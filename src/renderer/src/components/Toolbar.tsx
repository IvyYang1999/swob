import { useState, useCallback } from 'react'
import { useStore } from '../store'
import type { ViewMode } from '../store'
import { Search, Play, PanelRight, X, Download, FolderDown } from 'lucide-react'

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: 'compact', label: '精简' },
  { mode: 'full', label: '完整' },
  { mode: 'markdown', label: 'MD' },
]

export function Toolbar() {
  const {
    searchQuery, search, clearSearch,
    viewMode, setViewMode,
    selectedSession, resumeSession,
    infoPanelOpen, toggleInfoPanel,
    downloadSessionMarkdown, saveMarkdownToProject
  } = useStore()
  const [inputValue, setInputValue] = useState(searchQuery)
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null)
  const [saveStatus, setSaveStatus] = useState<string | null>(null)

  const handleSearch = useCallback((value: string) => {
    setInputValue(value)
    if (searchTimeout) clearTimeout(searchTimeout)
    const timeout = setTimeout(() => {
      search(value)
    }, 300)
    setSearchTimeout(timeout)
  }, [search, searchTimeout])

  const handleSaveToProject = useCallback(async () => {
    const path = await saveMarkdownToProject()
    if (path) {
      setSaveStatus('已保存')
      setTimeout(() => setSaveStatus(null), 2000)
    }
  }, [saveMarkdownToProject])

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
        className="flex items-center gap-1.5"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {/* View mode segmented control */}
        <div className="flex items-center bg-zinc-800 rounded-md border border-zinc-700 overflow-hidden">
          {VIEW_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-2 py-1 text-[11px] transition-colors ${
                viewMode === mode
                  ? 'bg-zinc-600 text-zinc-100 font-medium'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Export actions */}
        {selectedSession && (
          <>
            <button
              onClick={downloadSessionMarkdown}
              className="p-1.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
              title="下载 MD 文件"
            >
              <Download size={14} />
            </button>

            {selectedSession.cwds?.[0] && (
              <button
                onClick={handleSaveToProject}
                className="p-1.5 rounded hover:bg-zinc-700 text-zinc-500 hover:text-zinc-300"
                title={saveStatus || '保存到项目目录'}
              >
                {saveStatus ? (
                  <span className="text-[10px] text-green-400 font-medium px-0.5">{saveStatus}</span>
                ) : (
                  <FolderDown size={14} />
                )}
              </button>
            )}
          </>
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
              className="ml-1 px-3 py-1 text-xs rounded bg-green-700 hover:bg-green-600 text-white flex items-center gap-1"
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
