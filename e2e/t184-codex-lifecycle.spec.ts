import { expect, test } from '@playwright/test'
import {
  closeApp,
  launchApp,
  resizeAppWindow,
  revealAllSessions,
  CODEX_LIFECYCLE_ARCHIVED_ID,
  CODEX_LIFECYCLE_PARENT_ID,
  CODEX_LIFECYCLE_REPLAY_ID,
  type LaunchedApp
} from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({
    includeCodexLifecycleFixture: true,
    viewport: { width: 900, height: 700 }
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('archived/custom-home/replay 在真实 UI 可见且窄窗口无横向溢出', async ({}, testInfo) => {
  const { app, page } = launched
  await revealAllSessions(page)

  const archived = page.locator(`[data-session-id="codex:${CODEX_LIFECYCLE_ARCHIVED_ID}"]`)
  const parent = page.locator(`[data-session-id="codex:${CODEX_LIFECYCLE_PARENT_ID}"]`)
  const replay = page.locator(`[data-session-id="codex:${CODEX_LIFECYCLE_REPLAY_ID}"]`)
  await expect(archived).toContainText('T184 archived lifecycle')
  await expect(archived).toContainText('已归档')
  await expect(parent).toContainText('T184 custom root parent')
  await expect(parent.locator('.text-soft-purple')).toContainText('1')
  await expect(replay).toContainText('T184 replay child')
  await expect(replay).toContainText('Replay')

  await archived.hover()
  await page.screenshot({ path: testInfo.outputPath('sidebar-lifecycle-wide.png'), fullPage: true })

  const sidebarMetrics = await archived.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(sidebarMetrics.scrollWidth).toBeLessThanOrEqual(sidebarMetrics.clientWidth + 1)

  await page.getByTitle('设置').click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await expect(dialog).toBeVisible()
  const rootsHeading = dialog.getByText('额外 Codex 根目录')
  await rootsHeading.scrollIntoViewIfNeeded()
  const configuredPath = dialog.locator('code[title$="codex-work"]')
  await expect(configuredPath).toBeVisible()
  const addButton = dialog.getByRole('button', { name: '添加根目录' })
  await addButton.scrollIntoViewIfNeeded()
  await expect(addButton).toBeVisible()

  const removeButton = dialog.locator('button[aria-label^="移除 "]').first()
  await removeButton.hover()
  await dialog.screenshot({ path: testInfo.outputPath('settings-codex-roots-wide.png') })

  await resizeAppWindow(app, page, { width: 520, height: 560 })
  await rootsHeading.scrollIntoViewIfNeeded()
  const content = dialog.locator('[data-settings-category="general"]')
  const narrowMetrics = await content.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    scrollTop: element.scrollTop
  }))
  expect(narrowMetrics.scrollWidth).toBeLessThanOrEqual(narrowMetrics.clientWidth + 1)
  expect(narrowMetrics.scrollHeight).toBeGreaterThan(narrowMetrics.clientHeight)
  expect(narrowMetrics.scrollTop).toBeGreaterThan(0)
  await dialog.screenshot({ path: testInfo.outputPath('settings-codex-roots-narrow.png') })
})
