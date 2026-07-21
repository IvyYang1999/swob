/** 补充验收：设置面板 AI 分析区（用 title 精确定位 settings 按钮） */
import { _electron as electron } from '@playwright/test'
import * as path from 'path'

async function main() {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // Settings 按钮：title=设置/Settings
  const settingsBtn = page.locator('button[title*="设置"], button[title*="ettings"]').first()
  const found = await settingsBtn.isVisible({ timeout: 3000 }).catch(() => false)
  console.log(`${found ? '✅' : '❌'} 找到设置按钮`)
  if (!found) { await app.close(); process.exit(1) }
  await settingsBtn.click()
  await page.waitForTimeout(1200)

  const llmSection = page.locator('text=/AI 分析|AI Analysis/').first()
  const llmVisible = await llmSection.isVisible({ timeout: 3000 }).catch(() => false)
  console.log(`${llmVisible ? '✅' : '❌'} 设置面板显示 AI 分析区`)

  if (llmVisible) {
    await llmSection.scrollIntoViewIfNeeded()
    const anthropicBtn = page.locator('button', { hasText: 'anthropic' }).first()
    const customBtn = page.locator('button', { hasText: 'custom' }).first()
    console.log(`${await anthropicBtn.isVisible().catch(() => false) ? '✅' : '❌'} provider 选项存在`)

    await customBtn.click()
    await page.waitForTimeout(300)
    const baseUrlInput = page.locator('input[placeholder*="Base URL"]')
    console.log(`${await baseUrlInput.isVisible().catch(() => false) ? '✅' : '❌'} custom 显示 baseUrl 输入`)

    await anthropicBtn.click()
    const keyInput = page.locator('input[type="password"]').last()
    await keyInput.fill('sk-test-e2e-0000')
    const saveBtn = page.locator('button', { hasText: /^保存$|^Save$/ }).first()
    await saveBtn.click()
    await page.waitForTimeout(800)
    const savedMark = await page.locator('text=/已保存|Saved/').first().isVisible().catch(() => false)
    console.log(`${savedMark ? '✅' : '❌'} API key 保存反馈`)

    // 验证持久化：key hint 应显示末 4 位
    const persisted = await page.locator('input[placeholder*="0000"]').first().isVisible().catch(() => false)
    console.log(`${persisted ? '✅' : '❌'} key 持久化（placeholder 显示末 4 位）`)

    await page.screenshot({ path: 'e2e/screenshots/llm-settings.png' })
  }

  await app.close()
  console.log('Done')
}
main().catch(e => { console.error(e); process.exit(1) })
