import type { InsightsData } from './shared'
import { formatTokenCount, formatDuration } from './shared'
import { useAnalysisScope } from './scope'

export function StatsCards({ data }: { data: InsightsData }) {
  const { scope } = useAnalysisScope()
  const activeDays = data.activeDays
  const dailyAvgTime = activeDays > 0 ? Math.round(data.totalTime / activeDays) : 0
  const conversationBasis = scope.basis === 'conversation'

  const cards = [
    {
      value: formatTokenCount(conversationBasis ? data.conversationOnlyTokens : data.totalTokens),
      label: conversationBasis ? 'Conversation Tokens' : 'Processed Tokens',
      sub: conversationBasis
        ? `billing total ${formatTokenCount(data.totalTokens)}`
        : `${formatTokenCount(data.totalInputTokens)} processed in / ${formatTokenCount(data.totalOutputTokens)} out`,
      title: conversationBasis
        ? 'Conversation-only restricts the same deduplicated ledger to main-thread events (excludes sidechains/subagents).'
        : 'Processed/billing total = non-cached input + cache read + cache write + output, after provider-specific deduplication. Sessions without authoritative usage are excluded.',
    },
    {
      value: data.valuation.usd === undefined ? '未计价' : `$${data.valuation.usd.toFixed(2)}`,
      label: 'API 等价值(估算)',
      sub: `价格覆盖 ${data.valuation.coveragePercent.toFixed(1)}%`,
      title: '逐请求按模型/Provider/时点估算的 API 标价等价值;未计价 token 不套默认价。不代表订阅下现金支出。',
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
      value: formatDuration(data.totalTime),
      label: 'Est. Time',
      sub: dailyAvgTime > 0 ? `${formatDuration(dailyAvgTime)}/day · ${activeDays} active days` : `${activeDays} active days`,
      title: 'Estimated from message timestamps; wall-clock and think time are not separated.',
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
