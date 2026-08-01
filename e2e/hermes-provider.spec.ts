import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { stableCanonicalRecordId } from '../src/shared/provider-protocol'
import { closeApp, launchAppWithEnv, openSessionInChat } from './helpers'

function sessionRecordId(sourceRefStableId: string, sessionId: string): string {
  return stableCanonicalRecordId({
    providerId: 'swob/hermes',
    sourceRefStableId,
    recordType: 'session',
    sourceRecordId: sessionId
  })
}

test('Hermes state.db and JSON cards open their real Electron chat details', async ({}, testInfo) => {
  test.setTimeout(60_000)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-hermes-e2e-'))
  const home = path.join(root, 'home')
  const libraryRoot = path.join(root, 'Library')
  const hermesRoot = path.join(home, '.hermes')
  const sessionsRoot = path.join(hermesRoot, 'sessions')
  fs.mkdirSync(sessionsRoot, { recursive: true })
  fs.mkdirSync(libraryRoot, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: libraryRoot,
    onboardingCompleted: true
  }))
  fs.writeFileSync(path.join(libraryRoot, '.swob-config.json'), JSON.stringify({
    libraryRoot,
    preferences: { defaultViewMode: 'compact', singleTurnBehavior: 'show' }
  }))
  fs.copyFileSync(
    path.join(__dirname, '..', 'testdata', 'hermes', 'session_legacy-only.json'),
    path.join(sessionsRoot, 'session_legacy-only.json')
  )
  const db = new Database(path.join(hermesRoot, 'state.db'))
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'testdata', 'hermes', 'state-db.sql'), 'utf8'))
  db.close()

  const launched = await launchAppWithEnv({ sandboxRoot: root, env: {
    HOME: home,
    SWOB_TEST_HOME: home,
    SWOB_LIBRARY_ROOT: libraryRoot
  } })
  try {
    const { page } = launched
    const dbRecordId = sessionRecordId('hermes:db:synthetic-hermes-db', 'synthetic-hermes-db')
    const jsonRecordId = sessionRecordId('hermes:json:synthetic-hermes-json', 'synthetic-hermes-json')

    const dbCard = page.locator(`[data-session-id="${dbRecordId}"]`)
    await expect(dbCard).toBeVisible({ timeout: 20_000 })
    await expect(dbCard).toContainText('Locate hermes-db-search-needle.')
    await openSessionInChat(page, dbRecordId)
    const dbChat = page.getByTestId('chat-scroll')
    await expect(dbChat.getByText('Locate hermes-db-search-needle.', { exact: true })).toBeVisible()
    await expect(dbChat.getByText(/Reason only over fixture data/)).toBeVisible()
    await expect(dbChat.getByText('read_file', { exact: true })).toBeVisible()
    await dbChat.getByText('read_file', { exact: true }).locator('xpath=ancestor::button[1]').click()
    await expect(dbChat.getByText(/hermes-db-tool-result/)).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeEnabled()
    await expect(page.getByRole('button', { name: 'Fork', exact: true })).toHaveCount(0)
    await expect(page.getByText('compact 1x', { exact: true })).toBeVisible()
    await expect(dbChat.getByRole('button', { name: '系统上下文', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '完整', exact: true }).click()
    await dbChat.getByRole('button', { name: '系统上下文', exact: true }).click()
    await expect(dbChat.getByText('Synthetic DB system preamble.', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('hermes-state-db-detail.png') })

    await openSessionInChat(page, jsonRecordId)
    const jsonChat = page.getByTestId('chat-scroll')
    await expect(jsonChat.getByText('Find hermes-json-search-needle in the synthetic fixture.', { exact: true }))
      .toBeVisible()
    await expect(jsonChat.getByText(/Use only the sanitized fixture/)).toBeVisible()
    await jsonChat.getByRole('button', { name: '系统上下文', exact: true }).click()
    await expect(jsonChat.getByText('Synthetic system preamble. This fixture contains no real user data.', { exact: true }))
      .toBeVisible()
    await expect(page.getByText('synthetic-model-json', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Resume' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Fork', exact: true })).toHaveCount(0)
    await expect(page.getByText(/compact \d+x/)).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('hermes-json-detail.png') })
  } finally {
    await closeApp({ ...launched, sandboxRoot: root, home, libraryRoot,
      userData: path.join(home, '.swob-e2e-user-data') })
  }
})
