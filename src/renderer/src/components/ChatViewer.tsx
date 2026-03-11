import { useRef, useState, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import type { ParsedMessage } from '../store'
import { User, Bot, Terminal, ChevronDown, ChevronRight, History, GitBranch, Copy, Check } from 'lucide-react'
import { CliMarkdown, DocMarkdown } from './MarkdownContent'
import {
  computeSections,
  groupIntoTurns,
  buildSegments,
  sessionToMarkdown,
  COMPACT_SUMMARY_PREFIX
} from '../utils/markdown'
import type { CompactSection, Turn, ToolCallInfo } from '../utils/markdown'

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
        {expanded
          ? <ChevronDown size={11} className="text-zinc-500 shrink-0" />
          : <ChevronRight size={11} className="text-zinc-500 shrink-0" />}
        <Terminal size={11} className="text-zinc-500 shrink-0" />
        <div className="flex items-center gap-1 flex-wrap">
          {[...grouped.entries()].map(([name, count]) => (
            <span
              key={name}
              className={`text-[10px] px-1.5 py-0.5 rounded-full border font-mono ${TOOL_COLORS[name] || DEFAULT_TOOL_COLOR}`}
            >
              {name}{count > 1 ? ` ×${count}` : ''}
            </span>
          ))}
        </div>
      </button>
      {expanded && (
        <div className="mt-1 ml-5 space-y-1.5">
          {toolCalls.map((tc, i) => (
            <ToolCallExpanded key={i} tc={tc} />
          ))}
        </div>
      )}
    </div>
  )
}

// --- Expanded tool call detail ---

