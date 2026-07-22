import { translate, type Locale } from '../../i18n'

export type InspectorTab = 'details' | 'files' | 'audit'

interface InspectorTabsProps {
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  locale: Locale
}

const TAB_LABEL_KEYS: Record<InspectorTab, string> = {
  details: 'renderer.inspector_tabs.details',
  files: 'renderer.inspector_tabs.files',
  audit: 'renderer.inspector_tabs.audit'
}

const TABS: InspectorTab[] = ['details', 'files', 'audit']

export function InspectorTabs({ activeTab, onTabChange, locale }: InspectorTabsProps) {
  return (
    <div className="grid grid-cols-3 p-0.5 rounded bg-surface" role="tablist" aria-label="Inspector tabs">
      {TABS.map((tab) => (
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
