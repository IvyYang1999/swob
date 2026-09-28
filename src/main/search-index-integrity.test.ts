/**
 * F1d-3 ②: the secondary, active probe. PRAGMA quick_check runs only in the
 * library worker thread, asked for by the coordinator (search-index-writer)
 * when a query on the main thread met a corrupt index; the coordinator waits
 * a wall-clock deadline, past which the index is only suspect: nothing moves
 * for the time a check takes, writes wait, reads go on. Only the check's own
 * verdict repairs. ⑥: while a check holds the worker, the main thread still
 * answers the search IPC within 1 s. The worker is bundled from source as the
 * app bundles it; every index is synthetic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runLibraryWorkerRequest } from './library-worker'
import {
  closeSearchIndex,
  searchDatabasePath,
  searchFTS,
  searchIndexConnectionStats,
  synchronizeSearchSources,
  type SearchIndexEvent,
  type SearchIndexSource
} from './search-index'
import {
  SearchIndexWriteCoordinator,
  WorkerSearchIndexWritePort,
  type SearchIndexWritePort
} from './search-index-writer'
import { searchIndexedSessions } from './session-search'
import { searchIndexBackupDirectory } from './program-backups'
import { buildProductionLibraryWorker } from './__test-support__/production-library-worker'
import { addUnusedPages, breakFullTextPages } from './__fixtures__/search-index-corruption'

let buildRoot = ''
let workerPath = ''
let root = ''
let priorIndexDir: string | undefined
const events: SearchIndexEvent[] = []
const listener = (event: SearchIndexEvent): void => { events.push(event) }
const coordinators: SearchIndexWriteCoordinator[] = []

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-integrity-build-'))
  workerPath = await buildProductionLibraryWorker(buildRoot)
}, 120_000)

afterAll(() => {
  fs.rmSync(buildRoot, { recursive: true, force: true })
})

beforeEach(() => {
  closeSearchIndex()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-integrity-'))
  priorIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'index')
  delete process.env.SWOB_TEST_SEARCH_QUICK_CHECK_HOLD_MS
  fs.rmSync(searchIndexBackupDirectory(), { recursive: true, force: true })
  events.length = 0
  process.on('swob:search-index-event', listener)
})

afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.close()
  process.off('swob:search-index-event', listener)
  closeSearchIndex()
  delete process.env.SWOB_TEST_SEARCH_QUICK_CHECK_HOLD_MS
  if (priorIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = priorIndexDir
  fs.rmSync(searchIndexBackupDirectory(), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

const TOKENS = ['foxtrotcheck', 'golfcheck', 'hotelcheck']

function writeSession(token: string): string {
  const filePath = path.join(root, 'sources', `${token}.jsonl`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    { uuid: `${token}-u`, parentUuid: null, sessionId: `${token}-session`, type: 'user', timestamp: '2026-09-28T00:00:00.000Z', message: { role: 'user', content: `${token} question` } },
    { uuid: `${token}-a`, parentUuid: `${token}-u`, sessionId: `${token}-session`, type: 'assistant', timestamp: '2026-09-28T00:00:01.000Z', message: { role: 'assistant', content: `${token} answer` } }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  return filePath
}

/** A healthy synthetic index, closed: no connection, no -wal/-shm. */
async function healthyIndex(): Promise<SearchIndexSource[]> {
  const sources = TOKENS.map((token) => ({ filePath: writeSession(token), sessionId: `${token}-session`, source: 'claude-code' }))
  await synchronizeSearchSources(sources)
  closeSearchIndex()
  return sources
}

/** The app's writer: a coordinator over a real worker thread. Env set before this reaches the worker. */
function workerCoordinator(options: { deadlineMs?: number; cooldownMs?: number } = {}): SearchIndexWriteCoordinator {
  const coordinator = new SearchIndexWriteCoordinator(new WorkerSearchIndexWritePort(workerPath), {
    integrityCheckDeadlineMs: options.deadlineMs ?? 20_000,
    integrityCheckCooldownMs: options.cooldownMs ?? 0
  })
  coordinators.push(coordinator)
  return coordinator
}

