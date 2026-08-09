import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  acquireLibraryWriterArbiter,
  acquireLibraryWriterLease,
  advanceLibraryWriterArbiterEpoch,
  currentLibraryWriterArbiterWire,
  inspectLibraryWriterLease,
  LIBRARY_WRITER_MANUAL_RECOVERY_CONFIRMATION,
  LibraryWriterBusyError,
  LibraryWriterIdentityUnavailableError,
  registerLibraryWriterArbiterParticipant,
  recoverLibraryWriterLeaseManually,
  resolveLibraryWriterHostIdentityStoragePath,
  runWithLibraryWriterArbiterContext,
  type LibraryWriterLeaseOptions
} from './library-writer-lease'
import { deriveHostBootIdentity, deriveLibraryHostProof } from './host-identity'
import { LibraryPathUnsafeError } from './library-path-safety'
import {
  closeLibraryWriterCoordinator,
  LibraryWriterCoordinatorClosedError,
  readLibraryWriteGeneration,
  resetLibraryWriterCoordinatorForTests,
  runWithLibraryWriter,
  runWithLibraryWriterSync
} from './library-write-coordinator'
let root: string

const quiet = { eventSink: () => {} }

function leaseOptions(
  pid: number,
  processState: (candidatePid: number) => string | 'missing' | null,
  overrides: Partial<LibraryWriterLeaseOptions> = {}
): LibraryWriterLeaseOptions {
  return {
    pid,
    bootIdentity: () => 'boot-a',
    hostIdentity: () => '10000000-0000-4000-8000-000000000001',
    processStartFingerprint: processState,
    eventSink: () => {},
    ...overrides
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-writer-'))
})

