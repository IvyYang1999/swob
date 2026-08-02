/** Serializes worker replacement without rejecting or bypassing queued work. */
export class WorkerRecycleGate {
  private active: Promise<void> | null = null

  wait(): Promise<void> {
    return this.active || Promise.resolve()
  }

  begin(recycle: () => Promise<void>): Promise<void> {
    if (this.active) return this.active
    let active!: Promise<void>
    active = recycle().finally(() => {
      if (this.active === active) this.active = null
    })
    this.active = active
    return active
  }

  isActive(): boolean {
    return this.active !== null
  }
}
