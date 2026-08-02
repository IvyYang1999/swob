import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import * as path from 'node:path'
import {
  initLibrary,
  scanLibrary,
  syncLibraryFromSessions,
  syncLibraryStartupChunk,
  ensureSessionInLibrary,
  updateTranscript,
  updateTranscriptFromRaw,
  syncBackup,
  setSessionTurnCount,
  withLibraryMaintenanceWriter,
  type LibraryTree,
  type LibrarySyncOutcome
} from './library-manager'
import { parseSessionFile, buildSessionSummary, resolvePhysicalSessionId } from './session-loader'
import { loadCodexRawMessages, loadCodexSessionRecordWithRaw } from './codex-loader'
import { buildCursorSessionSummary, loadCursorRawMessages } from './cursor-loader'
import { detectSessionSourceFromPath } from './session-source'
import {
  closeSearchIndex,
  indexCanonicalSession,
  synchronizeSearchSources,
  tombstoneCanonicalSession
} from './search-index'
import { closeUsageFactStore, synchronizeUsageFacts } from './usage-fact-store'
import type { Folder, SessionSummary } from './types'
import type { UsageFactSyncResult } from './analysis-contract'
import type { CanonicalRecord } from '../shared/provider-schema.generated'

export interface SearchIndexSourceDescriptor {
  filePath: string
  sessionId?: string
  source?: string
  isLibraryBackup?: boolean
  stateFilePath?: string
}

export type LibraryWorkerRequest = (
  | { type: 'shutdown' }
  | { type: 'writer-probe'; root: string }
  | { type: 'scan'; root: string; ignoreDirs?: string[] }
  | {
      type: 'sync'
      root: string
      ignoreDirs?: string[]
      sessions: SessionSummary[]
      sessionMeta: Record<string, { customTitle?: string; notes?: string }>
    }
  | {
      type: 'sync-chunk'
      root: string
      sessions: SessionSummary[]
      sessionMeta: Record<string, { customTitle?: string; notes?: string }>
    }
  | {
      type: 'session-sync'
      root: string
      filePath: string
      sessionId?: string
      source?: 'claude-code' | 'codex' | 'cursor' | 'transcript'
      maintainLibrary?: boolean
    }
  | {
      type: 'usage-facts-sync'
      root: string
      sessions: SessionSummary[]
      folders: Folder[]
      rebuild?: boolean
    }
  | { type: 'search-sources-sync'; sources: SearchIndexSourceDescriptor[]; prune: boolean }
  | { type: 'search-canonical-index'; sessionId: string; records: CanonicalRecord[]; includeThinking?: boolean }
  | { type: 'search-canonical-tombstone'; sessionRecordId: string }
) & { cancelBuffer?: SharedArrayBuffer }

export interface LibraryWorkerSessionSyncResult {
  summary: SessionSummary
  dirPath?: string
}

export interface LibraryWorkerSyncResult {
  tree: LibraryTree
  outcome: LibrarySyncOutcome
}

type LibraryWorkerResult =
  | { kind: 'shutdown' }
  | { kind: 'writer-probe' }
  | { kind: 'sync-outcome'; outcome: LibrarySyncOutcome }
  | { kind: 'tree'; tree: LibraryTree; syncOutcome?: LibrarySyncOutcome }
  | { kind: 'session-sync'; value: LibraryWorkerSessionSyncResult }
  | { kind: 'usage-facts-sync'; value: UsageFactSyncResult }
  | { kind: 'search-write' }

export interface LibraryWorkerProgress {
  current: number
  total: number
  sessionId: string
}

interface WorkerEnvelope {
  requestId: number
  request: LibraryWorkerRequest
}

type WorkerReply =
  | { requestId: number; type: 'progress'; progress: LibraryWorkerProgress }
  | { requestId: number; type: 'result'; result: LibraryWorkerResult }
  | {
      requestId: number
      type: 'error'
      error: string
      errorName?: string
      errorCode?: string
      errorStack?: string
    }

