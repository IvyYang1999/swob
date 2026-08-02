import { formatTokenCount } from './shared'
import type { BySource, Valuation } from './shared'
import { useT } from '../../i18n'
import { getPricingLabel, pricingLabelColor, pricingLabelBgColor } from '../../utils/pricing-label'

export function CostCard({ valuation, cacheRead, cacheCreate, totalInput, sources = [] }: {
  valuation: Valuation; cacheRead: number; cacheCreate: number; totalInput: number; sources?: BySource[]
}) {
  const t = useT()
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0
  const label = getPricingLabel(valuation)
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
  const measuredSources = sources.filter((source) =>
    source.totalTokens > 0 || source.tokenAvailableSessions > 0
  )
  const sourceIsUnpriced = (source: BySource): boolean =>
    source.valuationCapability.status === 'unavailable' || source.valuation.usd === undefined
  const sourceAmount = (source: BySource): string => {
    const usd = source.valuation.usd
    if (source.valuationCapability.status === 'unavailable' || usd === undefined) {
      return t('renderer.cost_card.measured_not_priced')
    }
    const sourceLabel = getPricingLabel(source.valuation)
    return `${formatUsd(usd)} · ${t(`renderer.pricing.${sourceLabel}`)}`
  }

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-primary">{t('renderer.cost_card.title')}</span>
        <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${pricingLabelBgColor(label)} ${pricingLabelColor(label)}`}>
          {t(`renderer.pricing.${label}`)}
        </span>
      </div>
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
        <div className="flex justify-between">
          <span>{t('renderer.pricing.basis')}</span>
          <span>{t(`renderer.pricing.basis_${valuation.mode === 'provider-billed' ? 'reported' : valuation.mode === 'mixed' ? 'mixed' : 'estimated'}`)}</span>
        </div>
      </div>
      {measuredSources.length > 0 && (
        <div className="space-y-1 border-t border-edge pt-2">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {t('renderer.cost_card.by_source')}
          </div>
          <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
            {measuredSources.map((source) => (
              <div
                key={source.source}
                className="flex items-center justify-between gap-3 text-[11px]"
                title={source.valuationCapability.reason}
              >
                <span className="truncate text-muted">{source.label}</span>
                <span className={sourceIsUnpriced(source) ? 'shrink-0 text-soft-amber' : 'shrink-0 text-primary'}>
                  {sourceAmount(source)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {valuation.revisionNotices.map((notice) => (
        <div key={notice.revision} className="rounded border border-soft-amber/25 bg-soft-amber/5 px-2 py-1 text-[10px] text-soft-amber">
          {t('renderer.pricing_trace_card.revised')}
        </div>
      ))}
      <div className="text-[10px] leading-relaxed text-faint">{t('renderer.cost_card.caveat')}</div>
    </div>
  )
}
