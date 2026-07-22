import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv as launchApp } from './helpers'

let app: ElectronApplication
let page: Page
let fixtureHome: string
let vaultRoot: string
let screenshotDir: string
const originalSessionDirs: string[] = []

function createSessionPackage(index: number, turns: number, tags: string[]): void {
  const sessionId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  const dir = path.join(vaultRoot, `💬 会话 ${index}`)
  originalSessionDirs.push(dir)
  fs.mkdirSync(dir, { recursive: true })
  const rows: unknown[] = []
  for (let turn = 0; turn < turns; turn++) {
    rows.push({
      uuid: `${sessionId}-u-${turn}`,
      parentUuid: turn === 0 ? null : `${sessionId}-a-${turn - 1}`,
      sessionId,
      type: 'user',
      timestamp: new Date(Date.UTC(2026, 6, 21 - index, 1, turn % 60)).toISOString(),
      cwd: `/fixtures/project-${index % 2 === 0 ? 'alpha' : 'beta'}`,
      promptSource: 'typed',
      message: { role: 'user', content: turn === 0 ? `测试会话 ${index} 的标题` : `第 ${turn + 1} 轮` }
    })
    rows.push({
      uuid: `${sessionId}-a-${turn}`,
      parentUuid: `${sessionId}-u-${turn}`,
      sessionId,
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 6, 21 - index, 1, (turn % 60) + 1)).toISOString(),
      cwd: `/fixtures/project-${index % 2 === 0 ? 'alpha' : 'beta'}`,
      message: { role: 'assistant', content: 'fixture response' }
    })
  }
  const backup = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  fs.writeFileSync(path.join(dir, 'backup.jsonl'), backup)
  fs.writeFileSync(path.join(dir, 'transcript.md'), `# 测试会话 ${index}\n`)
  fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
    schemaVersion: 2,
    sessionId,
    sourceFilePaths: [`/nonexistent/fixture-${index}.jsonl`],
    createdAt: `2026-07-${String(21 - index).padStart(2, '0')}T01:00:00.000Z`,
    updatedAt: `2026-07-${String(21 - index).padStart(2, '0')}T02:00:00.000Z`,
    projectPath: `/fixtures/project-${index % 2 === 0 ? 'alpha' : 'beta'}`,
    turnCount: turns,
    tags
  }, null, 2))
}

function snapshot(root: string): string[] {
  const result: string[] = []
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const fullPath = path.join(dir, name)
      const relative = path.relative(root, fullPath)
      // Lineage is an independently scheduled derived registry and may finish during
      // this assertion window. Lens purity concerns config, notes and session packages.
      if (relative === '.session-lineage.json') continue
      const stat = fs.statSync(fullPath)
      if (stat.isDirectory()) walk(fullPath)
      else {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex')
        result.push(`${relative}:${stat.mtimeMs}:${hash}`)
      }
    }
  }
  walk(root)
  return result
}

test.beforeAll(async () => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t101-e2e-'))
  vaultRoot = path.join(fixtureHome, 'Documents', 'Swob')
  screenshotDir = path.join(os.tmpdir(), 'swob-t101-visual')
  fs.rmSync(screenshotDir, { recursive: true, force: true })
  fs.mkdirSync(vaultRoot, { recursive: true })
  fs.mkdirSync(screenshotDir, { recursive: true })
  fs.writeFileSync(path.join(vaultRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot: vaultRoot,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }, null, 2))
  fs.writeFileSync(path.join(vaultRoot, '项目说明.md'), '# 普通笔记，不能被整理移动\n')
  ;[1, 5, 10, 40, 100].forEach((turns, index) => createSessionPackage(index + 1, turns, index === 0 ? ['产品', '性能'] : [`标签${index + 1}`]))

  const launched = await launchApp({ env: { HOME: fixtureHome } })
  app = launched.app
  page = launched.page
  // tF4 起侧栏分组默认全折叠:先等分组出现,展开第一组后会话才可见
  await page.getByRole('tab', { name: /查看全部会话/ }).click()
  await expect(page.locator('[data-lens-group]').first()).toBeVisible({ timeout: 20_000 })
  await page.locator('[data-lens-group] > button').first().click()
  await expect(page.locator('[data-session-id]').first()).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(1500)
})

