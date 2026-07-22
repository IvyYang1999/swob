import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers'

let launched: LaunchedApp
let app: ElectronApplication
let page: Page

async function sendUpdateEvent(channel: string, ...args: unknown[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send(payload.channel, ...payload.args)
  }, { channel, args })
}

test.beforeAll(async () => {
  launched = await launchApp({ viewport: { width: 720, height: 520 } })
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test('更新错误在桌面与窄窗口都可读、可关闭且不产生横向溢出', async ({}, testInfo) => {
  await expect(page.getByTitle('设置')).toBeVisible({ timeout: 15_000 })
  await sendUpdateEvent('update:error', 'check', '')
  const manualDownload = page.getByRole('button', { name: '手动下载' })
  await expect(page.getByText('暂时无法检查更新')).toBeVisible()
  await expect(manualDownload).toBeVisible()
  await manualDownload.hover()
  await page.screenshot({ path: testInfo.outputPath('check-error-desktop.png') })

  await page.getByRole('button', { name: '关闭更新提示' }).click()
  await page.setViewportSize({ width: 420, height: 420 })
  const baselineOverflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))

  await sendUpdateEvent('update:error', 'install', '1.3.1')
  await expect(page.getByText('安全校验未通过，未安装新版')).toBeVisible()
  await expect(page.getByRole('button', { name: '手动下载' })).toBeInViewport()

  const overflow = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.body.clientWidth,
    root: document.documentElement.scrollWidth - document.documentElement.clientWidth
  }))
  expect(overflow.body).toBeLessThanOrEqual(baselineOverflow.body + 1)
  expect(overflow.root).toBeLessThanOrEqual(baselineOverflow.root + 1)

  const banner = page.getByTestId('update-banner')
  const bannerBox = await banner.boundingBox()
  expect(bannerBox).not.toBeNull()
  expect(bannerBox!.x).toBeGreaterThanOrEqual(0)
  expect(bannerBox!.x + bannerBox!.width).toBeLessThanOrEqual(420)
  const bannerOverflow = await banner.evaluate((element) => element.scrollWidth - element.clientWidth)
  expect(bannerOverflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('install-error-narrow.png') })

  await page.getByRole('button', { name: '关闭更新提示' }).click()
  await expect(page.getByText('安全校验未通过，未安装新版')).toHaveCount(0)
})
