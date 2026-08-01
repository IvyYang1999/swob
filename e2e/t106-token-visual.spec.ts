import { expect, test } from '@playwright/test'
import { closeApp, launchApp, openSessionInChat, resizeAppWindow, revealAllSessions, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({ viewport: { width: 1200, height: 760 }, includeCursorFixture: true })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('Token Insights 在真实 Electron 窗口展示统一口径与 unavailable', async ({}, testInfo) => {
  const { app, page } = launched
  await page.getByTitle('Token 洞察').click()
  await page.getByRole('button', { name: /^(全部|All)$/ }).click()
  await expect(page.getByText('Processed Tokens', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: /^全部$|^All$/ }).click()
  await expect(page.getByText('2 with usage · 2 unavailable', { exact: true })).toBeVisible()
  await expect(page.getByText('Cursor', { exact: true })).toBeVisible()
  await expect(page.getByText('Unavailable', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/缓存分桶互斥|cache components are mutually exclusive/)).toBeVisible()

  const processedCard = page.getByText('Processed Tokens', { exact: true }).first().locator('..')
  await processedCard.hover()
  await expect(processedCard).toHaveAttribute('title', /non-cached input \+ cache read \+ cache write \+ output/)
  await page.screenshot({ path: testInfo.outputPath('token-insights-wide.png'), fullPage: true })

  await page.getByRole('button', { name: '7d', exact: true }).click()
  await resizeAppWindow(app, page, { width: 760, height: 620 })
  await expect(page.getByText('Processed Tokens', { exact: true }).first()).toBeVisible()
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
  const heatmapScroller = page.getByText(/Token 热力图|Token Heatmap/).locator('../..').locator('div.relative.overflow-x-auto')
  await expect(heatmapScroller).toBeVisible()
  const horizontalScroll = await heatmapScroller.evaluate((element) => {
    const before = element.scrollLeft
    element.scrollLeft = element.scrollWidth
    return { before, after: element.scrollLeft, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
  })
  expect(await heatmapScroller.locator('[data-heatmap-day]').count()).toBe(7)
  expect(horizontalScroll.scrollWidth).toBeLessThanOrEqual(horizontalScroll.clientWidth + 1)
  expect(Math.abs(horizontalScroll.after - horizontalScroll.before)).toBeLessThanOrEqual(1)
  const bySource = page.getByText(/按来源|By Source/)
  await bySource.scrollIntoViewIfNeeded()
  await expect(bySource).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('token-insights-narrow.png'), fullPage: true })
})

test('Cursor session 信息面板明确显示 Token 不可用', async () => {
  const { page } = launched
  await page.getByTitle('Token 洞察').click()
  await revealAllSessions(page)
  const cursorSession = page.locator('[data-session-id]').filter({ hasText: 'Cursor token unavailable fixture' }).first()
  await expect(cursorSession).toBeVisible({ timeout: 20_000 })
  await openSessionInChat(page, await cursorSession.getAttribute('data-session-id') || undefined)
  await expect(page.getByText('Cursor response without authoritative usage.', { exact: true })).toBeVisible({ timeout: 20_000 })
  const infoTitle = page.getByText(/^(会话信息|Session Info)$/)
  await page.waitForTimeout(300)
  if (!await infoTitle.isVisible().catch(() => false)) {
    await page.getByTitle(/信息面板|Toggle Info Panel/).click()
  }
  await expect(infoTitle).toBeVisible({ timeout: 5_000 })
  const unavailable = page.getByText(/Token：不可用|Tokens: unavailable/)
  await expect(unavailable).toBeVisible({ timeout: 10_000 })
  await expect(unavailable.locator('..')).toHaveAttribute('title', /do not expose authoritative token usage/)
})