export async function runLibraryWorkerRequest(
  request: LibraryWorkerRequest,
  onProgress?: (progress: LibraryWorkerProgress) => void
): Promise<LibraryWorkerResult> {
  const cancelFlag = request.cancelBuffer ? new Int32Array(request.cancelBuffer) : null
  const shouldCancel = cancelFlag ? () => Atomics.load(cancelFlag, 0) === 1 : undefined
  throwIfWorkerCancelled(shouldCancel)
  if (request.type === 'shutdown') {
    closeUsageFactStore()
    closeSearchIndex()
    return { kind: 'shutdown' }
  }
  if (request.type === 'usage-facts-sync') {
    return {
      kind: 'usage-facts-sync',
      value: synchronizeUsageFacts(request.sessions, request.folders, {
        rebuild: request.rebuild,
        shouldCancel
      })
    }
  }
  if (request.type === 'search-sources-sync') {
    await synchronizeSearchSources(request.sources.map((source) => ({
      ...source,
      ...(source.source === 'codex'
        ? { loadRaw: () => loadCodexRawMessages(source.filePath, source.sessionId) }
        : source.source === 'cursor'
          ? { loadRaw: () => loadCursorRawMessages(source.filePath, source.sessionId) }
          : {})
    })), { prune: request.prune, shouldCancel })
    return { kind: 'search-write' }
  }
  if (request.type === 'search-canonical-index') {
    await indexCanonicalSession(request.sessionId, request.records, {
      includeThinking: request.includeThinking,
      shouldCancel
    })
    return { kind: 'search-write' }
  }
  if (request.type === 'search-canonical-tombstone') {
    await tombstoneCanonicalSession(request.sessionRecordId, { shouldCancel })
    return { kind: 'search-write' }
  }
  initLibrary(request.root, {
    readOnly: request.type === 'scan',
    ignoreDirs: request.type === 'scan' || request.type === 'sync' ? request.ignoreDirs : undefined
  })
  if (request.type === 'writer-probe') {
    await withLibraryMaintenanceWriter(async () => {})
    return { kind: 'writer-probe' }
  }
  if (request.type === 'scan') return { kind: 'tree', tree: scanLibrary() }
  if (request.type === 'sync-chunk') {
    return {
      kind: 'sync-outcome',
      outcome: await syncLibraryStartupChunk(request.sessions, request.sessionMeta, onProgress, shouldCancel)
    }
  }
  if (request.type === 'sync') {
    scanLibrary()
    const syncOutcome = await syncLibraryFromSessions(request.sessions, request.sessionMeta, onProgress, shouldCancel)
    throwIfWorkerCancelled(shouldCancel)
    return { kind: 'tree', tree: scanLibrary(), syncOutcome }
  }
  const detectedSource = request.source === 'transcript'
    ? detectSessionSourceFromPath(request.filePath)
    : request.source || detectSessionSourceFromPath(request.filePath)
  let summary: SessionSummary | null = null
  let parsedRaw: Awaited<ReturnType<typeof parseSessionFile>> | null = null
  if (detectedSource === 'codex') {
    const record = await loadCodexSessionRecordWithRaw(request.filePath)
    summary = record.summary
    parsedRaw = record.rawMessages
  } else if (detectedSource === 'cursor') {
    summary = await buildCursorSessionSummary(request.filePath)
  } else {
    parsedRaw = await parseSessionFile(request.filePath)
    const physicalSessionId = resolvePhysicalSessionId(request.filePath, parsedRaw) || request.sessionId
    summary = buildSessionSummary(request.filePath, parsedRaw, true, physicalSessionId)
  }
  if (!summary) throw new Error(`Unable to build session summary: ${request.filePath}`)
  throwIfWorkerCancelled(shouldCancel)

  let dirPath: string | undefined
  if (request.maintainLibrary !== false) {
    dirPath = await withLibraryMaintenanceWriter(async () => {
      const maintainedDir = await ensureSessionInLibrary(summary!)
      if (!summary!.id.includes(':intra-') && !summary!.id.includes(':branch-')) {
        setSessionTurnCount(maintainedDir, summary!.turnCount)
      }
      if (parsedRaw) {
        updateTranscriptFromRaw(
          summary!.sessionId,
          parsedRaw,
          detectedSource === 'codex' ? 'codex' : 'claude-code',
          request.filePath,
          undefined,
          maintainedDir
        )
      } else {
        await updateTranscript(summary!.sessionId, undefined, maintainedDir)
      }
      await syncBackup(summary!.sessionId, maintainedDir)
      return maintainedDir
    })
  }
  throwIfWorkerCancelled(shouldCancel)
  return { kind: 'session-sync', value: { summary, dirPath } }
}

function throwIfWorkerCancelled(shouldCancel?: () => boolean): void {
  if (!shouldCancel?.()) return
  const error = new Error('Library worker request cancelled')
  error.name = 'AbortError'
  throw error
}

if (!isMainThread && parentPort) {
  let requestTail: Promise<void> = Promise.resolve()
  parentPort.on('message', ({ requestId, request }: WorkerEnvelope) => {
    requestTail = requestTail.then(async () => {
      try {
        const result = await runLibraryWorkerRequest(request, (progress) => {
          parentPort!.postMessage({ requestId, type: 'progress', progress } satisfies WorkerReply)
        })
        parentPort!.postMessage({ requestId, type: 'result', result } satisfies WorkerReply)
      } catch (error) {
        const typedError = error instanceof Error ? error as Error & { code?: unknown } : null
        parentPort!.postMessage({
          requestId,
          type: 'error',
          error: typedError?.message || String(error),
          errorName: typedError?.name,
          errorCode: typeof typedError?.code === 'string' ? typedError.code : undefined,
          errorStack: process.env.SWOB_E2E_SANDBOX_ROOT ? typedError?.stack : undefined
        } satisfies WorkerReply)
      }
    })
  })
}

