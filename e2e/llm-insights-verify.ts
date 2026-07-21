/**
 * E2E 验收：AI Insights 报告 + LLM 设置
 * 覆盖：设置面板 AI 配置区 → Insights 页面按钮 → 隐私提醒 → Quick Report 进度与产物
 */
import { _electron as electron } from '@playwright/test'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

async function main() {
  const results: Array<{ step: string; ok: boolean; note?: string }> = []
  const check = (step: string, ok: boolean, note?: string) => {
    results.push({ step, ok, note })
    console.log(`${ok ? '✅' : '❌'} ${step}${note ? ` — ${note}` : ''}`)
  }

  console.log('启动 Electron…')
  const app = await electron.launch({
    args: [path.join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, NODE_ENV: 'test' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(3000)

  // ── 1. 设置面板：AI 分析配置区 ──
  const settingsBtn = page.locator('button:has(svg)').nth(-2) // Settings gear
  await settingsBtn.click()
  await page.waitForTimeout(1000)

  const llmSection = page.locator('text=AI 分析').or(page.locator('text=AI Analysis')).first()
  const llmVisible = await llmSection.isVisible({ timeout: 3000 }).catch(() => false)
  check('设置面板显示 AI 分析区', llmVisible)

  if (llmVisible) {
    // Provider 三选
    const anthropicBtn = page.locator('button', { hasText: 'anthropic' }).first()
    const openaiBtn = page.locator('button', { hasText: 'openai' }).first()
    const customBtn = page.locator('button', { hasText: 'custom' }).first()
    check('provider 三选存在',
      await anthropicBtn.isVisible().catch(() => false) &&
      await openaiBtn.isVisible().catch(() => false) &&
      await customBtn.isVisible().catch(() => false))

    // custom 显示 baseUrl 输入
    await customBtn.click()
    await page.waitForTimeout(300)
    const baseUrlInput = page.locator('input[placeholder*="Base URL"]')
    check('custom provider 显示 baseUrl 输入', await baseUrlInput.isVisible().catch(() => false))

    // 填入测试 key 并保存
    await anthropicBtn.click()
    const keyInput = page.locator('input[type="password"]').first()
    await keyInput.fill('sk-test-e2e-0000')
    const saveBtn = page.locator('button', { hasText: /保存|Save/ }).first()
    await saveBtn.click()
    await page.waitForTimeout(800)
    const savedMark = await page.locator('text=/已保存|Saved/').first().isVisible().catch(() => false)
    check('API key 保存反馈', savedMark)

    await page.screenshot({ path: 'e2e/screenshots/llm-settings.png' })
  }

  // 关闭设置
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)

  // ── 2. Insights 页面：报告卡片 ──
  const insightsBtn = page.locator('button[title*="洞察"], button[title*="nsight"]').first()
  const insightsAlt = page.locator('button:has(svg)').nth(-3)
  const iBtn = await insightsBtn.isVisible({ timeout: 2000 }).catch(() => false) ? insightsBtn : insightsAlt
  await iBtn.click()
  await page.waitForTimeout(2500)

  const reportCard = page.locator('text=Audit Report').first()
  check('Insights 页显示 Audit Report 卡片', await reportCard.isVisible({ timeout: 5000 }).catch(() => false))

  const quickBtn = page.locator('button', { hasText: 'Quick Report' }).first()
  const aiBtn = page.locator('button', { hasText: 'AI Report' }).first()
  check('Quick Report 按钮存在', await quickBtn.isVisible().catch(() => false))
  check('AI Report 按钮存在', await aiBtn.isVisible().catch(() => false))

  // ── 3. AI Report → 隐私提醒 ──
  if (await aiBtn.isVisible().catch(() => false)) {
    await aiBtn.click()
    await page.waitForTimeout(500)
    const privacyNotice = page.locator('text=Privacy Notice').first()
    check('AI Report 弹出隐私提醒', await privacyNotice.isVisible().catch(() => false))
    await page.screenshot({ path: 'e2e/screenshots/llm-privacy-notice.png' })
    const cancelBtn = page.locator('button', { hasText: 'Cancel' }).first()
    if (await cancelBtn.isVisible().catch(() => false)) await cancelBtn.click()
    await page.waitForTimeout(300)
  }

  // ── 4. Quick Report：进度 + 产物 ──
  const reportDir = path.join(os.homedir(), '.claude-session-manager', 'reports')
  const before = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).length : 0

  if (await quickBtn.isVisible().catch(() => false)) {
    await quickBtn.click()
    // 进度指示应出现
    const progressSeen = await page.locator('text=/Auditing sessions|Starting/').first()
      .isVisible({ timeout: 5000 }).catch(() => false)
    check('生成中显示实时进度', progressSeen)
    await page.screenshot({ path: 'e2e/screenshots/llm-progress.png' })

    // 等完成（最多 120s）
    const done = await page.locator('text=/Report generated/').first()
      .waitFor({ state: 'visible', timeout: 120_000 }).then(() => true).catch(() => false)
    check('Quick Report 生成完成', done)

    const after = fs.existsSync(reportDir) ? fs.readdirSync(reportDir).length : 0
    check('报告 HTML 已落盘', after > before, `${before} → ${after} files in reports/`)

    const latest = path.join(reportDir, 'insights-latest.html')
    if (fs.existsSync(latest)) {
      const html = fs.readFileSync(latest, 'utf-8')
      check('报告含 dashboard 与健康分布', html.includes('Swob Session Insights') && html.includes('Health Distribution'))
    }
    await page.screenshot({ path: 'e2e/screenshots/llm-report-done.png' })
  }

  await app.close()

  const failed = results.filter(r => !r.ok)
  console.log(`\n结果: ${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
