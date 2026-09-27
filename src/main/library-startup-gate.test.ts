import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { MessageBoxOptions } from 'electron'
import {
  buildLibraryWriterLockDialog,
  classifyLibraryStartupGateFailure,
  passLibraryStartupGate,
  type LibraryStartupGateDeps
} from './library-startup-gate'
import {
  inspectLibraryWriterLease,
  LIBRARY_WRITER_MANUAL_RECOVERY_CONFIRMATION,
  LibraryWriterBusyError,
  LibraryWriterIdentityUnavailableError,
  libraryWriterBusyMessage,
  recoverLibraryWriterLeaseManually,
  type LibraryWriterBusyReason,
  type LibraryWriterLeaseInspection,
  type LibraryWriterLeaseOptions
} from './library-writer-lease'
import { deriveHostBootIdentity, deriveLibraryHostProof } from './host-identity'
import { resetLibraryWriterCoordinatorForTests, runWithLibraryWriter } from './library-write-coordinator'
import { translate } from '../shared/i18n'

const DUPLICATE_BODY_ZH = translate('zh-CN', 'native.duplicate_recovery.fatal_body')
const DUPLICATE_TITLE_ZH = translate('zh-CN', 'native.duplicate_recovery.fatal_title')
const EVIDENCE = 'a'.repeat(64)

interface Harness {
  deps: LibraryStartupGateDeps
  dialogs: MessageBoxOptions[]
  logs: Array<{ event: string; fields?: Record<string, unknown> }>
  recoverCalls: string[]
  rollbackCalls: () => number
}

function blockedInspection(overrides: Partial<LibraryWriterLeaseInspection> = {}): LibraryWriterLeaseInspection {
  return {
    state: 'blocked',
    reason: 'remote-owner',
    evidenceHash: EVIDENCE,
    manualRecoveryAvailable: true,
    message: libraryWriterBusyMessage('remote-owner'),
    ownerPid: 76437,
    ownerAlive: null,
    mode: 'maintenance',
    heartbeatAt: '2026-09-04T01:00:00.000Z',
    leaseExpiresAt: '2026-09-04T01:00:15.000Z',
    leaseExpired: true,
    ownerDeviceIsLocal: true,
    ...overrides
  }
}

/** Busy error as it would look from another bundle: same name/code, not the same class. */
function foreignBusyError(reason: LibraryWriterBusyReason): Error {
  const error = new Error(`busy ${reason}`) as Error & { code: string; reason: string }
  error.name = 'LibraryWriterBusyError'
  error.code = 'LIBRARY_WRITER_BUSY'
  error.reason = reason
  return error
}

function harness(options: {
  gateErrors: unknown[]
  responses: number[]
  inspection?: () => LibraryWriterLeaseInspection
  recover?: (hash: string) => ReturnType<LibraryStartupGateDeps['recoverWriterLock']>
  throwInsideRollback?: unknown
}): Harness {
  const dialogs: MessageBoxOptions[] = []
  const logs: Harness['logs'] = []
  const recoverCalls: string[] = []
  const gateErrors = [...options.gateErrors]
  const responses = [...options.responses]
  let rollbacks = 0
  const deps: LibraryStartupGateDeps = {
    runUnderMaintenanceWriter: async (operation) => {
      const next = gateErrors.shift()
      if (next !== undefined) throw next
      return operation()
    },
    rollbackInterruptedDuplicateRecovery: async () => {
      rollbacks++
      if (options.throwInsideRollback !== undefined) throw options.throwInsideRollback
      return { recoveredPlanCount: 0, recoveredPackageCount: 0 }
    },
    inspectWriterLock: options.inspection || (() => blockedInspection()),
    recoverWriterLock: (hash) => {
      recoverCalls.push(hash)
      return options.recover ? options.recover(hash) : { recovered: true, reason: 'recovered', quarantinePath: '/q' }
    },
    showMessageBox: async (dialogOptions) => {
      dialogs.push(dialogOptions)
      const response = responses.shift()
      if (response === undefined) throw new Error('unexpected dialog')
      return { response }
    },
    translate: (key, params) => translate('zh-CN', key, params),
    formatTime: (iso) => `T(${iso})`,
    log: (event, fields) => { logs.push({ event, fields }) },
    isShuttingDown: () => false
  }
  return { deps, dialogs, logs, recoverCalls, rollbackCalls: () => rollbacks }
}

