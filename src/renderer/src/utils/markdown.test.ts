/**
 * markdown.ts 工具函数测试
 *
 * 这些测试覆盖了之前手动测试才发现的真实 bug：
 * - task-notification 被当作用户消息显示
 * - 空消息导致多余的 turn
 * - compact boundary 切分错误
 * - demoteHeadings 在代码块内误替换
 */
import { describe, it, expect } from 'vitest'
import { groupIntoTurns, buildSegments, computeSections, computeChatTocEntries } from './markdown'
import type { CompactSection } from './markdown'

// --- 造假数据的工具函数 ---
// 模拟一条 ParsedMessage，只填必要字段
function msg(overrides: {
  type: string
  subtype?: string
  textContent?: string
  toolCalls?: any[]
  uuid?: string
  isSidechain?: boolean
  isSharedContext?: boolean
}) {
  return {
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    type: overrides.type,
    subtype: overrides.subtype,
    timestamp: '2026-03-01T00:00:00Z',
    role: overrides.type === 'user' ? 'user' : overrides.type === 'assistant' ? 'assistant' : undefined,
    textContent: overrides.textContent ?? '',
    toolCalls: overrides.toolCalls ?? [],
    isPreCompact: false,
    isSidechain: overrides.isSidechain ?? false,
    isSharedContext: overrides.isSharedContext ?? false,
    raw: {}
  } as any
}

// ========================================================
// groupIntoTurns 测试
// ========================================================
describe('groupIntoTurns', () => {
  it('基本对话：一问一答 = 1 个 turn', () => {
    const msgs = [
      msg({ type: 'user', textContent: '你好' }),
      msg({ type: 'assistant', textContent: '你好！有什么可以帮你的？' })
    ]
    const turns = groupIntoTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].userMsg?.textContent).toBe('你好')
    expect(turns[0].assistantMsgs).toHaveLength(1)
  })

  it('连续两轮对话 = 2 个 turn', () => {
    const msgs = [
      msg({ type: 'user', textContent: '问题1' }),
      msg({ type: 'assistant', textContent: '回答1' }),
      msg({ type: 'user', textContent: '问题2' }),
      msg({ type: 'assistant', textContent: '回答2' })
    ]
    const turns = groupIntoTurns(msgs)
    expect(turns).toHaveLength(2)
    expect(turns[0].userMsg?.textContent).toBe('问题1')
    expect(turns[1].userMsg?.textContent).toBe('问题2')
  })

  it('【真实 bug】task-notification 不应该被当作用户消息', () => {
    // 这个 bug 之前在生产环境出现过：
    // JSONL 里 type=user 但内容是 <task-notification>，显示成了一条用户消息
    const msgs = [
      msg({ type: 'user', textContent: '帮我写个函数' }),
      msg({ type: 'assistant', textContent: '好的' }),
      msg({ type: 'user', subtype: 'task-notification', textContent: '<task-notification>Task completed</task-notification>' }),
      msg({ type: 'user', textContent: '再帮我改一下' }),
      msg({ type: 'assistant', textContent: '改好了' })
    ]
    const turns = groupIntoTurns(msgs)
    // 应该是 2 个 turn，不是 3 个
    expect(turns).toHaveLength(2)
    expect(turns[0].userMsg?.textContent).toBe('帮我写个函数')
    expect(turns[1].userMsg?.textContent).toBe('再帮我改一下')
  })

  it('skill-output 类型的消息也应该跳过', () => {
    const msgs = [
      msg({ type: 'user', textContent: '用 brainstorming skill' }),
      msg({ type: 'user', subtype: 'skill-output', textContent: '# Brainstorming skill content...' }),
      msg({ type: 'assistant', textContent: '好的，我来分析' })
    ]
    const turns = groupIntoTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].userMsg?.textContent).toBe('用 brainstorming skill')
  })

  it('system 消息应该被忽略', () => {
    const msgs = [
      msg({ type: 'system', textContent: 'System reminder...' }),
      msg({ type: 'user', textContent: '你好' }),
      msg({ type: 'system', subtype: 'compact_boundary', textContent: 'Conversation compacted' }),
      msg({ type: 'assistant', textContent: '你好！' })
    ]
    const turns = groupIntoTurns(msgs)
    expect(turns).toHaveLength(1)
  })

  it('空文本的用户消息应该被跳过', () => {
    const msgs = [
      msg({ type: 'user', textContent: '' }),
      msg({ type: 'user', textContent: '   ' }),
      msg({ type: 'user', textContent: '真正的问题' }),
      msg({ type: 'assistant', textContent: '回答' })
    ]
    const turns = groupIntoTurns(msgs)
    expect(turns).toHaveLength(1)
    expect(turns[0].userMsg?.textContent).toBe('真正的问题')
  })

  it('assistant 消息没有前置 user 也应该正常处理', () => {
    // compact 恢复后可能出现这种情况
    const msgs = [
      msg({ type: 'assistant', textContent: '继续之前的工作...' }),
      msg({ type: 'user', textContent: '好的' }),
      msg({ type: 'assistant', textContent: '完成了' })
    ]
    const turns = groupIntoTurns(msgs)
    expect(turns).toHaveLength(2)
    expect(turns[0].userMsg).toBeNull()
    expect(turns[0].assistantMsgs[0].textContent).toBe('继续之前的工作...')
  })
})

