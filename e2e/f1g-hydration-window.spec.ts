import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv } from './helpers'

/**
 * F1g: a whole replacement of cachedSessions (here a second sessions:loadAll,
 * exactly what the Agent window's History does) leaves every Library-only
 * session out until the next hydration adds it back. Usage syncs in that
 * window must neither remove nor confirm the removal of their ledger rows;
 * the first sync after the hydration completes judges normally again.
 *
 * SWOB_TEST_LIBRARY_HYDRATION_HOLD (test only, inside SWOB_TEST_HOME) holds
 * every hydration before Phase 2b while the file exists, so the window is
 * deterministic. rebuildInsightsFacts() forces a sync in the window: in the
 * wild a real-time change makes a later sync's revision differ; the forced
 * rebuild only skips that revision dedupe. resume/fork are never called.
 */

interface Fixture {
  home: string
  libraryRoot: string
  holdPath: string
  ledgerPath: string
  physicalIds: string[]
  libraryOnlyIds: string[]
}

interface SyncResult {
  changedSessions: number
  unchangedSessions: number
  removedSessions: number
  retainedSessions?: number
  heldRemovals?: number
  absences?: Array<{ source: string; reason: string; sessions: number }>
}

const fixtures: Fixture[] = []
const apps: ElectronApplication[] = []

function claudeSourcePath(home: string, sessionId: string): string {
  return path.join(home, '.claude', 'projects', '-f1g-project', `${sessionId}.jsonl`)
}

function writeClaudeRows(filePath: string, sessionId: string, index: number): void {
  const at = (second: number) => new Date(Date.UTC(2026, 7, 10, 9, index, second)).toISOString()
  const rows = [
    {
      uuid: `${sessionId}-u`, parentUuid: null, sessionId, type: 'user', promptSource: 'typed',
      timestamp: at(0), cwd: '/fixtures/f1g',
      message: { role: 'user', content: `F1G session ${index}` }
    },
    {
      uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, sessionId, type: 'assistant',
      requestId: `${sessionId}-request`, timestamp: at(1), cwd: '/fixtures/f1g',
      message: {
        id: `${sessionId}-message`, role: 'assistant', model: 'claude-sonnet-4-20250514',
        content: 'F1G response', stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 50 }
      }
    }
  ]
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

/** Physical Claude sessions plus Library-only packages (source deleted, backup left). */
function createFixture(label: string, physicalCount: number, libraryOnlyCount: number): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1g-${label}-`))
  const libraryRoot = path.join(home, 'Documents', 'Swob')
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: libraryRoot,
    onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }))
  const id = (block: number, index: number) =>
    `f1a90000-0000-4000-8${block}00-${String(index + 1).padStart(12, '0')}`
  const physicalIds = Array.from({ length: physicalCount }, (_, index) => id(0, index))
  // Quiet sources: older than the hot-startup and active-transcript windows,
  // so no live sync rewrites cachedSessions (and the usage revision) while
  // the spec watches which sync runs.
  const quiet = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  physicalIds.forEach((sessionId, index) => {
    const sourcePath = claudeSourcePath(home, sessionId)
    writeClaudeRows(sourcePath, sessionId, index)
    fs.utimesSync(sourcePath, quiet, quiet)
  })
  const libraryOnlyIds = Array.from({ length: libraryOnlyCount }, (_, index) => id(1, index))
  libraryOnlyIds.forEach((sessionId, index) => {
    const dir = path.join(libraryRoot, `F1G Library-only ${index + 1}`)
    writeClaudeRows(path.join(dir, 'backup.jsonl'), sessionId, 30 + index)
    fs.writeFileSync(path.join(dir, 'transcript.md'), `# F1G Library-only ${index + 1}\n`)
    fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      // Deleted source: only the backup is left.
      sourceFilePaths: [claudeSourcePath(home, sessionId)],
      createdAt: '2026-08-10T09:00:00.000Z',
      updatedAt: '2026-08-10T09:30:00.000Z',
      projectPath: '/fixtures/f1g',
      turnCount: 1,
      // A title puts the package in the tree config's sessionMeta, which is
      // how the spec sees a rescan adopt a deletion.
      customTitle: `F1G Library-only ${index + 1}`
    }, null, 2))
  })
  const fixture: Fixture = {
    home,
    libraryRoot,
    holdPath: path.join(home, 'f1g-hydration-hold'),
    ledgerPath: path.join(home, '.claude-session-manager', 'usage-facts.db'),
    physicalIds,
    libraryOnlyIds
  }
  fixtures.push(fixture)
  return fixture
}

