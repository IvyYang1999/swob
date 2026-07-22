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
    model: 'glm-4.5'
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
    INSERT INTO session VALUES (
      ${sqlString(SESSION_ID)}, ${sqlString(PARENT_ID)}, 'zcode-slug',
      '/Users/test/projects/zcode-app', 'Zcode title', 1783504800, 1783504805
    );
    INSERT INTO message VALUES ('msg_user', ${sqlString(SESSION_ID)}, ${sqlString(userData)}, 1783504800);
    INSERT INTO message VALUES ('msg_assistant', ${sqlString(SESSION_ID)}, ${sqlString(assistantData)}, 1783504805);
    INSERT INTO part VALUES ('part_user_text', ${sqlString(SESSION_ID)}, 'msg_user', ${sqlString(JSON.stringify({ type: 'text', text: '请检查 Zcode 会话' }))});
    INSERT INTO part VALUES ('part_assistant_text', ${sqlString(SESSION_ID)}, 'msg_assistant', ${sqlString(JSON.stringify({ type: 'text', text: 'Zcode 会话已加载。' }))});
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
      expect(summary?.activityDays).toEqual(['2026-07-08'])

      const detail = await buildZcodeSessionDetail(fixture.sourceRef)
      expect(detail?.messages.map((message) => message.textContent)).toEqual([
        '请检查 Zcode 会话',
        'Zcode 会话已加载。'
      ])

      const dispatched = await loadSessionDetail(fixture.sourceRef)
      expect(dispatched?.source).toBe('zcode')
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
