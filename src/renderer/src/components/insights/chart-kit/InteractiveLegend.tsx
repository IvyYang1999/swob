import { useCallback } from 'react'

export interface LegendItem {
  key: string
  label: string
  color: string
}

interface InteractiveLegendProps {
  items: LegendItem[]
  /** Set of currently hidden keys. */
  hiddenKeys: Set<string>
  onToggle: (key: string) => void
}

export function InteractiveLegend({ items, hiddenKeys, onToggle }: InteractiveLegendProps) {
  const handleClick = useCallback((key: string) => {
    onToggle(key)
  }, [onToggle])

  if (items.length === 0) return null

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map(({ key, label, color }) => {
        const isHidden = hiddenKeys.has(key)
        return (
          <button
            key={key}
            onClick={() => handleClick(key)}
            className={`flex items-center gap-1.5 text-xs transition-opacity ${isHidden ? 'opacity-30' : 'opacity-100'} hover:opacity-80`}
            title={isHidden ? `Show ${label}` : `Hide ${label}`}
          >
            <span
              className="w-2.5 h-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: color }}
            />
            <span className="text-muted">{label}</span>
          </button>
        )
      })}
    </div>
  )
}
