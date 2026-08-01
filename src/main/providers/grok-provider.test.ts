import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  helloForProviderV2,
  ProviderChunkAssembler,
  runProviderConformanceV2,
  validateParseChunkV2,
  validateProviderManifestV2
} from '../../shared/provider-protocol-v2'
import type {
  CanonicalEvent,
  ProviderConformanceSample,
  UsageRecord
} from '../../shared/provider-schema-v2.generated'
import {
  createGrokProvider,
  GROK_EIGHT_LAYER_CAPABILITY_MATRIX,
  GROK_PROVIDER_MANIFEST_V2
} from './grok-provider'

const temporaryRoots: string[] = []

function fixtureDirectory(): string {
  return path.resolve(__dirname, '../../../testdata/grok/compacted-session')
}

function rewindFixtureDirectory(): string {
  return path.resolve(__dirname, '../../../testdata/grok/compacted-rewind-session')
}

function temporaryFixture(
  sourceDirectory = fixtureDirectory(),
  sessionId = '11111111-2222-7333-8444-555555555555'
): { root: string; sessionDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-grok-provider-'))
  temporaryRoots.push(root)
  const sessionDir = path.join(root, 'workspace', sessionId)
  fs.mkdirSync(path.dirname(sessionDir), { recursive: true })
  fs.cpSync(sourceDirectory, sessionDir, { recursive: true })
  return { root, sessionDir }
}

async function parseFixture(root: string) {
  const provider = createGrokProvider({ homeDir: root, roots: [root] })
  const signal = new AbortController().signal
  const sources = await provider.discover(signal)
  const fingerprint = await provider.fingerprint(sources[0], signal)
  const chunks = await provider.parse(sources[0], fingerprint, signal)
  return { provider, signal, sources, fingerprint, chunks, events: chunks.flatMap((chunk) => chunk.events) }
}

