import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ProviderChunkAssembler,
  validateParseChunkV2,
  validateProviderManifestV2
} from '../../shared/provider-protocol-v2'
import type { ParseChunk, UsageRecord } from '../../shared/provider-schema-v2.generated'
import {
  KIMI_EIGHT_LAYER_EVIDENCE,
  KIMI_PROVIDER_MANIFEST_V2,
  createKimiProvider,
  kimiParentSessionId
} from './kimi-provider'

const fixtureHome = path.resolve('testdata/kimi/home')

async function parsedFixtures() {
  const runtime = createKimiProvider({ homeDir: fixtureHome })
  const controller = new AbortController()
  const sources = await runtime.discover(controller.signal)
  const chunks = new Map<string, ParseChunk>()
  for (const source of sources) {
    const fingerprint = await runtime.fingerprint(source, controller.signal)
    const parsed = await runtime.parse(source, fingerprint, controller.signal)
    expect(parsed).toHaveLength(1)
    chunks.set(source.stableId, parsed[0])
  }
  return { runtime, sources, chunks }
}

function events(chunk: ParseChunk, kind: ParseChunk['events'][number]['kind']) {
  return chunk.events.filter((event) => event.kind === kind)
}

function textPayloads(chunk: ParseChunk): string[] {
  return chunk.events.flatMap((event) => {
    if (event.kind !== 'message.text' && event.kind !== 'message.thinking') return []
    const payload = event.payload as { text?: unknown }
    return typeof payload.text === 'string' ? [payload.text] : []
  })
}

