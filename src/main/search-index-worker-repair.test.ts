/**
 * F1d-3 across the real thread boundary: in the app the library worker owns
 * search.db's writer and the main thread keeps a module-level read
 * connection (search-index.ts). A repair in the worker must (S1) close the
 * main thread's read connection, which would otherwise go on reading the
 * moved file, before the worker's reply arrives, and (S2) reach the main
 * thread as a structured event (WorkerReply 'search-index-event' ->
 * process 'swob:search-index-event', which index.ts writes to
 * lifecycle.log). The worker is bundled from source as the app bundles it.
 * The index is synthetic.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { LibraryWorkerClient } from './library-worker'
import {
  closeSearchIndex,
  searchDatabasePath,
  searchFTS,
  searchIndexConnectionStats,
  synchronizeSearchSources,
  type SearchIndexEvent
} from './search-index'
import { searchIndexBackupDirectory } from './program-backups'
import { buildProductionLibraryWorker } from './__test-support__/production-library-worker'
import { breakPageHeaders, overwriteSearchIndexHeader } from './__fixtures__/search-index-corruption'

let buildRoot = ''
let workerPath = ''
let root = ''
let priorIndexDir: string | undefined
const events: SearchIndexEvent[] = []
const listener = (event: SearchIndexEvent): void => { events.push(event) }

beforeAll(async () => {
  buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-worker-build-'))
  workerPath = await buildProductionLibraryWorker(buildRoot)
}, 120_000)

afterAll(() => {
  fs.rmSync(buildRoot, { recursive: true, force: true })
})

beforeEach(() => {
  closeSearchIndex()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-worker-repair-'))
  priorIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'index')
  fs.rmSync(searchIndexBackupDirectory(), { recursive: true, force: true })
  events.length = 0
  process.on('swob:search-index-event', listener)
})

afterEach(() => {
  process.off('swob:search-index-event', listener)
  closeSearchIndex()
  if (priorIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = priorIndexDir
  fs.rmSync(searchIndexBackupDirectory(), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

function writeSession(token: string): string {
  const filePath = path.join(root, 'sources', `${token}.jsonl`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify({
    uuid: `${token}-u`, parentUuid: null, sessionId: `${token}-session`, type: 'user',
    timestamp: '2026-09-28T00:00:00.000Z', message: { role: 'user', content: `${token} question` }
  }) + '\n')
  return filePath
}

describe('search.db repair across the worker boundary (F1d-3)', () => {
  it('a repair in the worker closes the main thread\'s read connection before the reply, and reaches it as an event', async () => {
    const tokens = ['deltaworker', 'echoworker']
    const descriptors = tokens.map((token) => ({ filePath: writeSession(token), sessionId: `${token}-session`, source: 'claude-code' }))
    await synchronizeSearchSources(descriptors)
    closeSearchIndex()
    // The main thread reads, as the search IPC does: its connection stays open.
    expect(searchFTS(tokens[0])).toHaveLength(1)
    expect(searchIndexConnectionStats().hasReadConnection).toBe(true)
    const corruptIno = fs.statSync(searchDatabasePath()).ino
    overwriteSearchIndexHeader(searchDatabasePath())

    const worker = new LibraryWorkerClient(workerPath)
    try {
      await worker.syncSearchSources(descriptors, { prune: true })

      // S1: closed by the worker's event, before any new query could look at the path.
      expect(searchIndexConnectionStats().hasReadConnection).toBe(false)
      // S2: the repair arrived on this thread as one structured event.
      expect(events).toEqual([expect.objectContaining({
        event: 'search-index-repaired',
        operation: 'full-sync',
        reason: 'SQLITE_NOTADB',
        complete: true,
        rebuilt: true
      })])
      const backupFileName = String(events[0].backupFileName)
      expect(fs.statSync(path.join(searchIndexBackupDirectory(), backupFileName)).ino).toBe(corruptIno)
      expect(fs.statSync(searchDatabasePath()).ino).not.toBe(corruptIno)
      // The next query opens the index the worker rebuilt.
      for (const token of tokens) expect(searchFTS(token), token).toHaveLength(1)
    } finally {
      await worker.close()
    }
  }, 60_000)

  it('③ F1d-3-b: a writer that holds the old file while the worker repairs it (as a CLI process would) writes into the rebuilt index at its next operation; neither writer writes the moved copy again', async () => {
    const descriptor = (token: string) => ({ filePath: writeSession(token), sessionId: `${token}-session`, source: 'claude-code' })
    const initial = ['kiloworker', 'limaworker'].map(descriptor)
    // This thread is the other writer: it never armed the self-heal (like the
    // CLI), and its connection stays open on the file.
    await synchronizeSearchSources(initial)
    expect(searchIndexConnectionStats().hasWriteConnection).toBe(true)
    // Its pages go into the file (the WAL emptied); then damage only a
    // Library-backup projection meets (the backup table's own pages). A
    // plain session's projection never reads them: this writer could go on
    // writing into the file, as the app's writer did in the F1d-3 case.
    const checkpoint = new Database(searchDatabasePath())
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
    const backupTable = (checkpoint.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'library_backup'").get() as { rootpage: number }).rootpage
    checkpoint.close()
    breakPageHeaders(searchDatabasePath(), [backupTable])
    const corruptIno = fs.statSync(searchDatabasePath()).ino

    const worker = new LibraryWorkerClient(workerPath)
    try {
      const backup = { ...descriptor('oscarbackup'), source: 'library-backup', isLibraryBackup: true }
      await worker.syncSearchSources([backup], { prune: false })
      const [repaired] = events.filter((event) => event.event === 'search-index-repaired')
      expect(repaired).toMatchObject({ operation: 'live-sync', reason: expect.stringMatching(/^SQLITE_CORRUPT/), complete: true, rebuilt: true })
      const moved = path.join(searchIndexBackupDirectory(), String(repaired.backupFileName))
      expect(fs.statSync(moved).ino).toBe(corruptIno)
      const movedFiles = (): string[] => fs.readdirSync(searchIndexBackupDirectory()).sort().map((name) => {
        const stat = fs.lstatSync(path.join(searchIndexBackupDirectory(), name))
        return `${name}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
      })
      const afterRepair = movedFiles()

      // The other writer's next operation lands in the rebuilt index, not in
      // the copy it had open (F1d-3 verification C1 had two rows land there).
      const fromOther = descriptor('mikeother')
      await synchronizeSearchSources([fromOther], { prune: false })
      // So do the worker's own next writes, and the re-projection the app runs after a repair.
      const fromWorker = descriptor('novemberworker')
      await worker.syncSearchSources([fromWorker], { prune: false })
      await worker.syncSearchSources(initial, { prune: false })

      for (const token of ['kiloworker', 'limaworker', 'mikeother', 'novemberworker', 'oscarbackup']) {
        expect(searchFTS(token), token).toHaveLength(1)
      }
      expect(movedFiles()).toEqual(afterRepair)
      expect(events.map((event) => event.event)).toEqual(['search-index-repaired'])
    } finally {
      await worker.close()
    }
  }, 60_000)
})
