import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv as launchApp } from './helpers'

const SHOT_DIR = path.join(os.tmpdir(), 'swob-t104-visual')

test.beforeAll(() => {
  fs.rmSync(SHOT_DIR, { recursive: true, force: true })
  fs.mkdirSync(SHOT_DIR, { recursive: true })
})

test('引导三步截图', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t104-shot-'))
  const { app, page } = await launchApp({ env: { HOME: home } })
  try {
    await page.setViewportSize({ width: 1000, height: 700 })
    const onboarding = page.locator('[data-testid="onboarding"]')
    await expect(onboarding).toBeVisible({ timeout: 20_000 })
    await page.screenshot({ path: path.join(SHOT_DIR, '1-welcome.png') })
    await onboarding.getByRole('button', { name: /开始设置/ }).click()
    await expect(onboarding.getByText('为你的会话安个家')).toBeVisible()
    await page.screenshot({ path: path.join(SHOT_DIR, '2-vault.png') })
    await onboarding.getByRole('button', { name: /就放这里/ }).click()
    await expect(onboarding.getByText('发现了这些会话')).toBeVisible()
    await page.screenshot({ path: path.join(SHOT_DIR, '3-scan.png') })
  } finally {
    await app.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('新侧边栏与库位置弹窗截图', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t104-shot2-'))
  const vault = path.join(home, 'Documents', 'Swob')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: vault, onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(vault, '.swob-config.json'), JSON.stringify({
    libraryRoot: vault,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }))
  fs.mkdirSync(path.join(vault, '项目笔记'), { recursive: true })
  fs.writeFileSync(path.join(vault, '项目笔记', '想法.md'), '# 想法\n')
  for (let i = 1; i <= 3; i++) {
    const dir = path.join(vault, `💬 演示会话 ${i}`)
    const sessionId = `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    const turns = i === 3 ? 1 : 10 + i
    fs.mkdirSync(dir, { recursive: true })
    const rows: string[] = []
    for (let turn = 0; turn < turns; turn++) {
      rows.push(JSON.stringify({
        uuid: `${sessionId}-u-${turn}`,
        parentUuid: turn === 0 ? null : `${sessionId}-a-${turn - 1}`,
        sessionId,
        type: 'user',
        timestamp: new Date(Date.UTC(2026, 6, 20, 1, turn % 60)).toISOString(),
        cwd: '/fixtures/demo',
        promptSource: 'typed',
        message: { role: 'user', content: turn === 0 ? `演示会话 ${i} 的第一条消息` : `第 ${turn + 1} 轮` }
      }))
      rows.push(JSON.stringify({
        uuid: `${sessionId}-a-${turn}`,
        parentUuid: `${sessionId}-u-${turn}`,
        sessionId,
        type: 'assistant',
        timestamp: new Date(Date.UTC(2026, 6, 20, 1, (turn % 60) + 1)).toISOString(),
        cwd: '/fixtures/demo',
        message: { role: 'assistant', content: 'demo response' }
      }))
    }
    fs.writeFileSync(path.join(dir, 'backup.jsonl'), rows.join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'transcript.md'), `# 演示会话 ${i}\n`)
    fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      sourceFilePaths: [`/nonexistent/demo-${i}.jsonl`],
      createdAt: '2026-07-20T01:00:00.000Z',
      updatedAt: '2026-07-21T02:00:00.000Z',
      projectPath: '/fixtures/demo',
      turnCount: turns
    }))
  }
  const { app, page } = await launchApp({ env: { HOME: home } })
  try {
    await page.setViewportSize({ width: 1200, height: 760 })
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(1500)
    await page.screenshot({ path: path.join(SHOT_DIR, '4-sidebar-folders.png') })
    await page.getByRole('tab', { name: /镜头/ }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(SHOT_DIR, '5-sidebar-lens.png') })
    await page.getByRole('tab', { name: /文件夹/ }).click()
    await page.locator('[title*="库位置"]').click()
    await expect(page.locator('[data-testid="vault-location-modal"]')).toBeVisible()
    await page.screenshot({ path: path.join(SHOT_DIR, '6-vault-location-modal.png') })
  } finally {
    await app.close()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
