import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { LibraryWorkerClient, runLibraryWorkerRequest } from './library-worker'
import {
  closeSearchIndex,
  searchDatabasePath,
  searchIndexConnectionStats,
  searchFTS,
  synchronizeSearchSources,
  type SearchIndexSource
} from './search-index'
import {
  closeSearchIndexWriteCoordinator,
  getSearchIndexWriteCoordinator,
  SearchIndexWriteCoordinator,
  setSearchIndexWriteCoordinatorForTest,
  WorkerSearchIndexWritePort,
  type SearchIndexWritePort
} from './search-index-writer'
import type { CanonicalRecord } from '../shared/provider-schema.generated'

const roots: string[] = []
const workerIntegrationIt = process.env.SWOB_SEARCH_WORKER_INTEGRATION === '1' ? it : it.skip
const largeWorkerIntegrationIt = process.env.SWOB_LARGE_SEARCH_WORKER_TEST === '1' ? it : it.skip

class DirectSearchPort implements SearchIndexWritePort {
  syncCalls = 0

  async syncSearchSources(sources: SearchIndexSource[], options: { prune: boolean }): Promise<void> {
    this.syncCalls++
    await synchronizeSearchSources(sources, options)
  }

  async indexCanonicalSearch(_sessionId: string, _records: CanonicalRecord[]): Promise<void> {}
  async tombstoneCanonicalSearch(_sessionRecordId: string): Promise<void> {}
  async close(): Promise<void> {}
}

function canonicalRecords(recordId: string): CanonicalRecord[] {
  return [{
    id: recordId,
    recordType: 'session',
    sourceRef: { stableId: `source:${recordId}`, displayLocator: `/fixture/${recordId}`, fingerprint: { algorithm: 'sha256', value: 'fixture' } },
    sourceSessionId: `source-session:${recordId}`,
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    cwd: ['/fixture'],
    projectPath: '/fixture',
    providerTitle: recordId,
    provenance: {
      providerId: 'swob/fixture', sourceRefId: `source:${recordId}`, parserDataVersion: '1',
      formatVersion: 'fixture', observedAt: '2026-08-02T00:00:00.000Z'
    }
  } as CanonicalRecord]
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  return { promise: new Promise<void>((done) => { resolve = done }), resolve }
}

