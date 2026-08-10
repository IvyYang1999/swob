import { createHash } from 'node:crypto'
import {
  buildLogicalSessionIdentityFromSummary,
  logicalSessionKey
} from './library-session-identity'
import type { LibrarySyncOutcome } from './library-manager'
import type { SessionSummary } from './types'

export const LIBRARY_STARTUP_CHECKPOINT_VERSION = 2
export const LIBRARY_STARTUP_BATCH_SIZE = 32
export const LIBRARY_STARTUP_RECOVERY_MAX_ATTEMPTS = 5

const LIBRARY_STARTUP_RECOVERY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const

export type LibraryStartupRecoveryState =
  | 'retry-scheduled'
  | 'waiting-provider'
  | 'attention-required'
  | 'exhausted'

export interface LibraryStartupRecoveryEntry {
  fingerprint: string
  state: LibraryStartupRecoveryState
  reasonCode: string
  attempt: number
  firstFailedAt: string
  lastAttemptAt: string
  nextAttemptAt: string | null
}

export interface LibraryStartupRecoverySummary {
  retryScheduled: number
  waitingProvider: number
  attentionRequired: number
  exhausted: number
  maxAttempts: typeof LIBRARY_STARTUP_RECOVERY_MAX_ATTEMPTS
  nextRetryAt: string | null
}

export interface LibraryStartupProgress {
  current: number
  total: number
  completed: number
  failed: number
  remaining: number
  sessionId: string
  failureReason?: string
}

export interface LibraryStartupCheckpoint {
  version: typeof LIBRARY_STARTUP_CHECKPOINT_VERSION
  snapshotDigest: string
  schemaGeneration: number
  completedKeys: string[]
  dirtyKeys: string[]
  completedFingerprints: Record<string, string>
  recovery: Record<string, LibraryStartupRecoveryEntry>
}

export interface LibraryStartupDescriptor {
  key: string
  fingerprint: string
}

export interface LibraryStartupPlan {
  checkpoint: LibraryStartupCheckpoint
  descriptors: LibraryStartupDescriptor[]
  dirtyIndexes: number[]
  recoveryItems: Array<{ index: number; entry: LibraryStartupRecoveryEntry }>
  invalidation: 'cold' | 'none' | 'snapshot-changed' | 'schema-changed' | 'projection-changed'
}

export class LibraryStartupSyncInterruptedError extends Error {
  constructor() {
    super('Library background synchronization interrupted')
    this.name = 'LibraryStartupSyncInterruptedError'
  }
}

export interface IncrementalLibraryStartupOptions {
  sessions: readonly SessionSummary[]
  probeWriter: () => Promise<void>
  /** Production planning already proves the writer while taking the one authoritative registry scan. */
  writerAlreadyProven?: boolean
  /** Bounded production path. One callback invocation owns one writer transaction. */
  syncBatch?: (sessions: readonly SessionSummary[]) => Promise<LibrarySyncOutcome>
  /** Compatibility/test adapter. Production startup must use syncBatch. */
  syncChunk?: (session: SessionSummary) => Promise<LibrarySyncOutcome>
  resolveLatest: (initial: SessionSummary) => SessionSummary
  /** True only when this drain completed at least one durable live commit. */
  drainLive: () => Promise<boolean | void>
  onWriterProven: () => void
  onFirstDurableBoundary?: (kind: 'durable' | 'empty' | 'read-only-only' | 'failed') => void
  onProgress?: (progress: LibraryStartupProgress) => void
  shouldInterrupt?: () => boolean
  yieldToEventLoop?: () => Promise<void>
  batchSize?: number
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringifyRecord(record: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))))
}

/**
 * The descriptor uses loader-produced source facts and semantic identity only.
 * It deliberately does not stat source files: discovery already paid that cost,
 * and repeating it here recreates the startup lstat hot path this planner removes.
 */
