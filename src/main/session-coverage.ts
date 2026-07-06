import type { SessionSummary } from './types'

export function addSessionCoverage(ids: Set<string>, session: SessionSummary): void {
  ids.add(session.sessionId)
  ids.add(session.id)
  for (const continuationId of session.continuationSessionIds || []) {
    ids.add(continuationId)
  }
}

export function collectSessionCoverage(sessions: SessionSummary[]): Set<string> {
  const ids = new Set<string>()
  for (const session of sessions) addSessionCoverage(ids, session)
  return ids
}