async function launch(fixture: Fixture, env: Record<string, string> = {}): Promise<Page> {
  const { app, page } = await launchAppWithEnv({
    env: {
      HOME: fixture.home,
      SWOB_LIBRARY_ROOT: fixture.libraryRoot,
      SWOB_TEST_LIBRARY_HYDRATION_HOLD: fixture.holdPath,
      ...env
    }
  })
  apps.push(app)
  await page.evaluate(() => {
    const api = (window as any).api
    const collected: {
      results: unknown[]
      trees: Array<{ metaIds: string[]; folderIds: string[] }>
    } = { results: [], trees: [] }
    ;(window as any).__f1g = collected
    api.onInsightsFactsUpdated((result: unknown) => { collected.results.push(result) })
    api.onLibraryPatch((patch: {
      config?: { sessionMeta?: Record<string, unknown>; folders?: Array<{ id: string }> }
    }) => {
      // Only an adopted Library tree comes with its config.
      if (!patch.config) return
      collected.trees.push({
        metaIds: Object.keys(patch.config.sessionMeta || {}),
        folderIds: (patch.config.folders || []).map((folder) => folder.id)
      })
    })
  })
  // Startup has synced the physical sessions and hydrated the Library.
  await expect.poll(
    () => page.evaluate(() => (window as any).api.libraryGetHealth().then((health: { state: string }) => health.state)),
    { timeout: 60_000 }
  ).toBe('ready')
  return page
}

function ledgerSessions(fixture: Fixture): string[] {
  const ledger = new Database(fixture.ledgerPath, { readonly: true, fileMustExist: true })
  try {
    return (ledger.prepare('SELECT session_id FROM usage_sessions ORDER BY session_id').all() as
      Array<{ session_id: string }>).map((row) => row.session_id)
  } finally {
    ledger.close()
  }
}

function report(phase: string, fields: Record<string, unknown>): void {
  console.log(`[f1g-e2e] ${JSON.stringify({ phase, ...fields })}`)
}

async function rebuild(page: Page): Promise<SyncResult> {
  const result = await page.evaluate(() => (window as any).api.rebuildInsightsFacts()) as SyncResult | undefined
  expect(result).toBeDefined()
  return result!
}

/** A second independent physical load, then a sync forced inside the still-open window. */
async function loadAgainAndSync(page: Page): Promise<SyncResult> {
  const result = await page.evaluate(async () => {
    const api = (window as any).api
    await api.loadAllSessions()
    return api.rebuildInsightsFacts()
  }) as SyncResult | undefined
  expect(result).toBeDefined()
  return result!
}

async function syncResultsSince(page: Page, count: number): Promise<SyncResult[]> {
  return page.evaluate((from) => (window as any).__f1g.results.slice(from), count) as Promise<SyncResult[]>
}

async function syncResultCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__f1g.results.length)
}

/**
 * Remove a Library-only package and wait until a rescan has adopted the tree
 * without it. The package leaves the Library in one rename, so no scan sees a
 * half-deleted directory (it would count as a folder and change the revision).
 */
async function deletePackage(page: Page, fixture: Fixture, sessionId: string): Promise<void> {
  const packageName = `F1G Library-only ${fixture.libraryOnlyIds.indexOf(sessionId) + 1}`
  const removed = path.join(fixture.home, 'f1g-removed-package')
  await page.evaluate(() => { (window as any).__f1g.trees.length = 0 })
  fs.renameSync(path.join(fixture.libraryRoot, packageName), removed)
  fs.rmSync(removed, { recursive: true, force: true })
  await expect.poll(() => page.evaluate(({ deleted, folder }) => (window as any).__f1g.trees.some(
    (tree: { metaIds: string[]; folderIds: string[] }) =>
      !tree.metaIds.includes(deleted) && !tree.folderIds.includes(folder)
  ), { deleted: sessionId, folder: packageName }), { timeout: 30_000 }).toBe(true)
}

/** Let the held hydration finish, then wait for the ledger; report the syncs either way. */
async function releaseHydration(page: Page, fixture: Fixture, expected: string[]): Promise<SyncResult[]> {
  const beforeRelease = await syncResultCount(page)
  fs.rmSync(fixture.holdPath, { force: true })
  try {
    await expect.poll(() => ledgerSessions(fixture), { timeout: 30_000 }).toEqual(expected)
  } finally {
    const syncs = await syncResultsSince(page, beforeRelease)
    report('after-hydration', {
      ledger: ledgerSessions(fixture).length,
      syncs: syncs.map((result) => ({ removed: result.removedSessions, held: result.heldRemovals ?? 0 }))
    })
  }
  return syncResultsSince(page, beforeRelease)
}

function expectNothingRemovedOrHeld(results: SyncResult[]): void {
  for (const result of results) {
    expect(result.removedSessions).toBe(0)
    expect(result.heldRemovals ?? 0).toBe(0)
  }
}

test.afterEach(async () => {
  for (const fixture of fixtures) fs.rmSync(fixture.holdPath, { force: true })
  for (const app of apps.splice(0)) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
    try { app.process().kill('SIGKILL') } catch { /* already closed */ }
  }
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.home, { recursive: true, force: true })
})

