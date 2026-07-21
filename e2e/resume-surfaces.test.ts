import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import * as fs from 'node:fs'
import {
  CLAUDE_FIXTURE_ID,
  CODEX_FIXTURE_ID,
  ZCODE_FIXTURE_ID,
  closeApp,
  launchApp,
  resizeAppWindow,
  revealAllSessions,
  type LaunchedApp
} from './helpers'

async function assertMenuFitsViewport(page: Page): Promise<void> {
  const menuBox = await page.getByRole('menu').boundingBox()
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  expect(menuBox).not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.y).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport.width)
  expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport.height)
}

test.describe.serial('多客户端 Resume surfaces', () => {
  let launched: LaunchedApp
  let page: Page

  test.beforeAll(async () => {
<<<<<<< HEAD
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
=======
    launched = await launchApp({ viewport: { width: 1100, height: 720 } })
    page = launched.page
    // Root-scatter model: loose sessions render flat; single-turn ones collapse.
    await revealAllSessions(page)
>>>>>>> origin/master
    await expect(page.locator('[data-session-id]')).toHaveCount(3, { timeout: 20000 })
  })

  test.afterAll(async () => {
    await closeApp(launched)
  })

  test('Codex 菜单显示 Desktop 与终端入口，并在窄窗口内完整可见', async ({}, testInfo) => {
    await page.locator(`[data-session-id="codex:${CODEX_FIXTURE_ID}"]`).click()
    await resizeAppWindow(launched.app, page, { width: 760, height: 520 })
    const [contentBounds, viewport] = await Promise.all([
      launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds()),
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    ])
    expect({ width: contentBounds.width, height: contentBounds.height }).toEqual(viewport)
    await page.getByRole('button', { name: '选择继续方式' }).click()

    await expect(page.getByRole('menuitem', { name: /在 Codex App 中继续/ })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /在终端中继续/ })).toBeVisible()
    await assertMenuFitsViewport(page)
    await page.getByRole('menu').screenshot({ path: testInfo.outputPath('codex-resume-menu.png') })
    const nativePng = await launched.app.evaluate(async ({ BrowserWindow }) => {
      const image = await BrowserWindow.getAllWindows()[0].capturePage()
      return image.toPNG().toString('base64')
    })
    fs.writeFileSync(testInfo.outputPath('native-window-760x520.png'), Buffer.from(nativePng, 'base64'))

    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toBeHidden()
  })

  test('设置页默认关闭 Claude Desktop 实验入口，并显示不可逆风险警告', async ({}, testInfo) => {
    await resizeAppWindow(launched.app, page, { width: 760, height: 520 })
    await page.getByTitle('设置').click()
    await page.getByRole('tab', { name: 'Resume' }).click()

    const toggle = page.getByRole('checkbox', { name: '实验：导入到 Claude Desktop' })
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText(/导入可能修改原始 transcript/)).toBeVisible()
    await toggle.check()
    await expect(toggle).toBeChecked()

<<<<<<< HEAD
    const section = page.getByText('实验：导入到 Claude Desktop').locator('xpath=ancestor::div[contains(@class,"rounded-md")]').first()
    await section.screenshot({ path: path.join(SCREENSHOT_DIR, 'claude-experimental-setting.png') })
=======
    const section = page.getByText('实验：导入到 Claude Desktop').locator('xpath=ancestor::section')
    await section.screenshot({ path: testInfo.outputPath('claude-experimental-setting.png') })
>>>>>>> origin/master

    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('Claude 菜单在开关开启后显示 Desktop 与 Remote Control，点击导入先弹警告', async () => {
    await page.locator(`[data-session-id="${CLAUDE_FIXTURE_ID}"]`).click()
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

  test('ZCode 只提供打开 App，明确提示不能恢复指定会话', async ({}, testInfo) => {
    await page.locator(`[data-session-id="zcode:${ZCODE_FIXTURE_ID}"]`).click()
    await expect(page.getByRole('button', { name: /打开 ZCode$/ })).toBeVisible()
    await expect(page.getByRole('button', { name: '复制命令' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Fork/ })).toBeDisabled()

    await page.getByRole('button', { name: '选择继续方式' }).click()
    await expect(page.getByRole('menuitem', { name: /打开 ZCode App/ })).toContainText(
      'ZCode 当前不支持从外部跳转到指定历史会话'
    )
    await assertMenuFitsViewport(page)
    await page.getByRole('menu').screenshot({ path: testInfo.outputPath('zcode-open-app-menu.png') })
  })
})
