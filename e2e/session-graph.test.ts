import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchApp } from './helpers'

let app: ElectronApplication
let page: Page

test.describe.serial('Session Galaxy', () => {
  test.beforeAll(async () => {
    const launched = await launchApp()
    app = launched.app
    page = launched.page
    await expect(page.locator('[data-session-id]').first()).toBeVisible({ timeout: 15_000 })
  })

  test.afterAll(async () => {
    if (!page.isClosed()) {
      const host = page.locator('.session-graph-host')
      if (await host.isVisible().catch(() => false)) {
        await host.press('Escape').catch(() => undefined)
        await expect(host).toBeHidden({ timeout: 5_000 }).catch(() => undefined)
      }
    }
    app.process().kill('SIGKILL')
  })

  test('shows a WebGL first frame within 500ms and animates off the UI thread', async () => {
    const button = page.locator('button[title="血统图"], button[title="Lineage"]').first()
    await button.click()
    const host = page.locator('.session-graph-host')
    await expect(host).toHaveAttribute('data-graph-first-frame', 'true', { timeout: 2_000 })
    expect(Number(await host.getAttribute('data-graph-first-frame-ms'))).toBeLessThan(500)
    await expect(host).toHaveAttribute('data-graph-ready', 'true', { timeout: 8_000 })
    await expect(host.locator('canvas[data-renderer="webgl"]')).toBeVisible()

    await expect(host).toHaveAttribute('data-graph-alpha', /\d/, { timeout: 2_000 })
    const firstAlpha = Number(await host.getAttribute('data-graph-alpha'))
    await page.waitForTimeout(180)
    const secondAlpha = Number(await host.getAttribute('data-graph-alpha'))
    expect(firstAlpha).toBeGreaterThan(secondAlpha)

    const frameStats = await page.evaluate(() => new Promise<{ maxGap: number; frames: number }>((resolve) => {
      const started = performance.now()
      let previous = started
      let maxGap = 0
      let frames = 0
      const frame = (now: number) => {
        maxGap = Math.max(maxGap, now - previous)
        previous = now
        frames++
        if (now - started >= 500) resolve({ maxGap, frames })
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }))
    expect(frameStats.frames).toBeGreaterThan(20)
    expect(frameStats.maxGap).toBeLessThan(80)
  })

  test('anchors wheel zoom at the cursor and pans with inertia', async () => {
    const host = page.locator('.session-graph-host')
    const box = await host.boundingBox()
    expect(box).not.toBeNull()
    const mouseLocal = { x: box!.width * 0.73, y: box!.height * 0.41 }
    const before = {
      scale: Number(await host.getAttribute('data-graph-scale')),
      x: Number(await host.getAttribute('data-graph-x')),
      y: Number(await host.getAttribute('data-graph-y'))
    }
    const world = {
      x: (mouseLocal.x - before.x) / before.scale,
      y: (mouseLocal.y - before.y) / before.scale
    }
    await page.mouse.move(box!.x + mouseLocal.x, box!.y + mouseLocal.y)
    await page.mouse.wheel(0, -280)
    await page.waitForTimeout(80)
    const after = {
      scale: Number(await host.getAttribute('data-graph-scale')),
      x: Number(await host.getAttribute('data-graph-x')),
      y: Number(await host.getAttribute('data-graph-y'))
    }
    expect(after.scale).toBeGreaterThan(before.scale)
    expect(after.x + world.x * after.scale).toBeCloseTo(mouseLocal.x, 0)
    expect(after.y + world.y * after.scale).toBeCloseTo(mouseLocal.y, 0)

    const candidates = [
      { x: 12, y: 12 },
      { x: box!.width - 12, y: 12 },
      { x: 12, y: box!.height - 12 },
      { x: box!.width - 12, y: box!.height - 12 }
    ]
    let blank = candidates[0]
    for (const candidate of candidates) {
      await page.mouse.move(box!.x + candidate.x, box!.y + candidate.y)
      if (await host.getAttribute('data-graph-hover-active') === 'false') {
        blank = candidate
        break
      }
    }
    await page.mouse.move(box!.x + blank.x, box!.y + blank.y)
    await page.mouse.down()
    await page.mouse.move(box!.x + blank.x + 70, box!.y + blank.y + 36, { steps: 4 })
    await page.mouse.up()
    const released = {
      x: Number(await host.getAttribute('data-graph-x')),
      y: Number(await host.getAttribute('data-graph-y'))
    }
    await page.waitForTimeout(120)
    const inertial = {
      x: Number(await host.getAttribute('data-graph-x')),
      y: Number(await host.getAttribute('data-graph-y'))
    }
    expect(Math.hypot(inertial.x - released.x, inertial.y - released.y)).toBeGreaterThan(1)
  })

  test('supports hover, node drag reheat, rebound, and click-through', async () => {
    const host = page.locator('.session-graph-host')
    await expect(host).toHaveAttribute('data-graph-settled', 'true', { timeout: 12_000 })
    const box = await host.boundingBox()
    expect(box).not.toBeNull()
    const fitCandidates = [
      { x: 12, y: 12 },
      { x: box!.width - 12, y: 12 },
      { x: 12, y: box!.height - 12 },
      { x: box!.width - 12, y: box!.height - 12 }
    ]
    let fitPoint = fitCandidates[0]
    for (const candidate of fitCandidates) {
      await page.mouse.move(box!.x + candidate.x, box!.y + candidate.y)
      if (await host.getAttribute('data-graph-hover-active') === 'false') {
        fitPoint = candidate
        break
      }
    }
    await host.locator('canvas[data-renderer="webgl"]').dispatchEvent('dblclick', {
      clientX: box!.x + fitPoint.x,
      clientY: box!.y + fitPoint.y,
      bubbles: true
    })
    await expect(host).toHaveAttribute('data-graph-viewport-animating', 'false', { timeout: 5_000 })
    const probe = async () => ({
      x: Number(await host.getAttribute('data-graph-probe-x')),
      y: Number(await host.getAttribute('data-graph-probe-y'))
    })

    let point = await probe()
    await page.mouse.move(box!.x + point.x, box!.y + point.y)
    await expect(host).toHaveAttribute('data-graph-hover-active', 'true')
    await expect(page.locator('[role="tooltip"]')).toBeVisible()

    await page.mouse.down()
    await page.mouse.move(box!.x + point.x + 46, box!.y + point.y + 28, { steps: 4 })
    await expect(host).toHaveAttribute('data-graph-dragging-node', 'true')
    await page.mouse.up()
    await expect(host).toHaveAttribute('data-graph-dragging-node', 'false')
    const released = await probe()
    await page.waitForTimeout(420)
    const rebounded = await probe()
    expect(Math.hypot(rebounded.x - released.x, rebounded.y - released.y)).toBeGreaterThan(1)

    await page.waitForFunction(() => {
      const alpha = Number(document.querySelector('.session-graph-host')?.getAttribute('data-graph-alpha'))
      return Number.isFinite(alpha) && alpha < 0.03
    }, undefined, { timeout: 15_000 })
    for (let attempt = 0; attempt < 6 && await host.isVisible(); attempt++) {
      point = await probe()
      await page.mouse.move(box!.x + point.x, box!.y + point.y)
      if (await host.getAttribute('data-graph-hover-active') === 'true') {
        await page.mouse.down()
        await page.mouse.up()
        break
      }
      await page.waitForTimeout(40)
    }
    await expect(host).toBeHidden({ timeout: 5_000 })
  })
})
