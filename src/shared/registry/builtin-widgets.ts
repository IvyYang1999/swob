import type { WidgetDataScope, WidgetSizeConstraints, WidgetDataStatus } from './widget-registry'

export const DASHBOARD_PAGE_IDS = [
  'overview',
  'cost',
  'sessions',
  'workflow',
  'quality',
  'audit'
] as const

export type DashboardPageId = (typeof DASHBOARD_PAGE_IDS)[number]

export interface WidgetDeclaration {
  id: string
  title: string
  page: DashboardPageId
  dataScope: WidgetDataScope
  size: WidgetSizeConstraints
  /** Whether the backend data pipeline for this widget is fully connected. */
  dataStatus: WidgetDataStatus
}

const full = { minWidth: 6, defaultWidth: 12, maxWidth: 12 }
const half = { minWidth: 4, defaultWidth: 6, maxWidth: 12 }
const third = { minWidth: 3, defaultWidth: 4, maxWidth: 12 }
const globalInsights = { kind: 'insights' as const, dimensions: ['global'] }

export const BUILTIN_WIDGET_DECLARATIONS: readonly WidgetDeclaration[] = [
  { id: 'overview.stats', title: 'insights.widgets.stats', page: 'overview', dataScope: globalInsights, size: full, dataStatus: 'connected' },
  { id: 'overview.accounting-note', title: 'insights.widgets.accounting_note', page: 'overview', dataScope: { kind: 'none' }, size: full, dataStatus: 'connected' },
  { id: 'overview.token-heatmap', title: 'insights.widgets.token_heatmap', page: 'overview', dataScope: { kind: 'insights', dimensions: ['time'] }, size: full, dataStatus: 'connected' },
  { id: 'overview.by-source', title: 'insights.widgets.by_source', page: 'overview', dataScope: { kind: 'insights', dimensions: ['source'] }, size: third, dataStatus: 'connected' },
  { id: 'overview.by-model', title: 'insights.widgets.by_model', page: 'overview', dataScope: { kind: 'insights', dimensions: ['model'] }, size: third, dataStatus: 'connected' },
  { id: 'overview.top-projects', title: 'insights.widgets.top_projects', page: 'overview', dataScope: { kind: 'insights', dimensions: ['project'] }, size: third, dataStatus: 'connected' },
  { id: 'overview.token-mix', title: 'insights.widgets.token_mix', page: 'overview', dataScope: globalInsights, size: full, dataStatus: 'connected' },
  { id: 'overview.daily-trend', title: 'insights.widgets.daily_trend', page: 'overview', dataScope: { kind: 'insights', dimensions: ['time'] }, size: full, dataStatus: 'connected' },
  { id: 'overview.daily-timeline', title: 'insights.widgets.daily_timeline', page: 'overview', dataScope: globalInsights, size: full, dataStatus: 'connected' },
  { id: 'cost.summary', title: 'insights.widgets.cost', page: 'cost', dataScope: globalInsights, size: half, dataStatus: 'connected' },
  { id: 'cost.pricing-trace', title: 'insights.widgets.pricing_trace', page: 'cost', dataScope: globalInsights, size: half, dataStatus: 'connected' },
  { id: 'sessions.ranking', title: 'insights.widgets.session_ranking', page: 'sessions', dataScope: globalInsights, size: full, dataStatus: 'connected' },
  { id: 'sessions.turn-distribution', title: 'insights.widgets.turn_distribution', page: 'sessions', dataScope: globalInsights, size: half, dataStatus: 'connected' },
  { id: 'sessions.hourly', title: 'insights.widgets.hourly', page: 'sessions', dataScope: { kind: 'insights', dimensions: ['hour'] }, size: half, dataStatus: 'connected' },
  { id: 'workflow.tool-usage', title: 'insights.widgets.tool_usage', page: 'workflow', dataScope: globalInsights, size: full, dataStatus: 'pending' },
  { id: 'workflow.code-changes', title: 'insights.widgets.code_changes', page: 'workflow', dataScope: globalInsights, size: half, dataStatus: 'pending' },
  { id: 'quality.summary', title: 'insights.widgets.quality', page: 'quality', dataScope: globalInsights, size: full, dataStatus: 'connected' },
  { id: 'audit.report-generator', title: 'insights.widgets.report_generator', page: 'audit', dataScope: { kind: 'none' }, size: full, dataStatus: 'connected' },
  { id: 'audit.report', title: 'insights.widgets.audit_report', page: 'audit', dataScope: { kind: 'service', service: 'audit' }, size: full, dataStatus: 'connected' }
]

export interface DashboardSectionConfig {
  id: string
  columns: 1 | 2 | 3
  widgetIds: string[]
}

export interface DashboardPageConfig {
  sections: DashboardSectionConfig[]
}

export interface DashboardLayoutConfig {
  schemaVersion: 1
  pages: Record<DashboardPageId, DashboardPageConfig>
}

