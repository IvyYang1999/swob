import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ClaudeResumeRecoveryFailureReason } from './resume-recovery-service'

const RECOVERY_METRICS_FILE = '.swob-recovery-attempts.jsonl'

export type RecoveryAttemptOutcome = 'source-present' | 'already-present' | 'restored' | 'failed'

export interface RecoveryAttempt {
  version: 1
  attemptId: string
  attemptedAt: string
  sessionId: string
  physicalSessionId?: string
  durationMs: number
  ok: boolean
  outcome: RecoveryAttemptOutcome
  failureCode?: ClaudeResumeRecoveryFailureReason
}

export interface RecoveryAttemptInput {
  sessionId: string
  physicalSessionId?: string
  attemptedAt: string
  durationMs: number
  result:
    | { ok: true; state: Exclude<RecoveryAttemptOutcome, 'failed'> }
    | { ok: false; reason: ClaudeResumeRecoveryFailureReason }
}

export interface RecoveryAttemptSummary {
  attempts: number
  successes: number
  failures: number
  successRate: number
  byFailureCode: Record<string, number>
}

export function getRecoveryMetricsPath(libraryRoot: string): string {
  return path.join(libraryRoot, RECOVERY_METRICS_FILE)
}

function isRecoveryAttempt(value: unknown): value is RecoveryAttempt {
  if (!value || typeof value !== 'object') return false
  const attempt = value as Partial<RecoveryAttempt>
  if (attempt.version !== 1 || typeof attempt.attemptId !== 'string' ||
      typeof attempt.attemptedAt !== 'string' || typeof attempt.sessionId !== 'string' ||
      typeof attempt.durationMs !== 'number' || !Number.isFinite(attempt.durationMs) ||
      typeof attempt.ok !== 'boolean') return false
  if (!['source-present', 'already-present', 'restored', 'failed'].includes(String(attempt.outcome))) return false
  if (attempt.ok === (attempt.outcome === 'failed')) return false
  if (!attempt.ok && typeof attempt.failureCode !== 'string') return false
  return attempt.physicalSessionId === undefined || typeof attempt.physicalSessionId === 'string'
}

/**
 * Append one privacy-minimal recovery fact. Paths and diagnostic text are
 * deliberately excluded so metrics cannot become a second transcript.
 */
export function recordRecoveryAttempt(libraryRoot: string, input: RecoveryAttemptInput): RecoveryAttempt {
  const attempt: RecoveryAttempt = {
    version: 1,
    attemptId: randomUUID(),
    attemptedAt: input.attemptedAt,
    sessionId: input.sessionId,
    ...(input.physicalSessionId ? { physicalSessionId: input.physicalSessionId } : {}),
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ok: input.result.ok,
    outcome: input.result.ok ? input.result.state : 'failed',
    ...(!input.result.ok ? { failureCode: input.result.reason } : {})
  }

  const filePath = getRecoveryMetricsPath(libraryRoot)
  try {
    const existing = fs.lstatSync(filePath)
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error('Recovery metrics target must be a regular file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
    (fs.constants.O_NOFOLLOW || 0)
  const descriptor = fs.openSync(filePath, flags, 0o600)
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('Recovery metrics target must be a regular file')
    // Tighten an existing file as well as setting the creation mode.
    fs.fchmodSync(descriptor, 0o600)
    fs.writeSync(descriptor, `${JSON.stringify(attempt)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  return attempt
}

export function readRecoveryAttempts(libraryRoot: string): RecoveryAttempt[] {
  let text: string
  let descriptor: number | undefined
  try {
    const filePath = getRecoveryMetricsPath(libraryRoot)
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    if (!fs.fstatSync(descriptor).isFile()) return []
    text = fs.readFileSync(descriptor, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP') return []
    throw error
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }

  const attempts: RecoveryAttempt[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecoveryAttempt(parsed)) attempts.push(parsed)
    } catch {
      // Append-only logs can end with a partial line after a crash. Preserve all
      // independently valid records instead of treating the whole file as lost.
    }
  }
  return attempts
}

export function summarizeRecoveryAttempts(attempts: RecoveryAttempt[]): RecoveryAttemptSummary {
  const successes = attempts.filter((attempt) => attempt.ok).length
  const failures = attempts.length - successes
  const byFailureCode: Record<string, number> = {}
  for (const attempt of attempts) {
    if (!attempt.failureCode) continue
    byFailureCode[attempt.failureCode] = (byFailureCode[attempt.failureCode] || 0) + 1
  }
  return {
    attempts: attempts.length,
    successes,
    failures,
    successRate: attempts.length > 0 ? successes / attempts.length : 0,
    byFailureCode
  }
}
