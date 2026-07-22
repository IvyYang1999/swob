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
import { ReportGenerator } from './ReportGenerator'
import { CardShell } from './CardShell'
import { FilterBar } from './FilterBar'
import { SessionRanking } from './SessionRanking'
import { PricingTraceCard } from './PricingTraceCard'
import { QualityTab } from './QualityTab'
import { DrilldownView } from './DrilldownView'
import { ScopeContext, DEFAULT_SCOPE, scopeRangeLabel } from './scope'
import type { AnalysisScope } from './scope'
import type { InsightsData, QueryBundle, PreviousPeriodComparison } from './shared'
import { adaptQueryBundle, extractFilterOptions } from './shared'
import type { AnalysisDimension, InsightsQueryResult } from '../../../../main/analysis-contract'

type DashboardTab = 'overview' | 'cost' | 'sessions' | 'workflow' | 'quality' | 'audit'

const TABS: Array<{ id: DashboardTab; zh: string; en: string }> = [
  { id: 'overview', zh: '总览', en: 'Overview' },
  { id: 'cost', zh: '成本与缓存', en: 'Cost & Cache' },
  { id: 'sessions', zh: '会话与效率', en: 'Sessions' },
  { id: 'workflow', zh: '工作流', en: 'Workflow' },
  { id: 'quality', zh: '数据质量', en: 'Data Quality' },
  { id: 'audit', zh: '审计报告', en: 'Audit Report' },
]

interface DrilldownTarget {
  dimension: AnalysisDimension
  dimensionLabel: string
  key: string
  label: string
}

