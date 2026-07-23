/**
 * Renderer-safe mirror of the analysis scope types from
 * src/main/analysis-contract.ts. The renderer must not import src/main
 * (tsconfig.web project boundary); keep these in lockstep with the contract —
 * the contract file is the source of truth and its tests cover the IPC shape.
 */
export type AnalysisPreset = 'today' | '7d' | '30d' | '90d' | 'all'
export type MetricBasis = 'billing' | 'conversation'

export interface AnalysisScope {
  range: { from?: string; to?: string } | AnalysisPreset
  sources?: string[]
  models?: string[]
  projectOrFolder?: { kind: 'project' | 'folder'; key: string }
  metricBasis: MetricBasis
}

export type AnalysisDimension =
  | 'global' | 'time' | 'hour' | 'source'
  | 'model' | 'project' | 'folder' | 'session'
export type DashboardAnalysisDimension = Exclude<AnalysisDimension, 'folder'>

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
  processedTokens: number
  billingTokens: number
  conversationTokens: number
  calls: number
  turns: number
  eventCount: number
  sessionCount: number
  detectedSessionCount: number
  parsedSessionCount: number
  usageAvailableSessionCount: number
  usageUnavailableSessionCount: number
  usageCoverage: CoverageMetric
  modelCoverage: CoverageMetric
  pricingCoverage: PricingCoveragePlaceholder
  costUsd: number | null
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
  schemaVersion: number
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
  schemaVersion: number
  usageRevision: string
  scope: AnalysisScope
  results: Record<DashboardAnalysisDimension, InsightsQueryResult>
}

export interface InsightsDrilldownSession {
  sessionId: string
  rootSessionId: string
  sourceClient: string
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
