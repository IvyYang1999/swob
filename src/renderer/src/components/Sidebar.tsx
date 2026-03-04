import { useState, useMemo, useRef, useEffect } from 'react'
import { useStore, type SessionSummary } from '../store'
import {
  FolderPlus, FolderOpen, Folder, ChevronRight, ChevronDown,
  MessageSquare, Clock, Trash2, FolderInput, FolderMinus, List, FolderTree
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
  const { config, addSessionToFolder, removeSessionFromFolder } = useStore()
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  // Adjust position if menu would go off screen
  const style: React.CSSProperties = { left: x, top: y }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded-md shadow-xl py-1 min-w-[180px]"
      style={style}
    >
      {config?.folders && config.folders.length > 0 && (
        <>
          <div className="px-3 py-1 text-[11px] text-zinc-500 uppercase tracking-wider">
            文件夹
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
                  {isInFolder ? `从「${folder.name}」移除` : `移入「${folder.name}」`}
                </span>
              </button>
            )
          })}
        </>
      )}
      {(!config?.folders || config.folders.length === 0) && (
        <div className="px-3 py-2 text-xs text-zinc-500">
          还没有文件夹，先创建一个吧
        </div>
      )}
    </div>
  )
}

function SessionItem({
  session,
  indent,
  onContextMenu
}: {
  session: SessionSummary
  indent: number
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
}) {
  const { selectedSession, selectSession, config } = useStore()
  const meta = config?.sessionMeta[session.id]
  const title = meta?.customTitle || session.firstUserMessage || session.id.slice(0, 12)

  return (
    <button
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('sessionId', session.id)
      }}
      onClick={() => selectSession(session.filePath)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e, session.id)
      }}
      className={`w-full py-1.5 pr-3 text-left hover:bg-zinc-800 group ${
        selectedSession?.id === session.id ? 'bg-zinc-800' : ''
      }`}
      style={{ paddingLeft: `${indent * 16 + 12}px` }}
    >
      <div className="text-sm text-zinc-200 truncate">{title.slice(0, 60)}</div>
      <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500">
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
}

export function Sidebar() {
  const {
    sessions, config, selectedSession,
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
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree')

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

  const handleContextMenu = (e: React.MouseEvent, sessionId: string) => {
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId })
  }

  // Compute which sessions are in at least one folder
  const groupedSessionIds = useMemo(() => {
    const ids = new Set<string>()
    config?.folders.forEach((f) => f.sessionIds.forEach((id) => ids.add(id)))
    return ids
  }, [config?.folders])

  // Ungrouped sessions: not in any folder
  const ungroupedSessions = useMemo(
    () => sessions.filter((s) => !groupedSessionIds.has(s.id)),
    [sessions, groupedSessionIds]
  )

  // Map session id -> session for quick lookup
  const sessionMap = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    sessions.forEach((s) => map.set(s.id, s))
    return map
  }, [sessions])

  return (
    <div className="w-60 h-full flex flex-col border-r border-zinc-700 bg-zinc-900 shrink-0">
      {/* Header */}
      <div className="p-3 flex items-center justify-between border-b border-zinc-700">
        <span className="text-sm font-medium text-zinc-300">Sessions</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewMode(viewMode === 'tree' ? 'flat' : 'tree')}
            className={`p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200`}
            title={viewMode === 'tree' ? '切换为时间线视图' : '切换为树状视图'}
          >
            {viewMode === 'tree' ? <List size={14} /> : <FolderTree size={14} />}
          </button>
          <button
            onClick={() => setShowNewFolder(true)}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
            title="新建文件夹"
          >
            <FolderPlus size={14} />
          </button>
        </div>
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

        {viewMode === 'flat' ? (
          /* ====== FLAT MODE: all sessions by time ====== */
          <>
            <div className="px-3 py-2 text-[11px] text-zinc-500 uppercase tracking-wider">
              全部对话 ({sessions.length})
            </div>
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                indent={0}
                onContextMenu={handleContextMenu}
              />
            ))}
          </>
        ) : (
          /* ====== TREE MODE: folders with children, then ungrouped ====== */
          <>
            {/* Folders */}
            {config?.folders.map((folder) => {
              const isExpanded = expandedFolders.has(folder.id)
              const folderSessions = folder.sessionIds
                .map((id) => sessionMap.get(id))
                .filter(Boolean) as SessionSummary[]

              return (
                <div key={folder.id}>
                  {/* Folder header */}
                  <button
                    onClick={() => {
                      if (renamingFolderId === folder.id) return
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
                      if (sessionId) {
                        addSessionToFolder(folder.id, sessionId)
                        // Auto-expand the folder when dropping
                        setExpandedFolders((prev) => new Set([...prev, folder.id]))
                      }
                    }}
                    className={`w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 group ${
                      dragOverFolderId === folder.id ? 'ring-1 ring-blue-500 bg-blue-900/20' : ''
                    } text-zinc-400`}
                  >
                    {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
                      <span className="truncate flex-1">
                        {folder.name}
                        <span className="text-zinc-600 ml-1">({folderSessions.length})</span>
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`删除文件夹「${folder.name}」？（不会删除其中的对话）`)) deleteFolder(folder.id)
                      }}
                      className="hidden group-hover:block p-0.5 hover:text-red-400"
                      title="删除文件夹"
                    >
                      <Trash2 size={12} />
                    </button>
                  </button>

                  {/* Folder children */}
                  {isExpanded && folderSessions.length > 0 && (
                    <div>
                      {folderSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          indent={2}
                          onContextMenu={handleContextMenu}
                        />
                      ))}
                    </div>
                  )}
                  {isExpanded && folderSessions.length === 0 && (
                    <div className="pl-10 pr-3 py-2 text-xs text-zinc-600 italic">
                      拖拽对话到这里
                    </div>
                  )}
                </div>
              )
            })}

            {/* Divider between folders and ungrouped */}
            {config?.folders && config.folders.length > 0 && ungroupedSessions.length > 0 && (
              <div className="mx-3 my-2 flex items-center gap-2">
                <div className="flex-1 border-t border-zinc-700" />
                <span className="text-[10px] text-zinc-600 shrink-0">未分组</span>
                <div className="flex-1 border-t border-zinc-700" />
              </div>
            )}

            {/* Ungrouped sessions */}
            {ungroupedSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                indent={0}
                onContextMenu={handleContextMenu}
              />
            ))}
          </>
        )}
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
