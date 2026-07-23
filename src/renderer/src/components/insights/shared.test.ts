import { describe, expect, it } from 'vitest'
import {
  adaptQueryBundle,
  type InsightsQueryResult,
  type QueryBundle,
  type UsageAggregate
} from './shared'

function aggregate(
  key: string,
  processedTokens: number,
  coverage: { covered: number; total: number }
): UsageAggregate {
  return {
    key,
    label: key,
    nonCachedInputTokens: processedTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    processedTokens,
    billingTokens: processedTokens,
    conversationTokens: processedTokens,
    calls: coverage.covered,
    turns: coverage.covered,
    eventCount: coverage.covered,
    sessionCount: coverage.total,
    detectedSessionCount: coverage.total,
    parsedSessionCount: coverage.total,
    usageAvailableSessionCount: coverage.covered,
    usageUnavailableSessionCount: coverage.total - coverage.covered,
    usageCoverage: {
      ...coverage,
      percent: coverage.total > 0 ? (coverage.covered / coverage.total) * 100 : null
    },
    modelCoverage: { covered: 0, total: 0, percent: null },
    pricingCoverage: { covered: 0, total: processedTokens, percent: 0, status: 'available' },
    costUsd: null,
    unknownTimeEvents: 0
  }
}

function query(
  dimension: InsightsQueryResult['dimension'],
  items: UsageAggregate[],
  total: UsageAggregate
): InsightsQueryResult {
  return {
    schemaVersion: 5,
    scope: { range: 'all', metricBasis: 'billing' },
    dimension,
    range: { fromDay: null, toDay: null, label: 'All time' },
    items,
    total,
    previousPeriod: null,
    quality: { unknownTimeEvents: 0, lastIndexedAt: null }
  }
}

describe('adaptQueryBundle', () => {
  it('preserves session ranking, reconciliation and unavailable-session coverage', () => {
    const global = aggregate('global', 150, { covered: 2, total: 4 })
    const project = aggregate('/repo/project', 150, { covered: 2, total: 4 })
    const claude = aggregate('claude-code', 100, { covered: 1, total: 1 })
    const codex = aggregate('codex', 50, { covered: 1, total: 1 })
    const cursor = aggregate('cursor', 0, { covered: 0, total: 1 })
    const zcode = aggregate('zcode', 0, { covered: 0, total: 1 })
    const sessionOne = aggregate('session-one', 100, { covered: 1, total: 1 })
    const sessionTwo = aggregate('session-two', 50, { covered: 1, total: 1 })
    const sessionUnavailable = aggregate('session-unavailable', 0, { covered: 0, total: 1 })
    const bundle: QueryBundle = {
      global: query('global', [global], global),
      time: query('time', [], global),
      hour: query('hour', [], global),
      source: query('source', [claude, codex, cursor, zcode], global),
      model: query('model', [], global),
      project: query('project', [project], global),
      session: query('session', [sessionOne, sessionTwo, sessionUnavailable], global)
    }

    const adapted = adaptQueryBundle(bundle, [
      { id: 'session-one', sessionId: 'session-one', cwds: ['/repo/project'], source: 'claude-code' },
      { id: 'session-two', sessionId: 'session-two', cwds: ['/repo/project'], source: 'codex' }
    ])

    expect(adapted).toMatchObject({
      totalSessions: 4,
      tokenAvailableSessions: 2,
      tokenUnavailableSessions: 2,
      reconciliation: { global: 150, projects: 150, sessions: 150, difference: 0, ok: true }
    })
    expect(adapted.bySource.find((source) => source.source === 'cursor')).toMatchObject({
      label: 'Cursor', tokenAvailableSessions: 0, tokenUnavailableSessions: 1, tokenDataStatus: 'unavailable'
    })
    expect(adapted.bySession.map((session) => session.totalTokens)).toEqual([100, 50, null])
    expect(adapted.bySession[0]).toMatchObject({ projectPath: '/repo/project', source: 'claude-code' })
  })
})
