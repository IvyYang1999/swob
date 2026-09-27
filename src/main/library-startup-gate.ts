import type { MessageBoxOptions } from 'electron'
import type {
  LibraryWriterLeaseInspection,
  LibraryWriterManualRecoveryResult
} from './library-writer-lease'
import { duplicateRecoveryErrorCode } from './duplicate-recovery-failure-code'

/**
 * Desktop startup gate: before any window exists, the app rolls back an
 * interrupted duplicate-recovery transaction under the Library maintenance
 * writer. That single call can fail for two unrelated reasons, and the user
 * must be told which one:
 *
 * - the writer lease could not be taken (lock held / unprovable / identity
 *   unavailable) — the rollback never ran, so the duplicate-recovery text
 *   would be a false explanation; the user gets the lock facts and an explicit
 *   "recover lock" action for exactly the evidence shown;
 * - the rollback itself failed — the original duplicate-recovery text.
 *
 * Attribution uses error.name / error.code plus the phase (did the rollback
 * start?), never instanceof: the writer error classes are also bundled into
 * the CLI and worker entries, and a class identity check would silently stop
 * matching if this path ever crossed an entry or chunk boundary.
 *
 * Dialogs are asynchronous (dialog.showMessageBox), never the Sync variant, so
 * a waiting dialog does not block the JavaScript event loop.
 */

export type LibraryStartupGateFailureKind =
  | 'writer-busy'
  | 'writer-identity'
  | 'duplicate-recovery'
  | 'unknown'

export interface LibraryStartupGateFailure {
  kind: LibraryStartupGateFailureKind
  /** Stable code for logs and the generic dialog; never a path or a message sentence. */
  code: string
  /** Busy reason or identity-unavailable reason carried by a writer error. */
  reason: string | null
}

export type LibraryStartupGateAction = 'recover' | 'retry' | 'quit'

export interface LibraryStartupGateDeps {
  /** Runs the operation under the Library maintenance writer (withLibraryMaintenanceWriter). */
  runUnderMaintenanceWriter(operation: () => Promise<unknown>): Promise<unknown>
  /** recoverInterruptedDuplicateRecoveryTransactions for the configured Library. */
  rollbackInterruptedDuplicateRecovery(): Promise<unknown>
  /** Read-only lease inspection, including ownerDeviceIsLocal; may throw. */
  inspectWriterLock(): LibraryWriterLeaseInspection
  /** Explicit manual recovery bound to the evidence hash the user was shown. */
  recoverWriterLock(expectedEvidenceHash: string): LibraryWriterManualRecoveryResult
  showMessageBox(options: MessageBoxOptions): Promise<{ response: number }>
  translate(key: string, params?: Record<string, string | number>): string
  formatTime(iso: string): string
  log(event: string, fields?: Record<string, unknown>): void
  isShuttingDown(): boolean
}

const WRITER_BUSY_CODE = 'LIBRARY_WRITER_BUSY'
const WRITER_IDENTITY_CODE = 'WRITER_IDENTITY_UNAVAILABLE'
const BUSY_REASONS = new Set([
  'active-owner', 'remote-owner', 'unverifiable-owner', 'corrupt-owner', 'recovery-in-progress', 'timeout'
])
const IDENTITY_REASONS = new Set(['boot-identity', 'process-start', 'host-identity'])
const RECOVERY_FAILURE_REASONS = new Set(['evidence-changed', 'unlocked', 'confirmation-required'])

function stringField(error: unknown, field: 'name' | 'code' | 'reason' | 'message'): string | null {
  if (!error || typeof error !== 'object') return null
  const value = (error as Record<string, unknown>)[field]
  return typeof value === 'string' && value ? value : null
}

function isDuplicateRecoveryError(error: unknown): boolean {
  const name = stringField(error, 'name')
  const code = stringField(error, 'code')
  const message = stringField(error, 'message')
  return Boolean(name?.startsWith('DuplicateRecovery')) ||
    Boolean(code && /^duplicate-recovery-/.test(code)) ||
    Boolean(message && /^duplicate-recovery-/.test(message)) ||
    message === 'quarantine-root-must-be-outside-library'
}

/** A log/dialog-safe code: an error code, a kebab-case internal message, or a class name. */
export function startupGateErrorCode(error: unknown): string {
  const code = stringField(error, 'code')
  if (code && /^[A-Za-z][A-Za-z0-9_.-]{1,63}$/.test(code)) return code
  const message = stringField(error, 'message')
  if (message && /^[a-z][a-z0-9-]{1,95}$/.test(message)) return message
  const name = stringField(error, 'name')
  if (name && name !== 'Error' && /^[A-Za-z][A-Za-z0-9]{1,63}$/.test(name)) return name
  return 'STARTUP_GATE_UNKNOWN_ERROR'
}

