import type { InsightsData, PreviousPeriodComparison } from './shared'
import { formatTokenCount, formatDuration } from './shared'
import { useAnalysisScope } from './scope'
import { useT } from '../../i18n'

function ComparisonArrow({ comparison }: { comparison: PreviousPeriodComparison | null }) {
  if (!comparison || comparison.percentChange == null) return null

  const pct = comparison.percentChange
  const isUp = pct > 0
  const isZero = pct === 0
  const arrow = isZero ? '=' : isUp ? '↑' : '↓'
  const color = isZero ? 'text-muted' : isUp ? 'text-green-400' : 'text-red-400'
  const displayPct = Math.abs(pct).toFixed(1)

  return (
    <span className={`inline-flex items-center gap-0.5 text-[10px] ${color}`} title={comparison.range.label}>
      {arrow} {displayPct}%
    </span>
  )
}

export function StatsCards({ data, previousPeriod }: { data: InsightsData; previousPeriod?: PreviousPeriodComparison | null }) {
  const { scope } = useAnalysisScope()
  const t = useT()
  const activeDays = data.activeDays
  const dailyAvgTime = activeDays > 0 ? Math.round(data.totalTime / activeDays) : 0
  const conversationBasis = scope.metricBasis === 'conversation'
  const primaryCost = data.valuation.ledgerBreakdown.providerBilledUsd !== undefined
    ? { amount: data.valuation.ledgerBreakdown.providerBilledUsd, label: t('renderer.cost_card.provider_billed') }
    : data.valuation.ledgerBreakdown.swobEstimateUsd !== undefined
      ? { amount: data.valuation.ledgerBreakdown.swobEstimateUsd, label: t('renderer.cost_card.swob_estimate') }
      : data.valuation.ledgerBreakdown.harnessListEstimateUsd !== undefined
        ? { amount: data.valuation.ledgerBreakdown.harnessListEstimateUsd, label: t('renderer.cost_card.harness_estimate') }
        : data.valuation.ledgerBreakdown.subscriptionAllocatedUsd !== undefined
          ? { amount: data.valuation.ledgerBreakdown.subscriptionAllocatedUsd, label: t('renderer.cost_card.subscription_allocated') }
          : null

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
      showComparison: true,
    },
    {
      value: primaryCost
        ? `$${primaryCost.amount.toFixed(2)}`
        : data.totalTokens > 0
          ? t('renderer.cost_card.measured_not_priced')
          : '—',
      label: primaryCost?.label || t('renderer.stats_cards.cost_ledgers'),
      sub: primaryCost ? t('renderer.stats_cards.coverage_both', {
        value0: data.valuation.coveragePercent.toFixed(1),
        value1: data.valuation.financialCoveragePercent.toFixed(1)
      }) : '',
      title: t('renderer.stats_cards.caveat'),
      showComparison: false,
    },
    {
      value: String(data.totalSessions),
      label: 'Sessions',
      sub: data.tokenUnavailableSessions > 0
        ? `${data.tokenAvailableSessions} with usage · ${data.tokenUnavailableSessions} unavailable`
        : '',
      title: 'Token-unavailable sessions remain in the session count but do not contribute a false zero to token totals.',
      showComparison: false,
    },
    {
      value: formatTokenCount(data.totalTurns),
      label: 'Total Turns',
      sub: '',
      title: '',
      showComparison: false,
    },
    {
      value: data.totalTime > 0 ? formatDuration(data.totalTime) : `${activeDays}d`,
      label: data.totalTime > 0 ? 'Est. Time' : 'Active Days',
      sub: data.totalTime > 0
        ? (dailyAvgTime > 0 ? `${formatDuration(dailyAvgTime)}/day · ${activeDays} active days` : `${activeDays} active days`)
        : '',
      title: 'Estimated from message timestamps; wall-clock and think time are not separated.',
      showComparison: false,
    },
  ]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <div key={c.label} className="bg-surface rounded-lg p-4 border border-edge" title={c.title || undefined}>
          <div className="text-xs text-muted mb-1">{c.label}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold text-primary">{c.value}</span>
            {c.showComparison && <ComparisonArrow comparison={previousPeriod ?? null} />}
          </div>
          {c.sub && <div className="text-[11px] text-muted mt-0.5">{c.sub}</div>}
        </div>
      ))}
    </div>
  )
}
