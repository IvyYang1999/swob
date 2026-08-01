import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CanonicalRecord, SourceRef } from '../shared/provider-schema.generated'
import { closeCanonicalSessionStore, getCanonicalSessionStore } from './canonical-store'
import {
  CANONICAL_PROVENANCE_FILE,
  CANONICAL_RECORDS_FILE
} from './canonical-package'
import { ProviderHost } from './provider-host'
import { refreshCanonicalProviders } from './provider-runtime'
import { createPiProvider } from './providers/pi-provider'
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
})