export function describeLibraryStartupSession(
  session: SessionSummary,
  schemaGeneration: number,
  customTitle?: string
): LibraryStartupDescriptor {
  const identityKey = logicalSessionKey(buildLogicalSessionIdentityFromSummary(session))
  const sourcePaths = [...new Set(session.allFilePaths || [session.filePath])].sort()
  const key = sha256(stableStringifyRecord({
    identityKey,
    projectionId: session.id,
    sourcePaths
  }))
  const fingerprint = sha256(stableStringifyRecord({
    schemaGeneration,
    identityKey,
    projectionId: session.id,
    source: session.source || null,
    sourcePaths,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    fileSizeBytes: session.fileSizeBytes,
    messageCount: session.messageCount,
    turnCount: session.turnCount,
    lifecycleState: session.lifecycleState || null,
    branchParentId: session.branchParentId || null,
    branchChildIds: [...(session.branchChildIds || [])].sort(),
    customTitle: customTitle || null
  }))
  return { key, fingerprint }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

export function parseLibraryStartupCheckpoint(value: unknown): LibraryStartupCheckpoint | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<LibraryStartupCheckpoint>
  const version = (candidate as { version?: unknown }).version
  if ((version !== 1 && version !== LIBRARY_STARTUP_CHECKPOINT_VERSION) ||
    typeof candidate.snapshotDigest !== 'string' ||
    !Number.isSafeInteger(candidate.schemaGeneration) ||
    !isStringArray(candidate.completedKeys) ||
    !isStringArray(candidate.dirtyKeys) ||
    !candidate.completedFingerprints || typeof candidate.completedFingerprints !== 'object' ||
    !Object.values(candidate.completedFingerprints).every((entry) => typeof entry === 'string')) {
    return null
  }
  const rawRecovery = version === LIBRARY_STARTUP_CHECKPOINT_VERSION
    ? (candidate as Partial<LibraryStartupCheckpoint>).recovery
    : {}
  if (!rawRecovery || typeof rawRecovery !== 'object') return null
  const recovery: Record<string, LibraryStartupRecoveryEntry> = {}
  for (const [key, raw] of Object.entries(rawRecovery)) {
    if (!raw || typeof raw !== 'object') return null
    const entry = raw as Partial<LibraryStartupRecoveryEntry>
    if (typeof entry.fingerprint !== 'string' ||
      !['retry-scheduled', 'waiting-provider', 'attention-required', 'exhausted'].includes(String(entry.state)) ||
      typeof entry.reasonCode !== 'string' || !Number.isSafeInteger(entry.attempt) || entry.attempt! < 0 ||
      typeof entry.firstFailedAt !== 'string' || !Number.isFinite(Date.parse(entry.firstFailedAt)) ||
      typeof entry.lastAttemptAt !== 'string' || !Number.isFinite(Date.parse(entry.lastAttemptAt)) ||
      (entry.nextAttemptAt !== null &&
        (typeof entry.nextAttemptAt !== 'string' || !Number.isFinite(Date.parse(entry.nextAttemptAt))))) return null
    recovery[key] = entry as LibraryStartupRecoveryEntry
  }
  return {
    version: LIBRARY_STARTUP_CHECKPOINT_VERSION,
    snapshotDigest: candidate.snapshotDigest,
    schemaGeneration: candidate.schemaGeneration!,
    completedKeys: [...new Set(candidate.completedKeys)].sort(),
    dirtyKeys: [...new Set(candidate.dirtyKeys)].sort(),
    completedFingerprints: { ...candidate.completedFingerprints },
    recovery
  }
}

function indexesForDirtyKeys(
  descriptors: readonly LibraryStartupDescriptor[],
  isDirty: (key: string) => boolean
): number[] {
  const seen = new Set<string>()
  return descriptors.flatMap((descriptor, index) => {
    if (seen.has(descriptor.key) || !isDirty(descriptor.key)) return []
    seen.add(descriptor.key)
    return [index]
  })
}

