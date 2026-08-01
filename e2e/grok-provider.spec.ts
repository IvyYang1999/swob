import { expect, test } from '@playwright/test'
import { stableCanonicalRecordId } from '../src/shared/provider-protocol'
import {
  closeApp,
  launchApp,
  openSessionInChat,
  resizeAppWindow,
  revealAllSessions
} from './helpers'

const SOURCE_SESSION_ID = '11111111-2222-7333-8444-555555555555'
const GROK_SESSION_ID = stableCanonicalRecordId({
  providerId: 'swob/grok',
  sourceRefStableId: `grok:${SOURCE_SESSION_ID}`,
  recordType: 'session',
  sourceRecordId: SOURCE_SESSION_ID
})

test('Grok composite source opens from sidebar and renders compact history, tools, reasoning and usage', async ({}, testInfo) => {
  const launched = await launchApp({
    includeGrokFixture: true,
    viewport: { width: 1100, height: 720 }
  })
  const { app, page } = launched
  try {
    await revealAllSessions(page)
    const card = page.locator(`[data-session-id="${GROK_SESSION_ID}"]`)
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('hello from the synthetic fixture')
    await expect(card).toContainText('GR')

    // This click exercises the real Electron IPC source-root gate and the
    // composite displayLocator lookup, not a direct loader call.
    await openSessionInChat(page, GROK_SESSION_ID)
    const chat = page.getByTestId('chat-scroll')
    const oldPrompt = chat.getByText('hello from the synthetic fixture', { exact: true })
    const currentPrompt = chat.getByText('implement the direct v2 parser', { exact: true })
    await expect(oldPrompt).toBeVisible()
    await expect(currentPrompt).toBeVisible()
    await expect(chat.getByText(/Preserve reported cache and reasoning subset semantics/)).toBeVisible()
    await expect(chat.getByText('apply_patch', { exact: true })).toBeVisible()
    const resumeButton = page.getByRole('button', { name: 'Resume', exact: true })
    await expect(resumeButton).toBeDisabled()
    await expect(resumeButton).toHaveAttribute('title', /binary\/help\/source\/post-launch anchor verification/)
    await expect(page.getByRole('button', { name: /Fork|分叉/ })).toHaveCount(0)
    await expect.poll(async () => {
      const [oldBox, currentBox] = await Promise.all([oldPrompt.boundingBox(), currentPrompt.boundingBox()])
      return Boolean(oldBox && currentBox && oldBox.y < currentBox.y)
    }).toBe(true)

    const toolToggle = chat.getByText('apply_patch', { exact: true }).locator('xpath=ancestor::button[1]')
    await toolToggle.hover()
    await toolToggle.click()
    await expect(chat.getByText(/src\/main\/providers\/grok-provider\.ts/)).toBeVisible()
    await expect(page.getByText(/\d+ in \/ \d+ out/i)).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('grok-provider-1100x720.png'), fullPage: false })

    await resizeAppWindow(app, page, { width: 760, height: 520 })
    await chat.evaluate((element) => { element.scrollTop = Math.floor(element.scrollHeight / 2) })
    expect(await chat.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await expect(chat).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('grok-provider-760x520.png'), fullPage: false })
  } finally {
    await closeApp(launched)
  }
})
