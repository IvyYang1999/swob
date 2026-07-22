import type { SessionSource } from './types'

export const USAGE_FACT_SCHEMA_VERSION = 1

export type AnalysisPreset = 'today' | '7d' | '30d' | '90d' | 'all'
export type MetricBasis = 'billing' | 'conversation'
export type AnalysisDimension = 'global' | 'time' | 'hour' | 'source' | 'model' | 'project' | 'folder' | 'session'

export interface AnalysisScope {
  range: { from?: string; to?: string } | AnalysisPreset
  sources?: SessionSource[]
  models?: string[]
  projectOrFolder?: { kind: 'project' | 'folder'; key: string }
  metricBasis: MetricBasis
}

export interface UsageFact {
  eventId: string
  occurredAt: string | null
  /** Local calendar key derived from occurredAt, or the explicit unknown bucket. */
  occurredDay: string | 'unknown-time'
  occurredHour: number | null
  sourceClient: SessionSource
  sessionId: string
  rootSessionId: string
  agentScope: 'main' | 'subagent' | 'unknown'
  projectPath: string
  model: string | null
  modelRaw: string | null
  modelProvenance: string
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
  sessionCount: number
  usageCoverage: CoverageMetric
  modelCoverage: CoverageMetric
  pricingCoverage: PricingCoveragePlaceholder
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

export interface InsightsDrilldownSession {
  sessionId: string
  rootSessionId: string
  sourceClient: SessionSource
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
