import { expect, test } from '@playwright/test'
import { closeApp, launchApp, resizeAppWindow, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({
    claudeTurns: 4,
    includePricingFixture: true,
    includeUnpricedValuationFixture: true,
    viewport: { width: 1180, height: 780 }
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('成本页按来源显示计量/计价真值，并在窄窗保持可读', async ({}, testInfo) => {
  const { app, page } = launched
  await page.getByTitle(/Token 洞察|Token Insights/).click()
  await expect(page.getByText('Processed Tokens', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '全部', exact: true }).click()

  const costTab = page.getByRole('tab', { name: /成本与缓存|Cost & Cache/ })
  await costTab.click()
  await expect(costTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('按来源计价')).toBeVisible()
  await expect(page.getByText('ZCode', { exact: true })).toBeVisible()
  await expect(page.getByText('仅计量，未计价')).toBeVisible()

  const zcodeRow = page.locator('[title*="model_usage attempt now retains"]')
  await expect(zcodeRow).toBeVisible()
  await zcodeRow.hover()
  await page.screenshot({ path: testInfo.outputPath('swob-t182-cost-wide.png'), fullPage: false })

  await resizeAppWindow(app, page, { width: 720, height: 640 })
  const sidebar = page.getByTestId('sidebar')
  const sidebarWidthBefore = (await sidebar.boundingBox())!.width
  const resizeHandle = page.locator('.cursor-col-resize').first()
  const handleBox = await resizeHandle.boundingBox()
  if (!handleBox) throw new Error('Sidebar resize handle is unavailable')
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 80)
  await page.mouse.down()
  await page.mouse.move(handleBox.x - 80, handleBox.y + 80, { steps: 5 })
  await page.mouse.up()
  expect((await sidebar.boundingBox())!.width).toBeLessThan(sidebarWidthBefore)
  await page.getByText('仅计量，未计价').scrollIntoViewIfNeeded()
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
  await expect(page.getByText('仅计量，未计价')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('swob-t182-cost-narrow.png'), fullPage: false })
})
