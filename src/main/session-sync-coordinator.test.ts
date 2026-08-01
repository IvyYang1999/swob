import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionSyncCoordinator } from './session-sync-coordinator'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('SessionSyncCoordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('coalesces 20 changes inside the 2 second quiet window into one sync', async () => {
    const sync = vi.fn(async () => {})
    const coordinator = new SessionSyncCoordinator({ sync, quietWindowMs: 2_000 })

    for (let index = 0; index < 20; index++) {
      coordinator.schedule({ sessionId: 'same-session', filePath: '/tmp/same.jsonl', reason: 'change' })
      await vi.advanceTimersByTimeAsync(90)
    }
    expect(sync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    await coordinator.waitForIdle()

    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'same-session' }))
  })

  it('never runs the same session concurrently and performs one quiet rerun', async () => {
    const first = deferred()
    const sync = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined)
    const coordinator = new SessionSyncCoordinator({ sync, quietWindowMs: 2_000 })

    coordinator.schedule({ sessionId: 'active', filePath: '/tmp/active.jsonl' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sync).toHaveBeenCalledTimes(1)

    for (let index = 0; index < 8; index++) {
      coordinator.schedule({ sessionId: 'active', filePath: '/tmp/active.jsonl' })
    }
    first.resolve()
    await Promise.resolve()
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await coordinator.waitForIdle()
    expect(sync).toHaveBeenCalledTimes(2)
  })

  it('limits unrelated sessions to two concurrent syncs', async () => {
    const gates = [deferred(), deferred(), deferred(), deferred()]
    let active = 0
    let peak = 0
    const sync = vi.fn(async (request: { sessionId?: string }) => {
      active++
      peak = Math.max(peak, active)
      const index = Number(request.sessionId?.slice(-1))
      await gates[index].promise
      active--
    })
    const coordinator = new SessionSyncCoordinator({ sync, quietWindowMs: 10, concurrency: 2 })

    for (let index = 0; index < 4; index++) coordinator.schedule({ sessionId: `session-${index}` })
    await vi.advanceTimersByTimeAsync(10)
    expect(sync).toHaveBeenCalledTimes(2)
    expect(peak).toBe(2)

    gates[0].resolve()
    gates[1].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(sync).toHaveBeenCalledTimes(4)
    gates[2].resolve()
    gates[3].resolve()
    await coordinator.waitForIdle()
    expect(peak).toBe(2)
  })

  it('does not report an expected AbortError after shutdown stops active work', async () => {
    let rejectSync!: (error: Error) => void
    const active = new Promise<void>((_resolve, reject) => { rejectSync = reject })
    const logger = { error: vi.fn() }
    const coordinator = new SessionSyncCoordinator({
      sync: () => active,
      quietWindowMs: 10,
      logger
    })

    coordinator.schedule({ sessionId: 'shutdown-active' })
    await vi.advanceTimersByTimeAsync(10)
    coordinator.stop()
    const cancelled = new Error('cancelled')
    cancelled.name = 'AbortError'
    rejectSync(cancelled)
    await coordinator.waitForIdle()

    expect(logger.error).not.toHaveBeenCalled()
  })
})
