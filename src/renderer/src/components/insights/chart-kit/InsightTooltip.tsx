import { useT } from '../../../i18n'
import { formatTokenCount, TOKEN_TYPE_COLORS } from '../shared'
import type { TokenBreakdown } from '../shared'

export interface InsightTooltipProps {
  /** Main label (e.g. date, model name). */
  label: string
  /** Primary metric value (token count or cost). */
  value: number
  /** Format: 'token' shows formatted token count, 'cost' shows USD. */
  format?: 'token' | 'cost'
  /** Optional token breakdown for detailed view. */
  tokenBreakdown?: TokenBreakdown | null
  /** Optional cost in USD. */
  costUsd?: number | null
  /** Ledger name for the cost. */
  ledgerName?: string
  /** Coverage percentage. */
  coveragePercent?: number | null
  /** Additional breakdown lines (e.g. by-source items). */
  breakdownItems?: Array<{ label: string; value: number; color?: string }>
}

const TOKEN_LABELS: Array<{ key: keyof TokenBreakdown; colorKey: keyof typeof TOKEN_TYPE_COLORS }> = [
  { key: 'nonCachedInputTokens', colorKey: 'nonCachedInput' },
  { key: 'cacheReadTokens', colorKey: 'cacheRead' },
  { key: 'cacheWriteTokens', colorKey: 'cacheWrite' },
  { key: 'outputTokens', colorKey: 'output' },
  { key: 'reasoningTokens', colorKey: 'reasoning' },
]

const TOKEN_I18N_KEYS: Record<keyof TokenBreakdown, string> = {
  nonCachedInputTokens: 'renderer.token_mix.non_cached_input',
  cacheReadTokens: 'renderer.token_mix.cache_read',
  cacheWriteTokens: 'renderer.token_mix.cache_write',
  outputTokens: 'renderer.token_mix.output',
  reasoningTokens: 'renderer.token_mix.reasoning',
}

export function InsightTooltip({
  label,
  value,
  format = 'token',
  tokenBreakdown,
  costUsd,
  ledgerName,
  coveragePercent,
  breakdownItems,
}: InsightTooltipProps) {
  const t = useT()
  const formattedValue = format === 'cost' ? `$${value.toFixed(2)}` : formatTokenCount(value)

  return (
    <div className="px-2.5 py-1.5 rounded bg-hover border border-edge text-xs text-primary shadow-lg space-y-1 min-w-[140px]">
      <div className="font-medium">{label}</div>
      <div className="text-sm font-semibold">{formattedValue}</div>

      {/* Token breakdown */}
      {tokenBreakdown && (
        <div className="space-y-0.5 pt-0.5 border-t border-edge">
          {TOKEN_LABELS.map(({ key, colorKey }) => {
            const count = tokenBreakdown[key]
            if (count === 0) return null
            return (
              <div key={key} className="flex items-center gap-1.5">
                <span
                  className="w-1.5 h-1.5 rounded-sm shrink-0"
                  style={{ backgroundColor: TOKEN_TYPE_COLORS[colorKey] }}
                />
                <span className="text-[10px] text-muted flex-1">{t(TOKEN_I18N_KEYS[key])}</span>
                <span className="text-[10px] text-secondary">{formatTokenCount(count)}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* Cost */}
      {costUsd != null && format !== 'cost' && (
        <div className="text-[10px] text-muted pt-0.5 border-t border-edge">
          {ledgerName ? `${ledgerName}: ` : ''}${costUsd.toFixed(4)}
        </div>
      )}

      {/* Coverage */}
      {coveragePercent != null && (
        <div className="text-[10px] text-faint">
          {t('renderer.chart_kit.coverage', { value0: coveragePercent.toFixed(1) })}
        </div>
      )}

      {/* Breakdown items */}
      {breakdownItems && breakdownItems.length > 0 && (
        <div className="space-y-0.5 pt-0.5 border-t border-edge">
          {breakdownItems.map(({ label: itemLabel, value: itemValue, color }) => (
            <div key={itemLabel} className="flex items-center gap-1.5">
              {color && (
                <span className="w-1.5 h-1.5 rounded-sm shrink-0" style={{ backgroundColor: color }} />
              )}
              <span className="text-[10px] text-muted flex-1">{itemLabel}</span>
              <span className="text-[10px] text-secondary">
                {format === 'cost' ? `$${itemValue.toFixed(2)}` : formatTokenCount(itemValue)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
