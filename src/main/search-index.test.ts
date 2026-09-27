/**
 * Search projection version (F1d, scheme A): a legacy row written under an
 * older projection is re-projected as a whole file by its next full sync,
 * never appended to; until then it stays searchable. Canonical rows are
 * untouched. All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import type { CanonicalRecord, SourceRef } from '../shared/provider-schema.generated'
import { parseSessionFile } from './session-loader'
import {
  closeSearchIndex,
  grepTranscripts,
  indexCanonicalSession,
  probeSearchProjection,
  searchDatabasePath,
  searchFTS,
  SEARCH_PROJECTION_VERSION,
  synchronizeSearchSources
} from './search-index'

let root = ''
let priorIndexDir: string | undefined

beforeEach(() => {
  closeSearchIndex()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-projection-'))
  priorIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'index')
})

afterEach(() => {
  closeSearchIndex()
  vi.restoreAllMocks()
  if (priorIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = priorIndexDir
  fs.rmSync(root, { recursive: true, force: true })
})

const PREFIX = `p${SEARCH_PROJECTION_VERSION}|`

function message(uuid: string, type: 'user' | 'assistant', text: string, sessionId = 'projection-session'): object {
  return {
    uuid,
    parentUuid: null,
    sessionId,
    type,
    timestamp: '2026-09-27T00:00:00.000Z',
    message: { role: type, content: text }
  }
}

function writeJsonl(name: string, rows: object[]): string {
  const filePath = path.join(root, 'sources', name)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n'))
  return filePath
}

/** A separate connection, as an older build left the index. */
function withIndex<T>(run: (db: Database.Database) => T): T {
  const db = new Database(searchDatabasePath())
  try {
    return run(db)
  } finally {
    db.close()
  }
}

/**
 * Turn a file's rows into what an earlier projection wrote: the bare
 * `mtime:size` signature and, for a pre-F1a reader, fewer records counted and
 * the U+2028 record's row missing.
 */
function toEarlierProjection(filePath: string, lost?: { rawCount: number; token: string }): void {
  withIndex((db) => {
    const row = db.prepare('SELECT file_signature, indexed_raw_count FROM sessions WHERE file_path = ?')
      .get(filePath) as { file_signature: string; indexed_raw_count: number }
    db.prepare('UPDATE sessions SET file_signature = ?, indexed_raw_count = ? WHERE file_path = ?')
      .run(row.file_signature.replace(/^p\d+\|/, ''), lost?.rawCount ?? row.indexed_raw_count, filePath)
    if (lost) {
      db.prepare(`
        DELETE FROM messages_fts WHERE rowid IN (
          SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND file_path = ?
        )
      `).run(`"${lost.token}"`, filePath)
    }
  })
}

const ftsRowsOf = (filePath: string): number => withIndex((db) =>
  (db.prepare('SELECT count(*) AS count FROM messages_fts WHERE file_path = ?').get(filePath) as { count: number }).count)

const signatureOf = (filePath: string): string => withIndex((db) =>
  (db.prepare('SELECT file_signature FROM sessions WHERE file_path = ?').get(filePath) as { file_signature: string })
    .file_signature)

function canonicalRecords(text: string): CanonicalRecord[] {
  const sourceRef: SourceRef = {
    kind: 'file',
    providerId: 'swob/pi',
    stableId: 'pi:f1d-projection',
    uri: 'file:///synthetic/pi-f1d.jsonl',
    displayLocator: 'ssh://example.invalid/sessions/pi-f1d.jsonl',
    fingerprint: { algorithm: 'sha256', value: 'synthetic-canonical-fingerprint' }
  }
  const provenance = {
    providerId: 'swob/pi',
    sourceRefId: sourceRef.stableId,
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    observedAt: '2026-09-27T00:00:00.000Z'
  }
  return [
    {
      id: 'f1d-canonical-session-record',
      recordType: 'session',
      sourceRef,
      sourceSessionId: 'f1d-canonical-session',
      createdAt: '2026-09-27T00:00:00.000Z',
      updatedAt: '2026-09-27T00:01:00.000Z',
      cwd: ['/synthetic/projection-project'],
      projectPath: '/synthetic/projection-project',
      providerTitle: null,
      provenance
    },
    {
      id: 'f1d-canonical-message',
      recordType: 'message',
      sessionRecordId: 'f1d-canonical-session-record',
      ordinal: 0,
      role: 'user',
      timestamp: '2026-09-27T00:00:01.000Z',
      content: [{ kind: 'text', text }],
      provenance
    }
  ]
}