export function InsightsPage() {
  const api = (window as any).api
  const config = useStore((s) => s.config)
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const [data, setData] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview')
  const [scope, setScope] = useState<AnalysisScope>(DEFAULT_SCOPE)
  const [previousPeriod, setPreviousPeriod] = useState<PreviousPeriodComparison | null>(null)
  const [availableSources, setAvailableSources] = useState<string[]>([])
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [availableProjects, setAvailableProjects] = useState<Array<{ kind: 'project' | 'folder'; key: string; label: string }>>([])
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null)

  // Fetch data using queryInsights API whenever scope changes
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const dimensions: AnalysisDimension[] = ['global', 'time', 'hour', 'source', 'model', 'project']
    const queries = dimensions.map((dim) =>
      api.queryInsights(scope, dim)
        .then((result: InsightsQueryResult) => ({ dim, result }))
        .catch(() => ({ dim, result: null as InsightsQueryResult | null }))
    )

    Promise.all(queries).then((results) => {
      if (cancelled) return

      const bundle: QueryBundle = {
        global: null,
        time: null,
        hour: null,
        source: null,
        model: null,
        project: null,
      }

      for (const { dim, result } of results) {
        if (result) {
          bundle[dim as keyof QueryBundle] = result
        }
      }

      const adapted = adaptQueryBundle(bundle)
      setData(adapted)

      // Extract period comparison from global result
      setPreviousPeriod(bundle.global?.previousPeriod ?? null)

      // Extract available filter options
      const options = extractFilterOptions(bundle)
      setAvailableSources(options.sources)
      setAvailableModels(options.models)
      setAvailableProjects(options.projects)

      setLoading(false)
    })

    return () => { cancelled = true }
  }, [scope])

  const projectViewMode = config?.preferences?.projectViewMode || 'folders'
  const projectData = useMemo(() => {
    if (!data) return []
    if (projectViewMode === 'paths') return data.byProject
    return data.byFolder.length > 0 ? data.byFolder : data.byProject
  }, [data, projectViewMode])

  const openDrilldown = useCallback((dimension: AnalysisDimension, dimensionLabel: string, key: string, label: string) => {
    setDrilldown({ dimension, dimensionLabel, key, label })
  }, [])

  const closeDrilldown = useCallback(() => {
    setDrilldown(null)
  }, [])

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    )
  }

  // Determine the range label from actual scope (no hardcoded degradation notes)
  const rangeLabel = scopeRangeLabel(scope, locale)

  return (
    <ScopeContext.Provider value={{ scope, setScope, availableSources, availableModels, availableProjects }}>
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

        {/* Drilldown overlay */}
        {drilldown && (
          <DrilldownView
            onClose={closeDrilldown}
            dimension={drilldown.dimension}
            dimensionLabel={drilldown.dimensionLabel}
            itemKey={drilldown.key}
            itemLabel={drilldown.label}
          />
        )}

        {activeTab === 'overview' && !drilldown && (
          <>
            <StatsCards data={data} previousPeriod={previousPeriod} />
            <div className="text-[10px] text-muted px-1" title="The same provider-normalized ledger feeds global, project and session totals.">
              {zh
                ? '同一账本供给全局/项目/会话;缓存分桶互斥;不可用用量被排除而不是记 0'
                : 'Processed/billing scope · cache components are mutually exclusive · unavailable usage is excluded, not counted as zero'}
              {data.tokenUnavailableSessions > 0 && ` · ${data.tokenUnavailableSessions} ${zh ? '个会话用量不可用' : 'sessions unavailable'}`}
            </div>

            {data.heatmap.length > 0 && (
              <CardShell title="Token 热力图" titleEn="Token Heatmap">
                <div className="min-w-0">
                  <TokenHeatmap data={data.heatmap} />
                </div>
              </CardShell>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <CardShell title="按来源" titleEn="By Source">
                <SourceDonut sources={data.bySource} />
                {data.bySource.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {data.bySource.filter((s) => s.totalTokens > 0).map((s) => (
                      <button
                        key={s.source}
                        onClick={() => openDrilldown('source', zh ? '来源' : 'Source', s.source, s.label)}
                        className="text-[10px] text-accent hover:underline"
                      >
                        {zh ? '下钻' : 'drill'} {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </CardShell>
              <CardShell title="按模型" titleEn="By Model">
                <ModelBreakdown models={data.byModel ?? []} />
                {(data.byModel ?? []).length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {(data.byModel ?? []).filter((m) => m.totalTokens > 0).map((m) => (
                      <button
                        key={m.model}
                        onClick={() => openDrilldown('model', zh ? '模型' : 'Model', m.model, m.model)}
                        className="text-[10px] text-accent hover:underline"
                      >
                        {zh ? '下钻' : 'drill'} {m.model.length > 15 ? m.model.slice(0, 13) + '...' : m.model}
                      </button>
                    ))}
                  </div>
                )}
              </CardShell>
              <CardShell title="Top 项目" titleEn="Top Projects">
                <ProjectRanking projects={projectData} />
                {data.byProject.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {data.byProject.slice(0, 5).filter((p) => p.totalTokens > 0).map((p) => (
                      <button
                        key={p.fullPath}
                        onClick={() => openDrilldown('project', zh ? '项目' : 'Project', p.fullPath, p.project)}
                        className="text-[10px] text-accent hover:underline"
                      >
                        {zh ? '下钻' : 'drill'} {p.project}
                      </button>
                    ))}
                  </div>
                )}
              </CardShell>
            </div>

            <CardShell title="日趋势" titleEn="Daily Trend">
              <DailyTrend data={data.byDate} />
            </CardShell>

            <CardShell title="每日明细" titleEn="Daily Insights">
              <DailyTimeline data={data.byDate} projectKey={projectViewMode === 'paths' ? 'byProject' : 'byFolder'} />
            </CardShell>
          </>
        )}

        {activeTab === 'cost' && !drilldown && (
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

        {activeTab === 'sessions' && !drilldown && (
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

        {activeTab === 'workflow' && !drilldown && (
          <>
            <ToolUsageChart tools={data.topTools || []} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <CodeChangesCard changes={data.codeChanges || { filesRead: 0, filesWritten: 0, filesEdited: 0 }} />
            </div>
          </>
        )}

        {activeTab === 'quality' && !drilldown && <QualityTab data={data} />}

        {activeTab === 'audit' && !drilldown && (
          <>
            <ReportGenerator />
            <AuditReportTab />
          </>
        )}
      </div>
    </ScopeContext.Provider>
  )
}
