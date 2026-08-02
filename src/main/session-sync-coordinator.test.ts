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

  it('drains a cutoff generation without waiting for continuous sub-quiet-window events', async () => {
    const first = deferred()
    let sourceGeneration = 1
    let backupGeneration = 0
    let transcriptGeneration = 0
    let active = 0
    let peak = 0
    let calls = 0
    const sync = vi.fn(async () => {
      const capturedGeneration = sourceGeneration
      calls++
      active++
      peak = Math.max(peak, active)
      if (calls === 1) await first.promise
      backupGeneration = capturedGeneration
      transcriptGeneration = capturedGeneration
      active--
    })
    const coordinator = new SessionSyncCoordinator({ sync, quietWindowMs: 2_000, concurrency: 1 })

    coordinator.schedule({ sessionId: 'continuous', filePath: '/tmp/continuous.jsonl' })
    const firstBoundary = coordinator.flushPendingSnapshot({ maxEntries: 1 })
    await Promise.resolve()
    expect(sync).toHaveBeenCalledTimes(1)

    // These events arrive every 50ms, so the historical waitForIdle boundary
    // could rearm forever and prevent even one startup chunk from running.
    for (let index = 0; index < 20; index++) {
      sourceGeneration++
      coordinator.schedule({ sessionId: 'continuous', filePath: '/tmp/continuous.jsonl' })
      await vi.advanceTimersByTimeAsync(50)
    }
    first.resolve()
    await firstBoundary

    expect(backupGeneration).toBe(1)
    expect(transcriptGeneration).toBe(1)
    expect(coordinator.getStats().pending).toBe(1)
    let completedStartupChunks = 1

    // Every boundary processes one newest generation and then advances one
    // startup chunk, even while new events continue below the quiet window.
    for (let boundary = 0; boundary < 3; boundary++) {
      for (let index = 0; index < 5; index++) {
        sourceGeneration++
        coordinator.schedule({ sessionId: 'continuous', filePath: '/tmp/continuous.jsonl' })
        await vi.advanceTimersByTimeAsync(50)
      }
      await coordinator.flushPendingSnapshot({ maxEntries: 1 })
      completedStartupChunks++
    }

    expect(completedStartupChunks).toBe(4)
    expect(backupGeneration).toBe(sourceGeneration)
    expect(transcriptGeneration).toBe(sourceGeneration)
    expect(peak).toBe(1)
    expect(active).toBe(0)
  })

  it('round-robins continuously dirty keys while startup advances at every boundary', async () => {
    const served: string[] = []
    let active = 0
    let peak = 0
    const coordinator = new SessionSyncCoordinator({
      quietWindowMs: 2_000,
      concurrency: 1,
      sync: async (request) => {
        active++
        peak = Math.max(peak, active)
        served.push(request.sessionId || '')
        await Promise.resolve()
        active--
      }
    })
    let completedStartupChunks = 0
    coordinator.schedule({ sessionId: 'b', filePath: '/tmp/b.jsonl' })
    coordinator.schedule({ sessionId: 'c', filePath: '/tmp/c.jsonl' })

    for (let boundary = 0; boundary < 6; boundary++) {
      // a is deliberately always newest. Generation-only priority would pick
      // it forever and starve the quieter b/c pending keys.
      coordinator.schedule({ sessionId: 'a', filePath: '/tmp/a.jsonl' })
      await coordinator.flushPendingSnapshot({ maxEntries: 1 })
      completedStartupChunks++
    }

    expect(completedStartupChunks).toBe(6)
    expect(new Set(served.slice(0, 3))).toEqual(new Set(['a', 'b', 'c']))
    expect(served.filter((sessionId) => sessionId === 'a')).toHaveLength(4)
    expect(served.filter((sessionId) => sessionId === 'b')).toHaveLength(1)
    expect(served.filter((sessionId) => sessionId === 'c')).toHaveLength(1)
    expect(peak).toBe(1)
    expect(active).toBe(0)
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
