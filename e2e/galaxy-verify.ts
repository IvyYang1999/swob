import { _electron as electron } from '@playwright/test'
import * as path from 'path'

async function main() {
  console.log('启动 Electron…')
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test' }
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // 点击血统图按钮
  const lineageBtn = page.locator('button[title*="ineage"], button[title*="血统"], button[aria-label*="ineage"], button[aria-label*="血统"]').first()
  if (await lineageBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await lineageBtn.click()
    // 等待力模拟计算完成
    await page.waitForTimeout(8000)
    await page.screenshot({ path: 'e2e/screenshots/galaxy-view.png' })
    console.log('✅ galaxy-view.png')
  } else {
    console.log('⚠️ 未找到按钮')
    await page.screenshot({ path: 'e2e/screenshots/galaxy-debug.png' })
  }

  await app.close()
  console.log('Done')
}

main().catch(e => { console.error(e); process.exit(1) })
