import { describe, expect, it } from 'vitest'
import {
  buildLogicalSessionIdentityFromMeta,
  buildLogicalSessionIdentityFromSummary,
  logicalSessionKey
} from './library-session-identity'
import { candidateFromManifest, LibrarySessionRegistry } from './library-session-registry'

function summary(sessionId: string, filePath: string, source?: any): any {
  return { sessionId, filePath, allFilePaths: [filePath], source }
}

describe('LogicalSessionKey', () => {
  it('normalizes named Claude instances without persisting home paths or usernames', () => {
    const first = buildLogicalSessionIdentityFromSummary(summary(
      'same-session',
      '/Users/alice/.claude-window/work/projects/-repo/same-session.jsonl',
      'claude-code'
    ))
    const second = buildLogicalSessionIdentityFromSummary(summary(
      'same-session',
      '/home/bob/.claude-window/work/projects/-repo/same-session.jsonl',
      'claude-code'
    ))

    expect(logicalSessionKey(first)).toBe(logicalSessionKey(second))
    expect(JSON.stringify(first)).not.toContain('alice')
    expect(JSON.stringify(first)).not.toContain('/Users')
  })

  it('keeps verified providers and semantic instances distinct', () => {
    const sessionId = 'provider-collision'
    const claudeA = buildLogicalSessionIdentityFromSummary(summary(
      sessionId,
      `/Users/u/.claude-window/a/projects/-repo/${sessionId}.jsonl`,
      'claude-code'
    ))
    const claudeB = buildLogicalSessionIdentityFromSummary(summary(
      sessionId,
      `/Users/u/.claude-window/b/projects/-repo/${sessionId}.jsonl`,
      'claude-code'
    ))
    const codex = buildLogicalSessionIdentityFromSummary(summary(
      sessionId,
      `/Users/u/.codex/sessions/2026/07/22/${sessionId}.jsonl`,
      'codex'
    ))

    expect(new Set([claudeA, claudeB, codex].map(logicalSessionKey)).size).toBe(3)
    expect(codex.sourceFamily).toBe('codex')
  })

  it('normalizes Windows drive, separator, case, and Unicode aliases deterministically', () => {
    const lower = buildLogicalSessionIdentityFromSummary(summary(
      'windows-session',
      'c:\\Users\\Alice\\.claude-window\\café\\projects\\repo\\windows-session.jsonl',
      'claude-code'
    ))
    const upper = buildLogicalSessionIdentityFromSummary(summary(
      'windows-session',
      'C:/USERS/ALICE/.CLAUDE-WINDOW/CAFE\u0301/PROJECTS/REPO/windows-session.jsonl',
      'claude-code'
    ))
    expect(logicalSessionKey(upper)).toBe(logicalSessionKey(lower))
  })

  it('normalizes forward-slash UNC aliases with Windows case semantics', () => {
    const lower = buildLogicalSessionIdentityFromSummary(summary(
      'unc-session',
      '//server/share/Users/Alice/.claude-window/work/projects/repo/unc-session.jsonl',
      'claude-code'
    ))
    const upper = buildLogicalSessionIdentityFromSummary(summary(
      'unc-session',
      '//SERVER/SHARE/USERS/ALICE/.CLAUDE-WINDOW/WORK/PROJECTS/REPO/unc-session.jsonl',
      'claude-code'
    ))
    expect(logicalSessionKey(upper)).toBe(logicalSessionKey(lower))
    expect(upper.sourceFamily).toBe('claude-code')
  })

  it('keeps multiple verified config roots for one provider distinct without path disclosure', () => {
    const work = buildLogicalSessionIdentityFromSummary(summary(
      'same-codex-session',
      '/Users/alice/.codex-work/sessions/2026/07/22/same-codex-session.jsonl',
      'codex'
    ))
    const personal = buildLogicalSessionIdentityFromSummary(summary(
      'same-codex-session',
      '/home/bob/.codex-personal/sessions/2026/07/22/same-codex-session.jsonl',
      'codex'
    ))
    expect(logicalSessionKey(work)).not.toBe(logicalSessionKey(personal))
    expect(JSON.stringify([work, personal])).not.toContain('/Users')
    expect(JSON.stringify([work, personal])).not.toContain('alice')
  })

  it('marks contradictory or insufficient legacy evidence ambiguous instead of guessing', () => {
    expect(buildLogicalSessionIdentityFromMeta({
      sessionId: 'legacy',
      sourceFilePaths: ['/unknown/transcript.jsonl']
    }).sourceFamily).toBe('legacy-ambiguous')

    expect(buildLogicalSessionIdentityFromMeta({
      sessionId: 'mixed',
      sourceFilePaths: [
        '/Users/u/.claude/projects/-repo/mixed.jsonl',
        '/Users/u/.codex/sessions/2026/07/22/mixed.jsonl'
      ]
    }).sourceFamily).toBe('legacy-ambiguous')
  })

  it('uses only the semantic segment from legacy configDir evidence', () => {
    const identity = buildLogicalSessionIdentityFromMeta({
      sessionId: 'legacy-window',
      sourceFilePaths: [],
      sourceInstance: {
        kind: 'claude-window',
        configDir: '/Users/private-user/.claude-window/work'
      }
    })
    expect(identity.sourceFamily).toBe('claude-code')
    expect(identity.sourceInstance.kind).toBe('named')
    expect(JSON.stringify(identity)).not.toContain('private-user')
    expect(JSON.stringify(identity)).not.toContain('/Users')
  })
})

