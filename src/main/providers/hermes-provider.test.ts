import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import {
  helloForProviderV2,
  runProviderConformanceV2,
  validateParseChunkV2,
  validateProviderManifestV2
} from '../../shared/provider-protocol-v2'
import { PROVIDER_PROTOCOL_VERSION, type ProviderEnvelope } from '../../shared/provider-schema-v2.generated'
import { buildResumeLaunchSpec } from '../session-actions'
import { verifyResumeContractV2 } from '../resume-contract-v2'
import {
  HERMES_DB_FORMAT,
  HERMES_EIGHT_LAYER_TRUTH,
  HERMES_JSON_FORMAT,
  HERMES_PROVIDER_MANIFEST,
  createHermesProvider
} from './hermes-provider'

const temporaryRoots: string[] = []

function fixture(name: string): string {
  return path.resolve(__dirname, `../../../testdata/hermes/${name}`)
}

function setup(): { root: string; home: string; dbPath: string; jsonRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-hermes-provider-'))
  temporaryRoots.push(root)
  const home = path.join(root, 'home')
  const hermesRoot = path.join(home, '.hermes')
  const jsonRoot = path.join(hermesRoot, 'sessions')
  const dbPath = path.join(hermesRoot, 'state.db')
  fs.mkdirSync(jsonRoot, { recursive: true })
  fs.copyFileSync(fixture('session_legacy-only.json'), path.join(jsonRoot, 'session_legacy-only.json'))
  const db = new Database(dbPath)
  db.exec(fs.readFileSync(fixture('state-db.sql'), 'utf8'))
  db.close()
  return { root, home, dbPath, jsonRoot }
}

