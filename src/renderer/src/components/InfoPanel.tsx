import { useState, useMemo, useEffect, useDeferredValue } from 'react'
import { useStore } from '../store'
import type { Highlight } from '../store'
import { translate, useT } from '../i18n'
import { Clock, MessageSquare, FolderOpen, Wrench, Zap, FileText, HardDrive, Image, File, Settings, ExternalLink, ChevronDown, ChevronRight, Pencil, Plus, Eye, Upload, Highlighter, Trash2, GitBranch, Copy, Check, Coins } from 'lucide-react'
import { SessionFamilyTree } from './SessionFamilyTree'
import { ExecutionTreePanel } from './ExecutionTreePanel'
import { ContextInspectorPanel } from './ContextInspectorPanel'
import { SessionAuditPanel } from './SessionAuditPanel'
import { InspectorTabs, DisclosureSection } from './inspector'
import type { InspectorTab } from './inspector'
import { getHarnessPresentation } from '../utils/harness-presentation'

// --- Shared types & utilities ---

interface FileRef {
  path: string
  actions: string[]
  exists: boolean
}

interface TreeNode {
  name: string
  fullPath: string
  children: Map<string, TreeNode>
  file?: FileRef
}

function formatDateTime(iso: string, locale: string = 'zh-CN'): string {
  return new Date(iso).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function formatTokenShort(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return '<1m'
  const totalMinutes = Math.max(1, Math.round(ms / 60_000))
  if (totalMinutes < 60) return `${totalMinutes}m`
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  return m > 0 ? `${h}h${m}m` : `${h}h`
}

// --- Shared sub-components ---

function ClickablePath({ path, isDir, dimmed }: { path: string; isDir?: boolean; dimmed?: boolean }) {
  const t = useT()
  const short = path.replace(/^\/Users\/[^/]+/, '~')
  const fileName = path.split('/').pop() || path

  return (
    <div
      className={`flex items-center gap-1.5 text-xs font-mono truncate cursor-pointer group ${
        dimmed ? 'text-faint line-through' : 'text-secondary hover:text-soft-blue'
      }`}
      title={`${path}\n${dimmed ? t('info.file_deleted') + ' ' : ''}${t('info.file_click_hint')}`}
      onClick={() => window.api.openPath(path)}
      onContextMenu={(e) => {
        e.preventDefault()
        window.api.showItemInFolder(path)
      }}
    >
      <ExternalLink size={10} className="shrink-0 opacity-0 group-hover:opacity-100" />
      <span className="truncate">{isDir ? short : fileName}</span>
    </div>
  )
}

function ActionBadge({ action }: { action: string }) {
  const t = useT()
  const config: Record<string, { label: string; color: string }> = {
    'write': { label: t('info.action_write'), color: 'bg-soft-green/15 text-soft-green' },
    'edit': { label: t('info.action_edit'), color: 'bg-soft-blue/15 text-soft-blue' },
    'read': { label: t('info.action_read'), color: 'bg-hover text-secondary' },
    'user-image': { label: t('info.action_upload'), color: 'bg-soft-purple/15 text-soft-purple' },
    'user-input': { label: t('info.action_user'), color: 'bg-soft-amber/15 text-soft-amber' },
  }
  const c = config[action] || { label: action, color: 'bg-hover text-secondary' }
  return (
    <span className={`px-1 py-0.5 rounded text-[9px] leading-none ${c.color}`}>
      {c.label}
    </span>
  )
}

function ActionIcon({ action }: { action: string }) {
  const size = 10
  switch (action) {
    case 'write': return <Plus size={size} className="text-soft-green shrink-0" />
    case 'edit': return <Pencil size={size} className="text-soft-blue shrink-0" />
    case 'read': return <Eye size={size} className="text-muted shrink-0" />
    case 'user-image': return <Upload size={size} className="text-soft-purple shrink-0" />
    case 'user-input': return <Upload size={size} className="text-soft-amber shrink-0" />
    default: return null
  }
}

// --- File tree building ---

function buildFileTree(files: FileRef[], basePath?: string): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: new Map() }
  const normalizedBase = basePath?.replace(/\/+$/, '')

  for (const f of files) {
    const displayPath = normalizedBase && f.path.startsWith(`${normalizedBase}/`)
      ? f.path.slice(normalizedBase.length + 1)
      : f.path
    const parts = displayPath.split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          fullPath: `${normalizedBase || ''}/${parts.slice(0, i + 1).join('/')}`,
          children: new Map()
        })
      }
      node = node.children.get(part)!
    }
    node.file = f
  }

  function collapse(node: TreeNode): TreeNode {
    for (const [key, child] of node.children) {
      node.children.set(key, collapse(child))
    }
    if (node.children.size === 1 && !node.file && node.name !== '') {
      const [, child] = [...node.children.entries()][0]
      return {
        name: node.name + '/' + child.name,
        fullPath: child.fullPath,
        children: child.children,
        file: child.file
      }
    }
    return node
  }

  return collapse(root)
}

