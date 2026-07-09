/**
 * session-loader.ts 核心解析逻辑测试
 *
 * 这些函数虽然不是 UI，但出 bug 时你看到的全是 UI 怪象：
 * - 列表里 session 标题是 "[Request interrupted..."
 * - 点击 session 看到空白
 * - 工具统计数字不对
 * - 分支检测误判
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildSessionSummary,
  buildSessionSummaryFromBackup,
  buildSessionDetail,
  loadSessionDetail,
  detectIntraFileBranches,
  filterMessagesByBranch,
  findClaudeProjectRoots,
  findSessionFilesInProjectRoots,
  getClaudeConfigDirForSessionFile,
  isRealUserMessage
} from './session-loader'
import { buildResumeCommand, resolveSessionActionContext } from './session-actions'
import { shellQuote } from './resume-terminal'
import type { RawJsonlMessage } from './types'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// --- 造假 JSONL 消息的工具函数 ---
function rawMsg(overrides: Partial<RawJsonlMessage> & { type: RawJsonlMessage['type'] }): RawJsonlMessage {
  return {
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    parentUuid: overrides.parentUuid ?? null,
    sessionId: overrides.sessionId || 'test-session-id',
    type: overrides.type,
    subtype: overrides.subtype,
    timestamp: overrides.timestamp || '2026-03-01T00:00:00Z',
    cwd: overrides.cwd || '/Users/test',
    version: overrides.version || '2.1.63',
    slug: overrides.slug,
    isSidechain: overrides.isSidechain,
    message: overrides.message,
    permissionMode: overrides.permissionMode
  }
}

// 写一个临时 JSONL 文件（测试 parseSessionFile 用）
function writeTempJsonl(messages: RawJsonlMessage[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-test-'))
  const fp = path.join(dir, 'test-session-id.jsonl')
  const content = messages.map((m) => JSON.stringify(m)).join('\n')
  fs.writeFileSync(fp, content)
  return fp
}

function writeJsonlAt(filePath: string, messages: RawJsonlMessage[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'))
  return filePath
}

function writeObjectJsonl(fileName: string, rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-backup-test-'))
  const fp = path.join(dir, fileName)
  fs.writeFileSync(fp, rows.map((row) => JSON.stringify(row)).join('\n'))
  return fp
}

function codexBackupRows(sessionId: string): unknown[] {
  return [
    {
      timestamp: '2026-07-07T00:00:00Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-07-07T00:00:00Z',
        cwd: '/Users/test/projects/codex-app',
        cli_version: 'codex-test'
      }
    },
    {
      timestamp: '2026-07-07T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '从 Codex backup 建 summary' }]
      }
    },
    {
      timestamp: '2026-07-07T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex backup summary 已恢复。' }]
      }
    }
  ]
}

function cursorBackupRows(prompt = '从 Cursor backup 建 detail'): unknown[] {
  return [
    { role: 'user', message: { content: `<user_query>${prompt}</user_query>` } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Cursor backup 已恢复。' }] } }
  ]
}

function sharedCrossSessionPrefix(sessionId: string): RawJsonlMessage[] {
  return [
    rawMsg({ uuid: 'shared-u1', sessionId, parentUuid: null, type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: '共享开始' } }),
    rawMsg({ uuid: 'shared-a1', sessionId, parentUuid: 'shared-u1', type: 'assistant', timestamp: '2026-06-10T10:01:00Z', message: { role: 'assistant', content: '收到' } }),
    rawMsg({ uuid: 'shared-u2', sessionId, parentUuid: 'shared-a1', type: 'user', timestamp: '2026-06-10T10:02:00Z', message: { role: 'user', content: '继续共享上下文' } }),
    rawMsg({ uuid: 'shared-a2', sessionId, parentUuid: 'shared-u2', type: 'assistant', timestamp: '2026-06-10T10:03:00Z', message: { role: 'assistant', content: '继续' } })
  ]
}

async function loadAllSessionsFromTempHome(home: string) {
  const oldHome = process.env.HOME
  process.env.HOME = home
  vi.resetModules()
  try {
    const mod = await import('./session-loader')
    return await mod.loadAllSessions()
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    vi.resetModules()
  }
}

// ========================================================
// Claude session discovery 测试
// ========================================================
describe('Claude session discovery', () => {
  it('应该同时扫描 ~/.claude/projects 和 ~/.claude-window/*/projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-home-'))
    const standardRoot = path.join(home, '.claude', 'projects')
    const windowRoot = path.join(home, '.claude-window', 'aec2c37b389f', 'projects')
    const standardFile = writeJsonlAt(
      path.join(standardRoot, '-Users-test-projects-swob', 'standard-session.jsonl'),
      [rawMsg({ type: 'user', sessionId: 'standard-session', message: { role: 'user', content: '标准 Claude session' } })]
    )
    const windowFile = writeJsonlAt(
      path.join(windowRoot, '-Users-test-projects-draftbox', 'window-session.jsonl'),
      [rawMsg({ type: 'user', sessionId: 'window-session', message: { role: 'user', content: 'Claude Window session' } })]
    )
    const subagentFile = writeJsonlAt(
      path.join(windowRoot, '-Users-test-projects-draftbox', 'subagents', 'agent-session.jsonl'),
      [rawMsg({ type: 'user', sessionId: 'subagent-session', message: { role: 'user', content: 'subagent' } })]
    )

    const roots = findClaudeProjectRoots(home)
    expect(roots).toContain(standardRoot)
    expect(roots).toContain(windowRoot)

    const files = findSessionFilesInProjectRoots(roots)
    expect(files).toContain(standardFile)
    expect(files).toContain(windowFile)
    expect(files).not.toContain(subagentFile)
  })

  it('Claude Window session 应该记录对应的 CLAUDE_CONFIG_DIR', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-home-'))
    const configDir = path.join(home, '.claude-window', 'aec2c37b389f')
    const sessionFile = writeJsonlAt(
      path.join(configDir, 'projects', '-Users-test-projects-draftbox', 'window-session.jsonl'),
      [
        rawMsg({
          type: 'user',
          sessionId: 'window-session',
          cwd: '/Users/test/projects/draftbox',
          message: { role: 'user', content: 'DraftBox 开发 session' }
        })
      ]
    )
    const standardFile = path.join(home, '.claude', 'projects', '-Users-test-projects-swob', 'standard-session.jsonl')

    expect(getClaudeConfigDirForSessionFile(sessionFile, home)).toBe(configDir)
    expect(getClaudeConfigDirForSessionFile(standardFile, home)).toBeUndefined()

    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const summary = buildSessionSummary(sessionFile, [
        rawMsg({
          type: 'user',
          sessionId: 'window-session',
          cwd: '/Users/test/projects/draftbox',
          message: { role: 'user', content: 'DraftBox 开发 session' }
        })
      ], true)
      expect(summary?.claudeConfigDir).toBe(configDir)
      expect(summary?.resumeCwd).toBe('/Users/test/projects/draftbox')
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
    }
  })
})

