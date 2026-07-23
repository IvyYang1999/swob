import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  ReportJobParams,
  ReportJobSnapshot,
  ReportJobType
} from '../../../../shared/report-jobs'

interface ReportJobController {
  job: ReportJobSnapshot | null
  pendingRequest: boolean
  requestError: string | null
  start: (force?: boolean) => Promise<ReportJobSnapshot | null>
  cancel: () => Promise<void>
}

/**
 * Keeps report state outside the component lifetime: status is recovered from
 * the main-process manager and live updates are filtered by the current jobId.
 */
export function useReportJob(type: ReportJobType, params: ReportJobParams): ReportJobController {
  const paramsKey = JSON.stringify(params)
  const stableParams = useMemo<ReportJobParams>(() => JSON.parse(paramsKey), [paramsKey])
  const [job, setJob] = useState<ReportJobSnapshot | null>(null)
  const [pendingRequest, setPendingRequest] = useState(false)
  const [requestError, setRequestError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setJob(null)
    setRequestError(null)
    void window.api.reportStatus({ type, params: stableParams }).then((snapshot) => {
      if (active) setJob(snapshot)
    }).catch(() => {
      if (active) setRequestError('report-status-failed')
    })
    return () => { active = false }
  }, [stableParams, type])

  useEffect(() => {
    if (!job?.jobId) return
    let active = true
    const jobId = job.jobId
    const unsubscribe = window.api.onInsightsProgress((update) => {
      if (active && update.jobId === jobId) setJob(update)
    })
    void window.api.reportSubscribe(jobId).then((snapshot) => {
      if (active && snapshot) setJob(snapshot)
    }).catch(() => {
      if (active) setRequestError('report-status-failed')
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [job?.jobId])

  const start = useCallback(async (force = false): Promise<ReportJobSnapshot | null> => {
    setPendingRequest(true)
    setRequestError(null)
    try {
      const snapshot = await window.api.reportStart({ type, params: stableParams, force })
      setJob(snapshot)
      return snapshot
    } catch {
      setRequestError('report-start-failed')
      return null
    } finally {
      setPendingRequest(false)
    }
  }, [stableParams, type])

  const cancel = useCallback(async (): Promise<void> => {
    if (!job || (job.state !== 'queued' && job.state !== 'running')) return
    setPendingRequest(true)
    setRequestError(null)
    try {
      const snapshot = await window.api.reportCancel(job.jobId)
      if (snapshot) setJob(snapshot)
    } catch {
      setRequestError('report-cancel-failed')
    } finally {
      setPendingRequest(false)
    }
  }, [job?.jobId, job?.state])

  return { job, pendingRequest, requestError, start, cancel }
}
