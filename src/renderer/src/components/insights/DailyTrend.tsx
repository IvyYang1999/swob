import { useState, useMemo, useCallback } from 'react'
import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { AnalysisScope } from '../../../../shared/analysis-scope-types'
import type { InsightsData, PreviousPeriodComparison } from './shared'
import { formatTokenCount } from './shared'
import { filterDaysToAnalysisRange } from './insights-range'
import { useT } from '../../i18n'
import type { MetricMode } from './chart-kit'
import { InsightsChartFrame } from './chart-kit'
import { InteractiveLegend } from './chart-kit'
import type { LegendItem } from './chart-kit'

interface DailyTrendProps {
  data: InsightsData
  range: AnalysisScope['range']
  previousPeriod?: PreviousPeriodComparison | null
  onDayClick?: (date: string) => void
}

interface ChartDatum {
  date: string
  dateLabel: string
  totalTokens: number | undefined
  inputTokens: number
  outputTokens: number
  costUsd: number | null
}

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`
  if (usd >= 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(4)}`
}

function DailyTrendTooltip({
  active,
  payload,
  label,
  metricMode,
}: {
  active?: boolean
  payload?: Array<{ value: number; dataKey: string; color?: string }>
  label?: string
  metricMode: MetricMode
}) {
  const t = useT()
  if (!active || !payload || payload.length === 0) return null

  return (
    <div className="px-2.5 py-1.5 rounded bg-hover border border-edge text-xs text-primary shadow-lg space-y-0.5 min-w-[140px]">
      <div className="font-medium">{label}</div>
      {payload
        .filter((p) => p.dataKey !== 'previousPeriod' && (p.value > 0 || (metricMode === 'cost' && p.value === undefined)))
        .map((p) => (
          <div key={p.dataKey} className="flex items-center gap-1.5">
            <span
              className="w-1.5 h-1.5 rounded-sm shrink-0"
              style={{ backgroundColor: p.color || '#6b7280' }}
            />
            <span className="text-muted flex-1">
              {p.dataKey === 'totalTokens' ? 'Total' :
               p.dataKey === 'inputTokens' ? 'Input' :
               p.dataKey === 'outputTokens' ? 'Output' :
               p.dataKey}
            </span>
            <span className="text-secondary">
              {p.value == null
                ? t('renderer.pricing.unpriced')
                : metricMode === 'cost' ? formatCost(p.value) : formatTokenCount(p.value)}
            </span>
          </div>
        ))}
      {payload.find((p) => p.dataKey === 'previousPeriod' && p.value > 0) && (
        <div className="text-[10px] text-faint pt-0.5 border-t border-edge">
          {t('renderer.chart_kit.previous_period')}: {
            metricMode === 'cost'
              ? formatCost(payload.find((p) => p.dataKey === 'previousPeriod')!.value)
              : formatTokenCount(payload.find((p) => p.dataKey === 'previousPeriod')!.value)
          }
        </div>
      )}
      <div className="text-[10px] text-faint">{t('renderer.daily_trend.click_to_drill')}</div>
    </div>
  )
}

