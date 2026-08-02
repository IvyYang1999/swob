import { useMemo } from 'react'
import { useT } from '../../i18n'
import { formatTokenCount, TOKEN_TYPE_COLORS } from './shared'
import type { TokenBreakdown } from './shared'
// Note: InsightsChartFrame removed from this component — the parent widget
// renderer (builtin-widget-registry) wraps TokenMixChart in InsightsChartFrame,
// so using it here would create double card nesting.

interface TokenMixChartProps {
  /** Global token breakdown. */
  breakdown: TokenBreakdown
  /** Optional focused breakdown (e.g. selected source/model/project). */
  focusedBreakdown?: TokenBreakdown | null
  focusedLabel?: string
}

interface SegmentData {
  key: string
  label: string
  value: number
  color: string
  percent: number
}

function buildSegments(breakdown: TokenBreakdown, t: (key: string) => string): SegmentData[] {
  // Reasoning tokens are a SUBSET of output tokens — do not double-count.
  // Show (output - reasoning) as plain output and reasoning as its own segment.
  const plainOutput = Math.max(0, breakdown.outputTokens - breakdown.reasoningTokens)
  const total =
    breakdown.nonCachedInputTokens +
    breakdown.cacheReadTokens +
    breakdown.cacheWriteTokens +
    plainOutput +
    breakdown.reasoningTokens
  const safeTotal = total || 1
  return [
    {
      key: 'nonCachedInput',
      label: t('renderer.token_mix.non_cached_input'),
      value: breakdown.nonCachedInputTokens,
      color: TOKEN_TYPE_COLORS.nonCachedInput,
      percent: (breakdown.nonCachedInputTokens / safeTotal) * 100,
    },
    {
      key: 'cacheRead',
      label: t('renderer.token_mix.cache_read'),
      value: breakdown.cacheReadTokens,
      color: TOKEN_TYPE_COLORS.cacheRead,
      percent: (breakdown.cacheReadTokens / safeTotal) * 100,
    },
    {
      key: 'cacheWrite',
      label: t('renderer.token_mix.cache_write'),
      value: breakdown.cacheWriteTokens,
      color: TOKEN_TYPE_COLORS.cacheWrite,
      percent: (breakdown.cacheWriteTokens / safeTotal) * 100,
    },
    {
      key: 'output',
      label: t('renderer.token_mix.output'),
      value: plainOutput,
      color: TOKEN_TYPE_COLORS.output,
      percent: (plainOutput / safeTotal) * 100,
    },
    {
      key: 'reasoning',
      label: t('renderer.token_mix.reasoning'),
      value: breakdown.reasoningTokens,
      color: TOKEN_TYPE_COLORS.reasoning,
      percent: (breakdown.reasoningTokens / safeTotal) * 100,
    },
  ].filter((s) => s.value > 0)
}

function HorizontalSegmentedBar({ segments }: { segments: SegmentData[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0)
  if (total === 0) return null
  return (
    <div className="space-y-1.5">
      <div className="flex h-6 rounded overflow-hidden">
        {segments.map((s) => (
          <div
            key={s.key}
            className="flex items-center justify-center text-[9px] text-white font-medium transition-all"
            style={{
              width: `${s.percent}%`,
              backgroundColor: s.color,
              minWidth: s.percent > 0 ? 2 : 0,
            }}
            title={`${s.label}: ${formatTokenCount(s.value)} (${s.percent.toFixed(1)}%)`}
          >
            {s.percent > 8 ? `${s.percent.toFixed(0)}%` : ''}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5">
        {segments.map((s) => (
          <div key={s.key} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm shrink-0" style={{ backgroundColor: s.color }} />
            <span className="text-[10px] text-muted">{s.label}</span>
            <span className="text-[10px] text-secondary">{formatTokenCount(s.value)}</span>
            <span className="text-[10px] text-faint">({s.percent.toFixed(1)}%)</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function TokenMixChart({ breakdown, focusedBreakdown, focusedLabel }: TokenMixChartProps) {
  const t = useT()
  const globalSegments = useMemo(() => buildSegments(breakdown, t), [breakdown, t])
  const focusedSegments = useMemo(
    () => focusedBreakdown ? buildSegments(focusedBreakdown, t) : null,
    [focusedBreakdown, t]
  )

  // ALL hooks must be called before any conditional return (React rules of hooks)
  const chartData = useMemo(() => {
    if (!focusedSegments || !focusedLabel) return null
    const allKeys = new Set([
      ...globalSegments.map((s) => s.key),
      ...focusedSegments.map((s) => s.key),
    ])
    return Array.from(allKeys).map((key) => {
      const global = globalSegments.find((s) => s.key === key)
      const focused = focusedSegments.find((s) => s.key === key)
      return {
        key,
        label: global?.label || focused?.label || key,
        color: global?.color || focused?.color || '#6b7280',
        global: global?.value || 0,
        focused: focused?.value || 0,
      }
    })
  }, [globalSegments, focusedSegments, focusedLabel])

  // Empty data: return a simple no-data indicator.
  // The parent widget renderer wraps this in InsightsChartFrame,
  // so we must not nest another InsightsChartFrame here.
  if (globalSegments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <div className="text-2xl text-faint">---</div>
        <div className="text-xs text-muted">{t('renderer.chart_kit.no_data')}</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Global segmented bar */}
      <HorizontalSegmentedBar segments={globalSegments} />

      {/* Focused comparison */}
      {chartData && focusedLabel && (
        <div className="space-y-1.5 pt-2 border-t border-edge">
          <div className="text-[10px] text-muted">{focusedLabel}</div>
          {focusedSegments && <HorizontalSegmentedBar segments={focusedSegments} />}
        </div>
      )}
    </div>
  )
}
