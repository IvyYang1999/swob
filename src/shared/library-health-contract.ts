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
export type WriterCapabilityState = 'unproven' | 'available' | 'blocked' | 'read-only' | 'corrupt'
export type LibraryWriterBusyReason =
  | 'active-owner'
  | 'remote-owner'
  | 'unverifiable-owner'
  | 'corrupt-owner'
  | 'recovery-in-progress'
  | 'timeout'
export type LibraryWriterFailureReason = LibraryWriterBusyReason | 'identity-unavailable'
export type ActiveSourceFreshnessState = 'unproven' | 'durable' | 'stale' | 'unverifiable'
export type BackgroundBacklogState =
  | 'unobserved'
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'completed-with-errors'
export type BackgroundRecoveryState =
  | 'idle'
  | 'scheduled'
  | 'running'
  | 'waiting-provider'
  | 'attention-required'
  | 'exhausted'
export type IdentityExceptionsState =
  | 'none'
  | 'authorized-read-only'
  | 'unknown-conflicts'
  | 'evidence-mismatch'
export type UnverifiableReason =
  | 'missing-source'
  | 'icloud-placeholder'
  | 'remote-session'
  | 'corrupt-manifest'
  | 'other'

/**
 * Contract-owned legal transitions. Runtime reset is the only operation that
 * may replace a dimension with its initial value without consulting this map.
 */
export const LIBRARY_HEALTH_DIMENSION_TRANSITIONS = {
  writerCapability: {
    unproven: ['available', 'blocked', 'read-only', 'corrupt'],
    available: ['blocked', 'read-only', 'corrupt'],
    blocked: ['available', 'read-only', 'corrupt'],
    'read-only': ['available', 'blocked', 'corrupt'],
    corrupt: ['available', 'blocked', 'read-only']
  },
  activeSourceFreshness: {
    unproven: ['durable', 'stale', 'unverifiable'],
    durable: ['stale', 'unverifiable'],
    stale: ['durable', 'unverifiable'],
    unverifiable: ['durable', 'stale']
  },
  backgroundBacklog: {
    unobserved: ['idle', 'running', 'completed', 'completed-with-errors'],
    idle: ['running', 'completed'],
    running: ['paused', 'completed', 'completed-with-errors'],
    paused: ['running', 'completed', 'completed-with-errors'],
    completed: ['running'],
    'completed-with-errors': ['running']
  },
  identityExceptions: {
    none: ['authorized-read-only', 'unknown-conflicts', 'evidence-mismatch'],
    'authorized-read-only': ['none', 'unknown-conflicts', 'evidence-mismatch'],
    'unknown-conflicts': ['none', 'authorized-read-only', 'evidence-mismatch'],
    'evidence-mismatch': ['none', 'authorized-read-only', 'unknown-conflicts']
  }
} as const

export interface IdentityExceptionEvidence {
  schemaVersion: 1
  exceptionId: string
  logicalKeyHash: string
  evidenceHash: string
  physicalPackageCount: number
  access: 'read-only'
  authorizationSource: string
  authorizationDecision: string
  authorizedAt: string
}

export interface BackgroundSyncFailure {
  sessionId: string
  reasonCode: string
}

export interface LibraryHealthDimensions {
  writerCapability: {
    state: WriterCapabilityState
    stateSinceAt: string
    reasonCode: string | null
  }
  activeSourceFreshness: {
    state: ActiveSourceFreshnessState
    stateSinceAt: string
    reasonCode: string | null
    foregroundStartedAt: string
    foregroundReadyAt: string | null
    foregroundReadyLatencyMs: number | null
    foregroundReadySloMs: 60_000
    sloMet: boolean | null
  }
  backgroundBacklog: {
    state: BackgroundBacklogState
    stateSinceAt: string
    total: number
    completed: number
    failed: number
    remaining: number
    failures: readonly BackgroundSyncFailure[]
    failureCounts: Readonly<Record<string, number>>
    unverifiableBuckets: Readonly<Record<UnverifiableReason, number>>
    recovery: {
      state: BackgroundRecoveryState
      retryScheduled: number
      waitingProvider: number
      attentionRequired: number
      exhausted: number
      maxAttempts: number
      nextRetryAt: string | null
    }
  }
  identityExceptions: {
    state: IdentityExceptionsState
    stateSinceAt: string
    authorizedGroupCount: number
    authorizedPackageCount: number
    unknownGroupCount: number
    unknownPackageCount: number
    evidenceMismatchGroupCount: number
    records: readonly IdentityExceptionEvidence[]
  }
}

export interface LibraryDiagnosticEvent {
  schemaVersion: 1
  timestamp: string
  state: LibraryHealthState
  errorCode: string
  message: string
  /** Machine-readable writer failure cause; paths and owner evidence never cross this boundary. */
  reason?: LibraryWriterFailureReason
  /** Present on writer-recovery scheduler events. */
  attempt?: number
  nextRetryAt?: string | null
  lastReason?: LibraryWriterFailureReason | null
  severity: 'warning' | 'error'
}

