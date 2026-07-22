import {
  EMBEDDED_PRICING_CATALOG,
  canonicalizeModel,
  type PricingRule
} from './pricing-catalog'
import {
  processedTotal,
  type NormalizedTokenComponents,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'

export type ValuationMode = 'reported' | 'estimated-list-price' | 'api-equivalent' | 'unpriced'
export type PricingMatchKind = 'reported' | 'exact' | 'alias' | 'mixed' | 'none'

export interface PricingTrace {
  pricingRuleId: string
  provider: string
  modelCanonical: string
  eventTimestamp: string
  effectiveFrom: string
  effectiveTo?: string
  source: PricingRule['source']
  sourceUrl: string
  catalogVersion: string
  longContext: boolean
}

export interface Valuation {
  usd?: number
  mode: ValuationMode
  pricingMatch: PricingMatchKind
  coveredTokens: number
  totalBillableTokens: number
  coveragePercent: number
  missingReasons: string[]
  pricingRules: PricingTrace[]
  modeBreakdown: Partial<Record<Exclude<ValuationMode, 'unpriced'>, number>>
  componentUsd?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cacheWrite5m: number
    cacheWrite1h: number
  }
}

function percent(covered: number, total: number, hasValue: boolean): number {
  if (total === 0) return hasValue ? 100 : 0
  return (covered / total) * 100
}

function unpriced(event: UsageEvent, ...reasons: string[]): Valuation {
  const total = processedTotal(event.components)
  return {
    mode: 'unpriced',
    pricingMatch: 'none',
    coveredTokens: 0,
    totalBillableTokens: total,
    coveragePercent: 0,
    missingReasons: [...new Set(reasons)],
    pricingRules: [],
    modeBreakdown: {}
  }
}

function eventDate(timestamp?: string): number | undefined {
  if (!timestamp) return undefined
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : undefined
}

function matchRule(
  event: UsageEvent,
  catalog: readonly PricingRule[]
): { rule: PricingRule; match: 'exact' | 'alias' } | undefined {
  if (!event.billingProvider || !event.modelCanonical) return undefined
  const at = eventDate(event.timestamp)
  if (at === undefined) return undefined
  const rules = catalog
    .filter((rule) => rule.provider === event.billingProvider && rule.modelCanonical === event.modelCanonical)
    .filter((rule) => {
      const from = new Date(rule.effectiveFrom).getTime()
      const to = rule.effectiveTo ? new Date(rule.effectiveTo).getTime() : Number.POSITIVE_INFINITY
      return at >= from && at < to
    })
    .sort((left, right) => new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime())
  const rule = rules[0]
  if (!rule) return undefined
  return { rule, match: canonicalizeModel(event.modelRaw)?.match || 'exact' }
}

function addPricedComponent(
  tokens: number,
  price: number | undefined,
  multiplier: number,
  missingReason: string,
  state: { usd: number; covered: number; missing: string[] }
): number {
  if (tokens === 0) return 0
  if (price === undefined) {
    state.missing.push(missingReason)
    return 0
  }
  state.covered += tokens
  const usd = (tokens / 1_000_000) * price * multiplier
  state.usd += usd
  return usd
}

function inputTokens(components: NormalizedTokenComponents): number {
  return components.nonCachedInputTokens + components.cacheReadTokens + components.cacheWriteTokens +
    components.cacheWrite5mTokens + components.cacheWrite1hTokens
}

function unsupportedModifier(event: UsageEvent): string | undefined {
  if (event.isBatch) return 'batch-price-not-modeled'
  if (event.serviceTier && !['standard', 'default'].includes(event.serviceTier.toLowerCase())) {
    return 'service-tier-price-not-modeled'
  }
  if (event.speed && event.speed.toLowerCase() !== 'standard') return 'speed-price-not-modeled'
  if (event.inferenceRegion) return 'regional-price-not-modeled'
  return undefined
}

