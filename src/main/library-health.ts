/**
 * Library Health State Machine, Freshness Data, and Compensation Queue.
 *
 * Provides a five-state health model for the Library subsystem:
 *   initializing → ready | read-only | writer-blocked | identity-conflict | corrupt
 *
 * Freshness queries are lightweight (stat/manifest only, never parse transcripts).
 * Diagnostic events are append-only and never contain PII (no full paths, no content).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { computeSessionFreshness, findStaleSessions } from './library-freshness'

export {
  classifyUnverifiableReason,
  computeSessionFreshness,
  findStaleSessions,
  freshnessDiagnosticFingerprint
} from './library-freshness'
import {
  LIBRARY_HEALTH_DIMENSION_TRANSITIONS,
  type ActiveSourceFreshnessState,
  type BackgroundBacklogState,
  type BackgroundSyncFailure,
  type CompensationProgress,
  type IdentityExceptionsState,
  type LibraryDiagnosticEvent,
  type LibraryHealthDimensions,
  type LibraryHealthSnapshot,
  type LibraryHealthState,
  type LibraryWriterBusyReason,
  type LibraryWriterFailureReason,
  type LibraryWriterRecoveryStatus,
  type SessionFreshness,
  type UnverifiableReason,
  type WriterCapabilityState
} from '../shared/library-health-contract'

export type {
  CompensationProgress,
  LibraryDiagnosticEvent,
  LibraryHealthSnapshot,
  LibraryHealthState,
  SessionFreshness
} from '../shared/library-health-contract'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DIAGNOSTIC_EVENTS = 50
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 320
const MAX_DIAGNOSTIC_READ_BYTES = 256 * 1024
const MAX_BACKGROUND_FAILURE_SAMPLES = 20

let diagnosticFilePath: string | null = null

function isLibraryWriterFailureReason(value: unknown): value is LibraryWriterFailureReason {
  return value === 'active-owner' || value === 'remote-owner' ||
    value === 'unverifiable-owner' || value === 'corrupt-owner' ||
    value === 'recovery-in-progress' || value === 'timeout' || value === 'identity-unavailable'
}

function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '[id]')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'`]+/g, '[path]')
    .slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH)
}

function appendDiagnostic(event: LibraryDiagnosticEvent): void {
  if (!diagnosticFilePath) return
  let descriptor: number | null = null
  try {
    const diagnosticDirectory = path.dirname(diagnosticFilePath)
    if (!fs.existsSync(diagnosticDirectory)) fs.mkdirSync(diagnosticDirectory, { recursive: true, mode: 0o700 })
    const directoryStat = fs.lstatSync(diagnosticDirectory)
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) return
    if (fs.existsSync(diagnosticFilePath) && fs.lstatSync(diagnosticFilePath).isSymbolicLink()) return
    const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
    descriptor = fs.openSync(
      diagnosticFilePath,
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_RDWR | noFollow,
      0o600
    )
    const fileStat = fs.fstatSync(descriptor)
    if (!fileStat.isFile()) return
    let prefix = ''
    if (fileStat.size > 0) {
      const lastByte = Buffer.alloc(1)
      fs.readSync(descriptor, lastByte, 0, 1, fileStat.size - 1)
      if (lastByte[0] !== 0x0a) prefix = '\n'
    }
    fs.writeSync(descriptor, `${prefix}${JSON.stringify(event)}\n`, undefined, 'utf8')
    fs.fsyncSync(descriptor)
  } catch {
    // Diagnostics must never turn a Library failure into an application crash.
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* already closed/unavailable */ }
    }
  }
}

function readPersistedDiagnostics(filePath: string): LibraryDiagnosticEvent[] {
  let descriptor: number | null = null
  try {
    if (!fs.existsSync(filePath) || fs.lstatSync(filePath).isSymbolicLink()) return []
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY)
    const size = fs.fstatSync(descriptor).size
    const readSize = Math.min(size, MAX_DIAGNOSTIC_READ_BYTES)
    const buffer = Buffer.alloc(readSize)
    fs.readSync(descriptor, buffer, 0, readSize, size - readSize)
    let lines = buffer.toString('utf8').split('\n')
    if (size > readSize) lines = lines.slice(1)
    const events: LibraryDiagnosticEvent[] = []
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as Partial<LibraryDiagnosticEvent>
        if (value.schemaVersion === 1 && typeof value.timestamp === 'string' &&
          typeof value.state === 'string' && typeof value.errorCode === 'string' &&
          typeof value.message === 'string' &&
          (value.reason === undefined || isLibraryWriterFailureReason(value.reason)) &&
          (value.attempt === undefined || (Number.isSafeInteger(value.attempt) && value.attempt! >= 0)) &&
          (value.nextRetryAt === undefined || value.nextRetryAt === null ||
            (typeof value.nextRetryAt === 'string' && Number.isFinite(Date.parse(value.nextRetryAt)))) &&
          (value.lastReason === undefined || value.lastReason === null ||
            isLibraryWriterFailureReason(value.lastReason)) &&
          (value.severity === 'warning' || value.severity === 'error')) {
          events.push(value as LibraryDiagnosticEvent)
        }
      } catch { /* tolerate a torn tail and retain earlier valid events */ }
    }
    return events.slice(-MAX_DIAGNOSTIC_EVENTS)
  } catch {
    return []
  } finally {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor) } catch { /* already closed/unavailable */ }
    }
  }
}

