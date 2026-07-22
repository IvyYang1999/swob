import { expect, test } from '@playwright/test'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  openSessionInChat,
  type LaunchedApp
} from './helpers'

test('1500-turn session keeps DOM bounded and renderer long tasks below 100ms', async ({}, testInfo) => {
  test.setTimeout(60_000)
  let launched: LaunchedApp | undefined
  try {
    launched = await launchApp({
      claudeTurns: 1500,
      viewport: { width: 1100, height: 720 }
    })
    const { page } = launched
    await page.evaluate(() => {
      const state = window as unknown as {
        __swobLongTasks: Array<{ startTime: number; duration: number }>
        __swobLongTaskObserver?: PerformanceObserver
      }
      state.__swobLongTasks = []
      state.__swobLongTaskObserver = new PerformanceObserver((list) => {
        state.__swobLongTasks.push(...list.getEntries().map((entry) => ({
          startTime: entry.startTime,
          duration: entry.duration
        })))
      })
      state.__swobLongTaskObserver.observe({ entryTypes: ['longtask'] })
    })

    const openStart = await page.evaluate(() => performance.now())
    await openSessionInChat(page, CLAUDE_FIXTURE_ID)

    const scroller = page.getByTestId('chat-scroll')
    await expect(scroller.locator('[data-turn-uuid]').first()).toBeVisible({ timeout: 25_000 })
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    }))
    const openEnd = await page.evaluate(() => performance.now())

    const initialDomTurns = await scroller.locator('[data-turn-uuid]').count()
    expect(initialDomTurns).toBeLessThanOrEqual(30)
    expect(await page.getByTestId('toc-scroll').locator('button').count()).toBeLessThanOrEqual(40)

    const openingLongTasks = await page.evaluate(() => {
      const state = window as unknown as {
        __swobLongTasks: Array<{ startTime: number; duration: number }>
      }
      return [...state.__swobLongTasks]
    })
    const openWindowLongTasks = openingLongTasks.filter((entry) => (
      entry.startTime >= openStart && entry.startTime <= openEnd
    ))
    await testInfo.attach('opening-long-tasks.json', {
      body: Buffer.from(JSON.stringify({ openStart, openEnd, tasks: openingLongTasks, openWindowLongTasks })),
      contentType: 'application/json'
    })
    expect(
      Math.max(0, ...openWindowLongTasks.map((entry) => entry.duration)),
      JSON.stringify({ openStart, openEnd, tasks: openingLongTasks, openWindowLongTasks })
    ).toBeLessThan(100)

    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await page.waitForTimeout(500)
    const bottomDomTurns = await scroller.locator('[data-turn-uuid]').count()
    expect(bottomDomTurns).toBeLessThanOrEqual(30)
    await scroller.screenshot({ path: testInfo.outputPath('long-session-virtualized.png') })
  } finally {
    if (launched) await closeApp(launched)
  }
})
