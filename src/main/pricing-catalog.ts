export type PricingSource = 'official' | 'litellm' | 'models.dev' | 'openrouter' | 'user-override'

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
  source: PricingSource
  sourceUrl: string
  catalogVersion: string
}

export interface CanonicalModelMatch {
  modelCanonical: string
  originalProvider: string
  match: 'exact' | 'alias'
}

export const PRICING_CATALOG_VERSION = 'official-snapshot-2026-07-22.v1'

const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const OPENAI_PRICING_URL = 'https://developers.openai.com/api/docs/pricing'

function anthropicRule(
  modelCanonical: string,
  effectiveFrom: string,
  input: number,
  output: number
): PricingRule {
  return {
    id: `anthropic:${modelCanonical}:${effectiveFrom}`,
    provider: 'anthropic',
    modelCanonical,
    effectiveFrom,
    usdPerMillion: {
      input,
      output,
      cacheRead: input * 0.1,
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 2
    },
    source: 'official',
    sourceUrl: ANTHROPIC_PRICING_URL,
    catalogVersion: PRICING_CATALOG_VERSION
  }
}

/**
 * Embedded, reviewable snapshot. Runtime valuation never fetches pricing data.
 * The first catalog intentionally covers models observed in Swob's live rollup
 * and golden fixtures, plus exact aliases; an absent rule is unpriced.
 * When an official page does not publish a release-effective timestamp, the
 * snapshot date is the conservative lower bound; we never back-price history.
 */
export const EMBEDDED_PRICING_CATALOG: readonly PricingRule[] = [
  anthropicRule('claude-sonnet-4', '2025-05-22T00:00:00Z', 3, 15),
  anthropicRule('claude-opus-4', '2025-05-22T00:00:00Z', 15, 75),
  anthropicRule('claude-opus-4-1', '2025-08-05T00:00:00Z', 15, 75),
  anthropicRule('claude-sonnet-4-5', '2025-09-29T00:00:00Z', 3, 15),
  anthropicRule('claude-haiku-4-5', '2025-10-15T00:00:00Z', 1, 5),
  anthropicRule('claude-opus-4-5', '2025-11-24T00:00:00Z', 5, 25),
  anthropicRule('claude-opus-4-6', '2026-02-05T00:00:00Z', 5, 25),
  anthropicRule('claude-sonnet-4-6', '2026-02-17T00:00:00Z', 3, 15),
  anthropicRule('claude-fable-5', '2026-07-22T00:00:00Z', 10, 50),
  anthropicRule('claude-opus-4-8', '2026-07-22T00:00:00Z', 5, 25),
  {
    ...anthropicRule('claude-sonnet-5', '2026-07-22T00:00:00Z', 2, 10),
    effectiveTo: '2026-09-01T00:00:00Z'
  },
  anthropicRule('claude-sonnet-5', '2026-09-01T00:00:00Z', 3, 15),
  {
    id: 'openai:gpt-5.5:2026-07-22',
    provider: 'openai',
    modelCanonical: 'gpt-5.5',
    effectiveFrom: '2026-07-22T00:00:00Z',
    usdPerMillion: { input: 5, output: 30, cacheRead: 0.5 },
    contextThresholdTokens: 272_000,
    thresholdMode: 'whole-request',
    longContextMultiplier: { input: 2, output: 1.5 },
    source: 'official',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.5',
    catalogVersion: PRICING_CATALOG_VERSION
  },
  {
    id: 'openai:gpt-5.6-sol:2026-07-22',
    provider: 'openai',
    modelCanonical: 'gpt-5.6-sol',
    effectiveFrom: '2026-07-22T00:00:00Z',
    usdPerMillion: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    contextThresholdTokens: 272_000,
    thresholdMode: 'whole-request',
    longContextMultiplier: { input: 2, output: 1.5 },
    source: 'official',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-sol',
    catalogVersion: PRICING_CATALOG_VERSION
  },
  {
    id: 'openai:gpt-5.6-terra:2026-07-22',
    provider: 'openai',
    modelCanonical: 'gpt-5.6-terra',
    effectiveFrom: '2026-07-22T00:00:00Z',
    usdPerMillion: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 3.125 },
    contextThresholdTokens: 272_000,
    thresholdMode: 'whole-request',
    longContextMultiplier: { input: 2, output: 1.5 },
    source: 'official',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-terra',
    catalogVersion: PRICING_CATALOG_VERSION
  },
  {
    id: 'openai:gpt-5.6-luna:2026-07-22',
    provider: 'openai',
    modelCanonical: 'gpt-5.6-luna',
    effectiveFrom: '2026-07-22T00:00:00Z',
    usdPerMillion: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
    contextThresholdTokens: 272_000,
    thresholdMode: 'whole-request',
    longContextMultiplier: { input: 2, output: 1.5 },
    source: 'official',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    catalogVersion: PRICING_CATALOG_VERSION
  },
  {
    id: 'openai:gpt-5.4:2026-03-05',
    provider: 'openai',
    modelCanonical: 'gpt-5.4',
    effectiveFrom: '2026-03-05T00:00:00Z',
    usdPerMillion: { input: 2.5, output: 15, cacheRead: 0.25 },
    contextThresholdTokens: 272_000,
    thresholdMode: 'whole-request',
    longContextMultiplier: { input: 2, output: 1.5 },
    source: 'official',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5.4',
    catalogVersion: PRICING_CATALOG_VERSION
  },
  {
    id: 'openai:gpt-5:2025-08-07',
    provider: 'openai',
    modelCanonical: 'gpt-5',
    effectiveFrom: '2025-08-07T00:00:00Z',
    usdPerMillion: { input: 1.25, output: 10, cacheRead: 0.125 },
    source: 'official',
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5',
    catalogVersion: PRICING_CATALOG_VERSION
  },
  {
    id: 'openai:gpt-4o-mini:2024-07-18',
    provider: 'openai',
    modelCanonical: 'gpt-4o-mini',
    effectiveFrom: '2024-07-18T00:00:00Z',
    usdPerMillion: { input: 0.15, output: 0.6, cacheRead: 0.075 },
    source: 'official',
    sourceUrl: OPENAI_PRICING_URL,
    catalogVersion: PRICING_CATALOG_VERSION
  }
]

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
