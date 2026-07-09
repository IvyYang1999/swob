import { useState, useEffect, useRef, useCallback } from 'react'
import { Search, Play, ArrowRight, Clock, MessageSquare, FolderOpen } from 'lucide-react'
import claudeIcon from './assets/icons/claude.png'
import openaiIcon from './assets/icons/openai.png'
import cursorIcon from './assets/icons/cursor.png'

const api = (window as any).api

interface SpotlightResultItem {
  session: {
    id: string
    sessionId: string
    firstUserMessage: string
    updatedAt: string
    turnCount: number
    cwds: string[]
    resumeCwd?: string
    source?: string
    permissionMode?: string
    canResume?: boolean
    resumeUnavailableReason?: string
  }
  score: number
  matchedFields: string[]
  customTitle?: string
  folderName?: string
}

function sourceIcon(source?: string): string {
  if (source === 'codex') return openaiIcon
  if (source === 'cursor') return cursorIcon
  return claudeIcon
}

function sourceLabel(source?: string): string {
  if (source === 'codex') return 'Codex'
  if (source === 'cursor') return 'Cursor'
  return 'CC'
}

function sourceBadgeClass(source?: string): string {
  if (source === 'codex') return 'bg-[#5a9fd4]/15 text-[#5a9fd4]'
  if (source === 'cursor') return 'bg-[#a1a1aa]/15 text-[#a1a1aa]'
  return 'bg-[#c88450]/15 text-[#c88450]'
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}天前`
  return new Date(isoDate).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function getProjectName(cwds: string[]): string {
  if (!cwds || cwds.length === 0) return ''
  const cwd = cwds[0]
  const parts = cwd.split('/')
  return parts[parts.length - 1] || parts[parts.length - 2] || ''
}

export default function SpotlightApp() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SpotlightResultItem[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()

  const doSearch = useCallback(async (q: string) => {
    setLoading(true)
    try {
      const res = await api.spotlightSearch(q)
      setResults(res)
      setSelectedIndex(0)
    } catch {
      setResults([])
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    doSearch('')
    inputRef.current?.focus()
  }, [doSearch])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(query), 120)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [query, doSearch])

  // Scroll selected item into view
  useEffect(() => {
    const container = listRef.current
    if (!container) return
    const item = container.children[selectedIndex] as HTMLElement
    if (item) item.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleResume = useCallback((item: SpotlightResultItem) => {
    if (item.session.canResume === false) return
    const cwd = item.session.resumeCwd || item.session.cwds?.[0]
    api.spotlightResume(item.session.sessionId, cwd)
  }, [])

  const handleNavigate = useCallback((item: SpotlightResultItem) => {
    api.spotlightSelectInMain(item.session.id)
  }, [])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[selectedIndex]
      if (!item) return
      if (e.metaKey || e.ctrlKey) {
        handleNavigate(item)
      } else {
        handleResume(item)
      }
    } else if (e.key === 'Escape') {
      api.spotlightHide()
    }
  }, [results, selectedIndex, handleResume, handleNavigate])

  return (
    <div className="w-full h-full flex flex-col select-none p-5" style={{ WebkitAppRegion: 'drag' } as any}>
      <div
        className="mx-auto w-full max-w-[680px] rounded-2xl bg-base/95 backdrop-blur-xl border border-edge shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: '480px', WebkitAppRegion: 'no-drag' } as any}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-edge">
          <Search size={18} className="shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索 session… 试试 &quot;飞搜 最新 codex&quot;"
            className="flex-1 bg-transparent text-primary text-sm outline-none placeholder:text-faint"
            autoFocus
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-muted border-t-transparent rounded-full animate-spin shrink-0" />
          )}
        </div>

        {/* Results list */}
        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {results.length === 0 && query && !loading && (
            <div className="px-4 py-8 text-center text-muted text-sm">
              没有找到匹配的 session
            </div>
          )}
          {results.map((item, i) => (
            <div
              key={item.session.id}
              className={`px-4 py-2.5 flex items-start gap-3 transition-colors ${
                i === selectedIndex ? 'bg-accent/12' : 'hover:bg-surface'
              } ${item.session.canResume === false ? 'cursor-not-allowed opacity-70' : 'cursor-pointer'}`}
              onClick={() => handleResume(item)}
              onMouseEnter={() => setSelectedIndex(i)}
              title={item.session.canResume === false ? item.session.resumeUnavailableReason : undefined}
            >
              <img
                src={sourceIcon(item.session.source)}
                className="w-6 h-6 rounded-full shrink-0 mt-0.5"
                alt=""
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-primary truncate font-medium">
                    {item.customTitle || item.session.firstUserMessage.slice(0, 80) || '(empty)'}
                  </span>
                  <span className={`px-1 rounded text-[10px] whitespace-nowrap shrink-0 font-medium ${sourceBadgeClass(item.session.source)}`}>
                    {sourceLabel(item.session.source)}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-0.5 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <Clock size={10} />
                    {formatRelativeTime(item.session.updatedAt)}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageSquare size={10} />
                    {item.session.turnCount}轮
                  </span>
                  {getProjectName(item.session.cwds) && (
                    <span className="truncate max-w-[160px]">
                      {getProjectName(item.session.cwds)}
                    </span>
                  )}
                  {item.folderName && (
                    <span className="flex items-center gap-1 truncate">
                      <FolderOpen size={10} />
                      {item.folderName}
                    </span>
                  )}
                </div>
                {item.customTitle && item.session.firstUserMessage && (
                  <div className="text-xs text-faint truncate mt-0.5">
                    {item.session.firstUserMessage.slice(0, 100)}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0 mt-1">
                {i === selectedIndex && (
                  <>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleResume(item) }}
                      disabled={item.session.canResume === false}
                      className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] bg-active/15 text-active hover:bg-active/25 transition-colors disabled:opacity-45 disabled:cursor-not-allowed disabled:hover:bg-active/15"
                      title={item.session.canResume === false ? item.session.resumeUnavailableReason : 'Resume (Enter)'}
                    >
                      <Play size={10} /> Resume
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleNavigate(item) }}
                      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] bg-surface text-muted hover:text-secondary transition-colors"
                      title="在 Swob 中查看 (⌘+Enter)"
                    >
                      <ArrowRight size={10} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-1.5 border-t border-edge text-[11px] text-faint flex items-center gap-4">
          <span>↑↓ 选择</span>
          <span>↵ Resume</span>
          <span>⌘↵ 在 Swob 中查看</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  )
}
