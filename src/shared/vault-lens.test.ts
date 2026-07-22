import { describe, expect, it } from 'vitest'
import { friendlyProjectName, groupSessionsByLens } from './vault-lens'

// Construct fixtures in the machine's local timezone because the product's
// 今天/昨天 buckets intentionally follow the user's system calendar.
const localTimestamp = (year: number, monthIndex: number, day: number, hour = 12): string =>
  new Date(year, monthIndex, day, hour).toISOString()
const NOW = new Date(2026, 6, 24, 12)

function session(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionId: id,
    updatedAt: localTimestamp(2026, 6, 24, 3),
    turnCount: 5,
    cwds: ['/Users/yyt/projects/swob'],
    projectPath: '/Users/yyt/.claude/projects/-Users-yyt-projects-swob',
    source: 'claude-code',
    ...overrides
  }
}

describe('Vault 镜头分组', () => {
  it('项目镜头使用友好目录名，不暴露 Claude 编码路径', () => {
    expect(friendlyProjectName(session('a'))).toBe('swob')
    const groups = groupSessionsByLens([session('a')], 'project', { now: NOW })
    expect(groups.map((group) => group.label)).toEqual(['swob'])
  })

  it('日期镜头按今天、昨天、本周、本月、更早分桶', () => {
    const groups = groupSessionsByLens([
      session('today'),
      session('yesterday', { updatedAt: localTimestamp(2026, 6, 23) }),
      session('week', { updatedAt: localTimestamp(2026, 6, 21) }),
      session('month', { updatedAt: localTimestamp(2026, 6, 2) }),
      session('old', { updatedAt: localTimestamp(2026, 5, 30) })
    ], 'date', { now: NOW })

    expect(groups.map((group) => [group.id, group.items.length])).toEqual([
      ['today', 1],
      ['yesterday', 1],
      ['week', 1],
      ['month', 1],
      ['older', 1]
    ])
  })

  it('标签镜头允许同一会话出现在多个组，未标注会话有独立组', () => {
    const groups = groupSessionsByLens([
      session('multi'),
      session('untagged')
    ], 'tags', {
      now: NOW,
      metaBySessionId: { multi: { tags: ['产品', '性能', '产品'] } }
    })

    expect(groups.find((group) => group.id === 'tag:产品')?.items.map((item) => item.id)).toEqual(['multi'])
    expect(groups.find((group) => group.id === 'tag:性能')?.items.map((item) => item.id)).toEqual(['multi'])
    expect(groups.find((group) => group.id === 'untagged')?.items.map((item) => item.id)).toEqual(['untagged'])
  })

  it('harness、轮数、来源和无分组镜头遵循稳定桶边界', () => {
    const items = [
      session('single', { turnCount: 1 }),
      session('short', { turnCount: 9, source: 'codex' }),
      session('medium', { turnCount: 10, source: 'cursor' }),
      session('long', { turnCount: 40, source: 'opencode', isRemote: true }),
      session('epic', { turnCount: 100, source: 'zcode' })
    ]

    expect(groupSessionsByLens(items, 'turns', { now: NOW }).map((group) => group.id)).toEqual([
      'single', 'short', 'medium', 'long', 'epic'
    ])
    expect(groupSessionsByLens(items, 'harness', { now: NOW }).map((group) => group.id)).toEqual([
      'harness:claude-code', 'harness:codex', 'harness:cursor', 'harness:opencode', 'harness:zcode'
    ])
    expect(groupSessionsByLens(items, 'source', { now: NOW }).map((group) => [group.id, group.items.length])).toEqual([
      ['local', 4], ['cloud', 1]
    ])
    expect(groupSessionsByLens(items, 'none', { now: NOW })).toHaveLength(1)
  })

  it('镜头分组是纯计算，不修改输入会话或 meta', () => {
    const items = [session('immutable')]
    const meta = { immutable: { tags: ['只读'] } }
    const beforeItems = structuredClone(items)
    const beforeMeta = structuredClone(meta)

    groupSessionsByLens(items, 'tags', { now: NOW, metaBySessionId: meta })

    expect(items).toEqual(beforeItems)
    expect(meta).toEqual(beforeMeta)
  })
})
