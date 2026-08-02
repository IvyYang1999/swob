import { createHash } from 'node:crypto'
import snapshotDocument from './pricing-snapshots.json'

export type PricingSource = 'official' | 'genai-prices' | 'litellm' | 'models.dev' | 'openrouter' | 'user-override'
export type PriceSourceRole = 'history-formula' | 'coverage-diff' | 'model-identity' | 'official-review-override'

export interface PricingDimensions {
  serviceTier?: string
  speed?: string
  batchMode?: 'realtime' | 'batch'
  region?: string
}

export interface CandidateModelMatcher {
  kind: 'equals' | 'starts-with' | 'contains'
  value: string
}

export interface PricingRule {
  id: string
  provider: string
  modelCanonical: string
  effectiveFrom: string
  effectiveTo?: string
  usdPerMillion: {
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
    cacheWrite5m?: number
    cacheWrite1h?: number
  }
  contextThresholdTokens?: number
  thresholdMode?: 'whole-request' | 'marginal'
  longContextMultiplier?: { input: number; output: number }
  dimensions?: PricingDimensions
  pricingFormula?: string
  /** Candidate-only identity evidence; runtime aliases remain separately reviewed. */
  modelMatchers?: readonly CandidateModelMatcher[]
  source: PricingSource
  sourceUrl: string
  sourceRevision?: string
  officialReviewUrl?: string
  reviewStatus?: 'approved' | 'pending-review'
  catalogVersion: string
}

export type BillingUnit =
  | 'search'
  | 'image'
  | 'audio-minute'
  | 'cache-storage-token-hour'
  | 'credit'
  | 'page'
  | 'request'
  | 'character'
  | 'gigabyte-day'

export interface UnitPricingRule {
  id: string
  provider: string
  sku: string
  unit: BillingUnit
  usdPerUnit: number
  effectiveFrom: string
  effectiveTo?: string
  dimensions?: PricingDimensions
  source: PricingSource
  sourceUrl: string
  sourceRevision: string
  reviewStatus: 'approved' | 'pending-review'
}

export interface PriceSnapshotSource {
  name: string
  role: PriceSourceRole
  revision: string
  evidenceUrl: string
}

export interface PriceSnapshot {
  revision: string
  status: 'approved'
  generatedAt: string
  reviewedAt: string
  replaces?: string
  revisionReason?: 'official-price-catalog-update'
  revisionNotice?: { 'zh-CN': string; en: string }
  contentHash: string
  sourcePipeline: readonly PriceSnapshotSource[]
  rules: readonly PricingRule[]
  unitRules?: readonly UnitPricingRule[]
}

export interface PriceCandidateSnapshot {
  revision: string
  status: 'pending-review'
  generatedAt: string
  contentHash: string
  sourcePipeline: readonly PriceSnapshotSource[]
  rules: readonly PricingRule[]
  unitRules: readonly UnitPricingRule[]
  review: {
    requiredApprover: string
    activationAllowed: false
  }
}

export interface CanonicalModelMatch {
  modelCanonical: string
  originalProvider: string
  match: 'exact' | 'alias'
}

type RawRule = Omit<PricingRule, 'catalogVersion'>
type RawSnapshot = Omit<PriceSnapshot, 'rules' | 'sourcePipeline'> & {
  sourcePipeline: PriceSnapshotSource[]
  unitRules?: UnitPricingRule[]
  patches: Array<
    | { op: 'add'; rule: RawRule }
    | { op: 'replace'; ruleId: string; rule: RawRule }
  >
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, stableJson(item)]))
}

function snapshotHashInput(snapshot: PriceSnapshot): unknown {
  return {
    schemaVersion: snapshotDocument.schemaVersion,
    revision: snapshot.revision,
    status: snapshot.status,
    generatedAt: snapshot.generatedAt,
    reviewedAt: snapshot.reviewedAt,
    ...(snapshot.replaces ? { replaces: snapshot.replaces } : {}),
    ...(snapshot.revisionReason ? { revisionReason: snapshot.revisionReason } : {}),
    ...(snapshot.revisionNotice ? { revisionNotice: snapshot.revisionNotice } : {}),
    sourcePipeline: snapshot.sourcePipeline,
    rules: snapshot.rules.map(({ catalogVersion: _catalogVersion, ...rule }) => rule),
    ...(snapshot.unitRules ? { unitRules: snapshot.unitRules } : {})
  }
}

