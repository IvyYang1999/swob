import { expect, test } from '@playwright/test'
import { stableCanonicalRecordId } from '../src/shared/provider-protocol'
import {
  closeApp,
  launchApp,
  openSessionInChat,
  resizeAppWindow,
  revealAllSessions
} from './helpers'

const KIMI_MAIN_SESSION_RECORD_ID = stableCanonicalRecordId({
  providerId: 'swob/kimi',
  sourceRefStableId: 'kimi:session_synthetic_native:main',
  recordType: 'session',
  sourceRecordId: 'session_synthetic_native'
})

test('Kimi v2 provider renders native text, thinking and tools at wide and narrow widths', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const launched = await launchApp({
    includeKimiFixture: true,
    viewport: { width: 1100, height: 720 }
  })
  const { app, page } = launched
  try {
    await revealAllSessions(page)
    const card = page.locator(`[data-session-id="${KIMI_MAIN_SESSION_RECORD_ID}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('Inspect the synthetic fixture.')
    await expect(card).toContainText('KM')

    await openSessionInChat(page, KIMI_MAIN_SESSION_RECORD_ID)
    const chatScroll = page.getByTestId('chat-scroll')
    await expect(chatScroll.getByText('Inspect the synthetic fixture.', { exact: true })).toBeVisible()
    await expect(chatScroll.getByText(/I should inspect only the fixture/)).toBeVisible()
    await expect(chatScroll.getByText('Read', { exact: true })).toBeVisible()
    await expect(page.getByText(/58 in \/ 9 out/)).toBeVisible()

    const toolToggle = chatScroll.getByText('Read', { exact: true }).locator('xpath=ancestor::button[1]')
    await toolToggle.hover()
    await toolToggle.click()
    await expect(chatScroll.getByText('/workspace/synthetic-kimi/README.md', { exact: true })).toBeVisible()
    await expect(chatScroll.getByText(/synthetic-kimi-search-needle/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('kimi-provider-1100x720.png'), fullPage: false })

    await resizeAppWindow(app, page, { width: 760, height: 520 })
    await page.getByTitle('切换信息面板').click()
    await page.getByTitle('目录').click()
    await expect(page.locator(`[data-session-id="${KIMI_MAIN_SESSION_RECORD_ID}"]`)).toBeVisible()
    const toolInput = chatScroll.getByText('/workspace/synthetic-kimi/README.md', { exact: true })
    const box = await toolInput.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(760)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await chatScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(chatScroll.getByText(/Partial answer before cancellation/)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('kimi-provider-760x520.png'), fullPage: false })
  } finally {
    await closeApp(launched)
  }
})