describe('search projection version (F1d)', () => {
  it('an earlier projection of a growing file is re-projected whole: no duplicate row, and the record the old reader lost is found', async () => {
    const filePath = writeJsonl('growing.jsonl', [
      message('u1', 'user', 'alphaopening question'),
      // A raw U+2028 inside the JSON string: the reader before F1a split the line there and lost the record.
      message('a1', 'assistant', 'lineseparatorrecovered tailbravo'),
      message('u2', 'user', 'charlieprobe follow up')
    ])
    await synchronizeSearchSources([{ filePath }])
    expect(searchFTS('lineseparatorrecovered')).toHaveLength(1)

    toEarlierProjection(filePath, { rawCount: 2, token: 'lineseparatorrecovered' })
    expect(searchFTS('lineseparatorrecovered')).toHaveLength(0)
    fs.appendFileSync(filePath, '\n' + JSON.stringify(message('a2', 'assistant', 'deltaappended answer')))

    await synchronizeSearchSources([{ filePath }])
    expect(ftsRowsOf(filePath)).toBe(4)
    expect(grepTranscripts('charlieprobe')[0].matches).toHaveLength(1)
    expect(searchFTS('lineseparatorrecovered')).toHaveLength(1)
    expect(searchFTS('deltaappended')).toHaveLength(1)
    expect(signatureOf(filePath).startsWith(PREFIX)).toBe(true)
  })

  it('a file growing under the current projection is still appended to, not re-projected', async () => {
    const filePath = writeJsonl('append.jsonl', [message('u1', 'user', 'appendbase question')])
    await synchronizeSearchSources([{ filePath }])
    const firstRowid = withIndex((db) =>
      (db.prepare('SELECT min(rowid) AS rowid FROM messages_fts WHERE file_path = ?').get(filePath) as { rowid: number }).rowid)
    fs.appendFileSync(filePath, '\n' + JSON.stringify(message('a1', 'assistant', 'appendtail answer')))

    await synchronizeSearchSources([{ filePath }])
    expect(ftsRowsOf(filePath)).toBe(2)
    // The first row was kept, not deleted and written again.
    expect(withIndex((db) =>
      (db.prepare('SELECT min(rowid) AS rowid FROM messages_fts WHERE file_path = ?').get(filePath) as { rowid: number }).rowid))
      .toBe(firstRowid)
  })

  it('rows of an earlier projection stay searchable until their own file is re-projected', async () => {
    const names = ['oneproj', 'twoproj', 'threeproj']
    const files = names.map((name) => writeJsonl(`${name}.jsonl`, [message(`${name}-u`, 'user', `${name} marker`, name)]))
    await synchronizeSearchSources(files.map((filePath) => ({ filePath })))
    for (const filePath of files) toEarlierProjection(filePath)
    expect(probeSearchProjection()).toEqual({ legacyRows: 3, staleLegacyRows: 3 })
    for (const name of names) expect(searchFTS(name)).toHaveLength(1)

    // A pass that got through the first file only.
    await synchronizeSearchSources([{ filePath: files[0] }], { prune: false })
    expect(probeSearchProjection()).toEqual({ legacyRows: 3, staleLegacyRows: 2 })
    for (const name of names) expect(searchFTS(name)).toHaveLength(1)

    await synchronizeSearchSources(files.map((filePath) => ({ filePath })))
    expect(probeSearchProjection()).toEqual({ legacyRows: 3, staleLegacyRows: 0 })
    for (const [index, name] of names.entries()) {
      expect(searchFTS(name)).toHaveLength(1)
      expect(ftsRowsOf(files[index])).toBe(1)
    }
  })

  it('a pass cancelled half way keeps what it re-projected, and the next pass reads only the rest', async () => {
    const files = ['c1', 'c2', 'c3', 'c4'].map((name) =>
      writeJsonl(`${name}.jsonl`, [message(`${name}-u`, 'user', `cancel${name} marker`, name)]))
    await synchronizeSearchSources(files.map((filePath) => ({ filePath })))
    for (const filePath of files) toEarlierProjection(filePath)
    let loads = 0
    const counted = (filePath: string) => ({
      filePath,
      loadRaw: () => {
        loads++
        return parseSessionFile(filePath)
      }
    })

    await expect(synchronizeSearchSources(files.map(counted), { shouldCancel: () => loads >= 3 }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(probeSearchProjection()).toEqual({ legacyRows: 4, staleLegacyRows: 2 })
    for (const name of ['c1', 'c2', 'c3', 'c4']) expect(searchFTS(`cancel${name}`)).toHaveLength(1)

    loads = 0
    await synchronizeSearchSources(files.map(counted))
    expect(loads).toBe(2)
    expect(probeSearchProjection()).toEqual({ legacyRows: 4, staleLegacyRows: 0 })
  })

  it('canonical rows keep their fingerprint signature and rows through a full re-projection', async () => {
    await indexCanonicalSession('f1d-canonical-session', canonicalRecords('canonicalkeptmarker'))
    const legacy = writeJsonl('legacy.jsonl', [message('u1', 'user', 'legacyreprojected marker')])
    await synchronizeSearchSources([{ filePath: legacy }])
    toEarlierProjection(legacy)
    const canonicalState = () => withIndex((db) => ({
      row: db.prepare("SELECT * FROM sessions WHERE projection_kind = 'canonical'").all(),
      fts: db.prepare("SELECT rowid, * FROM messages_fts WHERE file_path LIKE 'canonical:%' ORDER BY rowid").all()
    }))
    const before = canonicalState()
    expect(before.row).toHaveLength(1)
    expect(probeSearchProjection()).toEqual({ legacyRows: 1, staleLegacyRows: 1 })

    await synchronizeSearchSources([{ filePath: legacy }])
    expect(canonicalState()).toEqual(before)
    expect(searchFTS('canonicalkeptmarker')).toHaveLength(1)
    expect(searchFTS('legacyreprojected')).toHaveLength(1)
    expect(probeSearchProjection()).toEqual({ legacyRows: 1, staleLegacyRows: 0 })
  })

  it('a full pass that re-projects files logs progress every 100 files and when done; a hot or a live pass stays silent', async () => {
    const files = Array.from({ length: 150 }, (_, index) =>
      writeJsonl(`progress-${index}.jsonl`, [message(`p${index}`, 'user', `progressmarker${index}`, `progress-${index}`)]))
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const progressLines = () => info.mock.calls.map((call) => String(call[0])).filter((line) => line.startsWith('[search-index]'))

    await synchronizeSearchSources(files.map((filePath) => ({ filePath })))
    expect(progressLines()).toEqual([
      expect.stringMatching(/^\[search-index\] full sync: processed 100\/150 files, replaced 100, \d+\.\ds$/),
      expect.stringMatching(/^\[search-index\] full sync done: processed 150\/150 files, replaced 150, \d+\.\ds$/)
    ])

    info.mockClear()
    await synchronizeSearchSources(files.map((filePath) => ({ filePath })))
    fs.appendFileSync(files[0], '\n' + JSON.stringify(message('p0-a', 'assistant', 'liveupdate answer', 'progress-0')))
    await synchronizeSearchSources([{ filePath: files[0] }], { prune: false })
    expect(progressLines()).toEqual([])
    expect(searchFTS('liveupdate')).toHaveLength(1)
  })

  it('probeSearchProjection is null without an index and never creates one', async () => {
    expect(probeSearchProjection()).toBeNull()
    expect(fs.existsSync(searchDatabasePath())).toBe(false)

    const filePath = writeJsonl('probe.jsonl', [message('u1', 'user', 'probemarker')])
    await synchronizeSearchSources([{ filePath }])
    expect(probeSearchProjection()).toEqual({ legacyRows: 1, staleLegacyRows: 0 })
    toEarlierProjection(filePath)
    expect(probeSearchProjection()).toEqual({ legacyRows: 1, staleLegacyRows: 1 })
  })
})
