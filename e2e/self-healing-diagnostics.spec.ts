import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { launchAppWithEnv } from './helpers'

let app: ElectronApplication
let page: Page
let fixtureHome: string

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableUuid(label: string): string {
  const digest = sha256(label)
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  fixtureHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-self-healing-e2e-'))
  const libraryRoot = path.join(fixtureHome, 'Documents', 'Swob')
  const sourcePath = path.join(fixtureHome, '.claude', 'projects', 'fixture', 'diagnostic-session.jsonl')
  const backup = Buffer.from('{"type":"user","message":{"role":"user","content":"synthetic"}}\n')
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.mkdirSync(path.join(fixtureHome, '.claude-session-manager'), { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.writeFileSync(sourcePath, backup)
  fs.writeFileSync(path.join(fixtureHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: libraryRoot,
    onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }))
  const diagnosticsRoot = path.join(fixtureHome, '.swob-e2e-user-data', 'diagnostics')
  fs.mkdirSync(diagnosticsRoot, { recursive: true })
  fs.writeFileSync(path.join(diagnosticsRoot, 'duplicate-recovery-summary-v1.json'), JSON.stringify({
    schemaVersion: 1,
    plannerRevision: 1,
    libraryRootHash: sha256(path.resolve(libraryRoot)),
    writeGeneration: 1,
    completedAt: '2026-08-09T00:00:00.000Z',
    summary: {
      schemaVersion: 1,
      planId: 'plan:fedcba9876543210fedcba98',
      packageCount: 2,
      conflictCount: 1,
      autoRepairableGroupCount: 1,
      autoRepairablePackageCount: 1,
      manualMergeGroupCount: 0,
      preservedGroupCount: 0
    }
  }))

  for (const suffix of ['a', 'b']) {
    const packageRoot = path.join(libraryRoot, `synthetic-duplicate-${suffix}`)
    fs.mkdirSync(packageRoot)
    fs.writeFileSync(path.join(packageRoot, '.swob-session.json'), JSON.stringify({
      schemaVersion: 3,
      packageId: stableUuid(`self-healing-${suffix}`),
      logicalIdentity: {
        schemaVersion: 1,
        sourceFamily: 'claude-code',
        sourceInstance: { kind: 'default', id: 'default' },
        sessionId: 'diagnostic-session'
      },
      sessionId: 'diagnostic-session',
      sourceFilePaths: [sourcePath],
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:01:00.000Z',
      projectPath: '/synthetic/project',
      turnCount: 1,
      backupSha256: sha256(backup),
      backupSize: backup.length
    }))
    fs.writeFileSync(path.join(packageRoot, 'backup.jsonl'), backup)
    fs.writeFileSync(path.join(packageRoot, 'transcript.md'), '# Synthetic transcript\n')
  }

  const launched = await launchAppWithEnv({ env: {
    HOME: fixtureHome,
    SWOB_TEST_DUPLICATE_RECOVERY_FIRST_DELAY_MS: '5000'
  } })
  app = launched.app
  page = launched.page
})

test.afterAll(async () => {
  if (app) await app.close()
  if (fixtureHome) fs.rmSync(fixtureHome, { recursive: true, force: true })
})

test('conflicts are analyzed automatically while mutation remains an explicit confirmed action', async ({}, testInfo) => {
  await page.setViewportSize({ width: 820, height: 680 })
  await page.getByTitle('设置').click()
  const dialog = page.getByRole('dialog', { name: '设置' })
  await dialog.getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: '诊断与修复' }).click()
  const content = dialog.locator('[data-settings-category="diagnostics"]')

  await expect(content.getByText('正在本机自动核验冲突包；分析只读，不会修改 Library。')).toBeVisible()
  await expect(content.getByRole('button', { name: '安全分析' })).toHaveCount(0)
  await expect(content.getByText(/这是上次只读分析的脱敏汇总/)).toBeVisible()
  const cancel = content.getByRole('button', { name: '取消分析' })
  await page.setViewportSize({ width: 480, height: 680 })
  await cancel.scrollIntoViewIfNeeded()
  await expect(cancel).toBeInViewport()
  await expect(content.getByText(/复核完成前不会提供隔离操作/)).toBeVisible()
  await dialog.screenshot({ path: testInfo.outputPath('self-healing-cache-rechecking-narrow.png') })

  await cancel.click()
  await page.setViewportSize({ width: 480, height: 520 })
  const resume = content.getByRole('button', { name: '重新分析' })
  await expect(content.getByText('只读分析已暂停；Library 没有被修改。')).toBeVisible()
  await expect(content.getByText('1 组重复会话的只读比对已暂停')).toBeVisible()
  await expect(content.getByText(/当前复核已暂停/)).toBeVisible()

  await resume.scrollIntoViewIfNeeded()
  await resume.hover()
  const pausedMetrics = await content.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }))
  expect(pausedMetrics.scrollWidth).toBeLessThanOrEqual(pausedMetrics.clientWidth + 1)
  await expect(resume).toBeInViewport()
  await dialog.screenshot({ path: testInfo.outputPath('self-healing-paused-narrow.png') })

  await resume.click()
  await page.setViewportSize({ width: 820, height: 680 })
  const apply = content.getByRole('button', { name: '隔离 1 个等价副本' })
  await expect(apply).toBeVisible({ timeout: 30_000 })
  await apply.hover()
  await expect(content.getByTestId('diagnostics-raw')).toHaveCount(0)
  await dialog.screenshot({ path: testInfo.outputPath('self-healing-wide.png') })

  await page.setViewportSize({ width: 480, height: 520 })
  await apply.scrollIntoViewIfNeeded()
  await content.evaluate((element) => { element.scrollTop += 28 })
  const metrics = await content.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }))
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1)
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  await expect(apply).toBeInViewport()
  await dialog.screenshot({ path: testInfo.outputPath('self-healing-narrow.png') })
})
