import type { LibraryWorkerClient } from './library-worker'
import { isMainThread } from 'node:worker_threads'
import * as fs from 'node:fs'
import type { CanonicalRecord, SessionRecord } from '../shared/provider-schema.generated'
import {
  closeSearchIndex,
  indexCanonicalSession,
  synchronizeSearchSources,
  tombstoneCanonicalSession,
  type SearchIndexSource
} from './search-index'

export interface SearchIndexWritePort {
  syncSearchSources(sources: SearchIndexSource[], options: { prune: boolean }): Promise<void>
  indexCanonicalSearch(
    sessionId: string,
    records: CanonicalRecord[],
    options?: { includeThinking?: boolean }
  ): Promise<void>
  tombstoneCanonicalSearch(sessionRecordId: string): Promise<void>
  close(): Promise<void>
}

interface SearchIndexSourceDescriptor {
  filePath: string
  sessionId?: string
  source?: string
  isLibraryBackup?: boolean
  stateFilePath?: string
}

interface CanonicalIndexIntent {
  kind: 'index'
  sessionId: string
  records: CanonicalRecord[]
  includeThinking?: boolean
}

interface CanonicalTombstoneIntent {
  kind: 'tombstone'
  sessionRecordId: string
}

type CanonicalIntent = CanonicalIndexIntent | CanonicalTombstoneIntent

interface Waiter {
  resolve: () => void
  reject: (error: unknown) => void
}

interface PendingBatch {
  legacy: Map<string, SearchIndexSource>
  pruneLegacy: boolean
  canonical: Map<string, CanonicalIntent>
  waiters: Waiter[]
}

export interface SearchIndexWriteCoordinatorOptions {
  maxBusyAttempts?: number
  busyRetryDelaysMs?: number[]
  delay?: (milliseconds: number) => Promise<void>
  onError?: (error: unknown, stats: SearchIndexWriteStats) => void
}

export interface SearchIndexWriteStats {
  running: boolean
  pendingLegacy: number
  pendingCanonical: number
  exhausted: boolean
  busyAttempts: number
}

// Large JSONL parsing leaves a correspondingly large V8 isolate reservation.
// Recycling releases the isolate's reachable heap; native allocators may keep
// their process RSS high-water mark, so this is lifecycle hygiene rather than
// a claim that the OS immediately reclaims every byte.
export const LARGE_SEARCH_WORKER_RECYCLE_BYTES = 32 * 1024 * 1024

function emptyBatch(): PendingBatch {
  return {
    legacy: new Map(),
    pruneLegacy: false,
    canonical: new Map(),
    waiters: []
  }
}

function mergeBatch(older: PendingBatch, newer: PendingBatch): PendingBatch {
  const legacy = newer.pruneLegacy
    ? new Map(newer.legacy)
    : new Map([...older.legacy, ...newer.legacy])
  return {
    legacy,
    pruneLegacy: older.pruneLegacy || newer.pruneLegacy,
    canonical: new Map([...older.canonical, ...newer.canonical]),
    waiters: [...older.waiters, ...newer.waiters]
  }
}

function isSqliteBusy(error: unknown): boolean {
  const typed = error as { code?: unknown; message?: unknown } | null
  return typed?.code === 'SQLITE_BUSY' ||
    (typeof typed?.message === 'string' && /database is (?:locked|busy)/i.test(typed.message))
}

function canonicalIntentKey(records: CanonicalRecord[]): string {
  const session = records.find((record): record is SessionRecord => record.recordType === 'session')
  if (!session) throw new Error('canonical-search-requires-one-session-record')
  return session.id
}

/**
 * The only production write queue for search.db. Library projection commits do
 * not await it; this queue is an independently retryable, reconstructable
 * projection boundary.
 */
export class SearchIndexWriteCoordinator {
  private pending: PendingBatch | null = null
  private running = false
  private stoppedError: unknown = null
  private exhausted = false
  private busyAttempts = 0
  private readonly idleWaiters = new Set<() => void>()
  private readonly maxBusyAttempts: number
  private readonly busyRetryDelaysMs: number[]
  private readonly delay: (milliseconds: number) => Promise<void>
  private readonly onError?: (error: unknown, stats: SearchIndexWriteStats) => void

