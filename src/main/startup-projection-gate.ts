interface UsageProjectionOptions {
  rebuild?: boolean
}

interface DeferredUsageProjection<T> {
  rebuild: boolean
  waiters: Array<{
    resolve: (result: T) => void
    reject: (error: unknown) => void
  }>
}

/**
 * Keeps rebuildable full projections behind the first durable startup write.
 * Reads are deliberately outside this gate and continue using the last
 * committed search/usage snapshots while new work is deferred.
 */
export class StartupProjectionGate<T> {
  private opened = false
  private searchPending = false
  private usagePending: DeferredUsageProjection<T> | null = null

  scheduleSearch(run: () => void): void {
    if (!this.opened) {
      this.searchPending = true
      return
    }
    run()
  }

  scheduleUsage(
    options: UsageProjectionOptions,
    run: (options: { rebuild: boolean }) => Promise<T>
  ): Promise<T> {
    if (this.opened) return run({ rebuild: options.rebuild === true })
    return new Promise<T>((resolve, reject) => {
      const pending = this.usagePending || { rebuild: false, waiters: [] }
      pending.rebuild ||= options.rebuild === true
      pending.waiters.push({ resolve, reject })
      this.usagePending = pending
    })
  }

  open(runSearch: () => void, runUsage: (options: { rebuild: boolean }) => Promise<T>): void {
    if (this.opened) return
    this.opened = true
    const searchPending = this.searchPending
    const usagePending = this.usagePending
    this.searchPending = false
    this.usagePending = null

    if (searchPending) runSearch()
    if (usagePending) {
      void runUsage({ rebuild: usagePending.rebuild }).then(
        (result) => usagePending.waiters.forEach((waiter) => waiter.resolve(result)),
        (error) => usagePending.waiters.forEach((waiter) => waiter.reject(error))
      )
    }
  }

  reset(reason: Error): void {
    this.opened = false
    this.searchPending = false
    const usagePending = this.usagePending
    this.usagePending = null
    usagePending?.waiters.forEach((waiter) => waiter.reject(reason))
  }
}
