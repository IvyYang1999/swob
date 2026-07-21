import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import type { BySource } from './shared'
import { formatTokenCount, SOURCE_COLORS } from './shared'

interface PayloadItem {
  name: string
  value: number
  source: string
}

function CustomTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: PayloadItem }> }) {
  if (!active || !payload?.[0]) return null
  const d = payload[0].payload
  return (
    <div className="px-2 py-1 rounded bg-hover border border-edge text-xs text-primary shadow-lg">
      {d.name}: {formatTokenCount(d.value)}
    </div>
  )
}

export function SourceDonut({ sources }: { sources: BySource[] }) {
  const total = sources.reduce((s, b) => s + b.totalTokens, 0)
  const visibleSources = sources.filter((source) => source.sessionCount > 0 || source.totalTokens > 0)
  if (visibleSources.length === 0) return <div className="text-xs text-muted">No sessions</div>

  const data = visibleSources.filter((source) => source.totalTokens > 0).map((s) => ({
    name: s.label,
    value: s.totalTokens,
    source: s.source,
  }))

  return (
    <div className="flex items-center gap-4">
      {total > 0 && <div className="relative" style={{ width: 160, height: 160 }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={75}
              dataKey="value"
              stroke="none"
            >
              {data.map((entry) => (
                <Cell key={entry.source} fill={SOURCE_COLORS[entry.source] || '#71717a'} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-lg font-medium text-primary">{formatTokenCount(total)}</span>
          <span className="text-[10px] text-muted">processed</span>
        </div>
      </div>}
      <div className="flex flex-col gap-1.5">
        {visibleSources.map((s) => {
          const pct = total > 0 ? ((s.totalTokens / total) * 100).toFixed(1) : '0'
          const unavailable = s.tokenDataStatus === 'unavailable'
          const partial = s.tokenDataStatus === 'partial'
          return (
            <div key={s.source} className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: SOURCE_COLORS[s.source] || '#71717a' }} />
              <span className="text-xs text-primary">{s.label}</span>
              <span className="text-xs text-muted">
                {unavailable ? 'Unavailable' : `${formatTokenCount(s.totalTokens)} (${pct}%)`}
                {partial && ` · ${s.tokenUnavailableSessions} unavailable`}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
