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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LibraryHealthState =
  | 'initializing'
  | 'ready'
  | 'read-only'
  | 'writer-blocked'
  | 'identity-conflict'
  | 'corrupt'

export interface LibraryDiagnosticEvent {
  timestamp: string
  state: LibraryHealthState
  errorCode: string
  message: string
}

export interface SessionFreshness {
  sessionId: string
  sourceUpdatedAt: string | null
  transcriptUpdatedAt: string | null
  backupUpdatedAt: string | null
  lagMs: number
}

export interface CompensationProgress {
  total: number
  completed: number
  failed: number
}

export interface LibraryHealthSnapshot {
  state: LibraryHealthState
  diagnostics: readonly LibraryDiagnosticEvent[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DIAGNOSTIC_EVENTS = 50
const DEFAULT_STALE_THRESHOLD_MS = 60_000
const ERROR_LAG_THRESHOLD_MS = 5 * 60_000

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

class LibraryHealthStateMachine extends EventEmitter {
  private _state: LibraryHealthState = 'initializing'
  private readonly _diagnostics: LibraryDiagnosticEvent[] = []

  get state(): LibraryHealthState {
    return this._state
  }

  get diagnostics(): readonly LibraryDiagnosticEvent[] {
    return this._diagnostics
  }

  /**
   * Transition to a new state. Invalid transitions (e.g. ready → initializing)
   * are silently ignored; the state machine only moves forward.
   */
  transition(
    next: LibraryHealthState,
    errorCode?: string,
    message?: string
  ): void {
    const prev = this._state
    if (prev === next) return

    this._state = next

    if (errorCode || message) {
      this.recordDiagnostic(next, errorCode || 'STATE_CHANGE', message || `${prev} -> ${next}`)
    }

    this.emit('stateChanged', { previous: prev, current: next })
  }

  recordDiagnostic(
    state: LibraryHealthState,
    errorCode: string,
    message: string
  ): void {
    const event: LibraryDiagnosticEvent = {
      timestamp: new Date().toISOString(),
      state,
      errorCode,
      message
    }
    this._diagnostics.push(event)
    // Keep bounded — drop oldest events beyond the cap
    while (this._diagnostics.length > MAX_DIAGNOSTIC_EVENTS) {
      this._diagnostics.shift()
    }
    this.emit('diagnostic', event)
  }

  snapshot(): LibraryHealthSnapshot {
    return {
      state: this._state,
      diagnostics: [...this._diagnostics]
    }
  }

  /**
   * Reset to initializing. Used only when the Library root changes.
   */
  reset(): void {
    this._state = 'initializing'
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
  private _progress: CompensationProgress = { total: 0, completed: 0, failed: 0 }
  private _running = false
  private _cancelled = false
  private _concurrency: number

  constructor(concurrency = 2) {
    super()
    this._concurrency = Math.max(1, Math.min(concurrency, 3))
  }

  get progress(): CompensationProgress {
    return { ...this._progress }
  }

  get running(): boolean {
    return this._running
  }

  /**
   * Enqueue sessions that need re-processing after a blocked period.
   * Does not start processing — call `run()` explicitly.
   */
  enqueue(entries: CompensationEntry[]): void {
    // Deduplicate by sessionId
    const existing = new Set(this._queue.map((e) => e.sessionId))
    for (const entry of entries) {
      if (!existing.has(entry.sessionId)) {
        this._queue.push(entry)
        existing.add(entry.sessionId)
      }
    }
    this._progress = {
      total: this._queue.length + this._progress.completed + this._progress.failed,
      completed: this._progress.completed,
      failed: this._progress.failed
    }
    this.emit('update', this.progress)
  }

  cancel(): void {
    this._cancelled = true
  }

  /**
   * Process the queue with bounded concurrency.
   */
  async run(processor: CompensationProcessor): Promise<CompensationProgress> {
    if (this._running) return this.progress
    this._running = true
    this._cancelled = false
    this._progress = { total: this._queue.length, completed: 0, failed: 0 }
    this.emit('update', this.progress)

    while (this._queue.length > 0 && !this._cancelled) {
      const batch = this._queue.splice(0, this._concurrency)
      const results = await Promise.allSettled(
        batch.map((entry) => processor(entry.sessionId, entry.dirPath))
      )
      for (const result of results) {
        if (result.status === 'fulfilled') {
          this._progress.completed++
        } else {
          this._progress.failed++
        }
      }
      this.emit('update', this.progress)
    }

    this._running = false
    return this.progress
  }

  /**
   * Clear queue and reset progress. Used for retry.
   */
  reset(): void {
    this._queue = []
    this._progress = { total: 0, completed: 0, failed: 0 }
    this._cancelled = false
    this._running = false
  }
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

function statMtimeIso(filePath: string): string | null {
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString()
  } catch {
    return null
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
const compensationQueue = new CompensationQueue(2)

// Track stale sessions observed during blocked/error periods
let staleDuringBlockedPeriod: CompensationEntry[] = []

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
 * When transitioning from an error/blocked state back to 'ready',
 * the compensation queue is populated with sessions that were stale
 * during the blocked period.
 */
export function transitionLibraryHealth(
  next: LibraryHealthState,
  errorCode?: string,
  message?: string
): void {
  const prev = healthMachine.state
  healthMachine.transition(next, errorCode, message)

  // When recovering from blocked/error → ready, seed the compensation queue
  if (
    next === 'ready' &&
    (prev === 'writer-blocked' || prev === 'identity-conflict' || prev === 'corrupt')
  ) {
    if (staleDuringBlockedPeriod.length > 0) {
      compensationQueue.enqueue([...staleDuringBlockedPeriod])
      staleDuringBlockedPeriod = []
    }
  }
}

/**
 * Record a diagnostic event without a state change.
 */
export function recordLibraryDiagnostic(
  errorCode: string,
  message: string
): void {
  healthMachine.recordDiagnostic(healthMachine.state, errorCode, message)
}

/**
 * Reset the health state machine (used on Library root change).
 */
export function resetLibraryHealth(): void {
  healthMachine.reset()
  staleDuringBlockedPeriod = []
  compensationQueue.reset()
}

/**
 * Register a callback for health state changes.
 * Returns an unsubscribe function.
 */
export function onLibraryHealthChanged(
  callback: (event: { previous: LibraryHealthState; current: LibraryHealthState }) => void
): () => void {
  healthMachine.on('stateChanged', callback)
  return () => healthMachine.removeListener('stateChanged', callback)
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

/**
 * Compute freshness data for a single Library session.
 * Lightweight: stat calls only, never parses transcripts.
 */
export function computeSessionFreshness(
  sessionId: string,
  dirPath: string,
  sourceFilePaths: string[]
): SessionFreshness {
  const now = Date.now()

  // Source file mtime: use the most recent across all source paths
  let sourceUpdatedAt: string | null = null
  let sourceMs = 0
  for (const srcPath of sourceFilePaths) {
    try {
      const stat = fs.statSync(srcPath)
      if (stat.mtimeMs > sourceMs) {
        sourceMs = stat.mtimeMs
        sourceUpdatedAt = new Date(stat.mtimeMs).toISOString()
      }
    } catch {
      // Source file may be missing (remote, iCloud placeholder, etc.)
    }
  }

  // Transcript mtime
  const transcriptPath = path.join(dirPath, 'transcript.md')
  const transcriptUpdatedAt = statMtimeIso(transcriptPath)

  // Backup mtime
  const backupPath = path.join(dirPath, 'backup.jsonl')
  const backupUpdatedAt = statMtimeIso(backupPath)

  // Lag = now - min(sourceUpdatedAt, transcriptUpdatedAt) among available timestamps
  const timestamps = [sourceMs, transcriptUpdatedAt ? new Date(transcriptUpdatedAt).getTime() : 0]
    .filter((t) => t > 0)
  const minTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : 0
  const lagMs = minTimestamp > 0 ? Math.max(0, now - minTimestamp) : 0

  return {
    sessionId,
    sourceUpdatedAt,
    transcriptUpdatedAt,
    backupUpdatedAt,
    lagMs
  }
}

/**
 * Find sessions whose freshness lag exceeds a threshold.
 */
export function findStaleSessions(
  sessions: ReadonlyArray<{ sessionId: string; dirPath: string; sourceFilePaths: string[] }>,
  thresholdMs = DEFAULT_STALE_THRESHOLD_MS
): SessionFreshness[] {
  const stale: SessionFreshness[] = []
  for (const session of sessions) {
    const freshness = computeSessionFreshness(
      session.sessionId,
      session.dirPath,
      session.sourceFilePaths
    )
    if (freshness.lagMs > thresholdMs) {
      stale.push(freshness)
    }
  }
  return stale
}

/**
 * Check freshness and record diagnostics for sessions exceeding the error threshold.
 */
export function checkFreshnessAndRecordDiagnostics(
  sessions: ReadonlyArray<{ sessionId: string; dirPath: string; sourceFilePaths: string[] }>
): void {
  const state = healthMachine.state
  const isBlocked = state === 'writer-blocked' || state === 'identity-conflict' || state === 'corrupt'

  for (const session of sessions) {
    const freshness = computeSessionFreshness(
      session.sessionId,
      session.dirPath,
      session.sourceFilePaths
    )

    if (freshness.lagMs > ERROR_LAG_THRESHOLD_MS) {
      healthMachine.recordDiagnostic(
        state,
        'SESSION_STALE_ERROR',
        `Session ${session.sessionId.slice(0, 12)} lag ${Math.round(freshness.lagMs / 1000)}s exceeds 5min threshold`
      )
    }

    // Track stale sessions during blocked periods for compensation
    if (isBlocked && freshness.lagMs > DEFAULT_STALE_THRESHOLD_MS) {
      const already = staleDuringBlockedPeriod.some((e) => e.sessionId === session.sessionId)
      if (!already) {
        staleDuringBlockedPeriod.push({
          sessionId: session.sessionId,
          dirPath: session.dirPath
        })
      }
    }
  }
}

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
): { state: LibraryHealthState; errorCode: string; message: string } {
  if (!error || typeof error !== 'object') {
    return {
      state: 'corrupt',
      errorCode: 'UNKNOWN_ERROR',
      message: 'Unknown Library error'
    }
  }

  const err = error as { name?: string; code?: string; message?: string }

  // Writer busy / lease contention
  if (err.name === 'LibraryWriterBusyError' || err.code === 'LIBRARY_WRITER_BUSY') {
    return {
      state: 'writer-blocked',
      errorCode: 'WRITER_BUSY',
      message: 'Library writer is held by another process'
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
