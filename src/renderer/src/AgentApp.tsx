import { useCallback, useEffect, useRef, useState } from 'react'
import { Bot, History, Plus, Square, X, Terminal } from 'lucide-react'

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

interface ChatItem {
  role: 'user' | 'assistant' | 'tool' | 'error'
  text: string
}

/**
 * Global agent floating window (#agent hash route). The engine is the user's
 * installed Claude Code CLI in headless mode; the only tool is the swob CLI,
 * and every conversation is itself a session that lands in the vault.
 */
export function AgentApp() {
  const [status, setStatus] = useState<{ available: boolean; reason?: string } | null>(null)
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    void window.api.agentGetStatus().then(setStatus).catch(() => setStatus({ available: false, reason: '状态查询失败' }))
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onAgentEvent((event) => {
      if (event.type === 'assistant-text' && event.text) {
        setItems((prev) => [...prev, { role: 'assistant', text: event.text! }])
      } else if (event.type === 'tool-use') {
        setItems((prev) => [...prev, { role: 'tool', text: event.summary || event.name || 'tool' }])
      } else if (event.type === 'result') {
        setBusy(false)
        if (!event.ok && event.error) {
          setItems((prev) => [...prev, { role: 'error', text: event.error! }])
        }
      }
    })
    return unsubscribe
  }, [])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [items, busy])

  const send = useCallback(async () => {
    const prompt = input.trim()
    if (!prompt || busy) return
    setInput('')
    setItems((prev) => [...prev, { role: 'user', text: prompt }])
    setBusy(true)
    const result = await window.api.agentSend(prompt)
    if (!result.ok) {
      setBusy(false)
      setItems((prev) => [...prev, { role: 'error', text: result.error || '发送失败' }])
    }
  }, [input, busy])

  const newConversation = useCallback(async () => {
    await window.api.agentNewConversation()
    setItems([])
  }, [])

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-panel text-primary">
      {/* Drag bar */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <Bot size={14} className="text-accent" />
        <span className="text-xs font-medium">Swob 助手</span>
        <span className="rounded bg-soft-amber/10 px-1 py-0.5 text-[8px] text-soft-amber">MVP</span>
        <div className="ml-auto flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => void window.api.agentOpenHistory()}
            title="历史对话(在主窗口「Swob 助手」文件夹)"
            className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
          >
            <History size={13} />
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
            title="隐藏 (⌘⇧A)"
            className="rounded p-1 text-muted hover:bg-hover hover:text-primary"
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2">
        {status && !status.available && (
          <div className="rounded-md border border-soft-amber/30 bg-soft-amber/5 p-2 text-[11px] leading-relaxed text-soft-amber">
            {status.reason || '引擎不可用'}
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
            <div className="pt-2 text-[9px] text-faint">
              引擎:本机 Claude Code CLI · 只能使用 swob 命令 · 对话本身也会落入你的 vault
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
              <div className="mr-4 whitespace-pre-wrap rounded-lg bg-surface px-2.5 py-1.5 text-[12px] leading-relaxed">
                {item.text}
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
          <div className="flex items-center gap-2 px-1 text-[11px] text-muted">
            <div className="h-3 w-3 animate-spin rounded-full border border-soft-blue border-t-transparent" />
            思考中…
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
            placeholder={status?.available === false ? '需要先安装 Claude Code CLI' : '问点什么… (Enter 发送)'}
            disabled={status?.available === false}
            className="min-h-0 flex-1 resize-none rounded-md border border-edge bg-surface px-2 py-1.5 text-[12px] text-primary outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
          />
          {busy ? (
            <button
              onClick={() => void window.api.agentCancel()}
              title="停止"
              className="rounded-md bg-red-400/15 p-2 text-red-400 hover:bg-red-400/25"
            >
              <Square size={13} />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim() || status?.available === false}
              className="rounded-md bg-accent/15 px-3 py-2 text-[11px] font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
            >
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
