import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv } from './helpers'

/**
 * F1d-2 end to end, on a synthetic HOME only. Phase 1 starts the desktop on
 * a fresh HOME and lets it build its caches. Phase 2 turns them into what
 * the previous build left (summary cache stamped 29, search rows without the
 * projection prefix, a lineage registry with aliases, a manual resolution and
 * no derivation mark) and starts again: the startup projection itself must
 * re-derive the search rows (not whatever warmup comes next), log the
 * rebuild, and rebuild the registry once after the first writable load,
 * keeping every alias and the resolution and backing the old file up.
 * Phase 3 restarts with everything current: no rebuild of either. A second
 * test: a registry that cannot be read is never overwritten.
 */

interface Fixture {
  home: string
  libraryRoot: string
  state: string
  registryPath: string
}

interface LifecycleLine {
  event: string
  [field: string]: unknown
}

const apps: ElectronApplication[] = []
const fixtures: Fixture[] = []

const SESSION = (index: number) => `f1d20000-0000-4000-8000-${String(index).padStart(12, '0')}`
const PLAIN = [1, 2, 3, 4].map(SESSION)
const OLD = SESSION(10)
const NEW = SESSION(11)
const PARENT_A = SESSION(20)
const PARENT_B = SESSION(21)
const CHILD = SESSION(22)
const RESOLUTION_ID = `manual:${CHILD}:${PARENT_A}:${CHILD}:continuation`
const LEGACY_ALIAS = 'f1d2-legacy-alias'

function row(sessionId: string, uuid: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    uuid, parentUuid: null, isSidechain: false, sessionId, type: 'user', promptSource: 'typed',
    userType: 'external', timestamp: new Date(Date.UTC(2026, 7, 1, 9, minute, 0)).toISOString(),
    cwd: '/fixtures/f1d2', message: { role: 'user', content: `f1d2 ${uuid}` },
    ...extra
  }
}

function reply(sessionId: string, uuid: string, parentUuid: string, minute: number, text: string) {
  return {
    uuid, parentUuid, isSidechain: false, sessionId, type: 'assistant', requestId: `${uuid}-request`,
    timestamp: new Date(Date.UTC(2026, 7, 1, 9, minute, 30)).toISOString(), cwd: '/fixtures/f1d2',
    message: {
      id: `${uuid}-message`, role: 'assistant', model: 'claude-sonnet-4-20250514', content: text,
      stop_reason: 'end_turn', usage: { input_tokens: 40, output_tokens: 10 }
    }
  }
}

