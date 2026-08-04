import * as fs from 'node:fs'
import * as path from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, resizeAppWindow, type LaunchedApp } from './helpers'

let launched: LaunchedApp

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  launched = await launchApp({ viewport: { width: 820, height: 760 } })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

async function choosePackage(sourcePath: string): Promise<void> {
  await launched.app.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] })
  }, sourcePath)
  await launched.page.getByRole('button', { name: '从文件安装' }).click()
}

test('三个官方包完成预览、安装、禁用、启用与卸载全链路', async ({}, testInfo) => {
  const { page, libraryRoot } = launched
  await page.getByTitle('设置').click()
  const settings = page.getByRole('dialog', { name: '设置' })
  await settings.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'Lens' }).click()
  await expect(settings.getByText('声明式扩展包')).toBeVisible()
  await expect(settings.getByText('尚未安装扩展包')).toBeVisible()

  const cases = [
    { file: 'aurora-calm.swoblens', name: '极光静谧', id: 'swob.aurora-calm' },
    { file: 'research-kit.swoblens', name: '学术研究套装', id: 'swob.research-kit' },
    { file: 'field-notes-card.swoblens', name: '田野笔记卡', id: 'swob.field-notes-card' }
  ]

  for (const [index, item] of cases.entries()) {
    const source = path.join(process.cwd(), 'docs', 'swoblens', 'examples', item.file)
    await choosePackage(source)
    await expect(settings.getByText('安装前预览')).toBeVisible()
    await expect(settings.getByText(item.name)).toBeVisible()
    if (index === 0) await settings.screenshot({ path: testInfo.outputPath('swoblens-preview.png') })
    await settings.getByRole('button', { name: '安装并启用' }).click()
    await expect(settings.getByText(item.name)).toBeVisible()

    if (item.id === 'swob.aurora-calm') {
      await expect.poll(() => page.evaluate(() =>
        document.documentElement.style.getPropertyValue('--color-accent').trim()
      )).toBe('#67e8f9')
    }
    if (item.id === 'swob.research-kit') {
      await expect.poll(() => {
        const config = JSON.parse(fs.readFileSync(path.join(libraryRoot, '.swob-config.json'), 'utf8'))
        return config.preferences.enabledLenses
      }).toEqual(['highlights', 'image-index', 'outputs', 'share-templates'])
    }

    await settings.getByRole('button', { name: '禁用' }).click()
    await expect(settings.getByRole('button', { name: '启用' })).toBeVisible()
    await settings.getByRole('button', { name: '启用' }).click()
    await expect(settings.getByRole('button', { name: '禁用' })).toBeVisible()
    await settings.screenshot({ path: testInfo.outputPath(`swoblens-installed-${index + 1}.png`) })
    if (index === cases.length - 1) {
      await resizeAppWindow(launched.app, page, { width: 480, height: 520 })
      const packageSection = settings.locator('[data-swoblens-packages]')
      await packageSection.scrollIntoViewIfNeeded()
      const metrics = await packageSection.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth
      }))
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
      await settings.screenshot({ path: testInfo.outputPath('swoblens-narrow.png') })
      await resizeAppWindow(launched.app, page, { width: 820, height: 760 })
    }
    await settings.getByRole('button', { name: '卸载' }).click()
    await expect(settings.getByText(item.name)).toHaveCount(0)
    await expect(settings.getByText('尚未安装扩展包')).toBeVisible()
  }
})
