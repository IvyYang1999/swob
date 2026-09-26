import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import Database from 'better-sqlite3'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  TokenUsage,
  ContentPart,
  SessionSource
} from './session-types'
import {
  accountingFromMutuallyExclusiveUsage,
  tokenUsageFromAccounting,
  type TokenAccounting
} from './token-accounting'
import { accountOpenCodeMessageUsage, accountZCodeModelUsage } from './sqlite-agent-usage'
import { runtimeHome } from './runtime-home'
import { activityDaysFromTimestamps } from './activity-time'

const SESSION_ID_RE = /^sess?_[A-Za-z0-9_-]+$/
const SQLITE_NATIVE_BUSY_TIMEOUT_MS = 5000 // better-sqlite3 busy_timeout on the live provider DB
const AGENT_DB_SOURCES = {
  opencode: {
    relativePath: ['.local', 'share', 'opencode', 'opencode.db'],
    summaryPrefix: 'opencode'
  },
  zcode: {
    relativePath: ['.zcode', 'cli', 'db', 'db.sqlite'],
    summaryPrefix: 'zcode'
  }
} as const
export type SqliteAgentSource = keyof typeof AGENT_DB_SOURCES
const SESSION_SELECT_COLUMNS = [
  'id',
  'slug',
  'directory',
  'title',
  'model',
  'tokens',
  'time_created',
  'timeCreated',
  'created_at',
  'createdAt',
  'time_updated',
  'timeUpdated',
  'updated_at',
  'updatedAt',
  'parent_id',
  'parentId',
  'parentID'
]
const MESSAGE_SELECT_COLUMNS = ['id', 'data', 'role', 'time_created', 'timeCreated']
const PART_SELECT_COLUMNS = [
  'id',
  'messageID',
  'messageId',
  'message_id',
  'type',
  'idx',
  'index',
  'order',
  'sequence',
  'data',
  'name',
  'text',
  'content'
]
const ZCODE_USAGE_SELECT_COLUMNS = [
  'id',
  'logical_request_id',
  'attempt_index',
  'session_id',
  'provider_id',
  'model_id',
  'status',
  'started_at',
  'completed_at',
  'input_tokens',
  'output_tokens',
  'reasoning_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'provider_total_tokens',
  'computed_total_tokens'
]

type SqliteRow = Record<string, unknown>

interface OpencodeSchema {
  session: Set<string>
  message: Set<string>
  part: Set<string>
  sessionMessage: Set<string>
  modelUsage: Set<string>
}

interface LoadedOpencodeSession {
  dbPath: string
  sourceRef: string
  sessionId: string
  sessionRow: SqliteRow
  rawMessages: RawJsonlMessage[]
  tokenAccounting: TokenAccounting
}

const schemaCache = new Map<string, Promise<OpencodeSchema>>()
const sqliteSessionIdCache = new Map<string, { signature: string; ids: Set<string> }>()

export function getOpencodeDbPath(): string {
  return getSqliteAgentDbPath('opencode')
}

export function getSqliteAgentDbPath(source: SqliteAgentSource): string {
  return path.join(runtimeHome(), ...AGENT_DB_SOURCES[source].relativePath)
}

export function isValidOpencodeSessionId(sessionId?: string): boolean {
  return !!sessionId && SESSION_ID_RE.test(sessionId)
}

export function makeOpencodeSessionRef(sessionId: string, dbPath = getOpencodeDbPath()): string {
  return makeSqliteAgentSessionRef('opencode', sessionId, dbPath)
}

export function makeSqliteAgentSessionRef(
  source: SqliteAgentSource,
  sessionId: string,
  dbPath = getSqliteAgentDbPath(source)
): string {
  return `${dbPath}#${sessionId}`
}

export function parseOpencodeSessionRef(
  sourceRef: string,
  sessionIdOverride?: string
): { dbPath: string; sessionId: string | null } {
  return parseSqliteAgentSessionRef('opencode', sourceRef, sessionIdOverride)
}

export function parseSqliteAgentSessionRef(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): { dbPath: string; sessionId: string | null } {
  if (sessionIdOverride) {
    return {
      dbPath: stripSqliteAgentSessionRef(sourceRef),
      sessionId: isValidOpencodeSessionId(sessionIdOverride) ? sessionIdOverride : null
    }
  }

  if (isValidOpencodeSessionId(sourceRef)) {
    return { dbPath: getSqliteAgentDbPath(source), sessionId: sourceRef }
  }

  const hashIdx = sourceRef.lastIndexOf('#')
  if (hashIdx >= 0) {
    const sessionId = sourceRef.slice(hashIdx + 1)
    return {
      dbPath: sourceRef.slice(0, hashIdx),
      sessionId: isValidOpencodeSessionId(sessionId) ? sessionId : null
    }
  }

  return { dbPath: sourceRef, sessionId: null }
}

export function stripOpencodeSessionRef(sourceRef: string): string {
  return stripSqliteAgentSessionRef(sourceRef)
}

export function stripSqliteAgentSessionRef(sourceRef: string): string {
  const hashIdx = sourceRef.lastIndexOf('#')
  return hashIdx >= 0 ? sourceRef.slice(0, hashIdx) : sourceRef
}

export async function findOpencodeSessionFiles(dbPath = getOpencodeDbPath()): Promise<string[]> {
  return findSqliteAgentSessionFiles('opencode', dbPath)
}

export async function findSqliteAgentSessionFiles(
  source: SqliteAgentSource,
  dbPath = getSqliteAgentDbPath(source)
): Promise<string[]> {
  // `swob grep` calls this directly, so it keeps its contract and never
  // throws. A failed discovery still yields no refs here; the session loader
  // uses discoverSqliteAgentSessions, which reports the failure explicitly.
  return (await discoverSqliteAgentSessions(source, dbPath)).refs
}

export interface SqliteAgentDiscovery {
  /** 'absent': no DB file (tool not installed). 'unavailable': the DB exists but could not be read. */
  state: 'ok' | 'unavailable' | 'absent'
  reason: SqliteAgentFailureCode | null
  /** Most sqlite3 invocations one statement needed (1 = no retry; 0 = nothing ran). */
  attempts: number
  /** Session refs found; always empty unless `state` is 'ok'. */
  refs: string[]
  dbPath: string
}

