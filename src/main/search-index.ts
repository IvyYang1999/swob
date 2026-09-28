import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { parseSessionFile } from './session-loader'
import type { RawJsonlMessage } from './session-types'
import type {
  CanonicalRecord,
  MessageRecord,
  SessionRecord,
  ToolCallRecord,
  ToolResultEvent
} from '../shared/provider-schema.generated'
import { runtimeHome } from './runtime-home'
import {
  stripTerminalControlSequences,
  stripTerminalControlSequencesDeep
} from '../shared/chat-format'
import { builtinProviderForId } from '../shared/provider-capabilities'
import {
  pruneProgramBackups,
  readSearchIndexRepairStamp,
  SEARCH_INDEX_COMPANION_SUFFIXES,
  searchIndexBackupDirectory,
  searchIndexBackupName,
  writeSearchIndexRepairStamp
} from './program-backups'

// v4 rebuilds unchanged files so ANSI/CSI/OSC text cannot survive in old FTS rows.
const SEARCH_SCHEMA_VERSION = 5

/**
 * Version of what a legacy (file-backed) row projects, carried in its
 * file_signature as `p<version>|<mtimeMs>:<size>`. A row of another version
 * (1 was the bare `mtimeMs:size`) no longer matches, so its file is
 * re-projected as a whole by its next full sync, one file per transaction:
 * the old rows stay searchable until then, and an interrupted pass resumes.
 * 2 (F1d): F1a keeps records holding U+2028/U+2029, F1b and F1c-2 change the
 * Codex and Cursor projections. Changing this never drops a table.
 */
export const SEARCH_PROJECTION_VERSION = 2
const SEARCH_PROJECTION_PREFIX = `p${SEARCH_PROJECTION_VERSION}|`

function searchDatabaseBusyTimeoutMs(): number {
  const configured = Number(process.env.SWOB_SEARCH_INDEX_BUSY_TIMEOUT_MS)
  return Number.isFinite(configured) && configured >= 0 ? configured : 3_000
}

export interface SearchIndexSource {
  filePath: string
  sessionId?: string
  source?: string
  isLibraryBackup?: boolean
  /** Physical file used for freshness checks when filePath is a virtual DB session ref. */
  stateFilePath?: string
  /** Source-specific normalizer. Called only when the physical signature changed. */
  loadRaw?: () => Promise<RawJsonlMessage[]>
}

export interface SearchIndexResult {
  sessionId: string
  filePath: string
  firstUserMessage: string
  matches: Array<{ text: string; timestamp: string }>
}

export interface TranscriptGrepFilters {
  source?: string
  sessionIds?: string[]
  after?: string
  before?: string
  project?: string
  limit?: number
}

export interface TranscriptGrepLine {
  role: string
  text: string
  timestamp: string
  matched: boolean
}

export interface TranscriptGrepMatch {
  role: string
  text: string
  timestamp: string
  context: TranscriptGrepLine[]
}

export interface TranscriptGrepResult {
  sessionId: string
  filePath: string
  source: string
  projectPath: string
  matches: TranscriptGrepMatch[]
}

interface IndexedSessionRow {
  file_path: string
  display_path: string
  session_id: string
  file_signature: string
  indexed_size: number
  file_dev: number
  file_ino: number
  indexed_raw_count: number
  project_path: string
  projection_kind: 'legacy' | 'canonical'
}

interface FileState {
  signature: string
  size: number
  dev: number
  ino: number
}

interface SearchRow {
  session_id: string
  index_key: string
  file_path: string
  projection_kind: 'legacy' | 'canonical'
  first_user_message: string
  snippet: string
  timestamp: string
}

interface GrepRow {
  rowid: number
  session_id: string
  file_path: string
  display_path: string
  source: string
  project_path: string
  role: string
  text: string
  timestamp: string
}

interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

export type SearchIndexFileIdentity = FileIdentity

let database: Database.Database | null = null
let databasePath = ''
/** The file this thread's writer connection opened: a repair moves that file and no other (F1d-3). */
let writerFileIdentity: FileIdentity | null = null
/**
 * A writer connection whose schema setup found the file corrupt (F1d-3). It
 * stays open until a repair has moved the file: closing the last connection
 * removes `<path>-wal` and `-shm` by name, which would lose the WAL before it
 * is moved with the file. (Unarmed, F1d-3-b: until closeWritersLeavingFileAsIs.)
 */
let failedWriterDatabase: Database.Database | null = null
let writeDatabaseOpenCount = 0
let readDatabase: Database.Database | null = null
let readDatabasePath = ''
/** The file the read connection has open; another file at the path is opened anew (F1d-3). */
let readDatabaseIdentity: FileIdentity | null = null
let readDatabaseOpenCount = 0
let synchronizationTail: Promise<void> = Promise.resolve()
let indexRevision = 0
const queryCache = new Map<string, {
  dataVersion: number
  indexRevision: number
  results: SearchIndexResult[]
}>()

function invalidateQueryCache(): void {
  indexRevision++
  queryCache.clear()
}

function indexDirectory(): string {
  return process.env.SWOB_SEARCH_INDEX_DIR || path.join(runtimeHome(), '.claude-session-manager')
}

export function searchDatabasePath(): string {
  return path.join(indexDirectory(), 'search.db')
}

function fileIdentity(filePath: string): FileIdentity | null {
  try {
    const stat = fs.statSync(filePath, { throwIfNoEntry: false })
    return stat ? { dev: stat.dev, ino: stat.ino } : null
  } catch {
    return null
  }
}

function sameFile(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino)
}

/** The file at search.db's path now (device and inode), or null without one. */
export function searchIndexFileIdentity(): SearchIndexFileIdentity | null {
  return fileIdentity(searchDatabasePath())
}

// --- F1d-3: a corrupt search.db is moved aside and rebuilt ---

/**
 * SQLite's own verdict that search.db's bytes are not a database it can use:
 * SQLITE_CORRUPT (with its extended codes) or SQLITE_NOTADB. BUSY and LOCKED
 * never are: another connection may be using a healthy file (the summary
 * cache's repair in session-loader.ts draws the same line).
 */
export function isSearchIndexCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' &&
    (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' || code.startsWith('SQLITE_CORRUPT_'))
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  return error instanceof Error ? error.name : 'unknown'
}

/**
 * search.db is corrupt, and this thread does not repair it (F1d-3-b: only
 * the desktop app's library worker does, see armSearchIndexSelfHeal): the
 * file was left where and as it was. `code` is SQLite's own verdict
 * (SQLITE_CORRUPT…, SQLITE_NOTADB). Being this class, not a bare SQLite
 * error, tells a caller the verdict is about search.db and no other store.
 */
export class SearchIndexCorruptError extends Error {
  readonly code: string

  constructor(readonly operation: string, readonly reason: string) {
    super(`search.db is corrupt (${reason}); left as it is for the Swob app to repair`)
    this.name = 'SearchIndexCorruptError'
    this.code = reason
  }
}

