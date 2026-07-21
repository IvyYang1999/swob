import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { buildCodexSessionSummary, buildCodexSessionDetail, findCodexSessionFiles } from './codex-loader'

function writeTempJsonl(lines: object[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-test-'))
  const fp = path.join(dir, 'rollout-2026-03-27T21-37-24-test-uuid.jsonl')
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'))
  return fp
}

const SESSION_ID = '019d2f83-912b-7933-8860-00156f6f333e'

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
  describe('findCodexSessionFiles', () => {
    it('扫描 ~/.codex/sessions/ 下的 rollout-*.jsonl 文件', () => {
      const files = findCodexSessionFiles()
      for (const f of files) {
        expect(path.basename(f)).toMatch(/^rollout-.*\.jsonl$/)
      }
    })
  })

  describe('buildCodexSessionSummary', () => {
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
      expect(summary!.toolUsage['exec_command']).toBe(1)
      expect(summary!.tokenUsage.inputTokens).toBe(500)
      expect(summary!.tokenUsage.outputTokens).toBe(200)
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
