import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import type { CanonicalRecord, ParseOutcome, ProviderManifest, SourceRef } from '../shared/provider-schema.generated'
import piGolden from '../../schema/fixtures/v2/pi-golden.json'
import type {
  ParseChunk as ParseChunkV2,
  ProviderManifest as ProviderManifestV2
} from '../shared/provider-schema-v2.generated'
import { closeCanonicalSessionStore, getCanonicalSessionStore } from './canonical-store'
import { canonicalRecordsToSessionSummary } from './canonical-projection'
import {
  CANONICAL_PROVENANCE_FILE,
  CANONICAL_RECORDS_FILE
} from './canonical-package'
import { ProviderHost, type BuiltinProviderRuntime, type BuiltinProviderRuntimeV2 } from './provider-host'
import {
  refreshCanonicalProviders,
  withCanonicalProviderRefreshBarrier
} from './provider-runtime'
import { createPiProvider } from './providers/pi-provider'
import { createKimiProvider } from './providers/kimi-provider'
import { createHermesProvider } from './providers/hermes-provider'
import { createTraeProvider } from './providers/trae-provider'
import { closeSearchIndex, searchFTS } from './search-index'

let root = ''
let home = ''
let libraryRoot = ''
let searchRoot = ''
let previousHome: string | undefined
let previousSearchRoot: string | undefined
let previousCanonicalRoot: string | undefined
let library: typeof import('./library-manager')

function fixturePath(): string {
  return path.resolve(__dirname, '../../testdata/pi/session.jsonl')
}

function hermesFixture(name: string): string {
  return path.resolve(__dirname, `../../testdata/hermes/${name}`)
}

function packageDirs(): string[] {
  return fs.readdirSync(libraryRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(libraryRoot, entry.name))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, '.swob-session.json')))
    .sort()
}

function remoteRecords(sessionId: string, sourceRef: SourceRef): CanonicalRecord[] {
  const provenance = {
    providerId: 'swob/pi',
    sourceRefId: sourceRef.stableId,
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    observedAt: '2026-07-23T00:00:00.000Z'
  }
  const sessionRecordId = `remote-session-record:${sessionId}`
  return [
    {
      id: sessionRecordId,
      recordType: 'session',
      sourceRef,
      sourceSessionId: sessionId,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:01:00.000Z',
      cwd: ['/remote/project'],
      projectPath: '/remote/project',
      providerTitle: `Remote ${sessionId}`,
      provenance
    },
    {
      id: `remote-message-record:${sessionId}`,
      recordType: 'message',
      sessionRecordId,
      ordinal: 0,
      role: 'user',
      timestamp: '2026-07-23T00:00:01.000Z',
      content: [{ kind: 'text', text: `fanout ${sessionId}` }],
      provenance
    }
  ]
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-provider-runtime-'))
  home = path.join(root, 'home')
  libraryRoot = path.join(root, 'Library')
  searchRoot = path.join(root, 'search')
  fs.mkdirSync(home, { recursive: true })
  previousHome = process.env.HOME
  previousSearchRoot = process.env.SWOB_SEARCH_INDEX_DIR
  previousCanonicalRoot = process.env.SWOB_CANONICAL_STORE_DIR
  process.env.HOME = home
  process.env.SWOB_SEARCH_INDEX_DIR = searchRoot
  process.env.SWOB_CANONICAL_STORE_DIR = path.join(root, 'canonical-store')
  closeSearchIndex()
  closeCanonicalSessionStore()
  library = await import('./library-manager')
  library.initLibrary(libraryRoot)
  library.scanLibrary()
})

afterEach(() => {
  closeSearchIndex()
  closeCanonicalSessionStore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousSearchRoot === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = previousSearchRoot
  if (previousCanonicalRoot === undefined) delete process.env.SWOB_CANONICAL_STORE_DIR
  else process.env.SWOB_CANONICAL_STORE_DIR = previousCanonicalRoot
  fs.rmSync(root, { recursive: true, force: true })
})

