import { useState, useMemo, useRef, useEffect, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useStore, type SessionSummary, type Folder, type VaultFile } from '../store'
import { useT } from '../i18n'
import { groupSessionsByLens, type LensDimension, type LensGroup } from '../../../shared/vault-lens'
import {
  FolderPlus, Folder as FolderIcon, ChevronRight, ChevronDown,
  MessageSquare, Clock, Trash2,
  Plus, Play, GitBranch, Cloud,
  FileText, Focus, Tags, CalendarDays, Layers3, Gauge,
  HardDrive, Rows3, WandSparkles, FolderTree, Undo2
} from 'lucide-react'
import { SshConfigModal } from './SshConfigModal'
import { resolveResumeCwd } from '../utils/chat-helpers'
import { OrganizerPanel } from './OrganizerPanel'
import { VaultLocationModal } from './VaultLocationModal'

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

function sortSessionsForView(sessions: readonly SessionSummary[], mode = 'updated'): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    if (mode === 'created') return b.createdAt.localeCompare(a.createdAt)
    if (mode === 'turns') return b.turnCount - a.turnCount || b.updatedAt.localeCompare(a.updatedAt)
    if (mode === 'name') {
      return (a.firstUserMessage || a.id).localeCompare(b.firstUserMessage || b.id, undefined, { numeric: true })
    }
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

function isSingleTurnSession(session: SessionSummary): boolean {
  const bucket = (session as any).ungroupBucket
  if (bucket === 'single') return true
  if (bucket === 'multi') return false
  return session.turnCount <= 1
}

// ============ Session Item ============

function SessionItem({
  session, depth, onContextMenu, isRenaming, renameValue,
  onRenameChange, onRenameSubmit, onRenameCancel, onDoubleClickRename,
  allowDrag = true
}: {
  session: SessionSummary; depth: number
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  isRenaming?: boolean; renameValue?: string
  onRenameChange?: (v: string) => void
  onRenameSubmit?: () => void; onRenameCancel?: () => void
  onDoubleClickRename?: (sessionId: string) => void
  allowDrag?: boolean
}) {
  const { selectedUniqueId, selectSession, config, activeSessionIds, cloudSessionIds, locale, sessions } = useStore()
  const t = useT()
  const isIntraBranch = session.id.includes(':intra-')
  const meta = isIntraBranch
    ? config?.sessionMeta[session.id]
    : (config?.sessionMeta[session.sessionId] || config?.sessionMeta[session.id])
  const isActive = activeSessionIds.has(session.sessionId || session.id)
  const isCloud = cloudSessionIds.has(session.sessionId || session.id)
  const isRemote = !!session.isRemote
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
      draggable={allowDrag && !isRenaming}
      onDragStart={(e) => {
        if (!allowDrag) { e.preventDefault(); return }
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
      className={`w-full py-1.5 pr-3 text-left hover:bg-surface group ${
        isSelected ? 'bg-surface border-l-2 border-accent' : ''
      }`}
      style={{ paddingLeft: `${depth * 16 + (isSelected ? 10 : 12)}px` }}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef} value={renameValue}
          onChange={(e) => onRenameChange?.(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onRenameSubmit?.(); if (e.key === 'Escape') onRenameCancel?.() }}
          onBlur={() => onRenameSubmit?.()} onClick={(e) => e.stopPropagation()}
          className="w-full text-sm bg-hover text-primary rounded px-1 py-0.5 outline-none border border-edge-focus"
        />
      ) : (
        <div className="text-sm text-primary truncate flex items-center gap-1.5">
          <MessageSquare size={12} className="shrink-0 text-muted" aria-label="会话包" />
          {isActive && <span className="w-1.5 h-1.5 rounded-full bg-active shrink-0" title={t('sidebar.opened_in_terminal')} />}
          {isCloud && <span title="iCloud 云端文件，未下载到本地"><Cloud size={11} className="shrink-0 text-soft-blue" /></span>}
          {isRemote && !isCloud && <span title={session.remoteHost ? `来自 ${session.remoteHost}` : '来自其他设备'}><Cloud size={11} className="shrink-0 text-soft-cyan" /></span>}
          {isIntraBranch && <GitBranch size={12} className="shrink-0 text-soft-purple" />}
          <span className="truncate">{title.slice(0, 60)}</span>
        </div>
      )}
      <div className="flex items-center gap-2 mt-0.5 text-xs text-muted overflow-hidden">
        <Clock size={10} className="shrink-0" /><span className="whitespace-nowrap">{formatDate(session.updatedAt, locale, t)}</span>
        <MessageSquare size={10} className="shrink-0" /><span className="whitespace-nowrap">{t('sidebar.turns', { n: session.turnCount })}</span>
        {(!session.source || session.source === 'claude-code') && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-orange/15 text-soft-orange font-medium">CC</span>
        )}
        {session.source === 'codex' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-blue/15 text-soft-blue font-medium">Codex</span>
        )}
        {session.source === 'cursor' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-secondary/10 text-secondary font-medium">Cursor</span>
        )}
        {session.source === 'opencode' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-emerald/15 text-soft-emerald font-medium">OC</span>
        )}
        {session.source === 'zcode' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-cyan/15 text-soft-cyan font-medium">ZC</span>
        )}
        {session.source === 'cc-mirror' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-pink/15 text-soft-pink font-medium">Mirror</span>
        )}
        {session.source === 'antigravity' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-purple/15 text-soft-purple font-medium">AGY</span>
        )}
        {session.source === 'grok' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-secondary/10 text-secondary font-medium">Grok</span>
        )}
        {session.source === 'pi' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-teal/15 text-soft-teal font-medium">Pi</span>
        )}
        {session.source === 'kimi' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-orange/15 text-soft-orange font-medium">Kimi</span>
        )}
        {session.source === 'hermes' && (
          <span className="px-1 rounded text-[10px] whitespace-nowrap shrink-0 bg-soft-purple/15 text-soft-purple font-medium">Hermes</span>
        )}
        {session.compactCount > 0 && (
          <span className="px-1 bg-soft-amber/10 text-soft-amber rounded text-[10px] whitespace-nowrap shrink-0">compact</span>
        )}
        {hasBranchChildren && (
          <span className="px-1 bg-soft-purple/10 text-soft-purple rounded text-[10px] flex items-center gap-0.5 shrink-0">
            <GitBranch size={9} />{branchChildIds!.length}
          </span>
        )}
      </div>
    </button>
  )
}

