import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  assertExplicitTemporaryLaunchPaths,
  assertTestLaunchContract,
  runtimeSafetyState,
  type IsolationEnvironment
} from '../src/main/e2e-library-isolation'
import {
  assertProtectedRealStateUnchanged,
  snapshotProtectedRealState,
  type ProtectedStateSnapshot
} from '../src/main/__test-support__/protected-state-audit'
import {
  assertE2EProviderHomeEnvironmentIsolated,
  isolateE2EProviderHomeEnvironment
} from './provider-home-isolation'

export const CLAUDE_FIXTURE_ID = '82000000-0000-4000-8000-000000000099'
export const CODEX_FIXTURE_ID = '019abcde-1234-7000-8000-012345670099'
export const CODEX_PRICING_FIXTURE_ID = '019abcde-1234-7000-8000-012345670171'
export const CODEX_LIFECYCLE_PARENT_ID = '18400000-0000-4000-8000-000000000011'
export const CODEX_LIFECYCLE_REPLAY_ID = '18400000-0000-4000-8000-000000000012'
export const CODEX_LIFECYCLE_ARCHIVED_ID = '18400000-0000-4000-8000-000000000013'
export const ZCODE_FIXTURE_ID = 'sess_ZcodeUI099'

interface AppIsolationAudit {
  before: ProtectedStateSnapshot
  verified: boolean
}

const appIsolationAudits = new WeakMap<ElectronApplication, AppIsolationAudit>()

function inheritedE2EEnvironment(): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME']) {
    const value = process.env[name]
    if (value) inherited[name] = value
  }
  return inherited
}

function attachProtectedStateAudit(app: ElectronApplication, before: ProtectedStateSnapshot): void {
  const audit: AppIsolationAudit = { before, verified: false }
  appIsolationAudits.set(app, audit)
  const close = app.close.bind(app)
  app.close = async () => {
    try {
      await close()
    } finally {
      verifyProtectedStateAudit(app)
    }
  }
}

function verifyProtectedStateAudit(app: ElectronApplication): void {
  const audit = appIsolationAudits.get(app)
  if (!audit || audit.verified) return
  assertProtectedRealStateUnchanged(audit.before)
  audit.verified = true
}

/**
 * Legacy launcher for specs that manage their own fixture HOME and inspect it
 * after the app closes (onboarding, vault-lens, visual capture). New specs
 * should prefer the fully sandboxed launchApp below.
 */
export async function launchAppWithEnv(options: {
  env?: Record<string, string>
  sandboxRoot?: string
} = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const testHome = options.env?.SWOB_TEST_HOME || options.env?.HOME
  if (!testHome) throw new Error('launchAppWithEnv requires an isolated HOME or SWOB_TEST_HOME')
  const sandboxRoot = options.sandboxRoot || testHome
  const userData = path.join(testHome, '.swob-e2e-user-data')
  const cache = path.join(testHome, '.swob-e2e-cache')
  const libraryRoot = options.env?.SWOB_LIBRARY_ROOT || path.join(testHome, 'Documents', 'Swob')
  const config = path.join(sandboxRoot, '.swob-e2e-config')
  const temp = path.join(sandboxRoot, '.swob-e2e-tmp')
  for (const directory of [userData, cache, config, temp]) fs.mkdirSync(directory, { recursive: true })
  const environment: IsolationEnvironment & Record<string, string | undefined> = {
    ...inheritedE2EEnvironment(),
    ...options.env,
    HOME: testHome,
    USERPROFILE: testHome,
    NODE_ENV: 'test',
    SWOB_TEST_HOME: testHome,
    SWOB_TEST_LOCALE: 'zh-CN',
    SWOB_E2E_SANDBOX_ROOT: sandboxRoot,
    SWOB_TEST_SYSTEM_TEMP_ROOT: os.tmpdir(),
    SWOB_LIBRARY_ROOT: libraryRoot,
    SWOB_USER_DATA_ROOT: userData,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    TMPDIR: temp
  }
  isolateE2EProviderHomeEnvironment(environment, sandboxRoot)
  assertTestLaunchContract(environment, userData, { systemTemporaryRoot: os.tmpdir() })
  assertE2EProviderHomeEnvironmentIsolated(environment, sandboxRoot)
  const protectedStateBefore = snapshotProtectedRealState()
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      `--disk-cache-dir=${cache}`
    ],
    env: environment as Record<string, string>
  })
  attachProtectedStateAudit(app, protectedStateBefore)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export interface LaunchAppOptions {
  claudeTurns?: number
  viewport?: { width: number; height: number }
  includeCursorFixture?: boolean
  includePiFixture?: boolean
  includeKimiFixture?: boolean
  includeGrokFixture?: boolean
  includeQoderFixture?: boolean
  includeTraeFixture?: boolean
  includeInspectorFixture?: boolean
  includePricingFixture?: boolean
  includeUnpricedValuationFixture?: boolean
  includeCodexLifecycleFixture?: boolean
  env?: Record<string, string>
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  sandboxRoot: string
  home: string
  libraryRoot: string
  userData: string
}

