/**
 * Canonical Library health contract shared by main, preload, renderer and CLI.
 *
 * Time deltas are always milliseconds. Consumers may format them for display,
 * but must not introduce a second freshness calculation.
 */
export type LibraryHealthState =
  | 'initializing'
  | 'ready'
  | 'read-only'
  | 'writer-blocked'
  | 'identity-conflict'
  | 'corrupt'

export type LibraryWriteCapability = 'full' | 'partial' | 'none'
export type LibraryHealthAction = 'retry-compensation' | 'cancel-compensation'
export type FreshnessBasis = 'local-source' | 'canonical-records' | 'unverifiable'
export type FreshnessStatus = 'fresh' | 'syncing' | 'stale' | 'unverifiable'
export type FreshnessSeverity = 'ok' | 'warning' | 'error' | 'unknown'
export type FreshnessArtifact = 'transcript' | 'backup' | 'canonical-records'

export interface LibraryDiagnosticEvent {
  schemaVersion: 1
  timestamp: string
  state: LibraryHealthState
  errorCode: string
  message: string
  severity: 'warning' | 'error'
}

export interface SessionFreshness {
  schemaVersion: 1
  sessionId: string
  basis: FreshnessBasis
  status: FreshnessStatus
  severity: FreshnessSeverity
  stale: boolean
  sourceUpdatedAt: string | null
  canonicalUpdatedAt: string | null
  transcriptUpdatedAt: string | null
  backupUpdatedAt: string | null
  requiredArtifacts: readonly FreshnessArtifact[]
  lagMs: number | null
  thresholdMs: number
  reasons: readonly string[]
}

export interface CompensationProgress {
  total: number
  completed: number
  failed: number
  pending: number
  inProgress: boolean
  cancelled: boolean
}

export interface LibraryHealthSnapshot {
  schemaVersion: 1
  state: LibraryHealthState
  stateSinceAt: string
  reasonCode: string | null
  writeCapability: LibraryWriteCapability
  diagnostics: readonly LibraryDiagnosticEvent[]
  compensation: CompensationProgress
  availableActions: readonly LibraryHealthAction[]
}

const HEALTH_STATES = new Set<LibraryHealthState>([
  'initializing', 'ready', 'read-only', 'writer-blocked', 'identity-conflict', 'corrupt'
])

/** Runtime guard used at every untyped IPC boundary. Invalid data fails closed. */
export function isLibraryHealthSnapshot(value: unknown): value is LibraryHealthSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LibraryHealthSnapshot>
  const progress = candidate.compensation as Partial<CompensationProgress> | undefined
  return candidate.schemaVersion === 1 &&
    typeof candidate.state === 'string' && HEALTH_STATES.has(candidate.state as LibraryHealthState) &&
    typeof candidate.stateSinceAt === 'string' && Number.isFinite(Date.parse(candidate.stateSinceAt)) &&
    (candidate.reasonCode === null || typeof candidate.reasonCode === 'string') &&
    (candidate.writeCapability === 'full' || candidate.writeCapability === 'partial' || candidate.writeCapability === 'none') &&
    Array.isArray(candidate.diagnostics) && candidate.diagnostics.every((event) =>
      !!event && event.schemaVersion === 1 && typeof event.timestamp === 'string' &&
      typeof event.errorCode === 'string' && typeof event.message === 'string') &&
    !!progress &&
    [progress.total, progress.completed, progress.failed, progress.pending]
      .every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) &&
    typeof progress.inProgress === 'boolean' && typeof progress.cancelled === 'boolean' &&
    Array.isArray(candidate.availableActions) && candidate.availableActions.every((action) =>
      action === 'retry-compensation' || action === 'cancel-compensation')
}

/** Renderer fail-closed initial value; invalid IPC must never be normalized to ready. */
export function createInitializingLibraryHealthSnapshot(): LibraryHealthSnapshot {
  return {
    schemaVersion: 1,
    state: 'initializing',
    stateSinceAt: new Date(0).toISOString(),
    reasonCode: 'HEALTH_UNAVAILABLE',
    writeCapability: 'none',
    diagnostics: [],
    compensation: {
      total: 0,
      completed: 0,
      failed: 0,
      pending: 0,
      inProgress: false,
      cancelled: false
    },
    availableActions: []
  }
}
