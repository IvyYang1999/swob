import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  resizeAppWindow,
  type LaunchedApp
} from './helpers'

let launched: LaunchedApp

test.beforeAll(async () => {
  launched = await launchApp({ claudeTurns: 60, viewport: { width: 1200, height: 800 } })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test('transcript updates keep the report UI mounted and identical starts single-flight', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const { page, home } = launched
  await page.getByTitle(/Token 洞察|Token Insights/).click()
  await page.getByRole('tab', { name: /审计报告|Audit Report/ }).click()

  const generate = page.getByRole('button', { name: /生成审计报告|Generate audit report/ })
  await expect(generate).toBeVisible({ timeout: 20_000 })
  const auditRoot = generate.locator('xpath=../..')
  await auditRoot.evaluate((element) => element.setAttribute('data-t161-mounted', 'true'))

  await generate.click()
  const jobIds = await page.evaluate(async () => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    start.setDate(start.getDate() - 30)
    const request = { type: 'audit' as const, params: { startDate: start.toISOString() } }
    const jobs = await Promise.all(Array.from({ length: 20 }, () => window.api.reportStart(request)))
    return jobs.map((job) => job.jobId)
  })
  expect(new Set(jobIds).size).toBe(1)
  await page.screenshot({ path: testInfo.outputPath('report-running.png'), fullPage: true })

  const transcript = path.join(
    home,
    '.claude',
    'projects',
    '-synthetic-project',
    `${CLAUDE_FIXTURE_ID}.jsonl`
  )
  for (let index = 0; index < 20; index++) {
    const row = {
      uuid: `storm-update-${index}`,
      parentUuid: null,
      sessionId: CLAUDE_FIXTURE_ID,
      type: 'user',
      timestamp: new Date(Date.UTC(2026, 6, 23, 4, 0, index)).toISOString(),
      cwd: path.join(home, 'project'),
      message: { role: 'user', content: `storm update ${index}` }
    }
    fs.appendFileSync(transcript, `${JSON.stringify(row)}\n`, 'utf-8')
    await page.waitForTimeout(30)
  }

  await expect(page.locator('[data-t161-mounted="true"]')).toBeVisible()
  await expect(page.getByText(/正在加载洞察|Loading insights/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('report-after-transcript-updates.png'), fullPage: true })

  const recovered = await page.evaluate(async (jobId) => window.api.reportStatus({ jobId }), jobIds[0])
  expect(recovered?.jobId).toBe(jobIds[0])
  expect(['running', 'completed']).toContain(recovered?.state)

  await resizeAppWindow(launched.app, page, { width: 1000, height: 650 })
  await page.getByRole('button', { name: /AI 报告|AI Report/ }).hover()
  await page.screenshot({ path: testInfo.outputPath('report-minimum-window-hover.png'), fullPage: true })
  const hasHorizontalOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  )
  expect(hasHorizontalOverflow).toBe(false)
})
