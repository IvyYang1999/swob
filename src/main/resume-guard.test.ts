import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  getSessionResumeAvailability,
  initLibrary,
  scanLibrary,
  LOCAL_RESUME_UNAVAILABLE_REASON
} from './library-manager'
import {
  buildGuardedResumeAction,
  buildGuardedResumeCommand,
  openGuardedForkAction,
  openGuardedResumeAction,
  openGuardedResumeCommand
} from './resume-guard'
import type { SessionSource, SessionSummary } from './types'

let tmpRoot: string

function writeSessionMeta(dirPath: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify(meta, null, 2), 'utf-8')
}

function writeBackup(dirPath: string, sessionId: string, source: SessionSource): void {
  let row: unknown
  if (source === 'codex') {
    row = { timestamp: '2026-07-07T00:00:00Z', type: 'session_meta', payload: { id: sessionId, timestamp: '2026-07-07T00:00:00Z', cwd: tmpRoot, cli_version: 'test' } }
  } else if (source === 'cursor') {
    row = { role: 'user', message: { content: 'hello' } }
  } else {
    row = { uuid: `${sessionId}-u1`, parentUuid: null, sessionId, type: 'user', timestamp: '2026-07-07T00:00:00Z', cwd: tmpRoot, message: { role: 'user', content: 'hello' } }
  }
  fs.writeFileSync(path.join(dirPath, 'backup.jsonl'), JSON.stringify(row) + '\n', 'utf-8')
}

