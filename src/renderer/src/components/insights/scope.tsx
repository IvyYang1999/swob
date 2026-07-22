import { createContext, useContext } from 'react'

/**
 * Analysis scope shared by every dashboard card. v1 is deliberately honest:
 * only basis switching is live; range presets other than 'all' arrive with the
 * t114 event-level data layer, so no dead filter controls are rendered yet.
 */
export interface AnalysisScope {
  range: 'all'
  basis: 'billing' | 'conversation'
}

export const DEFAULT_SCOPE: AnalysisScope = { range: 'all', basis: 'billing' }

export interface ScopeContextValue {
  scope: AnalysisScope
  setScope: (next: AnalysisScope) => void
}

export const ScopeContext = createContext<ScopeContextValue>({
  scope: DEFAULT_SCOPE,
  setScope: () => {}
})

export function useAnalysisScope(): ScopeContextValue {
  return useContext(ScopeContext)
}

export function scopeRangeLabel(scope: AnalysisScope, locale: string, override?: string): string {
  if (override) return override
  if (scope.range === 'all') return locale === 'zh-CN' ? '全部历史' : 'All history'
  return scope.range
}

export function scopeBasisLabel(scope: AnalysisScope, locale: string): string {
  if (scope.basis === 'conversation') {
    return locale === 'zh-CN' ? '仅会话口径' : 'Conversation-only'
  }
  return locale === 'zh-CN' ? '计费口径' : 'Billing'
}
