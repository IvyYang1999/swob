import { useState, useEffect, useRef } from 'react'
import { DemoShell } from './DemoShell'
import { AGENT_MESSAGES } from './fixtures'

export function CompanionDemo() {
  const [visibleCount, setVisibleCount] = useState(0)
  const [started, setStarted] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!started || visibleCount >= AGENT_MESSAGES.length) return
    const delay = AGENT_MESSAGES[visibleCount]?.role === 'assistant' ? 800 : 400
    const timer = setTimeout(() => setVisibleCount(c => c + 1), delay)
    return () => clearTimeout(timer)
  }, [started, visibleCount])

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight)
  }, [visibleCount])

  return (
    <DemoShell aspectRatio="3/4">
      <div style={windowStyle}>
        {/* 标题栏 */}
        <div style={titleBarStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 13 }}>🤖</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-bright)' }}>Swob 助手</span>
            <span style={mvpBadge}>MVP</span>
          </div>
          <div style={{ fontSize: 9, color: 'var(--color-faint)' }}>
            claude · opus-4.6
          </div>
        </div>

        {/* 消息区 */}
        <div ref={scrollRef} style={messagesStyle}>
          {!started && (
            <div style={emptyStyle}>
              <span style={{ fontSize: 28 }}>💬</span>
              <p style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 8 }}>
                问我关于你历史会话的任何问题
              </p>
              <button style={startBtnStyle} onClick={() => { setStarted(true); setVisibleCount(1) }}>
                试试看
              </button>
            </div>
          )}
          {started && AGENT_MESSAGES.slice(0, visibleCount).map((m, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              {m.role === 'user' && (
                <div style={userBubbleStyle}>{m.content}</div>
              )}
              {m.role === 'assistant' && (
                <div style={assistantBubbleStyle}>
                  {m.content.split('\n').map((line, j) => (
                    <div key={j} style={{ minHeight: line ? undefined : 6 }}>
                      {line.startsWith('>') ? (
                        <div style={quoteStyle}>{line.slice(2)}</div>
                      ) : line.match(/^\d+\./) ? (
                        <div style={{ paddingLeft: 8 }}>{line}</div>
                      ) : (
                        formatBold(line)
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
          {started && visibleCount < AGENT_MESSAGES.length && (
            <div style={{ display: 'flex', gap: 4, padding: '4px 8px' }}>
              <span style={dotStyle(0)}>·</span>
              <span style={dotStyle(1)}>·</span>
              <span style={dotStyle(2)}>·</span>
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div style={inputBarStyle}>
          <div style={inputFieldStyle}>问点什么…</div>
        </div>
      </div>
    </DemoShell>
  )
}

function formatBold(text: string) {
  const parts = text.split(/\*\*(.*?)\*\*/g)
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? <strong key={i}>{part}</strong> : <span key={i}>{part}</span>
      )}
    </span>
  )
}

const windowStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--color-base)',
}
const titleBarStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '8px 12px', borderBottom: '1px solid var(--color-edge)',
}
const mvpBadge: React.CSSProperties = {
  fontSize: 8, fontWeight: 600, padding: '1px 4px', borderRadius: 3,
  background: 'color-mix(in srgb, var(--color-soft-amber) 12%, transparent)',
  color: 'var(--color-soft-amber)',
}
const messagesStyle: React.CSSProperties = {
  flex: 1, overflowY: 'auto', padding: '10px 12px',
}
const emptyStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  justifyContent: 'center', height: '100%', textAlign: 'center',
}
const startBtnStyle: React.CSSProperties = {
  marginTop: 12, fontSize: 12, fontWeight: 600, padding: '6px 16px',
  border: 'none', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-accent)', color: '#fff', cursor: 'pointer',
}
const userBubbleStyle: React.CSSProperties = {
  marginLeft: '20%', padding: '6px 10px', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-accent-light)', fontSize: 11, lineHeight: 1.5,
  color: 'var(--color-primary)',
}
const assistantBubbleStyle: React.CSSProperties = {
  marginRight: '8%', padding: '6px 10px', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)', fontSize: 11, lineHeight: 1.6,
  color: 'var(--color-body)',
}
const quoteStyle: React.CSSProperties = {
  borderLeft: '2px solid var(--color-accent)', paddingLeft: 8,
  color: 'var(--color-muted)', fontStyle: 'italic', margin: '4px 0',
}
const inputBarStyle: React.CSSProperties = {
  padding: 8, borderTop: '1px solid var(--color-edge)',
}
const inputFieldStyle: React.CSSProperties = {
  padding: '8px 10px', borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-edge)', background: 'var(--color-surface)',
  fontSize: 11, color: 'var(--color-faint)',
}

function dotStyle(i: number): React.CSSProperties {
  return {
    fontSize: 18, fontWeight: 700, color: 'var(--color-muted)',
    animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
  }
}

if (typeof document !== 'undefined' && !document.getElementById('companion-anim')) {
  const style = document.createElement('style')
  style.id = 'companion-anim'
  style.textContent = `@keyframes pulse { 0%,80%,100% { opacity:0.2 } 40% { opacity:1 } }`
  document.head.appendChild(style)
}