function writeSource(filePath: string, sessionId: string, source: SessionSource): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (source === 'codex') {
    fs.writeFileSync(filePath, [
      JSON.stringify({ timestamp: '2026-07-07T00:00:00Z', type: 'session_meta', payload: { id: sessionId, timestamp: '2026-07-07T00:00:00Z', cwd: tmpRoot, cli_version: 'test' } }),
      JSON.stringify({ timestamp: '2026-07-07T00:01:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] } }),
      JSON.stringify({ timestamp: '2026-07-07T00:02:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] } })
    ].join('\n') + '\n', 'utf-8')
    return
  }
  if (source === 'cursor') {
    fs.writeFileSync(filePath, [
      JSON.stringify({ role: 'user', message: { content: 'hello' } }),
      JSON.stringify({ role: 'assistant', message: { content: 'ok' } })
    ].join('\n') + '\n', 'utf-8')
    return
  }
  fs.writeFileSync(filePath, [
    JSON.stringify({ uuid: `${sessionId}-u1`, parentUuid: null, sessionId, type: 'user', timestamp: '2026-07-07T00:00:00Z', cwd: tmpRoot, message: { role: 'user', content: 'hello' } }),
    JSON.stringify({ uuid: `${sessionId}-a1`, parentUuid: `${sessionId}-u1`, sessionId, type: 'assistant', timestamp: '2026-07-07T00:01:00Z', cwd: tmpRoot, message: { role: 'assistant', content: 'ok' } })
  ].join('\n') + '\n', 'utf-8')
}

function summary(sessionId: string, filePath: string, source: SessionSource): SessionSummary {
  return {
    id: source === 'codex' ? `codex:${sessionId}` : source === 'cursor' ? `cursor:${sessionId}` : sessionId,
    sessionId,
    resumeSessionId: sessionId,
    slug: '',
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:01:00Z',
    messageCount: 2,
    turnCount: 1,
    compactCount: 0,
    cwds: [tmpRoot],
    version: '',
    firstUserMessage: 'hello',
    toolUsage: {},
    skillInvocations: [],
    projectPath: path.dirname(filePath),
    filePath,
    fileSizeBytes: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
    allFilePaths: [filePath],
    resumeCwd: tmpRoot,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    source
  }
}

function sourcePathFor(sessionId: string, source: SessionSource, exists: boolean): string {
  const base = exists ? tmpRoot : '/Users/other-machine'
  if (source === 'codex') return path.join(base, '.codex', 'sessions', '2026', '07', `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`)
  if (source === 'cursor') return path.join(base, '.cursor', 'projects', '-Users-other-project', 'agent-transcripts', sessionId, `${sessionId}.jsonl`)
  if (source === 'antigravity') return path.join(base, '.gemini', 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs', 'transcript.jsonl')
  return path.join(base, '.claude', 'projects', '-Users-other-project', `${sessionId}.jsonl`)
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-resume-guard-'))
  initLibrary(tmpRoot)
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('resume guard', () => {
  it('Hermes Fork fails before preparation or terminal launch', async () => {
    const sessionId = 'hermes-no-fork'
    const sourcePath = path.join(tmpRoot, '.hermes', 'state.db') + `#${sessionId}`
    const session = summary(sessionId, sourcePath, 'hermes')
    let prepared = false
    const opened: unknown[] = []

    const result = await openGuardedForkAction({
      sessionId,
      sessions: [session],
      prepareResumeTarget: async () => {
        prepared = true
        return { ok: true, sourcePath }
      },
      openAction: (action) => { opened.push(action) }
    })

    expect(result).toMatchObject({
      ok: false,
      surface: 'terminal',
      reasonCode: 'resume.error.build_action_failed',
      reasonParams: { details: expect.stringContaining('no verified CLI surface for forking') }
    })
    expect(prepared).toBe(false)
    expect(opened).toEqual([])
  })

  it.each([
    ['claude-code' as const],
    ['codex' as const],
    ['cursor' as const]
  ])('【曾经的 bug】跨设备 %s 会话源不存在只有 backup 时不可恢复且不打开命令', async (source) => {
    const sessionId = `${source}-remote`
    const sourcePath = sourcePathFor(sessionId, source, false)
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: '/Users/other-machine/project'
    })
    writeBackup(dirPath, sessionId, source)
    scanLibrary()

    expect(getSessionResumeAvailability(sessionId, summary(sessionId, sourcePath, source))).toEqual({
      canResume: false,
      reason: LOCAL_RESUME_UNAVAILABLE_REASON,
      sourcePath
    })

    const opened: string[] = []
    const result = await openGuardedResumeCommand({
      sessionId,
      sessions: [summary(sessionId, sourcePath, source)],
      openCommand: (command) => opened.push(command)
    })

    expect(result.ok).toBe(false)
    expect(result.reasonCode).toBe('resume.error.unavailable')
    expect(opened).toEqual([])
  })

  it.each([
    ['claude-code' as const, 'claude --resume'],
    ['codex' as const, 'codex resume'],
    ['cursor' as const, 'cursor agent --resume']
  ])('本机有源文件的 %s 会话可恢复且命令行为不变', async (source, expectedCommandPart) => {
    const sessionId = `${source}-local`
    const sourcePath = sourcePathFor(sessionId, source, true)
    writeSource(sourcePath, sessionId, source)
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()

    expect(getSessionResumeAvailability(sessionId, summary(sessionId, sourcePath, source)).canResume).toBe(true)

    const opened: string[] = []
    const result = await openGuardedResumeCommand({
      sessionId,
      sessions: [summary(sessionId, sourcePath, source)],
      openCommand: (command) => opened.push(command)
    })

    expect(result.ok).toBe(true)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toContain(expectedCommandPart)
    expect(opened[0]).toContain(sessionId)
  })

  it('Antigravity Resume 必须先证明本机 CLI 真实支持 --conversation', async () => {
    const sessionId = 'agy-local-conversation'
    const sourcePath = sourcePathFor(sessionId, 'antigravity', true)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, '{"step_index":0,"type":"USER_INPUT","content":"synthetic"}\n')
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()
    const session = summary(sessionId, sourcePath, 'antigravity')
    const opened: unknown[] = []

    const blocked = await openGuardedResumeAction({
      sessionId,
      sessions: [session],
      openAction: (action) => { opened.push(action) },
      antigravityResumePreflight: async () => ({
        available: false, reason: 'conversation-flag-unavailable', helpOutput: 'agy --resume <id>'
      })
    })
    expect(blocked).toMatchObject({
      ok: false,
      reasonCode: 'resume.error.build_action_failed',
      reasonParams: { details: 'antigravity-resume-conversation-flag-unavailable' }
    })
    expect(opened).toEqual([])

    const allowed = await openGuardedResumeAction({
      sessionId,
      sessions: [session],
      openAction: (action) => { opened.push(action) },
      antigravityResumePreflight: async () => ({
        available: true, reason: 'available', helpOutput: 'agy --conversation <id>'
      })
    })
    expect(allowed).toMatchObject({
      ok: true,
      action: {
        kind: 'terminal',
        launchSpec: { executable: 'agy', args: ['--conversation', sessionId] }
      }
    })
    expect(opened).toEqual([allowed.action])
  })

  it('Codex Desktop action 复用同一 guard，并把已验证 session id 交给 deep link', async () => {
    const sessionId = '019abcde-1234-7000-8000-0123456789ab'
    const sourcePath = sourcePathFor(sessionId, 'codex', true)
    writeSource(sourcePath, sessionId, 'codex')
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()

    const opened: unknown[] = []
    const result = await openGuardedResumeAction({
      sessionId,
      sessions: [summary(sessionId, sourcePath, 'codex')],
      surface: 'codex-desktop',
      openAction: (action) => { opened.push(action) }
    })

    expect(result).toMatchObject({
      ok: true,
      sessionId,
      surface: 'codex-desktop',
      action: {
        kind: 'deep-link',
        url: `codex://threads/${sessionId}`
      }
    })
    expect(opened).toEqual([result.action])
  })

  it('Claude Desktop action 默认被实验门控拒绝，显式开启后才构建 deep link', async () => {
    const sessionId = '82000000-0000-4000-8000-000000000001'
    const sourcePath = sourcePathFor(sessionId, 'claude-code', true)
    writeSource(sourcePath, sessionId, 'claude-code')
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()
    const session = summary(sessionId, sourcePath, 'claude-code')

    const blocked = await buildGuardedResumeAction({
      sessionId,
      sessions: [session],
      surface: 'claude-desktop'
    })
    expect(blocked).toMatchObject({
      ok: false,
      surface: 'claude-desktop',
      reasonCode: 'resume.error.claude_desktop_disabled'
    })

    const allowed = await buildGuardedResumeAction({
      sessionId,
      sessions: [session],
      surface: 'claude-desktop',
      allowExperimentalClaudeDesktop: true
    })
    expect(allowed).toMatchObject({
      ok: true,
      surface: 'claude-desktop',
      action: {
        kind: 'deep-link',
        url: `claude://resume?session=${sessionId}`
      }
    })
  })

  it('ZCode guard 只生成打开 App/工作区的 action，终端命令 fail closed', async () => {
    const sessionId = 'sess_ZcodeGuard1'
    const dbPath = path.join(tmpRoot, '.zcode', 'cli', 'db', 'db.sqlite')
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    fs.writeFileSync(dbPath, '')
    const sourceRef = `${dbPath}#${sessionId}`
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourceRef],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()
    const session = summary(sessionId, sourceRef, 'zcode')

    const desktop = await buildGuardedResumeAction({
      sessionId,
      sessions: [session],
      surface: 'zcode-desktop'
    })
    expect(desktop).toMatchObject({
      ok: true,
      surface: 'zcode-desktop',
      noticeCode: 'resume.notice.zcode_opened',
      action: {
        kind: 'deep-link',
        url: `zcode://workspace/open?path=${encodeURIComponent(tmpRoot)}`
      }
    })

    const terminal = await buildGuardedResumeCommand({
      sessionId,
      sessions: [session]
    })
    expect(terminal).toMatchObject({
      ok: false,
      reasonCode: 'resume.error.unavailable'
    })
  })

  it('目标客户端启动失败时返回失败，不把 action 构建成功误报为已打开', async () => {
    const sessionId = '019abcde-1234-7000-8000-0123456789ab'
    const sourcePath = sourcePathFor(sessionId, 'codex', true)
    writeSource(sourcePath, sessionId, 'codex')

    const result = await openGuardedResumeAction({
      sessionId,
      sessions: [summary(sessionId, sourcePath, 'codex')],
      surface: 'codex-desktop',
      openAction: async () => {
        throw new Error('protocol handler missing')
      }
    })

    expect(result).toMatchObject({
      ok: false,
      surface: 'codex-desktop',
      reasonCode: 'resume.error.open_client_failed',
      reasonParams: { details: 'protocol handler missing' }
    })
  })

  it('坏 meta 缺 sourceFilePaths 且没有本机 summary 时不抛错并禁用 resume', () => {
    const sessionId = 'bad-meta-missing-source-paths'
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: '/Users/other-machine/project'
    })
    writeBackup(dirPath, sessionId, 'claude-code')
    scanLibrary()

    expect(() => getSessionResumeAvailability(sessionId)).not.toThrow()
    expect(getSessionResumeAvailability(sessionId)).toEqual({
      canResume: false,
      reason: LOCAL_RESUME_UNAVAILABLE_REASON,
      sourcePath: null
    })
  })

  it('meta sourceFilePaths 为空数组时禁用 resume', () => {
    const sessionId = 'bad-meta-empty-source-paths'
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: '/Users/other-machine/project'
    })
    scanLibrary()

    expect(getSessionResumeAvailability(sessionId)).toEqual({
      canResume: false,
      reason: LOCAL_RESUME_UNAVAILABLE_REASON,
      sourcePath: null
    })
  })

  it('坏 meta 缺 sourceFilePaths 但本机 summary 有真实源时按 summary 放行', () => {
    const sessionId = 'bad-meta-local-summary'
    const sourcePath = sourcePathFor(sessionId, 'claude-code', true)
    writeSource(sourcePath, sessionId, 'claude-code')
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()

    expect(getSessionResumeAvailability(sessionId, summary(sessionId, sourcePath, 'claude-code'))).toEqual({
      canResume: true,
      sourcePath
    })
  })

  it('复制命令不触发恢复写入，真正打开 Resume 才跨过恢复动作边界', async () => {
    const sessionId = '82000000-0000-4000-8000-000000000001'
    const sourcePath = sourcePathFor(sessionId, 'claude-code', true)
    writeSource(sourcePath, sessionId, 'claude-code')
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()

    const recoveryFlags: boolean[] = []
    const prepareResumeTarget = async (_id: string, options: { allowRecovery?: boolean }) => {
      recoveryFlags.push(options.allowRecovery === true)
      return options.allowRecovery
        ? { ok: true, state: 'restored' as const, sourcePath }
        : { ok: false, sourcePath, failureCode: 'recovery-required' as const, reason: 'recovery required' }
    }

    const copied = await buildGuardedResumeCommand({
      sessionId,
      sessions: [summary(sessionId, sourcePath, 'claude-code')],
      prepareResumeTarget
    })
    expect(copied).toMatchObject({ ok: false, reasonCode: 'resume.error.recovery-required' })

    const opened: string[] = []
    const resumed = await openGuardedResumeCommand({
      sessionId,
      sessions: [summary(sessionId, sourcePath, 'claude-code')],
      prepareResumeTarget,
      openCommand: (command) => opened.push(command)
    })
    expect(resumed.ok).toBe(true)
    expect(opened).toHaveLength(1)
    expect(recoveryFlags).toEqual([false, true])
  })

  it('远程会话显式选择目标实例后透传 preferredTargetInstanceId', async () => {
    const sessionId = 'remote-import-with-selected-target'
    const sourcePath = sourcePathFor(sessionId, 'claude-code', false)
    const dirPath = path.join(tmpRoot, sessionId)
    writeSessionMeta(dirPath, {
      schemaVersion: 2,
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: '/Users/other-machine/project',
      origin: {
        deviceId: 'remote-device-selected-target',
        hostname: 'remote-selected.local',
        username: 'remote',
        capturedAt: '2026-07-07T00:00:00Z'
      }
    })
    writeBackup(dirPath, sessionId, 'claude-code')
    scanLibrary()

    const received: Array<{
      allowRecovery?: boolean
      requestedSessionId?: string
      preferredTargetInstanceId?: string
    }> = []
    const opened: string[] = []
    const result = await openGuardedResumeCommand({
      sessionId,
      sessions: [summary(sessionId, sourcePath, 'claude-code')],
      preferredTargetInstanceId: 'claude-default',
      prepareResumeTarget: async (_id, options) => {
        received.push(options)
        return { ok: true, state: 'restored', sourcePath: path.join(tmpRoot, `${sessionId}.jsonl`) }
      },
      openCommand: (command) => opened.push(command)
    })

    expect(result.ok).toBe(true)
    expect(opened).toHaveLength(1)
    expect(received).toEqual([{
      allowRecovery: true,
      requestedSessionId: sessionId,
      preferredTargetInstanceId: 'claude-default'
    }])
  })

  it('continuation 物理 ID 复活时，用逻辑 Library ID 找备份但仍恢复物理 ID', async () => {
    const logicalId = '86000000-0000-4000-8000-000000000001'
    const physicalId = '86000000-0000-4000-8000-000000000002'
    const sourcePath = sourcePathFor(physicalId, 'claude-code', true)
    writeSource(sourcePath, physicalId, 'claude-code')
    const dirPath = path.join(tmpRoot, logicalId)
    writeSessionMeta(dirPath, {
      sessionId: logicalId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-07T00:00:00Z',
      updatedAt: '2026-07-07T00:01:00Z',
      projectPath: tmpRoot
    })
    scanLibrary()

    const parent = summary(logicalId, sourcePath, 'claude-code')
    parent.continuationSessionIds = [physicalId]
    parent.resumeSessionId = physicalId
    const preparedIds: string[] = []
    const result = await openGuardedResumeCommand({
      sessionId: physicalId,
      sessions: [parent],
      prepareResumeTarget: async (sessionId) => {
        preparedIds.push(sessionId)
        return { ok: true, state: 'restored', sourcePath }
      },
      openCommand: () => undefined
    })

    expect(preparedIds).toEqual([logicalId])
    expect(result).toMatchObject({ ok: true, sessionId: physicalId })
    expect(result.command).toContain(physicalId)
  })
})
