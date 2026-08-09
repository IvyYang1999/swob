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
  const banner = page.getByTestId('session-bootstrap-banner')

  await expect(banner).toHaveAttribute('data-bootstrap-state', 'source-ready', { timeout: 20_000 })
  await expect(banner).toHaveClass(/text-primary/)
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

test('Library 已 ready 后到达的 Provider 仍会幂等归档', async () => {
  await closeApp(launched)
  launched = await launchApp({
    claudeTurns: 2,
    includePiFixture: true,
    env: { SWOB_TEST_CANONICAL_REFRESH_DELAY_MS: '8000' },
    viewport: { width: 900, height: 680 }
  })
  const { page, libraryRoot } = launched
  const banner = page.getByTestId('session-bootstrap-banner')

  await expect(banner).toHaveAttribute('data-bootstrap-state', 'source-ready', { timeout: 10_000 })
  await expect.poll(async () => {
    const health = await page.evaluate(() => (window as any).api.libraryGetHealth())
    return health.state
  }, { timeout: 6_000 }).toBe('ready')
  expect(canonicalProviderIds(libraryRoot)).not.toContain('swob/pi')

  await expect(banner).toBeHidden({ timeout: 10_000 })
  await expect.poll(() => canonicalProviderIds(libraryRoot), { timeout: 10_000 })
    .toContain('swob/pi')
})

test('初始物理源失败时明确进入 degraded 而不是伪 source-ready', async () => {
  await closeApp(launched)
  launched = await launchApp({
    env: { SWOB_TEST_SESSION_LOAD_FAILURE: '1' },
    viewport: { width: 900, height: 680 }
  })
  const banner = launched.page.getByTestId('session-bootstrap-banner')
  await expect(banner).toHaveAttribute('data-bootstrap-state', 'degraded', { timeout: 10_000 })
  await expect(banner).toBeVisible()
})
