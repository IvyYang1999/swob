import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const CLAUDE_FIXTURE_ID = '82000000-0000-4000-8000-000000000099'
export const CODEX_FIXTURE_ID = '019abcde-1234-7000-8000-012345670099'
export const ZCODE_FIXTURE_ID = 'sess_ZcodeUI099'

/**
 * Legacy launcher for specs that manage their own fixture HOME and inspect it
 * after the app closes (onboarding, vault-lens, visual capture). New specs
 * should prefer the fully sandboxed launchApp below.
 */
export async function launchAppWithEnv(options: { env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const testHome = options.env?.SWOB_TEST_HOME || options.env?.HOME
  if (!testHome) throw new Error('launchAppWithEnv requires an isolated HOME or SWOB_TEST_HOME')
  const userData = path.join(testHome, '.swob-e2e-user-data')
  const cache = path.join(testHome, '.swob-e2e-cache')
  fs.mkdirSync(userData, { recursive: true })
  fs.mkdirSync(cache, { recursive: true })
  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      `--disk-cache-dir=${cache}`
    ],
    env: {
      ...process.env,
      SWOB_TEST_LOCALE: 'zh-CN',
      ...options.env,
      NODE_ENV: 'test',
      SWOB_TEST_HOME: options.env?.SWOB_TEST_HOME || options.env?.HOME || ''
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export interface LaunchAppOptions {
  claudeTurns?: number
  viewport?: { width: number; height: number }
  includeCursorFixture?: boolean
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

function createSyntheticCorpus(home: string, libraryRoot: string, claudeTurns: number, includeCursorFixture = false): void {
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })

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
        content: `Synthetic response ${index} ${'fixture '.repeat(12)}`,
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
      JSON.stringify({ role, time: { created } }),
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

function isolatedEnvironment(home: string, libraryRoot: string, sandboxRoot: string): Record<string, string> {
  const inherited: Record<string, string> = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'LOGNAME']) {
    const value = process.env[name]
    if (value) inherited[name] = value
  }
  return {
    ...inherited,
    HOME: home,
    NODE_ENV: 'test',
    SWOB_TEST_HOME: home,
    SWOB_TEST_LOCALE: 'zh-CN',
    SWOB_LIBRARY_ROOT: libraryRoot,
    XDG_CACHE_HOME: path.join(sandboxRoot, 'cache'),
    XDG_CONFIG_HOME: path.join(sandboxRoot, 'config'),
    TMPDIR: path.join(sandboxRoot, 'tmp')
  }
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
  createSyntheticCorpus(home, libraryRoot, options.claudeTurns ?? 3, options.includeCursorFixture ?? false)

  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      `--disk-cache-dir=${cache}`,
      `--crash-dumps-dir=${logs}`
    ],
    env: { ...isolatedEnvironment(home, libraryRoot, sandboxRoot), ...options.env }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  if (options.viewport) await resizeAppWindow(app, page, options.viewport)
  return { app, page, sandboxRoot, home, libraryRoot, userData }
}

export async function closeApp(launched: LaunchedApp): Promise<void> {
  await Promise.race([
    launched.app.close(),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ])
  try { launched.app.process().kill('SIGKILL') } catch { /* already closed */ }
  fs.rmSync(launched.sandboxRoot, { recursive: true, force: true })
}

export async function revealAllSessions(page: Page): Promise<void> {
  // Root-scatter storage model: loose sessions render flat in the sidebar
  // bottom area. Single-turn sessions collapse into an expandable section.
  const sessions = page.locator('[data-session-id]')
  const singleTurnToggle = page.getByRole('button', { name: /单轮对话/ })
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