describe('LibrarySessionRegistry', () => {
  const baseMeta = {
    sessionId: 'registry-session',
    sourceFilePaths: ['/Users/u/.claude/projects/-repo/registry-session.jsonl'],
    updatedAt: '2026-07-22T00:00:00.000Z'
  }

  it('retains the complete conflict set instead of last-write-wins', () => {
    const registry = new LibrarySessionRegistry()
    registry.replace([
      candidateFromManifest('/library/a', baseMeta),
      candidateFromManifest('/library/b', baseMeta)
    ])

    const resolution = registry.resolveSessionId(baseMeta.sessionId)
    expect(resolution.state).toBe('conflict')
    if (resolution.state === 'conflict') {
      expect(resolution.candidates.map((candidate) => candidate.dirPath)).toEqual(['/library/a', '/library/b'])
    }
  })

  it('deduplicates aliases but fails closed when only a symlink is visible', () => {
    const candidate = candidateFromManifest('/library/physical', baseMeta)
    const registry = new LibrarySessionRegistry()
    registry.replace([candidate, { ...candidate, isSymlink: true }])
    expect(registry.resolveSessionId(baseMeta.sessionId).state).toBe('bound')

    registry.replace([{ ...candidate, isSymlink: true }])
    expect(registry.resolveSessionId(baseMeta.sessionId).state).toBe('conflict')
  })

  it('returns typed ambiguity for one legacy sessionId across verified logical keys', () => {
    const registry = new LibrarySessionRegistry()
    registry.replace([
      candidateFromManifest('/library/claude-a', baseMeta),
      candidateFromManifest('/library/codex', {
        ...baseMeta,
        sourceFilePaths: ['/Users/u/.codex/sessions/2026/07/22/registry-session.jsonl']
      })
    ])
    expect(registry.resolveSessionId(baseMeta.sessionId).state).toBe('ambiguous')
  })

  it('is deterministic when scan order reverses', () => {
    const first = candidateFromManifest('/library/a', baseMeta)
    const second = candidateFromManifest('/library/b', baseMeta)
    const forward = new LibrarySessionRegistry()
    const reverse = new LibrarySessionRegistry()
    forward.replace([first, second])
    reverse.replace([second, first])
    expect(reverse.resolveSessionId(baseMeta.sessionId)).toEqual(forward.resolveSessionId(baseMeta.sessionId))
  })

  it('preserves a previously observed binding as read-only missing evidence', () => {
    const registry = new LibrarySessionRegistry()
    const candidate = candidateFromManifest('/library/a', baseMeta)
    registry.replace([candidate], { authoritative: true })
    registry.replace([], { authoritative: true })
    const binding = registry.get(candidate.logicalKey)
    expect(binding).toMatchObject({
      state: 'missing',
      reason: 'previously-seen',
      creationAllowed: false
    })
  })
})
