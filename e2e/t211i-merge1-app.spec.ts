import { expect, test } from '@playwright/test'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  openSessionInChat,
  resizeAppWindow,
  type LaunchedApp
} from './helpers'

test.describe.serial('t211 Merge 1 real App integration', () => {
  let launched: LaunchedApp

  test.beforeAll(async () => {
    launched = await launchApp({ claudeTurns: 4, viewport: { width: 820, height: 480 } })
  })

  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('mounts E/B/C/D/G product entries in the real 820px App', async ({}, testInfo) => {
    const { page } = launched
    const workspace = page.getByRole('navigation', { name: '工作区标签页' })
    await expect(workspace).toBeVisible()
    const addTab = page.getByRole('button', { name: '新建工作区标签页' })
    await addTab.hover(); await addTab.focus(); await expect(addTab).toBeFocused()

    const catalog = page.getByTestId('truth-kernel-catalog-surface')
    const catalogToggle = catalog.locator('button[aria-expanded]').first()
    await catalogToggle.click()
    await expect(catalog.getByRole('region', { name: '资料目录导航' })).toBeVisible()
    await expect(catalog.getByRole('region', { name: '存储位置' })).toContainText('Library')
    await catalog.getByRole('tab', { name: '位置' }).hover()
    await catalog.getByRole('tab', { name: '位置' }).focus()
    await expect(catalog.getByRole('tab', { name: '位置' })).toBeFocused()
    await catalog.screenshot({ path: testInfo.outputPath('merge1-catalog-820.png') })
    await catalogToggle.click()

    await openSessionInChat(page, CLAUDE_FIXTURE_ID)
    const timeline = page.getByTestId('truth-kernel-timeline-slot')
    await expect(timeline).toBeVisible({ timeout: 20_000 })
    const timelineToggle = timeline.locator('button[aria-expanded]').first()
    await timelineToggle.click()
    await expect(timelineToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(timeline.getByRole('list', { name: 'Agent 时间线' })).toBeVisible()
    await timelineToggle.hover(); await timelineToggle.focus(); await expect(timelineToggle).toBeFocused()

    const activity = page.getByRole('tab', { name: '活动' })
    await activity.click()
    await expect(page.getByTestId('context-ledger-panel')).toBeVisible()
    await expect(page.getByRole('region', { name: '会话轨迹' })).toBeVisible()
    await expect(page.getByRole('region', { name: '会话证据' })).toBeVisible()
    const infoPanel = page.getByTestId('info-panel')
    await infoPanel.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: testInfo.outputPath('merge1-app-820.png') })
  })

  test('keeps the real shell usable at 480px and exposes Provider Doctor', async ({}, testInfo) => {
    const { app, page } = launched
    await resizeAppWindow(app, page, { width: 480, height: 720 })
    const strip = page.getByTestId('workspace-tab-strip')
    await expect(strip).toBeVisible()
    await strip.evaluate((element) => { element.scrollLeft = element.scrollWidth })
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)

    await page.getByTitle('设置').click()
    const zhDialog = page.getByRole('dialog', { name: '设置' })
    await zhDialog.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '通用' }).click()
    await zhDialog.getByRole('group', { name: '语言' }).getByRole('button', { name: 'English' }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Diagnostics & Repair' }).click()
    await dialog.getByRole('button', { name: 'Provider Doctor' }).click()
    const doctor = dialog.getByRole('region', { name: 'Provider Doctor' })
    await expect(doctor).toBeVisible()
    await doctor.getByText(/Claude Code/).first().hover()
    await doctor.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await dialog.screenshot({ path: testInfo.outputPath('merge1-app-480-provider-doctor.png') })
    await dialog.getByRole('button', { name: 'Close' }).click()
    const catalog = page.getByTestId('truth-kernel-catalog-surface')
    await catalog.locator('button[aria-expanded]').first().click()
    await expect(catalog.getByRole('region', { name: 'Catalog navigator' })).toBeVisible()
    await expect(catalog.getByRole('region', { name: 'Storage roots' })).toContainText('Stale')
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1)
    await catalog.screenshot({ path: testInfo.outputPath('merge1-catalog-480-en-offline.png') })
  })
})