export async function launchDangerousDevelopmentApp(): Promise<LaunchedApp> {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-dev-real-library-e2e-'))
  const home = path.join(sandboxRoot, 'home')
  const libraryRoot = path.join(sandboxRoot, 'Real-Library-Fixture')
  const userData = path.join(sandboxRoot, 'user-data')
  const cache = path.join(sandboxRoot, 'cache')
  const config = path.join(sandboxRoot, 'config')
  const temp = path.join(sandboxRoot, 'tmp')
  for (const directory of [home, libraryRoot, userData, cache, config, temp]) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: libraryRoot,
    onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }))

  const environment: Record<string, string> = {
    ...inheritedE2EEnvironment(),
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'development',
    SWOB_LIBRARY_ROOT: libraryRoot,
    SWOB_USER_DATA_ROOT: userData,
    SWOB_ISOLATION_PROTECTED_HOME: home,
    SWOB_DEV_USE_REAL_LIBRARY: '1',
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    TMPDIR: temp
  }
  isolateE2EProviderHomeEnvironment(environment, sandboxRoot)
  assertE2EProviderHomeEnvironmentIsolated(environment, sandboxRoot)
  assertExplicitTemporaryLaunchPaths(environment, sandboxRoot, userData, os.tmpdir())
  const safety = runtimeSafetyState(libraryRoot, environment)
  if (!safety.dangerousRealLibrary) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
    throw new Error('Development danger-marker fixture did not activate the real-Library guard')
  }

  const protectedStateBefore = snapshotProtectedRealState()
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      `--disk-cache-dir=${cache}`
    ],
    env: environment
  })
  attachProtectedStateAudit(app, protectedStateBefore)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    return { app, page, sandboxRoot, home, libraryRoot, userData }
  } catch (error) {
    await app.close().catch(() => {})
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
    throw error
  }
}

export async function resizeAppWindow(
  app: ElectronApplication,
  page: Page,
  contentSize: { width: number; height: number }
): Promise<void> {
  const nativeWindow = await app.browserWindow(page)
  await nativeWindow.evaluate((browserWindow, size) => {
    const [minimumWidth, minimumHeight] = browserWindow.getMinimumSize()
    browserWindow.setMinimumSize(
      Math.min(minimumWidth, size.width),
      Math.min(minimumHeight, size.height)
    )
    browserWindow.setContentSize(size.width, size.height)
  }, contentSize)
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    contentSize
  )
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
}