/**
 * Discover the sessions of one SQLite-backed source and record the outcome in
 * its source status. Never throws: a read failure is 'unavailable' with a
 * fixed reason code, never an empty success, so no caller can mistake it for
 * "every session is gone".
 */
export async function discoverSqliteAgentSessions(
  source: SqliteAgentSource,
  dbPath = getSqliteAgentDbPath(source)
): Promise<SqliteAgentDiscovery> {
  const discovery = await probeSqliteAgentSessions(source, dbPath)
  recordSqliteAgentDiscovery(source, discovery)
  return discovery
}

async function probeSqliteAgentSessions(
  source: SqliteAgentSource,
  dbPath: string
): Promise<SqliteAgentDiscovery> {
  if (!fs.existsSync(dbPath)) return { state: 'absent', reason: null, attempts: 0, refs: [], dbPath }
  const trace: SqliteCliTrace = { attempts: 0 }
  try {
    const schema = await getSchema(dbPath, trace)
    // The DB exists, so a missing session table or id column is an
    // unsupported schema, not an empty source.
    if (!schema.session.has('id')) throw new SqliteAgentReadError('schema-unsupported')
    const rows = await runSqliteJson<SqliteRow>(
      dbPath,
      'SELECT "id" FROM "session"',
      trace
    )
    const refs = rows
      .map((row) => asString(row.id))
      .filter(isValidOpencodeSessionId)
      .map((sessionId) => makeSqliteAgentSessionRef(source, sessionId, dbPath))
    return { state: 'ok', reason: null, attempts: Math.max(1, trace.attempts), refs, dbPath }
  } catch (error) {
    return {
      state: 'unavailable',
      reason: sqliteAgentFailureCode(error),
      attempts: Math.max(1, trace.attempts, isSqliteAgentReadError(error) ? error.attempts : 1),
      refs: [],
      dbPath
    }
  }
}

// --- Source status ---

export type SqliteAgentSourceState = 'ok' | 'partial' | 'unavailable' | 'absent'

/**
 * Latest outcome of one SQLite-backed source in this process. Fixed codes and
 * counts only: never a path, a session id or sqlite3 stderr.
 */
export interface SqliteAgentSourceStatus {
  /** 'partial': discovery succeeded but some session reads failed. */
  state: SqliteAgentSourceState
  reason: SqliteAgentFailureCode | null
  /** When this status was last updated (ISO-8601). */
  at: string
  /** Last successful discovery in this process (ISO-8601), or null. */
  lastSuccessAt: string | null
  /** Most sqlite3 invocations one statement of the latest discovery needed (1 = no retry). */
  attempts: number
  /** Sessions the latest load showed from a successful read or a signature-valid cache hit. */
  sessionsRead: number
  /** Sessions whose read failed in the latest load. */
  sessionsFailed: number
  /** Sessions the latest load showed from their last good summary because a read failed. */
  sessionsCarriedOver: number
}

/** Session-phase tallies the session loader reports after each load. */
export interface SqliteAgentLoadOutcome {
  sessionsRead: number
  sessionsFailed: number
  sessionsCarriedOver: number
  /** First failure code among the session reads, if any. */
  reason: SqliteAgentFailureCode | null
}

const sourceStatuses = new Map<SqliteAgentSource, SqliteAgentSourceStatus>()
const warnedSourceStates = new Map<SqliteAgentSource, string>()

/** Process-local status of a SQLite-backed source; null until it is first discovered. */
export function getSqliteAgentSourceStatus(source: SqliteAgentSource): SqliteAgentSourceStatus | null {
  const status = sourceStatuses.get(source)
  return status ? { ...status } : null
}

function recordSqliteAgentDiscovery(source: SqliteAgentSource, discovery: SqliteAgentDiscovery): void {
  const previous = sourceStatuses.get(source)
  const at = new Date().toISOString()
  sourceStatuses.set(source, {
    state: discovery.state,
    reason: discovery.reason,
    at,
    lastSuccessAt: discovery.state === 'ok' ? at : previous?.lastSuccessAt ?? null,
    attempts: discovery.attempts,
    sessionsRead: 0,
    sessionsFailed: 0,
    sessionsCarriedOver: 0
  })
  if (discovery.state === 'unavailable') {
    warnSqliteAgentStatus(
      source,
      `unavailable:${discovery.reason}`,
      `discovery unavailable (${discovery.reason}, attempts ${discovery.attempts})`
    )
  } else if (discovery.state === 'absent') {
    warnedSourceStates.delete(source)
  }
}

/**
 * Record the session phase of the load that followed a discovery. Failed
 * session reads turn a successful discovery into 'partial'; an unavailable or
 * absent source keeps its discovery state and only gains the counts.
 */
export function recordSqliteAgentLoad(source: SqliteAgentSource, outcome: SqliteAgentLoadOutcome): void {
  const previous = sourceStatuses.get(source)
  if (!previous) return
  const discovered = previous.state === 'ok' || previous.state === 'partial'
  const partial = discovered && outcome.sessionsFailed > 0
  const reason = partial ? outcome.reason ?? 'sqlite-error' : discovered ? null : previous.reason
  sourceStatuses.set(source, {
    ...previous,
    state: discovered ? (partial ? 'partial' : 'ok') : previous.state,
    reason,
    at: new Date().toISOString(),
    sessionsRead: outcome.sessionsRead,
    sessionsFailed: outcome.sessionsFailed,
    sessionsCarriedOver: outcome.sessionsCarriedOver
  })
  if (partial) {
    warnSqliteAgentStatus(
      source,
      `partial:${reason}`,
      `${outcome.sessionsFailed} session read(s) failed (${reason}); ${outcome.sessionsCarriedOver} carried over`
    )
  } else if (discovered) {
    warnedSourceStates.delete(source)
  }
}

/** Log a failure state once per change, with fixed codes and counts only. */
function warnSqliteAgentStatus(source: SqliteAgentSource, key: string, detail: string): void {
  if (warnedSourceStates.get(source) === key) return
  warnedSourceStates.set(source, key)
  console.warn(`[sqlite-agent] ${source}: ${detail}`)
}

/**
 * Verify that a DB-backed resume reference still points at a real session row.
 * A failed read throws SqliteAgentReadError instead of reporting the row as
 * missing.
 */
