import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as path from 'path'
import { parseSessionFile } from './session-loader'
import type { RawJsonlMessage } from './types'
import { runtimeHome } from './runtime-home'
import {
  stripTerminalControlSequences,
  stripTerminalControlSequencesDeep
} from '../shared/chat-format'

// v4 rebuilds unchanged files so ANSI/CSI/OSC text cannot survive in old FTS rows.
const SEARCH_SCHEMA_VERSION = 4

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
  session_id: string
  file_signature: string
  indexed_size: number
  file_dev: number
  file_ino: number
  indexed_raw_count: number
  project_path: string
}

interface FileState {
  signature: string
  size: number
  dev: number
  ino: number
}

interface SearchRow {
  session_id: string
  file_path: string
  first_user_message: string
  snippet: string
  timestamp: string
}

interface GrepRow {
  rowid: number
  session_id: string
  file_path: string
  source: string
  project_path: string
  role: string
  text: string
  timestamp: string
}

let database: Database.Database | null = null
let databasePath = ''
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

function computeFileState(filePath: string): FileState | null {
  try {
    const stat = fs.statSync(filePath)
    return {
      signature: `${stat.mtimeMs}:${stat.size}`,
      size: stat.size,
      dev: stat.dev,
      ino: stat.ino
    }
  } catch {
    return null
  }
}

function ensureSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('busy_timeout = 2500')

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
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      project_path TEXT NOT NULL,
      file_signature TEXT NOT NULL,
      first_user_message TEXT NOT NULL,
      indexed_size INTEGER NOT NULL,
      file_dev INTEGER NOT NULL,
      file_ino INTEGER NOT NULL,
      indexed_raw_count INTEGER NOT NULL
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
  db.pragma(`user_version = ${SEARCH_SCHEMA_VERSION}`)
}