/**
 * A record of the search index's own maintenance, for lifecycle.log: what
 * happened and why, sizes and durations, file names but never a path or any
 * content.
 */
export interface SearchIndexEvent {
  readonly event: string
  readonly [field: string]: unknown
}

let searchIndexEventSink: ((event: SearchIndexEvent) => void) | null = null

/**
 * Where this thread's search index events go. The library worker, which owns
 * the app's writer, hands them to the main thread (WorkerReply
 * 'search-index-event'); anywhere else they are delivered in place.
 */
export function setSearchIndexEventSink(sink: ((event: SearchIndexEvent) => void) | null): void {
  searchIndexEventSink = sink
}

function emitSearchIndexEvent(event: SearchIndexEvent): void {
  try {
    if (searchIndexEventSink) searchIndexEventSink(event)
    else deliverSearchIndexEvent(event)
  } catch { /* a report never changes what the index does */ }
}

/**
 * Deliver a search index event on this thread, emitted in place or posted by
 * the worker that owns the writer. A repair replaced the file this thread's
 * read connection has open, which would go on reading the moved copy: that
 * connection is closed first, so the next query opens the rebuilt index. A
 * writer on this thread needs no signal: each write operation starts by
 * following the file at the path (followSearchIndexFile, F1d-3-b), and one
 * already running is never closed under it. Then process
 * 'swob:search-index-event' (the desktop app logs it and projects every
 * source into a rebuilt index).
 */
export function deliverSearchIndexEvent(event: SearchIndexEvent): void {
  if (event.event === 'search-index-repaired') reopenSearchIndexReadConnection()
  try {
    process.emit('swob:search-index-event', event)
  } catch { /* a listener's failure is not the index's */ }
}

/** Close this thread's read connection: the next query opens whatever file is at the path then. */
export function reopenSearchIndexReadConnection(): void {
  if (readDatabase) {
    try { readDatabase.close() } catch { /* the handle is released either way */ }
  }
  readDatabase = null
  readDatabasePath = ''
  readDatabaseIdentity = null
  invalidateQueryCache()
}

function closeWriterConnections(): void {
  for (const connection of [database, failedWriterDatabase]) {
    if (!connection) continue
    try { connection.close() } catch { /* the handle is released either way */ }
  }
  database = null
  databasePath = ''
  failedWriterDatabase = null
  invalidateQueryCache()
}

function closeSearchIndexConnections(): void {
  closeWriterConnections()
  reopenSearchIndexReadConnection()
}

/**
 * F1d-3-b. A writer follows the file at the path, as the read connection
 * does (getReadOnlyDatabase). Checked once as each write operation starts:
 * when another file is at the path (the app's worker moved a corrupt one
 * aside and rebuilt it, or anyone replaced or removed it), this thread's
 * writers are closed, so the operation writes into the file at the path and
 * never into the moved copy. Closing a connection whose file moved
 * checkpoints nothing into the new file and removes none of its -wal/-shm
 * (SQLite checks that the file has not moved). What follows no signal: a
 * writer in another process (the CLI) follows at its next operation, and an
 * operation already running when the file moves finishes in the moved copy.
 */
function followSearchIndexFile(): void {
  if (!database && !failedWriterDatabase) return
  if (sameFile(fileIdentity(searchDatabasePath()), writerFileIdentity)) return
  closeWriterConnections()
}

/**
 * F1d-3-b. Close this thread's writers on a file found corrupt without
 * writing into it. The last connection to a WAL database checkpoints the
 * WAL's frames into the file as it closes. With an empty -wal there is
 * nothing to checkpoint, and the close only removes the -wal/-shm the
 * writer itself opened. Otherwise a read-only connection that has read the
 * header holds the file while the writers close (none is the last one), and
 * a read-only connection's own close never checkpoints: the file and its
 * -wal stay byte for byte, and the next opener (the app's worker) reads the
 * frames there. Best effort: a holder that cannot read even the header means
 * no WAL was opened on the file either.
 */
function closeWritersLeavingFileAsIs(): void {
  const indexPath = searchDatabasePath()
  const walBytes = (): number => {
    try {
      return fs.statSync(`${indexPath}-wal`, { throwIfNoEntry: false })?.size ?? 0
    } catch {
      return 1 // unknown: hold the file
    }
  }
  let holder: Database.Database | null = null
  if ((database || failedWriterDatabase) && sameFile(fileIdentity(indexPath), writerFileIdentity) && walBytes() > 0) {
    try {
      holder = new Database(indexPath, { readonly: true, fileMustExist: true, timeout: 0 })
      holder.pragma('schema_version', { simple: true })
    } catch {
      try { holder?.close() } catch { /* nothing was held */ }
      holder = null
    }
  }
  closeWriterConnections()
  if (holder) {
    try { holder.close() } catch { /* read-only: nothing to lose */ }
  }
}

/**
 * The file this thread found corrupt without repairing it (F1d-3-b: a thread
 * that did not arm the self-heal). Nothing more is written into it: every
 * later write fails at once with the same verdict, without opening it, until
 * another file is at the path.
 */
let leftCorruptIndex: { readonly identity: FileIdentity; readonly reason: string } | null = null

/**
 * A write (or the CLI's query) on a thread that does not repair found
 * search.db corrupt: the writers close without writing into it, it is
 * reported once per file (search-index-left-corrupt), and the caller gets a
 * SearchIndexCorruptError. Nothing is moved, rebuilt or deleted.
 */
function leaveCorruptSearchIndex(operation: string, error: unknown): SearchIndexCorruptError {
  const reason = errorCodeOf(error)
  const identity = database || failedWriterDatabase ? writerFileIdentity : fileIdentity(searchDatabasePath())
  closeWritersLeavingFileAsIs()
  if (identity && !sameFile(identity, leftCorruptIndex?.identity ?? null)) {
    leftCorruptIndex = { identity, reason }
    emitSearchIndexEvent({ event: 'search-index-left-corrupt', operation, reason })
  }
  return new SearchIndexCorruptError(operation, reason)
}

function refuseLeftCorruptIndex(operation: string): SearchIndexCorruptError | null {
  if (!leftCorruptIndex || selfHeal) return null
  if (!sameFile(fileIdentity(searchDatabasePath()), leftCorruptIndex.identity)) {
    // Another file is at the path (the app repaired it): write as usual.
    leftCorruptIndex = null
    return null
  }
  return new SearchIndexCorruptError(operation, leftCorruptIndex.reason)
}

/** The one search.db file a failed query reported, so repeated searches do not repeat it. */
let reportedCorruptRead: FileIdentity | null = null

/**
 * A query on this thread found search.db corrupt. Only a thread that armed
 * the self-heal moves the file (repairCorruptSearchIndex; in the app, the
 * library worker, when it writes or checks): here the read connection is
 * dropped, and the finding is reported once per file.
 */