/** Configure append-only, redacted diagnostics outside the Library write boundary. */
export function configureLibraryHealthPersistence(libraryRoot: string, diagnosticsRoot: string): void {
  const resolvedDiagnosticsRoot = path.resolve(diagnosticsRoot)
  const libraryHash = createHash('sha256').update(path.resolve(libraryRoot)).digest('hex').slice(0, 24)
  const candidate = path.join(resolvedDiagnosticsRoot, `library-health.${libraryHash}.v1.jsonl`)
  if (diagnosticFilePath === candidate) return
  diagnosticFilePath = candidate
  healthMachine.replaceDiagnostics(readPersistedDiagnostics(candidate))
}

/** Test/root-switch boundary: stop persisting to the previous Library. */
export function clearLibraryHealthPersistence(): void {
  diagnosticFilePath = null
}

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

export function createEmptyUnverifiableBuckets(): Record<UnverifiableReason, number> {
  return {
    'missing-source': 0,
    'icloud-placeholder': 0,
    'remote-session': 0,
    'corrupt-manifest': 0,
    other: 0
  }
}

const emptyUnverifiableBuckets = createEmptyUnverifiableBuckets

class LibraryHealthStateMachine extends EventEmitter {
  private _state: LibraryHealthState = 'initializing'
  private _stateSinceAt = new Date().toISOString()
  private readonly _diagnostics: LibraryDiagnosticEvent[] = []
  private _dimensions: LibraryHealthDimensions = this.initialDimensions()
  private _writerRecovery: LibraryWriterRecoveryStatus = {
    attempt: 0,
    nextRetryAt: null,
    lastReason: null
  }

  private initialDimensions(now = new Date().toISOString()): LibraryHealthDimensions {
    return {
      writerCapability: {
        state: 'unproven',
        stateSinceAt: now,
        reasonCode: null
      },
      activeSourceFreshness: {
        state: 'unproven',
        stateSinceAt: now,
        reasonCode: null,
        foregroundStartedAt: now,
        foregroundReadyAt: null,
        foregroundReadyLatencyMs: null,
        foregroundReadySloMs: 60_000,
        sloMet: null
      },
      backgroundBacklog: {
        state: 'idle',
        stateSinceAt: now,
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
        stateSinceAt: now,
        authorizedGroupCount: 0,
        authorizedPackageCount: 0,
        unknownGroupCount: 0,
        unknownPackageCount: 0,
        evidenceMismatchGroupCount: 0,
        records: []
      }
    }
  }

  private deriveCompositeState(): LibraryHealthState {
    const writer = this._dimensions.writerCapability.state
    if (writer === 'unproven') return 'initializing'
    if (writer === 'blocked') return 'writer-blocked'
    if (writer === 'read-only') return 'read-only'
    if (writer === 'corrupt') return 'corrupt'
    if (this._dimensions.identityExceptions.state !== 'none') return 'identity-conflict'
    return this._dimensions.activeSourceFreshness.state === 'unproven' ? 'initializing' : 'ready'
  }

  private commit(previousState: LibraryHealthState): void {
    const next = this.deriveCompositeState()
    if (next !== previousState) {
      this._state = next
      this._stateSinceAt = new Date().toISOString()
      this.emit('stateChanged', { previous: previousState, current: next })
    } else {
      this._state = next
    }
    this.emit('changed')
  }

  private transitionAllowed(
    dimension: keyof typeof LIBRARY_HEALTH_DIMENSION_TRANSITIONS,
    current: string,
    next: string
  ): boolean {
    if (current === next) return true
    const transitions = LIBRARY_HEALTH_DIMENSION_TRANSITIONS[dimension] as Record<string, readonly string[]>
    return transitions[current]?.includes(next) === true
  }

