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

test('纵向左栏九项同时可见，无横向 Tab，旧配置迁移生效', async () => {
  const dialog = page.getByRole('dialog', { name: '设置' })
  const nav = dialog.getByRole('navigation', { name: '设置分类' })
  const items = nav.getByRole('button')
  await expect(items).toHaveCount(9)
  await expect(items).toHaveText(['通用', 'AI 智能', '助手', '终端', '继续', 'SSH', '视图', '更新', 'CLI'])
  await expect(dialog.getByRole('tab')).toHaveCount(0)
  await expect(nav.getByRole('button', { name: '外观' })).toHaveCount(0)
  await expect(nav.getByRole('button', { name: '通用' })).toHaveAttribute('aria-current', 'page')

  // 九项都在可视区(左栏不滚动即可见)
  for (const name of ['通用', 'AI 智能', '助手', '终端', '继续', 'SSH', '视图', '更新', 'CLI']) {
    await expect(nav.getByRole('button', { name })).toBeInViewport()
  }

  await page.getByRole('button', { name: '浅色' }).click()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'general-light.png') })
})

test('终端分类展示检测结果和路径，可靠入口才可选', async () => {
  await navItem('终端').click()
  const terminalButton = page.getByRole('button', { name: /Terminal.*System\/Applications\/Utilities\/Terminal\.app/ }).first()
  await expect(terminalButton).toBeVisible()
  await expect(page.getByText('所有 CLI 继续会话操作都会使用这里选择的终端。只允许选择具备可靠命令入口的应用。')).toBeVisible()
  await expect(page.getByRole('button', { name: '重新检测' })).toBeVisible()
  await terminalButton.hover()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'terminals-light.png') })
})

test('Resume 分类按 harness 动态过滤，实验开关在本分类', async () => {
  await navItem('通用').click()
  await page.getByRole('button', { name: '深色' }).click()
  await navItem('继续').click()
  // CC-Mirror has its own Provider registry truth and no longer inherits the
  // Claude Code Resume declaration, so all 11 discoverable sources are listed.
  await expect(page.getByRole('combobox')).toHaveCount(11)
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

test('【曾经的 bug】SSH 公网 IP 仅在明确点击后查询，并覆盖成功与失败视觉态', async () => {
  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __swobT162FetchCalls?: number
      __swobT162FetchUrls?: string[]
      __swobT162OriginalFetch?: typeof fetch
    }
    state.__swobT162FetchCalls = 0
    state.__swobT162FetchUrls = []
    state.__swobT162OriginalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      state.__swobT162FetchCalls = (state.__swobT162FetchCalls ?? 0) + 1
      state.__swobT162FetchUrls?.push(String(input))
      throw new Error('Unexpected network request before explicit public-IP query')
    }
  })

  await navItem('SSH').click()
  await expect(page.getByText('远程连接信息')).toBeVisible()
  await expect(page.getByRole('dialog').getByText(/手机/)).toHaveCount(0)
  await expect(page.getByText(/只有点击下方按钮后.*api\.ipify\.org/)).toBeVisible()
  const queryButton = page.getByRole('button', { name: '查询公网 IP' })
  await expect(queryButton).toBeVisible()
  expect(await app.evaluate(() =>
    (globalThis as typeof globalThis & { __swobT162FetchCalls?: number }).__swobT162FetchCalls
  )).toBe(0)

  const refreshButton = page.getByRole('button', { name: '刷新', exact: true })
  await refreshButton.click()
  await expect(refreshButton).toBeEnabled()
  expect(await app.evaluate(() =>
    (globalThis as typeof globalThis & { __swobT162FetchCalls?: number }).__swobT162FetchCalls
  )).toBe(0)

  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __swobT162FetchCalls?: number
      __swobT162FetchUrls?: string[]
    }
    globalThis.fetch = async (input) => {
      state.__swobT162FetchCalls = (state.__swobT162FetchCalls ?? 0) + 1
      state.__swobT162FetchUrls?.push(String(input))
      return {
        ok: true,
        json: async () => ({ ip: '203.0.113.10' })
      } as Response
    }
  })
  await queryButton.click()
  await expect(page.getByText('203.0.113.10')).toBeVisible()
  expect(await app.evaluate(() =>
    (globalThis as typeof globalThis & { __swobT162FetchCalls?: number }).__swobT162FetchCalls
  )).toBe(1)
  expect(await app.evaluate(() =>
    (globalThis as typeof globalThis & { __swobT162FetchUrls?: string[] }).__swobT162FetchUrls
  )).toEqual(['https://api.ipify.org?format=json'])
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'ssh-public-ip-success.png') })

  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __swobT162FetchCalls?: number
      __swobT162FetchUrls?: string[]
    }
    globalThis.fetch = async (input) => {
      state.__swobT162FetchCalls = (state.__swobT162FetchCalls ?? 0) + 1
      state.__swobT162FetchUrls?.push(String(input))
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      throw error
    }
  })
  await page.getByRole('button', { name: '重新查询公网 IP' }).click()
  await expect(page.getByRole('status')).toContainText('公网 IP 查询超时')
  expect(await app.evaluate(() =>
    (globalThis as typeof globalThis & { __swobT162FetchCalls?: number }).__swobT162FetchCalls
  )).toBe(2)
  expect(await app.evaluate(() =>
    (globalThis as typeof globalThis & { __swobT162FetchUrls?: string[] }).__swobT162FetchUrls
  )).toEqual([
    'https://api.ipify.org?format=json',
    'https://api.ipify.org?format=json'
  ])

  await page.setViewportSize({ width: 480, height: 520 })
  const sshContent = page.locator('[data-settings-category="ssh"]')
  const sshMetrics = await sshContent.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight
  }))
  expect(sshMetrics.scrollWidth).toBeLessThanOrEqual(sshMetrics.clientWidth + 1)
  expect(sshMetrics.scrollHeight).toBeGreaterThan(sshMetrics.clientHeight)
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'ssh-public-ip-narrow.png') })
  await page.setViewportSize({ width: 760, height: 660 })

  await page.getByText('查找远程机器地址').click()
  await expect(page.getByText(/远程机器运行 hostname/)).toBeVisible()
  await page.getByRole('dialog').screenshot({ path: path.join(screenshotDir, 'ssh-guide.png') })

  await app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __swobT162FetchCalls?: number
      __swobT162FetchUrls?: string[]
      __swobT162OriginalFetch?: typeof fetch
    }
    if (state.__swobT162OriginalFetch) globalThis.fetch = state.__swobT162OriginalFetch
    delete state.__swobT162FetchCalls
    delete state.__swobT162FetchUrls
    delete state.__swobT162OriginalFetch
  })
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

  // 仍是纵向导航,九项可见,无横向 tablist
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
  await navItem('继续').click()
  const content = page.locator('[data-settings-category="resume"]')
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