  constructor(
    private readonly writer: SearchIndexWritePort,
    options: SearchIndexWriteCoordinatorOptions = {}
  ) {
    this.maxBusyAttempts = Math.max(1, options.maxBusyAttempts ?? 5)
    this.busyRetryDelaysMs = options.busyRetryDelaysMs || [50, 150, 500, 1_000]
    this.delay = options.delay || ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds)
    }))
    this.onError = options.onError
  }

  scheduleLegacySource(source: SearchIndexSource): Promise<void> {
    const batch = emptyBatch()
    batch.legacy.set(source.filePath, source)
    return this.schedule(batch)
  }

  scheduleLegacySnapshot(sources: SearchIndexSource[]): Promise<void> {
    const batch = emptyBatch()
    batch.pruneLegacy = true
    for (const source of sources) batch.legacy.set(source.filePath, source)
    return this.schedule(batch)
  }

  scheduleCanonicalIndex(
    sessionId: string,
    records: CanonicalRecord[],
    options: { includeThinking?: boolean } = {}
  ): Promise<void> {
    const batch = emptyBatch()
    batch.canonical.set(canonicalIntentKey(records), {
      kind: 'index',
      sessionId,
      records,
      includeThinking: options.includeThinking
    })
    return this.schedule(batch)
  }

  scheduleCanonicalTombstone(sessionRecordId: string): Promise<void> {
    const batch = emptyBatch()
    batch.canonical.set(sessionRecordId, { kind: 'tombstone', sessionRecordId })
    return this.schedule(batch)
  }

  /** Explicit query/warmup recovery hook for a batch retained after retry exhaustion. */
  retryPending(): Promise<void> {
    if (this.stoppedError) return Promise.reject(this.stoppedError)
    if (!this.pending) return this.running ? this.waitForIdle() : Promise.resolve()
    this.exhausted = false
    return new Promise<void>((resolve, reject) => {
      this.pending!.waiters.push({ resolve, reject })
      if (!this.running) void this.drain()
    })
  }

  getStats(): SearchIndexWriteStats {
    return {
      running: this.running,
      pendingLegacy: this.pending?.legacy.size || 0,
      pendingCanonical: this.pending?.canonical.size || 0,
      exhausted: this.exhausted,
      busyAttempts: this.busyAttempts
    }
  }

  async close(error: unknown = new Error('Search index writer stopped')): Promise<void> {
    if (!this.stoppedError) {
      this.stoppedError = error
      const pending = this.pending
      this.pending = null
      if (pending) for (const waiter of pending.waiters) waiter.reject(error)
    }
    await this.waitForIdle()
    await this.writer.close()
  }

  private schedule(batch: PendingBatch): Promise<void> {
    if (this.stoppedError) return Promise.reject(this.stoppedError)
    this.exhausted = false
    const promise = new Promise<void>((resolve, reject) => batch.waiters.push({ resolve, reject }))
    this.pending = this.pending ? mergeBatch(this.pending, batch) : batch
    if (!this.running) void this.drain()
    return promise
  }

  private async drain(): Promise<void> {
    if (this.running || this.stoppedError) return
    this.running = true
    try {
      while (this.pending && !this.stoppedError) {
        const current = this.pending
        this.pending = null
        let failure: unknown = null
        for (let attempt = 1; attempt <= this.maxBusyAttempts; attempt++) {
          try {
            await this.execute(current)
            failure = null
            break
          } catch (error) {
            failure = error
            if (!isSqliteBusy(error) || attempt >= this.maxBusyAttempts || this.stoppedError) break
            this.busyAttempts++
            const delayIndex = Math.min(attempt - 1, this.busyRetryDelaysMs.length - 1)
            await this.delay(this.busyRetryDelaysMs[Math.max(0, delayIndex)] || 0)
          }
        }
        if (!failure) {
          for (const waiter of current.waiters) waiter.resolve()
          continue
        }

        for (const waiter of current.waiters) waiter.reject(failure)
        if (!isSqliteBusy(failure)) {
          this.onError?.(failure, this.getStats())
          continue
        }

        const retained = { ...current, waiters: [] }
        const combined = this.pending ? mergeBatch(retained, this.pending) : retained
        // Work that arrived during the retry cycle is retained too, but its
        // callers must receive the bounded failure instead of hanging forever.
        for (const waiter of combined.waiters) waiter.reject(failure)
        this.pending = { ...combined, waiters: [] }
        this.exhausted = true
        this.onError?.(failure, this.getStats())
        break // bounded: retain evidence, never spin forever
      }
    } finally {
      this.running = false
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
    }
  }

  private async execute(batch: PendingBatch): Promise<void> {
    if (batch.pruneLegacy || batch.legacy.size > 0) {
      await this.writer.syncSearchSources([...batch.legacy.values()], { prune: batch.pruneLegacy })
    }
    for (const intent of batch.canonical.values()) {
      if (intent.kind === 'index') {
        await this.writer.indexCanonicalSearch(intent.sessionId, intent.records, {
          includeThinking: intent.includeThinking
        })
      } else {
        await this.writer.tombstoneCanonicalSearch(intent.sessionRecordId)
      }
    }
  }

  private async waitForIdle(): Promise<void> {
    if (!this.running) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }
}

let defaultCoordinator: SearchIndexWriteCoordinator | null = null
let defaultCoordinatorClosePromise: Promise<void> | null = null

