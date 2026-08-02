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
  incrementalUsageFactCanonicalizationSql,
  queryInsights,
  queryInsightsBundle,
  sessionUsageEvents,
  synchronizeUsageFacts,
  usageFactStoreStats
} from './usage-fact-store'

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
    expect(usageFactStoreStats()).toMatchObject({ schemaVersion: 7, sessions: 1, facts: 1 })
  })

  it('v6 账本原地升级为 v7，不重建现有表', () => {
    const session = makeSession('migration-sentinel', '/repo/migration', [
      usageEvent('sentinel-call', localTimestamp(2026, 7, 20, 8), components(7, 3))
    ])
    synchronizeUsageFacts([session], [])
    expect(usageFactStoreStats().schemaVersion).toBe(7)
    closeUsageFactStore()

    const dbPath = process.env.SWOB_USAGE_INDEX_PATH!
    const legacy = new Database(dbPath)
    legacy.exec(`
      DROP INDEX IF EXISTS usage_facts_billing_current_idx;
      DROP INDEX IF EXISTS usage_facts_superseded_idx;
      ALTER TABLE usage_facts DROP COLUMN superseded_by;
      ALTER TABLE usage_facts DROP COLUMN superseded_at;
      ALTER TABLE usage_facts DROP COLUMN superseded;
      UPDATE usage_schema_meta SET schema_version = 6 WHERE singleton = 1;
    `)
    legacy.close()

    expect(usageFactStoreStats().schemaVersion).toBe(7)
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
    expect(columns).toEqual(expect.arrayContaining(['superseded', 'superseded_at', 'superseded_by']))
    expect(indexes).toContain('usage_facts_billing_current_idx')
    expect(sessionUsageEvents('migration-sentinel', scope()).events).toEqual([
      expect.objectContaining({ nonCachedInputTokens: 7, outputTokens: 3 })
    ])
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

    // A stale pre-t183 summary cache can attempt to downgrade the same
    // sessions back to their legacy aggregate. The ledger must fail closed:
    // never revive/replace the superseded aggregate and never discard the
    // stronger per-call facts. CACHE_VERSION 27 prevents this input in the
    // loader; this assertion preserves the storage boundary independently.
    let downgradeError: unknown = null
    try {
      synchronizeUsageFacts(legacySessions, [])
    } catch (error) {
      downgradeError = error
    }
    expect(downgradeError).toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
    expect(queryInsights(scope(), 'global').total.processedTokens).toBe(96)

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
      schemaVersion: 7,
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
