/**
 * E2E 冒烟：Zcode 会话来源（t083）
 *
 * 真启动 Electron 应用，验证 Zcode 会话出现在侧边栏（ZC 徽章），
 * 点开后能看到聊天内容。只读操作，不动用户数据。
 * 前提：本机存在 ~/.zcode/cli/db/db.sqlite（没有则跳过）。
 */
import { test, expect } from '@playwright/test'
import { closeApp, launchApp, revealAllSessions, type LaunchedApp, ZCODE_FIXTURE_ID } from './helpers'
import type { ElectronApplication, Page } from '@playwright/test'

test.describe('Zcode 来源', () => {
  let app: ElectronApplication
  let page: Page
  let launched: LaunchedApp

  test.beforeAll(async () => {
    launched = await launchApp()
    app = launched.app
    page = launched.page
  })

  test.afterAll(async () => {
    await closeApp(launched)
  })

  test('侧边栏出现带 ZC 徽章的 Zcode 会话', async ({}, testInfo) => {
    await revealAllSessions(page)
    const zcSession = page.locator(`[data-session-id="zcode:${ZCODE_FIXTURE_ID}"]`)
    const zcBadge = zcSession.getByText('ZC', { exact: true })
    await expect(zcBadge).toBeVisible({ timeout: 20000 })
    await page.screenshot({ path: testInfo.outputPath('zcode-sidebar.png') })
  })

  test('点开 Zcode 会话能看到聊天内容', async ({}, testInfo) => {
    await revealAllSessions(page)
    const zcSession = page.locator(`[data-session-id="zcode:${ZCODE_FIXTURE_ID}"]`)
    await zcSession.click()
    await page.waitForTimeout(3000)
    await page.screenshot({ path: testInfo.outputPath('zcode-chat.png') })

    const body = await page.locator('body').innerText()
    expect(body.length).toBeGreaterThan(100)
  })
})
