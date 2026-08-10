export class LibraryRescanController {
  private dirty = false
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private paused = false
  private idlePromise: Promise<void> | null = null
  private resolveIdle: (() => void) | null = null

  constructor(
    private readonly scan: () => Promise<void>,
    private readonly delayMs = 750
  ) {}

  markDirty(): void {
    if (this.disposed) return
    this.dirty = true
    if (!this.paused) this.schedule()
  }

  pause(): void {
    if (this.disposed) return
    this.paused = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  resume(): void {
    if (this.disposed) return
    this.paused = false
    if (this.dirty) this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.dirty = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async waitForIdle(): Promise<void> {
    await this.idlePromise
  }

  async disposeAndWait(): Promise<void> {
    this.dispose()
    await this.waitForIdle()
  }

  private schedule(): void {
    if (this.running || this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.delayMs)
  }

  private async flush(): Promise<void> {
    if (this.running || !this.dirty || this.disposed || this.paused) return
    this.dirty = false
    this.running = true
    this.idlePromise = new Promise<void>((resolve) => { this.resolveIdle = resolve })
    try {
      await this.scan()
    } finally {
      this.running = false
      this.resolveIdle?.()
      this.resolveIdle = null
      this.idlePromise = null
      if (this.dirty) this.schedule()
    }
  }
}
