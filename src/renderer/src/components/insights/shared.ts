export function formatTokenCount(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function formatDuration(ms: number): string {
  if (ms === 0) return '0m'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export const SOURCE_COLORS: Record<string, string> = {
  'claude-code': '#f59e0b',
  codex: '#3b82f6',
  cursor: '#a1a1aa',
  opencode: '#10b981',
  zcode: '#10b981',
  'cc-mirror': '#f472b6',
  antigravity: '#a78bfa',
  grok: '#6b7280',
  pi: '#14b8a6',
  kimi: '#fb923c',
  hermes: '#8b5cf6',
  qoder: '#06b6d4',
  trae: '#c084fc',
  gemini: '#4285f4',
}

export const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  'cc-mirror': 'CC Mirror',
  antigravity: 'Antigravity',
  grok: 'Grok / Factory',
  pi: 'Pi',
  kimi: 'Kimi Code',
  hermes: 'Hermes',
  qoder: 'Qoder',
  trae: 'Trae',
  gemini: 'Gemini CLI',
}

export const PROJECT_COLORS = [
  '#8b5cf6', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
]

export interface ByModel {
  model: string
  totalTokens: number
  sessionCount: number
  tokenBreakdown: TokenBreakdown
  costUsd: number | null
  coveragePercent: number | null
}

/**
 * Token type breakdown available from UsageAggregate.
 * Makes the five-token split visible to all chart components.
 */
export interface TokenBreakdown {
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
}

/**
 * Returns false for values that represent "no real data connected":
 * 0, null, undefined, empty arrays, arrays where every element is 0.
 */
export function isDataConnected(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'number') return value !== 0
  if (Array.isArray(value)) {
    if (value.length === 0) return false
    return value.some((item) => typeof item === 'number' ? item !== 0 : item != null)
  }
  if (typeof value === 'object') {
    const values = Object.values(value as Record<string, unknown>)
    if (values.length === 0) return false
    return values.some((v) => isDataConnected(v))
  }
  return true
}

/** Semantic colors for token type breakdown across all charts. */
export const TOKEN_TYPE_COLORS = {
  nonCachedInput: '#3b82f6',  // blue-500
  cacheRead: '#22c55e',       // green-500
  cacheWrite: '#14b8a6',      // teal-500
  output: '#f59e0b',          // amber-500
  reasoning: '#a78bfa',       // violet-400
} as const

export type TokenTypeKey = keyof typeof TOKEN_TYPE_COLORS

export interface InsightsData {
  totalTokens: number
  conversationOnlyTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  totalTurns: number
  totalTime: number
  activeDays: number
  bySource: BySource[]
  byModel: ByModel[]
  byProject: ByProject[]
  byFolder: ByFolder[]
  byDate: ByDate[]
  heatmap: HeatmapCell[]
  // Full five-token breakdown from UsageAggregate
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  /** Global token type breakdown (all five types) */
  tokenBreakdown: TokenBreakdown
  /** Cost and coverage from global aggregate */
  costUsd: number | null
  pricingCoverage: { covered: number; total: number; percent: number | null }
  usageCoverage: { covered: number; total: number; percent: number | null }
  modelCoverage: { covered: number; total: number; percent: number | null }
  /** Total calls across all events */
  totalCalls: number
  /** Total event count */
  totalEvents: number
  valuation: Valuation
  hourlyDistribution: number[]     // 24 items, index = hour
  /** Events whose timestamp is unknown — hourly chart should show unavailable when all slots are 0 and this > 0. */
  hourlyUnknownTimeEvents: number
  turnCountDistribution: number[]  // [1-5, 6-20, 21-50, 51-100, 101-500, 500+]
  topTools: Array<{ name: string; count: number }>
  codeChanges: { filesRead: number; filesWritten: number; filesEdited: number }
  bySession: Array<{
    sessionId: string
    projectPath: string
    source: string
    totalTokens: number | null
    conversationOnlyTokens: number | null
    provenance: string
    valuation: Valuation
  }>
  reconciliation: {
    global: number
    projects: number
    sessions: number
    difference: number
    ok: boolean
    valuation: {
      globalUsd: number | null
      sessionsUsd: number | null
      uniqueEventsUsd: number | null
      difference: number
      coverageDifference: number
      ok: boolean
    }
  }
}

