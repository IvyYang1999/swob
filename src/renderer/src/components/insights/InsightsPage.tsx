import { translate } from '../../i18n'
import { useState, useEffect, useMemo, useCallback } from 'react'
import { useStore } from '../../store'
import { FilterBar } from './FilterBar'
import { DrilldownView } from './DrilldownView'
import { ScopeContext, DEFAULT_SCOPE } from './scope'
import type { AnalysisScope } from './scope'
import type { InsightsData, QueryBundle, PreviousPeriodComparison } from './shared'
import { adaptQueryBundle, extractFilterOptions } from './shared'
import type { AnalysisDimension, InsightsQueryResult } from '../../../../shared/analysis-scope-types'
import {
  createDefaultDashboardLayout,
  type DashboardLayoutConfig,
  type DashboardPageId
} from '../../../../shared/registry/builtin-widgets'
import { DashboardPageWidgets } from '../../registry/builtin-widget-registry'

type DashboardTab = DashboardPageId

const TABS: Array<{ id: DashboardTab; labelKey: string }> = [
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
  const api = (window as any).api
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
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
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutConfig>(createDefaultDashboardLayout)

  useEffect(() => {
    let cancelled = false
    api.dashboardLoadLayout()
      .then((layout: DashboardLayoutConfig) => {
        if (!cancelled) setDashboardLayout(layout)
      })
      .catch(() => {
        if (!cancelled) setDashboardLayout(createDefaultDashboardLayout())
      })
    return () => { cancelled = true }
  }, [])

  // Fetch data using queryInsights API whenever scope changes
  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const dimensions: AnalysisDimension[] = ['global', 'time', 'hour', 'source', 'model', 'project', 'session']
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
        session: null,
      }

      for (const { dim, result } of results) {
        if (result) {
          bundle[dim as keyof QueryBundle] = result
        }
      }

      const adapted = adaptQueryBundle(bundle, sessions)
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
  }, [scope, sessions])

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
            context={{ data, previousPeriod, projectData, projectViewMode, zh, openDrilldown }}
          />
        )}
      </div>
    </ScopeContext.Provider>
  )
}
