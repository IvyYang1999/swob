import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  helloForProviderV2,
  ProviderChunkAssembler,
  runProviderConformanceV2,
  validateParseChunkV2,
  validateProviderEnvelopeV2,
  validateProviderManifestV2
} from '../../shared/provider-protocol-v2'
import { PROVIDER_PROTOCOL_VERSION } from '../../shared/provider-schema-v2.generated'
import { ProviderHost } from '../provider-host'
import { createTraeProvider, detectTraeModernEncryptedLayout, TRAE_CAPABILITY_MATRIX } from './trae-provider'

const temporaryRoots: string[] = []

interface TraeFixture {
  storageKey: string
  store: { list: Array<Record<string, unknown>> }
}

function fixture(): TraeFixture {
  return JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../testdata/trae/legacy-state-vscdb.json'),
    'utf8'
  )) as TraeFixture
}

function createFixtureDatabase(options: { root?: string; wal?: boolean } = {}): {
  root: string
  databasePath: string
  workspacePath: string
  writer: Database.Database
  data: TraeFixture
} {
  const root = options.root || fs.mkdtempSync(path.join(os.tmpdir(), 'swob-trae-provider-'))
  if (!options.root) temporaryRoots.push(root)
  const workspaceRoot = path.join(root, 'workspaceStorage', 'synthetic-workspace')
  const databasePath = path.join(workspaceRoot, 'state.vscdb')
  const workspacePath = path.join(workspaceRoot, 'workspace.json')
  fs.mkdirSync(workspaceRoot, { recursive: true })
  const writer = new Database(databasePath)
  if (options.wal) writer.pragma('journal_mode = WAL')
  writer.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
  const data = fixture()
  writer.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    .run(data.storageKey, JSON.stringify(data.store))
  fs.writeFileSync(workspacePath, JSON.stringify({ folder: 'file:///tmp/synthetic-trae-project' }))
  return { root, databasePath, workspacePath, writer, data }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Trae native Provider Protocol v2 runtime', () => {
  it('discovers a virtual session, includes workspace metadata in its fingerprint, and emits only evidenced events', async () => {
    const sample = createFixtureDatabase()
    const provider = createTraeProvider({ homeDir: sample.root, roots: [sample.root] })
    const signal = new AbortController().signal

    try {
      expect(TRAE_CAPABILITY_MATRIX.find((entry) => entry.layer === 'discover'))
        .toEqual({ layer: 'discover', measurement: 'exact', capability: 'experimental' })
      expect(TRAE_CAPABILITY_MATRIX.find((entry) => entry.layer === 'token'))
        .toEqual({ layer: 'token', measurement: 'unavailable', capability: 'unavailable' })
      expect(TRAE_CAPABILITY_MATRIX.find((entry) => entry.layer === 'resume'))
        .toEqual({ layer: 'resume', measurement: 'unavailable', capability: 'unavailable' })
      expect(validateProviderManifestV2(provider.manifest).ok).toBe(true)
      const sources = await provider.discover(signal)
      expect(sources).toHaveLength(1)
      expect(sources[0]).toMatchObject({
        kind: 'sqlite-row',
        providerId: 'swob/trae',
        stableId: 'trae:synthetic-trae-session',
        databaseUri: expect.stringContaining('state.vscdb'),
        primaryKey: { key: sample.data.storageKey, sessionId: 'synthetic-trae-session' }
      })

      const fingerprint = await provider.fingerprint(sources[0], signal)
      expect(fingerprint).toMatchObject({
        algorithm: 'composite-sha256',
        value: expect.stringMatching(/^[0-9a-f]{64}$/),
        inputs: ['state.vscdb:ItemTable/session', 'workspace.json']
      })
      const beforeWorkspaceChange = fingerprint.value
      fs.writeFileSync(sample.workspacePath, JSON.stringify({ folder: 'file:///tmp/moved-synthetic-project' }))
      expect((await provider.fingerprint(sources[0], signal)).value).not.toBe(beforeWorkspaceChange)
      fs.writeFileSync(sample.workspacePath, JSON.stringify({ folder: 'file:///tmp/synthetic-trae-project' }))

      const chunks = await provider.parse(sources[0], fingerprint, signal)
      const assembler = new ProviderChunkAssembler()
      for (const chunk of chunks) {
        expect(validateParseChunkV2(chunk).ok).toBe(true)
        assembler.accept(chunk)
      }
      expect(assembler.completedSessions()).toBe(1)
      const events = chunks.flatMap((chunk) => chunk.events)
      expect(events.map((event) => event.kind)).toEqual([
        'session.metadata',
        'message.text',
        'message.text',
        'message.text',
        'message.text',
        'message.text',
        'message.text',
        'unknown'
      ])
      expect(events[0].payload).toEqual({
        title: 'Synthetic Trae session',
        cwd: ['/tmp/synthetic-trae-project'],
        projectPath: '/tmp/synthetic-trae-project'
      })
      expect(JSON.stringify(events)).toContain('synthetic-trae-search-needle')
      expect(events.every((event) => event.timeline.modelContext[0].state === 'unknown')).toBe(true)
      expect(events.some((event) => event.kind === 'usage' || event.kind.startsWith('tool.'))).toBe(false)
      expect(events.at(-1)).toMatchObject({
        actor: 'unknown',
        kind: 'unknown',
        payload: { rawType: 'future-role' }
      })

      const envelopes = [
        {
          protocolVersion: PROVIDER_PROTOCOL_VERSION,
          messageId: randomUUID(),
          kind: 'hello' as const,
          payload: helloForProviderV2(provider.manifest)
        },
        {
          protocolVersion: PROVIDER_PROTOCOL_VERSION,
          messageId: randomUUID(),
          kind: 'manifest' as const,
          payload: provider.manifest
        },
        ...chunks.map((chunk) => ({
          protocolVersion: PROVIDER_PROTOCOL_VERSION,
          messageId: randomUUID(),
          kind: 'parse-chunk' as const,
          payload: chunk
        }))
      ]
      expect(runProviderConformanceV2({ manifest: provider.manifest, envelopes })).toMatchObject({
        ok: true,
        providerId: 'swob/trae',
        completedSessions: 1
      })
    } finally {
      sample.writer.close()
    }
  })

  it('reads a WAL database consistently and isolates one malformed virtual session at host parse time', async () => {
    const sample = createFixtureDatabase({ wal: true })
    const malformed = {
      sessionId: 'synthetic-trae-malformed',
      title: 'Malformed synthetic session',
      updatedAt: 1754006470000,
      messages: 'not-an-array'
    }
    sample.data.store.list.push(malformed)
    sample.writer.prepare('UPDATE ItemTable SET value = ? WHERE key = ?')
      .run(JSON.stringify(sample.data.store), sample.data.storageKey)
    const provider = createTraeProvider({ homeDir: sample.root, roots: [sample.root] })

    try {
      const report = (await new ProviderHost({ runtimes: [], v2Runtimes: [provider] }).runAll())[0]
      expect(report.discoveredSources.map((source) => source.stableId).sort()).toEqual([
        'trae:synthetic-trae-malformed',
        'trae:synthetic-trae-session'
      ])
      expect(report.outcomes).toHaveLength(0)
      expect(report.consumerProjections).toHaveLength(0)
      expect(report.v2Chunks.length).toBeGreaterThan(0)
      expect(report.errors).toMatchObject([{
        code: 'provider-failed',
        providerError: { sourceRefId: 'trae:synthetic-trae-malformed' }
      }])
    } finally {
      sample.writer.close()
    }
  })

  it('chunks a large legacy transcript under both event-count and envelope-byte limits', async () => {
    const sample = createFixtureDatabase()
    const messages = Array.from({ length: 2_300 }, (_, index) => ({
      id: `synthetic-message-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `synthetic bounded event ${index}`,
      timestamp: 1754006400000 + index
    }))
    sample.data.store.list[0].messages = messages
    sample.writer.prepare('UPDATE ItemTable SET value = ? WHERE key = ?')
      .run(JSON.stringify(sample.data.store), sample.data.storageKey)
    const provider = createTraeProvider({ homeDir: sample.root, roots: [sample.root] })
    const signal = new AbortController().signal

    try {
      const source = (await provider.discover(signal))[0]
      const fingerprint = await provider.fingerprint(source, signal)
      const chunks = await provider.parse(source, fingerprint, signal)
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.flatMap((chunk) => chunk.events)).toHaveLength(2_301)
      const assembler = new ProviderChunkAssembler()
      for (const chunk of chunks) {
        expect(chunk.events.length).toBeLessThanOrEqual(2_048)
        expect(validateParseChunkV2(chunk).ok).toBe(true)
        expect(validateProviderEnvelopeV2({
          protocolVersion: PROVIDER_PROTOCOL_VERSION,
          messageId: randomUUID(),
          kind: 'parse-chunk',
          payload: chunk
        }).ok).toBe(true)
        assembler.accept(chunk)
      }
      expect(assembler.completedSessions()).toBe(1)
    } finally {
      sample.writer.close()
    }
  })

  it('recognizes the modern encrypted ModularData database as an unsupported layout', () => {
    const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-trae-modern-'))
    temporaryRoots.push(appRoot)
    const profileRoot = path.join(appRoot, 'User')
    const databasePath = path.join(appRoot, 'ModularData', 'ai-agent', 'database.db')
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    fs.writeFileSync(databasePath, Buffer.from('Z6\x19\x00synthetic-encrypted-layout'))
    expect(detectTraeModernEncryptedLayout(profileRoot)).toBe(true)

    fs.writeFileSync(databasePath, Buffer.from('SQLite format 3\0synthetic-plaintext-layout'))
    expect(detectTraeModernEncryptedLayout(profileRoot)).toBe(false)
  })
})
