interface UsageProjectionOptions {
  rebuild?: boolean
}

interface ProjectionWaiter<T> {
  resolve: (result: T) => void
  reject: (error: unknown) => void
}

interface DeferredSearchProjection {
  run: () => void | Promise<void>
  waiters: Array<ProjectionWaiter<void>>
}

interface DeferredUsageProjection<T> {
  rebuild: boolean
  run: (options: { rebuild: boolean }) => Promise<T>
  waiters: Array<ProjectionWaiter<T | undefined>>
}

interface SearchProjectionJob {
  kind: 'search'
  run: () => void | Promise<void>
  waiters: Array<ProjectionWaiter<void>>
}

interface UsageProjectionJob<T> {
  kind: 'usage'
  rebuild: boolean
  run: (options: { rebuild: boolean }) => Promise<T>
  waiters: Array<ProjectionWaiter<T | undefined>>
}

type ProjectionJob<T> = SearchProjectionJob | UsageProjectionJob<T>

export interface StartupProjectionGateOptions {
  /** One callback is admitted per idle turn so foreground I/O can run between projections. */
  scheduleIdle?: (run: () => void) => void
}

export interface StartupProjectionGateStats {
  running: 'search' | 'usage' | null
  queued: number
  searchFullRuns: number
  usageFullRuns: number
  maxConcurrentFullRuns: number
}

/**
 * Owns the single low-priority queue for rebuildable Search and Usage
 * projections. Reads deliberately stay outside this queue and continue using
 * the last committed durable snapshots while a newer projection is pending.
 */
export class StartupProjectionGate<T> {
  private opened = false
  private startupActive = false
  private startupFullProjectionNeeded = false
  private startupSearchRun: (() => void | Promise<void>) | null = null
  private startupUsageRun: ((options: { rebuild: boolean }) => Promise<T>) | null = null
  private readonly startupKindsRun = new Set<'search' | 'usage'>()
  private deferredSearch: DeferredSearchProjection | null = null
  private deferredUsage: DeferredUsageProjection<T> | null = null
  private readonly queue: Array<ProjectionJob<T>> = []
  private activeJob: ProjectionJob<T> | null = null
  private drainScheduled = false
  private readonly idleWaiters = new Set<() => void>()
  private readonly scheduleIdle: (run: () => void) => void
  private searchFullRuns = 0
  private usageFullRuns = 0
  private activeFullRuns = 0
  private maxConcurrentFullRuns = 0

  constructor(options: StartupProjectionGateOptions = {}) {
    this.scheduleIdle = options.scheduleIdle || ((run) => {
      const immediate = setImmediate(run)
      immediate.unref?.()
    })
  }

  /** The startup planner may upgrade skip -> run, but never downgrade it. */
  prepareStartup(fullProjectionNeeded: boolean): void {
    if (!fullProjectionNeeded || this.startupFullProjectionNeeded) return
    this.startupFullProjectionNeeded = true
    if (this.opened && this.startupActive) this.enqueueMissingStartupProjections()
  }

  scheduleSearch(run: () => void | Promise<void>): Promise<void> {
    if (!this.opened) {
      return new Promise<void>((resolve, reject) => {
        const pending = this.deferredSearch || { run, waiters: [] }
        pending.run = run
        pending.waiters.push({ resolve, reject })
        this.deferredSearch = pending
      })
    }
    if (this.startupActive) {
      if (!this.startupFullProjectionNeeded || this.startupKindsRun.has('search')) {
        return Promise.resolve()
      }
      this.startupKindsRun.add('search')
    }
    return this.enqueueSearch(run)
  }

  scheduleUsage(
    options: UsageProjectionOptions,
    run: (options: { rebuild: boolean }) => Promise<T>
  ): Promise<T | undefined> {
    if (!this.opened) {
      return new Promise<T | undefined>((resolve, reject) => {
        const pending = this.deferredUsage || { rebuild: false, run, waiters: [] }
        pending.rebuild ||= options.rebuild === true
        pending.run = run
        pending.waiters.push({ resolve, reject })
        this.deferredUsage = pending
      })
    }
    if (this.startupActive && options.rebuild !== true) {
      if (!this.startupFullProjectionNeeded || this.startupKindsRun.has('usage')) {
        return Promise.resolve(undefined)
      }
      this.startupKindsRun.add('usage')
    }
    return this.enqueueUsage(options.rebuild === true, run)
  }

  open(
    runSearch: () => void | Promise<void>,
    runUsage: (options: { rebuild: boolean }) => Promise<T>
  ): void {
    if (this.opened) return
    this.opened = true
    this.startupActive = true
    this.startupSearchRun = runSearch
    this.startupUsageRun = runUsage

    const deferredSearch = this.deferredSearch
    const deferredUsage = this.deferredUsage
    this.deferredSearch = null
    this.deferredUsage = null

    if (!this.startupFullProjectionNeeded) {
      deferredSearch?.waiters.forEach((waiter) => waiter.resolve())
      if (deferredUsage?.rebuild) {
        // A user-forced rebuild also satisfies any later startup upgrade; do
        // not enqueue a second Usage full run for the same generation.
        this.startupKindsRun.add('usage')
        this.enqueueUsageJob(true, deferredUsage.run, deferredUsage.waiters)
      } else {
        deferredUsage?.waiters.forEach((waiter) => waiter.resolve(undefined))
      }
      return
    }

    this.enqueueStartupSearch(deferredSearch?.waiters || [])
    this.enqueueStartupUsage(deferredUsage?.rebuild === true, deferredUsage?.waiters || [])
  }

