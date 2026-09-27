/**
 * F1d-3: search.db is a derived index. When SQLite itself calls it corrupt or
 * not a database, the thread that owns the writer moves the file and its
 * -wal/-shm aside whole (search-backups/, same volume, nothing deleted),
 * creates an empty index and runs the operation again; a query that meets a
 * corrupt index answers nothing and reports it, but never moves the file;
 * BUSY/LOCKED are never corruption; a healthy index is never touched. Every
 * index here is synthetic, damaged by __fixtures__/search-index-corruption.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import {
  closeSearchIndex,
  isSearchIndexCorruption,
  probeSearchProjection,
  searchDatabasePath,
  searchFTS,
  searchIndexConnectionStats,
  synchronizeSearchSources,
  type SearchIndexEvent,
  type SearchIndexSource
} from './search-index'
import { SEARCH_INDEX_BACKUP_FILE_NAME, searchIndexBackupDirectory } from './program-backups'
import {
  breakFullTextPages,
  overwriteSearchIndexHeader,
  truncateSearchIndex
} from './__fixtures__/search-index-corruption'

let root = ''
let priorIndexDir: string | undefined
let priorBusyTimeout: string | undefined
const events: SearchIndexEvent[] = []
const listener = (event: SearchIndexEvent): void => { events.push(event) }

beforeEach(() => {
  closeSearchIndex()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-repair-'))
  priorIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  priorBusyTimeout = process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS
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
  if (priorBusyTimeout === undefined) delete process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS
  else process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS = priorBusyTimeout
  fs.rmSync(searchIndexBackupDirectory(), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

const TOKENS = ['alpharepair', 'bravorepair', 'charlierepair']

function writeSession(token: string, extra = ''): string {
  const filePath = path.join(root, 'sources', `${token}.jsonl`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const rows = [
    { uuid: `${token}-u`, parentUuid: null, sessionId: `${token}-session`, type: 'user', timestamp: '2026-09-28T00:00:00.000Z', message: { role: 'user', content: `${token} question` } },
    { uuid: `${token}-a`, parentUuid: `${token}-u`, sessionId: `${token}-session`, type: 'assistant', timestamp: '2026-09-28T00:00:01.000Z', message: { role: 'assistant', content: `${token} answer ${extra}` } }
  ]
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return filePath
}

function sources(): SearchIndexSource[] {
  return TOKENS.map((token) => ({ filePath: writeSession(token) }))
}

/** A healthy synthetic index of the three sessions, closed (checkpointed, no -wal/-shm). */
async function healthyIndex(): Promise<SearchIndexSource[]> {
  const all = sources()
  await synchronizeSearchSources(all)
  closeSearchIndex()
  expect(fs.existsSync(`${searchDatabasePath()}-wal`)).toBe(false)
  return all
}

