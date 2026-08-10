import { expect, test } from '@playwright/test'

const fixtureUrl = 'http://127.0.0.1:4179/catalog-visual.html'

test('t211E isolated Catalog shell renders long scopes and read-only root states at wide and narrow sizes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 820, height: 620 }); await page.goto(fixtureUrl)
  await expect(page.getByRole('navigation', { name: 'Workspace tabs' })).toBeVisible()
  await expect(page.getByText('Permission denied · catalog data is unchanged')).toBeVisible()
  await expect(page.getByRole('region', { name: 'Catalog onboarding' })).toContainText('Discovery is read-only')
  await page.getByRole('button', { name: 'Index only — do not archive' }).click(); await expect(page.getByRole('button', { name: 'Index only — do not archive' })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('tab', { name: /Locations/ }).click(); await expect(page.getByText('stale').first()).toBeVisible()
  await page.getByRole('tab', { name: /Sources/ }).click(); await expect(page.getByText('Claude Code', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /Collections/ }).click(); await page.getByText('Swob · 2026 launch with a very long project name').hover()
  await page.getByRole('button', { name: 'New workspace tab' }).focus()
  await expect(page.getByRole('button', { name: 'New workspace tab' })).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('catalog-wide.png'), fullPage: false })

  const firstTab = page.getByRole('tab', { name: 'All sessions · Insights' }); await firstTab.focus(); await firstTab.press('ArrowRight'); await expect(page.getByRole('tab', { name: 'Obsidian Vault · Sessions' })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Obsidian Vault · Sessions' }).dblclick(); await expect(page.getByRole('tab', { name: /renamed/ })).toBeVisible()
  await page.getByRole('tab', { name: /renamed/ }).hover(); await page.getByRole('button', { name: /Duplicate Obsidian Vault/ }).click(); await expect(page.getByRole('tab', { name: /copy/ })).toBeVisible()
  const resizer = page.getByRole('separator', { name: 'Resize Catalog sidebar' }); const before = await resizer.boundingBox(); if (!before) throw new Error('missing resizer'); await page.mouse.move(before.x + 2, before.y + 30); await page.mouse.down(); await page.mouse.move(360, before.y + 30); await page.mouse.up(); expect((await resizer.boundingBox())!.x).toBeGreaterThan(340)

  for (const theme of ['light', 'dim', 'contrast']) {
    await page.goto(`${fixtureUrl}?theme=${theme}`); await expect(page.getByRole('navigation', { name: 'Workspace tabs' })).toBeVisible(); await page.screenshot({ path: testInfo.outputPath(`catalog-${theme}.png`), fullPage: false })
  }

  await page.setViewportSize({ width: 480, height: 620 })
  await page.goto(`${fixtureUrl}?locale=zh`)
  await expect(page.getByRole('navigation', { name: '工作区标签页' })).toBeVisible()
  await expect(page.getByRole('tab', { name: '集合' })).toBeVisible()
  await expect(page.getByText('权限被拒绝 · 目录数据保持不变')).toBeVisible()
  await expect(page.getByRole('region', { name: '资料目录首次设置' })).toContainText('发现过程只读')
  const strip = page.getByTestId('workspace-tab-strip')
  await strip.evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  await page.screenshot({ path: testInfo.outputPath('catalog-narrow.png'), fullPage: false })
})
