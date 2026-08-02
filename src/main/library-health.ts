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
  computeSessionFreshness,
  findStaleSessions,
  freshnessDiagnosticFingerprint
} from './library-freshness'
import {
  type CompensationProgress,
  type LibraryDiagnosticEvent,
  type LibraryHealthSnapshot,
  type LibraryHealthState,
  type SessionFreshness
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

let diagnosticFilePath: string | null = null

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
          typeof value.message === 'string' && (value.severity === 'warning' || value.severity === 'error')) {
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

class LibraryHealthStateMachine extends EventEmitter {
  private _state: LibraryHealthState = 'initializing'
  private _stateSinceAt = new Date().toISOString()
  private readonly _diagnostics: LibraryDiagnosticEvent[] = []

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
    message?: string
  ): void {
    const prev = this._state
    if (prev === next) {
      if (errorCode || message) {
        this.recordDiagnostic(next, errorCode || 'STATE_EVENT', message || `Library remains ${next}`)
      }
      return
    }

    this._state = next
    this._stateSinceAt = new Date().toISOString()

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
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      state,
      errorCode,
      message: sanitizeDiagnosticMessage(message),
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
    return {
      schemaVersion: 1,
      state: this._state,
      stateSinceAt: this._stateSinceAt,
      reasonCode: latest?.errorCode ?? null,
      writeCapability: this._state === 'ready'
        ? 'full'
        : this._state === 'identity-conflict'
          ? 'partial'
          : 'none',
      diagnostics: [...this._diagnostics],
      compensation: compensationQueue.progress,
      availableActions: compensationQueue.running
        ? ['cancel-compensation']
        : this._state === 'writer-blocked' || compensationQueue.progress.pending > 0
          ? ['retry-compensation']
          : []
    }
  }

  /**
   * Reset to initializing. Used only when the Library root changes.
   */
  reset(): void {
    this._state = 'initializing'
    this._stateSinceAt = new Date().toISOString()
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
  message?: string
): void {
  healthMachine.transition(next, errorCode, message)
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
  message: string
): void {
  healthMachine.recordDiagnostic(healthMachine.state, errorCode, message)
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
  healthMachine.on('stateChanged', listener)
  return () => healthMachine.removeListener('stateChanged', listener)
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