function usage(events: CanonicalEvent[]): UsageRecord[] {
  return events.filter((event) => event.kind === 'usage').map((event) => event.payload as unknown as UsageRecord)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Grok Build native Provider Protocol v2 provider', () => {
  it('discovers and fingerprints the three-member composite source, without treating Factory Droid as Grok Build', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-grok-product-boundary-'))
    temporaryRoots.push(home)
    const factorySession = path.join(home, '.factory', 'sessions', 'workspace', 'factory-session')
    fs.mkdirSync(factorySession, { recursive: true })
    fs.writeFileSync(path.join(factorySession, 'chat_history.jsonl'), '{"type":"user","content":"not Grok Build"}\n')
    const provider = createGrokProvider({ homeDir: home })
    const signal = new AbortController().signal
    expect(await provider.discover(signal)).toEqual([])

    const grokSession = path.join(home, '.grok', 'sessions', 'workspace', 'grok-session')
    fs.mkdirSync(path.dirname(grokSession), { recursive: true })
    fs.cpSync(fixtureDirectory(), grokSession, { recursive: true })
    const sources = await provider.discover(signal)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      kind: 'composite-directory',
      providerId: 'swob/grok',
      stableId: 'grok:11111111-2222-7333-8444-555555555555',
      memberUris: expect.arrayContaining([
        expect.stringContaining('summary.json'),
        expect.stringContaining('chat_history.jsonl'),
        expect.stringContaining('updates.jsonl')
      ])
    })
    const first = await provider.fingerprint(sources[0], signal)
    expect(first).toMatchObject({ algorithm: 'composite-sha256', inputs: expect.any(Array) })
    expect(first.inputs).toHaveLength(3)
    fs.appendFileSync(path.join(grokSession, 'updates.jsonl'), '\n')
    expect((await provider.fingerprint(sources[0], signal)).value).not.toBe(first.value)
  })

  it('reconstructs compacted history once, preserves dual context membership, cleartext summaries, tools and parent identity', async () => {
    const { root } = temporaryFixture()
    const { chunks, events } = await parseFixture(root)
    const assembler = new ProviderChunkAssembler()
    for (const chunk of chunks) {
      const validation = validateParseChunkV2(chunk)
      expect(validation.ok, JSON.stringify(validation.issues)).toBe(true)
      assembler.accept(chunk)
    }
    expect(assembler.completedSessions()).toBe(1)
    expect(chunks[0]).toMatchObject({
      providerId: 'swob/grok',
      parserDataVersion: '2',
      formatVersion: 'grok-build-composite-v1',
      mode: 'initial',
      done: true
    })
    const texts = events.flatMap((event) => {
      const payload = event.payload as Record<string, unknown>
      return typeof payload.text === 'string' ? [payload.text] : []
    })
    expect(texts.filter((text) => text === 'inspect the synthetic workspace')).toHaveLength(1)
    expect(texts).toEqual(expect.arrayContaining([
      'hello from the synthetic fixture',
      'The synthetic README defines the provider boundary.',
      'implement the direct v2 parser',
      'Preserve reported cache and reasoning subset semantics.'
    ]))
    expect(JSON.stringify(events)).not.toContain('synthetic-ciphertext-not-a-real-secret')
    expect(chunks[0].diagnostics).toMatchObject([{ code: 'grok-encrypted-reasoning-unavailable' }])

    const compact = events.find((event) => event.kind === 'context.compaction')!
    const summary = events.find((event) => event.kind === 'context.summary')!
    expect(compact.sequence).toBeLessThan(summary.sequence)
    expect(compact.payload).toMatchObject({ contextRevision: 1, summaryEventId: summary.id })
    const oldGreeting = events.find((event) =>
      event.kind === 'message.text' && (event.payload as any).text === 'hello from the synthetic fixture')!
    expect(oldGreeting.timeline.modelContext).toEqual([
      { contextRevision: 0, state: 'visible-to-model', fromSequence: 0, untilSequence: compact.sequence },
      { contextRevision: 1, state: 'archived', fromSequence: compact.sequence, untilSequence: null }
    ])
    const currentPrompt = events.find((event) =>
      event.kind === 'message.text' && (event.payload as any).text === 'implement the direct v2 parser')!
    expect(currentPrompt.timeline.modelContext).toEqual([
      { contextRevision: 1, state: 'visible-to-model', fromSequence: compact.sequence, untilSequence: null }
    ])
    expect(events.filter((event) => event.kind === 'tool.call').map((event) => event.payload)).toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: 'call-precompact', rawName: 'read_file' }),
      expect.objectContaining({ callId: 'call-current', rawName: 'apply_patch' })
    ]))
    expect(events.some((event) => event.kind === 'session.lifecycle' &&
      (event.payload as any).parentBranchViewId === 'grok:branch:aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee')).toBe(true)
  })

  it('drops a rewound prompt branch before reconstructing compacted history', async () => {
    const { root } = temporaryFixture(
      rewindFixtureDirectory(),
      '22222222-3333-7444-8555-666666666666'
    )
    const { chunks, events } = await parseFixture(root)
    const texts = events.flatMap((event) => {
      const payload = event.payload as Record<string, unknown>
      return typeof payload.text === 'string' ? [payload.text] : []
    })

    expect(texts).toEqual(expect.arrayContaining([
      'live prompt 0',
      'live prompt 0 continued',
      'live answer 0',
      'replacement prompt 1',
      'replacement answer 1',
      'current prompt',
      'current answer'
    ]))
    expect(texts).not.toContain('dead prompt 1')
    expect(texts).not.toContain('dead answer 1')
    expect(events.some((event) => JSON.stringify(event.payload).includes('dead-call'))).toBe(false)
    expect(usage(events).map((record) => record.turnId)).toEqual([
      'live-prompt-0',
      'replacement-prompt-1'
    ])
    expect(chunks.flatMap((chunk) => chunk.diagnostics)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'grok-unknown-update-kind' })
    ]))

    const compact = events.find((event) => event.kind === 'context.compaction')!
    const replacement = events.find((event) =>
      event.kind === 'message.text' && (event.payload as any).text === 'replacement prompt 1')!
    const current = events.find((event) =>
      event.kind === 'message.text' && (event.payload as any).text === 'current prompt')!
    expect(replacement.timeline.modelContext.at(-1)).toMatchObject({
      state: 'archived',
      fromSequence: compact.sequence
    })
    expect(current.timeline.modelContext).toEqual([
      { contextRevision: 1, state: 'visible-to-model', fromSequence: compact.sequence, untilSequence: null }
    ])
  })

  it('keeps provider-reported token subsets exact and never duplicates a turn total across model rows', async () => {
    const { root } = temporaryFixture()
    const { events } = await parseFixture(root)
    const records = usage(events)
    expect(records.find((record) => record.turnId === 'prompt-synthetic-0')).toMatchObject({
      modelId: 'grok-fixture-main',
      input: { total: 100, uncached: 70, cacheRead: 30 },
      output: { total: 20, visible: 16, reasoning: 4 },
      providerTotal: 120,
      relations: { cacheRead: 'subset-of-input', reasoning: 'subset-of-output' },
      measurement: { source: 'reported', confidence: 'exact' },
      cost: { amount: 0.0005, currency: 'USD', kind: 'reported' },
      priceRevision: null
    })
    const multiModel = records.filter((record) => record.turnId === 'prompt-synthetic-2')
    expect(multiModel).toHaveLength(2)
    expect(multiModel.find((record) => record.modelId === 'grok-fixture-main')?.cost?.amount).toBe(0.0004)
    expect(multiModel.find((record) => record.modelId === 'grok-fixture-helper')?.cost).toBeNull()
    expect(multiModel.some((record) => record.cost?.amount === 0.0009)).toBe(false)
  })

  it('withholds incomplete cost instead of turning missing trust into free or exact billing', async () => {
    const { root, sessionDir } = temporaryFixture()
    const updatesPath = path.join(sessionDir, 'updates.jsonl')
    fs.writeFileSync(
      updatesPath,
      fs.readFileSync(updatesPath, 'utf8').replace(
        '"costUsdTicks":5000000,"modelUsage"',
        '"costUsdTicks":5000000,"usageIsIncomplete":true,"modelUsage"'
      )
    )
    const { chunks, events } = await parseFixture(root)
    expect(usage(events).find((record) => record.turnId === 'prompt-synthetic-0')?.cost).toBeNull()
    expect(chunks[0].diagnostics.some((entry) => entry.code === 'grok-untrusted-cost-withheld')).toBe(true)
  })

  it('dispatches legacy role rows and mixed role/type rows without a v1 migration hop', async () => {
    const { root, sessionDir } = temporaryFixture()
    const chatPath = path.join(sessionDir, 'chat_history.jsonl')
    fs.writeFileSync(chatPath, [
      JSON.stringify({ role: 'system', content: 'legacy synthetic system' }),
      JSON.stringify({ role: 'user', content: 'legacy synthetic question' }),
      JSON.stringify({
        role: 'assistant',
        content: 'legacy synthetic answer',
        reasoning_content: 'legacy visible reasoning summary',
        tool_calls: [{ id: 'legacy-call', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }]
      }),
      JSON.stringify({ role: 'tool', tool_call_id: 'legacy-call', content: 'legacy synthetic result' })
    ].join('\n') + '\n')
    fs.writeFileSync(path.join(sessionDir, 'updates.jsonl'), '')
    expect((await parseFixture(root)).chunks[0].formatVersion).toBe('grok-build-composite-v0')

    fs.appendFileSync(chatPath, `${JSON.stringify({ type: 'user', content: 'current synthetic row' })}\n`)
    const mixed = await parseFixture(root)
    expect(mixed.chunks[0].formatVersion).toBe('grok-build-composite-mixed-v0-v1')
    expect(mixed.events.some((event) => event.kind === 'message.reasoning')).toBe(true)
  })

  it('publishes an evidence-backed eight-layer matrix and passes the direct-v2 conformance contract', async () => {
    const { root } = temporaryFixture()
    const { chunks } = await parseFixture(root)
    expect(Object.keys(GROK_EIGHT_LAYER_CAPABILITY_MATRIX)).toEqual([
      'discovery', 'metadata', 'messages', 'tools', 'context', 'usage', 'relationships', 'resume'
    ])
    expect(Object.values(GROK_EIGHT_LAYER_CAPABILITY_MATRIX).map((entry) => entry.accuracy)).not.toContain('estimated')
    const capabilitiesByLayer = {
      discovery: ['discover'],
      metadata: ['summary', 'identity'],
      messages: ['transcript', 'thinking'],
      tools: ['tools'],
      context: ['context-timeline'],
      usage: ['usage'],
      relationships: ['relationships'],
      resume: ['terminal-resume', 'native-resume']
    } as const
    for (const [layer, entry] of Object.entries(GROK_EIGHT_LAYER_CAPABILITY_MATRIX)) {
      expect(entry.fixture, `${layer} fixture`).not.toBe('')
      expect(entry.conformanceTestId, `${layer} conformance test`).not.toBe('')
      for (const capabilityName of capabilitiesByLayer[layer as keyof typeof capabilitiesByLayer]) {
        const declaration = GROK_PROVIDER_MANIFEST_V2.capabilities[capabilityName]
        expect(declaration.evidence.some((item) =>
          item.fixture === entry.fixture && item.conformanceTestId === entry.conformanceTestId
        ), `${layer} evidence must align with manifest capability ${capabilityName}`).toBe(true)
      }
    }
    expect(validateProviderManifestV2(GROK_PROVIDER_MANIFEST_V2).ok).toBe(true)
    expect(GROK_PROVIDER_MANIFEST_V2.capabilities['terminal-resume']).toMatchObject({ status: 'unavailable' })
    expect(GROK_PROVIDER_MANIFEST_V2.resumeContract).toBeNull()
    const sample: ProviderConformanceSample = {
      manifest: GROK_PROVIDER_MANIFEST_V2,
      envelopes: [
        { protocolVersion: '2.0', messageId: 'grok-hello', kind: 'hello', payload: helloForProviderV2(GROK_PROVIDER_MANIFEST_V2) },
        { protocolVersion: '2.0', messageId: 'grok-manifest', kind: 'manifest', payload: GROK_PROVIDER_MANIFEST_V2 },
        ...chunks.map((chunk, index) => ({
          protocolVersion: '2.0' as const,
          messageId: `grok-chunk-${index}`,
          kind: 'parse-chunk' as const,
          payload: chunk
        }))
      ]
    }
    expect(runProviderConformanceV2(sample)).toEqual({
      ok: true,
      providerId: 'swob/grok',
      issues: [],
      checkedEnvelopes: 3,
      completedSessions: 1
    })
  })
})
