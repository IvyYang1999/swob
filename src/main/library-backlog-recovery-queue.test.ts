import { describe, expect, it } from 'vitest'
import { LibraryBacklogRecoveryQueue } from './library-backlog-recovery-queue'

describe('LibraryBacklogRecoveryQueue', () => {
  it('retains a Provider wake that arrives while automatic recovery is active', () => {
    const queue = new LibraryBacklogRecoveryQueue()
    queue.request('automatic')
    expect(queue.takeNext()).toBe('automatic')

    // The first recovery is now in flight. This wake must survive until its
    // transaction boundary because waiting-provider entries have no timer.
    queue.request('provider')
    expect(queue.takeNext()).toBe('provider')
    expect(queue.takeNext()).toBeNull()
  })

  it('coalesces duplicate wakes and gives Provider the next boundary', () => {
    const queue = new LibraryBacklogRecoveryQueue()
    queue.request('automatic')
    queue.request('provider')
    queue.request('provider')

    expect(queue.takeNext()).toBe('provider')
    expect(queue.takeNext()).toBe('automatic')
    expect(queue.takeNext()).toBeNull()
  })

  it('drops root-scoped wakes when the root changes', () => {
    const queue = new LibraryBacklogRecoveryQueue()
    queue.request('provider')
    queue.clear()
    expect(queue.size).toBe(0)
    expect(queue.takeNext()).toBeNull()
  })
})
