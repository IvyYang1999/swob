import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeApp, launchApp, type LaunchedApp } from './helpers'

let launched: LaunchedApp
let app: ElectronApplication
let page: Page
const screenshotDir = path.join(os.tmpdir(), 'swob-dashboard-smoke')

test.beforeAll(async () => {
  fs.rmSync(screenshotDir, { recursive: true, force: true })
  fs.mkdirSync(screenshotDir, { recursive: true })
  launched = await launchApp({ claudeTurns: 6, viewport: { width: 1200, height: 800 } })
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test('五页仪表盘可达且带范围标签与口径切换', async () => {
  await page.getByTitle(/Token 洞察|Token Insights/).click()

  // Overview
  await expect(page.getByRole('tab', { name: /总览|Overview/ })).toBeVisible({ timeout: 15000 })
  await expect(page.getByText(/Processed Tokens/)).toBeVisible()
  await expect(page.getByText(/成本账本|Cost ledgers/).first()).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, '1-overview.png') })

  // Basis toggle switches KPI label
  await page.getByRole('button', { name: /仅主对话 Token|Main-conversation tokens/ }).first().click()
  await expect(page.getByText(/Conversation Tokens/)).toBeVisible()
  await page.getByRole('button', { name: /含全部来源的 Token|All-source tokens/ }).first().click()

  // Heatmap range is semantic, not a fixed one-year viewport.
  await page.getByRole('button', { name: /今日|Today/, exact: true }).click()
  await expect(page.locator('[data-heatmap-day]')).toHaveCount(1)
  await page.getByRole('button', { name: '7d', exact: true }).click()
  await expect(page.locator('[data-heatmap-day]')).toHaveCount(7)
  // Fixed-date fixtures eventually fall outside the default seven-day window.
  // Switch back to all history before asserting usage-derived session metrics.
  await page.getByRole('button', { name: /^(全部|All)$/ }).click()

  // Cost & Cache
  await page.getByRole('tab', { name: /成本与缓存|Cost & Cache/ }).click()
  await expect(page.getByText(/金额追溯|Valuation trace/)).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, '2-cost.png') })

  // Sessions
  await page.getByRole('button', { name: /^全部$|^All$/ }).click()
  await page.getByRole('tab', { name: /会话与效率|Sessions/ }).click()
  await expect(page.getByText(/会话排名|Session ranking/)).toBeVisible()
  await expect(page.getByText(/P95/)).toBeVisible()
  await expect(page.getByText(/会话开始时刻分布/)).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, '3-sessions.png') })

  // Workflow
  await page.getByRole('tab', { name: /工作流|Workflow/ }).click()
  await page.screenshot({ path: path.join(screenshotDir, '4-workflow.png') })

  // Data Quality
  await page.getByRole('tab', { name: /数据质量|Data Quality/ }).click()
  await expect(page.getByText(/三级对账|Reconciliation/)).toBeVisible()
  await expect(page.getByText(/定价覆盖与追溯|Pricing coverage/)).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, '5-quality.png') })

  // Audit tab keeps report generator
  await page.getByRole('tab', { name: /审计报告|Audit Report/ }).click()
  await expect(page.getByText(/快速报告|Quick Report/)).toBeVisible()

  // Narrow window: tabs remain reachable, no horizontal body scroll
  await page.setViewportSize({ width: 640, height: 700 })
  await expect(page.getByRole('tab', { name: /数据质量|Data Quality/ })).toBeVisible()
  await page.screenshot({ path: path.join(screenshotDir, '6-narrow.png') })
})
