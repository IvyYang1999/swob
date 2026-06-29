import { describe, expect, it } from 'vitest'
import { collectSessionCoverage } from './session-coverage'
import type { SessionSummary } from './types'

function summary(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: overrides.id || 'logical-session',
    sessionId: overrides.sessionId || 'logical-session',
    slug: '',
    createdAt: '2026-06-14T00:00:00Z',
    updatedAt: '2026-06-14T00:00:00Z',
    messageCount: 0,
    turnCount: 0,
    compactCount: 0,
    cwds: [],
    version: '',
    firstUserMessage: '',
    toolUsage: {},
    skillInvocations: [],
    projectPath: '',
    filePath: '',
    fileSizeBytes: 0,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    ...overrides
  }
}

describe('session coverage', () => {
  it('把 compact continuation 的物理 sessionId 也视为已覆盖', () => {
    const ids = collectSessionCoverage([
      summary({
        id: 'parent-id',
        sessionId: 'parent-session',
        continuationSessionIds: ['compact-child-session']
      })
    ])

    expect(ids.has('parent-id')).toBe(true)
    expect(ids.has('parent-session')).toBe(true)
    expect(ids.has('compact-child-session')).toBe(true)
  })
})

