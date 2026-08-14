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
    await input.fill('Synthetic Claude turn 1490')
    const matchCounter = page.locator('span.tabular-nums')
    await expect(matchCounter).toHaveText('1/1')
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

    await input.fill('**User**')
    await expect(matchCounter).toHaveText('0/0')

    await input.fill('Synthetic Claude turn 149')
    await expect(matchCounter).toHaveText('1/11')
    const firstMatchScrollTop = await scroller.evaluate((element) => element.scrollTop)
    await input.press('Enter')
    await expect(matchCounter).toHaveText('2/11')
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(firstMatchScrollTop + 1000)
    expect(await scroller.locator('[data-turn-uuid]').count()).toBeLessThanOrEqual(30)

    await input.fill('')
    await expect.poll(() => scroller.locator('[data-turn-uuid]').count()).toBeLessThanOrEqual(30)
  } finally {
    if (launched) await closeApp(launched)
  }
})
