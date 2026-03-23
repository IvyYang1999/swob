/**
 * session-loader.ts 核心解析逻辑测试
 *
 * 这些函数虽然不是 UI，但出 bug 时你看到的全是 UI 怪象：
 * - 列表里 session 标题是 "[Request interrupted..."
 * - 点击 session 看到空白
 * - 工具统计数字不对
 * - 分支检测误判
 */
import { describe, it, expect } from 'vitest'
import { buildSessionSummary, buildSessionDetail, detectIntraFileBranches, filterMessagesByBranch, isRealUserMessage } from './session-loader'
import type { RawJsonlMessage } from './types'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// --- 造假 JSONL 消息的工具函数 ---
function rawMsg(overrides: Partial<RawJsonlMessage> & { type: RawJsonlMessage['type'] }): RawJsonlMessage {
  return {
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    parentUuid: overrides.parentUuid ?? null,
    sessionId: overrides.sessionId || 'test-session-id',
    type: overrides.type,
    subtype: overrides.subtype,
    timestamp: overrides.timestamp || '2026-03-01T00:00:00Z',
    cwd: overrides.cwd || '/Users/test',
    version: overrides.version || '2.1.63',
    slug: overrides.slug,
    isSidechain: overrides.isSidechain,
    message: overrides.message,
    permissionMode: overrides.permissionMode
  }
}

