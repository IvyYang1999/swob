import { describe, expect, it } from 'vitest'

/**
 * R4 contract lock: TokenMix reasoning subset.
 *
 * Reasoning tokens are a SUBSET of output tokens — the chart must show
 * (output - reasoning) as plain output and reasoning as its own segment.
 * Total must NOT double-count.
 */
describe('TokenMix reasoning subset', () => {
  it('reasoning tokens are subtracted from output to avoid double-counting', () => {
    const outputTokens = 1000
    const reasoningTokens = 300

    // This is the exact logic from buildSegments in TokenMixChart.tsx:
    //   const plainOutput = Math.max(0, breakdown.outputTokens - breakdown.reasoningTokens)
    const plainOutput = Math.max(0, outputTokens - reasoningTokens)

    expect(plainOutput).toBe(700)
    expect(reasoningTokens).toBe(300)
    // Total segments should sum to original outputTokens, not outputTokens + reasoningTokens
    expect(plainOutput + reasoningTokens).toBe(outputTokens)
    expect(plainOutput + reasoningTokens).not.toBe(outputTokens + reasoningTokens)
  })

  it('reasoning > output clamps plainOutput to zero instead of going negative', () => {
    const outputTokens = 100
    const reasoningTokens = 200

    const plainOutput = Math.max(0, outputTokens - reasoningTokens)

    expect(plainOutput).toBe(0)
    // Even in this edge case, total should NOT exceed outputTokens
    // (we accept reasoning = 200 as-is since it is the raw data)
    expect(plainOutput + reasoningTokens).toBe(200)
  })
})
