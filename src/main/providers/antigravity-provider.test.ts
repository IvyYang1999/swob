import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { validateProviderManifestV2, validateParseChunkV2 } from '../../shared/provider-protocol-v2'
import { closeCanonicalSessionStore, getCanonicalSessionStore } from '../canonical-store'
import { initLibrary, scanLibrary } from '../library-manager'
import { ProviderHost } from '../provider-host'
import { projectNativeV2ChunksForConsumers } from '../provider-v2-consumer-projection'
import { refreshCanonicalProviders } from '../provider-runtime'
import { closeSearchIndex, searchFTS } from '../search-index'
import { loadSessionDetail } from '../session-loader'
import {
  ANTIGRAVITY_CAPABILITY_MATRIX,
  ANTIGRAVITY_MANIFEST_V2,
  antigravityCliSupportsConversation,
  buildAntigravityResumeArgs,
  createAntigravityProvider
} from './antigravity-provider'
import { probeAntigravityResumeCapability } from './antigravity-resume'

const FIXTURE_ID = '11111111-2222-4333-8444-555555555555'
const CHILD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const fixtureRoot = path.resolve(__dirname, '../../../testdata/antigravity')
const expectedConformanceTestIds = [
  'antigravity-v2.discovery.composite-root',
  'antigravity-v2.metadata.matching-history-row',
  'antigravity-v2.messages.ordered-source-blocks',
  'antigravity-v2.tools.call-result-pairing',
  'antigravity-v2.system-compact.checkpoint-not-compaction',
  'antigravity-v2.tokens.known-schema-counters',
  'antigravity-v2.relationships.structured-conversation-id',
  'antigravity-v2.resume.help-preflight'
] as const
const tempRoots: string[] = []
const signal = new AbortController().signal

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-antigravity-${label}-`))
  tempRoots.push(root)
  return root
}

function installJsonlFixture(home: string): { root: string; transcript: string } {
  const root = path.join(home, '.gemini', 'antigravity-cli')
  const brain = path.join(root, 'brain', FIXTURE_ID)
  const transcript = path.join(brain, '.system_generated', 'logs', 'transcript.jsonl')
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.copyFileSync(path.join(fixtureRoot, 'transcript.jsonl'), transcript)
  fs.copyFileSync(path.join(fixtureRoot, 'implementation_plan.md'), path.join(brain, 'implementation_plan.md'))
  fs.copyFileSync(path.join(fixtureRoot, 'history.jsonl'), path.join(root, 'history.jsonl'))
  return { root, transcript }
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  bytes.push(remaining)
  return Buffer.from(bytes)
}

function protoVarint(field: number, value: number): Buffer {
  return Buffer.concat([varint(field * 8), varint(value)])
}

function protoBytes(field: number, value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes])
}

const BASELINE_SCHEMA = [
  'CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))',
  'CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))',
  'CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`))',
  'CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`))',
  'CREATE INDEX `idx_steps_status` ON `steps`(`status`)',
  'CREATE INDEX `idx_steps_step_type` ON `steps`(`step_type`)'
] as const

function createKnownSchemaDatabase(databasePath: string): void {
  const usageFixture = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, 'known-sqlite-usage.json'), 'utf8')
  ) as {
    timestampSeconds: number
    userText: string
    assistantText: string
    providerInputLimit: number
    uncachedInputTokens: number
    outputTokens: number
    cacheReadTokens: number
    modelId: string
  }
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new Database(databasePath)
  try {
    for (const statement of BASELINE_SCHEMA) database.exec(statement)
    database.pragma('user_version = 1')
    const timestamp = protoBytes(5, protoVarint(1, usageFixture.timestampSeconds))
    const user = Buffer.concat([timestamp, protoBytes(17, usageFixture.userText)])
    const assistant = Buffer.concat([timestamp, protoBytes(17, usageFixture.assistantText)])
    const insert = database.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)')
    insert.run(0, 14, user)
    insert.run(1, 17, assistant)
    const tokenBlock = Buffer.concat([
      protoVarint(1, usageFixture.providerInputLimit),
      protoVarint(2, usageFixture.uncachedInputTokens),
      protoVarint(3, usageFixture.outputTokens),
      protoVarint(5, usageFixture.cacheReadTokens),
      protoBytes(21, usageFixture.modelId)
    ])
    database.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
      .run(1, tokenBlock, tokenBlock.length)
  } finally {
    database.close()
  }
}

