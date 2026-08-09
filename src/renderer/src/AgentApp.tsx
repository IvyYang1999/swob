import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, History, Plus, Square, X, Terminal, MessageSquare, Clock, ChevronLeft } from 'lucide-react'
import { CliMarkdown } from './components/MarkdownContent'
import { translate, useStandaloneLocale, type Locale } from './i18n'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Turn raw engine errors into something a person can act on. */
function humanizeAgentError(text: string, locale: Locale): string {
  if (text.includes('EBADF')) {
    return translate(locale, 'renderer.agent.engine_process_failed')
  }
  if (text.includes('ENOENT')) {
    return translate(locale, 'renderer.agent.cli_not_found')
  }
  return text
}

function formatRelativeTime(isoDate: string, locale: Locale): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (mins < 60) return formatter.format(-mins, 'minute')
  const hours = Math.floor(mins / 60)
  if (hours < 24) return formatter.format(-hours, 'hour')
  const days = Math.floor(hours / 24)
  if (days < 7) return formatter.format(-days, 'day')
  return new Date(isoDate).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
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
  reasonCode?: string
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

function mergeAgentSessionSummaries(
  current: SessionSummary[],
  incoming: SessionSummary[]
): SessionSummary[] {
  const byId = new Map(current.map((session) => [session.id, session]))
  for (const session of incoming) byId.set(session.id, session)
  return [...byId.values()]
    .filter((session) =>
      session.projectPath?.includes(AGENT_PATH_MARKER) ||
      session.cwds?.some((cwd) => cwd.includes(AGENT_PATH_MARKER))
    )
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
}

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

function HistoryList({ onSelect, onBack, locale }: {
  onSelect: (session: SessionSummary) => void
  onBack: () => void
  locale: Locale
}) {
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key, params)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const unsubscribe = window.api.onProviderPatch(({ sessions: patch }) => {
      if (!cancelled) setSessions((current) => mergeAgentSessionSummaries(current, patch as SessionSummary[]))
    })
    void window.api.loadAllSessions().then((all: unknown) => {
      if (cancelled) return
      // Merge instead of replacing because the provider patch can arrive before
      // the invoke promise resolves when its background work finishes quickly.
      setSessions((current) => mergeAgentSessionSummaries(current, all as SessionSummary[]))
      setLoading(false)
    }).catch(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] text-muted">
        <div className="h-3 w-3 animate-spin rounded-full border border-soft-blue border-t-transparent mr-2" />
        {t('renderer.agent.loading_history')}
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[11px] text-muted">
        <MessageSquare size={20} className="text-faint" />
        <div>{t('renderer.agent.no_history')}</div>
        <button
          onClick={onBack}
          className="mt-2 rounded px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
        >
          {t('renderer.agent.back_to_chat')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {sessions.map((session) => {
        const title = session.firstUserMessage
          ? session.firstUserMessage.slice(0, 60) + (session.firstUserMessage.length > 60 ? '...' : '')
          : t('renderer.agent.no_messages')
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
                  {formatRelativeTime(session.updatedAt, locale)}
                </span>
                <span>{t('renderer.agent.turns', { value0: session.turnCount })}</span>
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
  const locale = useStandaloneLocale()
  const t = (key: string, params?: Record<string, string | number>) => translate(locale, key, params)
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
      .catch(() => setStatus({ available: false, reasonCode: 'renderer.agent.status_failed' }))
  }, [locale])

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
        if (!event.ok && (event.errorCode || event.error)) {
          const message = event.errorCode
            ? t(event.errorCode, event.errorParams)
            : event.error as string
          setItems((prev) => [...prev, { role: 'error', text: message }])
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
      setItems((prev) => [...prev, {
        role: 'error',
        text: result.errorCode ? t(result.errorCode, result.errorParams) : t('renderer.agent.send_failed')
      }])
    }
  }, [input, busy, locale])

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
      setItems([{ role: 'error', text: t('renderer.agent.history_load_failed') }])
    }
    setViewingHistorySession(true)
    // TODO: tF2-resume — 需要新增 IPC `agent:resumeSession(sessionId)` 让 main 进程
    // 将 agentSessionId 设为指定值,这样后续 agentSend 能以 --resume 接续该会话。
    // 当前 main/agent-window.ts 未暴露此 IPC,故历史会话仅只读展示。
    setView('chat')
  }, [locale])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-panel text-primary">
      {/* Title bar (draggable) */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Bot size={14} className="text-accent" />
        <span className="text-xs font-medium">{t('renderer.agent.title')}</span>
        <span className="rounded bg-soft-amber/10 px-1 py-0.5 text-[8px] text-soft-amber">MVP</span>
        {/* Engine & model transparency */}
        <span className="text-[10px] text-faint" title={status?.binaryPath || 'unknown'}>
          {engineName}
          {model ? ` / ${model}` : ''}
        </span>
        <div className="ml-auto flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={toggleView}
            title={view === 'chat' ? t('renderer.agent.history') : t('renderer.agent.back_to_chat')}
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
            title={t('renderer.agent.new_chat')}
            className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
          >
            <Plus size={13} />
          </button>
          <button
            onClick={() => void window.api.agentHideWindow()}
            title={t('renderer.agent.hide')}
            className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* View switcher: history list or chat messages */}
      {view === 'history' ? (
        <HistoryList locale={locale} onSelect={(s) => void loadHistorySession(s)} onBack={() => setView('chat')} />
      ) : (
        <>
          {/* Chat messages */}
          <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
            {status && !status.available && (
              <div className="rounded-md border border-soft-amber/30 bg-soft-amber/5 p-2 text-[11px] leading-relaxed text-soft-amber">
                {status.reasonCode ? t(status.reasonCode) : t('renderer.agent.engine_unavailable')}
              </div>
            )}
            {viewingHistorySession && items.length > 0 && (
              <div className="flex items-center gap-1.5 rounded bg-amber-900/20 px-2 py-1 text-[10px] text-amber-400">
                <Clock size={10} />
                <span>{t('renderer.agent.history_read_only')}</span>
              </div>
            )}
            {items.length === 0 && status?.available && (
              <div className="space-y-2 pt-6 text-center text-[11px] text-muted">
                <div>{t('renderer.agent.empty_title')}</div>
                <div className="space-y-1 text-[10px] text-faint">
                  <div>{t('renderer.agent.example_yesterday')}</div>
                  <div>{t('renderer.agent.example_bug')}</div>
                  <div>{t('renderer.agent.example_tokens')}</div>
                </div>
                <div className="pt-2 text-[10px] text-faint">
                  {t('renderer.agent.engine_disclosure', { value0: engineName })}
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
                    {humanizeAgentError(item.text, locale)}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="flex items-center gap-2 px-1 text-[11px] text-muted animate-pulse">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-soft-blue border-t-transparent" />
                <span>{t('renderer.agent.thinking')}</span>
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
                placeholder={status?.available === false ? t('renderer.agent.install_cli') : t('renderer.agent.input_placeholder')}
                disabled={status?.available === false}
                className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-surface px-2 py-1.5 text-[12px] text-primary outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
              />
              {busy ? (
                <button
                  onClick={() => void window.api.agentCancel()}
                  title={t('renderer.agent.stop')}
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
                  {t('renderer.agent.send')}
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
