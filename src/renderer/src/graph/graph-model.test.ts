import { describe, expect, it } from 'vitest'
import {
  buildSessionGraph,
  deterministicInitialPosition,
  resolveSessionForGraphNode,
  totalTokensOf,
  type GraphSessionInput
} from './graph-model'

const base = (overrides: Partial<GraphSessionInput>): GraphSessionInput => ({
  id: 'session-a',
  sessionId: 'session-a',
  source: 'claude-code',
  projectPath: '/project',
  firstUserMessage: 'hello',
  turnCount: 5,
  compactCount: 0,
  createdAt: '2026-07-20T00:00:00.000Z',
  ...overrides
})

describe('buildSessionGraph', () => {
  it('draws only verified fork and continuation relations', () => {
    const sessions = [
      base({ id: 'a', sessionId: 'a' }),
      base({ id: 'b', sessionId: 'b' }),
      base({ id: 'c', sessionId: 'c', source: 'codex' })
    ]
    const graph = buildSessionGraph(sessions, {
      relations: [
        { parent: 'a', child: 'b', type: 'fork' },
        { parent: 'b', child: 'c', type: 'continuation' },
        { parent: 'a', child: 'c', type: 'project' }
      ]
    })

    expect(graph.edges).toEqual([
      { source: 'a', target: 'b', type: 'fork' },
      { source: 'b', target: 'c', type: 'continuation' }
    ])
  })

  it('does not invent edges for shared source or project', () => {
    const graph = buildSessionGraph([
      base({ id: 'a', sessionId: 'a' }),
      base({ id: 'b', sessionId: 'b' })
    ], null)
    expect(graph.edges).toHaveLength(0)
  })

  it('refuses to guess a lineage endpoint shared by intra-session branches', () => {
    const graph = buildSessionGraph([
      base({ id: 'root', sessionId: 'root' }),
      base({ id: 'child:branch-0', sessionId: 'child' }),
      base({ id: 'child:branch-1', sessionId: 'child' })
    ], { relations: [{ parent: 'root', child: 'child', type: 'fork' }] })
    expect(graph.edges).toHaveLength(0)
  })

  it('uses stable hash-derived initial positions', () => {
    expect(deterministicInitialPosition('same-id')).toEqual(deterministicInitialPosition('same-id'))
    expect(deterministicInitialPosition('same-id')).not.toEqual(deterministicInitialPosition('other-id'))
  })

  it('sums the actual token usage fields when totalTokens is absent', () => {
    expect(totalTokensOf(base({ tokenUsage: {
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 30,
      cacheReadTokens: 40
    } }))).toBe(100)
  })

  it('navigates to the exact UI session before falling back to the physical session id', () => {
    const sessions = [
      { id: 'shared:branch-0', sessionId: 'shared' },
      { id: 'shared:branch-1', sessionId: 'shared' }
    ]
    expect(resolveSessionForGraphNode(sessions, { id: 'shared:branch-1', sessionId: 'shared' }))
      .toEqual(sessions[1])
  })
})
