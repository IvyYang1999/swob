import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildSessionSummary,
  buildSessionSummaryFromBackup,
  parseSessionFile,
  type SessionLoadEvidence
} from './session-loader'
import {
  closeUsageFactStore,
  synchronizeUsageFacts,
  type UsageFactAbsenceEvidence
} from './usage-fact-store'
import type { SessionSummary } from './types'

/**
 * F1g ledger contract: the real usage ledger, fed what the desktop hands it
 * around a Library hydration. vitest cannot import index.ts (it registers
 * ipcMain and app at the top level), so that wiring is pinned by text in
 * library-live-sync.architecture.test.ts and driven end to end by
 * e2e/f1g-hydration-window.spec.ts. These pins hold the ledger to what the
 * wiring relies on; they pass on the F1f ledger as it stands, so they are a
 * contract, not the reverse check of the fix.
 */

const GATE_ENV = ['SWOB_USAGE_REMOVAL_MAX_RATIO', 'SWOB_USAGE_REMOVAL_MAX_COUNT', 'SWOB_USAGE_REMOVAL_MIN_COUNT']
const savedEnv = new Map<string, string | undefined>()
let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1g-ledger-'))
  for (const name of [...GATE_ENV, 'SWOB_USAGE_INDEX_PATH']) savedEnv.set(name, process.env[name])
  for (const name of GATE_ENV) delete process.env[name]
  process.env.SWOB_USAGE_INDEX_PATH = path.join(root, 'usage-facts.db')
  closeUsageFactStore()
})

afterEach(() => {
  closeUsageFactStore()
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  savedEnv.clear()
  fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function claudeSourcePath(sessionId: string): string {
  return path.join(root, 'home', '.claude', 'projects', '-f1g-fixture', `${sessionId}.jsonl`)
}

function writeClaudeTranscript(filePath: string, sessionId: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const rows = [
    {
      uuid: `${sessionId}-u`, parentUuid: null, sessionId, type: 'user', promptSource: 'typed',
      timestamp: '2026-08-04T00:00:00.000Z', cwd: '/fixtures/f1g',
      message: { role: 'user', content: `${sessionId} prompt` }
    },
    {
      uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, sessionId, type: 'assistant',
      requestId: `${sessionId}-request`, timestamp: '2026-08-04T00:00:01.000Z', cwd: '/fixtures/f1g',
      message: {
        id: `${sessionId}-message`, role: 'assistant', model: 'claude-sonnet-4-5', content: 'answer',
        stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }
      }
    }
  ]
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/** A session whose source file the physical load reads. */
async function physicalSession(sessionId: string): Promise<SessionSummary> {
  const filePath = claudeSourcePath(sessionId)
  writeClaudeTranscript(filePath, sessionId)
  const summary = buildSessionSummary(filePath, await parseSessionFile(filePath))
  if (!summary) throw new Error(`fixture ${sessionId} did not parse`)
  return summary
}

/** A Library-only session: its source is gone, hydration Phase 2b parses the backup. */
async function libraryOnlySession(sessionId: string): Promise<SessionSummary> {
  const backupPath = path.join(root, 'Library', sessionId, 'backup.jsonl')
  writeClaudeTranscript(backupPath, sessionId)
  const summary = await buildSessionSummaryFromBackup(backupPath, sessionId, {
    sourceFilePaths: [claudeSourcePath(sessionId)]
  })
  if (!summary) throw new Error(`fixture ${sessionId} did not parse`)
  return summary
}

async function sessions(prefix: string, count: number, make: (id: string) => Promise<SessionSummary>): Promise<SessionSummary[]> {
  return Promise.all(Array.from({ length: count }, (_, index) => make(`${prefix}-${index + 1}`)))
}

function evidence(loadId: string): UsageFactAbsenceEvidence {
  const physicalLoad: SessionLoadEvidence = { loadId, summaryCache: 'warm', sqliteSources: {} }
  return { physicalLoad, providerSettlement: 'complete', excludedSources: [] }
}

/** What the desktop hands over from a whole replacement until that epoch has hydrated. */
const beforeHydration: UsageFactAbsenceEvidence = { physicalLoad: null, providerSettlement: null, excludedSources: [] }

function ledger(): { sessions: string[]; history: number } {
  const audit = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true, fileMustExist: true })
  try {
    return {
      sessions: (audit.prepare('SELECT session_id FROM usage_sessions ORDER BY session_id').all() as
        Array<{ session_id: string }>).map((row) => row.session_id),
      history: (audit.prepare('SELECT count(*) AS count FROM usage_valuation_history').get() as { count: number }).count
    }
  } finally {
    audit.close()
  }
}