  get state(): LibraryHealthState {
    return this._state
  }

  get diagnostics(): readonly LibraryDiagnosticEvent[] {
    return this._diagnostics
  }

  replaceDiagnostics(events: readonly LibraryDiagnosticEvent[]): void {
    this._diagnostics.splice(0, this._diagnostics.length, ...events.slice(-MAX_DIAGNOSTIC_EVENTS))
  }

  /**
   * Transition to a new state. Invalid transitions (e.g. ready → initializing)
   * are silently ignored; the state machine only moves forward.
   */
  transition(
    next: LibraryHealthState,
    errorCode?: string,
    message?: string,
    reason?: LibraryWriterFailureReason
  ): void {
    const prev = this._state
    const now = new Date().toISOString()
    if (next === 'initializing') {
      this._dimensions.writerCapability = { state: 'unproven', stateSinceAt: now, reasonCode: errorCode || null }
      this._dimensions.activeSourceFreshness = {
        state: 'unproven',
        stateSinceAt: now,
        reasonCode: errorCode || null,
        foregroundStartedAt: now,
        foregroundReadyAt: null,
        foregroundReadyLatencyMs: null,
        foregroundReadySloMs: 60_000,
        sloMet: null
      }
    } else if (next === 'ready') {
      this._dimensions.writerCapability = { state: 'available', stateSinceAt: now, reasonCode: errorCode || null }
      if (this._dimensions.activeSourceFreshness.state === 'unproven') {
        this.markActiveSourceFreshness('durable', errorCode || null, false)
      }
      this._dimensions.identityExceptions = {
        ...this._dimensions.identityExceptions,
        state: 'none',
        stateSinceAt: now,
        authorizedGroupCount: 0,
        authorizedPackageCount: 0,
        unknownGroupCount: 0,
        unknownPackageCount: 0,
        evidenceMismatchGroupCount: 0,
        records: []
      }
    } else if (next === 'identity-conflict') {
      this._dimensions.writerCapability = { state: 'available', stateSinceAt: now, reasonCode: errorCode || null }
      if (this._dimensions.activeSourceFreshness.state === 'unproven') {
        this.markActiveSourceFreshness('durable', errorCode || null, false)
      }
      if (this._dimensions.identityExceptions.state === 'none') {
        this._dimensions.identityExceptions = {
          ...this._dimensions.identityExceptions,
          state: 'unknown-conflicts',
          stateSinceAt: now,
          unknownGroupCount: 1,
          unknownPackageCount: 1
        }
      }
    } else {
      const writerState: WriterCapabilityState = next === 'writer-blocked'
        ? 'blocked'
        : next === 'read-only'
          ? 'read-only'
          : 'corrupt'
      this._dimensions.writerCapability = { state: writerState, stateSinceAt: now, reasonCode: errorCode || null }
    }

    if (errorCode || message) {
      this.recordDiagnostic(next, errorCode || 'STATE_CHANGE', message || `${prev} -> ${next}`, reason)
    }
    if (next === 'writer-blocked') this._writerRecovery.lastReason = reason || null
    if (next !== 'writer-blocked') this._writerRecovery.nextRetryAt = null
    this.commit(prev)
  }

  beginBackgroundSync(total: number): void {
    const previous = this._state
    const now = new Date().toISOString()
    if (this._dimensions.writerCapability.state !== 'available') {
      this._dimensions.writerCapability = { state: 'unproven', stateSinceAt: now, reasonCode: null }
    }
    if (this._dimensions.activeSourceFreshness.state === 'unproven') {
      this._dimensions.activeSourceFreshness = {
        ...this._dimensions.activeSourceFreshness,
        stateSinceAt: now,
        reasonCode: null
      }
    }
    this._dimensions.backgroundBacklog = {
      ...this._dimensions.backgroundBacklog,
      state: total > 0 ? 'running' : 'completed',
      stateSinceAt: now,
      total,
      completed: 0,
      failed: 0,
      remaining: total,
      failures: [],
      failureCounts: {}
    }
    this.commit(previous)
  }

  markWriterCapability(state: WriterCapabilityState, reasonCode: string | null = null): void {
    const current = this._dimensions.writerCapability.state
    if (!this.transitionAllowed('writerCapability', current, state)) return
    const previous = this._state
    this._dimensions.writerCapability = {
      state,
      stateSinceAt: current === state ? this._dimensions.writerCapability.stateSinceAt : new Date().toISOString(),
      reasonCode
    }
    this.commit(previous)
  }

