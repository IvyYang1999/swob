/** Pure, stat-only Library freshness calculation shared by main and CLI. */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SessionFreshness } from '../shared/library-health-contract'

export const DEFAULT_STALE_THRESHOLD_MS = 60_000
export const ERROR_LAG_THRESHOLD_MS = 5 * 60_000
const CLOCK_SKEW_TOLERANCE_MS = 5_000

export interface FreshnessOptions {
  canonicalRecordsFile?: string | null
  now?: () => number
  thresholdMs?: number
}

/**
 * Stable identity for a set of error-level freshness failures. Runtime lag is
 * intentionally excluded: a missing replica keeps aging every poll, but that
 * is still one incident until its source/artifact timestamps or reasons change.
 */
export function freshnessDiagnosticFingerprint(
  freshnessEntries: readonly SessionFreshness[]
): string {
  return [...freshnessEntries]
    .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
    .map((freshness) => [
      freshness.sessionId,
      freshness.sourceUpdatedAt,
      freshness.canonicalUpdatedAt,
      freshness.transcriptUpdatedAt,
      freshness.backupUpdatedAt,
      freshness.reasons.join(',')
    ].join(':'))
    .join('|')
}

function normalizeThreshold(thresholdMs: number | undefined): number {
  return typeof thresholdMs === 'number' && Number.isFinite(thresholdMs) && thresholdMs >= 0
    ? thresholdMs
    : DEFAULT_STALE_THRESHOLD_MS
}

function statMtimeIso(filePath: string): string | null {
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString()
  } catch {
    return null
  }
}

export function computeSessionFreshness(
  sessionId: string,
  dirPath: string,
  sourceFilePaths: string[],
  options: FreshnessOptions = {}
): SessionFreshness {
  const now = (options.now || Date.now)()
  const thresholdMs = normalizeThreshold(options.thresholdMs)

  let sourceUpdatedAt: string | null = null
  let sourceMs = 0
  for (const srcPath of sourceFilePaths) {
    try {
      const virtualSeparator = srcPath.indexOf('#')
      const statPath = fs.existsSync(srcPath) || virtualSeparator <= 0
        ? srcPath
        : srcPath.slice(0, virtualSeparator)
      const stat = fs.statSync(statPath)
      if (stat.mtimeMs > sourceMs) {
        sourceMs = stat.mtimeMs
        sourceUpdatedAt = new Date(stat.mtimeMs).toISOString()
      }
    } catch { /* remote, placeholder or missing source */ }
  }

  const transcriptUpdatedAt = statMtimeIso(path.join(dirPath, 'transcript.md'))
  const backupUpdatedAt = statMtimeIso(path.join(dirPath, 'backup.jsonl'))
  const canonicalPath = options.canonicalRecordsFile
    ? path.join(dirPath, options.canonicalRecordsFile)
    : null
  const canonicalUpdatedAt = canonicalPath ? statMtimeIso(canonicalPath) : null

  const basis = options.canonicalRecordsFile
    ? 'canonical-records'
    : sourceUpdatedAt
      ? 'local-source'
      : 'unverifiable'
  const authoritativeUpdatedAt = basis === 'canonical-records' ? canonicalUpdatedAt : sourceUpdatedAt
  const authoritativeMs = authoritativeUpdatedAt ? Date.parse(authoritativeUpdatedAt) : 0
  const requiredArtifacts = basis === 'canonical-records'
    ? ['canonical-records', 'transcript'] as const
    : basis === 'local-source'
      ? ['transcript', 'backup'] as const
      : [] as const

  const transcriptMs = transcriptUpdatedAt ? Date.parse(transcriptUpdatedAt) : 0
  const backupMs = backupUpdatedAt ? Date.parse(backupUpdatedAt) : 0
  const replicaLag = (replicaMs: number): number => {
    if (authoritativeMs <= 0) return 0
    return replicaMs > 0
      ? Math.max(0, authoritativeMs - replicaMs)
      : Math.max(0, now - authoritativeMs)
  }
  const requiredReplicaTimes = basis === 'canonical-records'
    ? [transcriptMs]
    : basis === 'local-source'
      ? [transcriptMs, backupMs]
      : []
  const hasMissingReplica = requiredReplicaTimes.some((value) => value <= 0)
  const clockSkew = authoritativeMs > now + CLOCK_SKEW_TOLERANCE_MS
  const lagMs = basis === 'unverifiable' || authoritativeMs <= 0 || clockSkew
    ? null
    : Math.max(0, ...requiredReplicaTimes.map(replicaLag))
  const stale = lagMs !== null && lagMs > thresholdMs
  const reasons: string[] = []
  if (basis === 'unverifiable') reasons.push('SOURCE_UNAVAILABLE')
  if (basis === 'canonical-records' && !canonicalUpdatedAt) reasons.push('CANONICAL_RECORDS_UNAVAILABLE')
  if (clockSkew) reasons.push('CLOCK_SKEW')
  if (stale && transcriptMs <= 0) reasons.push('TRANSCRIPT_MISSING')
  else if (stale && replicaLag(transcriptMs) > thresholdMs) reasons.push('TRANSCRIPT_STALE')
  if (basis === 'local-source') {
    if (stale && backupMs <= 0) reasons.push('BACKUP_MISSING')
    else if (stale && replicaLag(backupMs) > thresholdMs) reasons.push('BACKUP_STALE')
  }
  const status = lagMs === null
    ? 'unverifiable'
    : stale
      ? 'stale'
      : hasMissingReplica
        ? 'syncing'
        : 'fresh'
  const severity = lagMs === null
    ? 'unknown'
    : lagMs > ERROR_LAG_THRESHOLD_MS
      ? 'error'
      : stale
        ? 'warning'
        : 'ok'

  return {
    schemaVersion: 1,
    sessionId,
    basis,
    status,
    severity,
    stale,
    sourceUpdatedAt,
    canonicalUpdatedAt,
    transcriptUpdatedAt,
    backupUpdatedAt,
    requiredArtifacts,
    lagMs,
    thresholdMs,
    reasons
  }
}

export function findStaleSessions(
  sessions: ReadonlyArray<{
    sessionId: string
    dirPath: string
    sourceFilePaths: string[]
    canonicalRecordsFile?: string | null
  }>,
  thresholdMs = DEFAULT_STALE_THRESHOLD_MS
): SessionFreshness[] {
  const effectiveThresholdMs = normalizeThreshold(thresholdMs)
  return sessions
    .map((session) => computeSessionFreshness(
      session.sessionId,
      session.dirPath,
      session.sourceFilePaths,
      { canonicalRecordsFile: session.canonicalRecordsFile, thresholdMs: effectiveThresholdMs }
    ))
    .filter((freshness) => freshness.lagMs !== null && freshness.lagMs > effectiveThresholdMs)
}
