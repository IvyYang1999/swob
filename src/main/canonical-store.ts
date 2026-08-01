import * as fs from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import type {
  CanonicalRecord,
  Fingerprint,
  ParseOutcome,
  SessionRecord,
  SourceRef,
  Tombstone
} from '../shared/provider-schema.generated'
import type {
  CanonicalEvent,
  ParseChunk,
  SessionIdentity
} from '../shared/provider-schema-v2.generated'
import { validateParseChunkV2 } from '../shared/provider-protocol-v2'
import { runtimeHome } from './runtime-home'

export const CANONICAL_STORE_SCHEMA_VERSION = 2
const CANONICAL_STORE_BUSY_TIMEOUT_MS = 3_000

export interface CanonicalStoredSession {
  sessionRecord: SessionRecord
  records: CanonicalRecord[]
  fingerprint: Fingerprint
  tombstone: Tombstone | null
}

export interface CanonicalSourceState {
  sourceRef: SourceRef
  fingerprint: Fingerprint
  sessionRecordIds: string[]
  tombstonedAt: string | null
}

interface SessionRow {
  session_record_id: string
  fingerprint_json: string
  session_json: string
  tombstoned_at: string | null
  tombstone_reason: Tombstone['reason'] | null
}

interface RecordRow {
  session_record_id: string
  record_json: string
}

interface SourceRow {
  source_ref_json: string
  fingerprint_json: string
  tombstoned_at: string | null
}

interface V2SessionRow {
  identity_json: string
  fingerprint_json: string
  complete: number
  last_chunk_index: number
  last_cursor: string | null
  event_count: number
  tombstoned_at: string | null
  tombstone_reason: Tombstone['reason'] | null
}

interface V2EventRow {
  event_json: string
}

export interface CanonicalStoredEventSession {
  identity: SessionIdentity
  fingerprint: Fingerprint
  complete: boolean
  lastChunkIndex: number
  lastCursor: string | null
  eventCount: number
  tombstonedAt: string | null
  tombstoneReason: Tombstone['reason'] | null
}

export interface CanonicalEventPage {
  events: CanonicalEvent[]
  nextSequence: number | null
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T
}

function canonicalStoreDirectory(): string {
  return process.env.SWOB_CANONICAL_STORE_DIR || path.join(runtimeHome(), '.claude-session-manager')
}

export function canonicalStoreDatabasePath(): string {
  return path.join(canonicalStoreDirectory(), 'canonical.db')
}

