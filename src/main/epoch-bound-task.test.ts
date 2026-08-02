import { afterEach, describe, expect, it, vi } from 'vitest'
import { scheduleEpochBoundTask } from './epoch-bound-task'

afterEach(() => vi.useRealTimers())

describe('scheduleEpochBoundTask', () => {
  it('drops an old-root timer and only runs a newly adopted root snapshot', async () => {
    vi.useFakeTimers()
    let epoch = 7
    let paused = false
    const oldRoot = vi.fn()
    const newRoot = vi.fn()

    scheduleEpochBoundTask({
      epoch,
      currentEpoch: () => epoch,
      isPaused: () => paused,
      isStopped: () => false,
      run: oldRoot
    })
    epoch++
    paused = true
    await vi.runAllTimersAsync()
    expect(oldRoot).not.toHaveBeenCalled()

    paused = false
    scheduleEpochBoundTask({
      epoch,
      currentEpoch: () => epoch,
      isPaused: () => paused,
      isStopped: () => false,
      run: newRoot
    })
    await vi.runAllTimersAsync()
    expect(newRoot).toHaveBeenCalledOnce()
  })
})
