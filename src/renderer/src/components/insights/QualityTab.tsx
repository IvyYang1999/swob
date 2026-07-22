import { translate } from '../../i18n'
import { useStore } from '../../store'
import { CardShell } from './CardShell'
import { PricingTraceCard } from './PricingTraceCard'
import { formatTokenCount, type InsightsData } from './shared'

function OkBadge({ ok, zh }: { ok: boolean; zh: boolean }) {
  return ok
    ? <span className="rounded bg-soft-emerald/15 px-1.5 py-0.5 text-[9px] text-soft-emerald">{translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.ok')}</span>
    : <span className="rounded bg-red-400/15 px-1.5 py-0.5 text-[9px] text-red-400">{translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.mismatch')}</span>
}

/**
 * Data Quality is a first-class page, not a footnote: coverage, reconciliation
 * and unavailability are the product's trust story for local multi-provider logs.
 */
export function QualityTab({ data }: { data: InsightsData }) {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const recon = data.reconciliation

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <CardShell
        title={translate(locale, 'renderer.quality_tab.reconciliation')}
        tooltip={translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.global_project_and_session_totals_must_close_from')}
      >
        <div className="space-y-1 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.global_tokens')}</span>
            <span className="font-medium text-primary">{formatTokenCount(recon.global)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Σ {translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.projects')}</span>
            <span className="font-medium text-primary">{formatTokenCount(recon.projects)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Σ {translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.sessions')}</span>
            <span className="font-medium text-primary">{formatTokenCount(recon.sessions)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-edge pt-1">
            <span className="text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.token_difference')}</span>
            <span className="flex items-center gap-1.5">
              <span className="text-primary">{recon.difference}</span>
              <OkBadge ok={recon.ok} zh={zh} />
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.usd_difference')}</span>
            <span className="flex items-center gap-1.5">
              <span className="text-primary">${recon.valuation.difference.toFixed(4)}</span>
              <OkBadge ok={recon.valuation.ok} zh={zh} />
            </span>
          </div>
        </div>
      </CardShell>

      <CardShell
        title={translate(locale, 'renderer.quality_tab.usage_availability')}
        tooltip={translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.sessions_without_authoritative_usage_never_contribute_a_fake')}
      >
        <div className="space-y-1 text-[11px]">
          {data.bySource.map((source) => {
            const total = source.tokenAvailableSessions + source.tokenUnavailableSessions
            return (
              <div key={source.source} className="flex items-center justify-between gap-2">
                <span className="w-24 shrink-0 truncate text-secondary">{source.label}</span>
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-hover">
                  <div
                    className="h-full rounded bg-soft-emerald/70"
                    style={{ width: total > 0 ? `${(source.tokenAvailableSessions / total) * 100}%` : 0 }}
                  />
                </div>
                <span className="shrink-0 text-[10px] text-muted">
                  {source.tokenAvailableSessions}/{total}
                  {source.tokenUnavailableSessions > 0 && (
                    <span className="text-soft-amber"> · {source.tokenUnavailableSessions} {translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.n_a')}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        <div className="text-[9px] text-faint">
          {translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.value_sessions_with_authoritative_usage_value_marked_unavailable', { value0: data.tokenAvailableSessions, value1: data.tokenUnavailableSessions })}
        </div>
      </CardShell>

      <CardShell title={translate(locale, 'renderer.quality_tab.pricing_trace')} className="lg:col-span-2">
        <div className="mb-2 flex items-center gap-3">
          <div className="text-2xl font-bold text-primary">{data.valuation.coveragePercent.toFixed(1)}%</div>
          <div className="text-[10px] leading-tight text-muted">
            {translate(zh ? 'zh-CN' : 'en', 'renderer.quality_tab.of_billable_tokens_priced')}<br />
            {formatTokenCount(data.valuation.coveredTokens)} / {formatTokenCount(data.valuation.totalBillableTokens)}
          </div>
        </div>
        <PricingTraceCard valuation={data.valuation} />
      </CardShell>
    </div>
  )
}
