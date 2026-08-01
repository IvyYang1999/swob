import { describe, expect, it } from 'vitest'
import {
  adaptQueryBundle,
  extractFilterOptions,
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
    financialCoverage: { covered: 0, total: processedTokens, percent: 0 },
    costUsd: null,
    costLedgers: {},
    priceRevisions: [],
    pricingRevisionNotices: [],
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
  it('projects parallel cost ledgers, financial coverage and price revisions into the UI model', () => {
    const global = aggregate('global', 200, { covered: 1, total: 1 })
    global.costUsd = 0.14
    global.costLedgers = { harnessListEstimateUsd: 0.7, swobEstimateUsd: 0.14 }
    global.pricingCoverage = { covered: 200, total: 200, percent: 100, status: 'available' }
    global.financialCoverage = { covered: 0, total: 200, percent: 0 }
    global.priceRevisions = ['official-snapshot-2026-08-01.v2']
    global.pricingRevisionNotices = [{
      revision: 'official-snapshot-2026-08-01.v2',
      notice: { 'zh-CN': '因官方价格目录更新而修订', en: 'Revised after an official pricing catalog update' }
    }]

    const adapted = adaptQueryBundle({
      global: query('global', [global], global),
      time: null, hour: null, source: null, model: null, project: null, session: null
    })

    expect(adapted.valuation).toMatchObject({
      mode: 'mixed',
      usd: 0.14,
      ledgerBreakdown: { harnessListEstimateUsd: 0.7, swobEstimateUsd: 0.14 },
      coveragePercent: 100,
      financialCoveragePercent: 0,
      priceRevision: 'official-snapshot-2026-08-01.v2'
    })
    expect(adapted.valuation.revisionNotices).toHaveLength(1)
  })

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

describe('extractFilterOptions', () => {
  it('uses unfiltered bundle options even when current dimension rows are empty', () => {
    const total = aggregate('global', 0, { covered: 0, total: 0 })
    const bundle: QueryBundle = {
      global: query('global', [total], total),
      time: query('time', [], total),
      hour: query('hour', [], total),
      source: query('source', [], total),
      model: query('model', [], total),
      project: query('project', [], total),
      session: query('session', [], total),
      filterOptions: {
        sources: ['codex'],
        models: ['gpt-5'],
        projects: [{ kind: 'project', key: '/repo', label: '/repo' }]
      }
    }
    expect(extractFilterOptions(bundle)).toEqual(bundle.filterOptions)
  })
})