  markActiveSourceFreshness(
    state: ActiveSourceFreshnessState,
    reasonCode: string | null = null,
    emit = true
  ): void {
    const current = this._dimensions.activeSourceFreshness
    if (!this.transitionAllowed('activeSourceFreshness', current.state, state)) return
    const previous = this._state
    const readyAt = state === 'durable' && current.foregroundReadyAt === null
      ? new Date().toISOString()
      : current.foregroundReadyAt
    const latency = readyAt
      ? Math.max(0, Date.parse(readyAt) - Date.parse(current.foregroundStartedAt))
      : current.foregroundReadyLatencyMs
    this._dimensions.activeSourceFreshness = {
      ...current,
      state,
      stateSinceAt: current.state === state ? current.stateSinceAt : new Date().toISOString(),
      reasonCode,
      foregroundReadyAt: readyAt,
      foregroundReadyLatencyMs: latency,
      sloMet: latency === null ? null : latency <= 60_000
    }
    if (emit) this.commit(previous)
  }

  updateBackgroundProgress(progress: {
    total: number
    completed: number
    failed: number
    remaining: number
    failure?: BackgroundSyncFailure
  }): void {
    const previous = this._state
    const isNewFailure = progress.failure && !this._dimensions.backgroundBacklog.failures.some((failure) =>
      failure.sessionId === progress.failure!.sessionId && failure.reasonCode === progress.failure!.reasonCode)
    const failures = isNewFailure && this._dimensions.backgroundBacklog.failures.length < MAX_BACKGROUND_FAILURE_SAMPLES
      ? [...this._dimensions.backgroundBacklog.failures, progress.failure!]
      : [...this._dimensions.backgroundBacklog.failures]
    const failureCounts = progress.failure
      ? {
          ...this._dimensions.backgroundBacklog.failureCounts,
          [progress.failure.reasonCode]:
            (this._dimensions.backgroundBacklog.failureCounts[progress.failure.reasonCode] || 0) + 1
        }
      : { ...this._dimensions.backgroundBacklog.failureCounts }
    this._dimensions.backgroundBacklog = {
      ...this._dimensions.backgroundBacklog,
      state: 'running',
      total: progress.total,
      completed: progress.completed,
      failed: progress.failed,
      remaining: progress.remaining,
      failures,
      failureCounts
    }
    this.commit(previous)
  }

  finishBackgroundSync(paused = false): void {
    const current = this._dimensions.backgroundBacklog
    const next: BackgroundBacklogState = paused
      ? 'paused'
      : current.failed > 0
        ? 'completed-with-errors'
        : 'completed'
    if (!this.transitionAllowed('backgroundBacklog', current.state, next)) return
    const previous = this._state
    this._dimensions.backgroundBacklog = {
      ...current,
      state: next,
      stateSinceAt: current.state === next ? current.stateSinceAt : new Date().toISOString(),
      remaining: paused ? current.remaining : Math.max(0, current.total - current.completed - current.failed)
    }
    this.commit(previous)
  }

  setUnverifiableBuckets(buckets: Readonly<Record<UnverifiableReason, number>>): void {
    const previous = this._state
    this._dimensions.backgroundBacklog = {
      ...this._dimensions.backgroundBacklog,
      unverifiableBuckets: { ...buckets }
    }
    this.commit(previous)
  }

  setBackgroundRecovery(recovery: LibraryHealthDimensions['backgroundBacklog']['recovery']): void {
    const previous = this._state
    this._dimensions.backgroundBacklog = {
      ...this._dimensions.backgroundBacklog,
      recovery: { ...recovery }
    }
    this.commit(previous)
  }

  setIdentityExceptions(summary: Omit<LibraryHealthDimensions['identityExceptions'], 'stateSinceAt'>): void {
    const current = this._dimensions.identityExceptions
    if (!this.transitionAllowed('identityExceptions', current.state, summary.state)) return
    const previous = this._state
    this._dimensions.identityExceptions = {
      ...summary,
      records: summary.records.map((record) => structuredClone(record)),
      stateSinceAt: current.state === summary.state ? current.stateSinceAt : new Date().toISOString()
    }
    this.commit(previous)
  }

