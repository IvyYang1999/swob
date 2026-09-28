/**
 * F1d-3-b: a CLI command that meets a corrupt search.db leaves it as it is.
 * It moves nothing, rebuilds nothing and prunes nothing (only the Swob app's
 * library worker repairs the index), it writes nothing more into the file
 * (lstat and bytes unchanged, its -wal too), and `swob grep` exits 1 with one
 * actionable line: 「搜索索引损坏，打开 Swob 让它自愈」. The CLI runs from the
 * repository entry (runCli), in this test's own HOME; every index is
 * synthetic, damaged by main/__fixtures__/search-index-corruption.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import type { CliIo } from './index'
import type { SearchIndexEvent } from '../main/search-index'
import {
  breakFullTextPages,
  breakPageHeaders,
  overwriteSearchIndexHeader,
  truncateSearchIndex
} from '../main/__fixtures__/search-index-corruption'

let tempHome = ''
let libraryRoot = ''
let sourcePath = ''
let previousHome: string | undefined
let previousIndexDir: string | undefined
let runCli: typeof import('./index').runCli
let closeSearchIndex: typeof import('../main/search-index').closeSearchIndex
let searchDatabasePath: typeof import('../main/search-index').searchDatabasePath
let closeSearchIndexWriteCoordinator: typeof import('../main/search-index-writer').closeSearchIndexWriteCoordinator
let searchIndexBackupDirectory: typeof import('../main/program-backups').searchIndexBackupDirectory
let closeCanonicalSessionStore: typeof import('../main/canonical-store').closeCanonicalSessionStore
const events: SearchIndexEvent[] = []
const listener = (event: SearchIndexEvent): void => { events.push(event) }

const NEEDLE = 'corruptclineedle'
const MESSAGE = '搜索索引损坏，打开 Swob 让它自愈'

function writeSource(): void {
  const sourceDir = path.join(tempHome, '.claude', 'projects', '-repo-corrupt')
  fs.mkdirSync(sourceDir, { recursive: true })
  sourcePath = path.join(sourceDir, 'corrupt-cli-session.jsonl')
  fs.writeFileSync(sourcePath, [
    {
      uuid: 'u1', parentUuid: null, sessionId: 'corrupt-cli-session', type: 'user',
      cwd: '/repo/corrupt', timestamp: '2026-09-28T00:00:00.000Z',
      message: { role: 'user', content: `${NEEDLE} question` }
    },
    {
      uuid: 'a1', parentUuid: 'u1', sessionId: 'corrupt-cli-session', type: 'assistant',
      cwd: '/repo/corrupt', timestamp: '2026-09-28T00:00:01.000Z',
      message: { role: 'assistant', model: 'test-model', content: [{ type: 'text', text: `${NEEDLE} answer` }] }
    }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
}

interface Invocation {
  code: number
  stdout: string
  stderr: string
}

async function invoke(args: string[]): Promise<Invocation> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    stdout: (value) => { stdout += value },
    stderr: (value) => { stderr += value },
    readStdin: async () => ''
  }
  const code = await runCli(args, io, { libraryRoot })
  return { code, stdout, stderr }
}

/** search.db as the file system sees it, and whatever SQLite keeps beside it. */
function indexState(): { main: string; wal: string | null; shm: boolean; bytes: string } {
  const stat = fs.lstatSync(searchDatabasePath())
  const wal = `${searchDatabasePath()}-wal`
  return {
    main: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`,
    wal: fs.existsSync(wal) ? `${fs.lstatSync(wal).ino}:${fs.readFileSync(wal).toString('base64')}` : null,
    shm: fs.existsSync(`${searchDatabasePath()}-shm`),
    bytes: fs.readFileSync(searchDatabasePath()).toString('base64')
  }
}

/** A healthy index built by the CLI itself, closed. */
async function healthyIndex(): Promise<void> {
  await closeSearchIndexWriteCoordinator()
  closeSearchIndex()
  fs.rmSync(path.dirname(searchDatabasePath()), { recursive: true, force: true })
  const built = await invoke(['grep', NEEDLE, '--json'])
  expect(built.code, built.stderr).toBe(0)
  expect(JSON.parse(built.stdout)).toMatchObject({ sessionCount: 1 })
  expect(fs.existsSync(`${searchDatabasePath()}-wal`)).toBe(false)
  events.length = 0
}

/** Break a table's root page; the lookup connection is the last one and leaves no -wal/-shm behind. */
function breakTable(name: string): void {
  const db = new Database(searchDatabasePath(), { fileMustExist: true })
  let page: number
  try {
    page = (db.prepare('SELECT rootpage FROM sqlite_master WHERE name = ?').get(name) as { rootpage: number }).rootpage
  } finally {
    db.close()
  }
  breakPageHeaders(searchDatabasePath(), [page])
}

function expectCorruptFailure(invocation: Invocation, reason: RegExp): void {
  expect(invocation.code).toBe(1)
  expect(invocation.stdout).toBe('')
  const lines = invocation.stderr.split('\n').filter(Boolean)
  expect(lines, invocation.stderr).toHaveLength(1)
  const { error } = JSON.parse(lines[0])
  expect(error).toEqual({ message: MESSAGE, code: 'SEARCH_INDEX_CORRUPT', hint: expect.any(String), retryable: true })
  expect(error.hint).toMatch(reason)
}

beforeAll(async () => {
  previousHome = process.env.HOME
  previousIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-corrupt-index-'))
  libraryRoot = path.join(tempHome, 'Vault')
  process.env.HOME = tempHome
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(tempHome, 'search-index')
  fs.mkdirSync(libraryRoot, { recursive: true })
  writeSource()
  ;({ runCli } = await import('./index'))
  ;({ closeSearchIndex, searchDatabasePath } = await import('../main/search-index'))
  ;({ closeSearchIndexWriteCoordinator } = await import('../main/search-index-writer'))
  ;({ searchIndexBackupDirectory } = await import('../main/program-backups'))
  ;({ closeCanonicalSessionStore } = await import('../main/canonical-store'))
})

afterAll(async () => {
  await closeSearchIndexWriteCoordinator()
  closeSearchIndex()
  closeCanonicalSessionStore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = previousIndexDir
  fs.rmSync(tempHome, { recursive: true, force: true })
})

beforeEach(() => {
  events.length = 0
  process.on('swob:search-index-event', listener)
})

afterEach(async () => {
  process.off('swob:search-index-event', listener)
  await closeSearchIndexWriteCoordinator()
  closeSearchIndex()
})

describe.sequential('CLI on a corrupt search.db (F1d-3-b)', () => {
  it('on a healthy index a grep writes nothing to it (each run opens a new writer)', async () => {
    await healthyIndex()
    const before = indexState()

    const again = await invoke(['grep', NEEDLE, '--json'])

    expect(again.code, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ sessionCount: 1, matchCount: 2 })
    expect(indexState()).toEqual(before)
    expect(before).toMatchObject({ wal: null, shm: false })
    expect(events).toEqual([])
  })

  const damages: Array<{ damage: string; apply: () => void; reason: RegExp; operation: string }> = [
    { damage: 'truncated', apply: () => truncateSearchIndex(searchDatabasePath()), reason: /SQLITE_CORRUPT/, operation: 'full-sync' },
    { damage: 'not a database', apply: () => overwriteSearchIndexHeader(searchDatabasePath()), reason: /SQLITE_NOTADB/, operation: 'full-sync' },
    { damage: 'broken session rows', apply: () => breakTable('sessions'), reason: /SQLITE_CORRUPT/, operation: 'full-sync' },
    // The legacy pass reads sessions only; the grep query itself meets the damage.
    { damage: 'broken full-text pages', apply: () => breakFullTextPages(searchDatabasePath()), reason: /SQLITE_CORRUPT/, operation: 'grep' }
  ]
  for (const { damage, apply, reason, operation } of damages) {
    it(`${damage}: grep exits 1 with the one line, and leaves the file byte for byte (nothing moved, rebuilt or pruned)`, async () => {
      await healthyIndex()
      apply()
      const before = indexState()

      const invocation = await invoke(['grep', NEEDLE, '--json'])

      expectCorruptFailure(invocation, reason)
      expect(indexState()).toEqual(before)
      expect(before).toMatchObject({ wal: null, shm: false })
      expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
      expect(events).toEqual([{ event: 'search-index-left-corrupt', operation, reason: expect.stringMatching(reason) }])
    })
  }

  it('frames a crashed app left in the WAL stay there: the corrupt file is not checkpointed into, its -wal is kept byte for byte', async () => {
    await healthyIndex()
    breakFullTextPages(searchDatabasePath())
    const crashed = new Database(searchDatabasePath())
    crashed.prepare('UPDATE sessions SET first_user_message = ? WHERE session_id = ?').run('walonlymarker', 'corrupt-cli-session')
    // Closed while a read-only connection holds the file: it checkpoints nothing, as a crash would.
    const holder = new Database(searchDatabasePath(), { readonly: true, fileMustExist: true })
    holder.pragma('schema_version')
    crashed.close()
    holder.close()
    const before = indexState()
    expect(before.wal).not.toBeNull()

    const invocation = await invoke(['grep', NEEDLE, '--json'])

    expectCorruptFailure(invocation, /SQLITE_CORRUPT/)
    expect(indexState()).toMatchObject({ main: before.main, wal: before.wal, bytes: before.bytes })
    expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
  })

  it('a corrupt index met by the canonical projection: grep writes nothing more (no legacy pass, no query) and says so', async () => {
    const piPath = path.join(tempHome, '.pi', 'agent', 'sessions', 'corrupt', 'session.jsonl')
    fs.mkdirSync(path.dirname(piPath), { recursive: true })
    fs.copyFileSync(path.resolve(__dirname, '../../testdata/pi/session.jsonl'), piPath)
    try {
      await healthyIndex()
      overwriteSearchIndexHeader(searchDatabasePath())
      const before = indexState()

      const invocation = await invoke(['grep', NEEDLE, '--json'])

      expectCorruptFailure(invocation, /SQLITE_NOTADB/)
      expect(indexState()).toEqual(before)
      expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
      expect(events).toEqual([{ event: 'search-index-left-corrupt', operation: 'canonical-index', reason: 'SQLITE_NOTADB' }])

      // A command that only projects into the index (list) still answers, and moves nothing either.
      events.length = 0
      const listed = await invoke(['list', '--json'])
      expect(listed.code, listed.stderr).toBe(0)
      expect(JSON.parse(listed.stdout)).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'corrupt-cli-session' })]))
      expect(listed.stderr).toContain('search.db is corrupt (SQLITE_NOTADB)')
      expect(indexState()).toEqual(before)
      expect(fs.existsSync(searchIndexBackupDirectory())).toBe(false)
    } finally {
      fs.rmSync(path.join(tempHome, '.pi'), { recursive: true, force: true })
    }
  })
})
