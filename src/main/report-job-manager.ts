import { createHash, randomUUID } from 'node:crypto'
import type {
  ReportJobError,
  ReportJobParams,
  ReportJobProgress,
  ReportJobResult,
  ReportJobSnapshot,
  ReportJobStartRequest,
  ReportJobStatusRequest,
  ReportJobType
} from '../shared/report-jobs'

export interface ReportJobContext {
  jobId: string
  signal: AbortSignal
  progress: (stage: string, current: number, total: number) => void
}

export type ReportJobRunner = (context: ReportJobContext) => Promise<ReportJobResult>

interface MutableReportJob extends ReportJobSnapshot {
  controller: AbortController
  runner: ReportJobRunner
  lane: 'audit' | 'html'
}

interface ReportJobManagerOptions {
  maxConcurrent?: number
  cacheTtlMs?: number
  now?: () => number
  createId?: () => string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)])
  )
}

export function hashReportJobParams(type: ReportJobType, params: ReportJobParams = {}): string {
  return createHash('sha256')
    .update(JSON.stringify({ type, params: stableValue(params) }))
    .digest('hex')
    .slice(0, 16)
}

function snapshot(job: MutableReportJob): ReportJobSnapshot {
  const {
    controller: _controller,
    runner: _runner,
    lane: _lane,
    ...serializable
  } = job
  return structuredClone(serializable)
}

function errorDetails(error: unknown, stage?: string): ReportJobError {
  const typed = error instanceof Error ? error as Error & { code?: unknown } : null
  return {
    code: typeof typed?.code === 'string' ? typed.code : 'report-failed',
    message: typed?.message || String(error),
    ...(stage ? { stage } : {})
  }
}

function laneFor(type: ReportJobType): 'audit' | 'html' {
  return type === 'audit' ? 'audit' : 'html'
}

