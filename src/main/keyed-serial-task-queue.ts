/** Coalesces the same key while serializing different keys in arrival order. */
export class KeyedSerialTaskQueue<Key, Result> {
  private tail: Promise<void> = Promise.resolve()
  private readonly inFlight = new Map<Key, Promise<Result>>()

  run(key: Key, task: () => Promise<Result>): Promise<Result> {
    const existing = this.inFlight.get(key)
    if (existing) return existing

    const execution = this.tail.catch(() => undefined).then(task)
    this.tail = execution.then(() => undefined, () => undefined)
    this.inFlight.set(key, execution)
    void execution.finally(() => {
      if (this.inFlight.get(key) === execution) this.inFlight.delete(key)
    }).catch(() => undefined)
    return execution
  }
}
