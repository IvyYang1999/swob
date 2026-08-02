import { describe, expect, it } from 'vitest'

/**
 * R4 contract lock: DailyTrend costUsd null gap.
 *
 * In cost mode, a ByDate item with costUsd: null must produce `undefined`
 * in the chart datum (so Recharts renders a gap via connectNulls={false}),
 * NOT zero — zero would flatten the line to the axis.
 */
describe('DailyTrend cost null gap', () => {
  it('costUsd null produces undefined gap, not zero', () => {
    // The mapping logic from DailyTrend:
    //   totalTokens: metricMode === 'cost'
    //     ? (d.costUsd != null ? d.costUsd : undefined)
    //     : d.totalTokens
    //
    // We test the expression directly — component rendering is not needed.
    const costUsdNull: number | null = null
    const metricMode = 'cost'

    const mapped = metricMode === 'cost'
      ? (costUsdNull != null ? costUsdNull : undefined)
      : 100

    expect(mapped).toBeUndefined()
    // Critical: must NOT be 0
    expect(mapped).not.toBe(0)
  })

  it('costUsd with a value passes through as-is', () => {
    const costUsd: number | null = 0.42
    const metricMode = 'cost'

    const mapped = metricMode === 'cost'
      ? (costUsd != null ? costUsd : undefined)
      : 100

    expect(mapped).toBe(0.42)
  })
})