export function buildLibraryStartupPlan(
  sessions: readonly SessionSummary[],
  schemaGeneration: number,
  previous: LibraryStartupCheckpoint | null,
  sessionMeta: Record<string, { customTitle?: string }> = {}
): LibraryStartupPlan {
  if (!Number.isSafeInteger(schemaGeneration) || schemaGeneration < 1) {
    throw new Error('Library startup schema generation must be a positive integer')
  }
  const descriptors = sessions.map((session) => describeLibraryStartupSession(
    session,
    schemaGeneration,
    sessionMeta[session.sessionId]?.customTitle
  ))
  const snapshotDigest = sha256(descriptors
    .map((descriptor) => `${descriptor.key}:${descriptor.fingerprint}`)
    .sort()
    .join('\n'))
  const descriptorByKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]))
  const previousCompleted = previous?.schemaGeneration === schemaGeneration
    ? previous.completedFingerprints
    : {}

  if (previous?.schemaGeneration === schemaGeneration && previous.snapshotDigest === snapshotDigest) {
    const completed = new Set(previous.completedKeys)
    const dirty = new Set(previous.dirtyKeys)
    const recovery = Object.fromEntries(Object.entries(previous.recovery)
      .filter(([key, entry]) => descriptorByKey.get(key)?.fingerprint === entry.fingerprint))
    return {
      checkpoint: {
        ...previous,
        completedKeys: [...completed].filter((key) => descriptorByKey.has(key)).sort(),
        dirtyKeys: [...dirty].filter((key) => descriptorByKey.has(key)).sort(),
        completedFingerprints: Object.fromEntries(Object.entries(previous.completedFingerprints)
          .filter(([key]) => descriptorByKey.has(key))),
        recovery
      },
      descriptors,
      dirtyIndexes: indexesForDirtyKeys(descriptors, (key) => dirty.has(key) && !completed.has(key)),
      recoveryItems: descriptors.flatMap((descriptor, index) => recovery[descriptor.key]
        ? [{ index, entry: recovery[descriptor.key] }]
        : []),
      invalidation: 'none'
    }
  }

  const dirtyKeys = [...new Set(descriptors
    .filter((descriptor) => previousCompleted[descriptor.key] !== descriptor.fingerprint)
    .map((descriptor) => descriptor.key))].sort()
  const dirtyKeySet = new Set(dirtyKeys)
  const cleanFingerprints = Object.fromEntries(descriptors
    .filter((descriptor) => !dirtyKeySet.has(descriptor.key))
    .map((descriptor) => [descriptor.key, descriptor.fingerprint]))
  const checkpoint: LibraryStartupCheckpoint = {
    version: LIBRARY_STARTUP_CHECKPOINT_VERSION,
    snapshotDigest,
    schemaGeneration,
    completedKeys: [],
    dirtyKeys,
    completedFingerprints: cleanFingerprints,
    recovery: Object.fromEntries(Object.entries(previous?.recovery || {})
      .filter(([key, entry]) => descriptorByKey.get(key)?.fingerprint === entry.fingerprint && dirtyKeySet.has(key)))
  }
  return {
    checkpoint,
    descriptors,
    dirtyIndexes: indexesForDirtyKeys(descriptors, (key) => dirtyKeySet.has(key)),
    recoveryItems: descriptors.flatMap((descriptor, index) => checkpoint.recovery[descriptor.key]
      ? [{ index, entry: checkpoint.recovery[descriptor.key] }]
      : []),
    invalidation: !previous
      ? 'cold'
      : previous.schemaGeneration !== schemaGeneration
        ? 'schema-changed'
        : 'snapshot-changed'
  }
}

export function completeLibraryStartupCheckpoint(
  checkpoint: LibraryStartupCheckpoint,
  sessions: readonly SessionSummary[],
  sessionMeta: Record<string, { customTitle?: string }> = {}
): LibraryStartupCheckpoint {
  const descriptors = sessions.map((session) => describeLibraryStartupSession(
    session,
    checkpoint.schemaGeneration,
    sessionMeta[session.sessionId]?.customTitle
  ))
  const dirty = new Set(checkpoint.dirtyKeys)
  const completed = new Set(checkpoint.completedKeys)
  const completedFingerprints = { ...checkpoint.completedFingerprints }
  const recovery = { ...checkpoint.recovery }
  for (const descriptor of descriptors) {
    if (!dirty.has(descriptor.key)) throw new Error('Library startup batch is not part of the active checkpoint')
    completed.add(descriptor.key)
    completedFingerprints[descriptor.key] = descriptor.fingerprint
    delete recovery[descriptor.key]
  }
  return {
    ...checkpoint,
    completedKeys: [...completed].sort(),
    completedFingerprints,
    recovery
  }
}

function stableRecoveryDelayMs(key: string, attempt: number): number {
  const base = LIBRARY_STARTUP_RECOVERY_DELAYS_MS[Math.min(
    Math.max(0, attempt - 1),
    LIBRARY_STARTUP_RECOVERY_DELAYS_MS.length - 1
  )]
  const bucket = Number.parseInt(sha256(key).slice(0, 4), 16) % 21
  return Math.max(250, Math.round(base * (0.9 + bucket / 100)))
}