// ========================================================
// buildSessionSummary 测试
// ========================================================
describe('buildSessionSummary', () => {
  it('基本解析：提取 sessionId、时间、轮次', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '你好！' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    expect(summary!.sessionId).toBe('test-session-id')
    expect(summary!.turnCount).toBe(1)
    expect(summary!.messageCount).toBe(2)
    expect(summary!.createdAt).toBe('2026-03-01T10:00:00Z')
    expect(summary!.firstUserMessage).toBe('你好')
  })

  it('【真实 bug】firstUserMessage 应该跳过 "[Request interrupted..."', () => {
    // 之前这种消息会作为 session 标题显示，用户看到一堆 "[Request interrupted..."
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool_use]' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '...' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '帮我写一个排序函数' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('帮我写一个排序函数')
  })

  it('firstUserMessage 应该跳过 compact 续写开头', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '继续帮我改那个 bug' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '改好了' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('继续帮我改那个 bug')
  })

  it('firstUserMessage 应该跳过 local-command 和命令输出', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: generated while running local commands</local-command-caveat>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '现在文件夹里有大量的单轮会话' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '开始处理' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('现在文件夹里有大量的单轮会话')
    expect(summary!.turnCount).toBe(1)
  })

  it('compact 次数统计', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '第一轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
      rawMsg({ type: 'system', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '第二轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
      rawMsg({ type: 'system', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '第三轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.compactCount).toBe(2)
  })

  it('工具调用统计', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '读一下文件' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看' },
            { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Read', id: 't2', input: { file_path: '/b.ts' } },
            { type: 'tool_use', name: 'Bash', id: 't3', input: { command: 'ls' } }
          ]
        }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.toolUsage['Read']).toBe(2)
    expect(summary!.toolUsage['Bash']).toBe(1)
  })

  it('subagent 文件路径应该返回 null', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } })
    ]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-test-'))
    const subDir = path.join(dir, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const fp = path.join(subDir, 'agent-abc.jsonl')
    fs.writeFileSync(fp, msgs.map((m) => JSON.stringify(m)).join('\n'))

    const summary = buildSessionSummary(fp, msgs)
    expect(summary).toBeNull()
  })

  it('空消息列表应该返回 null', () => {
    const fp = writeTempJsonl([])
    const summary = buildSessionSummary(fp, [])
    expect(summary).toBeNull()
  })

  it('多个 cwd 都应该被收集', () => {
    const msgs = [
      rawMsg({ type: 'user', cwd: '/Users/test/project-a', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', cwd: '/Users/test/project-a', message: { role: 'assistant', content: '好' } }),
      rawMsg({ type: 'user', cwd: '/Users/test/project-b', message: { role: 'user', content: '切目录了' } }),
      rawMsg({ type: 'assistant', cwd: '/Users/test/project-b', message: { role: 'assistant', content: '好' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.cwds).toContain('/Users/test/project-a')
    expect(summary!.cwds).toContain('/Users/test/project-b')
  })

  it('resume 应该使用会话最初创建时的 cwd，而不是后来 cd 进去的目录', () => {
    const msgs = [
      rawMsg({
        type: 'user',
        cwd: '/Users/test/project-a',
        permissionMode: 'bypassPermissions',
        version: '2.1.71',
        message: { role: 'user', content: '第一轮' }
      }),
      rawMsg({
        type: 'assistant',
        cwd: '/Users/test/project-a',
        permissionMode: 'bypassPermissions',
        version: '2.1.71',
        message: { role: 'assistant', content: '收到' }
      }),
      rawMsg({
        type: 'user',
        cwd: '/Users/test/project-b',
        permissionMode: 'default',
        version: '2.1.85',
        message: { role: 'user', content: '后来切到另一个目录继续' }
      }),
      rawMsg({
        type: 'assistant',
        cwd: '/Users/test/project-b',
        permissionMode: 'default',
        version: '2.1.85',
        message: { role: 'assistant', content: '继续完成' }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.cwds).toEqual(['/Users/test/project-a', '/Users/test/project-b'])
    expect(summary!.resumeCwd).toBe('/Users/test/project-a')
    expect(summary!.permissionMode).toBe('default')
    expect(summary!.version).toBe('2.1.85')
  })

  it('content 是数组格式（含图片等）也能正确提取文本', () => {
    const msgs = [
      rawMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image', source: { type: 'base64', data: '...' } }
          ] as any
        }
      }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '我看到了' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('看看这张图')
  })
})

describe('buildSessionSummaryFromBackup', () => {
  it('【曾经的 bug】codex backup.jsonl 无本机源时应该建出非 null summary', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const fp = writeObjectJsonl('backup.jsonl', codexBackupRows(sessionId))

    const summary = await buildSessionSummaryFromBackup(fp, sessionId, {
      sourceFilePaths: ['/missing/unknown-source.jsonl']
    })

    expect(summary).not.toBeNull()
    expect(summary!.source).toBe('codex')
    expect(summary!.id).toBe(`codex:${sessionId}`)
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.firstUserMessage).toBe('从 Codex backup 建 summary')
  })

  it('【曾经的 bug】claude backup.jsonl 仍然走 Claude parser', async () => {
    const sessionId = 'claude-backup-123'
    const fp = writeObjectJsonl('backup.jsonl', [
      rawMsg({
        type: 'user',
        sessionId,
        timestamp: '2026-07-07T00:00:00Z',
        message: { role: 'user', content: 'Claude backup 不能回归' }
      }),
      rawMsg({
        type: 'assistant',
        sessionId,
        timestamp: '2026-07-07T00:00:01Z',
        message: { role: 'assistant', content: '收到' }
      })
    ])

    const summary = await buildSessionSummaryFromBackup(fp, sessionId, {
      sourceFilePaths: ['/missing/unknown-source.jsonl']
    })

    expect(summary).not.toBeNull()
    expect(summary!.source).toBe('claude-code')
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.firstUserMessage).toBe('Claude backup 不能回归')
  })

  it('backup source path 与内容冲突时 summary 优先使用 backup 内容来源', async () => {
    const sessionId = 'cursor-backup-conflict'
    const fp = writeObjectJsonl('backup.jsonl', cursorBackupRows('Cursor 内容优先'))

    const summary = await buildSessionSummaryFromBackup(fp, sessionId, {
      sourceFilePaths: [
        '/Users/test/.codex/sessions/2026/07/07/rollout-2026-07-07T00-00-00-00000000-0000-4000-8000-000000000000.jsonl'
      ]
    })

    expect(summary).not.toBeNull()
    expect(summary!.source).toBe('cursor')
    expect(summary!.id).toBe(`cursor:${sessionId}`)
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.firstUserMessage).toBe('Cursor 内容优先')
  })
})