function createSyntheticCorpus(
  home: string,
  libraryRoot: string,
  claudeTurns: number,
  includeCursorFixture = false,
  includePiFixture = false,
  includeKimiFixture = false,
  includeGrokFixture = false,
  includeQoderFixture = false,
  includeTraeFixture = false,
  includeInspectorFixture = false,
  includePricingFixture = false,
  includeUnpricedValuationFixture = false,
  includeCodexLifecycleFixture = false
): void {
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })
  const inspectorFile = path.join(project, 'src', 'nested', 'fixture.ts')
  if (includeInspectorFixture) {
    fs.mkdirSync(path.dirname(inspectorFile), { recursive: true })
    fs.writeFileSync(inspectorFile, 'export const inspectorFixture = true\n', 'utf8')
  }
  if (includeGrokFixture) {
    const grokSession = path.join(
      home,
      '.grok',
      'sessions',
      '%2Fworkspace%2Fswob-grok-fixture',
      '11111111-2222-7333-8444-555555555555'
    )
    fs.mkdirSync(path.dirname(grokSession), { recursive: true })
    fs.cpSync(path.resolve(__dirname, '../testdata/grok/compacted-session'), grokSession, { recursive: true })
  }

  // Sandboxed specs test the main UI, not first-run onboarding (which has its
  // own dedicated spec). Pre-complete onboarding so the wizard never blocks.
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: libraryRoot,
    onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: {
      defaultViewMode: 'compact',
      terminalApp: 'Terminal',
      // Session-focused specs must not depend on the transient expansion state
      // of the single-turn disclosure while background Library patches arrive.
      singleTurnBehavior: 'show'
    }
  }))

  const claudeRows: unknown[] = []
  let parentUuid: string | null = null
  for (let index = 0; index < claudeTurns; index++) {
    const userUuid = `claude-user-${index}`
    const assistantUuid = `claude-assistant-${index}`
    claudeRows.push({
      uuid: userUuid,
      parentUuid,
      sessionId: CLAUDE_FIXTURE_ID,
      type: 'user',
      timestamp: new Date(Date.UTC(2026, 6, 21, 10, 0, index * 2)).toISOString(),
      cwd: project,
      message: { role: 'user', content: `Synthetic Claude turn ${index}` }
    })
    claudeRows.push({
      uuid: assistantUuid,
      parentUuid: userUuid,
      sessionId: CLAUDE_FIXTURE_ID,
      type: 'assistant',
      requestId: `claude-request-${index}`,
      timestamp: new Date(Date.UTC(2026, 6, 21, 10, 0, index * 2 + 1)).toISOString(),
      cwd: project,
      message: {
        id: `claude-message-${index}`,
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: includeInspectorFixture && index === 0
          ? [
              { type: 'text', text: `Synthetic response ${index} ${'fixture '.repeat(12)}` },
              {
                type: 'tool_use',
                id: 'inspector-edit-0',
                name: 'Edit',
                input: {
                  file_path: inspectorFile,
                  old_string: 'false',
                  new_string: 'true'
                }
              }
            ]
          : `Synthetic response ${index} ${'fixture '.repeat(12)}`,
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 50
        }
      }
    })
    parentUuid = assistantUuid
  }
  writeJsonl(
    path.join(home, '.claude', 'projects', '-synthetic-project', `${CLAUDE_FIXTURE_ID}.jsonl`),
    claudeRows
  )

  if (includeCodexLifecycleFixture) {
    const customCodexHome = path.join(home, 'codex-work')
    const lifecycleRows = (
      sessionId: string,
      prompt: string,
      extraMeta: Record<string, unknown> = {}
    ) => [
      {
        timestamp: '2026-08-01T10:00:00Z', type: 'session_meta',
        payload: {
          id: sessionId, timestamp: '2026-08-01T10:00:00Z', cwd: project,
          cli_version: 'test', model_provider: 'openai', ...extraMeta
        }
      },
      {
        timestamp: '2026-08-01T10:00:01Z', type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }
      },
      {
        timestamp: '2026-08-01T10:00:02Z', type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Lifecycle fixture response' }] }
      },
      {
        timestamp: '2026-08-01T10:00:03Z', type: 'event_msg',
        payload: {
          type: 'token_count', info: {
            turn_id: `turn-${sessionId}`,
            last_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0 },
            total_token_usage: { input_tokens: 40, output_tokens: 10, cached_input_tokens: 0 }
          }
        }
      }
    ]
    writeJsonl(path.join(
      customCodexHome, 'sessions', '2026', '08', '02',
      `rollout-parent-${CODEX_LIFECYCLE_PARENT_ID}.jsonl`
    ), lifecycleRows(CODEX_LIFECYCLE_PARENT_ID, 'T184 custom root parent'))
    writeJsonl(path.join(
      customCodexHome, 'sessions', '2026', '08', '02',
      `rollout-replay-${CODEX_LIFECYCLE_REPLAY_ID}.jsonl`
    ), lifecycleRows(CODEX_LIFECYCLE_REPLAY_ID, 'T184 replay child', {
      forked_from_id: CODEX_LIFECYCLE_PARENT_ID
    }))
    writeJsonl(path.join(
      home, '.codex', 'archived_sessions',
      `rollout-archived-${CODEX_LIFECYCLE_ARCHIVED_ID}.jsonl`
    ), lifecycleRows(CODEX_LIFECYCLE_ARCHIVED_ID, 'T184 archived lifecycle'))
    fs.writeFileSync(path.join(home, '.claude-session-manager', 'codex-homes.json'), JSON.stringify({
      version: 1,
      homes: [customCodexHome]
    }, null, 2))
  }

  if (includePricingFixture) {
    writeJsonl(
      path.join(
        home,
        '.codex',
        'sessions',
        '2026',
        '07',
        '31',
        `rollout-2026-07-31T12-00-00-${CODEX_PRICING_FIXTURE_ID}.jsonl`
      ),
      [
        {
          timestamp: '2026-07-31T12:00:00Z',
          type: 'session_meta',
          payload: {
            id: CODEX_PRICING_FIXTURE_ID,
            timestamp: '2026-07-31T12:00:00Z',
            cwd: project,
            cli_version: 'test',
            model_provider: 'openai'
          }
        },
        {
          timestamp: '2026-07-31T12:00:01Z',
          type: 'turn_context',
          payload: { turn_id: 'pricing-turn', model: 'gpt-5.6-luna', model_provider: 'openai' }
        },
        {
          timestamp: '2026-07-31T12:00:02Z',
          type: 'response_item',
          payload: {
            type: 'message', role: 'user',
            content: [{ type: 'input_text', text: 'Auditable pricing fixture' }]
          }
        },
        {
          timestamp: '2026-07-31T12:00:03Z',
          type: 'response_item',
          payload: {
            type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'Pricing fixture response' }]
          }
        },
        {
          timestamp: '2026-07-31T12:00:04Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100000, cached_input_tokens: 0, output_tokens: 100000 },
              total_token_usage: { input_tokens: 100000, cached_input_tokens: 0, output_tokens: 100000 }
            }
          }
        }
      ]
    )
  }

  if (includePiFixture) {
    const piPath = path.join(home, '.pi', 'agent', 'sessions', 'synthetic-project', 'session.jsonl')
    fs.mkdirSync(path.dirname(piPath), { recursive: true })
    fs.copyFileSync(path.join(__dirname, '..', 'testdata', 'pi', 'session.jsonl'), piPath)
  }

  if (includeKimiFixture) {
    fs.cpSync(
      path.join(__dirname, '..', 'testdata', 'kimi', 'home', '.kimi-code'),
      path.join(home, '.kimi-code'),
      { recursive: true }
    )
  }

  if (includeQoderFixture) {
    fs.cpSync(
      path.join(__dirname, '..', 'testdata', 'qoder', '-workspace-synthetic-qoder'),
      path.join(home, '.qoder', 'projects', '-workspace-synthetic-qoder'),
      { recursive: true }
    )
  }

  if (includeTraeFixture) {
    const fixture = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'testdata', 'trae', 'legacy-state-vscdb.json'),
      'utf8'
    )) as { storageKey: string; store: unknown }
    const workspaceRoot = path.join(
      home,
      'Library',
      'Application Support',
      'Trae',
      'User',
      'workspaceStorage',
      'synthetic-workspace'
    )
    fs.mkdirSync(workspaceRoot, { recursive: true })
    fs.writeFileSync(
      path.join(workspaceRoot, 'workspace.json'),
      JSON.stringify({ folder: 'file:///workspace/synthetic-trae' })
    )
    const traeDb = new Database(path.join(workspaceRoot, 'state.vscdb'))
    traeDb.pragma('journal_mode = WAL')
    traeDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    traeDb.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run(fixture.storageKey, JSON.stringify(fixture.store))
    traeDb.close()
  }
  writeJsonl(
    path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '07',
      '21',
      `rollout-2026-07-21T10-00-00-${CODEX_FIXTURE_ID}.jsonl`
    ),
    [
      {
        timestamp: '2026-07-21T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: CODEX_FIXTURE_ID,
          timestamp: '2026-07-21T10:00:00Z',
          cwd: project,
          cli_version: 'test'
        }
      },
      {
        timestamp: '2026-07-21T10:00:10Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Synthetic Codex UI fixture' }]
        }
      },
      {
        timestamp: '2026-07-21T10:00:20Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Synthetic response' }]
        }
      },
      {
        timestamp: '2026-07-21T10:00:21Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 },
            total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 }
          }
        }
      }
    ]
  )

  if (includeCursorFixture) {
    writeJsonl(
      path.join(
        home,
        '.cursor',
        'projects',
        '-synthetic-project',
        'agent-transcripts',
        'cursor-token-unavailable',
        'cursor-token-unavailable.jsonl'
      ),
      [
        { timestamp: '2026-07-21T09:00:00Z', role: 'user', message: { content: [{ type: 'text', text: '<user_query>Cursor token unavailable fixture</user_query>' }] } },
        { timestamp: '2026-07-21T09:00:05Z', role: 'assistant', message: { content: [{ type: 'text', text: 'Cursor response without authoritative usage.' }] } }
      ]
    )
  }

  const dbPath = path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec([
    'CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)',
    'CREATE TABLE message(id TEXT PRIMARY KEY, sessionID TEXT, data TEXT, role TEXT, time_created INTEGER)',
    'CREATE TABLE part(id TEXT PRIMARY KEY, sessionID TEXT, messageID TEXT, type TEXT, idx INTEGER, data TEXT)',
    'CREATE TABLE session_message(sessionID TEXT, messageID TEXT)'
  ].join(';'))
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
    ZCODE_FIXTURE_ID,
    'Synthetic ZCode UI fixture',
    project,
    'test',
    1784628000000,
    1784628060000
  )
  for (const [id, role, created, text] of [
    ['zcode-user', 'user', 1784628000000, 'Synthetic ZCode UI fixture'],
    ['zcode-assistant', 'assistant', 1784628060000, 'Synthetic response']
  ] as const) {
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
      id,
      ZCODE_FIXTURE_ID,
      JSON.stringify({
        role,
        time: { created },
        ...(includeUnpricedValuationFixture && role === 'assistant'
          ? { model: 'unknown-zcode-model', tokens: { input: 120, output: 30 } }
          : {})
      }),
      role,
      created
    )
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
      `${id}-part`,
      ZCODE_FIXTURE_ID,
      id,
      'text',
      0,
      JSON.stringify({ type: 'text', text })
    )
  }
  db.close()
}