describe('the usage ledger around a Library hydration (F1g contract)', () => {
  it('keeps a Library-only row through two pre-hydration loads, then finds it present again', async () => {
    // G1's shape: one Library-only session beside five physical ones, default gate.
    const physical = await sessions('physical', 5, physicalSession)
    const libraryOnly = await libraryOnlySession('library-only')
    expect(synchronizeUsageFacts([...physical, libraryOnly], [], { absence: evidence('load-1') }))
      .toMatchObject({ changedSessions: 6, removedSessions: 0 })
    const before = ledger()
    expect(before.sessions).toHaveLength(6)

    // Two independent loads, each synced before hydration Phase 2b: no evidence either time.
    for (let load = 0; load < 2; load++) {
      expect(synchronizeUsageFacts(physical, [], { absence: beforeHydration })).toMatchObject({
        removedSessions: 0,
        heldRemovals: 0,
        retainedSessions: 1,
        absences: [{ source: 'claude-code', reason: 'awaiting-first-load', sessions: 1 }]
      })
    }
    expect(ledger()).toEqual(before)

    // The epoch has hydrated: the session is back in the input, with evidence.
    expect(synchronizeUsageFacts([...physical, libraryOnly], [], { absence: evidence('load-3') })).toMatchObject({
      changedSessions: 0,
      unchangedSessions: 6,
      removedSessions: 0,
      retainedSessions: 0,
      heldRemovals: 0,
      absences: []
    })
    expect(ledger()).toEqual(before)
  })

  it('keeps an earlier hold through a pre-hydration round without confirming it; the hydrated input releases it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.SWOB_USAGE_REMOVAL_MAX_COUNT = '2'
    process.env.SWOB_USAGE_REMOVAL_MIN_COUNT = '1'
    const physical = await sessions('physical', 4, physicalSession)
    const libraryOnly = await sessions('library-only', 3, libraryOnlySession)
    synchronizeUsageFacts([...physical, ...libraryOnly], [], { absence: evidence('load-1') })
    const before = ledger()

    // A hold that an evidence round placed (three missing, over the count).
    expect(synchronizeUsageFacts(physical, [], { absence: evidence('load-2') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 3 })
    // A later load synced before hydration keeps the hold but cannot confirm it.
    expect(synchronizeUsageFacts(physical, [], { absence: beforeHydration }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 3 })
    expect(ledger()).toEqual(before)

    // Hydrated: the sessions are present, so the hold is gone. The next
    // absence starts a new hold instead of confirming the old one.
    expect(synchronizeUsageFacts([...physical, ...libraryOnly], [], { absence: evidence('load-3') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0 })
    expect(synchronizeUsageFacts(physical, [], { absence: evidence('load-4') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 3 })
    expect(ledger()).toEqual(before)
  })

  it('still removes a really deleted Library-only session in the first round with evidence after hydration', async () => {
    const physical = await sessions('physical', 5, physicalSession)
    const kept = await libraryOnlySession('library-kept')
    const deleted = await libraryOnlySession('library-deleted')
    synchronizeUsageFacts([...physical, kept, deleted], [], { absence: evidence('load-1') })
    const before = ledger()

    // Its package went away inside the window: deferred, not lost.
    expect(synchronizeUsageFacts([...physical, kept], [], { absence: beforeHydration }))
      .toMatchObject({ removedSessions: 0, retainedSessions: 1 })
    expect(ledger()).toEqual(before)

    expect(synchronizeUsageFacts([...physical, kept], [], { absence: evidence('load-2') }))
      .toMatchObject({ removedSessions: 1, retainedSessions: 0, heldRemovals: 0 })
    const after = ledger()
    expect(after.sessions).toEqual(before.sessions.filter((sessionId) => sessionId !== 'library-deleted'))
    expect(after.history).toBe(before.history)
  })

  it('is what the window must never hand over: evidence without the Library-only sessions (G1, G3)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // G1: below the minimum count, one round with evidence deletes at once.
    const physical = await sessions('physical', 5, physicalSession)
    const single = await libraryOnlySession('library-single')
    synchronizeUsageFacts([...physical, single], [], { absence: evidence('load-1') })
    expect(synchronizeUsageFacts(physical, [], { absence: evidence('load-2') }))
      .toMatchObject({ removedSessions: 1, heldRemovals: 0 })

    // G3: over the gate, held once, then confirmed by the next independent load.
    process.env.SWOB_USAGE_REMOVAL_MAX_COUNT = '2'
    process.env.SWOB_USAGE_REMOVAL_MIN_COUNT = '1'
    const libraryOnly = await sessions('library-only', 3, libraryOnlySession)
    synchronizeUsageFacts([...physical, ...libraryOnly], [], { absence: evidence('load-3') })
    expect(synchronizeUsageFacts(physical, [], { absence: evidence('load-4') }))
      .toMatchObject({ removedSessions: 0, heldRemovals: 3 })
    expect(synchronizeUsageFacts(physical, [], { absence: evidence('load-5') }))
      .toMatchObject({ removedSessions: 3, heldRemovals: 0 })
    expect(ledger().sessions).toEqual(physical.map((session) => session.sessionId).sort())
  })
})