describe('loadSessionDetail source-aware backup', () => {
  it('【曾经的 bug】loadSessionDetail 喂 codex backup.jsonl 应返回非 null detail', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const fp = writeObjectJsonl('backup.jsonl', codexBackupRows(sessionId))

    const detail = await loadSessionDetail(fp)

    expect(detail).not.toBeNull()
    expect(detail!.source).toBe('codex')
    expect(detail!.sessionId).toBe(sessionId)
    expect(detail!.messages.length).toBeGreaterThan(0)
  })

  it('cursor backup.jsonl 缺 .swob-session.json 时不使用父目录名生成错误 id', async () => {
    const fp = writeObjectJsonl('backup.jsonl', cursorBackupRows())

    const detail = await loadSessionDetail(fp)

    expect(detail).toBeNull()
  })

  it('cursor backup.jsonl 的 .swob-session.json 缺 sessionId 时不使用父目录名生成错误 id', async () => {
    const fp = writeObjectJsonl('backup.jsonl', cursorBackupRows())
    fs.writeFileSync(path.join(path.dirname(fp), '.swob-session.json'), JSON.stringify({ sourceFilePaths: [] }))

    const detail = await loadSessionDetail(fp)

    expect(detail).toBeNull()
  })

  it('cursor 正常源目录 detail 仍然使用父目录名作为 sessionId', async () => {
    const sessionId = 'cursor-normal-session'
    const fp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cursor-normal-')),
      '.cursor',
      'projects',
      '-Users-test-project',
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`
    )
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, cursorBackupRows('Cursor 正常源目录').map((row) => JSON.stringify(row)).join('\n'))

    const detail = await loadSessionDetail(fp)

    expect(detail).not.toBeNull()
    expect(detail!.source).toBe('cursor')
    expect(detail!.sessionId).toBe(sessionId)
    expect(detail!.id).toBe(`cursor:${sessionId}`)
  })
})

// ========================================================
// buildSessionDetail 测试
// ========================================================
describe('buildSessionDetail', () => {
  it('【真实 bug】task-notification 应该被标记为特殊 subtype', () => {
    // 这个 bug 导致 <task-notification> 显示为用户消息
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '帮我做个功能' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<task-notification>Task 1 completed</task-notification>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '继续' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '继续做' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    // 第三条消息（task-notification）应该有特殊 subtype
    const taskNotif = detail!.messages.find((m) => m.subtype === 'task-notification')
    expect(taskNotif).toBeDefined()
    expect(taskNotif!.textContent).toContain('task-notification')
  })

  it('tool_result 应该被关联到对应的 tool_use', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '读文件' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看' },
            { type: 'tool_use', name: 'Read', id: 'tool-123', input: { file_path: '/tmp/test.ts' } }
          ]
        }
      }),
      rawMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-123', content: '文件内容在这里...' }
          ]
        }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const assistantMsg = detail!.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg!.toolCalls[0].result).toBe('文件内容在这里...')
  })

  it('isPreCompact 标记：compact 之前的消息应该标为 true', () => {
    const msgs = [
      rawMsg({ type: 'user', uuid: 'u1', message: { role: 'user', content: '旧消息' } }),
      rawMsg({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '旧回复' } }),
      rawMsg({ type: 'system', uuid: 's1', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', uuid: 'u2', message: { role: 'user', content: '新消息' } }),
      rawMsg({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: '新回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const oldMsg = detail!.messages.find((m) => m.uuid === 'u1')
    const newMsg = detail!.messages.find((m) => m.uuid === 'u2')
    expect(oldMsg!.isPreCompact).toBe(true)
    expect(newMsg!.isPreCompact).toBe(false)
  })

  it('sidechain 消息应该标记 isSidechain', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: '这是被拒绝的回复' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '这是最终回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const sidechain = detail!.messages.filter((m) => m.isSidechain)
    expect(sidechain).toHaveLength(1)
    expect(sidechain[0].textContent).toBe('这是被拒绝的回复')
  })

  it('loadSessionDetail 应该把 compact continuation shard 拼回父会话并去重', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-continuation-'))
    const parentFile = path.join(tmp, 'parent.jsonl')
    const childFile = path.join(tmp, 'child.jsonl')
    const repeatedPrompt = '这是现在侧边栏的滚动截图。所有 session 都显示在未分组。'

    const parentMsgs = [
      rawMsg({ uuid: 'u1', sessionId: 'parent-session', type: 'user', timestamp: '2026-06-14T10:00:00Z', message: { role: 'user', content: '开始' } }),
      rawMsg({ uuid: 'a1', sessionId: 'parent-session', type: 'assistant', parentUuid: 'u1', timestamp: '2026-06-14T10:01:00Z', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ uuid: 'cb', sessionId: 'parent-session', type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: 'a1', timestamp: '2026-06-14T10:02:00Z', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ uuid: 'sum', sessionId: 'parent-session', type: 'user', parentUuid: 'cb', timestamp: '2026-06-14T10:02:00Z', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ uuid: 'copied-a', sessionId: 'parent-session', type: 'assistant', parentUuid: 'sum', timestamp: '2026-06-14T10:03:00Z', message: { role: 'assistant', content: 'compact 后的共享回复' } }),
      rawMsg({ uuid: 'pending-parent', sessionId: 'parent-session', type: 'user', parentUuid: 'copied-a', timestamp: '2026-06-14T10:10:00Z', message: { role: 'user', content: repeatedPrompt } })
    ]
    const childMsgs = [
      rawMsg({ uuid: 'cb', sessionId: 'child-session', type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: 'a1', timestamp: '2026-06-14T10:02:00Z', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ uuid: 'sum', sessionId: 'child-session', type: 'user', parentUuid: 'cb', timestamp: '2026-06-14T10:02:00Z', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ uuid: 'copied-a', sessionId: 'child-session', type: 'assistant', parentUuid: 'sum', timestamp: '2026-06-14T10:03:00Z', message: { role: 'assistant', content: 'compact 后的共享回复' } }),
      rawMsg({ uuid: 'pending-child', sessionId: 'child-session', type: 'user', parentUuid: 'copied-a', timestamp: '2026-06-14T10:10:40Z', message: { role: 'user', content: repeatedPrompt } }),
      rawMsg({ uuid: 'child-answer', sessionId: 'child-session', type: 'assistant', parentUuid: 'pending-child', timestamp: '2026-06-14T10:11:00Z', message: { role: 'assistant', content: '这是子 continuation 的新回答' } })
    ]

    writeJsonlAt(parentFile, parentMsgs)
    writeJsonlAt(childFile, childMsgs)

    const detail = await loadSessionDetail(parentFile, [parentFile, childFile])

    expect(detail).not.toBeNull()
    expect(detail!.sessionId).toBe('parent-session')
    expect(detail!.messages.filter((m) => m.uuid === 'cb')).toHaveLength(1)
    expect(detail!.messages.filter((m) => m.type === 'user' && m.textContent === repeatedPrompt)).toHaveLength(1)
    expect(detail!.messages.some((m) => m.uuid === 'child-answer' && m.textContent === '这是子 continuation 的新回答')).toBe(true)
  })
})

// ========================================================
// cross-session branch inference 测试
// ========================================================
describe('cross-session branch inference', () => {
  it('同一条用户 prompt 被不同 sessionId 重放且一边只是继续追加时，不应该判为 branch', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-branch-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const repeatedPrompt = '晚上，看电视剧，妈突然来了一句：宝宝，妈妈觉得那个人是骗子。'

    const longSession = [
      ...sharedCrossSessionPrefix('diary-long'),
      rawMsg({ uuid: 'long-repeat-user', sessionId: 'diary-long', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-13T13:11:21Z', message: { role: 'user', content: repeatedPrompt } }),
      rawMsg({ uuid: 'long-repeat-answer', sessionId: 'diary-long', parentUuid: 'long-repeat-user', type: 'assistant', timestamp: '2026-06-13T13:12:04Z', message: { role: 'assistant', content: '对同一条 prompt 的另一版回答' } }),
      rawMsg({ uuid: 'long-extra-user', sessionId: 'diary-long', parentUuid: 'long-repeat-answer', type: 'user', timestamp: '2026-06-14T02:24:58Z', message: { role: 'user', content: '2026.6.14sun 今日Todo' } }),
      rawMsg({ uuid: 'long-extra-answer', sessionId: 'diary-long', parentUuid: 'long-extra-user', type: 'assistant', timestamp: '2026-06-14T02:25:32Z', message: { role: 'assistant', content: '继续处理今日 Todo' } })
    ]
    const shortSession = [
      ...sharedCrossSessionPrefix('diary-short'),
      rawMsg({ uuid: 'short-repeat-user', sessionId: 'diary-short', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-13T13:07:37Z', message: { role: 'user', content: repeatedPrompt } }),
      rawMsg({ uuid: 'short-repeat-answer', sessionId: 'diary-short', parentUuid: 'short-repeat-user', type: 'assistant', timestamp: '2026-06-13T13:09:54Z', message: { role: 'assistant', content: '对同一条 prompt 的一版回答' } })
    ]

    writeJsonlAt(path.join(projectDir, 'diary-long.jsonl'), longSession)
    writeJsonlAt(path.join(projectDir, 'diary-short.jsonl'), shortSession)

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      const long = sessions.find((s) => s.sessionId === 'diary-long')
      const short = sessions.find((s) => s.sessionId === 'diary-short')

      expect(long).toBeDefined()
      expect(short).toBeDefined()
      expect(long!.branchParentId).toBeUndefined()
      expect(short!.branchParentId).toBeUndefined()
      expect(long!.branchChildIds || []).not.toContain(short!.id)
      expect(short!.branchChildIds || []).not.toContain(long!.id)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('共享前缀后双方都有不同用户意图时，仍然应该判为单向 branch', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-branch-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')

    const parentSession = [
      ...sharedCrossSessionPrefix('branch-a'),
      rawMsg({ uuid: 'branch-a-user', sessionId: 'branch-a', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-10T10:10:00Z', message: { role: 'user', content: '走 A 方案' } }),
      rawMsg({ uuid: 'branch-a-answer', sessionId: 'branch-a', parentUuid: 'branch-a-user', type: 'assistant', timestamp: '2026-06-10T10:11:00Z', message: { role: 'assistant', content: 'A 方案回复' } })
    ]
    const childSession = [
      ...sharedCrossSessionPrefix('branch-b'),
      rawMsg({ uuid: 'branch-b-user', sessionId: 'branch-b', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-10T10:12:00Z', message: { role: 'user', content: '走 B 方案' } }),
      rawMsg({ uuid: 'branch-b-answer', sessionId: 'branch-b', parentUuid: 'branch-b-user', type: 'assistant', timestamp: '2026-06-10T10:13:00Z', message: { role: 'assistant', content: 'B 方案回复' } })
    ]

    writeJsonlAt(path.join(projectDir, 'branch-a.jsonl'), parentSession)
    writeJsonlAt(path.join(projectDir, 'branch-b.jsonl'), childSession)

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      const parent = sessions.find((s) => s.sessionId === 'branch-a')
      const child = sessions.find((s) => s.sessionId === 'branch-b')

      expect(parent).toBeDefined()
      expect(child).toBeDefined()
      expect(parent!.branchParentId).toBeUndefined()
      expect(parent!.branchChildIds).toContain(child!.id)
      expect(child!.branchParentId).toBe(parent!.id)
      expect(child!.branchChildIds || []).not.toContain(parent!.id)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('真实 fork 文件用 basename child id 独立显示并 resume child session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-fork-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const parentId = '11111111-1111-4111-8111-111111111111'
    const childId = '22222222-2222-4222-8222-222222222222'
    const parentFile = path.join(projectDir, `${parentId}.jsonl`)
    const childFile = path.join(projectDir, `${childId}.jsonl`)

    const shared = [
      rawMsg({ uuid: 'shared-u', sessionId: parentId, parentUuid: null, type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: '共享上下文' } }),
      rawMsg({ uuid: 'shared-a', sessionId: parentId, parentUuid: 'shared-u', type: 'assistant', timestamp: '2026-06-10T10:01:00Z', message: { role: 'assistant', content: '共享回复' } }),
      rawMsg({ uuid: 'shared-u2', sessionId: parentId, parentUuid: 'shared-a', type: 'user', timestamp: '2026-06-10T10:01:30Z', message: { role: 'user', content: '继续共享' } })
    ]
    const parentMsgs = [
      ...shared,
      rawMsg({ uuid: 'parent-u', sessionId: parentId, parentUuid: 'shared-u2', type: 'user', timestamp: '2026-06-10T10:02:00Z', message: { role: 'user', content: '父会话继续' } }),
      rawMsg({ uuid: 'parent-a', sessionId: parentId, parentUuid: 'parent-u', type: 'assistant', timestamp: '2026-06-10T10:03:00Z', message: { role: 'assistant', content: '父会话回答' } })
    ]
    const childMsgs = [
      ...shared,
      rawMsg({ uuid: 'child-u', sessionId: childId, parentUuid: 'shared-u2', type: 'user', timestamp: '2026-06-10T10:04:00Z', message: { role: 'user', content: 'fork child 的新问题' } }),
      rawMsg({ uuid: 'child-a', sessionId: childId, parentUuid: 'child-u', type: 'assistant', timestamp: '2026-06-10T10:05:00Z', message: { role: 'assistant', content: 'fork child 的回答' } })
    ]

    writeJsonlAt(parentFile, parentMsgs)
    writeJsonlAt(childFile, childMsgs)

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      const parent = sessions.find((s) => s.sessionId === parentId)
      const child = sessions.find((s) => s.sessionId === childId)

      expect(parent).toBeDefined()
      expect(child).toBeDefined()
      expect(child!.id).toBe(childId)
      expect(child!.filePath).toBe(childFile)
      expect(child!.branchParentId).toBe(parent!.id)
      expect(parent!.branchChildIds).toContain(child!.id)

      const detail = await loadSessionDetail(
        child!.filePath,
        child!.allFilePaths,
        child!.branchParentFilePaths,
        child!.branchPointUuid,
        child!.branchLeafUuid
      )
      expect(detail).not.toBeNull()
      expect(detail!.sessionId).toBe(childId)
      expect(detail!.messages.filter((m) => m.uuid === 'shared-a')).toHaveLength(1)
      expect(detail!.messages.some((m) => m.uuid === 'parent-u')).toBe(false)
      expect(detail!.messages.some((m) => m.uuid === 'child-u')).toBe(true)

      const context = await resolveSessionActionContext(childId, sessions)
      expect(context.sessionId).toBe(childId)
      expect(buildResumeCommand(context.sessionId, context.permissionMode, undefined, context.source))
        .toBe(`claude --resume ${shellQuote(childId)}`)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// ========================================================
// detectIntraFileBranches 测试
// ========================================================

/**
 * 构造一个有真实分支的消息树：两个终端同时 resume 同一 session，
 * 消息时间交错（M↔B 切换 >= 3 次）。
 *
 * 树结构：
 *   shared1 → shared2 → shared3 (fork point)
 *                           ├→ main1 → main2 → main3 (主路径，更长)
 *                           └→ branch1 → branch2     (分支)
 * 时间交错：main1, branch1, main2, branch2, main3
 */
function buildBranchTree() {
  const shared1 = rawMsg({ uuid: 's1', parentUuid: null, type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '开始对话' } })
  const shared2 = rawMsg({ uuid: 's2', parentUuid: 's1', type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })
  const shared3 = rawMsg({ uuid: 's3', parentUuid: 's2', type: 'user', timestamp: '2026-03-01T10:02:00Z', message: { role: 'user', content: '继续' } })

  // Main path (longer)
  const main1 = rawMsg({ uuid: 'm1', parentUuid: 's3', type: 'assistant', timestamp: '2026-03-01T10:03:00Z', message: { role: 'assistant', content: '主路径回复1' } })
  const main2 = rawMsg({ uuid: 'm2', parentUuid: 'm1', type: 'user', timestamp: '2026-03-01T10:05:00Z', message: { role: 'user', content: '主路径问题2' } })
  const main3 = rawMsg({ uuid: 'm3', parentUuid: 'm2', type: 'assistant', timestamp: '2026-03-01T10:07:00Z', message: { role: 'assistant', content: '主路径回复2' } })

  // Branch path (shorter, timestamps interleave with main)
  const branch1 = rawMsg({ uuid: 'b1', parentUuid: 's3', type: 'assistant', timestamp: '2026-03-01T10:04:00Z', message: { role: 'assistant', content: '分支回复1' } })
  const branch2 = rawMsg({ uuid: 'b2', parentUuid: 'b1', type: 'user', timestamp: '2026-03-01T10:06:00Z', message: { role: 'user', content: '分支问题2' } })

  return [shared1, shared2, shared3, main1, main2, main3, branch1, branch2]
}

describe('【曾经的 bug】分支检测不能被 traceToRoot 的改动破坏', () => {
  it('能检测到时间交错的真实分支', () => {
    const msgs = buildBranchTree()
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
    expect(branches[0].firstUserMessage).toBe('分支问题2')
  })

  it('分支的 turnCount 包含共享上下文的轮数', () => {
    const msgs = buildBranchTree()
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
    // 共享上下文: 1轮 (s1→s2) + 分支独有: 1轮 (b1→b2 中 user=b2) = 至少 > 0
    // 完整路径: s1, s2, s3, b1, b2 → user: s1, s3, b2 (3) / assistant: s2, b1 (2) → min(3,2) = 2
    expect(branches[0].turnCount).toBeGreaterThanOrEqual(2)
  })

  it('有 compact 边界时分支仍能被检测到', () => {
    // compact_boundary 的 parentUuid=null 不应该影响分支检测
    const compact = rawMsg({
      uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary',
      timestamp: '2026-03-01T09:00:00Z'
    })
    compact.logicalParentUuid = 'pre-compact-msg'

    const preCompact = rawMsg({ uuid: 'pre-compact-msg', parentUuid: null, type: 'user', timestamp: '2026-03-01T08:00:00Z', message: { role: 'user', content: '远古消息' } })
    const afterCompact = rawMsg({ uuid: 'ac1', parentUuid: 'cb', type: 'user', timestamp: '2026-03-01T09:01:00Z', message: { role: 'user', content: 'compact 后的对话' } })

    // Fork after compact
    const main1 = rawMsg({ uuid: 'pm1', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:02:00Z', message: { role: 'assistant', content: '主1' } })
    const main2 = rawMsg({ uuid: 'pm2', parentUuid: 'pm1', type: 'user', timestamp: '2026-03-01T09:04:00Z', message: { role: 'user', content: '主2' } })
    const main3 = rawMsg({ uuid: 'pm3', parentUuid: 'pm2', type: 'assistant', timestamp: '2026-03-01T09:06:00Z', message: { role: 'assistant', content: '主3' } })

    const branch1 = rawMsg({ uuid: 'pb1', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:03:00Z', message: { role: 'assistant', content: '支1' } })
    const branch2 = rawMsg({ uuid: 'pb2', parentUuid: 'pb1', type: 'user', timestamp: '2026-03-01T09:05:00Z', message: { role: 'user', content: '支2' } })

    const msgs = [preCompact, compact, afterCompact, main1, main2, main3, branch1, branch2]
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
  })

  it('两边都 compact 后仍能检测到分支', () => {
    // 场景：fork 后两个终端各自聊了很久，各自触发了 compact
    // traceToRoot 需要穿越各自的 compact_boundary 才能找到共享前缀
    const shared1 = rawMsg({ uuid: 'sh1', parentUuid: null, type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '开始对话' } })
    const shared2 = rawMsg({ uuid: 'sh2', parentUuid: 'sh1', type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })

    // Main path: fork → lots of messages → compact → continue
    const mainPre = rawMsg({ uuid: 'mp1', parentUuid: 'sh2', type: 'user', timestamp: '2026-03-01T10:02:00Z', message: { role: 'user', content: '主路径开始' } })
    const mainPre2 = rawMsg({ uuid: 'mp2', parentUuid: 'mp1', type: 'assistant', timestamp: '2026-03-01T10:04:00Z', message: { role: 'assistant', content: '主路径回复' } })
    const mainCompact = rawMsg({ uuid: 'mc', parentUuid: null, type: 'system', subtype: 'compact_boundary', timestamp: '2026-03-01T11:00:00Z' })
    mainCompact.logicalParentUuid = 'mp2'
    const mainPost1 = rawMsg({ uuid: 'mq1', parentUuid: 'mc', type: 'user', timestamp: '2026-03-01T11:01:00Z', message: { role: 'user', content: '主路径继续' } })
    const mainPost2 = rawMsg({ uuid: 'mq2', parentUuid: 'mq1', type: 'assistant', timestamp: '2026-03-01T11:02:00Z', message: { role: 'assistant', content: '主路径继续回复' } })

    // Branch path: fork → lots of messages → compact → continue (timestamps interleave with main)
    const brPre = rawMsg({ uuid: 'bp1', parentUuid: 'sh2', type: 'user', timestamp: '2026-03-01T10:03:00Z', message: { role: 'user', content: '分支路径开始' } })
    const brPre2 = rawMsg({ uuid: 'bp2', parentUuid: 'bp1', type: 'assistant', timestamp: '2026-03-01T10:05:00Z', message: { role: 'assistant', content: '分支回复' } })
    const brCompact = rawMsg({ uuid: 'bc', parentUuid: null, type: 'system', subtype: 'compact_boundary', timestamp: '2026-03-01T11:05:00Z' })
    brCompact.logicalParentUuid = 'bp2'
    const brPost1 = rawMsg({ uuid: 'bq1', parentUuid: 'bc', type: 'user', timestamp: '2026-03-01T11:06:00Z', message: { role: 'user', content: '分支继续' } })

    const msgs = [shared1, shared2, mainPre, mainPre2, mainCompact, mainPost1, mainPost2, brPre, brPre2, brCompact, brPost1]
    const branches = detectIntraFileBranches(msgs)

    // 关键：即使两边都 compact 了，分支也必须被检测到
    expect(branches.length).toBeGreaterThanOrEqual(1)
  })
})

describe('filterMessagesByBranch 穿越 compact 边界', () => {
  it('分支过滤结果包含 compact 之前的消息', () => {
    const preCompact = rawMsg({ uuid: 'old1', parentUuid: null, type: 'user', timestamp: '2026-03-01T08:00:00Z', message: { role: 'user', content: '远古消息' } })
    const preCompact2 = rawMsg({ uuid: 'old2', parentUuid: 'old1', type: 'assistant', timestamp: '2026-03-01T08:01:00Z', message: { role: 'assistant', content: '远古回复' } })
    const compact = rawMsg({
      uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary',
      timestamp: '2026-03-01T09:00:00Z'
    })
    compact.logicalParentUuid = 'old2'

    const afterCompact = rawMsg({ uuid: 'ac1', parentUuid: 'cb', type: 'user', timestamp: '2026-03-01T09:01:00Z', message: { role: 'user', content: '新消息' } })
    const afterCompact2 = rawMsg({ uuid: 'ac2', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:02:00Z', message: { role: 'assistant', content: '新回复' } })

    const msgs = [preCompact, preCompact2, compact, afterCompact, afterCompact2]
    const filtered = filterMessagesByBranch(msgs, 'ac2')

    // 应该包含 compact 之前和之后的所有消息
    const uuids = filtered.map(m => m.uuid)
    expect(uuids).toContain('old1')
    expect(uuids).toContain('old2')
    expect(uuids).toContain('cb')
    expect(uuids).toContain('ac1')
    expect(uuids).toContain('ac2')
  })
})

// ========================================================
// isRealUserMessage + turnCount 测试
// ========================================================

describe('【曾经的 bug】turnCount 不能把工具结果算成用户轮次', () => {
  it('tool_result 不是真实用户消息', () => {
    const toolResult = rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'file written' }] }
    })
    expect(isRealUserMessage(toolResult)).toBe(false)
  })

  it('【曾经的 bug】tool_result + text 混合也不是真实用户消息（AskUserQuestion 的回答）', () => {
    const mixed = rawMsg({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'abc', content: 'Answer questions?' },
        { type: 'text', text: 'Answer questions?' }
      ] as any }
    })
    expect(isRealUserMessage(mixed)).toBe(false)
  })

  it('纯文本的用户消息是真实的', () => {
    const textMsg = rawMsg({
      type: 'user',
      message: { role: 'user', content: '你好' }
    })
    expect(isRealUserMessage(textMsg)).toBe(true)
  })

  it('task-notification 不是真实用户消息', () => {
    const taskMsg = rawMsg({
      type: 'user',
      message: { role: 'user', content: '<task-notification>task completed</task-notification>' }
    })
    expect(isRealUserMessage(taskMsg)).toBe(false)
  })

  it('local-command caveat 和命令输出不是真实用户消息', () => {
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' }
    }))).toBe(false)
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>' }
    }))).toBe(false)
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' }
    }))).toBe(false)
  })

  it('【曾经的 bug】"Tool loaded." 不是真实用户消息', () => {
    expect(isRealUserMessage(rawMsg({ type: 'user', message: { role: 'user', content: 'Tool loaded.' } }))).toBe(false)
  })

  it('【曾经的 bug】"Continue from where you left off." 不是真实用户消息（字符串格式）', () => {
    expect(isRealUserMessage(rawMsg({ type: 'user', message: { role: 'user', content: 'Continue from where you left off.' } }))).toBe(false)
  })

  it('【曾经的 bug】"Continue from where you left off." 不是真实用户消息（array 格式）', () => {
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] as any }
    }))).toBe(false)
  })

  it('含 text 部分的 array content 是真实用户消息', () => {
    const mixed = rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '请帮我看看' }] as any }
    })
    expect(isRealUserMessage(mixed)).toBe(true)
  })

  it('1 个用户消息 + 8 个 tool_result = turnCount 应该是 1 而不是 9', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'https://example.com' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'WebFetch', input: {} }] as any } }),
      rawMsg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'fetched' }] as any } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '继续' }, { type: 'tool_use', name: 'Write', input: {} }] as any } }),
      rawMsg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'written' }] as any } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:03:00Z', message: { role: 'assistant', content: '完成' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    // 只有 1 个真实用户消息，turnCount 应该是 1
    expect(summary!.turnCount).toBe(1)
  })
})
