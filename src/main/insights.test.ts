import { describe, it, expect } from 'vitest'
import { buildInsights, estimateActiveTime } from './insights'
import {
  accountCodexUsage,
  accountingFromMutuallyExclusiveUsage,
  markExcludedFromRollups,
  tokenUsageFromAccounting,
  unavailableTokenAccounting
} from './token-accounting'
import type { SessionSummary, Folder } from './types'

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
      expect(result.bySource).toHaveLength(11)
      expect(result.bySource.map((s) => s.source)).toEqual([
        'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror',
        'antigravity', 'grok', 'pi', 'kimi', 'hermes'
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