export function calculatePriceSnapshotHash(snapshot: PriceSnapshot): string {
  return createHash('sha256').update(JSON.stringify(stableJson(snapshotHashInput(snapshot)))).digest('hex')
}

function candidateHashInput(candidate: PriceCandidateSnapshot): unknown {
  return {
    schemaVersion: 2,
    revision: candidate.revision,
    status: candidate.status,
    generatedAt: candidate.generatedAt,
    sourcePipeline: candidate.sourcePipeline,
    rules: candidate.rules.map(({ catalogVersion: _catalogVersion, ...rule }) => rule),
    unitRules: candidate.unitRules,
    review: candidate.review
  }
}

export function calculatePriceCandidateHash(candidate: PriceCandidateSnapshot): string {
  return createHash('sha256').update(JSON.stringify(stableJson(candidateHashInput(candidate)))).digest('hex')
}

export function assertPriceCandidateIntegrity(candidate: PriceCandidateSnapshot): void {
  if (candidate.status !== 'pending-review' || candidate.review.activationAllowed !== false) {
    throw new Error(`Price candidate ${candidate.revision} is not safely isolated`)
  }
  const actual = calculatePriceCandidateHash(candidate)
  if (actual !== candidate.contentHash) {
    throw new Error(`Price candidate ${candidate.revision} hash mismatch: expected ${candidate.contentHash}, got ${actual}`)
  }
  const expectedRoles: PriceSourceRole[] = [
    'history-formula', 'coverage-diff', 'model-identity', 'official-review-override'
  ]
  if (candidate.sourcePipeline.map((source) => source.role).join('\0') !== expectedRoles.join('\0') ||
    candidate.sourcePipeline.some((source) => !source.revision || !source.evidenceUrl)) {
    throw new Error(`Price candidate ${candidate.revision} has an incomplete source pipeline`)
  }
  for (const rule of candidate.unitRules) {
    if (rule.reviewStatus !== 'pending-review' || !rule.sourceRevision || !rule.sourceUrl) {
      throw new Error(`Price candidate unit rule ${rule.id} is not pending review`)
    }
  }
  for (const rule of candidate.rules) {
    if (rule.reviewStatus !== 'pending-review' || !rule.sourceRevision || !rule.sourceUrl || !rule.officialReviewUrl) {
      throw new Error(`Price candidate token rule ${rule.id} lacks pending review evidence`)
    }
  }
}

function dimensionsKey(dimensions?: PricingDimensions): string {
  return JSON.stringify(stableJson({
    serviceTier: dimensions?.serviceTier?.toLowerCase() || 'standard',
    speed: dimensions?.speed?.toLowerCase() || 'standard',
    batchMode: dimensions?.batchMode || 'realtime',
    region: dimensions?.region?.toLowerCase() || null
  }))
}

