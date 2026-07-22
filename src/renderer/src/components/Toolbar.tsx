import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { Search, PanelRight, X, Zap, Settings, BarChart3, GitBranch, Bot } from 'lucide-react'
import { usePlatformCapabilities } from './WindowsAlphaNotice'

export function Toolbar() {
  const {
    searchQuery, search, clearSearch,
    infoPanelOpen, toggleInfoPanel,
    settingsOpen, toggleSettings,
    workspaceView, setWorkspaceView
  } = useStore()
  const t = useT()
  const isWindowsAlpha = usePlatformCapabilities()?.windowsNativeAlpha === true
  const [inputValue, setInputValue] = useState(searchQuery)
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleSearch = useCallback((value: string) => {
    setInputValue(value)
    if (searchTimeout) clearTimeout(searchTimeout)
    const timeout = setTimeout(() => {
      search(value)
    }, 300)
    setSearchTimeout(timeout)
  }, [search, searchTimeout])

  // ⌘K to focus global search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div
      className="h-12 flex items-center gap-3 px-4 border-b border-edge bg-base shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Native Windows uses a regular title bar and has no macOS traffic lights. */}
      {!isWindowsAlpha && <div className="w-16 shrink-0" />}

      {/* Search */}
      <div
        className="flex-1 max-w-lg relative"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t('toolbar.search_placeholder')}
          className="w-full pl-8 pr-16 py-1.5 text-sm bg-surface border border-edge rounded-md text-primary placeholder:text-muted focus:outline-none focus:border-edge-focus"
        />
        {inputValue ? (
          <button
            onClick={() => {
              setInputValue('')
              clearSearch()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-body"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-faint bg-hover/50 border border-edge-strong/50 rounded px-1 py-0.5 font-mono">
            {isWindowsAlpha ? 'Ctrl+K' : '⌘K'}
          </kbd>
        )}
      </div>

      {/* Spotlight jump button */}
      <div style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => (window as any).api?.spotlightToggle?.()}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted hover:text-primary hover:bg-hover transition-colors"
          title={t('toolbar.spotlight')}
        >
          <Zap size={13} />
          <span className="hidden sm:inline">{t('toolbar.spotlight_label')}</span>
          <kbd className="text-[10px] text-faint bg-hover/50 border border-edge-strong/50 rounded px-1 py-0.5 font-mono">
            {isWindowsAlpha ? 'Ctrl+Shift+Space' : '⌘⇧Space'}
          </kbd>
        </button>
      </div>

      {/* Right side */}
      <div
        className="flex items-center gap-1 ml-auto"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => void window.api.agentToggleWindow()}
          className="p-1.5 rounded hover:bg-hover text-secondary hover:text-primary"
          title="Swob 助手 (⌘⇧A)"
        >
          <Bot size={14} />
        </button>
        <button
          onClick={() => setWorkspaceView('galaxy')}
          className={`p-1.5 rounded hover:bg-hover ${workspaceView === 'galaxy' ? 'text-primary' : 'text-secondary hover:text-primary'}`}
          title={t('toolbar.lineage')}
        >
          <GitBranch size={14} />
        </button>
        <button
          onClick={() => setWorkspaceView('insights')}
          className={`p-1.5 rounded hover:bg-hover ${workspaceView === 'insights' ? 'text-primary' : 'text-secondary hover:text-primary'}`}
          title={t('toolbar.insights')}
        >
          <BarChart3 size={14} />
        </button>
        <button
          onClick={toggleSettings}
          className={`p-1.5 rounded hover:bg-hover ${settingsOpen ? 'text-primary' : 'text-secondary hover:text-primary'}`}
          title={t('toolbar.settings')}
        >
          <Settings size={14} />
        </button>
        <button
          onClick={toggleInfoPanel}
          className={`p-1.5 rounded hover:bg-hover ${infoPanelOpen ? 'text-primary' : 'text-muted'}`}
          title={t('toolbar.toggle_info')}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </div>
  )
}
