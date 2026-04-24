import { useState, useMemo, useCallback } from 'react'
import type { HeatmapCell } from './shared'
import { formatTokenCount } from './shared'

const HEATMAP_LEVELS = [
  'bg-edge/60',
  'bg-blue-500/20',
  'bg-blue-500/40',
  'bg-blue-500/70',
  'bg-blue-500',
]

const DOW_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

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

type GridCell = HeatmapCell & { key: string; pad: boolean }

export function TokenHeatmap({ data }: { data: HeatmapCell[] }) {
  const [tooltip, setTooltip] = useState<{ date: string; value: number; x: number; y: number } | null>(null)

  // Build weeks[][day] structure — each week is a column, each day is a row
  const weeks = useMemo<GridCell[][]>(() => {
    const map = new Map(data.map((d) => [d.date, d]))
    const today = new Date()

    // Go back 364 days and snap to the previous Sunday
    const start = new Date(today)
    start.setDate(start.getDate() - 364)
    const dow = start.getDay()
    if (dow !== 0) start.setDate(start.getDate() - dow)

    const result: GridCell[][] = []
    let week: GridCell[] = []
    const cursor = new Date(start)

    while (cursor <= today) {
      if (cursor.getDay() === 0 && week.length > 0) {
        result.push(week)
        week = []
      }
      const iso = cursor.toISOString().slice(0, 10)
      const cell = map.get(iso) ?? { date: iso, value: 0, level: 0 as const }
      week.push({ ...cell, key: iso, pad: false })
      cursor.setDate(cursor.getDate() + 1)
    }
    // Pad last week to 7 days so the grid is rectangular
    if (week.length > 0) {
      for (let i = week.length; i < 7; i++) {
        week.push({ date: '', value: 0, level: 0, key: `pad-${i}`, pad: true })
      }
      result.push(week)
    }

    return result
  }, [data])

  // Month labels: show at the first week of each new month
  const months = useMemo(() => {
    const labels: Array<{ label: string; col: number }> = []
    let lastMonth = -1
    for (let col = 0; col < weeks.length; col++) {
      const sun = weeks[col][0]
      if (!sun || sun.pad) continue
      const m = new Date(sun.key).getMonth()
      if (m !== lastMonth) {
        labels.push({ label: new Date(sun.key).toLocaleString('default', { month: 'short' }), col })
        lastMonth = m
      }
    }
    return labels
  }, [weeks])

  const CELL = 13
  const GAP = 3
  const STEP = CELL + GAP

  const handleMouseEnter = useCallback((e: React.MouseEvent, cell: HeatmapCell) => {
    const rect = (e.target as HTMLElement).getBoundingClientRect()
    setTooltip({ date: cell.date, value: cell.value, x: rect.left + rect.width / 2, y: rect.top })
  }, [])

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  return (
    <div className="flex gap-1">
      {/* Day-of-week labels */}
      <div className="flex flex-col pt-[20px]" style={{ gap: GAP }}>
        {DOW_LABELS.map((label, i) => (
          <div key={i} className="text-[10px] text-muted leading-none flex items-center" style={{ height: CELL }}>
            {label}
          </div>
        ))}
      </div>

      {/* Grid */}
      <div className="relative overflow-x-auto">
        {/* Month labels */}
        <div className="relative h-5">
          {months.map((m) => (
            <span
              key={m.col}
              className="absolute text-[10px] text-muted"
              style={{ left: m.col * STEP }}
            >
              {m.label}
            </span>
          ))}
        </div>

        {/* Cells: render week by week (column by column) */}
        <div
          className="grid"
          style={{
            gridTemplateRows: `repeat(7, ${CELL}px)`,
            gridTemplateColumns: `repeat(${weeks.length}, ${CELL}px)`,
            gridAutoFlow: 'column',
            gap: GAP,
          }}
        >
          {weeks.flatMap((week) =>
            week.map((cell) => (
              <div
                key={cell.key}
                className={`rounded-[3px] ${cell.pad ? 'invisible' : HEATMAP_LEVELS[cell.level]}`}
                style={{ width: CELL, height: CELL }}
                onMouseEnter={!cell.pad && cell.value > 0 ? (e) => handleMouseEnter(e, cell) : undefined}
                onMouseLeave={!cell.pad ? handleMouseLeave : undefined}
              />
            ))
          )}
        </div>
      </div>

      {tooltip && <HeatmapTooltip {...tooltip} />}
    </div>
  )
}
