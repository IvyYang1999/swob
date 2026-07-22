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
  decodeClaudeProjectDirectoryName,
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
  const message: RawJsonlMessage = {
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
    requestId: overrides.requestId,
    promptSource: overrides.promptSource ?? (overrides.type === 'user' ? 'typed' : undefined),
    message: overrides.message,
    permissionMode: overrides.permissionMode
  }
  if (overrides.forkedFrom !== undefined) message.forkedFrom = overrides.forkedFrom
  if (overrides.origin !== undefined) message.origin = overrides.origin
  if (overrides.isMeta !== undefined) message.isMeta = overrides.isMeta
  if (overrides.sourceToolAssistantUUID !== undefined) {
    message.sourceToolAssistantUUID = overrides.sourceToolAssistantUUID
  }
  if (overrides.toolUseResult !== undefined) message.toolUseResult = overrides.toolUseResult
  return message
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

function codexRoleRows(params: {
  sessionId: string
  userText: string
  inputTokens: number
  outputTokens: number
  turnId: string
  source?: unknown
  parentThreadId?: string
}): unknown[] {
  return [
    {
      timestamp: '2026-07-22T00:00:00Z',
      type: 'session_meta',
      payload: {
        id: params.sessionId,
        timestamp: '2026-07-22T00:00:00Z',
        cwd: '/Users/test/projects/swob',
        cli_version: 'codex-test',
        model_provider: 'openai',
        source: params.source || 'vscode',
        ...(params.parentThreadId
          ? { thread_source: 'subagent', parent_thread_id: params.parentThreadId }
          : {})
      }
    },
    {
      timestamp: '2026-07-22T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: params.userText }]
      }
    },
    {
      timestamp: '2026-07-22T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '完成' }]
      }
    },
    {
      timestamp: '2026-07-22T00:00:02Z',
      type: 'turn_context',
      payload: { turn_id: params.turnId, model: 'gpt-5.4', model_provider: 'openai' }
    },
    {
      timestamp: '2026-07-22T00:00:03Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          turn_id: params.turnId,
          last_token_usage: {
            input_tokens: params.inputTokens,
            output_tokens: params.outputTokens,
            cached_input_tokens: 0
          }
        }
      }
    },
    {
      timestamp: '2026-07-22T00:00:04Z',
      type: 'event_msg',
      payload: { type: 'task_complete' }
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

async function loadAllSessionsFromTempHome(
  home: string,
  options: { readOnly?: boolean; quiet?: boolean } = {}
) {
  const oldHome = process.env.HOME
  process.env.HOME = home
  vi.resetModules()
  try {
    const mod = await import('./session-loader')
    return await mod.loadAllSessions(options)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    vi.resetModules()
  }
}

function incrementalCacheLog(spy: ReturnType<typeof vi.spyOn>): string {
  const call = [...spy.mock.calls].reverse().find(([message]) =>
    typeof message === 'string' && message.includes('[session-loader] incremental cache:')
  )
  return String(call?.[0] || '')
}

// ========================================================
// Claude session discovery 测试
// ========================================================
describe('Claude session discovery', () => {
  it('Claude 项目目录名支持 Windows 盘符 dash 编码', () => {
    expect(decodeClaudeProjectDirectoryName('C--Users-Alice-project', 'win32'))
      .toBe('C:\\Users\\Alice\\project')
    expect(decodeClaudeProjectDirectoryName('-Users-alice-project', 'darwin'))
      .toBe('/Users/alice/project')
    expect(decodeClaudeProjectDirectoryName('relative-project', 'win32')).toBeUndefined()
  })

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

  it('【回归】新增 harness 保留真实 source；未验证格式不得套用 Claude token parser', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-new-sources-home-'))
    const ccRows = [
      rawMsg({ type: 'user', sessionId: 'cc-session', message: { role: 'user', content: 'CC Mirror 真实消息' } }),
      rawMsg({
        type: 'assistant', sessionId: 'cc-session',
        message: { id: 'cc-msg', role: 'assistant', content: '完成', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
      })
    ]
    writeJsonlAt(path.join(home, '.cc-mirror', 'default', 'projects', '-Users-test-cc', 'cc-session.jsonl'), ccRows)
    writeJsonlAt(path.join(home, '.gemini', 'antigravity-cli', 'brain', 'agy-session', 'transcript.jsonl'), [] as RawJsonlMessage[])
    writeJsonlAt(path.join(home, '.grok', 'sessions', 'grok-session.jsonl'), [] as RawJsonlMessage[])
    writeJsonlAt(path.join(home, '.pi', 'agent', 'sessions', 'pi-session.jsonl'), [] as RawJsonlMessage[])
    writeJsonlAt(path.join(home, '.kimi-code', 'sessions', 'kimi-session', 'wire.jsonl'), [] as RawJsonlMessage[])
    const hermesPath = path.join(home, '.hermes', 'sessions', 'hermes-session.json')
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true })
    fs.writeFileSync(hermesPath, '{}')

    const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
    const cc = sessions.find((session) => session.source === 'cc-mirror')
    expect(cc?.firstUserMessage).toBe('CC Mirror 真实消息')
    expect(cc?.tokenAccounting?.billingTotal).toBe(15)

    for (const source of ['antigravity', 'grok', 'pi', 'kimi', 'hermes'] as const) {
      const summary = sessions.find((session) => session.source === source)
      expect(summary, source).toBeDefined()
      expect(summary?.tokenAccounting?.provider, source).toBe(source)
      expect(summary?.tokenAccounting?.provenance, source).toBe('unavailable')
      expect(summary?.tokenAccounting?.billingTotal, source).toBeNull()
    }
    expect(sessions.filter((session) => session.source === 'claude-code')).toHaveLength(0)
  })

  it('【回归】Claude 主文件与 subagent 共用去重表，同时保留 billing/conversation 两种 scope', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-subagent-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-project')
    const mainRows = [
      rawMsg({ type: 'user', sessionId: 'main-session', message: { role: 'user', content: '让 subagent 调研' } }),
      rawMsg({
        type: 'assistant', sessionId: 'main-session', uuid: 'main-call', requestId: 'shared-request',
        message: { id: 'shared-message', role: 'assistant', content: '主线程', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      })
    ]
    const subagentRows = [
      rawMsg({
        type: 'assistant', sessionId: 'main-session', uuid: 'shared-copy', requestId: 'shared-request', isSidechain: true,
        message: { id: 'shared-message', role: 'assistant', content: '重复副本', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      }),
      rawMsg({
        type: 'assistant', sessionId: 'main-session', uuid: 'subagent-call', requestId: 'subagent-request', isSidechain: true,
        message: { id: 'subagent-message', role: 'assistant', content: '子代理独立调用', stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } }
      })
    ]
    writeJsonlAt(path.join(projectDir, 'main-session.jsonl'), mainRows)
    writeJsonlAt(path.join(projectDir, 'subagents', 'agent-research.jsonl'), subagentRows)

    const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
    const summary = sessions.find((session) => session.sessionId === 'main-session')

    expect(summary?.tokenAccounting?.usageEvents).toHaveLength(2)
    expect(summary?.tokenAccounting?.billingTotal).toBe(180)
    expect(summary?.tokenAccounting?.conversationOnly).toBe(120)
    expect(summary?.tokenAccounting?.usageEvents.map((event) => event.scope).sort()).toEqual(['main', 'subagent'])
  })

  it('【回归】同一 provider/session id 的跨文件副本只保留最完整 token 快照', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-cross-file-home-'))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '22')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const codexRows = (inputTokens: number, outputTokens: number, suffix: string) => [
      {
        timestamp: `2026-07-22T00:00:0${suffix}Z`, type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-07-22T00:00:00Z', cwd: '/Users/test/codex', cli_version: 'test' }
      },
      {
        timestamp: `2026-07-22T00:00:1${suffix}Z`, type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跨文件去重' }] }
      },
      {
        timestamp: `2026-07-22T00:00:2${suffix}Z`, type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } } }
      }
    ]
    fs.mkdirSync(codexDir, { recursive: true })
    fs.writeFileSync(path.join(codexDir, 'rollout-copy-a.jsonl'), codexRows(500, 200, '1').map((row) => JSON.stringify(row)).join('\n'))
    fs.writeFileSync(path.join(codexDir, 'rollout-copy-b.jsonl'), codexRows(650, 250, '2').map((row) => JSON.stringify(row)).join('\n'))

    const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
    const codexSessions = sessions.filter((session) => session.source === 'codex')

    expect(codexSessions).toHaveLength(1)
    expect(codexSessions[0].tokenAccounting?.billingTotal).toBe(900)
    expect(codexSessions[0].allFilePaths).toHaveLength(2)
    expect(codexSessions[0].tokenAccounting?.warnings.join(' ')).toContain('deduplicated 2 files')
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

  it('Windows 绝对路径的写入动作不能被丢弃', () => {
    const windowsFile = 'C:\\Users\\Alice\\project\\src\\main.ts'
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '修改 Windows 项目' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'write-win-file', name: 'Write', input: { file_path: windowsFile } }]
        }
      })
    ]
    const summary = buildSessionSummary(writeTempJsonl(msgs), msgs)

    expect(summary?.referencedFiles).toContainEqual({
      path: windowsFile,
      actions: ['write'],
      exists: false
    })
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

  it('【回归】Claude streaming 快照与 fork 继承 usage 不得重复计入 summary', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '统计 token' } }),
      rawMsg({
        type: 'assistant', uuid: 'snap-1', requestId: 'req-1',
        message: { id: 'msg-1', role: 'assistant', content: 'partial', stop_reason: null, usage: { input_tokens: 100, output_tokens: 10 } }
      }),
      rawMsg({
        type: 'assistant', uuid: 'snap-2', requestId: 'req-1',
        message: { id: 'msg-1', role: 'assistant', content: 'done', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      }),
      rawMsg({
        type: 'assistant', uuid: 'fork-copy',
        forkedFrom: { sessionId: 'parent', messageUuid: 'parent-message' },
        message: { id: 'forked', role: 'assistant', content: 'inherited', stop_reason: 'end_turn', usage: { input_tokens: 5_000, output_tokens: 5_000 } }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)!

    expect(summary.tokenAccounting?.billingTotal).toBe(120)
    expect(summary.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 })
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
    expect(taskNotif!.origin).toBe('task-notification')
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
describe('loadAllSessions per-file incremental cache', () => {
  it('readOnly 模式读取会话但不创建 summary cache', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-readonly-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'readonly.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'readonly-session',
        type: 'user',
        message: { role: 'user', content: '只读审计' }
      })
    ])

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })

      expect(sessions.some((session) => session.sessionId === 'readonly-session')).toBe(true)
      expect(fs.existsSync(path.join(home, '.claude-session-manager', 'summary-cache.json'))).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('只重建变化文件，并使热启动 summaries/血统与删缓存全量重建一致', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cache-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const firstFile = path.join(projectDir, 'cache-a.jsonl')
    const secondFile = path.join(projectDir, 'cache-b.jsonl')
    const firstMessages = [
      rawMsg({ uuid: 'cache-a-u', sessionId: 'cache-a', type: 'user', message: { role: 'user', content: '缓存会话 A' } }),
      rawMsg({ uuid: 'cache-a-a', sessionId: 'cache-a', parentUuid: 'cache-a-u', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: 'A 回复' } })
    ]
    const secondMessages = [
      rawMsg({ uuid: 'cache-b-u', sessionId: 'cache-b', type: 'user', message: { role: 'user', content: '缓存会话 B' } }),
      rawMsg({ uuid: 'cache-b-a', sessionId: 'cache-b', parentUuid: 'cache-b-u', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: 'B 回复' } })
    ]
    writeJsonlAt(firstFile, firstMessages)
    writeJsonlAt(secondFile, secondMessages)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 2, reused 0, files 2')

      const cachePath = path.join(home, '.claude-session-manager', 'summary-cache.json')
      const diskCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
      expect(diskCache.version).toBe(24)
      expect(Object.keys(diskCache.entries).sort()).toEqual([firstFile, secondFile].sort())
      expect(diskCache.entries[firstFile]).toMatchObject({
        sig: expect.any(String),
        perFile: {
          summary: { sessionId: 'cache-a' },
          lineageMeta: {
            uuids: ['cache-a-u', 'cache-a-a'],
            leafUuidRefs: expect.any(Array),
            startTime: expect.any(String),
            endTime: expect.any(String),
            cwd: '/Users/test',
            sessionId: 'cache-a'
          }
        }
      })

      writeJsonlAt(firstFile, [
        ...firstMessages,
        rawMsg({ uuid: 'cache-a-u2', sessionId: 'cache-a', parentUuid: 'cache-a-a', type: 'user', timestamp: '2026-03-01T00:02:00Z', message: { role: 'user', content: '只修改 A' } }),
        rawMsg({ uuid: 'cache-a-a2', sessionId: 'cache-a', parentUuid: 'cache-a-u2', type: 'assistant', timestamp: '2026-03-01T00:03:00Z', message: { role: 'assistant', content: 'A 新回复' } })
      ])
      infoSpy.mockClear()
      const incremental = await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 1, reused 1, files 2')

      fs.rmSync(cachePath)
      infoSpy.mockClear()
      const fullRebuild = await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 2, reused 0, files 2')
      expect(incremental).toEqual(fullRebuild)
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('P1-3：压缩缓存保留来源证据，多文件 summary 重建不丢判定字段', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-origin-cache-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const firstFile = path.join(projectDir, 'origin-cache-a.jsonl')
    const secondFile = path.join(projectDir, 'origin-cache-b.jsonl')
    writeJsonlAt(firstFile, [
      rawMsg({
        uuid: 'origin-human',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
        promptSource: 'typed',
        message: { role: 'user', content: '缓存中的真人问题' }
      }),
      rawMsg({
        uuid: 'origin-assistant-a',
        sessionId: 'origin-cache-session',
        parentUuid: 'origin-human',
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: { role: 'assistant', content: '第一段回复' }
      })
    ])
    writeJsonlAt(secondFile, [
      rawMsg({
        uuid: 'origin-task',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:02:00Z',
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
        message: { role: 'user', content: '无标签的任务通知正文' }
      }),
      rawMsg({
        uuid: 'origin-meta',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:02:10Z',
        promptSource: 'typed',
        isMeta: true,
        message: { role: 'user', content: '无标签的元消息正文' }
      }),
      rawMsg({
        uuid: 'origin-tool',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:02:20Z',
        promptSource: 'typed',
        sourceToolAssistantUUID: 'tool-source-uuid',
        toolUseResult: { detail: '不应写入压缩缓存' },
        message: { role: 'user', content: '规整后的工具结果' }
      }),
      rawMsg({
        uuid: 'origin-assistant-b',
        sessionId: 'origin-cache-session',
        parentUuid: 'origin-tool',
        type: 'assistant',
        timestamp: '2026-03-01T00:03:00Z',
        message: { role: 'assistant', content: '第二段回复' }
      })
    ])

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { quiet: true })
      const summary = sessions.find((session) => session.sessionId === 'origin-cache-session')
      const cachePath = path.join(home, '.claude-session-manager', 'summary-cache.json')
      const diskCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
      const refs = [
        ...diskCache.entries[firstFile].perFile.lineageMeta.leafUuidRefs,
        ...diskCache.entries[secondFile].perFile.lineageMeta.leafUuidRefs
      ]

      expect(summary).toMatchObject({ firstUserMessage: '缓存中的真人问题', turnCount: 1 })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-human')).toMatchObject({
        promptSource: 'typed'
      })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-task')).toMatchObject({
        origin: { kind: 'task-notification' },
        promptSource: 'sdk'
      })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-meta')).toMatchObject({
        promptSource: 'typed',
        isMeta: true
      })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-tool')).toMatchObject({
        promptSource: 'typed',
        sourceToolAssistantUUID: 'tool-source-uuid',
        toolUseResult: true
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('P1-3：版本 19 的旧缓存强制失效，不污染来源判定', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-old-origin-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'old-cache-session.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        uuid: 'old-cache-task',
        sessionId: 'old-cache-session',
        type: 'user',
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
        message: { role: 'user', content: '无标签的机器通知' }
      }),
      rawMsg({
        uuid: 'old-cache-assistant',
        sessionId: 'old-cache-session',
        parentUuid: 'old-cache-task',
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: { role: 'assistant', content: '收到' }
      })
    ])
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      const cachePath = path.join(home, '.claude-session-manager', 'summary-cache.json')
      const oldCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
      oldCache.version = 19
      oldCache.entries[file].perFile.summary.firstUserMessage = '旧缓存误判的真人内容'
      oldCache.entries[file].perFile.summary.turnCount = 1
      delete oldCache.entries[file].perFile.lineageMeta.leafUuidRefs[0].origin
      oldCache.entries[file].perFile.lineageMeta.leafUuidRefs[0].promptSource = 'typed'
      fs.writeFileSync(cachePath, JSON.stringify(oldCache))

      infoSpy.mockClear()
      const sessions = await loadAllSessionsFromTempHome(home)
      const summary = sessions.find((session) => session.sessionId === 'old-cache-session')
      const refreshedCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))

      expect(incrementalCacheLog(infoSpy)).toContain('parsed 1, reused 0, files 1')
      expect(summary).toMatchObject({ firstUserMessage: 'old-cache-session', turnCount: 0 })
      expect(refreshedCache.version).toBe(24)
      expect(refreshedCache.entries[file].perFile.lineageMeta.leafUuidRefs[0]).toMatchObject({
        origin: { kind: 'task-notification' },
        promptSource: 'sdk'
      })
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('t117：guardian/thread_spawn 不作顶层，子用量归父且旧缓存不能复活 guardian', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-role-cache-home-'))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '22')
    const parentId = '019f8476-88d9-7b12-9b78-0e6d5ec8f640'
    const childId = '019f4a2a-d46a-7d63-93e8-3a542bfe1c1d'
    const guardianId = '019f8786-bfca-7b12-a541-fe89cc3b242a'
    const parentFile = path.join(codexDir, `rollout-parent-${parentId}.jsonl`)
    const childFile = path.join(codexDir, `rollout-child-${childId}.jsonl`)
    const guardianFile = path.join(codexDir, `rollout-guardian-${guardianId}.jsonl`)

    writeJsonlAt(parentFile, codexRoleRows({
      sessionId: parentId,
      userText: '正常父会话',
      inputTokens: 100,
      outputTokens: 20,
      turnId: 'shared-turn'
    }) as RawJsonlMessage[])
    const childRows = codexRoleRows({
      sessionId: childId,
      userText: '真实子 Agent',
      inputTokens: 100,
      outputTokens: 20,
      turnId: 'shared-turn',
      parentThreadId: parentId,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: 1,
            agent_path: '/root/review',
            agent_nickname: 'Reviewer'
          }
        }
      }
    }) as any[]
    childRows.splice(childRows.length - 1, 0, {
      timestamp: '2026-07-22T00:00:03.500Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          turn_id: 'child-only',
          last_token_usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 0 }
        }
      }
    })
    writeJsonlAt(childFile, childRows as RawJsonlMessage[])
    writeJsonlAt(guardianFile, codexRoleRows({
      sessionId: guardianId,
      userText: 'The following is the Codex agent history whose request action you are assessing.',
      inputTokens: 30,
      outputTokens: 3,
      turnId: 'guardian-only',
      parentThreadId: parentId,
      source: { subagent: { other: 'guardian' } }
    }) as RawJsonlMessage[])

    try {
      const cold = await loadAllSessionsFromTempHome(home)
      const parent = cold.find((session) => session.sessionId === parentId)
      const cachePath = path.join(home, '.claude-session-manager', 'summary-cache.json')
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))

      expect(cold.map((session) => session.sessionId)).toEqual([parentId])
      expect(parent?.subagents).toEqual([
        expect.objectContaining({ sessionId: childId, role: 'thread-spawn', parentSessionId: parentId })
      ])
      expect(parent?.tokenAccounting?.billingTotal).toBe(208)
      expect(parent?.tokenAccounting?.conversationOnly).toBe(120)
      expect(parent?.tokenAccounting?.usageEvents).toHaveLength(3)
      expect(parent?.tokenAccounting?.usageEvents.filter((event) => event.scope === 'subagent')).toHaveLength(2)
      expect(cache.version).toBe(24)
      expect(cache.entries[guardianFile].perFile).toMatchObject({
        summary: null,
        codexSubagent: { role: 'guardian', parentSessionId: parentId }
      })

      cache.version = 23
      cache.entries[guardianFile].perFile.summary = {
        ...parent,
        id: `codex:${guardianId}`,
        sessionId: guardianId,
        firstUserMessage: '旧缓存中的 guardian'
      }
      fs.writeFileSync(cachePath, JSON.stringify(cache))

      const hot = await loadAllSessionsFromTempHome(home)
      expect(hot.map((session) => session.sessionId)).toEqual([parentId])
      expect(JSON.parse(fs.readFileSync(cachePath, 'utf-8')).version).toBe(24)

      fs.rmSync(childFile)
      fs.rmSync(guardianFile)
      const afterChildrenRemoved = await loadAllSessionsFromTempHome(home)
      expect(afterChildrenRemoved[0].tokenAccounting?.billingTotal).toBe(120)
      expect(afterChildrenRemoved[0].tokenAccounting?.conversationOnly).toBe(120)
      expect(afterChildrenRemoved[0].subagents).toBeUndefined()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('t117：报告固定快照中的 44 个 guardian 全部退出顶层，正常 Codex 数量不变', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-44-guardian-home-'))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '22')
    const normalIds = ['normal-codex-a', 'normal-codex-b']

    for (const [index, sessionId] of normalIds.entries()) {
      writeJsonlAt(path.join(codexDir, `rollout-normal-${index}.jsonl`), codexRoleRows({
        sessionId,
        userText: `正常会话 ${index}`,
        inputTokens: 10,
        outputTokens: 2,
        turnId: `normal-turn-${index}`
      }) as RawJsonlMessage[])
    }
    for (let index = 0; index < 44; index++) {
      writeJsonlAt(path.join(codexDir, `rollout-guardian-${index}.jsonl`), codexRoleRows({
        sessionId: `guardian-${index}`,
        userText: 'The following is the Codex agent history whose request action you are assessing.',
        inputTokens: 3,
        outputTokens: 1,
        turnId: `guardian-turn-${index}`,
        parentThreadId: normalIds[0],
        source: { subagent: { other: 'guardian' } }
      }) as RawJsonlMessage[])
    }

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      expect(46 - sessions.length).toBe(44)
      expect(sessions.map((session) => session.sessionId).sort()).toEqual(normalIds)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('当前不存在的文件会从新缓存删除', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'removed.jsonl')
    writeJsonlAt(file, [rawMsg({ sessionId: 'removed', type: 'user', message: { role: 'user', content: '待删除' } })])

    try {
      await loadAllSessionsFromTempHome(home)
      fs.rmSync(file)
      const sessions = await loadAllSessionsFromTempHome(home)
      const cachePath = path.join(home, '.claude-session-manager', 'summary-cache.json')
      const diskCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
      expect(sessions.some((session) => session.sessionId === 'removed')).toBe(false)
      expect(diskCache.entries[file]).toBeUndefined()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

})

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

      // The unchanged parent's UUID graph must survive the cache; otherwise the
      // one-file update loses the child -> parent relationship.
      writeJsonlAt(childFile, [
        ...childMsgs,
        rawMsg({ uuid: 'child-u2', sessionId: childId, parentUuid: 'child-a', type: 'user', timestamp: '2026-06-10T10:06:00Z', message: { role: 'user', content: '只更新 child' } }),
        rawMsg({ uuid: 'child-a2', sessionId: childId, parentUuid: 'child-u2', type: 'assistant', timestamp: '2026-06-10T10:07:00Z', message: { role: 'assistant', content: 'child 新回答' } })
      ])
      const incremental = await loadAllSessionsFromTempHome(home)
      fs.rmSync(path.join(home, '.claude-session-manager', 'summary-cache.json'))
      const rebuilt = await loadAllSessionsFromTempHome(home)
      expect(incremental).toEqual(rebuilt)
      expect(incremental.find((s) => s.sessionId === childId)?.branchParentId).toBe(parent!.id)
      expect(incremental.find((s) => s.sessionId === parentId)?.branchChildIds).toContain(child!.id)
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
