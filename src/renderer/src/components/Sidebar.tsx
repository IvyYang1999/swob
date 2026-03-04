import { useState } from 'react'
import { useStore } from '../store'
import {
  FolderPlus, FolderOpen, Folder, ChevronRight, ChevronDown,
  MessageSquare, Clock
} from 'lucide-react'

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function Sidebar() {
  const {
    sessions, config, selectedSession, selectedFolderId,
    selectSession, selectFolder, createFolder
  } = useStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      createFolder(newFolderName.trim())
      setNewFolderName('')
      setShowNewFolder(false)
    }
  }

  const displaySessions = selectedFolderId
    ? sessions.filter((s) => {
        const folder = config?.folders.find((f) => f.id === selectedFolderId)
        return folder?.sessionIds.includes(s.id)
      })
    : sessions

  return (
    <div className="w-60 h-full flex flex-col border-r border-zinc-700 bg-zinc-900 shrink-0">
      {/* Header */}
      <div className="p-3 flex items-center justify-between border-b border-zinc-700">
        <span className="text-sm font-medium text-zinc-300">Sessions</span>
        <button
          onClick={() => setShowNewFolder(true)}
          className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
          title="新建文件夹"
        >
          <FolderPlus size={16} />
        </button>
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="p-2 border-b border-zinc-700">
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder()
              if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName('') }
            }}
            onBlur={() => { if (newFolderName.trim()) handleCreateFolder(); else setShowNewFolder(false) }}
            placeholder="文件夹名称"
            className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-600 rounded text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        {/* All Sessions */}
        <button
          onClick={() => selectFolder(null)}
          className={`w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 ${
            !selectedFolderId ? 'bg-zinc-800 text-white' : 'text-zinc-400'
          }`}
        >
          <FolderOpen size={14} />
          <span>全部 ({sessions.length})</span>
        </button>

        {/* User folders */}
        {config?.folders.map((folder) => (
          <div key={folder.id}>
            <button
              onClick={() => {
                selectFolder(folder.id)
                toggleFolder(folder.id)
              }}
              className={`w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 ${
                selectedFolderId === folder.id ? 'bg-zinc-800 text-white' : 'text-zinc-400'
              }`}
            >
              {expandedFolders.has(folder.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} style={folder.color ? { color: folder.color } : undefined} />
              <span className="truncate">{folder.name} ({folder.sessionIds.length})</span>
            </button>
          </div>
        ))}

        {/* Divider */}
        <div className="mx-3 my-2 border-t border-zinc-700" />

        {/* Session list */}
        {displaySessions.map((session) => {
          const meta = config?.sessionMeta[session.id]
          const title = meta?.customTitle || session.firstUserMessage || session.id.slice(0, 12)
          return (
            <button
              key={session.id}
              onClick={() => selectSession(session.filePath)}
              className={`w-full px-3 py-2 text-left hover:bg-zinc-800 group ${
                selectedSession?.id === session.id ? 'bg-zinc-800' : ''
              }`}
            >
              <div className="text-sm text-zinc-200 truncate">{title.slice(0, 60)}</div>
              <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                <Clock size={10} />
                <span>{formatDate(session.updatedAt)}</span>
                <MessageSquare size={10} />
                <span>{session.turnCount}轮</span>
                {session.compactCount > 0 && (
                  <span className="px-1 bg-amber-900/50 text-amber-400 rounded text-[10px]">
                    compact
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Status bar */}
      <div className="p-2 border-t border-zinc-700 text-[11px] text-zinc-500">
        {sessions.length} sessions · {(sessions.reduce((a, s) => a + s.fileSizeBytes, 0) / 1024 / 1024).toFixed(0)}MB
      </div>
    </div>
  )
}
