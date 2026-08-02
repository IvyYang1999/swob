import { useT } from '../../i18n'
import { formatTokenCount } from './shared'

export function HourlyChart({ hours, unknownTimeEvents = 0 }: { hours: number[]; unknownTimeEvents?: number }) {
  const t = useT()
  const max = Math.max(...hours, 1)
  const allZero = hours.every((h) => h === 0)
  // If all hourly slots are zero but there are events with unknown timestamps,
  // the hourly distribution is genuinely unavailable — not "24 zeros".
  if (allZero && unknownTimeEvents > 0) {
    return (
      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium text-primary">{t('renderer.hourly_chart.title')}</div>
        </div>
        <div className="flex flex-col items-center justify-center py-8 gap-2">
          <div className="text-2xl text-faint">---</div>
          <div className="text-xs text-muted">{t('renderer.chart_kit.unavailable')}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-primary">{t('renderer.hourly_chart.title')}</div>
        <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-faint">
          {t('renderer.hourly_chart.basis')}
        </span>
      </div>
      <div className="flex items-end gap-[2px] h-16">
        {hours.map((count, hour) => (
          <div key={hour} className="flex-1 flex flex-col items-center justify-end gap-0.5">
            <div
              className="w-full rounded-t bg-soft-blue transition-all"
              style={{ height: `${(count / max) * 100}%`, minHeight: count > 0 ? 2 : 0, opacity: 0.3 + (count / max) * 0.7 }}
              title={t('renderer.hourly_chart.tooltip', { hour: String(hour), value: formatTokenCount(count) })}
              aria-label={t('renderer.hourly_chart.tooltip', { hour: String(hour), value: formatTokenCount(count) })}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-faint">
        <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span>
      </div>
    </div>
  )
}
