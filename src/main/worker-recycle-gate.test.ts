import { describe, expect, it } from 'vitest'
import { WorkerRecycleGate } from './worker-recycle-gate'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve }
}

describe('WorkerRecycleGate', () => {
  it('drains A/B on one worker and makes C wait until replacement completes', async () => {
    const gate = new WorkerRecycleGate()
    const bMayFinish = deferred()
    const closeMayFinish = deferred()
    const events: string[] = []
    let workerGeneration = 1
    let activeWorkers = 1
    let peakWorkers = 1

    const a = (async () => {
      events.push('A:done-on-1')
      await gate.begin(async () => {
        events.push('recycle:drain-start')
        await bMayFinish.promise
        events.push('B:done-on-1')
        await closeMayFinish.promise
        activeWorkers--
        events.push('recycle:closed-1')
      })
      workerGeneration = 0
    })()

    // B was already queued on worker 1. Recycling drains it rather than
    // creating worker 2 or rejecting the request.
    bMayFinish.resolve()
    const c = (async () => {
      await gate.wait()
      if (workerGeneration === 0) {
        workerGeneration = 2
        activeWorkers++
        peakWorkers = Math.max(peakWorkers, activeWorkers)
      }
      events.push(`C:done-on-${workerGeneration}`)
    })()
    await Promise.resolve()
    expect(events).not.toContain('C:done-on-2')
    expect(peakWorkers).toBe(1)

    closeMayFinish.resolve()
    await Promise.all([a, c])
    expect(events).toEqual([
      'A:done-on-1',
      'recycle:drain-start',
      'B:done-on-1',
      'recycle:closed-1',
      'C:done-on-2'
    ])
    expect(peakWorkers).toBe(1)
    expect(gate.isActive()).toBe(false)
  })

  it('clears a rejected recycle so C can recover with a replacement worker', async () => {
    const gate = new WorkerRecycleGate()
    const closeFailure = new Error('fixture close failed')
    const recycle = gate.begin(async () => { throw closeFailure })

    await expect(recycle).rejects.toBe(closeFailure)
    expect(gate.isActive()).toBe(false)

    let replacementCreated = false
    await gate.wait().catch(() => undefined)
    replacementCreated = true
    expect(replacementCreated).toBe(true)
    await expect(gate.begin(async () => {})).resolves.toBeUndefined()
  })
})
