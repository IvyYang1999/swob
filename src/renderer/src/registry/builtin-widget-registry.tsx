import { Fragment, type ReactNode } from 'react'
import {
  BUILTIN_WIDGET_DECLARATIONS,
  type DashboardLayoutConfig,
  type DashboardPageId
} from '../../../shared/registry/builtin-widgets'
import { WidgetRegistry } from '../../../shared/registry/widget-registry'
import type { AnalysisDimension } from '../../../shared/analysis-scope-types'
import { AuditReportTab } from '../components/insights/AuditReportTab'
import { CardShell } from '../components/insights/CardShell'
import { CodeChangesCard } from '../components/insights/CodeChangesCard'
import { CostCard } from '../components/insights/CostCard'
import { DailyTimeline } from '../components/insights/DailyTimeline'
import { DailyTrend } from '../components/insights/DailyTrend'
import { HourlyChart } from '../components/insights/HourlyChart'
import { ModelBreakdown } from '../components/insights/ModelBreakdown'
import { PricingTraceCard } from '../components/insights/PricingTraceCard'
import { ProjectRanking } from '../components/insights/ProjectRanking'
import { QualityTab } from '../components/insights/QualityTab'
import { ReportGenerator } from '../components/insights/ReportGenerator'
import { SessionRanking } from '../components/insights/SessionRanking'
import { SourceDonut } from '../components/insights/SourceDonut'
import { StatsCards } from '../components/insights/StatsCards'
import { TokenHeatmap } from '../components/insights/TokenHeatmap'
import { ToolUsageChart } from '../components/insights/ToolUsageChart'
import { TurnDistribution } from '../components/insights/TurnDistribution'
import type { InsightsData, PreviousPeriodComparison } from '../components/insights/shared'

export interface InsightsWidgetContext {
  data: InsightsData
  previousPeriod: PreviousPeriodComparison | null
  projectData: InsightsData['byProject'] | InsightsData['byFolder']
  projectViewMode: string
  zh: boolean
  openDrilldown: (
    dimension: AnalysisDimension,
    dimensionLabel: string,
    key: string,
    label: string
  ) => void
}

type WidgetRenderer = (context: InsightsWidgetContext) => ReactNode

