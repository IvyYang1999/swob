import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildForkCommand,
  buildForkLaunchSpec,
  buildResumeAction,
  buildResumeCommand,
  buildResumeLaunchSpec,
  resolveSessionActionContext
} from './session-actions'
import { shellQuote } from './resume-terminal'
import type { RawJsonlMessage, SessionSummary } from './types'

function rawMsg(overrides: Partial<RawJsonlMessage> & { type: RawJsonlMessage['type'] }): RawJsonlMessage {
  return {
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    parentUuid: overrides.parentUuid ?? null,
    sessionId: overrides.sessionId || 'test-session',
    type: overrides.type,
    subtype: overrides.subtype,
    timestamp: overrides.timestamp || '2026-06-14T00:00:00Z',
    cwd: overrides.cwd || '/Users/test/project',
    version: overrides.version || '2.1.70',
    permissionMode: overrides.permissionMode,
    message: overrides.message
  }
}

function writeJsonlAt(filePath: string, messages: RawJsonlMessage[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'))
  return filePath
}

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: overrides.id || 'test-session',
    sessionId: overrides.sessionId || 'test-session',
    slug: '',
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
    messageCount: 0,
    turnCount: 0,
    compactCount: 0,
    cwds: [],
    version: '',
    firstUserMessage: '',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '',
    filePath: '',
    fileSizeBytes: 0,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    source: 'claude-code',
    ...overrides
  }
}

