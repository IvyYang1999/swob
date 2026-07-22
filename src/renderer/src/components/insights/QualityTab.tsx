import { useStore } from '../../store'
import { CardShell } from './CardShell'
import { PricingTraceCard } from './PricingTraceCard'
import { formatTokenCount, type InsightsData } from './shared'

function OkBadge({ ok, zh }: { ok: boolean; zh: boolean }) {
  return ok
    ? <span className="rounded bg-soft-emerald/15 px-1.5 py-0.5 text-[9px] text-soft-emerald">{zh ? '闭合' : 'OK'}</span>
    : <span className="rounded bg-red-400/15 px-1.5 py-0.5 text-[9px] text-red-400">{zh ? '不闭合' : 'MISMATCH'}</span>
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
        title="三级对账"
        titleEn="Reconciliation"
        tooltip={zh ? '全局、项目、会话三级由同一账本聚合,必须闭合' : 'Global, project and session totals must close from one ledger'}
      >
        <div className="space-y-1 text-[11px]">
          <div className="flex items-center justify-between">
            <span className="text-muted">{zh ? '全局 token' : 'Global tokens'}</span>
            <span className="font-medium text-primary">{formatTokenCount(recon.global)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Σ {zh ? '项目' : 'projects'}</span>
            <span className="font-medium text-primary">{formatTokenCount(recon.projects)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">Σ {zh ? '会话' : 'sessions'}</span>
            <span className="font-medium text-primary">{formatTokenCount(recon.sessions)}</span>
          </div>
          <div className="flex items-center justify-between border-t border-edge pt-1">
            <span className="text-muted">{zh ? 'token 差额' : 'Token difference'}</span>
            <span className="flex items-center gap-1.5">
              <span className="text-primary">{recon.difference}</span>
              <OkBadge ok={recon.ok} zh={zh} />
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted">{zh ? '金额差额' : 'USD difference'}</span>
            <span className="flex items-center gap-1.5">
              <span className="text-primary">${recon.valuation.difference.toFixed(4)}</span>
              <OkBadge ok={recon.valuation.ok} zh={zh} />
            </span>
          </div>
        </div>
      </CardShell>

      <CardShell
        title="用量可得性(按来源)"
        titleEn="Usage availability by source"
        tooltip={zh ? '拿不到权威用量的会话不会以 0 混入总量' : 'Sessions without authoritative usage never contribute a fake zero'}
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
                    <span className="text-soft-amber"> · {source.tokenUnavailableSessions} {zh ? '不可用' : 'n/a'}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
        <div className="text-[9px] text-faint">
          {zh
            ? `${data.tokenAvailableSessions} 个会话有权威用量,${data.tokenUnavailableSessions} 个标记为不可用。`
            : `${data.tokenAvailableSessions} sessions with authoritative usage, ${data.tokenUnavailableSessions} marked unavailable.`}
        </div>
      </CardShell>

      <CardShell title="定价覆盖与追溯" titleEn="Pricing coverage & trace" className="lg:col-span-2">
        <div className="mb-2 flex items-center gap-3">
          <div className="text-2xl font-bold text-primary">{data.valuation.coveragePercent.toFixed(1)}%</div>
          <div className="text-[10px] leading-tight text-muted">
            {zh ? '已计价 token 占比' : 'of billable tokens priced'}<br />
            {formatTokenCount(data.valuation.coveredTokens)} / {formatTokenCount(data.valuation.totalBillableTokens)}
          </div>
        </div>
        <PricingTraceCard valuation={data.valuation} />
      </CardShell>
    </div>
  )
}