describe('Kimi native Provider Protocol v2 runtime', () => {
  it('KIMI-DISCOVERY-001 discovers main/subagent/migrated wires as composite sources', async () => {
    const { sources } = await parsedFixtures()

    expect(sources.map((source) => source.stableId)).toEqual([
      'kimi:session_synthetic_migrated:main',
      'kimi:session_synthetic_native:agent-0',
      'kimi:session_synthetic_native:main'
    ])
    for (const source of sources) {
      expect(source.kind).toBe('composite-directory')
      if (source.kind !== 'composite-directory') continue
      expect(source.memberUris.some((uri) => uri.endsWith('/wire.jsonl'))).toBe(true)
      expect(source.memberUris.some((uri) => uri.endsWith('/state.json'))).toBe(true)
      expect(source.memberUris.some((uri) => uri.endsWith('/session_index.jsonl'))).toBe(true)
    }
  })

  it('all eight evidence cells are explicit, fixture-backed and conformance-addressable', () => {
    expect(Object.keys(KIMI_EIGHT_LAYER_EVIDENCE)).toEqual([
      'discovery', 'metadata', 'messages', 'tools', 'systemCompact', 'token', 'relationships', 'resume'
    ])
    for (const cell of Object.values(KIMI_EIGHT_LAYER_EVIDENCE)) {
      expect(['exact', 'derived', 'estimated', 'unavailable']).toContain(cell.grade)
      expect(cell.fixture).not.toBe('')
      expect(cell.conformanceTestId).toMatch(/^KIMI-[A-Z-]+-001$/)
      expect(cell.note).not.toBe('')
    }
    expect(validateProviderManifestV2(KIMI_PROVIDER_MANIFEST_V2)).toEqual({
      ok: true,
      value: KIMI_PROVIDER_MANIFEST_V2,
      issues: []
    })
  })

  it('KIMI-MESSAGES-001 preserves both native and migrated text/thinking without prompt duplication', async () => {
    const { chunks } = await parsedFixtures()
    const native = chunks.get('kimi:session_synthetic_native:main')!
    const migrated = chunks.get('kimi:session_synthetic_migrated:main')!
    const nativeText = textPayloads(native)
    const migratedText = textPayloads(migrated)

    expect(nativeText.filter((text) => text === 'Inspect the synthetic fixture.')).toHaveLength(1)
    expect(nativeText).toContain('I should inspect only the fixture.')
    expect(nativeText).toContain('Partial answer before cancellation.')
    expect(migratedText).toContain('This is the migrated wire family.')
    expect(migratedText).toContain('The migrated fixture is readable.')
    expect(events(migrated, 'tool.result').some((event) =>
      JSON.stringify(event.payload).includes('synthetic-kimi-migrated-needle'))).toBe(true)
    expect(native.formatVersion).toBe('kimi-code-wire-native-v1.5')
    expect(migrated.formatVersion).toBe('kimi-code-wire-migrated-v1.0')
  })

  it('KIMI-TOOLS-001 normalizes native and migrated tool call/result pairs', async () => {
    const { chunks } = await parsedFixtures()
    const native = chunks.get('kimi:session_synthetic_native:main')!
    const migrated = chunks.get('kimi:session_synthetic_migrated:main')!

    expect(events(native, 'tool.call')[0]?.payload).toMatchObject({ callId: 'tool-1', rawName: 'Read' })
    expect(events(native, 'tool.result')[0]?.payload).toMatchObject({ callId: 'tool-1', isError: false })
    expect(events(migrated, 'tool.call')[0]?.payload).toMatchObject({ callId: 'legacy-tool-1', rawName: 'Read' })
    expect(events(migrated, 'tool.result')[0]?.payload).toMatchObject({ callId: 'legacy-tool-1', isError: false })
  })

  it('KIMI-USAGE-001 makes usage.record authoritative and keeps step.end only as derived fallback', async () => {
    const { chunks } = await parsedFixtures()
    const main = chunks.get('kimi:session_synthetic_native:main')!
    const child = chunks.get('kimi:session_synthetic_native:agent-0')!
    const migrated = chunks.get('kimi:session_synthetic_migrated:main')!
    const mainUsage = events(main, 'usage').map((event) => event.payload as unknown as UsageRecord)
    const childUsage = events(child, 'usage').map((event) => event.payload as unknown as UsageRecord)

    expect(mainUsage).toHaveLength(1)
    expect(mainUsage[0]).toMatchObject({
      input: { total: 58, uncached: 26, cacheRead: 32, cacheWrite5m: null, cacheWrite1h: null },
      output: { total: 9, visible: null, reasoning: null },
      measurement: { source: 'reported', confidence: 'exact' }
    })
    expect(main.diagnostics.some((entry) => entry.code === 'kimi-step-usage-deduplicated')).toBe(true)
    expect(childUsage).toHaveLength(1)
    expect(childUsage[0]).toMatchObject({
      input: { total: 12, uncached: 7, cacheRead: 5 },
      output: { total: 3 },
      measurement: { source: 'derived', confidence: 'high' }
    })
    expect(events(migrated, 'usage')).toHaveLength(0)
  })

  it('keeps an earlier turn fallback when only a later turn has authoritative usage', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-kimi-usage-turns-'))
    const copiedHome = path.join(temp, 'home')
    fs.cpSync(fixtureHome, copiedHome, { recursive: true })
    const wirePath = path.join(copiedHome, '.kimi-code', 'sessions', 'wd_synthetic',
      'session_synthetic_native', 'agents', 'main', 'wire.jsonl')
    const records = [
      { type: 'metadata', protocol_version: '1.5' },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'first' }] },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'first' }] } },
      { type: 'context.append_loop_event', event: { type: 'step.end', usage: { inputOther: 10, inputCacheRead: 2, inputCacheCreation: 1, output: 3 } } },
      { type: 'turn.ended', turnId: 1, reason: 'completed' },
      { type: 'turn.prompt', input: [{ type: 'text', text: 'second' }] },
      { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: 'second' }] } },
      { type: 'usage.record', usage: { inputOther: 20, inputCacheRead: 4, inputCacheCreation: 2, output: 6 } }
    ]
    fs.writeFileSync(wirePath, records.map((record) => JSON.stringify(record)).join('\n'))

    try {
      const runtime = createKimiProvider({ homeDir: copiedHome })
      const controller = new AbortController()
      const source = (await runtime.discover(controller.signal))
        .find((candidate) => candidate.stableId === 'kimi:session_synthetic_native:main')!
      const fingerprint = await runtime.fingerprint(source, controller.signal)
      const [chunk] = await runtime.parse(source, fingerprint, controller.signal)
      const usage = events(chunk, 'usage').map((event) => event.payload as unknown as UsageRecord)

      expect(usage).toHaveLength(2)
      expect(usage[0]).toMatchObject({ turnId: 'turn-1', input: { total: 13 }, measurement: { source: 'derived' } })
      expect(usage[1]).toMatchObject({ turnId: 'turn-2', input: { total: 26 }, measurement: { source: 'reported' } })
      expect(chunk.diagnostics.some((entry) => entry.code === 'kimi-step-usage-deduplicated')).toBe(false)
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })

  it('KIMI-SYSTEM-COMPACT-001 retains interactions, permissions, plan/goal, steer, rollback and unknown data', async () => {
    const { chunks } = await parsedFixtures()
    const main = chunks.get('kimi:session_synthetic_native:main')!

    expect(events(main, 'interaction.request')).toHaveLength(1)
    expect(events(main, 'interaction.response')).toHaveLength(1)
    expect(events(main, 'permission.request')).toHaveLength(1)
    expect(events(main, 'permission.response')).toHaveLength(1)
    expect(events(main, 'context.compaction')).toHaveLength(1)
    expect(events(main, 'context.summary')).toHaveLength(1)
    expect(events(main, 'rollback').length).toBeGreaterThanOrEqual(2)
    expect(events(main, 'artifact')).toHaveLength(1)
    expect(events(main, 'subagent.spawn')).toHaveLength(1)
    expect(events(main, 'unknown').some((event) =>
      (event.payload as { rawType?: unknown }).rawType === 'future.synthetic_event')).toBe(true)
    expect(main.events.some((event) => event.kind === 'session.lifecycle' &&
      JSON.stringify(event.payload).includes('goal.create'))).toBe(true)
    expect(main.events.some((event) => event.kind === 'session.lifecycle' &&
      JSON.stringify(event.payload).includes('turn.steer'))).toBe(true)
    expect(main.diagnostics.some((entry) => entry.code === 'kimi-malformed-jsonl-record')).toBe(true)
  })

  it('compaction keeps archive truth while closing the old model-context revision', async () => {
    const { chunks } = await parsedFixtures()
    const main = chunks.get('kimi:session_synthetic_native:main')!
    const compact = events(main, 'context.compaction')[0]
    const early = main.events.find((event) => event.kind === 'message.text' &&
      JSON.stringify(event.payload).includes('Inspect the synthetic fixture'))!
    const summary = events(main, 'context.summary')[0]

    expect(early.timeline.archived).toBe(true)
    expect(early.timeline.modelContext).toEqual([
      expect.objectContaining({ contextRevision: 0, state: 'visible-to-model', untilSequence: compact.sequence }),
      expect.objectContaining({ contextRevision: 1, state: 'archived', fromSequence: compact.sequence })
    ])
    expect(summary.timeline.modelContext).toEqual([
      expect.objectContaining({ contextRevision: 1, state: 'visible-to-model' })
    ])
    expect(compact.payload).toMatchObject({ summaryEventId: summary.id })
  })

  it('KIMI-RELATIONSHIPS-001 gives child branches a parent identity and Resume returns the parent session', async () => {
    const { chunks } = await parsedFixtures()
    const child = chunks.get('kimi:session_synthetic_native:agent-0')!

    expect(child.identity).toMatchObject({
      logicalSessionId: 'session_synthetic_native',
      branchViewId: 'kimi:session_synthetic_native:agent-0',
      parentBranchViewId: 'kimi:session_synthetic_native:main'
    })
    expect(child.formatVersion).toBe('kimi-code-wire-native-v1.5')
    expect(kimiParentSessionId(child)).toBe('session_synthetic_native')
    expect(events(child, 'session.lifecycle').some((event) =>
      JSON.stringify(event.payload).includes('subagent'))).toBe(true)
  })

  it('every chunk passes schema and stream conformance with contiguous identity-bound events', async () => {
    const { chunks } = await parsedFixtures()
    const assembler = new ProviderChunkAssembler()
    for (const chunk of chunks.values()) {
      expect(validateParseChunkV2(chunk), chunk.identity.physicalSourceId).toEqual({
        ok: true,
        value: chunk,
        issues: []
      })
      expect(assembler.accept(chunk)).toEqual({ acceptedEvents: chunk.events.length, done: true })
    }
    expect(assembler.completedSessions()).toBe(3)
  })

  it('composite fingerprint binds state/index/wire and rejects a changed source during parse', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-kimi-provider-'))
    const copiedHome = path.join(temp, 'home')
    fs.cpSync(fixtureHome, copiedHome, { recursive: true })
    const runtime = createKimiProvider({ homeDir: copiedHome })
    const controller = new AbortController()
    try {
      const source = (await runtime.discover(controller.signal))
        .find((candidate) => candidate.stableId === 'kimi:session_synthetic_native:main')!
      const before = await runtime.fingerprint(source, controller.signal)
      if (source.kind !== 'composite-directory') throw new Error('expected composite source')
      const stateUri = source.memberUris.find((uri) => uri.endsWith('/state.json'))!
      fs.appendFileSync(new URL(stateUri), '\n')
      const after = await runtime.fingerprint(source, controller.signal)

      expect(after.value).not.toBe(before.value)
      await expect(runtime.parse(source, before, controller.signal)).rejects.toThrow('kimi-source-changed-during-parse')
      expect(pathToFileURL(copiedHome).protocol).toBe('file:')
    } finally {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  })
})