export function DailyTrend({ data, range, previousPeriod, onDayClick }: DailyTrendProps) {
  const t = useT()
  const [metricMode, setMetricMode] = useState<MetricMode>('token')
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())

  const hasCost = data.byDate.some((d) => d.costUsd != null && d.costUsd > 0)

  const visibleData = useMemo(
    () => filterDaysToAnalysisRange(data.byDate, range),
    [data.byDate, range]
  )

  const chartData = useMemo<ChartDatum[]>(() =>
    visibleData.map((d) => ({
      date: d.date,
      dateLabel: d.date.slice(5),
      totalTokens: metricMode === 'cost'
        ? (d.costUsd != null ? d.costUsd : undefined)
        : d.totalTokens,
      inputTokens: metricMode === 'cost' ? 0 : d.inputTokens,
      outputTokens: metricMode === 'cost' ? 0 : d.outputTokens,
      costUsd: d.costUsd,
    })),
    [visibleData, metricMode]
  )

  const legendItems = useMemo<LegendItem[]>(() => {
    return metricMode === 'cost'
      ? [{ key: 'totalTokens', label: 'Cost', color: '#f59e0b' }]
      : [
          { key: 'inputTokens', label: 'Input', color: '#3b82f6' },
          { key: 'outputTokens', label: 'Output', color: '#f59e0b' },
        ]
  }, [metricMode])

  const handleToggle = useCallback((key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleChartClick = useCallback(
    (chartState: { activeLabel?: string | number | undefined } | null) => {
      const label = chartState?.activeLabel
      if (!label || !onDayClick) return
      const labelStr = String(label)
      const match = visibleData.find((d) => d.date.slice(5) === labelStr)
      if (match) onDayClick(match.date)
    },
    [onDayClick, visibleData]
  )

  const formatter = useCallback(
    (value: number) => metricMode === 'cost' ? formatCost(value) : formatTokenCount(value),
    [metricMode]
  )

  // Empty data: render DataQualityState via InsightsChartFrame instead of bare null
  if (chartData.length === 0) {
    return (
      <InsightsChartFrame title={t('renderer.daily_trend.title')} qualityState="no-data">
        {null}
      </InsightsChartFrame>
    )
  }

  return (
    <div className="space-y-2">
      {/* Controls: metric toggle only (breakdown removed -- backend has no per-day per-dimension data) */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Metric toggle */}
        <div className="flex rounded bg-hover text-[10px]">
          <button
            className={`px-1.5 py-0.5 rounded transition-colors ${metricMode === 'token' ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-primary'}`}
            onClick={() => setMetricMode('token')}
          >
            {t('renderer.chart_kit.metric_token')}
          </button>
          {hasCost && (
            <button
              className={`px-1.5 py-0.5 rounded transition-colors ${metricMode === 'cost' ? 'bg-accent/20 text-accent font-medium' : 'text-muted hover:text-primary'}`}
              onClick={() => setMetricMode('cost')}
            >
              {t('renderer.chart_kit.metric_cost')}
            </button>
          )}
        </div>

        {/* Coverage badge for cost mode */}
        {metricMode === 'cost' && data.valuation.coveragePercent > 0 && (
          <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-faint">
            {t('renderer.chart_kit.coverage', { value0: data.valuation.coveragePercent.toFixed(1) })}
          </span>
        )}
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={200}>
        <ComposedChart
          data={chartData}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          onClick={handleChartClick}
          style={{ cursor: onDayClick ? 'pointer' : undefined }}
        >
          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 10, fill: 'var(--color-muted)' }}
            axisLine={{ stroke: 'var(--color-edge)' }}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'var(--color-muted)' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={formatter}
            width={44}
          />
          <Tooltip
            content={
              <DailyTrendTooltip
                metricMode={metricMode}
              />
            }
          />

          {/* Token mode: stacked input/output areas */}
          {metricMode === 'token' && (
            <>
              {!hiddenKeys.has('inputTokens') && (
                <Area
                  type="monotone"
                  dataKey="inputTokens"
                  stackId="total"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.25}
                />
              )}
              {!hiddenKeys.has('outputTokens') && (
                <Area
                  type="monotone"
                  dataKey="outputTokens"
                  stackId="total"
                  stroke="#f59e0b"
                  fill="#f59e0b"
                  fillOpacity={0.25}
                />
              )}
            </>
          )}

          {/* Cost mode: single area — undefined values create gaps for unpriced days */}
          {metricMode === 'cost' && !hiddenKeys.has('totalTokens') && (
            <Area
              type="monotone"
              dataKey="totalTokens"
              stroke="#f59e0b"
              fill="#f59e0b"
              fillOpacity={0.25}
              connectNulls={false}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>

      {/* Interactive legend */}
      <InteractiveLegend items={legendItems} hiddenKeys={hiddenKeys} onToggle={handleToggle} />
    </div>
  )
}