export function assertPriceSnapshotIntegrity(snapshot: PriceSnapshot): void {
  if (snapshot.status !== 'approved') throw new Error(`Price snapshot ${snapshot.revision} is not approved`)
  const expectedRoles: PriceSourceRole[] = [
    'history-formula', 'coverage-diff', 'model-identity', 'official-review-override'
  ]
  if (snapshot.sourcePipeline.map((source) => source.role).join('\0') !== expectedRoles.join('\0')) {
    throw new Error(`Price snapshot ${snapshot.revision} has an incomplete source pipeline`)
  }
  const actual = calculatePriceSnapshotHash(snapshot)
  if (actual !== snapshot.contentHash) {
      throw new Error(`Price snapshot ${snapshot.revision} hash mismatch: expected ${snapshot.contentHash}, got ${actual}`)
  }
  const byModel = new Map<string, PricingRule[]>()
  for (const rule of snapshot.rules) {
    const key = `${rule.provider}\0${rule.modelCanonical}\0${dimensionsKey(rule.dimensions)}`
    const values = byModel.get(key) || []
    values.push(rule)
    byModel.set(key, values)
  }
  for (const [key, rules] of byModel) {
    rules.sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
    for (let index = 1; index < rules.length; index++) {
      const previousTo = rules[index - 1].effectiveTo
        ? Date.parse(rules[index - 1].effectiveTo!)
        : Number.POSITIVE_INFINITY
      if (previousTo > Date.parse(rules[index].effectiveFrom)) {
        throw new Error(`Price snapshot ${snapshot.revision} has overlapping rules for ${key}`)
      }
    }
  }
  const unitHistories = new Map<string, UnitPricingRule[]>()
  for (const rule of snapshot.unitRules || []) {
    if (rule.reviewStatus !== 'approved') throw new Error(`Price snapshot ${snapshot.revision} has unapproved unit ${rule.id}`)
    const key = `${rule.provider}\0${rule.sku}\0${rule.unit}\0${dimensionsKey(rule.dimensions)}`
    const values = unitHistories.get(key) || []
    values.push(rule)
    unitHistories.set(key, values)
  }
  for (const [key, rules] of unitHistories) {
    rules.sort((left, right) => Date.parse(left.effectiveFrom) - Date.parse(right.effectiveFrom))
    for (let index = 1; index < rules.length; index++) {
      const previousTo = rules[index - 1].effectiveTo
        ? Date.parse(rules[index - 1].effectiveTo!)
        : Number.POSITIVE_INFINITY
      if (previousTo > Date.parse(rules[index].effectiveFrom)) {
        throw new Error(`Price snapshot ${snapshot.revision} has overlapping unit rules for ${key}`)
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function resolveSnapshots(): Map<string, PriceSnapshot> {
  const registry = new Map<string, PriceSnapshot>()
  let rules = new Map((snapshotDocument.baseRules as RawRule[]).map((rule) => [rule.id, rule]))
  let unitRules: readonly UnitPricingRule[] | undefined
  for (const raw of snapshotDocument.snapshots as RawSnapshot[]) {
    if (raw.replaces) {
      const previous = registry.get(raw.replaces)
      if (!previous) throw new Error(`Price snapshot ${raw.revision} replaces unknown ${raw.replaces}`)
      rules = new Map(previous.rules.map(({ catalogVersion: _catalogVersion, ...rule }) => [rule.id, rule]))
      unitRules = previous.unitRules
    }
    for (const patch of raw.patches) {
      if (patch.op === 'replace' && !rules.has(patch.ruleId)) {
        throw new Error(`Price snapshot ${raw.revision} replaces missing rule ${patch.ruleId}`)
      }
      if (patch.op === 'replace') rules.delete(patch.ruleId)
      if (rules.has(patch.rule.id)) throw new Error(`Price snapshot ${raw.revision} duplicates ${patch.rule.id}`)
      rules.set(patch.rule.id, patch.rule)
    }
    const snapshot: PriceSnapshot = {
      revision: raw.revision,
      status: raw.status,
      generatedAt: raw.generatedAt,
      reviewedAt: raw.reviewedAt,
      ...(raw.replaces ? { replaces: raw.replaces } : {}),
      ...(raw.revisionReason ? { revisionReason: raw.revisionReason } : {}),
      ...(raw.revisionNotice ? { revisionNotice: raw.revisionNotice } : {}),
      contentHash: raw.contentHash,
      sourcePipeline: raw.sourcePipeline,
      rules: [...rules.values()].map((rule) => ({ ...rule, catalogVersion: raw.revision })),
      ...(raw.unitRules ? { unitRules: raw.unitRules } : unitRules ? { unitRules } : {})
    }
    unitRules = snapshot.unitRules
    assertPriceSnapshotIntegrity(snapshot)
    registry.set(snapshot.revision, deepFreeze(snapshot))
  }
  return registry
}

export const PRICE_SNAPSHOT_REGISTRY: ReadonlyMap<string, PriceSnapshot> = resolveSnapshots()
export const ACTIVE_PRICE_SNAPSHOT = PRICE_SNAPSHOT_REGISTRY.get('official-snapshot-2026-08-01.v2')!
export const PRICING_CATALOG_VERSION = ACTIVE_PRICE_SNAPSHOT.revision
export const EMBEDDED_PRICING_CATALOG: readonly PricingRule[] = ACTIVE_PRICE_SNAPSHOT.rules

const MODEL_ALIASES: Readonly<Record<string, { canonical: string; provider: string }>> = {
  'claude-sonnet-4': { canonical: 'claude-sonnet-4', provider: 'anthropic' },
  'claude-sonnet-4-20250514': { canonical: 'claude-sonnet-4', provider: 'anthropic' },
  'claude-opus-4': { canonical: 'claude-opus-4', provider: 'anthropic' },
  'claude-opus-4-20250514': { canonical: 'claude-opus-4', provider: 'anthropic' },
  'claude-opus-4-1': { canonical: 'claude-opus-4-1', provider: 'anthropic' },
  'claude-opus-4-1-20250805': { canonical: 'claude-opus-4-1', provider: 'anthropic' },
  'claude-sonnet-4-5': { canonical: 'claude-sonnet-4-5', provider: 'anthropic' },
  'claude-sonnet-4-5-20250929': { canonical: 'claude-sonnet-4-5', provider: 'anthropic' },
  'claude-haiku-4-5': { canonical: 'claude-haiku-4-5', provider: 'anthropic' },
  'claude-haiku-4-5-20251001': { canonical: 'claude-haiku-4-5', provider: 'anthropic' },
  'claude-opus-4-5': { canonical: 'claude-opus-4-5', provider: 'anthropic' },
  'claude-opus-4-6': { canonical: 'claude-opus-4-6', provider: 'anthropic' },
  'claude-sonnet-4-6': { canonical: 'claude-sonnet-4-6', provider: 'anthropic' },
  'claude-fable-5': { canonical: 'claude-fable-5', provider: 'anthropic' },
  'claude-opus-4-8': { canonical: 'claude-opus-4-8', provider: 'anthropic' },
  'claude-sonnet-5': { canonical: 'claude-sonnet-5', provider: 'anthropic' },
  'gpt-5.6': { canonical: 'gpt-5.6-sol', provider: 'openai' },
  'gpt-5.6-sol': { canonical: 'gpt-5.6-sol', provider: 'openai' },
  'gpt-5.6-terra': { canonical: 'gpt-5.6-terra', provider: 'openai' },
  'gpt-5.6-luna': { canonical: 'gpt-5.6-luna', provider: 'openai' },
  'gpt-5.5': { canonical: 'gpt-5.5', provider: 'openai' },
  'gpt-5.4': { canonical: 'gpt-5.4', provider: 'openai' },
  'gpt-5.4-2026-03-05': { canonical: 'gpt-5.4', provider: 'openai' },
  'gpt-5': { canonical: 'gpt-5', provider: 'openai' },
  'gpt-5-2025-08-07': { canonical: 'gpt-5', provider: 'openai' },
  'gpt-4o-mini': { canonical: 'gpt-4o-mini', provider: 'openai' }
}

const ROUTE_PROVIDERS = new Set(['anthropic', 'openai', 'openrouter', 'bedrock', 'vertex', 'google'])

export function providerFromModelRoute(modelRaw?: string): string | undefined {
  if (!modelRaw) return undefined
  const first = modelRaw.trim().toLowerCase().split('/')[0]
  return ROUTE_PROVIDERS.has(first) ? first : undefined
}

function unrouteModel(modelRaw: string): string {
  const segments = modelRaw.trim().toLowerCase().split('/')
  if (segments.length > 1 && ROUTE_PROVIDERS.has(segments[0])) return segments[segments.length - 1]
  return segments[0]
}

export function canonicalizeModel(modelRaw?: string): CanonicalModelMatch | undefined {
  if (!modelRaw || modelRaw.trim() === '<synthetic>') return undefined
  const normalized = unrouteModel(modelRaw)
  const alias = MODEL_ALIASES[normalized]
  if (!alias) return undefined
  return {
    modelCanonical: alias.canonical,
    originalProvider: alias.provider,
    match: normalized === alias.canonical ? 'exact' : 'alias'
  }
}

export function inferOriginalProvider(modelRaw?: string): string | undefined {
  if (!modelRaw || modelRaw.trim() === '<synthetic>') return undefined
  const normalized = unrouteModel(modelRaw)
  if (normalized.startsWith('claude-')) return 'anthropic'
  if (/^(gpt-|o\d(?:-|$))/.test(normalized)) return 'openai'
  if (normalized.startsWith('gemini-')) return 'google'
  return undefined
}
