import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store'
import {
  FolderPlus, FolderOpen, Folder, ChevronRight, ChevronDown,
  MessageSquare, Clock, Trash2, FolderInput, FolderMinus
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

interface ContextMenuState {
  x: number
  y: number
  sessionId: string
}

function ContextMenu({
  x, y, sessionId, onClose
}: ContextMenuState & { onClose: () => void }) {
  const { config, addSessionToFolder, removeSessionFromFolder, selectedFolderId } = useStore()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded-md shadow-xl py-1 min-w-[160px]"
      style={{ left: x, top: y }}
    >
      {/* Move to folder submenu */}
      {config?.folders && config.folders.length > 0 && (
        <>
          <div className="px-3 py-1 text-[11px] text-zinc-500 uppercase tracking-wider">
            添加到文件夹
          </div>
          {config.folders.map((folder) => {
            const isInFolder = folder.sessionIds.includes(sessionId)
            return (
              <button
                key={folder.id}
                onClick={(e) => {
                  e.stopPropagation()
                  if (isInFolder) {
                    removeSessionFromFolder(folder.id, sessionId)
                  } else {
                    addSessionToFolder(folder.id, sessionId)
                  }
                  onClose()
                }}
                className="w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-700 flex items-center gap-2"
              >
                {isInFolder ? (
                  <FolderMinus size={12} className="text-red-400" />
                ) : (
                  <FolderInput size={12} className="text-zinc-400" />
                )}
                <span className={isInFolder ? 'text-red-400' : 'text-zinc-300'}>
                  {isInFolder ? `从 ${folder.name} 移除` : folder.name}
                </span>
              </button>
            )
          })}
        </>
      )}

      {/* Remove from current folder */}
      {selectedFolderId && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            removeSessionFromFolder(selectedFolderId, sessionId)
            onClose()
          }}
          className="w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-700 flex items-center gap-2 text-red-400"
        >
          <FolderMinus size={12} />
          <span>从当前文件夹移除</span>
        </button>
      )}
    </div>
  )
}

export function Sidebar() {
  const {
    sessions, config, selectedSession, selectedFolderId,
    selectSession, selectFolder, createFolder, deleteFolder, renameFolder,
    addSessionToFolder
  } = useStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')

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

  const handleRenameFolder = (folderId: string) => {
    if (renamingValue.trim()) {
      renameFolder(folderId, renamingValue.trim())
    }
    setRenamingFolderId(null)
    setRenamingValue('')
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
                if (renamingFolderId === folder.id) return
                selectFolder(folder.id)
                toggleFolder(folder.id)
              }}
              onDoubleClick={() => {
                setRenamingFolderId(folder.id)
                setRenamingValue(folder.name)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOverFolderId(folder.id)
              }}
              onDragLeave={() => setDragOverFolderId(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOverFolderId(null)
                const sessionId = e.dataTransfer.getData('sessionId')
                if (sessionId) addSessionToFolder(folder.id, sessionId)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu(null) // close session context menu if open
              }}
              className={`w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 group ${
                selectedFolderId === folder.id ? 'bg-zinc-800 text-white' : 'text-zinc-400'
              } ${dragOverFolderId === folder.id ? 'ring-1 ring-blue-500 bg-blue-900/20' : ''}`}
            >
              {expandedFolders.has(folder.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} style={folder.color ? { color: folder.color } : undefined} />
              {renamingFolderId === folder.id ? (
                <input
                  autoFocus
                  value={renamingValue}
                  onChange={(e) => setRenamingValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRenameFolder(folder.id)
                    if (e.key === 'Escape') { setRenamingFolderId(null); setRenamingValue('') }
                  }}
                  onBlur={() => handleRenameFolder(folder.id)}
                  onClick={(e) => e.stopPropagation()}
                  className="flex-1 min-w-0 px-1 py-0 text-sm bg-zinc-700 border border-zinc-500 rounded text-zinc-200 focus:outline-none"
                />
              ) : (
                <span className="truncate flex-1">{folder.name} ({folder.sessionIds.length})</span>
              )}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`删除文件夹 "${folder.name}"？`)) deleteFolder(folder.id)
                }}
                className="hidden group-hover:block p-0.5 hover:text-red-400"
                title="删除文件夹"
              >
                <Trash2 size={12} />
              </button>
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
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('sessionId', session.id)
              }}
              onClick={() => selectSession(session.filePath)}
              onContextMenu={(e) => {
                e.preventDefault()
                setContextMenu({ x: e.clientX, y: e.clientY, sessionId: session.id })
              }}
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

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          {...contextMenu}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