afterEach(() => {
  resetLibraryWriterCoordinatorForTests()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Library 跨进程单写者 lease', () => {
  it('同一 Library 的两个实例串行执行，不受各自 userData 影响', async () => {
    const order: string[] = []
    let enterFirst!: () => void
    let releaseFirst!: () => void
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve })
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })

    const first = runWithLibraryWriter(root, 'same-install', 'maintenance', async () => {
      order.push('gui-start')
      enterFirst()
      await firstGate
      order.push('gui-end')
    }, { ...quiet, timeoutMs: 500 })
    await firstEntered

    const second = runWithLibraryWriter(root, 'same-install', 'move', async () => {
      order.push('cli-move')
    }, { ...quiet, timeoutMs: 5, pollMs: 1 })

    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(order).toEqual(['gui-start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['gui-start', 'gui-end', 'cli-move'])
    expect(readLibraryWriteGeneration(root)).toBe(2)
  })

  it.each(['epoch', 'cancel'] as const)('arbiter 等待在 %s 失效时退出且不触碰文件 lease', async (stopKind) => {
    let releaseOwner!: () => void
    let ownerEntered!: () => void
    const entered = new Promise<void>((resolve) => { ownerEntered = resolve })
    const ownerGate = new Promise<void>((resolve) => { releaseOwner = resolve })
    const owner = runWithLibraryWriter(root, 'device-a', 'maintenance', async () => {
      ownerEntered()
      await ownerGate
    }, { ...quiet, timeoutMs: 5 })
    await entered

    let cancelled = false
    const wire = currentLibraryWriterArbiterWire()
    const contender = runWithLibraryWriterArbiterContext(
      wire,
      () => cancelled,
      () => runWithLibraryWriter(root, 'device-a', 'move', async () => {}, { ...quiet, timeoutMs: 5 })
    )
    await new Promise((resolve) => setTimeout(resolve, 15))
    if (stopKind === 'epoch') advanceLibraryWriterArbiterEpoch()
    else cancelled = true
    await expect(contender).rejects.toMatchObject({ name: 'AbortError' })
    releaseOwner()
    await owner
    expect(readLibraryWriteGeneration(root)).toBe(1)
  })

  it('epoch 推进清理已死亡 participant 的 owner，且旧 handle 不能释放新 owner', async () => {
    const deadParticipant = registerLibraryWriterArbiterParticipant()
    const deadWire = currentLibraryWriterArbiterWire(deadParticipant)
    const orphanedHandle = await runWithLibraryWriterArbiterContext(
      deadWire,
      undefined,
      acquireLibraryWriterArbiter
    )

    deadParticipant.release()
    advanceLibraryWriterArbiterEpoch()
    const replacement = await acquireLibraryWriterArbiter()
    orphanedHandle.release()

    let contenderAcquired = false
    const contender = acquireLibraryWriterArbiter().then((handle) => {
      contenderAcquired = true
      handle.release()
    })
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(contenderAcquired).toBe(false)
    replacement.release()
    await contender
  })

  it('心跳延迟但原进程仍存活时绝不偷锁', async () => {
    const first = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        leaseMs: 5,
        heartbeatMs: 1_000
      }))
    await new Promise((resolve) => setTimeout(resolve, 15))

    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        timeoutMs: 5,
        pollMs: 1
      }))).rejects.toMatchObject({ code: 'LIBRARY_WRITER_BUSY', reason: 'active-owner' })
    first.release()
  })

  it('矩阵 1：同 profile、同 boot、PID 已死时自动恢复', async () => {
    const first = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { leaseMs: 5, heartbeatMs: 1_000 }))
    await new Promise((resolve) => setTimeout(resolve, 15))

    const recovered = await acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'missing' : 'start-202', { timeoutMs: 50 }))
    first.release()
    expect(fs.existsSync(path.join(root, '.swob', 'locks', 'library-writer'))).toBe(true)
    recovered.release()
  })

  it('矩阵 2／本次事故：不同 profile、同 boot、PID 已死也安全恢复', async () => {
    const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'legacy.owner.json'), JSON.stringify({
      schemaVersion: 1,
      ownerNonce: 'legacy',
      deviceId: 'profile-a',
      pid: 101,
      bootIdentity: 'boot-a',
      processStartFingerprint: 'start-101',
      mode: 'maintenance',
      acquiredAt: '2026-08-01T00:00:00.000Z',
      heartbeatAt: '2026-08-01T00:00:00.000Z',
      leaseExpiresAt: '2026-08-01T00:00:15.000Z'
    }))

    const recovered = await acquireLibraryWriterLease(root, 'profile-b', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'missing' : 'start-202', { timeoutMs: 50 }))

    expect(recovered.owner).toMatchObject({
      schemaVersion: 2,
      deviceId: 'profile-b',
      hostProof: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    const migratedOwnerName = fs.readdirSync(lockDir).find((name) => name.endsWith('.owner.json'))!
    expect(JSON.parse(fs.readFileSync(path.join(lockDir, migratedOwnerName), 'utf8'))).toMatchObject({
      schemaVersion: 2,
      ownerNonce: recovered.owner.ownerNonce
    })
    recovered.release()
  })

  it('不同 boot 但稳定 host proof 相同时可恢复，不查询旧 boot 的 PID', async () => {
    const first = await acquireLibraryWriterLease(root, 'profile-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { heartbeatMs: 1_000 }))
    let inspectedOldPid = false
    const recovered = await acquireLibraryWriterLease(root, 'profile-b', 'move',
      leaseOptions(202, (pid) => {
        if (pid === 101) inspectedOldPid = true
        return 'start-202'
      }, { bootIdentity: () => 'boot-b', timeoutMs: 50 }))

    expect(inspectedOldPid).toBe(false)
    first.release()
    recovered.release()
  })

  it('锁 owner 只持久化每次随机 challenge 的 HMAC proof，不写入原始 host identity', async () => {
    const rawHostIdentity = '30000000-0000-4000-8000-000000000003'
    const lease = await acquireLibraryWriterLease(root, 'profile-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { hostIdentity: () => rawHostIdentity }))
    const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
    const ownerName = fs.readdirSync(lockDir).find((name) => name.endsWith('.owner.json'))!
    const persisted = fs.readFileSync(path.join(lockDir, ownerName), 'utf8')

    expect(persisted).not.toContain(rawHostIdentity)
    expect(JSON.parse(persisted)).toMatchObject({
      schemaVersion: 2,
      hostProof: expect.stringMatching(/^[0-9a-f]{64}$/),
      hostProofSalt: expect.stringMatching(/^[0-9a-f-]{36}$/i)
    })
    lease.release()
  })

  it('矩阵 3：同 boot 的 PID 被复用但启动指纹不同时安全恢复', async () => {
    const first = await acquireLibraryWriterLease(root, 'profile-a', 'maintenance',
      leaseOptions(101, () => 'old-start-101', { heartbeatMs: 1_000 }))

    const recovered = await acquireLibraryWriterLease(root, 'profile-b', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'reused-start-101' : 'start-202', { timeoutMs: 50 }))

    first.release()
    recovered.release()
  })

  it('矩阵 4：不同 profile、同 boot、owner 仍存活时绝不抢锁', async () => {
    const first = await acquireLibraryWriterLease(root, 'profile-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { heartbeatMs: 1_000 }))

    await expect(acquireLibraryWriterLease(root, 'profile-b', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', { timeoutMs: 5, pollMs: 1 })))
      .rejects.toMatchObject({ reason: 'active-owner' })
    first.release()
  })

  it('矩阵 5：真正远端 owner 不会被本机 PID 状态误判或抢锁', async () => {
    const remote = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, () => 'start-101', {
        bootIdentity: () => 'remote-boot',
        hostIdentity: () => '20000000-0000-4000-8000-000000000002',
        heartbeatMs: 1_000
      }))
    let inspectedRemotePid = false
    const remoteError = await acquireLibraryWriterLease(root, 'device-b', 'move',
      leaseOptions(202, (pid) => {
        if (pid === 101) inspectedRemotePid = true
        return 'start-202'
      }, { timeoutMs: 5, pollMs: 1 }))
      .then(() => null, (error) => error)
    expect(remoteError).toBeInstanceOf(LibraryWriterBusyError)
    expect(remoteError).toMatchObject({ reason: 'remote-owner' })
    expect(inspectedRemotePid).toBe(false)
    expect(inspectLibraryWriterLease(root, leaseOptions(202, () => 'start-202'))).toMatchObject({
      state: 'blocked',
      reason: 'remote-owner',
      manualRecoveryAvailable: true,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    remote.release()
  })

  it('矩阵 6：owner 损坏时 fail-closed、显示明确原因，并且只能显式人工隔离', async () => {
    const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'broken.owner.json'), '{broken')
    const error = await acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, () => 'start-202', { timeoutMs: 5, pollMs: 1 }))
      .then(() => null, (caught) => caught as LibraryWriterBusyError)
    expect(error).toMatchObject({ reason: 'corrupt-owner' })
    expect(error?.message).toContain('owner 格式损坏')
    expect(fs.existsSync(path.join(lockDir, 'broken.owner.json'))).toBe(true)

    const inspection = inspectLibraryWriterLease(root, leaseOptions(202, () => 'start-202'))
    expect(inspection).toMatchObject({
      state: 'blocked', reason: 'corrupt-owner', manualRecoveryAvailable: true,
      evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/)
    })
    expect(recoverLibraryWriterLeaseManually(root, {
      expectedEvidenceHash: inspection.evidenceHash!,
      confirmation: 'not-confirmed'
    }, leaseOptions(202, () => 'start-202'))).toMatchObject({ recovered: false, reason: 'confirmation-required' })

    const recovered = recoverLibraryWriterLeaseManually(root, {
      expectedEvidenceHash: inspection.evidenceHash!,
      confirmation: LIBRARY_WRITER_MANUAL_RECOVERY_CONFIRMATION
    }, leaseOptions(202, () => 'start-202'))
    expect(recovered).toMatchObject({ recovered: true, reason: 'recovered' })
    expect(fs.readFileSync(path.join(recovered.quarantinePath!, 'broken.owner.json'), 'utf8')).toBe('{broken')
  })

  it('recovery claimant 崩溃后，同机后继进程按 PID 启动指纹清理 claim 并完成恢复', async () => {
    const hostIdentity = '10000000-0000-4000-8000-000000000001'
    const original = await acquireLibraryWriterLease(root, 'profile-a', 'maintenance',
      leaseOptions(101, () => 'start-101', { heartbeatMs: 1_000 }))
    const inspection = inspectLibraryWriterLease(root, leaseOptions(202, () => 'start-202'))
    const claimSalt = '40000000-0000-4000-8000-000000000004'
    const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
    fs.writeFileSync(path.join(lockDir, 'recovery.claim'), JSON.stringify({
      schemaVersion: 1,
      claimNonce: 'crashed-claimant',
      ownerNonce: original.owner.ownerNonce,
      ownerEvidenceHash: inspection.evidenceHash,
      claimantPid: 404,
      claimantBootIdentity: deriveHostBootIdentity(hostIdentity, 'boot-a', claimSalt),
      claimantProcessStartFingerprint: 'start-404',
      claimantHostProof: deriveLibraryHostProof(hostIdentity, claimSalt),
      claimantHostProofSalt: claimSalt,
      createdAt: '2026-08-02T00:00:00.000Z',
      kind: 'automatic'
    }))

    const recovered = await acquireLibraryWriterLease(root, 'profile-b', 'move',
      leaseOptions(202, (pid) => pid === 202 ? 'start-202' : 'missing', { timeoutMs: 50, pollMs: 1 }))
    original.release()
    recovered.release()
  })

  it('墙钟前跳或后退都不会偷走仍存活 owner，且等待由单调时钟限时', async () => {
    let wallNow = Date.parse('2026-07-22T00:00:00.000Z')
    const first = await acquireLibraryWriterLease(root, 'device-a', 'maintenance',
      leaseOptions(101, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        now: () => wallNow,
        leaseMs: 5,
        heartbeatMs: 1_000
      }))

    wallNow += 365 * 24 * 60 * 60 * 1_000
    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        now: () => wallNow,
        timeoutMs: 5,
        pollMs: 1
      }))).rejects.toMatchObject({ reason: 'active-owner' })

    wallNow = Date.parse('2000-01-01T00:00:00.000Z')
    await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
      leaseOptions(202, (pid) => pid === 101 ? 'start-101' : 'start-202', {
        now: () => wallNow,
        timeoutMs: 5,
        pollMs: 1
      }))).rejects.toMatchObject({ reason: 'active-owner' })
    first.release()
  })

  it('锁目录祖先是符号链接时拒绝写入 Library 外部', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-writer-outside-'))
    try {
      fs.mkdirSync(path.join(root, '.swob'))
      fs.symlinkSync(outside, path.join(root, '.swob', 'locks'), process.platform === 'win32' ? 'junction' : 'dir')
      await expect(acquireLibraryWriterLease(root, 'device-a', 'move',
        leaseOptions(202, () => 'start-202', { timeoutMs: 5 })))
        .rejects.toBeInstanceOf(LibraryPathUnsafeError)
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it.each([
    {
      label: 'boot identity',
      overrides: { bootIdentity: () => null }
    },
    {
      label: 'process start fingerprint',
      overrides: { processStartFingerprint: () => null }
    }
  ])('$label 探测失败时不创建锁目录，并返回 identity unavailable', async ({ overrides }) => {
    const error = await acquireLibraryWriterLease(root, 'device-a', 'maintenance', {
      ...leaseOptions(101, () => 'start-101'),
      ...overrides
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(LibraryWriterIdentityUnavailableError)
    expect(error).toMatchObject({ code: 'WRITER_IDENTITY_UNAVAILABLE' })
    expect(fs.existsSync(path.join(root, '.swob', 'locks'))).toBe(false)
  })

  it('生产环境解析 host identity 路径时忽略 SWOB_TEST_HOME', () => {
    const productionPath = resolveLibraryWriterHostIdentityStoragePath('darwin', {
      NODE_ENV: 'production',
      SWOB_TEST_HOME: root
    })
    const testPath = resolveLibraryWriterHostIdentityStoragePath('darwin', {
      NODE_ENV: 'test',
      SWOB_TEST_HOME: root
    })
    expect(productionPath).toBe('/Users/Shared/Swob/host-identity-v1.json')
    expect(productionPath).not.toContain(root)
    expect(testPath).toBe(path.join(root, '.swob-machine', 'host-identity-v1.json'))
  })

  it('operation 抛错也先持久化 generation，拒绝复用旧扫描', async () => {
    await expect(runWithLibraryWriter(root, 'device-a', 'metadata', () => {
      throw new Error('synthetic-crash-before-result')
    }, quiet)).rejects.toThrow('synthetic-crash-before-result')
    await runWithLibraryWriter(root, 'device-a', 'metadata', () => {}, quiet)
    expect(readLibraryWriteGeneration(root)).toBe(2)
  })

  it('进程级 closed latch 永久拒绝后续同步、异步与 reentrant writer', async () => {
    let rejectNested: (() => Promise<void>) | undefined
    const workerParticipant = registerLibraryWriterArbiterParticipant()
    const workerWire = currentLibraryWriterArbiterWire(workerParticipant)
    await runWithLibraryWriter(root, 'device-a', 'maintenance', () => {
      closeLibraryWriterCoordinator()
      rejectNested = () => runWithLibraryWriter(root, 'device-a', 'metadata', () => {}, quiet)
    }, quiet)
    workerParticipant.release()

    await expect(rejectNested!()).rejects.toBeInstanceOf(LibraryWriterCoordinatorClosedError)
    await expect(runWithLibraryWriter(root, 'device-a', 'metadata', () => {}, quiet))
      .rejects.toBeInstanceOf(LibraryWriterCoordinatorClosedError)
    await expect(runWithLibraryWriterArbiterContext(workerWire, undefined,
      () => runWithLibraryWriter(root, 'device-a', 'metadata', () => {}, quiet)))
      .rejects.toBeInstanceOf(LibraryWriterCoordinatorClosedError)
    expect(() => runWithLibraryWriterSync(root, 'device-a', 'metadata', () => {}, quiet))
      .toThrow(LibraryWriterCoordinatorClosedError)
    expect(readLibraryWriteGeneration(root)).toBe(1)
  })
})