function reportCorruptRead(operation: 'search' | 'probe', error: unknown): void {
  const identity = fileIdentity(searchDatabasePath())
  reopenSearchIndexReadConnection()
  if (identity && sameFile(identity, reportedCorruptRead)) return
  reportedCorruptRead = identity
  emitSearchIndexEvent({ event: 'search-index-read-corrupt', operation, reason: errorCodeOf(error) })
}

/**
 * One repair per this long: an index that keeps turning corrupt (a failing
 * disk) is reported, not moved aside and rebuilt over and over. F1d-3-b:
 * not per thread only. A repair that gets as far as moving files also
 * records when it began next to the moved copies (program-backups.ts,
 * search-backups/last-repair.json), so the interval outlives a recycled
 * library worker and a restarted app; this thread's own record covers the
 * attempts that stop before that.
 */
const SEARCH_INDEX_REPAIR_INTERVAL_MS = 10 * 60_000
let lastSearchIndexRepairAt: number | null = null
let deferredRepairReportedFor: number | null = null

/** The later of this thread's last repair and the one recorded on disk, if any. */
function lastRepairStartedAt(now: number): number | null {
  const recorded = readSearchIndexRepairStamp(now)
  if (lastSearchIndexRepairAt === null) return recorded
  return recorded === null ? lastSearchIndexRepairAt : Math.max(lastSearchIndexRepairAt, recorded)
}

interface SearchIndexRepairTrigger {
  readonly operation: string
  readonly reason: string
  /** The file found corrupt; by default the one this thread's writer opened. */
  readonly expected?: FileIdentity | null
}

/** repaired: moved aside, empty index in place; replaced: another file is there already; refused: nothing moved. */
export type SearchIndexRepairResult = 'repaired' | 'replaced' | 'refused'

/**
 * F1d-3-b. This thread's self-heal: null until armSearchIndexSelfHeal, and
 * the only way to reach repairCorruptSearchIndex (the move aside, the
 * rebuild, the prune after it). Unarmed, a corrupt search.db is left as it
 * is: see leaveCorruptSearchIndex.
 */
let selfHeal: ((trigger: SearchIndexRepairTrigger) => SearchIndexRepairResult) | null = null

/**
 * F1d-3-b. Arm this thread to repair search.db: a write, or the worker's
 * quick_check, that finds it corrupt moves it aside, rebuilds it and retries
 * (repairCorruptSearchIndex). Only the desktop app's library worker calls
 * this, in its worker-thread bootstrap (library-worker.ts). The CLI, the
 * app's main thread and every other thread never do, so none of them moves,
 * rebuilds or prunes anything (search-index-self-heal.architecture.test.ts
 * pins that the CLI cannot reach this). Returns the disarm, for tests.
 */
export function armSearchIndexSelfHeal(): () => void {
  selfHeal = repairCorruptSearchIndex
  return () => { selfHeal = null }
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, 'r')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  } catch { /* directory fsync is unavailable on some filesystems */ }
}

function freeSearchIndexBackupName(directory: string, at: number): string | null {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = searchIndexBackupName(new Date(at), process.pid, attempt)
    const taken = ['', ...SEARCH_INDEX_COMPANION_SUFFIXES].some((suffix) => {
      try {
        fs.lstatSync(path.join(directory, name + suffix))
        return true
      } catch {
        return false
      }
    })
    if (!taken) return name
  }
  return null
}

/**
 * F1d-3. search.db is a derived index: every row is projected again from the
 * session files. So a file SQLite calls corrupt or not a database
 * (isSearchIndexCorruption) is moved aside whole and rebuilt, never patched
 * and never deleted. Only a thread that armed it runs this (F1d-3-b,
 * armSearchIndexSelfHeal: the app's library worker, which then tells the
 * main thread; see deliverSearchIndexEvent). In order:
 * 1. the file must still be the one found corrupt ('replaced' otherwise:
 *    another file is at the path already, nothing moves) and a regular file
 *    (a symbolic link is never followed or moved);
 * 2. its `-wal`/`-shm`/`-journal`, then the file itself, are renamed into
 *    search-backups/ (program-backups.ts) on the same volume, so a new index
 *    never finds the old WAL beside it. A failed rename puts back what moved;
 * 3. only then are this thread's connections closed. A last connection's
 *    close removes `<path>-wal` and `-shm` by name: before the move that
 *    would lose the WAL, after a new index exists it would be the new
 *    index's. Between the two, the names are empty;
 * 4. both directories are synced, and each copy is checked to be the very
 *    file that was at the path (`complete`);
 * 5. an empty index with the current schema takes its place; the caller
 *    retries its operation.
 * 'refused' when a repair already ran within the interval, the path is not
 * a regular file, the backup directory is unusable or a rename failed: the
 * caller's error stands and the file stays where it was. Every outcome is
 * reported (search-index-repaired / -repair-failed / -repair-deferred).
 */
