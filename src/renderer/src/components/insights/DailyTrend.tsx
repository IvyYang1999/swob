import { useMemo } from 'react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { ByDate } from './shared'
import { formatTokenCount } from './shared'

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{ value: number; dataKey: string }>
  label?: string
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="px-2 py-1 rounded bg-hover border border-edge text-xs text-primary shadow-lg space-y-0.5">
      <div>{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey}>
          {p.dataKey === 'inputTokens' ? 'Input' : 'Output'}: {formatTokenCount(p.value)}
        </div>
      ))}
    </div>
  )
}

export function DailyTrend({ data }: { data: ByDate[] }) {
  const last30 = useMemo(() => data.slice(-30), [data])

  const chartData = useMemo(() =>
    last30.map((d) => ({
      date: d.date.slice(5),
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
    })),
    [last30]
  )

  if (chartData.length === 0) return null

  return (
    <div className="space-y-2">
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
            axisLine={{ stroke: 'var(--color-edge)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 9, fill: 'var(--color-muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={formatTokenCount}
            width={40}
          />
          <Tooltip content={<CustomTooltip />} />
          <Area type="monotone" dataKey="inputTokens" stackId="1" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.25} />
          <Area type="monotone" dataKey="outputTokens" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.25} />
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#3b82f6' }} />
          <span className="text-xs text-muted">Input</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#f59e0b' }} />
          <span className="text-xs text-muted">Output</span>
        </div>
      </div>
    </div>
  )
}
