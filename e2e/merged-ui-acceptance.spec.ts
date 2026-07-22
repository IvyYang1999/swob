import { expect, test, type Locator } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  openSessionInChat,
  resizeAppWindow,
  type LaunchedApp
} from './helpers'

interface ColorCentroid {
  x: number
  y: number
  weight: number
}

async function canvasColorCentroid(
  canvas: Locator,
  rgb: [number, number, number]
): Promise<ColorCentroid> {
  return canvas.evaluate((element, target) => {
    const context = (element as HTMLCanvasElement).getContext('2d')
    if (!context) throw new Error('2D canvas context unavailable')
    const { width, height } = context.canvas
    const pixels = context.getImageData(0, 0, width, height).data
    let weight = 0
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4
        if (pixels[offset] !== target[0] || pixels[offset + 1] !== target[1] || pixels[offset + 2] !== target[2]) continue
        const alpha = pixels[offset + 3] / 255
        weight += alpha
        minX = Math.min(minX, x)
        maxX = Math.max(maxX, x)
        minY = Math.min(minY, y)
        maxY = Math.max(maxY, y)
      }
    }
    if (weight === 0) throw new Error(`color ${target.join(',')} not found on canvas`)
    // The bounding-box center is invariant to a presentation-only radius/alpha
    // change; an alpha-weighted centroid can drift on a tiny antialiased circle.
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, weight }
  }, rgb)
}

test.describe.serial('merged tF10/tF21 visual acceptance', () => {
  let launched: LaunchedApp

  test.beforeAll(async () => {
    launched = await launchApp({ claudeTurns: 3, viewport: { width: 1100, height: 720 } })
  })

  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('selected Q/A produces deterministic PNG previews in all three themes', async ({}, testInfo) => {
    const { page } = launched
    await openSessionInChat(page, CLAUDE_FIXTURE_ID)
    await page.getByTitle('多选模式').click()

    const firstTurn = page.locator('[data-turn-uuid]').first()
    const selectors = firstTurn.locator('button.w-4.h-4')
    await expect(selectors).toHaveCount(2)
    await selectors.nth(0).click()
    await selectors.nth(1).click()
    await page.getByRole('button', { name: '生成分享图' }).click()

    const preview = page.getByAltText('Share preview')
    await expect(preview).toBeVisible({ timeout: 20_000 })
    for (const label of ['隐藏文件路径', '隐藏 Session ID', '排除工具结果', '"via Swob"']) {
      await expect(page.getByRole('checkbox', { name: label })).toBeChecked()
    }

    const pngByTheme = new Map<string, string>()
    for (const theme of ['Light', 'Dark', 'Minimal']) {
      await page.getByRole('button', { name: theme }).click()
      await expect(preview).toBeVisible({ timeout: 20_000 })
      const source = await preview.getAttribute('src')
      expect(source).toMatch(/^data:image\/png;base64,/)
      const bytes = Buffer.from(source!.split(',')[1], 'base64')
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
      expect(bytes.byteLength).toBeGreaterThan(10_000)
      pngByTheme.set(theme, source!)
      await page.screenshot({ path: testInfo.outputPath(`share-${theme.toLowerCase()}.png`) })
    }
    expect(new Set(pngByTheme.values()).size).toBe(3)

    await page.getByRole('button', { name: 'Light' }).click()
    await expect(preview).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => preview.getAttribute('src')).toBe(pngByTheme.get('Light'))

    await resizeAppWindow(launched.app, page, { width: 640, height: 600 })
    await expect(page.getByRole('button', { name: '保存 PNG' })).toBeInViewport()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBeLessThanOrEqual(1)
    await page.screenshot({ path: testInfo.outputPath('share-narrow.png') })
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
  })

  test('Galaxy preserves panned camera and old-node coordinates on presentation updates', async ({}, testInfo) => {
    const { app, page, home } = launched
    await resizeAppWindow(app, page, { width: 1200, height: 800 })
    const graphButton = page.getByTitle('会话图谱')
    if (!await graphButton.evaluate((button) => button.classList.contains('text-primary'))) {
      await graphButton.click()
    }
    await expect(page.getByText('会话图谱').last()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByText('3 sessions')).toBeVisible()

    const canvas = page.locator('canvas')
    await expect(canvas).toBeVisible()
    const beforePan = await canvasColorCentroid(canvas, [245, 158, 11])
    const box = await canvas.boundingBox()
    expect(box).not.toBeNull()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 70, box!.y + box!.height / 2 + 35, { steps: 5 })
    await page.mouse.up()
    const afterPan = await canvasColorCentroid(canvas, [245, 158, 11])
    expect(afterPan.x - beforePan.x).toBeGreaterThan(50)
    expect(afterPan.y - beforePan.y).toBeGreaterThan(20)

    const fixturePath = path.join(home, '.claude', 'projects', '-synthetic-project', `${CLAUDE_FIXTURE_ID}.jsonl`)
    const timestamp = new Date().toISOString()
    fs.appendFileSync(fixturePath, [
      {
        uuid: 'claude-user-presentation-update',
        parentUuid: 'claude-assistant-2',
        sessionId: CLAUDE_FIXTURE_ID,
        type: 'user',
        timestamp,
        cwd: path.join(home, 'project'),
        message: { role: 'user', content: 'Presentation-only update' }
      },
      {
        uuid: 'claude-assistant-presentation-update',
        parentUuid: 'claude-user-presentation-update',
        sessionId: CLAUDE_FIXTURE_ID,
        type: 'assistant',
        requestId: 'claude-request-presentation-update',
        timestamp: new Date(Date.now() + 1).toISOString(),
        cwd: path.join(home, 'project'),
        message: {
          id: 'claude-message-presentation-update',
          role: 'assistant',
          model: 'claude-sonnet-4-20250514',
          content: 'Presentation changed without changing graph membership.',
          stop_reason: 'end_turn',
          usage: { input_tokens: 1_000_000, output_tokens: 100 }
        }
      }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')

    await expect.poll(async () => (await canvasColorCentroid(canvas, [245, 158, 11])).weight, {
      timeout: 20_000
    }).not.toBeCloseTo(afterPan.weight, 2)
    const afterUpdate = await canvasColorCentroid(canvas, [245, 158, 11])
    // A larger antialiased circle can move the exact-color pixel bounds by a
    // few device pixels even though its world coordinate is unchanged.
    expect(Math.abs(afterUpdate.x - afterPan.x)).toBeLessThanOrEqual(4)
    expect(Math.abs(afterUpdate.y - afterPan.y)).toBeLessThanOrEqual(4)
    await page.screenshot({ path: testInfo.outputPath('galaxy-after-live-update.png') })
  })
})