  recordDiagnostic(
    state: LibraryHealthState,
    errorCode: string,
    message: string,
    reason?: LibraryWriterFailureReason,
    recovery?: LibraryWriterRecoveryStatus
  ): void {
    const event: LibraryDiagnosticEvent = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      state,
      errorCode,
      message: sanitizeDiagnosticMessage(message),
      ...(reason ? { reason } : {}),
      ...(recovery
        ? {
            attempt: recovery.attempt,
            nextRetryAt: recovery.nextRetryAt,
            lastReason: recovery.lastReason
          }
        : {}),
      severity: /(?:ERROR|FAILED|CONFLICT|BUSY|DENIED|FULL|UNSAFE|CORRUPT)/.test(errorCode) ||
        (state !== 'ready' && state !== 'initializing')
        ? 'error'
        : 'warning'
    }
    this._diagnostics.push(event)
    // Keep bounded — drop oldest events beyond the cap
    while (this._diagnostics.length > MAX_DIAGNOSTIC_EVENTS) {
      this._diagnostics.shift()
    }
    appendDiagnostic(event)
    this.emit('diagnostic', event)
  }

  snapshot(): LibraryHealthSnapshot {
    const latest = this._diagnostics[this._diagnostics.length - 1]
    const identity = this._dimensions.identityExceptions
    const hasIdentityRestrictions = identity.authorizedGroupCount + identity.unknownGroupCount +
      identity.evidenceMismatchGroupCount > 0
    const compensation = compensationQueue.progress
    return {
      schemaVersion: 1,
      state: this._state,
      stateSinceAt: this._stateSinceAt,
      reasonCode: latest?.errorCode ?? null,
      writeCapability: this._dimensions.writerCapability.state === 'available'
        ? hasIdentityRestrictions ? 'partial' : 'full'
        : 'none',
      diagnostics: [...this._diagnostics],
      compensation,
      writerRecovery: { ...this._writerRecovery },
      availableActions: compensationQueue.running
        ? ['cancel-compensation']
        : this._state === 'writer-blocked' || compensation.pending > 0
          ? ['retry-compensation']
          : [],
      dimensions: structuredClone(this._dimensions)
    }
  }

  /**
   * Reset to initializing. Used only when the Library root changes.
   */
  reset(): void {
    const now = new Date().toISOString()
    this._state = 'initializing'
    this._stateSinceAt = now
    this._dimensions = this.initialDimensions(now)
    this._writerRecovery = { attempt: 0, nextRetryAt: null, lastReason: null }
    this.emit('changed')
  }

  updateWriterRecovery(status: LibraryWriterRecoveryStatus): void {
    this._writerRecovery = { ...status }
    this.emit('changed')
  }
}

// ---------------------------------------------------------------------------
// Compensation Queue
// ---------------------------------------------------------------------------

interface CompensationEntry {
  sessionId: string
  dirPath: string
}

type CompensationProcessor = (sessionId: string, dirPath: string) => Promise<void>

class CompensationQueue extends EventEmitter {
  private _queue: CompensationEntry[] = []
  private readonly _activeSessionIds = new Set<string>()
  private _progress = { total: 0, completed: 0, failed: 0 }
  private _running = false
  private _cancelled = false
  private _accepting = true
  private _runPromise: Promise<CompensationProgress> | null = null
  private _generation = 0
  private _concurrency: number

  constructor(concurrency = 2) {
    super()
    this._concurrency = Math.max(1, Math.min(concurrency, 3))
  }

  get progress(): CompensationProgress {
    return {
      ...this._progress,
      pending: this._queue.length + this._activeSessionIds.size,
      inProgress: this._running,
      cancelled: this._cancelled
    }
  }

  get running(): boolean {
    return this._running
  }

  /**
   * Enqueue sessions that need re-processing after a blocked period.
   * Does not start processing — call `run()` explicitly.
   */
  enqueue(entries: CompensationEntry[]): void {
    if (!this._accepting) return
    // Deduplicate by sessionId
    const beforeLength = this._queue.length
    const existing = new Set([...this._queue.map((e) => e.sessionId), ...this._activeSessionIds])
    for (const entry of entries) {
      if (!existing.has(entry.sessionId)) {
        this._queue.push(entry)
        existing.add(entry.sessionId)
      }
    }
    if (this._running) this._progress.total += this._queue.length - beforeLength
    else this._progress = { total: this._queue.length, completed: 0, failed: 0 }
    this.emit('update', this.progress)
  }

  cancel(): void {
    this._cancelled = true
    this.emit('update', this.progress)
  }

  close(): void {
    this._accepting = false
    this.cancel()
  }

  /**
   * Process the queue with bounded concurrency.
   */
  run(processor: CompensationProcessor): Promise<CompensationProgress> {
    if (!this._accepting || this._cancelled) return Promise.resolve(this.progress)
    if (this._runPromise) return this._runPromise
    this._runPromise = this.process(processor).finally(() => {
      this._runPromise = null
    })
    return this._runPromise
  }

