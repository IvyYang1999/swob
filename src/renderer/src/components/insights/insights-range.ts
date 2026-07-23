import type { AnalysisScope } from '../../../../shared/analysis-scope-types'

function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addLocalDays(day: string, amount: number): string {
  const date = new Date(`${day}T12:00:00`)
  date.setDate(date.getDate() + amount)
  return localDay(date)
}

export function analysisRangeBounds(
  range: AnalysisScope['range'],
  dataDays: string[],
  now = new Date()
): { from: string; to: string } {
  const today = localDay(now)
  if (typeof range !== 'string') {
    return {
      from: range.from || dataDays[0] || range.to || today,
      to: range.to || today
    }
  }
  const presetDays: Partial<Record<typeof range, number>> = {
    today: 1,
    '7d': 7,
    '30d': 30,
    '90d': 90
  }
  const count = presetDays[range]
  if (count) return { from: addLocalDays(today, -(count - 1)), to: today }
  return { from: dataDays[0] || today, to: today }
}

export function filterDaysToAnalysisRange<T extends { date: string }>(
  data: T[],
  range: AnalysisScope['range'],
  now = new Date()
): T[] {
  const sorted = [...data].sort((left, right) => left.date.localeCompare(right.date))
  const bounds = analysisRangeBounds(range, sorted.map((item) => item.date), now)
  return sorted.filter((item) => item.date >= bounds.from && item.date <= bounds.to)
}

export function enumerateAnalysisDays(
  range: AnalysisScope['range'],
  dataDays: string[],
  now = new Date()
): string[] {
  const bounds = analysisRangeBounds(range, [...dataDays].sort(), now)
  if (bounds.from > bounds.to) return []
  const days: string[] = []
  for (let day = bounds.from; day <= bounds.to; day = addLocalDays(day, 1)) days.push(day)
  return days
}
