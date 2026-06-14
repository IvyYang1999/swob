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

// Mock window.api for SidebarFooter
;(globalThis as any).window = globalThis.window || {}
;(window as any).api = {
  libraryGetConfiguredPath: vi.fn().mockResolvedValue('/Users/test/Documents/Swob'),
  libraryIsInitialized: vi.fn().mockResolvedValue(false),
  librarySelectDirectory: vi.fn().mockResolvedValue(null),
  libraryChangePath: vi.fn().mockResolvedValue(null),
  showSessionContextMenu: vi.fn().mockResolvedValue(null)
}

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
  cloudSessionIds: new Set<string>(),
  sshConfig: null,
  locale: 'zh-CN',
  sessions: [],
  addSessionToFolder: vi.fn(),
  removeSessionFromFolder: vi.fn(),
  renameFolder: vi.fn(),
  setSessionMeta: vi.fn(),
  refreshCloudSessions: vi.fn(),
  showToast: vi.fn(),
  toasts: [],
  dismissToast: vi.fn(),
  createFolder: vi.fn(),
  moveFolder: vi.fn()
}

vi.mock('../store', () => {
  const fn = (() => mockStore) as any
  fn.getState = () => mockStore
  return { useStore: fn }
})

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

describe('未分组底部区域只接受物理归属标签', () => {
  beforeEach(() => {
    mockStore.selectedUniqueId = null
    mockStore.config = {
      folders: [],
      sessionMeta: {
        'parent-uuid': { customTitle: '母session标题' },
        'parent-uuid:intra-0': { customTitle: '分支标题' }
      },
      preferences: { defaultViewMode: 'compact' as const, terminalApp: 'Terminal' as const }
    }
  })

  it('配置 ungrouping 后，缺 ungroupBucket 的 library-only 会话不会 fail-open 进底部', () => {
    mockStore.config = {
      folders: [{
        id: '项目/开发项目/飞搜',
        name: '飞搜',
        parentId: null,
        sessionIds: ['remote-grouped'],
        createdAt: ''
      }],
      sessionMeta: {},
      preferences: {
        defaultViewMode: 'compact' as const,
        terminalApp: 'Terminal' as const,
        ungrouping: { multiTurn: '未分组', singleTurn: '单轮会话' }
      } as any
    }
    mockStore.sessions = [makeSession({
      id: 'remote-grouped',
      sessionId: 'remote-grouped',
      firstUserMessage: '这个已分组会话不该出现在底部',
      turnCount: 12
    })] as any

    render(<Sidebar width={260} />)

    expect(screen.getByText('飞搜')).toBeTruthy()
    expect(screen.queryByText((text) => text.includes('这个已分组会话不该出现在底部'))).toBeNull()
  })

  it('multi/single 物理标签仍进入底部未分组与单轮区域', () => {
    mockStore.config = {
      folders: [],
      sessionMeta: {},
      preferences: {
        defaultViewMode: 'compact' as const,
        terminalApp: 'Terminal' as const,
        ungrouping: { multiTurn: '未分组', singleTurn: '单轮会话' }
      } as any
    }
    mockStore.sessions = [
      makeSession({
        id: 'physical-multi',
        sessionId: 'physical-multi',
        firstUserMessage: '真正未分组多轮',
        turnCount: 8,
        ungroupBucket: 'multi'
      }),
      makeSession({
        id: 'physical-single',
        sessionId: 'physical-single',
        firstUserMessage: '真正单轮',
        turnCount: 1,
        ungroupBucket: 'single'
      })
    ] as any

    render(<Sidebar width={260} />)

    expect(screen.getByText((text) => text.includes('真正未分组多轮'))).toBeTruthy()
    expect(screen.getByText('sidebar.single_turn')).toBeTruthy()
    expect(screen.queryByText((text) => text.includes('真正单轮'))).toBeNull()
  })
})
