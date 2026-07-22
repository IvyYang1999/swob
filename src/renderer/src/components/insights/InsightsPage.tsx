import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore } from '../../store'
import { StatsCards } from './StatsCards'
import { TokenHeatmap } from './TokenHeatmap'
import { SourceDonut } from './SourceDonut'
import { ProjectRanking } from './ProjectRanking'
import { DailyTrend } from './DailyTrend'
import { DailyTimeline } from './DailyTimeline'
import { ModelBreakdown } from './ModelBreakdown'
import { CostCard } from './CostCard'
import { HourlyChart } from './HourlyChart'
import { TurnDistribution } from './TurnDistribution'
import { ToolUsageChart } from './ToolUsageChart'
import { CodeChangesCard } from './CodeChangesCard'
import { AuditReportTab } from './AuditReportTab'
import type { InsightsData } from './shared'

export function InsightsPage() {
  const api = (window as any).api
  const config = useStore((s) => s.config)
  const [data, setData] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getInsights().then((d: InsightsData) => {
      if (!cancelled) {
        setData(d)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  const projectViewMode = config?.preferences?.projectViewMode || 'folders'

  const [activeTab, setActiveTab] = useState<'stats' | 'audit'>('stats')
  const [generating, setGenerating] = useState(false)
  const [reportResult, setReportResult] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ stage: string; current: number; total: number } | null>(null)
  const [llmAvailable, setLlmAvailable] = useState(false)
  const [confirmingLlm, setConfirmingLlm] = useState(false)

  useEffect(() => {
    window.api.getLlmSettings().then(s => setLlmAvailable(s.hasKey)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!generating) return
    const unsubscribe = window.api.onInsightsProgress((p) => setProgress(p))
    return unsubscribe
  }, [generating])

  const projectData = useMemo(() => {
    if (!data) return []
    if (projectViewMode === 'paths') return data.byProject
    return data.byFolder.length > 0 ? data.byFolder : data.byProject
  }, [data, projectViewMode])

  const runGenerate = useCallback(async (useLlm: boolean) => {
    setGenerating(true)
    setReportResult(null)
    setProgress(null)
    setConfirmingLlm(false)
    try {
      const result = await window.api.generateInsights({ useLlm })
      if (result.ok) {
        let msg = `Report generated: ${result.sessionCount} sessions analyzed`
        if (useLlm && result.llmUsed) msg += ' · AI narrative included'
        if (useLlm && result.llmError === 'no-api-key') msg += ' · No API key configured (Settings → AI Analysis)'
        else if (useLlm && result.llmError) msg += ` · AI failed: ${result.llmError.slice(0, 80)}`
        setReportResult(msg)
      } else {
        setReportResult(`Error: ${result.error}`)
      }
    } catch (e) {
      setReportResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }, [])

  const stageLabel = (s: string): string =>
    s === 'analyzing' ? 'Auditing sessions'
    : s === 'sampling' ? 'Sampling content'
    : s === 'llm' ? 'AI analyzing'
    : s === 'writing' ? 'Writing report'
    : s

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-edge pb-2">
        {([['stats', '📊 Token 统计', '📊 Token Stats'], ['audit', '🔍 审计报告', '🔍 Audit Report']] as const).map(([id, zh, en]) => (
          <button
            key={id}
            onClick={() => setActiveTab(id as 'stats' | 'audit')}
            className={`px-3 py-1.5 rounded-t-md text-xs font-medium transition-colors ${
              activeTab === id
                ? 'bg-accent/10 text-accent border-b-2 border-accent'
                : 'text-muted hover:text-primary'
            }`}
          >
            {zh}
          </button>
        ))}
      </div>

      {activeTab === 'audit' && <AuditReportTab />}

      {activeTab === 'stats' && <>
      {/* Audit Report generation */}
      <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium text-primary">Audit Report</div>
            <div className="text-[11px] text-muted">Cross-session quality audit · health scores · anti-patterns · AI narrative</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runGenerate(false)}
              disabled={generating}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-hover text-secondary hover:text-primary disabled:opacity-50 transition-colors"
            >
              Quick Report
            </button>
            <button
              onClick={() => setConfirmingLlm(true)}
              disabled={generating}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-soft-emerald/15 text-soft-emerald hover:bg-soft-emerald/25 disabled:opacity-50 transition-colors flex items-center gap-1.5"
              title={llmAvailable ? '' : 'Configure API key in Settings first'}
            >
              ✨ AI Report
            </button>
          </div>
        </div>

        {confirmingLlm && (
          <div className="bg-soft-amber/5 border border-soft-amber/20 rounded-md p-3 space-y-2">
            <div className="text-xs text-soft-amber font-medium">⚠️ Privacy Notice</div>
            <div className="text-[11px] text-secondary leading-relaxed">
              AI Report samples <strong>real content from your recent sessions</strong> (user messages, up to 60 sessions)
              and sends it to your configured LLM provider for analysis.
              {!llmAvailable && <span className="text-soft-amber"> No API key configured — set one in Settings → AI Analysis first.</span>}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => runGenerate(true)}
                disabled={!llmAvailable}
                className="px-2.5 py-1 rounded text-[11px] font-medium bg-soft-emerald/20 text-soft-emerald hover:bg-soft-emerald/30 disabled:opacity-40"
              >
                I understand, generate
              </button>
              <button
                onClick={() => setConfirmingLlm(false)}
                className="px-2.5 py-1 rounded text-[11px] text-muted hover:text-primary"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {generating && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2 text-[11px] text-secondary">
              <div className="animate-spin w-3 h-3 border border-soft-blue border-t-transparent rounded-full" />
              {progress ? `${stageLabel(progress.stage)}… ${progress.current}/${progress.total}` : 'Starting…'}
            </div>
            {progress && progress.total > 1 && (
              <div className="h-1 rounded-full bg-edge overflow-hidden">
                <div
                  className="h-full bg-soft-blue rounded-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>
            )}
          </div>
        )}

        {reportResult && !generating && <div className="text-[11px] text-muted">{reportResult}</div>}
      </div>

      <StatsCards data={data} />
      <div className="text-[10px] text-muted px-1" title="The same provider-normalized ledger feeds global, project and session totals.">
        Processed/billing scope · cache components are mutually exclusive · unavailable usage is excluded, not counted as zero
        {data.tokenUnavailableSessions > 0 && ` · ${data.tokenUnavailableSessions} session${data.tokenUnavailableSessions === 1 ? '' : 's'} unavailable`}
        {!data.reconciliation?.ok && <span className="text-red-400"> · reconciliation mismatch</span>}
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Token Heatmap</div>
        <div className="min-w-0">
          <TokenHeatmap data={data.heatmap} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">By Source</div>
          <SourceDonut sources={data.bySource} />
        </div>
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">By Model</div>
          <ModelBreakdown models={data.byModel ?? []} />
        </div>
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">Top Projects</div>
          <ProjectRanking projects={projectData} />
        </div>
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Daily Trend (30d)</div>
        <DailyTrend data={data.byDate} />
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Daily Insights</div>
        <DailyTimeline data={data.byDate} projectKey={projectViewMode === 'paths' ? 'byProject' : 'byFolder'} />
      </div>

      {/* New insight dimensions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CostCard
          valuation={data.valuation}
          cacheRead={data.totalCacheReadTokens || 0}
          cacheCreate={data.totalCacheCreationTokens || 0}
          totalInput={data.totalInputTokens || 0}
        />
        <HourlyChart hours={data.hourlyDistribution || new Array(24).fill(0)} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TurnDistribution buckets={data.turnCountDistribution || [0,0,0,0,0,0]} />
        <CodeChangesCard changes={data.codeChanges || { filesRead: 0, filesWritten: 0, filesEdited: 0 }} />
      </div>

      <ToolUsageChart tools={data.topTools || []} />
      </>}
    </div>
  )
}
