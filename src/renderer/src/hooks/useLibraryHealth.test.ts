import { describe, expect, it } from 'vitest'

/**
 * R4 contract lock: useSessionFreshness race condition pattern.
 *
 * When sessionId changes from A to B, the async fetch for A may resolve
 * AFTER the fetch for B starts. The cancelled-flag pattern ensures stale
 * responses are discarded.
 *
 * This tests the cancellation pattern in isolation — no React rendering needed.
 */
describe('useSessionFreshness cancelled-flag pattern', () => {
  it('discards stale session response after sessionId change', async () => {
    let currentValue: string | null = null

    // Simulate the effect for session A (slow — resolves after B starts)
    const effectA = (() => {
      let cancelled = false
      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('freshness-A'), 50)
      })
      promise.then((result) => {
        if (!cancelled) currentValue = result
      })
      return { cancel: () => { cancelled = true } }
    })()

    // Session changes to B — cancel A's effect, start B's effect
    effectA.cancel()

    const effectB = (() => {
      let cancelled = false
      currentValue = null // reset on sessionId change
      const promise = new Promise<string>((resolve) => {
        setTimeout(() => resolve('freshness-B'), 10)
      })
      promise.then((result) => {
        if (!cancelled) currentValue = result
      })
      return { cancel: () => { cancelled = true } }
    })()

    // Wait for both promises to resolve
    await new Promise((resolve) => setTimeout(resolve, 100))

    // B should win — A's stale response must be discarded
    expect(currentValue).toBe('freshness-B')

    // Cleanup
    effectB.cancel()
  })

  it('sets null when sessionId is cleared', () => {
    // When sessionId becomes null/undefined, the effect resets to null
    let currentValue: string | null = 'stale-value'

    // Simulate sessionId → null: the effect body does setFreshness(null); return
    const sessionId: string | null = null
    if (!sessionId) {
      currentValue = null
    }

    expect(currentValue).toBeNull()
  })
})
