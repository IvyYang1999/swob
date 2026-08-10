import { Copy, Pin, Plus, RotateCcw, X } from 'lucide-react'
import type { KeyboardEvent } from 'react'
import type { WorkspaceTab } from '../../../../shared/contracts/truth-kernel'
import { translateCatalog, type CatalogLocale } from '../../../../shared/i18n-contributions/t211e-device-catalog'

export interface WorkspaceTabsProps {
  tabs: WorkspaceTab[]
  activeTabId: string
  onActivate(tabId: string): void
  onClose(tabId: string): void
  onCreate(): void
  onPin?(tabId: string, pinned: boolean): void
  onDuplicate?(tabId: string): void
  onRename?(tabId: string): void
  onRestoreRecentlyClosed?(): void
  locale?: CatalogLocale
}

/** Pure shell component; t211I owns connecting it to App and persisted IPC state. */
export function WorkspaceTabs({ tabs, activeTabId, onActivate, onClose, onCreate, onPin, onDuplicate, onRename, onRestoreRecentlyClosed, locale = 'en' }: WorkspaceTabsProps) {
  const hasTabActions = Boolean(onRename)
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId)
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let target = index
    if (event.key === 'ArrowRight') target = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') target = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') target = 0
    else if (event.key === 'End') target = tabs.length - 1
    else if (event.key === 'Delete' && !tabs[index].pinned) { onClose(tabs[index].tabId); return }
    else return
    event.preventDefault(); onActivate(tabs[target].tabId)
    document.querySelector<HTMLButtonElement>(`[data-workspace-tab-id="${CSS.escape(tabs[target].tabId)}"]`)?.focus()
  }
  return <nav aria-label={translateCatalog(locale, 'catalog.workspace.aria')} className="flex min-w-0 items-center gap-1 border-b border-edge bg-base px-2 py-1">
    <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" data-testid="workspace-tab-strip">
      {tabs.map((tab, index) => <div key={tab.tabId} className={`group flex min-w-0 shrink-0 items-center rounded-md border px-2 py-1 text-xs ${tab.tabId === activeTabId ? 'border-edge-strong bg-surface text-primary' : 'border-transparent text-secondary hover:bg-surface'}`}>
        <button type="button" role="tab" data-workspace-tab-id={tab.tabId} tabIndex={tab.tabId === activeTabId ? 0 : -1} onKeyDown={(event) => moveFocus(event, index)} onDoubleClick={() => onRename?.(tab.tabId)} onClick={() => onActivate(tab.tabId)} className="flex min-w-0 items-center gap-1 outline-none focus-visible:ring-2 focus-visible:ring-accent rounded" aria-selected={tab.tabId === activeTabId} aria-current={tab.tabId === activeTabId ? 'page' : undefined}>
          {tab.pinned && <Pin size={11} className="shrink-0 text-accent" aria-hidden="true" />}
          <span className={`${hasTabActions ? 'max-w-24' : 'max-w-40'} truncate`}>{tab.title}</span>
        </button>
        <button type="button" aria-label={translateCatalog(locale, 'catalog.workspace.close', { title: tab.title })} onClick={() => onClose(tab.tabId)} className="ml-1 rounded p-0.5 text-muted hover:bg-hover hover:text-primary focus-visible:ring-2 focus-visible:ring-accent"><X size={12} /></button>
      </div>)}
    </div>
    {activeTab && onPin && <button type="button" aria-label={translateCatalog(locale, activeTab.pinned ? 'catalog.workspace.unpin' : 'catalog.workspace.pin', { title: activeTab.title })} onClick={() => onPin(activeTab.tabId, !activeTab.pinned)} className="shrink-0 rounded p-1 text-secondary hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"><Pin size={14} /></button>}
    {activeTab && onDuplicate && <button type="button" aria-label={translateCatalog(locale, 'catalog.workspace.duplicate', { title: activeTab.title })} onClick={() => onDuplicate(activeTab.tabId)} className="shrink-0 rounded p-1 text-secondary hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"><Copy size={14} /></button>}
    {onRestoreRecentlyClosed && <button type="button" aria-label={translateCatalog(locale, 'catalog.workspace.restore')} onClick={onRestoreRecentlyClosed} className="shrink-0 rounded p-1 text-secondary hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"><RotateCcw size={15} /></button>}
    <button type="button" aria-label={translateCatalog(locale, 'catalog.workspace.new')} onClick={onCreate} className="shrink-0 rounded p-1 text-secondary hover:bg-surface focus-visible:ring-2 focus-visible:ring-accent"><Plus size={16} /></button>
  </nav>
}
