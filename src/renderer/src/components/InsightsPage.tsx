import { useState, useEffect, useMemo, useCallback } from 'react'
import { useT } from '../i18n'

interface BySource {
  source: string
  label: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
}

interface ByProject {
  project: string
  fullPath: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  sources: string[]
}

interface ByFolder {
  folderId: string
  folderName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
}

interface ByDate {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  bySource: Record<string, number>
  byProject: Record<string, number>
}

interface HeatmapCell {
  date: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}

interface InsightsData {
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  totalTurns: number
  bySource: BySource[]
  byProject: ByProject[]
  byFolder: ByFolder[]
  byDate: ByDate[]
  heatmap: HeatmapCell[]
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const SOURCE_COLORS: Record<string, string> = {
  'claude-code': 'bg-soft-orange',
  codex: 'bg-soft-blue',
  cursor: 'bg-secondary',
}

const SOURCE_TEXT_COLORS: Record<string, string> = {
  'claude-code': 'text-soft-orange',
  codex: 'text-soft-blue',
  cursor: 'text-secondary',
}

function sourceColor(source: string): string {
  return SOURCE_COLORS[source] || 'bg-muted'
}

function sourceTextColor(source: string): string {
  return SOURCE_TEXT_COLORS[source] || 'text-muted'
}

const HEATMAP_LEVELS = [
  'bg-surface',
  'bg-soft-green/20',
  'bg-soft-green/40',
  'bg-soft-green/60',
  'bg-soft-green',
]

function HeatmapTooltip({ date, value, x, y }: { date: string; value: number; x: number; y: number }) {
  return (
    <div
      className="fixed z-50 px-2 py-1 rounded bg-hover border border-edge text-xs text-primary shadow-lg pointer-events-none"
      style={{ left: x, top: y - 36 }}
    >
      {date} · {formatTokenCount(value)} tokens
    </div>
  )
}

function Heatmap({ data }: { data: HeatmapCell[] }) {
  const [tooltip, setTooltip] = useState<{ date: string; value: number; x: number; y: number } | null>(null)

  const grid = useMemo(() => {
    const map = new Map(data.map((d) => [d.date, d]))
    const today = new Date()
    const rows: Array<Array<HeatmapCell & { key: string }>> = Array.from({ length: 7 }, () => [])

    const start = new Date(today)
    start.setDate(start.getDate() - 364)
    const startDow = start.getDay()
    if (startDow !== 0) {
      start.setDate(start.getDate() - startDow)
    }

    const cursor = new Date(start)
    while (cursor <= today) {
      const iso = cursor.toISOString().slice(0, 10)
      const dow = cursor.getDay()
      const cell = map.get(iso) || { date: iso, value: 0, level: 0 as const }
      rows[dow].push({ ...cell, key: iso })
      cursor.setDate(cursor.getDate() + 1)
    }

    return rows
  }, [data])

  const months = useMemo(() => {
    if (grid[0].length === 0) return []
    const labels: Array<{ label: string; col: number }> = []
    let lastMonth = -1
    for (let col = 0; col < grid[0].length; col++) {
      const d = new Date(grid[0][col].key)
      const m = d.getMonth()
      if (m !== lastMonth) {
        labels.push({
          label: d.toLocaleString('default', { month: 'short' }),
          col,
        })
        lastMonth = m
      }
    }
    return labels
  }, [grid])

  const colCount = grid[0]?.length || 0

  const handleMouseEnter = useCallback((e: React.MouseEvent, cell: HeatmapCell) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    setTooltip({ date: cell.date, value: cell.value, x: rect.left + rect.width / 2, y: rect.top })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  return (
    <div className="space-y-1">
      <div className="relative" style={{ paddingTop: 16 }}>
        <div className="flex gap-[2px]" style={{ position: 'absolute', top: 0, left: 0 }}>
          {months.map((m, i) => (
            <span
              key={i}
              className="text-[10px] text-muted"
              style={{ position: 'absolute', left: m.col * 12 }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div
          className="grid gap-[2px]"
          style={{
            gridTemplateRows: 'repeat(7, 10px)',
            gridTemplateColumns: `repeat(${colCount}, 10px)`,
            gridAutoFlow: 'column',
          }}
        >
          {grid.flatMap((row) =>
            row.map((cell) => (
              <div
                key={cell.key}
                className={`w-[10px] h-[10px] rounded-[2px] ${HEATMAP_LEVELS[cell.level]}`}
                onMouseEnter={(e) => handleMouseEnter(e, cell)}
                onMouseLeave={handleMouseLeave}
              />
            ))
          )}
        </div>
      </div>
      {tooltip && <HeatmapTooltip {...tooltip} />}
    </div>
  )
}

function SourceBar({ sources }: { sources: BySource[] }) {
  const total = sources.reduce((s, b) => s + b.totalTokens, 0)
  if (total === 0) return null

  return (
    <div className="space-y-2">
      <div className="flex h-6 rounded overflow-hidden">
        {sources.map((s) => {
          const pct = (s.totalTokens / total) * 100
          if (pct < 0.5) return null
          return (
            <div
              key={s.source}
              className={`${sourceColor(s.source)} transition-all`}
              style={{ width: `${pct}%` }}
              title={`${s.label}: ${formatTokenCount(s.totalTokens)} (${pct.toFixed(1)}%)`}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-3">
        {sources.map((s) => (
          <div key={s.source} className="flex items-center gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-sm ${sourceColor(s.source)}`} />
            <span className={`text-xs ${sourceTextColor(s.source)}`}>{s.label}</span>
            <span className="text-xs text-muted">{formatTokenCount(s.totalTokens)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ProjectRanking({ projects }: { projects: ByProject[] }) {
  const top = projects.slice(0, 10)
  const maxTokens = top[0]?.totalTokens || 1

  return (
    <div className="space-y-1">
      {top.map((p) => {
        const pct = (p.totalTokens / maxTokens) * 100
        return (
          <div key={p.fullPath} className="flex items-center gap-2" style={{ height: 28 }}>
            <span className="text-xs text-secondary truncate w-32 shrink-0" title={p.fullPath}>
              {p.project}
            </span>
            <div className="flex-1 h-4 bg-surface rounded overflow-hidden">
              <div
                className="h-full bg-soft-blue rounded transition-all"
                style={{ width: `${pct}%` }}
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

function DailyTrend({ data }: { data: ByDate[] }) {
  const last30 = useMemo(() => data.slice(-30), [data])

  const { width, height, padTop, padBottom, padLeft, padRight } = {
    width: 600,
    height: 180,
    padTop: 16,
    padBottom: 28,
    padLeft: 40,
    padRight: 8,
  }

  const chartW = width - padLeft - padRight
  const chartH = height - padTop - padBottom

  const maxVal = useMemo(() => {
    let m = 0
    for (const d of last30) m = Math.max(m, d.inputTokens + d.outputTokens)
    return m || 1
  }, [last30])

  const toX = (i: number) => padLeft + (i / Math.max(last30.length - 1, 1)) * chartW
  const toY = (v: number) => padTop + chartH - (v / maxVal) * chartH

  const inputPath = useMemo(() => {
    if (last30.length === 0) return ''
    const pts = last30.map((d, i) => `${toX(i)},${toY(d.inputTokens)}`)
    return `M${pts.join('L')}L${toX(last30.length - 1)},${toY(0)}L${toX(0)},${toY(0)}Z`
  }, [last30, maxVal])

  const outputPath = useMemo(() => {
    if (last30.length === 0) return ''
    const pts = last30.map((d, i) => `${toX(i)},${toY(d.inputTokens + d.outputTokens)}`)
    const bottomPts = [...last30].map((d, i) => `${toX(last30.length - 1 - i)},${toY(last30[last30.length - 1 - i].inputTokens)}`)
    return `M${pts.join('L')}L${bottomPts.join('L')}Z`
  }, [last30, maxVal])

  const inputLinePath = useMemo(() => {
    if (last30.length === 0) return ''
    return 'M' + last30.map((d, i) => `${toX(i)},${toY(d.inputTokens)}`).join('L')
  }, [last30, maxVal])

  const totalLinePath = useMemo(() => {
    if (last30.length === 0) return ''
    return 'M' + last30.map((d, i) => `${toX(i)},${toY(d.inputTokens + d.outputTokens)}`).join('L')
  }, [last30, maxVal])

  const yTicks = useMemo(() => {
    const steps = 4
    return Array.from({ length: steps + 1 }, (_, i) => {
      const v = (maxVal / steps) * i
      return { v, y: toY(v) }
    })
  }, [maxVal])

  const xLabels = useMemo(() => {
    const step = Math.max(1, Math.floor(last30.length / 5))
    return last30
      .map((d, i) => (i % step === 0 || i === last30.length - 1 ? { label: d.date.slice(5), x: toX(i) } : null))
      .filter(Boolean) as Array<{ label: string; x: number }>
  }, [last30])

  if (last30.length === 0) return null

  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" style={{ maxWidth: width }}>
        {yTicks.map((tick) => (
          <g key={tick.v}>
            <line x1={padLeft} y1={tick.y} x2={width - padRight} y2={tick.y} stroke="var(--color-edge)" strokeWidth={0.5} />
            <text x={padLeft - 4} y={tick.y + 3} textAnchor="end" style={{ fontSize: 9, fill: 'var(--color-muted)' }}>
              {formatTokenCount(tick.v)}
            </text>
          </g>
        ))}
        <path d={inputPath} fill="var(--color-soft-blue)" fillOpacity={0.25} />
        <path d={outputPath} fill="var(--color-soft-orange)" fillOpacity={0.25} />
        <path d={inputLinePath} fill="none" stroke="var(--color-soft-blue)" strokeWidth={1.5} />
        <path d={totalLinePath} fill="none" stroke="var(--color-soft-orange)" strokeWidth={1.5} />
        {xLabels.map((l) => (
          <text key={l.label} x={l.x} y={height - 6} textAnchor="middle" style={{ fontSize: 9, fill: 'var(--color-muted)' }}>
            {l.label}
          </text>
        ))}
      </svg>
      <div className="flex gap-3">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm bg-soft-blue" />
          <span className="text-xs text-muted">Input</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-sm bg-soft-orange" />
          <span className="text-xs text-muted">Output</span>
        </div>
      </div>
    </div>
  )
}

export function InsightsPage() {
  const t = useT()
  const api = (window as any).api
  const [data, setData] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getInsights().then((d: InsightsData) => {
      if (!cancelled) {
        setData(d)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  const dailyAvg = useMemo(() => {
    if (!data || data.byDate.length === 0) return 0
    return Math.round(data.totalTokens / data.byDate.length)
  }, [data])

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    )
  }

  const stats = [
    { label: 'Total Tokens', value: formatTokenCount(data.totalTokens) },
    { label: 'Sessions', value: formatTokenCount(data.totalSessions) },
    { label: 'Total Turns', value: formatTokenCount(data.totalTurns) },
    { label: 'Daily Avg', value: formatTokenCount(dailyAvg) },
  ]

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface rounded-lg p-4 border border-edge">
            <div className="text-lg font-medium text-primary">{s.value}</div>
            <div className="text-xs text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Token Heatmap</div>
        <div className="overflow-x-auto">
          <Heatmap data={data.heatmap} />
        </div>
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">By Source</div>
        <SourceBar sources={data.bySource} />
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Top Projects</div>
        <ProjectRanking projects={data.byProject} />
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Daily Trend (30d)</div>
        <DailyTrend data={data.byDate} />
      </div>
    </div>
  )
}