function repairCorruptSearchIndex(trigger: SearchIndexRepairTrigger): SearchIndexRepairResult {
  const startedAt = Date.now()
  const fields = { operation: trigger.operation, reason: trigger.reason }
  const lastRepairAt = lastRepairStartedAt(startedAt)
  if (lastRepairAt !== null && startedAt - lastRepairAt < SEARCH_INDEX_REPAIR_INTERVAL_MS) {
    if (deferredRepairReportedFor !== lastRepairAt) {
      deferredRepairReportedFor = lastRepairAt
      emitSearchIndexEvent({
        event: 'search-index-repair-deferred',
        ...fields,
        sinceLastRepairMs: startedAt - lastRepairAt
      })
    }
    return 'refused'
  }
  const expected = trigger.expected === undefined ? writerFileIdentity : trigger.expected
  const refuse = (why: string, error?: unknown): SearchIndexRepairResult => {
    closeSearchIndexConnections()
    emitSearchIndexEvent({
      event: 'search-index-repair-failed',
      ...fields,
      why,
      ...(error === undefined ? {} : { code: errorCodeOf(error) }),
      ms: Date.now() - startedAt
    })
    return 'refused'
  }
  const indexPath = searchDatabasePath()
  let original: fs.Stats
  try {
    original = fs.lstatSync(indexPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return refuse('stat', error)
    // Gone already: the retry creates a new index.
    closeSearchIndexConnections()
    return 'replaced'
  }
  if (original.isFile() && expected && !sameFile(expected, original)) {
    closeSearchIndexConnections()
    return 'replaced'
  }
  lastSearchIndexRepairAt = startedAt
  if (!original.isFile()) return refuse('not-a-file')
  const companions: Array<{ suffix: string; stat: fs.Stats }> = []
  for (const suffix of SEARCH_INDEX_COMPANION_SUFFIXES) {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(indexPath + suffix)
    } catch {
      continue
    }
    if (!stat.isFile()) return refuse('companion-not-a-file')
    companions.push({ suffix, stat })
  }
  const directory = searchIndexBackupDirectory()
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!fs.lstatSync(directory).isDirectory()) return refuse('backup-directory')
  } catch (error) {
    return refuse('backup-directory', error)
  }
  // Before anything moves (F1d-3-b): the next repair, in whichever thread or run, waits the interval.
  writeSearchIndexRepairStamp(startedAt)
  const backupFileName = freeSearchIndexBackupName(directory, startedAt)
  if (!backupFileName) return refuse('backup-name')
  const moved: Array<{ from: string; to: string }> = []
  try {
    for (const { suffix } of companions) {
      const move = { from: indexPath + suffix, to: path.join(directory, backupFileName + suffix) }
      fs.renameSync(move.from, move.to)
      moved.push(move)
    }
    fs.renameSync(indexPath, path.join(directory, backupFileName))
  } catch (error) {
    for (const move of moved.reverse()) {
      try { fs.renameSync(move.to, move.from) } catch { /* stays in search-backups, never deleted */ }
    }
    return refuse('rename', error)
  }
  closeSearchIndexConnections()
  syncDirectory(directory)
  syncDirectory(path.dirname(indexPath))
  // Each copy is the very file that was at the path (a rename moves it whole;
  // a closing connection may only have folded its own WAL into it).
  const complete = [{ suffix: '', stat: original }, ...companions].every(({ suffix, stat }) => {
    try {
      const landed = fs.lstatSync(path.join(directory, backupFileName + suffix))
      return landed.isFile() && landed.dev === stat.dev && landed.ino === stat.ino
    } catch {
      return false
    }
  })
  let rebuilt = true
  try {
    getDatabase()
  } catch {
    rebuilt = false
  }
  const companionBytes = (suffix: string): number =>
    companions.find((companion) => companion.suffix === suffix)?.stat.size ?? 0
  emitSearchIndexEvent({
    event: 'search-index-repaired',
    ...fields,
    bytes: original.size,
    walBytes: companionBytes('-wal'),
    shmBytes: companionBytes('-shm'),
    journalBytes: companionBytes('-journal'),
    backupFileName,
    complete,
    rebuilt,
    ms: Date.now() - startedAt
  })
  // Only a copy checked whole may retire the older one (program-backups.ts).
  if (complete) {
    try {
      pruneProgramBackups({
        log: (event, details) => emitSearchIndexEvent({ event, ...details }),
        verifiedSearchIndexBackup: backupFileName
      })
    } catch { /* pruning is housekeeping: the repair stands */ }
  }
  return 'repaired'
}

/**
 * Run a write operation; when SQLite finds search.db corrupt, repair it
 * (above) and run the operation once more against the rebuilt index. Every
 * SQLite call inside these operations is on search.db: a source that fails
 * to parse, even with a SQLite error of its own store, is handled per source
 * in indexSourceNow and never reaches here. F1d-3-b: the writer first
 * follows the file at the path; a thread that did not arm the self-heal
 * repairs nothing and leaves a corrupt index as it is (a
 * SearchIndexCorruptError, now and for every later write on that file).
 */
async function withSearchIndexRepair(operation: string, work: () => Promise<void>): Promise<void> {
  followSearchIndexFile()
  const refused = refuseLeftCorruptIndex(operation)
  if (refused) throw refused
  try {
    await work()
  } catch (error) {
    if (!isSearchIndexCorruption(error)) throw error
    const repair = selfHeal
    if (!repair) throw leaveCorruptSearchIndex(operation, error)
    if (repair({ operation, reason: errorCodeOf(error) }) === 'refused') throw error
    await work()
  }
}

function computeFileState(filePath: string): FileState | null {
  try {
    const stat = fs.statSync(filePath)
    return {
      signature: `${SEARCH_PROJECTION_PREFIX}${stat.mtimeMs}:${stat.size}`,
      size: stat.size,
      dev: stat.dev,
      ino: stat.ino
    }
  } catch {
    return null
  }
}

function ensureSchema(db: Database.Database): void {
  db.pragma(`busy_timeout = ${searchDatabaseBusyTimeoutMs()}`)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')

  const version = db.pragma('user_version', { simple: true }) as number
  if (version !== SEARCH_SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS library_backup;
      DROP TABLE IF EXISTS sessions;
    `)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      file_path TEXT PRIMARY KEY,
      display_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      project_path TEXT NOT NULL,
      file_signature TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      indexed_size INTEGER NOT NULL,
      file_dev INTEGER NOT NULL,
      file_ino INTEGER NOT NULL,
      indexed_raw_count INTEGER NOT NULL,
      projection_kind TEXT NOT NULL CHECK(projection_kind IN ('legacy', 'canonical'))
    );
    CREATE INDEX IF NOT EXISTS sessions_session_id_idx ON sessions(session_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      session_id UNINDEXED,
      file_path UNINDEXED,
      role UNINDEXED,
      text,
      timestamp UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS library_backup (
      backup_path TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_signature TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS library_backup_session_id_idx ON library_backup(session_id);
  `)
  // Written only when it changes (F1d-3-b): setting the same value is still a
  // write (a WAL frame, checkpointed into the file on close), so a new
  // connection on a current index writes nothing, and a CLI that meets a
  // corrupt one leaves it byte for byte.
  if (version !== SEARCH_SCHEMA_VERSION) db.pragma(`user_version = ${SEARCH_SCHEMA_VERSION}`)
}

function getDatabase(): Database.Database {
  const requestedPath = searchDatabasePath()
  if (database && databasePath === requestedPath) return database
  if (database) database.close()
  queryCache.clear()

  fs.mkdirSync(path.dirname(requestedPath), { recursive: true, mode: 0o700 })
  const nextDatabase = new Database(requestedPath, { timeout: searchDatabaseBusyTimeoutMs() })
  writeDatabaseOpenCount++
  writerFileIdentity = fileIdentity(requestedPath)
  try {
    ensureSchema(nextDatabase)
    // Only when it differs (F1d-3-b): chmod to the same mode still changes the file's ctime.
    try {
      if ((fs.statSync(requestedPath).mode & 0o777) !== 0o600) fs.chmodSync(requestedPath, 0o600)
    } catch { /* best effort */ }
  } catch (error) {
    if (isSearchIndexCorruption(error)) {
      // Closed by the repair once the file has moved (see failedWriterDatabase).
      if (failedWriterDatabase) failedWriterDatabase.close()
      failedWriterDatabase = nextDatabase
    } else {
      nextDatabase.close()
    }
    throw error
  }
  database = nextDatabase
  databasePath = requestedPath
  return nextDatabase
}

function withReadOnlyDatabase<T>(query: (db: Database.Database) => T): T {
  const readOnlyDatabase = new Database(searchDatabasePath(), {
    readonly: true,
    fileMustExist: true,
    timeout: searchDatabaseBusyTimeoutMs()
  })
  try {
    readOnlyDatabase.pragma(`busy_timeout = ${searchDatabaseBusyTimeoutMs()}`)
    return query(readOnlyDatabase)
  } finally {
    readOnlyDatabase.close()
  }
}

