import type { InsightsData } from './shared'
import { formatTokenCount, formatDuration } from './shared'

export function StatsCards({ data }: { data: InsightsData }) {
  const activeDays = data.activeDays
  const dailyAvgTime = activeDays > 0 ? Math.round(data.totalTime / activeDays) : 0

  const cards = [
    {
      value: formatTokenCount(data.totalTokens),
      label: 'Processed Tokens',
      sub: `${formatTokenCount(data.totalInputTokens)} processed in / ${formatTokenCount(data.totalOutputTokens)} out`,
      title: 'Processed/billing total = non-cached input + cache read + cache write + output, after provider-specific deduplication. Sessions without authoritative usage are excluded.',
    },
    {
      value: String(data.totalSessions),
      label: 'Sessions',
      sub: data.tokenUnavailableSessions > 0
        ? `${data.tokenAvailableSessions} with usage · ${data.tokenUnavailableSessions} unavailable`
        : '',
      title: 'Token-unavailable sessions remain in the session count but do not contribute a false zero to token totals.',
    },
    {
      value: formatTokenCount(data.totalTurns),
      label: 'Total Turns',
      sub: '',
      title: '',
    },
    {
      value: String(activeDays),
      label: 'Active Days',
      sub: '',
      title: '',
    },
    {
      value: formatDuration(data.totalTime),
      label: 'Est. Time',
      sub: dailyAvgTime > 0 ? `${formatDuration(dailyAvgTime)}/day` : '',
      title: '',
    },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-surface rounded-lg p-4 border border-edge" title={c.title || undefined}>
          <div className="text-xs text-muted mb-1">{c.label}</div>
          <div className="text-2xl font-semibold text-primary">{c.value}</div>
          {c.sub && <div className="text-[11px] text-muted mt-0.5">{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}
