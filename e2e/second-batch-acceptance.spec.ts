import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import sharp from 'sharp'
import {
  closeApp,
  launchApp,
  resizeAppWindow,
  type LaunchedApp
} from './helpers'

interface ThemeCase {
  name: string
  mode: '浅色' | '深色'
  scheme: '默认' | '纸原' | '北境蓝'
  datasetTheme: 'light' | 'dark'
  datasetScheme: 'default' | 'paper' | 'nord'
  background: [number, number, number]
}

const themeCases: ThemeCase[] = [
  { name: 'default-light', mode: '浅色', scheme: '默认', datasetTheme: 'light', datasetScheme: 'default', background: [248, 249, 250] },
  { name: 'default-dark', mode: '深色', scheme: '默认', datasetTheme: 'dark', datasetScheme: 'default', background: [13, 17, 23] },
  { name: 'paper-light', mode: '浅色', scheme: '纸原', datasetTheme: 'light', datasetScheme: 'paper', background: [250, 248, 245] },
  { name: 'nord-dark', mode: '深色', scheme: '北境蓝', datasetTheme: 'dark', datasetScheme: 'nord', background: [46, 52, 64] }
]

test.describe.serial('second merge batch visual acceptance', () => {
  let launched: LaunchedApp

  test.beforeAll(async () => {
    launched = await launchApp({ claudeTurns: 3, viewport: { width: 1200, height: 800 } })
  })

  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('theme combinations persist and feedback surfaces remain visible', async ({}, testInfo) => {
    const { page, libraryRoot } = launched
    await page.getByTitle('设置').click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await expect(dialog).toBeVisible()

    const themeGroup = dialog.getByRole('radiogroup', { name: '主题' })
    const schemeGroup = dialog.getByRole('radiogroup', { name: '配色主题' })
    for (const themeCase of themeCases) {
      await themeGroup.getByRole('radio', { name: themeCase.mode, exact: true }).click()
      await schemeGroup.getByRole('radio', { name: themeCase.scheme, exact: true }).click()
      await expect.poll(() => page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        scheme: document.documentElement.dataset.colorScheme
      }))).toEqual({ theme: themeCase.datasetTheme, scheme: themeCase.datasetScheme })
      await page.screenshot({ path: testInfo.outputPath(`settings-${themeCase.name}.png`) })
    }

    await expect.poll(() => {
      const config = JSON.parse(fs.readFileSync(path.join(libraryRoot, '.swob-config.json'), 'utf8'))
      return {
        themeMode: config.preferences?.themeMode,
        colorScheme: config.preferences?.colorScheme
      }
    }).toEqual({ themeMode: 'dark', colorScheme: 'nord' })

    await dialog.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '更新', exact: true }).click()
    for (const label of ['反馈 Bug', '许愿池', 'Discord 社区', '文档与项目主页']) {
      await expect(dialog.getByRole('button', { name: new RegExp(label) })).toBeVisible()
    }
    await dialog.screenshot({ path: testInfo.outputPath('feedback-settings.png') })
    await page.keyboard.press('Escape')

    await page.getByTitle('帮助').click()
    for (const label of ['文档', '快捷键', '反馈 Bug', 'Discord 社区']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
    await page.getByRole('button', { name: 'Discord 社区', exact: true }).hover()
    await page.screenshot({ path: testInfo.outputPath('feedback-help-menu.png') })
    await page.keyboard.press('Escape')
  })

  test('Galaxy exports branded, theme-aware PNGs with stats, legend and QR', async ({}, testInfo) => {
    test.setTimeout(90_000)
    const { app, page } = launched
    await page.getByTitle('会话图谱').click()
    await expect(page.getByText('3 sessions')).toBeVisible({ timeout: 20_000 })

    const pngSources = new Set<string>()
    for (const themeCase of themeCases) {
      await page.getByTitle('设置').click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.getByRole('radiogroup', { name: '主题' }).getByRole('radio', { name: themeCase.mode, exact: true }).click()
      await dialog.getByRole('radiogroup', { name: '配色主题' }).getByRole('radio', { name: themeCase.scheme, exact: true }).click()
      await page.keyboard.press('Escape')

      await page.getByTitle('会话图谱').click()
      await expect(page.getByText('3 sessions')).toBeVisible({ timeout: 20_000 })
      await page.getByRole('button', { name: '分享我的会话星图', exact: true }).click()
      const preview = page.getByAltText('会话星图分享预览')
      await expect(preview).toBeVisible({ timeout: 20_000 })
      await expect.poll(() => preview.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
      const source = (await preview.getAttribute('src'))!
      pngSources.add(source)
      const bytes = Buffer.from(source.split(',')[1], 'base64')
      expect(bytes.byteLength).toBeGreaterThan(50_000)

      const output = testInfo.outputPath(`galaxy-${themeCase.name}.png`)
      fs.writeFileSync(output, bytes)
      const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true })
      expect({ width: info.width, height: info.height }).toEqual({ width: 1600, height: 1200 })
      const sampleOffset = (10 * info.width + 10) * info.channels
      expect(Array.from(data.subarray(sampleOffset, sampleOffset + 3))).toEqual(themeCase.background)

      // The t156 logo and the QR occupy distinct non-uniform regions in the brand strip.
      const logoCrop = await sharp(bytes).extract({ left: 1060, top: 998, width: 104, height: 104 }).png().toBuffer()
      const qrCrop = await sharp(bytes).extract({ left: 1392, top: 988, width: 128, height: 128 }).png().toBuffer()
      const logoStats = await sharp(logoCrop).stats()
      const qrStats = await sharp(qrCrop).stats()
      expect(Math.max(...logoStats.channels.slice(0, 3).map((channel) => channel.stdev))).toBeGreaterThan(8)
      expect(Math.max(...qrStats.channels.slice(0, 3).map((channel) => channel.stdev))).toBeGreaterThan(20)

      await page.screenshot({ path: testInfo.outputPath(`galaxy-modal-${themeCase.name}.png`) })
      await page.getByRole('button', { name: '关闭', exact: true }).first().click()
    }
    expect(pngSources.size).toBe(themeCases.length)

    await resizeAppWindow(app, page, { width: 640, height: 600 })
    await page.getByRole('button', { name: '分享我的会话星图', exact: true }).click()
    await expect(page.getByRole('button', { name: '保存 PNG', exact: true })).toBeInViewport()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath('galaxy-modal-narrow.png') })
  })
})
