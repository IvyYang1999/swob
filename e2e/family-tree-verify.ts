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

  // 点击一个有血统关系的 session
  // 从 lineage registry 已知 0221f87e 有 continuation 关系
  const sessionBtn = page.locator('[data-session-id]').first()
  if (await sessionBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await sessionBtn.click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'e2e/screenshots/family-tree-infopanel.png' })
    console.log('✅ family-tree-infopanel.png (first session)')
  }

  // 尝试搜索有血统的 session
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(500)
  await page.keyboard.type('codex')
  await page.waitForTimeout(1000)
  await page.screenshot({ path: 'e2e/screenshots/search-codex.png' })

  // 按 Escape 关闭搜索
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // 截全局血统图对比
  const lineageBtn = page.locator('button[title*="ineage"], button[title*="血统"], button[aria-label*="ineage"], button[aria-label*="血统"]').first()
  if (await lineageBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await lineageBtn.click()
    await page.waitForTimeout(2000)
    await page.screenshot({ path: 'e2e/screenshots/lineage-global-v2.png' })
    console.log('✅ lineage-global-v2.png')
  }

  await app.close()
  console.log('Done')
}

main().catch(e => { console.error(e); process.exit(1) })
