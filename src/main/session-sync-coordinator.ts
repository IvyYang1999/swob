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
  latestGeneration: number
  runningGeneration: number
  completedGeneration: number
  forceThroughGeneration: number
  lastSnapshotSelection: number
}

interface SnapshotWaiter {
  targets: Map<string, number>
  resolve: () => void
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
  private readonly snapshotWaiters = new Set<SnapshotWaiter>()
  private readonly lastSnapshotSelectionByKey = new Map<string, number>()
  private nextGeneration = 1
  private nextSnapshotSelection = 1
  private deferredDrainTimer: ReturnType<typeof setTimeout> | null = null
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
    const generation = this.nextGeneration++

    let entry = this.entries.get(key)
    if (!entry) {
      entry = {
        key,
        request,
        timer: null,
        queued: false,
        running: false,
        rerunRequested: false,
        latestGeneration: generation,
        runningGeneration: 0,
        completedGeneration: 0,
        forceThroughGeneration: 0,
        lastSnapshotSelection: this.lastSnapshotSelectionByKey.get(key) || 0
      }
      this.entries.set(key, entry)
    } else {
      entry.request = mergeRequest(entry.request, request)
      entry.latestGeneration = generation
    }

    if (entry.running) {
      entry.rerunRequested = true
      return
    }

    if (entry.queued) {
      if (entry.forceThroughGeneration > entry.completedGeneration) return
      entry.queued = false
      this.removeFromQueue(key)
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

  /**
   * Force a bounded, round-robin selection of pending keys through the sync
   * boundary, processing each selected key's newest generation. Events after
   * the cutoff remain queued, so neither startup nor a quieter live key can be
   * starved by one continuously active transcript.
   */
  async flushPendingSnapshot(options: { maxEntries?: number } = {}): Promise<number> {
    if (this.stopped) return 0
    const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 1))
    const pending = [...this.entries.values()]
      .filter((entry) => entry.latestGeneration > entry.completedGeneration)
    const running = pending.filter((entry) => entry.running)
    const selected = [
      ...running,
      ...pending
        .filter((entry) => !entry.running)
        .sort((left, right) =>
          left.lastSnapshotSelection - right.lastSnapshotSelection ||
          right.latestGeneration - left.latestGeneration)
        .slice(0, maxEntries)
    ]
    if (selected.length === 0) return 0

    const waiter: SnapshotWaiter = {
      targets: new Map(selected.map((entry) => [entry.key, entry.latestGeneration])),
      resolve: () => {}
    }
    const completion = new Promise<void>((resolve) => { waiter.resolve = resolve })
    this.snapshotWaiters.add(waiter)
    for (const entry of selected) {
      entry.lastSnapshotSelection = this.nextSnapshotSelection++
      this.lastSnapshotSelectionByKey.set(entry.key, entry.lastSnapshotSelection)
      this.forceThrough(entry, entry.latestGeneration)
    }
    this.drain()
    this.resolveSnapshotWaiters()
    await completion
    return selected.length
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
    if (this.deferredDrainTimer) clearTimeout(this.deferredDrainTimer)
    this.deferredDrainTimer = null
    for (const waiter of this.snapshotWaiters) waiter.resolve()
    this.snapshotWaiters.clear()
    this.lastSnapshotSelectionByKey.clear()
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

  private forceThrough(entry: PendingSessionSync, generation: number): void {
    entry.forceThroughGeneration = Math.max(entry.forceThroughGeneration, generation)
    if (entry.running) {
      if (entry.runningGeneration < entry.forceThroughGeneration) entry.rerunRequested = true
      return
    }
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    if (!entry.queued) {
      entry.queued = true
      this.queue.push(entry.key)
    }
  }

  private removeFromQueue(key: string): void {
    const queueIndex = this.queue.indexOf(key)
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1)
  }

  private drain(): void {
    while (!this.stopped && this.activeCount < this.concurrency && this.queue.length > 0) {
      const queueIndex = this.snapshotWaiters.size > 0
        ? this.queue.findIndex((key) => {
            const entry = this.entries.get(key)
            return Boolean(entry && entry.forceThroughGeneration > entry.completedGeneration)
          })
        : 0
      if (queueIndex < 0) break
      const [key] = this.queue.splice(queueIndex, 1)
      const entry = this.entries.get(key)
      if (!entry || !entry.queued || entry.running || entry.timer) continue
      entry.queued = false
      entry.running = true
      entry.runningGeneration = entry.latestGeneration
      this.activeCount++
      void this.run(entry)
    }
    this.resolveIdleWaitersIfNeeded()
  }

  private async run(entry: PendingSessionSync): Promise<void> {
    const request = { ...entry.request }
    const runningGeneration = entry.runningGeneration
    try {
      await this.sync(request)
    } catch (error) {
      if (!(this.stopped && error instanceof Error && error.name === 'AbortError')) {
        this.logger.error('[session-sync] session synchronization failed:', error)
      }
    } finally {
      entry.running = false
      entry.runningGeneration = 0
      entry.completedGeneration = Math.max(entry.completedGeneration, runningGeneration)
      this.activeCount--
      const hadSnapshotWaiters = this.snapshotWaiters.size > 0
      this.resolveSnapshotWaiters()
      if (!this.stopped && entry.forceThroughGeneration > entry.completedGeneration) {
        entry.rerunRequested = false
        this.forceThrough(entry, entry.forceThroughGeneration)
      } else if (!this.stopped && entry.rerunRequested) {
        entry.forceThroughGeneration = 0
        entry.rerunRequested = false
        this.armQuietWindow(entry)
      } else {
        entry.forceThroughGeneration = 0
        this.entries.delete(entry.key)
      }
      if (hadSnapshotWaiters && this.snapshotWaiters.size === 0) this.deferNormalDrain()
      else this.drain()
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

  private resolveSnapshotWaiters(): void {
    for (const waiter of this.snapshotWaiters) {
      for (const [key, generation] of waiter.targets) {
        const entry = this.entries.get(key)
        if (entry && entry.completedGeneration >= generation) waiter.targets.delete(key)
      }
      if (waiter.targets.size > 0) continue
      this.snapshotWaiters.delete(waiter)
      waiter.resolve()
    }
  }

  private deferNormalDrain(): void {
    if (this.stopped || this.deferredDrainTimer) return
    this.deferredDrainTimer = setTimeout(() => {
      this.deferredDrainTimer = null
      this.drain()
    }, 0)
    this.deferredDrainTimer.unref?.()
  }
}
