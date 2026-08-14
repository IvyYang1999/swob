import { expect, test } from '@playwright/test'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  openSessionInChat,
  type LaunchedApp
} from './helpers'

test('1500-turn in-session search finds offscreen matches without devirtualizing the transcript', async ({}, testInfo) => {
  test.setTimeout(60_000)
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp({ claudeTurns: 1500 })
    const { page } = launched
    await openSessionInChat(page, CLAUDE_FIXTURE_ID)
    const scroller = page.getByTestId('chat-scroll')
    await expect(scroller.locator('[data-turn-uuid]').first()).toBeVisible({ timeout: 20_000 })

    await page.evaluate(() => {
      const state = window as unknown as {
        __swobSearchLongTasks: Array<{ startTime: number; duration: number }>
        __swobSearchLongTaskObserver?: PerformanceObserver
      }
      state.__swobSearchLongTasks = []
      state.__swobSearchLongTaskObserver = new PerformanceObserver((list) => {
        state.__swobSearchLongTasks.push(...list.getEntries().map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration
        })))
      })
      state.__swobSearchLongTaskObserver.observe({ entryTypes: ['longtask'] })
    })

    const searchStart = await page.evaluate(() => performance.now())
    await page.keyboard.press('Meta+f')
    const input = page.locator('input[placeholder]').last()
    await input.fill('Synthetic response 1490')
    await expect(page.getByText('1/1', { exact: true })).toBeVisible()
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    const searchEnd = await page.evaluate(() => performance.now())

    expect(await scroller.locator('[data-turn-uuid]').count()).toBeLessThanOrEqual(30)
    const searchLongTasks = await page.evaluate(() => {
      const state = window as unknown as {
        __swobSearchLongTasks: Array<{ startTime: number; duration: number }>
      }
      return state.__swobSearchLongTasks.filter((entry) => (
        entry.startTime >= searchStart && entry.startTime <= searchEnd
      ))
    })
    await testInfo.attach('search-long-tasks.json', {
      body: Buffer.from(JSON.stringify({ searchStart, searchEnd, searchLongTasks })),
      contentType: 'application/json'
    })
    expect(Math.max(0, ...searchLongTasks.map((entry) => entry.duration))).toBeLessThan(100)
    await scroller.screenshot({ path: testInfo.outputPath('virtualized-search-1500-turns.png') })

    await input.fill('Synthetic response 149')
    await expect(page.getByText('1/11', { exact: true })).toBeVisible()
    await input.press('Enter')
    await expect(page.getByText('2/11', { exact: true })).toBeVisible()
    expect(await scroller.locator('[data-turn-uuid]').count()).toBeLessThanOrEqual(30)

    await input.fill('')
    await expect.poll(() => scroller.locator('[data-turn-uuid]').count()).toBeLessThanOrEqual(30)
  } finally {
    if (launched) await closeApp(launched)
  }
})
