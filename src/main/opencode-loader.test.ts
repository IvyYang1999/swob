import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import {
  buildOpencodeSessionDetail,
  buildOpencodeSessionSummary,
  findOpencodeSessionFiles,
  loadOpencodeRawMessages,
  makeOpencodeSessionRef
} from './opencode-loader'
import { loadSessionDetail } from './session-loader'

const SESSION_ID = 'ses_Abc123'

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

function createOpencodeDb(): { dir: string; dbPath: string; sourceRef: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-opencode-test-'))
  const dbPath = path.join(dir, '.local', 'share', 'opencode', 'opencode.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const userData = JSON.stringify({
    role: 'user',
    time: { created: '2026-07-08T10:00:00Z' },
    path: { cwd: '/Users/test/projects/opencode-app' },
    model: 'glm-4.5'
  })
  const assistantData = JSON.stringify({
    role: 'assistant',
    parentID: 'msg_user',
    time: { created: '2026-07-08T10:00:05Z' },
    tokens: { input: 11, output: 7, cache: { read: 3 } },
    model: 'glm-4.5'
  })
  const sessionTokens = JSON.stringify({ input: 100, output: 50 })
  const userText = JSON.stringify({ text: '请读取 src/index.ts' })
  const assistantText = JSON.stringify({ text: '我来读取文件。' })
  const toolData = JSON.stringify({ id: 'tool_read_1', name: 'read', input: { file_path: '/Users/test/projects/opencode-app/src/index.ts' } })
  const ignoredStep = JSON.stringify({ text: 'hidden step marker' })
  const ignoredReasoning = JSON.stringify({ text: 'hidden reasoning' })

  const sql = `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      slug TEXT,
      directory TEXT,
      title TEXT,
      model TEXT,
      tokens TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      sessionID TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      sessionID TEXT,
      messageID TEXT,
      type TEXT,
      idx INTEGER,
      data TEXT
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      sessionID TEXT,
      messageID TEXT,
      type TEXT
    );
    CREATE TABLE account (id TEXT, data TEXT);
    CREATE TABLE credential (id TEXT, data TEXT);

    INSERT INTO session VALUES (
      ${sqlString(SESSION_ID)},
      'opencode-slug',
      '/Users/test/projects/opencode-app',
      'Opencode title',
      'glm-4.5',
      ${sqlString(sessionTokens)}
    );
    INSERT INTO message VALUES (
      'msg_user',
      ${sqlString(SESSION_ID)},
      ${sqlString(userData)},
      1783504800
    );
    INSERT INTO message VALUES (
      'msg_assistant',
      ${sqlString(SESSION_ID)},
      ${sqlString(assistantData)},
      1783504805
    );
    INSERT INTO part VALUES ('part_user_text', ${sqlString(SESSION_ID)}, 'msg_user', 'text', 0, ${sqlString(userText)});
    INSERT INTO part VALUES ('part_assistant_text', ${sqlString(SESSION_ID)}, 'msg_assistant', 'text', 0, ${sqlString(assistantText)});
    INSERT INTO part VALUES ('part_tool', ${sqlString(SESSION_ID)}, 'msg_assistant', 'tool', 1, ${sqlString(toolData)});
    INSERT INTO part VALUES ('part_step', ${sqlString(SESSION_ID)}, 'msg_assistant', 'step-start', 2, ${sqlString(ignoredStep)});
    INSERT INTO part VALUES ('part_reasoning', ${sqlString(SESSION_ID)}, 'msg_assistant', 'reasoning', 3, ${sqlString(ignoredReasoning)});
    INSERT INTO session_message VALUES ('switch_1', ${sqlString(SESSION_ID)}, 'msg_assistant', 'agent-switched');
  `

  execFileSync('sqlite3', [dbPath], { input: sql })
  return { dir, dbPath, sourceRef: makeOpencodeSessionRef(SESSION_ID, dbPath) }
}

