import { describe, expect, it, vi } from 'vitest'
import { StartupProjectionGate } from './startup-projection-gate'

function manualIdleScheduler(): {
  scheduleIdle: (run: () => void) => void
  runNext: () => Promise<void>
  pending: () => number
} {
  const callbacks: Array<() => void> = []
  return {
    scheduleIdle: (run) => { callbacks.push(run) },
    runNext: async () => {
      const next = callbacks.shift()
      if (!next) throw new Error('No idle projection is scheduled')
      next()
      await Promise.resolve()
      await Promise.resolve()
    },
    pending: () => callbacks.length
  }
}

describe('StartupProjectionGate', () => {
  it('runs zero full projections for a warm dirty=0 startup', async () => {
    const idle = manualIdleScheduler()
    const gate = new StartupProjectionGate<string>({ scheduleIdle: idle.scheduleIdle })
    const search = vi.fn(async () => {})
    const usage = vi.fn(async () => 'synced')

    const searchRun = gate.scheduleSearch(search)
    const usageRun = gate.scheduleUsage({}, usage)
    gate.prepareStartup(false)
    gate.open(search, usage)

    await expect(searchRun).resolves.toBeUndefined()
    await expect(usageRun).resolves.toBeUndefined()
    expect(idle.pending()).toBe(0)
    expect(search).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
    expect(gate.getStats()).toMatchObject({
      searchFullRuns: 0,
      usageFullRuns: 0,
      maxConcurrentFullRuns: 0
    })

    // Later adoption/hydration callbacks in the same startup generation are
    // suppressed too; otherwise warm startup would accidentally rebuild.
    await expect(gate.scheduleSearch(search)).resolves.toBeUndefined()
    await expect(gate.scheduleUsage({}, usage)).resolves.toBeUndefined()
    expect(idle.pending()).toBe(0)
  })

  it.each([
    { scenario: 'dirty=1', dirty: 1 },
    { scenario: 'dirty=N', dirty: 2_000 }
  ])('bounds Search/Usage full runs for $scenario', async ({ dirty }) => {
    const idle = manualIdleScheduler()
    const gate = new StartupProjectionGate<string>({ scheduleIdle: idle.scheduleIdle })
    const order: string[] = []
    const search = vi.fn(async () => { order.push('search') })
    const usage = vi.fn(async () => { order.push('usage'); return `${dirty}` })

    gate.scheduleSearch(search)
    void gate.scheduleUsage({}, usage)
    gate.prepareStartup(dirty > 0)
    gate.open(search, usage)

    expect(search).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
    expect(idle.pending()).toBe(1)
    await idle.runNext()
    expect(search).toHaveBeenCalledOnce()
    expect(usage).not.toHaveBeenCalled()
    expect(idle.pending()).toBe(1)
    await idle.runNext()
    await gate.waitForIdle()

    expect(order).toEqual(['search', 'usage'])
    expect(gate.getStats()).toMatchObject({
      searchFullRuns: 1,
      usageFullRuns: 1,
      maxConcurrentFullRuns: 1
    })
  })

  it('keeps durable foreground reads available and refuses a concurrent second full projection', async () => {
    const idle = manualIdleScheduler()
    const gate = new StartupProjectionGate<string>({ scheduleIdle: idle.scheduleIdle })
    let finishSearch!: () => void
    const search = vi.fn(() => new Promise<void>((resolve) => { finishSearch = resolve }))
    const usage = vi.fn(async () => 'new-usage-snapshot')
    const durableSnapshot = { search: ['committed-result'], usage: 'committed-usage' }

    gate.scheduleSearch(search)
    void gate.scheduleUsage({}, usage)
    gate.prepareStartup(true)
    gate.open(search, usage)
    await idle.runNext()

    expect(search).toHaveBeenCalledOnce()
    expect(usage).not.toHaveBeenCalled()
    expect(durableSnapshot.search).toEqual(['committed-result'])
    expect(durableSnapshot.usage).toBe('committed-usage')
    expect(gate.getStats()).toMatchObject({ running: 'search', queued: 1 })

    finishSearch()
    await Promise.resolve()
    await Promise.resolve()
    expect(usage).not.toHaveBeenCalled()
    expect(idle.pending()).toBe(1)
    await idle.runNext()
    await gate.waitForIdle()
    expect(usage).toHaveBeenCalledOnce()
    expect(gate.getStats().maxConcurrentFullRuns).toBe(1)
  })

  it('upgrades a warm plan when a catch-up plan discovers dirty work', async () => {
    const idle = manualIdleScheduler()
    const gate = new StartupProjectionGate<string>({ scheduleIdle: idle.scheduleIdle })
    const search = vi.fn(async () => {})
    const usage = vi.fn(async () => 'catch-up')

    void gate.scheduleSearch(search)
    void gate.scheduleUsage({}, usage)
    gate.prepareStartup(false)
    gate.open(search, usage)
    gate.prepareStartup(true)

    await idle.runNext()
    await idle.runNext()
    await gate.waitForIdle()
    expect(search).toHaveBeenCalledOnce()
    expect(usage).toHaveBeenCalledOnce()
  })

  it('rejects deferred and queued work on reset but leaves an active prior worker alone', async () => {
    const idle = manualIdleScheduler()
    const gate = new StartupProjectionGate<string>({ scheduleIdle: idle.scheduleIdle })
    let finishPrior!: () => void
    const search = vi.fn(() => new Promise<void>((resolve) => { finishPrior = resolve }))
    const priorUsage = vi.fn(async () => 'prior-usage')

    const startupUsage = gate.scheduleUsage({}, priorUsage)
    gate.prepareStartup(true)
    gate.open(search, priorUsage)
    await idle.runNext()
    const queuedUsage = gate.scheduleUsage({ rebuild: true }, priorUsage)
    gate.reset(new Error('root changing'))
    await expect(startupUsage).rejects.toThrow('root changing')
    await expect(queuedUsage).rejects.toThrow('root changing')

    finishPrior()
    await Promise.resolve()
    await Promise.resolve()

    const nextSearch = vi.fn(async () => {})
    const nextUsage = vi.fn(async () => 'next-root')
    const next = gate.scheduleUsage({}, nextUsage)
    void gate.scheduleSearch(nextSearch)
    gate.prepareStartup(true)
    gate.open(nextSearch, nextUsage)
    await idle.runNext()
    await idle.runNext()
    await gate.waitForIdle()
    await expect(next).resolves.toBe('next-root')
    expect(nextSearch).toHaveBeenCalledOnce()
  })

  it('serializes later projection requests after startup finishes', async () => {
    const idle = manualIdleScheduler()
    const gate = new StartupProjectionGate<string>({ scheduleIdle: idle.scheduleIdle })
    const search = vi.fn(async () => {})
    const usage = vi.fn(async () => 'current')
    gate.open(search, usage)
    gate.finishStartup()

    const searchRun = gate.scheduleSearch(search)
    const usageRun = gate.scheduleUsage({}, usage)
    await idle.runNext()
    await expect(searchRun).resolves.toBeUndefined()
    expect(usage).not.toHaveBeenCalled()
    await idle.runNext()
    await expect(usageRun).resolves.toBe('current')
    expect(search).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledTimes(1)
  })
})
