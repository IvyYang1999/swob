import type { SessionSummary } from './types'

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function sessionSource(session: SessionSummary): string {
  return session.source || 'claude-code'
}

function sameSessionIdentity(left: SessionSummary, right: SessionSummary): boolean {
  if (left.id === right.id) return true
  return left.sessionId === right.sessionId && sessionSource(left) === sessionSource(right)
}

function sameSessionReference(
  reference: string | undefined,
  session: SessionSummary,
  expectedSource: string
): boolean {
  if (reference === session.id) return true
  return reference === session.sessionId && sessionSource(session) === expectedSource
}

/**
 * A one-file live parse is authoritative for mutable counters and timestamps,
 * but it cannot rediscover cross-file lineage that the full inventory already
 * proved. Merge those projection-only fields before replacing the cached row.
 */
export function mergeLiveSessionSummary(
  incoming: SessionSummary,
  cachedSessions: readonly SessionSummary[]
): SessionSummary {
  const existing = cachedSessions.find((candidate) => candidate.id === incoming.id) ||
    cachedSessions.find((candidate) => sameSessionIdentity(candidate, incoming))
  const identity = existing || incoming
  const identitySource = sessionSource(identity)
  const branchParentId = incoming.branchParentId || existing?.branchParentId
  const parent = branchParentId
    ? cachedSessions.find((candidate) =>
        sessionSource(candidate) === identitySource &&
        sameSessionReference(branchParentId, candidate, identitySource))
    : undefined
  const branchChildIds = uniqueStrings([
    ...(existing?.branchChildIds || []),
    ...(incoming.branchChildIds || []),
    ...cachedSessions
      .filter((candidate) =>
        sessionSource(candidate) === identitySource &&
        sameSessionReference(candidate.branchParentId, identity, identitySource))
      .map((candidate) => candidate.id)
  ])
  const branchParentFilePaths = uniqueStrings([
    ...(existing?.branchParentFilePaths || []),
    ...(incoming.branchParentFilePaths || []),
    ...(parent?.allFilePaths || (parent?.filePath ? [parent.filePath] : []))
  ])
  const continuationSessionIds = uniqueStrings([
    ...(existing?.continuationSessionIds || []),
    ...(incoming.continuationSessionIds || [])
  ])

  return {
    ...incoming,
    ...(incoming.resumeSessionId || existing?.resumeSessionId
      ? { resumeSessionId: incoming.resumeSessionId || existing?.resumeSessionId }
      : {}),
    ...(incoming.successor || existing?.successor
      ? { successor: incoming.successor || existing?.successor }
      : {}),
    ...(incoming.logicalSessionKey || existing?.logicalSessionKey
      ? { logicalSessionKey: incoming.logicalSessionKey || existing?.logicalSessionKey }
      : {}),
    ...(incoming.lifecycleState || existing?.lifecycleState
      ? { lifecycleState: incoming.lifecycleState || existing?.lifecycleState }
      : {}),
    ...(branchParentId ? { branchParentId } : {}),
    ...(incoming.branchPointUuid || existing?.branchPointUuid
      ? { branchPointUuid: incoming.branchPointUuid || existing?.branchPointUuid }
      : {}),
    ...(incoming.branchLeafUuid || existing?.branchLeafUuid
      ? { branchLeafUuid: incoming.branchLeafUuid || existing?.branchLeafUuid }
      : {}),
    ...(branchChildIds.length > 0 ? { branchChildIds } : {}),
    ...(branchParentFilePaths.length > 0 ? { branchParentFilePaths } : {}),
    ...(continuationSessionIds.length > 0 ? { continuationSessionIds } : {}),
    ...(existing?.duplicate !== undefined ? { duplicate: existing.duplicate } : {}),
    ...(existing?.duplicatePackageCount !== undefined
      ? { duplicatePackageCount: existing.duplicatePackageCount }
      : {}),
    ...(existing?.duplicatePackageHistory
      ? { duplicatePackageHistory: existing.duplicatePackageHistory }
      : {})
  }
}
