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
  resolveLibraryWriterHostIdentityBackupPath,
  resolveLibraryWriterHostIdentityStoragePath,
  runWithLibraryWriterArbiterContext,
  type LibraryWriterEvent,
  type LibraryWriterLeaseHandle,
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

  it('未触发 fatal close 时已进入的 writer 可在排空阶段完成 nested 写入', async () => {
    let nestedCompleted = false
    await runWithLibraryWriter(root, 'device-a', 'maintenance', async () => {
      await Promise.resolve()
      await runWithLibraryWriter(root, 'device-a', 'metadata', () => {
        nestedCompleted = true
      }, quiet)
    }, quiet)
    expect(nestedCompleted).toBe(true)
    expect(readLibraryWriteGeneration(root)).toBe(1)
  })

  it('fatal closed latch 在既有 writer 释放后永久拒绝后续同步、异步与 Worker writer', async () => {
    const workerParticipant = registerLibraryWriterArbiterParticipant()
    const workerWire = currentLibraryWriterArbiterWire(workerParticipant)
    await runWithLibraryWriter(root, 'device-a', 'maintenance', () => {}, quiet)
    closeLibraryWriterCoordinator()
    workerParticipant.release()

    await expect(runWithLibraryWriter(root, 'device-a', 'metadata', () => {}, quiet))
      .rejects.toBeInstanceOf(LibraryWriterCoordinatorClosedError)
    await expect(runWithLibraryWriterArbiterContext(workerWire, undefined,
      () => runWithLibraryWriter(root, 'device-a', 'metadata', () => {}, quiet)))
      .rejects.toBeInstanceOf(LibraryWriterCoordinatorClosedError)
    expect(() => runWithLibraryWriterSync(root, 'device-a', 'metadata', () => {}, quiet))
      .toThrow(LibraryWriterCoordinatorClosedError)
    expect(readLibraryWriteGeneration(root)).toBe(1)
  })

  describe('宿主身份重生成后的第二证据（stale-by-device-and-lease）', () => {
    const oldHost = '10000000-0000-4000-8000-000000000904'
    const regeneratedHost = '20000000-0000-4000-8000-000000000926'
    const incidentAt = Date.parse('2026-09-04T01:00:00.000Z')
    const dayMs = 24 * 60 * 60 * 1_000
    const orphans: LibraryWriterLeaseHandle[] = []

    afterEach(() => {
      for (const handle of orphans.splice(0)) handle.release()
    })

    /** 09-04: this installation takes the lock (15 s lease) and its process dies without releasing it. */
    async function incidentLock(overrides: Partial<LibraryWriterLeaseOptions> = {}, deviceId = 'this-install'): Promise<void> {
      orphans.push(await acquireLibraryWriterLease(root, deviceId, 'maintenance',
        leaseOptions(76437, () => 'start-76437', {
          bootIdentity: () => 'boot-0904',
          hostIdentity: () => oldHost,
          now: () => incidentAt,
          heartbeatMs: 60_000,
          ...overrides
        })))
    }

    /** After a reboot, with a regenerated host identity (its HMAC key no longer matches the owner's proof). */
    function afterRegeneration(
      nowMs: number,
      processState: (pid: number) => string | 'missing' | null,
      overrides: Partial<LibraryWriterLeaseOptions> = {}
    ): LibraryWriterLeaseOptions {
      return leaseOptions(202, (pid) => pid === 202 ? 'start-202' : processState(pid), {
        bootIdentity: () => 'boot-0926',
        hostIdentity: () => regeneratedHost,
        now: () => nowMs,
        timeoutMs: 20,
        pollMs: 1,
        ...overrides
      })
    }

    it('不同 boot + 身份重生成 + 本机 deviceId + 租约过期 ≥ 24 h + PID missing → 自动恢复，原因码进证据与事件', async () => {
      await incidentLock()
      const events: LibraryWriterEvent[] = []
      const now = Date.parse('2026-09-27T16:45:00.000Z')
      expect(inspectLibraryWriterLease(root, { ...afterRegeneration(now, () => 'missing'), localDeviceId: 'this-install' }))
        .toMatchObject({ state: 'blocked', reason: 'remote-owner', ownerDeviceIsLocal: true, leaseExpired: true })

      const recovered = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRegeneration(now, () => 'missing', { eventSink: (event) => { events.push(event) } }))

      expect(recovered.owner).toMatchObject({ schemaVersion: 2, deviceId: 'this-install' })
      const evidenceDir = path.join(root, '.swob', 'locks', 'writer-recovery-evidence')
      const retained = fs.readdirSync(evidenceDir)
      expect(retained).toHaveLength(1)
      const evidence = fs.readdirSync(path.join(evidenceDir, retained[0])).sort()
      expect(evidence).toHaveLength(2)
      expect(evidence).toContain('recovery.claim')
      expect(JSON.parse(fs.readFileSync(path.join(evidenceDir, retained[0], 'recovery.claim'), 'utf8')))
        .toMatchObject({ kind: 'automatic', basis: 'stale-by-device-and-lease' })
      expect(events).toContainEqual(expect.objectContaining({
        event: 'stale-recovered',
        recoveryBasis: 'stale-by-device-and-lease'
      }))
      recovered.release()
    })

    it.each([
      {
        label: 'owner 的 deviceId 不是本机',
        ownerDevice: 'other-install',
        expiredMs: 23 * dayMs,
        processState: () => 'missing' as const,
        overrides: {}
      },
      {
        label: '租约过期未满 24 h',
        ownerDevice: 'this-install',
        expiredMs: dayMs - 60_000,
        processState: () => 'missing' as const,
        overrides: {}
      },
      {
        label: 'PID 仍在（同一进程指纹）',
        ownerDevice: 'this-install',
        expiredMs: 23 * dayMs,
        processState: () => 'start-76437',
        overrides: {}
      },
      {
        label: 'PID 被复用（只认 missing）',
        ownerDevice: 'this-install',
        expiredMs: 23 * dayMs,
        processState: () => 'reused-start',
        overrides: {}
      },
      {
        label: 'PID 状态无法判定',
        ownerDevice: 'this-install',
        expiredMs: 23 * dayMs,
        processState: () => null,
        overrides: {}
      },
      {
        label: 'options 关闭第二证据',
        ownerDevice: 'this-install',
        expiredMs: 23 * dayMs,
        processState: () => 'missing' as const,
        overrides: { staleByDeviceAndLease: { enabled: false } }
      }
    ])('$label → 维持 remote-owner，锁原样保留', async ({ ownerDevice, expiredMs, processState, overrides }) => {
      await incidentLock({}, ownerDevice)
      const leaseExpiresAt = incidentAt + 15_000
      const error = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRegeneration(leaseExpiresAt + expiredMs, processState, overrides))
        .then(() => null, (caught: unknown) => caught)

      expect(error).toBeInstanceOf(LibraryWriterBusyError)
      expect(error).toMatchObject({ reason: 'remote-owner' })
      const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
      expect(fs.readdirSync(lockDir).filter((name) => name.endsWith('.owner.json'))).toHaveLength(1)
      expect(fs.existsSync(path.join(root, '.swob', 'locks', 'writer-recovery-evidence'))).toBe(false)
    })

    it('阈值可配置：minimumLeaseExpiredMs = 1 h 时过期 2 h 即恢复', async () => {
      await incidentLock()
      const recovered = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRegeneration(incidentAt + 15_000 + 2 * 60 * 60 * 1_000, () => 'missing', {
          staleByDeviceAndLease: { minimumLeaseExpiredMs: 60 * 60 * 1_000 }
        }))
      recovered.release()
    })

    it('不放宽 active-owner：同 boot 且 owner 进程存活时，即使 deviceId 相同、墙钟显示过期 30 天也不抢', async () => {
      await incidentLock({ bootIdentity: () => 'boot-a', hostIdentity: () => oldHost })
      await expect(acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        leaseOptions(202, (pid) => pid === 76437 ? 'start-76437' : 'start-202', {
          bootIdentity: () => 'boot-a',
          hostIdentity: () => oldHost,
          now: () => incidentAt + 30 * dayMs,
          timeoutMs: 5,
          pollMs: 1
        }))).rejects.toMatchObject({ reason: 'active-owner' })
    })

    it('legacy v1 owner 不享受第二证据，仍是 unverifiable-owner', async () => {
      const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
      fs.mkdirSync(lockDir, { recursive: true })
      fs.writeFileSync(path.join(lockDir, 'legacy.owner.json'), JSON.stringify({
        schemaVersion: 1,
        ownerNonce: 'legacy',
        deviceId: 'this-install',
        pid: 76437,
        bootIdentity: 'boot-0904',
        processStartFingerprint: 'start-76437',
        mode: 'maintenance',
        acquiredAt: '2026-09-04T01:00:00.000Z',
        heartbeatAt: '2026-09-04T01:00:00.000Z',
        leaseExpiresAt: '2026-09-04T01:00:15.000Z'
      }))
      await expect(acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRegeneration(Date.parse('2026-09-27T16:45:00.000Z'), () => 'missing')))
        .rejects.toMatchObject({ reason: 'unverifiable-owner' })
    })

    it('验收③：宿主身份目录被删后从备用副本恢复同一身份，本机旧锁仍被认作本机', async () => {
      const machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-machine-home-'))
      const previousTestHome = process.env.SWOB_TEST_HOME
      process.env.SWOB_TEST_HOME = machineHome
      try {
        const runtimeIdentity = (pid: number, bootIdentity: string, alive: (candidate: number) => string | 'missing') => ({
          pid,
          bootIdentity: () => bootIdentity,
          processStartFingerprint: alive,
          eventSink: () => {}
        })
        // No hostIdentity seam: the real getOrCreateHostIdentity runs against the test machine paths.
        orphans.push(await acquireLibraryWriterLease(root, 'this-install', 'maintenance', {
          ...runtimeIdentity(101, 'boot-a', () => 'start-101'),
          heartbeatMs: 60_000
        }))
        const identityPath = path.join(machineHome, '.swob-machine', 'host-identity-v1.json')
        const backupPath = path.join(machineHome, '.claude-session-manager', 'host-identity-v1.json')
        const identityBefore = fs.readFileSync(identityPath, 'utf8')
        expect(fs.existsSync(backupPath)).toBe(true)

        // The incident: the shared identity directory disappears and the machine reboots.
        fs.rmSync(path.dirname(identityPath), { recursive: true, force: true })

        const recovered = await acquireLibraryWriterLease(root, 'this-install', 'move', {
          ...runtimeIdentity(202, 'boot-b', (pid) => pid === 202 ? 'start-202' : 'start-101'),
          // Prove it is the restored host proof, not the second evidence.
          staleByDeviceAndLease: { enabled: false },
          timeoutMs: 50,
          pollMs: 1
        })
        expect(fs.readFileSync(identityPath, 'utf8')).toBe(identityBefore)
        recovered.release()
      } finally {
        if (previousTestHome === undefined) delete process.env.SWOB_TEST_HOME
        else process.env.SWOB_TEST_HOME = previousTestHome
        fs.rmSync(machineHome, { recursive: true, force: true })
      }
    })

    it('测试环境下 host identity 备用副本解析到测试 HOME，生产解析到状态目录', () => {
      expect(resolveLibraryWriterHostIdentityBackupPath('darwin', { NODE_ENV: 'test', SWOB_TEST_HOME: root }))
        .toBe(path.join(root, '.claude-session-manager', 'host-identity-v1.json'))
      expect(resolveLibraryWriterHostIdentityBackupPath('darwin', { NODE_ENV: 'production', HOME: '/tmp/profile-a', SWOB_TEST_HOME: root }))
        .toBe('/tmp/profile-a/.claude-session-manager/host-identity-v1.json')
    })
  })

  describe('身份历史第二证据（F1l-c：stale-by-identity-history）', () => {
    const identityA = '10000000-0000-4000-8000-000000000a01'
    const identityB = '20000000-0000-4000-8000-000000000b02'
    const orphans: LibraryWriterLeaseHandle[] = []

    afterEach(() => {
      for (const handle of orphans.splice(0)) handle.release()
    })

    /** identityA signed the incident lock; the current machine identity has since moved to identityB. */
    async function incidentLockSignedByA(deviceId = 'this-install'): Promise<void> {
      orphans.push(await acquireLibraryWriterLease(root, deviceId, 'maintenance',
        leaseOptions(76437, () => 'start-76437', {
          bootIdentity: () => 'boot-0904',
          hostIdentity: () => identityA,
          now: () => Date.parse('2026-09-04T01:00:00.000Z'),
          heartbeatMs: 60_000
        })))
    }

    function afterRotationToB(
      overrides: Partial<LibraryWriterLeaseOptions> = {}
    ): LibraryWriterLeaseOptions {
      return leaseOptions(202, (pid) => pid === 202 ? 'start-202' : 'missing', {
        bootIdentity: () => 'boot-0926',
        hostIdentity: () => identityB,
        now: () => Date.parse('2026-09-27T16:45:00.000Z'),
        timeoutMs: 20,
        pollMs: 1,
        ...overrides
      })
    }

    it('history 里的旧身份匹配 owner hostProof + deviceId 相同 → recover，原因码 stale-by-identity-history', async () => {
      await incidentLockSignedByA()
      const events: LibraryWriterEvent[] = []
      const recovered = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRotationToB({
          // Disabled so this test isolates identity-history: without it, staleByDeviceAndLease's
          // own conditions (deviceId match, >=24h expired, pid missing) would also independently
          // recover this same lock, masking whether identity-history actually did the work.
          staleByDeviceAndLease: { enabled: false },
          identityHistory: () => [identityA],
          eventSink: (event) => { events.push(event) }
        }))

      expect(recovered.owner).toMatchObject({ schemaVersion: 2, deviceId: 'this-install' })
      const evidenceDir = path.join(root, '.swob', 'locks', 'writer-recovery-evidence')
      const retained = fs.readdirSync(evidenceDir)
      expect(retained).toHaveLength(1)
      expect(JSON.parse(fs.readFileSync(path.join(evidenceDir, retained[0], 'recovery.claim'), 'utf8')))
        .toMatchObject({ kind: 'automatic', basis: 'stale-by-identity-history' })
      expect(events).toContainEqual(expect.objectContaining({
        event: 'stale-recovered',
        recoveryBasis: 'stale-by-identity-history'
      }))
      recovered.release()
    })

    it('history 里排第二的旧身份（历史有多条，最近的在前也要试到匹配的那条）', async () => {
      await incidentLockSignedByA()
      const recovered = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRotationToB({
          staleByDeviceAndLease: { enabled: false },
          identityHistory: () => ['30000000-0000-4000-8000-000000000c03', identityA]
        }))
      expect(recovered.owner).toMatchObject({ deviceId: 'this-install' })
      recovered.release()
    })

    it('deviceId 不同：即使历史身份匹配也不 recover，维持 remote-owner（历史不能跨机器用）', async () => {
      await incidentLockSignedByA('other-install')
      const error = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRotationToB({ identityHistory: () => [identityA] }))
        .then(() => null, (caught: unknown) => caught)

      expect(error).toBeInstanceOf(LibraryWriterBusyError)
      expect(error).toMatchObject({ reason: 'remote-owner' })
      expect(fs.existsSync(path.join(root, '.swob', 'locks', 'writer-recovery-evidence'))).toBe(false)
    })

    it('历史里没有匹配的身份 → 维持 remote-owner（不假装是本机的历史）', async () => {
      await incidentLockSignedByA()
      const error = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRotationToB({
          // Isolated from staleByDeviceAndLease for the same reason as above: this test is
          // specifically about identity-history refusing to fabricate a match, not about what
          // the other mechanism would independently do with these same deviceId/lease/pid facts.
          staleByDeviceAndLease: { enabled: false },
          identityHistory: () => ['40000000-0000-4000-8000-000000000d04']
        }))
        .then(() => null, (caught: unknown) => caught)
      expect(error).toBeInstanceOf(LibraryWriterBusyError)
      expect(error).toMatchObject({ reason: 'remote-owner' })
      expect(fs.existsSync(path.join(root, '.swob', 'locks', 'writer-recovery-evidence'))).toBe(false)
    })

    it('优先于 stale-by-device-and-lease：两者条件都满足时，原因码是 identity-history 而不是 device-and-lease', async () => {
      await incidentLockSignedByA() // this-install, lease expires long ago relative to the check below
      const recovered = await acquireLibraryWriterLease(root, 'this-install', 'maintenance',
        afterRotationToB({
          // staleByDeviceAndLease would also fire here (deviceId matches, ≥24h expired, pid missing) -
          // identity-history must win because it is the stronger evidence.
          identityHistory: () => [identityA]
        }))
      const evidenceDir = path.join(root, '.swob', 'locks', 'writer-recovery-evidence')
      const retained = fs.readdirSync(evidenceDir)
      expect(JSON.parse(fs.readFileSync(path.join(evidenceDir, retained[0], 'recovery.claim'), 'utf8')).basis)
        .toBe('stale-by-identity-history')
      recovered.release()
    })

    it('空历史（默认，无 identityHistory 覆盖）不影响既有 remote-owner/second-evidence 行为', async () => {
      await incidentLockSignedByA()
      const recovered = await acquireLibraryWriterLease(root, 'this-install', 'maintenance', afterRotationToB())
      const evidenceDir = path.join(root, '.swob', 'locks', 'writer-recovery-evidence')
      expect(JSON.parse(fs.readFileSync(
        path.join(evidenceDir, fs.readdirSync(evidenceDir)[0], 'recovery.claim'), 'utf8'
      )).basis).toBe('stale-by-device-and-lease')
      recovered.release()
    })

    it('验收②：旧身份 A 签的锁 + 主副本已重生成为 B（真实身份历史机制）→ recover，不弹远端 owner', async () => {
      const machineHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-machine-home-history-'))
      const previousTestHome = process.env.SWOB_TEST_HOME
      process.env.SWOB_TEST_HOME = machineHome
      try {
        // 1) This machine's real identity is A; it signs an incident lock, orphaned (heartbeat far in the future).
        orphans.push(await acquireLibraryWriterLease(root, 'this-install', 'maintenance', {
          pid: 101,
          bootIdentity: () => 'boot-a',
          processStartFingerprint: (pid) => pid === 101 ? 'start-101' : 'missing',
          heartbeatMs: 60_000,
          eventSink: () => {}
        }))
        const identityPath = path.join(machineHome, '.swob-machine', 'host-identity-v1.json')
        const backupPath = path.join(machineHome, '.claude-session-manager', 'host-identity-v1.json')
        const historyPath = path.join(machineHome, '.claude-session-manager', 'host-identity-history.jsonl')
        expect(fs.existsSync(historyPath)).toBe(false) // nothing superseded yet

        // 2) Something else regenerates the primary to B - the 09-26 shape - without going through this backup.
        const identityA = JSON.parse(fs.readFileSync(identityPath, 'utf8')).identity
        fs.rmSync(path.dirname(identityPath), { recursive: true, force: true })
        fs.mkdirSync(path.dirname(identityPath), { recursive: true })
        fs.writeFileSync(identityPath, JSON.stringify({
          schemaVersion: 1, identity: identityB, createdAt: '2026-09-26T22:22:00.000Z'
        }), { mode: 0o600 })

        // 3) The next process to read the identity (e.g. a `doctor locks` or another write attempt
        // that reaches getOrCreateHostIdentity) syncs the backup, archiving A into history.
        const { getOrCreateHostIdentity } = await import('./host-identity')
        getOrCreateHostIdentity({ storagePath: identityPath, backupPath })
        expect(fs.existsSync(historyPath)).toBe(true)
        expect(fs.readFileSync(historyPath, 'utf8')).toContain(identityA)
        expect(JSON.parse(fs.readFileSync(backupPath, 'utf8')).identity).toBe(identityB)

        // 4) Reboot: a fresh acquisition attempt now sees hostIdentity=B. The owner's hostProof was
        // derived from A, so same-host proof no longer matches - but identity history does.
        const recovered = await acquireLibraryWriterLease(root, 'this-install', 'move', {
          pid: 202,
          bootIdentity: () => 'boot-b',
          processStartFingerprint: (pid) => pid === 202 ? 'start-202' : 'missing',
          timeoutMs: 50,
          pollMs: 1,
          eventSink: () => {}
          // No hostIdentity/identityHistory seam: the real getOrCreateHostIdentity/readHostIdentityHistory run.
        })
        const evidenceDir = path.join(root, '.swob', 'locks', 'writer-recovery-evidence')
        const retained = fs.readdirSync(evidenceDir)
        expect(JSON.parse(fs.readFileSync(path.join(evidenceDir, retained[0], 'recovery.claim'), 'utf8')))
          .toMatchObject({ basis: 'stale-by-identity-history' })
        recovered.release()
      } finally {
        if (previousTestHome === undefined) delete process.env.SWOB_TEST_HOME
        else process.env.SWOB_TEST_HOME = previousTestHome
        fs.rmSync(machineHome, { recursive: true, force: true })
      }
    })
  })
})