const renderers: Record<string, WidgetRenderer> = {
  'overview.stats': ({ data, previousPeriod }) => (
    <StatsCards data={data} previousPeriod={previousPeriod} />
  ),
  'overview.accounting-note': ({ data, zh }) => (
    <div className="text-[10px] text-muted px-1" title="The same provider-normalized ledger feeds global, project and session totals.">
      {zh
        ? '同一账本供给全局/项目/会话;缓存分桶互斥;不可用用量被排除而不是记 0'
        : 'Processed/billing scope · cache components are mutually exclusive · unavailable usage is excluded, not counted as zero'}
      {data.tokenUnavailableSessions > 0 && ` · ${data.tokenUnavailableSessions} ${zh ? '个会话用量不可用' : 'sessions unavailable'}`}
    </div>
  ),
  'overview.token-heatmap': ({ data }) => data.heatmap.length > 0 ? (
    <CardShell title="Token 热力图" titleEn="Token Heatmap">
      <div className="min-w-0">
        <TokenHeatmap data={data.heatmap} />
      </div>
    </CardShell>
  ) : null,
  'overview.by-source': ({ data, zh, openDrilldown }) => (
    <CardShell title="按来源" titleEn="By Source">
      <SourceDonut sources={data.bySource} />
      {data.bySource.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {data.bySource.filter((source) => source.totalTokens > 0).map((source) => (
            <button
              key={source.source}
              onClick={() => openDrilldown('source', zh ? '来源' : 'Source', source.source, source.label)}
              className="text-[10px] text-accent hover:underline"
            >
              {zh ? '下钻' : 'drill'} {source.label}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  ),
  'overview.by-model': ({ data, zh, openDrilldown }) => (
    <CardShell title="按模型" titleEn="By Model">
      <ModelBreakdown models={data.byModel ?? []} />
      {(data.byModel ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {(data.byModel ?? []).filter((model) => model.totalTokens > 0).map((model) => (
            <button
              key={model.model}
              onClick={() => openDrilldown('model', zh ? '模型' : 'Model', model.model, model.model)}
              className="text-[10px] text-accent hover:underline"
            >
              {zh ? '下钻' : 'drill'} {model.model.length > 15 ? `${model.model.slice(0, 13)}...` : model.model}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  ),
  'overview.top-projects': ({ data, projectData, zh, openDrilldown }) => (
    <CardShell title="Top 项目" titleEn="Top Projects">
      <ProjectRanking projects={projectData} />
      {data.byProject.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {data.byProject.slice(0, 5).filter((project) => project.totalTokens > 0).map((project) => (
            <button
              key={project.fullPath}
              onClick={() => openDrilldown('project', zh ? '项目' : 'Project', project.fullPath, project.project)}
              className="text-[10px] text-accent hover:underline"
            >
              {zh ? '下钻' : 'drill'} {project.project}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  ),
  'overview.daily-trend': ({ data }) => (
    <CardShell title="日趋势" titleEn="Daily Trend">
      <DailyTrend data={data.byDate} />
    </CardShell>
  ),
  'overview.daily-timeline': ({ data, projectViewMode }) => (
    <CardShell title="每日明细" titleEn="Daily Insights">
      <DailyTimeline data={data.byDate} projectKey={projectViewMode === 'paths' ? 'byProject' : 'byFolder'} />
    </CardShell>
  ),
  'cost.summary': ({ data }) => (
    <CostCard
      valuation={data.valuation}
      cacheRead={data.totalCacheReadTokens || 0}
      cacheCreate={data.totalCacheCreationTokens || 0}
      totalInput={data.totalInputTokens || 0}
    />
  ),
  'cost.pricing-trace': ({ data, zh }) => (
    <CardShell
      title="金额追溯"
      titleEn="Valuation trace"
      tooltip={zh ? '每一分钱可追溯到模式、价格规则与目录版本' : 'Every dollar traces to a mode, rule and catalog version'}
    >
      <PricingTraceCard valuation={data.valuation} />
    </CardShell>
  ),
  'sessions.ranking': ({ data, zh }) => (
    <CardShell
      title="会话排名与分布"
      titleEn="Session ranking & distribution"
      tooltip={zh ? '按当前口径排序;点击跳转会话;黄色百分比=该会话价格覆盖率' : 'Sorted by active basis; click to open; amber % = pricing coverage'}
    >
      <SessionRanking data={data} />
    </CardShell>
  ),
  'sessions.turn-distribution': ({ data }) => (
    <TurnDistribution buckets={data.turnCountDistribution || [0, 0, 0, 0, 0, 0]} />
  ),
  'sessions.hourly': ({ data }) => (
    <HourlyChart hours={data.hourlyDistribution || new Array(24).fill(0)} />
  ),
  'workflow.tool-usage': ({ data }) => <ToolUsageChart tools={data.topTools || []} />,
  'workflow.code-changes': ({ data }) => (
    <CodeChangesCard changes={data.codeChanges || { filesRead: 0, filesWritten: 0, filesEdited: 0 }} />
  ),
  'quality.summary': ({ data }) => <QualityTab data={data} />,
  'audit.report-generator': () => <ReportGenerator />,
  'audit.report': () => <AuditReportTab />
}

export function createBuiltinWidgetRegistry(): WidgetRegistry<InsightsWidgetContext, ReactNode> {
  const registry = new WidgetRegistry<InsightsWidgetContext, ReactNode>()
  for (const declaration of BUILTIN_WIDGET_DECLARATIONS) {
    const render = renderers[declaration.id]
    if (!render) throw new Error(`Missing built-in widget renderer: ${declaration.id}`)
    registry.register({ ...declaration, source: { kind: 'builtin' }, render })
  }
  return registry
}

export const builtinWidgetRegistry = createBuiltinWidgetRegistry()

export function resolveDashboardPageSections(layout: DashboardLayoutConfig, page: DashboardPageId) {
  return layout.pages[page].sections.map((section) => ({
    ...section,
    widgets: section.widgetIds.map((id) => builtinWidgetRegistry.require(id))
  }))
}

export function DashboardPageWidgets({
  layout,
  page,
  context
}: {
  layout: DashboardLayoutConfig
  page: DashboardPageId
  context: InsightsWidgetContext
}) {
  return (
    <>
      {resolveDashboardPageSections(layout, page).map((section) => {
        const widgets = section.widgets.map((widget) => (
          <Fragment key={widget.id}>{widget.render(context)}</Fragment>
        ))
        if (section.columns === 1) return <Fragment key={section.id}>{widgets}</Fragment>
        const columns = section.columns === 2 ? 'lg:grid-cols-2' : 'lg:grid-cols-3'
        return (
          <div key={section.id} className={`grid grid-cols-1 ${columns} gap-4`}>
            {widgets}
          </div>
        )
      })}
    </>
  )
}
