import { useState } from 'react'
import { DemoShell } from './DemoShell'
import { SESSIONS, FOLDERS, CHAT_MESSAGES } from './fixtures'

type ViewMode = 'organize' | 'all'

export function CollectDemo() {
  const [mode, setMode] = useState<ViewMode>('organize')
  const [selected, setSelected] = useState('s1')
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set(['后端架构']))

  const toggleFolder = (name: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev)
      next.has(name) ? next.delete(name) : next.add(name)
      return next
    })
  }

  const selectedSession = SESSIONS.find(s => s.id === selected)

  return (
    <DemoShell>
      <div style={{ display: 'flex', height: '100%' }}>
        {/* 侧栏 */}
        <div style={sidebarStyle}>
          {/* 模式切换 */}
          <div style={tabBarStyle}>
            <button style={mode === 'organize' ? tabActiveStyle : tabStyle} onClick={() => setMode('organize')}>
              整理会话
            </button>
            <button style={mode === 'all' ? tabActiveStyle : tabStyle} onClick={() => setMode('all')}>
              查看全部
            </button>
          </div>

          {/* 会话列表 */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '4px 0' }}>
            {mode === 'organize' ? (
              FOLDERS.map(folder => (
                <div key={folder.name}>
                  <button style={folderStyle} onClick={() => toggleFolder(folder.name)}>
                    <span style={{ fontSize: 10, color: 'var(--color-muted)', marginRight: 4 }}>
                      {expandedFolders.has(folder.name) ? '▾' : '▸'}
                    </span>
                    <span style={{ fontSize: 12 }}>📁</span>
                    <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-primary)' }}>{folder.name}</span>
                    <span style={{ fontSize: 10, color: 'var(--color-muted)', marginLeft: 'auto' }}>{folder.sessions.length}</span>
                  </button>
                  {expandedFolders.has(folder.name) && folder.sessions.map(sid => {
                    const s = SESSIONS.find(ss => ss.id === sid)!
                    return <SessionItem key={sid} session={s} selected={selected === sid} onSelect={setSelected} indent />
                  })}
                </div>
              ))
            ) : (
              SESSIONS.filter(s => !s.deleted).map(s => (
                <SessionItem key={s.id} session={s} selected={selected === s.id} onSelect={setSelected} />
              ))
            )}
          </div>

          {/* 底部状态 */}
          <div style={statusBarStyle}>
            <span>{SESSIONS.filter(s => !s.deleted).length} 个会话</span>
          </div>
        </div>

        {/* 内容区 */}
        <div style={contentStyle}>
          {selectedSession && (
            <>
              <div style={contentHeaderStyle}>
                <h3 style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-bright)' }}>{selectedSession.title}</h3>
                <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 4 }}>
                  {selectedSession.date} · {selectedSession.turns} 轮 ·
                  <span style={{ ...sourceBadgeStyle, background: `color-mix(in srgb, ${selectedSession.sourceColor} 15%, transparent)`, color: selectedSession.sourceColor }}>
                    {selectedSession.source}
                  </span>
                </div>
              </div>
              <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
                {CHAT_MESSAGES.map((m, i) => (
                  <div key={i} style={{ marginBottom: 12 }}>
                    {m.role === 'user' && (
                      <div style={userMsgStyle}>{m.content}</div>
                    )}
                    {m.role === 'assistant' && (
                      <div style={assistantMsgStyle}>
                        {m.content.split('\n').map((line, j) => (
                          <div key={j} style={{ minHeight: line ? undefined : 8 }}>{line}</div>
                        ))}
                      </div>
                    )}
                    {m.role === 'tool' && (
                      <div style={toolMsgStyle}>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>⚡ {m.content}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </DemoShell>
  )
}

function SessionItem({ session, selected, onSelect, indent }: {
  session: typeof SESSIONS[0]
  selected: boolean
  onSelect: (id: string) => void
  indent?: boolean
}) {
  return (
    <button
      style={{
        ...itemStyle,
        paddingLeft: indent ? 28 : 10,
        background: selected ? 'var(--color-surface)' : 'transparent',
        borderLeft: selected ? '2px solid var(--color-accent)' : '2px solid transparent',
      }}
      onClick={() => onSelect(session.id)}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 11, color: 'var(--color-muted)' }}>💬</span>
        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--color-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {session.title}
        </span>
        {session.active && <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-soft-green)', flexShrink: 0 }} />}
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-muted)', marginTop: 2, display: 'flex', gap: 6, alignItems: 'center' }}>
        <span>{session.date}</span>
        <span>{session.turns}轮</span>
        <span style={{ ...sourceBadgeStyle, background: `color-mix(in srgb, ${session.sourceColor} 15%, transparent)`, color: session.sourceColor }}>
          {session.source}
        </span>
      </div>
    </button>
  )
}

const sidebarStyle: React.CSSProperties = {
  width: '38%', minWidth: 180, borderRight: '1px solid var(--color-edge)', display: 'flex', flexDirection: 'column', background: 'var(--color-base)',
}
const tabBarStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, padding: '8px 8px 4px', background: 'var(--color-surface)', margin: '8px 8px 0', borderRadius: 'var(--radius-sm)',
}
const tabStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 500, padding: '5px 0', border: 'none', background: 'transparent', color: 'var(--color-muted)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
}
const tabActiveStyle: React.CSSProperties = {
  ...tabStyle, background: 'var(--color-hover)', color: 'var(--color-primary)',
}
const folderStyle: React.CSSProperties = {
  width: '100%', display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left',
}
const itemStyle: React.CSSProperties = {
  width: '100%', display: 'block', padding: '6px 10px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left', transition: 'background 0.1s',
}
const statusBarStyle: React.CSSProperties = {
  padding: '6px 10px', borderTop: '1px solid var(--color-edge)', fontSize: 10, color: 'var(--color-muted)',
}
const contentStyle: React.CSSProperties = {
  flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0,
}
const contentHeaderStyle: React.CSSProperties = {
  padding: '12px 16px', borderBottom: '1px solid var(--color-edge)',
}
const sourceBadgeStyle: React.CSSProperties = {
  fontSize: 9, fontWeight: 600, padding: '1px 5px', borderRadius: 3,
}
const userMsgStyle: React.CSSProperties = {
  marginLeft: '20%', background: 'var(--color-accent-light)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, lineHeight: 1.5, color: 'var(--color-primary)',
}
const assistantMsgStyle: React.CSSProperties = {
  marginRight: '10%', background: 'var(--color-surface)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 12, lineHeight: 1.6, color: 'var(--color-body)',
}
const toolMsgStyle: React.CSSProperties = {
  padding: '2px 0', color: 'var(--color-faint)',
}
