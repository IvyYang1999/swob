import { useRef, useState, useMemo, useCallback } from 'react'
import { useStore } from '../store'
import { User, Bot, Terminal, ChevronDown, ChevronRight, History, GitBranch, Download } from 'lucide-react'
import type { ParsedMessage } from '../store'

type ToolCallInfo = { id?: string; name: string; input: Record<string, unknown>; result?: string }

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

// --- Compact mode: Pill bar (summary line, click to expand details) ---

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

// --- Expanded tool call (used in compact mode when pill bar is expanded) ---

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

// --- Full mode: scrollable code blocks, always visible ---

function ToolCallFull({ tc }: { tc: ToolCallInfo }) {
  const color = TOOL_COLORS[tc.name] || DEFAULT_TOOL_COLOR
  const preview = getToolPreview(tc.name, tc.input)

  // Format input nicely based on tool type
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

// --- Turn grouping ---

interface Turn {
  userMsg: ParsedMessage | null
  assistantMsgs: ParsedMessage[]
}

interface Segment {
  type: 'text' | 'tools'
  text?: string
  toolCalls?: ToolCallInfo[]
  isSidechain?: boolean
}

function groupIntoTurns(messages: ParsedMessage[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const msg of messages) {
    if (msg.type === 'system') continue
    const hasText = msg.textContent.trim().length > 0
    const hasTools = msg.toolCalls.length > 0

    if (msg.type === 'user') {
      if (!hasText) continue
      if (current) turns.push(current)
      current = { userMsg: msg, assistantMsgs: [] }
    } else if (msg.type === 'assistant') {
      if (!hasText && !hasTools) continue
      if (!current) current = { userMsg: null, assistantMsgs: [] }
      current.assistantMsgs.push(msg)
    }
  }
  if (current) turns.push(current)
  return turns
}

function buildSegments(msgs: ParsedMessage[]): Segment[] {
  const segments: Segment[] = []
  for (const msg of msgs) {
    const hasText = msg.textContent.trim().length > 0
    const hasTools = msg.toolCalls.length > 0
    if (hasText) {
      segments.push({ type: 'text', text: msg.textContent, isSidechain: msg.isSidechain })
    }
    if (hasTools) {
      const prev = segments[segments.length - 1]
      if (prev && prev.type === 'tools') {
        prev.toolCalls!.push(...msg.toolCalls)
      } else {
        segments.push({ type: 'tools', toolCalls: [...msg.toolCalls], isSidechain: msg.isSidechain })
      }
    }
  }
  return segments
}

// --- Constants ---

const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context.'

interface CompactSection {
  label: string
  messages: ParsedMessage[]
  isCurrent: boolean
  isSharedContext?: boolean
}

// --- Markdown export ---

function turnToMarkdown(turn: Turn): string {
  const lines: string[] = []

  if (turn.userMsg) {
    lines.push(`## Human\n`)
    lines.push(turn.userMsg.textContent.trim())
    lines.push('')
  }

  if (turn.assistantMsgs.length > 0) {
    lines.push(`## Assistant\n`)
    const segments = buildSegments(turn.assistantMsgs)
    for (const seg of segments) {
      if (seg.type === 'text') {
        lines.push(seg.text!.trim())
        lines.push('')
      } else if (seg.type === 'tools') {
        for (const tc of seg.toolCalls!) {
          if (tc.name === 'Bash' && tc.input.command) {
            lines.push(`\`\`\`bash`)
            lines.push(`$ ${tc.input.command}`)
            if (tc.result) lines.push(tc.result.slice(0, 2000))
            lines.push(`\`\`\``)
          } else if (tc.name === 'Read' && tc.input.file_path) {
            lines.push(`> 📄 Read \`${tc.input.file_path}\``)
          } else if (tc.name === 'Write' && tc.input.file_path) {
            lines.push(`> ✏️ Write \`${tc.input.file_path}\``)
            if (tc.input.content) {
              lines.push(`\`\`\``)
              lines.push(String(tc.input.content).slice(0, 1000))
              lines.push(`\`\`\``)
            }
          } else if (tc.name === 'Edit' && tc.input.file_path) {
            lines.push(`> ✏️ Edit \`${tc.input.file_path}\``)
            if (tc.input.old_string) {
              lines.push(`\`\`\`diff`)
              lines.push(`- ${String(tc.input.old_string).split('\n').join('\n- ')}`)
              lines.push(`+ ${String(tc.input.new_string || '').split('\n').join('\n+ ')}`)
              lines.push(`\`\`\``)
            }
          } else if ((tc.name === 'Grep' || tc.name === 'Glob') && tc.input.pattern) {
            lines.push(`> 🔍 ${tc.name} \`${tc.input.pattern}\``)
            if (tc.result) {
              lines.push(`\`\`\``)
              lines.push(tc.result.slice(0, 1000))
              lines.push(`\`\`\``)
            }
          } else if (tc.name === 'Agent') {
            lines.push(`> 🤖 Agent: ${tc.input.prompt ? String(tc.input.prompt).slice(0, 100) : 'subagent'}`)
            if (tc.result) {
              lines.push(`\`\`\``)
              lines.push(tc.result.slice(0, 2000))
              lines.push(`\`\`\``)
            }
          } else {
            lines.push(`> 🔧 ${tc.name}`)
            lines.push(`\`\`\`json`)
            lines.push(JSON.stringify(tc.input, null, 2).slice(0, 500))
            lines.push(`\`\`\``)
          }
          lines.push('')
        }
      }
    }
  }

  return lines.join('\n')
}

function sessionToMarkdown(
  title: string,
  sections: CompactSection[]
): string {
  const lines: string[] = []
  lines.push(`# ${title}\n`)

  for (const section of sections) {
    if (section.label) {
      lines.push(`---\n### ${section.label}\n`)
    }
    const turns = groupIntoTurns(section.messages)
    for (const turn of turns) {
      lines.push(turnToMarkdown(turn))
    }
  }

  return lines.join('\n')
}

function downloadMarkdown(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// --- Turn block component ---

function TurnBlock({
  turn, viewMode, highlightText, faded
}: {
  turn: Turn
  viewMode: 'compact' | 'full'
  highlightText: (text: string) => React.ReactNode
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
                      {highlightText(summary)}
                    </div>
                  </div>
                )
              }
              return (
                <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                  {highlightText(turn.userMsg!.textContent)}
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
                  <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed mb-1">
                    {highlightText(seg.text!)}
                  </div>
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

// --- Main ChatViewer ---

export function ChatViewer() {
  const { selectedSession, viewMode, searchQuery } = useStore()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())

  const sections = useMemo<CompactSection[]>(() => {
    if (!selectedSession) return []

    const sharedMsgs = selectedSession.messages.filter((m) => m.isSharedContext)
    const ownMsgs = selectedSession.messages.filter((m) => !m.isSharedContext)

    const allMsgs = ownMsgs.filter((m) => {
      if (viewMode === 'compact') {
        if (m.type === 'system' && m.subtype === 'compact_boundary') return true
        return m.type === 'user' || m.type === 'assistant'
      }
      if (m.type === 'system' && m.subtype === 'compact_boundary') return true
      return m.type !== 'progress'
    })

    const boundaryIndices: number[] = []
    allMsgs.forEach((m, i) => {
      if (m.type === 'system' && m.subtype === 'compact_boundary') boundaryIndices.push(i)
    })

    const sharedSection: CompactSection[] = []
    if (sharedMsgs.length > 0) {
      const filteredShared = sharedMsgs.filter((m) => m.type === 'user' || m.type === 'assistant')
      if (filteredShared.length > 0) {
        const userCount = filteredShared.filter(m => m.type === 'user').length
        const asstCount = filteredShared.filter(m => m.type === 'assistant').length
        sharedSection.push({
          label: `共享上下文 — 分支前的对话 (${userCount + asstCount} 条消息)`,
          messages: filteredShared,
          isCurrent: false,
          isSharedContext: true
        })
      }
    }

    if (boundaryIndices.length === 0) {
      return [...sharedSection, { label: '', messages: allMsgs, isCurrent: true }]
    }

    const result: CompactSection[] = []
    const firstSection = allMsgs.slice(0, boundaryIndices[0])
    if (firstSection.length > 0) {
      const userCount = firstSection.filter(m => m.type === 'user').length
      const asstCount = firstSection.filter(m => m.type === 'assistant').length
      result.push({
        label: `原始对话 (${userCount + asstCount} 条消息)`,
        messages: firstSection,
        isCurrent: false
      })
    }

    for (let i = 0; i < boundaryIndices.length; i++) {
      const start = boundaryIndices[i] + 1
      const end = i + 1 < boundaryIndices.length ? boundaryIndices[i + 1] : allMsgs.length
      const sectionMsgs = allMsgs.slice(start, end)
      const isLast = i === boundaryIndices.length - 1

      if (sectionMsgs.length > 0) {
        if (isLast) {
          result.push({ label: '', messages: sectionMsgs, isCurrent: true })
        } else {
          const userCount = sectionMsgs.filter(m => m.type === 'user').length
          const asstCount = sectionMsgs.filter(m => m.type === 'assistant').length
          result.push({
            label: `Compact #${i + 1} 后 (${userCount + asstCount} 条消息)`,
            messages: sectionMsgs,
            isCurrent: false
          })
        }
      }
    }

    return [...sharedSection, ...result]
  }, [selectedSession, viewMode])

  const sessionId = selectedSession?.id
  const prevSessionIdRef = useRef<string | null>(null)
  if (sessionId !== prevSessionIdRef.current) {
    prevSessionIdRef.current = sessionId ?? null
    if (expandedSections.size > 0) setExpandedSections(new Set())
  }

  const handleExportMarkdown = useCallback(() => {
    if (!selectedSession || sections.length === 0) return
    const title = selectedSession.firstUserMessage?.slice(0, 60) || selectedSession.sessionId
    const md = sessionToMarkdown(title, sections)
    const safeName = title.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_').slice(0, 40)
    downloadMarkdown(`${safeName}.md`, md)
  }, [selectedSession, sections])

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
        viewMode={viewMode}
        highlightText={highlightText}
        faded={faded}
      />
    ))
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {/* Export button */}
      <div className="flex justify-end">
        <button
          onClick={handleExportMarkdown}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          title="导出为 Markdown"
        >
          <Download size={12} />
          <span>导出 MD</span>
        </button>
      </div>

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
