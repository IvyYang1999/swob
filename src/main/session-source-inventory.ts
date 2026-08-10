import type { SessionSummary } from './types'

type ProviderSessionPredicate = (session: SessionSummary) => boolean

export type LiveSessionInventoryUpdate = {
  kind: 'session' | 'continuation'
  summary: SessionSummary
}

/**
 * Authoritative in-memory view of sessions discovered from source runtimes.
 *
 * Exclusions are a presentation/write policy, not a deletion operation. Keep
 * them out of this inventory so a failed onboarding attempt can be retried
 * with a different selection without reloading every source from disk.
 */
export class SessionSourceInventory {
  private sessions: SessionSummary[] = []

  constructor(private readonly isProviderSession: ProviderSessionPredicate) {}

  snapshot(): SessionSummary[] {
    return [...this.sessions]
  }

  filtered(excludedSources: readonly string[]): SessionSummary[] {
    return filterSessionSources(this.sessions, excludedSources)
  }

  merge(patch: readonly SessionSummary[]): void {
    if (patch.length === 0) return
    const byId = new Map(this.sessions.map((session) => [session.id, session]))
    for (const session of patch) byId.set(session.id, session)
    this.sessions = sortSessions(byId.values())
  }

  remove(ids: readonly string[]): void {
    if (ids.length === 0) return
    const removed = new Set(ids)
    this.sessions = this.sessions.filter((session) => !removed.has(session.id))
  }

  applyLiveSummary(summary: SessionSummary): LiveSessionInventoryUpdate {
    const source = summary.source || 'claude-code'
    const continuationParent = this.sessions.find((session) =>
      (session.source || 'claude-code') === source &&
      session.continuationSessionIds?.includes(summary.sessionId)
    )
    if (!continuationParent) {
      this.merge([summary])
      return { kind: 'session', summary }
    }

    const updatedParent: SessionSummary = {
      ...continuationParent,
      updatedAt: summary.updatedAt > continuationParent.updatedAt
        ? summary.updatedAt
        : continuationParent.updatedAt,
      permissionMode: summary.permissionMode || continuationParent.permissionMode,
      resumeCwd: summary.resumeCwd || continuationParent.resumeCwd
    }
    this.remove([summary.id])
    this.merge([updatedParent])
    return { kind: 'continuation', summary: updatedParent }
  }

  replacePhysical(snapshot: readonly SessionSummary[]): void {
    const byId = new Map(
      this.sessions
        .filter(this.isProviderSession)
        .map((session) => [session.id, session])
    )
    for (const session of snapshot) {
      if (!this.isProviderSession(session)) byId.set(session.id, session)
    }
    this.sessions = sortSessions(byId.values())
  }

  replaceProviders(snapshot: readonly SessionSummary[]): void {
    const byId = new Map(
      this.sessions
        .filter((session) => !this.isProviderSession(session))
        .map((session) => [session.id, session])
    )
    for (const session of snapshot) {
      if (this.isProviderSession(session)) byId.set(session.id, session)
    }
    this.sessions = sortSessions(byId.values())
  }
}

export function filterSessionSources(
  sessions: readonly SessionSummary[],
  excludedSources: readonly string[]
): SessionSummary[] {
  if (excludedSources.length === 0) return [...sessions]
  const excluded = new Set(excludedSources)
  return sessions.filter((session) => !excluded.has(session.source || 'claude-code'))
}

function sortSessions(sessions: Iterable<SessionSummary>): SessionSummary[] {
  return [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}
