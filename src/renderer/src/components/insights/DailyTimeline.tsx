import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { ByDate } from './shared'
import { formatTokenCount, formatDuration, PROJECT_COLORS } from './shared'
import { useStore } from '../../store'
import { useT } from '../../i18n'

interface DailyTimelineProps {
  data: ByDate[]
  projectKey: 'byProject' | 'byFolder'
}

export function DailyTimeline({ data, projectKey }: DailyTimelineProps) {
  const locale = useStore((state) => state.locale)
  const t = useT()
  const [visibleDays, setVisibleDays] = useState(14)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)

  const recentDays = useMemo(() => {
    return data
      .filter(d => d.totalTokens > 0)
      .slice(-visibleDays)
      .reverse()
  }, [data, visibleDays])

  const allProjectNames = useMemo(() => {
    const names = new Set<string>()
    for (const d of recentDays) {
      for (const key of Object.keys(d.byProject)) {
        names.add(key)
      }
    }
    const colorMap = new Map<string, string>()
    let i = 0
    for (const name of names) {
      colorMap.set(name, PROJECT_COLORS[i % PROJECT_COLORS.length])
      i++
    }
    return colorMap
  }, [recentDays])

  function formatDayHeader(dateStr: string): string {
    const d = new Date(dateStr)
    return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', weekday: 'short' }).format(d)
  }

  return (
    <div className="space-y-2">
      {recentDays.map((day) => {
        const isExpanded = expandedDate === day.date
        const projects = Object.entries(day.byProject).sort((a, b) => b[1] - a[1])
        const maxTokens = projects[0]?.[1] || 1

        return (
          <div key={day.date} className="bg-surface rounded-lg border border-edge">
            <button
              onClick={() => setExpandedDate(isExpanded ? null : day.date)}
              className="w-full px-3 py-2 flex items-center gap-2 hover:bg-hover rounded-lg transition-colors"
            >
              {isExpanded ? <ChevronDown size={12} className="text-muted shrink-0" /> : <ChevronRight size={12} className="text-muted shrink-0" />}
              <span className="text-xs text-primary font-medium">{formatDayHeader(day.date)}</span>
              <span className="text-[11px] text-muted">{formatDuration(day.totalTime)}</span>
              <span className="text-[11px] text-muted">·</span>
              <span className="text-[11px] text-muted">{formatTokenCount(day.totalTokens)}</span>
            </button>

            {projects.length > 0 && !isExpanded && (
              <div className="px-3 pb-2 pl-7">
                <div className="flex h-3 rounded overflow-hidden gap-[1px]">
                  {projects.map(([name, tokens]) => {
                    const pct = (tokens / maxTokens) * 100
                    return (
                      <div
                        key={name}
                        className="rounded-sm transition-all"
                        style={{ width: `${pct}%`, backgroundColor: allProjectNames.get(name) || '#71717a', minWidth: 2 }}
                        title={`${name}: ${formatTokenCount(tokens)}`}
                      />
                    )
                  })}
                </div>
                <div className="flex flex-wrap gap-2 mt-1">
                  {projects.map(([name]) => (
                    <span key={name} className="flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: allProjectNames.get(name) || '#71717a' }} />
                      <span className="text-[10px] text-muted">{name}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}

            {isExpanded && (
              <div className="px-3 pb-2 pl-7 space-y-1">
                {projects.map(([name, tokens]) => {
                  const pct = (tokens / maxTokens) * 100
                  const time = day.byProjectTime[name] || 0
                  return (
                    <div key={name} className="flex items-center gap-2" style={{ height: 24 }}>
                      <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: allProjectNames.get(name) || '#71717a' }} />
                      <span className="text-xs text-secondary truncate w-28 shrink-0">{name}</span>
                      <div className="flex-1 h-3 rounded overflow-hidden bg-hover">
                        <div
                          className="h-full rounded transition-all"
                          style={{ width: `${pct}%`, backgroundColor: allProjectNames.get(name) || '#71717a' }}
                        />
                      </div>
                      <span className="text-[11px] text-muted w-20 text-right shrink-0">
                        {formatDuration(time)} · {formatTokenCount(tokens)}
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}

      {visibleDays < data.filter(d => d.totalTokens > 0).length && (
        <button
          onClick={() => setVisibleDays(d => d + 14)}
          className="w-full py-2 text-xs text-muted hover:text-primary hover:bg-surface rounded-lg transition-colors"
        >
          {t('renderer.daily_timeline.load_more')}
        </button>
      )}
    </div>
  )
}
