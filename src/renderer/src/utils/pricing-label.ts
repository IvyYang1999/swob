import type { Valuation } from '../components/insights/shared'

export type PricingLabel = 'exact' | 'estimate' | 'partial' | 'mixed' | 'unpriced' | 'subscription'

/**
 * Determine the pricing quality label from the ACTUAL valuation object.
 *
 * "exact" requires ALL of:
 *   - has USD amount
 *   - mode is 'provider-billed' (real provider billing evidence)
 *   - pricingMatch is 'reported' or 'exact'
 *   - coveragePercent === 100
 *   - zero missingReasons
 *
 * Everything else with an amount is 'estimate', 'partial', or 'mixed'
 * depending on coverage and pricing mode diversity.
 */
export function getPricingLabel(valuation: Valuation): PricingLabel {
  if (valuation.usd === undefined || valuation.mode === 'unpriced') return 'unpriced'

  if (
    valuation.mode === 'provider-billed' &&
    (valuation.pricingMatch === 'reported' || valuation.pricingMatch === 'exact') &&
    valuation.coveragePercent === 100 &&
    valuation.missingReasons.length === 0
  ) return 'exact'

  if (valuation.mode === 'mixed' || valuation.pricingMatch === 'mixed') return 'mixed'

  if (valuation.mode === 'subscription-allocated') return 'subscription'

  if (valuation.coveragePercent < 100) return 'partial'

  return 'estimate'
}

const LABEL_COLORS: Record<PricingLabel, string> = {
  exact: 'text-soft-emerald',
  estimate: 'text-soft-amber',
  partial: 'text-soft-amber',
  mixed: 'text-soft-amber',
  subscription: 'text-violet-400',
  unpriced: 'text-muted',
}

const LABEL_BG_COLORS: Record<PricingLabel, string> = {
  exact: 'bg-soft-emerald/10 border-soft-emerald/25',
  estimate: 'bg-soft-amber/10 border-soft-amber/25',
  partial: 'bg-soft-amber/10 border-soft-amber/25',
  mixed: 'bg-soft-amber/10 border-soft-amber/25',
  subscription: 'bg-violet-400/10 border-violet-400/25',
  unpriced: 'bg-muted/10 border-muted/25',
}

export function pricingLabelColor(label: PricingLabel): string {
  return LABEL_COLORS[label]
}

export function pricingLabelBgColor(label: PricingLabel): string {
  return LABEL_BG_COLORS[label]
}