test.afterAll(async () => {
  await app.close()
  fs.rmSync(fixtureHome, { recursive: true, force: true })
})

test('文件夹与镜头切换、7 维分组不会写 Vault', async () => {
  await page.getByRole('tab', { name: /整理会话/ }).click()
  await expect(page.getByRole('tab', { name: /整理会话/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByText('项目说明.md')).toBeVisible()
  // 根目录散放：不再有 Inbox 容器；游离会话直接显示
  await expect(page.getByText('Inbox', { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-session-id]').first()).toBeVisible()
  const sidebar = page.locator('[data-testid="sidebar"]')
  const resizeHandle = page.locator('.cursor-col-resize').first()
  const beforeResize = await sidebar.boundingBox()
  const handleBox = await resizeHandle.boundingBox()
  if (beforeResize && handleBox) {
    await page.mouse.move(handleBox.x + 1, handleBox.y + handleBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(handleBox.x + 81, handleBox.y + handleBox.height / 2)
    await page.mouse.up()
    await expect.poll(async () => (await sidebar.boundingBox())?.width || 0).toBeGreaterThan(beforeResize.width + 50)
  }
  await page.screenshot({ path: path.join(screenshotDir, 'folders.png') })

  const before = snapshot(vaultRoot)
  await page.getByRole('tab', { name: /查看全部会话/ }).click()
  for (const label of ['项目', '日期', '标签', 'harness', '轮数', '来源', '无分组']) {
    await page.getByRole('button', { name: label, exact: true }).click()
    await expect(page.locator('[data-testid="lens-view"]')).toBeVisible()
  }
  await page.getByRole('button', { name: '标签', exact: true }).click()
  await expect(page.locator('[data-lens-group="tag:产品"]')).toBeVisible()
  await expect(page.locator('[data-lens-group="tag:性能"]')).toBeVisible()
  // tF4 起分组默认折叠:展开「产品」组后才有会话项;折叠组头部自带 chevron-right,断言只限会话项内
  await page.locator('[data-lens-group="tag:产品"] > button').click()
  await expect(page.locator('[data-testid="lens-view"] [data-session-id]').first()).toHaveAttribute('draggable', 'false')
  await expect(page.locator('[data-testid="lens-view"] [data-session-id] .lucide-folder')).toHaveCount(0)
  await expect(page.locator('[data-testid="lens-view"] [data-session-id] .lucide-chevron-right')).toHaveCount(0)
  await page.locator('[data-testid="lens-view"] [data-session-id]').first().click()
  await page.screenshot({ path: path.join(screenshotDir, 'lens-tags.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.screenshot({ path: path.join(screenshotDir, 'lens-tags-dark.png') })
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  expect(snapshot(vaultRoot)).toEqual(before)
})

test('按项目整理预览、确认和一键撤销形成闭环', async () => {
  await page.getByRole('button', { name: '按项目整理', exact: true }).click()
  const panel = page.locator('[data-testid="organizer-panel"]')
  await expect(panel).toBeVisible()
  await expect(panel.getByText(/确认前不会移动任何文件/)).toBeVisible()
  await expect(panel.getByRole('button', { name: /接受所选/ })).toBeVisible({ timeout: 10_000 })
  await page.screenshot({ path: path.join(screenshotDir, 'project-preview.png') })

  await panel.getByRole('button', { name: /接受所选/ }).click()
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeVisible()
  expect(originalSessionDirs.some((dir) => !fs.existsSync(dir))).toBe(true)

  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await expect.poll(() => originalSessionDirs.every((dir) => fs.existsSync(dir))).toBe(true)
})

test('智能整理无 API 时给出明确边界，不尝试假分类', async () => {
  await page.getByRole('button', { name: '智能整理', exact: true }).click()
  const panel = page.locator('[data-testid="organizer-panel"]')
  await expect(panel.getByText(/需要先在设置中配置 LLM API/)).toBeVisible()
  await panel.getByRole('button', { name: '关闭整理预览' }).click()
})