export interface LibraryWriterRecoveryStatus {
  /** One-based attempt currently scheduled or running; zero means no recovery is pending. */
  attempt: number
  nextRetryAt: string | null
  lastReason: LibraryWriterFailureReason | null
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
  /** Additive R1-lite reason bucket; older stored DTOs may omit it. */
  unverifiableReason?: UnverifiableReason | null
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
  writerRecovery: LibraryWriterRecoveryStatus
  dimensions: LibraryHealthDimensions
}

const HEALTH_STATES = new Set<LibraryHealthState>([
  'initializing', 'ready', 'read-only', 'writer-blocked', 'identity-conflict', 'corrupt'
])
const WRITER_STATES = new Set<WriterCapabilityState>(['unproven', 'available', 'blocked', 'read-only', 'corrupt'])
const FRESHNESS_STATES = new Set<ActiveSourceFreshnessState>(['unproven', 'durable', 'stale', 'unverifiable'])
const BACKLOG_STATES = new Set<BackgroundBacklogState>([
  'unobserved', 'idle', 'running', 'paused', 'completed', 'completed-with-errors'
])
const BACKGROUND_RECOVERY_STATES = new Set<BackgroundRecoveryState>([
  'idle', 'scheduled', 'running', 'waiting-provider', 'attention-required', 'exhausted'
])
const IDENTITY_STATES = new Set<IdentityExceptionsState>([
  'none', 'authorized-read-only', 'unknown-conflicts', 'evidence-mismatch'
])
const UNVERIFIABLE_REASONS: readonly UnverifiableReason[] = [
  'missing-source', 'icloud-placeholder', 'remote-session', 'corrupt-manifest', 'other'
]
const WRITER_FAILURE_REASONS = new Set<LibraryWriterFailureReason>([
  'active-owner',
  'remote-owner',
  'unverifiable-owner',
  'corrupt-owner',
  'recovery-in-progress',
  'timeout',
  'identity-unavailable'
])

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** Runtime guard used at every untyped IPC boundary. Invalid data fails closed. */
export function isLibraryHealthSnapshot(value: unknown): value is LibraryHealthSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LibraryHealthSnapshot>
  const progress = candidate.compensation as Partial<CompensationProgress> | undefined
  const writerRecovery = candidate.writerRecovery as Partial<LibraryWriterRecoveryStatus> | undefined
  const dimensions = candidate.dimensions as Partial<LibraryHealthDimensions> | undefined
  const writer = dimensions?.writerCapability
  const freshness = dimensions?.activeSourceFreshness
  const backlog = dimensions?.backgroundBacklog
  const recovery = backlog?.recovery
  const identity = dimensions?.identityExceptions
  return candidate.schemaVersion === 1 &&
    typeof candidate.state === 'string' && HEALTH_STATES.has(candidate.state as LibraryHealthState) &&
    typeof candidate.stateSinceAt === 'string' && Number.isFinite(Date.parse(candidate.stateSinceAt)) &&
    (candidate.reasonCode === null || typeof candidate.reasonCode === 'string') &&
    (candidate.writeCapability === 'full' || candidate.writeCapability === 'partial' || candidate.writeCapability === 'none') &&
    Array.isArray(candidate.diagnostics) && candidate.diagnostics.every((event) =>
      !!event && event.schemaVersion === 1 && typeof event.timestamp === 'string' &&
      typeof event.errorCode === 'string' && typeof event.message === 'string' &&
      (event.reason === undefined || WRITER_FAILURE_REASONS.has(event.reason)) &&
      (event.attempt === undefined || isNonNegativeInteger(event.attempt)) &&
      (event.nextRetryAt === undefined || event.nextRetryAt === null || isIsoTimestamp(event.nextRetryAt)) &&
      (event.lastReason === undefined || event.lastReason === null || WRITER_FAILURE_REASONS.has(event.lastReason))) &&
    !!progress &&
    [progress.total, progress.completed, progress.failed, progress.pending]
      .every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) &&
    typeof progress.inProgress === 'boolean' && typeof progress.cancelled === 'boolean' &&
    Array.isArray(candidate.availableActions) && candidate.availableActions.every((action) =>
      action === 'retry-compensation' || action === 'cancel-compensation') &&
    !!writerRecovery && isNonNegativeInteger(writerRecovery.attempt) &&
    (writerRecovery.nextRetryAt === null || isIsoTimestamp(writerRecovery.nextRetryAt)) &&
    (writerRecovery.lastReason === null ||
      (typeof writerRecovery.lastReason === 'string' && WRITER_FAILURE_REASONS.has(writerRecovery.lastReason))) &&
    !!writer && WRITER_STATES.has(writer.state) && isIsoTimestamp(writer.stateSinceAt) &&
    (writer.reasonCode === null || typeof writer.reasonCode === 'string') &&
    !!freshness && FRESHNESS_STATES.has(freshness.state) && isIsoTimestamp(freshness.stateSinceAt) &&
    (freshness.reasonCode === null || typeof freshness.reasonCode === 'string') &&
    isIsoTimestamp(freshness.foregroundStartedAt) &&
    (freshness.foregroundReadyAt === null || isIsoTimestamp(freshness.foregroundReadyAt)) &&
    (freshness.foregroundReadyLatencyMs === null || isNonNegativeInteger(freshness.foregroundReadyLatencyMs)) &&
    freshness.foregroundReadySloMs === 60_000 &&
    (freshness.sloMet === null || typeof freshness.sloMet === 'boolean') &&
    !!backlog && BACKLOG_STATES.has(backlog.state) && isIsoTimestamp(backlog.stateSinceAt) &&
    [backlog.total, backlog.completed, backlog.failed, backlog.remaining].every(isNonNegativeInteger) &&
    Array.isArray(backlog.failures) && backlog.failures.every((failure) =>
      !!failure && typeof failure.sessionId === 'string' && typeof failure.reasonCode === 'string') &&
    !!backlog.failureCounts && Object.entries(backlog.failureCounts).every(([reason, count]) =>
      reason.length > 0 && isNonNegativeInteger(count)) &&
    !!backlog.unverifiableBuckets && UNVERIFIABLE_REASONS.every((reason) =>
      isNonNegativeInteger(backlog.unverifiableBuckets[reason])) &&
    !!recovery && BACKGROUND_RECOVERY_STATES.has(recovery.state) &&
    [recovery.retryScheduled, recovery.waitingProvider, recovery.attentionRequired,
      recovery.exhausted, recovery.maxAttempts].every(isNonNegativeInteger) &&
    (recovery.nextRetryAt === null || isIsoTimestamp(recovery.nextRetryAt)) &&
    !!identity && IDENTITY_STATES.has(identity.state) && isIsoTimestamp(identity.stateSinceAt) &&
    [identity.authorizedGroupCount, identity.authorizedPackageCount, identity.unknownGroupCount,
      identity.unknownPackageCount, identity.evidenceMismatchGroupCount].every(isNonNegativeInteger) &&
    Array.isArray(identity.records) && identity.records.every((record) =>
      !!record && record.schemaVersion === 1 && typeof record.exceptionId === 'string' &&
      typeof record.logicalKeyHash === 'string' && typeof record.evidenceHash === 'string' &&
      isNonNegativeInteger(record.physicalPackageCount) && record.access === 'read-only' &&
      typeof record.authorizationSource === 'string' && typeof record.authorizationDecision === 'string' &&
      isIsoTimestamp(record.authorizedAt))
}