// 写一个临时 JSONL 文件（测试 parseSessionFile 用）
function writeTempJsonl(messages: RawJsonlMessage[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-test-'))
  const fp = path.join(dir, 'test-session-id.jsonl')
  const content = messages.map((m) => JSON.stringify(m)).join('\n')
  fs.writeFileSync(fp, content)
  return fp
}

// ========================================================
// buildSessionSummary 测试
// ========================================================
describe('buildSessionSummary', () => {
  it('基本解析：提取 sessionId、时间、轮次', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '你好！' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    expect(summary!.sessionId).toBe('test-session-id')
    expect(summary!.turnCount).toBe(1)
    expect(summary!.messageCount).toBe(2)
    expect(summary!.createdAt).toBe('2026-03-01T10:00:00Z')
    expect(summary!.firstUserMessage).toBe('你好')
  })

  it('【真实 bug】firstUserMessage 应该跳过 "[Request interrupted..."', () => {
    // 之前这种消息会作为 session 标题显示，用户看到一堆 "[Request interrupted..."
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool_use]' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '...' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '帮我写一个排序函数' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('帮我写一个排序函数')
  })

  it('firstUserMessage 应该跳过 compact 续写开头', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '继续帮我改那个 bug' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '改好了' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('继续帮我改那个 bug')
  })

  it('compact 次数统计', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '第一轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
      rawMsg({ type: 'system', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '第二轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
      rawMsg({ type: 'system', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '第三轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.compactCount).toBe(2)
  })

  it('工具调用统计', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '读一下文件' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看' },
            { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Read', id: 't2', input: { file_path: '/b.ts' } },
            { type: 'tool_use', name: 'Bash', id: 't3', input: { command: 'ls' } }
          ]
        }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.toolUsage['Read']).toBe(2)
    expect(summary!.toolUsage['Bash']).toBe(1)
  })

  it('subagent 文件路径应该返回 null', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } })
    ]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-test-'))
    const subDir = path.join(dir, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const fp = path.join(subDir, 'agent-abc.jsonl')
    fs.writeFileSync(fp, msgs.map((m) => JSON.stringify(m)).join('\n'))

    const summary = buildSessionSummary(fp, msgs)
    expect(summary).toBeNull()
  })

  it('空消息列表应该返回 null', () => {
    const fp = writeTempJsonl([])
    const summary = buildSessionSummary(fp, [])
    expect(summary).toBeNull()
  })

  it('多个 cwd 都应该被收集', () => {
    const msgs = [
      rawMsg({ type: 'user', cwd: '/Users/test/project-a', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', cwd: '/Users/test/project-a', message: { role: 'assistant', content: '好' } }),
      rawMsg({ type: 'user', cwd: '/Users/test/project-b', message: { role: 'user', content: '切目录了' } }),
      rawMsg({ type: 'assistant', cwd: '/Users/test/project-b', message: { role: 'assistant', content: '好' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.cwds).toContain('/Users/test/project-a')
    expect(summary!.cwds).toContain('/Users/test/project-b')
  })

  it('content 是数组格式（含图片等）也能正确提取文本', () => {
    const msgs = [
      rawMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image', source: { type: 'base64', data: '...' } }
          ] as any
        }
      }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '我看到了' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('看看这张图')
  })
})

// ========================================================
// buildSessionDetail 测试
// ========================================================
describe('buildSessionDetail', () => {
  it('【真实 bug】task-notification 应该被标记为特殊 subtype', () => {
    // 这个 bug 导致 <task-notification> 显示为用户消息
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '帮我做个功能' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<task-notification>Task 1 completed</task-notification>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '继续' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '继续做' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    // 第三条消息（task-notification）应该有特殊 subtype
    const taskNotif = detail!.messages.find((m) => m.subtype === 'task-notification')
    expect(taskNotif).toBeDefined()
    expect(taskNotif!.textContent).toContain('task-notification')
  })

  it('tool_result 应该被关联到对应的 tool_use', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '读文件' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看' },
            { type: 'tool_use', name: 'Read', id: 'tool-123', input: { file_path: '/tmp/test.ts' } }
          ]
        }
      }),
      rawMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-123', content: '文件内容在这里...' }
          ]
        }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const assistantMsg = detail!.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg!.toolCalls[0].result).toBe('文件内容在这里...')
  })

  it('isPreCompact 标记：compact 之前的消息应该标为 true', () => {
    const msgs = [
      rawMsg({ type: 'user', uuid: 'u1', message: { role: 'user', content: '旧消息' } }),
      rawMsg({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '旧回复' } }),
      rawMsg({ type: 'system', uuid: 's1', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', uuid: 'u2', message: { role: 'user', content: '新消息' } }),
      rawMsg({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: '新回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const oldMsg = detail!.messages.find((m) => m.uuid === 'u1')
    const newMsg = detail!.messages.find((m) => m.uuid === 'u2')
    expect(oldMsg!.isPreCompact).toBe(true)
    expect(newMsg!.isPreCompact).toBe(false)
  })

  it('sidechain 消息应该标记 isSidechain', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: '这是被拒绝的回复' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '这是最终回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const sidechain = detail!.messages.filter((m) => m.isSidechain)
    expect(sidechain).toHaveLength(1)
    expect(sidechain[0].textContent).toBe('这是被拒绝的回复')
  })
})

// ========================================================
// detectIntraFileBranches 测试
// ========================================================

/**
 * 构造一个有真实分支的消息树：两个终端同时 resume 同一 session，
 * 消息时间交错（M↔B 切换 >= 3 次）。
 *
 * 树结构：
 *   shared1 → shared2 → shared3 (fork point)
 *                           ├→ main1 → main2 → main3 (主路径，更长)
 *                           └→ branch1 → branch2     (分支)
 * 时间交错：main1, branch1, main2, branch2, main3
 */
function buildBranchTree() {
  const shared1 = rawMsg({ uuid: 's1', parentUuid: null, type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '开始对话' } })
  const shared2 = rawMsg({ uuid: 's2', parentUuid: 's1', type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })
  const shared3 = rawMsg({ uuid: 's3', parentUuid: 's2', type: 'user', timestamp: '2026-03-01T10:02:00Z', message: { role: 'user', content: '继续' } })

  // Main path (longer)
  const main1 = rawMsg({ uuid: 'm1', parentUuid: 's3', type: 'assistant', timestamp: '2026-03-01T10:03:00Z', message: { role: 'assistant', content: '主路径回复1' } })
  const main2 = rawMsg({ uuid: 'm2', parentUuid: 'm1', type: 'user', timestamp: '2026-03-01T10:05:00Z', message: { role: 'user', content: '主路径问题2' } })
  const main3 = rawMsg({ uuid: 'm3', parentUuid: 'm2', type: 'assistant', timestamp: '2026-03-01T10:07:00Z', message: { role: 'assistant', content: '主路径回复2' } })

  // Branch path (shorter, timestamps interleave with main)
  const branch1 = rawMsg({ uuid: 'b1', parentUuid: 's3', type: 'assistant', timestamp: '2026-03-01T10:04:00Z', message: { role: 'assistant', content: '分支回复1' } })
  const branch2 = rawMsg({ uuid: 'b2', parentUuid: 'b1', type: 'user', timestamp: '2026-03-01T10:06:00Z', message: { role: 'user', content: '分支问题2' } })

  return [shared1, shared2, shared3, main1, main2, main3, branch1, branch2]
}

