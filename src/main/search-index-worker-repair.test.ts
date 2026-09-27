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
import { overwriteSearchIndexHeader } from './__fixtures__/search-index-corruption'

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
})