describe('Library startup gate attribution', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('写锁 busy（跨 bundle 的同名错误）不再弹「重复包修复未能安全回滚」，而是写锁对话框 +【恢复锁】', async () => {
    const run = harness({ gateErrors: [foreignBusyError('remote-owner')], responses: [0] })

    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('continue')

    const [dialog] = run.dialogs
    expect(dialog.message).toBe('资料库写锁被占用')
    expect(dialog.message).not.toBe(DUPLICATE_TITLE_ZH)
    expect(dialog.detail).not.toContain(DUPLICATE_BODY_ZH)
    expect(dialog.detail).toContain(libraryWriterBusyMessage('remote-owner'))
    expect(dialog.detail).toContain('持有者进程：PID 76437')
    expect(dialog.detail).toContain('租约已于 T(2026-09-04T01:00:15.000Z) 过期')
    expect(dialog.detail).toContain('持有者设备：本机这份安装（deviceId 相同）')
    expect(dialog.detail).toContain(`证据哈希：${EVIDENCE.slice(0, 12)}…`)
    expect(dialog.buttons).toEqual(['恢复锁', '退出'])
    // The safe answer is the Return-key default; recovery is a deliberate click.
    expect(dialog).toMatchObject({ defaultId: 1, cancelId: 1 })
    expect(run.recoverCalls).toEqual([EVIDENCE])
    expect(run.rollbackCalls()).toBe(1)
    expect(run.logs.map(({ event }) => event)).toEqual([
      'library-startup-gate-blocked',
      'library-writer-manual-recovery'
    ])
    expect(run.logs[0].fields).toMatchObject({ kind: 'writer-busy', code: 'LIBRARY_WRITER_BUSY', reason: 'remote-owner' })
    expect(run.logs[1].fields).toMatchObject({ trigger: 'startup-dialog', recovered: true, reason: 'recovered' })
  })

  it('恢复失败时显示原因、不继续启动；选择退出即 quit', async () => {
    const run = harness({
      gateErrors: [foreignBusyError('remote-owner'), foreignBusyError('remote-owner')],
      responses: [0, 1],
      recover: () => ({ recovered: false, reason: 'evidence-changed' })
    })

    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('quit')

    expect(run.dialogs).toHaveLength(2)
    expect(run.dialogs[0].detail).not.toContain('上次恢复没有完成')
    expect(run.dialogs[1].detail).toContain('上次恢复没有完成：确认期间这把锁变了')
    expect(run.rollbackCalls()).toBe(0)
  })

  it('本机存活 owner（active-owner）不提供【恢复锁】，只能重试或退出', async () => {
    const run = harness({
      gateErrors: [foreignBusyError('active-owner')],
      responses: [0],
      inspection: () => blockedInspection({
        reason: 'active-owner',
        manualRecoveryAvailable: false,
        ownerAlive: true,
        leaseExpired: false
      })
    })

    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('continue')

    expect(run.dialogs[0].buttons).toEqual(['重试', '退出'])
    expect(run.dialogs[0].detail).toContain(libraryWriterBusyMessage('active-owner'))
    expect(run.recoverCalls).toEqual([])
    expect(run.rollbackCalls()).toBe(1)
  })

  it('写者身份不可用时说明原因，不提供注定失败的【恢复锁】', async () => {
    const run = harness({
      gateErrors: [new LibraryWriterIdentityUnavailableError('host-identity')],
      responses: [1]
    })

    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('quit')

    expect(run.dialogs[0].message).toBe('无法验证资料库写锁')
    expect(run.dialogs[0].detail).toContain('无法安全读取本机身份文件')
    expect(run.dialogs[0].buttons).toEqual(['重试', '退出'])
    expect(run.dialogs[0].detail).not.toContain(DUPLICATE_BODY_ZH)
    expect(run.recoverCalls).toEqual([])
  })

  it('回滚本身失败才弹重复包修复原文案（附错误码）', async () => {
    const run = harness({
      gateErrors: [],
      responses: [0],
      throwInsideRollback: new Error('duplicate-recovery-rollback-artifact-missing')
    })

    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('quit')

    expect(run.dialogs).toHaveLength(1)
    expect(run.dialogs[0]).toMatchObject({ type: 'error', message: DUPLICATE_TITLE_ZH })
    expect(run.dialogs[0].detail).toContain(DUPLICATE_BODY_ZH)
    expect(run.dialogs[0].detail).toContain('错误码：duplicate-recovery-rollback-artifact-missing')
  })

  it('未知错误弹通用错误 + 错误码，不再冒充重复包修复', async () => {
    const unsafe = Object.assign(new Error('Library 路径不安全'), { code: 'LIBRARY_PATH_UNSAFE' })
    for (const error of [unsafe, new Error('invalid-app-config')]) {
      const run = harness({ gateErrors: [error], responses: [0] })
      await expect(passLibraryStartupGate(run.deps)).resolves.toBe('quit')
      expect(run.dialogs[0].message).toBe('Swob 未能启动')
      expect(run.dialogs[0].message).not.toBe(DUPLICATE_TITLE_ZH)
      expect(run.dialogs[0].detail).not.toContain(DUPLICATE_BODY_ZH)
      expect(run.dialogs[0].detail).toContain(`错误码：${error === unsafe ? 'LIBRARY_PATH_UNSAFE' : 'invalid-app-config'}`)
      expect(run.rollbackCalls()).toBe(0)
    }
  })

  it('按 name/code 与阶段分流：真实错误类与同名跨 bundle 错误结果一致', () => {
    expect(classifyLibraryStartupGateFailure(new LibraryWriterBusyError('remote-owner'), false))
      .toEqual({ kind: 'writer-busy', code: 'LIBRARY_WRITER_BUSY', reason: 'remote-owner' })
    expect(classifyLibraryStartupGateFailure(foreignBusyError('timeout'), false))
      .toEqual({ kind: 'writer-busy', code: 'LIBRARY_WRITER_BUSY', reason: 'timeout' })
    expect(classifyLibraryStartupGateFailure(new LibraryWriterIdentityUnavailableError('boot-identity'), false))
      .toEqual({ kind: 'writer-identity', code: 'WRITER_IDENTITY_UNAVAILABLE', reason: 'boot-identity' })
    // An fs error thrown by the rollback is still the rollback's failure.
    expect(classifyLibraryStartupGateFailure(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }), true))
      .toMatchObject({ kind: 'duplicate-recovery', code: 'EACCES' })
    expect(classifyLibraryStartupGateFailure(Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }), false))
      .toMatchObject({ kind: 'unknown', code: 'EACCES' })
  })

  it('停机中（before-quit 已开始）不再弹框也不继续启动', async () => {
    const run = harness({ gateErrors: [foreignBusyError('remote-owner')], responses: [] })
    run.deps.isShuttingDown = () => true
    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('quit')
    expect(run.dialogs).toEqual([])
  })

  it('zh-CN 原因文案与 lease 模块的 BUSY_MESSAGES 逐字一致，en 另有译文', () => {
    const reasons: LibraryWriterBusyReason[] = [
      'active-owner', 'remote-owner', 'unverifiable-owner', 'corrupt-owner', 'recovery-in-progress', 'timeout'
    ]
    for (const reason of reasons) {
      const key = `native.library_writer.reason.${reason}`
      expect(translate('zh-CN', key)).toBe(libraryWriterBusyMessage(reason))
      expect(translate('en', key)).not.toBe(key)
      expect(translate('en', key)).not.toBe(libraryWriterBusyMessage(reason))
    }
    const dialog = buildLibraryWriterLockDialog(
      { kind: 'writer-busy', code: 'LIBRARY_WRITER_BUSY', reason: 'remote-owner' },
      blockedInspection(),
      null,
      { ...harness({ gateErrors: [], responses: [] }).deps, translate: (key, params) => translate('en', key, params) }
    )
    expect(dialog.options.buttons).toEqual(['Recover lock', 'Quit'])
    expect(dialog.options.message).toBe('The library write lock is held')
  })
})

