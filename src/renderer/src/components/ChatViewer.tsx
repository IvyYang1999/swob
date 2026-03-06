import { useRef, useState, useMemo } from 'react'
import { useStore } from '../store'
import { User, Bot, Terminal, ChevronDown, ChevronRight, AlertTriangle, History, GitBranch } from 'lucide-react'
import type { ParsedMessage } from '../store'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function ToolCallBlock({ name, input }: { name: string; input: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)

  let preview = ''
  if (name === 'Bash' && input.command) preview = String(input.command).slice(0, 80)
  else if (name === 'Read' && input.file_path) preview = String(input.file_path)
  else if (name === 'Write' && input.file_path) preview = String(input.file_path)
  else if (name === 'Edit' && input.file_path) preview = String(input.file_path)
  else if (name === 'Grep' && input.pattern) preview = String(input.pattern)
  else if (name === 'Glob' && input.pattern) preview = String(input.pattern)
  else if (name === 'Skill' && input.skill) preview = String(input.skill)

  return (
    <div className="my-1 border border-zinc-700 rounded bg-zinc-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-300"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Terminal size={12} />
        <span className="font-mono">{name}</span>
        {preview && (
          <span className="truncate text-zinc-500 ml-1">{preview}</span>
        )}
      </button>
      {expanded && (
        <pre className="px-3 py-2 text-xs text-zinc-400 overflow-x-auto border-t border-zinc-700 max-h-64 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  )
}

const COMPACT_SUMMARY_PREFIX = 'This session is being continued from a previous conversation that ran out of context.'

interface CompactSection {
  label: string
  messages: ParsedMessage[]
  isCurrent: boolean
  isSharedContext?: boolean
}

function MessageItem({
  msg, viewMode, highlightText, faded
}: {
  msg: ParsedMessage
  viewMode: 'compact' | 'full'
  highlightText: (text: string) => React.ReactNode
  faded: boolean
}) {
  const isUser = msg.type === 'user'
  const hasText = msg.textContent.trim().length > 0
  const hasTools = msg.toolCalls.length > 0

  // Skip messages with no visible content
  // - User messages with no text (tool_result responses have no user-visible content)
  // - Assistant messages with no text and no tool calls
  if (!hasText && (isUser || !hasTools)) return null

  return (
    <div className={`flex gap-3 ${faded ? 'opacity-50' : ''} ${msg.isSidechain ? 'opacity-40 border-l-2 border-zinc-600 pl-2' : ''}`}>
      <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
        isUser ? 'bg-blue-600' : 'bg-orange-600'
      }`}>
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs font-medium text-zinc-400">
            {isUser ? 'User' : 'Assistant'}
          </span>
          <span className="text-[11px] text-zinc-600">{formatTime(msg.timestamp)}</span>
          {msg.isSidechain && (
            <span className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 text-zinc-500">rejected</span>
          )}
        </div>
        {msg.textContent && (() => {
          const isCompactSummary = isUser && msg.textContent.startsWith(COMPACT_SUMMARY_PREFIX)
          if (isCompactSummary) {
            const summary = msg.textContent.slice(COMPACT_SUMMARY_PREFIX.length).trim()
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
              {highlightText(msg.textContent)}
            </div>
          )
        })()}
        {viewMode === 'full' && msg.toolCalls.length > 0 && (
          <div className="mt-2 space-y-1">
            {msg.toolCalls.map((tc, j) => (
              <ToolCallBlock key={j} name={tc.name} input={tc.input} />
            ))}
          </div>
        )}
        {viewMode === 'compact' && msg.toolCalls.length > 0 && (
          <div className="mt-1 text-[11px] text-zinc-500">
            {msg.toolCalls.map((tc) => tc.name).join(', ')} ({msg.toolCalls.length} calls)
          </div>
        )}
      </div>
    </div>
  )
}

export function ChatViewer() {
  const { selectedSession, viewMode, searchQuery } = useStore()
  const bottomRef = useRef<HTMLDivElement>(null)
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set())

  // Split messages into compact sections
  const sections = useMemo<CompactSection[]>(() => {
    if (!selectedSession) return []

    // Separate shared context messages (from parent branch) and own messages
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

    // Find compact boundary indices
    const boundaryIndices: number[] = []
    allMsgs.forEach((m, i) => {
      if (m.type === 'system' && m.subtype === 'compact_boundary') {
        boundaryIndices.push(i)
      }
    })

    // Prepend shared context section if this is a branch
    const sharedSection: CompactSection[] = []
    if (sharedMsgs.length > 0) {
      const filteredShared = sharedMsgs.filter((m) =>
        m.type === 'user' || m.type === 'assistant'
      )
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

    // Section before first compact boundary
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

    // Sections between compact boundaries
    for (let i = 0; i < boundaryIndices.length; i++) {
      const start = boundaryIndices[i] + 1 // skip the boundary itself
      const end = i + 1 < boundaryIndices.length ? boundaryIndices[i + 1] : allMsgs.length
      const sectionMsgs = allMsgs.slice(start, end)
      const isLast = i === boundaryIndices.length - 1

      if (sectionMsgs.length > 0) {
        if (isLast) {
          result.push({
            label: '',
            messages: sectionMsgs,
            isCurrent: true
          })
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

  // Reset expanded sections when session changes
  const sessionId = selectedSession?.id
  const prevSessionIdRef = useRef<string | null>(null)
  if (sessionId !== prevSessionIdRef.current) {
    prevSessionIdRef.current = sessionId ?? null
    if (expandedSections.size > 0) {
      setExpandedSections(new Set())
    }
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

  function highlightText(text: string): React.ReactNode {
    if (!searchQuery) return text
    try {
      const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      const parts = text.split(regex)
      return parts.map((part, i) => {
        const isMatch = new RegExp(`^${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(part)
        return isMatch ? (
          <mark key={i} className="bg-yellow-500/40 text-yellow-200 rounded px-0.5">{part}</mark>
        ) : (
          part
        )
      })
    } catch {
      return text
    }
  }

  const toggleSection = (idx: number) => {
    setExpandedSections(prev => {
      const next = new Set(prev)
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return next
    })
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {sections.map((section, sIdx) => {
        if (section.isCurrent) {
          // Current section: render all messages normally
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
              {section.messages.map((msg) => {
                if (msg.type === 'system') {
                  if (viewMode === 'compact') return null
                  return (
                    <div key={msg.uuid} className="text-xs text-zinc-500 bg-zinc-800/30 rounded px-3 py-2 font-mono">
                      [system] {msg.textContent.slice(0, 300)}
                    </div>
                  )
                }
                return (
                  <MessageItem
                    key={msg.uuid}
                    msg={msg}
                    viewMode={viewMode}
                    highlightText={highlightText}
                    faded={false}
                  />
                )
              })}
            </div>
          )
        }

        // Historical / shared context section: collapsible
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
                {section.messages.map((msg) => {
                  if (msg.type === 'system') {
                    if (viewMode === 'compact') return null
                    return (
                      <div key={msg.uuid} className="text-xs text-zinc-500 bg-zinc-800/30 rounded px-3 py-2 font-mono">
                        [system] {msg.textContent.slice(0, 300)}
                      </div>
                    )
                  }
                  return (
                    <MessageItem
                      key={msg.uuid}
                      msg={msg}
                      viewMode={viewMode}
                      highlightText={highlightText}
                      faded={true}
                    />
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}