export class LibraryWorkerClient {
  private worker: Worker | null = null
  private closing = false
  private closePromise: Promise<void> | null = null
  private nextRequestId = 1
  private readonly drainWaiters = new Set<() => void>()
  private readonly pending = new Map<number, {
    resolve: (result: LibraryWorkerResult) => void
    reject: (error: Error) => void
    onProgress?: (progress: LibraryWorkerProgress) => void
    cancelFlag?: Int32Array
    promise?: Promise<LibraryWorkerResult>
  }>()

  constructor(private readonly workerPath = path.join(__dirname, 'library-worker.js')) {}

  scan(root: string, ignoreDirs?: string[]): Promise<LibraryTree> {
    return this.observe(this.request({ type: 'scan', root, ignoreDirs }).then((result) => {
      if (result.kind !== 'tree') throw new Error('Library worker returned an invalid scan result')
      return result.tree
    }))
  }

  probeWriter(root: string): Promise<void> {
    return this.observe(this.request({ type: 'writer-probe', root }).then((result) => {
      if (result.kind !== 'writer-probe') throw new Error('Library worker returned an invalid writer probe result')
    }))
  }

  syncChunk(
    root: string,
    sessions: SessionSummary[],
    sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
    onProgress?: (progress: LibraryWorkerProgress) => void
  ): Promise<LibrarySyncOutcome> {
    return this.observe(this.request({
      type: 'sync-chunk',
      root,
      sessions,
      sessionMeta
    }, onProgress).then((result) => {
      if (result.kind !== 'sync-outcome') throw new Error('Library worker returned an invalid sync chunk result')
      return result.outcome
    }))
  }

  sync(
    root: string,
    sessions: SessionSummary[],
    sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
    options: { ignoreDirs?: string[]; onProgress?: (progress: LibraryWorkerProgress) => void } = {}
  ): Promise<LibraryWorkerSyncResult> {
    return this.observe(this.request({
      type: 'sync',
      root,
      ignoreDirs: options.ignoreDirs,
      sessions,
      sessionMeta
    }, options.onProgress).then((result) => {
      if (result.kind !== 'tree') throw new Error('Library worker returned an invalid sync result')
      if (!result.syncOutcome) throw new Error('Library worker omitted sync outcome')
      return { tree: result.tree, outcome: result.syncOutcome }
    }))
  }

  syncSession(request: Omit<Extract<LibraryWorkerRequest, { type: 'session-sync' }>, 'type'>): Promise<LibraryWorkerSessionSyncResult> {
    return this.observe(this.request({ type: 'session-sync', ...request }).then((result) => {
      if (result.kind !== 'session-sync') throw new Error('Library worker returned an invalid session result')
      return result.value
    }))
  }

  syncUsageFacts(
    root: string,
    sessions: SessionSummary[],
    folders: Folder[],
    options: { rebuild?: boolean } = {}
  ): Promise<UsageFactSyncResult> {
    return this.observe(this.request({
      type: 'usage-facts-sync',
      root,
      sessions,
      folders,
      rebuild: options.rebuild
    }).then((result) => {
      if (result.kind !== 'usage-facts-sync') throw new Error('Library worker returned an invalid usage fact result')
      return result.value
    }))
  }

  syncSearchSources(sources: SearchIndexSourceDescriptor[], options: { prune: boolean }): Promise<void> {
    return this.observe(this.request({
      type: 'search-sources-sync',
      sources,
      prune: options.prune
    }).then((result) => {
      if (result.kind !== 'search-write') throw new Error('Library worker returned an invalid search result')
    }))
  }

  indexCanonicalSearch(
    sessionId: string,
    records: CanonicalRecord[],
    options: { includeThinking?: boolean } = {}
  ): Promise<void> {
    return this.observe(this.request({
      type: 'search-canonical-index',
      sessionId,
      records,
      includeThinking: options.includeThinking
    }).then((result) => {
      if (result.kind !== 'search-write') throw new Error('Library worker returned an invalid search result')
    }))
  }

  tombstoneCanonicalSearch(sessionRecordId: string): Promise<void> {
    return this.observe(this.request({
      type: 'search-canonical-tombstone',
      sessionRecordId
    }).then((result) => {
      if (result.kind !== 'search-write') throw new Error('Library worker returned an invalid search result')
    }))
  }

