/**
 * chat-helpers.ts 测试
 * 从 ChatViewer.tsx 提取出来的纯逻辑函数
 */
import { describe, it, expect } from 'vitest'
import { getToolPreview, sessionHeaderMd, TOOL_COLORS, DEFAULT_TOOL_COLOR } from './chat-helpers'

describe('getToolPreview', () => {
  it('Bash 工具显示命令内容', () => {
    expect(getToolPreview('Bash', { command: 'npm test' })).toBe('npm test')
  })

  it('Bash 命令超长时截断到 120 字符', () => {
    const longCmd = 'a'.repeat(200)
    expect(getToolPreview('Bash', { command: longCmd })).toHaveLength(120)
  })

  it('Read/Write/Edit 工具显示文件路径', () => {
    expect(getToolPreview('Read', { file_path: '/src/main/index.ts' })).toBe('/src/main/index.ts')
    expect(getToolPreview('Write', { file_path: '/tmp/out.js' })).toBe('/tmp/out.js')
    expect(getToolPreview('Edit', { file_path: '/a.ts' })).toBe('/a.ts')
  })

  it('Grep/Glob 工具显示搜索模式', () => {
    expect(getToolPreview('Grep', { pattern: 'TODO' })).toBe('TODO')
    expect(getToolPreview('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts')
  })

  it('Skill 工具显示 skill 名称', () => {
    expect(getToolPreview('Skill', { skill: 'brainstorming' })).toBe('brainstorming')
  })

  it('Agent 工具显示 prompt 前 80 字符', () => {
    const longPrompt = '帮我'.repeat(100)
    const preview = getToolPreview('Agent', { prompt: longPrompt })
    expect(preview).toHaveLength(80)
  })

  it('未知工具或缺少字段返回空字符串', () => {
    expect(getToolPreview('UnknownTool', {})).toBe('')
    expect(getToolPreview('Bash', {})).toBe('') // 没有 command 字段
    expect(getToolPreview('Read', {})).toBe('') // 没有 file_path 字段
  })
})

describe('sessionHeaderMd', () => {
  const mockT = (key: string, params?: Record<string, string | number>) => {
    if (key === 'chat.turns_count' && params) return `${params.n} turns`
    return key
  }

  it('用 customTitle 作为标题', () => {
    const md = sessionHeaderMd(
      { firstUserMessage: '原始消息', sessionId: 'abc', createdAt: '2026-03-01T10:00:00Z', turnCount: 5, toolUsage: {} },
      mockT, 'zh-CN', '自定义标题'
    )
    expect(md).toContain('# 自定义标题')
    expect(md).not.toContain('原始消息')
  })

  it('没有 customTitle 时用 firstUserMessage', () => {
    const md = sessionHeaderMd(
      { firstUserMessage: '你好世界', sessionId: 'abc', createdAt: '2026-03-01T10:00:00Z', turnCount: 3, toolUsage: {} },
      mockT, 'zh-CN'
    )
    expect(md).toContain('# 你好世界')
  })

  it('没有 firstUserMessage 时用 sessionId', () => {
    const md = sessionHeaderMd(
      { sessionId: 'abc-123', createdAt: '2026-03-01T10:00:00Z', turnCount: 1, toolUsage: {} },
      mockT, 'zh-CN'
    )
    expect(md).toContain('# abc-123')
  })

  it('包含工具统计（最多 6 个，按数量排序）', () => {
    const md = sessionHeaderMd(
      {
        firstUserMessage: '测试', sessionId: 'x', createdAt: '2026-03-01T10:00:00Z', turnCount: 10,
        toolUsage: { Bash: 50, Read: 30, Edit: 20, Write: 10, Grep: 5, Glob: 3, Agent: 1 }
      },
      mockT, 'zh-CN'
    )
    expect(md).toContain('Bash(50)')
    expect(md).toContain('Read(30)')
    // Agent(1) 是第 7 个，应该被截掉
    expect(md).not.toContain('Agent(1)')
  })

  it('没有工具调用时不显示 Tools 行', () => {
    const md = sessionHeaderMd(
      { firstUserMessage: '测试', sessionId: 'x', createdAt: '2026-03-01T10:00:00Z', turnCount: 1, toolUsage: {} },
      mockT, 'zh-CN'
    )
    expect(md).not.toContain('Tools:')
  })
})

describe('TOOL_COLORS', () => {
  it('主要工具都有颜色定义', () => {
    expect(TOOL_COLORS['Bash']).toBeDefined()
    expect(TOOL_COLORS['Read']).toBeDefined()
    expect(TOOL_COLORS['Write']).toBeDefined()
    expect(TOOL_COLORS['Edit']).toBeDefined()
    expect(TOOL_COLORS['Grep']).toBeDefined()
  })

  it('DEFAULT_TOOL_COLOR 存在', () => {
    expect(DEFAULT_TOOL_COLOR).toBeDefined()
  })
})
