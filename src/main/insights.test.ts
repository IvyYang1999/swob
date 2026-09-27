import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildInsights, estimateActiveTime, valuationReconciliationVerdict } from './insights'
import { extractCodexTokenAccounting, type CodexLine } from './codex-loader'
import {
  accountClaudeUsage,
  accountCodexUsage,
  accountingForSession,
  assignCrossSessionUsageOwners,
  accountingFromMutuallyExclusiveUsage,
  accountingFromUsageEvents,
  markExcludedFromRollups,
  mergeTokenAccountings,
  processedTotal,
  tokenUsageFromAccounting,
  unavailableTokenAccounting,
  type UsageEvent
} from './token-accounting'
import type { SessionSummary, Folder, RawJsonlMessage } from './types'
import { localActivityDay } from './activity-time'
import { closeUsageFactStore, synchronizeUsageFacts, usageFactsForSession } from './usage-fact-store'
import { sessionHasParsedTranscript } from './session-provider-outcome'
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
        crossSessionDuplicateFacts: 0,
        crossSessionDuplicateTokens: 0,
        difference: 0,
        ok: true,
        valuation: {
          globalUsd: null,
          sessionsUsd: null,
          uniqueEventsUsd: null,
          crossSessionDuplicateUsd: 0,
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

// 同一计费事实出现在两场会话里（续接、分叉的转录会抄写另一场已记下的调用）。usage-facts 与 Insights 页
// 按 billing_fact_id 全局只算一次，取 billing_rank 排第一的那份（作用域 main → subagent → 其他；
// 有时间先于无时间；occurred_at、event_id 按原串升序）。CLI 的全局聚合与之同口径，bySession 仍逐会话（F1j）。
// 金额走 provider-billed 账目，不依赖价目表；时间取本地三天前起，落在 byDate 的 365 天窗口里。
describe('buildInsights 跨会话同一计费事实全局只计一次（F1j）', () => {
  const base = new Date()
  base.setDate(base.getDate() - 3)
  base.setHours(10, 0, 0, 0)
  const at = (hours: number): string => new Date(base.getTime() + hours * 3_600_000).toISOString()
  const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)
  const dayOf = (timestamp: string): string => localActivityDay(timestamp)!

  interface CallSpec {
    id: string
    usd: number
    input: number
    cacheRead?: number
    cacheWrite?: number
    output?: number
    model?: string
    scope?: UsageEvent['scope']
    timestamp?: string
  }

  /** 一条 Claude 调用：billingFactKey 与 dedupKey 都是 claude:message:<id>，与带 id 的 Claude 行一致。 */
  function call(spec: CallSpec): UsageEvent {
    const key = `claude:message:${spec.id}`
    return {
      provider: 'claude-code',
      providerFormatVersion: 'fixture-v1',
      dedupKey: key,
      billingFactKey: key,
      ...(spec.timestamp ? { timestamp: spec.timestamp } : {}),
      ...(spec.model ? { modelRaw: spec.model, modelCanonical: spec.model } : {}),
      modelProvenance: spec.model ? 'response' : 'unknown',
      providerProvenance: 'unknown',
      scope: spec.scope || 'main',
      counterKind: 'incremental',
      provenance: 'reported',
      components: {
        nonCachedInputTokens: spec.input, cacheReadTokens: spec.cacheRead || 0, cacheWriteTokens: spec.cacheWrite || 0,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: spec.output || 0
      },
      semantics: 'anthropic-disjoint',
      reportedCostUsd: spec.usd,
      reportedCostKind: 'provider-billed',
      warnings: []
    }
  }

  function ledgerSession(sessionId: string, project: string, events: UsageEvent[]): SessionSummary {
    const accounting = accountingFromUsageEvents('claude-code', events)
    return makeSession({
      sessionId, cwds: [project], projectPath: project,
      tokenAccounting: accounting, tokenUsage: tokenUsageFromAccounting(accounting)
    })
  }

  const eventIdOf = (session: SessionSummary): string => usageFactsForSession(session)[0].eventId
  const byPath = <T extends { fullPath: string }>(rows: T[]): Record<string, T> =>
    Object.fromEntries(rows.map((row) => [row.fullPath, row]))

  // 共享的那条事实 1,800 token、$2；B 的一份更早，按 billing_rank 胜出，A 的一份落选。
  // A 另有一条 haiku（180 token、$0.5），B 另有一条 opus（360 token、$1），落在第二天。
  function sharedFactSessions(): SessionSummary[] {
    const shared = { id: 'shared', usd: 2, input: 1_000, cacheRead: 200, cacheWrite: 100, output: 500, model: 'claude-sonnet-4-5' }
    return [
      ledgerSession('dup-a', '/dup/a', [
        call({ id: 'a-own', usd: 0.5, input: 100, cacheRead: 20, cacheWrite: 10, output: 50, model: 'claude-haiku-4-5', timestamp: at(0) }),
        call({ ...shared, timestamp: at(2) })
      ]),
      ledgerSession('dup-b', '/dup/b', [
        call({ id: 'b-own', usd: 1, input: 300, output: 60, model: 'claude-opus-4-1', timestamp: at(24) }),
        call({ ...shared, timestamp: at(1) })
      ])
    ]
  }
  const sharedFactFolders = [
    makeFolder({ id: 'fa', name: 'A', sessionIds: ['dup-a'] }),
    makeFolder({ id: 'fb', name: 'B', sessionIds: ['dup-b'] })
  ]

  it('两场会话共享同一条 main 事实：全局各项只计一次，归属胜出的会话；bySession 各计一次', () => {
    const result = buildInsights(sharedFactSessions(), sharedFactFolders)

    // 合计：180 + 360 + 1,800（只算 B 的一份）。
    expect(result.totalTokens).toBe(2_340)
    expect(result.conversationOnlyTokens).toBe(2_340)
    expect(result.totalInputTokens).toBe(130 + 300 + 1_300)
    expect(result.totalOutputTokens).toBe(50 + 60 + 500)
    expect(result.totalCacheReadTokens).toBe(220)
    expect(result.totalCacheCreationTokens).toBe(110)
    expect(result.valuation.usd).toBe(3.5)
    expect(result.bySource.find((source) => source.source === 'claude-code')).toMatchObject({
      totalTokens: 2_340, inputTokens: 1_730, outputTokens: 610, sessionCount: 2
    })
    const projects = byPath(result.byProject)
    expect(projects['/dup/a']).toMatchObject({ totalTokens: 180, inputTokens: 130, outputTokens: 50, sessionCount: 1 })
    expect(projects['/dup/b']).toMatchObject({ totalTokens: 2_160, inputTokens: 1_600, outputTokens: 560, sessionCount: 1 })
    expect(sum(result.byProject.map((project) => project.totalTokens))).toBe(result.totalTokens)
    expect(result.byFolder.map(({ folderId, totalTokens, inputTokens, outputTokens }) => ({ folderId, totalTokens, inputTokens, outputTokens })))
      .toEqual([
        { folderId: 'fb', totalTokens: 2_160, inputTokens: 1_600, outputTokens: 560 },
        { folderId: 'fa', totalTokens: 180, inputTokens: 130, outputTokens: 50 }
      ])
    // A 的 sonnet 调用全部落选：sonnet 只算 B 的一份，也只数 B 一场。
    expect(result.byModel).toEqual([
      { model: 'claude-sonnet-4-5', totalTokens: 1_800, sessionCount: 1 },
      { model: 'claude-opus-4-1', totalTokens: 360, sessionCount: 1 },
      { model: 'claude-haiku-4-5', totalTokens: 180, sessionCount: 1 }
    ])

    // 按日：A 的一份（第一天 12 点）不计，B 的一份（第一天 11 点）计给 B。
    const firstDay = result.byDate.find((date) => date.date === dayOf(at(0)))!
    const secondDay = result.byDate.find((date) => date.date === dayOf(at(24)))!
    expect(firstDay).toMatchObject({
      totalTokens: 1_980, inputTokens: 1_430, outputTokens: 550, sessionCount: 2, turnCount: 2,
      bySource: { 'claude-code': 1_980 }, byProject: { a: 180, b: 1_800 }, byFolder: { fa: 180, fb: 1_800 }
    })
    expect(secondDay).toMatchObject({
      totalTokens: 360, inputTokens: 300, outputTokens: 60, sessionCount: 1, turnCount: 1,
      bySource: { 'claude-code': 360 }, byProject: { b: 360 }, byFolder: { fb: 360 }
    })
    expect(result.unknownTimeUsage).toEqual({ eventCount: 0, totalTokens: 0 })
    expect(sum(result.byDate.map((date) => date.totalTokens))).toBe(result.totalTokens)
    expect(sum(result.heatmap.map((day) => day.value))).toBe(result.totalTokens)
    const hourly = new Array(24).fill(0) as number[]
    for (const timestamp of [at(0), at(1), at(24)]) hourly[new Date(timestamp).getHours()]++
    expect(result.hourlyDistribution).toEqual(hourly)
    expect(result.activeDays).toBe(2)

    // 逐会话不变：两场各自带着那一份。
    expect(result.bySession.map(({ sessionId, totalTokens, conversationOnlyTokens, valuation }) => ({
      sessionId, totalTokens, conversationOnlyTokens, usd: valuation.usd
    }))).toEqual([
      { sessionId: 'dup-a', totalTokens: 1_980, conversationOnlyTokens: 1_980, usd: 2.5 },
      { sessionId: 'dup-b', totalTokens: 2_160, conversationOnlyTokens: 2_160, usd: 3 }
    ])

    // 对账：Σ bySession 比合计多出的正是落选的那一份，三个 duplicate 字段报出它，两个 ok 都是 true。
    expect(result.reconciliation).toEqual({
      global: 2_340,
      projects: 2_340,
      sessions: 4_140,
      crossSessionDuplicateFacts: 1,
      crossSessionDuplicateTokens: 1_800,
      difference: 0,
      ok: true,
      valuation: {
        globalUsd: 3.5,
        sessionsUsd: 5.5,
        uniqueEventsUsd: 3.5,
        crossSessionDuplicateUsd: 2,
        difference: 0,
        coverageDifference: 0,
        ok: true
      }
    })
  })

  // A、B 各有同一条事实的一份：A 的 1,000 token、$1，B 的 2,000 token、$2。每一例只让一个排序键起作用，
  // 胜出的一份与会话顺序无关；前置断言写明 event_id 的先后，保证换掉那个键就会选到另一份。
  const RAW_INSTANT = at(30).replace(/\.\d{3}Z$/, '')
  it.each([
    ['作用域：main 胜过更早的 subagent 副本', 'rank-scope',
      { a: { scope: 'sidechain' as const, timestamp: at(0) }, b: { timestamp: at(1) } }, 'b', null, null],
    // scopeRank：main 0、subagent 1、其余 2。sidechain 与 subagent 同属 subagent 一档，档内看时间。两份都不是
    // main，conversationOnly 与哪份胜出无关，恒为 0（覆盖默认的「胜者即 conversationOnly」）。「subagent 先于
    // 其他」那一档原先借 'inherited' 造：F1m 起 inherited 副本不再参与竞争（见下一条用例），这一档改由
    // billing-identity.test.ts 的纯函数与账本 SQL 对拍守。
    ['作用域：sidechain 与 subagent 同档，更早的一份胜出', 'rank-scope-subagent',
      { a: { scope: 'subagent' as const, timestamp: at(1) }, b: { scope: 'sidechain' as const, timestamp: at(0) } }, 'b', null, 0],
    ['时间：更早的一份胜出', 'rank-time', { a: { timestamp: at(1) }, b: { timestamp: at(0) } }, 'b', 'a', null],
    ['NULL：有时间的一份胜过没有时间的', 'rank-null', { a: {}, b: { timestamp: at(1) } }, 'b', null, null],
    ['event_id：同一时间取 event_id 小的', 'rank-event-id', { a: { timestamp: at(1) }, b: { timestamp: at(1) } }, 'b', 'b', null],
    ['时间按原串比较：同一时刻 .000Z 排在 Z 前', 'rank-raw-string',
      { a: { timestamp: `${RAW_INSTANT}.000Z` }, b: { timestamp: `${RAW_INSTANT}Z` } }, 'a', 'b', null],
    // 逐字节 '+'（0x2B）在 '-'（0x2D）前；localeCompare 反过来。
    ['时间逐字节比较，不用 localeCompare：同一时刻 +00:00 排在 -00:00 前', 'rank-offset',
      { a: { timestamp: `${RAW_INSTANT}+00:00` }, b: { timestamp: `${RAW_INSTANT}-00:00` } }, 'a', null, null]
  ] as const)('两份金额不同（%s）：两种会话顺序都取 billing_rank 排第一的那份', (_name, key, copies, winner, smallerEventId, conversationOnlyOverride) => {
    const a = ledgerSession(`${key}-a`, '/rank/a', [call({ id: key, usd: 1, input: 1_000, ...copies.a })])
    const b = ledgerSession(`${key}-b`, '/rank/b', [call({ id: key, usd: 2, input: 2_000, ...copies.b })])
    if (smallerEventId) {
      const [smaller, larger] = smallerEventId === 'a' ? [a, b] : [b, a]
      expect(eventIdOf(smaller) < eventIdOf(larger)).toBe(true)
    }
    const expected = winner === 'a'
      ? { totalTokens: 1_000, usd: 1, projects: { '/rank/a': 1_000, '/rank/b': 0 } }
      : { totalTokens: 2_000, usd: 2, projects: { '/rank/a': 0, '/rank/b': 2_000 } }
    const expectedConversationOnly = conversationOnlyOverride ?? expected.totalTokens

    for (const order of [[a, b], [b, a]]) {
      const result = buildInsights(order, [])
      expect(result.totalTokens).toBe(expected.totalTokens)
      // 胜出的一份多数是 main：不在 conversationOnly 里的落选份不能从中再扣。作用域-subagent 那一档
      // 两份都不是 main，见 conversationOnlyOverride。
      expect(result.conversationOnlyTokens).toBe(expectedConversationOnly)
      expect(result.valuation.usd).toBe(expected.usd)
      expect(Object.fromEntries(result.byProject.map((project) => [project.fullPath, project.totalTokens])))
        .toEqual(expected.projects)
      expect(Object.fromEntries(result.bySession.map((session) => [session.sessionId, session.totalTokens])))
        .toEqual({ [`${key}-a`]: 1_000, [`${key}-b`]: 2_000 })
      // 落选的是另一份：两份合计 3,000 token、$3。
      expect(result.reconciliation).toMatchObject({
        crossSessionDuplicateFacts: 1,
        crossSessionDuplicateTokens: 3_000 - expected.totalTokens,
        ok: true,
        valuation: { crossSessionDuplicateUsd: 3 - expected.usd, ok: true }
      })
    }
  })

  // F1m：加载层把一份副本标成 inherited（它的计费事实记在别的会话上），它就不再是本会话的 owner，
  // 也不参与跨会话竞争；哪怕没有 inheritedFrom，也按 inherited 处理（uniqueBillingEvents 跳过它）。
  it('inherited 副本不参与跨会话竞争：全局只算另一份，它所在会话的账不含它', () => {
    const a = ledgerSession('inherited-a', '/inherited/a', [call({ id: 'inherited-shared', usd: 1, input: 1_000, scope: 'inherited', timestamp: at(0) })])
    const b = ledgerSession('inherited-b', '/inherited/b', [call({ id: 'inherited-shared', usd: 2, input: 2_000, scope: 'subagent', timestamp: at(1) })])
    for (const order of [[a, b], [b, a]]) {
      const result = buildInsights(order, [])
      expect(result.totalTokens).toBe(2_000)
      expect(result.valuation.usd).toBe(2)
      expect(Object.fromEntries(result.byProject.map((project) => [project.fullPath, project.totalTokens])))
        .toEqual({ '/inherited/a': 0, '/inherited/b': 2_000 })
      expect(Object.fromEntries(result.bySession.map((session) => [session.sessionId, session.totalTokens])))
        .toEqual({ 'inherited-a': 0, 'inherited-b': 2_000 })
      expect(result.reconciliation).toMatchObject({
        crossSessionDuplicateFacts: 0, crossSessionDuplicateTokens: 0, ok: true,
        valuation: { crossSessionDuplicateUsd: 0, ok: true }
      })
    }
  })

  // 候选范围只看 sessionHasParsedTranscript：sessionLedgers 对未解析的会话强制
  // owners = []（哪怕它的 tokenAccounting 意外带着事件），所以它既不会赢也不会
  // 让另一份落选；已解析且可用的会话才进入 billing_rank 竞争（F1j P2-1 a）。
  it('未解析的会话即使携带同一计费键的事件，也不进入跨会话去重竞争', () => {
    const shared = { id: 'range-shared', usd: 2, input: 1_000, output: 200 }
    const parsedSession = ledgerSession('range-parsed', '/range/parsed', [call({ ...shared, timestamp: at(1) })])
    const unparsedAccounting = accountingFromUsageEvents('claude-code', [call({ ...shared, timestamp: at(0) })])
    const unparsedSession: SessionSummary = {
      ...makeSession({ sessionId: 'range-unparsed', cwds: ['/range/unparsed'], projectPath: '/range/unparsed' }),
      isManifestOnly: true,
      messageCount: 0,
      tokenAccounting: unparsedAccounting,
      tokenUsage: tokenUsageFromAccounting(unparsedAccounting)
    }
    expect(sessionHasParsedTranscript(unparsedSession)).toBe(false)

    for (const order of [[parsedSession, unparsedSession], [unparsedSession, parsedSession]]) {
      const result = buildInsights(order, [])
      // 未解析的会话从未进入 winners 竞争：不产生任何落选，也不出现在 bySession
      // （bySession 只收 parsed 的会话），它的事件对总量的贡献是 0，不是「胜出」。
      expect(result.reconciliation).toMatchObject({ crossSessionDuplicateFacts: 0, crossSessionDuplicateTokens: 0 })
      expect(result.bySession.map((session) => session.sessionId)).toEqual(['range-parsed'])
      expect(result.bySession[0].totalTokens).toBe(1_200)
      expect(result.totalTokens).toBe(1_200)
    }
  })

  it('两场会话共用同一个账本对象：每条事实只扣落选会话的那一份（按会话与下标记，不按事件对象）', () => {
    const ledger = accountingFromUsageEvents('claude-code', [
      call({ id: 'shared-ledger-1', usd: 1, input: 1_000, timestamp: at(0) }),
      call({ id: 'shared-ledger-2', usd: 2, input: 2_000, timestamp: at(0) })
    ])
    const sessions = ['shared-1', 'shared-2'].map((sessionId) => makeSession({
      sessionId, cwds: ['/shared'], tokenAccounting: ledger, tokenUsage: tokenUsageFromAccounting(ledger)
    }))

    const result = buildInsights(sessions, [])

    expect(result.totalTokens).toBe(3_000)
    expect(result.valuation.usd).toBe(3)
    expect(result.byProject).toMatchObject([{ fullPath: '/shared', totalTokens: 3_000, sessionCount: 2 }])
    expect(sum(result.byDate.map((date) => date.totalTokens))).toBe(3_000)
    expect(result.bySession.map((session) => session.totalTokens)).toEqual([3_000, 3_000])
    // 两条事实各落选一份；按对象记会把两份都扣掉，合计变成 0、重复记成 4，对账却照样闭合。
    expect(result.reconciliation).toMatchObject({
      crossSessionDuplicateFacts: 2,
      crossSessionDuplicateTokens: 3_000,
      ok: true,
      valuation: { crossSessionDuplicateUsd: 3, ok: true }
    })
  })

  it('落选的一份没有时间戳：未知时间用量不算它，byDate 合计 + 未知时间 = totalTokens', () => {
    const copy = { id: 'untimed-shared', usd: 2, input: 1_000, output: 100 }
    // A 的一份没有时间（NULL 排后），落选；B 的一份胜出，计在它的日期上。
    const result = buildInsights([
      ledgerSession('untimed-a', '/untimed/a', [call(copy)]),
      ledgerSession('untimed-b', '/untimed/b', [call({ ...copy, timestamp: at(1) })])
    ], [])

    expect(result.totalTokens).toBe(1_100)
    expect(result.unknownTimeUsage).toEqual({ eventCount: 0, totalTokens: 0 })
    expect(sum(result.byDate.map((date) => date.totalTokens)) + result.unknownTimeUsage.totalTokens).toBe(result.totalTokens)
    expect(sum(result.hourlyDistribution)).toBe(1)

    // 反过来：没有时间的是 main，作用域先于时间，它胜出；有时间的 subagent 副本落选，byDate 不算它。
    const reversed = buildInsights([
      ledgerSession('untimed-a', '/untimed/a', [call(copy)]),
      ledgerSession('untimed-b', '/untimed/b', [call({ ...copy, scope: 'subagent', timestamp: at(1) })])
    ], [])

    expect(reversed.totalTokens).toBe(1_100)
    expect(reversed.unknownTimeUsage).toEqual({ eventCount: 1, totalTokens: 1_100 })
    expect(sum(reversed.byDate.map((date) => date.totalTokens))).toBe(0)
    expect(sum(reversed.hourlyDistribution)).toBe(0)
  })

  it('一场会话的调用全部落选：当天仍算它活跃，它的时间照样分到那一天（D5）', () => {
    const copy = { id: 'd5-shared', usd: 2, input: 1_000, output: 100 }
    // A 的一份在第二天、B 的一份在第一天：B 的更早，A 的调用全部落选。
    const sessions = [
      ledgerSession('d5-a', '/d5/a', [call({ ...copy, timestamp: at(24) })]),
      ledgerSession('d5-b', '/d5/b', [call({ ...copy, timestamp: at(0) })])
    ]
    const sessionTimes = new Map([['d5-a', 600_000], ['d5-b', 1_200_000]])

    const result = buildInsights(sessions, [], sessionTimes)

    expect(result.totalTokens).toBe(1_100)
    expect(result.byDate.find((date) => date.date === dayOf(at(24)))).toMatchObject({
      totalTokens: 0, inputTokens: 0, outputTokens: 0, turnCount: 0, sessionCount: 1,
      bySource: {}, byProject: {}, totalTime: 600_000, byProjectTime: { a: 600_000 }
    })
    expect(result.byDate.find((date) => date.date === dayOf(at(0)))).toMatchObject({
      totalTokens: 1_100, inputTokens: 1_000, outputTokens: 100, turnCount: 1, sessionCount: 1,
      bySource: { 'claude-code': 1_100 }, byProject: { b: 1_100 }, totalTime: 1_200_000, byProjectTime: { b: 1_200_000 }
    })
    expect(result.activeDays).toBe(2)
    expect(result.totalTime).toBe(1_800_000)
    expect(sum(result.byDate.map((date) => date.totalTime))).toBe(result.totalTime)
    expect(sum(result.hourlyDistribution)).toBe(1)
  })

  it('没有 billingFactKey 的调用不跨会话合并：legacy 聚合、Codex 旧总账、无 id 的 Claude 行、Codex 原始键；同键不同来源也不合并', () => {
    const legacy = (sessionId: string, source: 'claude-code' | 'codex'): SessionSummary => makeSession({ sessionId, source })
    const withLedger = (sessionId: string, source: SessionSummary['source'], accounting: ReturnType<typeof accountingFromUsageEvents>) =>
      makeSession({ sessionId, source, tokenAccounting: accounting, tokenUsage: tokenUsageFromAccounting(accounting) })
    const claudeRowWithoutId = { type: 'assistant', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 40, output_tokens: 10 } } }
    const codexWithoutHint = { kind: 'incremental' as const, timestamp: at(0), model: 'gpt-5', inputTokens: 700, outputTokens: 70 }
    const sameKey = (source: 'claude-code' | 'cc-mirror') =>
      accountingFromUsageEvents(source, [{ ...call({ id: 'cross-source', usd: 1, input: 300 }), provider: source }])
    // 两两一对：legacy 聚合 claude-code:aggregate、Codex 旧总账 codex:legacy-session-total、无 id 的 Claude 行
    // claude:row:0、没有 dedupHint 的 Codex 原始键，以及同一 billingFactKey 分属 claude-code 与 cc-mirror。
    const sessions = [
      legacy('legacy-1', 'claude-code'), legacy('legacy-2', 'claude-code'),
      legacy('codex-legacy-1', 'codex'), legacy('codex-legacy-2', 'codex'),
      withLedger('claude-row-1', 'claude-code', accountClaudeUsage([claudeRowWithoutId as unknown as RawJsonlMessage])),
      withLedger('claude-row-2', 'claude-code', accountClaudeUsage([claudeRowWithoutId as unknown as RawJsonlMessage])),
      withLedger('codex-raw-1', 'codex', accountCodexUsage([codexWithoutHint])),
      withLedger('codex-raw-2', 'codex', accountCodexUsage([codexWithoutHint])),
      withLedger('cross-source-1', 'claude-code', sameKey('claude-code')),
      withLedger('cross-source-2', 'cc-mirror', sameKey('cc-mirror'))
    ]
    // 前置：每一对的朴素键（billingFactKey || dedupKey）相同，usage-facts 的 billingFactId 却两两不同。
    const naiveKeys = sessions.map((session) =>
      accountingForSession(session).usageEvents.map((event) => event.billingFactKey || event.dedupKey))
    for (let index = 0; index < sessions.length; index += 2) expect(naiveKeys[index]).toEqual(naiveKeys[index + 1])
    const billingFactIds = sessions.flatMap((session) => usageFactsForSession(session).map((fact) => fact.billingFactId))
    expect(billingFactIds).toHaveLength(sessions.length)
    expect(new Set(billingFactIds).size).toBe(sessions.length)

    const result = buildInsights(sessions, [])
    const perSession = sum(sessions.map((session) => accountingForSession(session).billingTotal!))

    expect(result.totalTokens).toBe(perSession)
    expect(result.reconciliation).toMatchObject({
      global: perSession,
      sessions: perSession,
      crossSessionDuplicateFacts: 0,
      crossSessionDuplicateTokens: 0,
      difference: 0,
      ok: true,
      valuation: { crossSessionDuplicateUsd: 0, ok: true }
    })
  })

  // insights.ts 的 precedesInBillingRank 是 usage-fact-store.ts 里
  // canonicalizeBillingFacts 的 billing_rank（SQL ORDER BY）的复本（见 precedesInBillingRank
  // 的注释）；两边各写一份，从未对照过同一组事实是否选出同一条（F1j P2-1 c）。
  describe('与 usage-facts 的 billing_rank 对照：同一组事实两边选出同一条', () => {
    let root = ''
    let previousUsageIndex: string | undefined

    beforeEach(() => {
      closeUsageFactStore()
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-insights-billing-rank-'))
      previousUsageIndex = process.env.SWOB_USAGE_INDEX_PATH
      process.env.SWOB_USAGE_INDEX_PATH = path.join(root, 'usage.db')
    })

    afterEach(() => {
      closeUsageFactStore()
      if (previousUsageIndex === undefined) delete process.env.SWOB_USAGE_INDEX_PATH
      else process.env.SWOB_USAGE_INDEX_PATH = previousUsageIndex
      fs.rmSync(root, { recursive: true, force: true })
    })

    function billingIncludedSessionId(sharedBillingFactId: string): string {
      const db = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true, fileMustExist: true })
      try {
        const row = db.prepare(
          'SELECT session_id FROM usage_facts WHERE billing_fact_id = ? AND superseded = 0 AND billing_included = 1'
        ).get(sharedBillingFactId) as { session_id: string } | undefined
        return row?.session_id ?? ''
      } finally {
        db.close()
      }
    }

    it.each([
      ['作用域：main 先于 subagent', [{ scope: 'sidechain' as const, timestamp: at(0) }, { timestamp: at(1) }]],
      ['作用域：sidechain 与 subagent 同档，看时间', [{ scope: 'subagent' as const, timestamp: at(1) }, { scope: 'sidechain' as const, timestamp: at(0) }]],
      ['时间按原串比较：同一时刻 .000Z 排在 Z 前', [{ timestamp: `${RAW_INSTANT}Z` }, { timestamp: `${RAW_INSTANT}.000Z` }]],
      ['时间：更早胜出', [{ timestamp: at(1) }, { timestamp: at(0) }]],
      ['NULL：有时间胜过没有时间', [{}, { timestamp: at(1) }]],
      ['event_id：同一时间取更小的', [{ timestamp: at(1) }, { timestamp: at(1) }]]
    ] as const)('%s：JS 与 SQL 选出同一场会话', (name, [aSpec, bSpec]) => {
      const key = `parity-${name}`
      const a = ledgerSession(`${key}-a`, '/parity/a', [call({ id: key, usd: 1, input: 1_000, ...aSpec })])
      const b = ledgerSession(`${key}-b`, '/parity/b', [call({ id: key, usd: 2, input: 2_000, ...bSpec })])
      const sharedBillingFactId = usageFactsForSession(a)[0].billingFactId
      expect(usageFactsForSession(b)[0].billingFactId).toBe(sharedBillingFactId)

      // JS 侧：bySession 两边永远各自满额（1,000 / 2,000，未按胜负削减），赢家只能从全局合计
      // 反推——全局合计等于赢家那一份的满额，因为落选的一份被扣掉了。
      const jsResult = buildInsights([a, b], [])
      expect(Object.fromEntries(jsResult.bySession.map((session) => [session.sessionId, session.totalTokens])))
        .toEqual({ [`${key}-a`]: 1_000, [`${key}-b`]: 2_000 })
      expect(jsResult.totalTokens === 1_000 || jsResult.totalTokens === 2_000).toBe(true)
      const jsWinner = jsResult.totalTokens === 2_000 ? `${key}-b` : `${key}-a`

      // SQL 侧：真的写进账本，读 canonicalizeBillingFacts 判定的 billing_included 行。
      synchronizeUsageFacts([a, b], [])
      expect(billingIncludedSessionId(sharedBillingFactId)).toBe(jsWinner)
    })
  })

  // F1m：加载层用同一条规则先把跨会话共有的调用归到一场会话（其余副本标 inherited，所在会话的账不再含它）。
  // Insights 的全局与逐会话份额（byProject/byFolder/bySource 即各会话的 CountedUsage）与归属前逐位相同，
  // 按日会话数与时间分摊也不变（D5：一场会话的调用全记在别处，它当天仍算活跃）；按会话的 bySession 与对账里
  // 按会话的几个数按预期下降，对账恒等式照样闭合。
  describe('F1m：加载层归属之后 Insights 位级不变', () => {
    const shared = (id: string, hours: number, scope?: UsageEvent['scope']) =>
      call({ id, usd: 0.25, input: 1_000, cacheRead: 4_000, cacheWrite: 100, output: 50, model: 'claude-sonnet-4-5', timestamp: at(hours), ...(scope ? { scope } : {}) })
    function pristineSessions(): SessionSummary[] {
      const parent = ledgerSession('f1m-parent', '/f1m/parent', [
        shared('p-1', 0), shared('p-2', 1), shared('p-3', 25),
        call({ id: 'parent-own', usd: 1, input: 3_000, output: 300, model: 'claude-opus-4-1', timestamp: at(26) })
      ])
      // 分支：抄了父会话的三条调用（跨两天），再各自继续。
      const child = ledgerSession('f1m-child', '/f1m/child', [
        shared('p-1', 0), shared('p-2', 1), shared('p-3', 25),
        call({ id: 'child-own', usd: 2, input: 5_000, output: 500, model: 'claude-opus-4-1', timestamp: at(48) })
      ])
      // 只抄历史、自己没有调用的会话；它的副本作用域更弱，三条都会记在父或子会话上。
      const copy = ledgerSession('f1m-copy', '/f1m/copy', [shared('p-1', 0, 'sidechain'), shared('p-2', 1, 'sidechain')])
      const unrelated = ledgerSession('f1m-other', '/f1m/other', [call({ id: 'other-own', usd: 0.5, input: 700, output: 70, timestamp: at(2) })])
      const sessions = [parent, child, copy, unrelated]
      sessions.forEach((session, index) => { session.estimatedTime = 600_000 * (index + 1) })
      return sessions
    }
    const folders = ['f1m-parent', 'f1m-child', 'f1m-copy', 'f1m-other'].map((sessionId) =>
      makeFolder({ id: `folder-${sessionId}`, name: sessionId, sessionIds: [sessionId] }))
    /** Everything but the per-session ledgers (bySession) and the reconciliation numbers built from them. */
    const global = (result: ReturnType<typeof buildInsights>): string => JSON.stringify({
      ...result,
      bySession: undefined,
      reconciliation: {
        ...result.reconciliation,
        sessions: undefined,
        crossSessionDuplicateFacts: undefined,
        crossSessionDuplicateTokens: undefined,
        valuation: { ...result.reconciliation.valuation, sessionsUsd: undefined, crossSessionDuplicateUsd: undefined, difference: undefined }
      }
    })

    it('global totals, per-session shares, days and time are bit for bit the same; per-session ledgers drop the inherited copies', () => {
      const before = buildInsights(pristineSessions(), folders)
      const owned = pristineSessions()
      const stats = assignCrossSessionUsageOwners(owned)
      expect(stats).toMatchObject({ sessions: 4, sharedFacts: 3, inheritedCopies: 5 })
      const after = buildInsights(owned, folders)

      expect(global(after)).toBe(global(before))
      // What that covers, spelled out: the session that only copied history is still active on its days,
      // and every session's time is still spread over days (D5).
      expect(after.byDate).toEqual(before.byDate)
      expect(after.activeDays).toBe(before.activeDays)
      expect(sum(after.byDate.map((date) => date.totalTime))).toBe(sum(before.byDate.map((date) => date.totalTime)))
      expect(after.byFolder.find((folder) => folder.folderId === 'folder-f1m-copy')).toMatchObject({ totalTokens: 0, tokenAvailableSessions: 1 })

      // Three ways to the same number: Σ per-session ledgers, the Insights total, each call once.
      const perCall = 3 * 5_150 + 3_300 + 5_500 + 770
      expect(sum(owned.map((session) => session.tokenAccounting!.billingTotal!))).toBe(perCall)
      expect(after.totalTokens).toBe(perCall)
      expect(before.totalTokens).toBe(perCall)
      // Per session: bySession follows the session's own ledger; the load resolved every duplicate.
      expect(Object.fromEntries(after.bySession.map((session) => [session.sessionId, session.totalTokens])))
        .toEqual(Object.fromEntries(owned.map((session) => [session.sessionId, session.tokenAccounting!.billingTotal])))
      expect(before.reconciliation).toMatchObject({ crossSessionDuplicateFacts: 5, crossSessionDuplicateTokens: 5 * 5_150, ok: true })
      expect(after.reconciliation).toMatchObject({
        global: perCall, sessions: perCall, crossSessionDuplicateFacts: 0, crossSessionDuplicateTokens: 0, difference: 0, ok: true,
        valuation: { crossSessionDuplicateUsd: 0, ok: true }
      })
      expect(after.valuation.usd).toBe(before.valuation.usd)
    })

    it('the owner the load picks is the one Insights picked on the same sessions before the load decided', () => {
      const before = buildInsights(pristineSessions(), folders)
      const owned = pristineSessions()
      assignCrossSessionUsageOwners(owned)
      // byFolder (one session per folder) is each session's counted share: equal before and after means
      // Insights' own cross-session winners and the load's owners are the same copies.
      for (const session of owned) {
        const folderId = `folder-${session.sessionId}`
        const share = before.byFolder.find((folder) => folder.folderId === folderId)!.totalTokens
        expect(session.tokenAccounting!.billingTotal, session.sessionId).toBe(share)
      }
    })
  })
})

