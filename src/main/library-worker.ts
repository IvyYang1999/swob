import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import * as path from 'node:path'
import {
  initLibrary,
  scanLibrary,
  syncLibraryFromSessions,
  ensureSessionInLibrary,
  updateTranscript,
  updateTranscriptFromRaw,
  syncBackup,
  setSessionTurnCount,
  type LibraryTree
} from './library-manager'
import { parseSessionFile, buildSessionSummary, resolvePhysicalSessionId } from './session-loader'
import { buildCodexSessionSummary } from './codex-loader'
import { buildCursorSessionSummary } from './cursor-loader'
import { detectSessionSourceFromPath } from './session-source'
import { indexParsedSearchSource, indexSearchSource } from './search-index'
import { synchronizeUsageFacts } from './usage-fact-store'
import type { Folder, SessionSummary } from './types'
import type { UsageFactSyncResult } from './analysis-contract'

export type LibraryWorkerRequest =
  | { type: 'scan'; root: string; ignoreDirs?: string[] }
  | {
      type: 'sync'
      root: string
      ignoreDirs?: string[]
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

export interface LibraryWorkerSessionSyncResult {
  summary: SessionSummary
  dirPath?: string
}

type LibraryWorkerResult =
  | { kind: 'tree'; tree: LibraryTree }
  | { kind: 'session-sync'; value: LibraryWorkerSessionSyncResult }
  | { kind: 'usage-facts-sync'; value: UsageFactSyncResult }

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
  | { requestId: number; type: 'error'; error: string }

export async function runLibraryWorkerRequest(
  request: LibraryWorkerRequest,
  onProgress?: (progress: LibraryWorkerProgress) => void
): Promise<LibraryWorkerResult> {
  initLibrary(request.root, {
    readOnly: request.type === 'scan',
    ignoreDirs: request.type === 'scan' || request.type === 'sync' ? request.ignoreDirs : undefined
  })
  if (request.type === 'scan') return { kind: 'tree', tree: scanLibrary() }
  if (request.type === 'sync') {
    scanLibrary()
    await syncLibraryFromSessions(request.sessions, request.sessionMeta, onProgress)
    return { kind: 'tree', tree: scanLibrary() }
  }
  if (request.type === 'usage-facts-sync') {
    return {
      kind: 'usage-facts-sync',
      value: synchronizeUsageFacts(request.sessions, request.folders, { rebuild: request.rebuild })
    }
  }

  const detectedSource = request.source === 'transcript'
    ? detectSessionSourceFromPath(request.filePath)
    : request.source || detectSessionSourceFromPath(request.filePath)
  let summary: SessionSummary | null = null
  let parsedRaw: Awaited<ReturnType<typeof parseSessionFile>> | null = null
  if (detectedSource === 'codex') {
    summary = await buildCodexSessionSummary(request.filePath)
  } else if (detectedSource === 'cursor') {
    summary = await buildCursorSessionSummary(request.filePath)
  } else {
    parsedRaw = await parseSessionFile(request.filePath)
    const physicalSessionId = resolvePhysicalSessionId(request.filePath, parsedRaw) || request.sessionId
    summary = buildSessionSummary(request.filePath, parsedRaw, true, physicalSessionId)
  }
  if (!summary) throw new Error(`Unable to build session summary: ${request.filePath}`)

  let dirPath: string | undefined
  if (request.maintainLibrary !== false) {
    dirPath = await ensureSessionInLibrary(summary)
    if (!summary.id.includes(':intra-') && !summary.id.includes(':branch-')) {
      setSessionTurnCount(dirPath, summary.turnCount)
    }
    if (parsedRaw) {
      updateTranscriptFromRaw(summary.sessionId, parsedRaw, 'claude-code', request.filePath)
    } else {
      await updateTranscript(summary.sessionId)
    }
    await syncBackup(summary.sessionId)
  }
  if (parsedRaw) {
    await indexParsedSearchSource({
      filePath: request.filePath,
      sessionId: summary.sessionId,
      source: 'claude-code'
    }, parsedRaw)
  } else {
    await indexSearchSource({
      filePath: request.filePath,
      sessionId: summary.sessionId,
      source: detectedSource || undefined
    })
  }
  return { kind: 'session-sync', value: { summary, dirPath } }
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
        parentPort!.postMessage({
          requestId,
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        } satisfies WorkerReply)
      }
    })
  })
}

export class LibraryWorkerClient {
  private worker: Worker | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, {
    resolve: (result: LibraryWorkerResult) => void
    reject: (error: Error) => void
    onProgress?: (progress: LibraryWorkerProgress) => void
  }>()

  scan(root: string, ignoreDirs?: string[]): Promise<LibraryTree> {
    return this.request({ type: 'scan', root, ignoreDirs }).then((result) => {
      if (result.kind !== 'tree') throw new Error('Library worker returned an invalid scan result')
      return result.tree
    })
  }

  sync(
    root: string,
    sessions: SessionSummary[],
    sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
    options: { ignoreDirs?: string[]; onProgress?: (progress: LibraryWorkerProgress) => void } = {}
  ): Promise<LibraryTree> {
    return this.request({
      type: 'sync',
      root,
      ignoreDirs: options.ignoreDirs,
      sessions,
      sessionMeta
    }, options.onProgress).then((result) => {
      if (result.kind !== 'tree') throw new Error('Library worker returned an invalid sync result')
      return result.tree
    })
  }

  syncSession(request: Omit<Extract<LibraryWorkerRequest, { type: 'session-sync' }>, 'type'>): Promise<LibraryWorkerSessionSyncResult> {
    return this.request({ type: 'session-sync', ...request }).then((result) => {
      if (result.kind !== 'session-sync') throw new Error('Library worker returned an invalid session result')
      return result.value
    })
  }

  syncUsageFacts(
    root: string,
    sessions: SessionSummary[],
    folders: Folder[],
    options: { rebuild?: boolean } = {}
  ): Promise<UsageFactSyncResult> {
    return this.request({
      type: 'usage-facts-sync',
      root,
      sessions,
      folders,
      rebuild: options.rebuild
    }).then((result) => {
      if (result.kind !== 'usage-facts-sync') throw new Error('Library worker returned an invalid usage fact result')
      return result.value
    })
  }

  close(): void {
    const worker = this.worker
    this.worker = null
    if (worker) void worker.terminate()
    for (const pending of this.pending.values()) pending.reject(new Error('Library worker closed'))
    this.pending.clear()
  }

  private request(
    request: LibraryWorkerRequest,
    onProgress?: (progress: LibraryWorkerProgress) => void
  ): Promise<LibraryWorkerResult> {
    const worker = this.ensureWorker()
    const requestId = this.nextRequestId++
    return new Promise<LibraryWorkerResult>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, onProgress })
      worker.postMessage({ requestId, request } satisfies WorkerEnvelope)
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const workerPath = path.join(__dirname, 'library-worker.js')
    const worker = new Worker(workerPath)
    worker.on('message', (reply: WorkerReply) => {
      const pending = this.pending.get(reply.requestId)
      if (!pending) return
      if (reply.type === 'progress') {
        pending.onProgress?.(reply.progress)
        return
      }
      this.pending.delete(reply.requestId)
      if (reply.type === 'result') pending.resolve(reply.result)
      else pending.reject(new Error(reply.error))
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
  }
}