export async function hasSqliteAgentSessionRecord(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<boolean> {
  const { dbPath, sessionId } = parseSqliteAgentSessionRef(source, sourceRef, sessionIdOverride)
  if (!sessionId || !fs.existsSync(dbPath)) return false

  const schema = await getSchema(dbPath)
  if (!schema.session.has('id')) throw new SqliteAgentReadError('schema-unsupported')
  const rows = await runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT "id" FROM "session" WHERE "id" = ${sqlString(sessionId)} LIMIT 1`
  )
  return rows.length === 1
}

function sqliteSourceSignature(dbPath: string): string | null {
  const parts: string[] = []
  for (const candidate of [dbPath, `${dbPath}-wal`]) {
    try {
      const stat = fs.statSync(candidate)
      parts.push(`${candidate}:${stat.size}:${stat.mtimeMs}`)
    } catch (error) {
      if (candidate === dbPath || (error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      parts.push(`${candidate}:missing`)
    }
  }
  return parts.join('|')
}

/**
 * Main-process capability check for SQLite-backed sessions. One DB snapshot is
 * indexed per physical signature so annotating many rows never opens the same
 * database hundreds of times. The WAL signature keeps the cache honest while
 * the provider is actively writing.
 */
export function hasSqliteAgentSessionRecordSync(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): boolean {
  const { dbPath, sessionId } = parseSqliteAgentSessionRef(source, sourceRef, sessionIdOverride)
  if (!sessionId) return false
  const signature = sqliteSourceSignature(dbPath)
  if (!signature) return false
  const cacheKey = `${source}:${dbPath}`
  let cached = sqliteSessionIdCache.get(cacheKey)
  if (cached?.signature !== signature) {
    try {
      const database = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: SQLITE_NATIVE_BUSY_TIMEOUT_MS
      })
      try {
        database.pragma('query_only = ON')
        const columns = new Set((database.prepare('PRAGMA table_info("session")').all() as SqliteRow[])
          .map((row) => asString(row.name)))
        if (!columns.has('id')) return false
        const ids = new Set((database.prepare('SELECT "id" FROM "session"').all() as SqliteRow[])
          .map((row) => asString(row.id))
          .filter(isValidOpencodeSessionId))
        cached = { signature, ids }
        sqliteSessionIdCache.set(cacheKey, cached)
      } finally {
        database.close()
      }
    } catch {
      sqliteSessionIdCache.delete(cacheKey)
      return false
    }
  }
  return cached.ids.has(sessionId)
}

export async function loadOpencodeRawMessages(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<RawJsonlMessage[]> {
  return loadSqliteAgentRawMessages('opencode', sourceRef, sessionIdOverride)
}

export async function buildOpencodeSessionSummary(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return buildSqliteAgentSessionSummary('opencode', sourceRef, sessionIdOverride)
}

export async function buildOpencodeSessionDetail(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionDetail | null> {
  return buildSqliteAgentSessionDetail('opencode', sourceRef, sessionIdOverride)
}

export async function loadSqliteAgentRawMessages(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<RawJsonlMessage[]> {
  // A failed read throws SqliteAgentReadError (every caller catches it); a
  // transcript with silently missing parts is never returned.
  const loaded = await loadSqliteAgentSession(source, sourceRef, sessionIdOverride)
  return loaded?.rawMessages || []
}

export async function buildSqliteAgentSessionSummary(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  // A failed read throws SqliteAgentReadError; null means only that the
  // session is gone or truly empty.
  const loaded = await loadSqliteAgentSession(source, sourceRef, sessionIdOverride)
  if (!loaded || loaded.rawMessages.length === 0) return null
  return summarizeLoadedSqliteAgentSession(source, loaded)
}

export async function buildSqliteAgentSessionDetail(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionDetail | null> {
  let loaded: LoadedOpencodeSession | null
  try {
    loaded = await loadSqliteAgentSession(source, sourceRef, sessionIdOverride)
  } catch (error) {
    // Detail readers (`swob show`, the truth-kernel IPC) have no catch of
    // their own, so a failed CLI read stays null here: for the whole session,
    // never a transcript with missing parts.
    if (isSqliteAgentReadError(error)) return null
    throw error
  }
  if (!loaded || loaded.rawMessages.length === 0) return null

  const summary = summarizeLoadedSqliteAgentSession(source, loaded)
  if (!summary) return null

  const messages = rawToParsedMessages(loaded.rawMessages)
  attachToolResults(loaded.rawMessages, messages)

  return { ...summary, messages }
}

export async function buildOpencodeSessionSummaryFromBackup(
  _filePath: string,
  _sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return null
}

async function loadSqliteAgentSession(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<LoadedOpencodeSession | null> {
  const { dbPath, sessionId } = parseSqliteAgentSessionRef(source, sourceRef, sessionIdOverride)
  if (!sessionId || !fs.existsSync(dbPath)) return null

  return withReadOnlySqliteSnapshot(dbPath, async (snapshotPath) =>
    loadSqliteAgentSessionSnapshot(source, dbPath, snapshotPath, sessionId)
  )
}

async function withReadOnlySqliteSnapshot<T>(
  dbPath: string,
  read: (snapshotPath: string) => Promise<T>
): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-provider-sqlite-'))
  const snapshotPath = path.join(tempDir, path.basename(dbPath) || 'source.db')
  const source = new Database(dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: SQLITE_NATIVE_BUSY_TIMEOUT_MS
  })
  try {
    source.pragma('query_only = ON')
    // SQLite's online backup API reads one transactionally consistent image,
    // including committed WAL pages, while the provider DB remains read-only.
    await source.backup(snapshotPath)
    // A WAL-mode backup may leave committed pages in the temporary sidecar.
    // Fold those pages into the disposable snapshot so downstream readonly
    // sqlite3 processes never need to recover or write beside the source DB.
    const snapshot = new Database(snapshotPath)
    try {
      snapshot.pragma('wal_checkpoint(TRUNCATE)')
      snapshot.pragma('journal_mode = DELETE')
    } finally {
      snapshot.close()
    }
    return await read(snapshotPath)
  } finally {
    source.close()
    schemaCache.delete(snapshotPath)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

async function loadSqliteAgentSessionSnapshot(
  source: SqliteAgentSource,
  sourceDbPath: string,
  snapshotPath: string,
  sessionId: string
): Promise<LoadedOpencodeSession | null> {
  const dbPath = snapshotPath

  const schema = await getSchema(dbPath)
  // Missing or renamed core tables are an unsupported schema, not an empty
  // session. Every query below throws on failure as well: a session without
  // its parts or its ZCode usage rows is a failed read, not a smaller session.
  if (!hasMinimumSchema(schema)) throw new SqliteAgentReadError('schema-unsupported')

  const sessionSelect = selectExistingColumns(schema.session, SESSION_SELECT_COLUMNS)
  const sessionRows = await runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT ${sessionSelect} FROM "session" WHERE "id" = ${sqlString(sessionId)} LIMIT 1`
  )
  const sessionRow = sessionRows[0]
  if (!sessionRow) return null

  const messageRows = await queryMessages(dbPath, schema, sessionId)
  if (messageRows.length === 0) return null

  const partRows = await queryParts(dbPath, schema, sessionId, messageRows)
  const rawMessages = opencodeToRawMessages(sessionId, sessionRow, messageRows, partRows)
  const tokenAccounting = source === 'opencode'
    ? accountOpenCodeMessageUsage(messageRows)
    : accountZCodeModelUsage(await queryZcodeModelUsage(dbPath, schema, sessionId))

  return {
    dbPath: sourceDbPath,
    sourceRef: makeSqliteAgentSessionRef(source, sessionId, sourceDbPath),
    sessionId,
    sessionRow,
    rawMessages,
    tokenAccounting
  }
}

