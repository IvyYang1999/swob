import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { revealAllSessions } from './helpers'

const CLAUDE_ID = '82000000-0000-4000-8000-000000000178'
const CODEX_ID = '019abcde-1234-7000-8000-012345670178'
const ZCODE_ID = 'sess_windows_native_unsupported_178'

let app: ElectronApplication
let page: Page
let sandboxRoot = ''
let fixtureHome = ''
let libraryRoot = ''

test.skip(process.platform !== 'win32', 'Runs only on a native Windows runner')
test.skip(!process.env.SWOB_PACKAGED_EXE, 'Requires the installed NSIS package path')

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

function stringEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function createProductionHomeFixture(): { project: string } {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-windows-beta-packaged-'))
  fixtureHome = path.join(sandboxRoot, '用户 Home')
  libraryRoot = path.join(fixtureHome, 'Local Library')
  const project = path.join(fixtureHome, '项目 with space')
  for (const dir of [fixtureHome, libraryRoot, project]) fs.mkdirSync(dir, { recursive: true })

  const encodedProject = project.replace(/[:\\/]/g, '-')
  writeJsonl(path.join(fixtureHome, '.claude', 'projects', encodedProject, `${CLAUDE_ID}.jsonl`), [
    {
      uuid: 'windows-native-user', parentUuid: null, sessionId: CLAUDE_ID,
      type: 'user', timestamp: '2026-08-02T00:00:00Z', cwd: project,
      message: { role: 'user', content: 'Windows native Claude reading fixture' }
    },
    {
      uuid: 'windows-native-assistant', parentUuid: 'windows-native-user', sessionId: CLAUDE_ID,
      type: 'assistant', timestamp: '2026-08-02T00:00:01Z', cwd: project,
      message: { role: 'assistant', content: 'Windows native Claude response' }
    }
  ])

  writeJsonl(path.join(
    fixtureHome, '.codex', 'sessions', '2026', '08', '02',
    `rollout-2026-08-02T00-00-00-${CODEX_ID}.jsonl`
  ), [
    {
      timestamp: '2026-08-02T00:00:00Z', type: 'session_meta',
      payload: { id: CODEX_ID, timestamp: '2026-08-02T00:00:00Z', cwd: project, cli_version: 'native-test' }
    },
    {
      timestamp: '2026-08-02T00:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Windows native Codex search needle' }] }
    },
    {
      timestamp: '2026-08-02T00:00:02Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native Codex response' }] }
    },
    {
      timestamp: '2026-08-02T00:00:03Z', type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 },
          total_token_usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 40 }
        }
      }
    }
  ])

  // A real unsupported-source fixture proves that the Beta boundary is enforced
  // by source discovery rather than merely hidden in the renderer.
  const dbPath = path.join(fixtureHome, '.zcode', 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  db.exec([
    'CREATE TABLE session(id TEXT PRIMARY KEY, title TEXT, directory TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)',
    'CREATE TABLE message(id TEXT PRIMARY KEY, sessionID TEXT, data TEXT, role TEXT, time_created INTEGER)',
    'CREATE TABLE part(id TEXT PRIMARY KEY, sessionID TEXT, messageID TEXT, type TEXT, idx INTEGER, data TEXT)',
    'CREATE TABLE session_message(sessionID TEXT, messageID TEXT)'
  ].join(';'))
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)').run(
    ZCODE_ID, 'Unsupported native ZCode fixture', project, 'test', 1785628800000, 1785628801000
  )
  db.close()

  return { project }
}

