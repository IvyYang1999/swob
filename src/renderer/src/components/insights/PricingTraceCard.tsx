import { translate } from '../../i18n'
import { useStore } from '../../store'
import type { Valuation } from './shared'
import { formatTokenCount } from './shared'

const MISSING_REASON_LABELS: Record<string, string> = {
  'no-exact-provider-model-date-rule': 'renderer.pricing_trace.reason_no_rule',
  'model-not-in-catalog': 'renderer.pricing_trace.reason_model_missing',
  'model-unknown': 'renderer.pricing_trace.reason_model_unknown',
  'provider-unknown': 'renderer.pricing_trace.reason_provider_unknown',
  'timestamp-missing': 'renderer.pricing_trace.reason_timestamp_missing'
}

/** Every dollar traceable: parallel ledgers + exact snapshot/rule evidence. */
export function PricingTraceCard({ valuation, onOpenAudit }: {
  valuation: Valuation
  onOpenAudit?: () => void
}) {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const modes: Array<[string, string, number | undefined]> = [
    ['provider-billed', translate(locale, 'renderer.pricing_trace_card.provider_billed'), valuation.modeBreakdown['provider-billed']],
    ['harness-list-estimate', translate(locale, 'renderer.pricing_trace_card.harness_list_estimate'), valuation.modeBreakdown['harness-list-estimate']],
    ['swob-estimate', translate(locale, 'renderer.pricing_trace_card.swob_estimate'), valuation.modeBreakdown['swob-estimate']],
    ['api-equivalent', translate(locale, 'renderer.pricing_trace_card.api_equivalent'), valuation.modeBreakdown['api-equivalent']],
    ['subscription-allocated', translate(locale, 'renderer.pricing_trace_card.subscription_allocated'), valuation.modeBreakdown['subscription-allocated']]
  ]
  const catalogVersions = valuation.priceRevisions.length > 0
    ? valuation.priceRevisions
    : valuation.pricingRules.map((rule) => rule.catalogVersion)

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
          <span className="text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.pricing_trace_card.unpriced_tokens')}</span>
          <span className="text-soft-amber">
            {formatTokenCount(Math.max(0, valuation.totalBillableTokens - valuation.coveredTokens))}
            {' '}({(100 - valuation.coveragePercent).toFixed(1)}%)
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted">{translate(locale, 'renderer.pricing_trace_card.financial_coverage')}</span>
          <span className="font-medium text-primary">{valuation.financialCoveragePercent.toFixed(1)}%</span>
        </div>
      </div>

      {valuation.revisionNotices.map((notice) => (
        <div key={notice.revision} className="rounded border border-soft-amber/25 bg-soft-amber/5 px-2 py-1.5 text-[10px] text-soft-amber">
          {notice.notice[locale] || notice.notice.en}
        </div>
      ))}

      {valuation.missingReasons.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {translate(zh ? 'zh-CN' : 'en', 'renderer.pricing_trace_card.why_unpriced')}
          </div>
          {valuation.missingReasons.map((reason) => (
            <div key={reason} className="text-[10px] text-muted">
              • {MISSING_REASON_LABELS[reason] ? translate(locale, MISSING_REASON_LABELS[reason]) : reason}
            </div>
          ))}
        </div>
      )}

      {valuation.pricingRules.length > 0 && (
        <div className="space-y-0.5">
          <div className="text-[10px] font-medium uppercase tracking-wide text-faint">
            {translate(zh ? 'zh-CN' : 'en', 'renderer.pricing_trace_card.pricing_rules_used')}
          </div>
          <div className="max-h-32 space-y-0.5 overflow-y-auto pr-1">
            {valuation.pricingRules.map((rule) => (
              <div key={`${rule.eventDedupKey}:${rule.pricingRuleId}`} className="flex items-center justify-between gap-2 text-[10px]">
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

      {onOpenAudit && (
        <button
          type="button"
          onClick={onOpenAudit}
          className="text-[11px] font-medium text-accent hover:underline"
        >
          {translate(locale, 'renderer.pricing_trace_card.audit_calls')}
        </button>
      )}

      <div className="text-[10px] leading-relaxed text-faint">
        {catalogVersions.length > 0
          ? `${translate(zh ? 'zh-CN' : 'en', 'renderer.pricing_trace_card.catalog')}: ${catalogVersions.join(', ')} · `
          : ''}
        {translate(zh ? 'zh-CN' : 'en', 'renderer.pricing_trace_card.amounts_are_list_price_equivalents_not_cash_spend')}
      </div>
    </div>
  )
}