  private async process(processor: CompensationProcessor): Promise<CompensationProgress> {
    const generation = this._generation
    this._running = true
    this._progress = { total: this._queue.length, completed: 0, failed: 0 }
    this.emit('update', this.progress)
    const failedEntries: CompensationEntry[] = []

    while (this._queue.length > 0 && !this._cancelled && generation === this._generation) {
      const batch = this._queue.splice(0, this._concurrency)
      batch.forEach((entry) => this._activeSessionIds.add(entry.sessionId))
      const results = await Promise.allSettled(
        batch.map((entry) => processor(entry.sessionId, entry.dirPath))
      )
      for (const [index, result] of results.entries()) {
        this._activeSessionIds.delete(batch[index].sessionId)
        if (generation !== this._generation) continue
        if (result.status === 'fulfilled') {
          this._progress.completed++
        } else {
          this._progress.failed++
          failedEntries.push(batch[index])
        }
      }
      if (generation === this._generation) this.emit('update', this.progress)
    }

    // A failed item remains explicit pending work for a later Retry. Requeue it
    // only after this run ends so a persistent failure cannot create a hot loop.
    if (generation === this._generation) this._queue.unshift(...failedEntries)
    this._running = false
    this.emit('update', this.progress)
    return this.progress
  }

  waitForIdle(): Promise<void> {
    return this._runPromise?.then(() => undefined, () => undefined) ?? Promise.resolve()
  }

  /**
   * Clear queue and reset progress. Used for retry.
   */
  reset(): void {
    this._generation++
    this._cancelled = true
    this._queue = []
    this._progress = { total: 0, completed: 0, failed: 0 }
    this._accepting = true
    this._cancelled = false
  }

  retry(processor: CompensationProcessor): Promise<CompensationProgress> {
    if (!this._accepting) return Promise.resolve(this.progress)
    this._cancelled = false
    this.emit('update', this.progress)
    return this.run(processor)
  }
}

/**
 * Redact a filesystem path to prevent PII leaks in diagnostic events.
 * Keeps only the last two path segments (e.g. "session-dir/file.ext").
 */
function redactPath(filePath: string): string {
  const parts = filePath.split(path.sep)
  return parts.length <= 2 ? parts.join('/') : `.../${parts.slice(-2).join('/')}`
}

// ---------------------------------------------------------------------------
// Singleton + Public API
// ---------------------------------------------------------------------------

const healthMachine = new LibraryHealthStateMachine()
// One writer at a time: parallel workers would only contend for the same lease
// and can turn a healthy second item into a false timeout failure.
const compensationQueue = new CompensationQueue(1)

/**
 * Get the current health state.
 */
export function getLibraryHealthState(): LibraryHealthState {
  return healthMachine.state
}

/**
 * Get the full health snapshot (state + diagnostics).
 */
export function getLibraryHealth(): LibraryHealthSnapshot {
  return healthMachine.snapshot()
}

/**
 * Transition the Library to a new health state.
 *
 * Queue population is explicit at the failing write boundary. Keeping state
 * transitions side-effect free prevents read-only health probes from creating
 * background writes.
 */
export function transitionLibraryHealth(
  next: LibraryHealthState,
  errorCode?: string,
  message?: string,
  reason?: LibraryWriterFailureReason
): void {
  healthMachine.transition(next, errorCode, message, reason)
}

export function updateLibraryWriterRecovery(status: LibraryWriterRecoveryStatus): void {
  healthMachine.updateWriterRecovery({
    attempt: Math.max(0, Math.trunc(status.attempt)),
    nextRetryAt: status.nextRetryAt,
    lastReason: status.lastReason
  })
}

export function beginLibraryBackgroundSync(total: number): void {
  healthMachine.beginBackgroundSync(Math.max(0, Math.trunc(total)))
}

export function transitionWriterCapability(
  state: WriterCapabilityState,
  reasonCode: string | null = null
): void {
  healthMachine.markWriterCapability(state, reasonCode)
}

export function transitionActiveSourceFreshness(
  state: ActiveSourceFreshnessState,
  reasonCode: string | null = null
): void {
  healthMachine.markActiveSourceFreshness(state, reasonCode)
}

export function updateLibraryBackgroundProgress(progress: {
  total: number
  completed: number
  failed: number
  remaining: number
  failure?: BackgroundSyncFailure
}): void {
  healthMachine.updateBackgroundProgress({
    total: Math.max(0, Math.trunc(progress.total)),
    completed: Math.max(0, Math.trunc(progress.completed)),
    failed: Math.max(0, Math.trunc(progress.failed)),
    remaining: Math.max(0, Math.trunc(progress.remaining)),
    ...(progress.failure ? { failure: progress.failure } : {})
  })
}