afterEach(() => {
  closeSearchIndex()
  delete process.env.SWOB_SEARCH_INDEX_DIR
  delete process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('SearchIndexWriteCoordinator', () => {
  largeWorkerIntegrationIt('keeps a 100MB Library commit plus full search reread within the live gate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-100mb-root-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-100mb-source-'))
    roots.push(root, sourceRoot)
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search-index')
    const sessionId = 'search-100mb-worker'
    const sourcePath = path.join(sourceRoot, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    const userLine = JSON.stringify({
        uuid: 'large-user', parentUuid: null, sessionId, type: 'user',
        timestamp: '2026-08-02T09:00:00.000Z', cwd: '/fixture',
        message: { role: 'user', content: 'large search projection needle' }
      })
    const assistantTemplate = JSON.stringify({
        uuid: 'large-assistant', parentUuid: 'large-user', sessionId, type: 'assistant',
        timestamp: '2026-08-02T09:00:01.000Z', cwd: '/fixture',
        message: { role: 'assistant', content: '__SWOB_LARGE_PAYLOAD__' }
      })
    const marker = '__SWOB_LARGE_PAYLOAD__'
    const markerAt = assistantTemplate.indexOf(marker)
    const fd = fs.openSync(sourcePath, 'w')
    try {
      fs.writeSync(fd, userLine + '\n')
      fs.writeSync(fd, assistantTemplate.slice(0, markerAt))
      const chunk = Buffer.alloc(1024 * 1024, 0x78)
      for (let index = 0; index < 100; index++) fs.writeSync(fd, chunk)
      fs.writeSync(fd, assistantTemplate.slice(markerAt + marker.length) + '\n')
    } finally {
      fs.closeSync(fd)
    }

    const builtWorkerPath = path.join(process.cwd(), 'out', 'main', 'library-worker.js')
    const libraryWorker = new LibraryWorkerClient(builtWorkerPath)
    const searchPort = new WorkerSearchIndexWritePort(builtWorkerPath)
    const coordinator = new SearchIndexWriteCoordinator(searchPort)
    const libraryStartedAt = performance.now()
    const projected = await libraryWorker.syncSession({
      root, filePath: sourcePath, sessionId, source: 'claude-code'
    })
    await libraryWorker.close()
    const libraryElapsedMs = performance.now() - libraryStartedAt
    expect(projected.dirPath).toBeTruthy()

    const searchStartedAt = performance.now()
    await coordinator.scheduleLegacySource({ filePath: sourcePath, sessionId, source: 'claude-code' })
    await coordinator.close()
    const searchElapsedMs = performance.now() - searchStartedAt
    const totalElapsedMs = libraryElapsedMs + searchElapsedMs
    expect(searchFTS('large search projection needle')).toMatchObject([{ sessionId }])
    expect(totalElapsedMs).toBeLessThan(60_000)
    console.info('[100mb-library-search]', JSON.stringify({
      bytes: fs.statSync(sourcePath).size,
      libraryElapsedMs: Math.round(libraryElapsedMs),
      searchElapsedMs: Math.round(searchElapsedMs),
      totalElapsedMs: Math.round(totalElapsedMs),
      fullSearchReread: true,
      memoryVerification: 'unverified-worker_threads-share-process-rss'
    }))
  }, 120_000)

  workerIntegrationIt('serializes real Library and search workers while a third connection releases SQLITE_BUSY', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-worker-root-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-worker-source-'))
    roots.push(root, sourceRoot)
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search-index')
    process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS = '15'
    const sessionId = 'real-worker-boundary'
    const sourcePath = path.join(sourceRoot, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, JSON.stringify({
      uuid: 'worker-user', parentUuid: null, sessionId, type: 'user',
      timestamp: '2026-08-02T09:30:00.000Z', cwd: '/fixture',
      message: { role: 'user', content: 'real worker sqlite recovery needle' }
    }) + '\n')

    const builtWorkerPath = path.join(process.cwd(), 'out', 'main', 'library-worker.js')
    const libraryWorker = new LibraryWorkerClient(builtWorkerPath)
    const searchWorker = new LibraryWorkerClient(builtWorkerPath)
    const coordinator = new SearchIndexWriteCoordinator(searchWorker, {
      maxBusyAttempts: 3,
      busyRetryDelaysMs: [1],
      delay: async () => {
        blocker.exec('ROLLBACK')
        blocker.close()
      }
    })
    const summary = await libraryWorker.syncSession({
      root, filePath: sourcePath, sessionId, source: 'claude-code'
    })
    expect(summary.summary.sessionId).toBe(sessionId)
    expect(fs.readFileSync(path.join(summary.dirPath!, 'transcript.md'), 'utf8'))
      .toContain('real worker sqlite recovery needle')

    await coordinator.scheduleLegacySnapshot([])
    const blocker = new Database(searchDatabasePath())
    blocker.pragma('journal_mode = WAL')
    blocker.exec('BEGIN IMMEDIATE')
    await coordinator.scheduleLegacySource({ filePath: sourcePath, sessionId, source: 'claude-code' })
    expect(searchFTS('real worker sqlite recovery needle')).toMatchObject([{ sessionId }])
    await coordinator.close()
    await libraryWorker.close()
  })

  it('keeps Library success independent and catches search up after a second connection releases SQLITE_BUSY', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-boundary-root-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-boundary-source-'))
    roots.push(root, sourceRoot)
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search-index')
    process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS = '15'
    const sessionId = 'search-boundary-session'
    const sourcePath = path.join(sourceRoot, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, [
      {
        uuid: 'user-1', parentUuid: null, sessionId, type: 'user',
        timestamp: '2026-08-02T10:00:00.000Z', cwd: '/fixture/project',
        message: { role: 'user', content: 'sqlite busy recovery needle' }
      },
      {
        uuid: 'assistant-1', parentUuid: 'user-1', sessionId, type: 'assistant',
        timestamp: '2026-08-02T10:00:01.000Z', cwd: '/fixture/project',
        message: { role: 'assistant', content: 'committed' }
      }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')

    // This boundary is the regression: summary/Library commit completes before
    // search indexing starts, so a later SQLite failure cannot reject it.
    const projected = await runLibraryWorkerRequest({
      type: 'session-sync', root, filePath: sourcePath, sessionId, source: 'claude-code'
    })
    expect(projected.kind).toBe('session-sync')
    if (projected.kind !== 'session-sync' || !projected.value.dirPath) throw new Error('Library sync failed')
    expect(projected.value.summary.sessionId).toBe(sessionId)
    expect(fs.readFileSync(path.join(projected.value.dirPath, 'transcript.md'), 'utf8'))
      .toContain('sqlite busy recovery needle')
    expect(fs.readFileSync(path.join(projected.value.dirPath, 'backup.jsonl')))
      .toEqual(fs.readFileSync(sourcePath))

    // Initialize schema, then hold the write lock from an independent SQLite
    // connection longer than the configured busy_timeout.
    await synchronizeSearchSources([], { prune: true })
    closeSearchIndex()
    const locker = new Database(searchDatabasePath())
    locker.pragma('journal_mode = WAL')
    locker.exec('BEGIN IMMEDIATE')

    const port = new DirectSearchPort()
    let retryDelays = 0
    const coordinator = new SearchIndexWriteCoordinator(port, {
      maxBusyAttempts: 3,
      busyRetryDelaysMs: [1],
      delay: async () => {
        retryDelays++
        locker.exec('ROLLBACK')
        locker.close()
      }
    })
    let resolved = 0
    await coordinator.scheduleLegacySource({
      filePath: sourcePath,
      sessionId,
      source: 'claude-code'
    }).then(() => { resolved++ })

    expect(retryDelays).toBe(1)
    expect(port.syncCalls).toBe(2)
    expect(resolved).toBe(1)
    expect(coordinator.getStats()).toMatchObject({
      running: false,
      pendingLegacy: 0,
      exhausted: false
    })
    expect(searchFTS('sqlite busy recovery needle')).toMatchObject([{ sessionId }])
    await coordinator.close()
  })

  it('bounds retry attempts, retains the latest intent, and resumes only on an explicit recovery trigger', async () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    let locked = true
    let calls = 0
    const port: SearchIndexWritePort = {
      syncSearchSources: async () => {
        calls++
        if (locked) throw busy
      },
      indexCanonicalSearch: async () => {},
      tombstoneCanonicalSearch: async () => {},
      close: async () => {}
    }
    const coordinator = new SearchIndexWriteCoordinator(port, {
      maxBusyAttempts: 3,
      busyRetryDelaysMs: [0],
      delay: async () => {}
    })

    await expect(coordinator.scheduleLegacySource({ filePath: '/fixture/session.jsonl' }))
      .rejects.toMatchObject({ code: 'SQLITE_BUSY' })
    expect(calls).toBe(3)
    expect(coordinator.getStats()).toMatchObject({
      running: false,
      pendingLegacy: 1,
      exhausted: true,
      busyAttempts: 2
    })

    locked = false
    await coordinator.retryPending()
    expect(calls).toBe(4)
    expect(coordinator.getStats()).toMatchObject({ pendingLegacy: 0, exhausted: false })
    await coordinator.close()
  })

  it('reuses one readonly query connection and invalidates its cache after another connection commits', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-read-connection-'))
    roots.push(root)
    process.env.SWOB_SEARCH_INDEX_DIR = root
    const sourcePath = path.join(root, 'first.jsonl')
    fs.writeFileSync(sourcePath, JSON.stringify({
      uuid: 'first-user', parentUuid: null, sessionId: 'first-session', type: 'user',
      timestamp: '2026-08-02T11:00:00.000Z',
      message: { role: 'user', content: 'revisionneedle first' }
    }) + '\n')
    await synchronizeSearchSources([{ filePath: sourcePath }], { prune: true })

    const opensBefore = searchIndexConnectionStats().readOpens
    expect(searchFTS('revisionneedle')).toHaveLength(1)
    expect(searchFTS('revisionneedle')).toHaveLength(1)
    expect(searchIndexConnectionStats().readOpens - opensBefore).toBe(1)

    const external = new Database(searchDatabasePath())
    external.transaction(() => {
      external.prepare(`
        INSERT INTO sessions(
          file_path, display_path, session_id, source, project_path, file_signature,
          first_user_message, indexed_size, file_dev, file_ino, indexed_raw_count, projection_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'external:second', 'external:second', 'second-session', 'fixture', '', 'external-v1',
        'revisionneedle second', 1, 0, 0, 1, 'legacy'
      )
      external.prepare(`
        INSERT INTO messages_fts(session_id, file_path, role, text, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `).run('second-session', 'external:second', 'user', 'revisionneedle second', '2026-08-02T11:01:00.000Z')
    })()
    external.close()

    expect(searchFTS('revisionneedle').map((result) => result.sessionId).sort())
      .toEqual(['first-session', 'second-session'])
    expect(searchIndexConnectionStats().readOpens - opensBefore).toBe(1)
  })

  it('closes the one-shot in-process writer so a CLI process leaves no SQLite handles behind', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-cli-close-'))
    roots.push(root)
    process.env.SWOB_SEARCH_INDEX_DIR = root
    const sourcePath = path.join(root, 'cli.jsonl')
    fs.writeFileSync(sourcePath, JSON.stringify({
      uuid: 'cli-user', parentUuid: null, sessionId: 'cli-session', type: 'user',
      timestamp: '2026-08-02T12:00:00.000Z',
      message: { role: 'user', content: 'cli close needle' }
    }) + '\n')

    await getSearchIndexWriteCoordinator().scheduleLegacySnapshot([{ filePath: sourcePath }])
    expect(searchIndexConnectionStats().hasWriteConnection).toBe(true)
    await closeSearchIndexWriteCoordinator(new Error('CLI search completed'))
    expect(searchIndexConnectionStats()).toMatchObject({
      hasReadConnection: false,
      hasWriteConnection: false
    })

    const takeover = new Database(searchDatabasePath())
    expect(() => takeover.exec('BEGIN IMMEDIATE; ROLLBACK')).not.toThrow()
    takeover.close()
  })

  it('coalesces canonical and legacy intents by newest authoritative state', async () => {
    const runCase = async (
      schedulePending: (coordinator: SearchIndexWriteCoordinator) => Promise<void>[],
      assertPort: (port: {
        legacy: Array<{ sources: SearchIndexSource[]; prune: boolean }>
        canonical: string[]
      }) => void
    ): Promise<void> => {
      const gate = deferred()
      let first = true
      const observed = {
        legacy: [] as Array<{ sources: SearchIndexSource[]; prune: boolean }>,
        canonical: [] as string[]
      }
      const port: SearchIndexWritePort = {
        syncSearchSources: async (sources, options) => {
          observed.legacy.push({ sources, prune: options.prune })
          if (first) {
            first = false
            await gate.promise
          }
        },
        indexCanonicalSearch: async (_sessionId, records) => {
          observed.canonical.push(`index:${(records[0] as { id: string }).id}`)
        },
        tombstoneCanonicalSearch: async (sessionRecordId) => {
          observed.canonical.push(`tombstone:${sessionRecordId}`)
        },
        close: async () => {}
      }
      const coordinator = new SearchIndexWriteCoordinator(port)
      const active = coordinator.scheduleLegacySource({ filePath: '/running.jsonl' })
      const pending = schedulePending(coordinator)
      gate.resolve()
      await Promise.all([active, ...pending])
      assertPort(observed)
      await coordinator.close()
    }

    await runCase((coordinator) => [
      coordinator.scheduleCanonicalIndex('canonical-source', canonicalRecords('canonical-record')),
      coordinator.scheduleCanonicalTombstone('canonical-record')
    ], (port) => {
      expect(port.canonical).toEqual(['tombstone:canonical-record'])
    })

    await runCase((coordinator) => [
      coordinator.scheduleCanonicalTombstone('canonical-record'),
      coordinator.scheduleCanonicalIndex('canonical-source', canonicalRecords('canonical-record'))
    ], (port) => {
      expect(port.canonical).toEqual(['index:canonical-record'])
    })

    await runCase((coordinator) => [
      coordinator.scheduleLegacySnapshot([
        { filePath: '/a.jsonl', source: 'old-a' },
        { filePath: '/b.jsonl', source: 'old-b' }
      ]),
      coordinator.scheduleLegacySource({ filePath: '/a.jsonl', source: 'new-a' }),
      coordinator.scheduleLegacySource({ filePath: '/c.jsonl', source: 'new-c' })
    ], (port) => {
      expect(port.legacy).toHaveLength(2)
      expect(port.legacy[1].prune).toBe(true)
      expect(port.legacy[1].sources.map((source) => [source.filePath, source.source]).sort())
        .toEqual([
          ['/a.jsonl', 'new-a'],
          ['/b.jsonl', 'old-b'],
          ['/c.jsonl', 'new-c']
        ])
    })

    await runCase((coordinator) => [
      coordinator.scheduleLegacySnapshot([
        { filePath: '/old-a.jsonl' },
        { filePath: '/old-b.jsonl' }
      ]),
      coordinator.scheduleLegacySnapshot([{ filePath: '/new-only.jsonl' }])
    ], (port) => {
      expect(port.legacy).toHaveLength(2)
      expect(port.legacy[1]).toMatchObject({
        prune: true,
        sources: [{ filePath: '/new-only.jsonl' }]
      })
    })
  })

  it('fails closed on writer close rejection instead of creating a second global writer', async () => {
    const closeFailure = new Error('fixture worker close rejected')
    const port: SearchIndexWritePort = {
      syncSearchSources: async () => {},
      indexCanonicalSearch: async () => {},
      tombstoneCanonicalSearch: async () => {},
      close: async () => { throw closeFailure }
    }
    const coordinator = new SearchIndexWriteCoordinator(port)
    setSearchIndexWriteCoordinatorForTest(coordinator)
    await expect(closeSearchIndexWriteCoordinator(new Error('root changing'))).rejects.toBe(closeFailure)
    expect(getSearchIndexWriteCoordinator()).toBe(coordinator)
    await expect(coordinator.scheduleLegacySource({ filePath: '/must-not-run.jsonl' }))
      .rejects.toThrow('root changing')
    setSearchIndexWriteCoordinatorForTest(null)
  })
})
