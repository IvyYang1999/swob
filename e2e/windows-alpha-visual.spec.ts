import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({
    viewport: { width: 1000, height: 700 },
    env: { SWOB_TEST_PLATFORM: 'win32' }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test('Windows Alpha 设置边界、终端状态和窄窗口布局可见', async ({}, testInfo) => {
  const { page } = launched
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('Ctrl+K')).toBeVisible()

  await page.locator('button[title="设置"]').click()
  await page.getByRole('button', { name: '终端', exact: true }).click()

  const notice = page.locator('[data-testid="windows-alpha-notice"]')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Claude Code、Codex')
  await expect(notice).toContainText('Cursor、OpenCode、ZCode')
  await expect(page.getByRole('button', { name: 'Windows Terminal' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'PowerShell' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^cmd\b/ })).toBeVisible()
  await expect(page.getByText('iTerm')).toHaveCount(0)

  await page.getByRole('button', { name: 'PowerShell' }).hover()
  await page.screenshot({ path: testInfo.outputPath('windows-alpha-terminal.png') })

  const panel = page.getByText('设置', { exact: true }).locator('..').locator('..')
  const panelBox = await panel.boundingBox()
  const noticeBox = await notice.boundingBox()
  expect(panelBox).not.toBeNull()
  expect(noticeBox).not.toBeNull()
  expect(noticeBox!.x).toBeGreaterThanOrEqual(panelBox!.x)
  expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width)

  await page.getByRole('button', { name: '更新', exact: true }).click()
  await expect(page.getByText(/Windows Alpha 不提供自动更新/)).toBeVisible()
  await expect(page.getByRole('button', { name: '检查更新' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('windows-alpha-updates.png') })
})
