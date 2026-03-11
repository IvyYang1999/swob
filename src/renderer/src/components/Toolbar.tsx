import { useState, useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { Search, PanelRight, X } from 'lucide-react'

export function Toolbar() {
  const {
    searchQuery, search, clearSearch,
    infoPanelOpen, toggleInfoPanel
  } = useStore()
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
      className="h-12 flex items-center gap-3 px-4 border-b border-zinc-700 bg-zinc-900 shrink-0"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Spacer for traffic lights */}
      <div className="w-16 shrink-0" />

      {/* Search */}
      <div
        className="flex-1 max-w-lg relative"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          ref={inputRef}
          value={inputValue}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="搜索所有对话..."
          className="w-full pl-8 pr-16 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
        />
        {inputValue ? (
          <button
            onClick={() => {
              setInputValue('')
              clearSearch()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        ) : (
          <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-zinc-600 bg-zinc-700/50 border border-zinc-600/50 rounded px-1 py-0.5 font-mono">⌘K</kbd>
        )}
      </div>

      {/* Right side: layout toggle — pushed to far right */}
      <div
        className="flex items-center ml-auto"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={toggleInfoPanel}
          className={`p-1.5 rounded hover:bg-zinc-700 ${infoPanelOpen ? 'text-zinc-200' : 'text-zinc-500'}`}
          title="切换信息面板"
        >
          <PanelRight size={16} />
        </button>
      </div>
    </div>
  )
}
