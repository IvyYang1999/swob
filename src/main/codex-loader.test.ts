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
  rememberCodexSessionFile,
  parseCodexFileWithStats,
  type CodexLine
} from './codex-loader'
import { mergeTokenAccountings } from './token-accounting'
import {
  codexClock,
  codexJsonl,
  codexRow,
  codexTime,
  copiedPrefix,
  type CodexFixtureRow,
  type CodexFixtureUsage,
  type CodexRowBase
} from './__fixtures__/codex-rollout-synthetic'

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

    // 键序照《附录-Codex键序普查》（__fixtures__/codex-rollout-synthetic.ts）；token_count 无 turn_id，与真实格式一致。
    it('分叉副本改写时间戳后，billingFactKey 仍与父会话相同（F1b）', () => {
      const parentId = '7f1b0000-0000-4000-8000-000000000021'
      const at = codexClock('2026-07-31T12:00:00.000Z')
      const parentRows = [
        codexRow.topLevelMeta({ ...at(), id: parentId, cwd: '/repo' }),
        codexRow.turnContext({ ...at(), turnId: 'turn-1', cwd: '/repo', model: 'gpt-5.6-luna' }),
        codexRow.userMessage({ ...at(), text: '第一个问题' }),
        codexRow.tokenCount({ ...at(), total: { input: 100, cached: 20, output: 10 }, last: { input: 100, cached: 20, output: 10 } }),
        codexRow.turnContext({ ...at(), turnId: 'turn-2', cwd: '/repo', model: 'gpt-5.6-luna' }),
        codexRow.userMessage({ ...at(), text: '第二个问题' }),
        codexRow.tokenCount({ ...at(), total: { input: 250, cached: 60, output: 25 }, last: { input: 150, cached: 40, output: 15 } })
      ]
      const forkedAt = '2026-07-31T13:00:00.000Z'
      const childRows = [
        codexRow.threadSpawnMeta({
          timestamp: forkedAt, ordinal: 0, id: '7f1b0000-0000-4000-8000-000000000022', parentId,
          cwd: '/repo', depth: 1, historyStartOrdinal: parentRows.length
        }),
        ...copiedPrefix(parentRows.slice(1), { startIso: codexTime(forkedAt, 1), firstOrdinal: 1 })
      ]

      const original = extractCodexTokenAccounting(parentRows as unknown as CodexLine[])
      const copied = extractCodexTokenAccounting(childRows as unknown as CodexLine[], 'subagent')

      expect(original.usageEvents).toHaveLength(2)
      expect(original.usageEvents.every((event) => event.billingFactKey?.startsWith('codex:event:'))).toBe(true)
      const copiedTimestamps = new Set(copied.usageEvents.map((event) => event.timestamp))
      expect(original.usageEvents.some((event) => copiedTimestamps.has(event.timestamp))).toBe(false)
      expect(copied.usageEvents.map((event) => event.billingFactKey))
        .toEqual(original.usageEvents.map((event) => event.billingFactKey))
    })

    it('反例：累计值不同就是不同的计费事实，单轮用量相同也不共用键（F1b）', () => {
      const at = codexClock('2026-07-31T12:00:00.000Z')
      const sameTurn = { input: 100, cached: 20, output: 10 }
      const rows = [
        codexRow.topLevelMeta({ ...at(), id: '7f1b0000-0000-4000-8000-000000000023', cwd: '/repo' }),
        codexRow.turnContext({ ...at(), turnId: 'turn-1', cwd: '/repo', model: 'gpt-5.6-luna' }),
        codexRow.tokenCount({ ...at(), total: sameTurn, last: sameTurn }),
        codexRow.turnContext({ ...at(), turnId: 'turn-2', cwd: '/repo', model: 'gpt-5.6-luna' }),
        codexRow.tokenCount({ ...at(), total: { input: 200, cached: 40, output: 20 }, last: sameTurn })
      ]

      const accounting = extractCodexTokenAccounting(rows as unknown as CodexLine[])
      const keys = accounting.usageEvents.map((event) => event.billingFactKey)

      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
      expect(accounting.billingTotal).toBe(2 * (80 + 20 + 10))
    })

    // 真实分叉子文件里，抄写的 token_count 前面不一定有抄写的 turn_context：162 个里有 56 个，
    // 第一条抄写快照出现在任何 turn_context 之前（F1b 验收 P1-1）。副本因此可能没有 model，
    // 也可能带着子 agent 自己的 model。下面两例的抄写前缀都不含 turn_context。
    const forkParentRows = (parentId: string): CodexFixtureRow[] => {
      const at = codexClock('2026-07-31T12:00:00.000Z')
      return [
        codexRow.topLevelMeta({ ...at(), id: parentId, cwd: '/repo' }),
        codexRow.turnContext({ ...at(), turnId: 'turn-1', cwd: '/repo', model: 'gpt-5.6-luna' }),
        codexRow.userMessage({ ...at(), text: '第一个问题' }),
        codexRow.tokenCount({ ...at(), total: { input: 100, cached: 20, output: 10 }, last: { input: 100, cached: 20, output: 10 } }),
        codexRow.turnContext({ ...at(), turnId: 'turn-2', cwd: '/repo', model: 'gpt-5.6-luna' }),
        codexRow.userMessage({ ...at(), text: '第二个问题' }),
        codexRow.tokenCount({ ...at(), total: { input: 250, cached: 60, output: 25 }, last: { input: 150, cached: 40, output: 15 } })
      ]
    }

    /** 子 session_meta、`lead` 行、不含 turn_context 的抄写前缀（时间戳改写）、子自己的一轮（计 65）。 */
    const forkChildRowsWithoutCopiedTurnContext = (params: {
      id: string
      parentId: string
      parentRows: CodexFixtureRow[]
      lead: (at: () => CodexRowBase) => CodexFixtureRow[]
      ownModel: string
    }): CodexFixtureRow[] => {
      const forkedAt = '2026-07-31T13:00:00.000Z'
      const at = codexClock(forkedAt)
      const metaBase = at()
      const lead = params.lead(at)
      const inherited = copiedPrefix(
        params.parentRows.slice(1).filter((row) => row.type !== 'turn_context'),
        { startIso: codexTime(forkedAt, 10_000), firstOrdinal: 1 + lead.length }
      )
      const ownStart = 1 + lead.length + inherited.length
      const own = codexClock(codexTime(forkedAt, 60_000), ownStart)
      return [
        codexRow.threadSpawnMeta({
          ...metaBase, id: params.id, parentId: params.parentId, cwd: '/repo', depth: 1, historyStartOrdinal: ownStart
        }),
        ...lead,
        ...inherited,
        codexRow.turnContext({ ...own(), turnId: 'child-own-turn', cwd: '/repo', model: params.ownModel }),
        codexRow.userMessage({ ...own(), text: '子任务' }),
        codexRow.tokenCount({ ...own(), total: { input: 310, cached: 80, output: 30 }, last: { input: 60, cached: 20, output: 5 } })
      ]
    }

    const isTokenCount = (row: CodexFixtureRow): boolean =>
      row.type === 'event_msg' && (row.payload as { type?: unknown }).type === 'token_count'

    it('分叉副本在任何 turn_context 之前抄写 token_count（副本没有 model）：billingFactKey 仍与父会话相同，合并只计一次（F1b）', () => {
      const parentId = '7f1b0000-0000-4000-8000-000000000024'
      const childId = '7f1b0000-0000-4000-8000-000000000025'
      const parentRows = forkParentRows(parentId)
      const childRows = forkChildRowsWithoutCopiedTurnContext({
        id: childId, parentId, parentRows, lead: () => [], ownModel: 'gpt-5.6-luna'
      })

      const parent = extractCodexTokenAccounting(parentRows as unknown as CodexLine[])
      const child = extractCodexTokenAccounting(childRows as unknown as CodexLine[], 'subagent')
      const copies = child.usageEvents.slice(0, 2)

      expect(childRows.findIndex(isTokenCount))
        .toBeLessThan(childRows.findIndex((row) => row.type === 'turn_context'))
      expect(child.usageEvents).toHaveLength(3)
      expect(copies.map((event) => event.model)).toEqual([undefined, undefined])
      expect(copies.map((event) => event.billingFactKey))
        .toEqual(parent.usageEvents.map((event) => event.billingFactKey))
      const merged = mergeTokenAccountings([parent, child], { auditSourceIds: [parentId, childId] })
      expect(merged.usageEvents).toHaveLength(5)
      // Parent 110 + 165 once; the child adds only its own 65.
      expect(merged.billingTotal).toBe(340)
      expect(merged.conversationOnly).toBe(275)
    })

    it('子 agent 自己的 turn_context 换了 model 之后才出现抄写行：billingFactKey 仍与父会话相同，合并只计一次（F1b）', () => {
      const parentId = '7f1b0000-0000-4000-8000-000000000026'
      const childId = '7f1b0000-0000-4000-8000-000000000027'
      const parentRows = forkParentRows(parentId)
      const childRows = forkChildRowsWithoutCopiedTurnContext({
        id: childId,
        parentId,
        parentRows,
        lead: (at) => [codexRow.turnContext({ ...at(), turnId: 'child-first-turn', cwd: '/repo', model: 'gpt-5.6-sol' })],
        ownModel: 'gpt-5.6-sol'
      })

      const parent = extractCodexTokenAccounting(parentRows as unknown as CodexLine[])
      const child = extractCodexTokenAccounting(childRows as unknown as CodexLine[], 'subagent')
      const copies = child.usageEvents.slice(0, 2)

      expect(childRows.findIndex((row) => row.type === 'turn_context'))
        .toBeLessThan(childRows.findIndex(isTokenCount))
      expect(child.usageEvents).toHaveLength(3)
      expect(parent.usageEvents.map((event) => event.model)).toEqual(['gpt-5.6-luna', 'gpt-5.6-luna'])
      expect(copies.map((event) => event.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-sol'])
      expect(copies.map((event) => event.billingFactKey))
        .toEqual(parent.usageEvents.map((event) => event.billingFactKey))
      const merged = mergeTokenAccountings([parent, child], { auditSourceIds: [parentId, childId] })
      expect(merged.usageEvents).toHaveLength(5)
      expect(merged.billingTotal).toBe(340)
      expect(merged.conversationOnly).toBe(275)
    })

    it('反向：键不含 model 也不能过宽——turnId 相同而单轮或累计签名不同，就是不同的计费事实（F1b）', () => {
      // 真实 token_count 不带 turn_id；这里在 payload 上补一个，专测带 turnId 时的键。
      const oneSnapshot = (params: { id: string; turnId: string; total: CodexFixtureUsage; last: CodexFixtureUsage }) => {
        const at = codexClock('2026-07-31T12:00:00.000Z')
        const meta = codexRow.topLevelMeta({ ...at(), id: params.id, cwd: '/repo' })
        const turn = codexRow.turnContext({ ...at(), turnId: params.turnId, cwd: '/repo', model: 'gpt-5.6-luna' })
        const count = codexRow.tokenCount({ ...at(), total: params.total, last: params.last })
        const withTurnId = { ...count, payload: { ...(count.payload as CodexFixtureRow), turn_id: params.turnId } }
        return extractCodexTokenAccounting([meta, turn, withTurnId] as unknown as CodexLine[])
      }
      const usage = { input: 100, cached: 20, output: 10 }
      const base = oneSnapshot({ id: '7f1b0000-0000-4000-8000-000000000028', turnId: 'turn-7', total: usage, last: usage })
      const otherLast = oneSnapshot({
        id: '7f1b0000-0000-4000-8000-000000000029', turnId: 'turn-7', total: usage, last: { input: 90, cached: 20, output: 10 }
      })
      const otherTotal = oneSnapshot({
        id: '7f1b0000-0000-4000-8000-00000000002a', turnId: 'turn-7', total: { input: 200, cached: 40, output: 20 }, last: usage
      })
      const otherTurn = oneSnapshot({ id: '7f1b0000-0000-4000-8000-00000000002b', turnId: 'turn-8', total: usage, last: usage })
      const keys = [base, otherLast, otherTotal, otherTurn].map((accounting) => accounting.usageEvents[0]?.billingFactKey)

      expect(keys.every((key) => typeof key === 'string')).toBe(true)
      expect(new Set(keys).size).toBe(4)
      expect(mergeTokenAccountings([base, otherLast, otherTotal, otherTurn]).billingTotal).toBe(110 + 100 + 110 + 110)
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

// 键序照《附录-Codex键序普查》，见 __fixtures__/codex-rollout-synthetic.ts；值全部是合成的。
describe('Codex 压缩识别（F1b）', () => {
  const TOP_ID = '7f1b0000-0000-4000-8000-000000000001'
  const REPLAYED_FROM_ID = '7f1b0000-0000-4000-8000-000000000002'
  const CHILD_ID = '7f1b0000-0000-4000-8000-000000000003'
  const START = '2026-09-20T08:00:00.000Z'
  const CWD = '/synthetic/project'

  function writeRollout(rows: CodexFixtureRow[], id = TOP_ID): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-f1b-'))
    const filePath = path.join(dir, `rollout-2026-09-20T08-00-00-${id}.jsonl`)
    fs.writeFileSync(filePath, codexJsonl(rows))
    return filePath
  }

  /** A top-level rollout: one question/answer, then `middle`, then another question/answer. */
  function topLevelRows(middle: (at: () => CodexRowBase) => CodexFixtureRow[]): CodexFixtureRow[] {
    const at = codexClock(START)
    return [
      codexRow.topLevelMeta({ ...at(), id: TOP_ID, cwd: CWD }),
      codexRow.turnContext({ ...at(), turnId: 'turn-1', cwd: CWD, model: 'gpt-5.5-codex' }),
      codexRow.userMessage({ ...at(), text: '第一个问题' }),
      codexRow.assistantMessage({ ...at(), text: '第一个回答' }),
      ...middle(at),
      codexRow.turnContext({ ...at(), turnId: 'turn-2', cwd: CWD, model: 'gpt-5.5-codex' }),
      codexRow.userMessage({ ...at(), text: '第二个问题' }),
      codexRow.assistantMessage({ ...at(), text: '第二个回答' })
    ]
  }

  async function compactCountOf(rows: CodexFixtureRow[]): Promise<number | undefined> {
    return (await buildCodexSessionSummary(writeRollout(rows)))?.compactCount
  }

  it('顶层文件两条 compacted 计 2；消息只带小标记，不带替换历史和摘要正文', async () => {
    const filePath = writeRollout(topLevelRows((at) => [
      codexRow.compacted({ ...at(), message: '第一次压缩的摘要正文', window: 1 }),
      codexRow.userMessage({ ...at(), text: '压缩后继续' }),
      codexRow.assistantMessage({ ...at(), text: '继续回答' }),
      codexRow.compacted({ ...at(), message: '第二次压缩的摘要正文', window: 2 })
    ]))

    const summary = await buildCodexSessionSummary(filePath)
    const raw = await loadCodexRawMessages(filePath)
    const detail = await buildCodexSessionDetail(filePath)

    expect(summary?.compactCount).toBe(2)
    const boundaries = raw.filter((message) => message.type === 'system' && message.subtype === 'compact_boundary')
    expect(boundaries.map((message) => message.data)).toEqual([{ format: 'compacted' }, { format: 'compacted' }])
    expect(boundaries.every((message) => message.message === undefined)).toBe(true)
    const serialized = JSON.stringify(raw)
    expect(serialized).not.toContain('carried-over')
    expect(serialized).not.toContain('摘要正文')
    expect(detail?.compactCount).toBe(2)
    expect(detail?.messages.filter((message) => message.subtype === 'compact_boundary')).toHaveLength(2)
    expect(detail?.messages.every((message) => message.isPreCompact === false)).toBe(true)
  })

  it('compacted、ContextCompaction 与 context_compacted 描述同一次压缩：计 1', async () => {
    const filePath = writeRollout(topLevelRows((at) => [
      codexRow.contextCompactedEvent(at()),
      codexRow.compacted({ ...at(), message: '同一次压缩', window: 1 }),
      codexRow.contextCompactionEvent({ ...at(), threadId: TOP_ID, turnId: 'turn-1', itemId: 'item-compaction-1' })
    ]))

    const summary = await buildCodexSessionSummary(filePath)
    const raw = await loadCodexRawMessages(filePath)

    expect(summary?.compactCount).toBe(1)
    expect(raw.filter((message) => message.subtype === 'compact_boundary').map((message) => message.data))
      .toEqual([{ format: 'compacted' }])
  })

  it('只有新版 response_item.compaction：照数，同文件的 compact 事件不另计', async () => {
    const count = await compactCountOf(topLevelRows((at) => [
      codexRow.compactionItem({ ...at(), id: 'compaction-item-1' }),
      codexRow.contextCompactedEvent(at()),
      codexRow.compactionItem({ ...at(), id: 'compaction-item-2' }),
      codexRow.contextCompactedEvent(at())
    ]))

    expect(count).toBe(2)
  })

  it('compacted 与新版 compaction 同文件：只数 compacted', async () => {
    const count = await compactCountOf(topLevelRows((at) => [
      codexRow.compacted({ ...at(), message: '第一次', window: 1 }),
      codexRow.compactionItem({ ...at(), id: 'compaction-item-1' }),
      codexRow.compacted({ ...at(), message: '第二次', window: 2 })
    ]))

    expect(count).toBe(2)
  })

  it('同一文件里载荷逐字相同的压缩标记只计一次（与体检 oracle 同口径）', async () => {
    const count = await compactCountOf(topLevelRows((at) => {
      const first = codexRow.compacted({ ...at(), message: '重复写入的同一次压缩', window: 1 })
      const repeated = { ...structuredClone(first), ...at() }
      return [first, repeated, codexRow.compacted({ ...at(), message: '另一次压缩', window: 2 })]
    }))
    const itemCount = await compactCountOf(topLevelRows((at) => {
      const item = codexRow.compactionItem({ ...at(), id: 'compaction-item-1' })
      return [item, { ...structuredClone(item), ...at() }]
    }))

    expect(count).toBe(2)
    expect(itemCount).toBe(1)
  })

  it('两种标记都没有时保持原 event_msg 规则；ContextCompaction 一律不计', async () => {
    const eventOnly = await compactCountOf(topLevelRows((at) => [codexRow.contextCompactedEvent(at())]))
    const crossCheckOnly = await compactCountOf(topLevelRows((at) => [
      codexRow.contextCompactionEvent({ ...at(), threadId: TOP_ID, turnId: 'turn-1', itemId: 'item-compaction-1' })
    ]))

    expect(eventOnly).toBe(1)
    expect(crossCheckOnly).toBe(0)
  })

  it('顶层回放文件（两条 session_meta）按文件内标记计，抄来的旧标记也算', async () => {
    const original = codexClock('2026-09-19T08:00:00.000Z')
    const rows = [codexRow.topLevelMeta({ ...codexClock(START)(), id: TOP_ID, cwd: CWD })]
    rows.push(...copiedPrefix([
      codexRow.topLevelMeta({ ...original(), id: REPLAYED_FROM_ID, cwd: CWD }),
      codexRow.userMessage({ ...original(), text: '原会话的问题' }),
      codexRow.assistantMessage({ ...original(), text: '原会话的回答' }),
      codexRow.compacted({ ...original(), message: '原会话的压缩', window: 1 })
    ], { startIso: codexTime(START, 500), firstOrdinal: rows.length }))
    const own = codexClock(codexTime(START, 10_000), rows.length)
    rows.push(
      codexRow.turnContext({ ...own(), turnId: 'turn-replay', cwd: CWD, model: 'gpt-5.5-codex' }),
      codexRow.userMessage({ ...own(), text: '回放后的问题' }),
      codexRow.assistantMessage({ ...own(), text: '回放后的回答' }),
      codexRow.compacted({ ...own(), message: '回放后的压缩', window: 2 })
    )

    const summary = await buildCodexSessionSummary(writeRollout(rows))

    expect(summary).toMatchObject({ lifecycleState: 'replayed', branchParentId: `codex:${REPLAYED_FROM_ID}` })
    expect(summary?.compactCount).toBe(2)
  })

  it('子 agent 文件里的 compacted 不生成顶层 summary，也就不进任何 compactCount', async () => {
    const at = codexClock(START)
    const filePath = writeRollout([
      codexRow.threadSpawnMeta({ ...at(), id: CHILD_ID, parentId: TOP_ID, cwd: CWD, depth: 1, historyStartOrdinal: 1 }),
      codexRow.turnContext({ ...at(), turnId: 'child-turn-1', cwd: CWD, model: 'gpt-5.5-codex' }),
      codexRow.userMessage({ ...at(), text: '子任务' }),
      codexRow.compacted({ ...at(), message: '子 agent 的压缩', window: 1 }),
      codexRow.assistantMessage({ ...at(), text: '子任务完成' })
    ], CHILD_ID)

    const record = await loadCodexSessionRecord(filePath)

    expect(record.summary).toBeNull()
    expect(record.subagent).toMatchObject({ sessionId: CHILD_ID, parentSessionId: TOP_ID, role: 'thread-spawn' })
    expect(await buildCodexSessionDetail(filePath)).toBeNull()
  })
})

describe('parseCodexFile 只按 \\n 分行（F1a）', () => {
  const RAW_LS = Buffer.from([0xe2, 0x80, 0xa8]) // U+2028
  const RAW_PS = Buffer.from([0xe2, 0x80, 0xa9]) // U+2029

  // 外层键序照《附录-Codex键序普查》：{timestamp, ordinal, type, payload}；session_meta 的 payload
  // 用普查里的真实签名（{session_id,id,timestamp,cwd,originator,cli_version,source,thread_source,
  // model_provider,base_instructions,history_mode,context_window}）。response_item / event_msg 的
  // payload 键序附录没有列，照本文件 makeCodexLines。值全部是合成的。
  // 依次是：session_meta、user（含 U+2028）、function_call、function_call_output（含 U+2028）、
  // assistant（含 U+2029）、一条真坏行、一条没写完的尾行（无结尾 \n）。
  function writeLineSeparatorRollout(): string {
    const lines = [
      {
        timestamp: '2026-09-26T02:00:00.000Z',
        ordinal: 0,
        type: 'session_meta',
        payload: {
          session_id: SESSION_ID,
          id: SESSION_ID,
          timestamp: '2026-09-26T01:59:59.000Z',
          cwd: '/Users/test/projects/myapp',
          originator: 'codex_cli_rs',
          cli_version: '0.130.0',
          source: 'cli',
          thread_source: 'user',
          model_provider: 'openai',
          base_instructions: { text: 'synthetic base instructions' },
          history_mode: 'full',
          context_window: 258400
        }
      },
      {
        timestamp: '2026-09-26T02:00:01.000Z',
        ordinal: 1,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一行 第二行' }] }
      },
      {
        timestamp: '2026-09-26T02:00:02.000Z',
        ordinal: 2,
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat notes.txt"}', call_id: 'call_f1a' }
      },
      {
        timestamp: '2026-09-26T02:00:03.000Z',
        ordinal: 3,
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call_f1a', output: '工具输出 第二段' }
      },
      {
        timestamp: '2026-09-26T02:00:04.000Z',
        ordinal: 4,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '段一 段二' }] }
      }
    ]
    const broken = '{"timestamp":"2026-09-26T02:00:05.000Z","ordinal":5,"type":"event_msg","payload":'
    const tail = JSON.stringify({
      timestamp: '2026-09-26T02:00:06.000Z',
      ordinal: 6,
      type: 'event_msg',
      payload: { type: 'agent_message', message: '写到一半', phase: 'commentary' }
    }).slice(0, 80)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-codex-'))
    const fp = path.join(dir, `rollout-2026-09-26T10-00-00-${SESSION_ID}.jsonl`)
    fs.writeFileSync(fp, [...lines.map((line) => JSON.stringify(line)), broken, tail].join('\n'))
    return fp
  }

  it('含原样 U+2028 / U+2029 的 user、工具输出、assistant 记录不再丢', async () => {
    const fp = writeLineSeparatorRollout()
    const bytes = fs.readFileSync(fp)
    expect(bytes.includes(RAW_LS)).toBe(true)
    expect(bytes.includes(RAW_PS)).toBe(true)

    const raw = await loadCodexRawMessages(fp)
    expect(raw.filter((m) => m.type === 'user' && m.message?.content === '第一行 第二行')).toHaveLength(1)
    expect(raw.filter((m) => m.type === 'assistant' && m.message?.content === '段一 段二')).toHaveLength(1)
    expect(JSON.stringify(raw)).toContain('工具输出 第二段')
  })

  it('读流出错（文件不存在）时照旧抛出，由调用方兜底', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-codex-missing-'))
    await expect(loadCodexRawMessages(path.join(dir, `rollout-2026-09-26T10-00-00-${SESSION_ID}.jsonl`)))
      .rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('parseCodexFileWithStats 按记录计数：5 条记录读全，坏行与截断尾行各计一条丢失', async () => {
    const fp = writeLineSeparatorRollout()
    const { lines, ...stats } = await parseCodexFileWithStats(fp)
    expect(lines.map((line) => line.type)).toEqual([
      'session_meta', 'response_item', 'response_item', 'response_item', 'response_item'
    ])
    expect(Object.keys(lines[1])).toEqual(['timestamp', 'ordinal', 'type', 'payload'])
    expect(JSON.stringify(lines[1].payload)).toContain('第一行 第二行')
    expect(JSON.stringify(lines[4].payload)).toContain('段一 段二')
    expect(stats).toEqual({
      nonBlankLines: 7,
      recordsRead: 5,
      badLines: 2,
      recordsLost: 2,
      partialTail: true,
      truncated: false
    })
  })

  it('parseCodexFileWithStats：读流出错时照旧抛出', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-codex-missing-'))
    await expect(parseCodexFileWithStats(path.join(dir, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
