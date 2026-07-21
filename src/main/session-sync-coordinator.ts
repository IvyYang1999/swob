export interface SessionSyncRequest {
  /** Physical session id whenever it is already known. */
  sessionId?: string
  /** Source path is used as a stable fallback key for newly-created sessions. */
  filePath?: string
  source?: 'claude-code' | 'codex' | 'cursor' | 'transcript'
  reason?: 'add' | 'change' | 'transcript-watcher'
}

export interface SessionSyncCoordinatorOptions {
  sync: (request: SessionSyncRequest) => Promise<void>
  quietWindowMs?: number
  concurrency?: number
  logger?: Pick<Console, 'error'>
}

interface PendingSessionSync {
  key: string
  request: SessionSyncRequest
  timer: ReturnType<typeof setTimeout> | null
  queued: boolean
  running: boolean
  rerunRequested: boolean
}

export interface SessionSyncCoordinatorStats {
  pending: number
  queued: number
  running: number
}

const DEFAULT_QUIET_WINDOW_MS = 2_000
const DEFAULT_CONCURRENCY = 2

function mergeRequest(current: SessionSyncRequest, incoming: SessionSyncRequest): SessionSyncRequest {
  return {
    ...current,
    ...incoming,
    sessionId: incoming.sessionId || current.sessionId,
    filePath: incoming.filePath || current.filePath,
    source: incoming.source || current.source,
    reason: incoming.reason || current.reason
  }
}

/**
 * Coalesces noisy file events before any expensive parse/transcript/backup work.
 * A physical session can never run twice concurrently, while unrelated sessions
 * share a deliberately small global worker pool.
 */
export class SessionSyncCoordinator {
  private readonly sync: (request: SessionSyncRequest) => Promise<void>
  private readonly quietWindowMs: number
  private readonly concurrency: number
  private readonly logger: Pick<Console, 'error'>
  private readonly entries = new Map<string, PendingSessionSync>()
  private readonly queue: string[] = []
  private readonly idleWaiters = new Set<() => void>()
  private activeCount = 0
  private stopped = false

  constructor(options: SessionSyncCoordinatorOptions) {
    this.sync = options.sync
    this.quietWindowMs = options.quietWindowMs ?? DEFAULT_QUIET_WINDOW_MS
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY)
    this.logger = options.logger || console
  }

  schedule(request: SessionSyncRequest): void {
    if (this.stopped) return
    const key = request.sessionId ? `session:${request.sessionId}` : request.filePath ? `file:${request.filePath}` : ''
    if (!key) throw new Error('SessionSyncCoordinator requires sessionId or filePath')

    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        key,
        request,
        timer: null,
        queued: false,
        running: false,
        rerunRequested: false
      }
      this.entries.set(key, entry)
    } else {
      entry.request = mergeRequest(entry.request, request)
    }

    if (entry.running) {
      entry.rerunRequested = true
      return
    }

    if (entry.queued) {
      entry.queued = false
      const queueIndex = this.queue.indexOf(key)
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1)
    }
    this.armQuietWindow(entry)
  }

  getStats(): SessionSyncCoordinatorStats {
    return {
      pending: this.entries.size,
      queued: this.queue.length,
      running: this.activeCount
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.entries.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = null
      entry.queued = false
      entry.rerunRequested = false
      if (!entry.running) this.entries.delete(entry.key)
    }
    this.queue.length = 0
    this.resolveIdleWaitersIfNeeded()
  }

  private armQuietWindow(entry: PendingSessionSync): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => {
      entry.timer = null
      if (this.stopped || entry.running || entry.queued) return
      entry.queued = true
      this.queue.push(entry.key)
      this.drain()
    }, this.quietWindowMs)
    entry.timer.unref?.()
  }

  private drain(): void {
    while (!this.stopped && this.activeCount < this.concurrency && this.queue.length > 0) {
      const key = this.queue.shift()!
      const entry = this.entries.get(key)
      if (!entry || !entry.queued || entry.running || entry.timer) continue
      entry.queued = false
      entry.running = true
      this.activeCount++
      void this.run(entry)
    }
    this.resolveIdleWaitersIfNeeded()
  }

  private async run(entry: PendingSessionSync): Promise<void> {
    const request = { ...entry.request }
    try {
      await this.sync(request)
    } catch (error) {
      this.logger.error('[session-sync] session synchronization failed:', error)
    } finally {
      entry.running = false
      this.activeCount--
      if (!this.stopped && entry.rerunRequested) {
        entry.rerunRequested = false
        this.armQuietWindow(entry)
      } else {
        this.entries.delete(entry.key)
      }
      this.drain()
    }
  }

  private isIdle(): boolean {
    return this.activeCount === 0 && this.queue.length === 0 &&
      [...this.entries.values()].every((entry) => !entry.timer && !entry.running && !entry.queued)
  }

  private resolveIdleWaitersIfNeeded(): void {
    if (!this.isIdle()) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