function isolatedEnvironment(
  home: string,
  libraryRoot: string,
  sandboxRoot: string,
  userData: string
): Record<string, string> {
  const environment = {
    ...inheritedE2EEnvironment(),
    HOME: home,
    USERPROFILE: home,
    NODE_ENV: 'test',
    SWOB_TEST_HOME: home,
    SWOB_TEST_LOCALE: 'zh-CN',
    SWOB_E2E_SANDBOX_ROOT: sandboxRoot,
    SWOB_TEST_SYSTEM_TEMP_ROOT: os.tmpdir(),
    SWOB_LIBRARY_ROOT: libraryRoot,
    SWOB_USER_DATA_ROOT: userData,
    XDG_CACHE_HOME: path.join(sandboxRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(sandboxRoot, 'config'),
    TMPDIR: path.join(sandboxRoot, 'tmp')
  }
  isolateE2EProviderHomeEnvironment(environment, sandboxRoot)
  assertE2EProviderHomeEnvironmentIsolated(environment, sandboxRoot)
  return environment
}

export async function launchApp(options: LaunchAppOptions = {}): Promise<LaunchedApp> {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-e2e-'))
  const home = path.join(sandboxRoot, 'home')
  const libraryRoot = path.join(sandboxRoot, 'Library')
  const userData = path.join(sandboxRoot, 'user-data')
  const cache = path.join(sandboxRoot, 'cache')
  const logs = path.join(sandboxRoot, 'logs')
  const temp = path.join(sandboxRoot, 'tmp')
  for (const dir of [home, libraryRoot, userData, cache, logs, temp]) {
    fs.mkdirSync(dir, { recursive: true })
  }
  createSyntheticCorpus(
    home,
    libraryRoot,
    options.claudeTurns ?? 3,
    options.includeCursorFixture ?? false,
    options.includePiFixture ?? false,
    options.includeKimiFixture ?? false,
    options.includeGrokFixture ?? false,
    options.includeQoderFixture ?? false,
    options.includeTraeFixture ?? false,
    options.includeInspectorFixture ?? false,
    options.includePricingFixture ?? false,
    options.includeUnpricedValuationFixture ?? false,
    options.includeCodexLifecycleFixture ?? false
  )

  const environment = {
    ...isolatedEnvironment(home, libraryRoot, sandboxRoot, userData),
    ...options.env,
    HOME: home,
    NODE_ENV: 'test',
    SWOB_TEST_HOME: home,
    SWOB_E2E_SANDBOX_ROOT: sandboxRoot,
    SWOB_USER_DATA_ROOT: userData
  }
  isolateE2EProviderHomeEnvironment(environment, sandboxRoot)
  assertE2EProviderHomeEnvironmentIsolated(environment, sandboxRoot)
  const protectedStateBefore = snapshotProtectedRealState()
  try {
    assertTestLaunchContract(environment, userData, { systemTemporaryRoot: os.tmpdir() })
  } catch (error) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
    throw error
  }

  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      `--disk-cache-dir=${cache}`,
      `--crash-dumps-dir=${logs}`
    ],
    env: environment
  })
  attachProtectedStateAudit(app, protectedStateBefore)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    if (options.viewport) await resizeAppWindow(app, page, options.viewport)
    return { app, page, sandboxRoot, home, libraryRoot, userData }
  } catch (error) {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ])
    try { app.process().kill('SIGKILL') } catch { /* already closed */ }
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
    throw error
  }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  if (!launched) return
  let closeError: unknown
  try {
    await Promise.race([
      launched.app.close(),
      new Promise((resolve) => setTimeout(resolve, 5000))
    ])
  } catch (error) {
    closeError = error
  }
  try { launched.app.process().kill('SIGKILL') } catch { /* already closed */ }
  try {
    verifyProtectedStateAudit(launched.app)
  } catch (error) {
    closeError ||= error
  }
  try {
    fs.rmSync(launched.sandboxRoot, { recursive: true, force: true })
    if (fs.existsSync(launched.sandboxRoot)) {
      throw new Error('Test isolation violation: temporary E2E root was not removed')
    }
  } catch (error) {
    closeError ||= error
  }
  if (closeError) throw closeError
}

