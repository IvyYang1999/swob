import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, History, Plus, Square, X, Terminal, MessageSquare, Clock, ChevronLeft } from 'lucide-react'
import { CliMarkdown } from './components/MarkdownContent'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turn raw engine errors into something a person can act on. */
function humanizeAgentError(text: string): string {
  if (text.includes('EBADF')) {
    return '助手引擎启动失败(子进程异常)。请退出并重新打开 Swob;如果重启后仍出现,这是 Swob 的 bug,麻烦反馈给我们。'
  }
  if (text.includes('ENOENT')) {
    return '找不到 Claude Code CLI(claude 命令)。助手第一版依赖它作为引擎,安装后重试。'
  }
  return text
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

/** Extract engine name from binary path, e.g. "/usr/local/bin/claude" -> "claude" */
function extractEngineName(binaryPath?: string): string {
  if (!binaryPath) return 'Claude Code'
  const segments = binaryPath.split('/')
  return segments[segments.length - 1] || 'Claude Code'
}

// Agent sessions live under ~/.claude-session-manager/agent
const AGENT_PATH_MARKER = '.claude-session-manager/agent'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
}

interface AgentStatus {
  available: boolean
  binaryPath?: string
  sessionId?: string
  busy?: boolean
  reason?: string
}

/** Minimal session shape from loadAllSessions — we only use the fields we need. */
interface SessionSummary {
  id: string
  sessionId: string
  firstUserMessage: string
  updatedAt: string
  turnCount: number
  cwds: string[]
  projectPath: string
  filePath: string
}

/** Parsed message shape from loadSessionDetail. */
interface ParsedMessage {
  type: string
  textContent: string
}

type View = 'chat' | 'history'

// ---------------------------------------------------------------------------
// Animated thinking dots
// ---------------------------------------------------------------------------

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]">
      <span className="thinking-dot-1 inline-block h-[4px] w-[4px] rounded-full bg-soft-blue" />
      <span className="thinking-dot-2 inline-block h-[4px] w-[4px] rounded-full bg-soft-blue" />
      <span className="thinking-dot-3 inline-block h-[4px] w-[4px] rounded-full bg-soft-blue" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// HistoryList sub-component
// ---------------------------------------------------------------------------