function getDatabase(): Database.Database {
  const requestedPath = searchDatabasePath()
  if (database && databasePath === requestedPath) return database
  if (database) database.close()
  queryCache.clear()

  fs.mkdirSync(path.dirname(requestedPath), { recursive: true, mode: 0o700 })
  database = new Database(requestedPath)
  databasePath = requestedPath
  ensureSchema(database)
  try { fs.chmodSync(requestedPath, 0o600) } catch { /* best effort */ }
  return database
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

function removeIndexedFile(db: Database.Database, filePath: string): void {
  const remove = db.transaction(() => {
    db.prepare('DELETE FROM messages_fts WHERE file_path = ?').run(filePath)
    db.prepare('DELETE FROM library_backup WHERE backup_path = ?').run(filePath)
    db.prepare('DELETE FROM sessions WHERE file_path = ?').run(filePath)
  })
  remove()
  invalidateQueryCache()
}

async function indexSourceNow(source: SearchIndexSource): Promise<boolean> {
  const db = getDatabase()
  const state = computeFileState(source.stateFilePath || source.filePath)
  if (!state) {
    removeIndexedFile(db, source.filePath)
    return false
  }

  const existing = db.prepare(
    'SELECT * FROM sessions WHERE file_path = ?'
  ).get(source.filePath) as IndexedSessionRow | undefined
  if (existing?.file_signature === state.signature) return false

  let raw: RawJsonlMessage[]
  try {
    raw = source.loadRaw ? await source.loadRaw() : await parseSessionFile(source.filePath)
  } catch {
    removeIndexedFile(db, source.filePath)
    return false
  }

  return writeIndexedRawSource(db, source, state, raw, existing)
}

function writeIndexedRawSource(
  db: Database.Database,
  source: SearchIndexSource,
  state: FileState,
  raw: RawJsonlMessage[],
  existing?: IndexedSessionRow
): boolean {

  const sessionId = source.sessionId || raw.find((message) => message.sessionId)?.sessionId
  if (!sessionId) {
    removeIndexedFile(db, source.filePath)
    return false
  }

  const canAppend = Boolean(
    !source.stateFilePath && existing && existing.session_id === sessionId &&
    existing.file_dev === state.dev && existing.file_ino === state.ino &&
    state.size > existing.indexed_size && raw.length >= existing.indexed_raw_count
  )
  const rawToIndex = canAppend ? raw.slice(existing!.indexed_raw_count) : raw
  const searchableMessages = rawToIndex.flatMap((message) => {
    if (message.type !== 'user' && message.type !== 'assistant') return []
    const text = extractContentText(message.message?.content)
    if (!text) return []
    return [{ role: message.type, text, timestamp: message.timestamp || '' }]
  })

  const isLibraryBackup = source.isLibraryBackup ?? path.basename(source.filePath) === 'backup.jsonl'
  const write = db.transaction(() => {
    if (!canAppend) db.prepare('DELETE FROM messages_fts WHERE file_path = ?').run(source.filePath)
    db.prepare(`
      INSERT INTO sessions(
        file_path, session_id, source, project_path, file_signature, first_user_message,
        indexed_size, file_dev, file_ino, indexed_raw_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        session_id = excluded.session_id,
        source = excluded.source,
        project_path = excluded.project_path,
        file_signature = excluded.file_signature,
        first_user_message = excluded.first_user_message,
        indexed_size = excluded.indexed_size,
        file_dev = excluded.file_dev,
        file_ino = excluded.file_ino,
        indexed_raw_count = excluded.indexed_raw_count
    `).run(
      source.filePath,
      sessionId,
      source.source || (isLibraryBackup ? 'library-backup' : 'claude-code'),
      projectPathFromRaw(raw),
      state.signature,
      firstUserMessage(raw),
      state.size,
      state.dev,
      state.ino,
      raw.length
    )

    const insertMessage = db.prepare(`
      INSERT INTO messages_fts(session_id, file_path, role, text, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const message of searchableMessages) {
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
  })
  write()
  invalidateQueryCache()
  return true
}

function serializeSynchronization(work: () => Promise<void>): Promise<void> {
  const next = synchronizationTail.then(work, work)
  synchronizationTail = next.catch(() => {})
  return next
}

export async function indexSearchSource(source: SearchIndexSource): Promise<void> {
  return serializeSynchronization(async () => {
    await indexSourceNow(source)
  })
}

export async function indexParsedSearchSource(
  source: SearchIndexSource,
  raw: RawJsonlMessage[]
): Promise<void> {
  return serializeSynchronization(async () => {
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

export async function synchronizeSearchSources(
  sources: SearchIndexSource[],
  options: { prune?: boolean } = { prune: true }
): Promise<void> {
  return serializeSynchronization(async () => {
    const uniqueSources = new Map(sources.map((source) => [source.filePath, source]))
    for (const source of uniqueSources.values()) {
      const changed = await indexSourceNow(source)
      // Yield only after real parse/write work. Unchanged hot-index validation is
      // intentionally one tight stat/query pass so every search stays sub-50ms.
      if (changed) await new Promise<void>((resolve) => setImmediate(resolve))
    }

    if (options.prune !== false) {
      const db = getDatabase()
      const livePaths = new Set(uniqueSources.keys())
      const indexed = db.prepare('SELECT file_path, file_signature FROM sessions').all() as IndexedSessionRow[]
      for (const row of indexed) {
        if (!livePaths.has(row.file_path)) removeIndexedFile(db, row.file_path)
      }
    }
  })
}

function toFtsQuery(query: string): string | null {
  const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)
  if (!tokens?.length) return null
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

export function searchFTS(query: string, limit = 50): SearchIndexResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery || limit <= 0) return []
  const db = getDatabase()
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
      sessions.file_path,
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
    let result = results.get(row.session_id)
    if (!result) {
      if (results.size >= limit) continue
      result = {
        sessionId: row.session_id,
        filePath: row.file_path,
        firstUserMessage: row.first_user_message,
        matches: []
      }
      results.set(row.session_id, result)
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
export function grepTranscripts(query: string, filters: TranscriptGrepFilters = {}): TranscriptGrepResult[] {
  const ftsQuery = toFtsQuery(query)
  if (!ftsQuery) return []
  if (filters.sessionIds && filters.sessionIds.length === 0) return []

  const db = getDatabase()
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
        filePath: row.file_path,
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

export function searchIndexStats(): { sessions: number; messages: number; libraryBackups: number; databasePath: string } {
  const db = getDatabase()
  return {
    sessions: (db.prepare('SELECT count(*) AS count FROM sessions').get() as { count: number }).count,
    messages: (db.prepare('SELECT count(*) AS count FROM messages_fts').get() as { count: number }).count,
    libraryBackups: (db.prepare('SELECT count(*) AS count FROM library_backup').get() as { count: number }).count,
    databasePath: searchDatabasePath()
  }
}

export function closeSearchIndex(): void {
  if (database) database.close()
  database = null
  databasePath = ''
  synchronizationTail = Promise.resolve()
  invalidateQueryCache()
}