function identity(filePath: string): { ino: number; size: number; mtimeMs: number; ctimeMs: number } {
  const stat = fs.lstatSync(filePath)
  return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

const named = (name: string): SearchIndexEvent[] => events.filter((event) => event.event === name)

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('search.db integrity check in the worker (F1d-3)', () => {
  it('a healthy index checks ok in the worker, and nothing is written or moved (lstat)', async () => {
    await healthyIndex()
    const before = identity(searchDatabasePath())
    const coordinator = workerCoordinator()

    const report = await coordinator.requestIntegrityCheck('test-healthy')

    expect(report).toMatchObject({ trigger: 'test-healthy', status: 'ok', late: false })
    expect(report.ms).toEqual(expect.any(Number))
    expect(identity(searchDatabasePath())).toEqual(before)
    if (fs.existsSync(`${searchDatabasePath()}-wal`)) expect(fs.statSync(`${searchDatabasePath()}-wal`).size).toBe(0)
    expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
    expect(events).toEqual([{ event: 'search-index-checked', trigger: 'test-healthy', status: 'ok', ms: report.ms, late: false }])
    expect(coordinator.getStats().integrity).toBe('ok')
  }, 60_000)

  it('① a search that meets broken full-text pages has the worker check the index, which moves it aside and rebuilds it; search comes back', async () => {
    const sources = await healthyIndex()
    breakFullTextPages(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())
    const coordinator = workerCoordinator()
    // What index.ts does with these events (pinned in search-index-quick-check.architecture.test.ts).
    const checks: Array<Promise<unknown>> = []
    const reprojections: Array<Promise<void>> = []
    const wiring = (event: SearchIndexEvent): void => {
      if (event.event === 'search-index-read-corrupt') checks.push(coordinator.requestIntegrityCheck(`read-${String(event.operation)}`))
      if (event.event === 'search-index-repaired') reprojections.push(coordinator.scheduleLegacySnapshot(sources))
    }
    process.on('swob:search-index-event', wiring)
    try {
      // The main thread answers nothing, reports, and never moves the file itself.
      expect(searchIndexedSessions(TOKENS[0])).toEqual([])
      expect(identity(searchDatabasePath())).toEqual(corrupt)
      await until(() => checks.length === 1)
      const report = await checks[0]
      expect(report).toMatchObject({ trigger: 'read-search', status: 'repaired', reason: expect.stringMatching(/^SQLITE_CORRUPT/), late: false })
      await until(() => reprojections.length === 1)
      await reprojections[0]
    } finally {
      process.off('swob:search-index-event', wiring)
    }

    expect(events.map((event) => event.event)).toEqual([
      'search-index-read-corrupt', 'search-index-repaired', 'search-index-checked'
    ])
    const repaired = named('search-index-repaired')[0]
    expect(repaired).toMatchObject({ operation: 'quick-check', reason: expect.stringMatching(/^SQLITE_CORRUPT/), bytes: corrupt.size, complete: true, rebuilt: true })
    expect(fs.statSync(path.join(searchIndexBackupDirectory(), String(repaired.backupFileName))).ino).toBe(corrupt.ino)
    // The worker's event closed this thread's connection; the next search opens the rebuilt, re-projected index.
    expect(searchIndexConnectionStats().hasReadConnection).toBe(false)
    for (const token of TOKENS) expect(searchIndexedSessions(token), token).toHaveLength(1)
  }, 60_000)

  it('pages no query ever reads, which only quick_check reports, are found by the check and repaired', async () => {
    const sources = await healthyIndex()
    addUnusedPages(searchDatabasePath())
    const damaged = identity(searchDatabasePath())
    // Nothing a reader or a writer does trips over it.
    for (const token of TOKENS) expect(searchFTS(token), token).toHaveLength(1)
    await synchronizeSearchSources(sources)
    closeSearchIndex()
    expect(events).toEqual([])

    const report = await workerCoordinator().requestIntegrityCheck('test-silent')

    expect(report).toMatchObject({ status: 'repaired', reason: 'quick_check', problems: 1, late: false })
    expect(named('search-index-repaired')).toEqual([expect.objectContaining({
      operation: 'quick-check', reason: 'quick_check', bytes: damaged.size, complete: true, rebuilt: true
    })])
    expect(fs.statSync(path.join(searchIndexBackupDirectory(), String(named('search-index-repaired')[0].backupFileName))).ino)
      .toBe(damaged.ino)
  }, 60_000)

  it('⑥ while a quick_check holds the worker for 3 s, the main thread answers the search IPC within 1 s', async () => {
    await healthyIndex()
    process.env.SWOB_TEST_SEARCH_QUICK_CHECK_HOLD_MS = '3000'
    const coordinator = workerCoordinator()
    // The main thread's part of the `sessions:search` IPC (index.ts): a turn of the event loop, then the query.
    const searchIpc = async (): Promise<{ ms: number; results: number }> => {
      const startedAt = performance.now()
      await new Promise((resolve) => setImmediate(resolve))
      const results = searchIndexedSessions(TOKENS[1]).length
      return { ms: performance.now() - startedAt, results }
    }
    expect((await searchIpc()).results).toBe(1)

    let lagMs = 0
    let lastTick = performance.now()
    const monitor = setInterval(() => {
      const now = performance.now()
      lagMs = Math.max(lagMs, now - lastTick - 20)
      lastTick = now
    }, 20)
    const startedAt = performance.now()
    let checkDone = false
    const check = coordinator.requestIntegrityCheck('test-ipc').then((report) => {
      checkDone = true
      return report
    })
    const probes: Array<{ at: number; ms: number; results: number }> = []
    try {
      while (!checkDone && performance.now() - startedAt < 2_700) {
        const probe = await searchIpc()
        if (!checkDone) probes.push({ at: performance.now() - startedAt, ...probe })
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      const report = await check
      expect(report).toMatchObject({ status: 'ok', late: false })
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(3_000)
    } finally {
      clearInterval(monitor)
    }
    // Probes kept answering while the check still held the worker, each well within 1 s, with results.
    expect(probes.filter((probe) => probe.at >= 1_000).length).toBeGreaterThanOrEqual(10)
    expect(Math.max(...probes.map((probe) => probe.ms))).toBeLessThan(1_000)
    expect(probes.every((probe) => probe.results === 1)).toBe(true)
    expect(lagMs).toBeLessThan(1_000)
  }, 60_000)

  it('past the deadline the index is only suspect: nothing moves, writes wait for the verdict, and the late verdict is logged', async () => {
    const sources = await healthyIndex()
    process.env.SWOB_TEST_SEARCH_QUICK_CHECK_HOLD_MS = '1500'
    const coordinator = workerCoordinator({ deadlineMs: 200 })
    const before = identity(searchDatabasePath())

    const report = await coordinator.requestIntegrityCheck('test-deadline')
    expect(report).toMatchObject({ trigger: 'test-deadline', status: 'suspect' })
    expect(named('search-index-check-suspect')).toEqual([{ event: 'search-index-check-suspect', trigger: 'test-deadline', deadlineMs: 200 }])
    expect(coordinator.getStats().integrity).toBe('suspect')
    expect(identity(searchDatabasePath())).toEqual(before)
    expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)

    // A write arriving meanwhile waits for the verdict (the index is only read until then).
    const added = writeSession('lateindiacheck')
    const write = coordinator.scheduleLegacySource({ filePath: added, sessionId: 'lateindiacheck-session', source: 'claude-code' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(named('search-index-checked')).toEqual([])
    expect(searchFTS('lateindiacheck')).toEqual([])
    expect(coordinator.getStats().pendingLegacy).toBe(1)

    await write
    expect(named('search-index-checked')).toEqual([expect.objectContaining({ trigger: 'test-deadline', status: 'ok', late: true })])
    expect(coordinator.getStats().integrity).toBe('ok')
    expect(searchFTS('lateindiacheck')).toHaveLength(1)
    expect(identity(searchDatabasePath()).ino).toBe(before.ino)
    expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
    void sources
  }, 60_000)

  it('a corrupt index whose check overruns the deadline stays in place at the deadline; the verdict itself repairs it', async () => {
    await healthyIndex()
    breakFullTextPages(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())
    process.env.SWOB_TEST_SEARCH_QUICK_CHECK_HOLD_MS = '1200'
    const coordinator = workerCoordinator({ deadlineMs: 200 })

    const report = await coordinator.requestIntegrityCheck('test-late-verdict')
    expect(report.status).toBe('suspect')
    // At the deadline: the file is where it was, nothing in search-backups.
    expect(identity(searchDatabasePath())).toEqual(corrupt)
    expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)

    await until(() => named('search-index-checked').length === 1)
    expect(named('search-index-checked')[0]).toMatchObject({ status: 'repaired', reason: expect.stringMatching(/^SQLITE_CORRUPT/), late: true })
    expect(named('search-index-repaired')).toEqual([expect.objectContaining({ operation: 'quick-check', bytes: corrupt.size, complete: true })])
    expect(events.map((event) => event.event)).toEqual(['search-index-check-suspect', 'search-index-repaired', 'search-index-checked'])
  }, 60_000)

  it('one check at a time and at most one per cooldown; none without a worker thread, and never on the main thread', async () => {
    await healthyIndex()
    const coordinator = workerCoordinator({ cooldownMs: 60_000 })
    const first = coordinator.requestIntegrityCheck('first')
    const joined = coordinator.requestIntegrityCheck('joined')
    expect(await first).toMatchObject({ trigger: 'first', status: 'ok' })
    expect(await joined).toMatchObject({ trigger: 'first', status: 'ok' })
    expect(await coordinator.requestIntegrityCheck('again')).toEqual({ trigger: 'again', status: 'skipped', reason: 'cooldown' })
    expect(named('search-index-checked')).toHaveLength(1)

    const inProcess: SearchIndexWritePort = {
      syncSearchSources: (sources, options) => synchronizeSearchSources(sources, options),
      indexCanonicalSearch: async () => {},
      tombstoneCanonicalSearch: async () => {},
      close: async () => { closeSearchIndex() }
    }
    const local = new SearchIndexWriteCoordinator(inProcess)
    coordinators.push(local)
    expect(await local.requestIntegrityCheck('cli')).toEqual({ trigger: 'cli', status: 'unsupported' })

    await expect(runLibraryWorkerRequest({ type: 'search-integrity-check', trigger: 'main' }))
      .rejects.toThrow('PRAGMA quick_check on search.db runs only in the library worker thread')
  }, 60_000)
})
