import { useState, useCallback } from 'react'
import { useStore } from '../store'
import { Search, Eye, EyeOff, Play, PanelRight, X, Download } from 'lucide-react'

export function Toolbar() {
  const {
    searchQuery, search, clearSearch,
    viewMode, toggleViewMode,
    selectedSession, resumeSession,
    infoPanelOpen, toggleInfoPanel,
    triggerExportMarkdown
  } = useStore()
  const [inputValue, setInputValue] = useState(searchQuery)
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = useCallback((value: string) => {
    setInputValue(value)
    if (searchTimeout) clearTimeout(searchTimeout)
    const timeout = setTimeout(() => {
      search(value)
    }, 300)
    setSearchTimeout(timeout)
  }, [search, searchTimeout])

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
          value={inputValue}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="搜索所有对话..."
          className="w-full pl-8 pr-8 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
        />
        {inputValue && (
          <button
            onClick={() => {
              setInputValue('')
              clearSearch()
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Actions */}
      <div
        className="flex items-center gap-1"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={toggleViewMode}
          className="px-2 py-1 text-xs rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          title={viewMode === 'compact' ? '切换到完整模式' : '切换到精简模式'}
        >
          {viewMode === 'compact' ? <Eye size={14} /> : <EyeOff size={14} />}
          <span>{viewMode === 'compact' ? '精简' : '完整'}</span>
        </button>

        {selectedSession && (
          <button
            onClick={triggerExportMarkdown}
            className="px-2 py-1 text-xs rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
            title="导出为 Markdown"
          >
            <Download size={14} />
            <span>导出 MD</span>
          </button>
        )}

        <button
          onClick={toggleInfoPanel}
          className={`p-1.5 rounded hover:bg-zinc-700 ${infoPanelOpen ? 'text-zinc-200' : 'text-zinc-500'}`}
          title="切换信息面板"
        >
          <PanelRight size={16} />
        </button>

        {selectedSession && (
          <>
            {selectedSession.permissionMode === 'bypassPermissions' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 border border-red-800/50">
                skip-permissions
              </span>
            )}
            <button
              onClick={() => resumeSession(selectedSession.sessionId || selectedSession.id, selectedSession.permissionMode, selectedSession.cwds?.[0])}
              className="ml-2 px-3 py-1 text-xs rounded bg-green-700 hover:bg-green-600 text-white flex items-center gap-1"
            >
              <Play size={12} />
              Resume
            </button>
          </>
        )}
      </div>
    </div>
  )
}
