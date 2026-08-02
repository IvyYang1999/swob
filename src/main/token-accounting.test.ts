import { describe, expect, it } from 'vitest'
import type { RawJsonlMessage, SessionSource } from './types'
import {
  accountClaudeUsage,
  accountCodexUsage,
  accountingFromLegacyUsage,
  HARNESS_USAGE_CONTRACTS,
  mergeTokenAccountings,
  normalizeGeminiOutput,
  processedTotal
} from './token-accounting'

function claudeRow(overrides: Partial<RawJsonlMessage>): RawJsonlMessage {
  return {
    uuid: overrides.uuid || crypto.randomUUID(),
    parentUuid: null,
    sessionId: 'session-1',
    type: 'assistant',
    timestamp: '2026-07-22T00:00:00Z',
    ...overrides
  }
}

describe('token accounting', () => {
  it('Claude：按 message.id/requestId 合并流式快照，排除 fork 继承，并分开 billing 与主线程', () => {
    const messages: RawJsonlMessage[] = [
      claudeRow({
        uuid: 'stream-1',
        message: { id: 'msg-1', role: 'assistant', content: 'partial', stop_reason: null, usage: { input_tokens: 100, output_tokens: 10 } }
      }),
      // 先只出现 requestId，随后由同时包含两个 id 的完整行合并两个别名组。
      claudeRow({
        uuid: 'stream-2',
        requestId: 'req-1',
        message: { role: 'assistant', content: 'partial', stop_reason: null, usage: { input_tokens: 100, output_tokens: 15 } }
      }),
      claudeRow({
        uuid: 'stream-3',
        requestId: 'req-1',
        message: { id: 'msg-1', role: 'assistant', content: 'done', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      }),
      // 主会话与子代理日志里重复出现的同一 API call。
      claudeRow({
        uuid: 'subagent-copy',
        requestId: 'req-1',
        isSidechain: true,
        message: { id: 'msg-1', role: 'assistant', content: 'copy', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      }),
      claudeRow({
        uuid: 'sidechain-call',
        isSidechain: true,
        message: { id: 'msg-2', role: 'assistant', content: 'agent', stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 5 } }
      }),
      claudeRow({
        uuid: 'fork-copy',
        forkedFrom: { sessionId: 'parent', messageUuid: 'old' },
        message: { id: 'msg-fork', role: 'assistant', content: 'inherited', stop_reason: 'end_turn', usage: { input_tokens: 9_999, output_tokens: 9_999 } }
      })
    ]

    const accounting = accountClaudeUsage(messages)

    expect(accounting.usageEvents).toHaveLength(2)
    expect(accounting.billingTotal).toBe(175)
    expect(accounting.conversationOnly).toBe(120)
    expect(accounting.warnings.join(' ')).toContain('deduplicated')
    expect(accounting.warnings.join(' ')).toContain('fork-inherited')
  })

  it('Codex：cached_input 是 input 的子集，reasoning 是 output 的子集，均不重复相加', () => {
    const accounting = accountCodexUsage([{
      kind: 'incremental',
      inputTokens: 1_000,
      cachedInputTokens: 600,
      outputTokens: 100,
      reasoningTokens: 40,
      dedupHint: 'turn-1'
    }])

    expect(accounting.components).toEqual({
      nonCachedInputTokens: 400,
      cacheReadTokens: 600,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      outputTokens: 100,
      reasoningTokens: 40
    })
    expect(accounting.billingTotal).toBe(1_100)
    expect(processedTotal(accounting.components!)).toBe(1_100)
  })

  it('Codex：只有累计计数时按 delta 归一，最终总量等于末次累计 input + output', () => {
    const accounting = accountCodexUsage([
      { kind: 'cumulative', inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 100 },
      { kind: 'cumulative', inputTokens: 1_500, cachedInputTokens: 900, outputTokens: 160 }
    ])

    expect(accounting.billingTotal).toBe(1_660)
    expect(accounting.provenance).toBe('derived')
    expect(accounting.usageEvents.every((event) => event.counterKind === 'cumulative-delta')).toBe(true)
  })

  it('Codex 子会话用量归为 subagent，合并到父会话时按事件键去重且不进入 conversation-only', () => {
    const parent = accountCodexUsage([
      { kind: 'incremental', inputTokens: 100, outputTokens: 20, dedupHint: 'shared-turn' }
    ])
    const child = accountCodexUsage([
      { kind: 'incremental', inputTokens: 100, outputTokens: 20, dedupHint: 'shared-turn' },
      { kind: 'incremental', inputTokens: 50, outputTokens: 5, dedupHint: 'child-only' }
    ], 'subagent')

    const merged = mergeTokenAccountings([parent, child])

    expect(child.usageEvents.every((event) => event.scope === 'subagent')).toBe(true)
    expect(merged.billingTotal).toBe(175)
    expect(merged.conversationOnly).toBe(120)
    expect(merged.usageEvents).toHaveLength(3)
    expect(merged.usageEvents.find((event) => event.dedupKey === 'shared-turn')?.scope).toBe('main')
    expect(merged.usageEvents.filter((event) => event.dedupKey === 'shared-turn')).toHaveLength(2)
    expect(merged.warnings.join(' ')).toContain('deduplicated 1 cross-session usage event')
  })

  it('Cursor 与未验证 harness 明确 unavailable，不把未知值伪装成零', () => {
    const usage = { inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4 }
    const unavailableSources: SessionSource[] = ['cursor', 'antigravity', 'grok', 'pi', 'kimi', 'hermes']

    for (const source of unavailableSources) {
      const accounting = accountingFromLegacyUsage(source, usage)
      expect(accounting.provenance, source).toBe('unavailable')
      expect(accounting.billingTotal, source).toBeNull()
      expect(accounting.components, source).toBeNull()
    }
  })

  it('Harness 字段代数契约显式锁定 Claude/Codex/Gemini 包含关系', () => {
    expect(HARNESS_USAGE_CONTRACTS['claude-code']).toMatchObject({
      status: 'verified', inputCacheRelation: 'disjoint', reasoningRelation: 'subset-of-output'
    })
    expect(HARNESS_USAGE_CONTRACTS.codex).toMatchObject({
      status: 'verified', inputCacheRelation: 'cache-subset-of-input', reasoningRelation: 'subset-of-output'
    })
    expect(HARNESS_USAGE_CONTRACTS.gemini).toMatchObject({
      status: 'verified', inputCacheRelation: 'cache-subset-of-input', reasoningRelation: 'disjoint-from-visible-output'
    })
    expect(normalizeGeminiOutput(10, 6)).toEqual({
      visibleOutputTokens: 10, reasoningTokens: 6, billableOutputTokens: 16
    })
  })

  it('Codex 累计 reset 与乱序快照按事件时间归一，不生成负数', () => {
    const accounting = accountCodexUsage([
      { kind: 'cumulative', timestamp: '2026-07-30T00:02:00Z', inputTokens: 150, outputTokens: 0 },
      { kind: 'cumulative', timestamp: '2026-07-30T00:01:00Z', inputTokens: 100, outputTokens: 0 },
      { kind: 'cumulative', timestamp: '2026-07-30T00:03:00Z', inputTokens: 20, outputTokens: 0 }
    ])

    expect(accounting.billingTotal).toBe(170)
    expect(accounting.usageEvents.map((event) => event.components.nonCachedInputTokens)).toEqual([100, 50, 20])
    expect(accounting.warnings.join(' ')).toContain('reset')
  })

  it('Codex resume/subagent 的首个累计快照只作继承基线', () => {
    const accounting = accountCodexUsage([
      { kind: 'cumulative', timestamp: '2026-07-30T00:00:00Z', inputTokens: 1_000, outputTokens: 100 },
      { kind: 'cumulative', timestamp: '2026-07-30T00:01:00Z', inputTokens: 1_200, outputTokens: 120 }
    ], 'subagent', { startsWithInheritedBaseline: true })

    expect(accounting.billingTotal).toBe(220)
    expect(accounting.usageEvents).toHaveLength(1)
    expect(accounting.warnings.join(' ')).toContain('inherited cumulative baseline')
  })

  it('Codex 父子 copied prefix 共享 billingFactKey，子会话独立请求仍保留', () => {
    const parent = accountCodexUsage([
      {
        kind: 'incremental', inputTokens: 100, outputTokens: 20,
        dedupHint: 'codex:turn:shared', billingFactKey: 'codex:turn:shared'
      }
    ])
    const child = accountCodexUsage([
      {
        kind: 'incremental', inputTokens: 100, outputTokens: 20,
        dedupHint: 'codex:turn:shared', billingFactKey: 'codex:turn:shared'
      },
      {
        kind: 'incremental', inputTokens: 50, outputTokens: 5,
        dedupHint: 'codex:turn:child', billingFactKey: 'codex:turn:child'
      }
    ], 'subagent')

    const merged = mergeTokenAccountings([parent, child], {
      auditSourceIds: ['parent-session', 'child-session']
    })
    expect(merged).toMatchObject({
      billingTotal: 175,
      conversationOnly: 120
    })
    expect(merged.usageEvents).toHaveLength(3)
    expect(merged.usageEvents.filter((event) => event.billingFactKey === 'codex:turn:shared'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ auditSourceId: 'parent-session', scope: 'main' }),
        expect.objectContaining({ auditSourceId: 'child-session', scope: 'subagent' })
      ]))
  })
})
