import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { execFileSync } from 'child_process'
import {
  formatResumeAuditReport,
  isValidResumeSessionId,
  normalizeResumeAuditText,
  runResumeAudit
} from './resume-audit'
import { getSessionResumeAvailability, initLibrary, scanLibrary } from './library-manager'
import type { SessionSource, SessionSummary } from './types'

const IDS = {
  claude: '11111111-1111-4111-8111-111111111111',
  claudeWindow: '55555555-5555-4555-8555-555555555555',
  codex: '22222222-2222-4222-8222-222222222222',
  cursor: '33333333-3333-4333-8333-333333333333',
  staleCodex: '44444444-4444-4444-8444-444444444444'
}

let tempRoot: string
let binDir: string

function writeFile(filePath: string, content = ''): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

function writeJsonl(filePath: string, rows: unknown[]): string {
  return writeFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

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

function createAgentDb(
  dbPath: string,
  sessionId: string,
  userText: string,
  assistantText: string,
  withMessages = true
): string {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const userData = JSON.stringify({ role: 'user', time: { created: '2026-07-18T00:00:00Z' } })
  const assistantData = JSON.stringify({ role: 'assistant', time: { created: '2026-07-18T00:00:01Z' } })
  const messageSql = withMessages
    ? `
      INSERT INTO message VALUES ('user-1', ${sqlString(sessionId)}, ${sqlString(userData)}, 1);
      INSERT INTO message VALUES ('assistant-1', ${sqlString(sessionId)}, ${sqlString(assistantData)}, 2);
      INSERT INTO part VALUES ('part-user', ${sqlString(sessionId)}, 'user-1', 'text', 0, ${sqlString(JSON.stringify({ text: userText }))});
      INSERT INTO part VALUES ('part-assistant', ${sqlString(sessionId)}, 'assistant-1', 'text', 0, ${sqlString(JSON.stringify({ text: assistantText }))});
    `
    : ''
  execFileSync('sqlite3', [dbPath], {
    input: `
      CREATE TABLE session (id TEXT PRIMARY KEY, slug TEXT, directory TEXT, title TEXT, model TEXT);
      CREATE TABLE message (id TEXT PRIMARY KEY, sessionID TEXT, data TEXT, time_created INTEGER);
      CREATE TABLE part (id TEXT PRIMARY KEY, sessionID TEXT, messageID TEXT, type TEXT, idx INTEGER, data TEXT);
      CREATE TABLE session_message (id TEXT PRIMARY KEY, sessionID TEXT, messageID TEXT);
      INSERT INTO session VALUES (${sqlString(sessionId)}, 'fixture', '/tmp', 'fixture', 'fixture-model');
      ${messageSql}
    `
  })
  return dbPath
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    if (remaining > 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining > 0)
  return Buffer.from(bytes)
}

function bytesField(number: number, value: Buffer | string): Buffer {
  const payload = typeof value === 'string' ? Buffer.from(value, 'utf-8') : value
  return Buffer.concat([encodeVarint((number * 8) | 2), encodeVarint(payload.length), payload])
}

function fixtureBlobId(label: string): string {
  return crypto.createHash('sha256').update(label).digest('hex')
}

function createCursorStore(dbPath: string, sessionId: string, userText: string, assistantText: string): string {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const rootId = fixtureBlobId('root')
  const turnId = fixtureBlobId('turn')
  const userId = fixtureBlobId('user')
  const stepId = fixtureBlobId('step')
  const userBlob = bytesField(1, userText)
  const assistantMessage = bytesField(1, assistantText)
  const stepBlob = bytesField(1, assistantMessage)
  const agentTurn = Buffer.concat([
    bytesField(1, Buffer.from(userId, 'hex')),
    bytesField(2, Buffer.from(stepId, 'hex'))
  ])
  const turnBlob = bytesField(1, agentTurn)
  const rootBlob = bytesField(8, Buffer.from(turnId, 'hex'))
  const metadata = Buffer.from(JSON.stringify({ agentId: sessionId, latestRootBlobId: rootId }), 'utf-8').toString('hex')
  execFileSync('sqlite3', [dbPath], {
    input: `
      PRAGMA journal_mode=WAL;
      CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      INSERT INTO meta VALUES ('0', ${sqlString(metadata)});
      INSERT INTO blobs VALUES (${sqlString(rootId)}, X'${rootBlob.toString('hex')}');
      INSERT INTO blobs VALUES (${sqlString(turnId)}, X'${turnBlob.toString('hex')}');
      INSERT INTO blobs VALUES (${sqlString(userId)}, X'${userBlob.toString('hex')}');
      INSERT INTO blobs VALUES (${sqlString(stepId)}, X'${stepBlob.toString('hex')}');
    `
  })
  return dbPath
}

function claudeRows(sessionId: string, userText: string, assistantText: string): unknown[] {
  return [
    {
      uuid: 'claude-user', parentUuid: null, sessionId, type: 'user',
      timestamp: '2026-07-18T00:00:00.000Z', promptSource: 'typed',
      message: { role: 'user', content: userText }
    },
    {
      uuid: 'claude-assistant', parentUuid: 'claude-user', sessionId, type: 'assistant',
      timestamp: '2026-07-18T00:00:01.000Z', message: { role: 'assistant', content: assistantText }
    }
  ]
}

function writeCodexSession(filePath: string, sessionId: string, userText: string, assistantText: string): string {
  return writeJsonl(filePath, [
    {
      timestamp: '2026-07-18T00:00:00.000Z', type: 'session_meta',
      payload: { id: sessionId, timestamp: '2026-07-18T00:00:00.000Z', cwd: '/tmp', cli_version: 'fixture' }
    },
    {
      timestamp: '2026-07-18T00:00:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] }
    },
    {
      timestamp: '2026-07-18T00:00:02.000Z', type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: assistantText }] }
    }
  ])
}

