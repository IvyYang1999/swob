export type InspectorTab = 'details' | 'files' | 'audit'

interface InspectorTabsProps {
  activeTab: InspectorTab
  onTabChange: (tab: InspectorTab) => void
  locale: string
}

const TAB_LABELS: Record<InspectorTab, { zh: string; en: string }> = {
  details: { zh: '详情', en: 'Details' },
  files: { zh: '文件', en: 'Files' },
  audit: { zh: '审计', en: 'Audit' }
}

const TABS: InspectorTab[] = ['details', 'files', 'audit']

export function InspectorTabs({ activeTab, onTabChange, locale }: InspectorTabsProps) {
  const isZh = locale === 'zh-CN'

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
          {isZh ? TAB_LABELS[tab].zh : TAB_LABELS[tab].en}
        </button>
      ))}
    </div>
  )
}
