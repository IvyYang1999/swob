interface PendingRun<TInput, TResult> {
  input: TInput
  waiters: Array<{
    resolve: (result: TResult) => void
    reject: (error: unknown) => void
  }>
}

export interface LatestSnapshotRunnerOptions<TInput, TResult> {
  run: (input: TInput) => Promise<TResult>
  merge?: (current: TInput, incoming: TInput) => TInput
  onError?: (error: unknown) => void
}

/**
 * Runs one snapshot at a time and collapses every burst that arrives while it
 * is busy into exactly one latest pending snapshot.
 */
export class LatestSnapshotRunner<TInput, TResult> {
  private readonly runSnapshot: (input: TInput) => Promise<TResult>
  private readonly merge: (current: TInput, incoming: TInput) => TInput
  private readonly onError?: (error: unknown) => void
  private pending: PendingRun<TInput, TResult> | null = null
  private running = false
  private idleWaiters = new Set<() => void>()

  constructor(options: LatestSnapshotRunnerOptions<TInput, TResult>) {
    this.runSnapshot = options.run
    this.merge = options.merge || ((_current, incoming) => incoming)
    this.onError = options.onError
  }

  schedule(input: TInput): Promise<TResult> {
    const promise = new Promise<TResult>((resolve, reject) => {
      if (this.pending) {
        this.pending.input = this.merge(this.pending.input, input)
        this.pending.waiters.push({ resolve, reject })
      } else {
        this.pending = { input, waiters: [{ resolve, reject }] }
      }
    })
    if (!this.running) void this.drain()
    return promise
  }

  async waitForIdle(): Promise<void> {
    if (!this.running && !this.pending) return
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve))
  }

  getStats(): { running: boolean; pending: boolean; pendingWaiters: number } {
    return {
      running: this.running,
      pending: this.pending !== null,
      pendingWaiters: this.pending?.waiters.length || 0
    }
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    while (this.pending) {
      const current = this.pending
      this.pending = null
      try {
        const result = await this.runSnapshot(current.input)
        for (const waiter of current.waiters) waiter.resolve(result)
      } catch (error) {
        this.onError?.(error)
        for (const waiter of current.waiters) waiter.reject(error)
      }
    }
    this.running = false
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }
}