  private observe<T>(promise: Promise<T>): Promise<T> {
    // Preserve rejection for awaiting callers while preventing deliberately
    // fire-and-forget background work from becoming a process-level unhandled
    // rejection during coordinated shutdown.
    void promise.catch(() => {})
    return promise
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      // Application shutdown is stronger than an in-progress graceful
      // retirement. Upgrade it by signalling every accepted request so quit
      // is not held hostage by a large parse that no longer needs to finish.
      this.cancelPending()
      return this.closePromise
    }
    this.closing = true
    this.closePromise = this.finishClose(true)
    return this.closePromise
  }

  /**
   * Stop accepting new work, let every request already handed to this worker
   * reach its reply boundary, then shut the isolate down. This is the safe
   * recycling path: close() intentionally cancels queued work for application
   * shutdown, while retire() must never discard a sibling live sync merely
   * because another large source finished first.
   */
  async retire(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = this.finishClose(false)
    return this.closePromise
  }

  /**
   * Cooperatively cancel active and queued requests without waiting for the
   * worker to exit. Coordinators must signal this before waiting for their
   * active drain, otherwise close() cannot reach the shared cancel flag.
   */
  cancelPending(): void {
    for (const pending of this.pending.values()) {
      if (pending.cancelFlag) Atomics.store(pending.cancelFlag, 0, 1)
    }
  }

  private async finishClose(cancelPending: boolean): Promise<void> {
    const worker = this.worker
    if (!worker) return

    if (cancelPending) {
      for (const pending of this.pending.values()) {
        if (pending.cancelFlag) {
          // Some background callers intentionally do not await their work. Once
          // shutdown initiates cancellation, mark that expected rejection as
          // observed without changing the promise seen by an awaiting caller.
          if (pending.promise) void pending.promise.catch(() => {})
          Atomics.store(pending.cancelFlag, 0, 1)
        }
      }
    }

    // worker.terminate() can abort better-sqlite3 while native code is inside a
    // transaction and crash the entire Electron process. Process teardown also
    // destroys unref'ed worker isolates, so there is no safe timeout fallback:
    // in-flight native work must reach its reply boundary before termination.
    if (this.pending.size > 0) {
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          this.drainWaiters.delete(finish)
          resolve()
        }
        this.drainWaiters.add(finish)
        if (this.pending.size === 0) finish()
      })
    }

    await this.requestShutdown(worker)
    this.worker = null
    await worker.terminate()
  }

  private requestShutdown(worker: Worker): Promise<void> {
    const requestId = this.nextRequestId++
    return new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, {
        resolve: (result) => {
          if (result.kind === 'shutdown') resolve()
          else reject(new Error('Library worker returned an invalid shutdown result'))
        },
        reject
      })
      worker.postMessage({ requestId, request: { type: 'shutdown' } } satisfies WorkerEnvelope)
    })
  }

  private request(
    request: LibraryWorkerRequest,
    onProgress?: (progress: LibraryWorkerProgress) => void
  ): Promise<LibraryWorkerResult> {
    if (this.closing) return Promise.reject(new Error('Library worker is closing'))
    const worker = this.ensureWorker()
    const requestId = this.nextRequestId++
    const cancelFlag = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
    const workerRequest = { ...request, cancelBuffer: cancelFlag.buffer as SharedArrayBuffer }
    let resolveRequest!: (result: LibraryWorkerResult) => void
    let rejectRequest!: (error: Error) => void
    const promise = new Promise<LibraryWorkerResult>((resolve, reject) => {
      resolveRequest = resolve
      rejectRequest = reject
    })
    this.pending.set(requestId, {
      resolve: resolveRequest,
      reject: rejectRequest,
      onProgress,
      cancelFlag,
      promise
    })
    worker.postMessage({ requestId, request: workerRequest } satisfies WorkerEnvelope)
    return promise
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(this.workerPath)
    worker.on('message', (reply: WorkerReply) => {
      const pending = this.pending.get(reply.requestId)
      if (!pending) return
      if (reply.type === 'progress') {
        pending.onProgress?.(reply.progress)
        return
      }
      this.pending.delete(reply.requestId)
      this.notifyIfDrained()
      if (reply.type === 'result') pending.resolve(reply.result)
      else {
        const error = new Error(reply.error) as Error & { code?: string }
        if (reply.errorName) error.name = reply.errorName
        if (reply.errorCode) error.code = reply.errorCode
        if (reply.errorStack) error.stack = reply.errorStack
        pending.reject(error)
      }
    })
    worker.on('error', (error) => this.failAll(error instanceof Error ? error : new Error(String(error))))
    worker.on('exit', (code) => {
      if (this.worker === worker) this.worker = null
      if (code !== 0) this.failAll(new Error(`Library worker exited with code ${code}`))
    })
    this.worker = worker
    return worker
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    this.notifyIfDrained()
  }

  private notifyIfDrained(): void {
    if (this.pending.size !== 0) return
    for (const resolve of this.drainWaiters) resolve()
  }
}