function allEvents(chunks: Awaited<ReturnType<ReturnType<typeof createHermesProvider>['parse']>>) {
  return chunks.flatMap((chunk) => chunk.events)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Hermes native Provider Protocol v2 adapter', () => {
  it('declares a schema-valid manifest and an exhaustive format-scoped eight-layer truth table', () => {
    expect(validateProviderManifestV2(HERMES_PROVIDER_MANIFEST)).toEqual({
      ok: true,
      value: HERMES_PROVIDER_MANIFEST,
      issues: []
    })
    const allowed = new Set(['exact', 'derived', 'estimated', 'unavailable'])
    const conformanceTestIds = new Set<string>()
    for (const truth of Object.values(HERMES_EIGHT_LAYER_TRUTH)) {
      expect(Object.keys(truth).sort()).toEqual([
        'discovery', 'messages', 'metadata', 'relationships', 'resume', 'systemContext', 'tools', 'usage'
      ])
      for (const cell of Object.values(truth)) {
        expect(allowed.has(cell.status)).toBe(true)
        expect(cell.fixture).not.toBe('')
        expect(fs.existsSync(path.resolve(__dirname, `../../../${cell.fixture}`))).toBe(true)
        expect(cell.conformanceTestId).toMatch(/^hermes-(state-db-current|state-db-legacy|json-snapshot)-/)
        expect(conformanceTestIds.has(cell.conformanceTestId)).toBe(false)
        conformanceTestIds.add(cell.conformanceTestId)
        expect(cell.note).not.toBe('')
      }
    }
    expect(conformanceTestIds).toHaveProperty('size', 24)
    expect(HERMES_EIGHT_LAYER_TRUTH.stateDbCurrent.usage.status).toBe('exact')
    expect(HERMES_EIGHT_LAYER_TRUTH.stateDbLegacy.usage.status).toBe('unavailable')
    expect(HERMES_EIGHT_LAYER_TRUTH.jsonSnapshot.usage.status).toBe('unavailable')
    expect(HERMES_EIGHT_LAYER_TRUTH.stateDbCurrent.resume.status).toBe('unavailable')
    expect(HERMES_EIGHT_LAYER_TRUTH.stateDbLegacy.resume.status).toBe('unavailable')
    expect(HERMES_EIGHT_LAYER_TRUTH.jsonSnapshot.resume.status).toBe('unavailable')
  })

  it('discovers state.db rows and legacy JSON while preferring DB for duplicate session ids', async () => {
    const { home, dbPath, jsonRoot } = setup()
    const duplicate = JSON.parse(fs.readFileSync(fixture('session_legacy-only.json'), 'utf8'))
    duplicate.session_id = 'synthetic-hermes-db'
    fs.writeFileSync(path.join(jsonRoot, 'session_duplicate.json'), JSON.stringify(duplicate))
    const provider = createHermesProvider({ homeDir: home })
    const sources = await provider.discover(new AbortController().signal)

    expect(sources.map((source) => source.stableId).sort()).toEqual([
      'hermes:db:synthetic-hermes-db',
      'hermes:db:synthetic-hermes-parent',
      'hermes:json:synthetic-hermes-json'
    ])
    expect(sources.find((source) => source.stableId === 'hermes:db:synthetic-hermes-db')).toMatchObject({
      kind: 'sqlite-row',
      displayLocator: `${dbPath}#synthetic-hermes-db`,
      primaryKey: { id: 'synthetic-hermes-db' }
    })
  })

  it('reads committed WAL frames in one logical snapshot and preserves messages, reasoning, tools, usage and lineage', async () => {
    const { home, dbPath } = setup()
    const writer = new Database(dbPath)
    writer.pragma('journal_mode = WAL')
    writer.pragma('wal_autocheckpoint = 0')
    writer.prepare(
      'INSERT INTO messages(session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, 1, 0)'
    ).run('synthetic-hermes-db', 'assistant', 'committed-wal-search-needle', 1785542405)
    expect(fs.existsSync(`${dbPath}-wal`)).toBe(true)

    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === 'hermes:db:synthetic-hermes-db')!
    const fingerprint = await provider.fingerprint(source, signal)
    const chunks = await provider.parse(source, fingerprint, signal)
    writer.close()

    for (const chunk of chunks) expect(validateParseChunkV2(chunk).ok).toBe(true)
    expect(chunks[0].formatVersion).toBe(HERMES_DB_FORMAT)
    expect(await provider.inputBytes(source, signal)).toBeGreaterThan(0)
    const events = allEvents(chunks)
    expect(JSON.stringify(events)).toContain('committed-wal-search-needle')
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message.reasoning' }),
      expect.objectContaining({ kind: 'tool.call' }),
      expect.objectContaining({ kind: 'tool.result' }),
      expect.objectContaining({ kind: 'context.compaction' }),
      expect.objectContaining({ kind: 'usage' }),
      expect.objectContaining({ kind: 'session.lifecycle' })
    ]))
    const usageEvents = events.filter((entry) => entry.kind === 'usage')
    expect(usageEvents).toHaveLength(1)
    expect(usageEvents[0].payload).toMatchObject({
      modelId: 'synthetic-model-db',
      input: { total: 125, uncached: 100, cacheRead: 20, cacheWrite5m: 5, cacheWrite1h: null },
      output: { total: 30, visible: 20, reasoning: 10 },
      measurement: { source: 'reported', confidence: 'exact', sourceField: 'session_model_usage grouped by model' },
      cost: { amount: 0.0123, currency: 'USD', kind: 'reported' }
    })
    expect(events.some((entry) => entry.kind === 'session.lifecycle' &&
      (entry.payload as { relationshipType?: string }).relationshipType === 'continuation')).toBe(true)
    expect(events.find((entry) => entry.kind === 'message.text' &&
      (entry.payload as { text?: string }).text === 'Archived synthetic context.')?.timeline.modelContext[0].state)
      .toBe('archived')
    const archivedIndex = events.findIndex((entry) => entry.kind === 'message.text' &&
      (entry.payload as { text?: string }).text === 'Archived synthetic context.')
    const compactionIndex = events.findIndex((entry) => entry.kind === 'context.compaction')
    const activeIndex = events.findIndex((entry) => entry.kind === 'message.text' &&
      (entry.payload as { text?: string }).text === 'Locate hermes-db-search-needle.')
    expect(archivedIndex).toBeLessThan(compactionIndex)
    expect(compactionIndex).toBeLessThan(activeIndex)
    expect(events.some((entry) => entry.kind === 'session.lifecycle' &&
      JSON.stringify(entry.payload).includes('metadata.title:Synthetic Hermes DB'))).toBe(true)
  })

  it('classifies branch, delegate, and compression lineage only from pinned Hermes evidence', async () => {
    const { home, dbPath } = setup()
    const db = new Database(dbPath)
    db.exec(fs.readFileSync(fixture('state-db-relationships.sql'), 'utf8'))
    db.close()
    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const sources = await provider.discover(signal)
    const expected = new Map([
      ['synthetic-hermes-db', 'continuation'],
      ['synthetic-hermes-branch', 'fork'],
      ['synthetic-hermes-delegate', 'subagent'],
      ['synthetic-hermes-unclassified', 'related']
    ])

    for (const [sessionId, relationshipType] of expected) {
      const source = sources.find((entry) => entry.stableId === `hermes:db:${sessionId}`)!
      const fingerprint = await provider.fingerprint(source, signal)
      const chunks = await provider.parse(source, fingerprint, signal)
      const relationship = allEvents(chunks).find((entry) => entry.kind === 'session.lifecycle' &&
        Object.hasOwn(entry.payload as object, 'relationshipType'))
      expect(relationship?.payload).toMatchObject({ relationshipType })
      if (relationshipType === 'related') {
        expect(chunks[0].diagnostics.map((entry) => entry.code)).toContain('hermes-parent-relationship-unclassified')
      }
    }
    expect(HERMES_PROVIDER_MANIFEST.capabilities.subagents.status).toBe('experimental')
  })

  it('attributes v23 session_model_usage to every model instead of the session initial model', async () => {
    const { home, dbPath } = setup()
    const db = new Database(dbPath)
    db.exec(fs.readFileSync(fixture('state-db-multi-model-usage.sql'), 'utf8'))
    db.close()
    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === 'hermes:db:synthetic-hermes-db')!
    const fingerprint = await provider.fingerprint(source, signal)
    const chunks = await provider.parse(source, fingerprint, signal)
    const usage = allEvents(chunks).filter((entry) => entry.kind === 'usage').map((entry) => entry.payload)

    expect(usage).toHaveLength(2)
    expect(usage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modelId: 'synthetic-model-db',
        input: { total: 100, uncached: 80, cacheRead: 15, cacheWrite5m: 5, cacheWrite1h: null },
        output: { total: 25, visible: 17, reasoning: 8 },
        measurement: { source: 'reported', confidence: 'exact', sourceField: 'session_model_usage grouped by model' },
        cost: { amount: 0.009, currency: 'USD', kind: 'reported' }
      }),
      expect.objectContaining({
        modelId: 'synthetic-vision-model',
        input: { total: 25, uncached: 20, cacheRead: 5, cacheWrite5m: 0, cacheWrite1h: null },
        output: { total: 5, visible: 3, reasoning: 2 },
        measurement: { source: 'reported', confidence: 'exact', sourceField: 'session_model_usage grouped by model' },
        cost: { amount: 0.0033, currency: 'USD', kind: 'reported' }
      })
    ]))
  })

  it('keeps aggregate usage unattributed when per-model rows are unavailable', async () => {
    const { home, dbPath } = setup()
    const db = new Database(dbPath)
    db.prepare('DELETE FROM session_model_usage WHERE session_id = ?').run('synthetic-hermes-db')
    db.close()
    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === 'hermes:db:synthetic-hermes-db')!
    const fingerprint = await provider.fingerprint(source, signal)
    const chunks = await provider.parse(source, fingerprint, signal)
    const usage = allEvents(chunks).find((entry) => entry.kind === 'usage')

    expect(usage?.payload).toMatchObject({
      modelId: null,
      input: { total: 125, uncached: 100, cacheRead: 20, cacheWrite5m: 5 },
      output: { total: 30, visible: 20, reasoning: 10 },
      measurement: { source: 'reported', confidence: 'high' },
      cost: { amount: 0.0123, currency: 'USD', kind: 'reported' }
    })
    expect(chunks[0].diagnostics.map((entry) => entry.code))
      .toContain('hermes-model-usage-attribution-unavailable')
  })

  it('parses legacy JSON and represents missing usage explicitly without inventing counters or Resume', async () => {
    const { home } = setup()
    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.kind === 'file')!
    const fingerprint = await provider.fingerprint(source, signal)
    const chunks = await provider.parse(source, fingerprint, signal)
    const events = allEvents(chunks)

    expect(chunks[0].formatVersion).toBe(HERMES_JSON_FORMAT)
    expect(events.find((entry) => entry.kind === 'usage')?.payload).toMatchObject({
      modelId: 'synthetic-model-json',
      input: { total: null, uncached: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
      output: { total: null, visible: null, reasoning: null },
      providerTotal: null,
      measurement: { source: 'unavailable', confidence: 'unavailable', sourceField: null },
      cost: null
    })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message.reasoning' }),
      expect.objectContaining({ kind: 'tool.call' }),
      expect.objectContaining({ kind: 'tool.result' })
    ]))
    expect(chunks[0].diagnostics.map((entry) => entry.code)).toContain('hermes-json-usage-unavailable')
    expect(chunks[0].diagnostics.map((entry) => entry.code)).toContain('hermes-json-resume-unavailable')
  })

  it('tolerates old DB schemas and preserves malformed tool data as an explicit unknown event', async () => {
    const { root } = setup()
    const oldPath = path.join(root, 'old-state.db')
    const db = new Database(oldPath)
    db.exec(fs.readFileSync(fixture('state-db-legacy.sql'), 'utf8'))
    db.close()
    const provider = createHermesProvider({ homeDir: root, sessionRoots: [], stateDbPath: oldPath })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal))[0]
    const fingerprint = await provider.fingerprint(source, signal)
    const chunks = await provider.parse(source, fingerprint, signal)

    expect(allEvents(chunks)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message.text' }),
      expect.objectContaining({ kind: 'unknown' })
    ]))
    expect(chunks[0].diagnostics.map((entry) => entry.code)).toContain('hermes-tool-calls-malformed')
  })

  it('rejects a DB parse when the logical source changes after fingerprinting', async () => {
    const { home, dbPath } = setup()
    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === 'hermes:db:synthetic-hermes-db')!
    const fingerprint = await provider.fingerprint(source, signal)
    const db = new Database(dbPath)
    db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('Changed title', 'synthetic-hermes-db')
    db.close()

    await expect(provider.parse(source, fingerprint, signal)).rejects.toThrow('hermes-source-changed-during-parse')
  })

  it('passes protocol conformance but keeps --resume experimental until a launch produces observed anchors', async () => {
    const { home } = setup()
    const provider = createHermesProvider({ homeDir: home })
    const signal = new AbortController().signal
    const source = (await provider.discover(signal)).find((entry) => entry.stableId === 'hermes:db:synthetic-hermes-db')!
    const fingerprint = await provider.fingerprint(source, signal)
    const parsed = await provider.parse(source, fingerprint, signal)
    const envelopes: ProviderEnvelope[] = [
      { protocolVersion: PROVIDER_PROTOCOL_VERSION, messageId: randomUUID(), kind: 'hello',
        payload: helloForProviderV2(provider.manifest) },
      { protocolVersion: PROVIDER_PROTOCOL_VERSION, messageId: randomUUID(), kind: 'manifest', payload: provider.manifest },
      ...parsed.map((payload): ProviderEnvelope => ({
        protocolVersion: PROVIDER_PROTOCOL_VERSION, messageId: randomUUID(), kind: 'parse-chunk', payload
      }))
    ]
    expect(runProviderConformanceV2({ manifest: provider.manifest, envelopes })).toMatchObject({
      ok: true, providerId: 'swob/hermes', completedSessions: 1, issues: []
    })
    expect(buildResumeLaunchSpec('synthetic-hermes-db', undefined, undefined, 'hermes')).toMatchObject({
      executable: 'hermes', args: ['--resume', 'synthetic-hermes-db']
    })
    expect(provider.manifest.capabilities['terminal-resume']).toMatchObject({ status: 'experimental' })
    expect(verifyResumeContractV2(provider.manifest.resumeContract!, {
      launched: false,
      expectedSourceRefId: source.stableId,
      observedSourceRefId: null,
      sourceExists: true,
      expectedAnchors: { user: '', assistant: '' },
      observedDefaultMessages: [],
      observedAllMessages: []
    })).toMatchObject({ ok: false, status: 'launch-failed', sourceMatched: false })
  })
})
