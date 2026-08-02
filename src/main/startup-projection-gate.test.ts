import { describe, expect, it, vi } from 'vitest'
import { StartupProjectionGate } from './startup-projection-gate'

describe('StartupProjectionGate', () => {
  it('coalesces full projections until the first durable startup boundary opens it', async () => {
    const gate = new StartupProjectionGate<string>()
    const search = vi.fn()
    const usage = vi.fn(async ({ rebuild }: { rebuild: boolean }) => rebuild ? 'rebuilt' : 'synced')

    gate.scheduleSearch(search)
    gate.scheduleSearch(search)
    const first = gate.scheduleUsage({}, usage)
    const second = gate.scheduleUsage({ rebuild: true }, usage)

    expect(search).not.toHaveBeenCalled()
    expect(usage).not.toHaveBeenCalled()
    gate.open(search, usage)

    expect(search).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledWith({ rebuild: true })
    await expect(first).resolves.toBe('rebuilt')
    await expect(second).resolves.toBe('rebuilt')
  })

  it('rejects every deferred startup waiter, drops search, and accepts a retry generation', async () => {
    const gate = new StartupProjectionGate<string>()
    const abandonedSearch = vi.fn()
    const abandonedUsage = vi.fn(async () => 'abandoned-startup')
    gate.scheduleSearch(abandonedSearch)
    const first = gate.scheduleUsage({}, abandonedUsage)
    const second = gate.scheduleUsage({ rebuild: true }, abandonedUsage)
    gate.reset(new Error('startup failed before durability'))

    await expect(first).rejects.toThrow('startup failed before durability')
    await expect(second).rejects.toThrow('startup failed before durability')
    expect(abandonedSearch).not.toHaveBeenCalled()
    expect(abandonedUsage).not.toHaveBeenCalled()

    const retrySearch = vi.fn()
    const usage = vi.fn(async () => 'new-root')
    const current = gate.scheduleUsage({}, usage)
    gate.scheduleSearch(retrySearch)
    gate.open(retrySearch, usage)
    await expect(current).resolves.toBe('new-root')
    expect(retrySearch).toHaveBeenCalledOnce()
  })

  it('root-switch failure rejects only its deferred generation and leaves prior worker work alone', async () => {
    const gate = new StartupProjectionGate<string>()
    let finishPrior!: (result: string) => void
    const priorWorkerRun = new Promise<string>((resolve) => { finishPrior = resolve })
    const priorUsage = vi.fn(() => priorWorkerRun)
    gate.open(() => {}, priorUsage)
    const alreadyRunning = gate.scheduleUsage({}, priorUsage)
    expect(priorUsage).toHaveBeenCalledOnce()

    gate.reset(new Error('root changing'))
    const failedSearch = vi.fn()
    const failedUsage = vi.fn(async () => 'failed-root')
    gate.scheduleSearch(failedSearch)
    const failedRoot = gate.scheduleUsage({ rebuild: true }, failedUsage)
    gate.reset(new Error('root switch failed'))

    await expect(failedRoot).rejects.toThrow('root switch failed')
    expect(failedSearch).not.toHaveBeenCalled()
    expect(failedUsage).not.toHaveBeenCalled()

    finishPrior('prior-complete')
    await expect(alreadyRunning).resolves.toBe('prior-complete')

    const nextSearch = vi.fn()
    const nextUsage = vi.fn(async () => 'next-root')
    gate.scheduleSearch(nextSearch)
    const nextRoot = gate.scheduleUsage({}, nextUsage)
    gate.open(nextSearch, nextUsage)
    await expect(nextRoot).resolves.toBe('next-root')
    expect(nextSearch).toHaveBeenCalledOnce()
  })

  it('runs incremental projection requests immediately after opening', async () => {
    const gate = new StartupProjectionGate<string>()
    const search = vi.fn()
    const usage = vi.fn(async () => 'current')
    gate.open(search, usage)

    gate.scheduleSearch(search)
    await expect(gate.scheduleUsage({}, usage)).resolves.toBe('current')
    expect(search).toHaveBeenCalledTimes(1)
    expect(usage).toHaveBeenCalledTimes(1)
  })
})
