import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  closeApp,
  launchApp,
  resizeAppWindow,
  revealAllSessions
} from './helpers'

function canonicalProviderIds(libraryRoot: string): string[] {
  const ids: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(candidate)
      if (!entry.isFile() || entry.name !== '.swob-session.json') continue
      const metadata = JSON.parse(fs.readFileSync(candidate, 'utf8')) as {
        canonicalProvider?: { providerId?: string }
      }
      if (metadata.canonicalProvider?.providerId) ids.push(metadata.canonicalProvider.providerId)
    }
  }
  visit(libraryRoot)
  return ids.sort()
}

test('Qoder and Trae run through discovery, Library, search, and responsive UI', async ({}, testInfo) => {
  // This serial composite keeps its stricter per-assertion deadlines below;
  // the outer budget only prevents their valid sum from being pre-empted at 30s.
  test.setTimeout(60_000)
  const launched = await launchApp({
    includeQoderFixture: true,
    includeTraeFixture: true,
    viewport: { width: 1100, height: 720 }
  })
  const { app, page, libraryRoot } = launched
  try {
    await revealAllSessions(page)
    const qoderCard = page.locator('[data-session-id]')
      .filter({ hasText: 'Inspect the synthetic Qoder fixture' }).first()
    const traeCard = page.locator('[data-session-id]')
      .filter({ hasText: 'Inspect the synthetic workspace' }).first()
    await expect(qoderCard).toBeVisible({ timeout: 20_000 })
    await expect(qoderCard).toContainText('QD')
    await expect(traeCard).toBeVisible({ timeout: 20_000 })
    await expect(traeCard).toContainText('TR')

    await traeCard.click()
    const chatScroll = page.getByTestId('chat-scroll')
    await page.screenshot({ path: testInfo.outputPath('t175-trae-open.png'), fullPage: false })
    await expect(chatScroll.getByText(/Inspect the synthetic workspace/)).toBeVisible({ timeout: 10_000 })
    await expect(chatScroll.getByText(/First synthetic bubble/)).toBeVisible()
    await expect(chatScroll.getByText(/Second synthetic bubble/)).toBeVisible()

    const resume = page.getByRole('button', { name: 'Resume', exact: true })
    await expect(resume).toBeDisabled()
    await expect(resume).toHaveAttribute('title', /No verified Trae per-session CLI resume command/)
    await resume.hover({ force: true })

    const sidebar = page.getByTestId('sidebar')
    const sidebarBefore = await sidebar.boundingBox()
    const resizeHandle = page.locator('.cursor-col-resize').first()
    const handleBox = await resizeHandle.boundingBox()
    expect(sidebarBefore).not.toBeNull()
    expect(handleBox).not.toBeNull()
    await page.mouse.move(handleBox!.x + 1, handleBox!.y + 120)
    await page.mouse.down()
    await page.mouse.move(handleBox!.x + 45, handleBox!.y + 120, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await sidebar.boundingBox())?.width || 0)
      .toBeGreaterThan(sidebarBefore!.width + 20)

    const globalSearch = page.getByPlaceholder('搜索所有会话...')
    await globalSearch.fill('synthetic-trae-search-needle')
    await expect(page.getByText('synthetic-trae-search-needle', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await globalSearch.fill('qoder-synthetic-search-needle')
    await expect(page.getByText('qoder-synthetic-search-needle', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await globalSearch.fill('')
    await expect(page.getByText(/qoder-synthetic-search-needle/).first()).toBeHidden({ timeout: 5_000 })

    await expect.poll(() => canonicalProviderIds(libraryRoot), { timeout: 20_000 })
      .toEqual(expect.arrayContaining(['swob/qoder', 'swob/trae']))

    await page.screenshot({ path: testInfo.outputPath('t175-new-providers-1100x720.png'), fullPage: false })

    await resizeAppWindow(app, page, { width: 760, height: 520 })
    await page.getByTitle('切换信息面板').click()
    await page.getByTitle('目录').click()
    await revealAllSessions(page)
    await page.locator('[data-session-id]')
      .filter({ hasText: 'Inspect the synthetic Qoder fixture' }).first().click()
    await expect(chatScroll.getByText(/The synthetic Qoder inspection is complete/)).toBeVisible()
    await chatScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }))
    expect(overflow.body).toBeLessThanOrEqual(1)
    expect(overflow.root).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath('t175-new-providers-760x520.png'), fullPage: false })
  } finally {
    await closeApp(launched)
  }
})
