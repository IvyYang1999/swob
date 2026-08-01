import { formatTokenCount } from './shared'
import type { Valuation } from './shared'
import { useT } from '../../i18n'

export function CostCard({ valuation, cacheRead, cacheCreate, totalInput }: {
  valuation: Valuation; cacheRead: number; cacheCreate: number; totalInput: number
}) {
  const t = useT()
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0
  const ledgers = [
    {
      key: 'provider', label: t('renderer.cost_card.provider_billed'),
      amount: valuation.ledgerBreakdown.providerBilledUsd, tone: 'text-soft-emerald'
    },
    {
      key: 'harness', label: t('renderer.cost_card.harness_estimate'),
      amount: valuation.ledgerBreakdown.harnessListEstimateUsd, tone: 'text-blue-400'
    },
    {
      key: 'swob', label: t('renderer.cost_card.swob_estimate'),
      amount: valuation.ledgerBreakdown.swobEstimateUsd, tone: 'text-soft-amber'
    },
    {
      key: 'subscription', label: t('renderer.cost_card.subscription_allocated'),
      amount: valuation.ledgerBreakdown.subscriptionAllocatedUsd, tone: 'text-violet-400'
    }
  ].filter((ledger) => ledger.amount !== undefined)
  const formatUsd = (amount: number) => `$${amount >= 1 ? amount.toFixed(2) : amount.toFixed(4)}`

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="text-sm font-medium text-primary">{t('renderer.cost_card.title')}</div>
      <div className="grid grid-cols-[minmax(0,1fr)_96px] gap-4">
        <div className="min-w-0 space-y-1.5">
          {ledgers.length === 0 ? (
            <div className="text-sm text-muted">{t('renderer.cost_card.no_cost_ledger')}</div>
          ) : ledgers.map((ledger) => (
            <div key={ledger.key} className="flex items-center justify-between gap-3">
              <span className="truncate text-[11px] text-muted">{ledger.label}</span>
              <span className={`shrink-0 text-sm font-semibold tabular-nums ${ledger.tone}`}>
                {formatUsd(ledger.amount!)}
              </span>
            </div>
          ))}
        </div>
        <div className="border-l border-edge pl-3">
          <div className="text-2xl font-semibold text-soft-emerald">{cacheHitRate.toFixed(0)}%</div>
          <div className="text-[10px] leading-tight text-muted">{t('renderer.cost_card.cache_hit_rate')}</div>
        </div>
      </div>
      <div className="text-[11px] text-muted space-y-1">
        <div className="flex justify-between"><span>{t('renderer.cost_card.cache_read')}</span><span>{formatTokenCount(cacheRead)}</span></div>
        <div className="flex justify-between"><span>{t('renderer.cost_card.cache_create')}</span><span>{formatTokenCount(cacheCreate)}</span></div>
        <div className="flex justify-between"><span>{t('renderer.cost_card.coverage')}</span><span>{valuation.coveragePercent.toFixed(1)}%</span></div>
        <div className="flex justify-between"><span>{t('renderer.cost_card.financial_coverage')}</span><span>{valuation.financialCoveragePercent.toFixed(1)}%</span></div>
      </div>
      {valuation.revisionNotices.map((notice) => (
        <div key={notice.revision} className="rounded border border-soft-amber/25 bg-soft-amber/5 px-2 py-1 text-[10px] text-soft-amber">
          {t('renderer.pricing_trace_card.revised')}
        </div>
      ))}
      <div className="text-[10px] leading-relaxed text-faint">{t('renderer.cost_card.caveat')}</div>
    </div>
  )
}
