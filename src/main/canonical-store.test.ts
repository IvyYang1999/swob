import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import type {
  CanonicalRecord,
  FileSourceRef,
  Fingerprint,
  ParseOutcome,
  SourceRef
} from '../shared/provider-schema.generated'
import {
  CANONICAL_STORE_SCHEMA_VERSION,
  CanonicalSessionStore
} from './canonical-store'

const temporaryRoots: string[] = []

function fingerprint(value: string): Fingerprint {
  return { algorithm: 'sha256', value }
}

function source(displayLocator: string, value = 'first'): FileSourceRef {
  return {
    kind: 'file',
    providerId: 'swob/pi',
    stableId: 'pi:fanout-source',
    uri: `file://${displayLocator}`,
    displayLocator,
    fingerprint: fingerprint(value)
  }
}

function records(sessionId: string, sourceRef: SourceRef, text: string): CanonicalRecord[] {
  const provenance = {
    providerId: 'swob/pi',
    sourceRefId: sourceRef.stableId,
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    observedAt: '2026-07-23T00:00:00.000Z'
  }
  return [
    {
      id: `record:session:${sessionId}`,
      recordType: 'session',
      sourceRef,
      sourceSessionId: sessionId,
      createdAt: '2026-07-23T00:00:00.000Z',
      updatedAt: '2026-07-23T00:01:00.000Z',
      cwd: ['/synthetic/project'],
      projectPath: '/synthetic/project',
      providerTitle: null,
      provenance
    },
    {
      id: `record:message:${sessionId}`,
      recordType: 'message',
      sessionRecordId: `record:session:${sessionId}`,
      ordinal: 0,
      role: 'user',
      timestamp: '2026-07-23T00:00:01.000Z',
      content: [{ kind: 'text', text }],
      provenance
    }
  ]
}

