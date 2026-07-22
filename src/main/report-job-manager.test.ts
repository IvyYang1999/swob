import { describe, expect, it, vi } from 'vitest'
import { ReportJobManager } from './report-job-manager'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('ReportJobManager', () => {
  it('single-flights twenty starts with identical parameters', () => {
    const gate = deferred<{ report: { ok: boolean } }>()
    const runner = vi.fn(() => gate.promise)
    const manager = new ReportJobManager({ createId: () => 'audit-1' })

    const jobs = Array.from({ length: 20 }, () => manager.start({
      type: 'audit',
      params: { startDate: '2026-07-01T00:00:00.000Z' }
    }, runner))

    expect(new Set(jobs.map((job) => job.jobId))).toEqual(new Set(['audit-1']))
    expect(runner).toHaveBeenCalledTimes(1)
    expect(manager.stats()).toMatchObject({ jobs: 1, active: 1, queued: 0 })
  })

  it('runs one audit and one html report concurrently but serializes each lane', async () => {
    const auditOne = deferred<{ report: { id: number } }>()
    const auditTwo = deferred<{ report: { id: number } }>()
    const ai = deferred<{ path: string }>()
    const ids = ['audit-1', 'audit-2', 'ai-1']
    const manager = new ReportJobManager({ createId: () => ids.shift()! })
    const first = manager.start({ type: 'audit', params: { startDate: 'one' } }, () => auditOne.promise)
    const second = manager.start({ type: 'audit', params: { startDate: 'two' } }, () => auditTwo.promise)
    const third = manager.start({ type: 'ai' }, () => ai.promise)

    expect(manager.status({ jobId: first.jobId })?.state).toBe('running')
    expect(manager.status({ jobId: second.jobId })?.state).toBe('queued')
    expect(manager.status({ jobId: third.jobId })?.state).toBe('running')
    expect(manager.stats()).toMatchObject({ active: 2, queued: 1 })

    auditOne.resolve({ report: { id: 1 } })
    await vi.waitFor(() => expect(manager.status({ jobId: second.jobId })?.state).toBe('running'))
    auditTwo.resolve({ report: { id: 2 } })
    ai.resolve({ path: '/tmp/report.html' })
    await vi.waitFor(() => expect(manager.stats().active).toBe(0))
  })

  it('recovers status across subscribers and isolates progress by job id', async () => {
    const updates: string[] = []
    const manager = new ReportJobManager({ createId: () => 'quick-1' })
    manager.onUpdate((job) => updates.push(`${job.jobId}:${job.progress.stage}`))
    const gate = deferred<{ path: string }>()
    const job = manager.start({ type: 'quick' }, async ({ progress }) => {
      progress('analyzing', 5, 10)
      return gate.promise
    })

    await vi.waitFor(() => expect(manager.subscribe(job.jobId)?.progress.percent).toBe(50))
    expect(updates.every((update) => update.startsWith('quick-1:'))).toBe(true)
    expect(manager.subscribe(job.jobId)).toEqual(manager.status({ jobId: job.jobId }))
    gate.resolve({ path: '/tmp/report.html' })
    await vi.waitFor(() => expect(manager.status({ jobId: job.jobId })?.state).toBe('completed'))
  })

  it('aborts a running job and marks it cancelled', async () => {
    const ids = ['ai-1', 'ai-2']
    const manager = new ReportJobManager({ createId: () => ids.shift()! })
    const job = manager.start({ type: 'ai' }, ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))

    expect(manager.cancel(job.jobId)?.state).toBe('cancelled')
    await vi.waitFor(() => expect(manager.stats().active).toBe(0))
    expect(manager.status({ jobId: job.jobId })?.state).toBe('cancelled')

    const retry = manager.start({ type: 'ai' }, async () => ({ path: '/tmp/retry.html' }))
    expect(retry.jobId).toBe('ai-2')
  })
})
