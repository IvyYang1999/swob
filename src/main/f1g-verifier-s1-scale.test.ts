import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildSessionSummary, buildSessionSummaryFromBackup, parseSessionFile, type SessionLoadEvidence } from './session-loader'
import { closeUsageFactStore, synchronizeUsageFacts, type UsageFactAbsenceEvidence } from './usage-fact-store'
import type { SessionSummary } from './types'

// Verifier-only (not committed): F1f acceptance S1/G3 at the real scale of its
// claude-code shape (59 physical, 1,228 Library-only), synthetic data only.
const PHYSICAL = 59
const LIBRARY_ONLY = 1228
let root = ''
const saved = new Map<string, string | undefined>()

function transcript(filePath: string, sessionId: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    { uuid: `${sessionId}-u`, parentUuid: null, sessionId, type: 'user', promptSource: 'typed',
      timestamp: '2026-08-04T00:00:00.000Z', cwd: '/fixtures/s1', message: { role: 'user', content: 'p' } },
    { uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, sessionId, type: 'assistant', requestId: `${sessionId}-r`,
      timestamp: '2026-08-04T00:00:01.000Z', cwd: '/fixtures/s1',
      message: { id: `${sessionId}-m`, role: 'assistant', model: 'claude-sonnet-4-5', content: 'a', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 } } }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
}

async function physical(id: string): Promise<SessionSummary> {
  const file = path.join(root, 'home', '.claude', 'projects', '-s1', `${id}.jsonl`)
  transcript(file, id)
  return buildSessionSummary(file, await parseSessionFile(file))!
}

async function libraryOnly(id: string): Promise<SessionSummary> {
  const backup = path.join(root, 'Library', id, 'backup.jsonl')
  transcript(backup, id)
  return (await buildSessionSummaryFromBackup(backup, id, {
    sourceFilePaths: [path.join(root, 'home', '.claude', 'projects', '-s1', `${id}.jsonl`)]
  }))!
}

const evidence = (loadId: string): UsageFactAbsenceEvidence => ({
  physicalLoad: { loadId, summaryCache: 'warm', sqliteSources: {} } as SessionLoadEvidence,
  providerSettlement: null,
  excludedSources: []
})
const withheld: UsageFactAbsenceEvidence = { physicalLoad: null, providerSettlement: null, excludedSources: [] }

function rows(): number {
  const db = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true, fileMustExist: true })
  try { return (db.prepare('SELECT count(*) AS n FROM usage_sessions').get() as { n: number }).n } finally { db.close() }
}

let phys: SessionSummary[] = []
let lib: SessionSummary[] = []

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1gv-s1-'))
  for (const name of ['SWOB_USAGE_REMOVAL_MAX_RATIO', 'SWOB_USAGE_REMOVAL_MAX_COUNT', 'SWOB_USAGE_REMOVAL_MIN_COUNT', 'SWOB_USAGE_INDEX_PATH']) {
    saved.set(name, process.env[name]); if (name !== 'SWOB_USAGE_INDEX_PATH') delete process.env[name]
  }
  phys = await Promise.all(Array.from({ length: PHYSICAL }, (_, i) => physical(`p-${String(i).padStart(4, '0')}`)))
  lib = await Promise.all(Array.from({ length: LIBRARY_ONLY }, (_, i) => libraryOnly(`l-${String(i).padStart(4, '0')}`)))
}, 120_000)

afterAll(() => {
  closeUsageFactStore()
  for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  fs.rmSync(root, { recursive: true, force: true })
})

function freshLedger(label: string): void {
  closeUsageFactStore()
  process.env.SWOB_USAGE_INDEX_PATH = path.join(root, `${label}.db`)
  const seeded = synchronizeUsageFacts([...phys, ...lib], [], { absence: evidence(`${label}-seed`) })
  expect(seeded.removedSessions).toBe(0)
  expect(rows()).toBe(PHYSICAL + LIBRARY_ONLY)
}

describe('F1f S1/G3 shape at real scale (claude-code 59 + 1,228)', () => {
  it('pre-F1g input: first window holds 1,228, the second independent load confirms their deletion', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    freshLedger('master')
    const w1 = synchronizeUsageFacts(phys, [], { absence: evidence('load-2') })
    const w2 = synchronizeUsageFacts(phys, [], { absence: evidence('load-3') })
    console.log(`[s1-scale] master w1 removed=${w1.removedSessions} held=${w1.heldRemovals} retained=${w1.retainedSessions} | w2 removed=${w2.removedSessions} held=${w2.heldRemovals} | rows=${rows()}`)
    expect(w1).toMatchObject({ removedSessions: 0, heldRemovals: LIBRARY_ONLY })
    expect(w2).toMatchObject({ removedSessions: LIBRARY_ONLY })
    expect(rows()).toBe(PHYSICAL)
  }, 120_000)

  it('F1g input, first window of the process (nothing hydrated yet): evidence withheld, nothing removed or held', () => {
    freshLedger('f1g-first')
    const w1 = synchronizeUsageFacts(phys, [], { absence: withheld })
    const w2 = synchronizeUsageFacts(phys, [], { absence: withheld })
    console.log(`[s1-scale] f1g-first w1 removed=${w1.removedSessions} held=${w1.heldRemovals} retained=${w1.retainedSessions} | w2 removed=${w2.removedSessions} held=${w2.heldRemovals} retained=${w2.retainedSessions} | rows=${rows()}`)
    expect(w1).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: LIBRARY_ONLY })
    expect(w2).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: LIBRARY_ONLY })
    // Hydrated: the first sync with evidence finds them present again.
    const after = synchronizeUsageFacts([...phys, ...lib], [], { absence: evidence('load-4') })
    console.log(`[s1-scale] f1g-first after removed=${after.removedSessions} held=${after.heldRemovals} retained=${after.retainedSessions} unchanged=${after.unchangedSessions} | rows=${rows()}`)
    expect(after).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0 })
    expect(rows()).toBe(PHYSICAL + LIBRARY_ONLY)
  }, 120_000)

  it('F1g input, a later window (hydrated before): the carried subset keeps them present', () => {
    freshLedger('f1g-later')
    const w1 = synchronizeUsageFacts([...phys, ...lib], [], { absence: withheld })
    const w2 = synchronizeUsageFacts([...phys, ...lib], [], { absence: withheld })
    console.log(`[s1-scale] f1g-later w1 removed=${w1.removedSessions} held=${w1.heldRemovals} retained=${w1.retainedSessions} | w2 removed=${w2.removedSessions} held=${w2.heldRemovals} retained=${w2.retainedSessions} | rows=${rows()}`)
    expect(w1).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0 })
    expect(w2).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0 })
    expect(rows()).toBe(PHYSICAL + LIBRARY_ONLY)
  }, 120_000)
})
