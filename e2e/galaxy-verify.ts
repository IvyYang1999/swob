import { closeApp, launchApp } from './helpers'

async function main() {
  console.log('启动 Electron…')
  const launched = await launchApp()
  const { app, page } = launched
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // 点击血统图按钮 — toolbar 里倒数第3个按钮（GitBranch 图标）
  await page.waitForTimeout(2000)
  const lineageBtn = page.locator('button:has(svg)').nth(-3)
  const altBtn = page.locator('button[title="血统图"], button[title="Lineage"]').first()
  const btn = await altBtn.isVisible({ timeout: 2000 }).catch(() => false) ? altBtn : lineageBtn
  if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await btn.click()
    // 等待力模拟计算完成（1700+ nodes）
    await page.waitForTimeout(20000)
    await page.screenshot({ path: 'e2e/screenshots/galaxy-view.png' })
    console.log('✅ galaxy-view.png')
  } else {
    console.log('⚠️ 未找到按钮')
    await page.screenshot({ path: 'e2e/screenshots/galaxy-debug.png' })
  }

  await closeApp(launched)
  console.log('Done')
}

main().catch(e => { console.error(e); process.exit(1) })