export async function revealAllSessions(page: Page): Promise<void> {
  // Root-scatter storage model: loose sessions render flat in the sidebar
  // bottom area. Single-turn sessions collapse into an expandable section.
  const sessions = page.locator('[data-session-id]')
  const singleTurnToggle = page.getByRole('button', { name: /单轮会话|Single-turn/ })
  await Promise.race([
    sessions.first().waitFor({ state: 'visible', timeout: 20_000 }),
    singleTurnToggle.waitFor({ state: 'visible', timeout: 20_000 })
  ])

  let openedCollapsedSection = false
  if (await singleTurnToggle.isVisible().catch(() => false)
    && !await sessions.first().isVisible().catch(() => false)) {
    await singleTurnToggle.click()
    openedCollapsedSection = true
  }
  await sessions.first().waitFor({ state: 'visible', timeout: 20_000 })

  if (!openedCollapsedSection && await singleTurnToggle.isVisible().catch(() => false)) {
    const before = await sessions.count()
    await singleTurnToggle.click()
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-session-id]').length !== count,
      before,
      { timeout: 5_000 }
    ).catch(() => { /* section may be empty */ })
    // Idempotency: a second call would collapse the section again — undo that.
    if (await sessions.count() < before) await singleTurnToggle.click()
  }
}

/** Open a sidebar session and require the user-facing navigation to reach chat. */
export async function openSessionInChat(page: Page, sessionId?: string): Promise<void> {
  await revealAllSessions(page)
  const session = sessionId
    ? page.locator(`[data-session-id="${sessionId}"]`)
    : page.locator('[data-session-id]').first()
  await session.waitFor({ state: 'visible', timeout: 20_000 })
  await session.click()
  await page.getByTestId('chat-scroll').waitFor({ state: 'visible', timeout: 20_000 })
}
