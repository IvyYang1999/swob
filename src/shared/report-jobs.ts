export type ReportJobType = 'audit' | 'quick' | 'ai'

export type ReportJobState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface AuditReportJobParams {
  startDate?: string
  endDate?: string
}

export type ReportJobParams = AuditReportJobParams

export interface ReportJobProgress {
  stage: string
  current: number
  total: number
  percent: number
}

export interface ReportJobResult {
  report?: unknown
  path?: string
  sessionCount?: number
  llmUsed?: boolean
  llmError?: string
}

export interface ReportJobError {
  code: string
  message: string
  stage?: string
}

export interface ReportJobSnapshot {
  jobId: string
  type: ReportJobType
  params: ReportJobParams
  paramsHash: string
  state: ReportJobState
  progress: ReportJobProgress
  startedAt: string
  updatedAt: string
  completedAt?: string
  result?: ReportJobResult
  error?: ReportJobError
}

export interface ReportJobStartRequest {
  type: ReportJobType
  params?: ReportJobParams
  force?: boolean
}

export type ReportJobStatusRequest =
  | { jobId: string }
  | { type: ReportJobType; params?: ReportJobParams }

export type ReportJobUpdateEvent = ReportJobSnapshot
