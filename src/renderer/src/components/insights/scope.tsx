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

const PRESET_LABELS: Record<AnalysisPreset, { zh: string; en: string }> = {
  today: { zh: '今日', en: 'Today' },
  '7d': { zh: '7 天', en: '7 days' },
  '30d': { zh: '30 天', en: '30 days' },
  '90d': { zh: '90 天', en: '90 days' },
  all: { zh: '全部历史', en: 'All history' },
}

export function scopeRangeLabel(scope: AnalysisScope, locale: string, override?: string): string {
  if (override) return override
  const zh = locale === 'zh-CN'
  if (typeof scope.range === 'string') {
    const labels = PRESET_LABELS[scope.range]
    return labels ? (zh ? labels.zh : labels.en) : scope.range
  }
  // Custom date range
  const from = scope.range.from || '?'
  const to = scope.range.to || (zh ? '今天' : 'today')
  return `${from} ~ ${to}`
}

export function scopeBasisLabel(scope: AnalysisScope, locale: string): string {
  if (scope.metricBasis === 'conversation') {
    return locale === 'zh-CN' ? '仅会话口径' : 'Conversation-only'
  }
  return locale === 'zh-CN' ? '计费口径' : 'Billing'
}

export function isPresetRange(range: AnalysisScope['range']): range is AnalysisPreset {
  return typeof range === 'string'
}
