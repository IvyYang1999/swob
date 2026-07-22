import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { terminateChildProcess } from './child-process-termination'

function fakeChild(onKill: (signal: NodeJS.Signals) => void): ChildProcess {
  const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcess>
  Object.defineProperties(emitter, {
    exitCode: { value: null, writable: true },
    signalCode: { value: null, writable: true }
  })
  emitter.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    onKill((signal || 'SIGTERM') as NodeJS.Signals)
    return true
  })
  return emitter as ChildProcess
}

describe('terminateChildProcess', () => {
  it('uses SIGTERM when the child exits within the grace period', async () => {
    let child!: ChildProcess
    child = fakeChild((signal) => {
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', 0, signal))
    })
    const result = await terminateChildProcess(child, { graceMs: 20, killWaitMs: 20 })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(result).toEqual({ forced: false, exited: true })
  })

  it('escalates to SIGKILL when SIGTERM is ignored', async () => {
    let child!: ChildProcess
    child = fakeChild((signal) => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, signal))
    })
    const result = await terminateChildProcess(child, { graceMs: 5, killWaitMs: 20 })
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    expect(result).toEqual({ forced: true, exited: true })
  })
})
