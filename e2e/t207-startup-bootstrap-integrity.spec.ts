import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeApp, launchApp, resizeAppWindow, type LaunchedApp } from './helpers'

let launched: LaunchedApp

function canonicalProviderIds(libraryRoot: string): string[] {
  const ids: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(candidate)
      if (!entry.isFile() || entry.name !== '.swob-session.json') continue
      const metadata = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        canonicalProvider?: { providerId?: string }
      }
      if (metadata.canonicalProvider?.providerId) ids.push(metadata.canonicalProvider.providerId)
    }
  }
  visit(libraryRoot)
  return ids.sort()
}

test.describe.configure({ mode: 'serial' })

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

  await expect(page.getByText(/1500 个会话 ·|1500 sessions ·/)).toBeVisible()
  await expect(page.getByTestId('session-bootstrap-banner')).toHaveCount(0)
  await expect(page.getByTestId('library-health-banner')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('source-ready.png'), fullPage: false })

  await resizeAppWindow(app, page, { width: 720, height: 640 })
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('source-ready-narrow.png'), fullPage: false })

  await expect(page.getByText(/1501 个会话 ·|1501 sessions ·/)).toBeVisible()
  expect(fs.existsSync(path.join(home, '.claude-session-manager', 'summary-cache.sqlite'))).toBe(true)
  expect(fs.existsSync(path.join(home, '.claude-session-manager', 'summary-cache.json'))).toBe(false)
  await page.screenshot({ path: testInfo.outputPath('provider-complete.png'), fullPage: false })
})

test('Library 已 ready 后到达的 Provider 仍会幂等归档', async () => {
  await closeApp(launched)
  launched = await launchApp({
    claudeTurns: 2,
    includePiFixture: true,
    env: { SWOB_TEST_CANONICAL_REFRESH_DELAY_MS: '8000' },
    viewport: { width: 900, height: 680 }
  })
  const { page, libraryRoot } = launched

  await expect(page.getByTestId('session-bootstrap-banner')).toHaveCount(0)
  await expect(page.getByTestId('library-health-banner')).toHaveCount(0)
  await expect.poll(async () => {
    const health = await page.evaluate(() => (window as any).api.libraryGetHealth())
    return health.state
  }, { timeout: 6_000 }).toBe('ready')
  expect(canonicalProviderIds(libraryRoot)).not.toContain('swob/pi')

  await expect.poll(() => canonicalProviderIds(libraryRoot), { timeout: 10_000 })
    .toContain('swob/pi')
})

test('初始物理源失败不占据主界面，但 Debug Mode 保留 degraded 证据', async ({}, testInfo) => {
  await closeApp(launched)
  launched = await launchApp({
    env: { SWOB_TEST_SESSION_LOAD_FAILURE: '1' },
    viewport: { width: 900, height: 680 }
  })
  const { page } = launched
  await expect(page.getByTestId('session-bootstrap-banner')).toHaveCount(0)
  await expect(page.getByTestId('library-health-banner')).toHaveCount(0)
  await page.getByTitle(/设置|Settings/).click()
  await page.getByRole('navigation', { name: /设置分类|Settings categories/ })
    .getByRole('button', { name: /诊断与修复|Diagnostics & Repair/ }).click()
  await page.getByRole('checkbox', { name: 'Debug Mode' }).check()
  await expect(page.getByTestId('diagnostics-raw')).toContainText('"sessionBootstrapState": "degraded"')
  await page.getByRole('dialog').screenshot({ path: testInfo.outputPath('degraded-debug-mode.png') })
})
