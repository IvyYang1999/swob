/**
 * Convert a parsed event timestamp into the same local calendar day used by
 * AnalysisScope. Invalid or missing timestamps are explicit unknowns.
 */
export function localActivityDay(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

export function isActivityDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

/** Distinct, sorted local days backed by parsed message/event timestamps. */
export function activityDaysFromTimestamps(
  timestamps: Iterable<string | null | undefined>
): string[] {
  const days = new Set<string>()
  for (const timestamp of timestamps) {
    const day = localActivityDay(timestamp)
    if (day) days.add(day)
  }
  return [...days].sort()
}
