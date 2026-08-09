import { expect, test } from '@playwright/test'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeApp, launchApp, resizeAppWindow, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({
    claudeTurns: 4,
    includePricingFixture: true,
    viewport: { width: 1180, height: 780 }
  })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('可审计成本账本展示并下钻到调用、价格版本与逐桶计算', async () => {
  const { app, page } = launched
  await page.getByTitle(/Token 洞察|Token Insights/).click()
  await expect(page.getByText('Processed Tokens', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: '全部', exact: true }).click()
  await page.getByRole('tab', { name: /成本与缓存|Cost & Cache/ }).click()

  await expect(page.getByText(/成本账本与缓存|Cost Ledger & Cache/)).toBeVisible()
  await expect(page.getByText(/Swob API 等价值|Swob API equivalent/).first()).toBeVisible()
  await expect(page.getByText(/财务覆盖|Financial coverage/).first()).toBeVisible()
  await expect(page.getByText(/因官方价格目录更新而修订|Revised after an official pricing catalog update/).first()).toBeVisible()
  await expect(page.getByText(/official-snapshot-2026-08-01\.v2/)).toBeVisible()

  await page.screenshot({ path: path.join(os.tmpdir(), 'swob-t171-cost-wide.png'), fullPage: true })

  await page.getByRole('button', { name: /查看逐调用账本|View call ledger/ }).click()
  await expect(page.getByRole('button', { name: /审计账本|Audit ledger/ }).first()).toBeVisible()
  await page.getByRole('button', { name: /审计账本|Audit ledger/ }).first().click()
  await expect(page.getByText(/价格版本|Price revision/).first()).toBeVisible()
  await expect(page.getByText(/快照哈希|Snapshot hash/).first()).toBeVisible()
  await expect(page.getByText(/计算 · input|Calculation · input/).first()).toBeVisible()
  await expect(page.getByText(/official-snapshot-2026-07-22\.v1.*official-snapshot-2026-08-01\.v2/)).toBeVisible()

  await resizeAppWindow(app, page, { width: 720, height: 640 })
  await page.getByText(/价格版本|Price revision/).first().scrollIntoViewIfNeeded()
  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(1)
  expect(overflow.root).toBeLessThanOrEqual(1)
  await page.screenshot({ path: path.join(os.tmpdir(), 'swob-t171-cost-narrow.png'), fullPage: true })
})
