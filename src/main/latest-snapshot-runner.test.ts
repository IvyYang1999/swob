import { describe, expect, it, vi } from 'vitest'
import { LatestSnapshotRunner } from './latest-snapshot-runner'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('LatestSnapshotRunner', () => {
  it('runs the active snapshot and only the latest snapshot from a twenty-update burst', async () => {
    const first = deferred<number>()
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (value: number) => value)
    const runner = new LatestSnapshotRunner<number, number>({ run })

    const initial = runner.schedule(0)
    const burst = Array.from({ length: 20 }, (_item, index) => runner.schedule(index + 1))
    expect(run).toHaveBeenCalledTimes(1)
    first.resolve(0)

    await expect(initial).resolves.toBe(0)
    await expect(Promise.all(burst)).resolves.toEqual(new Array(20).fill(20))
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenNthCalledWith(2, 20)
  })

  it('merges sticky rebuild intent into the latest snapshot', async () => {
    const first = deferred<string>()
    const run = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async (value: { revision: number; rebuild: boolean }) => `${value.revision}:${value.rebuild}`)
    const runner = new LatestSnapshotRunner<{ revision: number; rebuild: boolean }, string>({
      run,
      merge: (current, incoming) => ({ ...incoming, rebuild: current.rebuild || incoming.rebuild })
    })

    void runner.schedule({ revision: 0, rebuild: false })
    const rebuild = runner.schedule({ revision: 1, rebuild: true })
    const latest = runner.schedule({ revision: 2, rebuild: false })
    first.resolve('first')

    await expect(rebuild).resolves.toBe('2:true')
    await expect(latest).resolves.toBe('2:true')
    await runner.waitForIdle()
  })
})