function ensureSchema(database: Database.Database): void {
  database.pragma(`busy_timeout = ${CANONICAL_STORE_BUSY_TIMEOUT_MS}`)
  database.pragma('journal_mode = WAL')
  database.pragma('synchronous = NORMAL')
  database.pragma('foreign_keys = ON')
  const version = database.pragma('user_version', { simple: true }) as number
  if (version > CANONICAL_STORE_SCHEMA_VERSION) {
    throw new Error(`canonical-store-schema-too-new:${version}`)
  }
  if (version === 0) {
    const migrate = database.transaction(() => {
      // Version 0 is either a new database or an interrupted pre-v1 setup.
      // Canonical state is a rebuildable projection, so remove any partial DDL
      // and publish the whole schema atomically.
      database.exec(`
        DROP TABLE IF EXISTS canonical_v2_events;
        DROP TABLE IF EXISTS canonical_v2_sessions;
        DROP TABLE IF EXISTS canonical_records;
        DROP TABLE IF EXISTS canonical_sessions;
        DROP TABLE IF EXISTS canonical_sources;
        DROP TABLE IF EXISTS canonical_schema_migrations;
        CREATE TABLE canonical_schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE canonical_sources (
          provider_id TEXT NOT NULL,
          source_ref_id TEXT NOT NULL,
          source_ref_json TEXT NOT NULL,
          fingerprint_json TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          tombstoned_at TEXT,
          PRIMARY KEY(provider_id, source_ref_id)
        );
        CREATE TABLE canonical_sessions (
          session_record_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          source_ref_id TEXT NOT NULL,
          source_session_id TEXT NOT NULL,
          project_path TEXT,
          created_at TEXT,
          updated_at TEXT,
          fingerprint_json TEXT NOT NULL,
          session_json TEXT NOT NULL,
          tombstoned_at TEXT,
          tombstone_reason TEXT,
          UNIQUE(provider_id, source_ref_id, source_session_id),
          FOREIGN KEY(provider_id, source_ref_id)
            REFERENCES canonical_sources(provider_id, source_ref_id)
        );
        CREATE INDEX canonical_sessions_provider_idx
          ON canonical_sessions(provider_id, source_session_id);
        CREATE INDEX canonical_sessions_source_idx
          ON canonical_sessions(provider_id, source_ref_id);
        CREATE TABLE canonical_records (
          record_id TEXT PRIMARY KEY,
          session_record_id TEXT NOT NULL,
          record_type TEXT NOT NULL,
          ordinal INTEGER,
          record_json TEXT NOT NULL,
          FOREIGN KEY(session_record_id) REFERENCES canonical_sessions(session_record_id) ON DELETE CASCADE
        );
        CREATE INDEX canonical_records_session_idx
          ON canonical_records(session_record_id, ordinal, record_id);
        CREATE TABLE canonical_v2_sessions (
          logical_session_key TEXT NOT NULL,
          branch_view_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          physical_source_id TEXT NOT NULL,
          identity_json TEXT NOT NULL,
          fingerprint_json TEXT NOT NULL,
          complete INTEGER NOT NULL,
          last_chunk_index INTEGER NOT NULL,
          last_cursor TEXT,
          event_count INTEGER NOT NULL,
          tombstoned_at TEXT,
          tombstone_reason TEXT,
          PRIMARY KEY(logical_session_key, branch_view_id)
        );
        CREATE INDEX canonical_v2_sessions_source_idx
          ON canonical_v2_sessions(provider_id, physical_source_id);
        CREATE TABLE canonical_v2_events (
          logical_session_key TEXT NOT NULL,
          branch_view_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          message_block_index INTEGER,
          event_json TEXT NOT NULL,
          PRIMARY KEY(logical_session_key, branch_view_id, event_id),
          UNIQUE(logical_session_key, branch_view_id, sequence),
          FOREIGN KEY(logical_session_key, branch_view_id)
            REFERENCES canonical_v2_sessions(logical_session_key, branch_view_id) ON DELETE CASCADE
        );
        CREATE INDEX canonical_v2_events_page_idx
          ON canonical_v2_events(logical_session_key, branch_view_id, sequence);
      `)
      database.prepare(
        'INSERT INTO canonical_schema_migrations(version, applied_at) VALUES (?, ?)'
      ).run(CANONICAL_STORE_SCHEMA_VERSION, new Date().toISOString())
      database.pragma(`user_version = ${CANONICAL_STORE_SCHEMA_VERSION}`)
    })
    migrate()
  }
  if (version === 1) {
    const migrate = database.transaction(() => {
      database.exec(`
        CREATE TABLE canonical_v2_sessions (
          logical_session_key TEXT NOT NULL,
          branch_view_id TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          physical_source_id TEXT NOT NULL,
          identity_json TEXT NOT NULL,
          fingerprint_json TEXT NOT NULL,
          complete INTEGER NOT NULL,
          last_chunk_index INTEGER NOT NULL,
          last_cursor TEXT,
          event_count INTEGER NOT NULL,
          tombstoned_at TEXT,
          tombstone_reason TEXT,
          PRIMARY KEY(logical_session_key, branch_view_id)
        );
        CREATE INDEX canonical_v2_sessions_source_idx
          ON canonical_v2_sessions(provider_id, physical_source_id);
        CREATE TABLE canonical_v2_events (
          logical_session_key TEXT NOT NULL,
          branch_view_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          message_block_index INTEGER,
          event_json TEXT NOT NULL,
          PRIMARY KEY(logical_session_key, branch_view_id, event_id),
          UNIQUE(logical_session_key, branch_view_id, sequence),
          FOREIGN KEY(logical_session_key, branch_view_id)
            REFERENCES canonical_v2_sessions(logical_session_key, branch_view_id) ON DELETE CASCADE
        );
        CREATE INDEX canonical_v2_events_page_idx
          ON canonical_v2_events(logical_session_key, branch_view_id, sequence);
      `)
      database.prepare(
        'INSERT INTO canonical_schema_migrations(version, applied_at) VALUES (?, ?)'
      ).run(CANONICAL_STORE_SCHEMA_VERSION, new Date().toISOString())
      database.pragma(`user_version = ${CANONICAL_STORE_SCHEMA_VERSION}`)
    })
    migrate()
  }
}