export function classifyLibraryStartupGateFailure(
  error: unknown,
  rollbackStarted: boolean
): LibraryStartupGateFailure {
  const name = stringField(error, 'name')
  const code = stringField(error, 'code')
  const reason = stringField(error, 'reason')
  if (name === 'LibraryWriterBusyError' || code === WRITER_BUSY_CODE) {
    return { kind: 'writer-busy', code: WRITER_BUSY_CODE, reason }
  }
  if (name === 'LibraryWriterIdentityUnavailableError' || code === WRITER_IDENTITY_CODE) {
    return { kind: 'writer-identity', code: WRITER_IDENTITY_CODE, reason }
  }
  // Anything the rollback itself threw is a duplicate-recovery failure; an
  // error before it started (Library path, device identity, arbiter) is not.
  if (rollbackStarted || isDuplicateRecoveryError(error)) {
    return { kind: 'duplicate-recovery', code: duplicateRecoveryErrorCode(error), reason: null }
  }
  return { kind: 'unknown', code: startupGateErrorCode(error), reason: null }
}

function busyReasonText(t: LibraryStartupGateDeps['translate'], reason: string | null | undefined): string {
  return t(`native.library_writer.reason.${reason && BUSY_REASONS.has(reason) ? reason : 'timeout'}`)
}

function identityReasonText(t: LibraryStartupGateDeps['translate'], reason: string | null): string {
  return t(`native.library_writer.identity_reason.${reason && IDENTITY_REASONS.has(reason) ? reason : 'host-identity'}`)
}

function recoveryFailureText(t: LibraryStartupGateDeps['translate'], failure: string): string {
  if (failure.startsWith('error:')) {
    return t('native.library_writer.recovery_error', { code: failure.slice('error:'.length) })
  }
  if (RECOVERY_FAILURE_REASONS.has(failure)) return t(`native.library_writer.recovery_reason.${failure}`)
  return busyReasonText(t, failure)
}

function ownerSummary(
  inspection: LibraryWriterLeaseInspection | null,
  failure: LibraryStartupGateFailure,
  deps: LibraryStartupGateDeps
): string[] {
  const t = deps.translate
  if (!inspection) return []
  if (inspection.state === 'unlocked') return [t('native.library_writer.lock_missing')]
  const lines: string[] = []
  if (inspection.reason && inspection.reason !== failure.reason) {
    lines.push(t('native.library_writer.current_state', { reason: busyReasonText(t, inspection.reason) }))
  }
  if (inspection.reason === 'corrupt-owner') {
    lines.push(t('native.library_writer.lock_corrupt'))
  } else {
    if (typeof inspection.ownerPid === 'number') {
      lines.push(t('native.library_writer.owner_pid', { pid: inspection.ownerPid }))
    }
    if (inspection.leaseExpiresAt) {
      lines.push(t(
        inspection.leaseExpired ? 'native.library_writer.lease_expired' : 'native.library_writer.lease_valid',
        { time: deps.formatTime(inspection.leaseExpiresAt) }
      ))
    }
    lines.push(t(inspection.ownerDeviceIsLocal === true
      ? 'native.library_writer.device_local'
      : inspection.ownerDeviceIsLocal === false
        ? 'native.library_writer.device_other'
        : 'native.library_writer.device_unknown'))
  }
  if (inspection.evidenceHash) {
    lines.push(t('native.library_writer.evidence', { hash: inspection.evidenceHash.slice(0, 12) }))
  }
  return lines
}

export interface LibraryWriterLockDialog {
  options: MessageBoxOptions
  actions: LibraryStartupGateAction[]
  /** The exact evidence a "recover" answer is bound to; null when recovery is not offered. */
  evidenceHash: string | null
}

