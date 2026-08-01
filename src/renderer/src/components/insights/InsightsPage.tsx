import { translate } from '../../i18n'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore } from '../../store'
import { FilterBar } from './FilterBar'
import { DrilldownView } from './DrilldownView'
import { ScopeContext, DEFAULT_SCOPE } from './scope'
import type { AnalysisScope } from './scope'
import type { InsightsData, QueryBundle, PreviousPeriodComparison } from './shared'
import { adaptQueryBundle, extractFilterOptions } from './shared'
import type { AnalysisDimension, InsightsQueryBundleResult } from '../../../../shared/analysis-scope-types'
import {
  createDefaultDashboardLayout,
  type DashboardLayoutConfig,
  type DashboardPageId
} from '../../../../shared/registry/builtin-widgets'
import { DashboardPageWidgets } from '../../registry/builtin-widget-registry'
import { useLensEnabled } from '../../hooks/useLens'

type DashboardTab = DashboardPageId

const ALL_TABS: Array<{ id: DashboardTab; labelKey: string }> = [
  { id: 'overview', labelKey: 'renderer.insights_page.tab_overview' },
  { id: 'cost', labelKey: 'renderer.insights_page.tab_cost' },
  { id: 'sessions', labelKey: 'renderer.insights_page.tab_sessions' },
  { id: 'workflow', labelKey: 'renderer.insights_page.tab_workflow' },
  { id: 'quality', labelKey: 'renderer.insights_page.tab_quality' },
  { id: 'audit', labelKey: 'renderer.insights_page.tab_audit' },
]

interface DrilldownTarget {
  dimension: AnalysisDimension
  dimensionLabel: string
  key: string
  label: string
}

export function InsightsPage() {
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  // tF30: filter tabs by Lens state
  const tokenInsightsLensEnabled = useLensEnabled('token-insights')
  const auditLensEnabled = useLensEnabled('audit')
  const TABS = useMemo(
    () => ALL_TABS.filter((tab) => tab.id === 'audit' ? auditLensEnabled : tokenInsightsLensEnabled),
    [auditLensEnabled, tokenInsightsLensEnabled]
  )
  const [bundle, setBundle] = useState<QueryBundle | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [queryError, setQueryError] = useState(false)
  const [retryRevision, setRetryRevision] = useState(0)
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview')
  const [scope, setScope] = useState<AnalysisScope>(DEFAULT_SCOPE)
  const [drilldown, setDrilldown] = useState<DrilldownTarget | null>(null)
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutConfig>(createDefaultDashboardLayout)

  useEffect(() => {
    if (!TABS.some((tab) => tab.id === activeTab) && TABS[0]) {
      setActiveTab(TABS[0].id)
      setDrilldown(null)
    }
  }, [TABS, activeTab])

  useEffect(() => {
    let cancelled = false
    window.api.dashboardLoadLayout()
      .then((layout: DashboardLayoutConfig) => {
        if (!cancelled) setDashboardLayout(layout)
      })
      .catch(() => {
        if (!cancelled) setDashboardLayout(createDefaultDashboardLayout())
      })
    return () => { cancelled = true }
  }, [])

  useEffect(() => window.api.onInsightsFactsUpdated(() => {
    setRetryRevision((revision) => revision + 1)
  }), [])

  // One atomic query keeps all dashboard dimensions on the same Usage Fact snapshot.
  useEffect(() => {
    let cancelled = false
    // Keep the last resolved dashboard mounted during background refreshes.
    // Session watcher updates can arrive while the user is scrolling; replacing
    // the whole page with Loading here detached controls mid-interaction.
    setRefreshing(true)
    setQueryError(false)

    void window.api.queryInsightsBundle(scope).then((response: InsightsQueryBundleResult) => {
      if (cancelled) return
      setBundle({
        global: response.results.global,
        time: response.results.time,
        hour: response.results.hour,
        source: response.results.source,
        model: response.results.model,
        project: response.results.project,
        session: response.results.session,
        filterOptions: response.filterOptions,
      })
    }).catch(() => {
      if (!cancelled) setQueryError(true)
    }).finally(() => {
      if (!cancelled) setRefreshing(false)
    })

    return () => { cancelled = true }
  }, [scope, retryRevision])

  const data = useMemo<InsightsData | null>(
    () => bundle ? adaptQueryBundle(bundle, sessions) : null,
    [bundle, sessions]
  )
  const previousPeriod = useMemo<PreviousPeriodComparison | null>(
    () => bundle?.global?.previousPeriod ?? null,
    [bundle]
  )
  const filterOptions = useMemo(
    () => bundle ? extractFilterOptions(bundle) : { sources: [], models: [], projects: [] },
    [bundle]
  )

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

  if (!data && queryError) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-muted text-sm">
        <span>{translate(locale, 'renderer.insights_page.load_failed')}</span>
        <button
          onClick={() => setRetryRevision((value) => value + 1)}
          className="px-3 py-1.5 rounded-md bg-accent/15 text-accent hover:bg-accent/25"
        >
          {translate(locale, 'renderer.insights_page.retry')}
        </button>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        {translate(locale, 'renderer.insights_page.loading')}
      </div>
    )
  }

  return (
    <ScopeContext.Provider value={{
      scope,
      setScope,
      availableSources: filterOptions.sources,
      availableModels: filterOptions.models,
      availableProjects: filterOptions.projects
    }}>
      <div className="relative flex-1 overflow-y-auto p-4 space-y-4">
        {refreshing && (
          <div className="absolute top-4 right-4 z-20 pointer-events-none" aria-live="polite">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-edge bg-surface/95 px-2.5 py-1 text-[10px] text-muted shadow-sm">
              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-soft-blue border-t-transparent" />
              {translate(locale, 'renderer.insights_page.refreshing')}
            </span>
          </div>
        )}
        {!refreshing && queryError && (
          <div className="flex justify-end">
            <button
              onClick={() => setRetryRevision((value) => value + 1)}
              className="text-[10px] text-red-400 hover:text-red-300"
            >
              {translate(locale, 'renderer.insights_page.refresh_failed_retry')}
            </button>
          </div>
        )}
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
              {translate(locale, tab.labelKey)}
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

        {!drilldown && (
          <DashboardPageWidgets
            layout={dashboardLayout}
            page={activeTab}
            context={{ data, previousPeriod, projectData, projectViewMode, scope, zh, openDrilldown }}
          />
        )}
      </div>
    </ScopeContext.Provider>
  )
}