const defaultDashboardLayout: DashboardLayoutConfig = {
  schemaVersion: 1,
  pages: {
    overview: {
      sections: [
        { id: 'stats', columns: 1, widgetIds: ['overview.stats'] },
        { id: 'accounting-note', columns: 1, widgetIds: ['overview.accounting-note'] },
        { id: 'token-heatmap', columns: 1, widgetIds: ['overview.token-heatmap'] },
        { id: 'breakdowns', columns: 3, widgetIds: ['overview.by-source', 'overview.by-model', 'overview.top-projects'] },
        { id: 'token-mix', columns: 1, widgetIds: ['overview.token-mix'] },
        { id: 'daily-trend', columns: 1, widgetIds: ['overview.daily-trend'] },
        { id: 'daily-timeline', columns: 1, widgetIds: ['overview.daily-timeline'] }
      ]
    },
    cost: {
      sections: [{ id: 'cost-cards', columns: 2, widgetIds: ['cost.summary', 'cost.pricing-trace'] }]
    },
    sessions: {
      sections: [
        { id: 'session-ranking', columns: 1, widgetIds: ['sessions.ranking'] },
        { id: 'session-distributions', columns: 2, widgetIds: ['sessions.turn-distribution', 'sessions.hourly'] }
      ]
    },
    workflow: {
      sections: [
        { id: 'tool-usage', columns: 1, widgetIds: ['workflow.tool-usage'] },
        { id: 'code-changes', columns: 2, widgetIds: ['workflow.code-changes'] }
      ]
    },
    quality: {
      sections: [{ id: 'quality-summary', columns: 1, widgetIds: ['quality.summary'] }]
    },
    audit: {
      sections: [
        { id: 'report-generator', columns: 1, widgetIds: ['audit.report-generator'] },
        { id: 'audit-report', columns: 1, widgetIds: ['audit.report'] }
      ]
    }
  }
}

export function createDefaultDashboardLayout(): DashboardLayoutConfig {
  return structuredClone(defaultDashboardLayout)
}

/**
 * Migrate a schema-1 dashboard layout to include newly added widgets.
 * Old layouts may not have 'overview.token-mix'. This adds it in the
 * correct position so existing users see the chart without manual reset.
 */
export function migrateDashboardLayout(layout: DashboardLayoutConfig): DashboardLayoutConfig {
  const overview = layout.pages.overview
  if (!overview) return layout
  const allWidgetIds = overview.sections.flatMap((s) => s.widgetIds)
  if (allWidgetIds.includes('overview.token-mix')) return layout
  // Insert token-mix section after breakdowns (by-source/by-model/top-projects)
  // and before daily-trend, matching the default layout order.
  const migrated = structuredClone(layout)
  const overviewSections = migrated.pages.overview.sections
  const breakdownIdx = overviewSections.findIndex((s) => s.id === 'breakdowns')
  const insertIdx = breakdownIdx >= 0 ? breakdownIdx + 1 : overviewSections.length
  overviewSections.splice(insertIdx, 0, {
    id: 'token-mix',
    columns: 1,
    widgetIds: ['overview.token-mix']
  })
  return migrated
}

export function isDashboardLayoutConfig(value: unknown): value is DashboardLayoutConfig {
  if (!value || typeof value !== 'object') return false
  const layout = value as Record<string, unknown>
  if (layout.schemaVersion !== 1 || !layout.pages || typeof layout.pages !== 'object') return false

  const pages = layout.pages as Record<string, unknown>
  const knownWidgets = new Map(BUILTIN_WIDGET_DECLARATIONS.map((widget) => [widget.id, widget]))
  const usedWidgets = new Set<string>()

  for (const pageId of DASHBOARD_PAGE_IDS) {
    const page = pages[pageId]
    if (!page || typeof page !== 'object') return false
    const sections = (page as Record<string, unknown>).sections
    if (!Array.isArray(sections)) return false
    const sectionIds = new Set<string>()

    for (const section of sections) {
      if (!section || typeof section !== 'object') return false
      const candidate = section as Record<string, unknown>
      if (typeof candidate.id !== 'string' || candidate.id.length === 0 || sectionIds.has(candidate.id)) return false
      sectionIds.add(candidate.id)
      if (candidate.columns !== 1 && candidate.columns !== 2 && candidate.columns !== 3) return false
      if (!Array.isArray(candidate.widgetIds)) return false
      for (const widgetId of candidate.widgetIds) {
        if (typeof widgetId !== 'string' || usedWidgets.has(widgetId)) return false
        const widget = knownWidgets.get(widgetId)
        if (!widget || widget.page !== pageId) return false
        usedWidgets.add(widgetId)
      }
    }
  }

  return Object.keys(pages).every((pageId) => (DASHBOARD_PAGE_IDS as readonly string[]).includes(pageId))
}
