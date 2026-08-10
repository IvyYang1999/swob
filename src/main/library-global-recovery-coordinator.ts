export type LibraryGlobalRecoveryOperation =
  | { kind: 'initial' }
  | { kind: 'backlog'; mode: 'automatic' | 'provider' }
  | { kind: 'refresh' }

export interface LibraryGlobalRecoveryFault {
  errorCode: string
  healthRevision: number
  operation: LibraryGlobalRecoveryOperation
}

export interface LibraryGlobalRecoveryLease extends LibraryGlobalRecoveryFault {
  leaseId: number
}

export function libraryGlobalRecoveryOperationKey(operation: LibraryGlobalRecoveryOperation): string {
  return operation.kind === 'backlog' ? `backlog:${operation.mode}` : operation.kind
}

/**
 * Lossless ownership for whole-transaction recovery. A failure that arrives
 * while another recovery is active is retained as a distinct pending fact,
 * including when it has the same operation key. The active lease may therefore
 * restore only the health revision it owns; it can never clear a later fault.
 */
export class LibraryGlobalRecoveryCoordinator {
  private readonly pending = new Map<string, LibraryGlobalRecoveryFault>()
  private active: LibraryGlobalRecoveryLease | null = null
  private nextLeaseId = 1

  enqueue(fault: LibraryGlobalRecoveryFault): void {
    this.pending.set(libraryGlobalRecoveryOperationKey(fault.operation), fault)
  }

  begin(): LibraryGlobalRecoveryLease | null {
    if (this.active) return null
    const first = this.nextPendingFault()
    if (!first) return null
    if (first.operation.kind === 'initial') this.pending.clear()
    else this.pending.delete(libraryGlobalRecoveryOperationKey(first.operation))
    const lease = { ...first, leaseId: this.nextLeaseId++ }
    this.active = lease
    return lease
  }

  succeed(lease: LibraryGlobalRecoveryLease): LibraryGlobalRecoveryFault | null {
    if (this.active?.leaseId !== lease.leaseId) return null
    this.active = null
    return lease
  }

  release(lease: LibraryGlobalRecoveryLease, requeue = false): boolean {
    if (this.active?.leaseId !== lease.leaseId) return false
    this.active = null
    if (requeue) this.enqueue(lease)
    return true
  }

  clear(): void {
    this.pending.clear()
    this.active = null
  }

  get hasWork(): boolean {
    return this.active !== null || this.pending.size > 0
  }

  get isActive(): boolean {
    return this.active !== null
  }

  get pendingCount(): number {
    return this.pending.size
  }

  private nextPendingFault(): LibraryGlobalRecoveryFault | null {
    // A full initialization subsumes a refresh or backlog transaction. Prefer
    // it when several failures were coalesced during the same backoff window.
    const initial = this.pending.get('initial')
    if (initial) return initial
    const refresh = this.pending.get('refresh')
    if (refresh) return refresh
    return this.pending.values().next().value ?? null
  }
}