function hasMinimumSchema(schema: OpencodeSchema): boolean {
  return schema.session.has('id') &&
    schema.message.has('id') &&
    schema.message.has('data') &&
    schema.part.has('data')
}

async function getSchema(dbPath: string, trace?: SqliteCliTrace): Promise<OpencodeSchema> {
  let cached = schemaCache.get(dbPath)
  if (!cached) {
    const loading = loadSchema(dbPath, trace)
    cached = loading
    schemaCache.set(dbPath, loading)
    // Cache successes only. A failed probe used to be cached as "no columns",
    // pinning the whole source at zero sessions until the process exited.
    loading.catch(() => {
      if (schemaCache.get(dbPath) === loading) schemaCache.delete(dbPath)
    })
  }
  return cached
}

const SCHEMA_TABLES = ['session', 'message', 'part', 'session_message', 'model_usage'] as const

async function loadSchema(dbPath: string, trace?: SqliteCliTrace): Promise<OpencodeSchema> {
  const probes = await Promise.allSettled(
    SCHEMA_TABLES.map((tableName) => tableColumns(dbPath, tableName, trace))
  )
  // Any failed probe fails the schema (first failure in table order): an
  // empty column set would otherwise read as "this table does not exist".
  for (const probe of probes) {
    if (probe.status === 'rejected') throw probe.reason
  }
  const [session, message, part, sessionMessage, modelUsage] = probes.map((probe) =>
    (probe as PromiseFulfilledResult<Set<string>>).value)
  return { session, message, part, sessionMessage, modelUsage }
}

async function tableColumns(
  dbPath: string,
  tableName: string,
  trace?: SqliteCliTrace
): Promise<Set<string>> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error('invalid-sqlite-table-name')
  const rows = await runSqliteJson<SqliteRow>(
    dbPath,
    `PRAGMA table_info("${tableName}")`,
    trace
  )
  return new Set(rows.map((row) => asString(row.name)).filter(Boolean))
}

// --- sqlite3 CLI executor ---

/**
 * `.timeout` given to every sqlite3 CLI process. Without it the CLI fails at
 * once with SQLITE_BUSY while another short-lived reader (our own parallel
 * schema probes included) rebuilds the WAL index.
 */
const SQLITE_CLI_BUSY_TIMEOUT_MS = 3000
/** Wall clock per sqlite3 CLI process; SWOB_SQLITE_CLI_TIMEOUT_MS overrides it within the bounds below. */
const SQLITE_CLI_DEFAULT_WALL_TIMEOUT_MS = 15_000
const SQLITE_CLI_MIN_WALL_TIMEOUT_MS = 1_000
const SQLITE_CLI_MAX_WALL_TIMEOUT_MS = 120_000
/** Under NODE_ENV=test the floor is lower so timeout paths can be exercised quickly. */
const SQLITE_CLI_TEST_MIN_WALL_TIMEOUT_MS = 50
/** A timer at least this late means the event loop was blocked after spawn. */
const SQLITE_CLI_LATE_TIMER_MS = 100
/** One extra window for an already-exited child to deliver 'close' before a late timeout counts. */
const SQLITE_CLI_LATE_TIMER_GRACE_MS = 250
/** Jittered backoff before the single retry of a busy / cannot-open statement. */
const SQLITE_CLI_RETRY_MIN_BACKOFF_MS = 250
const SQLITE_CLI_RETRY_MAX_BACKOFF_MS = 1_000
const SQLITE_CLI_STDERR_LIMIT = 4_096

export const SQLITE_AGENT_FAILURE_CODES = [
  'sqlite3-missing',
  'busy',
  'cannot-open',
  'corrupt',
  'sqlite-error',
  'timeout',
  'unparseable-output',
  'schema-unsupported'
] as const
export type SqliteAgentFailureCode = typeof SQLITE_AGENT_FAILURE_CODES[number]

const RETRIED_SQLITE_CLI_FAILURES: ReadonlySet<SqliteAgentFailureCode> = new Set(['busy', 'cannot-open'])

/**
 * A SQLite-agent read that failed. The message is the fixed code only: never a
 * path, a session id or sqlite3's stderr.
 */
export class SqliteAgentReadError extends Error {
  readonly code: SqliteAgentFailureCode
  readonly attempts: number

  constructor(code: SqliteAgentFailureCode, attempts = 1) {
    super(`sqlite-agent-read-failed:${code}`)
    this.name = 'SqliteAgentReadError'
    this.code = code
    this.attempts = attempts
  }
}

export function isSqliteAgentReadError(error: unknown): error is SqliteAgentReadError {
  return error instanceof Error && error.name === 'SqliteAgentReadError' &&
    (SQLITE_AGENT_FAILURE_CODES as readonly unknown[]).includes((error as { code?: unknown }).code)
}

