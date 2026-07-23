import { Fragment, type ReactNode } from 'react'
import {
  BUILTIN_WIDGET_DECLARATIONS,
  type DashboardLayoutConfig,
  type DashboardPageId
} from '../../../shared/registry/builtin-widgets'
import { WidgetRegistry } from '../../../shared/registry/widget-registry'
import type { AnalysisDimension, AnalysisScope } from '../../../shared/analysis-scope-types'
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
import { translate } from '../i18n'

export interface InsightsWidgetContext {
  data: InsightsData
  previousPeriod: PreviousPeriodComparison | null
  projectData: InsightsData['byProject'] | InsightsData['byFolder']
  projectViewMode: string
  scope: AnalysisScope
  zh: boolean
  openDrilldown: (
    dimension: AnalysisDimension,
    dimensionLabel: string,
    key: string,
    label: string
  ) => void
}

type WidgetRenderer = (context: InsightsWidgetContext) => ReactNode

function widgetT(zh: boolean, key: string, params?: Record<string, string | number>): string {
  return translate(zh ? 'zh-CN' : 'en', key, params)
}

const renderers: Record<string, WidgetRenderer> = {
  'overview.stats': ({ data, previousPeriod }) => (
    <StatsCards data={data} previousPeriod={previousPeriod} />
  ),
  'overview.accounting-note': ({ data, zh }) => (
    <div className="text-[10px] text-muted px-1" title="The same provider-normalized ledger feeds global, project and session totals.">
      {widgetT(zh, 'renderer.insights_page.processed_billing_scope_cache_components_are_mutually_exclusive')}
      {data.tokenUnavailableSessions > 0 && ` · ${data.tokenUnavailableSessions} ${widgetT(zh, 'renderer.insights_page.sessions_unavailable')}`}
    </div>
  ),
  'overview.token-heatmap': ({ data, scope, zh }) => (
    <CardShell title={widgetT(zh, 'renderer.insights_page.card_heatmap')}>
      <div className="min-w-0">
        <TokenHeatmap data={data.heatmap} range={scope.range} />
      </div>
    </CardShell>
  ),
  'overview.by-source': ({ data, zh, openDrilldown }) => (
    <CardShell title={widgetT(zh, 'renderer.insights_page.card_source')}>
      <SourceDonut sources={data.bySource} />
      {data.bySource.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {data.bySource.filter((source) => source.totalTokens > 0).map((source) => (
            <button
              key={source.source}
              onClick={() => openDrilldown('source', widgetT(zh, 'renderer.insights_page.source'), source.source, source.label)}
              className="text-[10px] text-accent hover:underline"
            >
              {widgetT(zh, 'renderer.insights_page.drill')} {source.label}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  ),
  'overview.by-model': ({ data, zh, openDrilldown }) => (
    <CardShell title={widgetT(zh, 'renderer.insights_page.card_model')}>
      <ModelBreakdown models={data.byModel ?? []} />
      {(data.byModel ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {(data.byModel ?? []).filter((model) => model.totalTokens > 0).map((model) => (
            <button
              key={model.model}
              onClick={() => openDrilldown('model', widgetT(zh, 'renderer.insights_page.model'), model.model, model.model)}
              className="text-[10px] text-accent hover:underline"
            >
              {widgetT(zh, 'renderer.insights_page.drill_2')} {model.model.length > 15 ? `${model.model.slice(0, 13)}...` : model.model}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  ),
  'overview.top-projects': ({ data, projectData, zh, openDrilldown }) => (
    <CardShell title={widgetT(zh, 'renderer.insights_page.card_projects')}>
      <ProjectRanking projects={projectData} />
      {data.byProject.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {data.byProject.slice(0, 5).filter((project) => project.totalTokens > 0).map((project) => (
            <button
              key={project.fullPath}
              onClick={() => openDrilldown('project', widgetT(zh, 'renderer.insights_page.project'), project.fullPath, project.project)}
              className="text-[10px] text-accent hover:underline"
            >
              {widgetT(zh, 'renderer.insights_page.drill_3')} {project.project}
            </button>
          ))}
        </div>
      )}
    </CardShell>
  ),
  'overview.daily-trend': ({ data, scope, zh }) => (
    <CardShell title={widgetT(zh, 'renderer.insights_page.card_daily_trend')}>
      <DailyTrend data={data.byDate} range={scope.range} />
    </CardShell>
  ),
  'overview.daily-timeline': ({ data, projectViewMode, zh }) => (
    <CardShell title={widgetT(zh, 'renderer.insights_page.card_daily_details')}>
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
      title={widgetT(zh, 'renderer.insights_page.card_valuation_trace')}
      tooltip={widgetT(zh, 'renderer.insights_page.every_dollar_traces_to_a_mode_rule_and')}
    >
      <PricingTraceCard valuation={data.valuation} />
    </CardShell>
  ),
  'sessions.ranking': ({ data, zh }) => (
    <CardShell
      title={widgetT(zh, 'renderer.insights_page.card_session_ranking')}
      tooltip={widgetT(zh, 'renderer.insights_page.sorted_by_active_basis_click_to_open_amber')}
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
