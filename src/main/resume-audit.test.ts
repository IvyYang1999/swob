import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  formatResumeAuditReport,
  isValidResumeSessionId,
  runResumeAudit
} from './resume-audit'
import { getSessionResumeAvailability, initLibrary, scanLibrary } from './library-manager'
import type { SessionSource, SessionSummary } from './types'

const IDS = {
  claude: '11111111-1111-4111-8111-111111111111',
  codex: '22222222-2222-4222-8222-222222222222',
  cursor: '33333333-3333-4333-8333-333333333333'
}

let tempRoot: string
let binDir: string

function writeFile(filePath: string, content = ''): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
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
  it('五种来源均复用现有命令路径并通过 L1/L2', async () => {
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
      dbRecordExists: async () => true
    })

    expect(report).toMatchObject({
      generatedAt: '2026-07-18T01:02:03.000Z',
      readOnly: true,
      total: 5,
      ok: 5,
      fail: 0,
      envMissing: 0,
      successRate: 100,
      verifiedRate: 100,
      l1: { ok: 5, fail: 0 },
      l2: { ok: 5, fail: 0, envMissing: 0 }
    })
    for (const source of ['claude-code', 'codex', 'cursor', 'opencode', 'zcode'] as const) {
      expect(report.perSource[source]).toMatchObject({ total: 1, ok: 1, fail: 0 })
    }
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
    expect(output).toContain('  claude-code:')
    expect(output).toContain('env-missing is excluded')
    expect(output).not.toContain(sourcePath)
    expect(output).not.toContain('private-project-name')
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
