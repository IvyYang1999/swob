import { describe, expect, it } from 'vitest'
import { mergeLiveSessionSummary } from './live-session-summary'
import type { SessionSummary } from './types'

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    sessionId: id.replace(/^codex:/, ''),
    slug: id,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    messageCount: 2,
    turnCount: 1,
    compactCount: 0,
    cwds: ['/repo'],
    version: 'test',
    firstUserMessage: id,
    toolUsage: {},
    skillInvocations: [],
    projectPath: '/repo',
    filePath: `/sessions/${id}.jsonl`,
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0
    },
    referencedFiles: [],
    configFiles: [],
    ...overrides
  }
}

describe('live session summary lineage merge', () => {
  it('does not erase a parent branch list when a one-file refresh omits lineage', () => {
    const parent = summary('codex:parent', {
      branchChildIds: ['codex:child'],
      logicalSessionKey: 'codex-parent-key',
      duplicate: true,
      duplicatePackageCount: 2
    })
    const child = summary('codex:child', {
      branchParentId: 'codex:parent',
      lifecycleState: 'replayed'
    })
    const incoming = summary('codex:parent', {
      updatedAt: '2026-08-02T01:00:00.000Z',
      turnCount: 8
    })

    expect(mergeLiveSessionSummary(incoming, [parent, child])).toMatchObject({
      updatedAt: '2026-08-02T01:00:00.000Z',
      turnCount: 8,
      branchChildIds: ['codex:child'],
      logicalSessionKey: 'codex-parent-key',
      duplicate: true,
      duplicatePackageCount: 2
    })
  })

  it('retains child lifecycle and reconstructs parent source paths', () => {
    const parent = summary('codex:parent', {
      filePath: '/sessions/parent.jsonl',
      allFilePaths: ['/sessions/parent.jsonl', '/sessions/parent-archived.jsonl']
    })
    const child = summary('codex:child', {
      branchParentId: 'codex:parent',
      branchPointUuid: 'turn-12',
      branchParentFilePaths: ['/sessions/parent.jsonl'],
      lifecycleState: 'replayed'
    })
    const incoming = summary('codex:child', { turnCount: 4 })

    expect(mergeLiveSessionSummary(incoming, [parent, child])).toMatchObject({
      branchParentId: 'codex:parent',
      branchPointUuid: 'turn-12',
      branchParentFilePaths: [
        '/sessions/parent.jsonl',
        '/sessions/parent-archived.jsonl'
      ],
      lifecycleState: 'replayed',
      turnCount: 4
    })
  })

  it('does not merge lineage when two providers reuse the same raw session UUID', () => {
    const claude = summary('claude-row', {
      sessionId: 'shared-uuid',
      source: 'claude-code',
      branchChildIds: ['claude-child'],
      duplicate: true,
      duplicatePackageCount: 3,
      filePath: '/claude/shared-uuid.jsonl'
    })
    const incomingCodex = summary('codex:shared-uuid', {
      sessionId: 'shared-uuid',
      source: 'codex',
      branchParentId: 'shared-parent'
    })
    const claudeParent = summary('claude-parent-row', {
      sessionId: 'shared-parent',
      source: 'claude-code',
      filePath: '/claude/shared-parent.jsonl'
    })

    const merged = mergeLiveSessionSummary(incomingCodex, [claude, claudeParent])
    expect(merged.branchChildIds).toBeUndefined()
    expect(merged.branchParentFilePaths).toBeUndefined()
    expect(merged.duplicate).toBeUndefined()
    expect(merged.duplicatePackageCount).toBeUndefined()
  })
})
