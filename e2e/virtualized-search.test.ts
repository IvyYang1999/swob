import { expect, test } from '@playwright/test'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  revealAllSessions,
  type LaunchedApp
} from './helpers'

test('in-session search finds offscreen virtualized turns and restores a bounded DOM', async () => {
  test.setTimeout(60_000)
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp({ claudeTurns: 80 })
    const { page } = launched
    await revealAllSessions(page)
    await page.locator(`[data-session-id="${CLAUDE_FIXTURE_ID}"]`).click()
    const scroller = page.getByTestId('chat-scroll')
    await expect(scroller.locator('[data-turn-uuid]').first()).toBeVisible({ timeout: 20_000 })

    await page.keyboard.press('Meta+f')
    const input = page.locator('input[placeholder]').last()
    await input.fill('Synthetic response 79')
    await expect(page.getByText('1/1', { exact: true })).toBeVisible()
    expect(await scroller.locator('[data-turn-uuid]').count()).toBe(80)

    await input.fill('')
    await expect.poll(() => scroller.locator('[data-turn-uuid]').count()).toBeLessThanOrEqual(30)
  } finally {
    if (launched) await closeApp(launched)
  }
})