function VaultFileItem({ file, depth = 0 }: { file: VaultFile; depth?: number }) {
  return (
    <button
      data-vault-file={file.path}
      onClick={() => { void window.api.openPath(file.path) }}
      className="w-full py-1.5 pr-3 flex items-center gap-1.5 text-sm text-secondary hover:text-primary hover:bg-surface text-left"
      style={{ paddingLeft: `${depth * 16 + 12}px` }}
      title={file.path}
    >
      <FileText size={12} className="shrink-0 text-faint" />
      <span className="truncate">{file.name}</span>
    </button>
  )
}

const LENS_DEFINITIONS: Array<{ id: LensDimension; label: string; icon: typeof Focus }> = [
  { id: 'project', label: '项目', icon: Focus },
  { id: 'date', label: '日期', icon: CalendarDays },
  { id: 'tags', label: '标签', icon: Tags },
  { id: 'harness', label: 'harness', icon: Layers3 },
  { id: 'turns', label: '轮数', icon: Gauge },
  { id: 'source', label: '来源', icon: HardDrive },
  { id: 'none', label: '无分组', icon: Rows3 }
]

const LENS_COLOR_CLASSES: Record<LensGroup['color'], string> = {
  blue: 'border-soft-blue bg-soft-blue/5',
  green: 'border-soft-green bg-soft-green/5',
  amber: 'border-soft-amber bg-soft-amber/5',
  purple: 'border-soft-purple bg-soft-purple/5',
  cyan: 'border-soft-cyan bg-soft-cyan/5',
  pink: 'border-soft-pink bg-soft-pink/5',
  orange: 'border-soft-orange bg-soft-orange/5'
}

