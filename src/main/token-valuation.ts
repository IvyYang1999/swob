import {
  ACTIVE_PRICE_SNAPSHOT,
  PRICE_SNAPSHOT_REGISTRY,
  calculatePriceSnapshotHash,
  canonicalizeModel,
  type PriceSnapshot,
  type PricingRule
} from './pricing-catalog'
import {
  processedTotal,
  type NormalizedTokenComponents,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'

export type ValuationMode =
  | 'provider-billed'
  | 'harness-list-estimate'
  | 'swob-estimate'
  | 'api-equivalent'
  | 'subscription-allocated'
  | 'mixed'
  | 'unpriced'
export type PricingMatchKind = 'reported' | 'exact' | 'alias' | 'mixed' | 'none'

export interface PricingCalculationLine {
  component: 'input' | 'output' | 'cache-read' | 'cache-write' | 'cache-write-5m' | 'cache-write-1h'
  tokens: number
  usdPerMillion: number
  multiplier: number
  usd: number
}

export interface PricingTrace {
  eventDedupKey: string
  pricingRuleId: string
  provider: string
  modelCanonical: string
  eventTimestamp: string
  effectiveFrom: string
  effectiveTo?: string
  source: PricingRule['source']
  sourceUrl: string
  catalogVersion: string
  priceSnapshotHash: string
  longContext: boolean
  calculation: PricingCalculationLine[]
}

export interface CostLedgerBreakdown {
  providerBilledUsd?: number
  harnessListEstimateUsd?: number
  swobEstimateUsd?: number
  subscriptionAllocatedUsd?: number
}

export interface ValuationRevision {
  previousRevision: string
  previousSnapshotHash: string
  reason: 'official-price-catalog-update'
  notice: { 'zh-CN': string; en: string }
  previousUsd: number
  revisedUsd: number
  deltaUsd: number
}

export interface Valuation {
  usd?: number
  mode: ValuationMode
  pricingMatch: PricingMatchKind
  selectedLedger?: Exclude<ValuationMode, 'mixed' | 'unpriced'>
  ledgerBreakdown: CostLedgerBreakdown
  coveredTokens: number
  totalBillableTokens: number
  coveragePercent: number
  financialCoveredTokens: number
  financialCoveragePercent: number
  missingReasons: string[]
  pricingRules: PricingTrace[]
  priceRevision: string
  priceSnapshotHash: string
  priceRevisions: string[]
  revision?: ValuationRevision
  revisionNotices: Array<{ revision: string; notice: { 'zh-CN': string; en: string } }>
  whatIf?: boolean
  modeBreakdown: Partial<Record<Exclude<ValuationMode, 'mixed' | 'unpriced'>, number>>
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

function snapshotForCatalog(catalog: readonly PricingRule[]): PriceSnapshot {
  const snapshot: PriceSnapshot = {
    revision: 'custom-unversioned-price-preview',
    status: 'approved',
    generatedAt: '1970-01-01T00:00:00Z',
    reviewedAt: '1970-01-01T00:00:00Z',
    contentHash: '',
    sourcePipeline: [],
    rules: catalog
  }
  return { ...snapshot, contentHash: calculatePriceSnapshotHash(snapshot) }
}

function resolvedSnapshot(value?: PriceSnapshot | readonly PricingRule[]): PriceSnapshot {
  if (!value) return ACTIVE_PRICE_SNAPSHOT
  return Array.isArray(value) ? snapshotForCatalog(value) : value as PriceSnapshot
}

function emptyValuation(
  event: UsageEvent,
  snapshot: PriceSnapshot,
  missingReasons: string[],
  ledgerBreakdown: CostLedgerBreakdown = {}
): Valuation {
  const total = processedTotal(event.components)
  const selected = selectLedger(ledgerBreakdown)
  const financialCoveredTokens = ledgerBreakdown.providerBilledUsd !== undefined ? total : 0
  return {
    ...(selected.usd !== undefined ? { usd: selected.usd } : {}),
    mode: selected.mode || 'unpriced',
    ...(selected.mode ? { selectedLedger: selected.mode } : {}),
    pricingMatch: selected.mode ? 'reported' : 'none',
    ledgerBreakdown,
    coveredTokens: 0,
    totalBillableTokens: total,
    coveragePercent: 0,
    financialCoveredTokens,
    financialCoveragePercent: percent(financialCoveredTokens, total, ledgerBreakdown.providerBilledUsd !== undefined),
    missingReasons: [...new Set(missingReasons)],
    pricingRules: [],
    priceRevision: snapshot.revision,
    priceSnapshotHash: snapshot.contentHash,
    priceRevisions: [snapshot.revision],
    revisionNotices: [],
    modeBreakdown: modeBreakdown(ledgerBreakdown, undefined)
  }
}

function eventDate(timestamp?: string): number | undefined {
  if (!timestamp) return undefined
  const value = new Date(timestamp).getTime()
  return Number.isFinite(value) ? value : undefined
}

function matchRule(
  event: UsageEvent,
  snapshot: PriceSnapshot
): { rule: PricingRule; match: 'exact' | 'alias' } | undefined {
  if (!event.billingProvider || !event.modelCanonical) return undefined
  const at = eventDate(event.timestamp)
  if (at === undefined) return undefined
  const rules = snapshot.rules
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
  component: PricingCalculationLine['component'],
  tokens: number,
  price: number | undefined,
  multiplier: number,
  missingReason: string,
  state: { usd: number; covered: number; missing: string[]; calculation: PricingCalculationLine[] }
): number {
  if (tokens === 0) return 0
  if (price === undefined) {
    state.missing.push(missingReason)
    return 0
  }
  state.covered += tokens
  const usd = (tokens / 1_000_000) * price * multiplier
  state.usd += usd
  state.calculation.push({ component, tokens, usdPerMillion: price, multiplier, usd })
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

function reportedLedgers(event: UsageEvent): CostLedgerBreakdown {
  const ledgers: CostLedgerBreakdown = {}
  if (event.reportedCostUsd !== undefined) {
    const kind = event.reportedCostKind || 'harness-list-estimate'
    if (kind === 'provider-billed') ledgers.providerBilledUsd = event.reportedCostUsd
    else if (kind === 'swob-estimate') ledgers.swobEstimateUsd = event.reportedCostUsd
    else ledgers.harnessListEstimateUsd = event.reportedCostUsd
  }
  if (event.subscriptionAllocation) ledgers.subscriptionAllocatedUsd = event.subscriptionAllocation.usd
  return ledgers
}

function selectLedger(ledgers: CostLedgerBreakdown): {
  usd?: number
  mode?: Exclude<ValuationMode, 'mixed' | 'unpriced'>
} {
  if (ledgers.providerBilledUsd !== undefined) return { usd: ledgers.providerBilledUsd, mode: 'provider-billed' }
  if (ledgers.swobEstimateUsd !== undefined) return { usd: ledgers.swobEstimateUsd, mode: 'swob-estimate' }
  if (ledgers.harnessListEstimateUsd !== undefined) {
    return { usd: ledgers.harnessListEstimateUsd, mode: 'harness-list-estimate' }
  }
  if (ledgers.subscriptionAllocatedUsd !== undefined) {
    return { usd: ledgers.subscriptionAllocatedUsd, mode: 'subscription-allocated' }
  }
  return {}
}

function modeBreakdown(
  ledgers: CostLedgerBreakdown,
  swobDisplayMode: 'swob-estimate' | 'api-equivalent' | undefined
): Valuation['modeBreakdown'] {
  return {
    ...(ledgers.providerBilledUsd !== undefined ? { 'provider-billed': ledgers.providerBilledUsd } : {}),
    ...(ledgers.harnessListEstimateUsd !== undefined
      ? { 'harness-list-estimate': ledgers.harnessListEstimateUsd }
      : {}),
    ...(ledgers.swobEstimateUsd !== undefined && swobDisplayMode
      ? { [swobDisplayMode]: ledgers.swobEstimateUsd }
      : {}),
    ...(ledgers.subscriptionAllocatedUsd !== undefined
      ? { 'subscription-allocated': ledgers.subscriptionAllocatedUsd }
      : {})
  }
}

function valueUsageEventAtSnapshot(event: UsageEvent, snapshot: PriceSnapshot): Valuation {
  const totalBillableTokens = processedTotal(event.components)
  const ledgers = reportedLedgers(event)
  const baseReasons: string[] = []
  if (!event.modelRaw || event.modelRaw === '<synthetic>') baseReasons.push('model-unknown')
  else if (!event.modelCanonical) baseReasons.push('model-not-in-catalog')
  else if (event.modelProvenance === 'session-fallback' || event.modelProvenance === 'unknown') {
    baseReasons.push('model-provenance-not-request-level')
  } else if (!event.billingProvider || event.providerProvenance === 'unknown') baseReasons.push('provider-unknown')
  else if (!event.timestamp || eventDate(event.timestamp) === undefined) baseReasons.push('event-time-unknown')
  else {
    const modifierReason = unsupportedModifier(event)
    if (modifierReason) baseReasons.push(modifierReason)
  }
  if (baseReasons.length > 0) return emptyValuation(event, snapshot, baseReasons, ledgers)

  const matched = matchRule(event, snapshot)
  if (!matched) return emptyValuation(event, snapshot, ['no-exact-provider-model-date-rule'], ledgers)

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
  const state = { usd: 0, covered: 0, missing: [] as string[], calculation: [] as PricingCalculationLine[] }
  const componentUsd = {
    input: addPricedComponent('input', event.components.nonCachedInputTokens, rule.usdPerMillion.input,
      inputMultiplier, 'input-price-missing', state),
    output: addPricedComponent('output', event.components.outputTokens, rule.usdPerMillion.output,
      outputMultiplier, 'output-price-missing', state),
    cacheRead: addPricedComponent('cache-read', event.components.cacheReadTokens, rule.usdPerMillion.cacheRead,
      inputMultiplier, 'cache-read-price-missing', state),
    cacheWrite: addPricedComponent('cache-write', event.components.cacheWriteTokens, rule.usdPerMillion.cacheWrite,
      inputMultiplier, event.semantics === 'anthropic-disjoint' ? 'cache-write-ttl-unknown' : 'cache-write-price-missing', state),
    cacheWrite5m: addPricedComponent('cache-write-5m', event.components.cacheWrite5mTokens,
      rule.usdPerMillion.cacheWrite5m, inputMultiplier, 'cache-write-5m-price-missing', state),
    cacheWrite1h: addPricedComponent('cache-write-1h', event.components.cacheWrite1hTokens,
      rule.usdPerMillion.cacheWrite1h, inputMultiplier, 'cache-write-1h-price-missing', state)
  }
  const trace: PricingTrace = {
    eventDedupKey: event.dedupKey,
    pricingRuleId: rule.id,
    provider: rule.provider,
    modelCanonical: rule.modelCanonical,
    eventTimestamp: event.timestamp!,
    effectiveFrom: rule.effectiveFrom,
    effectiveTo: rule.effectiveTo,
    source: rule.source,
    sourceUrl: rule.sourceUrl,
    catalogVersion: snapshot.revision,
    priceSnapshotHash: snapshot.contentHash,
    longContext: isLongContext,
    calculation: state.calculation
  }
  if (state.covered > 0 || totalBillableTokens === 0) ledgers.swobEstimateUsd = state.usd
  if (state.covered === 0 && totalBillableTokens > 0) {
    const result = emptyValuation(event, snapshot, state.missing, ledgers)
    return { ...result, pricingRules: [trace] }
  }

  const swobDisplayMode = event.providerProvenance === 'inferred' ? 'api-equivalent' : 'swob-estimate'
  const selected = selectLedger(ledgers)
  const financialCoveredTokens = ledgers.providerBilledUsd !== undefined ? totalBillableTokens : 0
  return {
    ...(selected.usd !== undefined ? { usd: selected.usd } : {}),
    mode: selected.mode === 'swob-estimate' ? swobDisplayMode : selected.mode || 'unpriced',
    ...(selected.mode
      ? { selectedLedger: selected.mode === 'swob-estimate' ? swobDisplayMode : selected.mode }
      : {}),
    pricingMatch: matched.match,
    ledgerBreakdown: ledgers,
    coveredTokens: state.covered,
    totalBillableTokens,
    coveragePercent: percent(state.covered, totalBillableTokens, true),
    financialCoveredTokens,
    financialCoveragePercent: percent(financialCoveredTokens, totalBillableTokens, ledgers.providerBilledUsd !== undefined),
    missingReasons: [...new Set(state.missing)],
    pricingRules: [trace],
    priceRevision: snapshot.revision,
    priceSnapshotHash: snapshot.contentHash,
    priceRevisions: [snapshot.revision],
    revisionNotices: [],
    modeBreakdown: modeBreakdown(ledgers, swobDisplayMode),
    componentUsd
  }
}

function withRevisionAudit(event: UsageEvent, current: Valuation, snapshot: PriceSnapshot): Valuation {
  if (!snapshot.replaces || !snapshot.revisionReason || !snapshot.revisionNotice) return current
  const previousSnapshot = PRICE_SNAPSHOT_REGISTRY.get(snapshot.replaces)
  if (!previousSnapshot) return current
  const previous = valueUsageEventAtSnapshot(event, previousSnapshot)
  const previousUsd = previous.ledgerBreakdown.swobEstimateUsd
  const revisedUsd = current.ledgerBreakdown.swobEstimateUsd
  if (previousUsd === undefined || revisedUsd === undefined || Math.abs(previousUsd - revisedUsd) < 1e-12) return current
  return {
    ...current,
    revision: {
      previousRevision: previousSnapshot.revision,
      previousSnapshotHash: previousSnapshot.contentHash,
      reason: snapshot.revisionReason,
      notice: snapshot.revisionNotice,
      previousUsd,
      revisedUsd,
      deltaUsd: revisedUsd - previousUsd
    },
    revisionNotices: [{ revision: snapshot.revision, notice: snapshot.revisionNotice }]
  }
}

export function valueUsageEvent(
  event: UsageEvent,
  catalogOrSnapshot?: PriceSnapshot | readonly PricingRule[]
): Valuation {
  const snapshot = resolvedSnapshot(catalogOrSnapshot)
  const current = valueUsageEventAtSnapshot(event, snapshot)
  return snapshot.revision === ACTIVE_PRICE_SNAPSHOT.revision
    ? withRevisionAudit(event, current, snapshot)
    : current
}

export function previewUsageEventRepricing(event: UsageEvent, targetRevision: string): Valuation {
  const snapshot = PRICE_SNAPSHOT_REGISTRY.get(targetRevision)
  if (!snapshot) throw new Error(`Unknown approved price revision: ${targetRevision}`)
  return { ...valueUsageEventAtSnapshot(event, snapshot), whatIf: true }
}

function addLedgerBreakdown(target: CostLedgerBreakdown, source: CostLedgerBreakdown): void {
  for (const key of Object.keys(source) as Array<keyof CostLedgerBreakdown>) {
    const amount = source[key]
    if (amount !== undefined) target[key] = (target[key] || 0) + amount
  }
}

function aggregateMode(valuations: Valuation[]): ValuationMode {
  const modes = new Set(valuations.filter((value) => value.usd !== undefined).map((value) => value.mode))
  if (modes.size === 0) return 'unpriced'
  if (modes.size === 1) return [...modes][0]
  return 'mixed'
}

export function aggregateValuations(valuations: Valuation[]): Valuation {
  const priced = valuations.filter((valuation) => valuation.usd !== undefined)
  const totalBillableTokens = valuations.reduce((sum, valuation) => sum + valuation.totalBillableTokens, 0)
  const coveredTokens = valuations.reduce((sum, valuation) => sum + valuation.coveredTokens, 0)
  const financialCoveredTokens = valuations.reduce((sum, valuation) => sum + valuation.financialCoveredTokens, 0)
  const usd = priced.length > 0 ? priced.reduce((sum, valuation) => sum + valuation.usd!, 0) : undefined
  const matchKinds = new Set(priced.map((valuation) => valuation.pricingMatch))
  const modeBreakdown: Valuation['modeBreakdown'] = {}
  const ledgerBreakdown: CostLedgerBreakdown = {}
  for (const valuation of valuations) {
    addLedgerBreakdown(ledgerBreakdown, valuation.ledgerBreakdown)
    for (const [mode, amount] of Object.entries(valuation.modeBreakdown)) {
      const key = mode as keyof Valuation['modeBreakdown']
      modeBreakdown[key] = (modeBreakdown[key] || 0) + (amount || 0)
    }
  }
  const priceRevisions = [...new Set(valuations.flatMap((valuation) => valuation.priceRevisions))]
  const revisionNotices = [...new Map(valuations.flatMap((valuation) => valuation.revisionNotices)
    .map((notice) => [notice.revision, notice] as const)).values()]
  const mode = aggregateMode(valuations)
  return {
    ...(usd !== undefined ? { usd } : {}),
    mode,
    ...(mode !== 'mixed' && mode !== 'unpriced' ? { selectedLedger: mode } : {}),
    pricingMatch: priced.length === 0 ? 'none' : matchKinds.size === 1 ? [...matchKinds][0] : 'mixed',
    ledgerBreakdown,
    coveredTokens,
    totalBillableTokens,
    coveragePercent: percent(coveredTokens, totalBillableTokens, usd !== undefined),
    financialCoveredTokens,
    financialCoveragePercent: percent(financialCoveredTokens, totalBillableTokens, false),
    missingReasons: [...new Set(valuations.flatMap((valuation) => valuation.missingReasons))],
    pricingRules: [...new Map(valuations.flatMap((valuation) => valuation.pricingRules)
      .map((trace) => [`${trace.eventDedupKey}\0${trace.pricingRuleId}`, trace] as const)).values()],
    priceRevision: priceRevisions.length === 1 ? priceRevisions[0] : 'mixed',
    priceSnapshotHash: priceRevisions.length === 1
      ? valuations.find((valuation) => valuation.priceRevision === priceRevisions[0])?.priceSnapshotHash || ''
      : 'mixed',
    priceRevisions,
    revisionNotices,
    modeBreakdown
  }
}

export function valueUsageEvents(
  events: UsageEvent[],
  catalogOrSnapshot?: PriceSnapshot | readonly PricingRule[]
): Valuation {
  const unique = new Map<string, UsageEvent>()
  for (const event of events) unique.set(event.billingFactKey || event.dedupKey, event)
  return aggregateValuations([...unique.values()].map((event) => valueUsageEvent(event, catalogOrSnapshot)))
}

export function valuationForAccounting(
  accounting: TokenAccounting,
  catalogOrSnapshot?: PriceSnapshot | readonly PricingRule[]
): Valuation {
  return valueUsageEvents(accounting.usageEvents, catalogOrSnapshot)
}