function emptyUnverifiableBuckets(): Record<UnverifiableReason, number> {
  return {
    'missing-source': 0,
    'icloud-placeholder': 0,
    'remote-session': 0,
    'corrupt-manifest': 0,
    other: 0
  }
}

/** Renderer fail-closed initial value; invalid IPC must never be normalized to ready. */
export function createInitializingLibraryHealthSnapshot(): LibraryHealthSnapshot {
  const epoch = new Date(0).toISOString()
  return {
    schemaVersion: 1,
    state: 'initializing',
    stateSinceAt: epoch,
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
    availableActions: [],
    writerRecovery: {
      attempt: 0,
      nextRetryAt: null,
      lastReason: null
    },
    dimensions: {
      writerCapability: {
        state: 'unproven',
        stateSinceAt: epoch,
        reasonCode: 'HEALTH_UNAVAILABLE'
      },
      activeSourceFreshness: {
        state: 'unproven',
        stateSinceAt: epoch,
        reasonCode: 'HEALTH_UNAVAILABLE',
        foregroundStartedAt: epoch,
        foregroundReadyAt: null,
        foregroundReadyLatencyMs: null,
        foregroundReadySloMs: 60_000,
        sloMet: null
      },
      backgroundBacklog: {
        state: 'unobserved',
        stateSinceAt: epoch,
        total: 0,
        completed: 0,
        failed: 0,
        remaining: 0,
        failures: [],
        failureCounts: {},
        unverifiableBuckets: emptyUnverifiableBuckets(),
        recovery: {
          state: 'idle',
          retryScheduled: 0,
          waitingProvider: 0,
          attentionRequired: 0,
          exhausted: 0,
          maxAttempts: 5,
          nextRetryAt: null
        }
      },
      identityExceptions: {
        state: 'none',
        stateSinceAt: epoch,
        authorizedGroupCount: 0,
        authorizedPackageCount: 0,
        unknownGroupCount: 0,
        unknownPackageCount: 0,
        evidenceMismatchGroupCount: 0,
        records: []
      }
    }
  }
}
