import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Folder, SessionSource, SessionSummary } from './types'
import type { NormalizedTokenComponents, TokenAccounting, UsageEvent, UsageScope } from './token-accounting'
import type { AnalysisDimension, AnalysisScope } from './analysis-contract'
import { activityDaysFromTimestamps } from './activity-time'
import {
  closeUsageFactStore,
  drilldownInsights,
  queryInsights,
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
  } = {}
): UsageEvent {
  return {
    provider: 'claude-code',
    providerFormatVersion: 'test-v1',
    dedupKey,
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

  it('无 timestamp 事件进入 unknown-time，受限日期不冒充任何一天但质量计数保留', () => {
    const session = makeSession('unknown-time', '/repo/alpha', [
      usageEvent('known', localTimestamp(2026, 7, 20, 12), components(10, 1)),
      usageEvent('unknown', undefined, components(50, 5))
    ])
    synchronizeUsageFacts([session], [])

    const all = queryInsights(scope(), 'time')
    expect(all.items.map((item) => item.key)).toEqual(['2026-07-20', 'unknown-time'])
    expect(all.quality.unknownTimeEvents).toBe(1)
    expect(all.total.processedTokens).toBe(66)

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
    const events = sessionUsageEvents('drill', scope({ range: { from: '2026-07-21', to: '2026-07-21' } }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ model: 'm2', nonCachedInputTokens: 20, outputTokens: 5 })
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

    expect(sessionUsageEvents('grandchild', scope())[0].rootSessionId).toBe('root')
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
    expect(usageFactStoreStats()).toMatchObject({ schemaVersion: 3, sessions: 1, facts: 1 })
  })

  it('usage/model/pricing coverage 显式且 pricing 使用 t113 逐请求估值', () => {
    const available = makeSession('available', '/repo/alpha', [
      usageEvent('known-model', localTimestamp(2026, 7, 20, 8), components(10, 2), {
        model: 'm1', reportedCostUsd: 0.25
      }),
      usageEvent('unknown-model', localTimestamp(2026, 7, 20, 9), components(5, 1))
    ])
    const unavailable = makeSession('unavailable', '/repo/alpha', [], { unavailable: true })
    synchronizeUsageFacts([available, unavailable], [folder('mixed-folder', ['available', 'unavailable'])])

    const result = queryInsights(scope(), 'global')
    expect(result.total.usageCoverage).toEqual({ covered: 1, total: 2, percent: 50 })
    expect(result.total.modelCoverage).toEqual({ covered: 1, total: 2, percent: 50 })
    expect(result.total.pricingCoverage).toEqual({
      status: 'available', covered: 12, total: 18, percent: (12 / 18) * 100
    })
    expect(result.total.costUsd).toBe(0.25)
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
      activityDays: ['2026-07-20']
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
      sessionCount: 6,
      usageCoverage: { covered: 3, total: 6, percent: 50 }
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
      schemaVersion: 3,
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
      sessionCount: 2,
      usageCoverage: { covered: 1, total: 2, percent: 50 }
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

  it('activity evidence 单独变化会增量重建 bounded 分母', () => {
    const day20 = makeSession('activity-only', '/repo/alpha', [], {
      unavailable: true, activityDays: ['2026-07-20']
    })
    expect(synchronizeUsageFacts([day20], [])).toMatchObject({ changedSessions: 1 })
    expect(queryInsights(scope({ range: { from: '2026-07-20', to: '2026-07-20' } }), 'global').total)
      .toMatchObject({ sessionCount: 1, usageCoverage: { covered: 0, total: 1, percent: 0 } })

    const day21 = makeSession('activity-only', '/repo/alpha', [], {
      unavailable: true, activityDays: ['2026-07-21']
    })
    expect(synchronizeUsageFacts([day21], [])).toMatchObject({ changedSessions: 1 })
    expect(queryInsights(scope({ range: { from: '2026-07-20', to: '2026-07-20' } }), 'global').total)
      .toMatchObject({ sessionCount: 0, usageCoverage: { covered: 0, total: 0, percent: null } })
    expect(queryInsights(scope({ range: { from: '2026-07-21', to: '2026-07-21' } }), 'global').total)
      .toMatchObject({ sessionCount: 1, usageCoverage: { covered: 0, total: 1, percent: 0 } })
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