describe('【曾经的 bug】分支检测不能被 traceToRoot 的改动破坏', () => {
  it('能检测到时间交错的真实分支', () => {
    const msgs = buildBranchTree()
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
    expect(branches[0].firstUserMessage).toBe('分支问题2')
  })

  it('分支的 turnCount 包含共享上下文的轮数', () => {
    const msgs = buildBranchTree()
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
    // 共享上下文: 1轮 (s1→s2) + 分支独有: 1轮 (b1→b2 中 user=b2) = 至少 > 0
    // 完整路径: s1, s2, s3, b1, b2 → user: s1, s3, b2 (3) / assistant: s2, b1 (2) → min(3,2) = 2
    expect(branches[0].turnCount).toBeGreaterThanOrEqual(2)
  })

  it('有 compact 边界时分支仍能被检测到', () => {
    // compact_boundary 的 parentUuid=null 不应该影响分支检测
    const compact = rawMsg({
      uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary',
      timestamp: '2026-03-01T09:00:00Z'
    })
    // @ts-expect-error logicalParentUuid not in type for tests
    compact.logicalParentUuid = 'pre-compact-msg'

    const preCompact = rawMsg({ uuid: 'pre-compact-msg', parentUuid: null, type: 'user', timestamp: '2026-03-01T08:00:00Z', message: { role: 'user', content: '远古消息' } })
    const afterCompact = rawMsg({ uuid: 'ac1', parentUuid: 'cb', type: 'user', timestamp: '2026-03-01T09:01:00Z', message: { role: 'user', content: 'compact 后的对话' } })

    // Fork after compact
    const main1 = rawMsg({ uuid: 'pm1', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:02:00Z', message: { role: 'assistant', content: '主1' } })
    const main2 = rawMsg({ uuid: 'pm2', parentUuid: 'pm1', type: 'user', timestamp: '2026-03-01T09:04:00Z', message: { role: 'user', content: '主2' } })
    const main3 = rawMsg({ uuid: 'pm3', parentUuid: 'pm2', type: 'assistant', timestamp: '2026-03-01T09:06:00Z', message: { role: 'assistant', content: '主3' } })

    const branch1 = rawMsg({ uuid: 'pb1', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:03:00Z', message: { role: 'assistant', content: '支1' } })
    const branch2 = rawMsg({ uuid: 'pb2', parentUuid: 'pb1', type: 'user', timestamp: '2026-03-01T09:05:00Z', message: { role: 'user', content: '支2' } })

    const msgs = [preCompact, compact, afterCompact, main1, main2, main3, branch1, branch2]
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
  })

  it('两边都 compact 后仍能检测到分支', () => {
    // 场景：fork 后两个终端各自聊了很久，各自触发了 compact
    // traceToRoot 需要穿越各自的 compact_boundary 才能找到共享前缀
    const shared1 = rawMsg({ uuid: 'sh1', parentUuid: null, type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '开始对话' } })
    const shared2 = rawMsg({ uuid: 'sh2', parentUuid: 'sh1', type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })

    // Main path: fork → lots of messages → compact → continue
    const mainPre = rawMsg({ uuid: 'mp1', parentUuid: 'sh2', type: 'user', timestamp: '2026-03-01T10:02:00Z', message: { role: 'user', content: '主路径开始' } })
    const mainPre2 = rawMsg({ uuid: 'mp2', parentUuid: 'mp1', type: 'assistant', timestamp: '2026-03-01T10:04:00Z', message: { role: 'assistant', content: '主路径回复' } })
    const mainCompact = rawMsg({ uuid: 'mc', parentUuid: null, type: 'system', subtype: 'compact_boundary', timestamp: '2026-03-01T11:00:00Z' })
    // @ts-expect-error
    mainCompact.logicalParentUuid = 'mp2'
    const mainPost1 = rawMsg({ uuid: 'mq1', parentUuid: 'mc', type: 'user', timestamp: '2026-03-01T11:01:00Z', message: { role: 'user', content: '主路径继续' } })
    const mainPost2 = rawMsg({ uuid: 'mq2', parentUuid: 'mq1', type: 'assistant', timestamp: '2026-03-01T11:02:00Z', message: { role: 'assistant', content: '主路径继续回复' } })

    // Branch path: fork → lots of messages → compact → continue (timestamps interleave with main)
    const brPre = rawMsg({ uuid: 'bp1', parentUuid: 'sh2', type: 'user', timestamp: '2026-03-01T10:03:00Z', message: { role: 'user', content: '分支路径开始' } })
    const brPre2 = rawMsg({ uuid: 'bp2', parentUuid: 'bp1', type: 'assistant', timestamp: '2026-03-01T10:05:00Z', message: { role: 'assistant', content: '分支回复' } })
    const brCompact = rawMsg({ uuid: 'bc', parentUuid: null, type: 'system', subtype: 'compact_boundary', timestamp: '2026-03-01T11:05:00Z' })
    // @ts-expect-error
    brCompact.logicalParentUuid = 'bp2'
    const brPost1 = rawMsg({ uuid: 'bq1', parentUuid: 'bc', type: 'user', timestamp: '2026-03-01T11:06:00Z', message: { role: 'user', content: '分支继续' } })

    const msgs = [shared1, shared2, mainPre, mainPre2, mainCompact, mainPost1, mainPost2, brPre, brPre2, brCompact, brPost1]
    const branches = detectIntraFileBranches(msgs)

    // 关键：即使两边都 compact 了，分支也必须被检测到
    expect(branches.length).toBeGreaterThanOrEqual(1)
  })
})

describe('filterMessagesByBranch 穿越 compact 边界', () => {
  it('分支过滤结果包含 compact 之前的消息', () => {
    const preCompact = rawMsg({ uuid: 'old1', parentUuid: null, type: 'user', timestamp: '2026-03-01T08:00:00Z', message: { role: 'user', content: '远古消息' } })
    const preCompact2 = rawMsg({ uuid: 'old2', parentUuid: 'old1', type: 'assistant', timestamp: '2026-03-01T08:01:00Z', message: { role: 'assistant', content: '远古回复' } })
    const compact = rawMsg({
      uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary',
      timestamp: '2026-03-01T09:00:00Z'
    })
    // @ts-expect-error
    compact.logicalParentUuid = 'old2'

    const afterCompact = rawMsg({ uuid: 'ac1', parentUuid: 'cb', type: 'user', timestamp: '2026-03-01T09:01:00Z', message: { role: 'user', content: '新消息' } })
    const afterCompact2 = rawMsg({ uuid: 'ac2', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:02:00Z', message: { role: 'assistant', content: '新回复' } })

    const msgs = [preCompact, preCompact2, compact, afterCompact, afterCompact2]
    const filtered = filterMessagesByBranch(msgs, 'ac2')

    // 应该包含 compact 之前和之后的所有消息
    const uuids = filtered.map(m => m.uuid)
    expect(uuids).toContain('old1')
    expect(uuids).toContain('old2')
    expect(uuids).toContain('cb')
    expect(uuids).toContain('ac1')
    expect(uuids).toContain('ac2')
  })
})

// ========================================================
// isRealUserMessage + turnCount 测试
// ========================================================

describe('【曾经的 bug】turnCount 不能把工具结果算成用户轮次', () => {
  it('tool_result 不是真实用户消息', () => {
    const toolResult = rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'file written' }] }
    })
    expect(isRealUserMessage(toolResult)).toBe(false)
  })

  it('纯文本的用户消息是真实的', () => {
    const textMsg = rawMsg({
      type: 'user',
      message: { role: 'user', content: '你好' }
    })
    expect(isRealUserMessage(textMsg)).toBe(true)
  })

  it('task-notification 不是真实用户消息', () => {
    const taskMsg = rawMsg({
      type: 'user',
      message: { role: 'user', content: '<task-notification>task completed</task-notification>' }
    })
    expect(isRealUserMessage(taskMsg)).toBe(false)
  })

  it('含 text 部分的 array content 是真实用户消息', () => {
    const mixed = rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '请帮我看看' }] as any }
    })
    expect(isRealUserMessage(mixed)).toBe(true)
  })

  it('1 个用户消息 + 8 个 tool_result = turnCount 应该是 1 而不是 9', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'https://example.com' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'WebFetch', input: {} }] as any } }),
      rawMsg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'fetched' }] as any } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '继续' }, { type: 'tool_use', name: 'Write', input: {} }] as any } }),
      rawMsg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'written' }] as any } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:03:00Z', message: { role: 'assistant', content: '完成' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    // 只有 1 个真实用户消息，turnCount 应该是 1
    expect(summary!.turnCount).toBe(1)
  })
})
