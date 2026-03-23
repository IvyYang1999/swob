import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { useT } from '../i18n'
import { Search, PanelRight, X, Globe } from 'lucide-react'

export function Toolbar() {
  const {
    searchQuery, search, clearSearch,
    infoPanelOpen, toggleInfoPanel,
    locale, setLocale
  } = useStore()
  const t = useT()
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
      {/* Spacer for traffic lights */}
      <div className="w-16 shrink-0" />

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
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-faint bg-hover/50 border border-edge-strong/50 rounded px-1 py-0.5 font-mono">⌘K</kbd>
        )}
      </div>

      {/* Right side: language toggle + info panel toggle */}
      <div
        className="flex items-center gap-1 ml-auto"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-hover text-secondary hover:text-primary text-xs"
          title={t('toolbar.language')}
        >
          <Globe size={14} />
          <span>{locale === 'zh-CN' ? 'EN' : '中'}</span>
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
