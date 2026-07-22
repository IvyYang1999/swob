import { formatTokenCount } from './shared'
import type { Valuation } from './shared'
import { useT } from '../../i18n'

export function CostCard({ valuation, cacheRead, cacheCreate, totalInput }: {
  valuation: Valuation; cacheRead: number; cacheCreate: number; totalInput: number
}) {
  const t = useT()
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0
  const amount = valuation.usd === undefined ? t('renderer.cost_card.unpriced') : `$${valuation.usd.toFixed(2)}`

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="text-sm font-medium text-primary">{t('renderer.cost_card.title')}</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xl font-bold text-soft-amber">{amount}</div>
          <div className="text-[10px] text-muted">{t('renderer.cost_card.api_equivalent')}</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-soft-emerald">{cacheHitRate.toFixed(0)}%</div>
          <div className="text-[10px] text-muted">Cache Hit Rate</div>
        </div>
      </div>
      <div className="text-[11px] text-muted space-y-1">
        <div className="flex justify-between"><span>Cache read</span><span>{formatTokenCount(cacheRead)}</span></div>
        <div className="flex justify-between"><span>Cache create</span><span>{formatTokenCount(cacheCreate)}</span></div>
        <div className="flex justify-between"><span>{t('renderer.cost_card.coverage')}</span><span>{valuation.coveragePercent.toFixed(1)}%</span></div>
      </div>
      <div className="text-[9px] text-faint">{t('renderer.cost_card.caveat')}</div>
    </div>
  )
}