describe('Library startup gate against a real synthetic lock', () => {
  let root: string
  const localHost = '10000000-0000-4000-8000-000000000001'
  const regeneratedOldHost = '20000000-0000-4000-8000-000000000002'

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-gate-'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetLibraryWriterCoordinatorForTests()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('09-04 形状（v2、不同 boot、hostProof 不匹配、deviceId 不同）：点【恢复锁】后旧锁进证据目录、启动继续', async () => {
    const lockDir = path.join(root, '.swob', 'locks', 'library-writer')
    const salt = '30000000-0000-4000-8000-000000000003'
    fs.mkdirSync(lockDir, { recursive: true })
    fs.writeFileSync(path.join(lockDir, 'old.owner.json'), JSON.stringify({
      schemaVersion: 2,
      ownerNonce: 'old',
      deviceId: 'other-install',
      pid: 76437,
      bootIdentity: deriveHostBootIdentity(regeneratedOldHost, 'boot-0904', salt),
      processStartFingerprint: 'start-76437',
      hostProof: deriveLibraryHostProof(regeneratedOldHost, salt),
      hostProofSalt: salt,
      mode: 'maintenance',
      acquiredAt: '2026-09-04T01:00:00.000Z',
      heartbeatAt: '2026-09-04T01:00:00.000Z',
      leaseExpiresAt: '2026-09-04T01:00:15.000Z'
    }))
    const options: LibraryWriterLeaseOptions = {
      pid: 202,
      bootIdentity: () => 'boot-0926',
      hostIdentity: () => localHost,
      processStartFingerprint: (pid) => pid === 202 ? 'start-202' : 'missing',
      eventSink: () => {},
      timeoutMs: 20,
      pollMs: 1
    }
    const run = harness({ gateErrors: [], responses: [0] })
    let rolledBackUnderWriter = 0
    run.deps.runUnderMaintenanceWriter = (operation) =>
      runWithLibraryWriter(root, 'this-install', 'maintenance', operation, options)
    run.deps.rollbackInterruptedDuplicateRecovery = async () => {
      rolledBackUnderWriter++
      return { recoveredPlanCount: 0, recoveredPackageCount: 0 }
    }
    run.deps.inspectWriterLock = () => inspectLibraryWriterLease(root, { ...options, localDeviceId: 'this-install' })
    run.deps.recoverWriterLock = (expectedEvidenceHash) => recoverLibraryWriterLeaseManually(root, {
      expectedEvidenceHash,
      confirmation: LIBRARY_WRITER_MANUAL_RECOVERY_CONFIRMATION
    }, options)

    await expect(passLibraryStartupGate(run.deps)).resolves.toBe('continue')

    expect(run.dialogs).toHaveLength(1)
    expect(run.dialogs[0].detail).toContain(libraryWriterBusyMessage('remote-owner'))
    expect(run.dialogs[0].detail).toContain('持有者设备：其它设备或其它安装')
    expect(run.dialogs[0].detail).not.toContain(DUPLICATE_BODY_ZH)
    expect(rolledBackUnderWriter).toBe(1)
    const evidenceDir = path.join(root, '.swob', 'locks', 'writer-recovery-evidence')
    const retained = fs.readdirSync(evidenceDir)
    expect(retained).toHaveLength(1)
    expect(fs.readdirSync(path.join(evidenceDir, retained[0]))).toContain('old.owner.json')
    // The gate released its own lease after the rollback.
    expect(fs.existsSync(lockDir)).toBe(false)
  })
})

