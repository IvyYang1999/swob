import { test, expect, _electron as electron } from '@playwright/test'
import Database from 'better-sqlite3'
import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const CLAUDE_ID = '82000000-0000-4000-8000-000000000098'
const CODEX_ID = '019abcde-1234-7000-8000-012345670098'
const ZCODE_ID = 'sess_ZcodeUI098'
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'swob-t098-ui-artifacts')

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
}

function createSyntheticHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t098-home-'))
  const project = path.join(home, 'project')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, 'Documents', 'Swob'), { recursive: true })

  writeJsonl(path.join(home, '.claude', 'projects', '-synthetic-project', `${CLAUDE_ID}.jsonl`), [
    {
      uuid: 'claude-user',
      parentUuid: null,
      sessionId: CLAUDE_ID,
      type: 'user',
      timestamp: '2026-07-21T10:00:00Z',
      cwd: project,
      message: { role: 'user', content: 'Synthetic Claude UI fixture' }
    },
    {
      uuid: 'claude-assistant',
      parentUuid: 'claude-user',
      sessionId: CLAUDE_ID,
      type: 'assistant',
      timestamp: '2026-07-21T10:01:00Z',
      cwd: project,
      message: { role: 'assistant', content: 'Synthetic response' }
    }
  ])

  writeJsonl(
    path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '07',
      '21',
      `rollout-2026-07-21T10-00-00-${CODEX_ID}.jsonl`
    ),
    [
      {
        timestamp: '2026-07-21T10:00:00Z',
        type: 'session_meta',
        payload: { id: CODEX_ID, timestamp: '2026-07-21T10:00:00Z', cwd: project, cli_version: 'test' }
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
    ZCODE_ID,
    'Synthetic ZCode UI fixture',
    project,
    'test',
    1784628000000,
    1784628060000
  )
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'zcode-user',
    ZCODE_ID,
    JSON.stringify({ role: 'user', time: { created: 1784628000000 } }),
    'user',
    1784628000000
  )
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
    'zcode-assistant',
    ZCODE_ID,
    JSON.stringify({ role: 'assistant', time: { created: 1784628060000 } }),
    'assistant',
    1784628060000
  )
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'zcode-user-part',
    ZCODE_ID,
    'zcode-user',
    'text',
    0,
    JSON.stringify({ type: 'text', text: 'Synthetic ZCode UI fixture' })
  )
  db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
    'zcode-assistant-part',
    ZCODE_ID,
    'zcode-assistant',
    'text',
    0,
    JSON.stringify({ type: 'text', text: 'Synthetic response' })
  )
  db.close()

  return home
}

async function assertMenuFitsViewport(page: Page): Promise<void> {
  const menuBox = await page.getByRole('menu').boundingBox()
  const viewport = page.viewportSize()
  expect(menuBox).not.toBeNull()
  expect(viewport).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.y).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport!.width)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height)
}

test.describe.serial('多客户端 Resume surfaces', () => {
  let app: ElectronApplication
  let page: Page
  let syntheticHome: string

  test.beforeAll(async () => {
    syntheticHome = createSyntheticHome()
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })
    app = await electron.launch({
      args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        HOME: syntheticHome,
        NODE_ENV: 'test'
      }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.setViewportSize({ width: 1100, height: 720 })
    const allSessionsGroup = page.getByRole('button', { name: /AI会话\(3\)/ })
    await expect(allSessionsGroup).toBeVisible({ timeout: 20000 })
    await allSessionsGroup.click()
    await expect(page.locator('[data-session-id]')).toHaveCount(3, { timeout: 20000 })
  })

  test.afterAll(async () => {
    if (app) {
      await Promise.race([app.close(), new Promise((resolve) => setTimeout(resolve, 5000))])
      try { app.process().kill('SIGKILL') } catch { /* already closed */ }
    }
    if (syntheticHome) fs.rmSync(syntheticHome, { recursive: true, force: true })
  })

  test('Codex 菜单显示 Desktop 与终端入口，并在窄窗口内完整可见', async () => {
    await page.locator(`[data-session-id="codex:${CODEX_ID}"]`).click()
    await page.setViewportSize({ width: 760, height: 520 })
    await page.getByRole('button', { name: '选择继续方式' }).click()

    await expect(page.getByRole('menuitem', { name: /在 Codex App 中继续/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /在终端中继续/ })).toBeVisible()
    await assertMenuFitsViewport(page)
    await page.getByRole('menu').screenshot({ path: path.join(SCREENSHOT_DIR, 'codex-resume-menu.png') })

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
  })

  test('设置页默认关闭 Claude Desktop 实验入口，并显示不可逆风险警告', async () => {
    await page.setViewportSize({ width: 760, height: 520 })
    await page.getByTitle('设置').click()
    await page.getByRole('button', { name: /终端与 Resume/ }).click()

    const toggle = page.getByRole('checkbox', { name: '实验：导入到 Claude Desktop' })
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText(/导入可能修改原始 transcript/)).toBeVisible()
    await toggle.check()
    await expect(toggle).toBeChecked()

    const section = page.getByText('实验：导入到 Claude Desktop').locator('xpath=ancestor::section')
    await section.screenshot({ path: path.join(SCREENSHOT_DIR, 'claude-experimental-setting.png') })

    await page.locator('.fixed.inset-0.z-50 .border-b button').click()
  })

  test('Claude 菜单在开关开启后显示 Desktop 与 Remote Control，点击导入先弹警告', async () => {
    await page.locator(`[data-session-id="${CLAUDE_ID}"]`).click()
    await page.getByRole('button', { name: '选择继续方式' }).click()

    await expect(page.getByRole('menuitem', { name: /导入到 Claude Desktop/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /在网页\/手机中继续/ })).toBeVisible()
    await assertMenuFitsViewport(page)

    let warning = ''
    page.once('dialog', async (dialog) => {
      warning = dialog.message()
      await dialog.dismiss()
    })
    await page.getByRole('menuitem', { name: /导入到 Claude Desktop/ }).click()
    expect(warning).toContain('可能改写原始 transcript')
    expect(warning).toContain('thinking')
  })

  test('ZCode 只提供打开 App，明确提示不能恢复指定会话', async () => {
    await page.locator(`[data-session-id="zcode:${ZCODE_ID}"]`).click()
    await expect(page.getByRole('button', { name: /打开 ZCode$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '复制命令' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Fork/ })).toBeDisabled()

    await page.getByRole('button', { name: '选择继续方式' }).click()
    await expect(page.getByRole('menuitem', { name: /打开 ZCode App/ })).toContainText(
      'ZCode 当前不支持从外部跳转到指定历史会话'
    )
    await assertMenuFitsViewport(page)
    await page.getByRole('menu').screenshot({ path: path.join(SCREENSHOT_DIR, 'zcode-open-app-menu.png') })
  })
})
