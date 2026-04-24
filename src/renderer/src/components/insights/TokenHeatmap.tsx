import { useState, useMemo, useCallback } from 'react'
import type { HeatmapCell } from './shared'
import { formatTokenCount } from './shared'

const HEATMAP_LEVELS = [
  'bg-edge/60',
  'bg-blue-500/15',
  'bg-blue-500/35',
  'bg-blue-500/65',
  'bg-blue-500',
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

export function TokenHeatmap({ data }: { data: HeatmapCell[] }) {
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
              style={{ position: 'absolute', left: m.col * 16 }}
            >
              {m.label}
            </span>
          ))}
        </div>
        <div
          className="grid gap-[3px]"
          style={{
            gridTemplateRows: 'repeat(7, 13px)',
            gridTemplateColumns: `repeat(${colCount}, 13px)`,
            gridAutoFlow: 'column',
          }}
        >
          {grid.flatMap((row) =>
            row.map((cell) => (
              <div
                key={cell.key}
                className={`w-[13px] h-[13px] rounded-[3px] ${HEATMAP_LEVELS[cell.level]}`}
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
