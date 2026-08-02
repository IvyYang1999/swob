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
  previewUsageEventCandidateRepricing,
  previewUsageEventRepricing,
  valuationForAccounting,
  valueUsageEvent,
  valueUsageEvents
} from './token-valuation'
import {
  ACTIVE_PRICE_SNAPSHOT,
  calculatePriceCandidateHash,
  calculatePriceSnapshotHash,
  type PriceCandidateSnapshot,
  type PriceSnapshot,
  type PricingRule
} from './pricing-catalog'
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

  it('7. price coverage 只认 Swob 可追溯规则，未知事件仍进入分母', () => {
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

  it('9. 历史金额追溯到 rule、snapshot hash、effective date 和 event timestamp', () => {
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
      catalogVersion: 'official-snapshot-2026-08-01.v2',
      priceSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      calculation: expect.arrayContaining([
        expect.objectContaining({ component: 'input', tokens: 1_000_000, usdPerMillion: 3 })
      ])
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

    for (const modified of [
      { ...base, isBatch: true },
      { ...base, serviceTier: 'priority' },
      { ...base, inferenceRegion: 'us' }
    ]) {
      const valuation = valueUsageEvent(modified)
      expect(valuation.mode).toBe('unpriced')
      expect(valuation.missingReasons[0]).toBe('unpriced-modifier')
      expect(valuation.missingReasons[1]).toMatch(/^unpriced-modifier:/)
    }
  })

  it('Fast/Priority/Batch/Flex/Region 都是可精确匹配的规则维度', () => {
    const base = accounting(claudeUsageRow({
      id: 'dimensions', model: 'claude-sonnet-4-5', provider: 'anthropic'
    })).usageEvents[0]
    const standard = {
      ...ACTIVE_PRICE_SNAPSHOT.rules.find((rule) => rule.modelCanonical === 'claude-sonnet-4-5')!,
      id: 'fixture:standard', catalogVersion: 'fixture', effectiveFrom: '2025-01-01T00:00:00Z'
    } satisfies PricingRule
    const rules: PricingRule[] = [
      standard,
      { ...standard, id: 'fixture:batch', dimensions: { batchMode: 'batch' }, usdPerMillion: { input: 1.5, output: 7.5 } },
      { ...standard, id: 'fixture:priority', dimensions: { serviceTier: 'priority' }, usdPerMillion: { input: 6, output: 30 } },
      { ...standard, id: 'fixture:flex', dimensions: { serviceTier: 'flex' }, usdPerMillion: { input: 1.5, output: 7.5 } },
      { ...standard, id: 'fixture:fast', dimensions: { speed: 'fast' }, usdPerMillion: { input: 18, output: 90 } },
      { ...standard, id: 'fixture:region', dimensions: { region: 'us' }, usdPerMillion: { input: 3.3, output: 16.5 } }
    ]

    expect(valueUsageEvent({ ...base, isBatch: true }, rules).usd).toBe(9)
    expect(valueUsageEvent({ ...base, serviceTier: 'priority' }, rules).usd).toBe(36)
    expect(valueUsageEvent({ ...base, serviceTier: 'flex' }, rules).usd).toBe(9)
    expect(valueUsageEvent({ ...base, speed: 'fast' }, rules).usd).toBe(108)
    expect(valueUsageEvent({ ...base, inferenceRegion: 'US' }, rules).usd).toBeCloseTo(19.8)
  })

  it('搜索/图片/音频/缓存存储/credits 独立计量，缺价不伪装成 0', () => {
    const base = accounting(claudeUsageRow({
      id: 'non-token', model: 'claude-sonnet-4-5', provider: 'anthropic',
      usage: { input_tokens: 0, output_tokens: 0 }
    })).usageEvents[0]
    const snapshot: PriceSnapshot = {
      revision: 'fixture-units', status: 'approved', generatedAt: '2026-08-02T00:00:00Z',
      reviewedAt: '2026-08-02T00:00:00Z', contentHash: '', sourcePipeline: [], rules: [],
      unitRules: [
        {
          id: 'anthropic:web-search', provider: 'anthropic', sku: 'web-search', unit: 'search',
          usdPerUnit: 0.01, effectiveFrom: '2025-01-01T00:00:00Z', source: 'official',
          sourceUrl: 'https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool',
          sourceRevision: 'review-fixture', reviewStatus: 'approved'
        },
        {
          id: 'anthropic:image', provider: 'anthropic', sku: 'image', unit: 'image',
          usdPerUnit: 0.04, effectiveFrom: '2025-01-01T00:00:00Z', source: 'official',
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          sourceRevision: 'review-fixture', reviewStatus: 'approved'
        },
        {
          id: 'anthropic:audio', provider: 'anthropic', sku: 'audio', unit: 'audio-minute',
          usdPerUnit: 0.02, effectiveFrom: '2025-01-01T00:00:00Z', source: 'official',
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          sourceRevision: 'review-fixture', reviewStatus: 'approved'
        },
        {
          id: 'anthropic:cache-storage', provider: 'anthropic', sku: 'cache-storage', unit: 'cache-storage-token-hour',
          usdPerUnit: 0.000001, effectiveFrom: '2025-01-01T00:00:00Z', source: 'official',
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          sourceRevision: 'review-fixture', reviewStatus: 'approved'
        },
        {
          id: 'anthropic:credit', provider: 'anthropic', sku: 'credit', unit: 'credit',
          usdPerUnit: 1, effectiveFrom: '2025-01-01T00:00:00Z', source: 'official',
          sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
          sourceRevision: 'review-fixture', reviewStatus: 'approved'
        }
      ]
    }
    snapshot.contentHash = calculatePriceSnapshotHash(snapshot)
    const valuation = valueUsageEvent({
      ...base,
      billingItems: [
        { sku: 'web-search', unit: 'search', quantity: 2 },
        { sku: 'image', unit: 'image', quantity: 1 },
        { sku: 'audio', unit: 'audio-minute', quantity: 3 },
        { sku: 'cache-storage', unit: 'cache-storage-token-hour', quantity: 10_000 },
        { sku: 'credit', unit: 'credit', quantity: 0.5 },
        { sku: 'future-tool', unit: 'request', quantity: 1 }
      ]
    }, snapshot)

    expect(valuation.usd).toBeCloseTo(0.63)
    expect(valuation.unitCoverage).toMatchObject({ coveredItems: 5, totalItems: 6 })
    expect(valuation.unitCoverage.coveragePercent).toBeCloseTo(100 * 5 / 6)
    expect(valuation.missingReasons).toContain('non-token-price-missing:request:future-tool')
    expect(valuation.pricingRules.flatMap((trace) => trace.unitCalculation || [])).toHaveLength(5)
  })

  it('待审核候选只能经显式 what-if 入口估值，不能进入运行时 registry', () => {
    const event = accounting(claudeUsageRow({
      id: 'candidate', model: 'claude-sonnet-4-5', provider: 'anthropic'
    })).usageEvents[0]
    const rule = {
      ...ACTIVE_PRICE_SNAPSHOT.rules.find((item) => item.modelCanonical === 'claude-sonnet-4-5')!,
      id: 'candidate:sonnet', catalogVersion: 'candidate-2026-08-02',
      sourceRevision: 'fixture-source', reviewStatus: 'pending-review' as const,
      officialReviewUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
      usdPerMillion: { input: 2, output: 10 }
    }
    const candidate: PriceCandidateSnapshot = {
      revision: 'candidate-2026-08-02', status: 'pending-review', generatedAt: '2026-08-02T00:00:00Z',
      contentHash: '', sourcePipeline: ACTIVE_PRICE_SNAPSHOT.sourcePipeline, rules: [rule], unitRules: [],
      review: { requiredApprover: 'yyt/负责人', activationAllowed: false }
    }
    candidate.contentHash = calculatePriceCandidateHash(candidate)

    expect(previewUsageEventCandidateRepricing(event, candidate)).toMatchObject({ usd: 12, whatIf: true })
    expect(() => valueUsageEvent(event, candidate as unknown as PriceSnapshot)).toThrow(/approved/)
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

  it('Claude Code reported cost 标为 harness 估值，并与 Swob 重算两账并存', () => {
    const event = accounting(claudeUsageRow({
      id: 'reported', model: 'claude-sonnet-4-5', provider: 'anthropic', reportedCostUsd: 1.23
    })).usageEvents[0]
    const valuation = valueUsageEvent(event)

    expect(event.reportedCostKind).toBe('harness-list-estimate')
    expect(valuation).toMatchObject({
      usd: 18,
      mode: 'swob-estimate',
      pricingMatch: 'exact',
      ledgerBreakdown: { harnessListEstimateUsd: 1.23, swobEstimateUsd: 18 },
      financialCoveragePercent: 0,
      coveragePercent: 100
    })
    expect(valuation.pricingRules).toHaveLength(1)
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
    expect(valueUsageEvent(event)).toMatchObject({
      mode: 'swob-estimate',
      ledgerBreakdown: { harnessListEstimateUsd: 0.42 }
    })
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
    expect(valuation).toMatchObject({ mode: 'swob-estimate', coveragePercent: 100 })
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

    expect(valueUsageEvent(introductory)).toMatchObject({ usd: 12, mode: 'swob-estimate' })
    expect(valueUsageEvent(standard)).toMatchObject({ usd: 18, mode: 'swob-estimate' })
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
    const reported = valueUsageEvent({
      ...events[0], dedupKey: 'reported-copy', reportedCostUsd: 2,
      reportedCostKind: 'provider-billed'
    })
    const valuation = aggregateValuations([
      reported,
      valueUsageEvent(events[1]),
      valueUsageEvent(events[2])
    ])

    expect(valuation.mode).toBe('mixed')
    expect(valuation.modeBreakdown).toMatchObject({
      'provider-billed': 2,
      'swob-estimate': 18,
      'api-equivalent': 1.75
    })
    expect(reported.financialCoveragePercent).toBe(100)
    expect(valueUsageEvent(events[0]).financialCoveragePercent).toBe(0)
    expect(valuation.missingReasons).toContain('model-not-in-catalog')
  })

  it('Terra/Luna 在 2026-07-30 调价边界按调用时间分段计价', () => {
    const before = accountCodexUsage([{
      kind: 'incremental', timestamp: '2026-07-29T23:59:59Z', model: 'gpt-5.6-luna', providerRaw: 'openai',
      inputTokens: 100_000, outputTokens: 100_000, dedupHint: 'luna-before'
    }]).usageEvents[0]
    const after = accountCodexUsage([{
      kind: 'incremental', timestamp: '2026-07-30T00:00:00Z', model: 'gpt-5.6-luna', providerRaw: 'openai',
      inputTokens: 100_000, outputTokens: 100_000, dedupHint: 'luna-after'
    }]).usageEvents[0]

    expect(valueUsageEvent(before).usd).toBeCloseTo(0.7)
    expect(valueUsageEvent(after)).toMatchObject({
      usd: 0.14,
      revision: {
        previousRevision: 'official-snapshot-2026-07-22.v1',
        reason: 'official-price-catalog-update'
      }
    })
    expect(valueUsageEvents([before, after]).usd).toBeCloseTo(0.84)
  })

  it('What-if repricing 必须显式指定 snapshot，不改写当前估值', () => {
    const event = accountCodexUsage([{
      kind: 'incremental', timestamp: '2026-07-30T00:00:00Z', model: 'gpt-5.6-terra', providerRaw: 'openai',
      inputTokens: 100_000, outputTokens: 100_000, dedupHint: 'terra-what-if'
    }]).usageEvents[0]
    const current = valueUsageEvent(event)
    const legacyPreview = previewUsageEventRepricing(event, 'official-snapshot-2026-07-22.v1')

    expect(current.usd).toBeCloseTo(1.4)
    expect(legacyPreview).toMatchObject({
      usd: 1.75,
      priceRevision: 'official-snapshot-2026-07-22.v1',
      whatIf: true
    })
    expect(valueUsageEvent(event)).toEqual(current)
  })
})