export interface Valuation {
  usd?: number
  mode: 'provider-billed' | 'harness-list-estimate' | 'swob-estimate' | 'api-equivalent' | 'subscription-allocated' | 'mixed' | 'unpriced'
  selectedLedger?: 'provider-billed' | 'harness-list-estimate' | 'swob-estimate' | 'api-equivalent' | 'subscription-allocated'
  pricingMatch: 'reported' | 'exact' | 'alias' | 'mixed' | 'none'
  ledgerBreakdown: {
    providerBilledUsd?: number
    harnessListEstimateUsd?: number
    swobEstimateUsd?: number
    subscriptionAllocatedUsd?: number
  }
  coveredTokens: number
  totalBillableTokens: number
  coveragePercent: number
  financialCoveredTokens: number
  financialCoveragePercent: number
  missingReasons: string[]
  pricingRules: Array<{
    eventDedupKey: string
    pricingRuleId: string
    provider: string
    modelCanonical: string
    eventTimestamp: string
    effectiveFrom: string
    effectiveTo?: string
    source: string
    sourceUrl: string
    catalogVersion: string
    priceSnapshotHash: string
    longContext: boolean
    calculation: Array<{
      component: string
      tokens: number
      usdPerMillion: number
      multiplier: number
      usd: number
    }>
  }>
  priceRevision: string
  priceSnapshotHash: string
  priceRevisions: string[]
  revisionNotices: Array<{
    revision: string
    notice: { 'zh-CN': string; en: string }
  }>
  modeBreakdown: Partial<Record<
    'provider-billed' | 'harness-list-estimate' | 'swob-estimate' | 'api-equivalent' | 'subscription-allocated',
    number
  >>
}

export interface BySource {
  source: string
  label: string
  valuationCapability: import('../../../../shared/provider-capabilities').ValuationCapability
  valuation: Valuation
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  tokenDataStatus: 'available' | 'partial' | 'unavailable' | 'no-data'
  tokenBreakdown: TokenBreakdown
  costUsd: number | null
  coveragePercent: number | null
}

export interface ByProject {
  project: string
  fullPath: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  sources: string[]
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
}

export interface ByFolder {
  folderId: string
  folderName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
}

export interface ByDate {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  bySource: Record<string, number>
  byModel: Record<string, number>
  byProject: Record<string, number>
  totalTime: number
  byProjectTime: Record<string, number>
  costUsd: number | null
  tokenBreakdown: TokenBreakdown
  coveragePercent: number | null
}

export interface HeatmapCell {
  date: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}

// ---------------------------------------------------------------------------
// Adapter: map queryInsights results into InsightsData-compatible shape
// so existing cards keep working with minimal changes.
// ---------------------------------------------------------------------------
import type {
  InsightsQueryResult,
  UsageAggregate,
  PreviousPeriodComparison,
} from '../../../../shared/analysis-scope-types'
import { valuationCapabilityForSource } from '../../../../shared/provider-capabilities'

export type { InsightsQueryResult, UsageAggregate, PreviousPeriodComparison }

export interface QueryBundle {
  global: InsightsQueryResult | null
  time: InsightsQueryResult | null
  hour: InsightsQueryResult | null
  source: InsightsQueryResult | null
  model: InsightsQueryResult | null
  project: InsightsQueryResult | null
  session: InsightsQueryResult | null
  filterOptions?: {
    sources: string[]
    models: string[]
    projects: Array<{ kind: 'project' | 'folder'; key: string; label: string }>
  }
}

interface SessionLookupItem {
  id: string
  sessionId: string
  cwds?: string[]
  projectPath?: string
  source?: string
}

