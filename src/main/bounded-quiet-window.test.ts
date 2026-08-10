import { describe, expect, it, vi } from 'vitest'
import { boundedQuietWindowDelay } from './bounded-quiet-window'

describe('boundedQuietWindowDelay', () => {
  it('reaches maxWait while newer generations keep resetting the quiet edge', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const firstRequestedAt = Date.now()
    let delay = 0
    try {
      for (let generation = 1; generation <= 61; generation++) {
        vi.advanceTimersByTime(500)
        // Target generation changes, but the root+epoch burst origin does not.
        delay = boundedQuietWindowDelay(firstRequestedAt, Date.now(), Date.now(), 750, 30_000)
        if (Date.now() < 30_000) expect(delay).toBeGreaterThan(0)
      }
      expect(Date.now()).toBeGreaterThan(30_000)
      expect(delay).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