/** Fixed reason code for any failed SQLite-agent read (sqlite3 CLI or better-sqlite3). */
export function sqliteAgentFailureCode(error: unknown): SqliteAgentFailureCode {
  if (isSqliteAgentReadError(error)) return error.code
  const code = typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : ''
  if (code.startsWith('SQLITE_BUSY')) return 'busy'
  if (code.startsWith('SQLITE_CANTOPEN')) return 'cannot-open'
  if (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB') return 'corrupt'
  return 'sqlite-error'
}

interface SqliteCliTrace {
  /** Most sqlite3 invocations any single statement needed. */
  attempts: number
}

type SqliteCliOutcome<T> = { ok: true; rows: T[] } | { ok: false; code: SqliteAgentFailureCode }

function sqliteCliWallTimeoutMs(): number {
  const raw = process.env.SWOB_SQLITE_CLI_TIMEOUT_MS?.trim()
  const requested = raw ? Number(raw) : Number.NaN
  if (!Number.isFinite(requested)) return SQLITE_CLI_DEFAULT_WALL_TIMEOUT_MS
  const floor = process.env.NODE_ENV === 'test'
    ? SQLITE_CLI_TEST_MIN_WALL_TIMEOUT_MS
    : SQLITE_CLI_MIN_WALL_TIMEOUT_MS
  return Math.min(SQLITE_CLI_MAX_WALL_TIMEOUT_MS, Math.max(floor, Math.round(requested)))
}

/** Map sqlite3's stderr to a fixed code; the text itself is never kept or surfaced. */
function classifySqliteCliFailure(stderr: string): SqliteAgentFailureCode {
  const text = stderr.toLowerCase()
  if (text.includes('database is locked')) return 'busy'
  if (text.includes('unable to open database')) return 'cannot-open'
  if (text.includes('file is not a database') || text.includes('malformed')) return 'corrupt'
  // Otherwise use the trailing "(N)" result code; extended codes such as
  // 261/517 (busy) keep their primary code in the low byte.
  for (const match of stderr.matchAll(/\((\d+)\)\s*$/gm)) {
    const primary = Number(match[1]) & 0xff
    if (primary === 5) return 'busy'
    if (primary === 14) return 'cannot-open'
    if (primary === 11 || primary === 26) return 'corrupt'
  }
  return 'sqlite-error'
}

/**
 * Run one read-only statement through the sqlite3 CLI. Every failure throws a
 * SqliteAgentReadError; exit 0 with empty output is a legitimate empty result
 * (no rows, or a table that does not exist). busy / cannot-open get one
 * jittered retry. A timeout is not retried in-statement, so one stuck sqlite3
 * cannot hold the first session list for twice the wall clock; the next load
 * probes again instead.
 */
async function runSqliteJson<T extends SqliteRow>(
  dbPath: string,
  sql: string,
  trace?: SqliteCliTrace
): Promise<T[]> {
  if (!fs.existsSync(dbPath)) return []

  const wallTimeoutMs = sqliteCliWallTimeoutMs()
  let attempts = 1
  let outcome = await runSqliteCliOnce<T>(dbPath, sql, wallTimeoutMs)
  if (!outcome.ok && RETRIED_SQLITE_CLI_FAILURES.has(outcome.code)) {
    const backoffMs = SQLITE_CLI_RETRY_MIN_BACKOFF_MS + Math.floor(
      Math.random() * (SQLITE_CLI_RETRY_MAX_BACKOFF_MS - SQLITE_CLI_RETRY_MIN_BACKOFF_MS + 1)
    )
    await new Promise((resolve) => setTimeout(resolve, backoffMs))
    attempts = 2
    outcome = await runSqliteCliOnce<T>(dbPath, sql, wallTimeoutMs)
  }
  if (trace) trace.attempts = Math.max(trace.attempts, attempts)
  if (!outcome.ok) throw new SqliteAgentReadError(outcome.code, attempts)
  return outcome.rows
}

function spawnSqlite3(dbPath: string): ChildProcessWithoutNullStreams | null {
  try {
    return spawn('sqlite3', ['-cmd', `.timeout ${SQLITE_CLI_BUSY_TIMEOUT_MS}`, '-readonly', '-json', dbPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch {
    return null
  }
}

function runSqliteCliOnce<T extends SqliteRow>(
  dbPath: string,
  sql: string,
  wallTimeoutMs: number
): Promise<SqliteCliOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let timer: ReturnType<typeof setTimeout> | undefined

    function finish(outcome: SqliteCliOutcome<T>): void {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(outcome)
    }

    const child = spawnSqlite3(dbPath)
    if (!child || !child.stdin || !child.stdout || !child.stderr) {
      child?.kill()
      finish({ ok: false, code: 'sqlite-error' })
      return
    }

    const armedAt = Date.now()
    let graceGiven = false
    const onTimeout = (): void => {
      // A late timer means the event loop was blocked after spawn, and the
      // child may already have exited with a valid result: let its 'close'
      // arrive once before calling it a timeout.
      if (!graceGiven && Date.now() - armedAt - wallTimeoutMs >= SQLITE_CLI_LATE_TIMER_MS) {
        graceGiven = true
        timer = setTimeout(onTimeout, SQLITE_CLI_LATE_TIMER_GRACE_MS)
        return
      }
      child.kill()
      finish({ ok: false, code: 'timeout' })
    }
    timer = setTimeout(onTimeout, wallTimeoutMs)

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    // stderr is read only to classify a failure.
    child.stderr.setEncoding('utf-8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < SQLITE_CLI_STDERR_LIMIT) stderr += chunk
    })
    // A child that exits before reading its script must not surface EPIPE as
    // an unhandled error; 'close' reports the outcome.
    child.stdin.on('error', () => {})

    child.on('error', (error) => {
      finish({
        ok: false,
        code: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'sqlite3-missing' : 'sqlite-error'
      })
    })
    child.on('close', (code) => {
      if (code !== 0) {
        finish({ ok: false, code: classifySqliteCliFailure(stderr) })
        return
      }
      const trimmed = stdout.trim()
      if (!trimmed) {
        finish({ ok: true, rows: [] })
        return
      }
      try {
        const parsed: unknown = JSON.parse(trimmed)
        finish(Array.isArray(parsed)
          ? { ok: true, rows: parsed as T[] }
          : { ok: false, code: 'unparseable-output' })
      } catch {
        finish({ ok: false, code: 'unparseable-output' })
      }
    })

    child.stdin.end(`PRAGMA query_only=ON;\n${sql.trim()};\n`)
  })
}

