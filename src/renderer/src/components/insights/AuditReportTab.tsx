import { useMemo, useState } from 'react'
import { formatTokenCount, SOURCE_COLORS, type Valuation } from './shared'
import { useT } from '../../i18n'
import { useReportJob } from './useReportJob'
import type { ReportJobParams } from '../../../../shared/report-jobs'
import { getPricingLabel, pricingLabelColor, pricingLabelBgColor } from '../../utils/pricing-label'

type TimeRange = 'today' | 'week' | 'month' | '30d' | '90d' | 'all'

interface InsightsReport {
  generatedAt: string
  dateRange: { start: string; end: string }
  totalSessions: number
  totalTurns: number
  totalTokens: number
  tokenAvailability: { availableSessions: number; unavailableSessions: number }
  valuation: Valuation
  activeDays: number
  totalActiveHours: number
  bySource: Array<{
    source: string
    valuationCapability: {
      status: 'billable-exact' | 'estimate-only' | 'unavailable'
      reason: string
    }
    sessions: number
    turns: number
    tokens: number
    valuation: Valuation
    unavailableSessions: number
  }>
  bySessionType: Record<string, number>
  healthDistribution: { excellent: number; good: number; fair: number; poor: number; avgScore: number }
  topTools: Array<{ name: string; count: number; errorRate: number }>
  topModels: Array<{ model: string; turns: number; valuation: Valuation }>
  visibleFrameworkMarkers: { avgEstimatedTokens: number }
  readEditRatio: { avg: number; healthyCnt: number; degradedCnt: number; criticalCnt: number }
  totalAntiPatterns: number
  totalFrustrationSignals: number
  totalInterruptions: number
  findings: string[]
}

const TIME_RANGES: Array<{ id: TimeRange; labelKey: string }> = [
  { id: 'today', labelKey: 'renderer.audit_report.range_today' },
  { id: 'week', labelKey: 'renderer.audit_report.range_week' },
  { id: 'month', labelKey: 'renderer.audit_report.range_month' },
  { id: '30d', labelKey: 'renderer.audit_report.range_30d' },
  { id: '90d', labelKey: 'renderer.audit_report.range_90d' },
  { id: 'all', labelKey: 'renderer.audit_report.range_all' },
]

