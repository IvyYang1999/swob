import { useStore } from '../store'
import { Clock, MessageSquare, FolderOpen, Wrench, Zap, FileText, HardDrive } from 'lucide-react'

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

export function InfoPanel() {
  const { selectedSession, infoPanelOpen } = useStore()

  if (!infoPanelOpen || !selectedSession) return null

  const s = selectedSession
  const toolEntries = Object.entries(s.toolUsage).sort((a, b) => b[1] - a[1])

  return (
    <div className="w-70 h-full border-l border-zinc-700 bg-zinc-900 overflow-y-auto shrink-0">
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
        </section>

        {/* Working directories */}
        <section>
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
            <FolderOpen size={12} />
            <span>关联目录</span>
          </div>
          <div className="space-y-1">
            {s.cwds.map((cwd) => (
              <div key={cwd} className="text-xs text-zinc-500 font-mono truncate" title={cwd}>
                {cwd.replace(/^\/Users\/[^/]+/, '~')}
              </div>
            ))}
          </div>
        </section>

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
