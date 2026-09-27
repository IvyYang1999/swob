import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractCodexTokenAccounting, type CodexLine } from './codex-loader'
import { generateInsightsReport } from './session-insights'
import { mergeTokenAccountings, tokenUsageFromAccounting } from './token-accounting'
import type { SessionSummary } from './types'
import {
  codexClock,
  codexJsonl,
  codexRow,
  codexTime,
  copiedPrefix,
  type CodexFixtureRow
} from './__fixtures__/codex-rollout-synthetic'

// 洞察报告的 topModels 汇总各场会话审计的按模型拆分。分叉子 agent 抄写的 token_count 与父会话
// 同一计费事实（F1b ④），各模型行之和不能超过报告的总估价（F1i）。
// 键序照《附录-Codex键序普查》（__fixtures__/codex-rollout-synthetic.ts）；值全部是合成的。
describe('洞察报告 topModels 只算计费归属（F1i）', () => {
  it('分叉副本带子 agent 的另一个 model：topModels 只有父的 model，各行估价之和 = 总估价', async () => {
    const parentId = '7f1b0000-0000-4000-8000-0000000000f9'
    const childId = '7f1b0000-0000-4000-8000-0000000000fa'
    // 父两轮 gpt-5（252,500 token，$0.27）。
    const at = codexClock('2026-07-31T12:00:00.000Z')
    const parentRows: CodexFixtureRow[] = [
      codexRow.topLevelMeta({ ...at(), id: parentId, cwd: '/repo' }),
      codexRow.turnContext({ ...at(), turnId: 'turn-1', cwd: '/repo', model: 'gpt-5' }),
      codexRow.tokenCount({
        ...at(),
        total: { input: 100_000, cached: 20_000, output: 1_000 },
        last: { input: 100_000, cached: 20_000, output: 1_000 }
      }),
      codexRow.turnContext({ ...at(), turnId: 'turn-2', cwd: '/repo', model: 'gpt-5' }),
      codexRow.tokenCount({
        ...at(),
        total: { input: 250_000, cached: 60_000, output: 2_500 },
        last: { input: 150_000, cached: 40_000, output: 1_500 }
      })
    ]
    // 分叉子先写下自己的 turn_context（gpt-5.4），再抄写父的前缀，两条副本于是带 gpt-5.4；
    // 最后是子自己一轮 gpt-5（60,500 token，$0.0575）。
    const forkedAt = '2026-07-31T13:00:00.000Z'
    const child = codexClock(forkedAt)
    const meta = child()
    const leading = [codexRow.turnContext({ ...child(), turnId: 'child-first-turn', cwd: '/repo', model: 'gpt-5.4' })]
    const inherited = copiedPrefix(
      parentRows.slice(1).filter((row) => row.type !== 'turn_context'),
      { startIso: codexTime(forkedAt, 10_000), firstOrdinal: 1 + leading.length }
    )
    const ownStart = 1 + leading.length + inherited.length
    const own = codexClock(codexTime(forkedAt, 60_000), ownStart)
    const childRows: CodexFixtureRow[] = [
      codexRow.threadSpawnMeta({
        ...meta, id: childId, parentId, cwd: '/repo', depth: 1, historyStartOrdinal: ownStart
      }),
      ...leading,
      ...inherited,
      codexRow.turnContext({ ...own(), turnId: 'child-own-turn', cwd: '/repo', model: 'gpt-5' }),
      codexRow.tokenCount({
        ...own(),
        total: { input: 310_000, cached: 80_000, output: 3_000 },
        last: { input: 60_000, cached: 20_000, output: 500 }
      })
    ]
    // 与 session-loader 一样：父会话的账本是父 + 子的合并账本，子文件排在父之后。
    const merged = mergeTokenAccountings([
      extractCodexTokenAccounting(parentRows as unknown as CodexLine[]),
      extractCodexTokenAccounting(childRows as unknown as CodexLine[], 'subagent')
    ], { auditSourceIds: [parentId, childId] })

    // 报告只审计读得到记录的会话文件：把父的 rollout 写进测试沙箱的临时目录（TMPDIR）。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-session-insights-'))
    try {
      const filePath = path.join(dir, 'rollout.jsonl')
      fs.writeFileSync(filePath, `${codexJsonl(parentRows)}\n`)
      const session: SessionSummary = {
        id: parentId,
        sessionId: parentId,
        slug: '',
        createdAt: '2026-07-31T12:00:00.000Z',
        updatedAt: '2026-07-31T13:01:02.000Z',
        messageCount: 10,
        turnCount: 3,
        compactCount: 0,
        cwds: ['/repo'],
        version: '0.0.0-synthetic',
        firstUserMessage: 'fixture',
        toolUsage: {},
        skillInvocations: [],
        projectPath: '/repo',
        filePath,
        fileSizeBytes: fs.statSync(filePath).size,
        userImages: [],
        pastedImageCount: 0,
        tokenUsage: tokenUsageFromAccounting(merged),
        tokenAccounting: merged,
        referencedFiles: [],
        configFiles: [],
        source: 'codex'
      }

      const report = await generateInsightsReport([session])
      const rowsUsd = report.topModels.reduce((sum, row) => sum + (row.valuation.usd ?? 0), 0)

      expect(report.totalSessions).toBe(1)
      expect(report.valuation.usd).toBeCloseTo(0.3275, 12)
      expect(rowsUsd).toBeCloseTo(report.valuation.usd!, 12)
      expect(report.topModels.map(({ model, turns }) => ({ model, turns }))).toEqual([{ model: 'gpt-5', turns: 3 }])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
