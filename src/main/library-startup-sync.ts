import { createHash } from 'node:crypto'
import {
  buildLogicalSessionIdentityFromSummary,
  logicalSessionKey
} from './library-session-identity'
import type { LibrarySyncOutcome } from './library-manager'
import type { SessionSummary } from './types'

export const LIBRARY_STARTUP_CHECKPOINT_VERSION = 1
export const LIBRARY_STARTUP_BATCH_SIZE = 32

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
}

export interface LibraryStartupDescriptor {
  key: string
  fingerprint: string
}

export interface LibraryStartupPlan {
  checkpoint: LibraryStartupCheckpoint
  descriptors: LibraryStartupDescriptor[]
  dirtyIndexes: number[]
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
  if (candidate.version !== LIBRARY_STARTUP_CHECKPOINT_VERSION ||
    typeof candidate.snapshotDigest !== 'string' ||
    !Number.isSafeInteger(candidate.schemaGeneration) ||
    !isStringArray(candidate.completedKeys) ||
    !isStringArray(candidate.dirtyKeys) ||
    !candidate.completedFingerprints || typeof candidate.completedFingerprints !== 'object' ||
    !Object.values(candidate.completedFingerprints).every((entry) => typeof entry === 'string')) {
    return null
  }
  return {
    version: LIBRARY_STARTUP_CHECKPOINT_VERSION,
    snapshotDigest: candidate.snapshotDigest,
    schemaGeneration: candidate.schemaGeneration!,
    completedKeys: [...new Set(candidate.completedKeys)].sort(),
    dirtyKeys: [...new Set(candidate.dirtyKeys)].sort(),
    completedFingerprints: { ...candidate.completedFingerprints }
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
    return {
      checkpoint: {
        ...previous,
        completedKeys: [...completed].filter((key) => descriptorByKey.has(key)).sort(),
        dirtyKeys: [...dirty].filter((key) => descriptorByKey.has(key)).sort(),
        completedFingerprints: Object.fromEntries(Object.entries(previous.completedFingerprints)
          .filter(([key]) => descriptorByKey.has(key)))
      },
      descriptors,
      dirtyIndexes: indexesForDirtyKeys(descriptors, (key) => dirty.has(key) && !completed.has(key)),
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
    completedFingerprints: cleanFingerprints
  }
  return {
    checkpoint,
    descriptors,
    dirtyIndexes: indexesForDirtyKeys(descriptors, (key) => dirtyKeySet.has(key)),
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
  for (const descriptor of descriptors) {
    if (!dirty.has(descriptor.key)) throw new Error('Library startup batch is not part of the active checkpoint')
    completed.add(descriptor.key)
    completedFingerprints[descriptor.key] = descriptor.fingerprint
  }
  return {
    ...checkpoint,
    completedKeys: [...completed].sort(),
    completedFingerprints
  }
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
  return {
    sessionId,
    code,
    disposition: 'failed',
    retryable: code === 'SESSION_CREATE_BUSY' || code === 'SESSION_SYNC_FAILED'
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
      unexpectedFailure = true
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
      } else {
        chunk = {
          total: batch.length,
          completed: 0,
          skipped: batch.map((session) => failedStartupItem(session.sessionId, error))
        }
        outcome.skipped.push(...chunk.skipped)
        failed += chunk.skipped.length
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