function recoveryStateForCode(code: string): 'transient' | 'provider' | 'attention' {
  if (code === 'PROVIDER_SESSION_PENDING') return 'provider'
  if (code === 'SESSION_CREATE_BUSY' || code === 'SESSION_SYNC_FAILED' ||
    code === 'PROVIDER_SESSION_DEGRADED' || code === 'EAGAIN' || code === 'EBUSY') return 'transient'
  return 'attention'
}

export function updateLibraryStartupCheckpointAfterBatch(
  checkpoint: LibraryStartupCheckpoint,
  sessions: readonly SessionSummary[],
  outcome: LibrarySyncOutcome,
  sessionMeta: Record<string, { customTitle?: string }> = {},
  nowMs = Date.now()
): { checkpoint: LibraryStartupCheckpoint; recoveryByWorkKey: Record<string, LibraryStartupRecoveryEntry> } {
  const descriptors = sessions.map((session) => describeLibraryStartupSession(
    session,
    checkpoint.schemaGeneration,
    sessionMeta[session.sessionId]?.customTitle
  ))
  const sessionIdCounts = new Map<string, number>()
  const descriptorIndexByKey = new Map<string, number>()
  for (let index = 0; index < descriptors.length; index++) {
    if (descriptorIndexByKey.has(descriptors[index].key)) {
      throw new Error('Library startup batch contains a duplicate workKey')
    }
    descriptorIndexByKey.set(descriptors[index].key, index)
  }
  for (const session of sessions) {
    sessionIdCounts.set(session.sessionId, (sessionIdCounts.get(session.sessionId) || 0) + 1)
  }
  const failedCount = outcome.skipped.filter((entry) => entry.disposition === 'failed').length
  if (outcome.total !== sessions.length || outcome.completed + failedCount !== sessions.length) {
    throw new Error('Library startup outcome does not account for the complete batch')
  }
  const resolvedSkippedWorkKeys = new Map<LibrarySyncOutcome['skipped'][number], string>()
  const seenSkippedWorkKeys = new Set<string>()
  for (const skipped of outcome.skipped) {
    let workKey = skipped.workKey
    if (workKey) {
      const descriptorIndex = descriptorIndexByKey.get(workKey)
      if (descriptorIndex === undefined || sessions[descriptorIndex].sessionId !== skipped.sessionId) {
        throw new Error('Library startup outcome workKey does not match its session')
      }
    } else {
      if (sessionIdCounts.get(skipped.sessionId) !== 1) {
        throw new Error('Library startup outcome omitted workKey for an ambiguous sessionId')
      }
      const index = sessions.findIndex((session) => session.sessionId === skipped.sessionId)
      if (index < 0) throw new Error('Library startup outcome references an unknown session')
      workKey = descriptors[index].key
    }
    if (seenSkippedWorkKeys.has(workKey)) {
      throw new Error('Library startup outcome repeats a workKey')
    }
    seenSkippedWorkKeys.add(workKey)
    resolvedSkippedWorkKeys.set(skipped, workKey)
  }
  const failedByWorkKey = new Map<string, string>()
  for (const skipped of outcome.skipped.filter((entry) => entry.disposition === 'failed')) {
    const workKey = resolvedSkippedWorkKeys.get(skipped)
    if (!workKey) throw new Error('Library startup outcome could not resolve a failed workKey')
    failedByWorkKey.set(workKey, skipped.code)
  }
  const terminalSessions = sessions.filter((_session, index) => !failedByWorkKey.has(descriptors[index].key))
  let next = completeLibraryStartupCheckpoint(checkpoint, terminalSessions, sessionMeta)
  const completed = new Set(next.completedKeys)
  const completedFingerprints = { ...next.completedFingerprints }
  const recovery = { ...next.recovery }
  const recoveryByWorkKey: Record<string, LibraryStartupRecoveryEntry> = {}
  const now = new Date(nowMs).toISOString()
  for (let index = 0; index < sessions.length; index++) {
    const session = sessions[index]
    const descriptor = descriptors[index]
    const code = failedByWorkKey.get(descriptor.key)
    if (!code) continue
    const previous = recovery[descriptor.key]?.fingerprint === descriptor.fingerprint
      ? recovery[descriptor.key]
      : null
    const failureClass = recoveryStateForCode(code)
    const attempt = failureClass === 'transient' ? (previous?.attempt || 0) + 1 : (previous?.attempt || 0)
    const state: LibraryStartupRecoveryState = failureClass === 'provider'
      ? 'waiting-provider'
      : failureClass === 'attention'
        ? 'attention-required'
        : attempt >= LIBRARY_STARTUP_RECOVERY_MAX_ATTEMPTS
          ? 'exhausted'
          : 'retry-scheduled'
    const entry: LibraryStartupRecoveryEntry = {
      fingerprint: descriptor.fingerprint,
      state,
      reasonCode: code,
      attempt,
      firstFailedAt: previous?.firstFailedAt || now,
      lastAttemptAt: now,
      nextAttemptAt: state === 'retry-scheduled'
        ? new Date(nowMs + stableRecoveryDelayMs(descriptor.key, attempt)).toISOString()
        : null
    }
    recovery[descriptor.key] = entry
    recoveryByWorkKey[descriptor.key] = entry
    completed.delete(descriptor.key)
    delete completedFingerprints[descriptor.key]
  }
  next = {
    ...next,
    completedKeys: [...completed].sort(),
    completedFingerprints,
    recovery
  }
  return { checkpoint: next, recoveryByWorkKey }
}

