import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CanonicalEvent,
  ParseChunk,
  ProviderConformanceSample,
  ProviderEnvelope
} from '../../shared/provider-schema-v2.generated'
import { PROVIDER_RESOURCE_LIMITS } from '../../shared/provider-schema-v2.generated'
import {
  decodeProviderEnvelopeV2,
  helloForProviderV2,
  ProviderChunkAssembler,
  runProviderConformanceV2,
  validateParseChunkV2,
  validateProviderManifestV2
} from '../../shared/provider-protocol-v2'
import { renderCanonicalEventPage } from '../canonical-v2-projection'
import { ProviderHost } from '../provider-host'
import {
  createQoderProvider,
  parseQoderSourceV2,
  QODER_FORMAT_VERSION,
  QODER_PROVIDER_ID,
  QODER_PROVIDER_MANIFEST,
  QODER_SESSION_INPUT_LIMIT_BYTES
} from './qoder-provider'

const fixtureRoot = path.resolve(__dirname, '../../../testdata/qoder')
const mainSessionId = '11111111-1111-4111-8111-111111111111'

let tempRoot = ''
let homeDir = ''
let projectsRoot = ''

function events(chunks: ParseChunk[]): CanonicalEvent[] {
  return chunks.flatMap((chunk) => chunk.events)
}

