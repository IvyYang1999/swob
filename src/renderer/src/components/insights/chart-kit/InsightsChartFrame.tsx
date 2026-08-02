import type { ReactNode } from 'react'
import { useStore } from '../../../store'
import { useAnalysisScope, scopeRangeLabel } from '../scope'
import { useT } from '../../../i18n'

export type MetricMode = 'token' | 'cost'
export type BreakdownMode = 'total' | 'by-source' | 'by-model' | 'by-project'
export type DataQualityState = 'ok' | 'no-data' | 'unavailable' | 'partial' | 'pending'

export interface ChartFrameProps {
  title: string
  titleEn?: string
  children: ReactNode
  /** Override the automatic scope label in the top-right badge. */
  rangeOverride?: string
  tooltip?: string
  className?: string
  /** Active metric mode (token vs cost). */
  metricMode?: MetricMode
  onMetricChange?: (mode: MetricMode) => void
  /** Active breakdown mode. */
  breakdownMode?: BreakdownMode
  onBreakdownChange?: (mode: BreakdownMode) => void
  /** Coverage percentage to display as badge when metric is cost. */
  coveragePercent?: number | null
  /** Data quality state determines rendering mode. */
  qualityState?: DataQualityState
  /** Optional reason when qualityState is 'unavailable'. */
  unavailableReason?: string
}

function MetricToggle({
  mode,
  onChange,
}: {
  mode: MetricMode
  onChange: (mode: MetricMode) => void
}) {
  const t = useT()
  return (
    <div className="flex rounded bg-hover text-[10px]">
      <button
        className={`px-1.5 py-0.5 rounded transition-colors ${mode === 'token' ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-primary'}`}
        onClick={() => onChange('token')}
      >
        {t('renderer.chart_kit.metric_token')}
      </button>
      <button
        className={`px-1.5 py-0.5 rounded transition-colors ${mode === 'cost' ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-primary'}`}
        onClick={() => onChange('cost')}
      >
        {t('renderer.chart_kit.metric_cost')}
      </button>
    </div>
  )
}

function BreakdownToggle({
  mode,
  onChange,
}: {
  mode: BreakdownMode
  onChange: (mode: BreakdownMode) => void
}) {
  const t = useT()
  const options: Array<{ key: BreakdownMode; label: string }> = [
    { key: 'total', label: t('renderer.chart_kit.breakdown_total') },
    { key: 'by-source', label: t('renderer.chart_kit.breakdown_by_source') },
    { key: 'by-model', label: t('renderer.chart_kit.breakdown_by_model') },
    { key: 'by-project', label: t('renderer.chart_kit.breakdown_by_project') },
  ]
  return (
    <div className="flex rounded bg-hover text-[10px]">
      {options.map(({ key, label }) => (
        <button
          key={key}
          className={`px-1.5 py-0.5 rounded transition-colors ${mode === key ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-primary'}`}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function CoverageBadge({ percent }: { percent: number }) {
  const t = useT()
  return (
    <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-faint">
      {t('renderer.chart_kit.coverage', { value0: percent.toFixed(1) })}
    </span>
  )
}

function DataQualityOverlay({ state, reason }: { state: DataQualityState; reason?: string }) {
  const t = useT()
  if (state === 'ok' || state === 'partial') return null

  const config = {
    'no-data': { text: t('renderer.chart_kit.no_data'), icon: '---' },
    'unavailable': { text: t('renderer.chart_kit.unavailable'), icon: '!' },
    'pending': { text: t('renderer.chart_kit.in_development'), icon: '...' },
  } as const

  const { text, icon } = config[state]
  return (
    <div className="flex flex-col items-center justify-center py-8 gap-2">
      <div className="text-2xl text-faint">{icon}</div>
      <div className="text-xs text-muted">{text}</div>
      {reason && <div className="text-[10px] text-faint">{reason}</div>}
      {state === 'pending' && (
        <div className="text-[10px] text-faint">{t('renderer.chart_kit.in_development_hint')}</div>
      )}
    </div>
  )
}

export function InsightsChartFrame({
  title,
  titleEn,
  children,
  rangeOverride,
  tooltip,
  className,
  metricMode,
  onMetricChange,
  breakdownMode,
  onBreakdownChange,
  coveragePercent,
  qualityState = 'ok',
  unavailableReason,
}: ChartFrameProps) {
  const locale = useStore((s) => s.locale)
  const { scope } = useAnalysisScope()
  const label = locale === 'zh-CN' ? title : (titleEn || title)
  const showContent = qualityState === 'ok' || qualityState === 'partial'

  return (
    <div className={`bg-surface rounded-lg p-4 border border-edge space-y-2 min-w-0 ${className || ''}`} title={tooltip}>
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-sm font-medium text-primary truncate">{label}</div>
        <div className="flex items-center gap-1.5 ml-auto shrink-0 flex-wrap">
          {onMetricChange && metricMode && (
            <MetricToggle mode={metricMode} onChange={onMetricChange} />
          )}
          {onBreakdownChange && breakdownMode && (
            <BreakdownToggle mode={breakdownMode} onChange={onBreakdownChange} />
          )}
          {metricMode === 'cost' && coveragePercent != null && (
            <CoverageBadge percent={coveragePercent} />
          )}
          <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[10px] text-faint">
            {scopeRangeLabel(scope, locale, rangeOverride)}
          </span>
        </div>
      </div>

      {/* Content or quality overlay */}
      {showContent ? children : <DataQualityOverlay state={qualityState} reason={unavailableReason} />}

      {/* Coverage note for partial data */}
      {qualityState === 'partial' && coveragePercent != null && (
        <CoverageBadge percent={coveragePercent} />
      )}
    </div>
  )
}
