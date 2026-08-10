export type LibraryBacklogRecoveryRequestMode = 'automatic' | 'provider'
export type LibraryBacklogRecoverySelectionMode = 'initial' | LibraryBacklogRecoveryRequestMode

const GLOBAL_RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const

export type LibraryBacklogBatchFailurePolicy = 'global-retry' | 'writer-recovery' | 'safety-stop'
export type LibraryBacklogWakeDisposition = 'run' | 'coalesce' | 'drop'

export function libraryBacklogWakeDisposition(
  runtimeEpoch: number,
  safetyStopEpoch: number | null,
  globalBackoffActive: boolean,
  exhaustedEpoch: number | null = null,
  writerRecoveryActive = false
): LibraryBacklogWakeDisposition {
  if (safetyStopEpoch === runtimeEpoch || exhaustedEpoch === runtimeEpoch) return 'drop'
  return globalBackoffActive || writerRecoveryActive ? 'coalesce' : 'run'
}

export function libraryBacklogBatchFailurePolicy(error: unknown): LibraryBacklogBatchFailurePolicy {
  if (!error || typeof error !== 'object') return 'global-retry'
  const typed = error as { name?: unknown; code?: unknown }
  const name = typeof typed.name === 'string' ? typed.name : ''
  const code = typeof typed.code === 'string' ? typed.code : ''
  if (name === 'LibraryWriterBusyError' || name === 'LibraryWriterIdentityUnavailableError' ||
    name === 'SessionCreateIdentityUnavailableError' ||
    code === 'LIBRARY_WRITER_BUSY' || code === 'WRITER_IDENTITY_UNAVAILABLE' || code === 'ENOSPC') {
    return 'writer-recovery'
  }
  if (name === 'LibraryPathUnsafeError' ||
    name === 'LibraryStartupCheckpointCorruptError' ||
    code === 'LIBRARY_PATH_UNSAFE' || code === 'EACCES' || code === 'EPERM' ||
    code === 'EIO' || code === 'ELOOP' || code === 'ENOTDIR' ||
    code === 'LIBRARY_STARTUP_CHECKPOINT_CORRUPT') return 'safety-stop'
  return 'global-retry'
}

export function libraryBacklogRecoveredHealthState(
  currentHealthRevision: number,
  ownedFailureHealthRevision: number | null | undefined,
  identityConflictCount: number
): 'ready' | 'identity-conflict' | null {
  if (!ownedFailureHealthRevision || currentHealthRevision !== ownedFailureHealthRevision) return null
  return identityConflictCount > 0 ? 'identity-conflict' : 'ready'
}

export function libraryBacklogGlobalRetryDelay(attempt: number): number | null {
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null
  return GLOBAL_RETRY_DELAYS_MS[attempt - 1] ?? null
}

export function shouldSelectLibraryBacklogItem(
  mode: LibraryBacklogRecoverySelectionMode,
  recovery: { state: string; nextAttemptAt: string | null } | undefined,
  nowMs: number,
  providerSession = false
): boolean {
  if (mode === 'initial') return !recovery
  if (mode === 'provider') {
    return providerSession && (!recovery || recovery.state === 'waiting-provider')
  }
  return !recovery || (recovery.state === 'retry-scheduled' && recovery.nextAttemptAt !== null &&
    Date.parse(recovery.nextAttemptAt) <= nowMs)
}

/**
 * Lossless coalescing gate for targeted recovery wakes. Provider availability
 * wins the next boundary because waiting-provider entries have no timer.
 */
export class LibraryBacklogRecoveryQueue {
  private readonly pending = new Set<LibraryBacklogRecoveryRequestMode>()

  request(mode: LibraryBacklogRecoveryRequestMode): void {
    this.pending.add(mode)
  }

  takeNext(): LibraryBacklogRecoveryRequestMode | null {
    const next = this.pending.has('provider') ? 'provider'
      : this.pending.has('automatic') ? 'automatic'
        : null
    if (next) this.pending.delete(next)
    return next
  }

  clear(): void {
    this.pending.clear()
  }

  get size(): number {
    return this.pending.size
  }
}
