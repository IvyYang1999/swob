import type { ByProject, ByFolder } from './shared'
import { formatTokenCount, PROJECT_COLORS } from './shared'

export function ProjectRanking({ projects }: { projects: ByProject[] | ByFolder[] }) {
  const top = projects.slice(0, 10)
  const maxTokens = top[0]?.totalTokens || 1

  return (
    <div className="space-y-1">
      {top.map((p, i) => {
        const pct = (p.totalTokens / maxTokens) * 100
        const name = 'project' in p ? p.project : p.folderName
        const key = 'project' in p ? p.fullPath : p.folderId
        const color = PROJECT_COLORS[i % PROJECT_COLORS.length]
        return (
          <div key={key} className="flex items-center gap-2" style={{ height: 28 }}>
            <span className="text-xs text-secondary truncate w-32 shrink-0" title={key}>
              {name}
            </span>
            <div className="flex-1 h-4 bg-surface rounded overflow-hidden">
              <div
                className="h-full rounded transition-all"
                style={{ width: `${pct}%`, backgroundColor: color }}
              />
            </div>
            <span className="text-xs text-muted w-14 text-right shrink-0">
              {formatTokenCount(p.totalTokens)}
            </span>
          </div>
        )
      })}
    </div>
  )
}
