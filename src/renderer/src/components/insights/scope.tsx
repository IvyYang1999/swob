import { translate, type Locale } from '../../i18n'
import { createContext, useContext } from 'react'
import type { AnalysisScope, AnalysisPreset, MetricBasis } from '../../../../shared/analysis-scope-types'

export type { AnalysisScope, AnalysisPreset, MetricBasis }

export const DEFAULT_SCOPE: AnalysisScope = {
  range: '7d',
  metricBasis: 'billing',
}

export interface ScopeContextValue {
  scope: AnalysisScope
  setScope: (next: AnalysisScope) => void
  /** Available sources/models discovered from query results, for FilterBar pills. */
  availableSources: string[]
  availableModels: string[]
  availableProjects: Array<{ kind: 'project' | 'folder'; key: string; label: string }>
}

export const ScopeContext = createContext<ScopeContextValue>({
  scope: DEFAULT_SCOPE,
  setScope: () => {},
  availableSources: [],
  availableModels: [],
  availableProjects: [],
})

export function useAnalysisScope(): ScopeContextValue {
  return useContext(ScopeContext)
}

const PRESET_LABELS: Record<AnalysisPreset, string> = {
  today: 'renderer.scope.preset_today',
  '7d': 'renderer.scope.preset_7d',
  '30d': 'renderer.scope.preset_30d',
  '90d': 'renderer.scope.preset_90d',
  all: 'renderer.scope.preset_all',
}

export function scopeRangeLabel(scope: AnalysisScope, locale: Locale, override?: string): string {
  if (override) return override
  const zh = locale === 'zh-CN'
  if (typeof scope.range === 'string') {
    const labels = PRESET_LABELS[scope.range]
    return labels ? translate(locale, labels) : scope.range
  }
  // Custom date range
  const from = scope.range.from || '?'
  const to = scope.range.to || (translate(zh ? 'zh-CN' : 'en', 'renderer.scope.today'))
  return `${from} ~ ${to}`
}

export function scopeBasisLabel(scope: AnalysisScope, locale: Locale): string {
  if (scope.metricBasis === 'conversation') {
    return translate(locale, 'renderer.scope.conversation_only')
  }
  return translate(locale, 'renderer.scope.billing')
}

export function isPresetRange(range: AnalysisScope['range']): range is AnalysisPreset {
  return typeof range === 'string'
}
