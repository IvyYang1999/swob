import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useStore, type SessionSummary, type Folder } from '../store'
import { useT } from '../i18n'
import {
  FolderPlus, Folder as FolderIcon, ChevronRight, ChevronDown,
  MessageSquare, Clock, Trash2, List, FolderTree,
  Plus, Play, Pencil, GitBranch
} from 'lucide-react'

function formatDate(iso: string, locale: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return t('sidebar.yesterday')
  if (days < 7) return t('sidebar.days_ago', { n: days })
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

// ============ Session Item ============

function SessionItem({
  session, depth, onContextMenu, isRenaming, renameValue,
  onRenameChange, onRenameSubmit, onRenameCancel, onDoubleClickRename
}: {
  session: SessionSummary; depth: number
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  isRenaming?: boolean; renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameSubmit?: () => void; onRenameCancel?: () => void
  onDoubleClickRename?: (sessionId: string) => void
}) {
  const { selectedUniqueId, selectSession, config, activeSessionIds, locale, sessions } = useStore()
  const t = useT()
  const isIntraBranch = session.id.includes(':intra-')
  // Branch: only use its own meta, never fall back to parent's
  const meta = isIntraBranch
    ? config?.sessionMeta[session.id]
    : (config?.sessionMeta[session.sessionId] || config?.sessionMeta[session.id])
  const isActive = activeSessionIds.has(session.sessionId || session.id)
  const branchChildIds = (session as any).branchChildIds as string[] | undefined
  const hasBranchChildren = branchChildIds && branchChildIds.length > 0
  const title = meta?.customTitle || session.firstUserMessage || session.id.slice(0, 12)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const isSelected = selectedUniqueId === session.id

  useEffect(() => {
    if (isRenaming) renameInputRef.current?.focus()
  }, [isRenaming])

  return (
    <button
      data-session-id={session.id}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-swob', JSON.stringify({
          type: 'session', id: session.id, sessionId: session.sessionId || session.id
        }))
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
        if (!isRenaming) {
          // For intra-file branches, look up fresh data from the sessions array
          // (localStorage cache might have stale data without branch fields)
          const fresh = sessions.find((s) => s.id === session.id) || session
          selectSession(
            fresh.filePath,
            (fresh as any).allFilePaths,
            fresh.id,
            (fresh as any).branchParentFilePaths,
            (fresh as any).branchPointUuid,
            (fresh as any).branchLeafUuid
          )
        }
      }}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, session.id) }}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClickRename?.(session.id) }}
      className={`w-full py-1.5 pr-3 text-left hover:bg-zinc-800 group ${
        isSelected ? 'bg-zinc-800 border-l-2 border-blue-500' : ''
      }`}
      style={{ paddingLeft: `${depth * 16 + (isSelected ? 10 : 12)}px` }}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef} value={renameValue}
          onChange={(e) => onRenameChange?.(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRenameSubmit?.(); if (e.key === 'Escape') onRenameCancel?.() }}
          onBlur={() => onRenameSubmit?.()} onClick={(e) => e.stopPropagation()}
          className="w-full text-sm bg-zinc-700 text-zinc-200 rounded px-1 py-0.5 outline-none border border-zinc-500"
        />
      ) : (
        <div className="text-sm text-zinc-200 truncate flex items-center gap-1.5">
          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" title={t('sidebar.opened_in_terminal')} />}
          {isIntraBranch && <GitBranch size={12} className="shrink-0 text-purple-400" />}
          <span className="truncate">{title.slice(0, 60)}</span>
        </div>
      )}
      <div className="flex items-center gap-2 mt-0.5 text-xs text-zinc-500 overflow-hidden">
        <Clock size={10} className="shrink-0" /><span className="whitespace-nowrap">{formatDate(session.updatedAt, locale, t)}</span>
        <MessageSquare size={10} className="shrink-0" /><span className="whitespace-nowrap">{t('sidebar.turns', { n: session.turnCount })}</span>
        {session.compactCount > 0 && (
          <span className="px-1 bg-amber-900/50 text-amber-400 rounded text-[10px] whitespace-nowrap shrink-0">compact</span>
        )}
        {hasBranchChildren && (
          <span className="px-1 bg-purple-900/50 text-purple-400 rounded text-[10px] flex items-center gap-0.5 shrink-0">
            <GitBranch size={9} />{branchChildIds!.length}
          </span>
        )}
      </div>
    </button>
  )
}