describe('session action context', () => {
  it('fails closed instead of relabelling Resume as Fork for unsupported sources', () => {
    for (const source of ['cursor', 'opencode', 'zcode', 'cc-mirror', 'antigravity', 'grok', 'pi', 'kimi', 'hermes'] as const) {
      expect(() => buildForkLaunchSpec('synthetic-session', undefined, undefined, source))
        .toThrow(`session-fork-unavailable:${source}`)
      expect(() => buildForkCommand('synthetic-session', undefined, undefined, source))
        .toThrow(`session-fork-unavailable:${source}`)
    }
  })

  it('keeps verified Claude and Codex Fork commands distinct from Resume', () => {
    expect(buildForkLaunchSpec('claude-session')).toMatchObject({
      executable: 'claude',
      args: ['--fork-session', '--resume', 'claude-session']
    })
    expect(buildForkCommand('claude-session'))
      .toBe(`claude --fork-session --resume ${shellQuote('claude-session')}`)
    expect(buildForkLaunchSpec('codex-session', undefined, undefined, 'codex')).toMatchObject({
      executable: 'codex',
      args: ['fork', 'codex-session']
    })
    expect(buildForkCommand('codex-session', undefined, undefined, 'codex'))
      .toBe(`codex fork ${shellQuote('codex-session')}`)
  })

  it('never rewrites non-Claude provider identity through the Claude fresh parser', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-provider-action-context-'))
    const claudeShapedFile = writeJsonlAt(path.join(root, 'foreign-provider.jsonl'), [rawMsg({
      uuid: 'foreign-user',
      sessionId: 'must-not-replace-provider-id',
      type: 'user',
      cwd: '/must-not-replace-provider-cwd',
      message: { role: 'user', content: 'synthetic foreign provider payload' }
    })])
    try {
      for (const source of ['kimi', 'hermes'] as const) {
        const context = await resolveSessionActionContext(`${source}-session`, [summary({
          id: `${source}-session`,
          sessionId: `${source}-session`,
          source,
          filePath: claudeShapedFile,
          allFilePaths: [claudeShapedFile],
          resumeCwd: `/synthetic/${source}`
        })])
        expect(context).toMatchObject({
          sessionId: `${source}-session`,
          source,
          cwd: `/synthetic/${source}`
        })
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('Windows Claude Resume 以 argv/cwd/env 建模，不拼 shell 字符串', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-win-launch-'))
    try {
      expect(buildResumeLaunchSpec(
        '82000000-0000-4000-8000-000000000001',
        'bypassPermissions',
        dir,
        'claude-code',
        'C:\\Users\\Alice\\.claude-window\\profile',
        'win32'
      )).toEqual({
        executable: 'claude',
        args: ['--dangerously-skip-permissions', '--resume', '82000000-0000-4000-8000-000000000001'],
        cwd: dir,
        env: { CLAUDE_CONFIG_DIR: 'C:\\Users\\Alice\\.claude-window\\profile' },
        target: 'native',
        keepOpen: true
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Windows Codex Resume 保留 -C 参数并禁止 Alpha 外来源', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-win-codex-launch-'))
    try {
      expect(buildResumeLaunchSpec('thread-123', undefined, dir, 'codex', undefined, 'win32'))
        .toMatchObject({ executable: 'codex', args: ['resume', 'thread-123', '-C', dir], cwd: dir })
      expect(() => buildResumeLaunchSpec('ses_abc', undefined, dir, 'opencode', undefined, 'win32'))
        .toThrow('Windows Alpha 暂不支持 OpenCode')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Windows 只允许 Claude 终端 Resume 与 Codex Desktop deep-link', () => {
    expect(() => buildResumeAction(
      '82000000-0000-4000-8000-000000000001',
      undefined,
      undefined,
      'claude-code',
      undefined,
      'claude-desktop',
      'win32'
    )).toThrow('Windows Alpha 暂不支持 claude-desktop Resume')

    expect(buildResumeAction(
      '019abcde-1234-7000-8000-0123456789ab',
      undefined,
      undefined,
      'codex',
      undefined,
      'codex-desktop',
      'win32'
    )).toEqual({
      kind: 'deep-link',
      url: 'codex://threads/019abcde-1234-7000-8000-0123456789ab'
    })
  })

  it('opencode resume command uses opencode --session and cd cwd when available', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-opencode-resume-'))

    try {
      const command = buildResumeCommand('ses_Abc123', undefined, dir, 'opencode')

      expect(command).toBe(`cd ${shellQuote(dir)} && opencode --session ${shellQuote('ses_Abc123')}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('zcode raw runtime command uses --resume rather than the invalid --session flag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-zcode-resume-'))

    try {
      const command = buildResumeCommand('sess_b3c1-with-hyphen', undefined, dir, 'zcode')

      expect(command).toBe(`cd ${shellQuote(dir)} && zcode --resume ${shellQuote('sess_b3c1-with-hyphen')}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Kimi uses its audited --session contract instead of the generic --resume guess', () => {
    const action = buildResumeAction(
      'session_synthetic_native',
      undefined,
      undefined,
      'kimi'
    )

    expect(action).toEqual({
      kind: 'terminal',
      command: `kimi --session ${shellQuote('session_synthetic_native')}`,
      launchSpec: {
        executable: 'kimi',
        args: ['--session', 'session_synthetic_native'],
        target: 'native',
        keepOpen: true
      }
    })
  })

  it('builds a Codex Desktop deep link only for a validated Codex session id', () => {
    expect(buildResumeAction(
      '019abcde-1234-7000-8000-0123456789ab',
      undefined,
      undefined,
      'codex',
      undefined,
      'codex-desktop'
    )).toEqual({
      kind: 'deep-link',
      url: 'codex://threads/019abcde-1234-7000-8000-0123456789ab'
    })

    expect(() => buildResumeAction(
      'thread/../../escape',
      undefined,
      undefined,
      'codex',
      undefined,
      'codex-desktop'
    )).toThrow('codex session id 格式不合法')
  })

  it('builds the experimental Claude Desktop import deep link for UUID sessions only', () => {
    const sessionId = '82000000-0000-4000-8000-000000000001'
    expect(buildResumeAction(
      sessionId,
      undefined,
      undefined,
      'claude-code',
      undefined,
      'claude-desktop'
    )).toEqual({
      kind: 'deep-link',
      url: `claude://resume?session=${sessionId}`
    })

    expect(() => buildResumeAction(
      'not-a-uuid',
      undefined,
      undefined,
      'claude-code',
      undefined,
      'claude-desktop'
    )).toThrow('claude session id 格式不合法')
  })

  it('builds Claude Remote Control as a terminal-hosted action', () => {
    const action = buildResumeAction(
      '82000000-0000-4000-8000-000000000001',
      undefined,
      undefined,
      'claude-code',
      undefined,
      'remote-control'
    )
    expect(action).toMatchObject({
      kind: 'remote-control',
      command: `claude --resume ${shellQuote('82000000-0000-4000-8000-000000000001')} --remote-control`
    })
  })

  it('opens the ZCode workspace through its registered scheme but refuses a fake public CLI surface', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-zcode-action-'))
    try {
      expect(buildResumeAction(
        'sess_Zcode1',
        undefined,
        dir,
        'zcode',
        undefined,
        'zcode-desktop'
      )).toEqual({
        kind: 'deep-link',
        url: `zcode://workspace/open?path=${encodeURIComponent(dir)}`
      })
      expect(() => buildResumeAction(
        'sess_Zcode1',
        undefined,
        dir,
        'zcode',
        undefined,
        'terminal'
      )).toThrow('ZCode 没有公开 CLI')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resume 命令会 shell-quote cwd 和 sessionId，避免特殊字符被 shell 解释', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-action-quote-'))
    const dir = path.join(tmpRoot, "project '$HOME")
    const sessionId = "abc'; touch /tmp/swob-pwn #"

    try {
      fs.mkdirSync(dir, { recursive: true })
      const command = buildResumeCommand(sessionId, undefined, dir, 'claude-code')

      expect(command).toBe(`cd ${shellQuote(dir)} && claude --resume ${shellQuote(sessionId)}`)
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('Claude Window session should recover config dir and original cwd from JSONL even when summary is stale', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-action-home-'))
    const configDir = path.join(home, '.claude-window', '17db0051cdfc')
    const initialCwd = path.join(home, 'project-start')
    const laterCwd = path.join(home, 'project-later')
    fs.mkdirSync(initialCwd, { recursive: true })
    fs.mkdirSync(laterCwd, { recursive: true })

    const sessionFile = writeJsonlAt(
      path.join(configDir, 'projects', '-Users-test-project-start', 'window-session.jsonl'),
      [
        rawMsg({
          uuid: 'u1',
          sessionId: 'window-session',
          type: 'user',
          timestamp: '2026-06-14T10:00:00Z',
          cwd: initialCwd,
          permissionMode: 'bypassPermissions',
          message: { role: 'user', content: 'start here' }
        }),
        rawMsg({
          uuid: 'a1',
          sessionId: 'window-session',
          type: 'assistant',
          timestamp: '2026-06-14T10:01:00Z',
          cwd: laterCwd,
          permissionMode: 'default',
          message: { role: 'assistant', content: 'later elsewhere' }
        })
      ]
    )

    const context = await resolveSessionActionContext('window-session', [
      summary({
        id: 'window-session',
        sessionId: 'window-session',
        filePath: sessionFile,
        allFilePaths: [sessionFile],
        resumeCwd: laterCwd,
        permissionMode: 'bypassPermissions'
      })
    ], { home, cwdFallback: laterCwd })

    expect(context.sessionId).toBe('window-session')
    expect(context.cwd).toBe(initialCwd)
    expect(context.claudeConfigDir).toBe(configDir)
    expect(context.permissionMode).toBe('default')

    const command = buildResumeCommand(
      context.sessionId,
      context.permissionMode,
      context.cwd,
      context.source,
      context.claudeConfigDir
    )
    expect(command).toContain(`cd ${shellQuote(initialCwd)}`)
    expect(command).toContain(`CLAUDE_CONFIG_DIR=${shellQuote(configDir)} claude --resume ${shellQuote('window-session')}`)
  })

  it('continuation id should resolve through the parent summary and keep the earliest cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-action-continuation-'))
    const initialCwd = path.join(dir, 'project-start')
    const laterCwd = path.join(dir, 'project-later')
    fs.mkdirSync(initialCwd, { recursive: true })
    fs.mkdirSync(laterCwd, { recursive: true })

    const parentFile = writeJsonlAt(path.join(dir, 'parent.jsonl'), [
      rawMsg({
        uuid: 'u1',
        sessionId: 'parent-session',
        type: 'user',
        timestamp: '2026-06-14T10:00:00Z',
        cwd: initialCwd,
        message: { role: 'user', content: 'first cwd' }
      }),
      rawMsg({
        uuid: 'a1',
        sessionId: 'parent-session',
        type: 'assistant',
        timestamp: '2026-06-14T10:01:00Z',
        cwd: initialCwd,
        message: { role: 'assistant', content: 'ok' }
      })
    ])
    const childFile = writeJsonlAt(path.join(dir, 'child.jsonl'), [
      rawMsg({
        uuid: 'u2',
        sessionId: 'child-session',
        type: 'user',
        timestamp: '2026-06-14T10:10:00Z',
        cwd: laterCwd,
        message: { role: 'user', content: 'continued elsewhere' }
      }),
      rawMsg({
        uuid: 'a2',
        sessionId: 'child-session',
        type: 'assistant',
        timestamp: '2026-06-14T10:11:00Z',
        cwd: laterCwd,
        message: { role: 'assistant', content: 'continued' }
      })
    ])

    const context = await resolveSessionActionContext('child-session', [
      summary({
        id: 'parent-session',
        sessionId: 'parent-session',
        filePath: parentFile,
        allFilePaths: [parentFile, childFile],
        resumeCwd: laterCwd,
        continuationSessionIds: ['child-session']
      })
    ])

    expect(context.sessionId).toBe('parent-session')
    expect(context.cwd).toBe(initialCwd)
  })

  it('intra-file branch id should not silently resolve to its parent session', async () => {
    await expect(resolveSessionActionContext('parent-session:intra-0', [
      summary({
        id: 'parent-session:intra-0',
        sessionId: 'parent-session'
      })
    ])).rejects.toThrow('Intra-file branches cannot be resumed independently')
  })
})
