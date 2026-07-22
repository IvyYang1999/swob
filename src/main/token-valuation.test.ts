import { describe, expect, it } from 'vitest'
import { buildInsights } from './insights'
import { extractCodexTokenAccounting, type CodexLine } from './codex-loader'
import {
  accountClaudeUsage,
  accountCodexUsage,
  tokenUsageFromAccounting,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'
import {
  aggregateValuations,
  valuationForAccounting,
  valueUsageEvent,
  valueUsageEvents
} from './token-valuation'
import type { RawJsonlMessage, SessionSummary } from './types'

function claudeUsageRow(input: {
  id: string
  model: string
  provider?: string
  timestamp?: string
  usage?: NonNullable<NonNullable<RawJsonlMessage['message']>['usage']>
  reportedCostUsd?: number
  sidechain?: boolean
  forked?: boolean
}): RawJsonlMessage {
  return {
    uuid: input.id,
    parentUuid: null,
    sessionId: 'fixture-session',
    type: 'assistant',
    timestamp: input.timestamp || '2026-07-22T00:00:00Z',
    isSidechain: input.sidechain,
    forkedFrom: input.forked ? { sessionId: 'parent', messageUuid: 'old' } : undefined,
    message: {
      id: input.id,
      role: 'assistant',
      model: input.model,
      provider: input.provider,
      costUSD: input.reportedCostUsd,
      stop_reason: 'end_turn',
      content: 'fixture',
      usage: input.usage || { input_tokens: 1_000_000, output_tokens: 1_000_000 }
    }
  }
}

function accounting(...rows: RawJsonlMessage[]): TokenAccounting {
  return accountClaudeUsage(rows)
}

function session(sessionId: string, tokenAccounting: TokenAccounting): SessionSummary {
  return {
    id: sessionId,
    sessionId,
    slug: '',
    createdAt: '2026-07-22T00:00:00Z',
    updatedAt: '2026-07-22T00:00:00Z',
    messageCount: 1,
    turnCount: 1,
    compactCount: 0,
    cwds: [`/fixture/${sessionId}`],
    version: '',
    firstUserMessage: 'fixture',
    toolUsage: {},
    skillInvocations: [],
    projectPath: `/fixture/${sessionId}`,
    filePath: `/fixture/${sessionId}.jsonl`,
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: tokenUsageFromAccounting(tokenAccounting),
    tokenAccounting,
    referencedFiles: [],
    configFiles: [],
    source: tokenAccounting.provider
  }
}

describe('t113 §11 valuation invariants', () => {
  it('1. global = sum(session) = sum(unique priced events)，coverage 同源对账', () => {
    const claude = accounting(claudeUsageRow({
      id: 'claude-priced', model: 'claude-sonnet-4-5', provider: 'anthropic'
    }))
    const gpt = accounting(claudeUsageRow({
      id: 'gpt-priced', model: 'gpt-5.4', provider: 'openai',
      usage: { input_tokens: 100_000, output_tokens: 100_000 }
    }))
    const result = buildInsights([session('claude', claude), session('gpt', gpt)], [])

    expect(result.valuation.usd).toBeCloseTo(19.75)
    expect(result.reconciliation.valuation).toEqual(expect.objectContaining({
      globalUsd: 19.75,
      sessionsUsd: 19.75,
      uniqueEventsUsd: 19.75,
      difference: 0,
      coverageDifference: 0,
      ok: true
    }))
  })

  it('2. mixed-model Session 等于逐请求模型金额之和', () => {
    const mixed = accounting(
      claudeUsageRow({ id: 'mixed-claude', model: 'claude-sonnet-4-5', provider: 'anthropic' }),
      claudeUsageRow({
        id: 'mixed-gpt', model: 'gpt-5.4', provider: 'openai',
        usage: { input_tokens: 100_000, output_tokens: 100_000 }
      })
    )
    const perEvent = mixed.usageEvents.map((event) => valueUsageEvent(event))

    expect(perEvent.map((value) => value.usd)).toEqual([18, 1.75])
    expect(valuationForAccounting(mixed).usd).toBeCloseTo(19.75)
  })

  it('3. Claude input/cache 5m/cache 1h/cache read 互斥且按独立桶计价', () => {
    const ledger = accounting(claudeUsageRow({
      id: 'claude-cache',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      usage: {
        input_tokens: 1_000_000,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 2_100_000,
        cache_creation: {
          ephemeral_5m_input_tokens: 1_000_000,
          ephemeral_1h_input_tokens: 1_000_000
        }
      }
    }))
    const event = ledger.usageEvents[0]

    expect(event.components).toMatchObject({
      nonCachedInputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      outputTokens: 1_000_000
    })
    expect(valueUsageEvent(event).usd).toBeCloseTo(28.05)
    expect(event.warnings.join(' ')).toContain('differs')
  })

  it('4. OpenAI nonCached + cached + cacheWrite = raw input', () => {
    const ledger = accountCodexUsage([{
      kind: 'incremental',
      timestamp: '2026-07-22T00:00:00Z',
      model: 'gpt-5.4',
      providerRaw: 'openai',
      inputTokens: 1_000,
      cachedInputTokens: 600,
      cacheWriteTokens: 100,
      outputTokens: 100,
      dedupHint: 'codex-input-subset'
    }])
    const event = ledger.usageEvents[0]
    expect(
      event.components.nonCachedInputTokens + event.components.cacheReadTokens + event.components.cacheWriteTokens
    ).toBe(event.rawInputTokens)
  })

  it('5. reasoning 是 output 子集且不重复计价', () => {
    const ledger = accountCodexUsage([{
      kind: 'incremental',
      timestamp: '2026-07-22T00:00:00Z',
      model: 'gpt-5.4',
      providerRaw: 'openai',
      inputTokens: 1_000_000,
      cachedInputTokens: 600_000,
      outputTokens: 100_000,
      reasoningTokens: 40_000,
      dedupHint: 'codex-reasoning'
    }])
    const event = ledger.usageEvents[0]

    expect(event.components.reasoningTokens).toBeLessThanOrEqual(event.components.outputTokens)
    expect(valueUsageEvent(event).usd).toBeCloseTo(4.55)
  })

  it('6. unknown/synthetic 不是 $0 或默认 Sonnet，而是 unpriced', () => {
    const unknown = accounting(claudeUsageRow({ id: 'unknown', model: 'future-model-9' })).usageEvents[0]
    const synthetic = accounting(claudeUsageRow({ id: 'synthetic', model: '<synthetic>' })).usageEvents[0]

    for (const event of [unknown, synthetic]) {
      const valuation = valueUsageEvent(event)
      expect(valuation.mode).toBe('unpriced')
      expect(valuation.usd).toBeUndefined()
      expect(valuation.coveragePercent).toBe(0)
      expect(valuation.totalBillableTokens).toBeGreaterThan(0)
    }
  })

  it('7. coverage 仅覆盖 reported 或可靠规则，未知事件仍进入分母', () => {
    const priced = accounting(claudeUsageRow({
      id: 'covered',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      usage: { input_tokens: 50, output_tokens: 50 }
    })).usageEvents[0]
    const unknown = accounting(claudeUsageRow({
      id: 'not-covered',
      model: 'future-model-9',
      usage: { input_tokens: 50, output_tokens: 50 }
    })).usageEvents[0]
    const valuation = valueUsageEvents([priced, unknown])

    expect(valuation.coveredTokens).toBe(100)
    expect(valuation.totalBillableTokens).toBe(200)
    expect(valuation.coveragePercent).toBe(50)
  })

  it('8. long-context 按请求整档判断，不按 Session 聚合判断', () => {
    const short = accountCodexUsage([{
      kind: 'incremental', timestamp: '2026-07-22T00:00:00Z', model: 'gpt-5.4', providerRaw: 'openai',
      inputTokens: 200_000, outputTokens: 10_000, dedupHint: 'short'
    }]).usageEvents[0]
    const long = accountCodexUsage([{
      kind: 'incremental', timestamp: '2026-07-22T00:01:00Z', model: 'gpt-5.4', providerRaw: 'openai',
      inputTokens: 300_000, outputTokens: 10_000, dedupHint: 'long'
    }]).usageEvents[0]
    const shortValue = valueUsageEvent(short)
    const longValue = valueUsageEvent(long)

    expect(shortValue.usd).toBeCloseTo(0.65)
    expect(shortValue.pricingRules[0].longContext).toBe(false)
    expect(longValue.usd).toBeCloseTo(1.725)
    expect(longValue.pricingRules[0].longContext).toBe(true)
    expect(valueUsageEvents([short, long]).usd).toBeCloseTo(2.375)
  })

  it('9. 历史金额追溯到 rule version、effective date 和 event timestamp', () => {
    const event = accounting(claudeUsageRow({
      id: 'trace', model: 'claude-sonnet-4-5-20250929', provider: 'anthropic',
      timestamp: '2026-01-02T03:04:05Z'
    })).usageEvents[0]
    const valuation = valueUsageEvent(event)

    expect(valuation.pricingMatch).toBe('alias')
    expect(valuation.pricingRules[0]).toMatchObject({
      pricingRuleId: 'anthropic:claude-sonnet-4-5:2025-09-29T00:00:00Z',
      eventTimestamp: '2026-01-02T03:04:05Z',
      effectiveFrom: '2025-09-29T00:00:00Z',
      catalogVersion: 'official-snapshot-2026-07-22.v1'
    })
  })

  it('10. 真相层只保存 USD；本任务不引入不可追溯的第二套 CNY 价格', () => {
    const valuation = valueUsageEvent(accounting(claudeUsageRow({
      id: 'usd-only', model: 'claude-sonnet-4-5', provider: 'anthropic'
    })).usageEvents[0])

    expect(valuation.usd).toBe(18)
    expect('cny' in valuation).toBe(false)
    expect('fxRate' in valuation).toBe(false)
  })
})

describe('t113 golden parser and priority fixtures', () => {
  it('Claude Code 中的 GPT/Gemini 正确归因，OpenRouter 保留路由商，synthetic 未知', () => {
    const ledger = accounting(
      claudeUsageRow({ id: 'gpt', model: 'gpt-5.4', provider: 'anthropic' }),
      claudeUsageRow({ id: 'gemini', model: 'gemini-3-pro', provider: 'anthropic' }),
      claudeUsageRow({ id: 'router', model: 'openrouter/anthropic/claude-sonnet-4-5' }),
      claudeUsageRow({ id: 'synthetic-provider', model: '<synthetic>' })
    )
    const [gpt, gemini, router, synthetic] = ledger.usageEvents

    expect(gpt).toMatchObject({ billingProvider: 'openai', providerProvenance: 'inferred' })
    expect(valueUsageEvent(gpt).mode).toBe('api-equivalent')
    expect(gemini).toMatchObject({ billingProvider: 'google', providerProvenance: 'inferred' })
    expect(router).toMatchObject({ billingProvider: 'openrouter', providerProvenance: 'model-prefix' })
    expect(valueUsageEvent(router).mode).toBe('unpriced')
    expect(synthetic.providerProvenance).toBe('unknown')
  })

  it('未建模的 Batch/服务档/区域修饰符不静默套标准价', () => {
    const base = accounting(claudeUsageRow({
      id: 'modifier', model: 'claude-sonnet-4-5', provider: 'anthropic'
    })).usageEvents[0]

    expect(valueUsageEvent({ ...base, isBatch: true })).toMatchObject({
      mode: 'unpriced', missingReasons: ['batch-price-not-modeled']
    })
    expect(valueUsageEvent({ ...base, serviceTier: 'priority' })).toMatchObject({
      mode: 'unpriced', missingReasons: ['service-tier-price-not-modeled']
    })
    expect(valueUsageEvent({ ...base, inferenceRegion: 'us' })).toMatchObject({
      mode: 'unpriced', missingReasons: ['regional-price-not-modeled']
    })
  })

  it('只有未知 TTL cache write 时不输出假 $0，保留未计价分母', () => {
    const event = accounting(claudeUsageRow({
      id: 'cache-ttl-unknown',
      model: 'claude-sonnet-4-5',
      provider: 'anthropic',
      usage: { cache_creation_input_tokens: 1_000 }
    })).usageEvents[0]
    const valuation = valueUsageEvent(event)

    expect(valuation).toMatchObject({
      mode: 'unpriced', coveredTokens: 0, totalBillableTokens: 1_000, coveragePercent: 0
    })
    expect(valuation.usd).toBeUndefined()
    expect(valuation.missingReasons).toContain('cache-write-ttl-unknown')
  })

  it('reported cost 优先于同一事件的目录重算', () => {
    const event = accounting(claudeUsageRow({
      id: 'reported', model: 'claude-sonnet-4-5', provider: 'anthropic', reportedCostUsd: 1.23
    })).usageEvents[0]
    const valuation = valueUsageEvent(event)

    expect(valuation).toMatchObject({ usd: 1.23, mode: 'reported', pricingMatch: 'reported' })
    expect(valuation.pricingRules).toEqual([])
  })

  it('Codex JSONL 贯通 turn_context 模型、session provider 与 cost.total', () => {
    const lines: CodexLine[] = [
      {
        timestamp: '2026-07-22T00:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'codex-cost', timestamp: '2026-07-22T00:00:00Z', cwd: '/fixture',
          cli_version: 'fixture', model_provider: 'openai'
        }
      },
      {
        timestamp: '2026-07-22T00:00:01Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-cost', model: 'gpt-5.4' }
      },
      {
        timestamp: '2026-07-22T00:00:02Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            turn_id: 'turn-cost',
            last_token_usage: { input_tokens: 100, output_tokens: 20 },
            cost: { total: 0.42 }
          }
        }
      }
    ]
    const event = extractCodexTokenAccounting(lines).usageEvents[0]

    expect(event).toMatchObject({
      modelRaw: 'gpt-5.4',
      modelCanonical: 'gpt-5.4',
      modelProvenance: 'turn-context',
      billingProvider: 'openai',
      providerProvenance: 'explicit',
      reportedCostUsd: 0.42
    })
    expect(valueUsageEvent(event)).toMatchObject({ usd: 0.42, mode: 'reported' })
  })

  it('实际高频 gpt-5.6-sol 覆盖 cached subset 与 1.25x cache write', () => {
    const event = accountCodexUsage([{
      kind: 'incremental',
      timestamp: '2026-07-22T08:00:00Z',
      model: 'gpt-5.6-sol',
      providerRaw: 'openai',
      inputTokens: 200_000,
      cachedInputTokens: 100_000,
      cacheWriteTokens: 50_000,
      outputTokens: 10_000,
      dedupHint: 'gpt-5.6-sol-cache'
    }]).usageEvents[0]
    const valuation = valueUsageEvent(event)

    expect(event.components).toMatchObject({
      nonCachedInputTokens: 50_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 50_000
    })
    expect(valuation).toMatchObject({ mode: 'estimated-list-price', coveragePercent: 100 })
    expect(valuation.usd).toBeCloseTo(0.9125)
  })

  it('Sonnet 5 促销与标准价格按事件时间命中不同规则', () => {
    const introductory = accounting(claudeUsageRow({
      id: 'sonnet-5-intro', model: 'claude-sonnet-5', provider: 'anthropic',
      timestamp: '2026-08-31T23:59:59Z'
    })).usageEvents[0]
    const standard = accounting(claudeUsageRow({
      id: 'sonnet-5-standard', model: 'claude-sonnet-5', provider: 'anthropic',
      timestamp: '2026-09-01T00:00:00Z'
    })).usageEvents[0]

    expect(valueUsageEvent(introductory)).toMatchObject({ usd: 12, mode: 'estimated-list-price' })
    expect(valueUsageEvent(standard)).toMatchObject({ usd: 18, mode: 'estimated-list-price' })
    expect(valueUsageEvent(introductory).pricingRules[0].pricingRuleId)
      .not.toBe(valueUsageEvent(standard).pricingRules[0].pricingRuleId)
  })

  it('累计 counter reset 保留增量且 streaming/fork/subagent 不重复', () => {
    const codex = accountCodexUsage([
      { kind: 'cumulative', timestamp: '2026-07-22T00:00:00Z', model: 'gpt-5.4', providerRaw: 'openai', inputTokens: 100, outputTokens: 10 },
      { kind: 'cumulative', timestamp: '2026-07-22T00:01:00Z', model: 'gpt-5.4', providerRaw: 'openai', inputTokens: 20, outputTokens: 2 }
    ])
    const claude = accounting(
      claudeUsageRow({ id: 'same-call', model: 'claude-sonnet-4-5', provider: 'anthropic' }),
      { ...claudeUsageRow({ id: 'same-call', model: 'claude-sonnet-4-5', provider: 'anthropic', sidechain: true }), uuid: 'copy' },
      claudeUsageRow({ id: 'fork-copy', model: 'claude-sonnet-4-5', provider: 'anthropic', forked: true }),
      claudeUsageRow({ id: 'subagent-call', model: 'claude-sonnet-4-5', provider: 'anthropic', sidechain: true })
    )

    expect(codex.billingTotal).toBe(132)
    expect(codex.warnings.join(' ')).toContain('reset')
    expect(claude.usageEvents).toHaveLength(2)
    expect(valuationForAccounting(claude).usd).toBe(36)
  })

  it('聚合 reported/list/API-equivalent 时保留 mode breakdown 与缺失原因', () => {
    const events: UsageEvent[] = accounting(
      claudeUsageRow({ id: 'list', model: 'claude-sonnet-4-5', provider: 'anthropic' }),
      claudeUsageRow({
        id: 'equivalent', model: 'gpt-5.4',
        usage: { input_tokens: 100_000, output_tokens: 100_000 }
      }),
      claudeUsageRow({ id: 'missing', model: 'future-model-9' })
    ).usageEvents
    const reported = valueUsageEvent({ ...events[0], dedupKey: 'reported-copy', reportedCostUsd: 2 })
    const valuation = aggregateValuations([
      reported,
      valueUsageEvent(events[1]),
      valueUsageEvent(events[2])
    ])

    expect(valuation.mode).toBe('api-equivalent')
    expect(valuation.modeBreakdown).toMatchObject({ reported: 2, 'api-equivalent': 1.75 })
    expect(valuation.missingReasons).toContain('model-not-in-catalog')
  })
})
