import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { revealAllSessions } from './helpers'

const CLAUDE_ID = '82000000-0000-4000-8000-000000000107'
const CODEX_ID = '019abcde-1234-7000-8000-012345670107'
const ZCODE_ID = 'sess_windows_native_unsupported_107'

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

function createProductionHomeFixture(): { project: string; claudeFile: string } {
  sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-windows-packaged-'))
  fixtureHome = path.join(sandboxRoot, '用户 Home')
  libraryRoot = path.join(sandboxRoot, 'Local Library')
  const project = path.join(fixtureHome, '项目 with space')
  for (const dir of [fixtureHome, libraryRoot, project]) fs.mkdirSync(dir, { recursive: true })

  fs.mkdirSync(path.join(fixtureHome, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(fixtureHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: libraryRoot,
    onboardingCompleted: true
  }), 'utf8')
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: { defaultViewMode: 'compact', defaultTerminalId: 'powershell' }
  }), 'utf8')

  const encodedProject = project.replace(/[:\\/]/g, '-')
  const claudeFile = path.join(fixtureHome, '.claude', 'projects', encodedProject, `${CLAUDE_ID}.jsonl`)
  writeJsonl(claudeFile, [
    {
      uuid: 'windows-native-user', parentUuid: null, sessionId: CLAUDE_ID,
      type: 'user', timestamp: '2026-07-22T00:00:00Z', cwd: project,
      message: { role: 'user', content: 'Windows native Claude fixture' }
    },
    {
      uuid: 'windows-native-assistant', parentUuid: 'windows-native-user', sessionId: CLAUDE_ID,
      type: 'assistant', timestamp: '2026-07-22T00:00:01Z', cwd: project,
      message: { role: 'assistant', content: 'Windows native Claude response' }
    }
  ])

  writeJsonl(path.join(
    fixtureHome, '.codex', 'sessions', '2026', '07', '22',
    `rollout-2026-07-22T00-00-00-${CODEX_ID}.jsonl`
  ), [
    {
      timestamp: '2026-07-22T00:00:00Z', type: 'session_meta',
      payload: { id: CODEX_ID, timestamp: '2026-07-22T00:00:00Z', cwd: project, cli_version: 'native-test' }
    },
    {
      timestamp: '2026-07-22T00:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Windows native Codex fixture' }] }
    },
    {
      timestamp: '2026-07-22T00:00:02Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Native response' }] }
    }
  ])

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
    ZCODE_ID, 'Unsupported native ZCode fixture', project, 'test', 1784678400000, 1784678401000
  )
  db.close()

  return { project, claudeFile }
}

test.beforeAll(async () => {
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
      SWOB_LIBRARY_ROOT: libraryRoot
    },
    timeout: 60_000
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (app) await app.close().catch(() => app.process().kill())
  if (sandboxRoot) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})

test('installed x64 app discovers only supported USERPROFILE sources and renders Windows UI', async ({}, testInfo) => {
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

  const sessions = await page.evaluate(() => window.api.loadAllSessions())
  const claude = sessions.find((session) => session.sessionId === CLAUDE_ID)
  const codex = sessions.find((session) => session.sessionId === CODEX_ID)
  expect(claude?.filePath).toContain(path.win32.join(fixtureHome, '.claude', 'projects'))
  expect(claude?.resumeCwd).toBe(path.win32.join(fixtureHome, '项目 with space'))
  expect(claude?.cwds).toContain(path.win32.join(fixtureHome, '项目 with space'))
  expect(codex?.source).toBe('codex')
  expect(codex?.resumeCwd).toBe(path.win32.join(fixtureHome, '项目 with space'))
  expect(sessions.some((session) => session.source === 'zcode')).toBe(false)

  await revealAllSessions(page)
  await expect(page.locator(`[data-session-id="${CLAUDE_ID}"]`)).toBeVisible()
  await expect(page.locator(`[data-session-id="codex:${CODEX_ID}"]`)).toBeVisible()
  await expect(page.locator(`[data-session-id="zcode:${ZCODE_ID}"]`)).toHaveCount(0)
  await expect(page.getByText('Ctrl+K')).toBeVisible()

  await page.locator('button[title="设置"], button[title="Settings"]').click()
  await page.getByRole('button', { name: /^(终端|Terminal)$/ }).click()
  await expect(page.locator('[data-testid="windows-alpha-notice"]')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Windows Terminal' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'PowerShell' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^cmd\b/ })).toBeVisible()
  await expect(page.getByText('iTerm')).toHaveCount(0)

  await expect.poll(() => page.evaluate(() => window.api.libraryGetRoot()), { timeout: 20_000 })
    .toBe(libraryRoot)
  await expect.poll(() => page.evaluate((id) => window.api.libraryGetDirPath(id), CLAUDE_ID), { timeout: 20_000 })
    .not.toBeNull()

  await page.screenshot({ path: testInfo.outputPath('windows-native-installed.png'), fullPage: true })
})