function LensView({
  dimension, onContextMenu, renamingSessionId, sessionRenameValue,
  onRenameChange, onRenameSubmit, onRenameCancel, onDoubleClickRename
}: {
  dimension: LensDimension
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  renamingSessionId: string | null
  sessionRenameValue: string
  onRenameChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onDoubleClickRename: (sessionId: string) => void
}) {
  const { sessions, config, cloudSessionIds, applyOrganization } = useStore()
  const sortedSessions = useMemo(
    () => sortSessionsForView(sessions, config?.preferences?.defaultSort)
      .filter((session) => config?.preferences?.singleTurnBehavior !== 'hide' || !isSingleTurnSession(session)),
    [sessions, config?.preferences?.defaultSort, config?.preferences?.singleTurnBehavior]
  )
  const groups = useMemo(() => groupSessionsByLens(sortedSessions, dimension, {
    metaBySessionId: config?.sessionMeta || {},
    cloudSessionIds
  }), [sortedSessions, dimension, config?.sessionMeta, cloudSessionIds])

  return (
    <div data-testid="lens-view" className="px-2 pb-3 space-y-3">
      {groups.map((group) => (
        <section key={group.id} data-lens-group={group.id} className="min-w-0">
          <div className={`h-8 px-2 flex items-center gap-2 border-l-2 ${LENS_COLOR_CLASSES[group.color]}`}>
            <span className="text-xs font-medium text-body truncate">{group.label}</span>
            <span className="ml-auto px-1.5 py-0.5 rounded-full text-[10px] bg-surface text-muted">{group.items.length}</span>
            {dimension === 'turns' && group.id === 'single' && group.items.length > 0 && (
              <button
                onClick={() => void applyOrganization('archive', group.items.map((session) => ({
                  sessionId: session.sessionId || session.id,
                  targetRelativeFolder: '归档/单轮会话'
                })))}
                className="text-[10px] text-muted hover:text-primary"
              >
                批量归档
              </button>
            )}
          </div>
          <div className="pt-1">
            {group.items.map((session) => (
              <SessionItem
                key={`${group.id}:${session.id}`}
                session={session}
                depth={0}
                allowDrag={false}
                onContextMenu={onContextMenu}
                isRenaming={renamingSessionId === session.id}
                renameValue={sessionRenameValue}
                onRenameChange={onRenameChange}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
                onDoubleClickRename={onDoubleClickRename}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
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
        className="w-full px-2 py-1 text-xs bg-surface border border-edge-strong rounded text-primary placeholder:text-muted focus:outline-none focus:border-secondary"
      />
    </div>
  )
}

// ============ Virtualized Session List (flat mode) ============

const SESSION_ROW_HEIGHT = 52

function VirtualizedSessionList({
  sessions, scrollRef, onContextMenu, renamingSessionId, sessionRenameValue,
  onRenameChange, onRenameSubmit, onRenameCancel, onDoubleClickRename
}: {
  sessions: SessionSummary[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  onContextMenu: (e: React.MouseEvent, sessionId: string) => void
  renamingSessionId: string | null
  sessionRenameValue: string
  onRenameChange: (v: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onDoubleClickRename: (sessionId: string) => void
}) {
  const t = useT()
  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SESSION_ROW_HEIGHT,
    overscan: 10
  })

  return (
    <>
      <div className="px-3 py-2 text-[11px] text-muted uppercase tracking-wider">
        {t('sidebar.all_sessions')} ({sessions.length})
      </div>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const session = sessions[virtualRow.index]
          return (
            <div
              key={session.id}
              style={{
                position: 'absolute',
                top: virtualRow.start,
                left: 0,
                right: 0,
                height: virtualRow.size
              }}
            >
              <SessionItem
                session={session}
                depth={0}
                onContextMenu={onContextMenu}
                isRenaming={renamingSessionId === session.id}
                renameValue={sessionRenameValue}
                onRenameChange={onRenameChange}
                onRenameSubmit={onRenameSubmit}
                onRenameCancel={onRenameCancel}
                onDoubleClickRename={onDoubleClickRename}
              />
            </div>
          )
        })}
      </div>
    </>
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
  const resumableFolderSessions = folderSessions.filter((s) => s.canResume !== false)
  const blockedResumeCount = folderSessions.length - resumableFolderSessions.length
  const totalCount = folderSessions.length + childFolders.reduce((acc, cf) => acc + cf.sessionIds.length, 0)

  const handleDrop = (e: React.DragEvent, zone: 'inside' | 'before' | 'after') => {
    e.preventDefault()
    e.stopPropagation()
    setDragOverFolderId(null)
    try {
      if (folder.id.startsWith('path-')) return
      const data = JSON.parse(e.dataTransfer.getData('application/x-swob'))
      if (data.type === 'session' && (data.id || data.sessionId)) {
        addSessionToFolder(folder.id, data.sessionId || data.id)
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
      <div
        ref={headerRef} draggable={!folder.id.startsWith('path-')}
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
        className={`w-full py-1.5 pr-3 flex items-center gap-1.5 text-sm hover:bg-surface group cursor-pointer select-none ${
          dragOverFolderId === folder.id && dragOverZone === 'inside' ? 'ring-1 ring-accent bg-soft-blue/8'
          : dragOverFolderId === folder.id && dragOverZone === 'before' ? 'border-t-2 border-accent'
          : dragOverFolderId === folder.id && dragOverZone === 'after' ? 'border-b-2 border-accent'
          : ''
        } text-secondary`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <FolderIcon size={14} style={folder.color ? { color: folder.color } : undefined} />
        {renamingFolderId === folder.id ? (
          <input autoFocus value={renamingValue}
            onChange={(e) => setRenamingValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleRenameFolder(folder.id); if (e.key === 'Escape') { setRenamingFolderId(null); setRenamingValue('') } }}
            onBlur={() => handleRenameFolder(folder.id)} onClick={(e) => e.stopPropagation()}
            className="flex-1 min-w-0 px-1 py-0 text-sm bg-hover border border-edge-focus rounded text-primary focus:outline-none"
          />
        ) : (
          <span className="truncate flex-1">{folder.name}<span className="text-faint ml-1">({totalCount})</span></span>
        )}
        {folderSessions.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              if (resumableFolderSessions.length === 0) return
              resumeBatch(resumableFolderSessions.map((s) => ({ sessionId: (s as any).sessionId || s.id, permissionMode: (s as any).permissionMode, cwd: resolveResumeCwd(s) })))
            }}
            disabled={resumableFolderSessions.length === 0}
            className="hidden group-hover:block p-0.5 hover:text-soft-green disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-secondary"
            title={
              resumableFolderSessions.length === 0
                ? (folderSessions[0]?.resumeUnavailableReason || '此会话无法直接恢复')
                : blockedResumeCount > 0
                  ? `${t('sidebar.batch_resume', { n: resumableFolderSessions.length })}，${blockedResumeCount} 个不可恢复将跳过`
                  : t('sidebar.batch_resume', { n: folderSessions.length })
            }
          ><Play size={12} /></button>
        )}
        {!folder.id.startsWith('path-') && (
          <button onClick={(e) => { e.stopPropagation(); setCreatingSubfolderId(folder.id); if (!isExpanded) toggleFolder(folder.id) }}
            className="hidden group-hover:block p-0.5 hover:text-soft-blue" title={t('sidebar.new_subfolder')}><Plus size={12} /></button>
        )}
        {!folder.id.startsWith('path-') && (
          <button onClick={(e) => { e.stopPropagation(); if (confirm(t('sidebar.delete_folder', { name: folder.name }))) deleteFolder(folder.id) }}
            className="hidden group-hover:block p-0.5 hover:text-soft-red"><Trash2 size={12} /></button>
        )}
      </div>

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
          {(folder.files || []).map((file) => (
            <VaultFileItem key={file.path} file={file} depth={depth + 1} />
          ))}
          {folderSessions.map((session) => (
            <SessionItem key={session.id} session={session} depth={depth + 1}
              onContextMenu={onSessionContextMenu} isRenaming={renamingSessionId === session.id}
              renameValue={sessionRenameValue} onRenameChange={onSessionRenameChange}
              onRenameSubmit={onSessionRenameSubmit} onRenameCancel={onSessionRenameCancel}
              onDoubleClickRename={onDoubleClickRenameSession} />
          ))}
          {childFolders.length === 0 && folderSessions.length === 0 && (folder.files || []).length === 0 && creatingSubfolderId !== folder.id && (
            <div className="py-2 text-xs text-faint italic" style={{ paddingLeft: `${(depth + 1) * 16 + 12}px` }}>
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
  const { sessions, config, createFolder, moveFolder, selectedUniqueId, addSessionToFolder, removeSessionFromFolder, resumeSession, sshConfig, refreshCloudSessions, undoLastOrganization, showToast } = useStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null)
  const [dragOverZone, setDragOverZone] = useState<'inside' | 'before' | 'after'>('inside')
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renamingValue, setRenamingValue] = useState('')
  const [creatingSubfolderId, setCreatingSubfolderId] = useState<string | null>(null)
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
  const [singleTurnExpanded, setSingleTurnExpanded] = useState(false)
  const [sessionRenameValue, setSessionRenameValue] = useState('')
  const { sshModalOpen, openSshModal, closeSshModal } = useStore()
  const [sidebarMode, setSidebarMode] = useState<'folders' | 'lens'>(() => {
    try {
      const saved = localStorage.getItem('swob:sidebar-mode')
      if (saved === 'lens') return 'lens'
      if (saved === 'timeline') return 'lens'
      return 'folders'
    } catch { return 'folders' }
  })
  const lensDefaultApplied = useRef(false)
  const [lensDimension, setLensDimension] = useState<LensDimension>(() => {
    try {
      const savedMode = localStorage.getItem('swob:sidebar-mode')
      if (savedMode === 'timeline') return 'date'
      const saved = localStorage.getItem('swob:lens-dimension') as LensDimension | null
      if (LENS_DEFINITIONS.some((item) => item.id === saved)) {
        lensDefaultApplied.current = true
        return saved!
      }
      return 'date'
    } catch { return 'date' }
  })
  const [organizerKind, setOrganizerKind] = useState<'project' | 'smart' | null>(null)
  const { renameFolder, setSessionMeta } = useStore()
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem('swob:sidebar-mode', sidebarMode)
    } catch { /* renderer storage unavailable */ }
  }, [sidebarMode])

  useEffect(() => {
    if (lensDefaultApplied.current || !config) return
    const defaults: Record<string, LensDimension> = {
      none: 'none', project: 'project', date: 'date', harness: 'harness'
    }
    setLensDimension(defaults[config.preferences?.defaultGrouping || 'none'] || 'none')
    lensDefaultApplied.current = true
  }, [config])

  useEffect(() => {
    if (!lensDefaultApplied.current) return
    try { localStorage.setItem('swob:lens-dimension', lensDimension) } catch { /* renderer storage unavailable */ }
  }, [lensDimension])

  // Initial status read only. Library changes are delivered by the main-process
  // watcher; a periodic renderer poll must not create an O(library) idle cost.
  useEffect(() => {
    void refreshCloudSessions()
  }, [refreshCloudSessions])

  // --- Native context menu ---
  const handleContextMenu = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault()
    const session = sessions.find((s) => s.id === sessionId)
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    const opId = isBranch ? sessionId : (session?.sessionId || sessionId)
    const canResume = !!session && !isBranch && session.canResume !== false
    const folders = (config?.folders || []).map((f) => ({
      id: f.id, name: f.name, parentId: f.parentId || null,
      isIn: f.sessionIds.includes(opId)
    }))
    const result = await window.api.showSessionContextMenu({
      sessionId: opId,
      canResume,
      resumeUnavailableReason: isBranch
        ? t('chat.intra_branch_not_resumable')
        : session?.resumeUnavailableReason,
      folders
    })
    if (!result) return
    if (result.action === 'resume') {
      if (session) {
        resumeSession(opId, session.permissionMode, resolveResumeCwd(session))
      }
    } else if (result.action === 'rename') {
      const s = sessions.find((s) => s.id === sessionId)
      const meta = config?.sessionMeta[sessionId] || config?.sessionMeta[s?.sessionId || '']
      setSessionRenameValue(meta?.customTitle || s?.firstUserMessage || '')
      setRenamingSessionId(sessionId)
    } else if (result.action === 'addToFolder' && result.folderId) {
      addSessionToFolder(result.folderId, opId)
    } else if (result.action === 'removeFromFolder' && result.folderId) {
      removeSessionFromFolder(result.folderId, opId)
    }
  }, [sessions, config, addSessionToFolder, removeSessionFromFolder, resumeSession, t])

  const handleSubmitRenameSession = useCallback(() => {
    if (renamingSessionId && sessionRenameValue.trim()) {
      const isBranch = renamingSessionId.includes(':intra-') || renamingSessionId.includes(':branch-')
      if (isBranch) {
        setSessionMeta(renamingSessionId, { customTitle: sessionRenameValue.trim() })
      } else {
        const session = sessions.find(s => s.id === renamingSessionId)
        setSessionMeta(session?.sessionId || renamingSessionId, { customTitle: sessionRenameValue.trim() })
      }
    }
    setRenamingSessionId(null); setSessionRenameValue('')
  }, [renamingSessionId, sessionRenameValue, setSessionMeta, sessions])

  const handleCancelRenameSession = useCallback(() => { setRenamingSessionId(null); setSessionRenameValue('') }, [])

  const handleDoubleClickRenameSession = useCallback((sessionId: string) => {
    const session = sessions.find(s => s.id === sessionId)
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
  // 「未分组容器」：用户在 preferences.ungrouping 显式配置的容器文件夹（自动整理开关）。
  // 只匹配用户配置的名字，绝不硬编码猜测（曾误伤用户自己的 inbox 文件夹）。
  const ungConfig = (config?.preferences as any)?.ungrouping as
    | { multiTurn?: string; singleTurn?: string }
    | undefined
  const ungroupingFolderIds = useMemo(() => {
    const names = new Set<string>(
      ungConfig ? [ungConfig.multiTurn, ungConfig.singleTurn].filter(Boolean) as string[] : []
    )
    return new Set((config?.folders || []).filter((f) => names.has(f.name)).map((f) => f.id))
  }, [config?.folders, ungConfig])
  // 树渲染用的文件夹列表：剔除未分组容器（用户显式勾选自动整理时才存在）
  const allFolders = useMemo(
    () => (config?.folders || []).filter((f) => !ungroupingFolderIds.has(f.id)),
    [config?.folders, ungroupingFolderIds]
  )
  const rootFolders = useMemo(() => allFolders.filter((f) => !f.parentId), [allFolders])

  // 底部归属按主进程打的物理位置标签 ungroupBucket 判定：
  //   'grouped' = 已在某主题文件夹（只在树里显示）
  //   'multi'/'single' = 在自动整理容器里 → 底部对应区
  //   'root' = 散放根目录的游离会话 → 底部，按 turnCount 分
  const bucketOf = (s: SessionSummary): string | undefined => (s as any).ungroupBucket
  const isBottomSession = (s: SessionSummary): boolean => {
    const b = bucketOf(s)
    if (b === 'grouped') return false
    if (b === 'multi' || b === 'single' || b === 'root') return true
    return !ungConfig
  }
  const isSingleTurn = (s: SessionSummary): boolean => {
    return isSingleTurnSession(s)
  }
  const sortedSessions = useMemo(
    () => sortSessionsForView(sessions, config?.preferences?.defaultSort)
      .filter((session) => config?.preferences?.singleTurnBehavior !== 'hide' || !isSingleTurnSession(session)),
    [sessions, config?.preferences?.defaultSort, config?.preferences?.singleTurnBehavior]
  )
  const singleTurnBehavior = config?.preferences?.singleTurnBehavior || 'collapse'
  const ungroupedSessions = useMemo(
    () => sortedSessions.filter((s) => isBottomSession(s) && !isSingleTurn(s)),
    [sortedSessions, ungConfig]
  )
  const singleTurnSessions = useMemo(
    () => sortedSessions.filter((s) => isBottomSession(s) && isSingleTurn(s)),
    [sortedSessions, ungConfig]
  )

  const sessionMap = useMemo(() => {
    const map = new Map<string, SessionSummary>()
    sortedSessions.forEach((s) => { map.set(s.id, s); if (s.sessionId && s.sessionId !== s.id && !map.has(s.sessionId)) map.set(s.sessionId, s) })
    return map
  }, [sortedSessions])

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

  // Store 的 undoLastOrganization 自带结果 toast，这里直接透传
  const handleUndo = () => { void undoLastOrganization() }

  const [cloudRefreshing, setCloudRefreshing] = useState(false)
  async function handleRefreshCloud() {
    setCloudRefreshing(true)
    await refreshCloudSessions()
    setCloudRefreshing(false)
    const cloudCount = useStore.getState().cloudSessionIds.size
    if (cloudCount > 0) {
      showToast(`发现 ${cloudCount} 个 iCloud 云端会话`, 'info')
    } else {
      showToast('iCloud 状态已刷新，所有会话均在本地', 'success')
    }
  }

  return (
    <div data-testid="sidebar" className="h-full flex flex-col bg-base shrink-0" style={{ width }}>
      {/* ===== Top: Mode switch (the ONLY thing at the very top) ===== */}
      <div className="px-2 pt-2 pb-1 border-b border-edge space-y-1.5">
        <div className="grid grid-cols-2 p-0.5 rounded bg-surface" role="tablist" aria-label="侧边栏模式">
          <button
            role="tab"
            aria-selected={sidebarMode === 'folders'}
            onClick={() => setSidebarMode('folders')}
            className={`py-1 rounded text-[11px] flex items-center justify-center gap-1.5 ${sidebarMode === 'folders' ? 'bg-hover text-primary' : 'text-muted hover:text-secondary'}`}
          >
            <FolderTree size={12} />文件夹
          </button>
          <button
            role="tab"
            aria-selected={sidebarMode === 'lens'}
            onClick={() => setSidebarMode('lens')}
            className={`py-1 rounded text-[11px] flex items-center justify-center gap-1.5 ${sidebarMode === 'lens' ? 'bg-hover text-primary' : 'text-muted hover:text-secondary'}`}
          >
            <Focus size={12} />镜头
          </button>
        </div>
        {sidebarMode === 'lens' && (
          <div className="lens-chip-strip flex gap-1 overflow-x-auto pb-0.5" aria-label="镜头维度">
            {LENS_DEFINITIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setLensDimension(id)}
                className={`shrink-0 px-2 py-1 rounded-full text-[10px] flex items-center gap-1 border ${lensDimension === id ? 'border-accent text-primary bg-soft-purple/10' : 'border-edge text-muted hover:text-secondary'}`}
              >
                <Icon size={10} />{label}
              </button>
            ))}
          </div>
        )}
      </div>

      {sshModalOpen && <SshConfigModal onClose={() => closeSshModal()} />}
      {organizerKind && <OrganizerPanel kind={organizerKind} sidebarWidth={width} onClose={() => setOrganizerKind(null)} />}

      {showNewFolder && (
        <div className="p-2 border-b border-edge">
          <input autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName('') } }}
            onBlur={() => { if (newFolderName.trim()) handleCreateFolder(); else setShowNewFolder(false) }}
            placeholder={t('sidebar.folder_name')}
            className="w-full px-2 py-1 text-sm bg-surface border border-edge-strong rounded text-primary placeholder:text-muted focus:outline-none focus:border-secondary" />
        </div>
      )}

      {/* ===== Main scrollable area ===== */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto"
        onDragOver={handleListDragOver} onDragLeave={stopAutoScroll} onDrop={stopAutoScroll} onDragEnd={stopAutoScroll}>
        {sidebarMode === 'lens' ? (
          <LensView
            dimension={lensDimension}
            onContextMenu={handleContextMenu}
            renamingSessionId={renamingSessionId}
            sessionRenameValue={sessionRenameValue}
            onRenameChange={setSessionRenameValue}
            onRenameSubmit={handleSubmitRenameSession}
            onRenameCancel={handleCancelRenameSession}
            onDoubleClickRename={handleDoubleClickRenameSession}
          />
        ) : (
          <>
            {rootFolders.length === 0 && sortedSessions.length > 0 && (
              <div className="m-3 p-3 border border-edge rounded bg-surface/40">
                <div className="flex items-center gap-2 text-sm text-primary"><WandSparkles size={14} className="text-accent" />开始整理你的会话</div>
                <p className="text-xs text-muted mt-1.5 leading-relaxed">切换到镜头浏览，或一键按项目整理。</p>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => setSidebarMode('lens')} className="text-[11px] text-accent hover:text-primary">用镜头浏览</button>
                  <button onClick={() => setOrganizerKind('project')} className="text-[11px] text-secondary hover:text-primary">按项目整理 →</button>
                </div>
              </div>
            )}
            {rootFolders.map((folder) => (
              <FolderNode key={folder.id} folder={folder} depth={0} allFolders={allFolders}
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
            {(config?.rootFiles || []).map((file) => <VaultFileItem key={file.path} file={file} />)}
            {rootFolders.length > 0 && ungroupedSessions.length > 0 && (
              <div className="mx-3 my-2 flex items-center gap-2"
                onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                onDrop={(e) => { e.preventDefault(); e.stopPropagation(); try { const d = JSON.parse(e.dataTransfer.getData('application/x-swob')); if (d.type === 'folder' && d.id) moveFolder(d.id, null) } catch {} }}>
                <div className="flex-1 border-t border-edge" />
                <span className="text-[10px] text-faint shrink-0">{t('sidebar.ungrouped')}</span>
                <div className="flex-1 border-t border-edge" />
              </div>
            )}
            {ungroupedSessions.map((session) => (
              <SessionItem key={session.id} session={session} depth={0} onContextMenu={handleContextMenu}
                isRenaming={renamingSessionId === session.id} renameValue={sessionRenameValue}
                onRenameChange={setSessionRenameValue} onRenameSubmit={handleSubmitRenameSession} onRenameCancel={handleCancelRenameSession}
                onDoubleClickRename={handleDoubleClickRenameSession} />
            ))}
            {singleTurnSessions.length > 0 && singleTurnBehavior !== 'hide' && (
              <>
                <div className="mx-3 my-2 flex items-center gap-2">
                  <div className="flex-1 border-t border-edge/50" />
                </div>
                <button
                  onClick={() => singleTurnBehavior !== 'show' && setSingleTurnExpanded(!singleTurnExpanded)}
                  className="w-full px-3 py-1.5 flex items-center gap-1.5 text-xs text-muted hover:text-secondary hover:bg-surface/50"
                >
                  {singleTurnBehavior === 'show' || singleTurnExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                  <span>{t('sidebar.single_turn')}</span>
                  <span className="text-faint ml-auto">{singleTurnSessions.length}</span>
                </button>
                {(singleTurnBehavior === 'show' || singleTurnExpanded) && singleTurnSessions.map((session) => (
                  <SessionItem key={session.id} session={session} depth={1} onContextMenu={handleContextMenu}
                    isRenaming={renamingSessionId === session.id} renameValue={sessionRenameValue}
                    onRenameChange={setSessionRenameValue} onRenameSubmit={handleSubmitRenameSession} onRenameCancel={handleCancelRenameSession}
                    onDoubleClickRename={handleDoubleClickRenameSession} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      {/* ===== Bottom status bar ===== */}
      <SidebarFooter
        sessionCount={sessions.length}
        totalBytes={sessions.reduce((a, s) => a + s.fileSizeBytes, 0)}
        onOrganize={setOrganizerKind}
        onNewFolder={() => setShowNewFolder(true)}
        onUndo={handleUndo}
        onRefreshCloud={handleRefreshCloud}
        cloudRefreshing={cloudRefreshing}
        sidebarMode={sidebarMode}
      />
    </div>
  )
}

function SidebarFooter({ sessionCount, totalBytes, onOrganize, onNewFolder, onUndo, onRefreshCloud, cloudRefreshing, sidebarMode }: {
  sessionCount: number; totalBytes: number
  onOrganize: (kind: 'project' | 'smart') => void
  onNewFolder: () => void
  onUndo: () => void
  onRefreshCloud: () => void
  cloudRefreshing: boolean
  sidebarMode: 'folders' | 'lens'
}) {
  const t = useT()
  const [libraryPath, setLibraryPath] = useState<string>('')
  const [locationModalOpen, setLocationModalOpen] = useState(false)

  useEffect(() => {
    (window.api as any).libraryGetConfiguredPath?.().then((p: string) => setLibraryPath(p))
  }, [])

  const shortPath = libraryPath.replace(/^\/Users\/[^/]+/, '~')

  return (
    <div className="border-t border-edge text-[11px] text-muted">
      <div className="px-2 py-1.5 flex items-center justify-between">
        <span>{t('sidebar.stats', { n: sessionCount, size: `${(totalBytes / 1024 / 1024).toFixed(0)}MB` })}</span>
        <div className="flex items-center gap-0.5">
          {sidebarMode === 'folders' && (
            <button onClick={onNewFolder} className="p-1 hover:bg-hover rounded hover:text-primary" title={t('sidebar.new_folder')}>
              <FolderPlus size={12} />
            </button>
          )}
          <button onClick={onRefreshCloud} className="p-1 hover:bg-hover rounded hover:text-primary" title="刷新 iCloud 同步状态">
            <Cloud size={12} className={cloudRefreshing ? 'animate-pulse text-soft-blue' : ''} />
          </button>
          <button onClick={onUndo} className="p-1 hover:bg-hover rounded hover:text-primary" title="撤销最近整理">
            <Undo2 size={12} />
          </button>
          <button onClick={() => onOrganize('project')} className="p-1 hover:bg-hover rounded hover:text-primary" title="按项目整理">
            <FolderIcon size={12} />
          </button>
          <button onClick={() => onOrganize('smart')} className="p-1 hover:bg-hover rounded hover:text-primary" title="智能整理">
            <WandSparkles size={12} />
          </button>
        </div>
      </div>
      {libraryPath && (
        <div
          className="px-2 pb-1.5 flex items-center gap-1 cursor-pointer hover:text-secondary truncate"
          onClick={() => setLocationModalOpen(true)}
          title={`库位置: ${libraryPath}\n点击切换或迁移`}
        >
          <FolderIcon size={10} className="shrink-0" />
          <span className="truncate">{shortPath}</span>
        </div>
      )}
      {locationModalOpen && (
        <VaultLocationModal
          currentPath={libraryPath}
          onClose={() => setLocationModalOpen(false)}
          onPathChanged={setLibraryPath}
        />
      )}
    </div>
  )
}
