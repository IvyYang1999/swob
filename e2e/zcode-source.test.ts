/**
 * E2E 冒烟：Zcode 会话来源（t083）
 *
 * 真启动 Electron 应用，验证 Zcode 会话出现在侧边栏（ZC 徽章），
 * 点开后能看到聊天内容。只读操作，不动用户数据。
 * 前提：本机存在 ~/.zcode/cli/db/db.sqlite（没有则跳过）。
 */
import { test, expect } from '@playwright/test'
import { launchApp } from './helpers'
import type { ElectronApplication, Page } from '@playwright/test'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const zcodeDbExists = fs.existsSync(path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite'))

test.describe('Zcode 来源', () => {
  test.skip(!zcodeDbExists, '本机未安装 Zcode，跳过')

  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchApp()
    app = launched.app
    page = launched.page
  })

  test.afterAll(async () => {
    // app.close() 会等所有窗口退出；spotlight 常驻窗口会让它挂住，兜底强杀
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))])
    try { app.process().kill('SIGKILL') } catch { /* 已退出 */ }
  })

  test('侧边栏出现带 ZC 徽章的 Zcode 会话', async () => {
    const zcBadge = page.locator('[data-session-id] span', { hasText: /^ZC$/ }).first()
    await expect(zcBadge).toBeVisible({ timeout: 20000 })
    await page.screenshot({ path: 'e2e/screenshots/zcode-sidebar.png' })
  })

  test('点开 Zcode 会话能看到聊天内容', async () => {
    const zcSession = page
      .locator('[data-session-id]')
      .filter({ has: page.locator('span', { hasText: /^ZC$/ }) })
      .first()
    await zcSession.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: 'e2e/screenshots/zcode-chat.png' })

    const body = await page.locator('body').innerText()
    expect(body.length).toBeGreaterThan(100)
  })
})
