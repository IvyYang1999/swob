import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { isValidOpencodeSessionId } from './opencode-loader'
import {
  buildZcodeSessionDetail,
  buildZcodeSessionSummary,
  findZcodeSessionFiles,
  loadZcodeRawMessages,
  makeZcodeSessionRef
} from './zcode-loader'
import { loadSessionDetail } from './session-loader'

const SESSION_ID = 'sess_subagent_agent_b3c1-42'
const PARENT_ID = 'sess_parent_b3c1-00'

function sqlite3Available(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const fixtureIt = sqlite3Available() ? it : it.skip

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function createZcodeDb(): { dir: string; dbPath: string; sourceRef: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-zcode-test-'))
  const dbPath = path.join(dir, '.zcode', 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const userData = JSON.stringify({
    role: 'user',
    time: { created: '2026-07-08T10:00:00Z' },
    path: { cwd: '/Users/test/projects/zcode-app' }
  })
  const assistantData = JSON.stringify({
    role: 'assistant',
    parentID: 'msg_user',
    time: { created: '2026-07-08T10:00:05Z' },
    model: 'glm-4.5',
    tokens: { input: 13, output: 5 }
  })
  const sql = `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT,
      data TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      message_id TEXT
    );
    CREATE TABLE model_usage (
      id TEXT PRIMARY KEY,
      logical_request_id TEXT,
      attempt_index INTEGER,
      session_id TEXT,
      provider_id TEXT,
      model_id TEXT,
      status TEXT,
      started_at INTEGER,
      completed_at INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_creation_input_tokens INTEGER,
      cache_read_input_tokens INTEGER,
      provider_total_tokens INTEGER,
      computed_total_tokens INTEGER
    );
    INSERT INTO session VALUES (
      ${sqlString(SESSION_ID)}, ${sqlString(PARENT_ID)}, 'zcode-slug',
      '/Users/test/projects/zcode-app', 'Zcode title', 1783504800, 1783504805
    );
    INSERT INTO message VALUES ('msg_user', ${sqlString(SESSION_ID)}, ${sqlString(userData)}, 1783504800);
    INSERT INTO message VALUES ('msg_assistant', ${sqlString(SESSION_ID)}, ${sqlString(assistantData)}, 1783504805);
    INSERT INTO part VALUES ('part_user_text', ${sqlString(SESSION_ID)}, 'msg_user', ${sqlString(JSON.stringify({ type: 'text', text: '请检查 Zcode 会话' }))});
    INSERT INTO part VALUES ('part_assistant_text', ${sqlString(SESSION_ID)}, 'msg_assistant', ${sqlString(JSON.stringify({ type: 'text', text: 'Zcode 会话已加载。' }))});
    INSERT INTO part VALUES ('part_assistant_reasoning', ${sqlString(SESSION_ID)}, 'msg_assistant', ${sqlString(JSON.stringify({ type: 'reasoning', text: 'Zcode independent reasoning' }))});
    INSERT INTO part VALUES ('part_assistant_tool', ${sqlString(SESSION_ID)}, 'msg_assistant', ${sqlString(JSON.stringify({ type: 'tool', id: 'zcode-tool-1', name: 'read', input: { file_path: '/Users/test/projects/zcode-app/README.md' } }))});
    INSERT INTO model_usage VALUES (
      'usage_1', 'request_1', 0, ${sqlString(SESSION_ID)}, 'zhipu', 'glm-4.5',
      'completed', 1783504805, 1783504806, 13, 5, 0, 2, 3, 18, 18
    );
  `

  execFileSync('sqlite3', [dbPath], { input: sql })
  return { dir, dbPath, sourceRef: makeZcodeSessionRef(SESSION_ID, dbPath) }
}

describe('zcode-loader', () => {
  fixtureIt('【zcode】按真实 schema 解析列表、详情和 subagent parent_id', async () => {
    const fixture = createZcodeDb()
    try {
      expect(await findZcodeSessionFiles(fixture.dbPath)).toEqual([fixture.sourceRef])
      expect(await loadZcodeRawMessages(fixture.sourceRef)).toHaveLength(2)

      const summary = await buildZcodeSessionSummary(fixture.sourceRef)
      expect(summary).toMatchObject({
        id: `zcode:${SESSION_ID}`,
        sessionId: SESSION_ID,
        source: 'zcode',
        branchParentId: PARENT_ID,
        resumeCwd: '/Users/test/projects/zcode-app'
      })
      expect(summary?.tokenUsage).toMatchObject({
        inputTokens: 8,
        outputTokens: 5,
        cacheCreationTokens: 2,
        cacheReadTokens: 3
      })
      expect(summary?.tokenAccounting?.usageEvents).toEqual([
        expect.objectContaining({
          dedupKey: 'zcode:model-usage:usage_1',
          billingFactKey: 'zcode:request:request_1:attempt:0',
          timestamp: '2026-07-08T10:00:05.000Z',
          providerRaw: 'zhipu',
          billingProvider: 'zhipu',
          modelRaw: 'glm-4.5',
          rawInputTokens: 13,
          fieldRelations: {
            cacheRead: 'subset-of-input',
            cacheWrite: 'subset-of-input',
            reasoning: 'provider-defined'
          }
        })
      ])
      expect(summary?.toolUsage).toEqual({ Read: 1 })
      expect(summary?.activityDays).toEqual(['2026-07-08'])

      const detail = await buildZcodeSessionDetail(fixture.sourceRef)
      expect(detail?.messages[0].textContent).toBe('请检查 Zcode 会话')
      expect(detail?.messages[1].textContent).toBe('Zcode 会话已加载。')
      expect(JSON.stringify(detail?.messages[1].raw)).toContain('Zcode independent reasoning')
      expect(detail?.messages[1].toolCalls).toEqual([
        expect.objectContaining({ id: 'zcode-tool-1', name: 'Read' })
      ])

      const dispatched = await loadSessionDetail(fixture.sourceRef)
      expect(dispatched?.source).toBe('zcode')
      expect(dispatched?.messages.some((message) =>
        message.textContent.includes('[Reasoning]'))).toBe(true)
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('【zcode】DB 缺失时安静跳过', async () => {
    const dbPath = path.join(os.tmpdir(), `swob-zcode-missing-${Date.now()}`, 'db.sqlite')
    await expect(findZcodeSessionFiles(dbPath)).resolves.toEqual([])
    await expect(buildZcodeSessionSummary(makeZcodeSessionRef(SESSION_ID, dbPath))).resolves.toBeNull()
  })

  it('【sqlite agent】session id 同时兼容 opencode 和 zcode 形态', () => {
    expect(isValidOpencodeSessionId('ses_abc123')).toBe(true)
    expect(isValidOpencodeSessionId('sess_b3c1-with-hyphen')).toBe(true)
    expect(isValidOpencodeSessionId('sess_subagent_agent_xxx')).toBe(true)
    expect(isValidOpencodeSessionId('session_bad')).toBe(false)
    expect(isValidOpencodeSessionId('sess_bad;drop')).toBe(false)
  })
})
