import { expect, test } from '@playwright/test'
import { stableCanonicalRecordId } from '../src/shared/provider-protocol'
import {
  closeApp,
  launchApp,
  openSessionInChat,
  resizeAppWindow,
  revealAllSessions
} from './helpers'

const PI_SESSION_ID = stableCanonicalRecordId({
  providerId: 'swob/pi',
  sourceRefStableId: 'pi:synthetic-pi-session',
  recordType: 'session',
  sourceRecordId: 'session:synthetic-pi-session'
})

test('Pi canonical provider renders transcript, thinking, tools, and usage in the product UI', async ({}, testInfo) => {
  const launched = await launchApp({
    includePiFixture: true,
    viewport: { width: 1100, height: 720 }
  })
  const { app, page } = launched
  try {
    await revealAllSessions(page)
    const card = page.locator(`[data-session-id="${PI_SESSION_ID}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('Find the synthetic bridge marker.')
    await expect(card).toContainText('PI')

    await openSessionInChat(page, PI_SESSION_ID)
    await expect(page.getByText('Find the synthetic bridge marker.', { exact: true })).toBeVisible()
    await expect(page.getByText(/I will inspect the generated sample/)).toBeVisible()
    await expect(page.getByText(/Inspect the sample fixture without touching private data/)).toBeVisible()
    await expect(page.getByText('read', { exact: true })).toBeVisible()
    await expect(page.locator('[title*="Input: 150 tokens"]')).toContainText('180 tok')
    await expect(page.locator('[title*="Input: 80 tokens"]')).toContainText('98 tok')
    await expect(page.getByText(/230 in \/ 48 out/)).toBeVisible()

    const toolToggle = page.getByText('read', { exact: true }).locator('xpath=ancestor::button[1]')
    await toolToggle.hover()
    await toolToggle.click()
    await expect(page.getByText(/\/workspace\/synthetic-pi\/README\.md/)).toBeVisible()
    const chatScroll = page.getByTestId('chat-scroll')
    const toolResult = chatScroll.getByText(/synthetic-search-needle/)
    const nextUser = chatScroll.getByText('Does replacement preserve identity?', { exact: true })
    await expect(toolResult).toBeVisible()
    await expect.poll(async () => {
      const [resultBox, nextBox] = await Promise.all([toolResult.boundingBox(), nextUser.boundingBox()])
      return Boolean(resultBox && nextBox && nextBox.y >= resultBox.y + resultBox.height)
    }).toBe(true)
    const toolInputPre = chatScroll.locator('pre').filter({ hasText: 'README.md' }).first()
    const canScrollToolInput = await toolInputPre.evaluate((element) => element.scrollWidth > element.clientWidth)
    if (canScrollToolInput) {
      await toolInputPre.evaluate((element) => { element.scrollLeft = element.scrollWidth })
      expect(await toolInputPre.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
      await toolInputPre.evaluate((element) => { element.scrollLeft = 0 })
    }
    await page.screenshot({ path: testInfo.outputPath('pi-provider-1100x720.png'), fullPage: false })

    await resizeAppWindow(app, page, { width: 760, height: 520 })
    await page.getByTitle('切换信息面板').click()
    await page.getByTitle('目录').click()
    await expect(page.locator(`[data-session-id="${PI_SESSION_ID}"]`)).toBeVisible()
    const toolInput = page.getByText(/\/workspace\/synthetic-pi\/README\.md/)
    await expect(toolInput).toBeVisible()
    const toolBox = await toolInput.boundingBox()
    expect(toolBox).not.toBeNull()
    expect(toolBox!.x).toBeGreaterThanOrEqual(0)
    expect(toolBox!.x + toolBox!.width).toBeLessThanOrEqual(760)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await chatScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(chatScroll.getByText(/stable source and canonical session IDs remain unchanged/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('pi-provider-760x520.png'), fullPage: false })
  } finally {
    await closeApp(launched)
  }
})
