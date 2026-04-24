import type { InsightsData } from './shared'
import { formatTokenCount, formatDuration } from './shared'

export function StatsCards({ data }: { data: InsightsData }) {
  const activeDays = data.activeDays
  const dailyAvgTime = activeDays > 0 ? Math.round(data.totalTime / activeDays) : 0

  const cards = [
    {
      value: formatTokenCount(data.totalTokens),
      label: 'Total Tokens',
      sub: `${formatTokenCount(data.totalInputTokens)} in / ${formatTokenCount(data.totalOutputTokens)} out`,
    },
    {
      value: String(data.totalSessions),
      label: 'Sessions',
      sub: '',
    },
    {
      value: formatTokenCount(data.totalTurns),
      label: 'Total Turns',
      sub: '',
    },
    {
      value: String(activeDays),
      label: 'Active Days',
      sub: '',
    },
    {
      value: formatDuration(data.totalTime),
      label: 'Est. Time',
      sub: dailyAvgTime > 0 ? `${formatDuration(dailyAvgTime)}/day` : '',
    },
  ]

  return (
    <div className="grid grid-cols-5 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-surface rounded-lg p-4 border border-edge">
          <div className="text-lg font-medium text-primary">{c.value}</div>
          <div className="text-xs text-muted">{c.label}</div>
          {c.sub && <div className="text-[11px] text-muted mt-0.5">{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}