  /** End startup coalescing only after the final adopted tree has queued its projections. */
  finishStartup(): void {
    this.startupActive = false
    this.startupFullProjectionNeeded = false
    this.startupSearchRun = null
    this.startupUsageRun = null
    this.startupKindsRun.clear()
  }

  reset(reason: Error): void {
    this.opened = false
    this.startupActive = false
    this.startupFullProjectionNeeded = false
    this.startupSearchRun = null
    this.startupUsageRun = null
    this.startupKindsRun.clear()

    const deferredSearch = this.deferredSearch
    const deferredUsage = this.deferredUsage
    this.deferredSearch = null
    this.deferredUsage = null
    deferredSearch?.waiters.forEach((waiter) => waiter.reject(reason))
    deferredUsage?.waiters.forEach((waiter) => waiter.reject(reason))

    const queued = this.queue.splice(0)
    for (const job of queued) this.rejectJob(job, reason)
    if (!this.activeJob) this.resolveIdleWaiters()
  }

  getStats(): StartupProjectionGateStats {
    return {
      running: this.activeJob?.kind || null,
      queued: this.queue.length,
      searchFullRuns: this.searchFullRuns,
      usageFullRuns: this.usageFullRuns,
      maxConcurrentFullRuns: this.maxConcurrentFullRuns
    }
  }

  async waitForIdle(): Promise<void> {
    if (!this.activeJob && this.queue.length === 0 && !this.drainScheduled) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  private enqueueMissingStartupProjections(): void {
    this.enqueueStartupSearch([])
    this.enqueueStartupUsage(false, [])
  }

  private enqueueStartupSearch(waiters: Array<ProjectionWaiter<void>>): void {
    const run = this.startupSearchRun
    if (!run || this.startupKindsRun.has('search')) {
      waiters.forEach((waiter) => waiter.resolve())
      return
    }
    this.startupKindsRun.add('search')
    this.enqueueSearchJob(run, waiters)
  }

  private enqueueStartupUsage(
    rebuild: boolean,
    waiters: Array<ProjectionWaiter<T | undefined>>
  ): void {
    const run = this.startupUsageRun
    if (!run || this.startupKindsRun.has('usage')) {
      waiters.forEach((waiter) => waiter.resolve(undefined))
      return
    }
    this.startupKindsRun.add('usage')
    this.enqueueUsageJob(rebuild, run, waiters)
  }

  private enqueueSearch(run: () => void | Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.enqueueSearchJob(run, [{ resolve, reject }])
    })
  }

  private enqueueSearchJob(
    run: () => void | Promise<void>,
    waiters: Array<ProjectionWaiter<void>>
  ): void {
    const queued = this.queue.find((job): job is SearchProjectionJob => job.kind === 'search')
    if (queued) {
      queued.run = run
      queued.waiters.push(...waiters)
    } else {
      this.queue.push({ kind: 'search', run, waiters })
    }
    this.requestDrain()
  }

  private enqueueUsage(
    rebuild: boolean,
    run: (options: { rebuild: boolean }) => Promise<T>
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      this.enqueueUsageJob(rebuild, run, [{ resolve, reject }])
    })
  }

  private enqueueUsageJob(
    rebuild: boolean,
    run: (options: { rebuild: boolean }) => Promise<T>,
    waiters: Array<ProjectionWaiter<T | undefined>>
  ): void {
    const queued = this.queue.find((job): job is UsageProjectionJob<T> => job.kind === 'usage')
    if (queued) {
      queued.rebuild ||= rebuild
      queued.run = run
      queued.waiters.push(...waiters)
    } else {
      this.queue.push({ kind: 'usage', rebuild, run, waiters })
    }
    this.requestDrain()
  }

  private requestDrain(): void {
    if (this.activeJob || this.drainScheduled || this.queue.length === 0) return
    this.drainScheduled = true
    this.scheduleIdle(() => { void this.drainOne() })
  }

  private async drainOne(): Promise<void> {
    this.drainScheduled = false
    if (this.activeJob) return
    const job = this.queue.shift()
    if (!job) {
      this.resolveIdleWaiters()
      return
    }
    // The queue is the authority. If this guard ever fires, fail closed instead
    // of allowing two CPU-heavy full projections to overlap.
    if (this.activeFullRuns !== 0) {
      this.rejectJob(job, new Error('Concurrent full projection rejected'))
      this.requestDrain()
      return
    }
    this.activeJob = job
    this.activeFullRuns++
    this.maxConcurrentFullRuns = Math.max(this.maxConcurrentFullRuns, this.activeFullRuns)
    if (job.kind === 'search') this.searchFullRuns++
    else this.usageFullRuns++
    try {
      if (job.kind === 'search') {
        await job.run()
        job.waiters.forEach((waiter) => waiter.resolve())
      } else {
        const result = await job.run({ rebuild: job.rebuild })
        job.waiters.forEach((waiter) => waiter.resolve(result))
      }
    } catch (error) {
      this.rejectJob(job, error)
    } finally {
      this.activeFullRuns--
      this.activeJob = null
      if (this.queue.length > 0) this.requestDrain()
      else this.resolveIdleWaiters()
    }
  }

  private rejectJob(job: ProjectionJob<T>, reason: unknown): void {
    job.waiters.forEach((waiter) => waiter.reject(reason))
  }

  private resolveIdleWaiters(): void {
    if (this.activeJob || this.queue.length > 0 || this.drainScheduled) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
