import { describe, expect, it } from 'vitest'
import { buildExecutionTree } from './execution-tree'
import type { SessionSubagentSummary } from './types'

describe('buildExecutionTree linked Codex subagents', () => {
  it('把 thread_spawn 作为父会话执行树节点，guardian 不作为可见 Agent 节点', () => {
    const linked: SessionSubagentSummary[] = [
      {
        sessionId: 'child-agent',
        parentSessionId: 'parent',
        role: 'thread-spawn',
        filePath: '/tmp/child.jsonl',
        createdAt: '2026-07-22T00:00:00Z',
        updatedAt: '2026-07-22T00:01:00Z',
        agentPath: '/root/review',
        agentNickname: 'Reviewer',
        status: 'completed'
      },
      {
        sessionId: 'guardian',
        parentSessionId: 'parent',
        role: 'guardian',
        filePath: '/tmp/guardian.jsonl',
        createdAt: '2026-07-22T00:00:00Z',
        updatedAt: '2026-07-22T00:01:00Z',
        status: 'completed'
      }
    ]

    const tree = buildExecutionTree([], 'parent', linked)

    expect(tree.totalAgentSpawns).toBe(1)
    expect(tree.totalToolCalls).toBe(1)
    expect(tree.toolCallsByName.Agent).toBe(1)
    expect(tree.turns[0].agentSpawns).toEqual([
      expect.objectContaining({ id: 'child-agent', subagentType: 'Reviewer', status: 'completed' })
    ])
  })

  it('孙级 thread_spawn 挂在顶层的 subagents 里，但执行树只显示直接子 agent（F1b）', () => {
    const linked: SessionSubagentSummary[] = [
      {
        sessionId: 'child-agent',
        parentSessionId: 'parent',
        role: 'thread-spawn',
        filePath: '/tmp/child.jsonl',
        createdAt: '2026-07-22T00:00:00Z',
        updatedAt: '2026-07-22T00:01:00Z',
        agentNickname: 'Reviewer',
        status: 'completed'
      },
      {
        sessionId: 'grandchild-agent',
        parentSessionId: 'child-agent',
        role: 'thread-spawn',
        filePath: '/tmp/grandchild.jsonl',
        createdAt: '2026-07-22T00:00:30Z',
        updatedAt: '2026-07-22T00:00:50Z',
        agentNickname: 'Helper',
        status: 'completed'
      }
    ]

    const tree = buildExecutionTree([], 'parent', linked)

    expect(tree.totalAgentSpawns).toBe(1)
    expect(tree.turns.flatMap((turn) => turn.agentSpawns).map((spawn) => spawn.id)).toEqual(['child-agent'])
  })
})
