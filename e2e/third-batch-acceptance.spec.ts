import { expect, test } from '@playwright/test'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  openSessionInChat,
  revealAllSessions
} from './helpers'

const themes = [
  { name: 'default-light', mode: '浅色', scheme: '默认', theme: 'light', colorScheme: 'default' },
  { name: 'default-dark', mode: '深色', scheme: '默认', theme: 'dark', colorScheme: 'default' },
  { name: 'paper-light', mode: '浅色', scheme: '纸原', theme: 'light', colorScheme: 'paper' },
  { name: 'nord-dark', mode: '深色', scheme: '深蓝夜', theme: 'dark', colorScheme: 'nord' }
] as const

function relativeLuminance(rgb: number[]): number {
  const channels = rgb.slice(0, 3).map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

test('third batch keeps the inspector structured and readable in all four palettes', async ({}, testInfo) => {
  test.setTimeout(90_000)
  const launched = await launchApp({
    claudeTurns: 1,
    includeInspectorFixture: true,
    viewport: { width: 1200, height: 800 }
  })
  const { page } = launched

  try {
    await revealAllSessions(page)
    await openSessionInChat(page, CLAUDE_FIXTURE_ID)

    const inspector = page.getByTestId('info-panel')
    await expect(inspector).toBeVisible()
    await expect(inspector.getByTitle('claude-sonnet-4-20250514')).toBeVisible()
    await expect(inspector.getByText(/130 in \/ 50 out/)).toBeVisible()
    await expect(inspector.getByRole('tab')).toHaveCount(2)
    await expect(inspector.getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true')

    await inspector.getByRole('button', { name: /project/ }).click()
    await expect(inspector.getByTestId('cwd-file-tree')).toBeVisible()
    await expect(inspector.getByText('src/nested/fixture.ts', { exact: true })).toBeVisible()

    for (const themeCase of themes) {
      await page.getByTitle('设置').click()
      const dialog = page.getByRole('dialog', { name: '设置' })
      await dialog.getByRole('group', { name: '主题' })
        .getByRole('button', { name: themeCase.mode, exact: true }).click()
      await dialog.getByRole('group', { name: '配色' })
        .getByRole('button', { name: themeCase.scheme, exact: true }).click()
      await page.keyboard.press('Escape')

      await expect.poll(() => page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        colorScheme: document.documentElement.dataset.colorScheme
      }))).toEqual({ theme: themeCase.theme, colorScheme: themeCase.colorScheme })

      if (!await inspector.getByTestId('cwd-file-tree').isVisible()) {
        await inspector.getByRole('button', { name: /project/ }).click()
      }
      await expect(inspector.getByText('src/nested/fixture.ts', { exact: true })).toBeVisible()

      const colors = await inspector.getByTitle('claude-sonnet-4-20250514').evaluate((element) => {
        const foreground = getComputedStyle(element).color
        const card = element.closest('section')
        const canvas = document.createElement('canvas')
        canvas.width = 1
        canvas.height = 1
        const context = canvas.getContext('2d', { willReadFrequently: true })!
        const toRgba = (value: string): number[] => {
          context.clearRect(0, 0, 1, 1)
          context.fillStyle = value
          context.fillRect(0, 0, 1, 1)
          return Array.from(context.getImageData(0, 0, 1, 1).data)
        }
        const layers: number[][] = []
        for (let current = card as HTMLElement | null; current; current = current.parentElement) {
          const layer = toRgba(getComputedStyle(current).backgroundColor)
          if (layer[3] > 0) layers.push(layer)
          if (layer[3] === 255) break
        }
        let composited = [255, 255, 255]
        for (const layer of layers.reverse()) {
          const alpha = layer[3] / 255
          composited = layer.slice(0, 3).map((channel, index) =>
            channel * alpha + composited[index] * (1 - alpha)
          )
        }
        return {
          foreground,
          background: card ? getComputedStyle(card).backgroundColor : '',
          foregroundRgb: toRgba(foreground).slice(0, 3),
          backgroundRgb: composited
        }
      })
      const foreground = relativeLuminance(colors.foregroundRgb)
      const background = relativeLuminance(colors.backgroundRgb)
      const contrast = (Math.max(foreground, background) + 0.05) /
        (Math.min(foreground, background) + 0.05)
      expect(
        contrast,
        `${themeCase.name} model text contrast: foreground=${colors.foreground}, background=${colors.background}`
      ).toBeGreaterThanOrEqual(4.5)
      const overflow = await inspector.evaluate((element) => {
        const offenders = Array.from(element.querySelectorAll<HTMLElement>('*'))
          .filter((child) => child.scrollWidth > child.clientWidth + 1)
          .map((child) => ({
            tag: child.tagName,
            className: child.className,
            text: child.textContent?.trim().slice(0, 80),
            scrollWidth: child.scrollWidth,
            clientWidth: child.clientWidth
          }))
          .slice(0, 8)
        return {
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          offenders
        }
      })
      expect(
        overflow.scrollWidth <= overflow.clientWidth + 1,
        `${themeCase.name} inspector overflow: ${JSON.stringify(overflow)}`
      ).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`inspector-${themeCase.name}.png`) })
    }

    await inspector.getByRole('tab', { name: 'Context' }).click()
    await expect(inspector.getByRole('tab', { name: 'Context' })).toHaveAttribute('aria-selected', 'true')
    await expect(inspector.getByText('执行树', { exact: true })).toHaveCount(1)
    await expect(inspector.getByText('上下文检查器', { exact: true })).toHaveCount(1)
    await page.screenshot({ path: testInfo.outputPath('inspector-context-nord-dark.png') })
  } finally {
    await closeApp(launched)
  }
})