function getReadOnlyDatabase(): Database.Database | null {
  const requestedPath = searchDatabasePath()
  const identity = fileIdentity(requestedPath)
  if (!identity) {
    if (readDatabase && readDatabasePath === requestedPath) reopenSearchIndexReadConnection()
    return null
  }
  if (readDatabase && readDatabasePath === requestedPath && sameFile(readDatabaseIdentity, identity)) {
    return readDatabase
  }
  // Another path, or another file at this path (a repaired index, F1d-3): an
  // open connection would go on reading the file it opened.
  if (readDatabase) reopenSearchIndexReadConnection()
  const nextDatabase = new Database(requestedPath, {
    readonly: true,
    fileMustExist: true,
    timeout: searchDatabaseBusyTimeoutMs()
  })
  nextDatabase.pragma(`busy_timeout = ${searchDatabaseBusyTimeoutMs()}`)
  readDatabase = nextDatabase
  readDatabasePath = requestedPath
  readDatabaseIdentity = identity
  readDatabaseOpenCount++
  return nextDatabase
}

function searchableValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return stripTerminalControlSequences(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try { return JSON.stringify(stripTerminalControlSequencesDeep(value)) }
  catch { return String(value) }
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return stripTerminalControlSequences(content)
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const item = part as Record<string, unknown>
    if (item.type === 'text') text += (text ? ' ' : '') + searchableValue(item.text)
    if (item.type === 'thinking') text += (text ? ' ' : '') + searchableValue(item.thinking ?? item.text)
    if (item.type === 'tool_result') text += (text ? ' ' : '') + extractContentText(item.content)
    if (item.type === 'tool_use') {
      text += (text ? ' ' : '') + searchableValue(item.name)
      text += (text ? ' ' : '') + searchableValue(item.input)
    }
  }
  return text
}

function projectPathFromRaw(raw: RawJsonlMessage[]): string {
  return raw.find((message) => typeof message.cwd === 'string' && message.cwd.trim())?.cwd || ''
}

function firstUserMessage(raw: RawJsonlMessage[]): string {
  const firstUser = raw.find((message) => message.type === 'user')
  return extractContentText(firstUser?.message?.content).slice(0, 200)
}

function removeIndexedFile(
  db: Database.Database,
  filePath: string,
  shouldCancel?: () => boolean
): void {
  const remove = db.transaction(() => {
    throwIfSearchIndexSyncCancelled(shouldCancel)
    db.prepare('DELETE FROM messages_fts WHERE file_path = ?').run(filePath)
    db.prepare('DELETE FROM library_backup WHERE backup_path = ?').run(filePath)
    db.prepare('DELETE FROM sessions WHERE file_path = ?').run(filePath)
    throwIfSearchIndexSyncCancelled(shouldCancel)
  })
  remove()
  invalidateQueryCache()
}

function throwIfSearchIndexSyncCancelled(shouldCancel?: () => boolean): void {
  if (!shouldCancel?.()) return
  const error = new Error('Search index synchronization cancelled')
  error.name = 'AbortError'
  throw error
}

function awaitSearchIndexInput<T>(input: Promise<T>, shouldCancel?: () => boolean): Promise<T> {
  if (!shouldCancel) return input
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (action: () => void): void => {
      if (settled) return
      settled = true
      clearInterval(poll)
      action()
    }
    const poll = setInterval(() => {
      try {
        throwIfSearchIndexSyncCancelled(shouldCancel)
      } catch (error) {
        finish(() => reject(error))
      }
    }, 10)
    poll.unref?.()
    input.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error))
    )
  })
}

async function indexSourceNow(
  source: SearchIndexSource,
  shouldCancel?: () => boolean
): Promise<boolean> {
  throwIfSearchIndexSyncCancelled(shouldCancel)
  const db = getDatabase()
  const state = computeFileState(source.stateFilePath || source.filePath)
  if (!state) {
    removeIndexedFile(db, source.filePath, shouldCancel)
    return false
  }

  const existing = db.prepare(
    'SELECT * FROM sessions WHERE file_path = ?'
  ).get(source.filePath) as IndexedSessionRow | undefined
  if (existing?.file_signature === state.signature) return false

  let raw: RawJsonlMessage[]
  try {
    raw = await awaitSearchIndexInput(
      source.loadRaw ? source.loadRaw() : parseSessionFile(source.filePath),
      shouldCancel
    )
  } catch {
    // A parser may gain native/cooperative abort support independently. Never
    // translate a shutdown abort into a destructive "source disappeared"
    // tombstone of the last complete projection.
    throwIfSearchIndexSyncCancelled(shouldCancel)
    removeIndexedFile(db, source.filePath, shouldCancel)
    return false
  }

  // Parsing a large source is intentionally outside the SQLite transaction.
  // If shutdown was requested while it was being read, do not begin a new
  // projection commit after quit.
  throwIfSearchIndexSyncCancelled(shouldCancel)
  return writeIndexedRawSource(db, source, state, raw, existing, shouldCancel)
}

