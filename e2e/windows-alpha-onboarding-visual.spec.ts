import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv } from './helpers'

test('Windows Alpha 首次启动扫描页显式告知支持边界', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-win-alpha-onboarding-'))
  const { app, page } = await launchAppWithEnv({
    env: { HOME: home, SWOB_TEST_HOME: home, SWOB_TEST_PLATFORM: 'win32' }
  })

  try {
    await page.setViewportSize({ width: 1000, height: 700 })
    const onboarding = page.locator('[data-testid="onboarding"]')
    await expect(onboarding).toBeVisible({ timeout: 20_000 })
    await onboarding.getByRole('button', { name: /开始设置/ }).click()
    await onboarding.getByRole('button', { name: /就放这里/ }).click()

    const notice = onboarding.locator('[data-testid="windows-alpha-notice"]')
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('Claude Code、Codex')
    await expect(notice).toContainText('WSL、OneDrive')
    await page.screenshot({ path: testInfo.outputPath('windows-alpha-onboarding-scan.png') })
  } finally {
    await Promise.race([
      app.close(),
      new Promise((resolve) => setTimeout(resolve, 5_000))
    ])
    try { app.process().kill('SIGKILL') } catch { /* already closed */ }
    fs.rmSync(home, { recursive: true, force: true })
  }
})
