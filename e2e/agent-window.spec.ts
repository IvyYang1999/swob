import { test, expect, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({ claudeTurns: 2 })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('工具栏入口打开 Swob 助手悬浮窗', async () => {
  const windowPromise = launched.app.waitForEvent('window', { timeout: 15000 })
  await launched.page.getByTitle(/Swob 助手/).click()
  const agentPage: Page = await windowPromise

  await expect(agentPage.getByText('Swob 助手').first()).toBeVisible({ timeout: 15000 })
  // Either the engine banner (sandbox has no claude on PATH) or the empty-state prompt shows.
  await expect(
    agentPage.getByText(/问我任何关于你的 AI 会话历史|未检测到 Claude Code CLI|引擎不可用/).first()
  ).toBeVisible()
  await expect(agentPage.getByRole('button', { name: '发送' })).toBeVisible()

  // Hide via titlebar button keeps the process alive (window is reused).
  await agentPage.getByTitle(/隐藏/).click()
})
