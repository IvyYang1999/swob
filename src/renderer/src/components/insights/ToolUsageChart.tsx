const TOOL_COLORS: Record<string, string> = {
  Bash: '#ef4444', Read: '#3b82f6', Edit: '#f59e0b', Write: '#22c55e',
  Agent: '#a78bfa', Grep: '#06b6d4', Glob: '#8b5cf6', Skill: '#ec4899',
  WebSearch: '#14b8a6', WebFetch: '#0ea5e9', ToolSearch: '#6366f1',
  TaskCreate: '#f97316', Artifact: '#d946ef'
}

export function ToolUsageChart({ tools }: { tools: Array<{ name: string; count: number }> }) {
  const max = tools[0]?.count || 1
  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
      <div className="text-sm font-medium text-primary">Tool Usage</div>
      <div className="space-y-1">
        {tools.slice(0, 10).map((t) => {
          const pct = (t.count / max) * 100
          const color = TOOL_COLORS[t.name] || '#6b7280'
          return (
            <div key={t.name} className="flex items-center gap-2" style={{ height: 22 }}>
              <span className="text-[11px] text-secondary w-20 truncate shrink-0 text-right">{t.name}</span>
              <div className="flex-1 h-3 bg-edge/50 rounded overflow-hidden">
                <div className="h-full rounded" style={{ width: `${pct}%`, backgroundColor: color, opacity: 0.75 }} />
              </div>
              <span className="text-[10px] text-muted w-12 text-right shrink-0">{t.count.toLocaleString()}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
