import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildResumeCommand,
  resolveSessionActionContext
} from './session-actions'
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
    expect(command).toContain(`cd ${JSON.stringify(initialCwd)}`)
    expect(command).toContain(`CLAUDE_CONFIG_DIR=${JSON.stringify(configDir)} claude --resume window-session`)
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
