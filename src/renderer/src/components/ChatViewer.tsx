import { useRef, useState, useMemo, useCallback, useEffect } from 'react'
import { useStore } from '../store'
import type { ViewMode, ParsedMessage, SessionDetail, Highlight } from '../store'
import {
  User, Bot, Terminal, ChevronDown, ChevronRight,
  History, GitBranch, Copy, Check, Download, Play,
  List, Code2, CheckSquare,
  Search, X, ArrowUp, ArrowDown, Highlighter, Trash2
} from 'lucide-react'
import { CliMarkdown, DocMarkdown } from './MarkdownContent'
import {
  computeSections,
  groupIntoTurns,
  buildSegments,
  sessionToMarkdown,
  computeChatTocEntries,
  turnToMarkdown,
  COMPACT_SUMMARY_PREFIX
} from '../utils/markdown'
import type { CompactSection, Turn, ToolCallInfo, TocEntry } from '../utils/markdown'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// --- Tool color palette ---

const TOOL_COLORS: Record<string, string> = {
  Bash: 'bg-green-900/50 text-green-400 border-green-700/40',
  Read: 'bg-blue-900/50 text-blue-400 border-blue-700/40',
  Write: 'bg-amber-900/50 text-amber-400 border-amber-700/40',
  Edit: 'bg-amber-900/50 text-amber-400 border-amber-700/40',
  Grep: 'bg-violet-900/50 text-violet-400 border-violet-700/40',
  Glob: 'bg-violet-900/50 text-violet-400 border-violet-700/40',
  Agent: 'bg-cyan-900/50 text-cyan-400 border-cyan-700/40',
  WebSearch: 'bg-indigo-900/50 text-indigo-400 border-indigo-700/40',
  WebFetch: 'bg-indigo-900/50 text-indigo-400 border-indigo-700/40',
  Skill: 'bg-pink-900/50 text-pink-400 border-pink-700/40',
}
const DEFAULT_TOOL_COLOR = 'bg-zinc-800/60 text-zinc-400 border-zinc-700/40'

function getToolPreview(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash' && input.command) return String(input.command).slice(0, 120)
  if ((name === 'Read' || name === 'Write' || name === 'Edit') && input.file_path) return String(input.file_path)
  if ((name === 'Grep' || name === 'Glob') && input.pattern) return String(input.pattern)
  if (name === 'Skill' && input.skill) return String(input.skill)
  if (name === 'Agent' && input.prompt) return String(input.prompt).slice(0, 80)
  return ''
}

// --- Diff view for Edit tool ---

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const oldLines = oldStr.split('\n')
  const newLines = newStr.split('\n')
  return (
    <div className="font-mono text-[11px] leading-relaxed">
      {oldLines.map((line, i) => (
        <div key={`old-${i}`} className="bg-red-950/40 text-red-400 px-3 py-0.5">
          <span className="select-none text-red-600 mr-2">-</span>{line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`new-${i}`} className="bg-green-950/40 text-green-400 px-3 py-0.5">
          <span className="select-none text-green-600 mr-2">+</span>{line}
        </div>
      ))}
    </div>
  )
}

// --- Compact mode: Pill bar ---

function ToolCallPillBar({ toolCalls }: { toolCalls: ToolCallInfo[] }) {
  const [expanded, setExpanded] = useState(false)
  const grouped = useMemo(() => {
    const map = new Map<string, number>()
    for (const tc of toolCalls) map.set(tc.name, (map.get(tc.name) || 0) + 1)
    return map
  }, [toolCalls])

  return (
    <div className="my-1.5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-800/60 border border-zinc-700/40 hover:border-zinc-600/50 transition-colors"
      >
        {expanded ? <ChevronDown size={11} className="text-zinc-500 shrink-0" /> : <ChevronRight size={11} className="text-zinc-500 shrink-0" />}
        <Terminal size={11} className="text-zinc-500 shrink-0" />
        <div className="flex items-center gap-1 flex-wrap">
          {[...grouped.entries()].map(([name, count]) => (
            <span key={name} className={`text-[10px] px-1.5 py-0.5 rounded-full border font-mono ${TOOL_COLORS[name] || DEFAULT_TOOL_COLOR}`}>
              {name}{count > 1 ? ` ×${count}` : ''}
            </span>
          ))}
        </div>
      </button>
      {expanded && (
        <div className="mt-1 ml-5 space-y-1.5">
          {toolCalls.map((tc, i) => <ToolCallExpanded key={i} tc={tc} />)}
        </div>
      )}
    </div>
  )
}

