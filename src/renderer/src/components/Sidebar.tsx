import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useStore, type SessionSummary, type Folder } from '../store'
import {
  FolderPlus, FolderOpen, Folder as FolderIcon, ChevronRight, ChevronDown,
  MessageSquare, Clock, Trash2, FolderInput, FolderMinus, List, FolderTree,
  Plus, Play, Pencil
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

// ============ Context Menu ============

interface ContextMenuState {
  x: number
  y: number
  sessionId: string
}

function ContextMenu({
  x, y, sessionId, onClose, onRename
}: ContextMenuState & { onClose: () => void; onRename: (sessionId: string) => void }) {
  const { config, sessions, addSessionToFolder, removeSessionFromFolder } = useStore()
  // Resolve base sessionId for library folder operations
  const baseSessionId = sessions.find((s) => s.id === sessionId)?.sessionId || sessionId

  useEffect(() => {
    const handler = () => onClose()
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [onClose])

  return (
    <div
      className="fixed z-50 bg-zinc-800 border border-zinc-600 rounded-md shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation()
          onRename(sessionId)
          onClose()
        }}
        className="w-full px-3 py-1.5 text-left text-xs hover:bg-zinc-700 flex items-center gap-2"
      >
        <Pencil size={12} className="text-zinc-400" />
        <span className="text-zinc-300">重命名</span>
      </button>
      {config?.folders && config.folders.length > 0 && (
        <>
          <div className="border-t border-zinc-700 my-1" />
          <div className="px-3 py-1 text-[11px] text-zinc-500 uppercase tracking-wider">
            文件夹
          </div>
          {config.folders.map((folder) => {
            const isInFolder = folder.sessionIds.includes(sessionId) || folder.sessionIds.includes(baseSessionId)
            return (
              <button
                key={folder.id}
                onClick={(e) => {
                  e.stopPropagation()
                  if (isInFolder) removeSessionFromFolder(folder.id, baseSessionId)
                  else addSessionToFolder(folder.id, baseSessionId)
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

// ============ Session Item ============

function SessionItem({
  session,
  depth,
  onContextMenu,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel
}: {
  session: SessionSummary
  depth: number
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  isRenaming?: boolean
  renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameSubmit?: () => void
  onRenameCancel?: () => void
}) {
  const { selectedUniqueId, selectSession, config, resumedSessionIds } = useStore()
  const meta = config?.sessionMeta[session.sessionId] || config?.sessionMeta[session.id]
  const isResumed = resumedSessionIds.has(session.sessionId || session.id)
  const title = meta?.customTitle || session.firstUserMessage || session.id.slice(0, 12)
  const renameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus()
  }, [isRenaming])

  return (
    <button
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-swob', JSON.stringify({
          type: 'session', id: session.id, sessionId: session.sessionId || session.id
        }))
        // For external drop targets: provide the library transcript.md path
        const mdPath = (session as any).libraryMdPath
        if (mdPath) {
          e.dataTransfer.setData('text/plain', mdPath)
          e.dataTransfer.setData('text/uri-list', `file://${mdPath}`)
        } else {
          e.dataTransfer.setData('text/plain', title)
        }
        e.dataTransfer.effectAllowed = 'copyMove'
      }}
      onClick={() => {
        if (!isRenaming) selectSession(
          session.filePath,
          (session as any).allFilePaths,
          session.id,
          (session as any).branchParentFilePaths,
          (session as any).branchPointUuid
        )
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu(e, session.id)
      }}
      className={`w-full py-1.5 pr-3 text-left hover:bg-zinc-800 group ${
        selectedUniqueId === session.id ? 'bg-zinc-800' : ''
      }`}
      style={{ paddingLeft: `${depth * 16 + 12}px` }}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={(e) => onRenameChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameSubmit?.()
            if (e.key === 'Escape') onRenameCancel?.()
          }}
          onBlur={() => onRenameSubmit?.()}
          onClick={(e) => e.stopPropagation()}
          className="w-full text-sm bg-zinc-700 text-zinc-200 rounded px-1 py-0.5 outline-none border border-zinc-500"
        />
      ) : (
        <div className="text-sm text-zinc-200 truncate flex items-center gap-1.5">
          {isResumed && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title="已在终端打开" />}
          <span className="truncate">{title.slice(0, 60)}</span>
        </div>
      )}
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

// ============ Inline New Folder Input ============

function InlineNewFolder({
  depth,
  onSubmit,
  onCancel
}: {
  depth: number
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  return (
    <div style={{ paddingLeft: `${depth * 16 + 12}px` }} className="pr-3 py-1">
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) onSubmit(value.trim())
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => { if (value.trim()) onSubmit(value.trim()); else onCancel() }}
        placeholder="子文件夹名称"
        className="w-full px-2 py-1 text-xs bg-zinc-800 border border-zinc-600 rounded text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-400"
      />
    </div>
  )
}

// ============ Recursive Folder Node ============

function FolderNode({
  folder,
  depth,
  allFolders,
  sessionMap,
  expandedFolders,
  toggleFolder,
  dragOverFolderId,
  dragOverZone,
  setDragOverFolderId,
  setDragOverZone,
  renamingFolderId,
  setRenamingFolderId,
  renamingValue,
  setRenamingValue,
  handleRenameFolder,
  onSessionContextMenu,
  creatingSubfolderId,
  setCreatingSubfolderId,
  renamingSessionId,
  sessionRenameValue,
  onSessionRenameChange,
  onSessionRenameSubmit,
  onSessionRenameCancel
}: {
  folder: Folder
  depth: number
  allFolders: Folder[]
  sessionMap: Map<string, SessionSummary>
  expandedFolders: Set<string>
  toggleFolder: (id: string) => void
  dragOverFolderId: string | null
  dragOverZone: 'inside' | 'before' | 'after'
  setDragOverFolderId: (id: string | null) => void
  setDragOverZone: (zone: 'inside' | 'before' | 'after') => void
  renamingFolderId: string | null
  setRenamingFolderId: (id: string | null) => void
  renamingValue: string
  setRenamingValue: (v: string) => void
  handleRenameFolder: (id: string) => void
  onSessionContextMenu: (e: React.MouseEvent, sessionId: string) => void
  creatingSubfolderId: string | null
  setCreatingSubfolderId: (id: string | null) => void
  renamingSessionId: string | null
  sessionRenameValue: string
  onSessionRenameChange: (v: string) => void
  onSessionRenameSubmit: () => void
  onSessionRenameCancel: () => void
}) {
  const { addSessionToFolder, deleteFolder, createFolder, moveFolder, resumeBatch } = useStore()
  const isExpanded = expandedFolders.has(folder.id)

  // Child folders
  const childFolders = allFolders.filter((f) => f.parentId === folder.id)

  // Direct sessions
  const folderSessions = folder.sessionIds
    .map((id) => sessionMap.get(id))
    .filter(Boolean) as SessionSummary[]

  const totalCount = folderSessions.length + childFolders.reduce((acc, cf) => {
    const cfSessions = cf.sessionIds.length
    return acc + cfSessions
  }, 0)

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const zone = dragOverZone
    setDragOverFolderId(null)
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/x-swob'))
      if (data.type === 'session' && (data.sessionId || data.id)) {
        addSessionToFolder(folder.id, data.sessionId || data.id)
        if (!expandedFolders.has(folder.id)) toggleFolder(folder.id)
      } else if (data.type === 'folder' && data.id && data.id !== folder.id) {
        if (zone === 'inside') {
          // Drop inside: make child of this folder
          moveFolder(data.id, folder.id)
          if (!expandedFolders.has(folder.id)) toggleFolder(folder.id)
        } else {
          // Drop before/after: make sibling (same parent as this folder)
          moveFolder(data.id, folder.parentId ?? null)
        }
      }
    } catch { /* ignore */ }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderId(folder.id)
    // Detect zone: top 25% = before, bottom 25% = after, middle = inside
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    const ratio = y / rect.height
    if (ratio < 0.25) setDragOverZone('before')
    else if (ratio > 0.75) setDragOverZone('after')
    else setDragOverZone('inside')
  }

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        // Only clear if leaving the folder entirely (not entering a child)
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOverFolderId(null)
        }
      }}
      onDrop={handleDrop}
    >
      {/* Folder header */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-swob', JSON.stringify({ type: 'folder', id: folder.id }))
          e.dataTransfer.effectAllowed = 'move'
          e.stopPropagation()
        }}
        onClick={() => {
          if (renamingFolderId === folder.id) return
          toggleFolder(folder.id)
        }}
        onDoubleClick={() => {
          setRenamingFolderId(folder.id)
          setRenamingValue(folder.name)
        }}
        role="button"
        className={`w-full py-1.5 pr-3 flex items-center gap-1.5 text-sm hover:bg-zinc-800 group cursor-pointer select-none relative ${
          dragOverFolderId === folder.id && dragOverZone === 'inside'
            ? 'ring-1 ring-blue-500 bg-blue-900/20'
            : dragOverFolderId === folder.id && dragOverZone === 'before'
              ? 'border-t-2 border-blue-500'
              : dragOverFolderId === folder.id && dragOverZone === 'after'
                ? 'border-b-2 border-blue-500'
                : ''
        } text-zinc-400`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FolderIcon size={14} style={folder.color ? { color: folder.color } : undefined} />
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
            <span className="text-zinc-600 ml-1">({totalCount})</span>
          </span>
        )}
        {/* Batch resume */}
        {folderSessions.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              resumeBatch(folderSessions.map((s) => ({
                sessionId: (s as any).sessionId || s.id,
                permissionMode: (s as any).permissionMode,
                cwd: (s as any).cwds?.[0]
              })))
            }}
            className="hidden group-hover:block p-0.5 hover:text-green-400"
            title={`批量 Resume ${folderSessions.length} 个对话`}
          >
            <Play size={12} />
          </button>
        )}
        {/* Add subfolder button */}
        <button
          onClick={(e) => {
            e.stopPropagation()
            setCreatingSubfolderId(folder.id)
            if (!expandedFolders.has(folder.id)) toggleFolder(folder.id)
          }}
          className="hidden group-hover:block p-0.5 hover:text-blue-400"
          title="新建子文件夹"
        >
          <Plus size={12} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (confirm(`删除文件夹「${folder.name}」？（含子文件夹，不会删除对话）`)) deleteFolder(folder.id)
          }}
          className="hidden group-hover:block p-0.5 hover:text-red-400"
          title="删除文件夹"
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* Expanded content */}
      {isExpanded && (
        <div>
          {/* Inline subfolder creation */}
          {creatingSubfolderId === folder.id && (
            <InlineNewFolder
              depth={depth + 1}
              onSubmit={(name) => {
                createFolder(name, undefined, folder.id)
                setCreatingSubfolderId(null)
              }}
              onCancel={() => setCreatingSubfolderId(null)}
            />
          )}

          {/* Child folders (recursive) */}
          {childFolders.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              allFolders={allFolders}
              sessionMap={sessionMap}
              expandedFolders={expandedFolders}
              toggleFolder={toggleFolder}
              dragOverFolderId={dragOverFolderId}
              dragOverZone={dragOverZone}
              setDragOverFolderId={setDragOverFolderId}
              setDragOverZone={setDragOverZone}
              renamingFolderId={renamingFolderId}
              setRenamingFolderId={setRenamingFolderId}
              renamingValue={renamingValue}
              setRenamingValue={setRenamingValue}
              handleRenameFolder={handleRenameFolder}
              onSessionContextMenu={onSessionContextMenu}
              creatingSubfolderId={creatingSubfolderId}
              setCreatingSubfolderId={setCreatingSubfolderId}
              renamingSessionId={renamingSessionId}
              sessionRenameValue={sessionRenameValue}
              onSessionRenameChange={onSessionRenameChange}
              onSessionRenameSubmit={onSessionRenameSubmit}
              onSessionRenameCancel={onSessionRenameCancel}
            />
          ))}

          {/* Direct sessions */}
          {folderSessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              depth={depth + 1}
              onContextMenu={onSessionContextMenu}
              isRenaming={renamingSessionId === session.id}
              renameValue={sessionRenameValue}
              onRenameChange={onSessionRenameChange}
              onRenameSubmit={onSessionRenameSubmit}
              onRenameCancel={onSessionRenameCancel}
            />
          ))}

          {/* Empty state */}
          {childFolders.length === 0 && folderSessions.length === 0 && creatingSubfolderId !== folder.id && (
            <div
              className="py-2 text-xs text-zinc-600 italic"
              style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}
            >
              拖拽对话到这里
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============ Main Sidebar ============

export function Sidebar({ width }: { width: number }) {
  const {
    sessions, config, createFolder, moveFolder
  } = useStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverZone, setDragOverZone] = useState<'inside' | 'before' | 'after'>('inside')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree')
  const [creatingSubfolderId, setCreatingSubfolderId] = useState<string | null>(null)

  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')

  const { renameFolder, setSessionMeta } = useStore()

  const handleStartRenameSession = useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId)
    const baseId = session?.sessionId || sessionId
    const meta = config?.sessionMeta[baseId] || config?.sessionMeta[sessionId]
    setSessionRenameValue(meta?.customTitle || session?.firstUserMessage || '')
    setRenamingSessionId(sessionId)
  }, [config, sessions])

  const handleSubmitRenameSession = useCallback(() => {
    if (renamingSessionId && sessionRenameValue.trim()) {
      const session = sessions.find((s) => s.id === renamingSessionId)
      const baseId = session?.sessionId || renamingSessionId
      setSessionMeta(baseId, { customTitle: sessionRenameValue.trim() })
    }
    setRenamingSessionId(null)
    setSessionRenameValue('')
  }, [renamingSessionId, sessionRenameValue, setSessionMeta, sessions])

  const handleCancelRenameSession = useCallback(() => {
    setRenamingSessionId(null)
    setSessionRenameValue('')
  }, [])

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }, [])

  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      createFolder(newFolderName.trim())
      setNewFolderName('')
      setShowNewFolder(false)
    }
  }

  const handleRenameFolder = useCallback((folderId: string) => {
    if (renamingValue.trim()) {
      renameFolder(folderId, renamingValue.trim())
    }
    setRenamingFolderId(null)
    setRenamingValue('')
  }, [renamingValue, renameFolder])

  const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
    setContextMenu({ x: e.clientX, y: e.clientY, sessionId })
  }, [])

  // Compute which sessions are in at least one folder (at any depth)
  const groupedSessionIds = useMemo(() => {
    const ids = new Set<string>()
    config?.folders.forEach((f) => f.sessionIds.forEach((id) => ids.add(id)))
    return ids
  }, [config?.folders])

  const ungroupedSessions = useMemo(
    () => sessions.filter((s) => !groupedSessionIds.has(s.id) && !groupedSessionIds.has(s.sessionId)),
    [sessions, groupedSessionIds]
  )

  const sessionMap = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    sessions.forEach((s) => {
      map.set(s.id, s)
      // Also index by sessionId for library folder lookups (which use base sessionId)
      if (s.sessionId && s.sessionId !== s.id && !map.has(s.sessionId)) {
        map.set(s.sessionId, s)
      }
    })
    return map
  }, [sessions])

  // Root-level folders (no parent)
  const rootFolders = useMemo(
    () => (config?.folders || []).filter((f) => !f.parentId),
    [config?.folders]
  )

  return (
    <div className="h-full flex flex-col bg-zinc-900 shrink-0" style={{ width }}>
      {/* Header */}
      <div className="p-3 flex items-center justify-between border-b border-zinc-700">
        <span className="text-sm font-medium text-zinc-300">Sessions</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setViewMode(viewMode === 'tree' ? 'flat' : 'tree')}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
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

      {/* New root folder input */}
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
          <>
            <div className="px-3 py-2 text-[11px] text-zinc-500 uppercase tracking-wider">
              全部对话 ({sessions.length})
            </div>
            {sessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                depth={0}
                onContextMenu={handleContextMenu}
              isRenaming={renamingSessionId === session.id}
              renameValue={sessionRenameValue}
              onRenameChange={setSessionRenameValue}
              onRenameSubmit={handleSubmitRenameSession}
              onRenameCancel={handleCancelRenameSession}
              />
            ))}
          </>
        ) : (
          <>
            {/* Recursive folder tree */}
            {rootFolders.map((folder) => (
              <FolderNode
                key={folder.id}
                folder={folder}
                depth={0}
                allFolders={config?.folders || []}
                sessionMap={sessionMap}
                expandedFolders={expandedFolders}
                toggleFolder={toggleFolder}
                dragOverFolderId={dragOverFolderId}
                dragOverZone={dragOverZone}
                setDragOverFolderId={setDragOverFolderId}
                setDragOverZone={setDragOverZone}
                renamingFolderId={renamingFolderId}
                setRenamingFolderId={setRenamingFolderId}
                renamingValue={renamingValue}
                setRenamingValue={setRenamingValue}
                handleRenameFolder={handleRenameFolder}
                onSessionContextMenu={handleContextMenu}
                creatingSubfolderId={creatingSubfolderId}
                setCreatingSubfolderId={setCreatingSubfolderId}
                renamingSessionId={renamingSessionId}
                sessionRenameValue={sessionRenameValue}
                onSessionRenameChange={setSessionRenameValue}
                onSessionRenameSubmit={handleSubmitRenameSession}
                onSessionRenameCancel={handleCancelRenameSession}
              />
            ))}

            {/* Divider — drop here to make folder root-level */}
            {rootFolders.length > 0 && ungroupedSessions.length > 0 && (
              <div
                className="mx-3 my-2 flex items-center gap-2"
                onDragOver={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  try {
                    const data = JSON.parse(e.dataTransfer.getData('application/x-swob'))
                    if (data.type === 'folder' && data.id) {
                      moveFolder(data.id, null)
                    }
                  } catch { /* ignore */ }
                }}
              >
                <div className="flex-1 border-t border-zinc-700" />
                <span className="text-[10px] text-zinc-600 shrink-0">未分组</span>
                <div className="flex-1 border-t border-zinc-700" />
              </div>
            )}

            {/* Ungrouped */}
            {ungroupedSessions.map((session) => (
              <SessionItem
                key={session.id}
                session={session}
                depth={0}
                onContextMenu={handleContextMenu}
              isRenaming={renamingSessionId === session.id}
              renameValue={sessionRenameValue}
              onRenameChange={setSessionRenameValue}
              onRenameSubmit={handleSubmitRenameSession}
              onRenameCancel={handleCancelRenameSession}
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
          onRename={handleStartRenameSession}
        />
      )}
    </div>
  )
}
