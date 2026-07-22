import { describe, expect, it, vi } from 'vitest'
import { runRuntimeCleanup } from './runtime-cleanup'

describe('runRuntimeCleanup', () => {
  it('runs cleanup steps in order and records their outcomes', async () => {
    const order: string[] = []
    const log = vi.fn()
    const result = await runRuntimeCleanup([
      { name: 'first', run: () => { order.push('first') } },
      { name: 'second', run: async () => { order.push('second') } }
    ], { totalBudgetMs: 100, log })

    expect(order).toEqual(['first', 'second'])
    expect(result.timedOut).toBe(false)
    expect(result.steps.map((step) => step.outcome)).toEqual(['ok', 'ok'])
    expect(log).toHaveBeenCalledWith('cleanup-complete', expect.objectContaining({ timedOut: false }))
  })

  it('returns at the total deadline when a cleanup promise never settles', async () => {
    const startedAt = Date.now()
    const result = await runRuntimeCleanup([
      { name: 'stuck', run: () => new Promise<void>(() => {}) },
      { name: 'skipped', run: vi.fn() }
    ], { totalBudgetMs: 20 })

    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(result.timedOut).toBe(true)
    expect(result.steps.map((step) => step.outcome)).toEqual(['timeout', 'timeout'])
  })
})
