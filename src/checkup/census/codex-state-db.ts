/**
 * Read-only access to Codex's own thread index (`state_<N>.sqlite`):
 * `threads` and `thread_spawn_edges`.
 *
 * Opened exactly like the repository precedents (opencode-loader.ts:256-262):
 * better-sqlite3 `{ readonly, fileMustExist, timeout }` + `query_only = ON`,
 * closed immediately, no long transaction, no sqlite3 CLI, no `immutable=1`.
 * A read-only connection to a WAL database may still create/touch the
 * `-wal`/`-shm` sidecars (SQLite mechanism); they are fingerprinted before and
 * after so the report can record the side effect.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { fingerprint, sameFingerprint, type FileFingerprint } from './files'

export interface CodexThreadRow {
  id: string
  rolloutPath: string | null
  threadSource: string | null
  archived: boolean | null
}

export interface CodexSpawnEdge { parent: string; child: string; status: string | null }

export interface SqliteSidecarAudit {
  mainBefore: FileFingerprint | null
  mainAfter: FileFingerprint | null
  /** Sidecars (-wal/-shm/-journal) that appeared or changed while the checkup held the connection. */
  sidecarsTouched: number
}

export interface CodexStateDb {
  available: boolean
  reason?: 'codex.state-db-missing' | 'codex.state-db-unreadable'
  /** N of the chosen state_<N>.sqlite (highest version). */
  version: number | null
  candidates: number
  threads: CodexThreadRow[]
  edges: CodexSpawnEdge[]
  audit: SqliteSidecarAudit | null
}

const STATE_DB = /^state_(\d+)\.sqlite$/
const SIDE_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const SQLITE_TIMEOUT_MS = 5000

export function findCodexStateDb(codexHome: string): { file: string | null; version: number | null; candidates: number } {
  let names: string[] = []
  try { names = fs.readdirSync(codexHome) } catch { names = [] }
  const versions = names
    .map((name) => STATE_DB.exec(name))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => ({ name: match[0], version: Number(match[1]) }))
    .sort((left, right) => right.version - left.version)
  const best = versions[0]
  return { file: best ? path.join(codexHome, best.name) : null, version: best?.version ?? null, candidates: versions.length }
}

function columnsOf(database: Database.Database, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name?: unknown }>
  return new Set(rows.map((row) => String(row.name)))
}

function sidecarFingerprints(file: string): Array<FileFingerprint | null> {
  return SIDE_SUFFIXES.map((suffix) => fingerprint(`${file}${suffix}`))
}

export function readCodexStateDb(codexHome: string): CodexStateDb {
  const located = findCodexStateDb(codexHome)
  if (!located.file) {
    return { available: false, reason: 'codex.state-db-missing', version: null, candidates: 0, threads: [], edges: [], audit: null }
  }
  const mainBefore = fingerprint(located.file)
  const sidecarsBefore = sidecarFingerprints(located.file)
  const threads: CodexThreadRow[] = []
  const edges: CodexSpawnEdge[] = []
  let database: Database.Database | null = null
  let failed = false
  try {
    database = new Database(located.file, { readonly: true, fileMustExist: true, timeout: SQLITE_TIMEOUT_MS })
    database.pragma('query_only = ON')
    const threadColumns = columnsOf(database, 'threads')
    if (threadColumns.has('id')) {
      const wanted = ['id', 'rollout_path', 'thread_source', 'archived'].filter((column) => threadColumns.has(column))
      const rows = database.prepare(`SELECT ${wanted.map((column) => `"${column}"`).join(', ')} FROM threads`).all() as Array<Record<string, unknown>>
      for (const row of rows) {
        if (typeof row.id !== 'string') continue
        threads.push({
          id: row.id,
          rolloutPath: typeof row.rollout_path === 'string' && row.rollout_path ? row.rollout_path : null,
          threadSource: typeof row.thread_source === 'string' ? row.thread_source : null,
          archived: typeof row.archived === 'number' ? row.archived !== 0 : null
        })
      }
    }
    const edgeColumns = columnsOf(database, 'thread_spawn_edges')
    if (edgeColumns.has('parent_thread_id') && edgeColumns.has('child_thread_id')) {
      const statusColumn = edgeColumns.has('status') ? ', "status"' : ''
      const rows = database.prepare(`SELECT "parent_thread_id", "child_thread_id"${statusColumn} FROM thread_spawn_edges`).all() as Array<Record<string, unknown>>
      for (const row of rows) {
        if (typeof row.parent_thread_id !== 'string' || typeof row.child_thread_id !== 'string') continue
        edges.push({ parent: row.parent_thread_id, child: row.child_thread_id, status: typeof row.status === 'string' ? row.status : null })
      }
    }
  } catch {
    failed = true
  } finally {
    try { database?.close() } catch { /* already closed */ }
  }
  const sidecarsAfter = sidecarFingerprints(located.file)
  const sidecarsTouched = sidecarsAfter.filter((after, index) => {
    const before = sidecarsBefore[index]
    if (!after) return false
    return !before || !sameFingerprint(before, after)
  }).length
  const audit: SqliteSidecarAudit = { mainBefore, mainAfter: fingerprint(located.file), sidecarsTouched }
  if (failed) {
    return { available: false, reason: 'codex.state-db-unreadable', version: located.version, candidates: located.candidates, threads: [], edges: [], audit }
  }
  return { available: true, version: located.version, candidates: located.candidates, threads, edges, audit }
}
