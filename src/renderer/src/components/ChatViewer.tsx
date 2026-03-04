import { useRef } from 'react'
import { useState } from 'react'
import { useStore } from '../store'
import { User, Bot, Terminal, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'

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

export function ChatViewer() {
  const { selectedSession, viewMode, searchQuery } = useStore()
  const bottomRef = useRef<HTMLDivElement>(null)

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

  const messages = selectedSession.messages.filter((m) => {
    if (viewMode === 'compact') {
      // Always show compact_boundary even in compact mode
      if (m.type === 'system' && m.subtype === 'compact_boundary') return true
      return m.type === 'user' || m.type === 'assistant'
    }
    return m.type !== 'progress'
  })

  function highlightText(text: string): React.ReactNode {
    if (!searchQuery) return text
    try {
      const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      const parts = text.split(regex)
      return parts.map((part, i) => {
        // Use a fresh test each time to avoid lastIndex issues with global regex
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

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((msg) => {
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          return (
            <div key={msg.uuid} className="flex items-center gap-3 py-3">
              <div className="flex-1 border-t border-amber-600/50" />
              <div className="flex items-center gap-2 text-amber-500 text-xs px-3 py-1 bg-amber-900/20 rounded-full">
                <AlertTriangle size={12} />
                Conversation compacted
              </div>
              <div className="flex-1 border-t border-amber-600/50" />
            </div>
          )
        }

        if (msg.type === 'system') {
          if (viewMode === 'compact') return null
          return (
            <div key={msg.uuid} className="text-xs text-zinc-500 bg-zinc-800/30 rounded px-3 py-2 font-mono">
              [system] {msg.textContent.slice(0, 300)}
            </div>
          )
        }

        const isUser = msg.type === 'user'
        const isPreCompact = msg.isPreCompact

        return (
          <div
            key={msg.uuid}
            className={`flex gap-3 ${isPreCompact ? 'opacity-60' : ''}`}
          >
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
                {isPreCompact && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded">
                    compact前
                  </span>
                )}
              </div>
              {msg.textContent && (
                <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                  {highlightText(msg.textContent)}
                </div>
              )}
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
      })}
      <div ref={bottomRef} />
    </div>
  )
}