async function queryMessages(
  dbPath: string,
  schema: OpencodeSchema,
  sessionId: string
): Promise<SqliteRow[]> {
  const messageSelect = selectExistingColumns(schema.message, MESSAGE_SELECT_COLUMNS)
  const messageSessionCol = pickColumn(schema.message, ['sessionID', 'sessionId', 'session_id'])
  if (messageSessionCol) {
    const timeColumn = pickColumn(schema.message, ['time_created', 'timeCreated'])
    const orderBy = timeColumn
      ? ` ORDER BY ${quotedIdent(timeColumn)}, "id"`
      : ' ORDER BY "id"'
    return runSqliteJson<SqliteRow>(
      dbPath,
      `SELECT ${messageSelect} FROM "message" WHERE ${quotedIdent(messageSessionCol)} = ${sqlString(sessionId)}${orderBy}`
    )
  }

  const smSessionCol = pickColumn(schema.sessionMessage, ['sessionID', 'sessionId', 'session_id'])
  const smMessageCol = pickColumn(schema.sessionMessage, ['messageID', 'messageId', 'message_id'])
  if (smSessionCol && smMessageCol) {
    const aliasedMessageSelect = selectExistingColumns(schema.message, MESSAGE_SELECT_COLUMNS, 'm')
    return runSqliteJson<SqliteRow>(
      dbPath,
      `SELECT ${aliasedMessageSelect} FROM "message" m ` +
      `JOIN "session_message" sm ON sm.${quotedIdent(smMessageCol)} = m."id" ` +
      `WHERE sm.${quotedIdent(smSessionCol)} = ${sqlString(sessionId)}`
    )
  }

  return []
}

async function queryParts(
  dbPath: string,
  schema: OpencodeSchema,
  sessionId: string,
  messages: SqliteRow[]
): Promise<SqliteRow[]> {
  const partSelect = selectExistingColumns(schema.part, PART_SELECT_COLUMNS)
  const partSessionCol = pickColumn(schema.part, ['sessionID', 'sessionId', 'session_id'])
  if (partSessionCol) {
    return runSqliteJson<SqliteRow>(
      dbPath,
      `SELECT ${partSelect} FROM "part" WHERE ${quotedIdent(partSessionCol)} = ${sqlString(sessionId)}`
    )
  }

  const partMessageCol = pickColumn(schema.part, ['messageID', 'messageId', 'message_id'])
  if (!partMessageCol) return []

  const ids = messages.map(messageId).filter(Boolean).map(sqlString)
  if (ids.length === 0) return []

  return runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT ${partSelect} FROM "part" WHERE ${quotedIdent(partMessageCol)} IN (${ids.join(',')})`
  )
}

async function queryZcodeModelUsage(
  dbPath: string,
  schema: OpencodeSchema,
  sessionId: string
): Promise<SqliteRow[]> {
  const sessionColumn = pickColumn(schema.modelUsage, ['session_id', 'sessionID', 'sessionId'])
  if (!sessionColumn || !schema.modelUsage.has('id')) return []
  const select = selectExistingColumns(schema.modelUsage, ZCODE_USAGE_SELECT_COLUMNS)
  return runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT ${select} FROM "model_usage" WHERE ${quotedIdent(sessionColumn)} = ${sqlString(sessionId)} ` +
      `ORDER BY ${schema.modelUsage.has('started_at') ? '"started_at", ' : ''}"id"`
  )
}

function opencodeToRawMessages(
  sessionId: string,
  sessionRow: SqliteRow,
  messageRows: SqliteRow[],
  partRows: SqliteRow[]
): RawJsonlMessage[] {
  const partsByMessage = new Map<string, SqliteRow[]>()
  for (const part of partRows) {
    const id = partMessageId(part)
    if (!id) continue
    if (!partsByMessage.has(id)) partsByMessage.set(id, [])
    partsByMessage.get(id)!.push(part)
  }

  const rows = [...messageRows].sort((a, b) => {
    const at = timestampSortValue(messageTimestamp(a))
    const bt = timestampSortValue(messageTimestamp(b))
    if (at !== bt) return at - bt
    return messageId(a).localeCompare(messageId(b))
  })

  const messages: RawJsonlMessage[] = []
  for (const row of rows) {
    const data = parseObject(row.data)
    const role = asString(data.role) || asString(row.role)
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue

    const uuid = asString(row.id) || asString(data.id)
    if (!uuid) continue

    const parts = (partsByMessage.get(uuid) || [])
      .filter((part) => !isIgnoredPartType(partType(part)))
      .sort(sortParts)

    const content = buildMessageContent(role, data, parts)
    if (isEmptyContent(content)) continue

    const timestamp = normalizeTimestamp(
      data.time && typeof data.time === 'object'
        ? (data.time as Record<string, unknown>).created
        : undefined
    ) || normalizeTimestamp(row.time_created) || normalizeTimestamp(row.timeCreated) || ''

    const cwd = asString(parseObject(data.path).cwd) ||
      asString(data.cwd) ||
      asString(sessionRow.directory)
    const modelObject = parseObject(data.model)
    const model = asString(data.modelID) || asString(data.modelId) || asString(data.model_id) ||
      asString(modelObject.modelID) || asString(modelObject.modelId) || asString(data.model) ||
      asString(sessionRow.model)
    const provider = asString(data.providerID) || asString(data.providerId) || asString(data.provider_id) ||
      asString(modelObject.providerID) || asString(modelObject.providerId) || asString(modelObject.provider_id)

    messages.push({
      uuid,
      parentUuid: asString(data.parentID) || asString(data.parentId) || null,
      sessionId,
      type: role,
      timestamp,
      cwd,
      slug: asString(sessionRow.slug) || undefined,
      version: model || undefined,
      providerId: provider || undefined,
      message: {
        role,
        model: model || undefined,
        providerId: provider || undefined,
        content,
        usage: extractUsage(data.tokens)
      }
    })
  }

  return messages
}

