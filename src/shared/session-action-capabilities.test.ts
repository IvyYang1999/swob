import { describe, expect, it } from 'vitest'
import { LEGACY_SESSION_SOURCES } from './provider-capabilities'
import { supportsVerifiedSessionFork } from './session-action-capabilities'

describe('session action capabilities', () => {
  it('exposes Fork only for sources with a verified, distinct Fork contract', () => {
    expect(LEGACY_SESSION_SOURCES.filter(supportsVerifiedSessionFork)).toEqual([
      'claude-code',
      'codex'
    ])
  })
})