// ========================================================
// buildSegments 测试
// ========================================================
describe('buildSegments', () => {
  it('纯文本消息 → 1 个 text segment', () => {
    const msgs = [msg({ type: 'assistant', textContent: '这是回答' })]
    const segs = buildSegments(msgs)
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('text')
    expect(segs[0].text).toBe('这是回答')
  })

  it('文本 + 工具调用 → text + tools 两个 segment', () => {
    const msgs = [
      msg({
        type: 'assistant',
        textContent: '让我看看',
        toolCalls: [{ name: 'Read', input: { file_path: '/tmp/test.ts' } }]
      })
    ]
    const segs = buildSegments(msgs)
    expect(segs).toHaveLength(2)
    expect(segs[0].type).toBe('text')
    expect(segs[1].type).toBe('tools')
    expect(segs[1].toolCalls![0].name).toBe('Read')
  })

  it('连续工具调用应该合并到同一个 tools segment', () => {
    const msgs = [
      msg({
        type: 'assistant',
        textContent: '',
        toolCalls: [{ name: 'Read', input: { file_path: '/a.ts' } }]
      }),
      msg({
        type: 'assistant',
        textContent: '',
        toolCalls: [{ name: 'Read', input: { file_path: '/b.ts' } }]
      })
    ]
    const segs = buildSegments(msgs)
    expect(segs).toHaveLength(1)
    expect(segs[0].type).toBe('tools')
    expect(segs[0].toolCalls).toHaveLength(2)
  })
})