function StatCard({ value, label, color, badge, badgeColor }: {
  value: string; label: string; color?: string; badge?: string; badgeColor?: string
}) {
  return (
    <div className="bg-surface rounded-lg p-3 border border-edge text-center">
      <div className="flex items-center justify-center gap-1.5">
        <span className={`text-xl font-bold ${color || 'text-primary'}`}>{value}</span>
        {badge && (
          <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${badgeColor || ''}`}>
            {badge}
          </span>
        )}
      </div>
      <div className="text-[10px] text-muted mt-0.5">{label}</div>
    </div>
  )
}

function HealthBar({ d }: { d: InsightsReport['healthDistribution'] }) {
  const t = useT()
  const total = d.excellent + d.good + d.fair + d.poor || 1
  const bars = [
    { n: d.excellent, color: '#3fb950', label: t('renderer.audit_report.health_excellent') },
    { n: d.good, color: '#58a6ff', label: t('renderer.audit_report.health_good') },
    { n: d.fair, color: '#f59e0b', label: t('renderer.audit_report.health_fair') },
    { n: d.poor, color: '#f85149', label: t('renderer.audit_report.health_poor') },
  ].filter(b => b.n > 0)
  return (
    <div>
      <div className="flex h-5 rounded overflow-hidden gap-0.5">
        {bars.map(b => (
          <div key={b.label} style={{ flex: b.n, backgroundColor: b.color }} className="flex items-center justify-center text-[9px] text-white font-medium rounded">
            {b.n > total * 0.08 ? b.n : ''}
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted mt-1">
        <span>{t('renderer.audit_report.avg_score')}: <strong className="text-primary">{d.avgScore.toFixed(0)}</strong>/100</span>
        <span>{bars.map(b => `${b.label}: ${b.n}`).join(' · ')}</span>
      </div>
    </div>
  )
}

function paramsForRange(range: TimeRange): ReportJobParams {
  if (range === 'all') return {}
  const now = new Date()
  let start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (range === 'week') start.setDate(start.getDate() - start.getDay())
  else if (range === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1)
  else if (range === '30d') start.setDate(start.getDate() - 30)
  else if (range === '90d') start.setDate(start.getDate() - 90)
  return { startDate: start.toISOString() }
}

function stageKey(stage: string): string {
  if (stage === 'queued') return 'renderer.report_job.stage_queued'
  if (stage === 'starting') return 'renderer.report_job.stage_starting'
  if (stage === 'analyzing') return 'renderer.report_job.stage_analyzing'
  if (stage === 'sampling') return 'renderer.report_job.stage_sampling'
  if (stage === 'llm') return 'renderer.report_job.stage_llm'
  if (stage === 'writing') return 'renderer.report_job.stage_writing'
  return 'renderer.report_job.stage_working'
}

export function AuditReportTab() {
  const t = useT()
  const [range, setRange] = useState<TimeRange>('30d')
  const params = useMemo(() => paramsForRange(range), [range])
  const { job, pendingRequest, requestError, start, cancel } = useReportJob('audit', params)
  const active = job?.state === 'queued' || job?.state === 'running'
  const report = job?.state === 'completed' && job.result?.report
    ? job.result.report as InsightsReport
    : null
  const errorCode = requestError || (job?.state === 'failed' ? job.error?.code || 'report-failed' : null)

  return (
    <div className="space-y-4">
      {/* Time range selector */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1 flex-wrap">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.id}
              onClick={() => setRange(tr.id)}
              className={`px-2.5 py-1 rounded-md text-xs transition-colors ${
                range === tr.id
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'bg-surface text-muted hover:text-primary hover:bg-hover'
              }`}
            >
              {t(tr.labelKey)}
            </button>
          ))}
        </div>
        {!active && (
          <button
            onClick={() => void start(job?.state === 'completed')}
            disabled={pendingRequest}
            className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50"
          >
            {job?.state === 'completed'
              ? t('renderer.audit_report.refresh')
              : job?.state === 'failed' || job?.state === 'cancelled'
                ? t('renderer.audit_report.retry')
                : t('renderer.audit_report.generate')}
          </button>
        )}
      </div>

      {active && job && (
        <div className="space-y-2 py-6" aria-live="polite">
          <div className="flex items-center justify-center gap-2 text-[11px] text-secondary">
            <div className="animate-spin w-4 h-4 border-2 border-soft-blue border-t-transparent rounded-full" />
            {t(stageKey(job.progress.stage))}… {job.progress.current}/{job.progress.total}
            <button onClick={() => void cancel()} className="ml-2 text-muted hover:text-primary underline underline-offset-2">
              {t('renderer.report_job.cancel')}
            </button>
          </div>
          <div className="h-1 max-w-sm mx-auto rounded-full bg-edge overflow-hidden">
            <div className="h-full bg-soft-blue transition-all duration-300" style={{ width: `${job.progress.percent}%` }} />
          </div>
        </div>
      )}

      {!active && report && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatCard value={String(report.totalSessions)} label={t('renderer.audit_report.sessions')} />
            <StatCard value={formatTokenCount(report.totalTokens)} label={t('renderer.audit_report.processed_tokens')} />
            <StatCard
              value={report.valuation.usd === undefined && report.totalTokens > 0
                ? t('renderer.cost_card.measured_not_priced')
                : report.valuation.usd === undefined
                  ? t('renderer.audit_report.unpriced')
                  : `$${report.valuation.usd.toFixed(2)}`}
              label={t('renderer.audit_report.api_equivalent_coverage', { value0: report.valuation.coveragePercent.toFixed(1) })}
              color={pricingLabelColor(getPricingLabel(report.valuation))}
              badge={t(`renderer.pricing.${getPricingLabel(report.valuation)}`)}
              badgeColor={`${pricingLabelBgColor(getPricingLabel(report.valuation))} ${pricingLabelColor(getPricingLabel(report.valuation))}`}
            />
          </div>

          <HealthBar d={report.healthDistribution} />

          {report.bySource.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-primary">{t('renderer.audit_report.by_source')}</div>
              {report.bySource.map(s => (
                <div key={s.source} className="flex items-center gap-2 text-[11px]" title={s.valuationCapability.reason}>
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SOURCE_COLORS[s.source] || '#6b7280' }} />
                  <span className="text-secondary w-20 truncate">{s.source}</span>
                  <span className="text-muted">
                    {t('renderer.audit_report.source_sessions_tokens', { value0: s.sessions, value1: formatTokenCount(s.tokens) })}
                    {s.unavailableSessions > 0 ? ` · ${t('renderer.audit_report.unavailable_count', { value0: s.unavailableSessions })}` : ''}
                  </span>
                  <span className="text-muted ml-auto flex items-center gap-1">
                    {s.valuation.usd === undefined
                      ? t('renderer.audit_report.unpriced')
                      : `$${s.valuation.usd.toFixed(2)} · ${s.valuation.coveragePercent.toFixed(1)}%`}
                    <span className={`inline-flex rounded-full border px-1 py-px text-[9px] font-medium ${pricingLabelBgColor(getPricingLabel(s.valuation))} ${pricingLabelColor(getPricingLabel(s.valuation))}`}>
                      {t(`renderer.pricing.${getPricingLabel(s.valuation)}`)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}

          {report.findings.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-primary">{t('renderer.audit_report.key_findings')}</div>
              {report.findings.map((f, i) => (
                <div key={i} className="text-[11px] text-muted pl-3 py-1 border-l-2 border-soft-amber/30">{f}</div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <StatCard value={String(report.totalAntiPatterns)} label={t('renderer.audit_report.anti_patterns')} color="text-soft-amber" />
            <StatCard value={String(report.totalFrustrationSignals)} label={t('renderer.audit_report.frustration')} color="text-red-400" />
            <StatCard value={String(report.totalInterruptions)} label={t('renderer.audit_report.interruptions')} />
          </div>
        </>
      )}

      {!active && errorCode && (
        <div className="text-center text-red-400 text-xs py-4">
          {t('renderer.report_job.failed_with_code', { value0: errorCode })}
          {job?.state === 'failed'
            ? ` · ${t('renderer.report_job.failed_stage', { value0: t(stageKey(job.error?.stage || job.progress.stage)) })}`
            : ''}
        </div>
      )}

      {!active && job?.state === 'cancelled' && !errorCode && (
        <div className="text-center text-muted text-xs py-4">{t('renderer.report_job.cancelled')}</div>
      )}

      {!active && !report && !errorCode && job?.state !== 'cancelled' && (
        <div className="text-center text-muted text-sm py-12">
          {t('renderer.audit_report.generate_hint')}
        </div>
      )}
    </div>
  )
}