function isTerminal(state: ReportJobSnapshot['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}

export class ReportJobManager {
  private readonly maxConcurrent: number
  private readonly cacheTtlMs: number
  private readonly now: () => number
  private readonly createId: () => string
  private readonly jobs = new Map<string, MutableReportJob>()
  private readonly jobIdByKey = new Map<string, string>()
  private readonly queue: string[] = []
  private readonly activeLanes = new Set<'audit' | 'html'>()
  private readonly listeners = new Set<(job: ReportJobSnapshot) => void>()
  private activeCount = 0

  constructor(options: ReportJobManagerOptions = {}) {
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2)
    this.cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5 * 60_000)
    this.now = options.now || Date.now
    this.createId = options.createId || randomUUID
  }

  onUpdate(listener: (job: ReportJobSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(request: ReportJobStartRequest, runner: ReportJobRunner): ReportJobSnapshot {
    this.pruneExpired()
    const params = structuredClone(request.params || {})
    const paramsHash = hashReportJobParams(request.type, params)
    const key = `${request.type}:${paramsHash}`
    const existingId = this.jobIdByKey.get(key)
    const existing = existingId ? this.jobs.get(existingId) : undefined
    if (existing && (!isTerminal(existing.state) ||
      (existing.state === 'completed' && !request.force && this.isFresh(existing)))) {
      return snapshot(existing)
    }

    const timestamp = new Date(this.now()).toISOString()
    const job: MutableReportJob = {
      jobId: this.createId(),
      type: request.type,
      params,
      paramsHash,
      state: 'queued',
      progress: { stage: 'queued', current: 0, total: 1, percent: 0 },
      startedAt: timestamp,
      updatedAt: timestamp,
      controller: new AbortController(),
      runner,
      lane: laneFor(request.type)
    }
    this.jobs.set(job.jobId, job)
    this.jobIdByKey.set(key, job.jobId)
    this.queue.push(job.jobId)
    this.emit(job)
    this.drain()
    return snapshot(job)
  }

  status(request: ReportJobStatusRequest): ReportJobSnapshot | null {
    this.pruneExpired()
    if ('jobId' in request) {
      const job = this.jobs.get(request.jobId)
      return job ? snapshot(job) : null
    }
    const params = request.params || {}
    const paramsHash = hashReportJobParams(request.type, params)
    const jobId = this.jobIdByKey.get(`${request.type}:${paramsHash}`)
    const job = jobId ? this.jobs.get(jobId) : undefined
    return job ? snapshot(job) : null
  }

  subscribe(jobId: string): ReportJobSnapshot | null {
    const job = this.jobs.get(jobId)
    return job ? snapshot(job) : null
  }

  cancel(jobId: string): ReportJobSnapshot | null {
    const job = this.jobs.get(jobId)
    if (!job || isTerminal(job.state)) return job ? snapshot(job) : null
    job.controller.abort()
    if (job.state === 'queued') {
      const index = this.queue.indexOf(jobId)
      if (index >= 0) this.queue.splice(index, 1)
      this.finish(job, 'cancelled')
      this.drain()
    } else {
      this.finish(job, 'cancelled')
    }
    return snapshot(job)
  }

  stats(): { jobs: number; active: number; queued: number } {
    return { jobs: this.jobs.size, active: this.activeCount, queued: this.queue.length }
  }

  private isFresh(job: MutableReportJob): boolean {
    const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : 0
    return completedAt > 0 && this.now() - completedAt <= this.cacheTtlMs
  }

  private pruneExpired(): void {
    for (const [jobId, job] of this.jobs) {
      if (!isTerminal(job.state) || this.isFresh(job)) continue
      this.jobs.delete(jobId)
      const key = `${job.type}:${job.paramsHash}`
      if (this.jobIdByKey.get(key) === jobId) this.jobIdByKey.delete(key)
    }
  }

  private drain(): void {
    if (this.activeCount >= this.maxConcurrent) return
    for (let index = 0; index < this.queue.length && this.activeCount < this.maxConcurrent;) {
      const jobId = this.queue[index]
      const job = this.jobs.get(jobId)
      if (!job || job.state !== 'queued') {
        this.queue.splice(index, 1)
        continue
      }
      if (this.activeLanes.has(job.lane)) {
        index++
        continue
      }
      this.queue.splice(index, 1)
      this.run(job)
    }
  }

  private run(job: MutableReportJob): void {
    job.state = 'running'
    job.progress = { stage: 'starting', current: 0, total: 1, percent: 0 }
    job.updatedAt = new Date(this.now()).toISOString()
    this.activeCount++
    this.activeLanes.add(job.lane)
    this.emit(job)

    void job.runner({
      jobId: job.jobId,
      signal: job.controller.signal,
      progress: (stage, current, total) => {
        if (job.state !== 'running') return
        const safeTotal = Math.max(1, total)
        const safeCurrent = Math.max(0, Math.min(current, safeTotal))
        job.progress = {
          stage,
          current: safeCurrent,
          total: safeTotal,
          percent: Math.min(100, (safeCurrent / safeTotal) * 100)
        }
        job.updatedAt = new Date(this.now()).toISOString()
        this.emit(job)
      }
    }).then((result) => {
      if (job.state === 'cancelled' || job.controller.signal.aborted) return
      job.result = result
      this.finish(job, 'completed')
    }).catch((error) => {
      if (job.state === 'cancelled' || job.controller.signal.aborted) {
        if (job.state !== 'cancelled') this.finish(job, 'cancelled')
        return
      }
      job.error = errorDetails(error, job.progress.stage)
      this.finish(job, 'failed')
    }).finally(() => {
      this.activeCount--
      this.activeLanes.delete(job.lane)
      this.drain()
    })
  }

  private finish(job: MutableReportJob, state: 'completed' | 'failed' | 'cancelled'): void {
    const timestamp = new Date(this.now()).toISOString()
    job.state = state
    job.updatedAt = timestamp
    job.completedAt = timestamp
    if (state === 'completed') {
      job.progress = { ...job.progress, current: job.progress.total, percent: 100 }
    }
    this.emit(job)
  }

  private emit(job: MutableReportJob): void {
    const value = snapshot(job)
    for (const listener of this.listeners) listener(value)
  }
}
