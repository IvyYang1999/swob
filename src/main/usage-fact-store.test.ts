import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Folder, SessionSource, SessionSummary } from './types'
import { accountingFromMutuallyExclusiveUsage, mergeTokenAccountings } from './token-accounting'
import type { NormalizedTokenComponents, TokenAccounting, UsageEvent, UsageScope } from './token-accounting'
import type { AnalysisDimension, AnalysisScope } from './analysis-contract'
import { activityDaysFromTimestamps } from './activity-time'
import {
  closeUsageFactStore,
  drilldownInsights,
  hasCompletedUsageFactSnapshot,
  incrementalUsageFactCanonicalizationSql,
  queryInsights,
  queryInsightsBundle,
  sessionUsageEvents,
  synchronizeUsageFacts,
  usageFactStoreStats,
  usageRemovalGateThresholds,
  type UsageFactAbsenceEvidence
} from './usage-fact-store'
import type { SessionLoadEvidence } from './session-loader'

let root = ''
let previousUsageIndex: string | undefined

function localTimestamp(year: number, month: number, day: number, hour: number): string {
  return new Date(year, month - 1, day, hour, 0, 0, 0).toISOString()
}

function components(
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
  reasoning = 0,
  cacheWrite5m = 0,
  cacheWrite1h = 0
): NormalizedTokenComponents {
  return {
    nonCachedInputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    outputTokens: output,
    reasoningTokens: reasoning
  }
}

function usageEvent(
  dedupKey: string,
  timestamp: string | undefined,
  value: NormalizedTokenComponents,
  options: {
    scope?: UsageScope
    model?: string
    provenance?: 'reported' | 'derived' | 'estimated'
    reportedCostUsd?: number
    billingFactKey?: string
  } = {}
): UsageEvent {
  return {
    provider: 'claude-code',
    providerFormatVersion: 'test-v1',
    dedupKey,
    billingFactKey: options.billingFactKey,
    timestamp,
    model: options.model,
    modelRaw: options.model,
    modelCanonical: options.model,
    modelProvenance: options.model ? 'response' : 'unknown',
    billingProvider: 'anthropic',
    providerRaw: 'anthropic',
    providerProvenance: 'explicit',
    scope: options.scope || 'main',
    counterKind: 'incremental',
    provenance: options.provenance || 'reported',
    components: value,
    semantics: 'anthropic-disjoint',
    reportedCostUsd: options.reportedCostUsd,
    warnings: []
  }
}

function add(left: NormalizedTokenComponents, right: NormalizedTokenComponents): NormalizedTokenComponents {
  return {
    nonCachedInputTokens: left.nonCachedInputTokens + right.nonCachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheWrite5mTokens: left.cacheWrite5mTokens + right.cacheWrite5mTokens,
    cacheWrite1hTokens: left.cacheWrite1hTokens + right.cacheWrite1hTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: (left.reasoningTokens || 0) + (right.reasoningTokens || 0)
  }
}

function total(value: NormalizedTokenComponents): number {
  return value.nonCachedInputTokens + value.cacheReadTokens + value.cacheWriteTokens +
    value.cacheWrite5mTokens + value.cacheWrite1hTokens + value.outputTokens
}

function makeSession(
  id: string,
  project: string,
  events: UsageEvent[],
  options: {
    source?: SessionSource
    unavailable?: boolean
    turns?: number
    updatedAt?: string
    activityDays?: string[]
    parse?: 'parsed' | 'no-data' | 'placeholder' | 'error'
  } = {}
): SessionSummary {
  const summed = events.reduce((sum, event) => add(sum, event.components), components(0, 0))
  const conversation = events
    .filter((event) => event.scope === 'main')
    .reduce((sum, event) => add(sum, event.components), components(0, 0))
  const accounting: TokenAccounting = options.unavailable
    ? {
        provider: options.source || 'claude-code', metricVersion: 2, provenance: 'unavailable',
        billingTotal: null, conversationOnly: null, components: null, usageEvents: [],
        unavailableReason: 'fixture unavailable', warnings: []
      }
    : {
        provider: options.source || 'claude-code', metricVersion: 2, provenance: 'reported',
        billingTotal: total(summed), conversationOnly: total(conversation), components: summed,
        usageEvents: events.map((event) => ({ ...event, provider: options.source || event.provider })), warnings: []
      }
  return {
    id,
    sessionId: id,
    slug: id,
    createdAt: '2026-07-20T00:00:00Z',
    updatedAt: options.updatedAt || '2026-07-22T00:00:00Z',
    activityDays: options.activityDays ?? activityDaysFromTimestamps(events.map((event) => event.timestamp)),
    messageCount: events.length * 2,
    turnCount: options.turns ?? events.filter((event) => event.scope === 'main').length,
    compactCount: 0,
    cwds: [project],
    version: 'test',
    firstUserMessage: id,
    toolUsage: {},
    skillInvocations: [],
    projectPath: project,
    filePath: path.join(root, `${id}.jsonl`),
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: {
      inputTokens: summed.nonCachedInputTokens,
      outputTokens: summed.outputTokens,
      cacheCreationTokens: summed.cacheWriteTokens,
      cacheReadTokens: summed.cacheReadTokens
    },
    tokenAccounting: accounting,
    providerOutcome: {
      detected: 'detected',
      parse: options.parse || (events.length > 0 ? 'parsed' : 'placeholder'),
      usage: options.unavailable ? 'unavailable' : 'available'
    },
    referencedFiles: [],
    configFiles: [],
    source: options.source || 'claude-code',
    models: [...new Set(events.flatMap((event) => event.model ? [event.model] : []))]
  }
}

function folder(id: string, sessionIds: string[]): Folder {
  return { id, name: id, sessionIds, createdAt: '2026-07-20T00:00:00Z' }
}

function scope(overrides: Partial<AnalysisScope> = {}): AnalysisScope {
  return { range: 'all', metricBasis: 'billing', ...overrides }
}

beforeEach(() => {
  closeUsageFactStore()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-usage-facts-'))
  previousUsageIndex = process.env.SWOB_USAGE_INDEX_PATH
  process.env.SWOB_USAGE_INDEX_PATH = path.join(root, 'usage.db')
})

afterEach(() => {
  closeUsageFactStore()
  if (previousUsageIndex === undefined) delete process.env.SWOB_USAGE_INDEX_PATH
  else process.env.SWOB_USAGE_INDEX_PATH = previousUsageIndex
  fs.rmSync(root, { recursive: true, force: true })
})