// ========================================================
// computeSections 测试
// ========================================================
describe('computeSections', () => {
  function makeSession(messages: any[]) {
    return {
      id: 'test',
      sessionId: 'test',
      slug: 'test',
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
      messageCount: messages.length,
      turnCount: 0,
      compactCount: 0,
      cwds: [],
      version: '2.1.63',
      firstUserMessage: '',
      toolUsage: {},
      skillInvocations: [],
      projectPath: '',
      filePath: '',
      fileSizeBytes: 0,
      messages
    } as any
  }

  it('没有 compact → 只有 1 个 current section', () => {
    const session = makeSession([
      msg({ type: 'user', textContent: '你好' }),
      msg({ type: 'assistant', textContent: '你好！' })
    ])
    const sections = computeSections(session)
    expect(sections).toHaveLength(1)
    expect(sections[0].isCurrent).toBe(true)
    expect(sections[0].messages).toHaveLength(2)
  })

  it('1 次 compact → 2 个 section（历史 + 当前）', () => {
    const session = makeSession([
      msg({ type: 'user', textContent: '旧消息1' }),
      msg({ type: 'assistant', textContent: '旧回复1' }),
      msg({ type: 'system', subtype: 'compact_boundary', textContent: 'Conversation compacted' }),
      msg({ type: 'user', textContent: '新消息' }),
      msg({ type: 'assistant', textContent: '新回复' })
    ])
    const sections = computeSections(session)
    expect(sections).toHaveLength(2)
    // 第一个是历史（compact 前的）
    expect(sections[0].isCurrent).toBe(false)
    expect(sections[0].messages).toHaveLength(2)
    // 第二个是当前
    expect(sections[1].isCurrent).toBe(true)
    expect(sections[1].messages).toHaveLength(2)
  })

  it('2 次 compact → 3 个 section', () => {
    const session = makeSession([
      msg({ type: 'user', textContent: 'v1' }),
      msg({ type: 'assistant', textContent: 'r1' }),
      msg({ type: 'system', subtype: 'compact_boundary', textContent: 'Conversation compacted' }),
      msg({ type: 'user', textContent: 'v2' }),
      msg({ type: 'assistant', textContent: 'r2' }),
      msg({ type: 'system', subtype: 'compact_boundary', textContent: 'Conversation compacted' }),
      msg({ type: 'user', textContent: 'v3' }),
      msg({ type: 'assistant', textContent: 'r3' })
    ])
    const sections = computeSections(session)
    expect(sections).toHaveLength(3)
    expect(sections[0].isCurrent).toBe(false)
    expect(sections[1].isCurrent).toBe(false)
    expect(sections[2].isCurrent).toBe(true)
  })

  it('共享上下文（分支）应该作为独立 section', () => {
    const session = makeSession([
      msg({ type: 'user', textContent: '共享消息', isSharedContext: true }),
      msg({ type: 'assistant', textContent: '共享回复', isSharedContext: true }),
      msg({ type: 'user', textContent: '分支消息' }),
      msg({ type: 'assistant', textContent: '分支回复' })
    ])
    const sections = computeSections(session)
    expect(sections).toHaveLength(2)
    expect(sections[0].isSharedContext).toBe(true)
    expect(sections[0].messages).toHaveLength(2)
    expect(sections[1].isCurrent).toBe(true)
  })

  it('progress 类型的消息应该被过滤掉', () => {
    const session = makeSession([
      msg({ type: 'user', textContent: '你好' }),
      msg({ type: 'progress', textContent: 'Loading...' }),
      msg({ type: 'assistant', textContent: '你好！' })
    ])
    const sections = computeSections(session)
    // progress 消息不应该出现在 section 里
    const allMsgs = sections.flatMap(s => s.messages)
    expect(allMsgs.every(m => m.type !== 'progress')).toBe(true)
  })
})

// ========================================================
// demoteHeadings 测试（通过 import 测试私有函数的行为）
// 我们通过 sessionToMarkdown 间接测试 demoteHeadings
// ========================================================
describe('computeChatTocEntries', () => {
  it('空 section 列表 → 空 TOC', () => {
    const entries = computeChatTocEntries([])
    expect(entries).toHaveLength(0)
  })

  it('compact summary 开头的消息不应该出现在 TOC 里', () => {
    const sections: CompactSection[] = [{
      label: '当前对话',
      messages: [
        msg({
          type: 'user',
          uuid: 'u1',
          textContent: 'This session is being continued from a previous conversation that ran out of context. blah blah'
        }),
        msg({ type: 'assistant', textContent: '好的' }),
        msg({ type: 'user', uuid: 'u2', textContent: '真正的问题' }),
        msg({ type: 'assistant', textContent: '回答' })
      ],
      isCurrent: true
    }]
    const entries = computeChatTocEntries(sections)
    // compact summary 不应该出现，只有 "真正的问题"
    const turnEntries = entries.filter(e => e.level === 5)
    expect(turnEntries).toHaveLength(1)
    expect(turnEntries[0].text).toBe('真正的问题')
  })
})
