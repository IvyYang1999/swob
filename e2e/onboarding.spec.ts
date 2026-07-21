import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchApp } from './helpers'

let app: ElectronApplication
let page: Page
let fixtureHome: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // 全新 HOME：无 app-config、无已初始化库 → 必须走首启动引导
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-onboarding-e2e-'))
  const launched = await launchApp({ env: { HOME: fixtureHome } })
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  await app.close()
  if (!process.env.SWOB_E2E_KEEP_FIXTURE) fs.rmSync(fixtureHome, { recursive: true, force: true })
  else console.log('[diag] fixture kept at:', fixtureHome)
})

test('全新安装走完三步引导后进入主界面，配置落盘', async () => {
  const onboarding = page.locator('[data-testid="onboarding"]')
  await expect(onboarding).toBeVisible({ timeout: 20_000 })

  // 第一步：欢迎页
  await expect(onboarding.getByText('你的 AI 会话，永不丢失')).toBeVisible()
  await onboarding.getByRole('button', { name: /开始设置/ }).click()

  // 第二步：Vault 位置（默认路径预填）
  await expect(onboarding.getByText('为你的会话安个家')).toBeVisible()
  await expect(onboarding.getByText(/Documents\/Swob|~\/Documents\/Swob/)).toBeVisible()
  await onboarding.getByRole('button', { name: /就放这里/ }).click()

  // 第三步：扫描页（全新 HOME 无会话 → 空态文案）
  await expect(onboarding.getByText('发现了这些会话')).toBeVisible()
  await expect(onboarding.getByText(/还没有发现会话/)).toBeVisible()
  await onboarding.getByRole('button', { name: '完成', exact: true }).click()

  // 引导结束 → 主界面侧边栏出现
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 20_000 })

  // 配置落盘：onboardingCompleted + libraryPath；库已初始化
  const appConfigPath = path.join(fixtureHome, '.claude-session-manager', 'app-config.json')
  await expect.poll(() => fs.existsSync(appConfigPath)).toBe(true)
  const appConfig = JSON.parse(fs.readFileSync(appConfigPath, 'utf-8'))
  expect(appConfig.onboardingCompleted).toBe(true)
  expect(appConfig.libraryPath).toBe(path.join(fixtureHome, 'Documents', 'Swob'))
  await expect.poll(() =>
    fs.existsSync(path.join(fixtureHome, 'Documents', 'Swob', '.swob-config.json'))
  ).toBe(true)
})

test('重启后不再出现引导', async () => {
  await app.close()
  const relaunched = await launchApp({ env: { HOME: fixtureHome } })
  app = relaunched.app
  page = relaunched.page
  await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="onboarding"]')).toHaveCount(0)
})