afterEach(() => {
  closeSearchIndex()
  closeCanonicalSessionStore()
  while (tempRoots.length > 0) fs.rmSync(tempRoots.pop()!, { recursive: true, force: true })
})

describe('Antigravity native Provider Protocol v2', () => {
  it('declares an eight-layer evidence matrix and a conforming honest manifest', () => {
    expect(ANTIGRAVITY_CAPABILITY_MATRIX.map((entry) => entry.layer)).toEqual([
      'discovery', 'metadata', 'messages', 'tools', 'system-compact', 'tokens', 'relationships', 'resume'
    ])
    expect(ANTIGRAVITY_CAPABILITY_MATRIX.some((entry) => entry.status === 'estimated')).toBe(false)
    expect(ANTIGRAVITY_CAPABILITY_MATRIX.map((entry) => entry.conformanceTestId))
      .toEqual(expectedConformanceTestIds)
    expect(new Set(ANTIGRAVITY_CAPABILITY_MATRIX.map((entry) => entry.conformanceTestId)).size).toBe(8)
    for (const entry of ANTIGRAVITY_CAPABILITY_MATRIX) {
      expect(entry.fixture).toMatch(/^testdata\/antigravity\/[a-z0-9._-]+$/)
      expect(fs.existsSync(path.resolve(__dirname, '../../..', entry.fixture))).toBe(true)
      expect(entry.conformanceTestId).toMatch(/^antigravity-v2\.[a-z0-9-]+\.[a-z0-9-]+$/)
    }
    expect(ANTIGRAVITY_CAPABILITY_MATRIX.find((entry) => entry.layer === 'tokens')?.limit)
      .toContain('chars/4 is not used')
    expect(validateProviderManifestV2(ANTIGRAVITY_MANIFEST_V2).ok).toBe(true)
  })

  it('discovers a composite JSONL/Markdown/history source and directly emits ordered v2 facts', async () => {
    const home = tempRoot('jsonl')
    const { root } = installJsonlFixture(home)
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)

    expect(source).toMatchObject({
      kind: 'composite-directory',
      providerId: 'swob/antigravity',
      stableId: `antigravity:cli:${FIXTURE_ID}`
    })
    if (source.kind !== 'composite-directory') throw new Error('expected composite Antigravity source')
    expect(source.memberUris).toHaveLength(2)
    const fingerprint = await provider.fingerprint(source, signal)
    expect(fingerprint.algorithm).toBe('composite-sha256')
    expect(await provider.inputBytes(source, signal)).toBeGreaterThan(0)

    const chunks = await provider.parse(source, fingerprint, signal)
    expect(chunks).toHaveLength(1)
    expect(validateParseChunkV2(chunks[0]).ok).toBe(true)
    const events = chunks[0].events
    expect(events.filter((event) => event.kind === 'usage')).toHaveLength(0)
    expect(events.map((event) => event.kind)).toEqual(expect.arrayContaining([
      'message.text', 'message.thinking', 'model.changed', 'tool.call', 'tool.result',
      'subagent.spawn', 'session.lifecycle', 'artifact'
    ]))
    const planner = events.filter((event) => event.messageId === 'agy-message:1')
    expect(planner.map((event) => [event.kind, event.messageBlockIndex])).toEqual([
      ['message.thinking', 0], ['message.text', 1], ['tool.call', 2]
    ])
    expect(events.find((event) => event.kind === 'tool.result')?.payload)
      .toMatchObject({ callId: 'tool-read-1', output: 'synthetic-antigravity-search-needle' })
    expect(events.find((event) => event.kind === 'subagent.spawn')?.payload)
      .toEqual({ agentId: CHILD_ID, parentAgentId: FIXTURE_ID })
    expect(events.find((event) => event.kind === 'artifact')?.timestamp)
      .toBe('2026-08-01T00:00:00.000Z')
    expect(events.some((event) => event.kind === 'context.compaction')).toBe(false)

    const projected = projectNativeV2ChunksForConsumers(
      provider.manifest.providerId,
      provider.manifest.parserDataVersion,
      [source],
      chunks
    )[0].sessions[0].records
    expect(projected.find((record) => record.recordType === 'session')).toMatchObject({
      providerTitle: 'Inspect the synthetic workspace',
      projectPath: '/workspace/synthetic-antigravity',
      cwd: ['/workspace/synthetic-antigravity']
    })
    expect(projected.some((record) => record.recordType === 'tool-call' && record.name === 'view_file')).toBe(true)
    expect(projected.some((record) => record.recordType === 'artifact')).toBe(true)
  })

  it('decodes provider token counters only for the pinned known SQLite schema', async () => {
    const home = tempRoot('sqlite')
    const root = path.join(home, '.gemini', 'antigravity-cli')
    const databasePath = path.join(root, 'conversations', `${FIXTURE_ID}.db`)
    createKnownSchemaDatabase(databasePath)
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    const usage = chunks.flatMap((chunk) => chunk.events).find((event) => event.kind === 'usage')

    expect(usage?.payload).toMatchObject({
      modelId: 'synthetic-gemini-model',
      input: { total: 140, uncached: 120, cacheRead: 20 },
      output: { total: 30, visible: null, reasoning: null },
      providerTotal: 170,
      measurement: { source: 'derived', confidence: 'high' },
      cost: null,
      priceRevision: null
    })
  })

  it('uses JSONL for transcript order while enriching usage from a matching known-schema database', async () => {
    const home = tempRoot('multi-source')
    const { root } = installJsonlFixture(home)
    createKnownSchemaDatabase(path.join(root, 'conversations', `${FIXTURE_ID}.db`))
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)
    const events = chunks.flatMap((chunk) => chunk.events)

    expect(events.some((event) => event.kind === 'message.text' &&
      JSON.stringify(event.payload).includes('Inspect the synthetic workspace'))).toBe(true)
    expect(events.some((event) => event.kind === 'message.text' &&
      JSON.stringify(event.payload).includes('Synthetic SQLite prompt'))).toBe(false)
    expect(events.filter((event) => event.kind === 'usage')).toHaveLength(1)
  })

  it('fails closed on an unknown SQLite schema and preserves the reason as a diagnostic', async () => {
    const home = tempRoot('unknown-db')
    const root = path.join(home, '.gemini', 'antigravity-cli')
    const databasePath = path.join(root, 'conversations', `${FIXTURE_ID}.db`)
    fs.mkdirSync(path.dirname(databasePath), { recursive: true })
    const database = new Database(databasePath)
    database.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
    database.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 14, protoBytes(17, 'must-not-be-guessed'))
    database.close()
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)

    expect(chunks[0].diagnostics).toMatchObject([{ code: 'antigravity-sqlite-schema-unrecognized' }])
    expect(chunks.flatMap((chunk) => chunk.events).some((event) =>
      JSON.stringify(event.payload).includes('must-not-be-guessed'))).toBe(false)
    expect(chunks.flatMap((chunk) => chunk.events)).toMatchObject([
      { kind: 'session.lifecycle', payload: { phase: 'unavailable:antigravity-sqlite-schema-unrecognized' } }
    ])
  })

  it('detects encrypted protobuf without reading secrets or inventing transcript content', async () => {
    const home = tempRoot('encrypted-pb')
    const root = path.join(home, '.gemini', 'antigravity-cli')
    const protobufPath = path.join(root, 'conversations', `${FIXTURE_ID}.pb`)
    fs.mkdirSync(path.dirname(protobufPath), { recursive: true })
    fs.writeFileSync(protobufPath, Buffer.from('synthetic-encrypted-bytes-never-rendered'))
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)

    expect(chunks[0].formatVersion).toBe('antigravity-encrypted-protobuf-unknown')
    expect(chunks[0].diagnostics).toMatchObject([{ code: 'antigravity-encrypted-protobuf-unavailable' }])
    expect(chunks.flatMap((chunk) => chunk.events)).toMatchObject([
      { kind: 'session.lifecycle', payload: { phase: 'unsupported-encrypted-protobuf' } }
    ])
    expect(JSON.stringify(chunks)).not.toContain('synthetic-encrypted-bytes-never-rendered')
  })

  it('rejects composite members outside the discovered Antigravity root', async () => {
    const home = tempRoot('path-boundary')
    const { root } = installJsonlFixture(home)
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)
    if (source.kind !== 'composite-directory') throw new Error('expected composite Antigravity source')
    const escaped = {
      ...source,
      memberUris: [...source.memberUris, 'file:///tmp/synthetic-outside-antigravity-root']
    }

    await expect(provider.parse(escaped, source.fingerprint, signal))
      .rejects.toThrow('antigravity-source-member-outside-root')
  })

  it('keeps malformed JSONL partial and never fabricates token usage', async () => {
    const home = tempRoot('malformed')
    const { root, transcript } = installJsonlFixture(home)
    fs.appendFileSync(transcript, '\n{"step_index":8,"type":')
    const provider = createAntigravityProvider({ homeDir: home, roots: [root] })
    const [source] = await provider.discover(signal)
    const chunks = await provider.parse(source, await provider.fingerprint(source, signal), signal)

    expect(chunks[0].diagnostics).toMatchObject([{ code: 'antigravity-jsonl-malformed' }])
    expect(chunks.flatMap((chunk) => chunk.events).filter((event) => event.kind === 'usage')).toHaveLength(0)
  })

  it('uses --conversation only after help output proves the capability', () => {
    const help = fs.readFileSync(path.join(fixtureRoot, 'agy-help.txt'), 'utf8')
    expect(antigravityCliSupportsConversation(help)).toBe(true)
    expect(buildAntigravityResumeArgs(FIXTURE_ID, help)).toEqual(['--conversation', FIXTURE_ID])
    expect(() => buildAntigravityResumeArgs(FIXTURE_ID, 'Usage: agy --resume <id>'))
      .toThrow('antigravity-conversation-flag-unavailable')
    expect(() => buildAntigravityResumeArgs('../unsafe', help)).toThrow('antigravity-conversation-id-invalid')
  })

  it('reports a missing or incompatible local agy binary as unavailable', async () => {
    await expect(probeAntigravityResumeCapability(async () => ({
      stdout: 'Usage: agy --resume <id>', stderr: ''
    }))).resolves.toMatchObject({ available: false, reason: 'conversation-flag-unavailable' })
    await expect(probeAntigravityResumeCapability(async () => {
      const error = new Error('not found') as NodeJS.ErrnoException
      error.code = 'ENOENT'
      throw error
    })).resolves.toEqual({ available: false, reason: 'binary-unavailable', helpOutput: null })
  })

  it('runs direct-v2 through sidebar/search/Vault/detail consumers without v1 migration', async () => {
    const root = tempRoot('full-chain')
    const home = path.join(root, 'home')
    const libraryRoot = path.join(root, 'Vault')
    const previous = {
      home: process.env.HOME,
      search: process.env.SWOB_SEARCH_INDEX_DIR,
      canonical: process.env.SWOB_CANONICAL_STORE_DIR
    }
    process.env.HOME = home
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search')
    process.env.SWOB_CANONICAL_STORE_DIR = path.join(root, 'canonical')
    const { transcript } = installJsonlFixture(home)
    closeSearchIndex()
    closeCanonicalSessionStore()
    initLibrary(libraryRoot)
    scanLibrary()
    try {
      const provider = createAntigravityProvider({ homeDir: home })
      const result = await refreshCanonicalProviders({
        host: new ProviderHost({ runtimes: [], v2Runtimes: [provider] }),
        store: getCanonicalSessionStore(),
        archive: true
      })
      expect(result.reports[0]).toMatchObject({ runtimeProtocolVersion: 2, outcomes: [] })
      expect(result.changedSessionRecordIds).toHaveLength(1)
      expect(searchFTS('synthetic-antigravity-search-needle')).toHaveLength(1)
      expect(searchFTS('synthetic-antigravity-artifact-needle')).toHaveLength(1)
      const packageDirs = fs.readdirSync(libraryRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(libraryRoot, entry.name))
      expect(packageDirs.some((dir) => fs.existsSync(path.join(dir, 'transcript.md')))).toBe(true)

      const detail = await loadSessionDetail(transcript)
      expect(detail?.messages.some((message) => JSON.stringify(message).includes('The synthetic workspace is ready.'))).toBe(true)
      expect(detail?.messages.some((message) => JSON.stringify(message).includes('view_file'))).toBe(true)
    } finally {
      closeSearchIndex()
      closeCanonicalSessionStore()
      if (previous.home === undefined) delete process.env.HOME
      else process.env.HOME = previous.home
      if (previous.search === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
      else process.env.SWOB_SEARCH_INDEX_DIR = previous.search
      if (previous.canonical === undefined) delete process.env.SWOB_CANONICAL_STORE_DIR
      else process.env.SWOB_CANONICAL_STORE_DIR = previous.canonical
    }
  })
})
