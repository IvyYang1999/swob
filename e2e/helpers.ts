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
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      ...options.env,
      NODE_ENV: 'test'
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

export interface LaunchAppOptions {
  claudeTurns?: number
  viewport?: { width: number; height: number }
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

function createSyntheticCorpus(home: string, libraryRoot: string, claudeTurns: number): void {
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })

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
      timestamp: new Date(Date.UTC(2026, 6, 21, 10, 0, index * 2 + 1)).toISOString(),
      cwd: project,
      message: {
        role: 'assistant',
        content: `Synthetic response ${index} ${'fixture '.repeat(12)}`
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
      }
    ]
  )

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
  createSyntheticCorpus(home, libraryRoot, options.claudeTurns ?? 3)

  const app = await electron.launch({
    args: [
      path.join(__dirname, '..', 'out', 'main', 'index.js'),
      `--user-data-dir=${userData}`,
      `--disk-cache-dir=${cache}`,
      `--crash-dumps-dir=${logs}`
    ],
    env: isolatedEnvironment(home, libraryRoot, sandboxRoot)
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
  const sessions = page.locator('[data-session-id]')
  const group = page.getByRole('button', { name: /AI会话\(3\)/ })
  await group.waitFor({ state: 'visible', timeout: 20_000 })
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await sessions.first().isVisible().catch(() => false)) return
    await group.click()
    try {
      await sessions.first().waitFor({ state: 'visible', timeout: 2_000 })
      return
    } catch {
      // Startup hydration can replace the Library tree after the first click.
      // Retry against the newly rendered group instead of assuming it stayed open.
    }
  }
  await sessions.first().waitFor({ state: 'visible', timeout: 20_000 })
}