function HistoryList({ onSelect, onBack }: {
  onSelect: (session: SessionSummary) => void
  onBack: () => void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.api.loadAllSessions().then((all: unknown) => {
      if (cancelled) return
      const allSessions = all as SessionSummary[]
      // Filter to only agent sessions (those whose projectPath or cwds contain the agent workspace marker)
      const agentSessions = allSessions.filter((s) =>
        s.projectPath?.includes(AGENT_PATH_MARKER) ||
        s.cwds?.some((c) => c.includes(AGENT_PATH_MARKER))
      )
      // Sort most recent first
      agentSessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      setSessions(agentSessions)
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted">
        <div className="h-3 w-3 animate-spin rounded-full border border-soft-blue border-t-transparent mr-2" />
        加载历史...
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[11px] text-muted">
        <MessageSquare size={20} className="text-faint" />
        <div>还没有助手对话记录</div>
        <button
          onClick={onBack}
          className="mt-2 rounded px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
        >
          返回对话
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sessions.map((session) => {
        const title = session.firstUserMessage
          ? session.firstUserMessage.slice(0, 60) + (session.firstUserMessage.length > 60 ? '...' : '')
          : '(无消息)'
        return (
          <button
            key={session.id}
            onClick={() => onSelect(session)}
            className="group flex w-full items-start gap-2 border-b border-edge/50 px-3 py-2 text-left hover:bg-hover transition-colors"
          >
            <MessageSquare size={12} className="mt-0.5 shrink-0 text-faint group-hover:text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-primary group-hover:text-bright">{title}</div>
              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-faint">
                <span className="flex items-center gap-0.5">
                  <Clock size={9} />
                  {formatRelativeTime(session.updatedAt)}
                </span>
                <span>{session.turnCount} 轮</span>
              </div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

/**
 * Global agent floating window (#agent hash route). The engine is the user's
 * installed Claude Code CLI in headless mode; the only tool is the swob CLI,
 * and every conversation is itself a session that lands in the vault.
 */
export function AgentApp() {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [view, setView] = useState<View>('chat')
  const [model, setModel] = useState<string | null>(null)
  const [viewingHistorySession, setViewingHistorySession] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const engineName = useMemo(() => extractEngineName(status?.binaryPath), [status?.binaryPath])

  // Fetch engine status on mount
  useEffect(() => {
    void window.api.agentGetStatus()
      .then((s: unknown) => setStatus(s as AgentStatus))
      .catch(() => setStatus({ available: false, reason: '状态查询失败' }))
  }, [])

  // Listen to agent events
  useEffect(() => {
    const unsubscribe = window.api.onAgentEvent((event) => {
      if (event.type === 'assistant-text' && event.text) {
        setItems((prev) => [...prev, { role: 'assistant', text: event.text as string }])
      } else if (event.type === 'tool-use') {
        setItems((prev) => [...prev, { role: 'tool', text: (event.summary || event.name || 'tool') as string }])
      } else if (event.type === 'result') {
        setBusy(false)
        // Try to extract model from result event if available
        if (event.model && typeof event.model === 'string') {
          setModel(event.model)
        }
        if (!event.ok && event.error) {
          setItems((prev) => [...prev, { role: 'error', text: event.error as string }])
        }
      } else if (event.type === 'init') {
        // Mark that we have an active (non-history) session
        setViewingHistorySession(false)
      }
    })
    return unsubscribe
  }, [])

  // Auto-scroll on new messages
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items, busy])

  const send = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setItems((prev) => [...prev, { role: 'user', text: prompt }])
    setBusy(true)
    setViewingHistorySession(false)
    const result = await window.api.agentSend(prompt)
    if (!result.ok) {
      setBusy(false)
      setItems((prev) => [...prev, { role: 'error', text: result.error || '发送失败' }])
    }
  }, [input, busy])

  const newConversation = useCallback(async () => {
    await window.api.agentNewConversation()
    setItems([])
    setViewingHistorySession(false)
    setView('chat')
  }, [])

  const toggleView = useCallback(() => {
    setView((v) => v === 'chat' ? 'history' : 'chat')
  }, [])

  // Load a history session's messages into chat view (read-only display)
  const loadHistorySession = useCallback(async (session: SessionSummary) => {
    try {
      const detail = await window.api.loadSessionDetail(session.filePath) as {
        messages?: ParsedMessage[]
      }
      if (detail?.messages) {
        const chatItems: ChatItem[] = detail.messages
          .filter((m) => m.textContent?.trim())
          .map((m) => ({
            role: (m.type === 'human' ? 'user' : 'assistant') as ChatItem['role'],
            text: m.textContent
          }))
        setItems(chatItems)
      }
    } catch {
      setItems([{ role: 'error', text: '无法加载该历史对话' }])
    }
    setViewingHistorySession(true)
    // TODO: tF2-resume — 需要新增 IPC `agent:resumeSession(sessionId)` 让 main 进程
    // 将 agentSessionId 设为指定值,这样后续 agentSend 能以 --resume 接续该会话。
    // 当前 main/agent-window.ts 未暴露此 IPC,故历史会话仅只读展示。
    setView('chat')
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-panel text-primary">
      {/* Title bar (draggable) */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Bot size={14} className="text-accent" />
        <span className="text-xs font-medium">Swob 助手</span>
        <span className="rounded bg-soft-amber/10 px-1 py-0.5 text-[8px] text-soft-amber">MVP</span>
        {/* Engine & model transparency */}
        <span className="text-[10px] text-faint" title={status?.binaryPath || 'unknown'}>
          {engineName}
          {model ? ` / ${model}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={toggleView}
            title={view === 'chat' ? '历史对话' : '返回对话'}
            className={`rounded p-1 transition-colors ${
              view === 'history'
                ? 'bg-accent/15 text-accent'
                : 'text-muted hover:bg-hover hover:text-primary'
            }`}
          >
            {view === 'history' ? <ChevronLeft size={13} /> : <History size={13} />}
          </button>
          <button
            onClick={() => void newConversation()}
            title="新对话"
            className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
          >
            <Plus size={13} />
          </button>
          <button
            onClick={() => void window.api.agentHideWindow()}
            title="隐藏 (Cmd+Shift+A)"
            className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* View switcher: history list or chat messages */}
      {view === 'history' ? (
        <HistoryList onSelect={(s) => void loadHistorySession(s)} onBack={() => setView('chat')} />
      ) : (
        <>
          {/* Chat messages */}
          <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
            {status && !status.available && (
              <div className="rounded-md border border-soft-amber/30 bg-soft-amber/5 p-2 text-[11px] leading-relaxed text-soft-amber">
                {status.reason || '引擎不可用'}
              </div>
            )}
            {viewingHistorySession && items.length > 0 && (
              <div className="flex items-center gap-1.5 rounded bg-amber-900/20 px-2 py-1 text-[10px] text-amber-400">
                <Clock size={10} />
                <span>历史对话(只读)</span>
              </div>
            )}
            {items.length === 0 && status?.available && (
              <div className="space-y-2 pt-6 text-center text-[11px] text-muted">
                <div>问我任何关于你的 AI 会话历史的问题</div>
                <div className="space-y-1 text-[10px] text-faint">
                  <div>「我昨天用 AI 干了些啥?」</div>
                  <div>「找一下上周关于登录 bug 的会话」</div>
                  <div>「这个月哪个项目烧 token 最多?」</div>
                </div>
                <div className="pt-2 text-[10px] text-faint">
                  引擎:{engineName} · 只能使用 swob 命令 · 对话本身也会落入你的 vault
                </div>
              </div>
            )}
            {items.map((item, index) => (
              <div key={index}>
                {item.role === 'user' && (
                  <div className="ml-8 rounded-lg bg-accent/10 px-2.5 py-1.5 text-[12px] leading-relaxed">
                    {item.text}
                  </div>
                )}
                {item.role === 'assistant' && (
                  <div className="mr-4 overflow-x-auto rounded-lg bg-surface px-2.5 py-1.5 text-[12px] leading-relaxed">
                    <CliMarkdown content={item.text} />
                  </div>
                )}
                {item.role === 'tool' && (
                  <div className="flex items-center gap-1.5 px-1 text-[10px] text-faint">
                    <Terminal size={10} />
                    <span className="truncate font-mono">{item.text}</span>
                  </div>
                )}
                {item.role === 'error' && (
                  <div className="rounded-md border border-red-400/30 bg-red-400/5 px-2.5 py-1.5 text-[11px] leading-relaxed text-red-400">
                    {humanizeAgentError(item.text)}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-[11px] text-muted animate-pulse">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-soft-blue border-t-transparent" />
                <span>思考中</span>
                <ThinkingDots />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-edge p-2">
            <div className="flex items-end gap-1.5">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={2}
                placeholder={status?.available === false ? '需要先安装 Claude Code CLI' : '问点什么... (Enter 发送)'}
                disabled={status?.available === false}
                className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-surface px-2 py-1.5 text-[12px] text-primary outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
              />
              {busy ? (
                <button
                  onClick={() => void window.api.agentCancel()}
                  title="停止"
                  className="rounded-md bg-red-400/15 p-2 text-red-400 transition-colors hover:bg-red-400/25 active:scale-95"
                >
                  <Square size={13} />
                </button>
              ) : (
                <button
                  onClick={() => void send()}
                  disabled={!input.trim() || status?.available === false}
                  className="rounded-md bg-accent/15 px-3 py-2 text-[11px] font-medium text-accent transition-colors hover:bg-accent/25 disabled:opacity-40"
                >
                  发送
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
