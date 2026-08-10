import { describe, expect, it, vi } from 'vitest'
import { LibraryRescanController } from './library-rescan-controller'

describe('LibraryRescanController', () => {
  it('does not scan while clean and coalesces a burst into one dirty scan', async () => {
    vi.useFakeTimers()
    const scan = vi.fn(async () => undefined)
    const controller = new LibraryRescanController(scan, 100)

    await vi.advanceTimersByTimeAsync(500)
    expect(scan).not.toHaveBeenCalled()
    controller.markDirty()
    controller.markDirty()
    controller.markDirty()
    await vi.advanceTimersByTimeAsync(100)
    expect(scan).toHaveBeenCalledTimes(1)
    controller.dispose()
    vi.useRealTimers()
  })

  it('runs one follow-up when a new event arrives during a scan', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const first = new Promise<void>((resolve) => { release = resolve })
    const scan = vi.fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined)
    const controller = new LibraryRescanController(scan, 50)

    controller.markDirty()
    await vi.advanceTimersByTimeAsync(50)
    controller.markDirty()
    release()
    await first
    await vi.advanceTimersByTimeAsync(50)
    expect(scan).toHaveBeenCalledTimes(2)
    controller.dispose()
    vi.useRealTimers()
  })

  it('disposes queued work and waits for an already-running scan to settle', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const active = new Promise<void>((resolve) => { release = resolve })
    const scan = vi.fn(() => active)
    const controller = new LibraryRescanController(scan, 50)

    controller.markDirty()
    await vi.advanceTimersByTimeAsync(50)
    let drained = false
    const draining = controller.disposeAndWait().then(() => { drained = true })
    controller.markDirty()
    await Promise.resolve()
    expect(drained).toBe(false)
    expect(scan).toHaveBeenCalledTimes(1)

    release()
    await draining
    await vi.advanceTimersByTimeAsync(100)
    expect(scan).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('retains dirty while paused and drains exactly once after resume', async () => {
    vi.useFakeTimers()
    const scan = vi.fn(async () => undefined)
    const controller = new LibraryRescanController(scan, 50)

    controller.pause()
    controller.markDirty()
    controller.markDirty()
    await vi.advanceTimersByTimeAsync(200)
    expect(scan).not.toHaveBeenCalled()

    controller.resume()
    await vi.advanceTimersByTimeAsync(50)
    expect(scan).toHaveBeenCalledTimes(1)
    controller.dispose()
    vi.useRealTimers()
  })

  it('coalesces events that arrive while an active scan is being paused', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const active = new Promise<void>((resolve) => { release = resolve })
    const scan = vi.fn().mockImplementationOnce(() => active).mockResolvedValue(undefined)
    const controller = new LibraryRescanController(scan, 50)

    controller.markDirty()
    await vi.advanceTimersByTimeAsync(50)
    controller.pause()
    controller.markDirty()
    controller.markDirty()
    release()
    await active
    await vi.advanceTimersByTimeAsync(200)
    expect(scan).toHaveBeenCalledTimes(1)

    controller.resume()
    await vi.advanceTimersByTimeAsync(50)
    expect(scan).toHaveBeenCalledTimes(2)
    controller.dispose()
    vi.useRealTimers()
  })
})
