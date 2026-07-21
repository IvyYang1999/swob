export class LibraryRescanController {
  private dirty = false
  private running = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(
    private readonly scan: () => Promise<void>,
    private readonly delayMs = 750
  ) {}

  markDirty(): void {
    if (this.disposed) return
    this.dirty = true
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.dirty = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.running || this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, this.delayMs)
  }

  private async flush(): Promise<void> {
    if (this.running || !this.dirty || this.disposed) return
    this.dirty = false
    this.running = true
    try {
      await this.scan()
    } finally {
      this.running = false
      if (this.dirty) this.schedule()
    }
  }
}