function outcome(
  sourceRef: SourceRef,
  sessionRecords: Array<{ sessionId: string; text: string }>,
  status: ParseOutcome['status'] = 'complete'
): ParseOutcome {
  return {
    providerId: 'swob/pi',
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    fingerprint: sourceRef.fingerprint,
    status,
    sessions: sessionRecords.map(({ sessionId, text }) => {
      const canonical = records(sessionId, sourceRef, text)
      return {
        sourceRefId: sourceRef.stableId,
        sessionRecordId: canonical[0].id,
        status,
        records: canonical,
        errors: [],
        replaceSessionRecordId: status === 'replace' ? canonical[0].id : null,
        noDataReason: null
      }
    }),
    errors: [],
    tombstones: []
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('CanonicalSessionStore', () => {
  it('recovers an interrupted version-0 migration atomically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-migration-'))
    temporaryRoots.push(root)
    const databasePath = path.join(root, 'canonical.db')
    const interrupted = new Database(databasePath)
    interrupted.exec('CREATE TABLE canonical_sources(partial TEXT)')
    interrupted.close()

    const recovered = new CanonicalSessionStore(databasePath)
    expect(recovered.schemaVersion()).toBe(CANONICAL_STORE_SCHEMA_VERSION)
    expect(recovered.listSessions()).toHaveLength(0)
    recovered.close()
  })

  it('migrates an existing v1 database by adding v2 event tables without rewriting v1 records', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-v1-to-v2-'))
    temporaryRoots.push(root)
    const databasePath = path.join(root, 'canonical.db')
    const legacy = new Database(databasePath)
    legacy.exec(`
      CREATE TABLE canonical_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO canonical_schema_migrations VALUES (1, '2026-07-23T00:00:00.000Z');
      CREATE TABLE canonical_sources(
        provider_id TEXT, source_ref_id TEXT, source_ref_json TEXT, fingerprint_json TEXT,
        last_seen_at TEXT, tombstoned_at TEXT
      );
      CREATE TABLE canonical_sessions(
        session_record_id TEXT, provider_id TEXT, source_ref_id TEXT, source_session_id TEXT,
        project_path TEXT, created_at TEXT, updated_at TEXT, fingerprint_json TEXT,
        session_json TEXT, tombstoned_at TEXT, tombstone_reason TEXT
      );
      CREATE TABLE canonical_records(
        record_id TEXT, session_record_id TEXT, record_type TEXT, ordinal INTEGER, record_json TEXT
      );
      PRAGMA user_version = 1;
    `)
    legacy.close()

    const migrated = new CanonicalSessionStore(databasePath)
    expect(migrated.schemaVersion()).toBe(2)
    const inspection = new Database(databasePath, { readonly: true })
    expect(inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('canonical_sessions', 'canonical_v2_sessions', 'canonical_v2_events')
      ORDER BY name
    `).all()).toEqual([
      { name: 'canonical_sessions' },
      { name: 'canonical_v2_events' },
      { name: 'canonical_v2_sessions' }
    ])
    inspection.close()
    migrated.close()
  })

  it('persists versioned canonical records and atomically replaces a session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-store-'))
    temporaryRoots.push(root)
    const databasePath = path.join(root, 'canonical.db')
    const firstSource = source('/synthetic/original.jsonl')
    const first = new CanonicalSessionStore(databasePath)
    expect(first.schemaVersion()).toBe(CANONICAL_STORE_SCHEMA_VERSION)
    first.applyParseOutcome(outcome(firstSource, [{ sessionId: 'one', text: 'old-only-text' }]))
    first.close()

    const reopened = new CanonicalSessionStore(databasePath)
    expect(reopened.listSessions()).toHaveLength(1)
    const changedSource = source('/synthetic/original.jsonl', 'second')
    reopened.applyParseOutcome(outcome(
      changedSource,
      [{ sessionId: 'one', text: 'new-only-text' }],
      'replace'
    ))
    const stored = reopened.getSession('record:session:one')!
    expect(JSON.stringify(stored.records)).toContain('new-only-text')
    expect(JSON.stringify(stored.records)).not.toContain('old-only-text')
    expect(stored.fingerprint.value).toBe('second')
    reopened.close()
  })

  it('rebinds a moved source without changing identity or duplicating fan-out sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-rebind-'))
    temporaryRoots.push(root)
    const store = new CanonicalSessionStore(path.join(root, 'canonical.db'))
    const original = source('/synthetic/original.jsonl')
    store.applyParseOutcome(outcome(original, [
      { sessionId: 'one', text: 'first' },
      { sessionId: 'two', text: 'second' }
    ]))
    const moved = source('/remote/host/moved.jsonl')
    moved.uri = 'ssh://example.invalid/remote/host/moved.jsonl'
    moved.displayLocator = 'ssh://example.invalid/remote/host/moved.jsonl'
    store.rebindSource(moved)

    expect(store.listSessions()).toHaveLength(2)
    expect(store.sourceStates('swob/pi')).toHaveLength(1)
    expect(store.getSession('record:session:one')?.sessionRecord.sourceRef.displayLocator)
      .toBe('ssh://example.invalid/remote/host/moved.jsonl')
    store.close()
  })

  it('tombstones one fan-out session without tombstoning a source that still has active sessions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-tombstone-'))
    temporaryRoots.push(root)
    const store = new CanonicalSessionStore(path.join(root, 'canonical.db'))
    const sourceRef = source('/synthetic/fanout.jsonl')
    store.applyParseOutcome(outcome(sourceRef, [
      { sessionId: 'one', text: 'first' },
      { sessionId: 'two', text: 'second' }
    ]))
    store.applyTombstone({
      sourceRefId: sourceRef.stableId,
      sessionRecordId: 'record:session:one',
      deletedAt: '2026-07-23T01:00:00.000Z',
      reason: 'provider-deleted',
      previousFingerprint: sourceRef.fingerprint
    })

    expect(store.listSessions()).toHaveLength(1)
    expect(store.listSessions(undefined, { includeTombstoned: true })).toHaveLength(2)
    expect(store.sourceStates('swob/pi')).toHaveLength(1)
    store.rebindSource(source('/synthetic/moved-fanout.jsonl'))
    expect(store.listSessions()).toHaveLength(1)
    expect(store.getSession('record:session:one')?.tombstone).not.toBeNull()
    store.close()
  })
})
