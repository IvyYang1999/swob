/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReportJobSnapshot, ReportJobUpdateEvent } from '../../../../shared/report-jobs'
import { AuditReportTab } from './AuditReportTab'

vi.mock('../../store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ locale: 'zh-CN' })
}))

function runningJob(current = 1): ReportJobSnapshot {
  return {
    jobId: 'audit-job-1',
    type: 'audit',
    params: { startDate: '2026-06-23T00:00:00.000Z' },
    paramsHash: 'hash',
    state: 'running',
    progress: { stage: 'analyzing', current, total: 10, percent: current * 10 },
    startedAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z'
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolver) => { resolve = resolver })
  return { promise, resolve }
}

describe('AuditReportTab report lifecycle', () => {
  let progressListener: ((update: ReportJobUpdateEvent) => void) | null
  let unsubscribe: ReturnType<typeof vi.fn>

  beforeEach(() => {
    progressListener = null
    unsubscribe = vi.fn()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      reportStatus: vi.fn().mockResolvedValue(null),
      reportStart: vi.fn().mockResolvedValue(runningJob()),
      reportSubscribe: vi.fn().mockResolvedValue(runningJob()),
      reportCancel: vi.fn().mockResolvedValue({ ...runningJob(), state: 'cancelled' }),
      onInsightsProgress: vi.fn((listener: (update: ReportJobUpdateEvent) => void) => {
        progressListener = listener
        return unsubscribe
      })
    }
  })

  afterEach(() => cleanup())

  it('checks status on mount without automatically starting an audit', async () => {
    render(<AuditReportTab />)

    await waitFor(() => expect(window.api.reportStatus).toHaveBeenCalledTimes(1))
    expect(window.api.reportStart).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '生成审计报告' }))
    await waitFor(() => expect(window.api.reportStart).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText(/1\/10/)).toBeTruthy())
  })

  it('recovers a running job, filters progress by jobId, and removes its listener', async () => {
    vi.mocked(window.api.reportStatus).mockResolvedValue(runningJob())
    const view = render(<AuditReportTab />)

    await waitFor(() => expect(screen.getByText(/1\/10/)).toBeTruthy())
    expect(window.api.reportStart).not.toHaveBeenCalled()
    await waitFor(() => expect(progressListener).not.toBeNull())

    progressListener?.({ ...runningJob(9), jobId: 'some-other-job' })
    expect(screen.queryByText(/9\/10/)).toBeNull()
    progressListener?.(runningJob(5))
    await waitFor(() => expect(screen.getByText(/5\/10/)).toBeTruthy())

    view.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('does not let a stale subscribe response overwrite a newer terminal event', async () => {
    const subscription = deferred<ReportJobSnapshot | null>()
    vi.mocked(window.api.reportStatus).mockResolvedValue(runningJob())
    vi.mocked(window.api.reportSubscribe).mockReturnValue(subscription.promise)
    render(<AuditReportTab />)

    await waitFor(() => expect(progressListener).not.toBeNull())
    progressListener?.({
      ...runningJob(10),
      state: 'failed',
      completedAt: '2026-07-23T00:00:01.000Z',
      updatedAt: '2026-07-23T00:00:01.000Z',
      error: { code: 'terminal-race-proof', message: 'terminal-race-proof', stage: 'analyzing' }
    })
    subscription.resolve(runningJob(2))

    await waitFor(() => expect(screen.getByText(/terminal-race-proof/)).toBeTruthy())
    expect(screen.queryByText(/2\/10/)).toBeNull()
  })
})
