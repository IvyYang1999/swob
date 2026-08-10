export type LibraryBacklogRecoveryRequestMode = 'automatic' | 'provider'

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
