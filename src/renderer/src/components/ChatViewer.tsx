import { useRef, useState, useMemo, useCallback, useEffect } from 'react'
import { useStore } from '../store'
import type { ViewMode, ParsedMessage, SessionDetail } from '../store'
import {
  User, Bot, Terminal, ChevronDown, ChevronRight,
  History, GitBranch, Copy, Check, Download, Play,
  List, Code2
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

function TurnBlock({ turn, viewMode, faded }: { turn: Turn; viewMode: 'compact' | 'full'; faded: boolean }) {
  const segments = useMemo(() => buildSegments(turn.assistantMsgs), [turn.assistantMsgs])
  const hasSidechain = turn.assistantMsgs.some((m) => m.isSidechain)
  const turnId = turn.userMsg ? `turn-${turn.userMsg.uuid}` : undefined

  return (
    <div id={turnId} className={`space-y-3 scroll-mt-12 ${faded ? 'opacity-50' : ''}`}>
      {turn.userMsg && (
        <div className={`flex gap-3 ${turn.userMsg.isSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-blue-600"><User size={14} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-zinc-400">User</span>
              <span className="text-[11px] text-zinc-600">{formatTime(turn.userMsg.timestamp)}</span>
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
      )}
      {segments.length > 0 && (
        <div className={`flex gap-3 ${hasSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-orange-600"><Bot size={14} /></div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-zinc-400">Assistant</span>
              <span className="text-[11px] text-zinc-600">{formatTime(turn.assistantMsgs[0].timestamp)}</span>
              {hasSidechain && <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-500">rejected</span>}
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

function TocSidebar({ entries, onNavigate, width, onResize }: {
  entries: TocEntry[]
  onNavigate: (id: string) => void
  width: number
  onResize: (w: number) => void
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
                {!isCollapsed && group.children.map((entry, ci) => (
                  <button
                    key={ci}
                    onClick={() => onNavigate(entry.id)}
                    className="w-full text-left pl-6 pr-2 py-0.5 text-[11px] text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/30 truncate"
                    title={entry.text}
                  >
                    {entry.text}
                  </button>
                ))}
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

// --- Session action bar ---

function SessionBar({
  tocOpen,
  onToggleToc,
  sourceView,
  onToggleSource,
  mdMode,
}: {
  tocOpen: boolean
  onToggleToc: () => void
  sourceView: boolean
  onToggleSource: () => void
  mdMode: boolean
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
                <div id={`section-${sIdx}`} className="scroll-mt-12">
                  <pre className="text-[12px] font-mono text-blue-400 font-bold whitespace-pre-wrap leading-relaxed">{sectionHeader}</pre>
                </div>
              )}
              {turns.map((turn, tIdx) => (
                <div
                  key={turn.userMsg?.uuid || tIdx}
                  id={turn.userMsg ? `turn-${turn.userMsg.uuid}` : undefined}
                  className="scroll-mt-12"
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
                <div id={`section-${sIdx}`} className="scroll-mt-12">
                  <DocMarkdown content={sectionHeader} tocEntries={[]} />
                </div>
              )}
              {turns.map((turn, tIdx) => (
                <div
                  key={turn.userMsg?.uuid || tIdx}
                  id={turn.userMsg ? `turn-${turn.userMsg.uuid}` : undefined}
                  className="scroll-mt-12"
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
  const { selectedSession, viewMode, config } = useStore()
  const contentRef = useRef<HTMLDivElement>(null)
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())
  const [tocOpen, setTocOpen] = useState(true)
  const [tocWidth, setTocWidth] = useState(200)
  const [sourceView, setSourceView] = useState(false)
  const pendingScrollRef = useRef<string | null>(null)
  const scrollRatioRef = useRef<number>(0)

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

  // Track scroll position as ratio for preserving across view mode switches
  useEffect(() => {
    const el = contentRef.current
    if (!el) return
    const handler = () => {
      const maxScroll = el.scrollHeight - el.clientHeight
      scrollRatioRef.current = maxScroll > 0 ? el.scrollTop / maxScroll : 0
    }
    el.addEventListener('scroll', handler, { passive: true })
    return () => el.removeEventListener('scroll', handler)
  })

  // Restore scroll position after view mode switch
  const prevViewModeRef = useRef(viewMode)
  useEffect(() => {
    if (prevViewModeRef.current !== viewMode) {
      prevViewModeRef.current = viewMode
      requestAnimationFrame(() => {
        const el = contentRef.current
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = scrollRatioRef.current * (el.scrollHeight - el.clientHeight)
        }
      })
    }
  }, [viewMode])

  const customTitle = useMemo(() => {
    if (!selectedSession || !config) return undefined
    return config.sessionMeta?.[selectedSession.sessionId]?.customTitle
  }, [selectedSession, config])

  // Unified TOC entries for all modes
  const tocEntries = useMemo(() => computeChatTocEntries(sections), [sections])

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
    // In chat modes, auto-expand collapsed sections if needed
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
    // Direct scroll
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

  function renderSection(section: CompactSection, faded: boolean) {
    const turns = groupIntoTurns(section.messages)
    return turns.map((turn, tIdx) => (
      <TurnBlock
        key={turn.userMsg?.uuid || turn.assistantMsgs[0]?.uuid || tIdx}
        turn={turn}
        viewMode={viewMode as 'compact' | 'full'}
        faded={faded}
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
      />
      <div className="flex-1 flex min-h-0">
        {tocOpen && tocEntries.length > 0 && (
          <TocSidebar
            entries={tocEntries}
            onNavigate={handleNavigate}
            width={tocWidth}
            onResize={setTocWidth}
          />
        )}

        {mdMode ? (
          sourceView ? (
            <SourceView session={selectedSession} sections={sections} customTitle={customTitle} contentRef={contentRef} />
          ) : (
            <MarkdownDocView session={selectedSession} sections={sections} customTitle={customTitle} contentRef={contentRef} />
          )
        ) : (
          <div ref={contentRef} className="flex-1 overflow-y-auto p-4 space-y-4">
            {sections.map((section, sIdx) => {
              if (section.isCurrent) {
                return (
                  <div key={`section-${sIdx}`} id={`section-${sIdx}`} className="space-y-4 scroll-mt-12">
                    {sections.length > 1 && (
                      <div className="flex items-center gap-3 py-2">
                        <div className="flex-1 border-t border-emerald-600/50" />
                        <span className="text-emerald-500 text-xs px-3 py-1 bg-emerald-900/20 rounded-full">当前对话</span>
                        <div className="flex-1 border-t border-emerald-600/50" />
                      </div>
                    )}
                    {renderSection(section, false)}
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
                <div key={`section-${sIdx}`} id={`section-${sIdx}`} className="scroll-mt-12">
                  <button onClick={() => toggleSection(sIdx)} className="w-full flex items-center gap-3 py-2 group">
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
                      {renderSection(section, true)}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
