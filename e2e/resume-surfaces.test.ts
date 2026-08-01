import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import * as fs from 'node:fs'
import {
  CLAUDE_FIXTURE_ID,
  CODEX_FIXTURE_ID,
  ZCODE_FIXTURE_ID,
  closeApp,
  launchApp,
  openSessionInChat,
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

async function openNarrowResumeMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: /更多操作|More actions/ }).click()
}

test.describe.serial('多客户端 Resume surfaces', () => {
  let launched: LaunchedApp
  let page: Page

  test.beforeAll(async () => {
    launched = await launchApp({ viewport: { width: 1100, height: 720 } })
    page = launched.page
    // Root-scatter model: loose sessions render flat; single-turn ones collapse.
    await revealAllSessions(page)
    await expect.poll(async () => page.locator('[data-session-id]').evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-session-id')).filter(Boolean).sort()
    ), { timeout: 20000 }).toEqual([
      CLAUDE_FIXTURE_ID,
      `codex:${CODEX_FIXTURE_ID}`,
      `zcode:${ZCODE_FIXTURE_ID}`
    ].sort())
  })

  test.afterAll(async () => {
    await closeApp(launched)
  })

  test('Codex 菜单显示 Desktop 与终端入口，并在窄窗口内完整可见', async ({}, testInfo) => {
    await openSessionInChat(page, `codex:${CODEX_FIXTURE_ID}`)
    await resizeAppWindow(launched.app, page, { width: 760, height: 520 })
    const [contentBounds, viewport] = await Promise.all([
      launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds()),
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
    ])
    expect({ width: contentBounds.width, height: contentBounds.height }).toEqual(viewport)
    await openNarrowResumeMenu(page)

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
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '继续' }).click()

    const toggle = page.getByRole('checkbox', { name: '实验：导入到 Claude Desktop' })
    await expect(toggle).not.toBeChecked()
    await expect(page.getByText(/导入可能修改原始 transcript/)).toBeVisible()
    await toggle.check()
    await expect(toggle).toBeChecked()
    await expect.poll(async () => page.evaluate(async () =>
      (await window.api.loadConfig()).preferences?.experimentalClaudeDesktopImport
    )).toBe(true)

    const section = page.getByText('实验：导入到 Claude Desktop').locator('xpath=ancestor::div[contains(@class,"rounded-md")]').first()
    await section.screenshot({ path: testInfo.outputPath('claude-experimental-setting.png') })

    await page.getByRole('button', { name: '关闭设置' }).click()
  })

  test('Claude 菜单在开关开启后显示 Desktop 与 Remote Control，点击导入先弹警告', async () => {
    await openSessionInChat(page, CLAUDE_FIXTURE_ID)
    await openNarrowResumeMenu(page)

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
    await openSessionInChat(page, `zcode:${ZCODE_FIXTURE_ID}`)
    // chat-scroll remains mounted across session switches; wait for the new
    // detail instead of racing its async load with the overflow-menu click.
    await expect(page.getByText('Synthetic response', { exact: true })).toBeVisible()
    await openNarrowResumeMenu(page)
    const menu = page.getByRole('menu')
    await expect(menu.getByRole('menuitem', { name: /打开 ZCode App/ })).toContainText(
      'ZCode 当前不支持从外部跳转到指定历史会话'
    )
    await expect(menu.getByRole('menuitem', { name: /复制.*命令|Copy.*command/ })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /Fork/ })).toHaveCount(0)
    await assertMenuFitsViewport(page)
    await page.getByRole('menu').screenshot({ path: testInfo.outputPath('zcode-open-app-menu.png') })
  })
})
