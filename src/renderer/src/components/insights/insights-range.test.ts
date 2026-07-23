import { describe, expect, it } from 'vitest'
import { enumerateAnalysisDays, filterDaysToAnalysisRange } from './insights-range'

const now = new Date('2026-07-23T12:00:00')

describe('insights range semantics', () => {
  it('renders exactly one visible day for today and seven for 7d', () => {
    expect(enumerateAnalysisDays('today', [], now)).toEqual(['2026-07-23'])
    expect(enumerateAnalysisDays('7d', [], now)).toEqual([
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23'
    ])
  })

  it('keeps all data for all and honors custom bounds without a fixed 30-row slice', () => {
    const data = [
      { date: '2026-06-01' },
      { date: '2026-07-01' },
      { date: '2026-07-23' }
    ]
    expect(filterDaysToAnalysisRange(data, 'all', now)).toEqual(data)
    expect(filterDaysToAnalysisRange(data, {
      from: '2026-07-01',
      to: '2026-07-23'
    }, now)).toEqual(data.slice(1))
  })
})
