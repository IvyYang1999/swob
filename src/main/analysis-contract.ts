import type { SessionSource } from './types'

export const USAGE_FACT_SCHEMA_VERSION = 9

export type AnalysisPreset = 'today' | '7d' | '30d' | '90d' | 'all'
export type MetricBasis = 'billing' | 'conversation'
export type AnalysisDimension = 'global' | 'time' | 'hour' | 'source' | 'model' | 'project' | 'folder' | 'session'
export type DashboardAnalysisDimension = Exclude<AnalysisDimension, 'folder'>
/** Legacy source IDs remain readable; future providers may use namespaced ProviderId strings. */
export type AnalysisSourceId = string

export interface AnalysisScope {
  range: { from?: string; to?: string } | AnalysisPreset
  sources?: AnalysisSourceId[]
  models?: string[]
  projectOrFolder?: { kind: 'project' | 'folder'; key: string }
  metricBasis: MetricBasis
}

export interface UsageFact {
  eventId: string
  /** Stable identity of the provider billing fact, shared by copied/forked transcripts. */
  billingFactId: string
  /** Exactly one copy of a billing fact participates in aggregates. All copies remain auditable. */
  billingIncluded: boolean
  occurredAt: string | null
  /** Local calendar key derived from occurredAt, or the explicit unknown bucket. */
  occurredDay: string | 'unknown-time'
  occurredHour: number | null
  sourceClient: AnalysisSourceId
  sessionId: string
  rootSessionId: string
  agentScope: 'main' | 'subagent' | 'unknown'
  projectPath: string
  model: string | null
  modelRaw: string | null
  modelProvenance: string
  /** Raw request-level provider label retained for attribution audit. */
  providerRaw: string | null
  /** Normalized provider used by valuation; null when the source did not prove one. */
  billingProvider: string | null
  providerProvenance: string | null
  /** Original source and billing identities; null only for pre-v8 historical facts. */
  sourceRowId: string | null
  providerFormatVersion: string | null
  dedupKey: string | null
  billingFactKey: string | null
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  usageProvenance: string
  callCount: number
  /** Main-agent usage events. Kept separate from calls so subagent work is visible. */
  turnCount: number
  costUsd?: number | null
  pricingProvenance?: string | null
  pricedTokens: number
  billableTokens: number
  financialCoveredTokens: number
  costLedgers: CostLedgerTotals
  priceRevision: string
  priceSnapshotHash: string
  pricingTrace: PricingTraceAudit[]
  revisionNotice?: PricingRevisionNotice
  valuationHistory: ValuationHistoryEntry[]
}

export interface UsageFactPage {
  events: UsageFact[]
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

export interface CostLedgerTotals {
  providerBilledUsd?: number
  harnessListEstimateUsd?: number
  swobEstimateUsd?: number
  subscriptionAllocatedUsd?: number
}

export interface PricingTraceAudit {
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
}

export interface PricingRevisionNotice {
  revision: string
  notice: { 'zh-CN': string; en: string }
}

export interface ValuationHistoryEntry {
  priceRevision: string
  priceSnapshotHash: string
  costUsd: number | null
  costLedgers: CostLedgerTotals
  pricingTrace: PricingTraceAudit[]
  recordedAt?: string
  whatIf?: boolean
}

export interface CoverageMetric {
  covered: number
  total: number
  percent: number | null
}

export interface PricingCoveragePlaceholder extends CoverageMetric {
  status: 'pending-t113' | 'available'
}

export interface UsageAggregate {
  key: string
  label: string
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Selected metricBasis total. Reasoning is a subset of output and is not added twice. */
  processedTokens: number
  billingTokens: number
  conversationTokens: number
  calls: number
  turns: number
  eventCount: number
  /** Compatibility total; on all-time categorical queries this equals detectedSessionCount. */
  sessionCount: number
  detectedSessionCount: number
  parsedSessionCount: number
  usageAvailableSessionCount: number
  usageUnavailableSessionCount: number
  usageCoverage: CoverageMetric
  modelCoverage: CoverageMetric
  pricingCoverage: PricingCoveragePlaceholder
  financialCoverage: CoverageMetric
  costUsd: number | null
  costLedgers: CostLedgerTotals
  priceRevisions: string[]
  pricingRevisionNotices: PricingRevisionNotice[]
  unknownTimeEvents: number
}

export interface ResolvedAnalysisRange {
  fromDay: string | null
  toDay: string | null
  label: string
}

export interface PreviousPeriodComparison {
  range: ResolvedAnalysisRange
  processedTokens: number
  absoluteChange: number
  percentChange: number | null
}

export interface InsightsQueryResult {
  schemaVersion: typeof USAGE_FACT_SCHEMA_VERSION
  scope: AnalysisScope
  dimension: AnalysisDimension
  range: ResolvedAnalysisRange
  items: UsageAggregate[]
  total: UsageAggregate
  previousPeriod: PreviousPeriodComparison | null
  quality: {
    unknownTimeEvents: number
    lastIndexedAt: string | null
  }
}

export interface InsightsQueryBundleResult {
  schemaVersion: typeof USAGE_FACT_SCHEMA_VERSION
  usageRevision: string
  scope: AnalysisScope
  filterOptions: {
    sources: string[]
    models: string[]
    projects: Array<{ kind: 'project' | 'folder'; key: string; label: string }>
  }
  results: Record<DashboardAnalysisDimension, InsightsQueryResult>
}

export interface InsightsDrilldownSession {
  sessionId: string
  rootSessionId: string
  sourceClient: AnalysisSourceId
  projectPath: string
  models: string[]
  processedTokens: number
  billingTokens: number
  conversationTokens: number
  calls: number
  turns: number
  firstOccurredAt: string | null
  lastOccurredAt: string | null
  usageProvenance: string[]
}

export interface UsageFactSyncResult {
  changedSessions: number
  unchangedSessions: number
  removedSessions: number
  factCount: number
  rebuilt: boolean
}