describe('opencode-loader', () => {
  fixtureIt('【opencode】summary/detail/raw 保留 reasoning，但过滤 step marker', async () => {
    const fixture = createOpencodeDb()
    try {
      const refs = await findOpencodeSessionFiles(fixture.dbPath)
      expect(refs).toEqual([fixture.sourceRef])

      const raw = await loadOpencodeRawMessages(fixture.sourceRef)
      expect(raw).toHaveLength(2)
      expect(raw[0].uuid).toBe('msg_user')
      expect(raw[1].parentUuid).toBe('msg_user')
      expect(JSON.stringify(raw)).not.toContain('hidden step marker')
      expect(JSON.stringify(raw)).toContain('hidden reasoning')

      const summary = await buildOpencodeSessionSummary(fixture.sourceRef)
      expect(summary?.activityDays).toEqual(['2026-07-08'])
      expect(summary).not.toBeNull()
      expect(summary!.source).toBe('opencode')
      expect(summary!.id).toBe(`opencode:${SESSION_ID}`)
      expect(summary!.sessionId).toBe(SESSION_ID)
      expect(summary!.firstUserMessage).toBe('请读取 src/index.ts')
      expect(summary!.resumeCwd).toBe('/Users/test/projects/opencode-app')
      expect(summary!.toolUsage).toEqual({ Read: 1 })
      expect(summary!.tokenUsage.inputTokens).toBe(11)
      expect(summary!.tokenUsage.outputTokens).toBe(7)
      expect(summary!.tokenUsage.cacheReadTokens).toBe(3)

      const detail = await buildOpencodeSessionDetail(fixture.sourceRef)
      expect(detail).not.toBeNull()
      expect(detail!.messages).toHaveLength(2)
      expect(detail!.messages[1].textContent).toBe('我来读取文件。')
      expect((detail!.messages[1].raw.message?.content as any[]))
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning', text: 'hidden reasoning' })]))
      expect(detail!.messages[1].toolCalls[0]).toMatchObject({
        id: 'tool_read_1',
        name: 'Read',
        input: { file_path: '/Users/test/projects/opencode-app/src/index.ts' }
      })
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  fixtureIt('【opencode】loadSessionDetail source-aware 分派到 opencode loader', async () => {
    const fixture = createOpencodeDb()
    try {
      const detail = await loadSessionDetail(fixture.sourceRef)

      expect(detail).not.toBeNull()
      expect(detail!.source).toBe('opencode')
      expect(detail!.sessionId).toBe(SESSION_ID)
      expect(detail!.messages[0].textContent).toBe('请读取 src/index.ts')
      expect(detail!.messages.some((message) => message.textContent.includes('[Reasoning]'))).toBe(true)
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  fixtureIt('【opencode】解析只读 snapshot，不修改源 DB 或留下临时 sidecar', async () => {
    const fixture = createOpencodeDb()
    const writer = new Database(fixture.dbPath)
    try {
      writer.pragma('journal_mode = WAL')
      writer.pragma('wal_autocheckpoint = 0')
      writer.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({ text: 'reasoning committed only in WAL' }),
        'part_reasoning'
      )
      expect(fs.existsSync(`${fixture.dbPath}-wal`)).toBe(true)
      const beforeHash = (filePath: string) =>
        createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
      const beforeDbHash = beforeHash(fixture.dbPath)
      const beforeWalHash = beforeHash(`${fixture.dbPath}-wal`)
      const beforeFiles = fs.readdirSync(path.dirname(fixture.dbPath)).sort()
      const detail = await buildOpencodeSessionDetail(fixture.sourceRef)

      expect(JSON.stringify(detail?.messages)).toContain('reasoning committed only in WAL')
      expect(beforeHash(fixture.dbPath)).toBe(beforeDbHash)
      expect(beforeHash(`${fixture.dbPath}-wal`)).toBe(beforeWalHash)
      expect(fs.readdirSync(path.dirname(fixture.dbPath)).sort()).toEqual(beforeFiles)
    } finally {
      writer.close()
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('【opencode】非法 sessionId 被拒绝且不崩溃', async () => {
    const raw = await loadOpencodeRawMessages('/tmp/.local/share/opencode/opencode.db#ses_bad-drop')
    const summary = await buildOpencodeSessionSummary('/tmp/.local/share/opencode/opencode.db#ses_bad;drop')

    expect(raw).toEqual([])
    expect(summary).toBeNull()
  })
})