function sessionRecordFrom(records: CanonicalRecord[], expectedId: string | null): SessionRecord {
  const sessions = records.filter((record): record is SessionRecord => record.recordType === 'session')
  if (sessions.length !== 1 || (expectedId && sessions[0].id !== expectedId)) {
    throw new Error('canonical-session-record-invalid')
  }
  return sessions[0]
}

function ordinalFor(record: CanonicalRecord): number | null {
  return 'ordinal' in record && typeof record.ordinal === 'number' ? record.ordinal : null
}

export class CanonicalSessionStore {
  private readonly database: Database.Database
  private readonly sessions = new Map<string, CanonicalStoredSession>()
  readonly databasePath: string

  constructor(databasePath = canonicalStoreDatabasePath()) {
    this.databasePath = databasePath
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 })
    this.database = new Database(databasePath, { timeout: CANONICAL_STORE_BUSY_TIMEOUT_MS })
    ensureSchema(this.database)
    try { fs.chmodSync(databasePath, 0o600) } catch { /* best effort */ }
    this.reloadMemory()
  }

  schemaVersion(): number {
    return this.database.pragma('user_version', { simple: true }) as number
  }

  listSessions(providerId?: string, options: { includeTombstoned?: boolean } = {}): CanonicalStoredSession[] {
    return [...this.sessions.values()]
      .filter((session) => !providerId || session.sessionRecord.provenance.providerId === providerId)
      .filter((session) => options.includeTombstoned || !session.tombstone)
      .map((session) => structuredClone(session))
  }

  getSession(sessionRecordId: string): CanonicalStoredSession | null {
    const session = this.sessions.get(sessionRecordId)
    return session ? structuredClone(session) : null
  }

  sourceStates(providerId: string, options: { includeTombstoned?: boolean } = {}): CanonicalSourceState[] {
    const rows = this.database.prepare(`
      SELECT source_ref_json, fingerprint_json, tombstoned_at
      FROM canonical_sources
      WHERE provider_id = ?
      ${options.includeTombstoned ? '' : 'AND tombstoned_at IS NULL'}
      ORDER BY source_ref_id
    `).all(providerId) as SourceRow[]
    const sessionIds = this.database.prepare(`
      SELECT session_record_id FROM canonical_sessions
      WHERE provider_id = ? AND source_ref_id = ? AND tombstoned_at IS NULL
      ORDER BY session_record_id
    `)
    return rows.map((row) => {
      const sourceRef = parseJson<SourceRef>(row.source_ref_json)
      return {
        sourceRef,
        fingerprint: parseJson<Fingerprint>(row.fingerprint_json),
        sessionRecordIds: (sessionIds.all(providerId, sourceRef.stableId) as Array<{ session_record_id: string }>)
          .map((entry) => entry.session_record_id),
        tombstonedAt: row.tombstoned_at
      }
    })
  }

  rebindSource(sourceRef: SourceRef): void {
    const current = this.database.prepare(`
      SELECT fingerprint_json FROM canonical_sources
      WHERE provider_id = ? AND source_ref_id = ?
    `).get(sourceRef.providerId, sourceRef.stableId) as { fingerprint_json: string } | undefined
    if (!current) return
    const rebound = { ...sourceRef, fingerprint: parseJson<Fingerprint>(current.fingerprint_json) } as SourceRef
    const update = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE canonical_sources SET source_ref_json = ?, last_seen_at = ?, tombstoned_at = NULL
        WHERE provider_id = ? AND source_ref_id = ?
      `).run(JSON.stringify(rebound), new Date().toISOString(), sourceRef.providerId, sourceRef.stableId)
      const sessionRows = this.database.prepare(`
        SELECT session_record_id, session_json FROM canonical_sessions
        WHERE provider_id = ? AND source_ref_id = ?
      `).all(sourceRef.providerId, sourceRef.stableId) as Array<{ session_record_id: string; session_json: string }>
      for (const row of sessionRows) {
        const session = parseJson<SessionRecord>(row.session_json)
        session.sourceRef = rebound
        const encoded = JSON.stringify(session)
        this.database.prepare(`
          UPDATE canonical_sessions SET session_json = ?
          WHERE session_record_id = ?
        `).run(encoded, row.session_record_id)
        this.database.prepare(`
          UPDATE canonical_records SET record_json = ? WHERE record_id = ?
        `).run(encoded, row.session_record_id)
      }
    })
    update()
    this.reloadMemory()
  }

  applyParseOutcome(outcome: ParseOutcome): void {
    const now = new Date().toISOString()
    const apply = this.database.transaction(() => {
      for (const result of outcome.sessions) {
        if (!result.sessionRecordId || result.records.length === 0) continue
        const sessionRecord = sessionRecordFrom(result.records, result.sessionRecordId)
        if (sessionRecord.provenance.providerId !== outcome.providerId ||
          sessionRecord.sourceRef.providerId !== outcome.providerId ||
          sessionRecord.sourceRef.stableId !== result.sourceRefId) {
          throw new Error('canonical-session-provider-identity-mismatch')
        }
        const sourceRef = { ...sessionRecord.sourceRef, fingerprint: outcome.fingerprint } as SourceRef
        sessionRecord.sourceRef = sourceRef
        this.database.prepare(`
          INSERT INTO canonical_sources(
            provider_id, source_ref_id, source_ref_json, fingerprint_json, last_seen_at, tombstoned_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
          ON CONFLICT(provider_id, source_ref_id) DO UPDATE SET
            source_ref_json = excluded.source_ref_json,
            fingerprint_json = excluded.fingerprint_json,
            last_seen_at = excluded.last_seen_at,
            tombstoned_at = NULL
        `).run(
          outcome.providerId,
          result.sourceRefId,
          JSON.stringify(sourceRef),
          JSON.stringify(outcome.fingerprint),
          now
        )
        this.database.prepare('DELETE FROM canonical_records WHERE session_record_id = ?')
          .run(sessionRecord.id)
        this.database.prepare(`
          INSERT INTO canonical_sessions(
            session_record_id, provider_id, source_ref_id, source_session_id,
            project_path, created_at, updated_at, fingerprint_json, session_json,
            tombstoned_at, tombstone_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          ON CONFLICT(session_record_id) DO UPDATE SET
            provider_id = excluded.provider_id,
            source_ref_id = excluded.source_ref_id,
            source_session_id = excluded.source_session_id,
            project_path = excluded.project_path,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            fingerprint_json = excluded.fingerprint_json,
            session_json = excluded.session_json,
            tombstoned_at = NULL,
            tombstone_reason = NULL
        `).run(
          sessionRecord.id,
          outcome.providerId,
          result.sourceRefId,
          sessionRecord.sourceSessionId,
          sessionRecord.projectPath,
          sessionRecord.createdAt,
          sessionRecord.updatedAt,
          JSON.stringify(outcome.fingerprint),
          JSON.stringify(sessionRecord)
        )
        const insertRecord = this.database.prepare(`
          INSERT INTO canonical_records(record_id, session_record_id, record_type, ordinal, record_json)
          VALUES (?, ?, ?, ?, ?)
        `)
        for (const record of result.records) {
          const storedRecord = record.recordType === 'session' ? sessionRecord : record
          insertRecord.run(
            storedRecord.id,
            sessionRecord.id,
            storedRecord.recordType,
            ordinalFor(storedRecord),
            JSON.stringify(storedRecord)
          )
        }
      }
      for (const tombstone of outcome.tombstones) this.applyTombstoneUnderTransaction(tombstone)
    })
    apply()
    this.reloadMemory()
  }

  applyParseChunkV2(chunk: ParseChunk): void {
    const validation = validateParseChunkV2(chunk)
    if (!validation.ok) {
      throw new Error(`canonical-v2-chunk-schema-invalid:${validation.issues[0]?.message || 'unknown'}`)
    }
    const key = chunk.identity.logicalSessionKey
    const branch = chunk.identity.branchViewId
    const apply = this.database.transaction(() => {
      let current = this.database.prepare(`
        SELECT identity_json, fingerprint_json, complete, last_chunk_index, last_cursor, event_count,
               tombstoned_at, tombstone_reason
        FROM canonical_v2_sessions
        WHERE logical_session_key = ? AND branch_view_id = ?
      `).get(key, branch) as V2SessionRow | undefined

      if (chunk.chunkIndex === 0) {
        if (chunk.previousCursor !== null) throw new Error('canonical-v2-first-chunk-cursor-invalid')
        if (chunk.mode === 'append') {
          if (!current) throw new Error('canonical-v2-append-session-missing')
          this.database.prepare(`
            UPDATE canonical_v2_sessions
            SET fingerprint_json = ?, complete = 0, last_chunk_index = -1, last_cursor = NULL,
                tombstoned_at = NULL, tombstone_reason = NULL
            WHERE logical_session_key = ? AND branch_view_id = ?
          `).run(JSON.stringify(chunk.fingerprint), key, branch)
          current = {
            ...current,
            fingerprint_json: JSON.stringify(chunk.fingerprint),
            complete: 0,
            last_chunk_index: -1,
            last_cursor: null,
            tombstoned_at: null,
            tombstone_reason: null
          }
        } else {
          this.database.prepare(`
            DELETE FROM canonical_v2_sessions
            WHERE logical_session_key = ? AND branch_view_id = ?
          `).run(key, branch)
          this.database.prepare(`
            INSERT INTO canonical_v2_sessions(
              logical_session_key, branch_view_id, provider_id, physical_source_id,
              identity_json, fingerprint_json, complete, last_chunk_index, last_cursor, event_count,
              tombstoned_at, tombstone_reason
            ) VALUES (?, ?, ?, ?, ?, ?, 0, -1, NULL, 0, NULL, NULL)
          `).run(
            key,
            branch,
            chunk.providerId,
            chunk.identity.physicalSourceId,
            JSON.stringify(chunk.identity),
            JSON.stringify(chunk.fingerprint)
          )
          current = {
            identity_json: JSON.stringify(chunk.identity),
            fingerprint_json: JSON.stringify(chunk.fingerprint),
            complete: 0,
            last_chunk_index: -1,
            last_cursor: null,
            event_count: 0,
            tombstoned_at: null,
            tombstone_reason: null
          }
        }
      }
      if (!current) throw new Error('canonical-v2-chunk-session-missing')
      const currentIdentity = parseJson<SessionIdentity>(current.identity_json)
      if (JSON.stringify(currentIdentity) !== JSON.stringify(chunk.identity) ||
        current.fingerprint_json !== JSON.stringify(chunk.fingerprint)) {
        throw new Error('canonical-v2-chunk-identity-mismatch')
      }
      if (current.complete) throw new Error('canonical-v2-chunk-session-complete')
      if (chunk.chunkIndex !== current.last_chunk_index + 1) throw new Error('canonical-v2-chunk-index-mismatch')
      if (chunk.previousCursor !== current.last_cursor) throw new Error('canonical-v2-chunk-cursor-mismatch')
      if (chunk.done === (chunk.cursor !== null)) throw new Error('canonical-v2-chunk-done-cursor-invalid')

      const insertEvent = this.database.prepare(`
        INSERT INTO canonical_v2_events(
          logical_session_key, branch_view_id, event_id, sequence, message_block_index, event_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      let expectedSequence = current.event_count
      for (const event of chunk.events) {
        if (event.sequence !== expectedSequence) throw new Error('canonical-v2-event-sequence-gap')
        if (JSON.stringify(event.identity) !== current.identity_json ||
          event.provenance.providerId !== chunk.providerId ||
          event.provenance.sourceRefId !== chunk.identity.physicalSourceId) {
          throw new Error('canonical-v2-event-identity-mismatch')
        }
        insertEvent.run(
          key,
          branch,
          event.id,
          event.sequence,
          event.messageBlockIndex,
          JSON.stringify(event)
        )
        expectedSequence++
      }
      this.database.prepare(`
        UPDATE canonical_v2_sessions
        SET complete = ?, last_chunk_index = ?, last_cursor = ?, event_count = ?
        WHERE logical_session_key = ? AND branch_view_id = ?
      `).run(chunk.done ? 1 : 0, chunk.chunkIndex, chunk.cursor, expectedSequence, key, branch)
    })
    apply()
  }

  getV2Session(logicalSessionKey: string, branchViewId: string): CanonicalStoredEventSession | null {
    const row = this.database.prepare(`
      SELECT identity_json, fingerprint_json, complete, last_chunk_index, last_cursor, event_count,
             tombstoned_at, tombstone_reason
      FROM canonical_v2_sessions
      WHERE logical_session_key = ? AND branch_view_id = ?
    `).get(logicalSessionKey, branchViewId) as V2SessionRow | undefined
    return row ? {
      identity: parseJson<SessionIdentity>(row.identity_json),
      fingerprint: parseJson<Fingerprint>(row.fingerprint_json),
      complete: row.complete === 1,
      lastChunkIndex: row.last_chunk_index,
      lastCursor: row.last_cursor,
      eventCount: row.event_count,
      tombstonedAt: row.tombstoned_at,
      tombstoneReason: row.tombstone_reason
    } : null
  }

  tombstoneV2Source(
    providerId: string,
    physicalSourceId: string,
    deletedAt: string | null,
    reason: Tombstone['reason']
  ): void {
    this.database.prepare(`
      UPDATE canonical_v2_sessions
      SET tombstoned_at = ?, tombstone_reason = ?
      WHERE provider_id = ? AND physical_source_id = ?
    `).run(deletedAt || new Date().toISOString(), reason, providerId, physicalSourceId)
  }

  hasCompleteV2Source(providerId: string, physicalSourceId: string, expectedSessions: number): boolean {
    if (!Number.isSafeInteger(expectedSessions) || expectedSessions < 0) return false
    const row = this.database.prepare(`
      SELECT count(*) AS count
      FROM canonical_v2_sessions
      WHERE provider_id = ? AND physical_source_id = ? AND complete = 1 AND tombstoned_at IS NULL
    `).get(providerId, physicalSourceId) as { count: number }
    return row.count === expectedSessions
  }

  readV2EventPage(
    logicalSessionKey: string,
    branchViewId: string,
    options: { afterSequence?: number | null; limit?: number } = {}
  ): CanonicalEventPage {
    const limit = Math.min(Math.max(options.limit ?? 512, 1), 4_096)
    const afterSequence = options.afterSequence ?? -1
    const rows = this.database.prepare(`
      SELECT event_json FROM canonical_v2_events
      WHERE logical_session_key = ? AND branch_view_id = ? AND sequence > ?
      ORDER BY sequence
      LIMIT ?
    `).all(logicalSessionKey, branchViewId, afterSequence, limit + 1) as V2EventRow[]
    const hasMore = rows.length > limit
    const pageRows = hasMore ? rows.slice(0, limit) : rows
    const events = pageRows.map((row) => parseJson<CanonicalEvent>(row.event_json))
    return {
      events,
      nextSequence: hasMore ? events.at(-1)?.sequence ?? null : null
    }
  }

  applyTombstone(tombstone: Tombstone): void {
    const apply = this.database.transaction(() => this.applyTombstoneUnderTransaction(tombstone))
    apply()
    this.reloadMemory()
  }

  close(): void {
    this.sessions.clear()
    this.database.close()
  }

  private applyTombstoneUnderTransaction(tombstone: Tombstone): void {
    const deletedAt = tombstone.deletedAt || new Date().toISOString()
    this.database.prepare(`
      UPDATE canonical_sessions
      SET tombstoned_at = ?, tombstone_reason = ?
      WHERE session_record_id = ?
    `).run(deletedAt, tombstone.reason, tombstone.sessionRecordId)
    const owner = this.database.prepare(`
      SELECT provider_id, source_ref_id FROM canonical_sessions WHERE session_record_id = ?
    `).get(tombstone.sessionRecordId) as { provider_id: string; source_ref_id: string } | undefined
    if (owner) {
      if (owner.source_ref_id !== tombstone.sourceRefId) {
        throw new Error('canonical-tombstone-source-mismatch')
      }
      const active = this.database.prepare(`
        SELECT count(*) AS count FROM canonical_sessions
        WHERE provider_id = ? AND source_ref_id = ? AND tombstoned_at IS NULL
      `).get(owner.provider_id, tombstone.sourceRefId) as { count: number }
      if (active.count === 0) {
        this.database.prepare(`
          UPDATE canonical_sources SET tombstoned_at = ?
          WHERE provider_id = ? AND source_ref_id = ?
        `).run(deletedAt, owner.provider_id, tombstone.sourceRefId)
      }
    }
  }

  private reloadMemory(): void {
    this.sessions.clear()
    const rows = this.database.prepare(`
      SELECT session_record_id, fingerprint_json, session_json, tombstoned_at, tombstone_reason
      FROM canonical_sessions
      ORDER BY session_record_id
    `).all() as SessionRow[]
    const recordRows = this.database.prepare(`
      SELECT session_record_id, record_json FROM canonical_records
      ORDER BY session_record_id, CASE WHEN ordinal IS NULL THEN 1 ELSE 0 END, ordinal, record_id
    `).all() as RecordRow[]
    const recordsBySession = new Map<string, CanonicalRecord[]>()
    for (const row of recordRows) {
      const records = recordsBySession.get(row.session_record_id) || []
      records.push(parseJson<CanonicalRecord>(row.record_json))
      recordsBySession.set(row.session_record_id, records)
    }
    for (const row of rows) {
      const sessionRecord = parseJson<SessionRecord>(row.session_json)
      const fingerprint = parseJson<Fingerprint>(row.fingerprint_json)
      this.sessions.set(row.session_record_id, {
        sessionRecord,
        records: recordsBySession.get(row.session_record_id) || [sessionRecord],
        fingerprint,
        tombstone: row.tombstoned_at && row.tombstone_reason
          ? {
              sourceRefId: sessionRecord.sourceRef.stableId,
              sessionRecordId: row.session_record_id,
              deletedAt: row.tombstoned_at,
              reason: row.tombstone_reason,
              previousFingerprint: fingerprint
            }
          : null
      })
    }
  }
}

let defaultStore: CanonicalSessionStore | null = null
let defaultStorePath = ''

export function getCanonicalSessionStore(): CanonicalSessionStore {
  const requestedPath = canonicalStoreDatabasePath()
  if (defaultStore && defaultStorePath === requestedPath) return defaultStore
  defaultStore?.close()
  defaultStore = new CanonicalSessionStore(requestedPath)
  defaultStorePath = requestedPath
  return defaultStore
}

/** Inspect the active runtime store without creating or migrating SQLite. */
export function getLoadedCanonicalSession(sessionRecordId: string): CanonicalStoredSession | null {
  const requestedPath = canonicalStoreDatabasePath()
  if (!defaultStore || defaultStorePath !== requestedPath) return null
  return defaultStore.getSession(sessionRecordId)
}

export function closeCanonicalSessionStore(): void {
  defaultStore?.close()
  defaultStore = null
  defaultStorePath = ''
}