// ============ Inline New Folder Input ============

function InlineNewFolder({ depth, onSubmit, onCancel }: {
  depth: number; onSubmit: (name: string) => void; onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const t = useT()
  return (
    <div style={{ paddingLeft: `${depth * 16 + 12}px` }} className="pr-3 py-1">
      <input autoFocus value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) onSubmit(value.trim()); if (e.key === 'Escape') onCancel() }}
        onBlur={() => { if (value.trim()) onSubmit(value.trim()); else onCancel() }}
        placeholder={t('sidebar.subfolder_name')}
        className="w-full px-2 py-1 text-xs bg-zinc-800 border border-zinc-600 rounded text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-400"
      />
    </div>
  )
}

// ============ Recursive Folder Node ============

function FolderNode({
  folder, depth, allFolders, sessionMap, expandedFolders, toggleFolder,
  dragOverFolderId, dragOverZone, setDragOverFolderId, setDragOverZone,
  renamingFolderId, setRenamingFolderId, renamingValue, setRenamingValue,
  handleRenameFolder, onSessionContextMenu, creatingSubfolderId,
  setCreatingSubfolderId, renamingSessionId, sessionRenameValue,
  onSessionRenameChange, onSessionRenameSubmit, onSessionRenameCancel,
  onDoubleClickRenameSession
}: {
  folder: Folder; depth: number; allFolders: Folder[]
  sessionMap: Map<string, SessionSummary>
  expandedFolders: Set<string>; toggleFolder: (id: string) => void
  dragOverFolderId: string | null; dragOverZone: 'inside' | 'before' | 'after'
  setDragOverFolderId: (id: string | null) => void
  setDragOverZone: (zone: 'inside' | 'before' | 'after') => void
  renamingFolderId: string | null; setRenamingFolderId: (id: string | null) => void
  renamingValue: string; setRenamingValue: (v: string) => void
  handleRenameFolder: (id: string) => void
  onSessionContextMenu: (e: React.MouseEvent, sessionId: string) => void
  creatingSubfolderId: string | null; setCreatingSubfolderId: (id: string | null) => void
  renamingSessionId: string | null; sessionRenameValue: string
  onSessionRenameChange: (v: string) => void
  onSessionRenameSubmit: () => void; onSessionRenameCancel: () => void
  onDoubleClickRenameSession: (sessionId: string) => void
}) {
  const { addSessionToFolder, deleteFolder, createFolder, moveFolder, resumeBatch } = useStore()
  const t = useT()
  const isExpanded = expandedFolders.has(folder.id)
  const headerRef = useRef<HTMLDivElement>(null)
  const childFolders = allFolders.filter((f) => f.parentId === folder.id)
  const folderSessions = folder.sessionIds.map((id) => sessionMap.get(id)).filter(Boolean) as SessionSummary[]
  const totalCount = folderSessions.length + childFolders.reduce((acc, cf) => acc + cf.sessionIds.length, 0)

  const handleDrop = (e: React.DragEvent, zone: 'inside' | 'before' | 'after') => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderId(null)
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/x-swob'))
      if (data.type === 'session' && (data.id || data.sessionId)) {
        addSessionToFolder(folder.id, data.id || data.sessionId)
        if (!expandedFolders.has(folder.id)) toggleFolder(folder.id)
      } else if (data.type === 'folder' && data.id && data.id !== folder.id) {
        if (zone === 'inside') {
          moveFolder(data.id, folder.id, 'inside')
          if (!expandedFolders.has(folder.id)) toggleFolder(folder.id)
        } else {
          moveFolder(data.id, folder.parentId ?? null, zone, folder.id)
        }
      }
    } catch { /* ignore */ }
  }

  return (
    <div>
      {/* Folder header — zone detection here */}
      <div
        ref={headerRef} draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('application/x-swob', JSON.stringify({ type: 'folder', id: folder.id }))
          e.dataTransfer.effectAllowed = 'move'
          e.stopPropagation()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDragOverFolderId(folder.id)
          const rect = headerRef.current!.getBoundingClientRect()
          const ratio = (e.clientY - rect.top) / rect.height
          if (ratio < 0.3) setDragOverZone('before')
          else if (ratio > 0.7) setDragOverZone('after')
          else setDragOverZone('inside')
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverFolderId(null)
        }}
        onDrop={(e) => handleDrop(e, dragOverZone)}
        onClick={() => { if (renamingFolderId !== folder.id) toggleFolder(folder.id) }}
        onDoubleClick={() => { setRenamingFolderId(folder.id); setRenamingValue(folder.name) }}
        role="button"
        className={`w-full py-1.5 pr-3 flex items-center gap-1.5 text-sm hover:bg-zinc-800 group cursor-pointer select-none ${
          dragOverFolderId === folder.id && dragOverZone === 'inside' ? 'ring-1 ring-blue-500 bg-blue-900/20'
          : dragOverFolderId === folder.id && dragOverZone === 'before' ? 'border-t-2 border-blue-500'
          : dragOverFolderId === folder.id && dragOverZone === 'after' ? 'border-b-2 border-blue-500'
          : ''
        } text-zinc-400`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FolderIcon size={14} style={folder.color ? { color: folder.color } : undefined} />
        {renamingFolderId === folder.id ? (
          <input autoFocus value={renamingValue}
            onChange={(e) => setRenamingValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameFolder(folder.id); if (e.key === 'Escape') { setRenamingFolderId(null); setRenamingValue('') } }}
            onBlur={() => handleRenameFolder(folder.id)} onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 px-1 py-0 text-sm bg-zinc-700 border border-zinc-500 rounded text-zinc-200 focus:outline-none"
          />
        ) : (
          <span className="truncate flex-1">{folder.name}<span className="text-zinc-600 ml-1">({totalCount})</span></span>
        )}
        {folderSessions.length > 0 && (
          <button onClick={(e) => { e.stopPropagation(); resumeBatch(folderSessions.map((s) => ({ sessionId: (s as any).sessionId || s.id, permissionMode: (s as any).permissionMode, cwd: (s as any).cwds?.[0] }))) }}
            className="hidden group-hover:block p-0.5 hover:text-green-400" title={t('sidebar.batch_resume', { n: folderSessions.length })}><Play size={12} /></button>
        )}
        <button onClick={(e) => { e.stopPropagation(); setCreatingSubfolderId(folder.id); if (!isExpanded) toggleFolder(folder.id) }}
          className="hidden group-hover:block p-0.5 hover:text-blue-400" title={t('sidebar.new_subfolder')}><Plus size={12} /></button>
        <button onClick={(e) => { e.stopPropagation(); if (confirm(t('sidebar.delete_folder', { name: folder.name }))) deleteFolder(folder.id) }}
          className="hidden group-hover:block p-0.5 hover:text-red-400"><Trash2 size={12} /></button>
      </div>

      {/* Expanded content — drop here = "inside" */}
      {isExpanded && (
        <div
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragOverFolderId(folder.id); setDragOverZone('inside') }}
          onDrop={(e) => handleDrop(e, 'inside')}
        >
          {creatingSubfolderId === folder.id && (
            <InlineNewFolder depth={depth + 1}
              onSubmit={(name) => { createFolder(name, undefined, folder.id); setCreatingSubfolderId(null) }}
              onCancel={() => setCreatingSubfolderId(null)} />
          )}
          {childFolders.map((child) => (
            <FolderNode key={child.id} folder={child} depth={depth + 1} allFolders={allFolders}
              sessionMap={sessionMap} expandedFolders={expandedFolders} toggleFolder={toggleFolder}
              dragOverFolderId={dragOverFolderId} dragOverZone={dragOverZone}
              setDragOverFolderId={setDragOverFolderId} setDragOverZone={setDragOverZone}
              renamingFolderId={renamingFolderId} setRenamingFolderId={setRenamingFolderId}
              renamingValue={renamingValue} setRenamingValue={setRenamingValue}
              handleRenameFolder={handleRenameFolder} onSessionContextMenu={onSessionContextMenu}
              creatingSubfolderId={creatingSubfolderId} setCreatingSubfolderId={setCreatingSubfolderId}
              renamingSessionId={renamingSessionId} sessionRenameValue={sessionRenameValue}
              onSessionRenameChange={onSessionRenameChange} onSessionRenameSubmit={onSessionRenameSubmit}
              onSessionRenameCancel={onSessionRenameCancel}
              onDoubleClickRenameSession={onDoubleClickRenameSession} />
          ))}
          {folderSessions.map((session) => (
            <SessionItem key={session.id} session={session} depth={depth + 1}
              onContextMenu={onSessionContextMenu} isRenaming={renamingSessionId === session.id}
              renameValue={sessionRenameValue} onRenameChange={onSessionRenameChange}
              onRenameSubmit={onSessionRenameSubmit} onRenameCancel={onSessionRenameCancel}
              onDoubleClickRename={onDoubleClickRenameSession} />
          ))}
          {childFolders.length === 0 && folderSessions.length === 0 && creatingSubfolderId !== folder.id && (
            <div className="py-2 text-xs text-zinc-600 italic" style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}>
              {t('sidebar.drop_here')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============ Main Sidebar ============

export function Sidebar({ width }: { width: number }) {
  const { sessions, config, createFolder, moveFolder, selectedUniqueId, addSessionToFolder, removeSessionFromFolder } = useStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverZone, setDragOverZone] = useState<'inside' | 'before' | 'after'>('inside')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree')
  const [creatingSubfolderId, setCreatingSubfolderId] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const { renameFolder, setSessionMeta } = useStore()
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // --- Native context menu ---
  const handleContextMenu = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    const session = sessions.find((s) => s.id === sessionId)
    // Use session.id for folder operations — branches have their own identity
    const opId = sessionId
    const folders = (config?.folders || []).map((f) => ({
      id: f.id, name: f.name, parentId: f.parentId || null,
      isIn: f.sessionIds.includes(opId)
    }))
    const result = await window.api.showSessionContextMenu({ sessionId: opId, folders })
    if (!result) return
    if (result.action === 'rename') {
      const s = sessions.find((s) => s.id === sessionId)
      const meta = config?.sessionMeta[sessionId] || config?.sessionMeta[s?.sessionId || '']
      setSessionRenameValue(meta?.customTitle || s?.firstUserMessage || '')
      setRenamingSessionId(sessionId)
    } else if (result.action === 'addToFolder' && result.folderId) {
      addSessionToFolder(result.folderId, opId)
    } else if (result.action === 'removeFromFolder' && result.folderId) {
      removeSessionFromFolder(result.folderId, opId)
    }
  }, [sessions, config, addSessionToFolder, removeSessionFromFolder])

  const handleSubmitRenameSession = useCallback(() => {
    if (renamingSessionId && sessionRenameValue.trim()) {
      // Use session.id directly — branches need their own identity
      setSessionMeta(renamingSessionId, { customTitle: sessionRenameValue.trim() })
    }
    setRenamingSessionId(null); setSessionRenameValue('')
  }, [renamingSessionId, sessionRenameValue, setSessionMeta])

  const handleCancelRenameSession = useCallback(() => { setRenamingSessionId(null); setSessionRenameValue('') }, [])

  const handleDoubleClickRenameSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId)
    // Branch: check own ID first; regular: sessionId === id
    const meta = config?.sessionMeta[sessionId] || config?.sessionMeta[session?.sessionId || '']
    setSessionRenameValue(meta?.customTitle || session?.firstUserMessage || '')
    setRenamingSessionId(sessionId)
  }, [sessions, config])

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders((prev) => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next })
  }, [])

  const handleCreateFolder = () => {
    if (newFolderName.trim()) { createFolder(newFolderName.trim()); setNewFolderName(''); setShowNewFolder(false) }
  }

  const handleRenameFolder = useCallback((folderId: string) => {
    if (renamingValue.trim()) renameFolder(folderId, renamingValue.trim())
    setRenamingFolderId(null); setRenamingValue('')
  }, [renamingValue, renameFolder])

  // --- Auto-expand folders for selected session + scroll to it ---
  useEffect(() => {
    if (!selectedUniqueId || !config?.folders) return
    const session = sessions.find((s) => s.id === selectedUniqueId)
    const baseId = session?.sessionId || selectedUniqueId
    const toExpand = new Set<string>()
    for (const folder of config.folders) {
      if (folder.sessionIds.includes(baseId) || folder.sessionIds.includes(selectedUniqueId)) {
        toExpand.add(folder.id)
        let pid = folder.parentId
        while (pid) { toExpand.add(pid); const p = config.folders.find((f) => f.id === pid); pid = p?.parentId || null }
      }
    }
    if (toExpand.size > 0) {
      setExpandedFolders((prev) => { const next = new Set(prev); for (const id of toExpand) next.add(id); return next })
    }
    setTimeout(() => {
      const el = scrollRef.current?.querySelector(`[data-session-id="${CSS.escape(selectedUniqueId)}"]`)
      if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 50)
  }, [selectedUniqueId])

  // --- Computed ---
  const groupedSessionIds = useMemo(() => {
    const ids = new Set<string>()
    config?.folders.forEach((f) => f.sessionIds.forEach((id) => ids.add(id)))
    return ids
  }, [config?.folders])

  const ungroupedSessions = useMemo(
    () => sessions.filter((s) => {
      // Branch sessions: only check their own id, not the parent's sessionId
      if (s.id.includes(':intra-')) return !groupedSessionIds.has(s.id)
      return !groupedSessionIds.has(s.id) && !groupedSessionIds.has(s.sessionId)
    }),
    [sessions, groupedSessionIds]
  )

  const sessionMap = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    sessions.forEach((s) => { map.set(s.id, s); if (s.sessionId && s.sessionId !== s.id && !map.has(s.sessionId)) map.set(s.sessionId, s) })
    return map
  }, [sessions])

  const rootFolders = useMemo(() => (config?.folders || []).filter((f) => !f.parentId), [config?.folders])

  // --- Auto-scroll during drag ---
  const handleListDragOver = useCallback((e: React.DragEvent) => {
    const el = scrollRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const y = e.clientY - rect.top
    const edge = 40
    if (y < edge) {
      const speed = Math.max(2, (edge - y) / 2)
      if (!scrollTimerRef.current) scrollTimerRef.current = setInterval(() => { el.scrollTop -= speed }, 16)
    } else if (y > rect.height - edge) {
      const speed = Math.max(2, (y - (rect.height - edge)) / 2)
      if (!scrollTimerRef.current) scrollTimerRef.current = setInterval(() => { el.scrollTop += speed }, 16)
    } else if (scrollTimerRef.current) {
      clearInterval(scrollTimerRef.current); scrollTimerRef.current = null
    }
  }, [])

  const stopAutoScroll = useCallback(() => { if (scrollTimerRef.current) { clearInterval(scrollTimerRef.current); scrollTimerRef.current = null } }, [])

  return (
    <div className="h-full flex flex-col bg-zinc-900 shrink-0" style={{ width }}>
      <div className="p-3 flex items-center justify-between border-b border-zinc-700">
        <span className="text-sm font-medium text-zinc-300">{t('sidebar.sessions')}</span>
        <div className="flex items-center gap-1">
          <button onClick={() => setViewMode(viewMode === 'tree' ? 'flat' : 'tree')}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
            title={viewMode === 'tree' ? t('sidebar.timeline_view') : t('sidebar.tree_view')}>
            {viewMode === 'tree' ? <List size={14} /> : <FolderTree size={14} />}
          </button>
          <button onClick={() => setShowNewFolder(true)}
            className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200" title={t('sidebar.new_folder')}>
            <FolderPlus size={14} />
          </button>
        </div>
      </div>

      {showNewFolder && (
        <div className="p-2 border-b border-zinc-700">
          <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName('') } }}
            onBlur={() => { if (newFolderName.trim()) handleCreateFolder(); else setShowNewFolder(false) }}
            placeholder={t('sidebar.folder_name')}
            className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-600 rounded text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-400" />
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto"
        onDragOver={handleListDragOver} onDragLeave={stopAutoScroll} onDrop={stopAutoScroll} onDragEnd={stopAutoScroll}>
        {viewMode === 'flat' ? (
          <>
            <div className="px-3 py-2 text-[11px] text-zinc-500 uppercase tracking-wider">{t('sidebar.all_sessions')} ({sessions.length})</div>
            {sessions.map((session) => (
              <SessionItem key={session.id} session={session} depth={0} onContextMenu={handleContextMenu}
                isRenaming={renamingSessionId === session.id} renameValue={sessionRenameValue}
                onRenameChange={setSessionRenameValue} onRenameSubmit={handleSubmitRenameSession} onRenameCancel={handleCancelRenameSession}
                onDoubleClickRename={handleDoubleClickRenameSession} />
            ))}
          </>
        ) : (
          <>
            {rootFolders.map((folder) => (
              <FolderNode key={folder.id} folder={folder} depth={0} allFolders={config?.folders || []}
                sessionMap={sessionMap} expandedFolders={expandedFolders} toggleFolder={toggleFolder}
                dragOverFolderId={dragOverFolderId} dragOverZone={dragOverZone}
                setDragOverFolderId={setDragOverFolderId} setDragOverZone={setDragOverZone}
                renamingFolderId={renamingFolderId} setRenamingFolderId={setRenamingFolderId}
                renamingValue={renamingValue} setRenamingValue={setRenamingValue}
                handleRenameFolder={handleRenameFolder} onSessionContextMenu={handleContextMenu}
                creatingSubfolderId={creatingSubfolderId} setCreatingSubfolderId={setCreatingSubfolderId}
                renamingSessionId={renamingSessionId} sessionRenameValue={sessionRenameValue}
                onSessionRenameChange={setSessionRenameValue} onSessionRenameSubmit={handleSubmitRenameSession}
                onSessionRenameCancel={handleCancelRenameSession}
                onDoubleClickRenameSession={handleDoubleClickRenameSession} />
            ))}
            {rootFolders.length > 0 && ungroupedSessions.length > 0 && (
              <div className="mx-3 my-2 flex items-center gap-2"
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); try { const d = JSON.parse(e.dataTransfer.getData('application/x-swob')); if (d.type === 'folder' && d.id) moveFolder(d.id, null) } catch {} }}>
                <div className="flex-1 border-t border-zinc-700" />
                <span className="text-[10px] text-zinc-600 shrink-0">{t('sidebar.ungrouped')}</span>
                <div className="flex-1 border-t border-zinc-700" />
              </div>
            )}
            {ungroupedSessions.map((session) => (
              <SessionItem key={session.id} session={session} depth={0} onContextMenu={handleContextMenu}
                isRenaming={renamingSessionId === session.id} renameValue={sessionRenameValue}
                onRenameChange={setSessionRenameValue} onRenameSubmit={handleSubmitRenameSession} onRenameCancel={handleCancelRenameSession}
                onDoubleClickRename={handleDoubleClickRenameSession} />
            ))}
          </>
        )}
      </div>

      <div className="p-2 border-t border-zinc-700 text-[11px] text-zinc-500">
        {t('sidebar.stats', { n: sessions.length, size: `${(sessions.reduce((a, s) => a + s.fileSizeBytes, 0) / 1024 / 1024).toFixed(0)}MB` })}
      </div>
    </div>
  )
}