function writeCursorTranscript(filePath: string, userText: string, assistantText: string): string {
  return writeJsonl(filePath, [
    { role: 'user', message: { content: userText } },
    { role: 'assistant', message: { content: assistantText } }
  ])
}

function installFakeBinary(binary: string): void {
  const filePath = writeFile(path.join(binDir, binary), '#!/bin/sh\n')
  fs.chmodSync(filePath, 0o755)
}

function summary(source: SessionSource, sessionId: string, filePath: string): SessionSummary {
  return {
    id: source === 'claude-code' ? sessionId : `${source}:${sessionId}`,
    sessionId,
    resumeSessionId: sessionId,
    slug: '',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:01:00.000Z',
    messageCount: 2,
    turnCount: 1,
    compactCount: 0,
    cwds: [],
    version: '',
    firstUserMessage: 'fixture',
    toolUsage: {},
    skillInvocations: [],
    projectPath: path.dirname(filePath),
    filePath,
    fileSizeBytes: 0,
    allFilePaths: [filePath],
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    source
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-resume-audit-'))
  binDir = path.join(tempRoot, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

describe('resume audit', () => {
  it('五种来源均复用现有命令路径并通过 L1/L2，空期望锚点单列跳过 L3', async () => {
    for (const binary of ['claude', 'codex', 'cursor', 'opencode', 'zcode']) installFakeBinary(binary)

    const sessions = [
      summary('claude-code', IDS.claude, writeFile(path.join(tempRoot, '.claude', 'projects', 'p', `${IDS.claude}.jsonl`))),
      summary('codex', IDS.codex, writeFile(path.join(tempRoot, '.codex', 'sessions', `${IDS.codex}.jsonl`))),
      summary('cursor', IDS.cursor, writeFile(path.join(tempRoot, '.cursor', 'projects', 'p', 'agent-transcripts', IDS.cursor, `${IDS.cursor}.jsonl`))),
      summary('opencode', 'ses_OpenCode1', `${writeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'))}#ses_OpenCode1`),
      summary('zcode', 'sess_Zcode1', `${writeFile(path.join(tempRoot, '.zcode', 'cli', 'db', 'db.sqlite'))}#sess_Zcode1`)
    ]

    const report = await runResumeAudit({
      sessions,
      pathEnv: binDir,
      now: () => new Date('2026-07-18T01:02:03.000Z'),
      dbRecordExists: async () => true,
      resumeTargets: {
        'claude-code': [sessions[0].filePath],
        codex: [sessions[1].filePath],
        cursor: [sessions[2].filePath],
        opencode: [sessions[3].filePath],
        zcode: [sessions[4].filePath]
      }
    })

    expect(report).toMatchObject({
      generatedAt: '2026-07-18T01:02:03.000Z',
      readOnly: true,
      total: 5,
      ok: 0,
      fail: 0,
      envMissing: 0,
      successRate: null,
      verifiedRate: 0,
      l1: { ok: 5, fail: 0 },
      l2: { ok: 5, fail: 0, envMissing: 0 },
      l3: {
        match: 0,
        mismatch: { total: 0, wrongBranch: 0, stale: 0, empty: 0 },
        would404: 0,
        skipped: 5,
        skippedReasons: { expectedAnchorEmpty: 5 }
      }
    })
    for (const source of ['claude-code', 'codex', 'cursor', 'opencode', 'zcode'] as const) {
      expect(report.perSource[source]).toMatchObject({
        total: 1,
        ok: 0,
        fail: 0,
        l3: { skipped: 1, skippedReasons: { expectedAnchorEmpty: 1 } }
      })
    }
  })

  it('Claude resume 按命令配置扫描全部项目目录并兼容 claude-window', async () => {
    installFakeBinary('claude')
    const standardBackup = writeJsonl(
      path.join(tempRoot, 'library', 'standard-backup.jsonl'),
      claudeRows(IDS.claude, '标准目录用户锚点', '标准目录助手锚点')
    )
    writeJsonl(
      path.join(tempRoot, '.claude', 'projects', 'another-project', `${IDS.claude}.jsonl`),
      claudeRows(IDS.claude, '标准目录用户锚点', '标准目录助手锚点')
    )

    const windowConfigDir = path.join(tempRoot, '.claude-window', 'fixture-window')
    const windowBackup = writeJsonl(
      path.join(tempRoot, 'library', 'window-backup.jsonl'),
      claudeRows(IDS.claudeWindow, '窗口目录用户锚点', '窗口目录助手锚点')
    )
    writeJsonl(
      path.join(windowConfigDir, 'projects', 'window-project', `${IDS.claudeWindow}.jsonl`),
      claudeRows(IDS.claudeWindow, '窗口目录用户锚点', '窗口目录助手锚点')
    )
    const windowSummary = summary('claude-code', IDS.claudeWindow, windowBackup)
    windowSummary.claudeConfigDir = windowConfigDir

    const report = await runResumeAudit({
      sessions: [summary('claude-code', IDS.claude, standardBackup), windowSummary],
      pathEnv: binDir,
      home: tempRoot
    })

    expect(report.l3).toMatchObject({
      match: 2,
      mismatch: { total: 0 },
      would404: 0,
      skipped: 0
    })
  })

  fixtureIt('【曾经的 bug】Cursor 期望侧读 agent-transcripts，resume 实际侧按 id 全局读取 DB', async () => {
    installFakeBinary('cursor')
    const expected = writeCursorTranscript(
      path.join(tempRoot, '.cursor', 'projects', 'another-project', 'agent-transcripts', IDS.cursor, `${IDS.cursor}.jsonl`),
      'Cursor loader 用户锚点',
      'Cursor loader 助手锚点'
    )
    const storePath = createCursorStore(
      path.join(tempRoot, '.cursor', 'chats', 'not-derived-from-resume-cwd', IDS.cursor, 'store.db'),
      IDS.cursor,
      'Cursor loader 用户锚点',
      'Cursor loader 助手锚点'
    )
    const storeBefore = fs.readFileSync(storePath)
    const storeMtimeBefore = fs.statSync(storePath).mtimeMs

    const report = await runResumeAudit({
      sessions: [summary('cursor', IDS.cursor, expected)],
      pathEnv: binDir,
      home: tempRoot
    })

    expect(report.perSource.cursor.l3).toMatchObject({
      match: 1,
      mismatch: { total: 0 },
      would404: 0,
      skipped: 0
    })
    expect(fs.readFileSync(storePath)).toEqual(storeBefore)
    expect(fs.statSync(storePath).mtimeMs).toBe(storeMtimeBefore)
  })

  fixtureIt('L3 五来源真实格式 fixture 均 match', async () => {
    for (const binary of ['claude', 'codex', 'cursor', 'opencode', 'zcode']) installFakeBinary(binary)

    const claudeFile = writeJsonl(
      path.join(tempRoot, '.claude', 'projects', 'p', `${IDS.claude}.jsonl`),
      claudeRows(IDS.claude, '**Claude 用户锚点**', 'Claude `助手` 锚点')
    )
    const codexFile = writeCodexSession(
      path.join(tempRoot, '.codex', 'sessions', `rollout-2026-07-18T00-00-00-${IDS.codex}.jsonl`),
      IDS.codex,
      'Codex 用户锚点',
      'Codex 助手锚点'
    )
    const cursorTranscript = writeCursorTranscript(
      path.join(tempRoot, '.cursor', 'projects', 'fixture', 'agent-transcripts', IDS.cursor, `${IDS.cursor}.jsonl`),
      'Cursor 用户锚点',
      'Cursor 助手锚点'
    )
    const cursorDb = createCursorStore(
      path.join(tempRoot, '.cursor', 'chats', 'fixture', IDS.cursor, 'store.db'),
      IDS.cursor,
      'Cursor 用户锚点',
      'Cursor 助手锚点'
    )
    const opencodeId = 'ses_OpenCodeMatch'
    const opencodeDb = createAgentDb(
      path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'),
      opencodeId,
      'OpenCode 用户锚点',
      'OpenCode 助手锚点'
    )
    const zcodeId = 'sess_ZcodeMatch'
    const zcodeDb = createAgentDb(
      path.join(tempRoot, '.zcode', 'cli', 'db', 'db.sqlite'),
      zcodeId,
      'Zcode 用户锚点',
      'Zcode 助手锚点'
    )

    const cursorSummary = summary('cursor', IDS.cursor, cursorTranscript)
    cursorSummary.resumeCwd = '/tmp/cursor-fixture'
    const sessions = [
      summary('claude-code', IDS.claude, claudeFile),
      summary('codex', IDS.codex, codexFile),
      cursorSummary,
      summary('opencode', opencodeId, `${opencodeDb}#${opencodeId}`),
      summary('zcode', zcodeId, `${zcodeDb}#${zcodeId}`)
    ]

    const report = await runResumeAudit({
      sessions,
      pathEnv: binDir,
      resumeTargets: {
        'claude-code': [claudeFile],
        codex: [codexFile],
        cursor: [cursorDb],
        opencode: [opencodeDb],
        zcode: [zcodeDb]
      }
    })

    expect(report).toMatchObject({
      total: 5,
      ok: 5,
      fail: 0,
      l3: {
        match: 5,
        mismatch: { total: 0, wrongBranch: 0, stale: 0, empty: 0 },
        would404: 0,
        skipped: 0
      }
    })
    for (const source of ['claude-code', 'codex', 'cursor', 'opencode', 'zcode'] as const) {
      expect(report.perSource[source].l3.match).toBe(1)
    }
  })

  it('L3 区分 wrong-branch、stale 与 would-404', async () => {
    for (const binary of ['claude', 'codex', 'cursor']) installFakeBinary(binary)

    const branchRows = [
      ...claudeRows(IDS.claude, '共享用户', '共享助手'),
      {
        uuid: 'main-user', parentUuid: 'claude-assistant', sessionId: IDS.claude, type: 'user',
        timestamp: '2026-07-18T00:00:02.000Z', promptSource: 'typed',
        message: { role: 'user', content: '主链用户' }
      },
      {
        uuid: 'main-assistant', parentUuid: 'main-user', sessionId: IDS.claude, type: 'assistant',
        timestamp: '2026-07-18T00:00:03.000Z', message: { role: 'assistant', content: '主链助手' }
      },
      {
        uuid: 'main-user-2', parentUuid: 'main-assistant', sessionId: IDS.claude, type: 'user',
        timestamp: '2026-07-18T00:00:04.000Z', promptSource: 'typed',
        message: { role: 'user', content: '主链更长' }
      },
      {
        uuid: 'main-assistant-2', parentUuid: 'main-user-2', sessionId: IDS.claude, type: 'assistant',
        timestamp: '2026-07-18T00:00:05.000Z', message: { role: 'assistant', content: '主链最终' }
      },
      {
        uuid: 'branch-user', parentUuid: 'claude-assistant', sessionId: IDS.claude, type: 'user',
        timestamp: '2026-07-18T00:00:06.000Z', promptSource: 'typed',
        message: { role: 'user', content: '分支用户锚点' }
      },
      {
        uuid: 'branch-assistant', parentUuid: 'branch-user', sessionId: IDS.claude, type: 'assistant',
        timestamp: '2026-07-18T00:00:07.000Z', message: { role: 'assistant', content: '分支助手锚点' }
      }
    ]
    const claudeFile = writeJsonl(
      path.join(tempRoot, '.claude', 'projects', 'p', `${IDS.claude}.jsonl`),
      branchRows
    )

    const expectedCodex = writeCodexSession(
      path.join(tempRoot, 'library', 'codex-backup.jsonl'),
      IDS.staleCodex,
      '新的用户锚点',
      '新的助手锚点'
    )
    const staleCodexTarget = writeCodexSession(
      path.join(tempRoot, '.codex', 'sessions', `rollout-2026-07-18T00-00-00-${IDS.staleCodex}.jsonl`),
      IDS.staleCodex,
      '旧的用户内容',
      '旧的助手内容'
    )

    const missingCursorTranscript = writeCursorTranscript(
      path.join(tempRoot, '.cursor', 'projects', 'fixture', 'agent-transcripts', IDS.cursor, `${IDS.cursor}.jsonl`),
      'Cursor 将 404',
      'Cursor 目标不存在'
    )
    const missingCursorTarget = path.join(
      tempRoot,
      '.cursor',
      'chats',
      'missing-workspace',
      IDS.cursor,
      'store.db'
    )

    const report = await runResumeAudit({
      sessions: [
        summary('claude-code', IDS.claude, claudeFile),
        summary('codex', IDS.staleCodex, expectedCodex),
        summary('cursor', IDS.cursor, missingCursorTranscript)
      ],
      pathEnv: binDir,
      resumeTargets: {
        'claude-code': [claudeFile],
        codex: [staleCodexTarget],
        cursor: [missingCursorTarget]
      }
    })

    expect(report.l3).toMatchObject({
      match: 0,
      mismatch: { total: 2, wrongBranch: 1, stale: 1, empty: 0 },
      would404: 1,
      skipped: 0
    })
    expect(report.l3.mismatchExamples.map((example) => example.classification)).toEqual([
      'wrong-branch',
      'stale'
    ])
    expect(report.l3.would404Examples[0]).toMatchObject({
      sessionId: `cursor:${IDS.cursor}`,
      userAnchor: 'Cursor将404'
    })
  })

  fixtureIt('L3 目标 session 存在但无消息分类为 empty', async () => {
    installFakeBinary('opencode')
    const sessionId = 'ses_EmptyTarget'
    const expectedDb = createAgentDb(
      path.join(tempRoot, 'expected', 'opencode.db'),
      sessionId,
      '期望用户锚点',
      '期望助手锚点'
    )
    const emptyTargetDb = createAgentDb(
      path.join(tempRoot, 'actual', 'opencode.db'),
      sessionId,
      '',
      '',
      false
    )

    const report = await runResumeAudit({
      sessions: [summary('opencode', sessionId, `${expectedDb}#${sessionId}`)],
      pathEnv: binDir,
      resumeTargets: { opencode: [emptyTargetDb] }
    })

    expect(report.l3.mismatch).toEqual({ total: 1, wrongBranch: 0, stale: 0, empty: 1 })
    expect(report.l3.would404).toBe(0)
  })

  it('L1 分开分类显式不可恢复与文件内分支', async () => {
    const unavailable = summary('claude-code', IDS.claude, path.join(tempRoot, 'missing.jsonl'))
    unavailable.canResume = false
    unavailable.resumeUnavailableReason = 'fixture unavailable'

    const branch = summary('claude-code', IDS.codex, writeFile(path.join(tempRoot, `${IDS.codex}.jsonl`)))
    branch.id = `${IDS.codex}:intra-0`

    const report = await runResumeAudit({ sessions: [unavailable, branch], pathEnv: binDir })

    expect(report.l1).toEqual({ ok: 0, fail: 2 })
    expect(report.failureReasons.map((reason) => reason.code)).toEqual([
      'intra-file-branch',
      'resume-unavailable'
    ])
  })

  it('L2 覆盖非法 id、源缺失和 DB 记录缺失', async () => {
    installFakeBinary('codex')
    installFakeBinary('cursor')
    installFakeBinary('opencode')
    const invalid = summary('codex', 'not-a-uuid', writeFile(path.join(tempRoot, 'invalid.jsonl')))
    const missing = summary('cursor', IDS.cursor, path.join(tempRoot, 'missing-cursor.jsonl'))
    const dbRef = `${writeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'))}#ses_MissingRow`
    const missingRecord = summary('opencode', 'ses_MissingRow', dbRef)

    const report = await runResumeAudit({
      sessions: [invalid, missing, missingRecord],
      pathEnv: binDir,
      dbRecordExists: async () => false
    })

    expect(report.l1).toEqual({ ok: 3, fail: 0 })
    expect(report.l2).toEqual({ ok: 0, fail: 3, envMissing: 0 })
    expect(report.failureReasons.map((reason) => reason.code).sort()).toEqual([
      'db-record-missing',
      'invalid-session-id',
      'source-missing'
    ])
  })

  it('缺 harness CLI 计入 envMissing 而不是失败', async () => {
    const cursorFile = writeFile(path.join(tempRoot, '.cursor', 'projects', 'p', IDS.cursor, `${IDS.cursor}.jsonl`))
    const report = await runResumeAudit({
      sessions: [summary('cursor', IDS.cursor, cursorFile)],
      pathEnv: binDir
    })

    expect(report).toMatchObject({
      total: 1,
      ok: 0,
      fail: 0,
      envMissing: 1,
      successRate: null,
      verifiedRate: 0,
      l2: { ok: 0, fail: 0, envMissing: 1 }
    })
    expect(report.environmentMissing).toEqual([
      { binary: 'cursor', count: 1, exampleSessionId: `cursor:${IDS.cursor}` }
    ])
  })

  it('人类可读输出包含表格、TOP3 和公式说明且不泄漏源路径', async () => {
    const sourcePath = writeFile(path.join(tempRoot, 'private-project-name', `${IDS.claude}.jsonl`))
    const report = await runResumeAudit({
      sessions: [summary('claude-code', IDS.claude, sourcePath)],
      pathEnv: binDir,
      now: () => new Date('2026-07-18T00:00:00.000Z')
    })
    const output = formatResumeAuditReport(report)

    expect(output).toContain('Swob resume audit (read-only)')
    expect(output).toContain('Failure TOP 3:')
    expect(output).toContain('Per-source diagnostics:')
    expect(output).toContain('L3 content consistency:')
    expect(output).toContain('L3 mismatch examples (max 3):')
    expect(output).toContain('L3 would-404 examples (max 3):')
    expect(output).toContain('  claude-code:')
    expect(output).toContain('env-missing is excluded')
    expect(output).not.toContain(sourcePath)
    expect(output).not.toContain('private-project-name')
  })

  it('锚点规范化去空白和 Markdown，示例严格截 30 字符并脱敏', async () => {
    installFakeBinary('codex')
    expect(normalizeResumeAuditText('## Hello  **world**\n`code`')).toBe('Helloworldcode')

    const sessionId = IDS.staleCodex
    const longCredentialLike = ['abcdefghijklmnop', 'qrstuvwxyz1234567890'].join('')
    const expected = writeCodexSession(
      path.join(tempRoot, 'library', 'credential-like.jsonl'),
      sessionId,
      `credential ${longCredentialLike} 后续文字`,
      '这是一个超过三十字符的助手消息用于验证严格截断行为不会泄漏更多内容'
    )
    const target = writeCodexSession(
      path.join(tempRoot, '.codex', 'sessions', `rollout-2026-07-18T00-00-00-${sessionId}.jsonl`),
      sessionId,
      '旧用户',
      '旧助手'
    )
    const report = await runResumeAudit({
      sessions: [summary('codex', sessionId, expected)],
      pathEnv: binDir,
      resumeTargets: { codex: [target] }
    })
    const example = report.l3.mismatchExamples[0]

    expect(example.userAnchor).toContain('xx……7890')
    expect(Array.from(example.userAnchor).length).toBeLessThanOrEqual(30)
    expect(Array.from(example.assistantAnchor).length).toBe(30)
    expect(JSON.stringify(report)).not.toContain(longCredentialLike)
  })

  it('DB source ref 以数据库本体判断存在，不把 #sessionId 当文件名', () => {
    const dbPath = writeFile(path.join(tempRoot, '.local', 'share', 'opencode', 'opencode.db'))
    initLibrary(path.join(tempRoot, 'library'))
    scanLibrary()

    expect(getSessionResumeAvailability('ses_Record1', summary('opencode', 'ses_Record1', `${dbPath}#ses_Record1`)))
      .toEqual({ canResume: true, sourcePath: `${dbPath}#ses_Record1` })
  })

  it('readOnly 初始化不会创建不存在的 Library 目录', () => {
    const libraryPath = path.join(tempRoot, 'does-not-exist')
    initLibrary(libraryPath, { readOnly: true })

    expect(fs.existsSync(libraryPath)).toBe(false)
  })
})

describe('resume session id validation', () => {
  it('按来源接受 UUID、ses_ 和 sess_ 格式', () => {
    expect(isValidResumeSessionId(IDS.claude, 'claude-code')).toBe(true)
    expect(isValidResumeSessionId(IDS.codex, 'codex')).toBe(true)
    expect(isValidResumeSessionId(IDS.cursor, 'cursor')).toBe(true)
    expect(isValidResumeSessionId('ses_OpenCode-1', 'opencode')).toBe(true)
    expect(isValidResumeSessionId('sess_Zcode-1', 'zcode')).toBe(true)
    expect(isValidResumeSessionId('sess_CompatiblePrefix', 'opencode')).toBe(true)
    expect(isValidResumeSessionId('ses_CompatiblePrefix', 'zcode')).toBe(true)
    expect(isValidResumeSessionId('invalid-prefix', 'opencode')).toBe(false)
  })
})
