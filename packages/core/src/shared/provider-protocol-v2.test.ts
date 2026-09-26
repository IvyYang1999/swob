import { describe, expect, it } from 'vitest'
import claudeGolden from '../../schema/fixtures/v2/claude-golden.json'
import codexGolden from '../../schema/fixtures/v2/codex-golden.json'
import piGolden from '../../schema/fixtures/v2/pi-golden.json'
import type {
  CanonicalEvent,
  ParseChunk,
  ProviderConformanceSample
} from './provider-schema-v2.generated'
import {
  ProviderChunkAssembler,
  deltaUsageRecords,
  runProviderConformanceV2,
  validateParseChunkV2,
  validateProviderEnvelopeV2
} from './provider-protocol-v2'

const samples = [claudeGolden, codexGolden, piGolden] as unknown as ProviderConformanceSample[]

function events(sample: ProviderConformanceSample): CanonicalEvent[] {
  return sample.envelopes.flatMap((envelope) => envelope.kind === 'parse-chunk'
    ? envelope.payload.events
    : [])
}

describe('Provider Protocol v2 三角合约', () => {
  it('Claude/Codex/Pi golden 均通过 schema 与 conformance，且 capability 有 fixture/test 证据', () => {
    for (const sample of samples) {
      expect(runProviderConformanceV2(sample)).toEqual({
        ok: true,
        providerId: sample.manifest.providerId,
        issues: [],
        checkedEnvelopes: sample.envelopes.length,
        completedSessions: 1
      })
      for (const declaration of Object.values(sample.manifest.capabilities)) {
        expect(declaration.evidence.length).toBeGreaterThan(0)
        expect(declaration.evidence.every((item) => item.fixture && item.conformanceTestId)).toBe(true)
      }
      for (const envelope of sample.envelopes) expect(validateProviderEnvelopeV2(envelope).ok).toBe(true)
    }
  })

  it('Claude 用显式事件表达 block 顺序、compact 双时间线、交互/权限和系统噪声', () => {
    const stream = events(samples[0])
    expect(stream.map((event) => event.kind)).toEqual([
      'message.text',
      'message.thinking',
      'tool.call',
      'tool.result',
      'interaction.request',
      'interaction.response',
      'permission.request',
      'permission.response',
      'context.compaction',
      'context.summary',
      'session.lifecycle',
      'usage',
      'unknown'
    ])
    expect(stream.slice(0, 4).map((event) => event.messageBlockIndex)).toEqual([0, 1, 2, 3])
    expect(stream[0].timeline.modelContext).toMatchObject([
      { state: 'visible-to-model', fromSequence: 0, untilSequence: 8 },
      { state: 'archived', fromSequence: 8, untilSequence: null }
    ])
    expect(stream[9].timeline.modelContext).toMatchObject([
      { state: 'visible-to-model', fromSequence: 9, untilSequence: null }
    ])
    expect(stream[4].payload).toMatchObject({ state: { state: 'historical', answered: true } })
    expect(stream[6].payload).toMatchObject({ state: { state: 'live-pending', channelId: 'fixture-channel' } })
    expect(stream[10]).toMatchObject({ visibility: 'hidden-noise', classification: 'lifecycle' })
    expect(stream.at(-1)).toMatchObject({ kind: 'unknown', payload: { rawType: 'future_event' } })
  })

  it('Codex 显式表达双事件流、累计 usage 差分、多 agent 和 rollback', () => {
    const stream = events(samples[1])
    expect(stream.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'message.reasoning', 'subagent.spawn', 'rollback', 'usage'
    ]))
    const usage = stream.filter((event) => event.kind === 'usage').map((event) => event.payload)
    expect(deltaUsageRecords(usage)).toMatchObject([
      { aggregation: 'delta', input: { total: 100, cacheRead: 20 }, output: { total: 30, reasoning: 10 } },
      { aggregation: 'delta', input: { total: 50, cacheRead: 10 }, output: { total: 10, reasoning: 2 } }
    ])
  })

  it('Pi 显式表达版本迁移、分支视图、上下文成员关系和 provider-reported cost', () => {
    const sample = samples[2]
    const stream = events(sample)
    expect(sample.manifest.formatVersions).toEqual(['pi-jsonl-v1', 'pi-jsonl-v3'])
    expect(stream.every((event) => event.identity.branchViewId === 'pi:branch:active')).toBe(true)
    expect(stream[0].sharedEventKey).toBe('pi:shared:event:root-user')
    expect(stream.find((event) => event.kind === 'usage')?.payload).toMatchObject({
      measurement: { source: 'reported', confidence: 'exact', sourceField: 'message.usage' },
      cost: { amount: 0.0042, currency: 'USD', kind: 'reported' },
      billingFactKey: 'pi:billing:assistant-1'
    })
  })

  it('分片装配器拒绝 cursor 或 sequence 缺口，允许跨分片超过旧 10k 上限', () => {
    const firstEnvelope = samples[2].envelopes.find((entry) => entry.kind === 'parse-chunk')!
    const first = structuredClone(firstEnvelope.payload) as ParseChunk
    first.done = false
    first.cursor = 'cursor:0'
    const assembler = new ProviderChunkAssembler()
    expect(assembler.accept(first)).toMatchObject({ acceptedEvents: first.events.length })

    const gap = structuredClone(first)
    gap.chunkIndex = 1
    gap.previousCursor = 'wrong-cursor'
    gap.cursor = null
    gap.done = true
    gap.events = [{ ...gap.events[0], id: 'gap', sequence: 99 }]
    expect(() => assembler.accept(gap)).toThrow('parse-chunk-cursor-mismatch')
  })

  it('Usage v2 对 subset、unavailable 和 derived price revision 失败关闭', () => {
    const envelope = samples[0].envelopes.find((entry) => entry.kind === 'parse-chunk')!
    const invalid = structuredClone(envelope.payload) as ParseChunk
    const usage = invalid.events.find((event) => event.kind === 'usage')!
    const payload = usage.payload as any
    payload.input.cacheRead = payload.input.total + 1
    expect(validateParseChunkV2(invalid)).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ keyword: 'usage-subset' })]
    })

    payload.input.cacheRead = null
    payload.input.total = null
    payload.input.uncached = null
    payload.input.cacheWrite5m = null
    payload.input.cacheWrite1h = null
    payload.output.total = null
    payload.output.visible = null
    payload.output.reasoning = null
    payload.providerTotal = null
    payload.measurement = { source: 'unavailable', confidence: 'unavailable', sourceField: null }
    payload.cost = { amount: 1, currency: 'USD', kind: 'derived' }
    payload.priceRevision = null
    expect(validateParseChunkV2(invalid).issues.map((entry) => entry.keyword))
      .toEqual(expect.arrayContaining(['usage-unavailable', 'price-revision']))
  })

  it('已知事件 payload 禁止私有字段绕过；未知事实只能走 unknown 透传', () => {
    const envelope = structuredClone(samples[0].envelopes.find((entry) => entry.kind === 'parse-chunk')!)
    const tool = envelope.kind === 'parse-chunk'
      ? envelope.payload.events.find((event) => event.kind === 'tool.call')!
      : null
    ;(tool!.payload as any).providerPrivateMarker = true
    expect(validateProviderEnvelopeV2(envelope).ok).toBe(false)

    const unknown = structuredClone(envelope)
    if (unknown.kind === 'parse-chunk') {
      unknown.payload.events = unknown.payload.events.filter((event) => event.kind === 'unknown')
      unknown.payload.events[0].sequence = 0
    }
    expect(validateProviderEnvelopeV2(unknown).ok).toBe(true)
  })
})