function buildMessageContent(
  role: string,
  messageData: Record<string, unknown>,
  parts: SqliteRow[]
): string | ContentPart[] {
  const contentParts: ContentPart[] = []

  for (const part of parts) {
    const type = partType(part)
    const data = parseObject(part.data)

    if (type === 'text') {
      const text = extractPartText(part, data)
      if (text) contentParts.push({ type: 'text', text })
      continue
    }

    if (type === 'reasoning') {
      const text = extractPartText(part, data)
      if (text) contentParts.push({ type: 'reasoning', text })
      continue
    }

    if (type === 'tool' && role === 'assistant') {
      const tool = buildToolUsePart(part, data)
      if (tool) contentParts.push(tool)
    }
  }

  if (contentParts.length === 0) {
    const fallbackText = extractMessageFallbackText(messageData)
    return fallbackText
  }

  const textOnly = contentParts.every((part) => part.type === 'text')
  if (textOnly) {
    return contentParts.map((part) => part.text || '').filter(Boolean).join('\n')
  }

  return contentParts
}

function buildToolUsePart(part: SqliteRow, data: Record<string, unknown>): ContentPart | null {
  const name = normalizeToolName(
    asString(data.name) ||
    asString(data.tool) ||
    asString(data.toolName) ||
    asString(part.name)
  )
  if (!name) return null

  return {
    type: 'tool_use',
    id: asString(data.id) || asString(data.callID) || asString(data.callId) || asString(part.id),
    name,
    input: extractToolInput(data)
  }
}

function extractToolInput(data: Record<string, unknown>): Record<string, unknown> {
  const candidate = data.input || data.args || data.arguments || data.params
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>
  }
  if (typeof candidate === 'string') {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* ignore */ }
  }
  return {}
}

function extractPartText(part: SqliteRow, data: Record<string, unknown>): string {
  const direct = asString(data.text) ||
    asString(data.content) ||
    asString(data.value) ||
    asString(part.text) ||
    asString(part.content)
  return direct || ''
}

function partType(part: SqliteRow): string {
  return asString(part.type) || asString(parseObject(part.data).type)
}

function extractMessageFallbackText(messageData: Record<string, unknown>): string {
  return asString(messageData.text) ||
    asString(messageData.content) ||
    asString(messageData.message) ||
    ''
}

function summarizeLoadedSqliteAgentSession(source: SqliteAgentSource, loaded: LoadedOpencodeSession): SessionSummary | null {
  const { dbPath, sourceRef, sessionId, sessionRow, rawMessages } = loaded
  if (rawMessages.length === 0) return null

  const validMessages = rawMessages.filter((m) => (m.type === 'user' || m.type === 'assistant') && m.message)
  if (validMessages.length === 0) return null

  const userMessages = validMessages.filter((m) => m.type === 'user' && extractText(m.message?.content).trim())
  const assistantMessages = validMessages.filter((m) => {
    if (m.type !== 'assistant') return false
    const content = m.message?.content
    return extractText(content).trim().length > 0 || extractToolCalls(content).length > 0
  })
  const timestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const activityDays = activityDaysFromTimestamps(timestamps)
  const cwds = [...new Set(rawMessages.map((m) => m.cwd).filter(Boolean) as string[])]
  const sessionTitle = source === 'zcode'
    ? asString(sessionRow.title) || asString(sessionRow.slug)
    : asString(sessionRow.slug) || asString(sessionRow.title)
  const firstUserMessage = userMessages[0]?.message
    ? extractText(userMessages[0].message.content).slice(0, 200)
    : (sessionTitle || sessionId).slice(0, 200)

  const allUserTexts: string[] = []
  let totalLen = 0
  const USER_TEXT_LIMIT = 2000
  for (const msg of userMessages) {
    const text = extractText(msg.message?.content).trim()
    if (!text || text === firstUserMessage) continue
    if (totalLen + text.length > USER_TEXT_LIMIT) {
      allUserTexts.push(text.slice(0, USER_TEXT_LIMIT - totalLen))
      break
    }
    allUserTexts.push(text)
    totalLen += text.length
  }

  const toolUsage: Record<string, number> = {}
  for (const msg of rawMessages) {
    if (msg.type !== 'assistant') continue
    for (const tool of extractToolCalls(msg.message?.content)) {
      toolUsage[tool.name] = (toolUsage[tool.name] || 0) + 1
    }
  }

  let tokenAccounting = loaded.tokenAccounting
  if (tokenAccounting.billingTotal === null) {
    const tokenUsage = rawMessages.reduce<TokenUsage>((acc, msg) => {
      if (msg.type !== 'assistant' || !msg.message?.usage) return acc
      acc.inputTokens += msg.message.usage.input_tokens || 0
      acc.outputTokens += msg.message.usage.output_tokens || 0
      acc.cacheCreationTokens += msg.message.usage.cache_creation_input_tokens || 0
      acc.cacheReadTokens += msg.message.usage.cache_read_input_tokens || 0
      return acc
    }, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })

    const sessionTokenUsage = extractAggregateUsage(sessionRow.tokens)
    if (tokenUsage.inputTokens === 0 && tokenUsage.outputTokens === 0 && sessionTokenUsage) {
      Object.assign(tokenUsage, sessionTokenUsage)
    }
    tokenAccounting = accountingFromMutuallyExclusiveUsage(
      source as SessionSource,
      tokenUsage,
      'reported',
      `${source} legacy aggregate fallback; request-level model/provider evidence unavailable`
    )
  }
  const normalizedTokenUsage = tokenUsageFromAccounting(tokenAccounting)

  const stat = safeStat(dbPath)
  const models = [...new Set([
    ...rawMessages.map((m) => m.message?.model),
    ...tokenAccounting.usageEvents.map((event) => event.modelRaw || event.model)
  ].filter(Boolean) as string[])]
  const sessionModel = asString(sessionRow.model)
  if (sessionModel && !models.includes(sessionModel)) models.push(sessionModel)

  return {
    id: `${AGENT_DB_SOURCES[source].summaryPrefix}:${sessionId}`,
    sessionId,
    resumeSessionId: sessionId,
    slug: sessionTitle,
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    activityDays,
    messageCount: validMessages.length,
    turnCount: Math.min(userMessages.length, assistantMessages.length),
    compactCount: 0,
    cwds,
    version: sessionModel || models[0] || '',
    firstUserMessage,
    toolUsage,
    skillInvocations: [],
    projectPath: asString(sessionRow.directory) || path.dirname(dbPath),
    filePath: sourceRef,
    fileSizeBytes: stat?.size || 0,
    allFilePaths: [sourceRef],
    resumeCwd: asString(sessionRow.directory) || cwds[0],
    branchParentId: asString(sessionRow.parent_id) || asString(sessionRow.parentId) || asString(sessionRow.parentID) || undefined,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: normalizedTokenUsage,
    tokenAccounting,
    providerOutcome: {
      detected: 'detected',
      parse: 'parsed',
      usage: tokenAccounting.billingTotal === null ? 'unavailable' : 'available'
    },
    referencedFiles: [],
    configFiles: [],
    source: source as SessionSource,
    allUserMessages: allUserTexts.length > 0 ? allUserTexts.join(' ') : undefined,
    models
  }
}