export function buildLibraryWriterLockDialog(
  failure: LibraryStartupGateFailure,
  inspection: LibraryWriterLeaseInspection | null,
  recoveryFailure: string | null,
  deps: LibraryStartupGateDeps
): LibraryWriterLockDialog {
  const t = deps.translate
  // Recovery needs this machine's identity to claim the lock; with the
  // identity unavailable it could only fail again, so it is not offered.
  const evidenceHash = failure.kind === 'writer-busy' &&
    inspection?.state === 'blocked' &&
    inspection.manualRecoveryAvailable &&
    typeof inspection.evidenceHash === 'string' && inspection.evidenceHash
    ? inspection.evidenceHash
    : null
  const detail = [
    failure.kind === 'writer-busy' ? busyReasonText(t, failure.reason) : identityReasonText(t, failure.reason)
  ]
  const summary = ownerSummary(inspection, failure, deps)
  if (summary.length > 0) detail.push('', ...summary)
  if (recoveryFailure) {
    detail.push('', t('native.library_writer.recovery_failed', { reason: recoveryFailureText(t, recoveryFailure) }))
  }
  detail.push('', t(evidenceHash
    ? 'native.library_writer.recover_hint'
    : failure.kind === 'writer-identity'
      ? 'native.library_writer.identity_hint'
      : 'native.library_writer.retry_hint'))
  const actions: LibraryStartupGateAction[] = evidenceHash ? ['recover', 'quit'] : ['retry', 'quit']
  const quitIndex = actions.indexOf('quit')
  return {
    options: {
      type: 'warning',
      title: 'Swob',
      message: t(failure.kind === 'writer-busy'
        ? 'native.library_writer.busy_title'
        : 'native.library_writer.identity_title'),
      detail: detail.join('\n'),
      buttons: actions.map((action) => t(`native.library_writer.button_${action}`)),
      // Recovering moves a lock that may belong to another computer; it must
      // be a deliberate click, never the Return-key default.
      defaultId: quitIndex,
      cancelId: quitIndex,
      noLink: true
    },
    actions,
    evidenceHash
  }
}

function fatalDialog(failure: LibraryStartupGateFailure, deps: LibraryStartupGateDeps): MessageBoxOptions {
  const t = deps.translate
  const duplicate = failure.kind === 'duplicate-recovery'
  return {
    type: 'error',
    title: 'Swob',
    message: t(duplicate ? 'native.duplicate_recovery.fatal_title' : 'native.startup_gate.fatal_title'),
    detail: [
      t(duplicate ? 'native.duplicate_recovery.fatal_body' : 'native.startup_gate.fatal_body'),
      '',
      t('native.startup_gate.error_code', { code: failure.code })
    ].join('\n'),
    buttons: [t('native.library_writer.button_quit')],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  }
}

function inspectSafely(deps: LibraryStartupGateDeps): LibraryWriterLeaseInspection | null {
  try {
    return deps.inspectWriterLock()
  } catch {
    return null
  }
}

function attemptRecovery(deps: LibraryStartupGateDeps, evidenceHash: string): string | null {
  try {
    const result = deps.recoverWriterLock(evidenceHash)
    deps.log('library-writer-manual-recovery', {
      trigger: 'startup-dialog',
      recovered: result.recovered,
      reason: result.reason
    })
    return result.recovered ? null : result.reason
  } catch (error) {
    const code = startupGateErrorCode(error)
    deps.log('library-writer-manual-recovery', {
      trigger: 'startup-dialog',
      recovered: false,
      reason: 'error',
      code
    })
    return `error:${code}`
  }
}

/**
 * Runs the rollback under the writer until it succeeds ('continue') or the
 * user quits ('quit'). A writer-lock failure shows the lock facts with
 * Recover/Retry; recovery success simply re-runs the gate, so the rest of
 * startup has a single entry after this function returns 'continue'.
 */
export async function passLibraryStartupGate(deps: LibraryStartupGateDeps): Promise<'continue' | 'quit'> {
  let recoveryFailure: string | null = null
  for (;;) {
    let rollbackStarted = false
    try {
      await deps.runUnderMaintenanceWriter(() => {
        rollbackStarted = true
        return deps.rollbackInterruptedDuplicateRecovery()
      })
      return 'continue'
    } catch (error) {
      const failure = classifyLibraryStartupGateFailure(error, rollbackStarted)
      console.error('[library-startup-gate] startup gate blocked:', failure.kind, failure.code)
      deps.log('library-startup-gate-blocked', {
        kind: failure.kind,
        code: failure.code,
        ...(failure.reason ? { reason: failure.reason } : {})
      })
      if (deps.isShuttingDown()) return 'quit'
      if (failure.kind === 'duplicate-recovery' || failure.kind === 'unknown') {
        await deps.showMessageBox(fatalDialog(failure, deps))
        return 'quit'
      }
      const dialog = buildLibraryWriterLockDialog(failure, inspectSafely(deps), recoveryFailure, deps)
      const { response } = await deps.showMessageBox(dialog.options)
      if (deps.isShuttingDown()) return 'quit'
      const action = dialog.actions[response] ?? 'quit'
      if (action === 'quit') return 'quit'
      recoveryFailure = action === 'recover' && dialog.evidenceHash
        ? attemptRecovery(deps, dialog.evidenceHash)
        : null
    }
  }
}