describe('UsageFact + AnalysisScope', () => {
  it('returns all dashboard dimensions from one cached usage revision', () => {
    // Pin the clock: the fixture event is dated 2026-07-20 and the query uses a relative '30d'
    // range, so this test expired once the real date moved past 2026-08-19.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'))
    try {
      const session = makeSession('bundle', '/repo/bundle', [
        usageEvent('bundle-event', localTimestamp(2026, 7, 20, 12), components(10, 5), { model: 'model-a' })
      ])
      synchronizeUsageFacts([session], [])

      const first = queryInsightsBundle(scope({ range: '30d' }))
      const second = queryInsightsBundle(scope({ range: '30d' }))

      expect(second).toBe(first)
      expect(Object.keys(first.results).sort()).toEqual([
        'global', 'hour', 'model', 'project', 'session', 'source', 'time'
      ])
      expect(first.results.global.total.processedTokens).toBe(15)
      expect(first.results.session.items[0]).toMatchObject({ key: 'bundle', processedTokens: 15 })
      expect(first.results.model.items[0]).toMatchObject({ key: 'model-a', processedTokens: 15 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps filter choices from the unfiltered range when the selected filter returns no rows', () => {
    const alpha = makeSession('filter-alpha', '/repo/alpha', [
      usageEvent('filter-alpha-event', localTimestamp(2026, 7, 20, 12), components(10, 5), { model: 'model-a' })
    ])
    const beta = makeSession('filter-beta', '/repo/beta', [
      usageEvent('filter-beta-event', localTimestamp(2026, 7, 20, 13), components(20, 5), { model: 'model-b' })
    ], { source: 'codex' })
    synchronizeUsageFacts([alpha, beta], [folder('work', ['filter-alpha'])])

    const bundle = queryInsightsBundle(scope({
      sources: ['source-with-no-results'],
      projectOrFolder: { kind: 'project', key: '/repo/missing' }
    }))

    expect(bundle.results.global.total.processedTokens).toBe(0)
    expect(bundle.filterOptions.sources.sort()).toEqual(['claude-code', 'codex'])
    expect(bundle.filterOptions.models.sort()).toEqual(['model-a', 'model-b'])
    expect(bundle.filterOptions.projects).toEqual(expect.arrayContaining([
      { kind: 'project', key: '/repo/alpha', label: '/repo/alpha' },
      { kind: 'project', key: '/repo/beta', label: '/repo/beta' },
      { kind: 'folder', key: 'work', label: 'work' }
    ]))
  })

  it('invalidates the bundle cache for distinct snapshots committed in the same millisecond', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'))
    try {
      const firstSession = makeSession('same-ms', '/repo/same-ms', [
        usageEvent('same-ms-event', '2026-07-22T12:00:00.000Z', components(10, 5))
      ])
      synchronizeUsageFacts([firstSession], [])
      const first = queryInsightsBundle(scope())

      const secondSession = makeSession('same-ms', '/repo/same-ms', [
        usageEvent('same-ms-event', '2026-07-22T12:00:00.000Z', components(20, 5))
      ])
      synchronizeUsageFacts([secondSession], [])
      const second = queryInsightsBundle(scope())

      expect(first.results.global.total.processedTokens).toBe(15)
      expect(second.results.global.total.processedTokens).toBe(25)
      expect(second.usageRevision).not.toBe(first.usageRevision)
      expect(second).not.toBe(first)
    } finally {
      vi.useRealTimers()
    }
  })

  it('跨天会话按事件真实日期拆分，五桶完整且 reasoning 不重复计入 processed', () => {
    const session = makeSession('cross-day', '/repo/alpha', [
      usageEvent('day-one', localTimestamp(2026, 7, 20, 23), components(10, 5, 2, 3, 4), { model: 'model-a' }),
      usageEvent('day-two', localTimestamp(2026, 7, 21, 1), components(20, 7, 4, 6, 3, 8, 9), { model: 'model-a' })
    ])
    synchronizeUsageFacts([session], [])

    const result = queryInsights(scope(), 'time')

    expect(result.items.map((item) => [item.key, item.processedTokens])).toEqual([
      ['2026-07-20', 20],
      ['2026-07-21', 54]
    ])
    expect(result.total).toMatchObject({
      nonCachedInputTokens: 30,
      cacheReadTokens: 6,
      cacheWriteTokens: 26,
      outputTokens: 12,
      reasoningTokens: 7,
      processedTokens: 74
    })
    expect(result.total.processedTokens).not.toBe(81)
  })

  it('无 timestamp 事件保留在总量和质量计数中，但所有时间轴都不接收 unknown-time', () => {
    const session = makeSession('unknown-time', '/repo/alpha', [
      usageEvent('known', localTimestamp(2026, 7, 20, 12), components(10, 1)),
      usageEvent('unknown', undefined, components(50, 5))
    ])
    synchronizeUsageFacts([session], [])

    const all = queryInsights(scope(), 'time')
    expect(all.items.map((item) => item.key)).toEqual(['2026-07-20'])
    expect(all.quality.unknownTimeEvents).toBe(1)
    expect(all.total.processedTokens).toBe(66)
    expect(queryInsights(scope(), 'hour').items.every((item) => item.key !== 'unknown-time')).toBe(true)

    const bundle = queryInsightsBundle(scope())
    expect(bundle.results.time.items.map((item) => item.key)).toEqual(['2026-07-20'])
    expect(bundle.results.hour.items.every((item) => item.key !== 'unknown-time')).toBe(true)
    for (const dimension of ['global', 'time', 'hour', 'source', 'model', 'project', 'session'] as const) {
      expect(() => structuredClone(bundle.results[dimension])).not.toThrow()
    }

    const bounded = queryInsights(scope({ range: { from: '2026-07-20', to: '2026-07-20' } }), 'time')
    expect(bounded.items).toHaveLength(1)
    expect(bounded.items[0].processedTokens).toBe(11)
    expect(bounded.quality.unknownTimeEvents).toBe(1)
  })

  it('billing/conversation 双口径区分子代理，来源/模型/项目/文件夹过滤可组合', () => {
    const main = usageEvent('main', localTimestamp(2026, 7, 20, 12), components(10, 5, 2, 1), { model: 'model-a' })
    const subagent = usageEvent('sub', localTimestamp(2026, 7, 20, 13), components(100, 20, 10, 5), { scope: 'subagent', model: 'model-b' })
    const session = makeSession('mixed-scope', '/repo/alpha', [main, subagent])
    synchronizeUsageFacts([session], [folder('work', ['mixed-scope'])])

    const billing = queryInsights(scope({
      sources: ['claude-code'],
      projectOrFolder: { kind: 'folder', key: 'work' }
    }), 'model')
    expect(billing.total.processedTokens).toBe(153)
    expect(billing.items.map((item) => item.key)).toEqual(['model-b', 'model-a'])

    const conversation = queryInsights(scope({
      metricBasis: 'conversation',
      models: ['model-a'],
      projectOrFolder: { kind: 'project', key: '/repo/alpha' }
    }), 'global')
    expect(conversation.total.processedTokens).toBe(18)
    expect(conversation.total.billingTokens).toBe(18)
    expect(conversation.total.conversationTokens).toBe(18)
    expect(conversation.total.turns).toBe(1)
  })

  it('同一 scope 下 global = Σsource = Σproject = Σsession = Σfact', () => {
    const sessions = [
      makeSession('a', '/repo/alpha', [
        usageEvent('a1', localTimestamp(2026, 7, 20, 8), components(10, 2, 3, 4), { model: 'm1' }),
        usageEvent('a2', localTimestamp(2026, 7, 21, 8), components(7, 5), { model: 'm2' })
      ]),
      makeSession('b', '/repo/beta', [
        usageEvent('b1', localTimestamp(2026, 7, 21, 9), components(30, 10, 5, 2), { model: 'm1' })
      ], { source: 'codex' })
    ]
    synchronizeUsageFacts(sessions, [])
    const analysisScope = scope({ range: { from: '2026-07-20', to: '2026-07-21' } })
    const dimensions: AnalysisDimension[] = ['source', 'project', 'session']
    const global = queryInsights(analysisScope, 'global').total.processedTokens
    for (const dimension of dimensions) {
      const sum = queryInsights(analysisScope, dimension).items.reduce((value, item) => value + item.processedTokens, 0)
      expect(sum, dimension).toBe(global)
    }
    const factSum = sessions.flatMap((session) => session.tokenAccounting!.usageEvents)
      .reduce((sum, event) => sum + total(event.components), 0)
    expect(global).toBe(factSum)
  })

  it('下钻返回命中会话，sessionEvents 返回事件级证据', () => {
    const session = makeSession('drill', '/repo/alpha', [
      usageEvent('one', localTimestamp(2026, 7, 20, 8), components(10, 5), { model: 'm1', provenance: 'derived' }),
      usageEvent('two', localTimestamp(2026, 7, 21, 8), components(20, 5), { model: 'm2' })
    ])
    synchronizeUsageFacts([session], [])

    expect(drilldownInsights(scope(), 'model', 'm2')).toMatchObject([{
      sessionId: 'drill',
      projectPath: '/repo/alpha',
      models: ['m2'],
      processedTokens: 25
    }])
    const page = sessionUsageEvents('drill', scope({ range: { from: '2026-07-21', to: '2026-07-21' } }))
    expect(page).toMatchObject({ offset: 0, limit: 100, total: 1, hasMore: false })
    expect(page.events).toHaveLength(1)
    expect(page.events[0]).toMatchObject({ model: 'm2', nonCachedInputTokens: 20, outputTokens: 5 })

    const firstPage = sessionUsageEvents('drill', scope(), { limit: 1 })
    const secondPage = sessionUsageEvents('drill', scope(), { limit: 1, offset: 1 })
    expect(firstPage).toMatchObject({ offset: 0, limit: 1, total: 2, hasMore: true })
    expect(secondPage).toMatchObject({ offset: 1, limit: 1, total: 2, hasMore: false })
    expect(firstPage.events[0].eventId).not.toBe(secondPage.events[0].eventId)
  })

  it('多级分支会话事实追溯到真正 rootSessionId', () => {
    const rootSession = makeSession('root', '/repo/alpha', [
      usageEvent('root-event', localTimestamp(2026, 7, 20, 8), components(1, 1))
    ])
    const child = makeSession('child', '/repo/alpha', [
      usageEvent('child-event', localTimestamp(2026, 7, 20, 9), components(2, 1))
    ])
    child.branchParentId = 'root'
    const grandchild = makeSession('grandchild', '/repo/alpha', [
      usageEvent('grandchild-event', localTimestamp(2026, 7, 20, 10), components(3, 1))
    ])
    grandchild.branchParentId = 'child'

    synchronizeUsageFacts([rootSession, child, grandchild], [])

    expect(sessionUsageEvents('grandchild', scope()).events[0].rootSessionId).toBe('root')
  })

  it('previous period 自动使用同长度、同过滤口径', () => {
    const session = makeSession('periods', '/repo/alpha', [
      usageEvent('previous', localTimestamp(2026, 7, 20, 8), components(8, 2), { model: 'm1' }),
      usageEvent('current', localTimestamp(2026, 7, 21, 8), components(16, 4), { model: 'm1' })
    ])
    synchronizeUsageFacts([session], [])

    const result = queryInsights(scope({ range: { from: '2026-07-21', to: '2026-07-21' }, models: ['m1'] }), 'global')
    expect(result.total.processedTokens).toBe(20)
    expect(result.previousPeriod).toMatchObject({
      range: { fromDay: '2026-07-20', toDay: '2026-07-20' },
      processedTokens: 10,
      absoluteChange: 10,
      percentChange: 100
    })
  })

  it('同步只重算变化 session，文件夹变化不重写 fact，删除会 prune', () => {
    const a = makeSession('a', '/repo/alpha', [usageEvent('a1', localTimestamp(2026, 7, 20, 8), components(10, 2))])
    const b = makeSession('b', '/repo/beta', [usageEvent('b1', localTimestamp(2026, 7, 20, 8), components(20, 4))])
    expect(synchronizeUsageFacts([a, b], [folder('one', ['a'])])).toMatchObject({ changedSessions: 2, unchangedSessions: 0, factCount: 2 })
    expect(synchronizeUsageFacts([a, b], [folder('two', ['a'])])).toMatchObject({ changedSessions: 0, unchangedSessions: 2, factCount: 2 })

    const changedA = makeSession('a', '/repo/alpha', [usageEvent('a1', localTimestamp(2026, 7, 20, 8), components(30, 2))])
    expect(synchronizeUsageFacts([changedA, b], [])).toMatchObject({ changedSessions: 1, unchangedSessions: 1, factCount: 2 })
    expect(synchronizeUsageFacts([changedA], [])).toMatchObject({ removedSessions: 1, factCount: 1 })
    expect(usageFactStoreStats()).toMatchObject({ schemaVersion: 9, sessions: 1, facts: 1 })
  })

  it.each([6, 7])('v%d 账本原地升级为 v9：旧事实保留且不伪造已丢失的审计 provenance', (legacyVersion) => {
    const session = makeSession('migration-sentinel', '/repo/migration', [
      usageEvent('sentinel-call', localTimestamp(2026, 7, 20, 8), components(7, 3))
    ])
    synchronizeUsageFacts([session], [])
    expect(usageFactStoreStats().schemaVersion).toBe(9)
    closeUsageFactStore()

    const dbPath = process.env.SWOB_USAGE_INDEX_PATH!
    const legacy = new Database(dbPath)
    if (legacyVersion === 6) {
      legacy.exec(`
        DROP INDEX IF EXISTS usage_facts_billing_current_idx;
        DROP INDEX IF EXISTS usage_facts_superseded_idx;
        ALTER TABLE usage_facts DROP COLUMN superseded_by;
        ALTER TABLE usage_facts DROP COLUMN superseded_at;
        ALTER TABLE usage_facts DROP COLUMN superseded;
      `)
    }
    legacy.exec(`
      ALTER TABLE usage_sessions DROP COLUMN projection_signature;
      ALTER TABLE usage_facts DROP COLUMN provider_raw;
      ALTER TABLE usage_facts DROP COLUMN billing_provider;
      ALTER TABLE usage_facts DROP COLUMN provider_provenance;
      ALTER TABLE usage_facts DROP COLUMN source_row_id;
      ALTER TABLE usage_facts DROP COLUMN provider_format_version;
      ALTER TABLE usage_facts DROP COLUMN dedup_key;
      ALTER TABLE usage_facts DROP COLUMN billing_fact_key;
      UPDATE usage_schema_meta SET schema_version = ${legacyVersion} WHERE singleton = 1;
    `)
    legacy.close()

    expect(usageFactStoreStats().schemaVersion).toBe(9)
    expect(synchronizeUsageFacts([session], [])).toMatchObject({
      changedSessions: 0,
      unchangedSessions: 1,
      factCount: 1
    })
    closeUsageFactStore()
    const migrated = new Database(dbPath, { readonly: true })
    const columns = (migrated.prepare('PRAGMA table_info(usage_facts)').all() as Array<{ name: string }>)
      .map((column) => column.name)
    const indexes = (migrated.prepare('PRAGMA index_list(usage_facts)').all() as Array<{ name: string }>)
      .map((index) => index.name)
    migrated.close()
    expect(columns).toEqual(expect.arrayContaining([
      'superseded', 'superseded_at', 'superseded_by',
      'provider_raw', 'billing_provider', 'provider_provenance',
      'source_row_id', 'provider_format_version', 'dedup_key', 'billing_fact_key'
    ]))
    expect(indexes).toContain('usage_facts_billing_current_idx')
    expect(sessionUsageEvents('migration-sentinel', scope()).events).toEqual([
      expect.objectContaining({
        nonCachedInputTokens: 7,
        outputTokens: 3,
        providerRaw: null,
        billingProvider: null,
        providerProvenance: null,
        sourceRowId: null,
        providerFormatVersion: null,
        dedupKey: null,
        billingFactKey: null
      })
    ])
  })

  it('v8 账本原地升级后先完整补齐投影签名，再允许轻量热启动', () => {
    const session = makeSession('v8-projection-sentinel', '/repo/migration', [
      usageEvent('v8-call', localTimestamp(2026, 7, 20, 8), components(11, 4))
    ])
    synchronizeUsageFacts([session], [])
    closeUsageFactStore()

    const dbPath = process.env.SWOB_USAGE_INDEX_PATH!
    const legacy = new Database(dbPath)
    legacy.exec(`
      ALTER TABLE usage_sessions DROP COLUMN projection_signature;
      UPDATE usage_schema_meta SET schema_version = 8 WHERE singleton = 1;
    `)
    legacy.close()

    expect(hasCompletedUsageFactSnapshot()).toBe(false)
    expect(synchronizeUsageFacts([session], [])).toMatchObject({
      changedSessions: 0,
      unchangedSessions: 1,
      factCount: 1
    })
    expect(hasCompletedUsageFactSnapshot()).toBe(true)
    expect(sessionUsageEvents(session.sessionId, scope()).events).toHaveLength(1)
  })

  it('incremental canonicalization uses the billing-fact/current composite index', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE usage_facts (
        event_id TEXT PRIMARY KEY,
        billing_fact_id TEXT NOT NULL,
        billing_included INTEGER NOT NULL,
        superseded INTEGER NOT NULL,
        agent_scope TEXT NOT NULL,
        occurred_at TEXT
      );
      CREATE INDEX usage_facts_superseded_idx
        ON usage_facts(superseded, event_id);
      CREATE INDEX usage_facts_billing_current_idx
        ON usage_facts(billing_fact_id, superseded);
    `)
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN ${incrementalUsageFactCanonicalizationSql(1)}`
    ).all('billing-1') as Array<{ detail: string }>
    db.close()

    const candidateLookup = plan.find((row) => row.detail.includes('candidate'))?.detail || ''
    expect(candidateLookup).toContain('usage_facts_billing_current_idx')
    expect(candidateLookup).toContain('billing_fact_id=? AND superseded=?')
  })

  it('incrementally canonicalizes 100k facts within a bounded time', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE usage_facts (
        event_id TEXT PRIMARY KEY,
        billing_fact_id TEXT NOT NULL,
        billing_included INTEGER NOT NULL DEFAULT 0,
        superseded INTEGER NOT NULL DEFAULT 0,
        agent_scope TEXT NOT NULL,
        occurred_at TEXT
      );
      CREATE INDEX usage_facts_superseded_idx
        ON usage_facts(superseded, event_id);
      CREATE INDEX usage_facts_billing_current_idx
        ON usage_facts(billing_fact_id, superseded);
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 100000
      )
      INSERT INTO usage_facts(event_id, billing_fact_id, agent_scope, occurred_at)
      SELECT
        printf('event-%06d', value),
        printf('billing-%06d', CAST((value + 1) / 2 AS INTEGER)),
        CASE WHEN value % 2 = 1 THEN 'main' ELSE 'subagent' END,
        printf('2026-08-02T00:%02d:%02d.000Z', (value / 60) % 60, value % 60)
      FROM sequence;
    `)

    const billingIds = Array.from(
      { length: 50_000 },
      (_, index) => `billing-${String(index + 1).padStart(6, '0')}`
    )
    const startedAt = performance.now()
    const update = db.prepare(incrementalUsageFactCanonicalizationSql(400))
    const canonicalize = db.transaction(() => {
      for (let offset = 0; offset < billingIds.length; offset += 400) {
        update.run(...billingIds.slice(offset, offset + 400))
      }
    })
    canonicalize()
    const elapsedMs = performance.now() - startedAt
    const included = db.prepare(
      'SELECT COUNT(*) AS count FROM usage_facts WHERE billing_included = 1'
    ).get() as { count: number }
    db.close()

    expect(included.count).toBe(50_000)
    expect(elapsedMs).toBeLessThan(10_000)
  }, 20_000)

  it('OpenCode/ZCode 历史 aggregate 重扫后保留为 superseded，只有逐调用事实进账', () => {
    const sources = [
      { source: 'opencode' as const, format: 'opencode-message-usage-v2', dedupKey: 'opencode:message:msg_1' },
      { source: 'zcode' as const, format: 'zcode-model-usage-v1', dedupKey: 'zcode:model-usage:usage_1' }
    ]
    const legacySessions = sources.map(({ source }) => {
      const session = makeSession(`legacy-${source}`, `/repo/${source}`, [], {
        source, turns: 1, parse: 'parsed'
      })
      session.tokenUsage = {
        inputTokens: 100,
        outputTokens: 20,
        cacheCreationTokens: 0,
        cacheReadTokens: 0
      }
      session.tokenAccounting = accountingFromMutuallyExclusiveUsage(source, session.tokenUsage)
      session.providerOutcome = { detected: 'detected', parse: 'parsed', usage: 'available' }
      return session
    })
    expect(synchronizeUsageFacts(legacySessions, [])).toMatchObject({ factCount: 2 })

    const perCallSessions = sources.map(({ source, format, dedupKey }) => {
      const event = usageEvent(dedupKey, localTimestamp(2026, 7, 20, 12), components(40, 8), {
        model: source === 'opencode' ? 'gpt-5.1' : 'glm-4.5'
      })
      event.provider = source
      event.providerFormatVersion = format
      event.billingFactKey = dedupKey
      event.billingProvider = source === 'opencode' ? 'openai' : 'zhipu'
      event.providerRaw = event.billingProvider
      event.providerProvenance = 'explicit'
      return makeSession(`legacy-${source}`, `/repo/${source}`, [event], { source })
    })

    expect(synchronizeUsageFacts(perCallSessions, [], { rebuild: true })).toMatchObject({
      changedSessions: 2,
      factCount: 2,
      rebuilt: true
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(96)
    for (const { source, dedupKey } of sources) {
      expect(sessionUsageEvents(`legacy-${source}`, scope()).events).toEqual([
        expect.objectContaining({
          sourceClient: source,
          billingIncluded: true,
          nonCachedInputTokens: 40,
          outputTokens: 8
        })
      ])
      expect(sessionUsageEvents(`legacy-${source}`, scope()).events[0].billingFactId)
        .not.toBe(dedupKey)
    }

    closeUsageFactStore()
    const audit = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true })
    const rows = audit.prepare(`
      SELECT source_client, superseded, billing_included, superseded_by
      FROM usage_facts
      ORDER BY source_client, superseded DESC
    `).all() as Array<{
      source_client: string
      superseded: number
      billing_included: number
      superseded_by: string | null
    }>
    const historyCount = (audit.prepare(
      'SELECT COUNT(*) AS count FROM usage_valuation_history'
    ).get() as { count: number }).count
    audit.close()
    expect(rows).toHaveLength(4)
    for (const source of ['opencode', 'zcode']) {
      expect(rows.filter((row) => row.source_client === source)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          superseded: 1,
          billing_included: 0,
          superseded_by: 't183-per-call-usage-v1'
        }),
        expect.objectContaining({ superseded: 0, billing_included: 1 })
      ]))
    }
    expect(historyCount).toBeGreaterThanOrEqual(4)

    // A stale pre-t183 summary cache, or a loader that falls back to the
    // legacy aggregate (a rejected model_usage row), can bring the same
    // sessions back as their aggregate. F1k: the ledger keeps each such
    // session as committed - never revives or replaces the superseded
    // aggregate, never discards the stronger per-call facts - and commits the
    // sync instead of rolling back every source on the aggregate's primary key.
    const revisionBefore = Number(queryInsightsBundle(scope()).usageRevision)
    expect(synchronizeUsageFacts(legacySessions, [])).toEqual({
      changedSessions: 0,
      unchangedSessions: 2,
      removedSessions: 0,
      factCount: 2,
      rebuilt: false,
      downgradesSkipped: { opencode: 1, zcode: 1 }
    })
    expect(Number(queryInsightsBundle(scope()).usageRevision)).toBe(revisionBefore + 1)
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(96)
    closeUsageFactStore()
    const kept = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true })
    const keptRows = kept.prepare(`
      SELECT source_client, superseded, billing_included, superseded_by
      FROM usage_facts
      ORDER BY source_client, superseded DESC
    `).all()
    kept.close()
    expect(keptRows).toEqual(rows)

    // When authoritative request rows are parsed again, the round trip is a
    // no-op over the last committed per-call snapshot.
    expect(synchronizeUsageFacts(perCallSessions, [])).toMatchObject({
      changedSessions: 0,
      unchangedSessions: 2,
      factCount: 2
    })
  })

  it('cancels a background rebuild at a transaction boundary and preserves the last committed snapshot', () => {
    const original = makeSession('cancelled', '/repo/cancelled', [
      usageEvent('before', localTimestamp(2026, 7, 20, 8), components(10, 2))
    ])
    synchronizeUsageFacts([original], [])

    const changed = makeSession('cancelled', '/repo/cancelled', [
      usageEvent('after', localTimestamp(2026, 7, 20, 8), components(100, 20))
    ])
    let checks = 0
    expect(() => synchronizeUsageFacts([changed], [], {
      shouldCancel: () => ++checks > 3
    })).toThrowError(/cancelled/)

    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(12)
    expect(usageFactStoreStats()).toMatchObject({ sessions: 1, facts: 1 })
  })

  it('usage/model/pricing coverage 显式且 pricing 使用 t113 逐请求估值', () => {
    const available = makeSession('available', '/repo/alpha', [
      usageEvent('known-model', localTimestamp(2026, 7, 20, 8), components(10, 2), {
        model: 'm1', reportedCostUsd: 0.25
      }),
      usageEvent('unknown-model', localTimestamp(2026, 7, 20, 9), components(5, 1))
    ])
    const unavailable = makeSession('unavailable', '/repo/alpha', [], {
      unavailable: true,
      parse: 'parsed'
    })
    synchronizeUsageFacts([available, unavailable], [folder('mixed-folder', ['available', 'unavailable'])])

    const result = queryInsights(scope(), 'global')
    expect(result.total.usageCoverage).toEqual({ covered: 1, total: 2, percent: 50 })
    expect(result.total).toMatchObject({
      detectedSessionCount: 2,
      parsedSessionCount: 2,
      usageAvailableSessionCount: 1,
      usageUnavailableSessionCount: 1
    })
    expect(result.total.modelCoverage).toEqual({ covered: 1, total: 2, percent: 50 })
    expect(result.total.pricingCoverage).toEqual({
      status: 'available', covered: 0, total: 18, percent: 0
    })
    expect(result.total.financialCoverage).toEqual({ covered: 0, total: 18, percent: 0 })
    expect(result.total.costUsd).toBe(0.25)
    expect(result.total.costLedgers).toEqual({ harnessListEstimateUsd: 0.25 })
    expect(queryInsights(scope(), 'project').items[0].usageCoverage).toEqual({
      covered: 1, total: 2, percent: 50
    })
    expect(queryInsights(scope(), 'folder').items[0]).toMatchObject({
      key: 'mixed-folder', label: 'mixed-folder',
      usageCoverage: { covered: 1, total: 2, percent: 50 }
    })
    expect(queryInsights(scope(), 'session').items.find((item) => item.key === 'unavailable')).toMatchObject({
      processedTokens: 0,
      usageCoverage: { covered: 0, total: 1, percent: 0 }
    })
    const bounded = queryInsights(scope({
      range: { from: '2026-07-22', to: '2026-07-22' }
    }), 'source')
    expect(bounded.total.processedTokens).toBe(0)
    expect(bounded.total.sessionCount).toBe(0)
    expect(bounded.total.usageCoverage).toEqual({ covered: 0, total: 0, percent: null })
    expect(bounded.items).toEqual([])
  })

  it('bounded coverage 只认事件活动日，updatedAt 不得替代事件时间', () => {
    const availableInRange = makeSession('available-in-range', '/repo/alpha', [
      usageEvent('available-day-20', localTimestamp(2026, 7, 20, 8), components(10, 2), { model: 'm1' })
    ], { updatedAt: '2026-07-22T00:00:00Z' })
    const unavailableInRange = makeSession('unavailable-in-range', '/repo/alpha', [], {
      source: 'cursor', unavailable: true, updatedAt: '2026-07-19T00:00:00Z',
      activityDays: ['2026-07-20'], parse: 'parsed'
    })
    const updatedOnlyInRange = makeSession('updated-only-in-range', '/repo/alpha', [
      usageEvent('event-day-21', localTimestamp(2026, 7, 21, 9), components(20, 2), { model: 'm1' })
    ], { updatedAt: '2026-07-20T00:00:00Z' })
    const crossDay = makeSession('cross-day-activity', '/repo/alpha', [
      usageEvent('cross-day-20', localTimestamp(2026, 7, 20, 10), components(5, 1), { model: 'm1' }),
      usageEvent('cross-day-21', localTimestamp(2026, 7, 21, 10), components(7, 2), { model: 'm1' })
    ])
    const noTime = makeSession('no-time', '/repo/alpha', [], {
      unavailable: true, updatedAt: '2026-07-20T00:00:00Z', activityDays: []
    })
    const placeholder = makeSession('placeholder', '/repo/alpha', [], {
      unavailable: true, turns: 0, updatedAt: '2026-07-20T00:00:00Z', activityDays: []
    })
    const sessions = [availableInRange, unavailableInRange, updatedOnlyInRange, crossDay, noTime, placeholder]
    synchronizeUsageFacts(sessions, [folder('all-sessions', sessions.map((session) => session.sessionId))])

    expect(queryInsights(scope(), 'global').total).toMatchObject({
      sessionCount: 4,
      detectedSessionCount: 6,
      parsedSessionCount: 4,
      usageCoverage: { covered: 3, total: 4, percent: 75 }
    })

    const day20 = scope({ range: { from: '2026-07-20', to: '2026-07-20' } })
    const global = queryInsights(day20, 'global')
    expect(global.total).toMatchObject({
      processedTokens: 18,
      sessionCount: 3,
      usageCoverage: { covered: 2, total: 3, percent: (2 / 3) * 100 }
    })

    const source = queryInsights(day20, 'source')
    expect(source.items.find((item) => item.key === 'claude-code')).toMatchObject({
      processedTokens: 18,
      sessionCount: 2,
      usageCoverage: { covered: 2, total: 2, percent: 100 }
    })
    expect(source.items.find((item) => item.key === 'cursor')).toMatchObject({
      processedTokens: 0,
      sessionCount: 1,
      usageCoverage: { covered: 0, total: 1, percent: 0 }
    })

    for (const dimension of ['project', 'folder'] as const) {
      const item = queryInsights(day20, dimension).items[0]
      expect(item).toMatchObject({
        processedTokens: 18,
        sessionCount: 3,
        usageCoverage: { covered: 2, total: 3, percent: (2 / 3) * 100 }
      })
    }

    const bySession = queryInsights(day20, 'session')
    expect(new Set(bySession.items.map((item) => item.key))).toEqual(new Set([
      'available-in-range', 'unavailable-in-range', 'cross-day-activity'
    ]))
    expect(bySession.items.find((item) => item.key === 'unavailable-in-range')).toMatchObject({
      processedTokens: 0,
      sessionCount: 1,
      usageCoverage: { covered: 0, total: 1, percent: 0 }
    })
    expect(bySession.items.some((item) => item.key === 'updated-only-in-range')).toBe(false)
    expect(bySession.items.some((item) => item.key === 'no-time')).toBe(false)
    expect(bySession.items.some((item) => item.key === 'placeholder')).toBe(false)

    const model = queryInsights(day20, 'model')
    expect(model.items.map((item) => item.key)).toEqual(['m1'])
    expect(model.items[0].sessionCount).toBe(2)
    expect(model.total.usageCoverage).toEqual({ covered: 2, total: 3, percent: (2 / 3) * 100 })

    expect(usageFactStoreStats()).toMatchObject({
      schemaVersion: 9,
      sessions: 6,
      activityDays: 5,
      timedSessions: 4,
      unknownActivitySessions: 2
    })
  })

  it('无可验证时间的 UsageFact 与空 placeholder 只进入 all-time typed truth', () => {
    const unknownUsageTime = makeSession('unknown-usage-time', '/repo/alpha', [
      usageEvent('unknown-time-event', undefined, components(10, 1), { model: 'm1' })
    ], { activityDays: [] })
    const placeholder = makeSession('empty-placeholder', '/repo/alpha', [], {
      unavailable: true, turns: 0, activityDays: []
    })
    synchronizeUsageFacts([unknownUsageTime, placeholder], [])

    expect(queryInsights(scope(), 'global').total).toMatchObject({
      processedTokens: 11,
      sessionCount: 1,
      detectedSessionCount: 2,
      parsedSessionCount: 1,
      usageCoverage: { covered: 1, total: 1, percent: 100 }
    })
    const boundedScope = scope({ range: { from: '2026-07-20', to: '2026-07-20' } })
    expect(queryInsights(boundedScope, 'global').total).toMatchObject({
      processedTokens: 0,
      sessionCount: 0,
      usageCoverage: { covered: 0, total: 0, percent: null }
    })
    expect(queryInsights(boundedScope, 'session').items).toEqual([])
    expect(usageFactStoreStats()).toMatchObject({
      timedSessions: 0,
      unknownActivitySessions: 2
    })
  })

  it('bounded coverage 的分子与 billing/conversation 事件 scope 一致', () => {
    const session = makeSession('subagent-only', '/repo/alpha', [
      usageEvent('subagent', localTimestamp(2026, 7, 20, 12), components(100, 20), {
        scope: 'subagent', model: 'm1'
      })
    ])
    synchronizeUsageFacts([session], [])
    const bounded = { from: '2026-07-20', to: '2026-07-20' }

    expect(queryInsights(scope({ range: bounded }), 'global').total).toMatchObject({
      processedTokens: 120,
      sessionCount: 1,
      usageCoverage: { covered: 1, total: 1, percent: 100 }
    })
    expect(queryInsights(scope({ range: bounded, metricBasis: 'conversation' }), 'global').total).toMatchObject({
      processedTokens: 0,
      sessionCount: 1,
      usageCoverage: { covered: 0, total: 1, percent: 0 }
    })
  })

  it('fork 与 copied prefix 共用 billingFactKey 时全局只计一次但保留两份审计事实', () => {
    const copiedAt = localTimestamp(2026, 7, 20, 12)
    const parent = makeSession('dedup-parent', '/repo/alpha', [
      usageEvent('parent-copy', copiedAt, components(100, 20), {
        model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:shared'
      })
    ], { source: 'codex' })
    const fork = makeSession('dedup-fork', '/repo/alpha', [
      usageEvent('fork-copy', copiedAt, components(100, 20), {
        model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:shared'
      })
    ], { source: 'codex' })
    fork.branchParentId = 'dedup-parent'

    synchronizeUsageFacts([parent, fork], [])

    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(120)
    const copies = [
      ...sessionUsageEvents('dedup-parent', scope()).events,
      ...sessionUsageEvents('dedup-fork', scope()).events
    ]
    expect(copies).toHaveLength(2)
    expect(new Set(copies.map((fact) => fact.billingFactId)).size).toBe(1)
    expect(copies.filter((fact) => fact.billingIncluded)).toHaveLength(1)

    // Removing the former winner must promote the surviving copy and rebuild
    // its session rollup without rewriting unrelated billing identities.
    synchronizeUsageFacts([fork], [])
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(120)
    expect(sessionUsageEvents('dedup-fork', scope()).events).toMatchObject([
      { billingIncluded: true }
    ])
  })

  it('热启动省略事件时保留已提交事实，但投影变化或重建必须要求完整物化', () => {
    const occurredAt = localTimestamp(2026, 7, 20, 12)
    const full = makeSession('compact-facts', '/repo/alpha', [
      usageEvent('kept', occurredAt, components(100, 20), { model: 'gpt-5.6-terra' })
    ])
    expect(synchronizeUsageFacts([full], [])).toMatchObject({ changedSessions: 1, factCount: 1 })

    const compact = structuredClone(full)
    compact.tokenAccounting!.usageEvents = []
    compact.tokenAccounting!.usageEventsOmitted = true
    expect(synchronizeUsageFacts([compact], [folder('folder-a', [compact.sessionId])]))
      .toMatchObject({ changedSessions: 0, unchangedSessions: 1, factCount: 1 })
    expect(sessionUsageEvents(compact.sessionId, scope()).events).toMatchObject([
      { dedupKey: 'kept', nonCachedInputTokens: 100, outputTokens: 20 }
    ])

    compact.turnCount++
    expect(() => synchronizeUsageFacts([compact], []))
      .toThrowError(expect.objectContaining({ code: 'USAGE_EVENTS_HYDRATION_REQUIRED' }))
    expect(sessionUsageEvents(compact.sessionId, scope()).events).toHaveLength(1)

    compact.turnCount--
    expect(() => synchronizeUsageFacts([compact], [], { rebuild: true }))
      .toThrowError(expect.objectContaining({ code: 'USAGE_EVENTS_HYDRATION_REQUIRED' }))
    expect(sessionUsageEvents(compact.sessionId, scope()).events).toHaveLength(1)
  })

  it.each([
    ['opencode', 'opencode-message-usage-v2'],
    ['zcode', 'zcode-model-usage-v1']
  ] as const)('%s 轻量账本保持逐调用 derivation identity', (source, format) => {
    const event = usageEvent(
      `${source}:call`,
      localTimestamp(2026, 7, 20, 12),
      components(40, 8),
      { model: 'provider-model' }
    )
    event.provider = source
    event.providerFormatVersion = format
    const full = makeSession(`${source}-compact`, `/repo/${source}`, [event], { source })
    synchronizeUsageFacts([full], [])

    const compact = structuredClone(full)
    compact.tokenAccounting!.usageEvents = []
    compact.tokenAccounting!.usageEventsOmitted = true
    expect(synchronizeUsageFacts([compact], [])).toMatchObject({
      changedSessions: 0,
      unchangedSessions: 1,
      factCount: 1
    })
  })

  // F1k ②b: the compact shape keeps billingTotal but drops the events, so an
  // aggregate-fallback session used to derive version 8 compact and 6 hydrated
  // and forced a full hydration on every compact sync.
  it.each(['opencode', 'zcode'] as const)('%s 聚合回退会话在紧凑与补全两种形态下派生版本一致（F1k ②b）', (source) => {
    const full = makeSession(`${source}-aggregate-compact`, `/repo/${source}`, [], {
      source, turns: 1, parse: 'parsed'
    })
    full.tokenUsage = { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }
    full.tokenAccounting = accountingFromMutuallyExclusiveUsage(source, full.tokenUsage, 'reported',
      `${source} legacy aggregate fallback; request-level model/provider evidence unavailable`)
    full.providerOutcome = { detected: 'detected', parse: 'parsed', usage: 'available' }
    expect(synchronizeUsageFacts([full], [])).toMatchObject({ changedSessions: 1, factCount: 1 })

    const compact = structuredClone(full)
    compact.tokenAccounting!.usageEvents = []
    compact.tokenAccounting!.usageEventsOmitted = true
    expect(synchronizeUsageFacts([compact], [])).toMatchObject({
      changedSessions: 0,
      unchangedSessions: 1,
      factCount: 1
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(120)
  })

  it('t184: active + replay copied prefix + archived 进真实账本后等于手工核算 215', () => {
    const occurredAt = localTimestamp(2026, 8, 2, 12)
    const shared = { model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:t184-shared' }
    const parent = makeSession('t184-parent', '/repo/custom-codex-home', [
      usageEvent('parent-shared', occurredAt, components(100, 20), shared)
    ], { source: 'codex' })
    parent.lifecycleState = 'active'
    const replay = makeSession('t184-replay', '/repo/custom-codex-home', [
      usageEvent('replay-shared', occurredAt, components(100, 20), shared),
      usageEvent('replay-only', occurredAt, components(50, 10), {
        model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:t184-replay'
      })
    ], { source: 'codex' })
    replay.lifecycleState = 'replayed'
    replay.branchParentId = parent.id
    const archived = makeSession('t184-archived', '/repo/default-codex-home', [
      usageEvent('archived-only', occurredAt, components(30, 5), {
        model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:t184-archived'
      })
    ], { source: 'codex' })
    archived.lifecycleState = 'archived'

    synchronizeUsageFacts([parent, replay, archived], [])

    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(215)
    const parentFacts = sessionUsageEvents(parent.id, scope()).events
    const replayFacts = sessionUsageEvents(replay.id, scope()).events
    const sharedBillingFactId = parentFacts[0].billingFactId
    const sharedCopies = [...parentFacts, ...replayFacts]
      .filter((fact) => fact.billingFactId === sharedBillingFactId)
    expect(sharedCopies).toHaveLength(2)
    expect(sharedCopies.filter((fact) => fact.billingIncluded)).toHaveLength(1)
    expect(sessionUsageEvents(archived.id, scope()).events).toMatchObject([
      { billingIncluded: true, nonCachedInputTokens: 30, outputTokens: 5 }
    ])
  })

  it('thread-spawn 合并链保留 copied-prefix 审计副本但账单只计一次', () => {
    const copiedAt = localTimestamp(2026, 7, 20, 12)
    const parentEvent = usageEvent('shared-copy', copiedAt, components(100, 20), {
      scope: 'main', model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:shared'
    })
    const childCopy = usageEvent('shared-copy', copiedAt, components(100, 20), {
      scope: 'subagent', model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:shared'
    })
    const childOnly = usageEvent('child-only', copiedAt, components(50, 5), {
      scope: 'subagent', model: 'gpt-5.6-terra', billingFactKey: 'codex:turn:child'
    })
    const parentAccounting = makeSession('parent-accounting', '/repo/alpha', [parentEvent], { source: 'codex' })
      .tokenAccounting!
    const childAccounting = makeSession('child-accounting', '/repo/alpha', [childCopy, childOnly], { source: 'codex' })
      .tokenAccounting!
    const merged = mergeTokenAccountings([parentAccounting, childAccounting], {
      auditSourceIds: ['parent-session', 'child-session']
    })
    const session = makeSession('merged-parent', '/repo/alpha', merged.usageEvents, { source: 'codex' })
    session.tokenAccounting = merged

    synchronizeUsageFacts([session], [])

    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(175)
    const facts = sessionUsageEvents('merged-parent', scope()).events
    expect(facts).toHaveLength(3)
    const copiedBillingFactId = [...new Set(facts.map((fact) => fact.billingFactId))]
      .find((billingFactId) => facts.filter((fact) => fact.billingFactId === billingFactId).length === 2)
    const copiedFacts = facts.filter((fact) => fact.billingFactId === copiedBillingFactId)
    expect(copiedFacts).toHaveLength(2)
    expect(copiedFacts.filter((fact) => fact.billingIncluded)).toHaveLength(1)
  })

  it('价格目录更新保留旧新估值版本与逐分桶计算证据', () => {
    const event = usageEvent(
      'luna-after-cutover',
      '2026-07-31T12:00:00.000Z',
      components(100_000, 100_000),
      { model: 'gpt-5.6-luna' }
    )
    event.billingProvider = 'openai'
    event.providerRaw = 'openai'
    const session = makeSession('repriced-luna', '/repo/pricing', [event], { source: 'codex' })

    synchronizeUsageFacts([session], [])

    const fact = sessionUsageEvents('repriced-luna', scope()).events[0]
    expect(fact.priceRevision).toBe('official-snapshot-2026-08-01.v2')
    expect(fact.revisionNotice?.notice['zh-CN']).toBe('因官方价格目录更新而修订')
    expect(fact.valuationHistory.map((entry) => entry.priceRevision)).toEqual([
      'official-snapshot-2026-07-22.v1',
      'official-snapshot-2026-08-01.v2'
    ])
    expect(fact.valuationHistory[0].costLedgers.swobEstimateUsd).toBeCloseTo(0.7)
    expect(fact.valuationHistory[1].costLedgers.swobEstimateUsd).toBeCloseTo(0.14)
    expect(fact.pricingTrace[0]).toMatchObject({
      modelCanonical: 'gpt-5.6-luna',
      catalogVersion: 'official-snapshot-2026-08-01.v2'
    })
    expect(fact.pricingTrace[0].calculation).toHaveLength(2)
  })

  it('activity evidence 单独变化会增量重建 bounded 分母', () => {
    const day20 = makeSession('activity-only', '/repo/alpha', [], {
      unavailable: true, activityDays: ['2026-07-20'], parse: 'parsed'
    })
    expect(synchronizeUsageFacts([day20], [])).toMatchObject({ changedSessions: 1 })
    expect(queryInsights(scope({ range: { from: '2026-07-20', to: '2026-07-20' } }), 'global').total)
      .toMatchObject({ sessionCount: 1, usageCoverage: { covered: 0, total: 1, percent: 0 } })

    const day21 = makeSession('activity-only', '/repo/alpha', [], {
      unavailable: true, activityDays: ['2026-07-21'], parse: 'parsed'
    })
    expect(synchronizeUsageFacts([day21], [])).toMatchObject({ changedSessions: 1 })
    expect(queryInsights(scope({ range: { from: '2026-07-20', to: '2026-07-20' } }), 'global').total)
      .toMatchObject({ sessionCount: 0, usageCoverage: { covered: 0, total: 0, percent: null } })
    expect(queryInsights(scope({ range: { from: '2026-07-21', to: '2026-07-21' } }), 'global').total)
      .toMatchObject({ sessionCount: 1, usageCoverage: { covered: 0, total: 1, percent: 0 } })
  })

  it('detection-only 保留 detected 事实，但不进入 coverage/bySession 分母', () => {
    const parsed = makeSession('parsed', '/repo/alpha', [
      usageEvent('known', localTimestamp(2026, 7, 20, 8), components(10, 2))
    ])
    const detectionOnly = makeSession('detected-only', '/repo/alpha', [], {
      source: 'hermes',
      unavailable: true,
      turns: 0
    })
    const noData = makeSession('no-data', '/repo/alpha', [], {
      source: 'hermes', unavailable: true, parse: 'no-data'
    })
    const parseError = makeSession('parse-error', '/repo/alpha', [], {
      source: 'hermes', unavailable: true, parse: 'error'
    })
    synchronizeUsageFacts([parsed, detectionOnly, noData, parseError], [])

    expect(queryInsights(scope(), 'global').total).toMatchObject({
      sessionCount: 1,
      detectedSessionCount: 4,
      parsedSessionCount: 1,
      usageAvailableSessionCount: 1,
      usageUnavailableSessionCount: 0,
      usageCoverage: { covered: 1, total: 1, percent: 100 }
    })
    expect(queryInsights(scope(), 'source').items.find((item) => item.key === 'hermes')).toMatchObject({
      processedTokens: 0,
      sessionCount: 0,
      detectedSessionCount: 3,
      parsedSessionCount: 0,
      usageAvailableSessionCount: 0,
      usageUnavailableSessionCount: 0,
      usageCoverage: { covered: 0, total: 0, percent: null }
    })
    expect(queryInsights(scope(), 'session').items.map((item) => item.key)).toEqual(['parsed'])
    expect(usageFactStoreStats()).toMatchObject({ sessions: 4, facts: 1 })

    const persisted = new Database(usageFactStoreStats().databasePath, { readonly: true })
    try {
      expect(persisted.prepare(`
        SELECT session_id, detection_status, parse_status, usage_status
        FROM usage_sessions
        ORDER BY session_id
      `).all()).toEqual([
        {
          session_id: 'detected-only', detection_status: 'detected',
          parse_status: 'placeholder', usage_status: 'unavailable'
        },
        {
          session_id: 'no-data', detection_status: 'detected',
          parse_status: 'no-data', usage_status: 'unavailable'
        },
        {
          session_id: 'parse-error', detection_status: 'detected',
          parse_status: 'error', usage_status: 'unavailable'
        },
        {
          session_id: 'parsed', detection_status: 'detected',
          parse_status: 'parsed', usage_status: 'available'
        }
      ])
    } finally {
      persisted.close()
    }
  })

  it('1700 session 任意 warm scope 查询 P95 < 200ms', () => {
    const sessions = Array.from({ length: 1700 }, (_, index) => makeSession(
      `scale-${index}`,
      `/repo/project-${index % 40}`,
      [usageEvent(
        `event-${index}`,
        localTimestamp(2026, 7, 1 + (index % 20), index % 24),
        components(10 + index, 3, index % 5, index % 3),
        { model: `model-${index % 8}` }
      )],
      { source: index % 2 === 0 ? 'claude-code' : 'codex' }
    ))
    synchronizeUsageFacts(sessions, [])
    const analysisScope = scope({
      range: { from: '2026-07-05', to: '2026-07-18' },
      sources: ['claude-code'],
      models: ['model-0', 'model-2', 'model-4', 'model-6']
    })
    queryInsights(analysisScope, 'project')
    const samples = Array.from({ length: 100 }, () => {
      const started = performance.now()
      queryInsights(analysisScope, 'project')
      return performance.now() - started
    }).sort((left, right) => left - right)
    const p95 = samples[Math.floor(samples.length * 0.95)]
    console.info(`usage fact acceptance: 1700 sessions warm query p95 ${p95.toFixed(2)}ms`)
    expect(p95).toBeLessThan(200)
  }, 30_000)
})

// ========================================================
// F1f: a session missing from one sync's input is not a deleted session
// ========================================================
describe('usage sync removes a missing session only on evidence (F1f)', () => {
  const REMOVAL_ENV = ['SWOB_USAGE_REMOVAL_MAX_RATIO', 'SWOB_USAGE_REMOVAL_MAX_COUNT', 'SWOB_USAGE_REMOVAL_MIN_COUNT']
  const savedRemovalEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const name of REMOVAL_ENV) {
      savedRemovalEnv.set(name, process.env[name])
      delete process.env[name]
    }
  })

  afterEach(() => {
    for (const name of REMOVAL_ENV) {
      const value = savedRemovalEnv.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    vi.restoreAllMocks()
  })

  function session(id: string, source: SessionSource = 'claude-code', project = `/repo/${source}`): SessionSummary {
    return makeSession(id, project, [
      usageEvent(`${id}-call`, localTimestamp(2026, 7, 20, 9), components(10, 2), { model: 'm1' })
    ], { source })
  }

  function physicalLoad(overrides: Partial<SessionLoadEvidence> = {}): SessionLoadEvidence {
    return { loadId: 'load-A', summaryCache: 'warm', sqliteSources: {}, ...overrides }
  }

  function absence(overrides: Partial<UsageFactAbsenceEvidence> = {}): UsageFactAbsenceEvidence {
    return { physicalLoad: physicalLoad(), providerSettlement: 'complete', excludedSources: [], ...overrides }
  }

  /** Read the ledger through a second, read-only connection: the store (and its pending holds) stays open. */
  function ledger(): {
    sessions: string[]
    facts: Record<string, number>
    history: Record<string, number>
    historyTotal: number
    activity: Record<string, number>
    folders: Record<string, number>
  } {
    const audit = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true, fileMustExist: true })
    try {
      const bySession = (sql: string): Record<string, number> => Object.fromEntries(
        (audit.prepare(sql).all() as Array<{ session_id: string; count: number }>)
          .map((row) => [row.session_id, row.count])
      )
      return {
        sessions: (audit.prepare('SELECT session_id FROM usage_sessions ORDER BY session_id').all() as
          Array<{ session_id: string }>).map((row) => row.session_id),
        facts: bySession('SELECT session_id, count(*) AS count FROM usage_facts GROUP BY session_id'),
        history: bySession('SELECT session_id, count(*) AS count FROM usage_valuation_history GROUP BY session_id'),
        historyTotal: (audit.prepare('SELECT count(*) AS count FROM usage_valuation_history').get() as
          { count: number }).count,
        activity: bySession('SELECT session_id, count(*) AS count FROM usage_session_activity GROUP BY session_id'),
        folders: bySession('SELECT session_id, count(*) AS count FROM usage_session_folders GROUP BY session_id')
      }
    } finally {
      audit.close()
    }
  }

  it('6 a whole-source disappearance is held until a second, independent load agrees; history never shrinks', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const opencode = Array.from({ length: 10 }, (_, index) => session(`ses_gate${index}`, 'opencode'))
    const keeper = session('keeper')
    synchronizeUsageFacts([...opencode, keeper], [])
    const before = ledger()
    expect(before.sessions).toHaveLength(11)
    expect(before.historyTotal).toBeGreaterThanOrEqual(11)

    // OpenCode discovery succeeded and lists none of them: every one is a
    // deletion candidate, and the whole source vanished from the input.
    const gone = (loadId: string) => absence({
      physicalLoad: physicalLoad({ loadId, sqliteSources: { opencode: { discovery: 'ok', presentSessionIds: [] } } })
    })
    expect(synchronizeUsageFacts([keeper], [], { absence: gone('load-A') })).toEqual({
      changedSessions: 0,
      unchangedSessions: 1,
      removedSessions: 0,
      factCount: 11,
      rebuilt: false,
      retainedSessions: 0,
      heldRemovals: 10,
      absences: [{ source: 'opencode', reason: 'source-vanished', sessions: 10 }]
    })
    expect(ledger()).toEqual(before)

    // Live updates re-sync on the same physical load: that is not a second round.
    expect(synchronizeUsageFacts([keeper], [], { absence: gone('load-A') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 10 })
    expect(ledger()).toEqual(before)

    // A different physical load agrees: now the rows go, the history stays.
    expect(synchronizeUsageFacts([keeper], [], { absence: gone('load-B') }))
      .toMatchObject({ removedSessions: 10, heldRemovals: 0, retainedSessions: 0, absences: [], factCount: 1 })
    const after = ledger()
    expect(after.sessions).toEqual(['keeper'])
    expect(after.history).toEqual(before.history)
    expect(after.historyTotal).toBe(before.historyTotal)

    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines).toEqual([
      '[usage-facts] opencode: holding 10 removal(s) until an independent load confirms them (source-vanished)',
      '[usage-facts] opencode: removed 10 held session(s) that an independent load confirmed gone'
    ])
    for (const line of lines) expect(line).not.toMatch(/ses_gate|\/repo/)
  })

  it('7 an excluded source leaves at once, ungated, and keeps its valuation history', () => {
    const kept = session('kept')
    const excluded = [session('codex-1', 'codex'), session('codex-2', 'codex')]
    synchronizeUsageFacts([kept, ...excluded], [])
    const before = ledger()

    // Without the exclusion, codex vanishing whole would be held by the gate.
    expect(synchronizeUsageFacts([kept], [], { absence: absence({ excludedSources: ['codex'] }) }))
      .toMatchObject({ removedSessions: 2, heldRemovals: 0, retainedSessions: 0, absences: [] })
    const after = ledger()
    expect(after.sessions).toEqual(['kept'])
    expect(after.facts['codex-1']).toBeUndefined()
    expect(after.history).toEqual(before.history)
  })

  it('8 a session still in the input but filtered out (branch, excluded from rollups) leaves as before', () => {
    const branch = session('branch-main')
    const excludedFromRollups = session('rollup-excluded')
    synchronizeUsageFacts([branch, excludedFromRollups], [])
    const before = ledger()

    const asBranch: SessionSummary = { ...branch, branchLeafUuid: 'leaf-1' }
    const asExcluded: SessionSummary = {
      ...excludedFromRollups,
      tokenAccounting: { ...excludedFromRollups.tokenAccounting!, excludedFromRollups: true }
    }
    // The input names them explicitly, so neither the cold cache nor the
    // vanished source holds them back.
    expect(synchronizeUsageFacts([asBranch, asExcluded], [], {
      absence: absence({ physicalLoad: physicalLoad({ summaryCache: 'cold' }) })
    })).toMatchObject({ removedSessions: 2, heldRemovals: 0, retainedSessions: 0 })
    expect(ledger().sessions).toEqual([])
    expect(ledger().history).toEqual(before.history)
  })

  it('9 a legacy caller (no evidence) still removes every missing session at once, but keeps its valuation history', () => {
    const a = session('legacy-a')
    const b = session('legacy-b', 'codex')
    synchronizeUsageFacts([a, b], [])
    const before = ledger()
    expect(before.history['legacy-b']).toBeGreaterThan(0)

    expect(synchronizeUsageFacts([a], [])).toEqual({
      changedSessions: 0,
      unchangedSessions: 1,
      removedSessions: 1,
      factCount: 1,
      rebuilt: false
    })
    const after = ledger()
    expect(after.sessions).toEqual(['legacy-a'])
    expect(after.facts['legacy-b']).toBeUndefined()
    expect(after.history).toEqual(before.history)

    // A legacy rebuild with nothing in the input empties the ledger, not the history.
    expect(synchronizeUsageFacts([], [], { rebuild: true })).toMatchObject({ removedSessions: 1, rebuilt: true })
    expect(ledger().sessions).toEqual([])
    expect(ledger().history).toEqual(before.history)
  })

  it('keeps every missing row until this process has a physical load, excluded and filtered ones included', () => {
    const rows = [session('first-a'), session('first-b', 'opencode'), session('first-c', 'pi')]
    synchronizeUsageFacts(rows, [])
    const before = ledger()
    expect(synchronizeUsageFacts([{ ...rows[0], branchLeafUuid: 'leaf' }], [], {
      absence: { physicalLoad: null, providerSettlement: null, excludedSources: ['opencode'] }
    })).toMatchObject({
      removedSessions: 0,
      retainedSessions: 3,
      heldRemovals: 0,
      absences: [
        { source: 'claude-code', reason: 'awaiting-first-load', sessions: 1 },
        { source: 'opencode', reason: 'awaiting-first-load', sessions: 1 },
        { source: 'pi', reason: 'awaiting-first-load', sessions: 1 }
      ]
    })
    expect(ledger()).toEqual(before)
  })

  it('applies the per-source-family rules to missing rows', () => {
    const rows = [
      session('claude-live'), session('claude-cold'),
      session('ses_ocListed', 'opencode'), session('ses_ocUnlisted', 'opencode'), session('ses_ocLive', 'opencode'),
      session('ses_zcA', 'zcode'), session('ses_zcB', 'zcode'),
      session('pi-a', 'pi'), session('pi-b', 'pi'),
      session('gemini-a', 'gemini')
    ]
    const byId = new Map(rows.map((row) => [row.sessionId, row]))
    const input = (...ids: string[]) => ids.map((id) => byId.get(id)!)
    synchronizeUsageFacts(rows, [])
    const before = ledger()

    // Cold summary cache: every legacy source keeps its missing rows; the
    // provider-host family keeps them until this process settles 'complete'.
    expect(synchronizeUsageFacts(input('claude-live', 'ses_ocLive'), [], {
      absence: absence({ physicalLoad: physicalLoad({ summaryCache: 'cold' }), providerSettlement: null })
    })).toMatchObject({
      removedSessions: 0,
      retainedSessions: 8,
      heldRemovals: 0,
      absences: [
        { source: 'claude-code', reason: 'cold-summary-cache', sessions: 1 },
        { source: 'gemini', reason: 'provider-unsettled', sessions: 1 },
        { source: 'opencode', reason: 'cold-summary-cache', sessions: 2 },
        { source: 'pi', reason: 'provider-unsettled', sessions: 2 },
        { source: 'zcode', reason: 'cold-summary-cache', sessions: 2 }
      ]
    })
    expect(ledger()).toEqual(before)

    // Warm: an unreadable DB keeps its rows; a readable one keeps what it still
    // lists; a degraded provider settlement keeps the whole family.
    expect(synchronizeUsageFacts(input('claude-live', 'claude-cold', 'ses_ocLive', 'pi-a'), [], {
      absence: absence({
        physicalLoad: physicalLoad({
          sqliteSources: {
            opencode: { discovery: 'ok', presentSessionIds: ['ses_ocLive', 'ses_ocListed'] },
            zcode: { discovery: 'unavailable', presentSessionIds: [] }
          }
        }),
        providerSettlement: 'degraded'
      })
    })).toMatchObject({
      removedSessions: 1,
      retainedSessions: 5,
      heldRemovals: 0,
      absences: [
        { source: 'gemini', reason: 'provider-degraded', sessions: 1 },
        { source: 'opencode', reason: 'listed-by-source', sessions: 1 },
        { source: 'pi', reason: 'provider-degraded', sessions: 1 },
        { source: 'zcode', reason: 'discovery-unavailable', sessions: 2 }
      ]
    })
    // The one row the DB no longer lists went; everything else is intact.
    const afterWarm = ledger()
    expect(afterWarm.sessions).not.toContain('ses_ocUnlisted')
    expect(afterWarm.sessions).toHaveLength(9)
    expect(afterWarm.history).toEqual(before.history)

    // An absent DB (no file) and a complete provider settlement make candidates;
    // sources that vanished from the input whole are held by the gate.
    expect(synchronizeUsageFacts(input('claude-live', 'claude-cold', 'ses_ocLive', 'ses_ocListed', 'pi-a'), [], {
      absence: absence({
        physicalLoad: physicalLoad({
          sqliteSources: {
            opencode: { discovery: 'ok', presentSessionIds: ['ses_ocLive', 'ses_ocListed'] },
            zcode: { discovery: 'absent', presentSessionIds: [] }
          }
        })
      })
    })).toMatchObject({
      removedSessions: 1,
      retainedSessions: 0,
      heldRemovals: 3,
      absences: [
        { source: 'gemini', reason: 'source-vanished', sessions: 1 },
        { source: 'zcode', reason: 'source-vanished', sessions: 2 }
      ]
    })
    const afterAbsent = ledger()
    expect(afterAbsent.sessions).not.toContain('pi-b')
    expect(afterAbsent.sessions).toEqual(expect.arrayContaining(['gemini-a', 'ses_zcA', 'ses_zcB']))
    expect(afterAbsent.history).toEqual(before.history)
  })

  it('holds a large share or count of one source, and lets a small one go at once', () => {
    const claude = Array.from({ length: 10 }, (_, index) => session(`claude-${index}`))
    const codex = [session('codex-a', 'codex'), session('codex-b', 'codex')]
    synchronizeUsageFacts([...claude, ...codex], [])

    // 6 of 10 (60% and at least 5) is held; 1 of 2 is under the minimum and goes.
    expect(synchronizeUsageFacts([...claude.slice(0, 4), codex[0]], [], { absence: absence() })).toMatchObject({
      removedSessions: 1,
      heldRemovals: 6,
      absences: [{ source: 'claude-code', reason: 'over-max-ratio', sessions: 6 }]
    })
    expect(ledger().sessions).toHaveLength(11)

    // Over the absolute count, even when the ratio is small.
    process.env.SWOB_USAGE_REMOVAL_MAX_COUNT = '2'
    process.env.SWOB_USAGE_REMOVAL_MAX_RATIO = '1'
    expect(synchronizeUsageFacts([...claude.slice(0, 7), codex[0]], [], { absence: absence() })).toMatchObject({
      removedSessions: 0,
      heldRemovals: 3,
      absences: [{ source: 'claude-code', reason: 'over-max-count', sessions: 3 }]
    })
    // All three have been held since load-A, so load-B confirms them.
    expect(synchronizeUsageFacts([...claude.slice(0, 7), codex[0]], [], {
      absence: absence({ physicalLoad: physicalLoad({ loadId: 'load-B' }) })
    })).toMatchObject({ removedSessions: 3, heldRemovals: 0 })
    expect(ledger().sessions).toHaveLength(8)
  })

  it('reads the gate thresholds from the environment, clamped', () => {
    expect(usageRemovalGateThresholds()).toEqual({ maxRatio: 0.2, maxCount: 100, minCount: 5 })
    process.env.SWOB_USAGE_REMOVAL_MAX_RATIO = 'not-a-number'
    process.env.SWOB_USAGE_REMOVAL_MAX_COUNT = ' '
    process.env.SWOB_USAGE_REMOVAL_MIN_COUNT = 'Infinity'
    expect(usageRemovalGateThresholds()).toEqual({ maxRatio: 0.2, maxCount: 100, minCount: 5 })
    process.env.SWOB_USAGE_REMOVAL_MAX_RATIO = '7'
    process.env.SWOB_USAGE_REMOVAL_MAX_COUNT = '-5'
    process.env.SWOB_USAGE_REMOVAL_MIN_COUNT = '0'
    expect(usageRemovalGateThresholds()).toEqual({ maxRatio: 1, maxCount: 0, minCount: 1 })
    process.env.SWOB_USAGE_REMOVAL_MAX_RATIO = '-1'
    process.env.SWOB_USAGE_REMOVAL_MAX_COUNT = '2.7'
    process.env.SWOB_USAGE_REMOVAL_MIN_COUNT = '3.9'
    expect(usageRemovalGateThresholds()).toEqual({ maxRatio: 0, maxCount: 2, minCount: 3 })
  })

  it('a kept round between two loads keeps the hold; a returning session clears it', () => {
    const rows = Array.from({ length: 6 }, (_, index) => session(`round-${index}`))
    const lastLive = rows.slice(0, 1)
    synchronizeUsageFacts(rows, [])
    const warm = (loadId: string) => absence({ physicalLoad: physicalLoad({ loadId }) })

    expect(synchronizeUsageFacts(lastLive, [], { absence: warm('load-A') })).toMatchObject({ heldRemovals: 5 })
    // A cold load has no say; the hold from load-A stands.
    expect(synchronizeUsageFacts(lastLive, [], {
      absence: absence({ physicalLoad: physicalLoad({ loadId: 'load-B', summaryCache: 'cold' }) })
    })).toMatchObject({ removedSessions: 0, retainedSessions: 5, heldRemovals: 0 })
    expect(synchronizeUsageFacts(lastLive, [], { absence: warm('load-C') }))
      .toMatchObject({ removedSessions: 5, heldRemovals: 0 })
    expect(ledger().sessions).toEqual(['round-0'])

    // A held session that comes back forgets its hold.
    const again = Array.from({ length: 6 }, (_, index) => session(`again-${index}`))
    synchronizeUsageFacts([...lastLive, ...again], [], { absence: warm('load-D') })
    expect(synchronizeUsageFacts(lastLive, [], { absence: warm('load-E') })).toMatchObject({ heldRemovals: 6 })
    synchronizeUsageFacts([...lastLive, ...again], [], { absence: warm('load-F') })
    expect(synchronizeUsageFacts(lastLive, [], { absence: warm('load-G') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 6 })
    expect(synchronizeUsageFacts(lastLive, [], { absence: warm('load-H') }))
      .toMatchObject({ removedSessions: 6, heldRemovals: 0 })
  })

  it('a rolled-back sync records no hold', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows = Array.from({ length: 5 }, (_, index) => session(`rollback-${index}`, 'codex'))
    const keeper = session('rollback-keeper')
    synchronizeUsageFacts([...rows, keeper], [])
    const warm = (loadId: string) => absence({ physicalLoad: physicalLoad({ loadId }) })

    // Cancel at the last check of the transaction, after the removal plan.
    // Checks: transaction start, one per input session, and the final one.
    let checks = 0
    expect(() => synchronizeUsageFacts([keeper], [], {
      absence: warm('load-A'),
      shouldCancel: () => ++checks >= 3
    })).toThrowError(/cancelled/)
    expect(checks).toBe(3)

    // Had load-A's hold survived the rollback, load-B would confirm it.
    expect(synchronizeUsageFacts([keeper], [], { absence: warm('load-B') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 5 })
    expect(synchronizeUsageFacts([keeper], [], { absence: warm('load-C') }))
      .toMatchObject({ removedSessions: 5, heldRemovals: 0 })
  })

  it('closing the store forgets every hold', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows = Array.from({ length: 5 }, (_, index) => session(`restart-${index}`, 'codex'))
    const keeper = session('restart-keeper')
    synchronizeUsageFacts([...rows, keeper], [])
    const warm = (loadId: string) => absence({ physicalLoad: physicalLoad({ loadId }) })
    expect(synchronizeUsageFacts([keeper], [], { absence: warm('load-A') })).toMatchObject({ heldRemovals: 5 })
    closeUsageFactStore()
    expect(synchronizeUsageFacts([keeper], [], { absence: warm('load-B') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 5 })
  })

  it('a rebuild keeps the activity days and folders of a row it keeps', () => {
    const live = session('rebuild-live')
    const missing = makeSession('rebuild-missing', '/repo/missing', [
      usageEvent('rebuild-missing-call', localTimestamp(2026, 7, 21, 9), components(30, 6), { model: 'm1' })
    ])
    synchronizeUsageFacts([live, missing], [folder('kept-folder', ['rebuild-missing'])])
    const before = ledger()
    expect(before.activity['rebuild-missing']).toBe(1)
    expect(before.folders['rebuild-missing']).toBe(1)

    expect(synchronizeUsageFacts([live], [folder('kept-folder', ['rebuild-missing'])], {
      rebuild: true,
      absence: absence({ physicalLoad: physicalLoad({ summaryCache: 'cold' }) })
    })).toMatchObject({ changedSessions: 1, removedSessions: 0, retainedSessions: 1, rebuilt: true })
    const after = ledger()
    expect(after.activity).toEqual(before.activity)
    expect(after.folders).toEqual(before.folders)
    expect(after.facts).toEqual(before.facts)
    // Rollups are rebuilt from every current fact, the kept row's included.
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(12 + 36)
  })
})

// ========================================================
// F1k: one session's degraded input neither rolls back the whole sync nor
// silently replaces what the session committed
// ========================================================
describe('usage sync keeps what a session committed when its input degrades (F1k)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const SQLITE_AGENT_FORMAT = {
    opencode: 'opencode-message-usage-v2',
    zcode: 'zcode-model-usage-v1'
  } as const

  /** A per-call OpenCode/ZCode session: one authoritative row per [key, input, output]. */
  function perCall(
    id: string,
    source: 'opencode' | 'zcode',
    calls: Array<[key: string, input: number, output: number]>
  ): SessionSummary {
    const events = calls.map(([key, input, output], index) => {
      const event = usageEvent(`${source}:call:${key}`, localTimestamp(2026, 7, 20, 9 + index), components(input, output), {
        model: 'glm-4.5',
        billingFactKey: `${source}:call:${key}`
      })
      event.provider = source
      event.providerFormatVersion = SQLITE_AGENT_FORMAT[source]
      return event
    })
    return makeSession(id, `/repo/${source}`, events, { source })
  }

  /** The loader's legacy aggregate fallback for the same session (100 in, 20 out). */
  function aggregate(id: string, source: 'opencode' | 'zcode'): SessionSummary {
    const session = makeSession(id, `/repo/${source}`, [], { source, turns: 1, parse: 'parsed' })
    session.tokenUsage = { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }
    session.tokenAccounting = accountingFromMutuallyExclusiveUsage(source, session.tokenUsage, 'reported',
      `${source} legacy aggregate fallback; request-level model/provider evidence unavailable`)
    session.providerOutcome = { detected: 'detected', parse: 'parsed', usage: 'available' }
    return session
  }

  /** Parsed, but no usage this time: no events, usage unavailable. */
  function noUsage(id: string, source: SessionSource): SessionSummary {
    return makeSession(id, `/repo/${source}`, [], { source, unavailable: true, parse: 'parsed' })
  }

  /** One session's ledger state, through a second, read-only connection. */
  function sessionLedger(sessionId: string): {
    current: number
    superseded: number
    tokens: number
    supersededBy: Array<string | null>
    history: number
    activity: number
    folders: number
    parse: string | undefined
    usage: string | undefined
    factSignature: string | undefined
    projectionSignature: string | null | undefined
  } {
    const audit = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true, fileMustExist: true })
    try {
      const facts = audit.prepare(`
        SELECT superseded, superseded_by,
          non_cached_input + cache_read + cache_write + output_tokens AS tokens
        FROM usage_facts WHERE session_id = ? ORDER BY superseded, event_id
      `).all(sessionId) as Array<{ superseded: number; superseded_by: string | null; tokens: number }>
      const count = (table: string): number => (audit.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE session_id = ?`
      ).get(sessionId) as { count: number }).count
      const row = audit.prepare(`
        SELECT parse_status, usage_status, fact_signature, projection_signature
        FROM usage_sessions WHERE session_id = ?
      `).get(sessionId) as {
        parse_status: string
        usage_status: string
        fact_signature: string
        projection_signature: string | null
      } | undefined
      const current = facts.filter((fact) => fact.superseded === 0)
      return {
        current: current.length,
        superseded: facts.length - current.length,
        tokens: current.reduce((sum, fact) => sum + fact.tokens, 0),
        supersededBy: facts.filter((fact) => fact.superseded === 1).map((fact) => fact.superseded_by),
        history: count('usage_valuation_history'),
        activity: count('usage_session_activity'),
        folders: count('usage_session_folders'),
        parse: row?.parse_status,
        usage: row?.usage_status,
        factSignature: row?.fact_signature,
        projectionSignature: row?.projection_signature
      }
    } finally {
      audit.close()
    }
  }

  it('a per-call session whose input falls back to an aggregate keeps its per-call facts; steady and returning rounds are no-ops', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const perCallInput = perCall('ses_zcPerCall', 'zcode', [['a', 20, 4], ['b', 20, 4]])
    expect(synchronizeUsageFacts([perCallInput], [])).toMatchObject({ changedSessions: 1, factCount: 2 })
    const before = sessionLedger('ses_zcPerCall')
    expect(before).toMatchObject({ current: 2, tokens: 48, activity: 1, parse: 'parsed', usage: 'available' })

    // Never an aggregate before (no superseded row): the old ledger replaced
    // the per-call rows with the aggregate without a word.
    const fallback = aggregate('ses_zcPerCall', 'zcode')
    expect(synchronizeUsageFacts([fallback], [])).toEqual({
      changedSessions: 0,
      unchangedSessions: 1,
      removedSessions: 0,
      factCount: 2,
      rebuilt: false,
      downgradesSkipped: { zcode: 1 }
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(48)
    const kept = sessionLedger('ses_zcPerCall')
    expect(kept).toMatchObject({
      current: 2,
      superseded: 0,
      tokens: 48,
      activity: 1,
      parse: 'parsed',
      usage: 'available',
      factSignature: before.factSignature
    })
    // It takes this sync's projection signature, so a compact sync of the
    // same fallback does not ask for a hydration every time.
    expect(kept.projectionSignature).not.toBe(before.projectionSignature)
    const compact = structuredClone(fallback)
    compact.tokenAccounting!.usageEvents = []
    compact.tokenAccounting!.usageEventsOmitted = true
    expect(synchronizeUsageFacts([compact], [])).toEqual({
      changedSessions: 0,
      unchangedSessions: 1,
      removedSessions: 0,
      factCount: 2,
      rebuilt: false
    })

    // The next hydrated round judges it again; the log line is not repeated.
    expect(synchronizeUsageFacts([fallback], [])).toMatchObject({ downgradesSkipped: { zcode: 1 } })
    expect(sessionLedger('ses_zcPerCall').tokens).toBe(48)

    // The per-call rows come back: nothing to redo.
    expect(synchronizeUsageFacts([perCallInput], [])).toEqual({
      changedSessions: 0,
      unchangedSessions: 1,
      removedSessions: 0,
      factCount: 2,
      rebuilt: false
    })
    expect(sessionLedger('ses_zcPerCall')).toMatchObject({ current: 2, tokens: 48, history: before.history })

    const lines = warn.mock.calls.map(([line]) => String(line))
    expect(lines).toEqual([
      '[usage-facts] zcode: kept the committed usage of 1 session(s) whose input fell back to an aggregate or to no usage'
    ])
    for (const line of lines) expect(line).not.toMatch(/ses_|\/repo/)
  })

  it('a session whose input has no usage this time keeps its committed facts, for every source', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const zcode = perCall('ses_zcNoUsage', 'zcode', [['a', 20, 4], ['b', 20, 4]])
    const claude = makeSession('claude-no-usage', '/repo/claude', [
      usageEvent('claude-no-usage-call', localTimestamp(2026, 7, 20, 9), components(30, 6), { model: 'm1' })
    ])
    const fresh = noUsage('claude-never-had-usage', 'claude-code')
    synchronizeUsageFacts([zcode, claude, fresh], [])
    const before = { zcode: sessionLedger('ses_zcNoUsage'), claude: sessionLedger('claude-no-usage') }

    // A session that never had facts has nothing to keep: it is written as usual.
    const freshAgain = { ...fresh, turnCount: fresh.turnCount + 1 }
    expect(synchronizeUsageFacts([
      noUsage('ses_zcNoUsage', 'zcode'),
      noUsage('claude-no-usage', 'claude-code'),
      freshAgain
    ], [])).toEqual({
      changedSessions: 1,
      unchangedSessions: 2,
      removedSessions: 0,
      factCount: 3,
      rebuilt: false,
      downgradesSkipped: { 'claude-code': 1, zcode: 1 }
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(48 + 36)
    // Facts, activity, statuses and fact signature stay as committed; only the
    // projection signature follows this sync's input.
    for (const [id, prior] of [['ses_zcNoUsage', before.zcode], ['claude-no-usage', before.claude]] as const) {
      const { projectionSignature: _projection, ...committed } = prior
      expect(sessionLedger(id)).toMatchObject(committed)
    }
    expect(before.zcode).toMatchObject({ current: 2, tokens: 48, activity: 1, parse: 'parsed', usage: 'available' })
    expect(before.claude).toMatchObject({ current: 1, tokens: 36, activity: 1, parse: 'parsed', usage: 'available' })
  })

  it('a session with facts that comes back as a manifest-only placeholder or a parse error keeps them (all sources)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const claude = makeSession('claude-manifest', '/repo/claude', [
      usageEvent('claude-manifest-call', localTimestamp(2026, 7, 20, 9), components(30, 6), { model: 'm1' })
    ])
    const codex = makeSession('codex-parse-error', '/repo/codex', [
      usageEvent('codex-parse-error-call', localTimestamp(2026, 7, 20, 10), components(30, 6), { model: 'm1' })
    ], { source: 'codex' })
    synchronizeUsageFacts([claude, codex], [folder('kept-folder', ['claude-manifest'])])
    const before = { claude: sessionLedger('claude-manifest'), codex: sessionLedger('codex-parse-error') }

    // Library hydration fell back to the manifest (backup missing or
    // unreadable): no messages, no accounting, no persisted outcome, which
    // reads as parse 'placeholder'. The Codex read failed this time.
    const manifestOnly: SessionSummary = {
      ...claude,
      isManifestOnly: true,
      messageCount: 0,
      activityDays: [],
      tokenAccounting: undefined,
      providerOutcome: undefined,
      tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
    }
    const parseError: SessionSummary = {
      ...codex,
      providerOutcome: { detected: 'detected', parse: 'error', usage: 'unavailable' }
    }
    expect(synchronizeUsageFacts([manifestOnly, parseError], [
      folder('kept-folder', ['claude-manifest', 'codex-parse-error'])
    ])).toEqual({
      changedSessions: 0,
      unchangedSessions: 2,
      removedSessions: 0,
      factCount: 2,
      rebuilt: false,
      downgradesSkipped: { 'claude-code': 1, codex: 1 }
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(72)
    expect(sessionLedger('claude-manifest')).toMatchObject({
      current: 1, tokens: 36, activity: before.claude.activity, parse: 'parsed', usage: 'available', folders: 1
    })
    // Folders are still kept up to date for a kept session.
    expect(sessionLedger('codex-parse-error')).toMatchObject({
      current: 1, tokens: 36, activity: before.codex.activity, parse: 'parsed', usage: 'available', folders: 1
    })
  })

  it('a session left with only its superseded aggregate takes this sync\'s aggregate once, and never flips back', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const id = 'ses_zcOnlySuperseded'
    const other = makeSession('claude-alongside', '/repo/claude', [
      usageEvent('claude-alongside-call', localTimestamp(2026, 7, 20, 9), components(30, 6), { model: 'm1' })
    ])
    synchronizeUsageFacts([aggregate(id, 'zcode'), other], [])
    synchronizeUsageFacts([perCall(id, 'zcode', [['a', 40, 8]]), other], [])
    expect(sessionLedger(id)).toMatchObject({
      current: 1, superseded: 1, tokens: 48, supersededBy: ['t183-per-call-usage-v1']
    })

    // The shape the real ledger was left in: a no-usage round cleared the
    // per-call rows and only the superseded aggregate stayed. A sync can no
    // longer produce it, so write it through a second connection.
    const writer = new Database(process.env.SWOB_USAGE_INDEX_PATH!)
    writer.prepare('DELETE FROM usage_facts WHERE session_id = ? AND superseded = 0').run(id)
    writer.prepare('DELETE FROM usage_rollups WHERE session_id = ?').run(id)
    writer.prepare("UPDATE usage_sessions SET fact_signature = 'before-f1k' WHERE session_id = ?").run(id)
    writer.close()
    const onlySuperseded = sessionLedger(id)
    expect(onlySuperseded).toMatchObject({ current: 0, superseded: 1, tokens: 0 })

    // Nothing stronger to protect: the aggregate's tokens are better than none.
    // The old ledger hit the superseded row's primary key and rolled back
    // every session of the sync, the Claude Code one included.
    const changedOther = makeSession('claude-alongside', '/repo/claude', [
      usageEvent('claude-alongside-call', localTimestamp(2026, 7, 20, 9), components(30, 6), { model: 'm1' }),
      usageEvent('claude-alongside-next', localTimestamp(2026, 7, 20, 11), components(10, 2), { model: 'm1' })
    ])
    expect(synchronizeUsageFacts([aggregate(id, 'zcode'), changedOther], [])).toEqual({
      changedSessions: 2,
      unchangedSessions: 0,
      removedSessions: 0,
      factCount: 3,
      rebuilt: false,
      aggregateAccepted: { zcode: 1 }
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(120 + 48)
    const accepted = sessionLedger(id)
    expect(accepted).toMatchObject({ current: 1, superseded: 0, tokens: 120, supersededBy: [] })
    expect(accepted.history).toBeGreaterThanOrEqual(onlySuperseded.history)

    // Per-call rows return: the accepted aggregate is superseded again.
    expect(synchronizeUsageFacts([perCall(id, 'zcode', [['a', 40, 8]]), changedOther], []))
      .not.toHaveProperty('aggregateAccepted')
    expect(sessionLedger(id)).toMatchObject({
      current: 1, superseded: 1, tokens: 48, supersededBy: ['t183-per-call-usage-v1']
    })
    // From here an aggregate or a no-usage input is kept out, and nothing is accepted again.
    expect(synchronizeUsageFacts([aggregate(id, 'zcode'), changedOther], []))
      .toMatchObject({ downgradesSkipped: { zcode: 1 } })
    expect(synchronizeUsageFacts([noUsage(id, 'zcode'), changedOther], []))
      .toMatchObject({ downgradesSkipped: { zcode: 1 } })
    const settled = sessionLedger(id)
    expect(settled).toMatchObject({ current: 1, superseded: 1, tokens: 48 })
    expect(settled.history).toBeGreaterThanOrEqual(accepted.history)
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(48 + 48)
  })

  it('a kept session stays input to the F1f removal rules: never absent or counted there, and its source never vanishes', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const kept = perCall('ses_zcKept', 'zcode', [['a', 20, 4], ['b', 20, 4]])
    const gone = perCall('ses_zcGone', 'zcode', [['c', 10, 2]])
    const claude = makeSession('claude-kept', '/repo/claude', [
      usageEvent('claude-kept-call', localTimestamp(2026, 7, 20, 9), components(30, 6), { model: 'm1' })
    ])
    synchronizeUsageFacts([kept, gone, claude], [])
    const history = { kept: sessionLedger('ses_zcKept').history, gone: sessionLedger('ses_zcGone').history }

    // Warm load: ZCode discovery succeeded and still lists the kept session
    // only; the other one was deleted in ZCode.
    const evidence: UsageFactAbsenceEvidence = {
      physicalLoad: {
        loadId: 'load-A',
        summaryCache: 'warm',
        sqliteSources: { zcode: { discovery: 'ok', presentSessionIds: ['ses_zcKept'] } }
      },
      providerSettlement: 'complete',
      excludedSources: []
    }
    // The kept session is still ZCode input, so the one deleted session is an
    // ordinary candidate (under the gate's minimum), not a vanished source.
    expect(synchronizeUsageFacts([aggregate('ses_zcKept', 'zcode'), noUsage('claude-kept', 'claude-code')], [], {
      absence: evidence
    })).toEqual({
      changedSessions: 0,
      unchangedSessions: 2,
      removedSessions: 1,
      factCount: 3,
      rebuilt: false,
      retainedSessions: 0,
      heldRemovals: 0,
      absences: [],
      downgradesSkipped: { 'claude-code': 1, zcode: 1 }
    })
    expect(sessionLedger('ses_zcKept')).toMatchObject({ current: 2, tokens: 48, history: history.kept })
    expect(sessionLedger('claude-kept')).toMatchObject({ current: 1, tokens: 36 })
    expect(sessionLedger('ses_zcGone')).toMatchObject({ current: 0, parse: undefined, history: history.gone })
  })

  it('a legacy rebuild gives a kept session back the activity days of the facts it keeps', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const zcode = perCall('ses_zcRebuild', 'zcode', [['a', 20, 4], ['b', 20, 4]])
    const claude = makeSession('claude-rebuild', '/repo/claude', [
      usageEvent('claude-rebuild-call', localTimestamp(2026, 7, 21, 9), components(30, 6), { model: 'm1' })
    ])
    const folders = [folder('rebuild-folder', ['ses_zcRebuild'])]
    synchronizeUsageFacts([zcode, claude], folders)
    const bounded = scope({ range: { from: '2026-07-20', to: '2026-07-20' } })
    expect(queryInsights(bounded, 'global').total).toMatchObject({
      processedTokens: 48,
      sessionCount: 1,
      usageCoverage: { covered: 1, total: 1, percent: 100 }
    })

    // No absence evidence: the rebuild clears every activity day and folder
    // first; a kept session must not drop out of the bounded denominator.
    expect(synchronizeUsageFacts([aggregate('ses_zcRebuild', 'zcode'), claude], folders, { rebuild: true }))
      .toEqual({
        changedSessions: 1,
        unchangedSessions: 1,
        removedSessions: 0,
        factCount: 3,
        rebuilt: true,
        downgradesSkipped: { zcode: 1 }
      })
    expect(sessionLedger('ses_zcRebuild')).toMatchObject({ current: 2, tokens: 48, activity: 1, folders: 1 })
    expect(queryInsights(bounded, 'global').total).toMatchObject({
      processedTokens: 48,
      sessionCount: 1,
      usageCoverage: { covered: 1, total: 1, percent: 100 }
    })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(48 + 36)
  })
})
