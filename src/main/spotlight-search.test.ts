import { describe, it, expect } from 'vitest'
import { spotlightSearch } from './spotlight-search'
import type { SessionSummary } from './types'

function makeSummary(overrides: Partial<SessionSummary> & { sessionId: string }): SessionSummary {
  return {
    id: overrides.sessionId,
    slug: '',
    createdAt: '2026-04-20T10:00:00Z',
    updatedAt: '2026-04-20T12:00:00Z',
    messageCount: 10,
    turnCount: 5,
    compactCount: 0,
    cwds: ['/Users/test/projects/myapp'],
    version: '1.0',
    firstUserMessage: '',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '/Users/test/.claude/projects/-Users-test-projects-myapp',
    filePath: '/Users/test/.claude/projects/-Users-test-projects-myapp/session.jsonl',
    fileSizeBytes: 1000,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    source: 'claude-code',
    ...overrides
  }
}

const emptyContext = { sessionMeta: {}, folderMap: new Map() }

describe('spotlightSearch', () => {
  it('空查询返回按时间排序的最新 session', () => {
    const sessions = [
      makeSummary({ sessionId: 'a', updatedAt: '2026-04-20T10:00:00Z' }),
      makeSummary({ sessionId: 'b', updatedAt: '2026-04-21T10:00:00Z' })
    ]
    const results = spotlightSearch('', sessions, emptyContext)
    expect(results.length).toBe(2)
    expect(results[0].session.sessionId).toBe('a')
  })

  it('按来源过滤：codex', () => {
    const sessions = [
      makeSummary({ sessionId: 'cc1', source: 'claude-code', firstUserMessage: '飞搜相关' }),
      makeSummary({ sessionId: 'cx1', source: 'codex', firstUserMessage: '飞搜相关' }),
      makeSummary({ sessionId: 'cu1', source: 'cursor', firstUserMessage: '飞搜相关' })
    ]
    const results = spotlightSearch('codex 飞搜', sessions, emptyContext)
    expect(results.length).toBe(1)
    expect(results[0].session.sessionId).toBe('cx1')
  })

  it('按来源别名过滤：cc → claude-code', () => {
    const sessions = [
      makeSummary({ sessionId: 'cc1', source: 'claude-code', firstUserMessage: '测试' }),
      makeSummary({ sessionId: 'cx1', source: 'codex', firstUserMessage: '测试' })
    ]
    const results = spotlightSearch('cc 测试', sessions, emptyContext)
    expect(results.length).toBe(1)
    expect(results[0].session.sessionId).toBe('cc1')
  })

  it('自定义标题优先级最高', () => {
    const sessions = [
      makeSummary({ sessionId: 'a', firstUserMessage: '飞搜功能开发' }),
      makeSummary({ sessionId: 'b', firstUserMessage: '一些不相关的内容' })
    ]
    const context = {
      sessionMeta: { b: { customTitle: '飞搜项目' } },
      folderMap: new Map()
    }
    const results = spotlightSearch('飞搜', sessions, context)
    expect(results.length).toBe(2)
    expect(results[0].session.sessionId).toBe('b')
  })

  it('多关键词要求全部匹配', () => {
    const sessions = [
      makeSummary({ sessionId: 'a', firstUserMessage: '飞搜功能开发', source: 'codex' }),
      makeSummary({ sessionId: 'b', firstUserMessage: '飞搜功能开发', source: 'cursor' })
    ]
    const results = spotlightSearch('飞搜 codex', sessions, emptyContext)
    expect(results.length).toBe(1)
    expect(results[0].session.sessionId).toBe('a')
  })

  it('"最新" 关键词按时间排序', () => {
    const sessions = [
      makeSummary({ sessionId: 'a', source: 'codex', firstUserMessage: '飞搜', updatedAt: '2026-04-20T10:00:00Z' }),
      makeSummary({ sessionId: 'b', source: 'codex', firstUserMessage: '飞搜', updatedAt: '2026-04-22T10:00:00Z' })
    ]
    const results = spotlightSearch('飞搜 最新 codex', sessions, emptyContext)
    expect(results.length).toBe(2)
    expect(results[0].session.sessionId).toBe('b')
  })

  it('路径匹配', () => {
    const sessions = [
      makeSummary({ sessionId: 'a', cwds: ['/Users/test/projects/swob'] }),
      makeSummary({ sessionId: 'b', cwds: ['/Users/test/projects/other'] })
    ]
    const results = spotlightSearch('swob', sessions, emptyContext)
    expect(results.length).toBe(1)
    expect(results[0].session.sessionId).toBe('a')
  })

  it('文件夹名匹配', () => {
    const sessions = [
      makeSummary({ sessionId: 'a', firstUserMessage: '其他内容' }),
      makeSummary({ sessionId: 'b', firstUserMessage: '其他内容' })
    ]
    const context = {
      sessionMeta: {},
      folderMap: new Map([['b', '飞搜开发']])
    }
    const results = spotlightSearch('飞搜', sessions, context)
    expect(results.length).toBe(1)
    expect(results[0].session.sessionId).toBe('b')
  })

  it('结果数量限制', () => {
    const sessions = Array.from({ length: 50 }, (_, i) =>
      makeSummary({ sessionId: `s${i}`, firstUserMessage: '通用关键词' })
    )
    const results = spotlightSearch('通用', sessions, emptyContext, 10)
    expect(results.length).toBe(10)
  })
})
