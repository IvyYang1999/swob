import type { LegacySessionSource } from './provider-capabilities'

/**
 * A source belongs here only after its CLI contract has a distinct,
 * independently verified per-session Fork operation. Resume is not Fork.
 */
const VERIFIED_SESSION_FORK_SOURCES = new Set<LegacySessionSource>([
  'claude-code',
  'codex'
])

export function supportsVerifiedSessionFork(source: string | null | undefined): boolean {
  return source !== null && source !== undefined &&
    VERIFIED_SESSION_FORK_SOURCES.has(source as LegacySessionSource)
}