function valuationFromAggregate(aggregate: UsageAggregate | undefined, fallbackTokens = 0): Valuation {
  const ledgers = aggregate?.costLedgers || {}
  const modeBreakdown: Valuation['modeBreakdown'] = {
    ...(ledgers.providerBilledUsd !== undefined ? { 'provider-billed': ledgers.providerBilledUsd } : {}),
    ...(ledgers.harnessListEstimateUsd !== undefined
      ? { 'harness-list-estimate': ledgers.harnessListEstimateUsd }
      : {}),
    ...(ledgers.swobEstimateUsd !== undefined ? { 'swob-estimate': ledgers.swobEstimateUsd } : {}),
    ...(ledgers.subscriptionAllocatedUsd !== undefined
      ? { 'subscription-allocated': ledgers.subscriptionAllocatedUsd }
      : {})
  }
  const modes = Object.keys(modeBreakdown) as Array<keyof Valuation['modeBreakdown']>
  const mode: Valuation['mode'] = modes.length === 0 ? 'unpriced' : modes.length === 1 ? modes[0] : 'mixed'
  const totalBillableTokens = aggregate?.pricingCoverage.total ?? fallbackTokens
  const coveredTokens = aggregate?.pricingCoverage.covered ?? 0
  const financialCoveredTokens = aggregate?.financialCoverage.covered ?? 0
  return {
    ...(aggregate?.costUsd !== null && aggregate?.costUsd !== undefined ? { usd: aggregate.costUsd } : {}),
    mode,
    ...(modes.length === 1 ? { selectedLedger: modes[0] } : {}),
    pricingMatch: coveredTokens > 0
      ? (modes.length === 1 && modes[0] === 'provider-billed' && coveredTokens >= totalBillableTokens
        ? 'exact'
        : 'alias')
      : modes.length > 0 ? 'reported' : 'none',
    ledgerBreakdown: ledgers,
    coveredTokens,
    totalBillableTokens,
    coveragePercent: aggregate?.pricingCoverage.percent ?? 0,
    financialCoveredTokens,
    financialCoveragePercent: aggregate?.financialCoverage.percent ?? 0,
    missingReasons: totalBillableTokens > coveredTokens ? ['aggregate-unpriced-tokens'] : [],
    pricingRules: [],
    priceRevision: aggregate?.priceRevisions.length === 1 ? aggregate.priceRevisions[0] : 'mixed',
    priceSnapshotHash: '',
    priceRevisions: aggregate?.priceRevisions || [],
    revisionNotices: aggregate?.pricingRevisionNotices || [],
    modeBreakdown
  }
}

function aggregateTokenBreakdown(a: UsageAggregate | undefined): TokenBreakdown {
  return {
    nonCachedInputTokens: a?.nonCachedInputTokens ?? 0,
    cacheReadTokens: a?.cacheReadTokens ?? 0,
    cacheWriteTokens: a?.cacheWriteTokens ?? 0,
    outputTokens: a?.outputTokens ?? 0,
    reasoningTokens: a?.reasoningTokens ?? 0,
  }
}

/** Bucket session turns into the 6-bucket distribution: [1-5, 6-20, 21-50, 51-100, 101-500, 500+] */
function bucketTurns(sessionItems: UsageAggregate[]): number[] {
  const buckets = [0, 0, 0, 0, 0, 0]
  for (const session of sessionItems) {
    const turns = session.turns
    if (turns <= 0) continue
    if (turns <= 5) buckets[0]++
    else if (turns <= 20) buckets[1]++
    else if (turns <= 50) buckets[2]++
    else if (turns <= 100) buckets[3]++
    else if (turns <= 500) buckets[4]++
    else buckets[5]++
  }
  return buckets
}

/**
 * Build an InsightsData-compatible object from multiple queryInsights results.
 * Preserves ALL fields from UsageAggregate so downstream charts can access
 * the full five-token breakdown, cost, coverage, calls, and turns.
 */
