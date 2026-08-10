import { describe, expect, it } from 'vitest'
import {
  filterProjectedPhysicalSourcePaths,
  isSessionSourceProjected,
  resolveSessionProjectionSource
} from './session-projection-policy'

describe('session projection policy', () => {
  it('resolves canonical, physical-path and persisted logical source evidence', () => {
    expect(resolveSessionProjectionSource({ canonicalProviderId: 'swob/pi' })).toBe('pi')
    expect(resolveSessionProjectionSource({
      sourceFilePaths: ['/Users/test/.codex/sessions/2026/session.jsonl']
    })).toBe('codex')
    expect(resolveSessionProjectionSource({ logicalSourceFamily: 'cursor' })).toBe('cursor')
  })

  it('hides only a proved excluded source and keeps unknown Library-only data visible', () => {
    expect(isSessionSourceProjected('claude-code', ['claude-code'])).toBe(false)
    expect(isSessionSourceProjected('codex', ['claude-code'])).toBe(true)
    expect(isSessionSourceProjected(null, ['claude-code'])).toBe(true)
  })

  it('does not let an unknown canonical provider override valid path evidence', () => {
    expect(resolveSessionProjectionSource({
      canonicalProviderId: 'unknown/provider',
      sourceFilePaths: ['/Users/test/.cursor/projects/demo/session.jsonl']
    })).toBe('cursor')
  })

  it('filters excluded physical sources before search indexing', () => {
    const claude = '/Users/test/.claude/projects/demo/session.jsonl'
    const codex = '/Users/test/.codex/sessions/2026/session.jsonl'
    expect(filterProjectedPhysicalSourcePaths([claude, codex], ['claude-code']))
      .toEqual([codex])
    expect(filterProjectedPhysicalSourcePaths([claude, codex], ['codex']))
      .toEqual([claude])
  })
})
