/**
 * @vitest-environment jsdom
 */
/**
 * Sidebar SessionItem 渲染测试
 *
 * 确保分支 session 和母 session 在渲染时各自独立。
 * 如果变量声明顺序搞错（比如 isIntraBranch 在使用后才定义），
 * 这个测试会直接 ReferenceError 挂掉。
 */
/// <reference types="@testing-library/jest-dom" />
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'

// --- Mock store and i18n before importing component ---

const mockStore = {
  selectedUniqueId: null,
  selectSession: vi.fn(),
  config: {
    folders: [],
    sessionMeta: {
      'parent-uuid': { customTitle: '母session标题' },
      'parent-uuid:intra-0': { customTitle: '分支标题' }
    },
    preferences: { defaultViewMode: 'compact' as const, terminalApp: 'Terminal' as const }
  },
  activeSessionIds: new Set<string>(),
  locale: 'zh-CN',
  sessions: [],
  addSessionToFolder: vi.fn(),
  removeSessionFromFolder: vi.fn(),
  renameFolder: vi.fn(),
  setSessionMeta: vi.fn()
}

vi.mock('../store', () => ({
  useStore: () => mockStore
}))

vi.mock('../i18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    if (key === 'sidebar.turns') return `${params?.n}轮`
    if (key === 'sidebar.yesterday') return '昨天'
    if (key === 'sidebar.days_ago') return `${params?.n}天前`
    return key
  }
}))

// Now import the component (after mocks are set up)
// We need to extract SessionItem — it's not exported, but Sidebar renders it.
// Instead, let's import the whole Sidebar module and test via rendering sessions.

// Since SessionItem is not exported, we test it through the Sidebar's flat view mode.
import { Sidebar } from './Sidebar'

function makeSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'parent-uuid',
    sessionId: 'parent-uuid',
    slug: '',
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T01:00:00Z',
    messageCount: 10,
    turnCount: 5,
    compactCount: 0,
    cwds: ['/home/user'],
    version: '2.1.63',
    firstUserMessage: '母session默认消息',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '/home/user',
    filePath: '/fake/path.jsonl',
    fileSizeBytes: 1000,
    ...overrides
  }
}

describe('【曾经的 bug】SessionItem 渲染不能因变量顺序而崩溃', () => {
  beforeEach(() => {
    mockStore.sessions = []
    mockStore.selectedUniqueId = null
  })

  it('渲染母 session 不崩溃', () => {
    const parent = makeSession()
    mockStore.sessions = [parent] as any

    // 如果变量声明顺序错了，这里会抛 ReferenceError
    expect(() => {
      render(<Sidebar width={260} />)
    }).not.toThrow()
  })

  it('渲染分支 session 不崩溃', () => {
    const branch = makeSession({
      id: 'parent-uuid:intra-0',
      sessionId: 'parent-uuid',
      firstUserMessage: '分支默认消息'
    })
    mockStore.sessions = [branch] as any

    expect(() => {
      render(<Sidebar width={260} />)
    }).not.toThrow()
  })
})

describe('分支和母 session 显示各自独立的标题', () => {
  it('母 session 显示自己的 customTitle', () => {
    const parent = makeSession()
    mockStore.sessions = [parent] as any

    render(<Sidebar width={260} />)

    expect(screen.getByText('母session标题')).toBeTruthy()
  })

  it('分支显示自己的 customTitle，不是母 session 的', () => {
    const branch = makeSession({
      id: 'parent-uuid:intra-0',
      sessionId: 'parent-uuid',
      firstUserMessage: '分支默认消息'
    })
    mockStore.sessions = [branch] as any

    render(<Sidebar width={260} />)

    // 应该显示分支自己的标题
    expect(screen.getByText('分支标题')).toBeTruthy()
    // 不应该显示母 session 的标题
    expect(screen.queryByText('母session标题')).toBeNull()
  })

  it('【曾经的 bug】分支没有 customTitle 时显示自己的 firstUserMessage，不能显示母 session 的标题', () => {
    // 清掉分支的 customTitle
    const origMeta = { ...mockStore.config.sessionMeta }
    delete (mockStore.config.sessionMeta as any)['parent-uuid:intra-0']

    const branch = makeSession({
      id: 'parent-uuid:intra-0',
      sessionId: 'parent-uuid',
      firstUserMessage: '分支默认消息'
    })
    mockStore.sessions = [branch] as any

    render(<Sidebar width={260} />)

    // 必须显示分支自己的 firstUserMessage
    expect(screen.getByText((text) => text.includes('分支默认消息'))).toBeTruthy()
    // 绝对不能 fallback 到母 session 的标题
    expect(screen.queryByText('母session标题')).toBeNull()

    // 恢复
    mockStore.config.sessionMeta = origMeta
  })
})