export function finishLibraryBackgroundSync(paused = false): void {
  healthMachine.finishBackgroundSync(paused)
}

export function updateLibraryBackgroundRecovery(
  recovery: LibraryHealthDimensions['backgroundBacklog']['recovery']
): void {
  healthMachine.setBackgroundRecovery({
    ...recovery,
    retryScheduled: Math.max(0, Math.trunc(recovery.retryScheduled)),
    waitingProvider: Math.max(0, Math.trunc(recovery.waitingProvider)),
    attentionRequired: Math.max(0, Math.trunc(recovery.attentionRequired)),
    exhausted: Math.max(0, Math.trunc(recovery.exhausted)),
    maxAttempts: Math.max(0, Math.trunc(recovery.maxAttempts))
  })
}

export function updateLibraryUnverifiableBuckets(
  buckets: Readonly<Record<UnverifiableReason, number>>
): void {
  healthMachine.setUnverifiableBuckets(buckets)
}

export function updateLibraryIdentityExceptions(
  summary: Omit<LibraryHealthDimensions['identityExceptions'], 'stateSinceAt'>
): void {
  healthMachine.setIdentityExceptions(summary)
}

/** A parse-only success can never prove the Library writer recovered. */
export function healthAfterSuccessfulLibraryWrite(
  current: LibraryHealthState,
  maintainedLibrary: boolean,
  identityConflictCount: number
): LibraryHealthState | null {
  if (current !== 'writer-blocked' || !maintainedLibrary) return null
  return identityConflictCount > 0 ? 'identity-conflict' : 'ready'
}

/**
 * Record a diagnostic event without a state change.
 */
export function recordLibraryDiagnostic(
  errorCode: string,
  message: string,
  reason?: LibraryWriterFailureReason,
  recovery?: LibraryWriterRecoveryStatus
): void {
  healthMachine.recordDiagnostic(healthMachine.state, errorCode, message, reason, recovery)
}

/**
 * Reset the health state machine (used on Library root change).
 */
export function resetLibraryHealth(): void {
  healthMachine.reset()
  compensationQueue.reset()
}

/**
 * Register a callback for health state changes.
 * Returns an unsubscribe function.
 */
export function onLibraryHealthChanged(
  callback: (snapshot: LibraryHealthSnapshot) => void
): () => void {
  const listener = (): void => callback(getLibraryHealth())
  healthMachine.on('changed', listener)
  return () => healthMachine.removeListener('changed', listener)
}

/**
 * Register a callback for diagnostic events.
 * Returns an unsubscribe function.
 */