describe('index.ts startup gate wiring', () => {
  const index = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
  const gateSource = fs.readFileSync(path.join(__dirname, 'library-startup-gate.ts'), 'utf8')
  const whenReady = index.match(/app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\n\}\)\n/)?.[0] || ''
  const continuation = index.match(
    /async function continueStartupAfterLibraryGate\(\): Promise<void> \{[\s\S]*?\n\}\n/
  )?.[0] || ''

  it('whenReady 只经 passLibraryStartupGate 放行，不再无条件弹重复包文案', () => {
    expect(whenReady).toContain('passLibraryStartupGate(')
    expect(whenReady).toMatch(
      /passLibraryStartupGate\([\s\S]*?if \(gate !== 'continue'\) \{[\s\S]*?app\.quit\(\)[\s\S]*?libraryStartupGatePassed = true[\s\S]*?await continueStartupAfterLibraryGate\(\)/
    )
    expect(index).not.toContain('native.duplicate_recovery.fatal_title')
    expect(index).not.toContain('native.duplicate_recovery.fatal_body')
    expect(whenReady).not.toContain('createWindow()')
    expect(whenReady).not.toContain('showErrorBox')
  })

  it('窗口、IPC 与 watcher 全在门后的延续函数里；second-instance 在门前不建窗', () => {
    expect(continuation).toContain('createWindow()')
    expect(continuation).toContain('registerFrontendIpc(')
    expect(continuation).toContain('startLibraryWatcher()')
    expect(continuation).toContain("app.on('activate'")
    expect(index).toMatch(/app\.on\('second-instance', \(\) => \{\s*if \(libraryStartupGatePassed\) showMainWindow\(\)/)
  })

  it('对话框只用异步 showMessageBox', () => {
    expect(index).not.toContain('showMessageBoxSync')
    expect(gateSource).not.toContain('showMessageBoxSync')
    expect(index).toContain('showMessageBox: (options) => dialog.showMessageBox(options)')
  })
})
