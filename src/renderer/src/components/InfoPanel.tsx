import { useState, useMemo } from 'react'
import { useStore } from '../store'
import { Clock, MessageSquare, FolderOpen, Wrench, Zap, FileText, HardDrive, Image, File, Settings, ExternalLink, ChevronDown, ChevronRight, Pencil, Plus, Eye, Upload } from 'lucide-react'

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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
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

function ClickablePath({ path, isDir, dimmed }: { path: string; isDir?: boolean; dimmed?: boolean }) {
  const short = path.replace(/^\/Users\/[^/]+/, '~')
  const fileName = path.split('/').pop() || path

  return (
    <div
      className={`flex items-center gap-1.5 text-xs font-mono truncate cursor-pointer group ${
        dimmed ? 'text-zinc-600 line-through' : 'text-zinc-400 hover:text-blue-400'
      }`}
      title={`${path}\n${dimmed ? '(已删除) ' : ''}点击打开 · 右键在 Finder 中显示`}
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
  const config: Record<string, { label: string; color: string }> = {
    'write': { label: '新建', color: 'bg-green-800 text-green-300' },
    'edit': { label: '编辑', color: 'bg-blue-800 text-blue-300' },
    'read': { label: '读取', color: 'bg-zinc-700 text-zinc-400' },
    'user-image': { label: '上传', color: 'bg-purple-800 text-purple-300' },
    'user-input': { label: '用户', color: 'bg-amber-800 text-amber-300' },
  }
  const c = config[action] || { label: action, color: 'bg-zinc-700 text-zinc-400' }
  return (
    <span className={`px-1 py-0.5 rounded text-[9px] leading-none ${c.color}`}>
      {c.label}
    </span>
  )
}

function ActionIcon({ action }: { action: string }) {
  const size = 10
  switch (action) {
    case 'write': return <Plus size={size} className="text-green-400 shrink-0" />
    case 'edit': return <Pencil size={size} className="text-blue-400 shrink-0" />
    case 'read': return <Eye size={size} className="text-zinc-500 shrink-0" />
    case 'user-image': return <Upload size={size} className="text-purple-400 shrink-0" />
    case 'user-input': return <Upload size={size} className="text-amber-400 shrink-0" />
    default: return null
  }
}

// Build a directory tree from flat file list, collapsing single-child intermediate dirs
function buildFileTree(files: FileRef[]): TreeNode {
  const root: TreeNode = { name: '', fullPath: '', children: new Map() }

  for (const f of files) {
    const parts = f.path.split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (!node.children.has(part)) {
        node.children.set(part, {
          name: part,
          fullPath: '/' + parts.slice(0, i + 1).join('/'),
          children: new Map()
        })
      }
      node = node.children.get(part)!
    }
    node.file = f
  }

  // Collapse single-child dirs that aren't files
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
          f.exists ? 'text-zinc-400 hover:text-blue-400' : 'text-zinc-600 line-through'
        }`}
        style={{ paddingLeft: depth * 12 }}
        title={`${f.path}\n操作: ${f.actions.join(', ')}${f.exists ? '' : '\n(已删除)'}\n点击打开 · 右键在 Finder 中显示`}
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
            className="flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300 w-full font-mono"
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
  const [open, setOpen] = useState(defaultOpen)
  const [showAll, setShowAll] = useState(false)

  if (paths.length === 0) return null

  const displayed = showAll ? paths : paths.slice(0, maxShow)
  const hasMore = paths.length > maxShow

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2 hover:text-zinc-300 w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Icon size={12} />
        <span>{label}</span>
        <span className="text-zinc-600 ml-auto">{paths.length}</span>
      </button>
      {open && (
        <div className="space-y-1 ml-1">
          {displayed.map((p) => (
            <ClickablePath key={p} path={p} isDir={isDir} />
          ))}
          {hasMore && !showAll && (
            <button
              onClick={() => setShowAll(true)}
              className="text-[11px] text-zinc-600 hover:text-zinc-400 ml-3"
            >
              还有 {paths.length - maxShow} 个...
            </button>
          )}
        </div>
      )}
    </section>
  )
}

function ImageList({ files }: { files: FileRef[] }) {
  const [open, setOpen] = useState(true)

  if (files.length === 0) return null

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2 hover:text-zinc-300 w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <Image size={12} />
        <span>上传图片</span>
        <span className="text-zinc-600 ml-auto">{files.length}</span>
      </button>
      {open && (
        <div className="space-y-1 ml-1">
          {files.map((f) => (
            <ClickablePath key={f.path} path={f.path} dimmed={!f.exists} />
          ))}
        </div>
      )}
    </section>
  )
}

function FileTreeSection({ files }: { files: FileRef[] }) {
  const [open, setOpen] = useState(true)

  const tree = useMemo(() => buildFileTree(files), [files])

  if (files.length === 0) return null

  const existCount = files.filter(f => f.exists).length
  const deletedCount = files.length - existCount

  return (
    <section>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2 hover:text-zinc-300 w-full"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        <File size={12} />
        <span>操作过的文件</span>
        <span className="text-zinc-600 ml-auto">
          {existCount}{deletedCount > 0 && <span className="text-zinc-700">+{deletedCount}</span>}
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

export function InfoPanel({ width }: { width: number }) {
  const { selectedSession, infoPanelOpen } = useStore()

  if (!infoPanelOpen || !selectedSession) return null

  const s = selectedSession
  const toolEntries = Object.entries(s.toolUsage).sort((a, b) => b[1] - a[1])
  const referencedFiles: FileRef[] = (s as any).referencedFiles || []
  const configFiles: string[] = (s as any).configFiles || []

  // Extract user images from referencedFiles (they have 'user-image' action)
  const imageFiles = referencedFiles.filter(f => f.actions.includes('user-image'))
  // Non-image referenced files for the tree
  const nonImageFiles = referencedFiles.filter(f => !f.actions.includes('user-image'))

  return (
    <div className="h-full bg-zinc-900 overflow-y-auto shrink-0" style={{ width }}>
      <div className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-zinc-300">Session Info</h3>

        {/* Basic metadata */}
        <section className="space-y-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-400">
            <Clock size={12} />
            <span>创建：{formatDateTime(s.createdAt)}</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-400">
            <Clock size={12} />
            <span>修改：{formatDateTime(s.updatedAt)}</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-400">
            <MessageSquare size={12} />
            <span>{s.turnCount} 轮对话 ({s.messageCount} 条消息)</span>
          </div>
          {s.compactCount > 0 && (
            <div className="flex items-center gap-2 text-amber-400 text-xs">
              <span>Compact: {s.compactCount} 次</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-zinc-400">
            <HardDrive size={12} />
            <span>{formatSize(s.fileSizeBytes)} · v{s.version}</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-500 text-xs">
            <span className="text-zinc-600 shrink-0">Session ID:</span>
            <span className="text-[10px] font-mono select-all cursor-text truncate">{s.sessionId}</span>
          </div>
        </section>

        {/* Working directories */}
        <CollapsibleFileList
          icon={FolderOpen}
          label="工作目录"
          paths={s.cwds}
          isDir
        />

        {/* User images with existence check */}
        <ImageList files={imageFiles} />

        {/* Referenced files - directory tree */}
        <FileTreeSection files={nonImageFiles} />

        {/* Config files */}
        <CollapsibleFileList
          icon={Settings}
          label="配置文件"
          paths={configFiles}
        />

        {/* Tool usage */}
        {toolEntries.length > 0 && (
          <section>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              <Wrench size={12} />
              <span>工具调用</span>
            </div>
            <div className="space-y-1">
              {toolEntries.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400 font-mono">{name}</span>
                  <span className="text-zinc-500">{count}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Skill invocations */}
        {s.skillInvocations.length > 0 && (
          <section>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              <Zap size={12} />
              <span>Skill 调用</span>
            </div>
            <div className="space-y-1">
              {s.skillInvocations.map((si, i) => (
                <div key={i} className="text-xs">
                  <span className="text-zinc-400 font-mono">{si.skillName}</span>
                  <span className="text-zinc-600 ml-2">{formatDateTime(si.timestamp)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* CLAUDE.md content */}
        {s.claudeMdContent && (
          <section>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              <FileText size={12} />
              <span>.claude 文档</span>
            </div>
            <pre className="text-[11px] text-zinc-500 bg-zinc-800 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
              {s.claudeMdContent}
            </pre>
          </section>
        )}
      </div>
    </div>
  )
}