function rawToParsedMessages(rawMessages: RawJsonlMessage[]): ParsedMessage[] {
  return rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
    .map((m) => {
      const content = m.message?.content
      const isToolResult = Array.isArray(content) && content.some((part) => part.type === 'tool_result')
      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: undefined,
        timestamp: m.timestamp,
        role: m.message?.role,
        origin: 'unknown',
        textContent: extractText(content),
        toolCalls: extractToolCalls(content),
        images: [],
        tokenUsage: m.type === 'assistant' ? extractParsedTokenUsage(m) : undefined,
        isPreCompact: false,
        isSidechain: false,
        isSharedContext: false,
        isSystemGenerated: isToolResult,
        raw: m
      }
    })
}

function attachToolResults(rawMessages: RawJsonlMessage[], parsedMessages: ParsedMessage[]): void {
  for (const raw of rawMessages) {
    const content = raw.message?.content
    if (raw.type !== 'user' || !Array.isArray(content)) continue
    for (const part of content) {
      if (part.type !== 'tool_result' || !part.tool_use_id || !part.content) continue
      const resultText = typeof part.content === 'string' ? part.content : extractText(part.content)
      if (!resultText) continue
      for (const msg of parsedMessages) {
        const toolCall = msg.toolCalls.find((tc) => tc.id === part.tool_use_id)
        if (toolCall) {
          toolCall.result = resultText
          break
        }
      }
    }
  }
}

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!)
    .join('\n')
}

function extractToolCalls(content: string | ContentPart[] | undefined): ToolCallInfo[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((part) => part.type === 'tool_use' && part.name)
    .map((part) => ({
      id: part.id,
      name: part.name!,
      input: (part.input as Record<string, unknown>) || {}
    }))
}

function extractParsedTokenUsage(msg: RawJsonlMessage): TokenUsage | undefined {
  const usage = msg.message?.usage
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0
  }
}

function extractUsage(tokensValue: unknown): NonNullable<RawJsonlMessage['message']>['usage'] | undefined {
  const usage = extractAggregateUsage(tokensValue)
  if (!usage) return undefined
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationTokens,
    cache_read_input_tokens: usage.cacheReadTokens
  }
}

function extractAggregateUsage(tokensValue: unknown): TokenUsage | null {
  const tokens = parseObject(tokensValue)
  if (Object.keys(tokens).length === 0) return null

  const cache = parseObject(tokens.cache)
  return {
    inputTokens: asNumber(tokens.input) ||
      asNumber(tokens.inputTokens) ||
      asNumber(tokens.input_tokens) ||
      asNumber(tokens.prompt_tokens) ||
      0,
    outputTokens: asNumber(tokens.output) ||
      asNumber(tokens.outputTokens) ||
      asNumber(tokens.output_tokens) ||
      asNumber(tokens.completion_tokens) ||
      0,
    cacheCreationTokens: asNumber(tokens.cacheCreation) ||
      asNumber(tokens.cache_creation_input_tokens) ||
      asNumber(cache.creation) ||
      asNumber(cache.write) ||
      0,
    cacheReadTokens: asNumber(tokens.cacheRead) ||
      asNumber(tokens.cache_read_input_tokens) ||
      asNumber(tokens.cached_input_tokens) ||
      asNumber(cache.read) ||
      0
  }
}

function isIgnoredPartType(partType: string): boolean {
  return partType === 'step-start' ||
    partType === 'step-finish'
}

function normalizeToolName(name: string): string {
  const normalized = name.trim()
  const map: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Bash'
  }
  return map[normalized.toLowerCase()] || normalized
}

function sortParts(a: SqliteRow, b: SqliteRow): number {
  const ai = asNumber(a.idx) || asNumber(a.index) || asNumber(a.order) || asNumber(a.sequence)
  const bi = asNumber(b.idx) || asNumber(b.index) || asNumber(b.order) || asNumber(b.sequence)
  if (ai !== bi) return ai - bi
  return asString(a.id).localeCompare(asString(b.id))
}

function messageTimestamp(row: SqliteRow): unknown {
  const data = parseObject(row.data)
  const time = parseObject(data.time)
  return time.created || row.time_created || row.timeCreated
}

function timestampSortValue(value: unknown): number {
  const iso = normalizeTimestamp(value)
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeTimestamp(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000
    return new Date(millis).toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed)
      if (Number.isFinite(num)) return normalizeTimestamp(num)
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed
  }
  return ''
}

function messageId(row: SqliteRow): string {
  const data = parseObject(row.data)
  return asString(row.id) || asString(data.id)
}

function partMessageId(row: SqliteRow): string {
  const data = parseObject(row.data)
  return asString(row.messageID) ||
    asString(row.messageId) ||
    asString(row.message_id) ||
    asString(data.messageID) ||
    asString(data.messageId) ||
    asString(data.message_id)
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function isEmptyContent(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return content.trim().length === 0
  return content.every((part) => {
    if (part.type === 'tool_use') return false
    return !part.text?.trim()
  })
}

function pickColumn(columns: Set<string>, candidates: string[]): string | null {
  return candidates.find((candidate) => columns.has(candidate)) || null
}

function selectExistingColumns(columns: Set<string>, candidates: string[], alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return candidates
    .filter((candidate) => columns.has(candidate))
    .map((candidate) => `${prefix}${quotedIdent(candidate)}`)
    .join(', ')
}

function quotedIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}