function createFixture(label: string): Fixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1d2-${label}-`))
  const libraryRoot = path.join(home, 'Documents', 'Swob')
  const state = path.join(home, '.claude-session-manager')
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.mkdirSync(state, { recursive: true })
  fs.writeFileSync(path.join(state, 'app-config.json'), JSON.stringify({ libraryPath: libraryRoot, onboardingCompleted: true }))
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }))
  const project = path.join(home, '.claude', 'projects', '-fixtures-f1d2')
  fs.mkdirSync(project, { recursive: true })
  const sessions: Array<[string, unknown[]]> = [
    ...PLAIN.map((sessionId, index): [string, unknown[]] => [sessionId, [
      row(sessionId, `plain-${index}-u`, index),
      reply(sessionId, `plain-${index}-a`, `plain-${index}-u`, index, `f1d2needle${index} answer`)
    ]]),
    // A continuation: the new session's summary points at the old one's last message.
    [OLD, [row(OLD, 'old-u', 10), reply(OLD, 'old-a', 'old-u', 10, 'f1d2 old answer')]],
    [NEW, [
      { type: 'summary', sessionId: NEW, leafUuid: 'old-a', timestamp: new Date(Date.UTC(2026, 7, 1, 9, 11, 0)).toISOString() },
      row(NEW, 'new-u', 11), reply(NEW, 'new-a', 'new-u', 11, 'f1d2 new answer')
    ]],
    // An ambiguity (a child forked from two parents) that a manual resolution settles.
    [PARENT_A, [row(PARENT_A, 'point-a', 20)]],
    [PARENT_B, [row(PARENT_B, 'point-b', 20)]],
    [CHILD, [
      row(CHILD, 'child-1', 21, { forkedFrom: { sessionId: PARENT_A, messageUuid: 'point-a' } }),
      row(CHILD, 'child-2', 22, { parentUuid: 'child-1', forkedFrom: { sessionId: PARENT_B, messageUuid: 'point-b' } })
    ]]
  ]
  // Quiet sources: no live sync rewrites anything while the spec watches.
  const quiet = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  for (const [sessionId, rows] of sessions) {
    const filePath = path.join(project, `${sessionId}.jsonl`)
    fs.writeFileSync(filePath, rows.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    fs.utimesSync(filePath, quiet, quiet)
  }
  const fixture = { home, libraryRoot, state, registryPath: path.join(libraryRoot, '.session-lineage.json') }
  fixtures.push(fixture)
  return fixture
}

async function launch(fixture: Fixture): Promise<Page> {
  const { app, page } = await launchAppWithEnv({
    env: { HOME: fixture.home, SWOB_LIBRARY_ROOT: fixture.libraryRoot }
  })
  apps.push(app)
  await expect.poll(
    () => page.evaluate(() => (window as any).api.libraryGetHealth().then((health: { state: string }) => health.state)),
    { timeout: 60_000 }
  ).toBe('ready')
  return page
}

async function closeAll(): Promise<void> {
  for (const app of apps.splice(0)) {
    await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 10_000))])
    try { app.process().kill('SIGKILL') } catch { /* already closed */ }
  }
}

function lifecycle(fixture: Fixture): LifecycleLine[] {
  const logPath = path.join(fixture.state, 'lifecycle.log')
  if (!fs.existsSync(logPath)) return []
  return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LifecycleLine)
}

function events(fixture: Fixture, event: string): LifecycleLine[] {
  return lifecycle(fixture).filter((line) => line.event === event)
}

function searchRows(fixture: Fixture): { legacy: number; stale: number } {
  const dbPath = path.join(fixture.state, 'search.db')
  if (!fs.existsSync(dbPath)) return { legacy: 0, stale: -1 }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`
      SELECT count(*) AS legacy, coalesce(sum(file_signature NOT LIKE 'p2|%'), 0) AS stale
      FROM sessions WHERE projection_kind = 'legacy'
    `).get() as { legacy: number; stale: number }
  } finally {
    db.close()
  }
}

function summaryCacheVersion(fixture: Fixture): number {
  const db = new Database(path.join(fixture.state, 'summary-cache.sqlite'), { readonly: true, fileMustExist: true })
  try {
    return Number(db.pragma('user_version', { simple: true }))
  } finally {
    db.close()
  }
}

function registry(fixture: Fixture): any {
  try {
    return JSON.parse(fs.readFileSync(fixture.registryPath, 'utf8'))
  } catch {
    return null
  }
}

function backups(fixture: Fixture): string[] {
  const directory = path.join(fixture.state, 'lineage-backups')
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []
}

function report(phase: string, fields: Record<string, unknown>): void {
  console.log(`[f1d2-e2e] ${JSON.stringify({ phase, ...fields })}`)
}

/** The registry the previous build left: no derivation mark, one legacy alias, one manual decision. */
function previousBuildRegistry(fixture: Fixture): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    generatedAt: '2026-08-01T12:00:00.000Z',
    libraryRoot: fixture.libraryRoot,
    aliases: { [OLD]: NEW, [PARENT_A]: CHILD, [LEGACY_ALIAS]: OLD },
    latestByRoot: {},
    sessions: {},
    relations: [{
      parent: PARENT_A, child: CHILD, type: 'continuation', pointUuid: `manual:${CHILD}`,
      pointTs: '2026-08-01T12:00:00.000Z', provenance: 'manual', resolutionId: RESOLUTION_ID
    }],
    broken: [],
    ambiguous: [],
    resolutions: [{
      ambiguitySessionId: CHILD, parentSessionId: PARENT_A, childSessionId: CHILD, type: 'continuation',
      decidedAt: '2026-08-01T12:00:00.000Z', resolutionId: RESOLUTION_ID,
      ambiguityReason: 'multiple-exact-lineage-parents', status: 'applied'
    }]
  }, null, 2) + '\n')
}

test.afterEach(async () => {
  await closeAll()
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture.home, { recursive: true, force: true })
})

// Phases 2 and 3 check independent effects: every one is reported, not only the first to fail.
const soft = expect.configure({ soft: true })

test('an upgrade from the previous build re-derives search at startup and rebuilds the registry once, losing nothing', async () => {
  test.setTimeout(300_000)
  const fixture = createFixture('upgrade')

  // Phase 1: a fresh HOME builds every cache (9 Claude sources, a first registry).
  await launch(fixture)
  await expect.poll(() => searchRows(fixture), { timeout: 60_000 }).toEqual({ legacy: 9, stale: 0 })
  await expect.poll(() => registry(fixture) !== null, { timeout: 30_000 }).toBe(true)
  const built = searchRows(fixture)
  expect(summaryCacheVersion(fixture)).toBe(30)
  report('phase-1', { searchRows: built, summaryCache: 30, registryAliases: Object.keys(registry(fixture).aliases).length })
  await closeAll()

  // What the previous build left behind.
  const summaryDb = new Database(path.join(fixture.state, 'summary-cache.sqlite'))
  summaryDb.pragma('user_version = 29')
  summaryDb.close()
  const searchDb = new Database(path.join(fixture.state, 'search.db'))
  searchDb.prepare(
    "UPDATE sessions SET file_signature = substr(file_signature, 4) WHERE projection_kind = 'legacy' AND file_signature LIKE 'p2|%'"
  ).run()
  searchDb.close()
  expect(searchRows(fixture)).toEqual({ legacy: built.legacy, stale: built.legacy })
  const previous = previousBuildRegistry(fixture)
  fs.writeFileSync(fixture.registryPath, previous)
  fs.rmSync(path.join(fixture.state, 'lifecycle.log'), { force: true })
  expect(backups(fixture)).toEqual([])

  // Phase 2: the upgrade start. No Library session is dirty (the sources did
  // not change): the startup projection runs because the probe asks for it,
  // and cache-rebuild-finished shows it re-projected every row. (A Library
  // rescan soon after startup may also re-project search; it is incidental.)
  const page = await launch(fixture)
  await soft.poll(() => searchRows(fixture), { timeout: 60_000 }).toEqual({ legacy: built.legacy, stale: 0 })
  await soft.poll(() => events(fixture, 'cache-rebuild-finished').length, { timeout: 30_000 }).toBe(1)
  const [started] = events(fixture, 'cache-rebuild-started')
  const [finished] = events(fixture, 'cache-rebuild-finished')
  report('phase-2-cache', { searchRows: searchRows(fixture), started, finished })
  soft(started).toMatchObject({
    reasons: ['summary-cache-version', 'search-projection-version'],
    summaryCache: { state: 'stale', version: 29 },
    summaryCacheVersion: 30,
    searchProjection: { legacyRows: built.legacy, staleLegacyRows: built.legacy },
    searchProjectionVersion: 2
  })
  // Finished means the startup snapshot itself re-projected every row.
  soft(finished).toMatchObject({
    summary: { outcome: 'ok' },
    search: { outcome: 'ok' },
    summaryCache: { state: 'current', version: 30 },
    searchProjection: { legacyRows: built.legacy, staleLegacyRows: 0 }
  })
  soft(summaryCacheVersion(fixture)).toBe(30)
  const hits = await page.evaluate(() => (window as any).api.searchSessions('f1d2needle2')) as Array<{ sessionId: string }>
  soft(hits.map((hit) => hit.sessionId)).toContain(PLAIN[2])

  // The registry: rebuilt once after the first writable load, nothing lost, old file backed up.
  await soft.poll(() => registry(fixture)?.derivedFrom?.summaryCacheVersion ?? null, { timeout: 30_000 }).toBe(30)
  const rebuilt = registry(fixture) || { aliases: {}, resolutions: [], relations: [] }
  soft(Object.keys(rebuilt.aliases)).toEqual(expect.arrayContaining([OLD, PARENT_A, LEGACY_ALIAS]))
  soft(rebuilt.aliases[LEGACY_ALIAS]).toBe(NEW)
  soft(rebuilt.resolutions).toEqual([expect.objectContaining({ resolutionId: RESOLUTION_ID, status: 'applied' })])
  soft(rebuilt.relations).toContainEqual(expect.objectContaining({
    parent: PARENT_A, child: CHILD, provenance: 'manual', resolutionId: RESOLUTION_ID
  }))
  const saved = backups(fixture)
  soft(saved).toHaveLength(1)
  soft(saved.slice(0, 1).map((name) => fs.readFileSync(path.join(fixture.state, 'lineage-backups', name)).equals(previous)))
    .toEqual([true])
  soft(fs.readdirSync(fixture.libraryRoot).filter((name) => name.endsWith('.tmp'))).toEqual([])
  const [lineageLine] = events(fixture, 'lineage-registry-rebuilt')
  report('phase-2-lineage', { lineageLine, aliases: Object.keys(rebuilt.aliases).length, backups: saved.length })
  soft(lineageLine).toMatchObject({
    trigger: 'derivation',
    summaryCacheVersion: 30,
    previous: { aliases: 3, resolutions: 1, manualRelations: 1 },
    next: { resolutions: 1, manualRelations: 1 },
    backup: saved[0]
  })
  soft(events(fixture, 'lineage-registry-refused')).toEqual([])
  await closeAll()

  // Phase 3: a steady restart rebuilds neither.
  const registryBytes = fs.readFileSync(fixture.registryPath)
  const lines = lifecycle(fixture).length
  await launch(fixture)
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const later = lifecycle(fixture).slice(lines).map((line) => line.event)
  report('phase-3', { events: later })
  soft(later).not.toContain('cache-rebuild-started')
  soft(later).not.toContain('lineage-registry-rebuilt')
  soft(fs.readFileSync(fixture.registryPath).equals(registryBytes)).toBe(true)
  soft(backups(fixture)).toEqual(saved)
})

test('a lineage registry that cannot be read is never overwritten', async () => {
  test.setTimeout(120_000)
  const fixture = createFixture('unreadable')
  const broken = Buffer.from('{"version":1,"aliases":{"f1d2-kept":')
  fs.writeFileSync(fixture.registryPath, broken)

  await launch(fixture)
  // Either the refusal is logged or (what this guards against) the file is rewritten.
  await expect.poll(
    () => events(fixture, 'lineage-registry-refused').length > 0 || !fs.readFileSync(fixture.registryPath).equals(broken),
    { timeout: 30_000 }
  ).toBe(true)
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  const refused = events(fixture, 'lineage-registry-refused')
  report('unreadable', { refused, rewritten: !fs.readFileSync(fixture.registryPath).equals(broken) })
  expect(fs.readFileSync(fixture.registryPath).equals(broken)).toBe(true)
  expect(refused[0]).toMatchObject({ code: 'LINEAGE_REGISTRY_UNREADABLE', readCode: 'invalid-json' })
  expect(backups(fixture)).toEqual([])
  expect(events(fixture, 'lineage-registry-rebuilt')).toEqual([])
})