function ToolCallExpanded({ tc }: { tc: ToolCallInfo }) {
  const [showResult, setShowResult] = useState(false)
  const color = TOOL_COLORS[tc.name] || DEFAULT_TOOL_COLOR
  const preview = getToolPreview(tc.name, tc.input)

  return (
    <div className="border border-zinc-700/50 rounded-md bg-zinc-800/30">
      <div className="px-2.5 py-1.5 flex items-center gap-2 text-xs">
        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-mono shrink-0 ${color}`}>{tc.name}</span>
        {preview && <span className="truncate text-zinc-500 text-[11px] font-mono">{preview}</span>}
      </div>
      <pre className="px-3 py-2 text-[11px] text-zinc-400 overflow-x-auto border-t border-zinc-700/50 max-h-40 overflow-y-auto font-mono">
        {JSON.stringify(tc.input, null, 2)}
      </pre>
      {tc.result && (
        <>
          <button
            onClick={() => setShowResult(!showResult)}
            className="w-full px-3 py-1 text-[11px] text-zinc-500 hover:text-zinc-400 border-t border-zinc-700/50 flex items-center gap-1"
          >
            {showResult ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Result ({tc.result.length > 200 ? `${Math.round(tc.result.length / 1024)}KB` : `${tc.result.length} chars`})
          </button>
          {showResult && (
            <pre className="px-3 py-2 text-[11px] text-zinc-500 overflow-x-auto border-t border-zinc-700/30 max-h-48 overflow-y-auto font-mono bg-zinc-900/30">
              {tc.result}
            </pre>
          )}
        </>
      )}
    </div>
  )
}

// --- Full mode: scrollable code blocks ---

function ToolCallFull({ tc }: { tc: ToolCallInfo }) {
  const color = TOOL_COLORS[tc.name] || DEFAULT_TOOL_COLOR
  const preview = getToolPreview(tc.name, tc.input)

  let inputDisplay: string
  if (tc.name === 'Bash' && tc.input.command) {
    inputDisplay = String(tc.input.command)
  } else if ((tc.name === 'Edit') && tc.input.old_string) {
    inputDisplay = `File: ${tc.input.file_path || ''}\n\n--- old ---\n${tc.input.old_string}\n\n+++ new +++\n${tc.input.new_string || ''}`
  } else if (tc.name === 'Write' && tc.input.content) {
    inputDisplay = `File: ${tc.input.file_path || ''}\n\n${String(tc.input.content).slice(0, 2000)}`
  } else if (tc.name === 'Read' && tc.input.file_path) {
    inputDisplay = String(tc.input.file_path)
  } else {
    inputDisplay = JSON.stringify(tc.input, null, 2)
  }

  return (
    <div className="my-1.5 border border-zinc-700/50 rounded-md bg-zinc-850/30 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-2 bg-zinc-800/60 border-b border-zinc-700/40">
        <span className={`px-1.5 py-0.5 rounded-full border text-[10px] font-mono shrink-0 ${color}`}>{tc.name}</span>
        {preview && <span className="truncate text-zinc-500 text-[11px] font-mono">{preview}</span>}
      </div>
      <pre className="px-3 py-2 text-[11px] text-zinc-400 overflow-x-auto max-h-48 overflow-y-auto font-mono">
        {inputDisplay}
      </pre>
      {tc.result && (
        <>
          <div className="px-2.5 py-1 text-[10px] text-zinc-500 bg-zinc-800/40 border-t border-zinc-700/40 font-medium">
            Result
          </div>
          <pre className="px-3 py-2 text-[11px] text-zinc-500 overflow-x-auto max-h-48 overflow-y-auto font-mono bg-zinc-900/30">
            {tc.result}
          </pre>
        </>
      )}
    </div>
  )
}

// --- Turn block component ---

function TurnBlock({
  turn, viewMode, faded
}: {
  turn: Turn
  viewMode: 'compact' | 'full'
  faded: boolean
}) {
  const segments = useMemo(() => buildSegments(turn.assistantMsgs), [turn.assistantMsgs])
  const hasSidechain = turn.assistantMsgs.some((m) => m.isSidechain)

  return (
    <div className={`space-y-3 ${faded ? 'opacity-50' : ''}`}>
      {/* User message */}
      {turn.userMsg && (
        <div className={`flex gap-3 ${turn.userMsg.isSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-blue-600">
            <User size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-zinc-400">User</span>
              <span className="text-[11px] text-zinc-600">{formatTime(turn.userMsg.timestamp)}</span>
            </div>
            {(() => {
              const isCompactSummary = turn.userMsg!.textContent.startsWith(COMPACT_SUMMARY_PREFIX)
              if (isCompactSummary) {
                const summary = turn.userMsg!.textContent.slice(COMPACT_SUMMARY_PREFIX.length).trim()
                return (
                  <div className="text-sm text-zinc-200 border-l-2 border-amber-600/50 pl-3">
                    <div className="text-[10px] text-amber-500 mb-1 font-medium">Compact 上下文摘要</div>
                    <div className="whitespace-pre-wrap break-words leading-relaxed max-h-48 overflow-y-auto">
                      {summary}
                    </div>
                  </div>
                )
              }
              return (
                <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                  {turn.userMsg!.textContent}
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* Assistant response (merged) */}
      {segments.length > 0 && (
        <div className={`flex gap-3 ${hasSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
          <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-orange-600">
            <Bot size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-zinc-400">Assistant</span>
              <span className="text-[11px] text-zinc-600">
                {formatTime(turn.assistantMsgs[0].timestamp)}
              </span>
              {hasSidechain && (
                <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-500">rejected</span>
              )}
            </div>
            {segments.map((seg, i) => (
              <div key={i}>
                {seg.type === 'text' && (
                  <CliMarkdown content={seg.text!} />
                )}
                {seg.type === 'tools' && (
                  viewMode === 'compact'
                    ? <ToolCallPillBar toolCalls={seg.toolCalls!} />
                    : (
                      <div className="space-y-1.5 my-1.5">
                        {seg.toolCalls!.map((tc, j) => (
                          <ToolCallFull key={j} tc={tc} />
                        ))}
                      </div>
                    )
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// --- Markdown document view ---

function MarkdownView({ session, sections }: { session: NonNullable<ReturnType<typeof useStore>['selectedSession']>; sections: CompactSection[] }) {
  const [copied, setCopied] = useState(false)

  const markdownContent = useMemo(
    () => sessionToMarkdown(session, sections),
    [session, sections]
  )

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(markdownContent)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [markdownContent])

  return (
    <div className="flex-1 overflow-y-auto">
      {/* Sticky toolbar */}
      <div className="sticky top-0 z-10 flex items-center justify-end gap-2 px-6 py-2 bg-zinc-900/90 backdrop-blur-sm border-b border-zinc-800">
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
        >
          {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
          <span>{copied ? '已复制' : '复制 MD'}</span>
        </button>
      </div>

      {/* Rendered markdown document */}
      <div className="max-w-3xl mx-auto px-8 py-6 select-text">
        <DocMarkdown content={markdownContent} />
      </div>
    </div>
  )
}

// --- Main ChatViewer ---

export function ChatViewer() {
  const { selectedSession, viewMode, searchQuery } = useStore()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())

  const sections = useMemo<CompactSection[]>(() => {
    if (!selectedSession) return []
    return computeSections(selectedSession)
  }, [selectedSession])

  const sessionId = selectedSession?.id
  const prevSessionIdRef = useRef<string | null>(null)
  if (sessionId !== prevSessionIdRef.current) {
    prevSessionIdRef.current = sessionId ?? null
    if (expandedSections.size > 0) setExpandedSections(new Set())
  }

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

  // Markdown mode: render full document
  if (viewMode === 'markdown') {
    return <MarkdownView session={selectedSession} sections={sections} />
  }

  // Compact / Full modes
  function highlightText(text: string): React.ReactNode {
    if (!searchQuery) return text
    try {
      const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      const parts = text.split(regex)
      return parts.map((part, i) => {
        const isMatch = new RegExp(`^${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(part)
        return isMatch ? (
          <mark key={i} className="bg-yellow-500/40 text-yellow-200 rounded px-0.5">{part}</mark>
        ) : part
      })
    } catch { return text }
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
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {sections.map((section, sIdx) => {
        if (section.isCurrent) {
          return (
            <div key={`section-${sIdx}`} className="space-y-4">
              {sections.length > 1 && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex-1 border-t border-emerald-600/50" />
                  <span className="text-emerald-500 text-xs px-3 py-1 bg-emerald-900/20 rounded-full">
                    当前对话
                  </span>
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
          <div key={`section-${sIdx}`}>
            <button
              onClick={() => toggleSection(sIdx)}
              className="w-full flex items-center gap-3 py-2 group"
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
                {renderSection(section, true)}
              </div>
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
