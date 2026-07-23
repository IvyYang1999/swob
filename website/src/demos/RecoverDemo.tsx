import { useState } from 'react'
import { DemoShell } from './DemoShell'
import { SESSIONS } from './fixtures'

type ReviveState = 'idle' | 'reviving' | 'done'

export function RecoverDemo() {
  const [query, setQuery] = useState('')
  const [reviveStates, setReviveStates] = useState<Record<string, ReviveState>>({})

  const filtered = SESSIONS.filter(s =>
    !query || s.title.toLowerCase().includes(query.toLowerCase()) || s.source.toLowerCase().includes(query.toLowerCase())
  )

  const handleRevive = (id: string) => {
    setReviveStates(prev => ({ ...prev, [id]: 'reviving' }))
    setTimeout(() => {
      setReviveStates(prev => ({ ...prev, [id]: 'done' }))
    }, 1200)
  }

  return (
    <DemoShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16 }}>
        {/* 搜索框 */}
        <div style={searchWrapStyle}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-muted)" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="搜索所有会话…"
            style={searchInputStyle}
          />
          {query && (
            <button style={clearBtnStyle} onClick={() => setQuery('')}>✕</button>
          )}
        </div>

        {/* 结果 */}
        <div style={{ flex: 1, overflowY: 'auto', marginTop: 12 }}>
          {query && (
            <div style={{ fontSize: 11, color: 'var(--color-muted)', marginBottom: 8 }}>
              找到 {filtered.length} 个结果
            </div>
          )}

          {filtered.map(s => {
            const state = reviveStates[s.id] || 'idle'
            return (
              <div key={s.id} style={resultItemStyle}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-primary)' }}>{s.title}</span>
                    {s.deleted && (
                      <span style={deletedBadge}>已清理</span>
                    )}
                    {state === 'done' && (
                      <span style={revivedBadge}>已复活 ✓</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 3, display: 'flex', gap: 8 }}>
                    <span>{s.date}</span>
                    <span>{s.turns} 轮</span>
                    <span style={{ color: s.sourceColor, fontWeight: 500 }}>{s.source}</span>
                  </div>
                </div>

                {s.deleted && state === 'idle' && (
                  <button style={reviveBtnStyle} onClick={() => handleRevive(s.id)}>
                    复活
                  </button>
                )}
                {s.deleted && state === 'reviving' && (
                  <span style={revivingStyle}>恢复中…</span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </DemoShell>
  )
}

const searchWrapStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
  border: '1px solid var(--color-edge)', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface)', transition: 'border-color 0.15s',
}
const searchInputStyle: React.CSSProperties = {
  flex: 1, border: 'none', outline: 'none', background: 'transparent',
  fontSize: 13, color: 'var(--color-primary)', fontFamily: 'inherit',
}
const clearBtnStyle: React.CSSProperties = {
  border: 'none', background: 'none', color: 'var(--color-muted)',
  cursor: 'pointer', fontSize: 12, padding: 2,
}
const resultItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12,
  padding: '10px 12px', borderRadius: 'var(--radius-sm)',
  borderBottom: '1px solid var(--color-edge-subtle)',
  transition: 'background 0.1s',
}
const deletedBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
  background: 'color-mix(in srgb, var(--color-soft-red) 12%, transparent)',
  color: 'var(--color-soft-red)',
}
const revivedBadge: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
  background: 'color-mix(in srgb, var(--color-soft-green) 12%, transparent)',
  color: 'var(--color-soft-green)',
}
const reviveBtnStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, padding: '5px 12px',
  border: '1px solid var(--color-accent)', borderRadius: 'var(--radius-sm)',
  background: 'var(--color-accent-light)', color: 'var(--color-accent)',
  cursor: 'pointer', transition: 'background 0.15s', flexShrink: 0,
}
const revivingStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--color-accent)', fontWeight: 500,
}
