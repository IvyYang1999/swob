import { describe, expect, it } from 'vitest'
import {
  LibraryBacklogRecoveryQueue,
  libraryBacklogBatchFailurePolicy,
  libraryBacklogGlobalRetryDelay,
  libraryBacklogRecoveredHealthState,
  libraryBacklogWakeDisposition,
  shouldSelectLibraryBacklogItem
} from './library-backlog-recovery-queue'

describe('LibraryBacklogRecoveryQueue', () => {
  it('keeps whole-batch safety failures out of the item retry timer', () => {
    expect(libraryBacklogBatchFailurePolicy(Object.assign(new Error('private path'), { code: 'EACCES' })))
      .toBe('safety-stop')
    expect(libraryBacklogBatchFailurePolicy(Object.assign(new Error('busy'), {
      name: 'LibraryWriterBusyError',
      code: 'LIBRARY_WRITER_BUSY'
    }))).toBe('writer-recovery')
    expect(libraryBacklogBatchFailurePolicy(Object.assign(new Error('link'), { code: 'LIBRARY_PATH_UNSAFE' })))
      .toBe('safety-stop')
    expect(libraryBacklogBatchFailurePolicy(Object.assign(new Error('loop'), { code: 'ELOOP' })))
      .toBe('safety-stop')
    expect(libraryBacklogBatchFailurePolicy(Object.assign(new Error('parent'), { code: 'ENOTDIR' })))
      .toBe('safety-stop')
    expect(libraryBacklogBatchFailurePolicy(new Error('worker exited'))).toBe('global-retry')
  })

  it('drops wakes behind a safety latch and only coalesces during global backoff', () => {
    expect(libraryBacklogWakeDisposition(7, 7, false)).toBe('drop')
    expect(libraryBacklogWakeDisposition(7, null, false, 7)).toBe('drop')
    expect(libraryBacklogWakeDisposition(7, 6, true)).toBe('coalesce')
    expect(libraryBacklogWakeDisposition(7, null, false, null, true)).toBe('coalesce')
    expect(libraryBacklogWakeDisposition(7, null, false)).toBe('run')
  })

  it('restores health after an owned global retry succeeds without overwriting a newer fault', () => {
    expect(libraryBacklogRecoveredHealthState(42, 42, 0)).toBe('ready')
    expect(libraryBacklogRecoveredHealthState(42, 42, 2)).toBe('identity-conflict')
    expect(libraryBacklogRecoveredHealthState(43, 42, 0)).toBeNull()
  })

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