export function valueUsageEvent(
  event: UsageEvent,
  catalog: readonly PricingRule[] = EMBEDDED_PRICING_CATALOG
): Valuation {
  const totalBillableTokens = processedTotal(event.components)
  if (event.reportedCostUsd !== undefined) {
    return {
      usd: event.reportedCostUsd,
      mode: 'reported',
      pricingMatch: 'reported',
      coveredTokens: totalBillableTokens,
      totalBillableTokens,
      coveragePercent: percent(totalBillableTokens, totalBillableTokens, true),
      missingReasons: [],
      pricingRules: [],
      modeBreakdown: { reported: event.reportedCostUsd }
    }
  }
  if (!event.modelRaw || event.modelRaw === '<synthetic>') return unpriced(event, 'model-unknown')
  if (!event.modelCanonical) return unpriced(event, 'model-not-in-catalog')
  if (event.modelProvenance === 'session-fallback' || event.modelProvenance === 'unknown') {
    return unpriced(event, 'model-provenance-not-request-level')
  }
  if (!event.billingProvider || event.providerProvenance === 'unknown') return unpriced(event, 'provider-unknown')
  if (!event.timestamp || eventDate(event.timestamp) === undefined) return unpriced(event, 'event-time-unknown')

  // P2 will add tier/region/fast/batch rules. Until then, an explicit modifier
  // is evidence that the standard list-price rule may be wrong, so do not quote.
  const modifierReason = unsupportedModifier(event)
  if (modifierReason) return unpriced(event, modifierReason)

  const matched = matchRule(event, catalog)
  if (!matched) return unpriced(event, 'no-exact-provider-model-date-rule')

  const { rule } = matched
  const isLongContext = Boolean(
    rule.contextThresholdTokens && inputTokens(event.components) > rule.contextThresholdTokens
  )
  const inputMultiplier = isLongContext && rule.thresholdMode === 'whole-request'
    ? rule.longContextMultiplier?.input || 1
    : 1
  const outputMultiplier = isLongContext && rule.thresholdMode === 'whole-request'
    ? rule.longContextMultiplier?.output || 1
    : 1
  const state = { usd: 0, covered: 0, missing: [] as string[] }
  const componentUsd = {
    input: addPricedComponent(
      event.components.nonCachedInputTokens,
      rule.usdPerMillion.input,
      inputMultiplier,
      'input-price-missing',
      state
    ),
    output: addPricedComponent(
      event.components.outputTokens,
      rule.usdPerMillion.output,
      outputMultiplier,
      'output-price-missing',
      state
    ),
    cacheRead: addPricedComponent(
      event.components.cacheReadTokens,
      rule.usdPerMillion.cacheRead,
      inputMultiplier,
      'cache-read-price-missing',
      state
    ),
    cacheWrite: addPricedComponent(
      event.components.cacheWriteTokens,
      rule.usdPerMillion.cacheWrite,
      inputMultiplier,
      event.semantics === 'anthropic-disjoint' ? 'cache-write-ttl-unknown' : 'cache-write-price-missing',
      state
    ),
    cacheWrite5m: addPricedComponent(
      event.components.cacheWrite5mTokens,
      rule.usdPerMillion.cacheWrite5m,
      inputMultiplier,
      'cache-write-5m-price-missing',
      state
    ),
    cacheWrite1h: addPricedComponent(
      event.components.cacheWrite1hTokens,
      rule.usdPerMillion.cacheWrite1h,
      inputMultiplier,
      'cache-write-1h-price-missing',
      state
    )
  }
  const mode: ValuationMode = event.providerProvenance === 'inferred'
    ? 'api-equivalent'
    : 'estimated-list-price'
  const trace: PricingTrace = {
    pricingRuleId: rule.id,
    provider: rule.provider,
    modelCanonical: rule.modelCanonical,
    eventTimestamp: event.timestamp,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    source: rule.source,
    sourceUrl: rule.sourceUrl,
    catalogVersion: rule.catalogVersion,
    longContext: isLongContext
  }
  if (state.covered === 0 && totalBillableTokens > 0) {
    return {
      mode: 'unpriced',
      pricingMatch: 'none',
      coveredTokens: 0,
      totalBillableTokens,
      coveragePercent: 0,
      missingReasons: [...new Set(state.missing)],
      pricingRules: [trace],
      modeBreakdown: {}
    }
  }
  return {
    usd: state.usd,
    mode,
    pricingMatch: matched.match,
    coveredTokens: state.covered,
    totalBillableTokens,
    coveragePercent: percent(state.covered, totalBillableTokens, true),
    missingReasons: [...new Set(state.missing)],
    pricingRules: [trace],
    modeBreakdown: { [mode]: state.usd },
    componentUsd
  }
}

function aggregateMode(valuations: Valuation[]): ValuationMode {
  const valuedModes = new Set(valuations.filter((value) => value.usd !== undefined).map((value) => value.mode))
  if (valuedModes.size === 0) return 'unpriced'
  if (valuedModes.size === 1) return [...valuedModes][0]
  if (valuedModes.has('api-equivalent')) return 'api-equivalent'
  if (valuedModes.has('estimated-list-price')) return 'estimated-list-price'
  return 'reported'
}

export function aggregateValuations(valuations: Valuation[]): Valuation {
  const priced = valuations.filter((valuation) => valuation.usd !== undefined)
  const totalBillableTokens = valuations.reduce((sum, valuation) => sum + valuation.totalBillableTokens, 0)
  const coveredTokens = valuations.reduce((sum, valuation) => sum + valuation.coveredTokens, 0)
  const usd = priced.length > 0 ? priced.reduce((sum, valuation) => sum + valuation.usd!, 0) : undefined
  const matchKinds = new Set(priced.map((valuation) => valuation.pricingMatch))
  const modeBreakdown: Valuation['modeBreakdown'] = {}
  for (const valuation of priced) {
    for (const [mode, amount] of Object.entries(valuation.modeBreakdown)) {
      const key = mode as keyof Valuation['modeBreakdown']
      modeBreakdown[key] = (modeBreakdown[key] || 0) + (amount || 0)
    }
  }
  return {
    usd,
    mode: aggregateMode(valuations),
    pricingMatch: priced.length === 0 ? 'none' : matchKinds.size === 1 ? [...matchKinds][0] : 'mixed',
    coveredTokens,
    totalBillableTokens,
    coveragePercent: percent(coveredTokens, totalBillableTokens, usd !== undefined),
    missingReasons: [...new Set(valuations.flatMap((valuation) => valuation.missingReasons))],
    pricingRules: [...new Map(
      valuations.flatMap((valuation) => valuation.pricingRules)
        .map((trace) => [trace.pricingRuleId, trace] as const)
    ).values()],
    modeBreakdown
  }
}

export function valueUsageEvents(
  events: UsageEvent[],
  catalog: readonly PricingRule[] = EMBEDDED_PRICING_CATALOG
): Valuation {
  const unique = new Map<string, UsageEvent>()
  for (const event of events) unique.set(event.dedupKey, event)
  return aggregateValuations([...unique.values()].map((event) => valueUsageEvent(event, catalog)))
}

export function valuationForAccounting(
  accounting: TokenAccounting,
  catalog: readonly PricingRule[] = EMBEDDED_PRICING_CATALOG
): Valuation {
  return valueUsageEvents(accounting.usageEvents, catalog)
}
