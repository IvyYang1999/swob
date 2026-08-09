import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeApp, launchApp, resizeAppWindow, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({
    claudeTurns: 4,
    additionalClaudeSessions: 1_497,
    includePiFixture: true,
    env: { SWOB_TEST_CANONICAL_REFRESH_DELAY_MS: '5000' },
    viewport: { width: 1180, height: 780 }
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('旧源先显示，慢 Provider 刷新只能增量增加会话', async ({}, testInfo) => {
  const { app, page, home } = launched
  const banner = page.getByTestId('session-bootstrap-banner')

  await expect(banner).toHaveAttribute('data-bootstrap-state', 'source-ready', { timeout: 20_000 })
  await expect(page.getByText(/1500 个会话 ·|1500 sessions ·/)).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('source-ready.png'), fullPage: false })

  await resizeAppWindow(app, page, { width: 720, height: 640 })
  await expect(banner).toBeVisible()
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('source-ready-narrow.png'), fullPage: false })

  await expect(banner).toBeHidden({ timeout: 15_000 })
  await expect(page.getByText(/1501 个会话 ·|1501 sessions ·/)).toBeVisible()
  expect(fs.existsSync(path.join(home, '.claude-session-manager', 'summary-cache.sqlite'))).toBe(true)
  expect(fs.existsSync(path.join(home, '.claude-session-manager', 'summary-cache.json'))).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('provider-complete.png'), fullPage: false })
})
