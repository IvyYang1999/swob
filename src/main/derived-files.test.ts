import { describe, expect, it } from 'vitest'
import type { RawJsonlMessage } from './types'
import {
  COMPACT_SUMMARIES_GENERATOR,
  USER_QUERIES_GENERATOR,
  extractCompactSummaryBlocks,
  extractUserQueryBlocks
} from './derived-files'

function rawMsg(overrides: Partial<RawJsonlMessage> & Record<string, unknown> = {}): RawJsonlMessage {
  const type = (overrides.type as RawJsonlMessage['type']) || 'user'
  return {
    uuid: String(overrides.uuid || 'u1'),
    parentUuid: (overrides.parentUuid as string | null | undefined) ?? null,
    sessionId: String(overrides.sessionId || 's1'),
    type,
    subtype: overrides.subtype as string | undefined,
    timestamp: String(overrides.timestamp || '2026-07-09T00:00:00Z'),
    promptSource: type === 'user' ? 'typed' : undefined,
    message: overrides.message as RawJsonlMessage['message'],
    ...overrides
  }
}

describe('派生文件生成器', () => {
  it('compact 摘要生成器：有 compact continuation 摘要时生成非空 markdown', () => {
    const raw = [
      rawMsg({
        uuid: 'u1',
        timestamp: '2026-07-09T00:00:00Z',
        message: { role: 'user', content: '第一轮真实问题' }
      }),
      rawMsg({
        uuid: 'cb',
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-07-09T00:10:00Z',
        message: { role: 'system', content: 'Conversation compacted' }
      }),
      rawMsg({
        uuid: 'summary',
        timestamp: '2026-07-09T00:11:00Z',
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context. Summary: 已完成架构梳理，下一步写测试。'
        }
      })
    ]

    const blocks = extractCompactSummaryBlocks(raw)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe('已完成架构梳理，下一步写测试。')

    const md = COMPACT_SUMMARIES_GENERATOR.generate(raw, { sessionId: 's1' })
    expect(md).not.toBeNull()
    expect(md).toContain('# Compact Summaries')
    expect(md).toContain('已完成架构梳理')
  })

  it('compact 摘要生成器：无 compact 摘要时返回 null', () => {
    const md = COMPACT_SUMMARIES_GENERATOR.generate([
      rawMsg({ message: { role: 'user', content: '普通问题' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '普通回答' } })
    ], { sessionId: 's1' })

    expect(md).toBeNull()
  })

  it('User Query 生成器：只抽真实用户消息并排除系统注入', () => {
    const raw = [
      rawMsg({ uuid: 'real-1', timestamp: '2026-07-09T00:00:00Z', message: { role: 'user', content: '真正的问题 1' } }),
      rawMsg({ uuid: 'task', timestamp: '2026-07-09T00:01:00Z', message: { role: 'user', content: '<task-notification>done</task-notification>' } }),
      rawMsg({ uuid: 'continued', timestamp: '2026-07-09T00:02:00Z', message: { role: 'user', content: 'This session is being continued from a previous conversation. Summary: old' } }),
      rawMsg({ uuid: 'tool', timestamp: '2026-07-09T00:03:00Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] as any } }),
      rawMsg({ uuid: 'real-2', timestamp: '2026-07-09T00:04:00Z', message: { role: 'user', content: [{ type: 'text', text: '真正的问题 2' }] as any } })
    ]

    const blocks = extractUserQueryBlocks(raw)
    expect(blocks.map((block) => block.text)).toEqual(['真正的问题 1', '真正的问题 2'])

    const md = USER_QUERIES_GENERATOR.generate(raw, { sessionId: 's1' })
    expect(md).not.toBeNull()
    expect(md).toContain('真正的问题 1')
    expect(md).toContain('真正的问题 2')
    expect(md).not.toContain('task-notification')
    expect(md).not.toContain('This session is being continued')
  })

  it('派生文件带最小 frontmatter：sessionId 和 derived 类型', () => {
    const md = USER_QUERIES_GENERATOR.generate([
      rawMsg({ sessionId: 'frontmatter-session', message: { role: 'user', content: '检查 frontmatter' } })
    ], { sessionId: 'frontmatter-session' })

    expect(md).not.toBeNull()
    expect(md!.startsWith('---\n')).toBe(true)
    expect(md).toContain('sessionId: frontmatter-session')
    expect(md).toContain('type: derived-user-queries')
  })
})
