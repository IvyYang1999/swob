import { describe, it, expect } from 'vitest'
import { buildInsights, estimateActiveTime } from './insights'
import { extractCodexTokenAccounting, type CodexLine } from './codex-loader'
import {
  accountCodexUsage,
  accountingFromMutuallyExclusiveUsage,
  accountingFromUsageEvents,
  markExcludedFromRollups,
  mergeTokenAccountings,
  processedTotal,
  tokenUsageFromAccounting,
  unavailableTokenAccounting,
  type UsageEvent
} from './token-accounting'
import type { SessionSummary, Folder } from './types'
import {
  codexClock,
  codexRow,
  codexTime,
  copiedPrefix,
  type CodexFixtureRow
} from './__fixtures__/codex-rollout-synthetic'

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'id-1',
    sessionId: 'sess-1',
    slug: '',
    createdAt: '2025-06-01T10:00:00Z',
    updatedAt: '2025-06-01T12:00:00Z',
    messageCount: 10,
    turnCount: 5,
    compactCount: 0,
    cwds: ['/Users/test/projects/swob'],
    version: '1.0',
    firstUserMessage: 'hello',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '/Users/test/projects/swob',
    filePath: '/tmp/test.jsonl',
    fileSizeBytes: 1000,
    permissionMode: 'default',
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    },
    referencedFiles: [],
    configFiles: [],
    source: 'claude-code',
    ...overrides
  }
}

function makeFolder(overrides: Partial<Folder> = {}): Folder {
  return {
    id: 'folder-1',
    name: '默认文件夹',
    sessionIds: [],
    createdAt: '2025-06-01T10:00:00Z',
    ...overrides
  }
}

function makeTimestampedSession(timestamp: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  const session = makeSession(overrides)
  const accounting = accountingFromMutuallyExclusiveUsage(
    session.source || 'claude-code',
    session.tokenUsage,
    'reported'
  )
  return {
    ...session,
    tokenAccounting: {
      ...accounting,
      usageEvents: accounting.usageEvents.map((event) => ({ ...event, timestamp }))
    }
  }
}

