import type { ReactNode } from 'react'
import { ViewRegistry } from '../../../shared/registry/view-registry'
import { ChatViewer } from '../components/ChatViewer'
import { InfoPanel } from '../components/InfoPanel'
import { InsightsPage } from '../components/insights/InsightsPage'
import { LineagePage } from '../components/LineagePage'
import { SearchResults } from '../components/SearchResults'
import { SettingsPanel } from '../components/settings/SettingsPanel'

export interface BuiltinViewContext {
  infoPanelWidth: number
  onInfoNavigate: (id: string) => void
}

export const BUILTIN_VIEW_IDS = {
  chat: 'view.chat',
  insights: 'view.insights',
  lineage: 'view.lineage',
  settings: 'view.settings',
  searchResults: 'view.search-results',
  info: 'panel.info'
} as const

export function createBuiltinViewRegistry(): ViewRegistry<BuiltinViewContext, ReactNode> {
  const registry = new ViewRegistry<BuiltinViewContext, ReactNode>()
  const source = { kind: 'builtin' as const }
  registry.register({ id: BUILTIN_VIEW_IDS.chat, title: 'views.chat', placement: 'main', source, render: () => <ChatViewer /> })
  registry.register({ id: BUILTIN_VIEW_IDS.insights, title: 'views.insights', placement: 'main', source, render: () => <InsightsPage /> })
  registry.register({ id: BUILTIN_VIEW_IDS.lineage, title: 'views.lineage', placement: 'main', source, render: () => <LineagePage /> })
  registry.register({ id: BUILTIN_VIEW_IDS.settings, title: 'views.settings', placement: 'overlay', source, render: () => <SettingsPanel /> })
  registry.register({ id: BUILTIN_VIEW_IDS.searchResults, title: 'views.search_results', placement: 'overlay', source, render: () => <SearchResults /> })
  registry.register({
    id: BUILTIN_VIEW_IDS.info,
    title: 'views.info',
    placement: 'panel',
    source,
    render: ({ infoPanelWidth, onInfoNavigate }) => (
      <InfoPanel width={infoPanelWidth} onNavigate={onInfoNavigate} />
    )
  })
  return registry
}

export const builtinViewRegistry = createBuiltinViewRegistry()
