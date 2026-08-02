import {
  ACTIVE_PRICE_SNAPSHOT,
  PRICE_SNAPSHOT_REGISTRY,
  assertPriceCandidateIntegrity,
  calculatePriceSnapshotHash,
  canonicalizeModel,
  type PriceCandidateSnapshot,
  type PriceSnapshot,
  type PricingDimensions,
  type PricingRule,
  type UnitPricingRule
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

export interface UnitPricingCalculationLine {
  sku: string
  unit: string
  quantity: number
  usdPerUnit: number
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
  sourceRevision?: string
  officialReviewUrl?: string
  dimensions?: PricingDimensions
  catalogVersion: string
  priceSnapshotHash: string
  longContext: boolean
  calculation: PricingCalculationLine[]
  unitCalculation?: UnitPricingCalculationLine[]
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
  unitCoverage: {
    coveredItems: number
    totalItems: number
    coveragePercent: number
  }
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
  if (Array.isArray(value)) return snapshotForCatalog(value)
  const snapshot = value as PriceSnapshot
  if (snapshot.status !== 'approved') throw new Error(`Price snapshot ${snapshot.revision} is not approved`)
  return snapshot
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
    unitCoverage: {
      coveredItems: 0,
      totalItems: event.billingItems?.length || 0,
      coveragePercent: percent(0, event.billingItems?.length || 0, false)
    },
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

function normalizedDimensions(event: UsageEvent): Required<Omit<PricingDimensions, 'region'>> & { region?: string } {
  const serviceTier = event.serviceTier?.toLowerCase()
  return {
    serviceTier: !serviceTier || serviceTier === 'default' ? 'standard' : serviceTier,
    speed: event.speed?.toLowerCase() || 'standard',
    batchMode: event.isBatch ? 'batch' : 'realtime',
    ...(event.inferenceRegion ? { region: event.inferenceRegion.toLowerCase() } : {})
  }
}

function dimensionsMatch(rule: PricingDimensions | undefined, event: UsageEvent): boolean {
  const actual = normalizedDimensions(event)
  return (rule?.serviceTier?.toLowerCase() || 'standard') === actual.serviceTier &&
    (rule?.speed?.toLowerCase() || 'standard') === actual.speed &&
    (rule?.batchMode || 'realtime') === actual.batchMode &&
    (rule?.region?.toLowerCase() || undefined) === actual.region
}

function modifierReasons(event: UsageEvent): string[] {
  const actual = normalizedDimensions(event)
  return [
    ...(actual.batchMode === 'batch' ? ['unpriced-modifier:batch-mode:batch'] : []),
    ...(actual.serviceTier !== 'standard' ? [`unpriced-modifier:service-tier:${actual.serviceTier}`] : []),
    ...(actual.speed !== 'standard' ? [`unpriced-modifier:speed:${actual.speed}`] : []),
    ...(actual.region ? [`unpriced-modifier:region:${actual.region}`] : [])
  ]
}

function appliesAt(effectiveFrom: string, effectiveTo: string | undefined, at: number): boolean {
  const from = new Date(effectiveFrom).getTime()
  const to = effectiveTo ? new Date(effectiveTo).getTime() : Number.POSITIVE_INFINITY
  return at >= from && at < to
}

function matchRule(
  event: UsageEvent,
  snapshot: PriceSnapshot
): { rule?: PricingRule; match?: 'exact' | 'alias'; unpricedModifiers: string[] } {
  if (!event.billingProvider || !event.modelCanonical) return { unpricedModifiers: [] }
  const at = eventDate(event.timestamp)
  if (at === undefined) return { unpricedModifiers: [] }
  const baseRules = snapshot.rules
    .filter((rule) => rule.provider === event.billingProvider && rule.modelCanonical === event.modelCanonical)
    .filter((rule) => appliesAt(rule.effectiveFrom, rule.effectiveTo, at))
  const rules = baseRules
    .filter((rule) => dimensionsMatch(rule.dimensions, event))
    .sort((left, right) => new Date(right.effectiveFrom).getTime() - new Date(left.effectiveFrom).getTime())
  const rule = rules[0]
  if (!rule) {
    const reasons = baseRules.length > 0 ? modifierReasons(event) : []
    return { unpricedModifiers: reasons }
  }
  return { rule, match: canonicalizeModel(event.modelRaw)?.match || 'exact', unpricedModifiers: [] }
}

function matchUnitRule(event: UsageEvent, rule: UnitPricingRule): boolean {
  const at = eventDate(event.timestamp)
  return at !== undefined && event.billingProvider === rule.provider &&
    appliesAt(rule.effectiveFrom, rule.effectiveTo, at) && dimensionsMatch(rule.dimensions, event)
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
  const billingItems = event.billingItems || []
  const ledgers = reportedLedgers(event)
  const baseReasons: string[] = []
  if (totalBillableTokens > 0) {
    if (!event.modelRaw || event.modelRaw === '<synthetic>') baseReasons.push('model-unknown')
    else if (!event.modelCanonical) baseReasons.push('model-not-in-catalog')
    else if (event.modelProvenance === 'session-fallback' || event.modelProvenance === 'unknown') {
      baseReasons.push('model-provenance-not-request-level')
    }
  }
  if (!event.billingProvider || event.providerProvenance === 'unknown') baseReasons.push('provider-unknown')
  else if (!event.timestamp || eventDate(event.timestamp) === undefined) baseReasons.push('event-time-unknown')
  if (baseReasons.length > 0) return emptyValuation(event, snapshot, baseReasons, ledgers)

  const state = { usd: 0, covered: 0, missing: [] as string[], calculation: [] as PricingCalculationLine[] }
  const pricingRules: PricingTrace[] = []
  let componentUsd: Valuation['componentUsd']
  let matchedKind: 'exact' | 'alias' | undefined

  if (totalBillableTokens > 0) {
    const matched = matchRule(event, snapshot)
    if (!matched.rule) {
      if (matched.unpricedModifiers.length > 0) {
        state.missing.push('unpriced-modifier', ...matched.unpricedModifiers)
      } else {
        state.missing.push('no-exact-provider-model-date-rule')
      }
    } else {
      const rule = matched.rule
      matchedKind = matched.match
      const isLongContext = Boolean(
        rule.contextThresholdTokens && inputTokens(event.components) > rule.contextThresholdTokens
      )
      const inputMultiplier = isLongContext && rule.thresholdMode === 'whole-request'
        ? rule.longContextMultiplier?.input || 1
        : 1
      const outputMultiplier = isLongContext && rule.thresholdMode === 'whole-request'
        ? rule.longContextMultiplier?.output || 1
        : 1
      componentUsd = {
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
      pricingRules.push({
        eventDedupKey: event.dedupKey,
        pricingRuleId: rule.id,
        provider: rule.provider,
        modelCanonical: rule.modelCanonical,
        eventTimestamp: event.timestamp!,
        effectiveFrom: rule.effectiveFrom,
        effectiveTo: rule.effectiveTo,
        source: rule.source,
        sourceUrl: rule.sourceUrl,
        sourceRevision: rule.sourceRevision,
        officialReviewUrl: rule.officialReviewUrl,
        dimensions: rule.dimensions,
        catalogVersion: snapshot.revision,
        priceSnapshotHash: snapshot.contentHash,
        longContext: isLongContext,
        calculation: state.calculation
      })
    }
  }

  let coveredItems = 0
  let unitUsd = 0
  for (const item of billingItems) {
    if (!Number.isFinite(item.quantity) || item.quantity < 0) {
      state.missing.push(`invalid-billing-item:${item.unit}:${item.sku}`)
      continue
    }
    const baseRules = (snapshot.unitRules || []).filter((rule) =>
      rule.provider === event.billingProvider && rule.unit === item.unit && rule.sku === item.sku &&
      appliesAt(rule.effectiveFrom, rule.effectiveTo, eventDate(event.timestamp)!)
    )
    const rule = baseRules.find((candidate) => matchUnitRule(event, candidate))
    if (!rule) {
      const reasons = baseRules.length > 0 ? modifierReasons(event) : []
      if (reasons.length > 0) state.missing.push('unpriced-modifier', ...reasons)
      else state.missing.push(`non-token-price-missing:${item.unit}:${item.sku}`)
      continue
    }
    coveredItems += 1
    const usd = item.quantity * rule.usdPerUnit
    unitUsd += usd
    pricingRules.push({
      eventDedupKey: event.dedupKey,
      pricingRuleId: rule.id,
      provider: rule.provider,
      modelCanonical: event.modelCanonical || '<non-token>',
      eventTimestamp: event.timestamp!,
      effectiveFrom: rule.effectiveFrom,
      effectiveTo: rule.effectiveTo,
      source: rule.source,
      sourceUrl: rule.sourceUrl,
      sourceRevision: rule.sourceRevision,
      dimensions: rule.dimensions,
      catalogVersion: snapshot.revision,
      priceSnapshotHash: snapshot.contentHash,
      longContext: false,
      calculation: [],
      unitCalculation: [{ sku: item.sku, unit: item.unit, quantity: item.quantity, usdPerUnit: rule.usdPerUnit, usd }]
    })
  }

  if (state.covered > 0 || coveredItems > 0 || (totalBillableTokens === 0 && billingItems.length === 0)) {
    ledgers.swobEstimateUsd = state.usd + unitUsd
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
    pricingMatch: matchedKind || (coveredItems > 0 ? 'exact' : 'none'),
    ledgerBreakdown: ledgers,
    coveredTokens: state.covered,
    totalBillableTokens,
    coveragePercent: percent(state.covered, totalBillableTokens, true),
    financialCoveredTokens,
    financialCoveragePercent: percent(financialCoveredTokens, totalBillableTokens, ledgers.providerBilledUsd !== undefined),
    unitCoverage: {
      coveredItems,
      totalItems: billingItems.length,
      coveragePercent: percent(coveredItems, billingItems.length, coveredItems > 0)
    },
    missingReasons: [...new Set(state.missing)],
    pricingRules,
    priceRevision: snapshot.revision,
    priceSnapshotHash: snapshot.contentHash,
    priceRevisions: [snapshot.revision],
    revisionNotices: [],
    modeBreakdown: modeBreakdown(ledgers, swobDisplayMode),
    ...(componentUsd ? { componentUsd } : {})
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

/** Explicit audit-only path. Pending candidates are never added to PRICE_SNAPSHOT_REGISTRY. */
function valueUsageEventAtCandidate(
  event: UsageEvent,
  candidate: PriceCandidateSnapshot
): Valuation {
  const raw = event.modelRaw?.trim().toLowerCase()
  const unprefixed = raw?.split('/').at(-1)
  const hasDirectCandidate = candidate.rules.some((rule) =>
    rule.modelCanonical === event.modelCanonical && (!event.billingProvider || rule.provider === event.billingProvider)
  )
  const matcherApplies = (rule: PricingRule): boolean => Boolean(unprefixed && rule.modelMatchers?.some((matcher) => {
    const value = matcher.value.toLowerCase()
    if (matcher.kind === 'equals') return unprefixed === value
    if (matcher.kind === 'starts-with') return unprefixed.startsWith(value)
    return unprefixed.includes(value)
  }))
  const matchingModels = !hasDirectCandidate && unprefixed
    ? candidate.rules.filter((rule) =>
        (!event.billingProvider || rule.provider === event.billingProvider) &&
        (rule.modelCanonical.toLowerCase() === unprefixed || matcherApplies(rule)))
    : []
  const inferred = matchingModels.length > 0
    ? {
        modelCanonical: matchingModels[0].modelCanonical,
        ...(event.billingProvider
          ? {}
          : { billingProvider: matchingModels[0].provider, providerProvenance: 'inferred' as const })
      }
    : {}
  const previewSnapshot: PriceSnapshot = {
    revision: candidate.revision,
    status: 'approved',
    generatedAt: candidate.generatedAt,
    reviewedAt: candidate.generatedAt,
    contentHash: candidate.contentHash,
    sourcePipeline: candidate.sourcePipeline,
    rules: candidate.rules,
    unitRules: candidate.unitRules
  }
  return { ...valueUsageEventAtSnapshot({ ...event, ...inferred }, previewSnapshot), whatIf: true }
}

export function previewUsageEventCandidateRepricing(
  event: UsageEvent,
  candidate: PriceCandidateSnapshot
): Valuation {
  assertPriceCandidateIntegrity(candidate)
  return valueUsageEventAtCandidate(event, candidate)
}

export function previewUsageEventsCandidateRepricing(
  events: UsageEvent[],
  candidate: PriceCandidateSnapshot
): Valuation {
  assertPriceCandidateIntegrity(candidate)
  const unique = new Map<string, UsageEvent>()
  for (const event of events) unique.set(event.billingFactKey || event.dedupKey, event)
  return {
    ...aggregateValuations([...unique.values()].map((event) =>
      valueUsageEventAtCandidate(event, candidate))),
    whatIf: true
  }
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
  const coveredItems = valuations.reduce((sum, valuation) => sum + valuation.unitCoverage.coveredItems, 0)
  const totalItems = valuations.reduce((sum, valuation) => sum + valuation.unitCoverage.totalItems, 0)
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
    unitCoverage: {
      coveredItems,
      totalItems,
      coveragePercent: percent(coveredItems, totalItems, coveredItems > 0)
    },
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