function ToolCallExpanded({ tc }: { tc: ToolCallInfo }) {
  const [showResult, setShowResult] = useState(true)
  const color = TOOL_COLORS[tc.name] || DEFAULT_TOOL_COLOR
  const preview = getToolPreview(tc.name, tc.input)
  const isEdit = tc.name === 'Edit' && tc.input.old_string

  return (
    <div className="border border-zinc-700/50 rounded-md bg-zinc-800/30">
      <div className="px-2.5 py-1.5 flex items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-mono shrink-0 ${color}`}>{tc.name}</span>
        {preview && <span className="truncate text-zinc-500 text-[11px] font-mono">{preview}</span>}
      </div>
      {isEdit ? (
        <div className="border-t border-zinc-700/50 overflow-x-auto max-h-60 overflow-y-auto">
          <DiffView oldStr={String(tc.input.old_string)} newStr={String(tc.input.new_string || '')} />
        </div>
      ) : (
        <pre className="px-3 py-2 text-[11px] text-zinc-400 overflow-x-auto border-t border-zinc-700/50 max-h-40 overflow-y-auto font-mono">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
      {tc.result && (
        <>
          <button onClick={() => setShowResult(!showResult)} className="w-full px-3 py-1 text-[11px] text-zinc-500 hover:text-zinc-400 border-t border-zinc-700/50 flex items-center gap-1">
            {showResult ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Result ({tc.result.length > 200 ? `${Math.round(tc.result.length / 1024)}KB` : `${tc.result.length} chars`})
          </button>
          {showResult && (
            <pre className="px-3 py-2 text-[11px] text-zinc-500 overflow-x-auto border-t border-zinc-700/30 max-h-48 overflow-y-auto font-mono bg-zinc-900/30">{tc.result}</pre>
          )}
        </>
      )}
    </div>
  )
}

function ToolCallFull({ tc }: { tc: ToolCallInfo }) {
  const [showResult, setShowResult] = useState(true)
  const color = TOOL_COLORS[tc.name] || DEFAULT_TOOL_COLOR
  const preview = getToolPreview(tc.name, tc.input)
  const isEdit = tc.name === 'Edit' && tc.input.old_string

  let inputDisplay: string
  if (tc.name === 'Bash' && tc.input.command) inputDisplay = String(tc.input.command)
  else if (tc.name === 'Read' && tc.input.file_path) inputDisplay = String(tc.input.file_path)
  else if (isEdit) inputDisplay = ''
  else if (tc.name === 'Write' && tc.input.content) inputDisplay = `File: ${tc.input.file_path || ''}\n\n${String(tc.input.content).slice(0, 2000)}`
  else inputDisplay = JSON.stringify(tc.input, null, 2)

  return (
    <div className="my-1.5 border border-zinc-700/50 rounded-md bg-zinc-850/30 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-2 bg-zinc-800/60 border-b border-zinc-700/40">
        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-mono shrink-0 ${color}`}>{tc.name}</span>
        {preview && <span className="truncate text-zinc-500 text-[11px] font-mono">{preview}</span>}
      </div>
      {isEdit ? (
        <div className="overflow-x-auto max-h-60 overflow-y-auto">
          <DiffView oldStr={String(tc.input.old_string)} newStr={String(tc.input.new_string || '')} />
        </div>
      ) : inputDisplay ? (
        <pre className="px-3 py-2 text-[11px] text-zinc-400 overflow-x-auto max-h-48 overflow-y-auto font-mono">{inputDisplay}</pre>
      ) : null}
      {tc.result && (
        <>
          <button onClick={() => setShowResult(!showResult)} className="w-full px-3 py-1 text-[11px] text-zinc-500 hover:text-zinc-400 border-t border-zinc-700/50 flex items-center gap-1">
            {showResult ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Result ({tc.result.length > 200 ? `${Math.round(tc.result.length / 1024)}KB` : `${tc.result.length} chars`})
          </button>
          {showResult && (
            <pre className="px-3 py-2 text-[11px] text-zinc-500 overflow-x-auto max-h-48 overflow-y-auto font-mono bg-zinc-900/30">{tc.result}</pre>
          )}
        </>
      )}
    </div>
  )
}

// --- Turn block ---

function TurnBlock({ turn, viewMode, qSelected, aSelected, selectMode, onSelectQ, onSelectA }: {
  turn: Turn; viewMode: 'compact' | 'full'
  qSelected?: boolean; aSelected?: boolean
  selectMode?: boolean
  onSelectQ?: (uuid: string) => void; onSelectA?: (uuid: string) => void
}) {
  const segments = useMemo(() => buildSegments(turn.assistantMsgs), [turn.assistantMsgs])
  const hasSidechain = turn.assistantMsgs.some((m) => m.isSidechain)
  const turnId = turn.userMsg ? `turn-${turn.userMsg.uuid}` : undefined
  const [copiedQ, setCopiedQ] = useState(false)
  const [copiedA, setCopiedA] = useState(false)

  const copyQuery = useCallback(() => {
    if (!turn.userMsg) return
    navigator.clipboard.writeText(turn.userMsg.textContent)
    setCopiedQ(true)
    setTimeout(() => setCopiedQ(false), 1500)
  }, [turn.userMsg])

  const copyResponse = useCallback(() => {
    const md = turnToMarkdown({ userMsg: null, assistantMsgs: turn.assistantMsgs })
    navigator.clipboard.writeText(md)
    setCopiedA(true)
    setTimeout(() => setCopiedA(false), 1500)
  }, [turn.assistantMsgs])

  return (
    <div id={turnId} className="space-y-3 scroll-mt-0 relative">
      {/* User message */}
      {turn.userMsg && (
        <div className={`group/user rounded-lg transition-colors ${qSelected ? 'bg-blue-950/25' : ''} ${turn.userMsg.isSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
          <div className="flex gap-3 items-start">
            {selectMode && onSelectQ && (
              <button
                onClick={() => onSelectQ(turn.userMsg!.uuid)}
                className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 mt-1.5 ${qSelected ? 'bg-blue-600 border-blue-500 text-white' : 'border-zinc-600 hover:border-zinc-400 text-zinc-500'}`}
              >
                {qSelected ? '✓' : ''}
              </button>
            )}
            <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-blue-600"><User size={14} /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-zinc-400">User</span>
                <span className="text-[11px] text-zinc-600">{formatTime(turn.userMsg.timestamp)}</span>
                <button
                  onClick={copyQuery}
                  className="opacity-0 group-hover/user:opacity-100 transition-opacity p-0.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300"
                  title="复制问题"
                >
                  {copiedQ ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                </button>
              </div>
              {turn.userMsg.textContent.startsWith(COMPACT_SUMMARY_PREFIX) ? (
                <div className="text-sm text-zinc-200 border-l-2 border-amber-600/50 pl-3">
                  <div className="text-[10px] text-amber-500 mb-1 font-medium">Compact 上下文摘要</div>
                  <div className="whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto">
                    {turn.userMsg.textContent.slice(COMPACT_SUMMARY_PREFIX.length).trim()}
                  </div>
                </div>
              ) : (
                <div className="text-sm text-zinc-200">
                  <CliMarkdown content={turn.userMsg.textContent} />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Assistant message */}
      {segments.length > 0 && (
        <div className={`group/assistant rounded-lg transition-colors ${aSelected ? 'bg-blue-950/25' : ''} ${hasSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
          <div className="flex gap-3 items-start">
            {selectMode && onSelectA && turn.userMsg && (
              <button
                onClick={() => onSelectA(turn.userMsg!.uuid)}
                className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 mt-1.5 ${aSelected ? 'bg-blue-600 border-blue-500 text-white' : 'border-zinc-600 hover:border-zinc-400 text-zinc-500'}`}
              >
                {aSelected ? '✓' : ''}
              </button>
            )}
            <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-orange-600"><Bot size={14} /></div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-zinc-400">Assistant</span>
                <span className="text-[11px] text-zinc-600">{formatTime(turn.assistantMsgs[0].timestamp)}</span>
                {hasSidechain && <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-500">rejected</span>}
                <button
                  onClick={copyResponse}
                  className="opacity-0 group-hover/assistant:opacity-100 transition-opacity p-0.5 rounded hover:bg-zinc-700/50 text-zinc-500 hover:text-zinc-300"
                  title="复制回答"
                >
                  {copiedA ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
                </button>
              </div>
              {segments.map((seg, i) => (
                <div key={i}>
                  {seg.type === 'text' && <CliMarkdown content={seg.text!} />}
                  {seg.type === 'tools' && (
                    viewMode === 'compact'
                      ? <ToolCallPillBar toolCalls={seg.toolCalls!} />
                      : <div className="space-y-1.5 my-1.5">{seg.toolCalls!.map((tc, j) => <ToolCallFull key={j} tc={tc} />)}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// --- View mode config ---

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: 'compact', label: '精简' },
  { mode: 'full', label: '完整' },
  { mode: 'markdown', label: 'MD' },
]

// --- Resizable TOC Sidebar ---

function TocSidebar({ entries, onNavigate, width, onResize, turnContentMap, highlightedTurnUuids }: {
  entries: TocEntry[]
  onNavigate: (id: string) => void
  width: number
  onResize: (w: number) => void
  turnContentMap?: Map<string, string>
  highlightedTurnUuids?: Set<string>
}) {
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const groups: { header: TocEntry | null; groupIdx: number; children: TocEntry[] }[] = []
  let currentGroup: (typeof groups)[0] | null = null

  for (const entry of entries) {
    if (entry.level === 1) continue
    if (entry.level === 2) {
      if (currentGroup) groups.push(currentGroup)
      currentGroup = { header: entry, groupIdx: groups.length, children: [] }
    } else if (entry.level === 5) {
      if (!currentGroup) currentGroup = { header: null, groupIdx: groups.length, children: [] }
      currentGroup.children.push(entry)
    }
  }
  if (currentGroup) groups.push(currentGroup)

  const toggleGroup = (idx: number) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startX: e.clientX, startW: width }
    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const newW = Math.max(120, Math.min(400, dragRef.current.startW + ev.clientX - dragRef.current.startX))
      onResize(newW)
    }
    const handleUp = () => {
      dragRef.current = null
      document.removeEventListener('mousemove', handleMove)
      document.removeEventListener('mouseup', handleUp)
    }
    document.addEventListener('mousemove', handleMove)
    document.addEventListener('mouseup', handleUp)
  }, [width, onResize])

  return (
    <div className="shrink-0 flex" style={{ width }}>
      <div className="flex-1 overflow-y-auto bg-zinc-900/80 border-r border-zinc-800">
        <div className="px-3 py-2 text-[11px] text-zinc-500 font-medium uppercase tracking-wide border-b border-zinc-800">
          目录
        </div>
        <div className="py-1">
          {groups.map((group, gi) => {
            const isCollapsed = collapsed.has(gi)
            return (
              <div key={gi}>
                {group.header && (
                  <button
                    onClick={() => {
                      toggleGroup(gi)
                      onNavigate(group.header!.id)
                    }}
                    className="w-full flex items-center gap-1 px-2 py-1 text-[11px] text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/50 truncate font-medium"
                  >
                    {isCollapsed ? <ChevronRight size={10} className="shrink-0 text-zinc-600" /> : <ChevronDown size={10} className="shrink-0 text-zinc-600" />}
                    <span className="truncate">{group.header.text}</span>
                  </button>
                )}
                {!isCollapsed && group.children.map((entry, ci) => {
                  const turnUuid = entry.id.startsWith('turn-') ? entry.id.slice(5) : ''
                  const hasHL = highlightedTurnUuids?.has(turnUuid)
                  return (
                    <button
                      key={ci}
                      draggable={!!turnContentMap?.has(entry.id)}
                      onDragStart={(e) => {
                        const md = turnContentMap?.get(entry.id)
                        if (md) {
                          e.dataTransfer.setData('text/plain', md)
                          e.dataTransfer.effectAllowed = 'copy'
                        }
                      }}
                      onClick={() => onNavigate(entry.id)}
                      className="w-full flex items-center gap-1 text-left pl-6 pr-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30 truncate cursor-pointer"
                      title={entry.text}
                    >
                      {hasHL && <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />}
                      <span className="truncate">{entry.text}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
      <div
        onMouseDown={handleMouseDown}
        className="w-1 cursor-col-resize hover:bg-zinc-600/50 active:bg-zinc-500/50 shrink-0"
      />
    </div>
  )
}

// --- In-session search bar (floats top-right of content area) ---

function InSessionSearchBar({
  query, onQueryChange, matchCount, currentMatch, onNext, onPrev, onClose
}: {
  query: string; onQueryChange: (q: string) => void
  matchCount: number; currentMatch: number
  onNext: () => void; onPrev: () => void; onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onNext() }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); onPrev() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onNext, onPrev, onClose])

  return (
    <div className="absolute top-1 right-3 z-20 flex items-center gap-1.5 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl px-2.5 py-1.5">
      <Search size={13} className="text-zinc-500 shrink-0" />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="搜索..."
        className="w-48 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none"
      />
      {query && (
        <span className="text-[11px] text-zinc-400 shrink-0 tabular-nums min-w-[3em] text-center">
          {matchCount > 0 ? `${currentMatch + 1}/${matchCount}` : '0/0'}
        </span>
      )}
      <div className="flex items-center gap-0.5 ml-1">
        <button onClick={onPrev} disabled={matchCount === 0} className="p-1 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 disabled:opacity-20 disabled:hover:bg-transparent" title="上一个 (Shift+Enter)">
          <ArrowUp size={14} />
        </button>
        <button onClick={onNext} disabled={matchCount === 0} className="p-1 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 disabled:opacity-20 disabled:hover:bg-transparent" title="下一个 (Enter)">
          <ArrowDown size={14} />
        </button>
      </div>
      <button onClick={onClose} className="p-1 rounded hover:bg-zinc-600 text-zinc-400 hover:text-zinc-200 ml-0.5" title="关闭 (Esc)">
        <X size={14} />
      </button>
    </div>
  )
}

// --- Highlight search keywords using CSS Custom Highlight API ---
// Does NOT modify the DOM — works by telling the browser to paint ranges.
// Immune to React re-renders.

// Inject highlight styles once (in case CSS minifier strips ::highlight)
let _hlStyleInjected = false
function ensureHighlightStyles() {
  if (_hlStyleInjected) return
  _hlStyleInjected = true
  const style = document.createElement('style')
  style.textContent = `::highlight(swob-search) { background-color: rgba(245,158,11,0.35); color: inherit; } ::highlight(swob-search-current) { background-color: #f59e0b; color: #1c1917; } ::highlight(swob-annotation) { background-color: rgba(34,197,94,0.25); color: inherit; }`
  document.head.appendChild(style)
}

// useSearchHighlight is now integrated directly into ChatViewer's search effect

// --- Session action bar ---

function SessionBar({
  tocOpen,
  onToggleToc,
  sourceView,
  onToggleSource,
  mdMode,
  selectMode,
  onToggleSelectMode,
  searchOpen,
  onToggleSearch,
}: {
  tocOpen: boolean
  onToggleToc: () => void
  sourceView: boolean
  onToggleSource: () => void
  mdMode: boolean
  selectMode: boolean
  onToggleSelectMode: () => void
  searchOpen: boolean
  onToggleSearch: () => void
}) {
  const { selectedSession, viewMode, setViewMode, downloadSessionMarkdown, resumeSession, config } = useStore()
  const [copied, setCopied] = useState(false)

  const handleCopyMd = useCallback(() => {
    if (!selectedSession) return
    const customTitle = config?.sessionMeta?.[selectedSession.sessionId]?.customTitle
    const sections = computeSections(selectedSession)
    const md = sessionToMarkdown(selectedSession, sections, customTitle)
    navigator.clipboard.writeText(md)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [selectedSession, config])

  if (!selectedSession) return null

  return (
    <div className="h-9 flex items-center justify-between px-3 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
      <div className="flex items-center gap-2">
        <div className="flex items-center bg-zinc-800 rounded-md border border-zinc-700 overflow-hidden">
          {VIEW_MODES.map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-2.5 py-0.5 text-[11px] transition-colors ${
                viewMode === mode
                  ? 'bg-zinc-600 text-zinc-100 font-medium'
                  : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-700/50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          onClick={onToggleToc}
          className={`p-1 rounded transition-colors ${tocOpen ? 'text-zinc-200 bg-zinc-700' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
          title="目录"
        >
          <List size={13} />
        </button>

        <button
          onClick={onToggleSearch}
          className={`p-1 rounded transition-colors ${searchOpen ? 'text-zinc-200 bg-zinc-700' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
          title="对话内搜索 (Cmd+F)"
        >
          <Search size={13} />
        </button>

        {!mdMode && (
          <button
            onClick={onToggleSelectMode}
            className={`p-1 rounded transition-colors ${selectMode ? 'text-blue-300 bg-blue-800/50' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
            title="多选模式"
          >
            <CheckSquare size={13} />
          </button>
        )}

        {mdMode && (
          <button
            onClick={onToggleSource}
            className={`p-1 rounded transition-colors ${sourceView ? 'text-zinc-200 bg-zinc-700' : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'}`}
            title={sourceView ? '预览' : '源码'}
          >
            <Code2 size={13} />
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <button
          onClick={handleCopyMd}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
        >
          {copied ? <Check size={11} className="text-green-400" /> : <Copy size={11} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>

        <button
          onClick={downloadSessionMarkdown}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          title="下载 MD"
        >
          <Download size={13} />
        </button>

        {selectedSession.permissionMode === 'bypassPermissions' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-900/50 text-red-400 border border-red-800/50">
            skip-permissions
          </span>
        )}

        <button
          onClick={() => resumeSession(
            selectedSession.sessionId || selectedSession.id,
            selectedSession.permissionMode,
            selectedSession.cwds?.[0]
          )}
          className="px-2.5 py-0.5 text-[11px] rounded bg-green-700 hover:bg-green-600 text-white flex items-center gap-1"
        >
          <Play size={10} />
          Resume
        </button>
      </div>
    </div>
  )
}

// --- Helper: generate session header markdown ---

function sessionHeaderMd(session: SessionDetail, customTitle?: string): string {
  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId
  const created = new Date(session.createdAt).toLocaleString('zh-CN')
  const toolSummary = Object.entries(session.toolUsage)
    .sort(([, a], [, b]) => b - a).slice(0, 6)
    .map(([name, count]) => `${name}(${count})`).join(', ')
  const lines = [`# ${title}\n`]
  lines.push(`> ${created} | ${session.turnCount} 轮对话`)
  if (toolSummary) lines.push(`> Tools: ${toolSummary}`)
  lines.push('')
  return lines.join('\n')
}

// --- Source view: per-turn raw markdown with anchor divs ---

function SourceView({ session, sections, customTitle, contentRef }: {
  session: SessionDetail
  sections: CompactSection[]
  customTitle?: string
  contentRef: React.RefObject<HTMLDivElement | null>
}) {
  const headerMd = useMemo(() => sessionHeaderMd(session, customTitle), [session, customTitle])

  return (
    <div ref={contentRef} className="flex-1 overflow-y-auto">
      <div className="p-6 select-text">
        <pre className="text-[12px] font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed mb-2">{headerMd}</pre>
        {sections.map((section, sIdx) => {
          const sectionHeader = section.isCurrent && sections.length > 1
            ? '## 当前对话\n'
            : section.label ? `## ${section.label}\n` : ''
          const turns = groupIntoTurns(section.messages)
          return (
            <div key={sIdx}>
              {sectionHeader && (
                <div id={`section-${sIdx}`} className="scroll-mt-0">
                  <pre className="text-[12px] font-mono text-blue-400 font-bold whitespace-pre-wrap leading-relaxed">{sectionHeader}</pre>
                </div>
              )}
              {turns.map((turn, tIdx) => (
                <div
                  key={turn.userMsg?.uuid || tIdx}
                  id={turn.userMsg ? `turn-${turn.userMsg.uuid}` : undefined}
                  className="scroll-mt-0"
                >
                  <pre className="text-[12px] font-mono text-zinc-400 whitespace-pre-wrap leading-relaxed">{turnToMarkdown(turn)}</pre>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- Markdown document view: per-turn rendered with anchor divs ---

function MarkdownDocView({ session, sections, customTitle, contentRef }: {
  session: SessionDetail
  sections: CompactSection[]
  customTitle?: string
  contentRef: React.RefObject<HTMLDivElement | null>
}) {
  const headerMd = useMemo(() => sessionHeaderMd(session, customTitle), [session, customTitle])

  return (
    <div ref={contentRef} className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-6 select-text">
        <DocMarkdown content={headerMd} tocEntries={[]} />
        {sections.map((section, sIdx) => {
          const sectionHeader = section.isCurrent && sections.length > 1
            ? '## 当前对话'
            : section.label ? `## ${section.label}` : ''
          const turns = groupIntoTurns(section.messages)
          return (
            <div key={sIdx}>
              {sectionHeader && (
                <div id={`section-${sIdx}`} className="scroll-mt-0">
                  <DocMarkdown content={sectionHeader} tocEntries={[]} />
                </div>
              )}
              {turns.map((turn, tIdx) => (
                <div
                  key={turn.userMsg?.uuid || tIdx}
                  id={turn.userMsg ? `turn-${turn.userMsg.uuid}` : undefined}
                  className="scroll-mt-0"
                >
                  <DocMarkdown content={turnToMarkdown(turn)} tocEntries={[]} />
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// --- Main ChatViewer ---

export function ChatViewer() {
  const { selectedSession, viewMode, config, addHighlight, removeHighlight } = useStore()
  const contentRef = useRef<HTMLDivElement>(null)
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())
  const [tocOpen, setTocOpen] = useState(true)
  const [tocWidth, setTocWidth] = useState(200)
  const [sourceView, setSourceView] = useState(false)
  const pendingScrollRef = useRef<string | null>(null)
  const firstVisibleTurnRef = useRef<string | null>(null)

  const sections = useMemo<CompactSection[]>(() => {
    if (!selectedSession) return []
    return computeSections(selectedSession)
  }, [selectedSession])

  // Reset expanded sections on session change
  const sessionId = selectedSession?.id
  const prevSessionIdRef = useRef<string | null>(null)
  if (sessionId !== prevSessionIdRef.current) {
    prevSessionIdRef.current = sessionId ?? null
    if (expandedSections.size > 0) setExpandedSections(new Set())
  }

  const mdMode = viewMode === 'markdown'

  // Collect all turn UUIDs for scroll tracking
  const allTurnUuids = useMemo(() => {
    const uuids: string[] = []
    for (const section of sections) {
      const turns = groupIntoTurns(section.messages)
      for (const turn of turns) {
        if (turn.userMsg) uuids.push(turn.userMsg.uuid)
      }
    }
    return uuids
  }, [sections])

  // Track the first visible turn on scroll
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = () => {
      const containerTop = el.getBoundingClientRect().top
      for (const uuid of allTurnUuids) {
        const turnEl = el.querySelector(`#turn-${CSS.escape(uuid)}`)
        if (turnEl) {
          const rect = turnEl.getBoundingClientRect()
          if (rect.bottom > containerTop) {
            firstVisibleTurnRef.current = uuid
            return
          }
        }
      }
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  }, [allTurnUuids])

  // Map turn UUID → section index (for auto-expand in chat modes)
  const turnSectionMap = useMemo(() => {
    const map = new Map<string, number>()
    sections.forEach((section, sIdx) => {
      if (section.isCurrent) return
      const turns = groupIntoTurns(section.messages)
      turns.forEach(turn => {
        if (turn.userMsg) map.set(turn.userMsg.uuid, sIdx)
      })
    })
    return map
  }, [sections])

  // Restore scroll position after view mode switch — align to first visible turn
  const prevViewModeRef = useRef(viewMode)
  useEffect(() => {
    if (prevViewModeRef.current !== viewMode) {
      prevViewModeRef.current = viewMode
      const targetUuid = firstVisibleTurnRef.current
      if (!targetUuid) return

      // In chat modes, auto-expand collapsed section if target turn is inside one
      if (!mdMode) {
        const sIdx = turnSectionMap.get(targetUuid)
        if (sIdx !== undefined && !expandedSections.has(sIdx)) {
          setExpandedSections(prev => new Set([...prev, sIdx]))
          pendingScrollRef.current = `turn-${targetUuid}`
          return
        }
      }

      requestAnimationFrame(() => {
        setTimeout(() => {
          const el = contentRef.current?.querySelector(`#turn-${CSS.escape(targetUuid)}`)
          if (el) el.scrollIntoView({ block: 'start' })
        }, 0)
      })
    }
  }, [viewMode])

  const customTitle = useMemo(() => {
    if (!selectedSession || !config) return undefined
    return config.sessionMeta?.[selectedSession.sessionId]?.customTitle
  }, [selectedSession, config])

  // Unified TOC entries for all modes
  const tocEntries = useMemo(() => computeChatTocEntries(sections), [sections])

  // Multi-select: Q and A selectable independently
  // Items are "q:uuid" or "a:uuid"
  const [selectMode, setSelectMode] = useState(false)
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set())
  const toggleSelectQ = useCallback((uuid: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      const key = `q:${uuid}`
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])
  const toggleSelectA = useCallback((uuid: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev)
      const key = `a:${uuid}`
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }, [])
  const toggleSelectMode = useCallback(() => {
    setSelectMode(prev => {
      if (prev) setSelectedItems(new Set())
      return !prev
    })
  }, [])

  // --- In-session search ---
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMatchCount, setSearchMatchCount] = useState(0)
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0)
  const searchRangesRef = useRef<Range[]>([])
  const autoExpandedRef = useRef<Set<number>>(new Set()) // sections auto-expanded by search

  // Cmd+F to toggle search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        setSearchOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Compute highlight ranges + match count when query or content changes
  const highlightContentKey = `${viewMode}-${expandedSections.size}-${sections.length}`
  useEffect(() => {
    // @ts-expect-error CSS.highlights
    const highlights = CSS.highlights as Map<string, unknown> | undefined
    if (!highlights) return
    highlights.delete('swob-search')
    highlights.delete('swob-search-current')
    searchRangesRef.current = []

    const el = contentRef.current
    const q = (searchOpen ? searchQuery : '').trim().toLowerCase()
    if (!el || !q) {
      setSearchMatchCount(0)
      setCurrentMatchIdx(0)
      // Re-collapse auto-expanded sections when query is cleared
      if (autoExpandedRef.current.size > 0) {
        const toCollapse = autoExpandedRef.current
        setExpandedSections(prev => {
          const next = new Set(prev)
          for (const idx of toCollapse) next.delete(idx)
          return next
        })
        autoExpandedRef.current = new Set()
      }
      return
    }

    // Phase 1: Auto-expand collapsed sections that contain matches (data-level scan)
    // Also re-collapse previously auto-expanded sections that no longer match
    const nowNeeded = new Set<number>()
    const sectionsToExpand: number[] = []
    for (let sIdx = 0; sIdx < sections.length; sIdx++) {
      const section = sections[sIdx]
      if (section.isCurrent) continue
      const hasMatch = section.messages.some(m => {
        if (m.type !== 'user' && m.type !== 'assistant') return false
        return m.textContent.toLowerCase().includes(q)
      })
      if (hasMatch) {
        nowNeeded.add(sIdx)
        if (!expandedSections.has(sIdx)) sectionsToExpand.push(sIdx)
      }
    }
    // Re-collapse auto-expanded sections that no longer match
    const toCollapse: number[] = []
    for (const idx of autoExpandedRef.current) {
      if (!nowNeeded.has(idx)) toCollapse.push(idx)
    }
    if (sectionsToExpand.length > 0 || toCollapse.length > 0) {
      setExpandedSections(prev => {
        const next = new Set(prev)
        for (const idx of sectionsToExpand) next.add(idx)
        for (const idx of toCollapse) next.delete(idx)
        return next
      })
      // Update auto-expanded tracking: only sections we auto-expanded that are still needed
      const newAutoExpanded = new Set<number>()
      for (const idx of autoExpandedRef.current) {
        if (nowNeeded.has(idx)) newAutoExpanded.add(idx)
      }
      for (const idx of sectionsToExpand) newAutoExpanded.add(idx)
      autoExpandedRef.current = newAutoExpanded
      if (sectionsToExpand.length > 0) return // wait for re-render with newly expanded DOM
    }

    ensureHighlightStyles()

    // Phase 2: DOM-level TreeWalker to find all text matches
    const ranges: Range[] = []
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let textNode: Text | null
    while ((textNode = walker.nextNode() as Text | null)) {
      const text = textNode.textContent?.toLowerCase() || ''
      let idx = text.indexOf(q)
      while (idx !== -1) {
        const range = new Range()
        range.setStart(textNode, idx)
        range.setEnd(textNode, idx + q.length)
        ranges.push(range)
        idx = text.indexOf(q, idx + 1)
      }
    }

    searchRangesRef.current = ranges
    setSearchMatchCount(ranges.length)

    if (ranges.length > 0) {
      // @ts-expect-error Highlight constructor
      highlights.set('swob-search', new Highlight(...ranges))
      // @ts-expect-error Highlight constructor
      highlights.set('swob-search-current', new Highlight(ranges[0]))
      setCurrentMatchIdx(0)
      requestAnimationFrame(() => {
        const rect = ranges[0].getBoundingClientRect()
        const container = el
        const containerRect = container.getBoundingClientRect()
        container.scrollTop += rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2
      })
    } else {
      setCurrentMatchIdx(0)
    }
  }, [searchQuery, searchOpen, highlightContentKey, sections])

  // Navigate to Nth keyword match — scrolls the exact text range into center
  const navigateToMatch = useCallback((idx: number) => {
    const ranges = searchRangesRef.current
    if (ranges.length === 0) return
    const safeIdx = ((idx % ranges.length) + ranges.length) % ranges.length
    setCurrentMatchIdx(safeIdx)

    // Update the "current match" highlight
    // @ts-expect-error CSS.highlights
    const highlights = CSS.highlights as Map<string, unknown> | undefined
    if (highlights) {
      // @ts-expect-error Highlight constructor
      highlights.set('swob-search-current', new Highlight(ranges[safeIdx]))
    }

    // Scroll so the matched text is centered in the viewport
    const el = contentRef.current
    if (!el) return
    requestAnimationFrame(() => {
      const rect = ranges[safeIdx].getBoundingClientRect()
      const containerRect = el.getBoundingClientRect()
      el.scrollTop += rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2
    })
  }, [])

  const searchNext = useCallback(() => navigateToMatch(currentMatchIdx + 1), [navigateToMatch, currentMatchIdx])
  const searchPrev = useCallback(() => navigateToMatch(currentMatchIdx - 1), [navigateToMatch, currentMatchIdx])
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchQuery('')
    // @ts-expect-error CSS.highlights
    const highlights = CSS.highlights as Map<string, unknown> | undefined
    if (highlights) { highlights.delete('swob-search'); highlights.delete('swob-search-current') }
    // Re-collapse sections that were auto-expanded by search
    if (autoExpandedRef.current.size > 0) {
      const toCollapse = autoExpandedRef.current
      setExpandedSections(prev => {
        const next = new Set(prev)
        for (const idx of toCollapse) next.delete(idx)
        return next
      })
      autoExpandedRef.current = new Set()
    }
  }, [])

  // --- Highlight / annotation system ---
  const highlights: Highlight[] = useMemo(() => {
    if (!selectedSession || !config) return []
    return config.sessionMeta?.[selectedSession.sessionId]?.highlights || []
  }, [selectedSession, config])

  // Track which turn UUIDs have highlights (for TOC markers)
  const highlightedTurnUuids = useMemo(() => new Set(highlights.map(h => h.turnUuid)), [highlights])

  // Floating selection toolbar
  const [selectionRect, setSelectionRect] = useState<{ top: number; left: number } | null>(null)
  const [pendingHighlight, setPendingHighlight] = useState<{ text: string; turnUuid: string } | null>(null)
  const annotationRangesRef = useRef<Map<string, Range>>(new Map())

  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = () => {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !el.contains(sel.anchorNode)) {
        setSelectionRect(null)
        setPendingHighlight(null)
        return
      }
      const text = sel.toString().trim()
      if (!text || text.length > 2000) { setSelectionRect(null); return }
      // Find turn UUID by walking up from anchor node
      let node: Node | null = sel.anchorNode
      let turnUuid: string | null = null
      while (node && node !== el) {
        if (node instanceof HTMLElement && node.id?.startsWith('turn-')) {
          turnUuid = node.id.slice(5)
          break
        }
        node = node.parentNode
      }
      if (!turnUuid) { setSelectionRect(null); return }
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      const containerRect = el.getBoundingClientRect()
      setSelectionRect({
        top: rect.top - containerRect.top + el.scrollTop - 36,
        left: rect.left - containerRect.left + rect.width / 2 - 16
      })
      setPendingHighlight({ text, turnUuid })
    }
    el.addEventListener('mouseup', handler)
    return () => el.removeEventListener('mouseup', handler)
  }, [])

  const handleAddHighlight = useCallback(() => {
    if (!pendingHighlight || !selectedSession) return
    addHighlight(selectedSession.sessionId, pendingHighlight)
    setSelectionRect(null)
    setPendingHighlight(null)
    window.getSelection()?.removeAllRanges()
  }, [pendingHighlight, selectedSession, addHighlight])

  // Render persistent annotation highlights via CSS Custom Highlight API
  const annotationContentKey = `${viewMode}-${expandedSections.size}-${highlights.length}`
  useEffect(() => {
    // @ts-expect-error CSS.highlights
    const cssHL = CSS.highlights as Map<string, unknown> | undefined
    if (!cssHL) return
    cssHL.delete('swob-annotation')
    annotationRangesRef.current.clear()
    const el = contentRef.current
    if (!el || highlights.length === 0) return
    ensureHighlightStyles()

    const ranges: Range[] = []
    for (const hl of highlights) {
      const turnEl = el.querySelector(`#turn-${CSS.escape(hl.turnUuid)}`)
      if (!turnEl) continue
      const q = hl.text.toLowerCase()
      const walker = document.createTreeWalker(turnEl, NodeFilter.SHOW_TEXT)
      let textNode: Text | null
      let found = false
      while ((textNode = walker.nextNode() as Text | null)) {
        const nodeText = textNode.textContent?.toLowerCase() || ''
        const idx = nodeText.indexOf(q)
        if (idx !== -1) {
          const range = new Range()
          range.setStart(textNode, idx)
          range.setEnd(textNode, Math.min(idx + hl.text.length, textNode.textContent!.length))
          ranges.push(range)
          annotationRangesRef.current.set(hl.id, range)
          found = true
          break
        }
      }
      // If exact match not found, try matching first N chars (text might have been truncated)
      if (!found && q.length > 20) {
        const shortQ = q.slice(0, 20)
        const walker2 = document.createTreeWalker(turnEl, NodeFilter.SHOW_TEXT)
        while ((textNode = walker2.nextNode() as Text | null)) {
          const nodeText = textNode.textContent?.toLowerCase() || ''
          const idx = nodeText.indexOf(shortQ)
          if (idx !== -1) {
            const range = new Range()
            range.setStart(textNode, idx)
            range.setEnd(textNode, Math.min(idx + hl.text.length, textNode.textContent!.length))
            ranges.push(range)
            annotationRangesRef.current.set(hl.id, range)
            break
          }
        }
      }
    }

    if (ranges.length > 0) {
      // @ts-expect-error Highlight constructor
      cssHL.set('swob-annotation', new Highlight(...ranges))
    }
  }, [highlights, annotationContentKey])

  // Navigate to a specific annotation highlight
  const scrollToAnnotation = useCallback((highlightId: string) => {
    const range = annotationRangesRef.current.get(highlightId)
    const el = contentRef.current
    if (!range || !el) return
    requestAnimationFrame(() => {
      try {
        const rect = range.getBoundingClientRect()
        const containerRect = el.getBoundingClientRect()
        el.scrollTop += rect.top - containerRect.top - containerRect.height / 2 + rect.height / 2
      } catch { /* range may be detached */ }
    })
  }, [])

  // Listen for highlight navigation events from InfoPanel
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent).detail?.highlightId
      if (id) scrollToAnnotation(id)
    }
    window.addEventListener('swob:scrollToHighlight', handler)
    return () => window.removeEventListener('swob:scrollToHighlight', handler)
  }, [scrollToAnnotation])

  // Build turn content map for TOC drag (turn UUID → markdown)
  const turnContentMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const section of sections) {
      const turns = groupIntoTurns(section.messages)
      for (const turn of turns) {
        if (turn.userMsg) {
          map.set(`turn-${turn.userMsg.uuid}`, turnToMarkdown(turn))
        }
      }
    }
    return map
  }, [sections])

  // Build all turns flat list for batch export
  const allTurns = useMemo(() => {
    const result: Turn[] = []
    for (const section of sections) {
      result.push(...groupIntoTurns(section.messages))
    }
    return result
  }, [sections])

  const selectedCount = selectedItems.size

  const handleBatchExport = useCallback(() => {
    if (selectedItems.size === 0) return
    const lines: string[] = []
    for (const turn of allTurns) {
      if (!turn.userMsg) continue
      const uuid = turn.userMsg.uuid
      const qSel = selectedItems.has(`q:${uuid}`)
      const aSel = selectedItems.has(`a:${uuid}`)
      if (qSel && aSel) {
        lines.push(turnToMarkdown(turn))
      } else if (qSel) {
        lines.push(`### User\n\n${turn.userMsg.textContent}\n`)
      } else if (aSel) {
        lines.push(turnToMarkdown({ userMsg: null, assistantMsgs: turn.assistantMsgs }))
      }
    }
    navigator.clipboard.writeText(lines.join('\n'))
  }, [selectedItems, allTurns])

  const handleBatchDownload = useCallback(() => {
    if (selectedItems.size === 0 || !selectedSession) return
    const lines: string[] = []
    for (const turn of allTurns) {
      if (!turn.userMsg) continue
      const uuid = turn.userMsg.uuid
      const qSel = selectedItems.has(`q:${uuid}`)
      const aSel = selectedItems.has(`a:${uuid}`)
      if (qSel && aSel) {
        lines.push(turnToMarkdown(turn))
      } else if (qSel) {
        lines.push(`### User\n\n${turn.userMsg.textContent}\n`)
      } else if (aSel) {
        lines.push(turnToMarkdown({ userMsg: null, assistantMsgs: turn.assistantMsgs }))
      }
    }
    const md = lines.join('\n')
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const date = new Date().toISOString().slice(0, 10)
    a.download = `selected-turns-${date}.md`
    a.click()
    URL.revokeObjectURL(url)
  }, [selectedItems, allTurns, selectedSession])

  // Scroll to pending target after section expansion
  useEffect(() => {
    if (pendingScrollRef.current) {
      const id = pendingScrollRef.current
      pendingScrollRef.current = null
      requestAnimationFrame(() => {
        const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`)
        el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  })

  const handleNavigate = useCallback((id: string) => {
    if (!mdMode) {
      if (id.startsWith('turn-')) {
        const uuid = id.slice(5)
        const sIdx = turnSectionMap.get(uuid)
        if (sIdx !== undefined && !expandedSections.has(sIdx)) {
          setExpandedSections(prev => new Set([...prev, sIdx]))
          pendingScrollRef.current = id
          return
        }
      }
      if (id.startsWith('section-')) {
        const sIdx = parseInt(id.slice(8))
        if (!isNaN(sIdx) && !sections[sIdx]?.isCurrent && !expandedSections.has(sIdx)) {
          setExpandedSections(prev => new Set([...prev, sIdx]))
          pendingScrollRef.current = id
          return
        }
      }
    }
    const el = contentRef.current?.querySelector(`#${CSS.escape(id)}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [mdMode, turnSectionMap, expandedSections, sections])

  if (!selectedSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <div className="text-center">
          <div className="text-4xl mb-3">💬</div>
          <div className="text-zinc-400">选择一个 Session 查看对话</div>
        </div>
      </div>
    )
  }

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  function renderSection(section: CompactSection) {
    const turns = groupIntoTurns(section.messages)
    return turns.map((turn, tIdx) => (
      <TurnBlock
        key={turn.userMsg?.uuid || turn.assistantMsgs[0]?.uuid || tIdx}
        turn={turn}
        viewMode={viewMode as 'compact' | 'full'}
        qSelected={turn.userMsg ? selectedItems.has(`q:${turn.userMsg.uuid}`) : false}
        aSelected={turn.userMsg ? selectedItems.has(`a:${turn.userMsg.uuid}`) : false}
        selectMode={selectMode}
        onSelectQ={toggleSelectQ}
        onSelectA={toggleSelectA}
      />
    ))
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <SessionBar
        tocOpen={tocOpen}
        onToggleToc={() => setTocOpen(!tocOpen)}
        sourceView={sourceView}
        onToggleSource={() => setSourceView(!sourceView)}
        mdMode={mdMode}
        selectMode={selectMode}
        onToggleSelectMode={toggleSelectMode}
        searchOpen={searchOpen}
        onToggleSearch={() => setSearchOpen(prev => !prev)}
      />

      <div className="flex-1 flex min-h-0">
        {tocOpen && tocEntries.length > 0 && (
          <TocSidebar
            entries={tocEntries}
            onNavigate={handleNavigate}
            width={tocWidth}
            onResize={setTocWidth}
            turnContentMap={turnContentMap}
            highlightedTurnUuids={highlightedTurnUuids}
          />
        )}

        {/* Content area wrapper — search bar & batch bar are inside here, not spanning TOC */}
        <div className="flex-1 flex flex-col min-w-0 relative">
          {searchOpen && (
            <InSessionSearchBar
              query={searchQuery}
              onQueryChange={setSearchQuery}
              matchCount={searchMatchCount}
              currentMatch={currentMatchIdx}
              onNext={searchNext}
              onPrev={searchPrev}
              onClose={closeSearch}
            />
          )}

          {/* Batch action bar */}
          {selectMode && selectedCount > 0 && !mdMode && (
            <div className="h-8 flex items-center gap-2 px-3 bg-blue-950/50 border-b border-blue-800/40 shrink-0">
              <span className="text-[11px] text-blue-400">已选 {selectedCount} 项</span>
              <button onClick={handleBatchExport} className="px-2 py-0.5 text-[10px] rounded bg-blue-800/50 text-blue-300 hover:bg-blue-700/50 flex items-center gap-1">
                <Copy size={10} /> 复制
              </button>
              <button onClick={handleBatchDownload} className="px-2 py-0.5 text-[10px] rounded bg-blue-800/50 text-blue-300 hover:bg-blue-700/50 flex items-center gap-1">
                <Download size={10} /> 下载 MD
              </button>
              <button onClick={() => { setSelectedItems(new Set()); setSelectMode(false) }} className="px-2 py-0.5 text-[10px] rounded text-zinc-500 hover:text-zinc-300">
                取消
              </button>
            </div>
          )}

          {mdMode ? (
            sourceView ? (
              <SourceView session={selectedSession} sections={sections} customTitle={customTitle} contentRef={contentRef} />
            ) : (
              <MarkdownDocView session={selectedSession} sections={sections} customTitle={customTitle} contentRef={contentRef} />
            )
          ) : (
            <div ref={contentRef} className="flex-1 overflow-y-auto px-4 pb-4 space-y-4">
            {sections.map((section, sIdx) => {
              if (section.isCurrent) {
                return (
                  <div key={`section-${sIdx}`} id={`section-${sIdx}`} className="space-y-4 scroll-mt-0">
                    {sections.length > 1 && (
                      <div className="sticky top-0 z-10 flex items-center gap-3 py-2 bg-zinc-900/95 backdrop-blur-sm -mx-4 px-4">
                        <div className="flex-1 border-t border-emerald-600/50" />
                        <span className="text-emerald-500 text-xs px-3 py-1 bg-emerald-900/20 rounded-full">当前对话</span>
                        <div className="flex-1 border-t border-emerald-600/50" />
                      </div>
                    )}
                    {renderSection(section)}
                  </div>
                )
              }

              const isExpanded = expandedSections.has(sIdx)
              const isShared = section.isSharedContext
              const borderColor = isShared ? 'border-purple-600/30' : 'border-amber-600/30'
              const textColor = isShared ? 'text-purple-400/70' : 'text-amber-500/70'
              const bgColor = isShared ? 'bg-purple-900/10 hover:bg-purple-900/20' : 'bg-amber-900/10 hover:bg-amber-900/20'
              const borderLColor = isShared ? 'border-purple-600/20' : 'border-amber-600/20'
              const SectionIcon = isShared ? GitBranch : History

              return (
                <div key={`section-${sIdx}`} id={`section-${sIdx}`} className="scroll-mt-0">
                  <button
                    onClick={() => toggleSection(sIdx)}
                    className="w-full flex items-center gap-3 py-2 group sticky top-0 z-10 bg-zinc-900/95 backdrop-blur-sm -mx-4 px-4"
                  >
                    <div className={`flex-1 border-t ${borderColor}`} />
                    <div className={`flex items-center gap-2 ${textColor} text-xs px-3 py-1 ${bgColor} rounded-full transition-colors`}>
                      {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <SectionIcon size={12} />
                      <span>{section.label}</span>
                    </div>
                    <div className={`flex-1 border-t ${borderColor}`} />
                  </button>
                  {isExpanded && (
                    <div className={`space-y-3 pl-2 border-l-2 ${borderLColor} ml-2`}>
                      {renderSection(section)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
          {/* Floating highlight button — appears on text selection */}
          {selectionRect && pendingHighlight && (
            <div
              className="absolute z-30 pointer-events-none"
              style={{ top: selectionRect.top, left: Math.max(8, selectionRect.left) }}
            >
              <button
                onMouseDown={(e) => { e.preventDefault(); e.stopPropagation() }}
                onClick={handleAddHighlight}
                className="pointer-events-auto flex items-center gap-1 px-2 py-1 bg-green-700 hover:bg-green-600 text-white text-xs rounded-md shadow-lg transition-colors"
                title="划线收藏"
              >
                <Highlighter size={12} />
                <span>划线</span>
              </button>
            </div>
          )}
        </div>{/* end content area wrapper */}
      </div>
    </div>
  )
}