// 估价对账的判定（F1j）。F1j 之后全局、逐会话、逐条三项金额按构造自洽，从 buildInsights 的输入造不出
// valuation.ok = false，所以反例直接喂给判定函数；buildInsights 的 reconciliation.valuation 原样展开它的
// 返回值（F1i 验收 P2-1）。
describe('valuationReconciliationVerdict：估价对账的判定（F1j）', () => {
  const side = (coveragePercent: number, coveredTokens: number, totalBillableTokens: number) =>
    ({ coveragePercent, coveredTokens, totalBillableTokens })
  const verdict = (
    usd: { globalUsd: number | null; sessionsUsd: number | null; uniqueEventsUsd: number | null; crossSessionDuplicateUsd: number },
    global = side(0, 0, 0),
    uniqueEvents = global
  ) => valuationReconciliationVerdict({ ...usd, global, uniqueEvents })
  const agreeing = (usd: number) => ({ globalUsd: usd, sessionsUsd: usd, uniqueEventsUsd: usd, crossSessionDuplicateUsd: 0 })

  it('USD 容差是较大合计的 1e-9：$8,192 处差 2^-17 在内、2^-16 在外', () => {
    // 前置：两个差在 $8,192 处都能精确表示，容差 8.192e-6 夹在两者之间。
    expect(8_192 + 2 ** -17 - 8_192).toBe(2 ** -17)
    expect(8_192 + 2 ** -16 - 8_192).toBe(2 ** -16)
    expect(2 ** -17).toBeLessThan(1e-9 * 8_192)
    expect(2 ** -16).toBeGreaterThan(1e-9 * 8_192)

    expect(verdict({ ...agreeing(8_192), uniqueEventsUsd: 8_192 + 2 ** -17 }))
      .toEqual({ difference: 2 ** -17, coverageDifference: 0, ok: true })
    expect(verdict({ ...agreeing(8_192), uniqueEventsUsd: 8_192 + 2 ** -16 }))
      .toEqual({ difference: 2 ** -16, coverageDifference: 0, ok: false })
  })

  it('容差的尺度取全局与逐会话中较大的一个：逐会话 $12,288 时差 2^-17 仍在容差内', () => {
    // 全局 $4,096，跨会话重复约 $8,192：尺度 12,288，容差 1.2288e-5；只按全局算是 4.096e-6，2^-17 就超了。
    expect(4_096 + (8_192 + 2 ** -17) - 12_288).toBe(2 ** -17)
    expect(2 ** -17).toBeGreaterThan(1e-9 * 4_096)

    expect(verdict({ globalUsd: 4_096, sessionsUsd: 12_288, uniqueEventsUsd: 4_096, crossSessionDuplicateUsd: 8_192 + 2 ** -17 }))
      .toEqual({ difference: 2 ** -17, coverageDifference: 0, ok: true })
  })

  it('差恰好等于容差仍然一致（≤，不是 <）', () => {
    // 金额为 0 时尺度取 1，容差正好是 1e-9。
    expect(verdict({ ...agreeing(0), uniqueEventsUsd: 1e-9 })).toEqual({ difference: 1e-9, coverageDifference: 0, ok: true })
  })

  it('逐会话之和含跨会话重复：加回重复金额才一致，漏加判不一致', () => {
    // 两场会话共享一条 $2 的事实：逐会话合计 $5.5，全局与逐条都是 $3.5。
    expect(verdict({ globalUsd: 3.5, sessionsUsd: 5.5, uniqueEventsUsd: 3.5, crossSessionDuplicateUsd: 2 }))
      .toEqual({ difference: 0, coverageDifference: 0, ok: true })
    expect(verdict({ globalUsd: 3.5, sessionsUsd: 5.5, uniqueEventsUsd: 3.5, crossSessionDuplicateUsd: 0 }))
      .toEqual({ difference: 2, coverageDifference: 0, ok: false })
  })

  it('全局对逐条那一项不能省：与逐会话对得上、与逐条差 $0.5，判不一致', () => {
    expect(verdict({ globalUsd: 3.5, sessionsUsd: 5.5, uniqueEventsUsd: 3, crossSessionDuplicateUsd: 2 }))
      .toEqual({ difference: 0.5, coverageDifference: 0, ok: false })
  })

  it('覆盖率差 1e-6 个百分点判不一致（真实规模的 token 数，容差不随 token 数放大）', () => {
    const result = verdict(agreeing(10), side(50, 16_000_000_000, 32_000_000_000), side(50 + 1e-6, 16_000_000_000, 32_000_000_000))

    expect(result.difference).toBe(0)
    expect(result.coverageDifference).toBeGreaterThan(1e-9)
    expect(result.ok).toBe(false)
  })

  it('覆盖率也比整数：100% 与 0% 时百分点相同，覆盖或可计费 token 差 1 仍判不一致（D6）', () => {
    expect(verdict(agreeing(10), side(100, 1_000, 1_000), side(100, 999, 999)))
      .toEqual({ difference: 0, coverageDifference: 0, ok: false })
    expect(verdict(agreeing(10), side(0, 0, 1_000), side(0, 0, 999)))
      .toEqual({ difference: 0, coverageDifference: 0, ok: false })
    expect(verdict(agreeing(10), side(100, 1_000, 1_000), side(100, 1_000, 1_000)))
      .toEqual({ difference: 0, coverageDifference: 0, ok: true })
  })
})

describe('buildInsights 的 token 对账会判不一致（F1j）', () => {
  it('provider 结论是 usage 不可用、账本却有 billingTotal：Σ bySession 多出这一场，ok = false', () => {
    // 默认 tokenUsage 1,000 + 500，legacy 聚合账本 1,500；它不进合计，但照样列在 bySession。
    const result = buildInsights([makeSession({
      sessionId: 'outcome-unavailable',
      providerOutcome: { detected: 'detected', parse: 'parsed', usage: 'unavailable', reason: 'fixture' }
    })], [])

    expect(result.totalTokens).toBe(0)
    expect(result.reconciliation).toMatchObject({
      global: 0, projects: 0, sessions: 1_500, crossSessionDuplicateTokens: 0, difference: 1_500, ok: false
    })
  })
})