export function summarizeLibraryStartupRecovery(
  recovery: Readonly<Record<string, LibraryStartupRecoveryEntry>>
): LibraryStartupRecoverySummary {
  const summary: LibraryStartupRecoverySummary = {
    retryScheduled: 0,
    waitingProvider: 0,
    attentionRequired: 0,
    exhausted: 0,
    maxAttempts: LIBRARY_STARTUP_RECOVERY_MAX_ATTEMPTS,
    nextRetryAt: null
  }
  for (const entry of Object.values(recovery)) {
    if (entry.state === 'retry-scheduled') {
      summary.retryScheduled++
      if (entry.nextAttemptAt && (!summary.nextRetryAt || entry.nextAttemptAt < summary.nextRetryAt)) {
        summary.nextRetryAt = entry.nextAttemptAt
      }
    } else if (entry.state === 'waiting-provider') summary.waitingProvider++
    else if (entry.state === 'attention-required') summary.attentionRequired++
    else summary.exhausted++
  }
  return summary
}

function failureReason(error: unknown): string {
  if (!error || typeof error !== 'object') return 'SESSION_SYNC_FAILED'
  const typed = error as { code?: unknown; name?: unknown }
  if (typeof typed.code === 'string' && /^[A-Z0-9_:-]+$/.test(typed.code)) return typed.code
  if (typed.name !== 'Error' && typeof typed.name === 'string' && /^[A-Za-z0-9_-]+$/.test(typed.name)) {
    return typed.name
  }
  return 'SESSION_SYNC_FAILED'
}

function failedStartupItem(sessionId: string, error: unknown): LibrarySyncOutcome['skipped'][number] {
  const code = failureReason(error)
  const handled = code === 'SESSION_SOURCE_MISSING' || code === 'SESSION_IDENTITY_CONFLICT'
  return {
    sessionId,
    code,
    disposition: handled ? 'handled' : 'failed',
    retryable: code === 'SESSION_CREATE_BUSY' || code === 'SESSION_SYNC_FAILED' ||
      code === 'EAGAIN' || code === 'EBUSY'
  }
}

function mustAbortStartup(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const typed = error as { code?: unknown; name?: unknown }
  return typed.name === 'AbortError' || typed.name === 'LibraryWriterBusyError' ||
    typed.name === 'LibraryPathUnsafeError' || typed.name === 'SessionCreateIdentityUnavailableError' ||
    ['LIBRARY_WRITER_BUSY', 'WRITER_IDENTITY_UNAVAILABLE', 'EACCES', 'EPERM', 'ENOSPC', 'EIO']
      .includes(String(typed.code || ''))
}

/**
 * Gives live source work priority at every bounded startup transaction boundary.
 * Production supplies syncBatch; syncChunk remains solely for focused adapters.
 */