function writeIndexedRawSource(
  db: Database.Database,
  source: SearchIndexSource,
  state: FileState,
  raw: RawJsonlMessage[],
  existing?: IndexedSessionRow,
  shouldCancel?: () => boolean
): boolean {

  const sessionId = source.sessionId || raw.find((message) => message.sessionId)?.sessionId
  if (!sessionId) {
    removeIndexedFile(db, source.filePath, shouldCancel)
    return false
  }

  // Only rows of the current projection may be appended to: an older reader
  // may have counted records differently (before F1a a U+2028 record was
  // lost), so slicing at its indexed_raw_count would duplicate and still miss
  // rows. Such a file is re-projected as a whole.
  const canAppend = Boolean(
    !source.stateFilePath && existing && existing.session_id === sessionId &&
    existing.file_signature.startsWith(SEARCH_PROJECTION_PREFIX) &&
    existing.file_dev === state.dev && existing.file_ino === state.ino &&
    state.size > existing.indexed_size && raw.length >= existing.indexed_raw_count
  )
  const rawToIndex = canAppend ? raw.slice(existing!.indexed_raw_count) : raw
  const searchableMessages: Array<{ role: string; text: string; timestamp: string }> = []
  for (const message of rawToIndex) {
    throwIfSearchIndexSyncCancelled(shouldCancel)
    if (message.type !== 'user' && message.type !== 'assistant') continue
    const text = extractContentText(message.message?.content)
    if (text) searchableMessages.push({ role: message.type, text, timestamp: message.timestamp || '' })
  }

  const isLibraryBackup = source.isLibraryBackup ?? path.basename(source.filePath) === 'backup.jsonl'
  const write = db.transaction(() => {
    throwIfSearchIndexSyncCancelled(shouldCancel)
    if (!canAppend) db.prepare('DELETE FROM messages_fts WHERE file_path = ?').run(source.filePath)
    db.prepare(`
      INSERT INTO sessions(
        file_path, display_path, session_id, source, project_path, file_signature, first_user_message,
        indexed_size, file_dev, file_ino, indexed_raw_count, projection_kind
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        display_path = excluded.display_path,
        session_id = excluded.session_id,
        source = excluded.source,
        project_path = excluded.project_path,
        file_signature = excluded.file_signature,
        first_user_message = excluded.first_user_message,
        indexed_size = excluded.indexed_size,
        file_dev = excluded.file_dev,
        file_ino = excluded.file_ino,
        indexed_raw_count = excluded.indexed_raw_count,
        projection_kind = excluded.projection_kind
    `).run(
      source.filePath,
      source.filePath,
      sessionId,
      source.source || (isLibraryBackup ? 'library-backup' : 'claude-code'),
      projectPathFromRaw(raw),
      state.signature,
      firstUserMessage(raw),
      state.size,
      state.dev,
      state.ino,
      raw.length,
      'legacy'
    )

    const insertMessage = db.prepare(`
      INSERT INTO messages_fts(session_id, file_path, role, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const message of searchableMessages) {
      throwIfSearchIndexSyncCancelled(shouldCancel)
      insertMessage.run(sessionId, source.filePath, message.role, message.text, message.timestamp)
    }

    if (isLibraryBackup) {
      db.prepare(`
        INSERT INTO library_backup(backup_path, session_id, file_signature)
        VALUES (?, ?, ?)
        ON CONFLICT(backup_path) DO UPDATE SET
          session_id = excluded.session_id,
          file_signature = excluded.file_signature
      `).run(source.filePath, sessionId, state.signature)
    } else {
      db.prepare('DELETE FROM library_backup WHERE backup_path = ?').run(source.filePath)
    }
    // Throwing at the boundary rolls back all projection rows if quit raced
    // the final insert.
    throwIfSearchIndexSyncCancelled(shouldCancel)
  })
  write()
  invalidateQueryCache()
  return true
}

function serializeWork(work: () => Promise<void>): Promise<void> {
  const next = synchronizationTail.then(work, work)
  synchronizationTail = next.catch(() => {})
  return next
}

function serializeSynchronization(operation: string, work: () => Promise<void>): Promise<void> {
  return serializeWork(() => withSearchIndexRepair(operation, work))
}

/** What an integrity check of search.db found (PRAGMA quick_check, run only in the library worker). */
export interface SearchIndexIntegrityOutcome {
  /**
   * ok: quick_check found nothing; repaired: it found the file corrupt, and
   * the file was moved aside and rebuilt; corrupt: found corrupt, but the
   * repair was refused (see repairCorruptSearchIndex); busy / error: no
   * verdict; missing: no index to check.
   */
  readonly status: 'ok' | 'repaired' | 'corrupt' | 'busy' | 'error' | 'missing'
  /** How long quick_check itself took. */
  readonly ms: number
  /** Lines quick_check reported other than "ok". */
  readonly problems?: number
  /** The SQLite code, or 'quick_check' when the check listed problems. */
  readonly reason?: string
}

/**
 * The repair after an integrity check found search.db corrupt (F1d-3): the
 * same repair as a failed write, serialized with every write. `expected` is
 * the file the check read, so a file put at the path since is never moved.
 */
export function repairSearchIndexAfterCheck(
  check: { reason: string; expected: SearchIndexFileIdentity }
): Promise<SearchIndexRepairResult> {
  let result: SearchIndexRepairResult = 'refused'
  return serializeWork(async () => {
    // Only where armed (F1d-3-b); elsewhere the file stays as it is.
    const repair = selfHeal
    if (repair) result = repair({ operation: 'quick-check', reason: check.reason, expected: check.expected })
  }).then(() => result)
}

export async function indexSearchSource(source: SearchIndexSource): Promise<void> {
  return serializeSynchronization('index-source', async () => {
    await indexSourceNow(source)
  })
}

export async function indexParsedSearchSource(
  source: SearchIndexSource,
  raw: RawJsonlMessage[]
): Promise<void> {
  return serializeSynchronization('index-parsed-source', async () => {
    const db = getDatabase()
    const state = computeFileState(source.stateFilePath || source.filePath)
    if (!state) {
      removeIndexedFile(db, source.filePath)
      return
    }
    const existing = db.prepare(
      'SELECT * FROM sessions WHERE file_path = ?'
    ).get(source.filePath) as IndexedSessionRow | undefined
    if (existing?.file_signature === state.signature) return
    writeIndexedRawSource(db, source, state, raw, existing)
  })
}

function canonicalIndexKey(sessionRecordId: string): string {
  return `canonical:${sessionRecordId}`
}

function canonicalMessageText(message: MessageRecord, includeThinking: boolean): string {
  return message.content.flatMap((content) => {
    if (content.kind === 'text') return [content.text]
    if (content.kind === 'thinking' && includeThinking) return [content.text]
    if (content.kind === 'media-ref') return [content.uri]
    return []
  }).map(searchableValue).filter(Boolean).join('\n')
}

function canonicalSessionRecord(records: CanonicalRecord[]): SessionRecord {
  const sessions = records.filter((record): record is SessionRecord => record.recordType === 'session')
  if (sessions.length !== 1) throw new Error('canonical-search-requires-one-session-record')
  return sessions[0]
}

export async function indexCanonicalSession(
  sessionId: string,
  records: CanonicalRecord[],
  options: { includeThinking?: boolean; shouldCancel?: () => boolean } = {}
): Promise<void> {
  return serializeSynchronization('canonical-index', async () => {
    throwIfSearchIndexSyncCancelled(options.shouldCancel)
    const session = canonicalSessionRecord(records)
    if (session.sourceSessionId !== sessionId) throw new Error('canonical-search-session-id-mismatch')
    const includeThinking = options.includeThinking !== false
    const indexKey = canonicalIndexKey(session.id)
    const messages = records
      .filter((record): record is MessageRecord => record.recordType === 'message')
      .sort((left, right) => left.ordinal - right.ordinal)
    const calls = records
      .filter((record): record is ToolCallRecord => record.recordType === 'tool-call')
      .sort((left, right) => left.ordinal - right.ordinal)
    const results = records.filter((record): record is ToolResultEvent => record.recordType === 'tool-result')
    const firstUser = messages.find((message) => message.role === 'user')
    const firstUserText = firstUser ? canonicalMessageText(firstUser, false).slice(0, 200) : ''
    const searchableRows: Array<{ role: string; text: string; timestamp: string }> = []
    for (const message of messages) {
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
      const text = canonicalMessageText(message, includeThinking)
      if (text) searchableRows.push({ role: message.role, text, timestamp: message.timestamp || '' })
    }
    for (const call of calls) {
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
      searchableRows.push({
        role: 'tool-call',
        text: [searchableValue(call.name), searchableValue(call.input)].filter(Boolean).join('\n'),
        timestamp: ''
      })
    }
    for (const result of results) {
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
      const text = searchableValue(result.content)
      if (text) searchableRows.push({ role: 'tool-result', text, timestamp: result.timestamp || '' })
    }
    const encodedSize = Buffer.byteLength(JSON.stringify(records), 'utf8')
    throwIfSearchIndexSyncCancelled(options.shouldCancel)
    const db = getDatabase()
    const write = db.transaction(() => {
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
      db.prepare('DELETE FROM messages_fts WHERE file_path = ?').run(indexKey)
      db.prepare(`
        INSERT INTO sessions(
          file_path, display_path, session_id, source, project_path, file_signature,
          first_user_message, indexed_size, file_dev, file_ino, indexed_raw_count, projection_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 'canonical')
        ON CONFLICT(file_path) DO UPDATE SET
          display_path = excluded.display_path,
          session_id = excluded.session_id,
          source = excluded.source,
          project_path = excluded.project_path,
          file_signature = excluded.file_signature,
          first_user_message = excluded.first_user_message,
          indexed_size = excluded.indexed_size,
          file_dev = 0,
          file_ino = 0,
          indexed_raw_count = excluded.indexed_raw_count,
          projection_kind = 'canonical'
      `).run(
        indexKey,
        session.sourceRef.displayLocator,
        session.sourceSessionId,
        builtinProviderForId(session.provenance.providerId)?.sourceId ||
          session.provenance.providerId,
        session.projectPath || session.cwd[0] || '',
        session.sourceRef.fingerprint.value,
        firstUserText,
        encodedSize,
        records.length
      )
      const insert = db.prepare(`
        INSERT INTO messages_fts(session_id, file_path, role, text, timestamp)
        VALUES (?, ?, ?, ?, ?)
      `)
      for (const row of searchableRows) {
        throwIfSearchIndexSyncCancelled(options.shouldCancel)
        insert.run(session.sourceSessionId, indexKey, row.role, row.text, row.timestamp)
      }
      db.prepare('DELETE FROM library_backup WHERE backup_path = ?').run(indexKey)
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
    })
    write()
    invalidateQueryCache()
  })
}

export async function tombstoneCanonicalSession(
  sessionRecordId: string,
  options: { shouldCancel?: () => boolean } = {}
): Promise<void> {
  return serializeSynchronization('canonical-tombstone', async () => {
    throwIfSearchIndexSyncCancelled(options.shouldCancel)
    removeIndexedFile(getDatabase(), canonicalIndexKey(sessionRecordId), options.shouldCancel)
  })
}

export async function synchronizeSearchSources(
  sources: SearchIndexSource[],
  options: { prune?: boolean; shouldCancel?: () => boolean } = { prune: true }
): Promise<void> {
  return serializeSynchronization(options.prune === false ? 'live-sync' : 'full-sync', async () => {
    throwIfSearchIndexSyncCancelled(options.shouldCancel)
    const uniqueSources = new Map(sources.map((source) => [source.filePath, source]))
    // Progress of a full pass that re-projects files (after a
    // SEARCH_PROJECTION_VERSION change, every file once): one line per 100
    // files and one when done. A hot pass that re-projects nothing and a live
    // pass (prune: false) stay silent.
    const startedAt = Date.now()
    let processed = 0
    let replaced = 0
    const logProgress = (done: boolean): void => {
      if (options.prune === false || replaced === 0) return
      console.info(
        `[search-index] full sync${done ? ' done' : ''}: processed ${processed}/${uniqueSources.size} files, ` +
        `replaced ${replaced}, ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
      )
    }
    for (const source of uniqueSources.values()) {
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
      const changed = await indexSourceNow(source, options.shouldCancel)
      processed++
      if (changed) replaced++
      if (processed % 100 === 0) logProgress(false)
      // Yield only after real parse/write work. Unchanged hot-index validation is
      // intentionally one tight stat/query pass so every search stays sub-50ms.
      if (changed) await new Promise<void>((resolve) => setImmediate(resolve))
    }

    if (options.prune !== false) {
      throwIfSearchIndexSyncCancelled(options.shouldCancel)
      const db = getDatabase()
      const livePaths = new Set(uniqueSources.keys())
      const indexed = db.prepare(
        "SELECT file_path, file_signature FROM sessions WHERE projection_kind = 'legacy'"
      ).all() as IndexedSessionRow[]
      for (const row of indexed) {
        throwIfSearchIndexSyncCancelled(options.shouldCancel)
        if (!livePaths.has(row.file_path)) removeIndexedFile(db, row.file_path, options.shouldCancel)
      }
    }
    logProgress(true)
  })
}

