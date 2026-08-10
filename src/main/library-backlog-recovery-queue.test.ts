import { describe, expect, it } from 'vitest'
import {
  LibraryBacklogRecoveryQueue,
  libraryBacklogGlobalRetryDelay,
  shouldSelectLibraryBacklogItem
} from './library-backlog-recovery-queue'

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

  it('gives every new Provider key one checkpoint owner without bypassing retry backoff', () => {
    const now = Date.parse('2026-08-10T00:00:00.000Z')
    expect(shouldSelectLibraryBacklogItem('provider', undefined, now, true)).toBe(true)
    expect(shouldSelectLibraryBacklogItem('provider', undefined, now, false)).toBe(false)
    expect(shouldSelectLibraryBacklogItem('provider', {
      state: 'waiting-provider',
      nextAttemptAt: null
    }, now, true)).toBe(true)
    expect(shouldSelectLibraryBacklogItem('provider', {
      state: 'retry-scheduled',
      nextAttemptAt: new Date(now - 1).toISOString()
    }, now, true)).toBe(false)
  })

  it('bounds global worker transport recovery without consuming item attempts', () => {
    expect(Array.from({ length: 6 }, (_, index) => libraryBacklogGlobalRetryDelay(index + 1)))
      .toEqual([1_000, 5_000, 30_000, 120_000, 600_000, null])
    expect(libraryBacklogGlobalRetryDelay(0)).toBeNull()
  })
})
