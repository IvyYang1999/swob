import { useStore } from '../../store'
import type { Valuation } from './shared'
import { formatTokenCount } from './shared'

const MISSING_REASON_LABELS: Record<string, [string, string]> = {
  'no-exact-provider-model-date-rule': ['无该时点的精确价格规则', 'No exact provider/model/date rule'],
  'model-not-in-catalog': ['模型不在价格目录', 'Model not in catalog'],
  'model-unknown': ['模型未知', 'Model unknown'],
  'provider-unknown': ['Provider 未知', 'Provider unknown'],
  'timestamp-missing': ['事件缺少时间戳', 'Event has no timestamp']
}

/** Every dollar traceable: mode breakdown + the exact pricing rules used. */
export function PricingTraceCard({ valuation }: { valuation: Valuation }) {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const modes: Array<[string, string, number | undefined]> = [
    ['reported', zh ? '日志自带金额' : 'Reported in logs', valuation.modeBreakdown.reported],
    ['estimated-list-price', zh ? '精确规则估算' : 'Estimated (exact rule)', valuation.modeBreakdown['estimated-list-price']],
    ['api-equivalent', zh ? '原厂等价估算' : 'API equivalent', valuation.modeBreakdown['api-equivalent']]
  ]
  const catalogVersion = valuation.pricingRules[0]?.catalogVersion

  return (
    <div className="space-y-3">
      <div className="space-y-1 text-[11px]">
        {modes.filter(([, , usd]) => usd !== undefined && usd > 0).map(([key, label, usd]) => (
          <div key={key} className="flex justify-between">
            <span className="text-muted">{label}</span>
            <span className="font-medium text-primary">${usd!.toFixed(2)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-edge pt-1">
          <span className="text-muted">{zh ? '未计价 token' : 'Unpriced tokens'}</span>
          <span className="text-soft-amber">
            {formatTokenCount(Math.max(0, valuation.totalBillableTokens - valuation.coveredTokens))}
            {' '}({(100 - valuation.coveragePercent).toFixed(1)}%)
          </span>
        </div>
      </div>

      {valuation.missingReasons.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {zh ? '未计价原因' : 'Why unpriced'}
          </div>
          {valuation.missingReasons.map((reason) => (
            <div key={reason} className="text-[10px] text-muted">
              • {zh ? (MISSING_REASON_LABELS[reason]?.[0] || reason) : (MISSING_REASON_LABELS[reason]?.[1] || reason)}
            </div>
          ))}
        </div>
      )}

      {valuation.pricingRules.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {zh ? '使用的价格规则' : 'Pricing rules used'}
          </div>
          <div className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
            {valuation.pricingRules.map((rule) => (
              <div key={rule.pricingRuleId} className="flex items-center justify-between gap-2 text-[10px]">
                <span className="truncate text-secondary" title={`${rule.pricingRuleId} · ${rule.sourceUrl}`}>
                  {rule.modelCanonical}
                </span>
                <span className="shrink-0 text-faint">
                  {rule.provider} · {rule.effectiveFrom.slice(0, 10)} · {rule.source}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="text-[9px] text-faint">
        {catalogVersion ? `${zh ? '价格目录' : 'Catalog'}: ${catalogVersion} · ` : ''}
        {zh
          ? '金额为 API 标价等价值,不代表订阅下的现金支出。'
          : 'Amounts are list-price equivalents, not cash spend under subscriptions.'}
      </div>
    </div>
  )
}
