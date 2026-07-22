import { useState, useEffect, useCallback } from 'react'
import { formatTokenCount, SOURCE_COLORS, type Valuation } from './shared'

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

const TIME_RANGES: Array<{ id: TimeRange; labelZh: string; labelEn: string }> = [
  { id: 'today', labelZh: '今日', labelEn: 'Today' },
  { id: 'week', labelZh: '本周', labelEn: 'This Week' },
  { id: 'month', labelZh: '本月', labelEn: 'This Month' },
  { id: '30d', labelZh: '近 30 天', labelEn: 'Last 30d' },
  { id: '90d', labelZh: '近 90 天', labelEn: 'Last 90d' },
  { id: 'all', labelZh: '全部', labelEn: 'All Time' },
]

function StatCard({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div className="bg-surface rounded-lg p-3 border border-edge text-center">
      <div className={`text-xl font-bold ${color || 'text-primary'}`}>{value}</div>
      <div className="text-[10px] text-muted mt-0.5">{label}</div>
    </div>
  )
}

function HealthBar({ d }: { d: InsightsReport['healthDistribution'] }) {
  const total = d.excellent + d.good + d.fair + d.poor || 1
  const bars = [
    { n: d.excellent, color: '#3fb950', label: 'Excellent' },
    { n: d.good, color: '#58a6ff', label: 'Good' },
    { n: d.fair, color: '#f59e0b', label: 'Fair' },
    { n: d.poor, color: '#f85149', label: 'Poor' },
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
        <span>Avg Score: <strong className="text-primary">{d.avgScore.toFixed(0)}</strong>/100</span>
        <span>{bars.map(b => `${b.label}: ${b.n}`).join(' · ')}</span>
      </div>
    </div>
  )
}

export function AuditReportTab() {
  const [range, setRange] = useState<TimeRange>('30d')
  const [report, setReport] = useState<InsightsReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ stage: string; current: number; total: number } | null>(null)

  const loadReport = useCallback(async (r: TimeRange) => {
    setLoading(true)
    setProgress(null)
    setReport(null)
    const now = new Date()
    let startDate: string | undefined
    if (r === 'today') startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
    else if (r === 'week') { const d = new Date(now); d.setDate(d.getDate() - d.getDay()); d.setHours(0,0,0,0); startDate = d.toISOString() }
    else if (r === 'month') startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    else if (r === '30d') { const d = new Date(now); d.setDate(d.getDate() - 30); startDate = d.toISOString() }
    else if (r === '90d') { const d = new Date(now); d.setDate(d.getDate() - 90); startDate = d.toISOString() }
    try {
      const unsub = window.api.onInsightsProgress((p) => setProgress(p))
      const result = await window.api.generateInsightsJson({ startDate })
      unsub()
      if (result.ok && result.report) {
        setReport(result.report as InsightsReport)
      }
    } catch { /* ignore */ }
    setLoading(false)
    setProgress(null)
  }, [])

  useEffect(() => {
    // Auto-load on mount
    loadReport(range)
  }, [range]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {/* Time range selector */}
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
            {tr.labelZh}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-[11px] text-secondary py-8 justify-center">
          <div className="animate-spin w-4 h-4 border-2 border-soft-blue border-t-transparent rounded-full" />
          {progress ? `${progress.stage}… ${progress.current}/${progress.total}` : 'Analyzing…'}
        </div>
      )}

      {!loading && report && (
        <>
          <div className="grid grid-cols-3 gap-3">
            <StatCard value={String(report.totalSessions)} label="Sessions" />
            <StatCard value={formatTokenCount(report.totalTokens)} label="Processed Tokens" />
            <StatCard
              value={report.valuation.usd === undefined ? '未计价' : `$${report.valuation.usd.toFixed(2)}`}
              label={`API 等价值(估算) · 覆盖 ${report.valuation.coveragePercent.toFixed(1)}%`}
              color="text-soft-amber"
            />
          </div>

          <HealthBar d={report.healthDistribution} />

          {report.bySource.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs font-medium text-primary">By Source</div>
              {report.bySource.map(s => (
                <div key={s.source} className="flex items-center gap-2 text-[11px]">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: SOURCE_COLORS[s.source] || '#6b7280' }} />
                  <span className="text-secondary w-20 truncate">{s.source}</span>
                  <span className="text-muted">
                    {s.sessions} sessions · {formatTokenCount(s.tokens)}
                    {s.unavailableSessions > 0 ? ` · ${s.unavailableSessions} unavailable` : ''}
                  </span>
                  <span className="text-muted ml-auto">
                    {s.valuation.usd === undefined ? '未计价' : `$${s.valuation.usd.toFixed(2)} · ${s.valuation.coveragePercent.toFixed(1)}%`}
                  </span>
                </div>
              ))}
            </div>
          )}

          {report.findings.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-primary">Key Findings</div>
              {report.findings.map((f, i) => (
                <div key={i} className="text-[11px] text-muted pl-3 py-1 border-l-2 border-soft-amber/30">{f}</div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-3 gap-3">
            <StatCard value={String(report.totalAntiPatterns)} label="Anti-patterns" color="text-soft-amber" />
            <StatCard value={String(report.totalFrustrationSignals)} label="Frustration" color="text-red-400" />
            <StatCard value={String(report.totalInterruptions)} label="Interruptions" />
          </div>
        </>
      )}

      {!loading && !report && (
        <div className="text-center text-muted text-sm py-12">
          Select a time range to generate report
        </div>
      )}
    </div>
  )
}
