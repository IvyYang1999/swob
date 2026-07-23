import { translate, type Locale } from '../../i18n'

export type InspectorTab = 'details' | 'files' | 'audit' | 'context' | 'outcomes' | 'activity'

interface InspectorTabsProps {
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  locale: Locale
  tabs?: InspectorTab[]
}

const TAB_LABEL_KEYS: Record<InspectorTab, string> = {
  details: 'renderer.info_panel.tab_details',
  files: 'renderer.inspector_tabs.files',
  audit: 'renderer.inspector_tabs.audit',
  context: 'renderer.inspector_tabs.context',
  outcomes: 'renderer.info_panel.tab_outcomes',
  activity: 'renderer.info_panel.tab_activity'
}

const DEFAULT_TABS: InspectorTab[] = ['outcomes', 'activity', 'details']

export function InspectorTabs({ activeTab, onTabChange, locale, tabs = DEFAULT_TABS }: InspectorTabsProps) {
  return (
    <div className={`grid p-0.5 rounded bg-surface`} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }} role="tablist" aria-label="Inspector tabs">
      {tabs.map((tab) => (
        <button
          key={tab}
          role="tab"
          aria-selected={activeTab === tab}
          onClick={() => onTabChange(tab)}
          className={`py-1 rounded text-[11px] text-center transition-colors ${
            activeTab === tab
              ? 'bg-hover text-primary'
              : 'text-muted hover:text-secondary'
          }`}
        >
          {translate(locale, TAB_LABEL_KEYS[tab])}
        </button>
      ))}
    </div>
  )
}