export async function syncLibraryStartupIncrementally(
  options: IncrementalLibraryStartupOptions
): Promise<LibrarySyncOutcome> {
  const outcome: LibrarySyncOutcome = {
    total: options.sessions.length,
    completed: 0,
    skipped: []
  }

  if (!options.writerAlreadyProven) await options.probeWriter()
  options.onWriterProven()
  let boundaryReported = false
  let failed = 0
  let unexpectedFailure = false
  const reportBoundary = (kind: 'durable' | 'empty' | 'read-only-only' | 'failed'): void => {
    if (boundaryReported) return
    boundaryReported = true
    options.onFirstDurableBoundary?.(kind)
  }
  if (await options.drainLive()) reportBoundary('durable')
  if (options.sessions.length === 0) reportBoundary('empty')

  const requestedBatchSize = options.syncBatch
    ? options.batchSize || LIBRARY_STARTUP_BATCH_SIZE
    : 1
  const batchSize = Math.max(1, Math.trunc(requestedBatchSize))
  for (let offset = 0; offset < options.sessions.length; offset += batchSize) {
    if (options.shouldInterrupt?.()) throw new LibraryStartupSyncInterruptedError()
    if (offset > 0 && await options.drainLive()) reportBoundary('durable')
    const batch = options.sessions.slice(offset, offset + batchSize).map(options.resolveLatest)
    let chunk: LibrarySyncOutcome | null = null
    const failureBySessionId = new Map<string, string>()
    try {
      if (options.syncBatch) {
        chunk = await options.syncBatch(batch)
      } else if (options.syncChunk) {
        chunk = await options.syncChunk(batch[0])
      } else {
        throw new Error('Library startup synchronization requires syncBatch or syncChunk')
      }
      const handled = chunk.skipped.filter((entry) => entry.disposition === 'handled').length
      const chunkFailures = chunk.skipped.filter((entry) => entry.disposition === 'failed').length
      if (chunk.completed > handled) reportBoundary('durable')
      outcome.completed += chunk.completed
      outcome.skipped.push(...chunk.skipped)
      failed += chunkFailures
      if (chunkFailures > 0) unexpectedFailure = true
    } catch (error) {
      if (mustAbortStartup(error)) throw error
      if (options.syncBatch && batch.length > 1) {
        // A content-specific failure must not strand the rest of a bounded
        // batch. Retry one-by-one only on this exceptional path; successful
        // items advance their own checkpoint while the bad key remains dirty.
        chunk = { total: batch.length, completed: 0, skipped: [] }
        for (const session of batch) {
          try {
            const retried = await options.syncBatch([session])
            chunk.completed += retried.completed
            chunk.skipped.push(...retried.skipped)
          } catch (retryError) {
            if (mustAbortStartup(retryError)) throw retryError
            const skipped = failedStartupItem(session.sessionId, retryError)
            chunk.skipped.push(skipped)
            failureBySessionId.set(session.sessionId, skipped.code)
          }
        }
        const handled = chunk.skipped.filter((entry) => entry.disposition === 'handled').length
        const chunkFailures = chunk.skipped.filter((entry) => entry.disposition === 'failed').length
        if (chunk.completed > handled) reportBoundary('durable')
        outcome.completed += chunk.completed
        outcome.skipped.push(...chunk.skipped)
        failed += chunkFailures
        if (chunkFailures > 0) unexpectedFailure = true
      } else {
        const skipped = batch.map((session) => failedStartupItem(session.sessionId, error))
        const handled = skipped.filter((entry) => entry.disposition === 'handled').length
        const chunkFailures = skipped.length - handled
        chunk = {
          total: batch.length,
          completed: handled,
          skipped
        }
        outcome.completed += handled
        outcome.skipped.push(...chunk.skipped)
        failed += chunkFailures
        if (chunkFailures > 0) unexpectedFailure = true
        for (const skipped of chunk.skipped) failureBySessionId.set(skipped.sessionId, skipped.code)
      }
    }

    const skippedBySessionId = new Map((chunk?.skipped || [])
      .filter((entry) => entry.disposition === 'failed')
      .map((entry) => [entry.sessionId, entry.code]))
    for (let batchIndex = 0; batchIndex < batch.length; batchIndex++) {
      const current = offset + batchIndex + 1
      const session = batch[batchIndex]
      const itemFailure = failureBySessionId.get(session.sessionId) || skippedBySessionId.get(session.sessionId)
      options.onProgress?.({
        current,
        total: options.sessions.length,
        completed: outcome.completed,
        failed,
        remaining: Math.max(0, options.sessions.length - outcome.completed - failed),
        sessionId: session.sessionId,
        ...(itemFailure ? { failureReason: itemFailure } : {})
      })
    }
    if (await options.drainLive()) reportBoundary('durable')
    if (offset + batch.length < options.sessions.length) await options.yieldToEventLoop?.()
  }

  reportBoundary(unexpectedFailure ? 'failed' : 'read-only-only')
  return outcome
}