test.beforeAll(async () => {
  test.setTimeout(90_000)
  const executablePath = process.env.SWOB_PACKAGED_EXE!
  expect(fs.existsSync(executablePath)).toBe(true)
  createProductionHomeFixture()
  const userData = path.join(sandboxRoot, 'user-data')
  const temp = path.join(sandboxRoot, 'temp')
  const appData = path.join(fixtureHome, 'AppData', 'Roaming')
  const localAppData = path.join(fixtureHome, 'AppData', 'Local')
  for (const dir of [userData, temp, appData, localAppData]) fs.mkdirSync(dir, { recursive: true })

  app = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`, `--disk-cache-dir=${path.join(sandboxRoot, 'cache')}`],
    env: {
      ...stringEnvironment(),
      NODE_ENV: 'production',
      HOME: path.join(sandboxRoot, 'wrong-git-bash-home'),
      USERPROFILE: fixtureHome,
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
      TEMP: temp,
      TMP: temp,
      SWOB_TEST_HOME: fixtureHome,
      SWOB_E2E_SANDBOX_ROOT: sandboxRoot,
      SWOB_LIBRARY_ROOT: libraryRoot,
      ELECTRON_ENABLE_LOGGING: '1'
    },
    timeout: 60_000
  })
  page = await app.firstWindow({ timeout: 60_000 })
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1200, height: 800 })
})

test.afterAll(async () => {
  if (app) await app.close().catch(() => app.process().kill())
  if (sandboxRoot) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('installed x64 Beta completes onboarding, discovery, reading, search, Insights and settings', async ({}, testInfo) => {
  test.setTimeout(120_000)

  const runtime = await app.evaluate(({ app: electronApp }) => ({
    isPackaged: electronApp.isPackaged,
    platform: process.platform,
    arch: process.arch,
    userProfile: process.env.USERPROFILE,
    home: process.env.HOME
  }))
  expect(runtime).toEqual({
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    userProfile: fixtureHome,
    home: path.join(sandboxRoot, 'wrong-git-bash-home')
  })

  const capabilities = await page.evaluate(() => window.api.platformGetCapabilities())
  expect(capabilities.windowsNativeAlpha).toBe(true)
  expect(capabilities.supportedSources).toEqual(['claude-code', 'codex'])

  // 1. Onboarding: exercise the real first-run flow and capture the source boundary.
  const onboarding = page.locator('[data-testid="onboarding"]')
  await expect(onboarding).toBeVisible({ timeout: 20_000 })
  await onboarding.getByRole('button', { name: /开始设置|Get started/ }).click()
  await onboarding.getByRole('button', { name: /都要|Both/ }).click()
  await onboarding.getByRole('button', { name: /就放这里|Use this/ }).click()
  await expect(onboarding.getByText('Claude Code', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(onboarding.getByText('Codex', { exact: true })).toBeVisible()
  await expect(onboarding.locator('[data-testid="windows-alpha-notice"]')).toContainText('Windows Native Beta')
  await page.screenshot({ path: testInfo.outputPath('01-onboarding.png'), fullPage: true })
  await onboarding.getByRole('button', { name: /^完成$|^Finish$/ }).click()
  await expect(onboarding).toHaveCount(0, { timeout: 30_000 })

  // 2. Discovery: both allowed sources are visible and the unsupported fixture is absent.
  const sessions = await page.evaluate(() => window.api.loadAllSessions())
  const claude = sessions.find((session) => session.sessionId === CLAUDE_ID)
  const codex = sessions.find((session) => session.sessionId === CODEX_ID)
  expect(claude?.filePath).toContain(path.win32.join(fixtureHome, '.claude', 'projects'))
  expect(claude?.resumeCwd).toBe(path.win32.join(fixtureHome, '项目 with space'))
  expect(codex?.source).toBe('codex')
  expect(codex?.resumeCwd).toBe(path.win32.join(fixtureHome, '项目 with space'))
  expect(sessions.some((session) => session.source === 'zcode')).toBe(false)

  await revealAllSessions(page)
  await expect(page.locator(`[data-session-id="${CLAUDE_ID}"]`)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator(`[data-session-id="codex:${CODEX_ID}"]`)).toBeVisible()
  await expect(page.locator(`[data-session-id="zcode:${ZCODE_ID}"]`)).toHaveCount(0)
  await expect(page.getByText('Ctrl+K')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('02-discovery.png'), fullPage: true })

  // 3. Reading: open a real packaged Claude transcript and prove both roles render.
  await page.locator(`[data-session-id="${CLAUDE_ID}"]`).click()
  await expect(page.getByText('Windows native Claude reading fixture', { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Windows native Claude response', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('03-reading.png'), fullPage: true })

  // 4. Search: wait for the incremental SQLite index and require the Codex body hit.
  const search = page.getByPlaceholder(/搜索所有会话|Search all sessions/)
  await search.fill('Windows native Codex search needle')
  await expect(page.getByText('Windows native Codex search needle', { exact: true }).first())
    .toBeVisible({ timeout: 30_000 })
  await page.screenshot({ path: testInfo.outputPath('04-search.png'), fullPage: true })
  await search.fill('')

  // 5. Insights: enter the actual packaged dashboard and wait for its first tab.
  await page.getByTitle(/Token 洞察|Token Insights/).click()
  await expect(page.getByRole('tab', { name: /总览|Overview/ })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText(/Processed Tokens/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('05-insights.png'), fullPage: true })

  // 6. Settings: prove the Beta boundary and Windows terminal choices are visible.
  await page.locator('button[title="设置"], button[title="Settings"]').click()
  const settings = page.getByRole('dialog', { name: /设置|Settings/ })
  await expect(settings).toBeVisible()
  await settings.getByRole('button', { name: /^(终端|Terminal)$/ }).click()
  await expect(settings.locator('[data-testid="windows-alpha-notice"]')).toContainText('Windows Native Beta')
  await expect(settings.getByRole('button', { name: 'Windows Terminal' })).toBeVisible()
  await expect(settings.getByRole('button', { name: 'PowerShell' })).toBeVisible()
  await expect(settings.getByRole('button', { name: /^cmd\b/ })).toBeVisible()
  await expect(settings.getByText('iTerm')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('06-settings.png'), fullPage: true })

  await expect.poll(() => page.evaluate(() => window.api.libraryGetRoot()), { timeout: 20_000 })
    .toBe(libraryRoot)
  await expect.poll(() => page.evaluate((id) => window.api.libraryGetDirPath(id), CLAUDE_ID), { timeout: 20_000 })
    .not.toBeNull()
})