describe('buildInsights', () => {
  describe('空数据', () => {
    it('空 sessions 返回正确的空结构', () => {
      const result = buildInsights([], [])

      expect(result.totalTokens).toBe(0)
      expect(result.totalInputTokens).toBe(0)
      expect(result.totalOutputTokens).toBe(0)
      expect(result.totalSessions).toBe(0)
      expect(result.totalTurns).toBe(0)
      expect(result.bySource).toHaveLength(14)
      expect(result.bySource.map((s) => s.source)).toEqual([
        'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror',
        'antigravity', 'grok', 'pi', 'kimi', 'hermes', 'qoder', 'trae', 'gemini'
      ])
      expect(result.bySource.every(s => s.totalTokens === 0)).toBe(true)
      expect(result.byProject).toHaveLength(0)
      expect(result.byFolder).toHaveLength(0)
      expect(result.byDate).toHaveLength(365)
      expect(result.heatmap).toHaveLength(365)
      expect(result.heatmap.every(h => h.level === 0)).toBe(true)
    })
  })

  describe('按来源统计', () => {
    it('不同来源的 session 分别统计', () => {
      const sessions = [
        makeSession({ sessionId: 's1', source: 'claude-code', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 3 }),
        makeSession({ sessionId: 's2', source: 'claude-code', tokenUsage: { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 4 }),
        makeSession({ sessionId: 's3', source: 'codex', tokenUsage: { inputTokens: 500, outputTokens: 250, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 10 }),
        makeSession({ sessionId: 's4', source: 'cursor', tokenUsage: { inputTokens: 300, outputTokens: 150, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 7 })
      ]
      const result = buildInsights(sessions, [])

      expect(result.bySource[0].source).toBe('claude-code')
      expect(result.bySource[0].totalTokens).toBe(450)
      expect(result.bySource[0].sessionCount).toBe(2)
      expect(result.bySource[0].turnCount).toBe(7)

      expect(result.bySource[1].source).toBe('codex')
      expect(result.bySource[1].totalTokens).toBe(750)
      expect(result.bySource[1].sessionCount).toBe(1)

      expect(result.bySource[2].source).toBe('cursor')
      expect(result.bySource[2].totalTokens).toBe(0)
      expect(result.bySource[2].sessionCount).toBe(1)
      expect(result.bySource[2].tokenDataStatus).toBe('unavailable')
    })

    it('bySource 固定顺序: claude-code, codex, cursor', () => {
      const sessions = [
        makeSession({ sessionId: 's1', source: 'cursor' }),
        makeSession({ sessionId: 's2', source: 'codex' })
      ]
      const result = buildInsights(sessions, [])

      expect(result.bySource[0].source).toBe('claude-code')
      expect(result.bySource[1].source).toBe('codex')
      expect(result.bySource[2].source).toBe('cursor')
    })

    it('bySource label 正确映射', () => {
      const result = buildInsights([], [])
      expect(result.bySource[0].label).toBe('Claude Code')
      expect(result.bySource[1].label).toBe('Codex')
      expect(result.bySource[2].label).toBe('Cursor')
    })

    it('没有 source 的 session 归入 claude-code', () => {
      const sessions = [makeSession({ sessionId: 's1', source: undefined })]
      const result = buildInsights(sessions, [])
      expect(result.bySource[0].sessionCount).toBe(1)
      expect(result.bySource[0].source).toBe('claude-code')
    })
  })

  describe('按项目统计', () => {
    it('从 cwds[0] 最后一级提取项目名', () => {
      const sessions = [
        makeSession({ sessionId: 's1', cwds: ['/Users/test/projects/swob'] }),
        makeSession({ sessionId: 's2', cwds: ['/Users/test/projects/feisou-plugin'] })
      ]
      const result = buildInsights(sessions, [])

      expect(result.byProject.map(p => p.project)).toContain('swob')
      expect(result.byProject.map(p => p.project)).toContain('feisou-plugin')
    })

    it('同一项目的多个 session 合并统计', () => {
      const sessions = [
        makeSession({ sessionId: 's1', cwds: ['/Users/test/projects/swob'], tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
        makeSession({ sessionId: 's2', cwds: ['/Users/test/projects/swob'], tokenUsage: { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const result = buildInsights(sessions, [])

      expect(result.byProject).toHaveLength(1)
      expect(result.byProject[0].totalTokens).toBe(450)
      expect(result.byProject[0].sessionCount).toBe(2)
    })

    it('byProject 按 totalTokens 降序排序', () => {
      const sessions = [
        makeSession({ sessionId: 's1', cwds: ['/a/small'], tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
        makeSession({ sessionId: 's2', cwds: ['/a/big'], tokenUsage: { inputTokens: 9999, outputTokens: 9999, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
        makeSession({ sessionId: 's3', cwds: ['/a/medium'], tokenUsage: { inputTokens: 500, outputTokens: 250, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const result = buildInsights(sessions, [])

      expect(result.byProject[0].project).toBe('big')
      expect(result.byProject[1].project).toBe('medium')
      expect(result.byProject[2].project).toBe('small')
    })

    it('项目记录涉及的 sources 列表', () => {
      const sessions = [
        makeSession({ sessionId: 's1', cwds: ['/a/swob'], source: 'claude-code' }),
        makeSession({ sessionId: 's2', cwds: ['/a/swob'], source: 'cursor' })
      ]
      const result = buildInsights(sessions, [])

      expect(result.byProject[0].sources).toContain('claude-code')
      expect(result.byProject[0].sources).toContain('cursor')
    })

    it('fullPath 保留完整路径', () => {
      const sessions = [
        makeSession({ sessionId: 's1', cwds: ['/Users/test/projects/swob'] })
      ]
      const result = buildInsights(sessions, [])
      expect(result.byProject[0].fullPath).toBe('/Users/test/projects/swob')
    })
  })

  describe('按文件夹统计', () => {
    it('文件夹内的 session 正确聚合', () => {
      const sessions = [
        makeSession({ sessionId: 'a', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 3 }),
        makeSession({ sessionId: 'b', tokenUsage: { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 7 }),
        makeSession({ sessionId: 'c', tokenUsage: { inputTokens: 500, outputTokens: 250, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 2 })
      ]
      const folders = [
        makeFolder({ id: 'f1', name: '工作', sessionIds: ['a', 'b'] }),
        makeFolder({ id: 'f2', name: '个人', sessionIds: ['c'] })
      ]
      const result = buildInsights(sessions, folders)

      const workFolder = result.byFolder.find(f => f.folderName === '工作')!
      expect(workFolder.totalTokens).toBe(450)
      expect(workFolder.sessionCount).toBe(2)
      expect(workFolder.turnCount).toBe(10)

      const personalFolder = result.byFolder.find(f => f.folderName === '个人')!
      expect(personalFolder.totalTokens).toBe(750)
      expect(personalFolder.sessionCount).toBe(1)
    })

    it('byFolder 按 totalTokens 降序排序', () => {
      const sessions = [
        makeSession({ sessionId: 'a', tokenUsage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
        makeSession({ sessionId: 'b', tokenUsage: { inputTokens: 999, outputTokens: 999, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const folders = [
        makeFolder({ id: 'f1', name: '少量', sessionIds: ['a'] }),
        makeFolder({ id: 'f2', name: '大量', sessionIds: ['b'] })
      ]
      const result = buildInsights(sessions, folders)
      expect(result.byFolder[0].folderName).toBe('大量')
      expect(result.byFolder[1].folderName).toBe('少量')
    })

    it('文件夹中不存在的 sessionId 不影响统计', () => {
      const sessions = [
        makeSession({ sessionId: 'a', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const folders = [
        makeFolder({ id: 'f1', name: '测试', sessionIds: ['a', 'not-exist'] })
      ]
      const result = buildInsights(sessions, folders)
      expect(result.byFolder[0].sessionCount).toBe(1)
      expect(result.byFolder[0].totalTokens).toBe(150)
    })
  })

  describe('热力图', () => {
    it('level 分级正确: 0=0, 1=<10k, 2=<50k, 3=<200k, 4=>=200k', () => {
      const today = new Date().toISOString().slice(0, 10)
      const sessions = [
        makeTimestampedSession(`${today}T00:00:00`, { sessionId: 's0', tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
        makeTimestampedSession(`${today}T01:00:00`, { sessionId: 's1', tokenUsage: { inputTokens: 5000, outputTokens: 4999, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
      ]
      const result = buildInsights(sessions, [])
      const todayEntry = result.heatmap.find(h => h.date === today)!
      expect(todayEntry.value).toBe(9999)
      expect(todayEntry.level).toBe(1)
    })

    it('level 2: tokens >= 10k 且 < 50k', () => {
      const today = new Date().toISOString().slice(0, 10)
      const sessions = [
        makeTimestampedSession(`${today}T01:00:00`, { sessionId: 's1', tokenUsage: { inputTokens: 10000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const result = buildInsights(sessions, [])
      const todayEntry = result.heatmap.find(h => h.date === today)!
      expect(todayEntry.level).toBe(2)
    })

    it('level 3: tokens >= 50k 且 < 200k', () => {
      const today = new Date().toISOString().slice(0, 10)
      const sessions = [
        makeTimestampedSession(`${today}T01:00:00`, { sessionId: 's1', tokenUsage: { inputTokens: 50000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const result = buildInsights(sessions, [])
      const todayEntry = result.heatmap.find(h => h.date === today)!
      expect(todayEntry.level).toBe(3)
    })

    it('level 4: tokens >= 200k', () => {
      const today = new Date().toISOString().slice(0, 10)
      const sessions = [
        makeTimestampedSession(`${today}T01:00:00`, { sessionId: 's1', tokenUsage: { inputTokens: 200000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const result = buildInsights(sessions, [])
      const todayEntry = result.heatmap.find(h => h.date === today)!
      expect(todayEntry.level).toBe(4)
    })

    it('没有数据的天 level 为 0', () => {
      const result = buildInsights([], [])
      expect(result.heatmap[0].level).toBe(0)
      expect(result.heatmap[0].value).toBe(0)
    })
  })

  describe('按日期统计', () => {
    it('byDate 覆盖最近 365 天', () => {
      const result = buildInsights([], [])
      expect(result.byDate).toHaveLength(365)

      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const lastDate = result.byDate[364].date
      const y = today.getFullYear()
      const m = String(today.getMonth() + 1).padStart(2, '0')
      const d = String(today.getDate()).padStart(2, '0')
      expect(lastDate).toBe(`${y}-${m}-${d}`)
    })

    it('没有数据的天值全为 0', () => {
      const result = buildInsights([], [])
      const randomDay = result.byDate[100]
      expect(randomDay.totalTokens).toBe(0)
      expect(randomDay.inputTokens).toBe(0)
      expect(randomDay.outputTokens).toBe(0)
      expect(randomDay.sessionCount).toBe(0)
      expect(randomDay.turnCount).toBe(0)
    })

    it('同一天多个 session 合并统计', () => {
      const today = new Date().toISOString().slice(0, 10)
      const sessions = [
        makeTimestampedSession(`${today}T10:00:00`, { sessionId: 's1', tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 3, source: 'claude-code', cwds: ['/a/proj1'] }),
        makeTimestampedSession(`${today}T14:00:00`, { sessionId: 's2', tokenUsage: { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 }, turnCount: 5, source: 'codex', cwds: ['/a/proj2'] })
      ]
      const result = buildInsights(sessions, [])
      const todayStats = result.byDate.find(d => d.date === today)!

      expect(todayStats.totalTokens).toBe(450)
      expect(todayStats.sessionCount).toBe(2)
      expect(todayStats.turnCount).toBe(2)
      expect(todayStats.bySource['claude-code']).toBe(150)
      expect(todayStats.bySource['codex']).toBe(300)
      expect(todayStats.byProject['proj1']).toBe(150)
      expect(todayStats.byProject['proj2']).toBe(300)
    })

    it('按 UsageEvent 时间归属小时和文件夹，不使用 session.updatedAt', () => {
      const today = new Date().toISOString().slice(0, 10)
      const session = makeTimestampedSession(`${today}T03:15:00`, {
        sessionId: 'event-time',
        updatedAt: '2035-01-01T23:00:00Z',
        tokenUsage: { inputTokens: 80, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }
      })
      const result = buildInsights([session], [makeFolder({ id: 'fact-folder', sessionIds: ['event-time'] })])
      const todayStats = result.byDate.find((date) => date.date === today)!

      expect(todayStats.totalTokens).toBe(100)
      expect(todayStats.byFolder['fact-folder']).toBe(100)
      expect(result.hourlyDistribution[3]).toBe(1)
      expect(result.byDate.some((date) => date.date === '2035-01-01' && date.totalTokens > 0)).toBe(false)
    })

    it('缺失事件时间不会伪装成 updatedAt', () => {
      const result = buildInsights([makeSession({
        sessionId: 'unknown-time',
        updatedAt: new Date().toISOString(),
        tokenUsage: { inputTokens: 40, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 0 }
      })], [])

      expect(result.unknownTimeUsage).toEqual({ eventCount: 1, totalTokens: 50 })
      expect(result.byDate.reduce((sum, date) => sum + date.totalTokens, 0)).toBe(0)
      expect(result.activeDays).toBe(0)
    })
  })

  describe('总览统计', () => {
    it('totalTokens = inputTokens + outputTokens', () => {
      const sessions = [
        makeSession({ sessionId: 's1', tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationTokens: 0, cacheReadTokens: 0 } }),
        makeSession({ sessionId: 's2', tokenUsage: { inputTokens: 2000, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0 } })
      ]
      const result = buildInsights(sessions, [])

      expect(result.totalInputTokens).toBe(3000)
      expect(result.totalOutputTokens).toBe(1500)
      expect(result.totalTokens).toBe(4500)
      expect(result.totalSessions).toBe(2)
    })

    it('detection-only 占位只计 detected，不污染 parsed 会话与 turn 分布', () => {
      const parsed = makeSession({ sessionId: 'parsed', turnCount: 7 })
      const detectedOnlyAccounting = unavailableTokenAccounting('hermes', 'no transcript parser')
      const detectedOnly = makeSession({
        sessionId: 'detected-only',
        source: 'hermes',
        messageCount: 0,
        turnCount: 0,
        tokenAccounting: detectedOnlyAccounting,
        tokenUsage: tokenUsageFromAccounting(detectedOnlyAccounting)
      })

      const result = buildInsights([parsed, detectedOnly], [])

      expect(result).toMatchObject({
        totalSessions: 2,
        detectedSessionCount: 2,
        parsedSessionCount: 1,
        usageAvailableSessionCount: 1,
        usageUnavailableSessionCount: 0,
        totalTurns: 7
      })
      expect(result.bySession.map((session) => session.sessionId)).toEqual(['parsed'])
      expect(result.bySource.find((source) => source.source === 'hermes')).toMatchObject({
        sessionCount: 1,
        detectedSessionCount: 1,
        parsedSessionCount: 0,
        usageAvailableSessionCount: 0,
        usageUnavailableSessionCount: 0,
        turnCount: 0
      })
      expect(result.turnCountDistribution.reduce((sum, count) => sum + count, 0)).toBe(1)
    })

    it('【回归】cache 口径互斥、unavailable 不作零值，且 global/project/session 严格对账', () => {
      const claudeAccounting = accountingFromMutuallyExclusiveUsage('claude-code', {
        inputTokens: 100,
        cacheReadTokens: 20,
        cacheCreationTokens: 10,
        outputTokens: 50
      })
      const codexAccounting = accountCodexUsage([{
        kind: 'incremental', inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 100, dedupHint: 'turn-1'
      }])
      const cursorAccounting = unavailableTokenAccounting('cursor', 'fixture has no authoritative usage')
      const syntheticAccounting = markExcludedFromRollups(claudeAccounting)
      const sessions = [
        makeSession({
          sessionId: 'claude', cwds: ['/a/project-a'], tokenAccounting: claudeAccounting,
          tokenUsage: tokenUsageFromAccounting(claudeAccounting)
        }),
        makeSession({
          sessionId: 'codex', source: 'codex', cwds: ['/a/project-b'], tokenAccounting: codexAccounting,
          tokenUsage: tokenUsageFromAccounting(codexAccounting)
        }),
        makeSession({
          sessionId: 'cursor', source: 'cursor', cwds: ['/a/project-c'], tokenAccounting: cursorAccounting,
          tokenUsage: tokenUsageFromAccounting(cursorAccounting)
        }),
        makeSession({
          sessionId: 'synthetic', branchLeafUuid: 'leaf', tokenAccounting: syntheticAccounting,
          tokenUsage: tokenUsageFromAccounting(syntheticAccounting)
        })
      ]
      const result = buildInsights(sessions, [])

      expect(result.totalTokens).toBe(1_280)
      expect(result.totalInputTokens).toBe(1_130)
      expect(result.totalOutputTokens).toBe(150)
      expect(result.totalCacheReadTokens).toBe(620)
      expect(result.totalCacheCreationTokens).toBe(10)
      expect(result.tokenAvailableSessions).toBe(2)
      expect(result.tokenUnavailableSessions).toBe(1)
      expect(result.totalSessions).toBe(3)
      expect(result.reconciliation).toEqual({
        global: 1_280,
        projects: 1_280,
        sessions: 1_280,
        difference: 0,
        ok: true,
        valuation: {
          globalUsd: null,
          sessionsUsd: null,
          uniqueEventsUsd: null,
          difference: 0,
          coverageDifference: 0,
          ok: true
        }
      })
      expect(result.bySession.find((session) => session.sessionId === 'cursor')?.totalTokens).toBeNull()
      expect(result.bySession.some((session) => session.sessionId === 'synthetic')).toBe(false)
    })

    // 键序照《附录-Codex键序普查》（__fixtures__/codex-rollout-synthetic.ts）；值全部是合成的。
    it('【回归】分叉子 agent 的副本没有 model：父 + 子合并账本的估价对账仍闭合（F1h）', () => {
      const parentId = '7f1b0000-0000-4000-8000-0000000000f3'
      const childId = '7f1b0000-0000-4000-8000-0000000000f4'
      const at = codexClock('2026-07-31T12:00:00.000Z')
      // 父会话两轮（gpt-5）：252,500 token，$0.27。
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
      // 分叉子：抄写前缀不含 turn_context（时间戳改写），副本因此没有 model；再是子自己的一轮（60,500 token，$0.0575）。
      const forkedAt = '2026-07-31T13:00:00.000Z'
      const inherited = copiedPrefix(
        parentRows.slice(1).filter((row) => row.type !== 'turn_context'),
        { startIso: codexTime(forkedAt, 10_000), firstOrdinal: 1 }
      )
      const own = codexClock(codexTime(forkedAt, 60_000), 1 + inherited.length)
      const childRows: CodexFixtureRow[] = [
        codexRow.threadSpawnMeta({
          timestamp: forkedAt, ordinal: 0, id: childId, parentId, cwd: '/repo', depth: 1,
          historyStartOrdinal: 1 + inherited.length
        }),
        ...inherited,
        codexRow.turnContext({ ...own(), turnId: 'child-own-turn', cwd: '/repo', model: 'gpt-5' }),
        codexRow.tokenCount({
          ...own(),
          total: { input: 310_000, cached: 80_000, output: 3_000 },
          last: { input: 60_000, cached: 20_000, output: 500 }
        })
      ]
      const parent = extractCodexTokenAccounting(parentRows as unknown as CodexLine[])
      const child = extractCodexTokenAccounting(childRows as unknown as CodexLine[], 'subagent')
      // 与 session-loader 一样，父会话的账本是父 + 子的合并账本，子文件排在父之后。
      const merged = mergeTokenAccountings([parent, child], { auditSourceIds: [parentId, childId] })
      const copies = child.usageEvents.slice(0, 2)

      expect(copies.map((event) => event.model)).toEqual([undefined, undefined])
      // 副本与父不只 billingFactKey 相同，dedupKey 也相同。
      expect(copies.map((event) => event.dedupKey)).toEqual(parent.usageEvents.map((event) => event.dedupKey))

      const result = buildInsights([makeSession({
        sessionId: parentId, source: 'codex', cwds: ['/repo'],
        tokenAccounting: merged, tokenUsage: tokenUsageFromAccounting(merged)
      })], [])

      expect(result.totalTokens).toBe(313_000)
      expect(result.valuation.usd).toBeCloseTo(0.3275, 12)
      expect(result.reconciliation.valuation.uniqueEventsUsd).toBeCloseTo(0.3275, 12)
      expect(result.reconciliation.valuation.difference).toBeLessThan(1e-12)
      expect(result.reconciliation.valuation.coverageDifference).toBeLessThan(1e-12)
      expect(result.reconciliation.valuation.ok).toBe(true)
    })

    // globalUsd / sessionsUsd 先按会话求和再汇总，uniqueEventsUsd 逐条平铺求和：同一批事件，
    // 两种求和次序的末位可以不同。$8,192 以上 1 个 ULP 就超过 1e-12（$10,000 处 = 2^-39）。
    // 金额走 provider-billed 账目，不依赖价目表（F1i）。
    it('【回归】按会话求和与逐条平铺求和只差浮点末位：估价对账仍然 ok（F1i）', () => {
      const billed = (dedupKey: string, usd: number): UsageEvent => ({
        provider: 'claude-code',
        providerFormatVersion: 'fixture-v1',
        dedupKey,
        modelProvenance: 'unknown',
        providerProvenance: 'unknown',
        scope: 'main',
        counterKind: 'incremental',
        provenance: 'reported',
        components: {
          nonCachedInputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0,
          cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0
        },
        semantics: 'anthropic-disjoint',
        reportedCostUsd: usd,
        reportedCostKind: 'provider-billed',
        warnings: []
      })
      const billedSession = (sessionId: string, events: UsageEvent[]): SessionSummary => {
        const accounting = accountingFromUsageEvents('claude-code', events)
        return makeSession({ sessionId, tokenAccounting: accounting, tokenUsage: tokenUsageFromAccounting(accounting) })
      }
      // 前置：这组金额在两种次序下末位确实不同。顺序要固定为 [A, B]，换成 [B, A] 差为 0。
      expect(0 + 10_000 + 0.1 + 0.2).not.toBe(10_000 + (0.1 + 0.2))

      const result = buildInsights([
        billedSession('session-a', [billed('a-1', 10_000)]),
        billedSession('session-b', [billed('b-1', 0.1), billed('b-2', 0.2)])
      ], [])
      const { valuation } = result.reconciliation

      expect(valuation.globalUsd).toBe(10_000 + (0.1 + 0.2))
      expect(valuation.sessionsUsd).toBe(valuation.globalUsd)
      expect(valuation.uniqueEventsUsd).toBe(0 + 10_000 + 0.1 + 0.2)
      // 差正好 1 个 ULP，大于旧的绝对阈值 1e-12：不是漏算或多算，只是求和次序。
      expect(valuation.difference).toBe(2 ** -39)
      expect(valuation.difference).toBeGreaterThan(1e-12)
      expect(valuation.coverageDifference).toBe(0)
      expect(valuation.ok).toBe(true)
    })
  })
})

describe('estimateActiveTime', () => {
  it('空消息返回 0', () => {
    expect(estimateActiveTime([])).toBe(0)
  })

  it('单条消息返回 0', () => {
    expect(estimateActiveTime([
      { timestamp: '2025-06-01T10:00:00Z' } as any
    ])).toBe(0)
  })

  it('正常消息序列累加间隔', () => {
    const messages = [
      { timestamp: '2025-06-01T10:00:00Z' },
      { timestamp: '2025-06-01T10:05:00Z' },
      { timestamp: '2025-06-01T10:10:00Z' },
    ] as any[]
    expect(estimateActiveTime(messages)).toBe(600_000)
  })

  it('超过 30 分钟的间隔被截断', () => {
    const messages = [
      { timestamp: '2025-06-01T10:00:00Z' },
      { timestamp: '2025-06-01T10:05:00Z' },
      { timestamp: '2025-06-01T11:00:00Z' },
      { timestamp: '2025-06-01T11:05:00Z' },
    ] as any[]
    expect(estimateActiveTime(messages)).toBe(600_000)
  })

  it('无序消息也能正确计算', () => {
    const messages = [
      { timestamp: '2025-06-01T10:10:00Z' },
      { timestamp: '2025-06-01T10:00:00Z' },
      { timestamp: '2025-06-01T10:05:00Z' },
    ] as any[]
    expect(estimateActiveTime(messages)).toBe(600_000)
  })
})

describe('buildInsights 时间字段', () => {
  it('totalTime 和 activeDays 正确计算', () => {
    const today = new Date().toISOString().slice(0, 10)
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
    const sessions = [
      makeTimestampedSession(`${today}T10:00:00`, { sessionId: 's1' }),
      makeTimestampedSession(`${yesterday}T10:00:00`, { sessionId: 's2' }),
    ]
    const sessionTimes = new Map<string, number>()
    sessionTimes.set('s1', 600_000)
    sessionTimes.set('s2', 1_800_000)
    const result = buildInsights(sessions, [], sessionTimes)

    expect(result.totalTime).toBe(2_400_000)
    expect(result.activeDays).toBe(2)
  })

  it('byDate 包含 totalTime 和 byProjectTime', () => {
    const today = new Date().toISOString().slice(0, 10)
    const sessions = [
      makeTimestampedSession(`${today}T10:00:00`, { sessionId: 's1', cwds: ['/a/swob'] }),
    ]
    const sessionTimes = new Map<string, number>()
    sessionTimes.set('s1', 600_000)
    const result = buildInsights(sessions, [], sessionTimes)
    const todayStats = result.byDate.find(d => d.date === today)!

    expect(todayStats.totalTime).toBe(600_000)
    expect(todayStats.byProjectTime['swob']).toBe(600_000)
  })

  it('空 sessions totalTime 为 0, activeDays 为 0', () => {
    const result = buildInsights([], [])
    expect(result.totalTime).toBe(0)
    expect(result.activeDays).toBe(0)
  })
})

// 分叉子 agent 抄写的 token_count 与父会话同一计费事实（F1b ④）。usageFactsForSession 与审计行
// 一一对应、含副本；byModel 和按日、热力图、小时分布、未知时间这几项都只能算 token 合计所算的
// 那一条，合计才对得上 totalTokens（F1i）。
// 键序照《附录-Codex键序普查》（__fixtures__/codex-rollout-synthetic.ts）；值全部是合成的。
describe('buildInsights 按模型与按日聚合只算计费归属（F1i）', () => {
  const PARENT_ID = '7f1b0000-0000-4000-8000-0000000000f5'
  const CHILD_ID = '7f1b0000-0000-4000-8000-0000000000f6'
  // byDate 与 heatmap 只覆盖最近 365 天：取两天前，用例不随日期过期。
  const START = new Date(Date.now() - 2 * 86_400_000).toISOString()
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

  /**
   * 父两轮 gpt-5（252,500 token）+ 分叉子：两条抄写的副本（252,500 token）与子自己一轮 gpt-5
   * （60,500 token）。copyModel 是子在抄写前写下的 turn_context 的 model，没有这一行时副本没有
   * model。父会话的账本是父 + 子的合并账本，子文件排在父之后，与 session-loader 一致。
   */
  function forkedSession(copyModel?: string): SessionSummary {
    const at = codexClock(START)
    const parentRows: CodexFixtureRow[] = [
      codexRow.topLevelMeta({ ...at(), id: PARENT_ID, cwd: '/repo' }),
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
    const forkedAt = codexTime(START, 3_600_000)
    const child = codexClock(forkedAt)
    const meta = child()
    const leading = copyModel
      ? [codexRow.turnContext({ ...child(), turnId: 'child-first-turn', cwd: '/repo', model: copyModel })]
      : []
    const inherited = copiedPrefix(
      parentRows.slice(1).filter((row) => row.type !== 'turn_context'),
      { startIso: codexTime(forkedAt, 10_000), firstOrdinal: 1 + leading.length }
    )
    const ownStart = 1 + leading.length + inherited.length
    const own = codexClock(codexTime(forkedAt, 60_000), ownStart)
    const childRows: CodexFixtureRow[] = [
      codexRow.threadSpawnMeta({
        ...meta, id: CHILD_ID, parentId: PARENT_ID, cwd: '/repo', depth: 1, historyStartOrdinal: ownStart
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
    const merged = mergeTokenAccountings([
      extractCodexTokenAccounting(parentRows as unknown as CodexLine[]),
      extractCodexTokenAccounting(childRows as unknown as CodexLine[], 'subagent')
    ], { auditSourceIds: [PARENT_ID, CHILD_ID] })
    return makeSession({
      sessionId: PARENT_ID, source: 'codex', cwds: ['/repo'],
      tokenAccounting: merged, tokenUsage: tokenUsageFromAccounting(merged)
    })
  }

  it.each([
    ['副本没有 model（改前 byModel 就相等，byDate 多算）', undefined],
    ['副本带同一个 model', 'gpt-5'],
    ['副本带子 agent 的另一个 model', 'gpt-5.4']
  ])('%s：byModel、byDate、热力图与小时分布的合计都等于 totalTokens', (_case, copyModel) => {
    const session = forkedSession(copyModel)
    const events = session.tokenAccounting!.usageEvents
    // 前置：审计行 5 条共 565,500 token（副本 252,500），副本带着 copyModel。
    expect(events.map((event) => event.model)).toEqual(['gpt-5', 'gpt-5', copyModel, copyModel, 'gpt-5'])
    expect(sum(events.map((event) => processedTotal(event.components)))).toBe(565_500)

    const result = buildInsights([session], [])

    expect(result.totalTokens).toBe(313_000)
    expect(result.byModel).toEqual([{ model: 'gpt-5', totalTokens: 313_000, sessionCount: 1 }])
    expect(sum(result.byModel.map((model) => model.totalTokens))).toBe(result.totalTokens)
    expect(sum(result.byDate.map((date) => date.totalTokens))).toBe(result.totalTokens)
    expect(sum(result.heatmap.map((day) => day.value))).toBe(result.totalTokens)
    expect(result.unknownTimeUsage).toEqual({ eventCount: 0, totalTokens: 0 })
    // 三次调用：父两轮与子自己一轮。
    expect(sum(result.hourlyDistribution)).toBe(3)
  })

  it('副本没有时间戳：未知时间用量也只算归属', () => {
    const call = (scope: 'main' | 'subagent') => accountCodexUsage([{
      kind: 'incremental', model: 'gpt-5', providerRaw: 'openai', inputTokens: 1_000, outputTokens: 100,
      dedupHint: `untimed-${scope}`, billingFactKey: 'untimed-fact'
    }], scope)
    const merged = mergeTokenAccountings([call('main'), call('subagent')])
    expect(merged.usageEvents).toHaveLength(2)

    const result = buildInsights([makeSession({
      sessionId: 'untimed', source: 'codex', tokenAccounting: merged, tokenUsage: tokenUsageFromAccounting(merged)
    })], [])

    expect(result.totalTokens).toBe(1_100)
    expect(result.unknownTimeUsage).toEqual({ eventCount: 1, totalTokens: 1_100 })
    expect(result.byModel).toEqual([{ model: 'gpt-5', totalTokens: 1_100, sessionCount: 1 }])
  })
})