function FileTreeNode({ node, depth = 0 }: { node: TreeNode; depth?: number }) {
  const t = useT()
  const [open, setOpen] = useState(true)
  const isLeaf = node.children.size === 0 && node.file
  const hasChildren = node.children.size > 0

  if (isLeaf && node.file) {
    const f = node.file
    const primaryAction = f.actions.includes('write') ? 'write'
      : f.actions.includes('edit') ? 'edit'
      : f.actions.includes('user-image') ? 'user-image'
      : f.actions.includes('user-input') ? 'user-input'
      : 'read'

    return (
      <div
        className={`flex items-center gap-1 text-xs font-mono truncate cursor-pointer group ${
          f.exists ? 'text-secondary hover:text-soft-blue' : 'text-faint line-through'
        }`}
        style={{ paddingLeft: depth * 12 }}
        title={`${f.path}\n${t('info.file_actions', { actions: f.actions.join(', ') })}${f.exists ? '' : '\n' + t('info.file_deleted')}\n${t('info.file_click_hint')}`}
        onClick={() => window.api.openPath(f.path)}
        onContextMenu={(e) => {
          e.preventDefault()
          window.api.showItemInFolder(f.path)
        }}
      >
        <ActionIcon action={primaryAction} />
        <span className="truncate">{node.name}</span>
        <div className="flex gap-0.5 shrink-0 ml-auto">
          {f.actions.map(a => <ActionBadge key={a} action={a} />)}
        </div>
      </div>
    )
  }

  if (hasChildren) {
    const sortedChildren = [...node.children.values()].sort((a, b) => {
      const aIsDir = a.children.size > 0
      const bIsDir = b.children.size > 0
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return (
      <div>
        {node.name && (
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1 text-xs text-muted hover:text-body w-full font-mono"
            style={{ paddingLeft: depth * 12 }}
          >
            {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            <FolderOpen size={10} className="shrink-0" />
            <span className="truncate">{node.name}</span>
          </button>
        )}
        {open && sortedChildren.map(child => (
          <FileTreeNode key={child.fullPath} node={child} depth={node.name ? depth + 1 : depth} />
        ))}
      </div>
    )
  }

  return null
}

// --- CollapsibleFileList ---

function CollapsibleFileList({
  icon: Icon, label, paths, isDir, defaultOpen = true, maxShow = 5
}: {
  icon: React.ComponentType<{ size: number }>
  label: string
  paths: string[]
  isDir?: boolean
  defaultOpen?: boolean
  maxShow?: number
}) {
  const t = useT()
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)

  if (paths.length === 0) return null

  const displayed = showAll ? paths : paths.slice(0, maxShow)
  const hasMore = paths.length > maxShow

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-secondary mb-2 hover:text-body w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Icon size={12} />
        <span>{label}</span>
        <span className="text-faint ml-auto">{paths.length}</span>
      </button>
      {open && (
        <div className="space-y-1 ml-1">
          {displayed.map((p) => (
            <ClickablePath key={p} path={p} isDir={isDir} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="text-[11px] text-faint hover:text-secondary ml-3"
            >
              {t('info.show_more', { n: paths.length - maxShow })}
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// --- ImageThumb / ImageGallery ---

interface ImageEntry {
  src: string | null
  turnUuid: string
  originalPath?: string
  isPasted: boolean
  status: 'exists' | 'cached' | 'missing' | 'loading'
}

function ImageThumb({ entry, onClick, onContextMenu }: { entry: ImageEntry; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void }) {
  const [lightbox, setLightbox] = useState(false)
  const locale = useStore((s) => s.locale)
  const shortPath = entry.originalPath?.replace(/^\/Users\/[^/]+/, '~') || ''
  const fileName = entry.originalPath?.split('/').pop() || ''

  return (
    <>
      <div
        className="relative group cursor-pointer rounded overflow-hidden bg-surface"
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        {entry.src ? (
          <img
            src={entry.src}
            className="w-full aspect-square object-cover rounded hover:opacity-90 transition-opacity"
            onDoubleClick={(e) => { e.stopPropagation(); setLightbox(true) }}
          />
        ) : (
          <div className="w-full aspect-square flex items-center justify-center bg-surface text-faint text-[10px] p-1 text-center leading-tight">
            {entry.status === 'loading' ? '...' : entry.status === 'missing' ? (
              <span title={shortPath}>{fileName || '?'}<br /><span className="text-soft-red">{translate(locale, 'renderer.info_panel.moved')}</span></span>
            ) : '?'}
          </div>
        )}
        <div className="absolute bottom-0 left-0 right-0 bg-black/50 text-[9px] text-white px-1 py-0.5 truncate opacity-0 group-hover:opacity-100 transition-opacity">
          {entry.isPasted ? (translate(locale, 'renderer.info_panel.pasted')) : fileName}
        </div>
        {entry.originalPath && entry.status === 'cached' && (
          <div className="absolute top-0.5 right-0.5 bg-soft-amber/80 text-[8px] text-white px-1 rounded">{translate(locale, 'renderer.info_panel.cache')}</div>
        )}
      </div>
      {lightbox && entry.src && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-zoom-out" onClick={() => setLightbox(false)}>
          <img src={entry.src} className="max-h-[90vh] max-w-[90vw] object-contain rounded-lg" />
        </div>
      )}
    </>
  )
}

function useSessionImages(messages: Array<{ uuid: string; type: string; timestamp: string; images: string[]; textContent: string }>) {
  const [entries, setEntries] = useState<ImageEntry[]>([])

  useEffect(() => {
    const collected: ImageEntry[] = []
    const filePathsToLoad: Array<{ idx: number; path: string }> = []
    const timestampsWithPaths = new Set<string>()

    for (const msg of messages) {
      if (msg.type !== 'user') continue
      const paths = [...msg.textContent.matchAll(/\[Image: source: ([^\]]+)\]/g)]
      if (paths.length === 0) continue
      timestampsWithPaths.add(msg.timestamp)
      const imageMsg = messages.find(m => m.type === 'user' && m.uuid !== msg.uuid && m.images.length > 0 && m.timestamp === msg.timestamp)
      const navUuid = imageMsg?.uuid || msg.uuid
      for (let i = 0; i < paths.length; i++) {
        const filePath = paths[i][1].trim()
        const idx = collected.length
        collected.push({ src: imageMsg?.images[i] || null, turnUuid: navUuid, originalPath: filePath, isPasted: false, status: 'loading' })
        filePathsToLoad.push({ idx, path: filePath })
      }
    }

    for (const msg of messages) {
      if (msg.type !== 'user' || msg.images.length === 0) continue
      if (timestampsWithPaths.has(msg.timestamp)) continue
      for (const src of msg.images) {
        collected.push({ src, turnUuid: msg.uuid, isPasted: true, status: 'exists' })
      }
    }

    setEntries(collected)

    for (const { idx, path: fp } of filePathsToLoad) {
      ;(window as any).api.loadImage(fp).then((result: { dataUrl: string | null; status: string }) => {
        setEntries(prev => {
          const next = [...prev]
          next[idx] = { ...next[idx], src: result.dataUrl || next[idx].src, status: result.status as ImageEntry['status'] }
          return next
        })
      })
    }
  }, [messages])

  return entries
}

function ImageGallery({ messages, onNavigate, defaultOpen = true }: {
  messages: Array<{ uuid: string; type: string; timestamp: string; images: string[]; textContent: string }>
  onNavigate: (turnUuid: string) => void
  defaultOpen?: boolean
}) {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const [open, setOpen] = useState(defaultOpen)
  const entries = useSessionImages(messages)

  if (entries.length === 0) return null

  const handleContextMenu = (entry: ImageEntry) => (e: React.MouseEvent) => {
    e.preventDefault()
    if (!entry.originalPath) return
    ;(window as any).api.showImageContextMenu({ path: entry.originalPath })
  }

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-secondary mb-2 hover:text-body w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Image size={12} />
        <span>{t('info.uploaded_images')}</span>
        <span className="text-faint ml-auto">{entries.length}</span>
      </button>
      {open && (
        <div className="grid grid-cols-3 gap-1.5">
          {entries.map((entry, i) => (
            <ImageThumb
              key={i}
              entry={entry}
              onClick={() => onNavigate(entry.turnUuid)}
              onContextMenu={handleContextMenu(entry)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

// --- FileTreeSection ---

function FileTreeSection({ files }: { files: FileRef[] }) {
  const t = useT()
  const [open, setOpen] = useState(true)

  const tree = useMemo(() => buildFileTree(files), [files])

  if (files.length === 0) return null

  const existCount = files.filter(f => f.exists).length
  const deletedCount = files.length - existCount

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-secondary mb-2 hover:text-body w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <File size={12} />
        <span>{t('info.files_operated')}</span>
        <span className="text-faint ml-auto">
          {existCount}{deletedCount > 0 && <span className="text-edge">+{deletedCount}</span>}
        </span>
      </button>
      {open && (
        <div className="space-y-0.5 ml-1">
          <FileTreeNode node={tree} />
        </div>
      )}
    </section>
  )
}

function CwdFileTree({ cwd, files }: { cwd: string; files: FileRef[] }) {
  const basePath = files.every((file) => file.path.startsWith(`${cwd.replace(/\/+$/, '')}/`))
    ? cwd
    : undefined
  const tree = useMemo(() => buildFileTree(files, basePath), [basePath, files])

  return (
    <div className="space-y-0.5 ml-1" data-testid="cwd-file-tree">
      <FileTreeNode node={tree} />
    </div>
  )
}

// --- HighlightList ---

function HighlightList({ highlights, sessionId, defaultOpen = true }: { highlights: Highlight[]; sessionId: string; defaultOpen?: boolean }) {
  const { removeHighlight } = useStore()
  const t = useT()
  const locale = useStore((s) => s.locale)
  const [open, setOpen] = useState(defaultOpen)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  if (highlights.length === 0) return null

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-secondary mb-2 hover:text-body w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Highlighter size={12} className="text-soft-green" />
        <span>{t('info.highlights')}</span>
        <span className="text-faint ml-auto">{highlights.length}</span>
      </button>
      {open && (
        <div className="space-y-1.5">
          {highlights.map((hl) => (
            <div
              key={hl.id}
              className="group relative px-2 py-1.5 rounded bg-soft-green/6 border border-soft-green/12 hover:border-soft-green/25 cursor-pointer transition-colors"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('swob:scrollToHighlight', { detail: { highlightId: hl.id } }))
              }}
              title={t('info.highlight_jump')}
            >
              <div className="text-xs text-soft-green/80 line-clamp-3 leading-relaxed border-l-2 border-soft-green/40 pl-2">
                {hl.text}
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-faint">
                  {new Date(hl.createdAt).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      navigator.clipboard.writeText(hl.text)
                      setCopiedId(hl.id)
                      setTimeout(() => setCopiedId(null), 1500)
                    }}
                    className="opacity-0 group-hover:opacity-100 text-faint hover:text-soft-green transition-opacity p-0.5"
                    title={t('info.highlight_copy')}
                  >
                    {copiedId === hl.id ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      removeHighlight(sessionId, hl.id)
                    }}
                    className="opacity-0 group-hover:opacity-100 text-faint hover:text-soft-red transition-opacity p-0.5"
                    title={t('info.highlight_delete')}
                  >
                    <Trash2 size={10} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

// --- Branch Relationships ---

function BranchRelationships({ session }: { session: any }) {
  const locale = useStore((s) => s.locale)
  const { sessions, config, openSession } = useStore()

  const branchParentId = session.branchParentId as string | undefined
  const branchChildIds = session.branchChildIds as string[] | undefined
  const isIntraBranch = !!session.branchLeafUuid
  const isForkBranch = !!branchParentId && !isIntraBranch
  const hasBranches = (branchChildIds && branchChildIds.length > 0) || isIntraBranch || isForkBranch

  if (!hasBranches) return null

  return (
    <section>
      <div className="flex items-center gap-2 text-xs font-medium text-soft-purple mb-2">
        <GitBranch size={12} />
        <span>{translate(locale, 'renderer.info_panel.branch_tree')}</span>
      </div>
      <div className="space-y-1.5">
        {branchParentId && (() => {
          const parent = sessions.find((ps) => ps.id === branchParentId)
          if (!parent) return null
          const pMeta = config?.sessionMeta?.[parent.sessionId] || config?.sessionMeta?.[parent.id]
          const pTitle = pMeta?.customTitle || parent.firstUserMessage?.slice(0, 40) || parent.id.slice(0, 12)
          return (
            <button
              key="parent"
              onClick={() => openSession(parent.id)}
              className="w-full text-left text-xs px-2 py-1.5 rounded bg-surface/50 hover:bg-surface transition-colors"
            >
              <div className="text-soft-purple/60 text-[10px] mb-0.5">{translate(locale, 'renderer.info_panel.parent')}</div>
              <div className="text-body truncate">{pTitle}</div>
              <div className="text-muted text-[10px] mt-0.5">{parent.turnCount} {translate(locale, 'renderer.info_panel.turns')}</div>
            </button>
          )
        })()}
        {isForkBranch && (
          <div className="px-2 py-1 text-[10px] text-soft-blue/60 border-l-2 border-soft-blue/30 ml-1">
            ● {translate(locale, 'renderer.info_panel.current_fork_can_resume_independently')}
          </div>
        )}
        {!isIntraBranch && !isForkBranch && (
          <div className="px-2 py-1 text-[10px] text-soft-emerald/60 border-l-2 border-soft-emerald/30 ml-1">
            ● {translate(locale, 'renderer.info_panel.current_main')}
          </div>
        )}
        {isIntraBranch && (
          <div className="px-2 py-1 text-[10px] text-soft-purple/60 border-l-2 border-soft-purple/30 ml-1">
            ● {translate(locale, 'renderer.info_panel.current_branch')}
          </div>
        )}
        {branchChildIds && branchChildIds.length > 0 && branchChildIds.map((childId) => {
          const child = sessions.find((cs) => cs.id === childId)
          if (!child) return null
          const cMeta = config?.sessionMeta?.[child.sessionId] || config?.sessionMeta?.[child.id]
          const cTitle = cMeta?.customTitle || child.firstUserMessage?.slice(0, 40) || child.id.slice(0, 12)
          return (
            <button
              key={childId}
              onClick={() => openSession(child.id)}
              className="w-full text-left text-xs px-2 py-1.5 rounded bg-surface/50 hover:bg-surface transition-colors"
            >
              <div className="text-soft-purple/60 text-[10px] mb-0.5">↳ {translate(locale, 'renderer.info_panel.child_branch')}</div>
              <div className="text-body truncate">{cTitle}</div>
              <div className="text-muted text-[10px] mt-0.5">{child.turnCount} {translate(locale, 'renderer.info_panel.turns')}</div>
            </button>
          )
        })}
      </div>
      <div className="mt-2 px-2 py-1.5 rounded bg-surface/30 text-[10px] text-muted leading-relaxed">
        {isForkBranch ? (
          <>
            <span className="text-secondary">{translate(locale, 'renderer.info_panel.fork_branch')}</span>
            {translate(locale, 'renderer.info_panel.fork_created_via')}
            <code className="text-soft-purple/80">/branch</code>
            {translate(locale, 'renderer.info_panel.or')}
            <code className="text-soft-purple/80">/fork</code>
            {translate(locale, 'renderer.info_panel.fork_can_resume')}
          </>
        ) : (
          <>
            <span className="text-secondary">{translate(locale, 'renderer.info_panel.main_session')}</span>
            {translate(locale, 'renderer.info_panel.main_session_explanation')}
            <br />
            <span className="text-secondary">{translate(locale, 'renderer.info_panel.resume_limitation')}</span>
            {translate(locale, 'renderer.info_panel.resume_limitation_prefix')}
            <code className="text-soft-purple/80">claude --resume</code>
            {translate(locale, 'renderer.info_panel.resume_limitation_explanation')}
          </>
        )}
      </div>
    </section>
  )
}

// ===================================================================
// Compact Session Info Card (always visible, replaces old Details tab)
// ===================================================================

function SessionInfoCard({ session }: { session: any }) {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const s = session
  const hp = getHarnessPresentation(s.source)
  const wallClockMs = new Date(s.updatedAt).getTime() - new Date(s.createdAt).getTime()
  const duration = formatDurationShort(s.estimatedTime ?? wallClockMs)
  const shortCwd = s.cwds?.[0]?.replace(/^\/Users\/[^/]+/, '~') || ''
  const modelLabel = s.models?.filter(Boolean).join(', ') || ''

  const hasTokens = s.tokenUsage && (
    s.tokenUsage.inputTokens > 0 || s.tokenUsage.outputTokens > 0 ||
    s.tokenUsage.cacheCreationTokens > 0 || s.tokenUsage.cacheReadTokens > 0
  )
  const tokenUnavailable = s.tokenAccounting?.provenance === 'unavailable'

  return (
    <section className="rounded bg-surface/60 border border-edge px-3 py-2.5 space-y-2">
      {/* Row 1: source badge + model + turn count + duration */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${hp.badgeClass}`}>
          {hp.shortLabel}
        </span>
        {modelLabel && (
          <span className="max-w-full truncate text-secondary font-mono" title={modelLabel}>
            {modelLabel}
          </span>
        )}
        <span className="text-secondary">{s.turnCount} {t('renderer.info_panel.turns')}</span>
        <span className="text-muted">{duration}</span>
        {s.compactCount > 0 && (
          <span className="text-soft-amber text-[10px]">compact {s.compactCount}x</span>
        )}
      </div>

      {/* Row 2: tokens */}
      <div
        className="text-[11px]"
        title={tokenUnavailable ? s.tokenAccounting?.unavailableReason : undefined}
      >
        {tokenUnavailable ? (
          <span className="text-muted">{translate(locale, 'renderer.info_panel.tokens_unavailable')}</span>
        ) : hasTokens ? (
          <span className="text-secondary">
            {formatTokenShort(s.tokenUsage.inputTokens + s.tokenUsage.cacheCreationTokens + s.tokenUsage.cacheReadTokens)} in / {formatTokenShort(s.tokenUsage.outputTokens)} out
            {s.tokenUsage.cacheReadTokens > 0 && <span className="text-faint ml-1">({formatTokenShort(s.tokenUsage.cacheReadTokens)} cached)</span>}
          </span>
        ) : (
          <span className="text-muted">{formatSize(s.fileSizeBytes)}</span>
        )}
      </div>

      {/* Row 3: project path */}
      {shortCwd && (
        <div
          className="text-[10px] text-muted font-mono truncate cursor-pointer hover:text-soft-blue"
          title={s.cwds?.[0]}
          onClick={() => { if (s.cwds?.[0]) window.api.openPath(s.cwds[0]) }}
        >
          {shortCwd}
        </div>
      )}
    </section>
  )
}

// ===================================================================
// Tab 1: Files
// ===================================================================

function FilesTab({ session, onNavigate }: {
  session: any
  onNavigate?: (id: string) => void
}) {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const s = session
  const referencedFiles: FileRef[] = s.referencedFiles || []
  const nonImageFiles = referencedFiles.filter((f: FileRef) => !f.actions.includes('user-image'))

  // Group files by cwd
  const cwdFileGroups = useMemo(() => {
    if (s.cwds.length === 0 && nonImageFiles.length === 0) return []

    const groups: Array<{ cwd: string; files: FileRef[] }> = []
    for (const cwd of s.cwds) {
      const cwdFiles = nonImageFiles.filter((f: FileRef) => f.path.startsWith(cwd + '/'))
      groups.push({ cwd, files: cwdFiles })
    }

    // Files not under any cwd
    const allCwdPrefixes = s.cwds.map((c: string) => c + '/')
    const orphanFiles = nonImageFiles.filter((f: FileRef) =>
      !allCwdPrefixes.some((prefix: string) => f.path.startsWith(prefix))
    )
    if (orphanFiles.length > 0) {
      groups.push({ cwd: translate(locale, 'renderer.info_panel.other_paths'), files: orphanFiles })
    }

    return groups
  }, [s.cwds, nonImageFiles, locale])

  const totalFileCount = nonImageFiles.length

  if (totalFileCount === 0 && s.cwds.length === 0) {
    return (
      <div className="text-xs text-muted py-8 text-center">
        {translate(locale, 'renderer.info_panel.no_file_operations')}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* File tree grouped by cwd */}
      {cwdFileGroups.map((group) => (
        <DisclosureSection
          key={group.cwd}
          title={group.cwd.replace(/^\/Users\/[^/]+/, '~')}
          icon={<FolderOpen size={12} />}
          badge={group.files.length || undefined}
          defaultOpen={false}
        >
          {group.files.length > 0 ? (
            <CwdFileTree cwd={group.cwd} files={group.files} />
          ) : (
            <div className="text-[11px] text-muted ml-1">
              {translate(locale, 'renderer.info_panel.no_file_operations_in_directory')}
            </div>
          )}
        </DisclosureSection>
      ))}
    </div>
  )
}

// ===================================================================
// Tab 2: Context
// ===================================================================

function ContextTab({ session, highlights, onNavigate, analysisReady }: {
  session: any
  highlights: Highlight[]
  onNavigate?: (id: string) => void
  analysisReady: boolean
}) {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const s = session
  const configFiles: string[] = s.configFiles || []
  const toolEntries = Object.entries(s.toolUsage).sort((a, b) => (b[1] as number) - (a[1] as number))

  return (
    <div className="space-y-4">
      {/* Uploaded images (default EXPANDED) */}
      <ImageGallery
        messages={s.messages || []}
        onNavigate={(turnUuid) => onNavigate?.(`turn-${turnUuid}`)}
        defaultOpen={true}
      />

      {/* Highlights / notes (default EXPANDED) */}
      <HighlightList highlights={highlights} sessionId={s.sessionId} defaultOpen={true} />

      {/* Config files (moved from Files tab) */}
      <CollapsibleFileList
        icon={Settings}
        label={t('info.config_files')}
        paths={configFiles}
      />

      {/* CLAUDE.md content */}
      {s.claudeMdContent && (
        <DisclosureSection
          title={t('info.claude_docs')}
          icon={<FileText size={12} />}
          defaultOpen={false}
        >
          <pre className="text-[11px] text-muted bg-surface rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
            {s.claudeMdContent}
          </pre>
        </DisclosureSection>
      )}

      {/* Context Inspector */}
      {analysisReady && (
        <ContextInspectorPanel filePath={s.filePath} />
      )}

      {/* Execution tree */}
      {analysisReady && (
        <ExecutionTreePanel filePath={s.filePath} />
      )}

      {/* Session Audit */}
      {analysisReady && (
        <SessionAuditPanel filePath={s.filePath} />
      )}

      {/* Tool usage */}
      {toolEntries.length > 0 && (
        <DisclosureSection
          title={t('info.tool_usage')}
          icon={<Wrench size={12} />}
          badge={toolEntries.length}
          defaultOpen={false}
        >
          <div className="space-y-1">
            {toolEntries.map(([name, count]) => (
              <div key={name} className="flex items-center justify-between text-xs">
                <span className="text-secondary font-mono">{name}</span>
                <span className="text-muted">{count as number}</span>
              </div>
            ))}
          </div>
        </DisclosureSection>
      )}

      {/* Skill invocations */}
      {s.skillInvocations.length > 0 && (
        <DisclosureSection
          title={t('info.skill_invocations')}
          icon={<Zap size={12} />}
          badge={s.skillInvocations.length}
          defaultOpen={false}
        >
          <div className="space-y-1">
            {s.skillInvocations.map((si: { skillName: string; timestamp: string }, i: number) => (
              <div key={i} className="text-xs">
                <span className="text-secondary font-mono">{si.skillName}</span>
                <span className="text-faint ml-2">{formatDateTime(si.timestamp, locale)}</span>
              </div>
            ))}
          </div>
        </DisclosureSection>
      )}

      {/* Branch relationships */}
      <BranchRelationships session={s} />

      {/* Session family tree (lineage) */}
      <DisclosureSection
        title={translate(locale, 'renderer.session_family_tree.session_lineage')}
        icon={<GitBranch size={12} className="text-soft-purple" />}
        defaultOpen={false}
      >
        <SessionFamilyTree sessionId={s.sessionId} />
      </DisclosureSection>
    </div>
  )
}

// ===================================================================
// Main InfoPanel
// ===================================================================

export function InfoPanel({ width, onNavigate }: { width: number; onNavigate?: (id: string) => void }) {
  const t = useT()
  const locale = useStore((s) => s.locale)
  const {
    selectedSession: selectedSessionSnapshot,
    infoPanelOpen,
    config,
  } = useStore()
  const selectedSession = useDeferredValue(selectedSessionSnapshot)
  const [panelReadySessionId, setPanelReadySessionId] = useState<string | null>(null)
  const [analysisReadySessionId, setAnalysisReadySessionId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<InspectorTab>('files')

  // Reset tab to 'files' when session changes
  useEffect(() => {
    setActiveTab('files')
  }, [selectedSession?.id])

  useEffect(() => {
    const sessionId = selectedSession?.id
    if (!sessionId) return
    const timer = window.setTimeout(() => setPanelReadySessionId(sessionId), 100)
    return () => window.clearTimeout(timer)
  }, [selectedSession?.id])

  useEffect(() => {
    const sessionId = selectedSession?.id
    if (!sessionId) return
    const timer = window.setTimeout(() => setAnalysisReadySessionId(sessionId), 300)
    return () => window.clearTimeout(timer)
  }, [selectedSession?.id])

  if (!infoPanelOpen || !selectedSession || panelReadySessionId !== selectedSession.id) return null

  const s = selectedSession
  const highlights: Highlight[] = config?.sessionMeta?.[s.sessionId]?.highlights || []

  return (
    <div data-testid="info-panel" className="h-full bg-base overflow-y-auto shrink-0" style={{ width }}>
      <div className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-body">{t('info.title')}</h3>

        {/* Always-visible compact session info card */}
        <SessionInfoCard session={s} />

        {/* Tab switcher: Files | Context */}
        <InspectorTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          locale={locale}
          tabs={['files', 'context']}
        />

        {/* Tab content */}
        {activeTab === 'files' && (
          <FilesTab
            session={s}
            onNavigate={onNavigate}
          />
        )}

        {activeTab === 'context' && (
          <ContextTab
            session={s}
            highlights={highlights}
            onNavigate={onNavigate}
            analysisReady={analysisReadySessionId === s.id}
          />
        )}
      </div>
    </div>
  )
}
