import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { Search, PanelRight, X, Zap, Settings, BarChart3, GitBranch, Bot } from 'lucide-react'
import { usePlatformCapabilities } from './WindowsAlphaNotice'
import {
  BUILTIN_COMMAND_IDS,
  createBuiltinCommandRegistry,
  type BuiltinCommandContext
} from '../../../shared/registry/builtin-commands'

const toolbarCommandRegistry = createBuiltinCommandRegistry()

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
  const commandContext: BuiltinCommandContext = {
    openView: (target) => {
      if (target === 'lineage') setWorkspaceView('galaxy')
      if (target === 'insights') setWorkspaceView('insights')
      if (target === 'settings') toggleSettings()
    },
    togglePanel: (target) => {
      if (target === 'info') toggleInfoPanel()
    },
    toggleWindow: (target) => target === 'agent'
      ? window.api.agentToggleWindow()
      : (window as any).api?.spotlightToggle?.()
  }
  const runCommand = (id: string) => {
    void toolbarCommandRegistry.require(id).run(commandContext)
  }
  const rightCommandButtons = [
    {
      id: BUILTIN_COMMAND_IDS.windowAgent,
      icon: Bot,
      iconSize: 14,
      className: 'p-1.5 rounded hover:bg-hover text-secondary hover:text-primary',
      title: t('renderer.toolbar.agent')
    },
    {
      id: BUILTIN_COMMAND_IDS.viewLineage,
      icon: GitBranch,
      iconSize: 14,
      className: `p-1.5 rounded hover:bg-hover ${workspaceView === 'galaxy' ? 'text-primary' : 'text-secondary hover:text-primary'}`
    },
    {
      id: BUILTIN_COMMAND_IDS.viewInsights,
      icon: BarChart3,
      iconSize: 14,
      className: `p-1.5 rounded hover:bg-hover ${workspaceView === 'insights' ? 'text-primary' : 'text-secondary hover:text-primary'}`
    },
    {
      id: BUILTIN_COMMAND_IDS.viewSettings,
      icon: Settings,
      iconSize: 14,
      className: `p-1.5 rounded hover:bg-hover ${settingsOpen ? 'text-primary' : 'text-secondary hover:text-primary'}`
    },
    {
      id: BUILTIN_COMMAND_IDS.panelInfo,
      icon: PanelRight,
      iconSize: 16,
      className: `p-1.5 rounded hover:bg-hover ${infoPanelOpen ? 'text-primary' : 'text-muted'}`
    }
  ]

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
          onClick={() => runCommand(BUILTIN_COMMAND_IDS.windowSpotlight)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-muted hover:text-primary hover:bg-hover transition-colors"
          title={t(toolbarCommandRegistry.require(BUILTIN_COMMAND_IDS.windowSpotlight).title)}
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
        {rightCommandButtons.map(({ id, icon: Icon, iconSize, className, title }) => {
          const command = toolbarCommandRegistry.require(id)
          return (
            <button
              key={command.id}
              onClick={() => runCommand(command.id)}
              className={className}
              title={title || t(command.title)}
            >
              <Icon size={iconSize} />
            </button>
          )
        })}
      </div>
    </div>
  )
}
