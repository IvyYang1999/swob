/**
 * 血统图 UI 快速验收脚本（非测试，直接跑截图）
 */
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

  // 截主界面
  await page.screenshot({ path: 'e2e/screenshots/main-verify.png' })
  console.log('✅ main-verify.png')

  // 找到血统图按钮（toolbar 里的 GitBranch 图标）并点击
  const lineageBtn = page.locator('button[title*="ineage"], button[title*="血统"], button[aria-label*="ineage"], button[aria-label*="血统"]').first()
  if (await lineageBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await lineageBtn.click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'e2e/screenshots/lineage-view.png' })
    console.log('✅ lineage-view.png')
  } else {
    // 尝试通过 toolbar 所有按钮找
    const buttons = page.locator('button svg')
    const count = await buttons.count()
    console.log(`toolbar 按钮数: ${count}`)
    // 截图看 toolbar 状态
    await page.screenshot({ path: 'e2e/screenshots/toolbar-debug.png' })
    console.log('⚠️ 未找到血统图按钮，已截 toolbar-debug.png')
  }

  await app.close()
  console.log('Done')
}

main().catch(e => { console.error(e); process.exit(1) })
