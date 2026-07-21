import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv as launchApp } from './helpers'

let app: ElectronApplication
let page: Page
let fixtureHome: string
let vaultRoot: string
let screenshotDir: string

test.describe.configure({ mode: 'serial' })

function navItem(name: string) {
  return page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name })
}

test.beforeAll(async () => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-t103v-e2e-'))
  vaultRoot = path.join(fixtureHome, 'Documents', 'Swob')
  screenshotDir = path.join(os.tmpdir(), 'swob-t103v-settings-visual')
  fs.rmSync(screenshotDir, { recursive: true, force: true })
  fs.mkdirSync(vaultRoot, { recursive: true })
  fs.mkdirSync(screenshotDir, { recursive: true })
  fs.mkdirSync(path.join(fixtureHome, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(fixtureHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: vaultRoot, onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(vaultRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot: vaultRoot,
    preferences: {
      defaultViewMode: 'compact',
      terminalApp: 'Terminal',
      resumeTerminal: 'terminal-app',
      projectViewMode: 'folders',
      legacyFixtureField: 'must-survive'
    }
  }, null, 2))

  const launched = await launchApp({ env: { HOME: fixtureHome } })
  app = launched.app
  page = launched.page
  await page.setViewportSize({ width: 760, height: 660 })
  await page.getByTitle('设置').click()
  await expect(page.getByRole('dialog', { name: '设置' })).toBeVisible()
})

test.afterAll(async () => {
  if (app) await app.close()
  if (fixtureHome) fs.rmSync(fixtureHome, { recursive: true, force: true })
})

test('纵向左栏七项同时可见，无横向 Tab，旧配置迁移生效', async () => {
  const dialog = page.getByRole('dialog', { name: '设置' })
  const nav = dialog.getByRole('navigation', { name: '设置分类' })
  const items = nav.getByRole('button')
  await expect(items).toHaveCount(7)
  await expect(items).toHaveText(['通用', '终端', 'Resume', 'SSH', '视图', '更新', 'CLI'])
  await expect(dialog.getByRole('tab')).toHaveCount(0)
  await expect(nav.getByRole('button', { name: '外观' })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: '通用' })).toHaveAttribute('aria-current', 'page')

  // 七项都在可视区(左栏不滚动即可见)
  for (const name of ['通用', '终端', 'Resume', 'SSH', '视图', '更新', 'CLI']) {
    await expect(nav.getByRole('button', { name })).toBeInViewport()
  }

  await page.getByRole('button', { name: '浅色' }).click()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'general-light.png') })
})

test('终端分类展示检测结果和路径，可靠入口才可选', async () => {
  await navItem('终端').click()
  const terminalButton = page.getByRole('button', { name: /Terminal.*System\/Applications\/Utilities\/Terminal\.app/ }).first()
  await expect(terminalButton).toBeVisible()
  await expect(page.getByText('所有 CLI Resume 都会使用这里选择的终端。')).toBeVisible()
  await expect(page.getByRole('button', { name: '重新检测' })).toBeVisible()
  await terminalButton.hover()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'terminals-light.png') })
})

test('Resume 分类按 harness 动态过滤，实验开关在本分类', async () => {
  await navItem('通用').click()
  await page.getByRole('button', { name: '深色' }).click()
  await navItem('Resume').click()
  await expect(page.getByRole('combobox')).toHaveCount(10)
  const zcode = page.getByRole('combobox', { name: /ZCode 默认方式/ })
  await expect(zcode).toHaveValue('zcode-desktop')
  expect(await zcode.locator('option[value="terminal"]').isDisabled()).toBe(true)
  await expect(zcode.locator('option[value="terminal"]')).toContainText('没有公开 CLI Resume')

  const claudeExperiment = page.getByRole('checkbox', { name: '实验：导入到 Claude Desktop' })
  await expect(claudeExperiment).not.toBeChecked()
  await claudeExperiment.check()
  await expect(claudeExperiment).toBeChecked()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'resume-dark.png') })
})

test('SSH 包含远程连接信息和三段教程，不出现手机文案', async () => {
  await navItem('SSH').click()
  await expect(page.getByText('远程连接信息')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/手机/)).toHaveCount(0)
  await page.getByText('查找远程机器地址').click()
  await expect(page.getByText(/远程机器运行 hostname/)).toBeVisible()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'ssh-guide.png') })
})

test('视图设置写入新结构，同时保留旧配置字段', async () => {
  await navItem('视图').click()
  await page.getByRole('group', { name: '默认排序' }).getByRole('button', { name: '轮数' }).click()
  await page.getByRole('group', { name: '默认分组' }).getByRole('button', { name: '按日期' }).click()
  await page.getByRole('group', { name: '单轮会话处理' }).getByRole('button', { name: '隐藏' }).click()

  await expect.poll(() => {
    const config = JSON.parse(fs.readFileSync(path.join(vaultRoot, '.swob-config.json'), 'utf-8'))
    return config.preferences
  }).toMatchObject({
    settingsSchemaVersion: 1,
    defaultSort: 'turns',
    defaultGrouping: 'date',
    singleTurnBehavior: 'hide',
    legacyFixtureField: 'must-survive'
  })
})

test('更新与 CLI 完全分离', async () => {
  await navItem('更新').click()
  await expect(page.getByRole('button', { name: '检查更新' })).toBeVisible()
  await expect(page.getByText(/Swob v/)).toBeVisible()
  await expect(page.getByText('CLI & Agent')).toHaveCount(0)

  await navItem('CLI').click()
  await expect(page.getByText('CLI & Agent')).toBeVisible()
  await expect(page.getByRole('button', { name: '检查更新' })).toHaveCount(0)
})

test('窄窗口仍是纵向导航,左栏固定,右侧内容独立滚动', async () => {
  await page.setViewportSize({ width: 480, height: 520 })
  const dialog = page.getByRole('dialog', { name: '设置' })
  const nav = dialog.getByRole('navigation', { name: '设置分类' })

  // 仍是纵向导航,七项可见,无横向 tablist
  await expect(nav).toBeVisible()
  await expect(dialog.getByRole('tablist')).toHaveCount(0)
  for (const name of ['通用', 'CLI']) {
    await expect(nav.getByRole('button', { name })).toBeInViewport()
  }
  // 导航区无横向滚动
  const navMetrics = await nav.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(navMetrics.scrollWidth).toBeLessThanOrEqual(navMetrics.clientWidth + 1)

  // 右侧内容独立纵向滚动
  await navItem('通用').click()
  const content = page.locator('[data-settings-category="general"]')
  const contentMetrics = await content.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY
  }))
  expect(contentMetrics.scrollHeight).toBeGreaterThan(contentMetrics.clientHeight)
  expect(contentMetrics.overflowY).toBe('auto')
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'narrow-vertical-nav.png') })

  // Escape 关闭
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: '设置' })).toHaveCount(0)
})