export function onLibraryDiagnostic(
  callback: (event: LibraryDiagnosticEvent) => void
): () => void {
  healthMachine.on('diagnostic', callback)
  return () => healthMachine.removeListener('diagnostic', callback)
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compensation Queue public API
// ---------------------------------------------------------------------------

export function getCompensationProgress(): CompensationProgress {
  return compensationQueue.progress
}

export function isCompensationRunning(): boolean {
  return compensationQueue.running
}

export function cancelCompensation(): void {
  compensationQueue.cancel()
}

/** Stop accepting new work before shutdown/root switch, then drain safely. */
export function closeCompensation(): void {
  compensationQueue.close()
}

export function waitForCompensationIdle(): Promise<void> {
  return compensationQueue.waitForIdle()
}

export function resetCompensation(): void {
  compensationQueue.reset()
}

export function onCompensationUpdate(
  callback: (progress: CompensationProgress) => void
): () => void {
  compensationQueue.on('update', callback)
  return () => compensationQueue.removeListener('update', callback)
}

/**
 * Run the compensation queue with the given processor.
 * The processor receives (sessionId, dirPath) and should re-sync
 * transcript + backup for that session.
 */
export function runCompensation(
  processor: CompensationProcessor
): Promise<CompensationProgress> {
  return compensationQueue.run(processor)
}

/** Explicit user retry is the only operation that resumes a cancelled queue. */
export function retryCompensation(
  processor: CompensationProcessor
): Promise<CompensationProgress> {
  return compensationQueue.retry(processor)
}

/**
 * Manually enqueue sessions for compensation (e.g. after retry).
 */
export function enqueueCompensation(
  entries: CompensationEntry[]
): void {
  compensationQueue.enqueue(entries)
}

// ---------------------------------------------------------------------------
// Error classification helpers
// ---------------------------------------------------------------------------

/**
 * Classify a Library initialization or runtime error into a health state
 * and error code. Used by callers to feed the state machine.
 */
export function classifyLibraryError(
  error: unknown
): { state: LibraryHealthState; errorCode: string; message: string; writerReason?: LibraryWriterFailureReason } {
  if (!error || typeof error !== 'object') {
    return {
      state: 'corrupt',
      errorCode: 'UNKNOWN_ERROR',
      message: 'Unknown Library error'
    }
  }

  const err = error as { name?: string; code?: string; message?: string; reason?: unknown }

  if (err.code === 'WRITER_IDENTITY_UNAVAILABLE') {
    return {
      state: 'writer-blocked',
      errorCode: 'WRITER_IDENTITY_UNAVAILABLE',
      message: 'Library writer identity is unavailable; no lock was created',
      writerReason: 'identity-unavailable'
    }
  }

  // Writer busy / lease contention
  if (err.name === 'LibraryWriterBusyError' || err.code === 'LIBRARY_WRITER_BUSY') {
    const reason = writerBusyReason(err.reason)
    return {
      state: 'writer-blocked',
      errorCode: WRITER_ERROR_CODES[reason],
      message: WRITER_ERROR_MESSAGES[reason],
      writerReason: reason
    }
  }

  // Identity conflict
  if (
    err.name === 'SessionIdentityConflictError' ||
    err.code === 'SESSION_IDENTITY_CONFLICT'
  ) {
    return {
      state: 'identity-conflict',
      errorCode: 'IDENTITY_CONFLICT',
      message: 'Multiple packages claim the same logical session identity'
    }
  }

  // Path safety
  if (err.name === 'LibraryPathUnsafeError') {
    return {
      state: 'corrupt',
      errorCode: 'PATH_UNSAFE',
      message: 'Library path failed safety validation'
    }
  }

  // Generic filesystem errors
  const fsCode = err.code
  if (fsCode === 'EACCES' || fsCode === 'EPERM') {
    return {
      state: 'read-only',
      errorCode: 'PERMISSION_DENIED',
      message: 'Insufficient filesystem permissions for Library operations'
    }
  }
  if (fsCode === 'ENOSPC') {
    return {
      state: 'writer-blocked',
      errorCode: 'DISK_FULL',
      message: 'Disk space exhausted'
    }
  }
  if (fsCode === 'EIO') {
    return {
      state: 'corrupt',
      errorCode: 'IO_ERROR',
      message: 'I/O error accessing Library'
    }
  }

  // Catch-all
  return {
    state: 'corrupt',
    errorCode: 'INIT_FAILED',
    message: redactErrorMessage(err.message || 'Library initialization failed')
  }
}

const WRITER_ERROR_CODES: Record<LibraryWriterBusyReason, string> = {
  'active-owner': 'WRITER_BUSY_ACTIVE_OWNER',
  'remote-owner': 'WRITER_BUSY_REMOTE_OWNER',
  'unverifiable-owner': 'WRITER_BUSY_UNVERIFIABLE_OWNER',
  'corrupt-owner': 'WRITER_BUSY_CORRUPT_OWNER',
  'recovery-in-progress': 'WRITER_BUSY_RECOVERY_IN_PROGRESS',
  timeout: 'WRITER_BUSY_TIMEOUT'
}

const WRITER_ERROR_MESSAGES: Record<LibraryWriterBusyReason, string> = {
  'active-owner': 'Library writer is held by another process',
  'remote-owner': 'Library writer belongs to a different host',
  'unverifiable-owner': 'Library writer ownership could not be verified',
  'corrupt-owner': 'Library writer owner record is corrupt',
  'recovery-in-progress': 'Library writer recovery is already in progress',
  timeout: 'Library writer acquisition timed out'
}

function writerBusyReason(reason: unknown): LibraryWriterBusyReason {
  return reason === 'active-owner' || reason === 'remote-owner' ||
    reason === 'unverifiable-owner' || reason === 'corrupt-owner' ||
    reason === 'recovery-in-progress' || reason === 'timeout'
    ? reason
    : 'unverifiable-owner'
}

/**
 * Strip absolute paths from error messages to avoid PII leaks.
 */
function redactErrorMessage(message: string): string {
  // Replace absolute paths (/Users/xxx/..., C:\Users\xxx\...) with redacted form
  return message.replace(
    /(?:\/[^\s:]+|[A-Z]:\\[^\s:]+)/g,
    (match) => redactPath(match)
  )
}
