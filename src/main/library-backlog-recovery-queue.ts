export type LibraryBacklogRecoveryRequestMode = 'automatic' | 'provider'
export type LibraryBacklogRecoverySelectionMode = 'initial' | LibraryBacklogRecoveryRequestMode

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
