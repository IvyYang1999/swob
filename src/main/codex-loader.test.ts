import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildCodexSessionSummary,
  buildCodexSessionDetail,
  classifyCodexSession,
  extractCodexTokenAccounting,
  findCodexSessionFiles,
  loadCodexRawMessages,
  loadCodexSessionRecord,
  loadCodexSessionRecordWithRaw,
  rememberCodexSessionFile
} from './codex-loader'

function writeTempJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-test-'))
  const fp = path.join(dir, 'rollout-2026-03-27T21-37-24-test-uuid.jsonl')
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'))
  return fp
}

const SESSION_ID = '019d2f83-912b-7933-8860-00156f6f333e'
const PARENT_ID = '019f8476-88d9-7b12-9b78-0e6d5ec8f640'

function makeCodexLines() {
  return [
    {
      timestamp: '2026-03-27T13:37:33.983Z',
      type: 'session_meta',
      payload: {
        id: SESSION_ID,
        timestamp: '2026-03-27T13:37:24.783Z',
        cwd: '/Users/test/projects/myapp',
        cli_version: '0.116.0',
        model_provider: 'openai'
      }
    },
    {
      timestamp: '2026-03-27T13:37:33.984Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '帮我看看这个项目的目录' }]
      }
    },
    {
      timestamp: '2026-03-27T13:37:33.985Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '帮我看看这个项目的目录', images: [] }
    },
    {
      timestamp: '2026-03-27T13:37:39.382Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '我来查看项目结构。', phase: 'commentary' }
    },
    {
      timestamp: '2026-03-27T13:37:39.477Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: '{"cmd":"ls","workdir":"/Users/test/projects/myapp"}',
        call_id: 'call_abc123'
      }
    },
    {
      timestamp: '2026-03-27T13:37:39.646Z',
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'call_abc123', output: 'src\npackage.json' }
    },
    {
      timestamp: '2026-03-27T13:38:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, output_tokens: 200, cached_input_tokens: 0, total_tokens: 700 } }, rate_limits: {} }
    },
    {
      timestamp: '2026-03-27T13:38:00.500Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '现在帮我改一下 README' }]
      }
    },
    {
      timestamp: '2026-03-27T13:38:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: '现在帮我改一下 README', images: [] }
    },
    {
      timestamp: '2026-03-27T13:38:05.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: '好的，我来修改 README。', phase: 'commentary' }
    },
    {
      timestamp: '2026-03-27T13:38:10.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', cwd: '/Users/test/projects/myapp', model: 'gpt-5.4' }
    }
  ]
}

