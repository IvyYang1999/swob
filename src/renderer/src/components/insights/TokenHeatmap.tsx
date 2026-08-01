import { useState, useMemo, useCallback } from 'react'
import type { AnalysisScope } from '../../../../shared/analysis-scope-types'
import type { HeatmapCell } from './shared'
import { formatTokenCount } from './shared'
import { enumerateAnalysisDays } from './insights-range'

const HEATMAP_LEVELS = [
  'bg-edge/60',
  'bg-blue-500/20',
  'bg-blue-500/40',
  'bg-blue-500/70',
  'bg-blue-500',
]

const DOW_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']
const CELL = 13
const GAP = 3
const STEP = CELL + GAP
const MONTH_LABEL_WIDTH = 24
const MONTH_LABEL_GAP = 2

type MonthLabel = { label: string; col: number }

export function fitHeatmapMonthLabels(labels: MonthLabel[], weekCount: number): MonthLabel[] {
  const gridWidth = weekCount > 0 ? weekCount * CELL + (weekCount - 1) * GAP : 0
  let previousRight = -Infinity
  return labels.filter(({ col }) => {
    const left = col * STEP
    if (left + MONTH_LABEL_WIDTH > gridWidth || left < previousRight + MONTH_LABEL_GAP) return false
    previousRight = left + MONTH_LABEL_WIDTH
    return true
  })
}

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

export function TokenHeatmap({
  data,
  range,
  now
}: {
  data: HeatmapCell[]
  range: AnalysisScope['range']
  /** Deterministic clock for tests; production intentionally omits it. */
  now?: Date
}) {
  const [tooltip, setTooltip] = useState<{ date: string; value: number; x: number; y: number } | null>(null)

  // Build weeks[][day] structure — each week is a column, each day is a row
  const weeks = useMemo<GridCell[][]>(() => {
    const map = new Map(data.map((d) => [d.date, d]))
    const days = enumerateAnalysisDays(range, data.map((item) => item.date), now)
    if (days.length === 0) return []

    const result: GridCell[][] = []
    let week: GridCell[] = []
    const firstDow = new Date(`${days[0]}T12:00:00`).getDay()
    for (let index = 0; index < firstDow; index++) {
      week.push({ date: '', value: 0, level: 0, key: `pad-start-${index}`, pad: true })
    }

    for (const iso of days) {
      if (week.length === 7) {
        result.push(week)
        week = []
      }
      const cell = map.get(iso) ?? { date: iso, value: 0, level: 0 as const }
      week.push({ ...cell, key: iso, pad: false })
    }
    // Pad last week to 7 days so the grid is rectangular
    if (week.length > 0) {
      for (let i = week.length; i < 7; i++) {
        week.push({ date: '', value: 0, level: 0, key: `pad-${i}`, pad: true })
      }
      result.push(week)
    }

    return result
  }, [data, range, now])

  // Month labels: show at the first week of each new month
  const months = useMemo(() => {
    const labels: MonthLabel[] = []
    let lastMonth = -1
    for (let col = 0; col < weeks.length; col++) {
      const firstVisible = weeks[col].find((cell) => !cell.pad)
      if (!firstVisible) continue
      const m = new Date(`${firstVisible.key}T12:00:00`).getMonth()
      if (m !== lastMonth) {
        labels.push({ label: new Date(`${firstVisible.key}T12:00:00`).toLocaleString('default', { month: 'short' }), col })
        lastMonth = m
      }
    }
    return fitHeatmapMonthLabels(labels, weeks.length)
  }, [weeks])

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
              className="absolute overflow-hidden whitespace-nowrap text-[10px] text-muted"
              style={{ left: m.col * STEP, maxWidth: MONTH_LABEL_WIDTH }}
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
                data-heatmap-day={cell.pad ? undefined : cell.date}
                aria-label={cell.pad ? undefined : `${cell.date}: ${formatTokenCount(cell.value)} tokens`}
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