export interface SearchProjectionProbe {
  /** File-backed (legacy) rows in search.db. */
  readonly legacyRows: number
  /**
   * Of those, rows projected under another SEARCH_PROJECTION_VERSION (or a
   * search.db of another schema version): each file is re-projected by its
   * next full sync.
   */
  readonly staleLegacyRows: number
}

/**
 * Read-only count of what the next full sync will re-project; null without a
 * readable search.db. Never creates, migrates or writes the index.
 */
export function probeSearchProjection(): SearchProjectionProbe | null {
  if (!fs.existsSync(searchDatabasePath())) return null
  try {
    return withReadOnlyDatabase((db) => {
      const counts = db.prepare(`
        SELECT count(*) AS legacyRows,
          coalesce(sum(substr(file_signature, 1, length(@prefix)) <> @prefix), 0) AS staleLegacyRows
        FROM sessions WHERE projection_kind = 'legacy'
      `).get({ prefix: SEARCH_PROJECTION_PREFIX }) as SearchProjectionProbe
      // Another schema version drops and rebuilds every table on the next write.
      return db.pragma('user_version', { simple: true }) === SEARCH_SCHEMA_VERSION
        ? { legacyRows: counts.legacyRows, staleLegacyRows: counts.staleLegacyRows }
        : { legacyRows: counts.legacyRows, staleLegacyRows: counts.legacyRows }
    })
  } catch (error) {
    if (isSearchIndexCorruption(error)) reportCorruptRead('probe', error)
    return null
  }
}

function toFtsQuery(query: string): string | null {
  const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)
  if (!tokens?.length) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

export function searchFTS(query: string, limit = 50): SearchIndexResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery || limit <= 0) return []
  try {
    const db = getReadOnlyDatabase()
    return db ? searchFTSFromDatabase(db, ftsQuery, limit) : []
  } catch (error) {
    // F1d-3: a corrupt index answers nothing instead of failing the search;
    // the writer's thread moves it aside and rebuilds it.
    if (!isSearchIndexCorruption(error)) throw error
    reportCorruptRead('search', error)
    return []
  }
}