export class WorkerSearchIndexWritePort implements SearchIndexWritePort {
  private workerPromise: Promise<LibraryWorkerClient> | null = null

  constructor(private readonly workerPath?: string) {}

  async syncSearchSources(sources: SearchIndexSource[], options: { prune: boolean }): Promise<void> {
    const descriptors: SearchIndexSourceDescriptor[] = sources.map((source) => ({
      filePath: source.filePath,
      sessionId: source.sessionId,
      source: source.source,
      isLibraryBackup: source.isLibraryBackup,
      stateFilePath: source.stateFilePath
    }))
    const recycleAfter = descriptors.some((source) => {
      try {
        return !source.stateFilePath && fs.statSync(source.filePath).size >= LARGE_SEARCH_WORKER_RECYCLE_BYTES
      } catch {
        return false
      }
    })
    try {
      await (await this.worker()).syncSearchSources(descriptors, options)
    } finally {
      if (recycleAfter) await this.recycleWorker()
    }
  }

  indexCanonicalSearch(
    sessionId: string,
    records: CanonicalRecord[],
    options: { includeThinking?: boolean } = {}
  ): Promise<void> {
    return this.worker().then((worker) => worker.indexCanonicalSearch(sessionId, records, options))
  }

  tombstoneCanonicalSearch(sessionRecordId: string): Promise<void> {
    return this.worker().then((worker) => worker.tombstoneCanonicalSearch(sessionRecordId))
  }

  async close(): Promise<void> {
    const current = this.workerPromise
    if (!current) return
    await (await current).close()
    if (this.workerPromise === current) this.workerPromise = null
  }

  private async recycleWorker(): Promise<void> {
    const previous = this.workerPromise
    if (!previous) return
    await (await previous).close()
    if (this.workerPromise === previous) this.workerPromise = null
  }

  private worker(): Promise<LibraryWorkerClient> {
    return this.workerPromise || (this.workerPromise = import('./library-worker').then(
      ({ LibraryWorkerClient: Client }) => new Client(this.workerPath)
    ))
  }
}

class InProcessSearchIndexWritePort implements SearchIndexWritePort {
  syncSearchSources(sources: SearchIndexSource[], options: { prune: boolean }): Promise<void> {
    return synchronizeSearchSources(sources, options)
  }

  indexCanonicalSearch(
    sessionId: string,
    records: CanonicalRecord[],
    options: { includeThinking?: boolean } = {}
  ): Promise<void> {
    return indexCanonicalSession(sessionId, records, options)
  }

  tombstoneCanonicalSearch(sessionRecordId: string): Promise<void> {
    return tombstoneCanonicalSession(sessionRecordId)
  }

  close(): Promise<void> {
    closeSearchIndex()
    return Promise.resolve()
  }
}

export function getSearchIndexWriteCoordinator(): SearchIndexWriteCoordinator {
  const useDedicatedWorker = process.env.NODE_ENV !== 'test' &&
    Boolean(process.versions.electron) && isMainThread
  return defaultCoordinator || (defaultCoordinator = new SearchIndexWriteCoordinator(
    useDedicatedWorker ? new WorkerSearchIndexWritePort() : new InProcessSearchIndexWritePort(),
    {
      // Electron owns the long-lived retry queue. A one-shot CLI process keeps
      // its historical single busy_timeout and returns a stable retryable
      // error instead of extending command latency across five timeouts.
      maxBusyAttempts: useDedicatedWorker ? 5 : 1,
      onError: useDedicatedWorker
        ? (error, stats) => {
            console.error('[search-index] write projection retained after failure:', error, stats)
          }
        : undefined
    }
  ))
}

export async function closeSearchIndexWriteCoordinator(error?: unknown): Promise<void> {
  if (defaultCoordinatorClosePromise) return defaultCoordinatorClosePromise
  const current = defaultCoordinator
  if (!current) return
  // Keep the stopped coordinator addressable while its worker drains. Any
  // concurrent producer receives a deterministic rejection instead of
  // creating a second writer before the old connection has closed.
  let closing!: Promise<void>
  closing = current.close(error).then(() => {
    if (defaultCoordinator === current) defaultCoordinator = null
  }).finally(() => {
    // On close failure retain the stopped coordinator. Fail closed until
    // restart rather than risk overlapping an ambiguously-live old worker.
    if (defaultCoordinatorClosePromise === closing) defaultCoordinatorClosePromise = null
  })
  defaultCoordinatorClosePromise = closing
  await closing
}

export function setSearchIndexWriteCoordinatorForTest(
  coordinator: SearchIndexWriteCoordinator | null
): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('test-only search coordinator override')
  defaultCoordinator = coordinator
  defaultCoordinatorClosePromise = null
}