test('G1: one Library-only session beside five physical ones survives pre-hydration loads; a real deletion waits for the hydration', async () => {
  test.setTimeout(180_000)
  const fixture = createFixture('g1', 5, 1)
  const [libraryOnly] = fixture.libraryOnlyIds
  const page = await launch(fixture)

  // Every session, the Library-only one included, is in the ledger.
  const warm = await rebuild(page)
  const everything = [...fixture.physicalIds, ...fixture.libraryOnlyIds].sort()
  expect(ledgerSessions(fixture)).toEqual(everything)
  report('warm', { ledger: everything.length, removed: warm.removedSessions })

  // Window 1: default gate, one missing session is below the minimum count,
  // so a sync with the load's evidence would delete it at once (G1).
  fs.writeFileSync(fixture.holdPath, 'hold\n')
  const since = await syncResultCount(page)
  const windowOne = await loadAgainAndSync(page)
  report('window-1', { ledger: ledgerSessions(fixture).length, ...windowOne })
  expect(ledgerSessions(fixture)).toEqual(everything)
  expectNothingRemovedOrHeld(await syncResultsSince(page, since))
  // Carried into the snapshot, it is present: nothing is even retained (F1g ②).
  expect(windowOne).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0, absences: [] })

  // Its package really goes away inside the window: kept for now (F1g ①).
  await deletePackage(page, fixture, libraryOnly)
  const windowDeletion = await rebuild(page)
  report('window-deleted-package', { ledger: ledgerSessions(fixture).length, ...windowDeletion })
  expect(ledgerSessions(fixture)).toEqual(everything)
  expect(windowDeletion).toMatchObject({
    removedSessions: 0,
    heldRemovals: 0,
    retainedSessions: 1,
    absences: [{ source: 'claude-code', reason: 'awaiting-first-load', sessions: 1 }]
  })

  // The hydration completes. It adds nothing back (no Library-only package is
  // left), so only the readiness flag in the revision lets its sync run; that
  // sync removes the deleted session.
  const afterHydration = await releaseHydration(page, fixture, [...fixture.physicalIds].sort())
  expect(afterHydration.some((result) => result.removedSessions === 1)).toBe(true)
})

test('G3: three Library-only sessions under a small gate are never confirmed deleted by two pre-hydration loads', async () => {
  test.setTimeout(180_000)
  const fixture = createFixture('g3', 4, 3)
  const page = await launch(fixture, {
    SWOB_USAGE_REMOVAL_MAX_COUNT: '2',
    SWOB_USAGE_REMOVAL_MIN_COUNT: '1'
  })
  const warm = await rebuild(page)
  const everything = [...fixture.physicalIds, ...fixture.libraryOnlyIds].sort()
  expect(ledgerSessions(fixture)).toEqual(everything)
  report('warm', { ledger: everything.length, removed: warm.removedSessions })

  // Two independent loads inside one window. With the load's evidence the
  // first would hold all three (over the count) and the second confirm them.
  fs.writeFileSync(fixture.holdPath, 'hold\n')
  const since = await syncResultCount(page)
  const windowOne = await loadAgainAndSync(page)
  report('window-1', { ledger: ledgerSessions(fixture).length, ...windowOne })
  expect(ledgerSessions(fixture)).toEqual(everything)
  const windowTwo = await loadAgainAndSync(page)
  report('window-2', { ledger: ledgerSessions(fixture).length, ...windowTwo })
  expect(ledgerSessions(fixture)).toEqual(everything)
  expectNothingRemovedOrHeld(await syncResultsSince(page, since))
  // Carried into the snapshot, they are present: nothing is even retained (F1g ②).
  expect(windowOne).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0, absences: [] })
  expect(windowTwo).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0, absences: [] })

  // A real deletion inside the window is deferred, not lost.
  const deleted = fixture.libraryOnlyIds[2]
  await deletePackage(page, fixture, deleted)
  const windowDeletion = await rebuild(page)
  report('window-deleted-package', { ledger: ledgerSessions(fixture).length, ...windowDeletion })
  expect(ledgerSessions(fixture)).toEqual(everything)
  expect(windowDeletion).toMatchObject({
    removedSessions: 0,
    heldRemovals: 0,
    retainedSessions: 1,
    absences: [{ source: 'claude-code', reason: 'awaiting-first-load', sessions: 1 }]
  })

  // After the hydration the next sync judges normally: the deleted one goes
  // (one missing row, under the gate), the other two stay.
  const remaining = everything.filter((sessionId) => sessionId !== deleted)
  const afterHydration = await releaseHydration(page, fixture, remaining)
  expect(afterHydration.some((result) => result.removedSessions === 1)).toBe(true)
  expectNothingRemovedOrHeld(afterHydration.filter((result) => result.removedSessions !== 1))
})