describe('canonical provider runtime full chain', () => {
  it('runs a synthetic Trae legacy session through discover, native store, search, and Library', async () => {
    const fixture = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../testdata/trae/legacy-state-vscdb.json'),
      'utf8'
    ))
    const traeRoot = path.join(home, 'Library', 'Application Support', 'Trae', 'User')
    const workspaceRoot = path.join(traeRoot, 'workspaceStorage', 'synthetic-workspace')
    const databasePath = path.join(workspaceRoot, 'state.vscdb')
    fs.mkdirSync(workspaceRoot, { recursive: true })
    const database = new Database(databasePath)
    database.pragma('journal_mode = WAL')
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(fixture.storageKey, JSON.stringify(fixture.store))
    database.close()
    fs.writeFileSync(
      path.join(workspaceRoot, 'workspace.json'),
      JSON.stringify({ folder: 'file:///tmp/synthetic-trae-project' })
    )
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({
      runtimes: [],
      v2Runtimes: [createTraeProvider({ homeDir: home, roots: [traeRoot] })]
    })

    const result = await refreshCanonicalProviders({ host, store, archive: true })
    expect(result.reports[0].errors, JSON.stringify(result.reports[0].errors)).toHaveLength(0)
    expect(result.reports[0].v2Chunks.length).toBeGreaterThan(0)
    expect(result.changedSessionRecordIds).toHaveLength(1)
    expect(store.listSessions('swob/trae')).toHaveLength(1)
    expect(store.listSessions('swob/trae')[0].sessionRecord.providerTitle).toBe('Synthetic Trae session')
    expect(searchFTS('synthetic-trae-search-needle')).toHaveLength(1)
    expect(packageDirs()).toHaveLength(1)

    const recordsPath = path.join(packageDirs()[0], CANONICAL_RECORDS_FILE)
    expect(fs.readFileSync(recordsPath, 'utf8')).toContain('synthetic-trae-search-needle')
    const detail = await (await import('./session-loader')).loadSessionDetail(recordsPath)
    expect(detail).toMatchObject({ source: 'trae', projectPath: '/tmp/synthetic-trae-project' })
    expect(detail?.messages.flatMap((message) => message.toolCalls)).toEqual([])
    expect(detail?.tokenAccounting).toMatchObject({
      provider: 'trae', provenance: 'unavailable', billingTotal: null, conversationOnly: null
    })
    const sourceDetail = await (await import('./session-loader')).loadSessionDetail(
      store.listSessions('swob/trae')[0].sessionRecord.sourceRef.displayLocator,
      undefined,
      undefined,
      undefined,
      undefined,
      result.changedSessionRecordIds[0]
    )
    expect(sourceDetail?.messages.some((message) =>
      message.textContent.includes('Inspect the synthetic workspace'))).toBe(true)
    expect(library.getSessionResumeAvailability('synthetic-trae-session', detail || undefined))
      .toMatchObject({ canResume: false })
  })

  it('runs Kimi native-v2 through sidebar read model, search and Vault without a v1 provider outcome', async () => {
    fs.cpSync(path.resolve('testdata/kimi/home/.kimi-code'), path.join(home, '.kimi-code'), { recursive: true })
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({
      runtimes: [],
      v2Runtimes: [createKimiProvider({ homeDir: home })]
    })

    const result = await refreshCanonicalProviders({ host, store, archive: true })

    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]).toMatchObject({
      providerId: 'swob/kimi',
      runtimeProtocolVersion: 2,
      outcomes: [],
      errors: []
    })
    expect(result.reports[0].v2Chunks).toHaveLength(3)
    expect(result.reports[0].consumerProjections).toHaveLength(3)
    expect(result.changedSessionRecordIds).toHaveLength(3)
    expect(store.listSessions('swob/kimi')).toHaveLength(3)
    expect(store.listSessions('swob/kimi').some((session) =>
      session.sessionRecord.providerTitle === 'Synthetic Kimi native session' &&
      session.sessionRecord.projectPath === '/workspace/synthetic-kimi')).toBe(true)
    expect(searchFTS('synthetic-kimi-search-needle')).toHaveLength(1)
    expect(searchFTS('synthetic-kimi-migrated-needle')).toHaveLength(1)
    expect(packageDirs()).toHaveLength(3)
    const packageRecords = packageDirs().map((dirPath) =>
      fs.readFileSync(path.join(dirPath, CANONICAL_RECORDS_FILE), 'utf8'))
    expect(packageRecords.some((content) => content.includes('I should inspect only the fixture.'))).toBe(true)
    expect(packageRecords.some((content) => content.includes('synthetic-kimi-search-needle'))).toBe(true)
    expect(result.reports[0].v2Chunks.every((chunk) =>
      store.getV2Session(chunk.identity.logicalSessionKey, chunk.identity.branchViewId)?.complete === true)).toBe(true)
  })

  it('projects a pure native-v2 runtime into sidebar/search/Vault consumers without v1 migration', async () => {
    const sourcePath = path.join(home, '.pi', 'agent', 'sessions', 'native-v2.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, '{"synthetic":true}\n')
    const manifest = structuredClone(piGolden.manifest) as unknown as ProviderManifestV2
    manifest.displayName = 'Pi'
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunkV2
    const fingerprint = { algorithm: 'sha256' as const, value: 'native-v2-source' }
    const stableId = 'pi:native-v2-source'
    chunk.fingerprint = fingerprint
    chunk.identity.physicalSourceId = stableId
    for (const event of chunk.events) {
      event.identity.physicalSourceId = stableId
      event.provenance.sourceRefId = stableId
    }
    const sourceRef: SourceRef = {
      kind: 'file',
      providerId: manifest.providerId,
      stableId,
      uri: pathToFileURL(sourcePath).href,
      displayLocator: sourcePath,
      fingerprint
    }
    const runtime: BuiltinProviderRuntimeV2 = {
      manifest,
      discover: async () => [sourceRef],
      fingerprint: async () => fingerprint,
      inputBytes: async () => fs.statSync(sourcePath).size,
      parse: async () => [chunk]
    }
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({ runtimes: [], v2Runtimes: [runtime] })

    const result = await refreshCanonicalProviders({ host, store, archive: true })

    expect(result.reports[0]).toMatchObject({
      runtimeProtocolVersion: 2,
      outcomes: [],
      errors: []
    })
    expect(result.reports[0].consumerProjections).toHaveLength(1)
    expect(result.changedSessionRecordIds).toHaveLength(1)
    expect(store.listSessions('swob/pi')).toHaveLength(1)
    expect(store.getV2Session(chunk.identity.logicalSessionKey, chunk.identity.branchViewId))
      .toMatchObject({ complete: true, eventCount: chunk.events.length })
    expect(searchFTS('Synthetic shared root event')).toHaveLength(1)
    expect(packageDirs()).toHaveLength(1)
    expect(fs.readFileSync(path.join(packageDirs()[0], CANONICAL_RECORDS_FILE), 'utf8'))
      .toContain('Synthetic shared root event')
  })

  it('invalidates a native-v2 cache when parserDataVersion changes with identical source bytes', async () => {
    const sourcePath = path.join(home, '.pi', 'agent', 'sessions', 'v2-parser-upgrade.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, '{"synthetic":true}\n')
    const manifest = structuredClone(piGolden.manifest) as unknown as ProviderManifestV2
    manifest.displayName = 'Pi'
    const chunk = structuredClone(
      piGolden.envelopes.find((entry) => entry.kind === 'parse-chunk')!.payload
    ) as unknown as ParseChunkV2
    const fingerprint = { algorithm: 'sha256' as const, value: 'v2-parser-upgrade-source' }
    const stableId = 'pi:v2-parser-upgrade-source'
    chunk.fingerprint = fingerprint
    chunk.identity.physicalSourceId = stableId
    for (const event of chunk.events) {
      event.identity.physicalSourceId = stableId
      event.provenance.sourceRefId = stableId
    }
    const sourceRef: SourceRef = {
      kind: 'file', providerId: manifest.providerId, stableId,
      uri: pathToFileURL(sourcePath).href, displayLocator: sourcePath, fingerprint
    }
    let parseCount = 0
    const runtime: BuiltinProviderRuntimeV2 = {
      manifest,
      discover: async () => [sourceRef],
      fingerprint: async () => fingerprint,
      inputBytes: async () => fs.statSync(sourcePath).size,
      parse: async () => { parseCount++; return [structuredClone(chunk)] }
    }
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({ runtimes: [], v2Runtimes: [runtime] })

    const first = await refreshCanonicalProviders({ host, store })
    expect(first.reports[0].errors).toEqual([])
    await refreshCanonicalProviders({ host, store })
    expect(parseCount).toBe(1)

    manifest.parserDataVersion = 'synthetic-v2-upgrade'
    chunk.parserDataVersion = manifest.parserDataVersion
    for (const event of chunk.events) event.provenance.parserDataVersion = manifest.parserDataVersion
    const upgraded = await refreshCanonicalProviders({ host, store })
    expect(parseCount).toBe(2)
    expect(upgraded.changedSessionRecordIds).toHaveLength(1)
    expect(store.listSessions('swob/pi')[0].sessionRecord.provenance.parserDataVersion)
      .toBe('synthetic-v2-upgrade')
  })

  it('invalidates a v1 cache whose stored parserDataVersion is stale despite identical source bytes', async () => {
    const sourcePath = path.join(home, '.pi', 'agent', 'sessions', 'v1-parser-upgrade.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, '{"synthetic":true}\n')
    const fingerprint = { algorithm: 'sha256' as const, value: 'v1-parser-upgrade-source' }
    const stableId = 'pi:v1-parser-upgrade-source'
    const sourceRef: SourceRef = {
      kind: 'file', providerId: 'swob/pi', stableId,
      uri: pathToFileURL(sourcePath).href, displayLocator: sourcePath, fingerprint
    }
    const manifest = structuredClone(
      (await import('../shared/provider-capabilities')).builtinProviderForSource('pi')!.manifest
    ) as ProviderManifest
    const v1Format = manifest.formatVersions[0]
    let parseCount = 0
    const runtime: BuiltinProviderRuntime = {
      manifest,
      discover: async () => [sourceRef],
      fingerprint: async () => fingerprint,
      inputBytes: async () => fs.statSync(sourcePath).size,
      parse: async (): Promise<ParseOutcome> => {
        parseCount++
        const recordParserVersion = parseCount === 1 ? 'synthetic-v1-stale' : manifest.parserDataVersion
        const records = remoteRecords('v1-parser-upgrade', sourceRef).map((record) => ({
          ...record,
          provenance: { ...record.provenance, parserDataVersion: recordParserVersion }
        })) as CanonicalRecord[]
        return {
          providerId: manifest.providerId,
          parserDataVersion: manifest.parserDataVersion,
          formatVersion: v1Format,
          fingerprint,
          status: 'complete',
          sessions: [{
            sourceRefId: stableId,
            sessionRecordId: records[0].id,
            status: 'complete',
            records,
            errors: [],
            replaceSessionRecordId: null,
            noDataReason: null
          }],
          errors: [],
          tombstones: []
        }
      }
    }
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({ runtimes: [runtime], v2Runtimes: [] })

    const first = await refreshCanonicalProviders({ host, store })
    expect(first.reports[0].errors).toEqual([])
    await refreshCanonicalProviders({ host, store })
    expect(parseCount).toBe(2)
    const unchanged = await refreshCanonicalProviders({ host, store })
    expect(parseCount).toBe(2)
    expect(unchanged.changedSessionRecordIds).toHaveLength(0)
    expect(store.listSessions('swob/pi')[0].sessionRecord.provenance.parserDataVersion)
      .toBe(manifest.parserDataVersion)
  })

  it('runs Hermes JSON/state.db through direct v2, search, Vault, detail and format-scoped Resume truth', async () => {
    const hermesRoot = path.join(home, '.hermes')
    const sessionRoot = path.join(hermesRoot, 'sessions')
    const dbPath = path.join(hermesRoot, 'state.db')
    fs.mkdirSync(sessionRoot, { recursive: true })
    fs.copyFileSync(hermesFixture('session_legacy-only.json'), path.join(sessionRoot, 'session_legacy-only.json'))
    const db = new Database(dbPath)
    db.exec(fs.readFileSync(hermesFixture('state-db.sql'), 'utf8'))
    db.close()
    const provider = createHermesProvider({ homeDir: home })
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({ runtimes: [], v2Runtimes: [provider] })

    const result = await refreshCanonicalProviders({ host, store, archive: true })

    expect(result.reports).toMatchObject([{
      providerId: 'swob/hermes', runtimeProtocolVersion: 2, outcomes: [], errors: []
    }])
    expect(result.reports[0].consumerProjections).toHaveLength(3)
    expect(result.changedSessionRecordIds).toHaveLength(3)
    expect(store.listSessions('swob/hermes')).toHaveLength(3)
    expect(searchFTS('hermes-db-search-needle')).toHaveLength(1)
    expect(searchFTS('hermes-json-search-needle')).toHaveLength(1)
    expect(packageDirs()).toHaveLength(3)

    const child = store.listSessions('swob/hermes').find((stored) =>
      stored.sessionRecord.sourceSessionId === 'synthetic-hermes-db')!
    const parent = store.listSessions('swob/hermes').find((stored) =>
      stored.sessionRecord.sourceSessionId === 'synthetic-hermes-parent')!
    const legacy = store.listSessions('swob/hermes').find((stored) =>
      stored.sessionRecord.sourceSessionId === 'synthetic-hermes-json')!
    expect(child.records.find((record) => record.recordType === 'relationship')).toMatchObject({
      relationshipType: 'continuation',
      fromSessionRecordId: parent.sessionRecord.id,
      toSessionRecordId: child.sessionRecord.id
    })
    const { canonicalRecordsToSessionSummary } = await import('./canonical-projection')
    const childSummary = canonicalRecordsToSessionSummary(child.records, {
      filePath: child.sessionRecord.sourceRef.displayLocator,
      source: 'hermes'
    })
    const legacySummary = canonicalRecordsToSessionSummary(legacy.records, {
      filePath: legacy.sessionRecord.sourceRef.displayLocator,
      source: 'hermes'
    })
    expect(childSummary).toMatchObject({
      firstUserMessage: 'Locate hermes-db-search-needle.',
      projectPath: '/synthetic/project',
      models: ['synthetic-model-db'],
      compactCount: 1
    })
    expect(legacySummary.compactCount).toBe(0)
    expect(legacySummary.models).toEqual(['synthetic-model-json'])
    expect(library.getSessionResumeAvailability(childSummary.sessionId, childSummary))
      .toMatchObject({ canResume: true, sourcePath: `${dbPath}#synthetic-hermes-db` })
    expect(library.getSessionResumeAvailability(legacySummary.sessionId, legacySummary))
      .toMatchObject({ canResume: false, sourcePath: path.join(sessionRoot, 'session_legacy-only.json') })

    const childPackage = packageDirs().find((dirPath) =>
      fs.readFileSync(path.join(dirPath, CANONICAL_RECORDS_FILE), 'utf8').includes('hermes-db-search-needle'))!
    const sessionLoader = await import('./session-loader')
    const detail = await sessionLoader.loadSessionDetail(
      path.join(childPackage, CANONICAL_RECORDS_FILE)
    )
    expect(detail?.messages.find((message) => message.textContent === 'Synthetic DB system preamble.')?.subtype)
      .toBe('provider-preamble')
    expect(detail?.messages.some((message) => message.subtype === 'compact_boundary')).toBe(true)
    expect(detail?.messages.some((message) => message.textContent.includes('[Thinking]'))).toBe(true)
    expect(detail?.messages.flatMap((message) => message.toolCalls)).toMatchObject([
      expect.objectContaining({ name: 'read_file', result: expect.stringContaining('hermes-db-tool-result') })
    ])
    // The v1 detail read model keeps the billable output total (30) while
    // retaining reasoning (10) as metadata inside it; reasoning is not added
    // again. Input 125 + output 30 = 155.
    expect(detail?.tokenAccounting?.billingTotal).toBe(155)
    const directDetail = await sessionLoader.loadSessionDetail(`${dbPath}#synthetic-hermes-db`)
    expect(directDetail?.messages.some((message) =>
      message.textContent.includes('hermes-db-search-needle'))).toBe(true)
  })

  it('runs Pi through discover, store, search, Library, rescan, move, replace, and tombstone', async () => {
    const piRoot = path.join(home, '.pi', 'agent', 'sessions')
    const sourcePath = path.join(piRoot, 'project', 'session.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.copyFileSync(fixturePath(), sourcePath)
    const store = getCanonicalSessionStore()
    const provider = createPiProvider({ homeDir: home, roots: [piRoot] })
    const host = new ProviderHost({ runtimes: [provider] })

    const first = await refreshCanonicalProviders({ host, store, archive: true })
    expect(first.reports[0].errors).toHaveLength(0)
    expect(first.reports[0].v2Chunks.length).toBeGreaterThan(0)
    expect(first.changedSessionRecordIds).toHaveLength(1)
    expect(store.listSessions('swob/pi')).toHaveLength(1)
    expect(searchFTS('synthetic-search-needle')).toHaveLength(1)
    expect(searchFTS('Inspect the sample fixture')).toHaveLength(1)

    const firstPackages = packageDirs()
    expect(firstPackages).toHaveLength(1)
    const packageDir = firstPackages[0]
    const recordsPath = path.join(packageDir, CANONICAL_RECORDS_FILE)
    const provenancePath = path.join(packageDir, CANONICAL_PROVENANCE_FILE)
    expect(fs.existsSync(recordsPath)).toBe(true)
    expect(fs.existsSync(provenancePath)).toBe(true)
    expect(fs.existsSync(path.join(packageDir, 'backup.jsonl'))).toBe(false)
    const stored = store.getSession(first.changedSessionRecordIds[0])!
    const v2Identity = first.reports[0].v2Chunks[0].identity
    expect(store.getV2Session(v2Identity.logicalSessionKey, v2Identity.branchViewId)).toMatchObject({
      complete: true,
      eventCount: first.reports[0].v2Chunks.flatMap((chunk) => chunk.events).length
    })
    const canonicalSummary = (await import('./canonical-projection')).canonicalRecordsToSessionSummary(
      stored.records,
      { filePath: stored.sessionRecord.sourceRef.displayLocator, source: 'pi' }
    )
    expect(await library.ensureSessionInLibrary(canonicalSummary)).toBe(packageDir)
    expect(packageDirs()).toEqual(firstPackages)
    expect(fs.existsSync(path.join(packageDir, 'backup.jsonl'))).toBe(false)
    const firstRecordsContent = fs.readFileSync(recordsPath, 'utf8')
    const firstRecordsMtime = fs.statSync(recordsPath).mtimeMs

    const detail = await (await import('./session-loader')).loadSessionDetail(recordsPath)
    expect(detail?.messages.some((message) => message.textContent.includes('[Thinking]'))).toBe(true)
    const projectedCalls = detail?.messages.flatMap((message) => message.toolCalls) || []
    expect(projectedCalls).toMatchObject([
      {
        name: 'read',
        input: { file_path: '/workspace/synthetic-pi/README.md' }
      }
    ])
    expect(projectedCalls[0].result).toContain('synthetic-search-needle')
    expect(detail?.tokenAccounting?.billingTotal).toBe(278)

    const unchanged = await refreshCanonicalProviders({ host, store, archive: true })
    expect(unchanged.changedSessionRecordIds).toHaveLength(0)
    expect(packageDirs()).toEqual(firstPackages)
    expect(fs.readFileSync(recordsPath, 'utf8')).toBe(firstRecordsContent)
    expect(fs.statSync(recordsPath).mtimeMs).toBe(firstRecordsMtime)

    const movedPath = path.join(piRoot, 'moved', 'renamed.jsonl')
    fs.mkdirSync(path.dirname(movedPath), { recursive: true })
    fs.renameSync(sourcePath, movedPath)
    await refreshCanonicalProviders({ host, store, archive: true })
    expect(packageDirs()).toEqual(firstPackages)
    expect(store.listSessions('swob/pi')[0].sessionRecord.sourceRef.displayLocator).toBe(movedPath)
    expect(searchFTS('synthetic-search-needle')[0].filePath).toBe(movedPath)
    const reboundMeta = JSON.parse(fs.readFileSync(path.join(packageDir, '.swob-session.json'), 'utf8'))
    expect(reboundMeta.sourceFilePaths).toEqual([movedPath])

    fs.writeFileSync(
      movedPath,
      fs.readFileSync(movedPath, 'utf8').replace('synthetic-search-needle', 'replacement-search-needle')
    )
    const replaced = await refreshCanonicalProviders({ host, store, archive: true })
    expect(replaced.changedSessionRecordIds).toEqual(first.changedSessionRecordIds)
    expect(packageDirs()).toEqual(firstPackages)
    expect(searchFTS('synthetic-search-needle')).toHaveLength(0)
    expect(searchFTS('replacement-search-needle')).toHaveLength(1)
    expect(fs.readFileSync(recordsPath, 'utf8')).toContain('replacement-search-needle')

    fs.unlinkSync(movedPath)
    const removed = await refreshCanonicalProviders({ host, store, archive: true })
    expect(removed.tombstonedSessionRecordIds).toEqual(first.changedSessionRecordIds)
    expect(store.listSessions('swob/pi')).toHaveLength(0)
    expect(store.listSessions('swob/pi', { includeTombstoned: true })).toHaveLength(1)
    expect(store.getV2Session(v2Identity.logicalSessionKey, v2Identity.branchViewId)).toMatchObject({
      tombstoneReason: 'source-missing'
    })
    expect(searchFTS('replacement-search-needle')).toHaveLength(0)
    expect(fs.existsSync(recordsPath)).toBe(true)
    const tombstonedMeta = JSON.parse(fs.readFileSync(path.join(packageDir, '.swob-session.json'), 'utf8'))
    expect(tombstonedMeta.canonicalProvider.tombstone).toMatchObject({ reason: 'source-missing' })
  })

  it('archives remote canonical locators and multi-session fan-out as stable distinct packages', async () => {
    const sourceRef: SourceRef = {
      kind: 'virtual-member',
      providerId: 'swob/pi',
      stableId: 'pi:remote-fanout',
      containerRefId: 'remote-container',
      memberKey: 'account-row',
      displayLocator: 'ssh://example.invalid/var/lib/pi/account.db#account-row',
      fingerprint: { algorithm: 'composite-sha256', value: 'remote-fingerprint' }
    }
    const first = await library.ensureCanonicalPackage('swob/pi', sourceRef, remoteRecords('remote-one', sourceRef))
    const second = await library.ensureCanonicalPackage('swob/pi', sourceRef, remoteRecords('remote-two', sourceRef))
    const firstAgain = await library.ensureCanonicalPackage('swob/pi', sourceRef, remoteRecords('remote-one', sourceRef))

    expect(firstAgain.dirPath).toBe(first.dirPath)
    expect(firstAgain.contentChanged).toBe(false)
    expect(second.dirPath).not.toBe(first.dirPath)
    expect(packageDirs()).toHaveLength(2)
    const metas = packageDirs().map((dirPath) =>
      JSON.parse(fs.readFileSync(path.join(dirPath, '.swob-session.json'), 'utf8')))
    expect(metas.map((meta) => meta.logicalIdentity.sessionId).sort())
      .toEqual(['remote-one', 'remote-two'])
    expect(metas.every((meta) => meta.logicalIdentity.sourceFamily === 'swob/pi')).toBe(true)
    expect(metas.every((meta) => meta.sourceFilePaths[0].startsWith('ssh://'))).toBe(true)
    expect(packageDirs().some((dirPath) => fs.existsSync(path.join(dirPath, 'backup.jsonl')))).toBe(false)
  })

  it('reconciles one Provider workKey once when direct archive wins before backlog execution', async () => {
    const sourceRef: SourceRef = {
      kind: 'virtual-member',
      providerId: 'swob/pi',
      stableId: 'pi:startup-owner',
      containerRefId: 'startup-owner-container',
      memberKey: 'startup-owner-row',
      displayLocator: 'ssh://example.invalid/var/lib/pi/startup.db#row',
      fingerprint: { algorithm: 'composite-sha256', value: 'startup-owner-f1' }
    }
    const firstRecords = remoteRecords('startup-owner', sourceRef)
    const firstSummary = canonicalRecordsToSessionSummary(firstRecords, {
      filePath: sourceRef.displayLocator,
      source: 'pi'
    })
    const cold = await library.planLibraryStartupSync([firstSummary], 1, {})
    const waiting = await library.syncLibraryStartupBatch(
      [firstSummary],
      {},
      { snapshotDigest: cold.snapshotDigest, schemaGeneration: cold.schemaGeneration }
    )
    expect(waiting.outcome.skipped[0]).toMatchObject({
      code: 'PROVIDER_SESSION_PENDING',
      recovery: { state: 'waiting-provider' }
    })

    // The direct Provider owner archives exactly once. Replanning must only
    // complete the checkpoint and must expose no second executor item.
    const store = getCanonicalSessionStore()
    store.applyParseOutcome({
      providerId: 'swob/pi',
      parserDataVersion: '1',
      formatVersion: 'pi-jsonl-v3',
      fingerprint: sourceRef.fingerprint,
      status: 'complete',
      sessions: [{
        sourceRefId: sourceRef.stableId,
        sessionRecordId: firstRecords[0].id,
        status: 'complete',
        records: firstRecords,
        errors: [],
        replaceSessionRecordId: null,
        noDataReason: null
      }],
      errors: [],
      tombstones: []
    })
    await library.ensureCanonicalPackage('swob/pi', sourceRef, firstRecords)
    const reconciled = await library.planLibraryStartupSync([firstSummary], 1, {})
    expect(reconciled.dirtyIndexes).toEqual([])
    expect(reconciled.recoverySummary.waitingProvider).toBe(0)
    expect(packageDirs()).toHaveLength(1)

    // A newer Provider fingerprint may invalidate F1 while direct archive has
    // already committed F2. The latest current projection still closes cleanly.
    const secondSourceRef: SourceRef = {
      ...sourceRef,
      fingerprint: { algorithm: 'composite-sha256', value: 'startup-owner-f2' }
    }
    const secondRecords = remoteRecords('startup-owner', secondSourceRef).map((record) =>
      record.recordType === 'session'
        ? { ...record, updatedAt: '2026-07-23T00:02:00.000Z' }
        : record)
    const secondSummary = canonicalRecordsToSessionSummary(secondRecords, {
      filePath: secondSourceRef.displayLocator,
      source: 'pi'
    })
    store.applyParseOutcome({
      providerId: 'swob/pi',
      parserDataVersion: '1',
      formatVersion: 'pi-jsonl-v3',
      fingerprint: secondSourceRef.fingerprint,
      status: 'complete',
      sessions: [{
        sourceRefId: secondSourceRef.stableId,
        sessionRecordId: secondRecords[0].id,
        status: 'complete',
        records: secondRecords,
        errors: [],
        replaceSessionRecordId: null,
        noDataReason: null
      }],
      errors: [],
      tombstones: []
    })
    const beforeSecondDirectArchive = await library.planLibraryStartupSync([secondSummary], 1, {})
    expect(beforeSecondDirectArchive.dirtyIndexes).toEqual([0])
    await library.ensureCanonicalPackage('swob/pi', secondSourceRef, secondRecords)
    const fingerprintChanged = await library.planLibraryStartupSync([secondSummary], 1, {})
    expect(fingerprintChanged.dirtyIndexes).toEqual([])
    expect(packageDirs()).toHaveLength(1)
  })

  it('preserves the last valid Pi snapshot when a live header is temporarily malformed', async () => {
    const piRoot = path.join(home, '.pi', 'agent', 'sessions')
    const sourcePath = path.join(piRoot, 'project', 'session.jsonl')
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.copyFileSync(fixturePath(), sourcePath)
    const store = getCanonicalSessionStore()
    const host = new ProviderHost({
      runtimes: [createPiProvider({ homeDir: home, roots: [piRoot] })]
    })

    const first = await refreshCanonicalProviders({ host, store })
    expect(first.changedSessionRecordIds).toHaveLength(1)
    expect(searchFTS('synthetic-search-needle')).toHaveLength(1)

    fs.writeFileSync(sourcePath, '{temporarily-incomplete')
    const transient = await refreshCanonicalProviders({ host, store })

    expect(transient.reports[0].errors).toMatchObject([{ code: 'provider-failed' }])
    expect(transient.tombstonedSessionRecordIds).toHaveLength(0)
    expect(store.listSessions('swob/pi')).toHaveLength(1)
    expect(searchFTS('synthetic-search-needle')).toHaveLength(1)
  })

  it('serializes dependent Library writes with canonical refresh work', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = withCanonicalProviderRefreshBarrier(async () => {
      order.push('first:start')
      await firstGate
      order.push('first:end')
    })
    await Promise.resolve()
    const second = withCanonicalProviderRefreshBarrier(async () => {
      order.push('second')
    })
    await Promise.resolve()

    expect(order).toEqual(['first:start'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second'])
  })
})