function identity(filePath: string): { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number } {
  const stat = fs.lstatSync(filePath)
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

function backups(): string[] {
  try {
    return fs.readdirSync(searchIndexBackupDirectory()).sort()
  } catch {
    return []
  }
}

/** The moved indexes themselves, without the -wal/-shm SQLite kept beside them. */
function backupSets(): string[] {
  return backups().filter((name) => name.endsWith('.db.corrupt'))
}

/** What a repair moved: the file and each companion it reports, under the backup name. */
function expectedBackupFiles(repaired: SearchIndexEvent): string[] {
  const name = String(repaired.backupFileName)
  return [
    name,
    ...(Number(repaired.shmBytes) > 0 ? [`${name}-shm`] : []),
    ...(fs.existsSync(path.join(searchIndexBackupDirectory(), `${name}-wal`)) ? [`${name}-wal`] : [])
  ].sort()
}

const named = (name: string): SearchIndexEvent[] => events.filter((event) => event.event === name)

describe('search.db repair (F1d-3)', () => {
  it('only SQLite\'s corrupt / not-a-database verdicts count as corruption, never BUSY or LOCKED', () => {
    for (const code of ['SQLITE_CORRUPT', 'SQLITE_CORRUPT_VTAB', 'SQLITE_CORRUPT_INDEX', 'SQLITE_NOTADB']) {
      expect(isSearchIndexCorruption(Object.assign(new Error(code), { code })), code).toBe(true)
    }
    for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_IOERR', 'SQLITE_CANTOPEN', 'SQLITE_FULL', 'EACCES']) {
      expect(isSearchIndexCorruption(Object.assign(new Error(code), { code })), code).toBe(false)
    }
    expect(isSearchIndexCorruption(new Error('database disk image is malformed'))).toBe(false)
    expect(isSearchIndexCorruption(null)).toBe(false)
  })

  it('a truncated index is moved aside whole, rebuilt, and the full sync that found it runs again', async () => {
    const all = await healthyIndex()
    truncateSearchIndex(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())

    await synchronizeSearchSources(all)

    const repaired = named('search-index-repaired')
    expect(repaired).toHaveLength(1)
    expect(repaired[0]).toMatchObject({
      operation: 'full-sync',
      reason: 'SQLITE_CORRUPT',
      bytes: corrupt.size,
      journalBytes: 0,
      complete: true,
      rebuilt: true
    })
    expect(repaired[0].ms).toEqual(expect.any(Number))
    const backupFileName = String(repaired[0].backupFileName)
    expect(backupFileName).toMatch(SEARCH_INDEX_BACKUP_FILE_NAME)
    // Moved, not copied or rewritten: the same file, the same size, and only
    // the -wal/-shm SQLite had opened beside it (the WAL still empty).
    expect(backups()).toEqual(expectedBackupFiles(repaired[0]))
    expect(backupSets()).toEqual([backupFileName])
    expect(repaired[0].walBytes).toBe(0)
    const moved = identity(path.join(searchIndexBackupDirectory(), backupFileName))
    expect({ dev: moved.dev, ino: moved.ino, size: moved.size, mtimeMs: moved.mtimeMs })
      .toEqual({ dev: corrupt.dev, ino: corrupt.ino, size: corrupt.size, mtimeMs: corrupt.mtimeMs })
    // A new file in its place, filled again: search is back.
    expect(identity(searchDatabasePath()).ino).not.toBe(corrupt.ino)
    for (const token of TOKENS) expect(searchFTS(token), token).toHaveLength(1)
    expect(probeSearchProjection()).toEqual({ legacyRows: 3, staleLegacyRows: 0 })
    expect(named('search-index-repair-failed')).toEqual([])
  })

  it('a file whose header is not SQLite\'s reports SQLITE_NOTADB and is repaired the same way', async () => {
    const all = await healthyIndex()
    overwriteSearchIndexHeader(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())

    await synchronizeSearchSources([all[0]], { prune: false })

    expect(named('search-index-repaired')).toEqual([expect.objectContaining({
      operation: 'live-sync', reason: 'SQLITE_NOTADB', bytes: corrupt.size, complete: true, rebuilt: true
    })])
    expect(backupSets()).toHaveLength(1)
    // A live pass re-projects its own source; a full pass brings back the rest.
    expect(searchFTS(TOKENS[0])).toHaveLength(1)
    expect(searchFTS(TOKENS[1])).toHaveLength(0)
    await synchronizeSearchSources(all)
    for (const token of TOKENS) expect(searchFTS(token), token).toHaveLength(1)
    expect(named('search-index-repaired')).toHaveLength(1)
  })

  it('broken full-text pages: a search answers nothing and reports it once, and never moves the file; the writer that meets them repairs', async () => {
    const all = await healthyIndex()
    breakFullTextPages(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())

    expect(searchFTS(TOKENS[0])).toEqual([])
    expect(searchFTS(TOKENS[1])).toEqual([])
    expect(named('search-index-read-corrupt')).toEqual([
      { event: 'search-index-read-corrupt', operation: 'search', reason: expect.stringMatching(/^SQLITE_CORRUPT/) }
    ])
    // The reader moved nothing and wrote nothing.
    const afterReads = identity(searchDatabasePath())
    expect(afterReads).toEqual(corrupt)
    expect(backups()).toEqual([])
    expect(named('search-index-repaired')).toEqual([])

    // A changed session: its projection rewrites full-text rows, and the writer repairs.
    fs.writeFileSync(all[1].filePath, fs.readFileSync(all[1].filePath, 'utf8') + JSON.stringify({
      uuid: 'late', parentUuid: null, sessionId: `${TOKENS[1]}-session`, type: 'user',
      timestamp: '2026-09-28T00:01:00.000Z', message: { role: 'user', content: 'lateaddition marker' }
    }) + '\n')
    await synchronizeSearchSources([all[1]], { prune: false })
    expect(named('search-index-repaired')).toEqual([expect.objectContaining({
      operation: 'live-sync', reason: expect.stringMatching(/^SQLITE_CORRUPT/), bytes: corrupt.size
    })])
    expect(searchFTS('lateaddition')).toHaveLength(1)
    await synchronizeSearchSources(all)
    for (const token of TOKENS) expect(searchFTS(token), token).toHaveLength(1)
  })

  it('the startup probe that meets a corrupt index answers null, reports it once, and never moves the file', async () => {
    await healthyIndex()
    truncateSearchIndex(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())

    expect(probeSearchProjection()).toBeNull()
    expect(probeSearchProjection()).toBeNull()

    expect(events).toEqual([{ event: 'search-index-read-corrupt', operation: 'probe', reason: 'SQLITE_CORRUPT' }])
    expect(identity(searchDatabasePath())).toEqual(corrupt)
    expect(backups()).toEqual([])
  })

  it('the -wal and -shm move with the file, so the rebuilt index never meets the old WAL', async () => {
    const all = await healthyIndex()
    // A second writer leaves frames in the WAL; copies of its -wal/-shm stand in for a crash.
    const other = new Database(searchDatabasePath())
    other.prepare("INSERT INTO messages_fts(session_id, file_path, role, text, timestamp) VALUES ('x', 'x', 'user', 'walonlymarker', '')").run()
    const walCopy = fs.readFileSync(`${searchDatabasePath()}-wal`)
    const shmCopy = fs.readFileSync(`${searchDatabasePath()}-shm`)
    other.close()
    fs.writeFileSync(`${searchDatabasePath()}-wal`, walCopy)
    fs.writeFileSync(`${searchDatabasePath()}-shm`, shmCopy)
    overwriteSearchIndexHeader(searchDatabasePath())
    const before = {
      main: identity(searchDatabasePath()),
      wal: identity(`${searchDatabasePath()}-wal`),
      shm: identity(`${searchDatabasePath()}-shm`)
    }
    expect(before.wal.size).toBeGreaterThan(0)

    await synchronizeSearchSources(all)

    const [repaired] = named('search-index-repaired')
    expect(repaired).toMatchObject({ reason: 'SQLITE_NOTADB', bytes: before.main.size, walBytes: before.wal.size, shmBytes: before.shm.size, complete: true })
    const name = String(repaired.backupFileName)
    expect(backups()).toEqual([name, `${name}-shm`, `${name}-wal`].sort())
    expect(identity(path.join(searchIndexBackupDirectory(), `${name}-wal`)).ino).toBe(before.wal.ino)
    expect(identity(path.join(searchIndexBackupDirectory(), `${name}-shm`)).ino).toBe(before.shm.ino)
    // The old frames went with the file: the rebuilt index knows only what was projected into it.
    expect(searchFTS('walonlymarker')).toEqual([])
    for (const token of TOKENS) expect(searchFTS(token), token).toHaveLength(1)
    for (const suffix of ['-wal', '-shm']) {
      const current = `${searchDatabasePath()}${suffix}`
      if (fs.existsSync(current)) expect(identity(current).ino, suffix).not.toBe(before[suffix === '-wal' ? 'wal' : 'shm'].ino)
    }
  })

  it('BUSY is never corruption: a locked index is left in place and the error stands', async () => {
    const all = await healthyIndex()
    const holder = new Database(searchDatabasePath())
    holder.exec('BEGIN EXCLUSIVE')
    const before = identity(searchDatabasePath())
    process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS = '0'
    try {
      writeSession(TOKENS[0], 'changed so the pass has to write')
      await expect(synchronizeSearchSources(all)).rejects.toMatchObject({ code: expect.stringMatching(/^SQLITE_BUSY/) })
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(events).toEqual([])
    expect(backups()).toEqual([])
    expect(identity(searchDatabasePath()).ino).toBe(before.ino)
  })

  it('a healthy index is never written by the repair machinery (lstat)', async () => {
    const all = await healthyIndex()
    const dbPath = searchDatabasePath()
    const stateDirectory = path.dirname(searchIndexBackupDirectory())
    const stateBefore = fs.existsSync(stateDirectory) ? fs.readdirSync(stateDirectory).sort() : []
    const closed = identity(dbPath)

    // Read paths: a search (twice) and the startup probe.
    for (const token of TOKENS) expect(searchFTS(token)).toHaveLength(1)
    expect(searchFTS(TOKENS[0])).toHaveLength(1)
    expect(probeSearchProjection()).toEqual({ legacyRows: 3, staleLegacyRows: 0 })
    expect(identity(dbPath)).toEqual(closed)
    // A read-only open of a WAL index creates SQLite's own empty -wal/-shm; nothing is written into them.
    if (fs.existsSync(`${dbPath}-wal`)) expect(fs.statSync(`${dbPath}-wal`).size).toBe(0)

    // Writer path: once its connection is open, an unchanged pass only reads.
    await synchronizeSearchSources(all)
    const open = { main: identity(dbPath), wal: identity(`${dbPath}-wal`) }
    await synchronizeSearchSources(all)
    await synchronizeSearchSources([all[0]], { prune: false })
    expect({ main: identity(dbPath), wal: identity(`${dbPath}-wal`) }).toEqual(open)

    expect(events).toEqual([])
    expect(backups()).toEqual([])
    expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
    expect(fs.existsSync(stateDirectory) ? fs.readdirSync(stateDirectory).sort() : []).toEqual(stateBefore)
    expect(identity(dbPath).ino).toBe(closed.ino)
  })

  it('a second corruption within the repair interval is reported once and left where it is', async () => {
    const all = await healthyIndex()
    truncateSearchIndex(searchDatabasePath())
    await synchronizeSearchSources(all)
    expect(named('search-index-repaired')).toHaveLength(1)

    // The writer moves to another index and back, so it opens the file again
    // (as the app's long-lived worker would), keeping its repair interval.
    const indexDirectory = process.env.SWOB_SEARCH_INDEX_DIR!
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'other-index')
    await synchronizeSearchSources([{ filePath: writeSession('otherindexmarker') }])
    process.env.SWOB_SEARCH_INDEX_DIR = indexDirectory
    overwriteSearchIndexHeader(searchDatabasePath())
    const second = identity(searchDatabasePath())
    await expect(synchronizeSearchSources(all)).rejects.toMatchObject({ code: 'SQLITE_NOTADB' })
    await expect(synchronizeSearchSources(all)).rejects.toMatchObject({ code: 'SQLITE_NOTADB' })

    expect(named('search-index-repaired')).toHaveLength(1)
    expect(named('search-index-repair-deferred')).toEqual([
      expect.objectContaining({ operation: 'full-sync', reason: 'SQLITE_NOTADB', sinceLastRepairMs: expect.any(Number) })
    ])
    expect(identity(searchDatabasePath())).toEqual(second)
    expect(backupSets()).toHaveLength(1)
  })

  it('a later repair retires the earlier moved index only once its own copy is whole on disk (N = 1), logging each deletion before and after', async () => {
    const all = await healthyIndex()
    truncateSearchIndex(searchDatabasePath())
    await synchronizeSearchSources(all)
    const first = String(named('search-index-repaired')[0].backupFileName)
    const firstFiles = backups()
    expect(backupSets()).toEqual([first])
    expect(events.filter((event) => event.event.startsWith('program-backup'))).toEqual([])

    // A new writer (as after the worker is recycled) and a second corruption.
    closeSearchIndex()
    await new Promise((resolve) => setTimeout(resolve, 2))
    overwriteSearchIndexHeader(searchDatabasePath())
    events.length = 0
    await synchronizeSearchSources(all)

    const second = String(named('search-index-repaired')[0].backupFileName)
    expect(second > first).toBe(true)
    expect(named('search-index-repaired')[0]).toMatchObject({ complete: true })
    expect(backupSets()).toEqual([second])
    expect(backups().every((name) => name.startsWith(second))).toBe(true)
    const pruning = events.filter((event) => event.event.startsWith('program-backup'))
    expect(pruning).toHaveLength(firstFiles.length * 2)
    for (const name of firstFiles) {
      expect(pruning.filter((event) => event.fileName === name).map((event) => event.event), name)
        .toEqual(['program-backup-deleting', 'program-backup-deleted'])
    }
    expect(pruning.every((event) => event.kind === 'search-index' && event.rule === 'count')).toBe(true)
    // The new copy was reported whole before anything was deleted.
    expect(events.findIndex((event) => event.event === 'search-index-repaired'))
      .toBeLessThan(events.findIndex((event) => event.event === 'program-backup-deleting'))
    for (const token of TOKENS) expect(searchFTS(token), token).toHaveLength(1)
  })

  it('an unusable backup directory leaves the corrupt file where it is and the error stands', async () => {
    const all = await healthyIndex()
    fs.mkdirSync(path.dirname(searchIndexBackupDirectory()), { recursive: true })
    fs.writeFileSync(searchIndexBackupDirectory(), 'a file where the directory should be')
    overwriteSearchIndexHeader(searchDatabasePath())
    const corrupt = identity(searchDatabasePath())

    await expect(synchronizeSearchSources(all)).rejects.toMatchObject({ code: 'SQLITE_NOTADB' })

    expect(named('search-index-repair-failed')).toEqual([
      expect.objectContaining({ operation: 'full-sync', reason: 'SQLITE_NOTADB', why: 'backup-directory' })
    ])
    expect(named('search-index-repaired')).toEqual([])
    expect(identity(searchDatabasePath())).toEqual(corrupt)
    expect(fs.readFileSync(searchIndexBackupDirectory(), 'utf8')).toBe('a file where the directory should be')
  })

  it('a source whose own store fails with a SQLite error never moves search.db', async () => {
    const all = await healthyIndex()
    writeSession(TOKENS[2], 'changed so its loader runs')
    const before = identity(searchDatabasePath())
    const failingStore: SearchIndexSource = {
      filePath: all[2].filePath,
      loadRaw: () => Promise.reject(Object.assign(new Error('source database disk image is malformed'), { code: 'SQLITE_CORRUPT' }))
    }

    await synchronizeSearchSources([all[0], all[1], failingStore])

    expect(events).toEqual([])
    expect(backups()).toEqual([])
    expect(identity(searchDatabasePath()).ino).toBe(before.ino)
    expect(searchFTS(TOKENS[0])).toHaveLength(1)
    // The unreadable source is dropped from the index, as before F1d-3.
    expect(searchFTS(TOKENS[2])).toEqual([])
  })

  it('the read connection follows another file put at the path, without any signal', async () => {
    const all = await healthyIndex()
    expect(searchFTS(TOKENS[0])).toHaveLength(1)
    const opens = searchIndexConnectionStats().readOpens

    // Another index takes the path (its old -wal/-shm moved away, as a
    // repair moves them) while this thread's read connection stays open on
    // the old file, and no event says so.
    const replacement = path.join(root, 'replacement.db')
    fs.copyFileSync(searchDatabasePath(), replacement)
    const other = new Database(replacement)
    other.prepare('DELETE FROM messages_fts WHERE file_path = ?').run(all[0].filePath)
    other.prepare(
      "INSERT INTO messages_fts(session_id, file_path, role, text, timestamp) VALUES (?, ?, 'user', 'replacementmarker question', '')"
    ).run(`${TOKENS[0]}-session`, all[0].filePath)
    other.close()
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(searchDatabasePath() + suffix)) fs.renameSync(searchDatabasePath() + suffix, path.join(root, `moved${suffix}`))
    }
    fs.renameSync(replacement, searchDatabasePath())
    expect(searchIndexConnectionStats().hasReadConnection).toBe(true)

    expect(searchFTS('replacementmarker')).toHaveLength(1)
    expect(searchFTS(TOKENS[0])).toEqual([])
    expect(searchIndexConnectionStats().readOpens).toBe(opens + 1)
    expect(events).toEqual([])
  })

  it('reports carry file names, sizes and durations, never a path', async () => {
    const all = await healthyIndex()
    breakFullTextPages(searchDatabasePath())
    searchFTS(TOKENS[0])
    probeSearchProjection()
    truncateSearchIndex(searchDatabasePath())
    await synchronizeSearchSources(all)
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining(['search-index-read-corrupt', 'search-index-repaired']))
    const text = JSON.stringify(events)
    expect(text).not.toContain(root)
    expect(text).not.toContain(os.homedir())
    expect(text).not.toContain('/')
  })
})

