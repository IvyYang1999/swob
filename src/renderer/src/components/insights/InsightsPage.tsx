import { useState, useEffect, useMemo } from 'react'
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
import { ReportGenerator } from './ReportGenerator'
import { CardShell } from './CardShell'
import { FilterBar } from './FilterBar'
import { SessionRanking } from './SessionRanking'
import { PricingTraceCard } from './PricingTraceCard'
import { QualityTab } from './QualityTab'
import { ScopeContext, DEFAULT_SCOPE, type AnalysisScope } from './scope'
import type { InsightsData } from './shared'

type DashboardTab = 'overview' | 'cost' | 'sessions' | 'workflow' | 'quality' | 'audit'

const TABS: Array<{ id: DashboardTab; zh: string; en: string }> = [
  { id: 'overview', zh: '总览', en: 'Overview' },
  { id: 'cost', zh: '成本与缓存', en: 'Cost & Cache' },
  { id: 'sessions', zh: '会话与效率', en: 'Sessions' },
  { id: 'workflow', zh: '工作流', en: 'Workflow' },
  { id: 'quality', zh: '数据质量', en: 'Data Quality' },
  { id: 'audit', zh: '审计报告', en: 'Audit Report' }
]

export function InsightsPage() {
  const api = (window as any).api
  const config = useStore((s) => s.config)
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const [data, setData] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview')
  const [scope, setScope] = useState<AnalysisScope>(DEFAULT_SCOPE)

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
  const projectData = useMemo(() => {
    if (!data) return []
    if (projectViewMode === 'paths') return data.byProject
    return data.byFolder.length > 0 ? data.byFolder : data.byProject
  }, [data, projectViewMode])

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    )
  }

  return (
    <ScopeContext.Provider value={{ scope, setScope }}>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <FilterBar data={data} />

        {/* Tab bar */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-edge pb-2" role="tablist">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 px-3 py-1.5 rounded-t-md text-xs font-medium transition-colors ${
                activeTab === tab.id
                  ? 'bg-accent/10 text-accent border-b-2 border-accent'
                  : 'text-muted hover:text-primary'
              }`}
            >
              {zh ? tab.zh : tab.en}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <>
            <StatsCards data={data} />
            <div className="text-[10px] text-muted px-1" title="The same provider-normalized ledger feeds global, project and session totals.">
              {zh
                ? '同一账本供给全局/项目/会话;缓存分桶互斥;不可用用量被排除而不是记 0'
                : 'Processed/billing scope · cache components are mutually exclusive · unavailable usage is excluded, not counted as zero'}
              {data.tokenUnavailableSessions > 0 && ` · ${data.tokenUnavailableSessions} ${zh ? '个会话用量不可用' : 'sessions unavailable'}`}
              {!data.reconciliation?.ok && <span className="text-red-400"> · {zh ? '对账不闭合' : 'reconciliation mismatch'}</span>}
            </div>

            <CardShell title="Token 热力图" titleEn="Token Heatmap" rangeOverride={zh ? '近 365 天' : 'Last 365d'}>
              <div className="min-w-0">
                <TokenHeatmap data={data.heatmap} />
              </div>
            </CardShell>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <CardShell title="按来源" titleEn="By Source">
                <SourceDonut sources={data.bySource} />
              </CardShell>
              <CardShell title="按模型" titleEn="By Model">
                <ModelBreakdown models={data.byModel ?? []} />
              </CardShell>
              <CardShell title="Top 项目" titleEn="Top Projects">
                <ProjectRanking projects={projectData} />
              </CardShell>
            </div>

            <CardShell title="日趋势" titleEn="Daily Trend" rangeOverride={zh ? '近 30 天·按会话结束日' : 'Last 30d · by session end date'}
              tooltip={zh ? '当前按会话最后更新日归档;事件级真实日期随 t114 上线' : 'Currently archived to session end date; event-level dates arrive with t114'}>
              <DailyTrend data={data.byDate} />
            </CardShell>

            <CardShell title="每日明细" titleEn="Daily Insights" rangeOverride={zh ? '近 30 天·按会话结束日' : 'Last 30d · by session end date'}>
              <DailyTimeline data={data.byDate} projectKey={projectViewMode === 'paths' ? 'byProject' : 'byFolder'} />
            </CardShell>
          </>
        )}

        {activeTab === 'cost' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <CostCard
              valuation={data.valuation}
              cacheRead={data.totalCacheReadTokens || 0}
              cacheCreate={data.totalCacheCreationTokens || 0}
              totalInput={data.totalInputTokens || 0}
            />
            <CardShell title="金额追溯" titleEn="Valuation trace"
              tooltip={zh ? '每一分钱可追溯到模式、价格规则与目录版本' : 'Every dollar traces to a mode, rule and catalog version'}>
              <PricingTraceCard valuation={data.valuation} />
            </CardShell>
          </div>
        )}

        {activeTab === 'sessions' && (
          <>
            <CardShell title="会话排名与分布" titleEn="Session ranking & distribution"
              tooltip={zh ? '按当前口径排序;点击跳转会话;黄色百分比=该会话价格覆盖率' : 'Sorted by active basis; click to open; amber % = pricing coverage'}>
              <SessionRanking data={data} />
            </CardShell>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <TurnDistribution buckets={data.turnCountDistribution || [0, 0, 0, 0, 0, 0]} />
              <HourlyChart hours={data.hourlyDistribution || new Array(24).fill(0)} />
            </div>
          </>
        )}

        {activeTab === 'workflow' && (
          <>
            <ToolUsageChart tools={data.topTools || []} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CodeChangesCard changes={data.codeChanges || { filesRead: 0, filesWritten: 0, filesEdited: 0 }} />
            </div>
          </>
        )}

        {activeTab === 'quality' && <QualityTab data={data} />}

        {activeTab === 'audit' && (
          <>
            <ReportGenerator />
            <AuditReportTab />
          </>
        )}
      </div>
    </ScopeContext.Provider>
  )
}
