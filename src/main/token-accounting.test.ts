import { describe, expect, it } from 'vitest'
import type { RawJsonlMessage, SessionSource } from './types'
import {
  accountClaudeUsage,
  accountCodexUsage,
  accountingFromLegacyUsage,
  mergeTokenAccountings,
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
    expect(merged.usageEvents).toHaveLength(2)
    expect(merged.usageEvents.find((event) => event.dedupKey === 'shared-turn')?.scope).toBe('main')
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
})