export function adaptQueryBundle(bundle: QueryBundle, sessions: SessionLookupItem[] = []): InsightsData {
  const g = bundle.global?.total
  const totalTokens = g?.processedTokens ?? 0
  const billingTokens = g?.billingTokens ?? 0
  const convTokens = g?.conversationTokens ?? 0
  const tokenAvailableSessions = g?.usageCoverage.covered ?? g?.sessionCount ?? 0
  const scopedSessionCount = g?.usageCoverage.total ?? g?.sessionCount ?? 0
  const tokenUnavailableSessions = Math.max(0, scopedSessionCount - tokenAvailableSessions)

  // By source — preserve full token breakdown + cost + coverage
  const bySource: BySource[] = (bundle.source?.items ?? []).map((a) => {
    const available = a.usageCoverage.covered
    const unavailable = Math.max(0, a.usageCoverage.total - available)
    const tokenDataStatus = a.usageCoverage.total === 0
      ? 'no-data' as const
      : available === 0
        ? 'unavailable' as const
        : unavailable > 0
          ? 'partial' as const
          : 'available' as const
    return {
      source: a.key,
      label: SOURCE_LABELS[a.key] || a.label,
      valuationCapability: valuationCapabilityForSource(a.key),
      valuation: valuationFromAggregate(a, a.billingTokens),
      totalTokens: a.processedTokens,
      inputTokens: a.nonCachedInputTokens + a.cacheReadTokens + a.cacheWriteTokens,
      outputTokens: a.outputTokens,
      sessionCount: a.usageCoverage.total,
      turnCount: a.turns,
      tokenAvailableSessions: available,
      tokenUnavailableSessions: unavailable,
      tokenDataStatus,
      tokenBreakdown: aggregateTokenBreakdown(a),
      costUsd: a.costUsd,
      coveragePercent: a.pricingCoverage.percent,
    }
  })

  // By model — preserve full token breakdown + cost + coverage
  const byModel: ByModel[] = (bundle.model?.items ?? [])
    .sort((a, b) => b.processedTokens - a.processedTokens)
    .map((a) => ({
      model: a.key,
      totalTokens: a.processedTokens,
      sessionCount: a.usageCoverage.total,
      tokenBreakdown: aggregateTokenBreakdown(a),
      costUsd: a.costUsd,
      coveragePercent: a.pricingCoverage.percent,
    }))

  // By project
  const byProject: ByProject[] = (bundle.project?.items ?? [])
    .sort((a, b) => b.processedTokens - a.processedTokens)
    .map((a) => ({
      project: a.label,
      fullPath: a.key,
      totalTokens: a.processedTokens,
      inputTokens: a.nonCachedInputTokens + a.cacheReadTokens + a.cacheWriteTokens,
      outputTokens: a.outputTokens,
      sessionCount: a.sessionCount,
      turnCount: a.turns,
      sources: [],
      tokenAvailableSessions: a.usageCoverage.covered,
      tokenUnavailableSessions: Math.max(0, a.usageCoverage.total - a.usageCoverage.covered),
    }))

  // Build source-keyed and model-keyed lookup maps for per-date cross-dimension
  const sourceByDate = new Map<string, Map<string, number>>()
  const modelByDate = new Map<string, Map<string, number>>()
  // These will be populated if we had cross-dimension data; for now kept empty
  // as the backend does not yet support time×source or time×model pivots.

  // By date (from time dimension) — preserve full token breakdown + cost + coverage
  const byDate: ByDate[] = (bundle.time?.items ?? []).map((a) => ({
    date: a.key,
    totalTokens: a.processedTokens,
    inputTokens: a.nonCachedInputTokens + a.cacheReadTokens + a.cacheWriteTokens,
    outputTokens: a.outputTokens,
    sessionCount: a.sessionCount,
    turnCount: a.turns,
    bySource: sourceByDate.get(a.key) ? Object.fromEntries(sourceByDate.get(a.key)!) : {},
    byModel: modelByDate.get(a.key) ? Object.fromEntries(modelByDate.get(a.key)!) : {},
    byProject: {},
    totalTime: 0,
    byProjectTime: {},
    costUsd: a.costUsd,
    tokenBreakdown: aggregateTokenBreakdown(a),
    coveragePercent: a.pricingCoverage.percent,
  }))

  // Hourly distribution from hour dimension
  const hourlyDistribution = new Array(24).fill(0)
  for (const a of bundle.hour?.items ?? []) {
    const h = parseInt(a.key, 10)
    if (!isNaN(h) && h >= 0 && h < 24) {
      hourlyDistribution[h] = a.processedTokens
    }
  }
  const hourlyUnknownTimeEvents = bundle.hour?.quality?.unknownTimeEvents
    ?? g?.unknownTimeEvents
    ?? 0

  // Turn distribution: bucket from session dimension turns
  const turnCountDistribution = bucketTurns(bundle.session?.items ?? [])

  // Heatmap: build from time items
  const maxTokensForHeatmap = Math.max(1, ...byDate.map((d) => d.totalTokens))
  const heatmap: HeatmapCell[] = byDate.map((d) => {
    const ratio = d.totalTokens / maxTokensForHeatmap
    const level: 0 | 1 | 2 | 3 | 4 = ratio === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : 4
    return { date: d.date, value: d.totalTokens, level }
  })

  const valuation = valuationFromAggregate(g, billingTokens)

  const sessionsById = new Map<string, SessionLookupItem>()
  for (const session of sessions) {
    sessionsById.set(session.id, session)
    sessionsById.set(session.sessionId, session)
  }
  const bySession = (bundle.session?.items ?? []).map((aggregate) => {
    const session = sessionsById.get(aggregate.key)
    const available = aggregate.usageCoverage.covered > 0
    return {
      sessionId: aggregate.key,
      projectPath: session?.cwds?.find(Boolean) || session?.projectPath || '(unknown project)',
      source: session?.source || 'unknown',
      totalTokens: available ? aggregate.billingTokens : null,
      conversationOnlyTokens: available ? aggregate.conversationTokens : null,
      provenance: available ? 'usage-fact' : 'unavailable',
      valuation: {
        ...valuationFromAggregate(aggregate, aggregate.billingTokens),
      },
    }
  })
  const projectTotal = byProject.reduce((sum, project) => sum + project.totalTokens, 0)
  const sessionTotal = (bundle.session?.items ?? []).reduce((sum, session) => sum + session.processedTokens, 0)
  const tokenDifference = totalTokens - sessionTotal

  return {
    totalTokens,
    conversationOnlyTokens: convTokens,
    totalInputTokens: g ? g.nonCachedInputTokens + g.cacheReadTokens + g.cacheWriteTokens : 0,
    totalOutputTokens: g?.outputTokens ?? 0,
    totalSessions: scopedSessionCount,
    tokenAvailableSessions,
    tokenUnavailableSessions,
    totalTurns: g?.turns ?? 0,
    totalTime: 0,
    activeDays: byDate.filter((d) => d.totalTokens > 0).length,
    bySource,
    byModel,
    byProject,
    byFolder: [],
    byDate,
    heatmap,
    totalCacheReadTokens: g?.cacheReadTokens ?? 0,
    totalCacheCreationTokens: g?.cacheWriteTokens ?? 0,
    tokenBreakdown: aggregateTokenBreakdown(g),
    costUsd: g?.costUsd ?? null,
    pricingCoverage: g?.pricingCoverage ?? { covered: 0, total: 0, percent: null },
    usageCoverage: g?.usageCoverage ?? { covered: 0, total: 0, percent: null },
    modelCoverage: g?.modelCoverage ?? { covered: 0, total: 0, percent: null },
    totalCalls: g?.calls ?? 0,
    totalEvents: g?.eventCount ?? 0,
    valuation,
    hourlyDistribution,
    hourlyUnknownTimeEvents,
    turnCountDistribution,
    topTools: [],
    codeChanges: { filesRead: 0, filesWritten: 0, filesEdited: 0 },
    bySession,
    reconciliation: {
      global: totalTokens,
      projects: projectTotal,
      sessions: sessionTotal,
      difference: tokenDifference,
      ok: Math.abs(totalTokens - projectTotal) < 0.000001 && Math.abs(tokenDifference) < 0.000001,
      valuation: {
        globalUsd: valuation.usd ?? null,
        sessionsUsd: bySession.some((session) => session.valuation.usd !== undefined)
          ? bySession.reduce((sum, session) => sum + (session.valuation.usd || 0), 0)
          : null,
        uniqueEventsUsd: valuation.usd ?? null,
        difference: valuation.usd === undefined
          ? 0
          : valuation.usd - bySession.reduce((sum, session) => sum + (session.valuation.usd || 0), 0),
        coverageDifference: 0,
        ok: valuation.usd === undefined || Math.abs(
          valuation.usd - bySession.reduce((sum, session) => sum + (session.valuation.usd || 0), 0)
        ) < 0.000001,
      },
    },
  }
}

/**
 * Extract discovered sources, models, projects from query results
 * for populating FilterBar pill options.
 */
export function extractFilterOptions(bundle: QueryBundle): {
  sources: string[]
  models: string[]
  projects: Array<{ kind: 'project' | 'folder'; key: string; label: string }>
} {
  if (bundle.filterOptions) return bundle.filterOptions
  const sources = [...new Set((bundle.source?.items ?? []).map((a) => a.key))]
  const models = [...new Set((bundle.model?.items ?? []).map((a) => a.key))]
  const projects = (bundle.project?.items ?? []).map((a) => ({
    kind: 'project' as const,
    key: a.key,
    label: a.label,
  }))
  return { sources, models, projects }
}
