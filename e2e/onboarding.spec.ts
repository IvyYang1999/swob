import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv as launchApp } from './helpers'
import { E2E_CLEARED_PROVIDER_HOME_OVERRIDES } from './provider-home-isolation'

let app: ElectronApplication
let page: Page
let fixtureRoot: string
let fixtureHome: string
let pollutedCodexHome: string

const POLLUTED_CODEX_SESSION_ID = '32300000-0000-4000-8000-000000000001'

function writePollutedCodexTranscript(codexHome: string): void {
  const transcript = path.join(
    codexHome,
    'sessions',
    '2026',
    '08',
    '04',
    `rollout-polluted-${POLLUTED_CODEX_SESSION_ID}.jsonl`
  )
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, [
    {
      timestamp: '2026-08-04T00:00:00Z',
      type: 'session_meta',
      payload: {
        id: POLLUTED_CODEX_SESSION_ID,
        timestamp: '2026-08-04T00:00:00Z',
        cwd: '/isolated/swob323',
        cli_version: 'test',
        model_provider: 'openai'
      }
    },
    {
      timestamp: '2026-08-04T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'SWOB-323 polluted CODEX_HOME sentinel' }]
      }
    }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // 全新 HOME：无 app-config、无已初始化库 → 必须走首启动引导
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-onboarding-e2e-'))
  fixtureHome = path.join(fixtureRoot, 'fresh-home')
  pollutedCodexHome = path.join(fixtureRoot, 'external-codex-home')
  fs.mkdirSync(fixtureHome, { recursive: true })
  writePollutedCodexTranscript(pollutedCodexHome)
  const launched = await launchApp({
    sandboxRoot: fixtureRoot,
    env: { HOME: fixtureHome, CODEX_HOME: pollutedCodexHome }
  })
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  await app.close()
  if (!process.env.SWOB_E2E_KEEP_FIXTURE) fs.rmSync(fixtureRoot, { recursive: true, force: true })
  else console.log('[diag] fixture kept at:', fixtureRoot)
})

test('全新安装完成场景选择与引导后进入主界面，配置落盘', async () => {
  const expectedClearedProviderHome = process.env.SWOB_E2E_EXPECT_CLEARED_PROVIDER_HOME
  if (expectedClearedProviderHome) {
    expect((process.env[E2E_CLEARED_PROVIDER_HOME_OVERRIDES] || '').split(','))
      .toContain(expectedClearedProviderHome)
  }
  expect(process.env.CODEX_HOME).toBeUndefined()
  expect(await app.evaluate(() => process.env.CODEX_HOME ?? null)).toBeNull()

  const onboarding = page.locator('[data-testid="onboarding"]')
  await expect(onboarding).toBeVisible({ timeout: 20_000 })

  // 第一步：欢迎页
  await expect(onboarding.getByText('你的 AI 会话，永不丢失')).toBeVisible()
  await onboarding.getByRole('button', { name: /开始设置/ }).click()

  // 第二步：选择使用场景；“全部都要”保留所有内置 Lens。
  await expect(onboarding.getByText('你主要用 Swob 做什么？')).toBeVisible()
  await onboarding.getByRole('button', { name: /都要/ }).click()

  // 第三步：Vault 位置（默认路径预填）
  await expect(onboarding.getByText('为你的会话安个家')).toBeVisible()
  await expect(onboarding.getByText(/Documents\/Swob|~\/Documents\/Swob/)).toBeVisible()
  await onboarding.getByRole('button', { name: /就放这里/ }).click()

  // 第四步：扫描页（全新 HOME 无会话 → 空态文案）
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
  // approveLibraryRoot 落盘的是 realpath 规范化路径(/var → /private/var)
  expect(fs.realpathSync(appConfig.libraryPath)).toBe(fs.realpathSync(path.join(fixtureHome, 'Documents', 'Swob')))
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