describe('codex-loader', () => {
  describe('classifyCodexSession', () => {
    it('只根据结构化 session_meta 区分 guardian、thread_spawn 与顶层会话', () => {
      expect(classifyCodexSession({
        source: { subagent: { other: 'guardian' } },
        thread_source: 'subagent',
        parent_thread_id: PARENT_ID
      })).toMatchObject({ role: 'guardian', parentThreadId: PARENT_ID })

      expect(classifyCodexSession({
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: PARENT_ID,
              depth: 1,
              agent_path: '/root/review',
              agent_nickname: 'Reviewer'
            }
          }
        }
      })).toMatchObject({
        role: 'thread-spawn',
        parentThreadId: PARENT_ID,
        agentPath: '/root/review',
        agentNickname: 'Reviewer'
      })

      expect(classifyCodexSession({ source: 'vscode' })).toEqual({ role: 'top-level' })
    })
  })

  describe('findCodexSessionFiles', () => {
    it('可从注入的 Windows USERPROFILE fixture 发现会话', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-win-codex-home-'))
      const sessionPath = path.join(home, '.codex', 'sessions', '2026', '07', '22', 'rollout-test.jsonl')
      fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
      fs.writeFileSync(sessionPath, '{}\n')

      try {
        expect(findCodexSessionFiles(home)).toEqual([sessionPath])
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    })

    it('同时扫描 sessions 与只读 archived_sessions，忽略非 rollout 文件', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-archive-home-'))
      const active = path.join(home, '.codex', 'sessions', '2026', '08', '02', 'rollout-active.jsonl')
      const archived = path.join(home, '.codex', 'archived_sessions', 'rollout-archived.jsonl')
      const ignored = path.join(home, '.codex', 'archived_sessions', 'notes.jsonl')
      fs.mkdirSync(path.dirname(active), { recursive: true })
      fs.mkdirSync(path.dirname(archived), { recursive: true })
      fs.writeFileSync(active, '{}\n')
      fs.writeFileSync(archived, '{}\n')
      fs.writeFileSync(ignored, '{}\n')

      try {
        expect(findCodexSessionFiles(home)).toEqual([archived, active].sort())
      } finally {
        fs.rmSync(home, { recursive: true, force: true })
      }
    })

    it('冷扫后由 watcher 事件增量加入新文件，不重扫整根', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-inventory-home-'))
      const directory = path.join(home, '.codex', 'sessions', '2026', '08', '02')
      const first = path.join(directory, 'rollout-first.jsonl')
      const second = path.join(directory, 'rollout-second.jsonl')
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(first, '{}\n')
      const previousHome = process.env.HOME

      try {
        expect(findCodexSessionFiles(home)).toEqual([first])
        fs.writeFileSync(second, '{}\n')
        expect(findCodexSessionFiles(home)).toEqual([first])
        process.env.HOME = home
        expect(rememberCodexSessionFile(second)).toBe(true)
        expect(findCodexSessionFiles(home)).toEqual([first, second])
      } finally {
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        fs.rmSync(home, { recursive: true, force: true })
      }
    })
  })

  describe('buildCodexSessionSummary', () => {
    it('组合解析一次产出与独立 summary/raw API 等价的投影', async () => {
      const filePath = writeTempJsonl(makeCodexLines())

      const combined = await loadCodexSessionRecordWithRaw(filePath)
      const [summary, rawMessages] = await Promise.all([
        buildCodexSessionSummary(filePath),
        loadCodexRawMessages(filePath)
      ])

      expect(combined.summary).toEqual(summary)
      expect(combined.rawMessages).toEqual(rawMessages)
      expect(combined.rawMessages.length).toBeGreaterThan(0)
    })

    it('resume/fork 复制前缀在无 turn_id 的真实格式下生成相同计费事实指纹', () => {
      const lines = [
        {
          timestamp: '2026-07-31T12:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'one', timestamp: '2026-07-31T12:00:00.000Z', cwd: '/repo', cli_version: '1', model_provider: 'openai' }
        },
        {
          timestamp: '2026-07-31T12:00:01.000Z',
          type: 'turn_context',
          payload: { turn_id: 'context-only', model: 'gpt-5.6-luna' }
        },
        {
          timestamp: '2026-07-31T12:00:02.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 },
              total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 }
            }
          }
        }
      ] as any[]

      const original = extractCodexTokenAccounting(lines)
      const copied = extractCodexTokenAccounting(structuredClone(lines))

      expect(original.usageEvents).toHaveLength(1)
      expect(original.usageEvents[0].billingFactKey).toMatch(/^codex:event:/)
      expect(copied.usageEvents[0].billingFactKey).toBe(original.usageEvents[0].billingFactKey)
    })

    it('正确解析 Codex session 为 SessionSummary', async () => {
      const fp = writeTempJsonl(makeCodexLines())
      const summary = await buildCodexSessionSummary(fp)

      expect(summary).not.toBeNull()
      expect(summary!.source).toBe('codex')
      expect(summary!.id).toBe(`codex:${SESSION_ID}`)
      expect(summary!.sessionId).toBe(SESSION_ID)
      expect(summary!.cwds).toEqual(['/Users/test/projects/myapp'])
      expect(summary!.firstUserMessage).toBe('帮我看看这个项目的目录')
      expect(summary!.turnCount).toBeGreaterThanOrEqual(2)
      expect(summary!.activityDays).toEqual(['2026-03-27'])
      expect(summary!.toolUsage['exec_command']).toBe(1)
      expect(summary!.tokenUsage.inputTokens).toBe(500)
      expect(summary!.tokenUsage.outputTokens).toBe(200)
    })

    it('旧 replay 文件用继承 SessionMeta 建 lineage，并保留官方 thread_rolled_back 事实', async () => {
      const childId = '18400000-0000-4000-8000-000000000021'
      const parentId = '18400000-0000-4000-8000-000000000020'
      const lines = [
        {
          timestamp: '2026-08-02T00:00:00Z', type: 'session_meta',
          payload: { id: childId, timestamp: '2026-08-02T00:00:00Z', cwd: '/repo', cli_version: 'test' }
        },
        {
          timestamp: '2026-08-02T00:00:00Z', type: 'session_meta',
          payload: { id: parentId, timestamp: '2026-08-01T00:00:00Z', cwd: '/repo', cli_version: 'test' }
        },
        {
          timestamp: '2026-08-02T00:00:01Z', type: 'event_msg',
          payload: { type: 'thread_rolled_back', num_turns: 1 }
        },
        {
          timestamp: '2026-08-02T00:00:02Z', type: 'response_item',
          payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'replay after rollback' }] }
        },
        {
          timestamp: '2026-08-02T00:00:03Z', type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }
        }
      ]
      const filePath = writeTempJsonl(lines)
      const summary = await buildCodexSessionSummary(filePath, childId)
      const detail = await buildCodexSessionDetail(filePath, childId)

      expect(summary).toMatchObject({
        lifecycleState: 'replayed',
        branchParentId: `codex:${parentId}`
      })
      expect(detail?.messages).toContainEqual(expect.objectContaining({ subtype: 'rollback' }))
    })

    it('【回归】cached_input/reasoning 是子集，重复 token_count 快照不应重复计费', async () => {
      const lines: any[] = makeCodexLines().filter((line) => !(line.type === 'event_msg' && line.payload.type === 'token_count'))
      lines.push(
        {
          timestamp: '2026-03-27T13:38:10.100Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 },
              total_token_usage: { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 }
            }
          }
        },
        {
          timestamp: '2026-03-27T13:38:10.200Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 },
              total_token_usage: { input_tokens: 1_000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 }
            }
          }
        },
        {
          timestamp: '2026-03-27T13:38:20.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 500, cached_input_tokens: 300, output_tokens: 60, reasoning_output_tokens: 20 },
              total_token_usage: { input_tokens: 1_500, cached_input_tokens: 900, output_tokens: 160, reasoning_output_tokens: 60 }
            }
          }
        }
      )
      const summary = await buildCodexSessionSummary(writeTempJsonl(lines))

      expect(summary!.tokenUsage).toEqual({
        inputTokens: 600,
        cacheReadTokens: 900,
        cacheCreationTokens: 0,
        outputTokens: 160
      })
      expect(summary!.tokenAccounting?.components?.reasoningTokens).toBe(60)
      expect(summary!.tokenAccounting?.billingTotal).toBe(1_660)
      expect(summary!.tokenAccounting?.usageEvents).toHaveLength(2)
    })

    it('空文件返回 null', async () => {
      const fp = writeTempJsonl([])
      const summary = await buildCodexSessionSummary(fp)
      expect(summary).toBeNull()
    })

    it('guardian 与 thread_spawn 不生成顶层 summary/detail，但保留父子关系和子会话用量', async () => {
      const guardianLines: any[] = makeCodexLines()
      guardianLines[0] = {
        ...guardianLines[0],
        payload: {
          ...guardianLines[0].payload,
          source: { subagent: { other: 'guardian' } },
          thread_source: 'subagent',
          parent_thread_id: PARENT_ID,
          originator: 'Codex Desktop'
        }
      }
      guardianLines.push({
        timestamp: '2026-03-27T13:38:20.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 550,
              output_tokens: 220,
              cached_input_tokens: 0,
              total_tokens: 770
            }
          },
          rate_limits: {}
        }
      })
      const guardianFile = writeTempJsonl(guardianLines)

      expect(await buildCodexSessionSummary(guardianFile)).toBeNull()
      expect(await buildCodexSessionDetail(guardianFile)).toBeNull()
      expect(await loadCodexSessionRecord(guardianFile)).toMatchObject({
        summary: null,
        subagent: {
          role: 'guardian',
          parentSessionId: PARENT_ID,
          tokenAccounting: {
            usageEvents: [{ scope: 'subagent' }]
          }
        }
      })

      const threadSpawnLines: any[] = makeCodexLines()
      threadSpawnLines[0] = {
        ...threadSpawnLines[0],
        payload: {
          ...threadSpawnLines[0].payload,
          source: {
            subagent: {
              thread_spawn: {
                parent_thread_id: PARENT_ID,
                depth: 1,
                agent_path: '/root/review',
                agent_nickname: 'Reviewer'
              }
            }
          },
          thread_source: 'subagent',
          parent_thread_id: PARENT_ID
        }
      }
      const threadSpawnFile = writeTempJsonl(threadSpawnLines)
      expect(await loadCodexSessionRecord(threadSpawnFile)).toMatchObject({
        summary: null,
        subagent: {
          role: 'thread-spawn',
          parentSessionId: PARENT_ID,
          agentPath: '/root/review',
          agentNickname: 'Reviewer'
        }
      })
    })

    it('普通用户即使输入审批器固定开场白也不能被文本误杀', async () => {
      const lines: any[] = makeCodexLines()
      lines[0] = { ...lines[0], payload: { ...lines[0].payload, source: 'vscode' } }
      lines[1] = {
        ...lines[1],
        payload: {
          ...lines[1].payload,
          content: [{ type: 'input_text', text: 'The following is the Codex agent history whose request action you are assessing.' }]
        }
      }

      const summary = await buildCodexSessionSummary(writeTempJsonl(lines))
      expect(summary?.firstUserMessage).toBe('The following is the Codex agent history whose request action you are assessing.')
    })

    it('用户、assistant 与 tool result 的 ANSI/CSI/OSC 在解析入口统一清理', async () => {
      const lines: any[] = makeCodexLines()
      lines[1].payload.content[0].text = '\u001b[2m用户\u001b[22m'
      lines[3].payload.message = '\u001b]8;;https://example.com\u0007助手\u001b]8;;\u0007'
      lines[5].payload.output = '\u001b[31m失败\u001b[0m\u001b[2J'

      const detail = await buildCodexSessionDetail(writeTempJsonl(lines))
      expect(detail?.firstUserMessage).toBe('用户')
      expect(detail?.messages.some((message) => message.textContent === '助手')).toBe(true)
      expect(detail?.messages.flatMap((message) => message.toolCalls).find((tool) => tool.id === 'call_abc123')?.result)
        .toBe('失败')
      expect(JSON.stringify(detail)).not.toMatch(/\u001b|\[2m|\[31m/)
    })

    it('兼容新版 Codex 数组格式的 function_call_output，并清理每个文本块', async () => {
      const lines: any[] = makeCodexLines()
      lines[5].payload.output = [
        { type: 'input_text', text: '\u001b[2m第一段\u001b[22m' },
        { type: 'input_text', text: '\u001b]0;title\u0007第二段\u001b[2J' }
      ]

      const detail = await buildCodexSessionDetail(writeTempJsonl(lines))
      expect(detail?.messages.flatMap((message) => message.toolCalls).find((tool) => tool.id === 'call_abc123')?.result)
        .toBe('第一段\n第二段')
    })

    it('没有 session_meta 时从文件名提取 session ID', async () => {
      const lines = makeCodexLines().filter((l) => l.type !== 'session_meta')
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-test-'))
      const fp = path.join(dir, `rollout-2026-03-27T21-37-24-${SESSION_ID}.jsonl`)
      fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'))

      const summary = await buildCodexSessionSummary(fp)
      expect(summary).not.toBeNull()
      expect(summary!.sessionId).toBe(SESSION_ID)
    })

    it('过滤 Codex 系统注入并用第一个真实 Query 做 firstUserMessage', async () => {
      const lines = [
        makeCodexLines()[0],
        {
          timestamp: '2026-03-27T13:37:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/test\n<INSTRUCTIONS>不要进入 transcript</INSTRUCTIONS>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>cwd=/Users/test</environment_context>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:36.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<user_instructions>系统注入</user_instructions>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:37.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<turn_aborted>interrupted</turn_aborted>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:38.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '请真正处理这个需求' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:39.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '收到。' }]
          }
        }
      ]
      const fp = writeTempJsonl(lines)
      const summary = await buildCodexSessionSummary(fp)

      expect(summary).not.toBeNull()
      expect(summary!.firstUserMessage).toBe('请真正处理这个需求')
      expect(summary!.allUserMessages).toBeUndefined()
    })

    it('真实用户消息以 AGENTS.md instructions 开头时不被误杀', async () => {
      const lines = [
        makeCodexLines()[0],
        {
          timestamp: '2026-03-27T13:37:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '# AGENTS.md instructions 是什么？请解释这个标题。' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '这是一个说明标题。' }]
          }
        }
      ]
      const fp = writeTempJsonl(lines)
      const summary = await buildCodexSessionSummary(fp)
      const detail = await buildCodexSessionDetail(fp)

      expect(summary).not.toBeNull()
      expect(summary!.firstUserMessage).toBe('# AGENTS.md instructions 是什么？请解释这个标题。')
      expect(summary!.turnCount).toBe(1)
      expect(detail!.messages.some((m) => m.textContent.includes('# AGENTS.md instructions 是什么'))).toBe(true)
    })

    it('过滤 recommended_plugins + INSTRUCTIONS + environment_context 组合注入', async () => {
      const bootstrap = [
        '<recommended_plugins>plugin catalog</recommended_plugins>',
        '# AGENTS.md instructions',
        '<INSTRUCTIONS>workspace rules</INSTRUCTIONS>',
        '<environment_context>cwd=/Users/test</environment_context>'
      ].join('\n')
      const lines = [
        makeCodexLines()[0],
        {
          timestamp: '2026-03-27T13:37:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: bootstrap }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '第一条真实 Query' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:36.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '真实回答' }]
          }
        }
      ]
      const fp = writeTempJsonl(lines)
      const summary = await buildCodexSessionSummary(fp)
      const detail = await buildCodexSessionDetail(fp)

      expect(summary!.firstUserMessage).toBe('第一条真实 Query')
      expect(detail!.messages.filter((m) => m.type === 'user').map((m) => m.textContent)).toEqual(['第一条真实 Query'])
    })
  })

  describe('buildCodexSessionDetail', () => {
    it('生成包含消息列表的 detail', async () => {
      const fp = writeTempJsonl(makeCodexLines())
      const detail = await buildCodexSessionDetail(fp)

      expect(detail).not.toBeNull()
      expect(detail!.source).toBe('codex')
      expect(detail!.messages.length).toBeGreaterThan(0)

      const userMsgs = detail!.messages.filter((m) => m.type === 'user' && !m.isSystemGenerated)
      expect(userMsgs.length).toBeGreaterThanOrEqual(2)

      const assistantMsgs = detail!.messages.filter((m) => m.type === 'assistant')
      expect(assistantMsgs.length).toBeGreaterThanOrEqual(2)

      const toolCallMsg = detail!.messages.find((m) => m.toolCalls.length > 0)
      expect(toolCallMsg).toBeDefined()
      expect(toolCallMsg!.toolCalls[0].name).toBe('exec_command')
    })

    it('工具调用结果正确配对', async () => {
      const fp = writeTempJsonl(makeCodexLines())
      const detail = await buildCodexSessionDetail(fp)

      const toolCallMsg = detail!.messages.find((m) => m.toolCalls.some((t) => t.id === 'call_abc123'))
      expect(toolCallMsg).toBeDefined()
      expect(toolCallMsg!.toolCalls[0].result).toContain('src')
    })

    it('同一 Assistant 回合的 reasoning/agent_message 与 response_item message 只保留一条', async () => {
      const repeatedAnswer = '同一回合只应落盘一次。'
      const lines = [
        makeCodexLines()[0],
        {
          timestamp: '2026-03-27T13:37:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '请检查重复回合' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.000Z',
          type: 'response_item',
          payload: {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: repeatedAnswer }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.050Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: repeatedAnswer, phase: 'final_answer' }
        },
        {
          timestamp: '2026-03-27T13:37:35.100Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: repeatedAnswer }]
          }
        }
      ]
      const fp = writeTempJsonl(lines)
      const detail = await buildCodexSessionDetail(fp)

      expect(detail!.messages.filter((m) => m.type === 'assistant').map((m) => m.textContent)).toEqual([repeatedAnswer])
    })

    it('【曾经的 bug】AGENTS.md instructions 等系统消息不作为用户输入', async () => {
      const lines = [
        makeCodexLines()[0],
        {
          timestamp: '2026-03-27T13:37:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'AGENTS.md instructions for /Users/test\n<INSTRUCTIONS>## Skills\nsome instructions</INSTRUCTIONS>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'System prompt content' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:36.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>cwd=/Users/test</environment_context>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:37.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '真实问题' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:38.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '真实回答' }]
          }
        }
      ]
      const fp = writeTempJsonl(lines)
      const detail = await buildCodexSessionDetail(fp)

      const userTexts = detail!.messages
        .filter((m) => m.type === 'user')
        .map((m) => m.textContent)

      expect(userTexts.some((t) => t.includes('AGENTS.md'))).toBe(false)
      expect(userTexts.some((t) => t.includes('System prompt'))).toBe(false)
      expect(userTexts.some((t) => t.includes('<environment_context>'))).toBe(false)
      expect(userTexts).toContain('真实问题')
    })

    it('保留 Codex user_shell_command 的命令本体', async () => {
      const lines = [
        makeCodexLines()[0],
        {
          timestamp: '2026-03-27T13:37:34.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<user_shell_command>\nnpm test\n</user_shell_command>' }]
          }
        },
        {
          timestamp: '2026-03-27T13:37:35.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: '测试完成。' }]
          }
        }
      ]
      const fp = writeTempJsonl(lines)
      const detail = await buildCodexSessionDetail(fp)

      const userTexts = detail!.messages
        .filter((m) => m.type === 'user')
        .map((m) => m.textContent)

      expect(userTexts).toContain('npm test')
      expect(userTexts.some((t) => t.includes('<user_shell_command>'))).toBe(false)
    })
  })
})