function searchFTSFromDatabase(
  db: Database.Database,
  ftsQuery: string,
  limit: number
): SearchIndexResult[] {
  const cacheKey = `${limit}:${ftsQuery}`
  const dataVersion = db.pragma('data_version', { simple: true }) as number
  const cached = queryCache.get(cacheKey)
  if (cached?.dataVersion === dataVersion && cached.indexRevision === indexRevision) {
    queryCache.delete(cacheKey)
    queryCache.set(cacheKey, cached)
    return cached.results
  }
  const rows = db.prepare(`
    SELECT
      sessions.session_id,
      sessions.file_path AS index_key,
      sessions.display_path AS file_path,
      sessions.projection_kind,
      sessions.first_user_message,
      snippet(messages_fts, 3, '', '', '...', 32) AS snippet,
      messages_fts.timestamp AS timestamp
    FROM messages_fts
    JOIN sessions ON sessions.file_path = messages_fts.file_path
    WHERE messages_fts MATCH ?
    ORDER BY bm25(messages_fts), messages_fts.timestamp DESC
    LIMIT ?
  `).all(ftsQuery, Math.max(limit * 10, limit)) as SearchRow[]

  const results = new Map<string, SearchIndexResult>()
  for (const row of rows) {
    const resultKey = row.projection_kind === 'canonical'
      ? `${row.session_id}\0${row.index_key}`
      : row.session_id
    let result = results.get(resultKey)
    if (!result) {
      if (results.size >= limit) continue
      result = {
        sessionId: row.session_id,
        filePath: row.file_path,
        firstUserMessage: row.first_user_message,
        matches: []
      }
      results.set(resultKey, result)
    }
    if (result.matches.length < 10) {
      result.matches.push({ text: row.snippet, timestamp: row.timestamp })
    }
  }
  const output = [...results.values()]
  queryCache.set(cacheKey, { dataVersion, indexRevision, results: output })
  if (queryCache.size > 32) queryCache.delete(queryCache.keys().next().value!)
  return output
}

function contextLine(row: Pick<GrepRow, 'role' | 'text' | 'timestamp'>, matched: boolean): TranscriptGrepLine {
  return { role: row.role, text: row.text, timestamp: row.timestamp, matched }
}

/**
 * Search the already synchronized FTS index. Context means the immediately
 * preceding and following indexed transcript messages from the same source.
 */
function grepTranscriptsFromDatabase(
  db: Database.Database,
  query: string,
  filters: TranscriptGrepFilters = {}
): TranscriptGrepResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  if (filters.sessionIds && filters.sessionIds.length === 0) return []

  const where = ['messages_fts MATCH ?']
  const params: Array<string | number> = [ftsQuery]
  if (filters.source) {
    where.push('sessions.source = ?')
    params.push(filters.source)
  }
  if (filters.sessionIds) {
    where.push(`sessions.session_id IN (${filters.sessionIds.map(() => '?').join(', ')})`)
    params.push(...filters.sessionIds)
  }
  if (filters.after) {
    where.push('messages_fts.timestamp >= ?')
    params.push(filters.after)
  }
  if (filters.before) {
    where.push('messages_fts.timestamp <= ?')
    params.push(filters.before)
  }
  if (filters.project) {
    where.push('sessions.project_path LIKE ?')
    params.push(`%${filters.project}%`)
  }
  const limit = Math.max(1, Math.min(filters.limit || 100, 1000))
  params.push(limit)

  const rows = db.prepare(`
    SELECT
      messages_fts.rowid AS rowid,
      sessions.session_id,
      sessions.file_path,
      sessions.display_path,
      sessions.source,
      sessions.project_path,
      messages_fts.role,
      messages_fts.text,
      messages_fts.timestamp
    FROM messages_fts
    JOIN sessions ON sessions.file_path = messages_fts.file_path
    WHERE ${where.join(' AND ')}
    ORDER BY bm25(messages_fts), messages_fts.timestamp DESC
    LIMIT ?
  `).all(...params) as GrepRow[]

  const previous = db.prepare(`
    SELECT role, text, timestamp FROM messages_fts
    WHERE file_path = ? AND rowid < ? ORDER BY rowid DESC LIMIT 1
  `)
  const next = db.prepare(`
    SELECT role, text, timestamp FROM messages_fts
    WHERE file_path = ? AND rowid > ? ORDER BY rowid ASC LIMIT 1
  `)
  const grouped = new Map<string, TranscriptGrepResult>()
  for (const row of rows) {
    const key = `${row.session_id}\0${row.file_path}`
    let result = grouped.get(key)
    if (!result) {
      result = {
        sessionId: row.session_id,
        filePath: row.display_path,
        source: row.source,
        projectPath: row.project_path,
        matches: []
      }
      grouped.set(key, result)
    }
    const before = previous.get(row.file_path, row.rowid) as Pick<GrepRow, 'role' | 'text' | 'timestamp'> | undefined
    const after = next.get(row.file_path, row.rowid) as Pick<GrepRow, 'role' | 'text' | 'timestamp'> | undefined
    result.matches.push({
      role: row.role,
      text: row.text,
      timestamp: row.timestamp,
      context: [
        ...(before ? [contextLine(before, false)] : []),
        contextLine(row, true),
        ...(after ? [contextLine(after, false)] : [])
      ]
    })
  }
  return [...grouped.values()]
}

export function grepTranscripts(query: string, filters: TranscriptGrepFilters = {}): TranscriptGrepResult[] {
  return grepTranscriptsFromDatabase(getDatabase(), query, filters)
}

/**
 * CLI query path: never runs schema setup or writes to the shared GUI index.
 * F1d-3-b: a corrupt index answers a SearchIndexCorruptError, and a writer
 * this process still holds on it closes without writing into it.
 */
export function grepTranscriptsReadOnly(
  query: string,
  filters: TranscriptGrepFilters = {}
): TranscriptGrepResult[] {
  try {
    return withReadOnlyDatabase((db) => grepTranscriptsFromDatabase(db, query, filters))
  } catch (error) {
    if (!isSearchIndexCorruption(error)) throw error
    throw leaveCorruptSearchIndex('grep', error)
  }
}

export function searchIndexStats(): { sessions: number; messages: number; libraryBackups: number; databasePath: string } {
  const db = getDatabase()
  return {
    sessions: (db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count,
    messages: (db.prepare('SELECT count(*) AS count FROM messages_fts').get() as { count: number }).count,
    libraryBackups: (db.prepare('SELECT count(*) AS count FROM library_backup').get() as { count: number }).count,
    databasePath: searchDatabasePath()
  }
}

export function searchIndexConnectionStats(): {
  readOpens: number
  writeOpens: number
  hasReadConnection: boolean
  hasWriteConnection: boolean
} {
  return {
    readOpens: readDatabaseOpenCount,
    writeOpens: writeDatabaseOpenCount,
    hasReadConnection: readDatabase !== null,
    hasWriteConnection: database !== null
  }
}

export function closeSearchIndex(): void {
  if (database) database.close()
  if (failedWriterDatabase) failedWriterDatabase.close()
  failedWriterDatabase = null
  if (readDatabase) readDatabase.close()
  database = null
  databasePath = ''
  writerFileIdentity = null
  readDatabase = null
  readDatabasePath = ''
  readDatabaseIdentity = null
  reportedCorruptRead = null
  leftCorruptIndex = null
  lastSearchIndexRepairAt = null
  deferredRepairReportedFor = null
  synchronizationTail = Promise.resolve()
  invalidateQueryCache()
}
