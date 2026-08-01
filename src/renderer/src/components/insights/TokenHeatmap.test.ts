import { describe, expect, it } from 'vitest'
import { fitHeatmapMonthLabels } from './TokenHeatmap'

describe('TokenHeatmap month labels', () => {
  it('【曾经的 bug】7d 跨月时不让两个短范围月份标签制造横向滚动', () => {
    expect(fitHeatmapMonthLabels([
      { label: 'Jul', col: 0 },
      { label: 'Aug', col: 1 }
    ], 2)).toEqual([{ label: 'Jul', col: 0 }])
  })

  it('保留有足够水平空间的月份标签', () => {
    expect(fitHeatmapMonthLabels([
      { label: 'Jan', col: 0 },
      { label: 'Feb', col: 4 },
      { label: 'Mar', col: 8 }
    ], 10)).toHaveLength(3)
  })
})