function envelope(kind: ProviderEnvelope['kind'], payload: ProviderEnvelope['payload']): ProviderEnvelope {
  return {
    protocolVersion: '2.0',
    messageId: randomUUID(),
    kind,
    payload
  } as ProviderEnvelope
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-qoder-provider-'))
  homeDir = path.join(tempRoot, 'home')
  projectsRoot = path.join(homeDir, '.qoder', 'projects')
  fs.mkdirSync(projectsRoot, { recursive: true })
  fs.cpSync(path.join(fixtureRoot, '-workspace-synthetic-qoder'),
    path.join(projectsRoot, '-workspace-synthetic-qoder'), { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('Qoder native Provider Protocol v2', () => {
  it('discovers only main/subagent transcripts with stable compound identities', async () => {
    const provider = createQoderProvider({ homeDir })
    const discovered = await provider.discover(new AbortController().signal)

    expect(discovered.map((source) => source.stableId)).toEqual([
      `qoder:${mainSessionId}`,
      `qoder:${mainSessionId}:subagent:agent-synthetic`
    ])
    const main = discovered[0]
    expect(main).toMatchObject({
      kind: 'composite-directory',
      providerId: QODER_PROVIDER_ID,
      fingerprint: { algorithm: 'composite-sha256', value: 'pending' }
    })
    if (main.kind !== 'composite-directory') throw new Error('expected compound source')
    expect(main.memberUris).toHaveLength(2)
    expect(main.memberUris.some((uri) => uri.endsWith('-session.json'))).toBe(true)

    const movedProject = path.join(projectsRoot, '-workspace-renamed-synthetic-qoder')
    fs.renameSync(path.join(projectsRoot, '-workspace-synthetic-qoder'), movedProject)
    const moved = await provider.discover(new AbortController().signal)
    expect(moved.map((source) => source.stableId)).toEqual(discovered.map((source) => source.stableId))
  })

  it('composite fingerprint includes sidecar metadata and fails closed on mid-parse change', async () => {
    const provider = createQoderProvider({ homeDir })
    const source = (await provider.discover(new AbortController().signal))[0]
    const signal = new AbortController().signal
    const first = await provider.fingerprint(source, signal)
    expect(first).toMatchObject({ algorithm: 'composite-sha256' })
    expect(first.inputs).toHaveLength(2)

    const sidecarPath = source.displayLocator.replace(/\.jsonl$/, '-session.json')
    fs.writeFileSync(sidecarPath, JSON.stringify({ title: 'Changed synthetic title' }))
    const second = await provider.fingerprint(source, signal)
    expect(second.value).not.toBe(first.value)
    await expect(provider.parse(source, first, signal))
      .rejects.toThrow('qoder-source-changed-during-parse')
  })

  it('preserves ordered text/thinking/tool/result/usage and unknown facts without estimates', async () => {
    const provider = createQoderProvider({ homeDir })
    const source = (await provider.discover(new AbortController().signal))[0]
    const signal = new AbortController().signal
    const fingerprint = await provider.fingerprint(source, signal)
    const chunks = await provider.parse(source, fingerprint, signal)

    expect(chunks).toHaveLength(1)
    expect(validateParseChunkV2(chunks[0])).toMatchObject({ ok: true, issues: [] })
    const stream = events(chunks)
    expect(stream.map((event) => event.sequence)).toEqual(stream.map((_event, index) => index))
    expect(stream[0]).toMatchObject({
      kind: 'session.metadata',
      payload: {
        title: 'Synthetic Qoder compound session',
        cwd: ['/workspace/synthetic-qoder'],
        projectPath: '/workspace/synthetic-qoder'
      }
    })
    const assistantBlocks = stream.filter((event) => event.messageId === 'qoder-assistant-1')
    expect(assistantBlocks.map((event) => event.kind)).toEqual([
      'message.thinking', 'message.text', 'tool.call', 'usage'
    ])
    expect(assistantBlocks.slice(0, 3).map((event) => event.messageBlockIndex)).toEqual([0, 1, 2])
    expect(assistantBlocks[2].payload).toMatchObject({
      callId: 'qoder-tool-1',
      rawName: 'Read',
      semanticToolId: 'filesystem.read',
      input: { file_path: '/workspace/synthetic-qoder/README.md' }
    })
    expect(stream.find((event) => event.kind === 'tool.result')?.payload).toMatchObject({
      callId: 'qoder-tool-1',
      output: 'qoder-synthetic-search-needle',
      state: 'complete'
    })
    expect(stream.find((event) => event.kind === 'usage')?.payload).toMatchObject({
      input: { total: 100, uncached: null, cacheRead: 20, cacheWrite5m: 5 },
      output: { total: 40, visible: 40, reasoning: null },
      providerTotal: null,
      measurement: { source: 'reported', confidence: 'exact', sourceField: 'message.usage' },
      cost: null
    })
    expect(stream.find((event) =>
      event.kind === 'unknown' && (event.payload as any).rawType === 'qoder.synthetic-future-event'))
      .toBeTruthy()
    expect(stream.every((event) => event.timeline.modelContext[0]?.state === 'unknown')).toBe(true)
    expect(stream.filter((event) => event.messageId).every((event) =>
      event.rawRef && event.provenance.rawRecordFingerprint)).toBe(true)

    const rendered = renderCanonicalEventPage(stream)
    expect(rendered.find((event) => event.kind === 'tool.call')).toMatchObject({
      semanticToolId: 'filesystem.read',
      component: 'tool-card'
    })
  })

  it('emits sidecar fork and nested subagent lineage as explicit branch facts', async () => {
    const provider = createQoderProvider({ homeDir })
    const discovered = await provider.discover(new AbortController().signal)
    const signal = new AbortController().signal
    const main = discovered[0]
    const mainChunks = await parseQoderSourceV2(
      main,
      await provider.fingerprint(main, signal),
      signal,
      'replace'
    )
    expect(mainChunks[0]).toMatchObject({
      mode: 'replace',
      identity: {
        logicalSessionId: mainSessionId,
        parentBranchViewId: 'qoder:00000000-0000-4000-8000-000000000000:default'
      }
    })
    expect(events(mainChunks).find((event) => event.kind === 'session.lifecycle')?.payload).toEqual({
      relationshipType: 'fork',
      parentBranchViewId: 'qoder:00000000-0000-4000-8000-000000000000:default'
    })

    const subagent = discovered[1]
    const subagentChunks = await provider.parse(
      subagent,
      await provider.fingerprint(subagent, signal),
      signal
    )
    expect(subagentChunks[0].identity).toMatchObject({
      logicalSessionId: `${mainSessionId}:subagent:agent-synthetic`,
      parentBranchViewId: `qoder:${mainSessionId}:default`
    })
    expect(events(subagentChunks).find((event) => event.kind === 'session.lifecycle')?.payload).toEqual({
      relationshipType: 'subagent',
      parentBranchViewId: `qoder:${mainSessionId}:default`
    })
    expect(events(subagentChunks).some((event) => event.kind === 'usage')).toBe(false)
    expect(events(subagentChunks).find((event) => event.kind === 'tool.call')?.payload).toMatchObject({
      rawName: 'Bash', semanticToolId: 'shell.execute'
    })
  })

  it('passes v2 conformance with evidence-backed capabilities and an honest Resume contract', async () => {
    const manifestValidation = validateProviderManifestV2(QODER_PROVIDER_MANIFEST)
    expect(manifestValidation).toMatchObject({ ok: true, issues: [] })
    expect(Object.values(QODER_PROVIDER_MANIFEST.capabilities).every((declaration) =>
      declaration.evidence.length > 0 && declaration.evidence.every((item) =>
        item.fixture && item.conformanceTestId))).toBe(true)
    expect(QODER_PROVIDER_MANIFEST.capabilities.usage).toMatchObject({ status: 'experimental' })
    expect(QODER_PROVIDER_MANIFEST.capabilities['context-timeline']).toMatchObject({ status: 'unavailable' })
    expect(QODER_PROVIDER_MANIFEST.capabilities['terminal-resume']).toMatchObject({ status: 'experimental' })
    expect(QODER_PROVIDER_MANIFEST.capabilities['native-resume']).toMatchObject({ status: 'unavailable' })
    expect(QODER_PROVIDER_MANIFEST.resumeContract).toMatchObject({
      commandTemplate: 'qodercli -r {sessionId}',
      postcondition: 'anchor-match',
      supportsSubagent: false
    })

    const provider = createQoderProvider({ homeDir })
    const source = (await provider.discover(new AbortController().signal))[0]
    const signal = new AbortController().signal
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    const sample: ProviderConformanceSample = {
      manifest: QODER_PROVIDER_MANIFEST,
      envelopes: [
        envelope('hello', helloForProviderV2(QODER_PROVIDER_MANIFEST)),
        envelope('manifest', QODER_PROVIDER_MANIFEST),
        ...chunks.map((chunk) => envelope('parse-chunk', chunk))
      ]
    }
    expect(runProviderConformanceV2(sample)).toEqual({
      ok: true,
      providerId: QODER_PROVIDER_ID,
      issues: [],
      checkedEnvelopes: sample.envelopes.length,
      completedSessions: 1
    })
  })

  it('streams beyond the per-chunk event cap with contiguous cursors', async () => {
    const projectDir = path.join(projectsRoot, '-workspace-long-qoder')
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    fs.mkdirSync(projectDir, { recursive: true })
    const rows = Array.from({ length: 2_050 }, (_entry, index) => JSON.stringify({
      type: 'user',
      uuid: `long-${index}`,
      timestamp: '2026-08-01T02:00:00.000Z',
      message: { role: 'user', content: `synthetic long event ${index} ${'x'.repeat(2_048)}` },
      sessionId
    }))
    fs.writeFileSync(transcriptPath, `${rows.join('\n')}\n`)

    const provider = createQoderProvider({ homeDir })
    const source = (await provider.discover(new AbortController().signal))
      .find((candidate) => candidate.stableId === `qoder:${sessionId}`)!
    const signal = new AbortController().signal
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    expect(chunks.length).toBeGreaterThan(2)
    expect(events(chunks)).toHaveLength(2_051)
    const assembler = new ProviderChunkAssembler()
    for (const chunk of chunks) {
      expect(chunk.events.length).toBeLessThanOrEqual(1_000)
      const encodedEnvelope = JSON.stringify(envelope('parse-chunk', chunk))
      expect(Buffer.byteLength(encodedEnvelope, 'utf8')).toBeLessThanOrEqual(
        PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes
      )
      expect(decodeProviderEnvelopeV2(encodedEnvelope)).toMatchObject({ ok: true, issues: [] })
      expect(assembler.accept(chunk).acceptedEvents).toBeGreaterThan(0)
    }
    expect(assembler.completedSessions()).toBe(1)
  })

  it('bounds oversized and adversarial persisted values before envelope transport', async () => {
    const projectDir = path.join(projectsRoot, '-workspace-adversarial-qoder')
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    fs.mkdirSync(projectDir, { recursive: true })
    let deep: unknown = 'leaf'
    for (let index = 0; index < 100; index++) deep = { child: deep }
    const unknownRow = {
      type: 'future-event',
      huge: '界'.repeat(200_000),
      wideArray: Array.from({ length: 5_000 }, (_entry, index) => index),
      wideObject: Object.fromEntries(Array.from({ length: 300 }, (_entry, index) => [`key-${index}`, index])),
      deep
    }
    const oversizedText = '💾'.repeat(150_000)
    const rows = [
      JSON.stringify({
        type: 'user',
        uuid: 'oversized-text',
        message: { role: 'user', content: oversizedText },
        sessionId
      }),
      JSON.stringify(unknownRow),
      ...Array.from({ length: 200 }, () => '{malformed')
    ]
    fs.writeFileSync(transcriptPath, `${rows.join('\n')}\n`)

    const provider = createQoderProvider({ homeDir })
    const source = (await provider.discover(new AbortController().signal))
      .find((candidate) => candidate.stableId === `qoder:${sessionId}`)!
    const signal = new AbortController().signal
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)

    expect(chunks[0].diagnostics).toContainEqual(expect.objectContaining({ code: 'qoder-value-truncated' }))
    expect(chunks[0].diagnostics).toContainEqual(expect.objectContaining({ code: 'qoder-diagnostics-truncated' }))
    expect(chunks[0].diagnostics.length).toBeLessThanOrEqual(128)
    const textEvents = events(chunks).filter((event) => event.kind === 'message.text')
    expect(textEvents.length).toBeGreaterThan(1)
    expect(textEvents.map((event) => (event.payload as any).text).join('')).toBe(oversizedText)
    expect(textEvents.every((event) =>
      Buffer.byteLength((event.payload as any).text, 'utf8') <= 192 * 1024)).toBe(true)
    expect(events(chunks).find((event) => event.kind === 'unknown')).toBeTruthy()
    for (const chunk of chunks) {
      const encodedEnvelope = JSON.stringify(envelope('parse-chunk', chunk))
      expect(Buffer.byteLength(encodedEnvelope, 'utf8')).toBeLessThanOrEqual(
        PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes
      )
      expect(decodeProviderEnvelopeV2(encodedEnvelope)).toMatchObject({ ok: true, issues: [] })
    }
  })

  it('fails closed on a session larger than 50 MiB before fingerprint parsing', async () => {
    const oversizedRoot = path.join(tempRoot, 'oversized-projects')
    const projectDir = path.join(oversizedRoot, '-workspace-oversized-qoder')
    const sessionId = '44444444-4444-4444-8444-444444444444'
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`)
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(transcriptPath, '')
    fs.truncateSync(transcriptPath, QODER_SESSION_INPUT_LIMIT_BYTES + 1)

    const provider = createQoderProvider({ homeDir, roots: [oversizedRoot] })
    const source = (await provider.discover(new AbortController().signal))
      .find((candidate) => candidate.stableId === `qoder:${sessionId}`)!
    const signal = new AbortController().signal
    await expect(provider.inputBytes(source, signal)).resolves.toBe(QODER_SESSION_INPUT_LIMIT_BYTES + 1)
    await expect(provider.fingerprint(source, signal)).rejects.toThrow('qoder-session-input-limit-exceeded')

    let fingerprintCalls = 0
    const guardedProvider = {
      ...provider,
      async fingerprint(...args: Parameters<typeof provider.fingerprint>) {
        fingerprintCalls++
        return provider.fingerprint(...args)
      }
    }
    const readFile = vi.spyOn(fs.promises, 'readFile')
    try {
      const report = (await new ProviderHost({ runtimes: [], v2Runtimes: [guardedProvider] }).runAll())[0]
      expect(report.errors).toMatchObject([{ code: 'resource-limit-exceeded' }])
      expect(report.outcomes).toHaveLength(0)
      expect(fingerprintCalls).toBe(0)
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      readFile.mockRestore()
    }
  })

  it('reports malformed lines without dropping adjacent valid facts', async () => {
    const provider = createQoderProvider({ homeDir })
    const source = (await provider.discover(new AbortController().signal))[0]
    fs.appendFileSync(source.displayLocator,
      '{malformed\n' +
      '{"type":"user","uuid":"after-malformed","message":{"role":"user","content":"survives malformed neighbor"}}\n')
    const signal = new AbortController().signal
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    expect(chunks[0].diagnostics).toContainEqual(expect.objectContaining({ code: 'qoder-jsonl-malformed' }))
    expect(events(chunks).some((event) =>
      event.kind === 'message.text' && (event.payload as any).text === 'survives malformed neighbor')).toBe(true)
  })

  it('declares the parser as native v2 and never exposes a v1 parse method', () => {
    const provider = createQoderProvider({ homeDir })
    expect(provider.manifest).toEqual(QODER_PROVIDER_MANIFEST)
    expect(provider.parse).toBeTypeOf('function')
    expect(provider.manifest.formatVersions).toEqual([QODER_FORMAT_VERSION])
  })
})
