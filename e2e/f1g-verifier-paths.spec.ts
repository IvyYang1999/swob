import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv } from './helpers'

/**
 * F1g verifier-only spec (not committed): the two whole-replacement paths the
 * Builder's spec does not drive end to end.
 *  R  reloadSessionsForAction, reached side-effect free through the copy-resume
 *     command of a Library package whose source exists outside the scanned
 *     source directories (so it is Library-only for the loader, resumable for
 *     the guard, and absent from cachedSessions while its hydration is held).
 *  S0 onboarding:setExcludedSources with no change: cachedSessions loses the
 *     Library-only sessions, the reset epoch stays, the snapshot must carry them.
 *  S1 onboarding:setExcludedSources excluding claude-code: every claude-code
 *     row leaves, the Library-only one included (never carried as present).
 * Sandbox only (launchAppWithEnv + protected-state audit); no resume/fork.
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
      message: { role: 'user', content: `F1G verifier session ${index}` }
    },
    {
      uuid: `${sessionId}-a`, parentUuid: `${sessionId}-u`, sessionId, type: 'assistant',
      requestId: `${sessionId}-request`, timestamp: at(1), cwd: '/fixtures/f1g',
      message: {
        id: `${sessionId}-message`, role: 'assistant', model: 'claude-sonnet-4-20250514',
        content: 'F1G verifier response', stop_reason: 'end_turn',
        usage: { input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 10, output_tokens: 50 }
      }
    }
  ]
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function writePackage(dir: string, sessionId: string, index: number, sourceFilePath: string, title: string): void {
  writeClaudeRows(path.join(dir, 'backup.jsonl'), sessionId, index)
  fs.writeFileSync(path.join(dir, 'transcript.md'), `# ${title}\n`)
  fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
    schemaVersion: 2,
    sessionId,
    sourceFilePaths: [sourceFilePath],
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:30:00.000Z',
    projectPath: '/fixtures/f1g',
    turnCount: 1,
    customTitle: title
  }, null, 2))
}

function createFixture(label: string, physicalCount: number, libraryOnlyCount: number): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1gv-${label}-`))
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
    `f1b90000-0000-4000-8${block}00-${String(index + 1).padStart(12, '0')}`
  const physicalIds = Array.from({ length: physicalCount }, (_, index) => id(0, index))
  const quiet = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  physicalIds.forEach((sessionId, index) => {
    const sourcePath = claudeSourcePath(home, sessionId)
    writeClaudeRows(sourcePath, sessionId, index)
    fs.utimesSync(sourcePath, quiet, quiet)
  })
  const libraryOnlyIds = Array.from({ length: libraryOnlyCount }, (_, index) => id(1, index))
  libraryOnlyIds.forEach((sessionId, index) => {
    writePackage(path.join(libraryRoot, `F1GV Library-only ${index + 1}`), sessionId, 30 + index,
      claudeSourcePath(home, sessionId), `F1GV Library-only ${index + 1}`)
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
    const collected: { results: unknown[]; trees: Array<{ metaIds: string[] }>; patched: string[] } =
      { results: [], trees: [], patched: [] }
    ;(window as any).__f1gv = collected
    api.onInsightsFactsUpdated((result: unknown) => { collected.results.push(result) })
    api.onLibraryPatch((patch: {
      sessions?: Array<{ sessionId?: string }>
      config?: { sessionMeta?: Record<string, unknown> }
    }) => {
      for (const session of patch.sessions || []) if (session.sessionId) collected.patched.push(session.sessionId)
      if (!patch.config) return
      collected.trees.push({ metaIds: Object.keys(patch.config.sessionMeta || {}) })
    })
  })
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
  console.log(`[f1g-verifier] ${JSON.stringify({ phase, ...fields })}`)
}

async function rebuild(page: Page): Promise<SyncResult> {
  const result = await page.evaluate(() => (window as any).api.rebuildInsightsFacts()) as SyncResult | undefined
  expect(result).toBeDefined()
  return result!
}

async function syncResultsSince(page: Page, count: number): Promise<SyncResult[]> {
  return page.evaluate((from) => (window as any).__f1gv.results.slice(from), count) as Promise<SyncResult[]>
}

async function syncResultCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__f1gv.results.length)
}

/** Wait until no adopted Library tree has arrived for 3 s (at most 20 s). */
async function quietLibrary(page: Page): Promise<void> {
  const started = Date.now()
  let seen = await page.evaluate(() => (window as any).__f1gv.trees.length)
  let quietSince = Date.now()
  while (Date.now() - started < 20_000 && Date.now() - quietSince < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    const now = await page.evaluate(() => (window as any).__f1gv.trees.length)
    if (now !== seen) { seen = now; quietSince = Date.now() }
  }
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

test('R: the reload a session action does keeps a just-orphaned session and carries the Library-only one', async () => {
  test.setTimeout(180_000)
  const fixture = createFixture('r', 5, 1)
  const page = await launch(fixture)
  const warm = await rebuild(page)
  const everything = [...fixture.physicalIds, ...fixture.libraryOnlyIds].sort()
  expect(ledgerSessions(fixture)).toEqual(everything)
  report('warm', { ledger: everything.length, removed: warm.removedSessions })

  // The source of one physical session goes away; its startup backup stays.
  const orphan = fixture.physicalIds[4]
  const moved = path.join(fixture.home, 'f1gv-moved-source')
  fs.renameSync(claudeSourcePath(fixture.home, orphan), moved)
  fs.rmSync(moved, { force: true })
  // Let any Library rescan the deletion causes finish before holding
  // hydrations: a held rescan would block the rescan controller.
  await quietLibrary(page)

  // Hold every hydration before Phase 2b, then add a package whose source
  // exists outside the scanned directories: Library-only for the loader,
  // resumable for the guard, and absent from cachedSessions while held.
  fs.writeFileSync(fixture.holdPath, 'hold\n')
  const outsideId = 'f1b90000-0000-4000-8200-000000000001'
  const outsideSource = path.join(fixture.home, 'f1gv-outside', `${outsideId}.jsonl`)
  writeClaudeRows(outsideSource, outsideId, 50)
  await page.evaluate(() => { (window as any).__f1gv.trees.length = 0 })
  const staging = path.join(fixture.home, 'f1gv-staging-package')
  fs.mkdirSync(staging, { recursive: true })
  writePackage(staging, outsideId, 50, outsideSource, 'F1GV Outside 1')
  const outsideDir = path.join(fixture.libraryRoot, 'F1GV Outside 1')
  fs.renameSync(staging, outsideDir)
  // Wait for a rescan to adopt it; nudge the watcher with a touch if it is slow.
  let adopted = false
  for (let attempt = 0; attempt < 24 && !adopted; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    adopted = await page.evaluate((wanted) => (window as any).__f1gv.trees.some(
      (tree: { metaIds: string[] }) => tree.metaIds.includes(wanted)
    ), outsideId)
    if (!adopted && attempt % 2 === 1) {
      const now = new Date()
      fs.utimesSync(path.join(outsideDir, '.swob-session.json'), now, now)
    }
  }
  report('adopted-outside-package', { adopted })
  expect(adopted).toBe(true)
  expect(ledgerSessions(fixture)).toEqual(everything)

  // Copying its resume command finds no summary: reloadSessionsForAction runs.
  const since = await syncResultCount(page)
  const command = await page.evaluate(async (sessionId) => {
    try {
      return { ok: true, value: String(await (window as any).api.buildResumeCommand(sessionId)) }
    } catch (error) {
      return { ok: false, value: String((error as Error)?.message || error) }
    }
  }, outsideId)
  report('copy-command', { ok: command.ok, hasSessionId: command.value.includes(outsideId), error: command.ok ? undefined : command.value })
  const afterReload = await rebuild(page)
  report('after-reload', { ledger: ledgerSessions(fixture).length, ...afterReload })
  expect(ledgerSessions(fixture)).toEqual(everything)
  expectNothingRemovedOrHeld(await syncResultsSince(page, since))
  // The orphan is missing and not yet hydrated: kept (F1g ①). The hydrated
  // Library-only session rides in the snapshot: not even retained (F1g ②).
  expect(afterReload).toMatchObject({
    removedSessions: 0,
    heldRemovals: 0,
    retainedSessions: 1,
    absences: [{ source: 'claude-code', reason: 'awaiting-first-load', sessions: 1 }]
  })

  // Only the hydration the reload started can finish this epoch: release it.
  const beforeRelease = await syncResultCount(page)
  fs.rmSync(fixture.holdPath, { force: true })
  const expected = [...everything, outsideId].sort()
  try {
    await expect.poll(() => ledgerSessions(fixture), { timeout: 30_000 }).toEqual(expected)
  } finally {
    const syncs = await syncResultsSince(page, beforeRelease)
    report('after-hydration', {
      ledger: ledgerSessions(fixture).length,
      syncs: syncs.map((result) => ({ removed: result.removedSessions, held: result.heldRemovals ?? 0, retained: result.retainedSessions ?? 0 }))
    })
  }
  expectNothingRemovedOrHeld(await syncResultsSince(page, beforeRelease))
})

test('R2: after a reload inside a window, only the reload\'s own hydration can close it', async () => {
  test.setTimeout(180_000)
  const fixture = createFixture('r2', 5, 1)
  const page = await launch(fixture)
  await rebuild(page)
  const everything = [...fixture.physicalIds, ...fixture.libraryOnlyIds].sort()
  expect(ledgerSessions(fixture)).toEqual(everything)

  // A Library-only package whose source exists outside the scanned
  // directories, hydrated and counted before the window opens.
  const outsideId = 'f1b90000-0000-4000-8200-000000000002'
  const outsideSource = path.join(fixture.home, 'f1gv-outside', `${outsideId}.jsonl`)
  writeClaudeRows(outsideSource, outsideId, 51)
  const staging = path.join(fixture.home, 'f1gv-staging-package')
  fs.mkdirSync(staging, { recursive: true })
  writePackage(staging, outsideId, 51, outsideSource, 'F1GV Outside 2')
  fs.renameSync(staging, path.join(fixture.libraryRoot, 'F1GV Outside 2'))
  const withOutside = [...everything, outsideId].sort()
  await expect.poll(async () => { await rebuild(page); return ledgerSessions(fixture) }, { timeout: 45_000 })
    .toEqual(withOutside)

  // One physical session loses its source (its startup backup stays).
  const orphan = fixture.physicalIds[4]
  const moved = path.join(fixture.home, 'f1gv-moved-source')
  fs.renameSync(claudeSourcePath(fixture.home, orphan), moved)
  fs.rmSync(moved, { force: true })
  await quietLibrary(page)

  // Window: a second load, its hydration held. Let the Library settle (the
  // load's provider settlement runs backlog recovery, whose writes trigger a
  // rescan): a rescan after the reload would close the window by itself.
  fs.writeFileSync(fixture.holdPath, 'hold\n')
  await page.evaluate(() => (window as any).api.loadAllSessions())
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await quietLibrary(page)
  // The outside package is out of cachedSessions now: copying its resume
  // command reloads, which supersedes the load's held hydration.
  const command = await page.evaluate(async (sessionId) => {
    try {
      return { ok: true, value: String(await (window as any).api.buildResumeCommand(sessionId)) }
    } catch (error) {
      return { ok: false, value: String((error as Error)?.message || error) }
    }
  }, outsideId)
  report('r2-copy-command', { ok: command.ok, hasSessionId: command.value.includes(outsideId) })
  const inWindow = await rebuild(page)
  report('r2-window', { ledger: ledgerSessions(fixture).length, ...inWindow })
  expect(ledgerSessions(fixture)).toEqual(withOutside)
  expect(inWindow).toMatchObject({
    removedSessions: 0,
    heldRemovals: 0,
    retainedSessions: 1,
    absences: [{ source: 'claude-code', reason: 'awaiting-first-load', sessions: 1 }]
  })

  // No rescan may follow the reload, or it alone could close the window.
  const treesAfterReload = await page.evaluate(() => (window as any).__f1gv.trees.length)
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const rescannedAfterReload = await page.evaluate(() => (window as any).__f1gv.trees.length) !== treesAfterReload
  report('r2-rescan-after-reload', { rescannedAfterReload })

  // Release: the hydration the reload started brings the orphan back from its
  // backup and completes the epoch. Without it nothing would.
  fs.rmSync(fixture.holdPath, { force: true })
  let last: SyncResult | null = null
  try {
    await expect.poll(async () => {
      last = await rebuild(page)
      return (last.retainedSessions ?? 0) === 0 && (last.absences || []).length === 0
    }, { timeout: 20_000 }).toBe(true)
  } finally {
    report('r2-after-release', { ledger: ledgerSessions(fixture).length, ...(last || {}) })
  }
  expect(ledgerSessions(fixture)).toEqual(withOutside)
})

test('S0: excluding no source again keeps the Library-only session in the snapshot', async () => {
  test.setTimeout(180_000)
  const fixture = createFixture('s0', 5, 1)
  const page = await launch(fixture)
  await rebuild(page)
  const everything = [...fixture.physicalIds, ...fixture.libraryOnlyIds].sort()
  expect(ledgerSessions(fixture)).toEqual(everything)
  // The startup load read a cold summary cache (F1f rule 5 keeps every
  // missing row). A second, warm load that hydrates to the end makes the
  // evidence warm and ready before the exclusion handler runs.
  await page.evaluate(() => { (window as any).__f1gv.patched.length = 0 })
  await page.evaluate(() => (window as any).api.loadAllSessions())
  // Hydration Phase 2b re-adds the Library-only session: its patch is sent.
  await expect.poll(() => page.evaluate((wanted) => (window as any).__f1gv.patched.includes(wanted),
    fixture.libraryOnlyIds[0]), { timeout: 30_000 }).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const ready = await rebuild(page)
  report('s0-ready', { ledger: ledgerSessions(fixture).length, ...ready })
  expect(ready).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0, absences: [] })

  fs.writeFileSync(fixture.holdPath, 'hold\n')
  const since = await syncResultCount(page)
  await page.evaluate(() => (window as any).api.onboardingSetExcludedSources([]))
  const windowSync = await rebuild(page)
  report('s0-window', { ledger: ledgerSessions(fixture).length, ...windowSync })
  expect(ledgerSessions(fixture)).toEqual(everything)
  expectNothingRemovedOrHeld(await syncResultsSince(page, since))
  expect(windowSync).toMatchObject({ removedSessions: 0, heldRemovals: 0, retainedSessions: 0, absences: [] })

  fs.rmSync(fixture.holdPath, { force: true })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const after = await rebuild(page)
  report('s0-after', { ledger: ledgerSessions(fixture).length, ...after })
  expect(ledgerSessions(fixture)).toEqual(everything)
})

test('S1: excluding claude-code removes its Library-only row too', async () => {
  test.setTimeout(180_000)
  const fixture = createFixture('s1', 5, 1)
  const page = await launch(fixture)
  await rebuild(page)
  const everything = [...fixture.physicalIds, ...fixture.libraryOnlyIds].sort()
  expect(ledgerSessions(fixture)).toEqual(everything)

  await page.evaluate(() => (window as any).api.onboardingSetExcludedSources(['claude-code']))
  const excluded = await rebuild(page)
  report('s1-excluded', { ledger: ledgerSessions(fixture).length, ...excluded })
  expect(ledgerSessions(fixture)).toEqual([])
})
