import { expect, test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CLAUDE_FIXTURE_ID,
  closeApp,
  launchApp,
  revealAllSessions,
  type LaunchedApp
} from './helpers'

let launched: LaunchedApp

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  launched = await launchApp({ claudeTurns: 2 })
})

test.afterAll(async () => {
  await closeApp(launched)
})

test('an active Claude JSONL append refreshes the sidebar within the realtime budget', async () => {
  await revealAllSessions(launched.page)
  const sessionItem = launched.page.locator(`[data-session-id="${CLAUDE_FIXTURE_ID}"]`)
  await expect(sessionItem).toBeVisible({ timeout: 20_000 })
  await expect(sessionItem).toContainText(/2\s*(轮|turn)/i)

  const sourcePath = path.join(
    launched.home,
    '.claude',
    'projects',
    '-synthetic-project',
    `${CLAUDE_FIXTURE_ID}.jsonl`
  )
  const timestamp = new Date().toISOString()
  const appendedRows = [
    {
      uuid: 'claude-user-realtime',
      parentUuid: 'claude-assistant-1',
      sessionId: CLAUDE_FIXTURE_ID,
      type: 'user',
      timestamp,
      cwd: path.join(launched.home, 'project'),
      message: { role: 'user', content: 'Realtime watcher acceptance turn' }
    },
    {
      uuid: 'claude-assistant-realtime',
      parentUuid: 'claude-user-realtime',
      sessionId: CLAUDE_FIXTURE_ID,
      type: 'assistant',
      timestamp,
      cwd: path.join(launched.home, 'project'),
      message: {
        id: 'claude-message-realtime',
        role: 'assistant',
        content: 'Realtime watcher acceptance response',
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 }
      }
    }
  ]

  const startedAt = Date.now()
  fs.appendFileSync(sourcePath, appendedRows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await expect(sessionItem).toContainText(/3\s*(轮|turn)/i, { timeout: 8_000 })
  const latencyMs = Date.now() - startedAt
  expect(latencyMs).toBeLessThan(8_000)
  console.info('[source-watcher-sidebar-acceptance]', JSON.stringify({ latencyMs }))
})
