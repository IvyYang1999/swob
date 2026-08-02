import { describe, expect, it } from 'vitest'
import {
  accountOpenCodeMessageUsage,
  accountZCodeModelUsage,
  OPENCODE_USAGE_FIELD_CONTRACT,
  ZCODE_USAGE_FIELD_CONTRACT
} from './sqlite-agent-usage'

describe('t183 SQLite agent per-call usage contracts', () => {
  it('OpenCode keeps visible output and reasoning disjoint and bills reasoning exactly once', () => {
    const accounting = accountOpenCodeMessageUsage([{
      id: 'msg_call_1',
      data: JSON.stringify({
        role: 'assistant',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4',
        time: { created: 1783504805000 },
        cost: 0.001,
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          cache: { read: 30, write: 10 }
        }
      })
    }])

    expect(OPENCODE_USAGE_FIELD_CONTRACT).toMatchObject({
      inputCacheRelation: 'disjoint',
      reasoningRelation: 'disjoint-from-visible-output'
    })
    expect(accounting.billingTotal).toBe(165)
    expect(accounting.usageEvents).toEqual([
      expect.objectContaining({
        sourceRowId: 'msg_call_1',
        dedupKey: 'opencode:message:msg_call_1',
        billingProvider: 'anthropic',
        providerProvenance: 'explicit',
        modelRaw: 'claude-sonnet-4',
        timestamp: '2026-07-08T10:00:05.000Z',
        rawOutputTokens: 20,
        rawReasoningTokens: 5,
        components: expect.objectContaining({
          nonCachedInputTokens: 100,
          cacheReadTokens: 30,
          cacheWriteTokens: 10,
          outputTokens: 25,
          visibleOutputTokens: 20,
          reasoningTokens: 5
        })
      })
    ])
  })

  it('OpenCode never guesses a missing provider from the model', () => {
    const accounting = accountOpenCodeMessageUsage([{
      id: 'msg_no_provider',
      data: JSON.stringify({
        role: 'assistant',
        modelID: 'claude-sonnet-4',
        time: { created: 1783504805000 },
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
      })
    }])

    expect(accounting.usageEvents[0]).toMatchObject({
      modelRaw: 'claude-sonnet-4',
      providerProvenance: 'unknown'
    })
    expect(accounting.usageEvents[0].billingProvider).toBeUndefined()
  })

  it('ZCode uses its independent model_usage contract and cache-subset normalization', () => {
    const accounting = accountZCodeModelUsage([
      {
        id: 'usage_1',
        logical_request_id: 'request_1',
        attempt_index: 0,
        provider_id: 'anthropic',
        model_id: 'claude-sonnet-4',
        status: 'completed',
        started_at: 1783504805000,
        input_tokens: 100,
        output_tokens: 20,
        reasoning_tokens: 5,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 30,
        computed_total_tokens: 120
      },
      {
        id: 'usage_2',
        logical_request_id: 'request_2',
        attempt_index: 1,
        provider_id: 'openai',
        model_id: 'gpt-5',
        status: 'completed',
        started_at: 1783504810000,
        input_tokens: 80,
        output_tokens: 10,
        reasoning_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 20,
        computed_total_tokens: 90
      }
    ])

    expect(ZCODE_USAGE_FIELD_CONTRACT).toMatchObject({
      sourceTable: 'model_usage',
      inputCacheRelation: 'cache-subset-of-input',
      reasoningRelation: 'provider-defined',
      totalAuthority: 'computed_total_tokens'
    })
    expect(accounting.usageEvents).toHaveLength(2)
    expect(accounting.billingTotal).toBe(210)
    expect(accounting.components).toMatchObject({
      nonCachedInputTokens: 120,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      outputTokens: 30,
      reasoningTokens: 5
    })
    expect(accounting.usageEvents[0]).toMatchObject({
      dedupKey: 'zcode:model-usage:usage_1',
      billingFactKey: 'zcode:request:request_1:attempt:0',
      billingProvider: 'anthropic',
      providerProvenance: 'explicit',
      modelRaw: 'claude-sonnet-4',
      components: expect.objectContaining({
        nonCachedInputTokens: 60,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        outputTokens: 20,
        visibleOutputTokens: 20,
        reasoningTokens: 5
      })
    })
    expect(accounting.usageEvents[1]).toMatchObject({
      billingProvider: 'openai',
      modelRaw: 'gpt-5'
    })
  })

  it('ZCode retains duplicate audit rows but counts one logical request attempt', () => {
    const base = {
      logical_request_id: 'request_shared',
      attempt_index: 0,
      provider_id: 'openai',
      model_id: 'gpt-5',
      status: 'completed',
      started_at: 1783504810000,
      input_tokens: 10,
      output_tokens: 2,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      computed_total_tokens: 12
    }
    const accounting = accountZCodeModelUsage([
      { ...base, id: 'usage_audit_copy_1' },
      { ...base, id: 'usage_audit_copy_2' }
    ])

    expect(accounting.usageEvents).toHaveLength(2)
    expect(accounting.billingTotal).toBe(12)
    expect(new Set(accounting.usageEvents.map((event) => event.billingFactKey))).toEqual(
      new Set(['zcode:request:request_shared:attempt:0'])
    )
  })

  it('ZCode accepts only the exact completed enum and diagnoses every excluded status category', () => {
    const row = (id: string, status: unknown) => ({
      id,
      logical_request_id: `request_${id}`,
      attempt_index: 0,
      provider_id: 'openai',
      model_id: 'gpt-5',
      status,
      started_at: 1783504810000,
      input_tokens: 10,
      output_tokens: 2,
      reasoning_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      computed_total_tokens: 12
    })
    const accounting = accountZCodeModelUsage([
      row('completed', 'completed'),
      row('failed', 'failed'),
      row('pending', 'pending'),
      row('cancelled', 'cancelled'),
      row('unknown', 'succeeded'),
      row('missing', null),
      row('wrong_case', 'COMPLETED'),
      row('whitespace', ' completed '),
      row('wrong_type', 1)
    ])

    expect(ZCODE_USAGE_FIELD_CONTRACT).toMatchObject({
      statusField: 'model_usage.status',
      billableStatuses: ['completed']
    })
    expect(accounting.usageEvents.map((event) => event.sourceRowId)).toEqual(['completed'])
    expect(accounting.billingTotal).toBe(12)
    expect(accounting.warnings).toEqual([
      'zcode-model-usage-status-excluded:cancelled:1',
      'zcode-model-usage-status-excluded:failed:1',
      'zcode-model-usage-status-excluded:missing:1',
      'zcode-model-usage-status-excluded:pending:1',
      'zcode-model-usage-status-excluded:unknown:4'
    ])
  })

  it('ZCode remains unavailable when every model_usage row is non-completed', () => {
    const accounting = accountZCodeModelUsage([{
      id: 'usage_pending',
      status: 'pending',
      input_tokens: 10,
      output_tokens: 2,
      computed_total_tokens: 12
    }])

    expect(accounting).toMatchObject({
      provenance: 'unavailable',
      billingTotal: null,
      usageEvents: [],
      unavailableReason: 'No completed authoritative per-call ZCode model_usage rows were found',
      warnings: ['zcode-model-usage-status-excluded:pending:1']
    })
  })
})
