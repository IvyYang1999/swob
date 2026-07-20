import {
  ensureSessionResumeTarget,
  getSessionDirPath,
  getSessionResumeAvailability,
  type SessionResumeAvailability,
  type SessionResumePreparationResult
} from './library-manager'
import {
  buildForkCommand,
  buildResumeCommand,
  resolveSessionActionContext
} from './session-actions'
import type { SessionSummary } from './types'

export interface ResumeActionResult {
  ok: boolean
  sessionId: string
  reason?: string
  command?: string
}

export interface GuardedResumeOptions {
  sessionId: string
  sessions: SessionSummary[]
  permissionMode?: string
  cwd?: string
  reloadSessions?: () => Promise<SessionSummary[]>
  /** Internal action boundary: command builders/copy never enable recovery. */
  allowRecovery?: boolean
  prepareResumeTarget?: (
    sessionId: string,
    options: { allowRecovery?: boolean; requestedSessionId?: string }
  ) => Promise<SessionResumePreparationResult>
}

export interface OpenGuardedResumeOptions extends GuardedResumeOptions {
  openCommand: (command: string) => void
}

function findSessionForGuard(sessions: SessionSummary[], sessionId: string): SessionSummary | undefined {
  return sessions.find((s) => s.id === sessionId || s.sessionId === sessionId) ||
    sessions.find((s) => (s.continuationSessionIds || []).includes(sessionId))
}

function unavailableResult(sessionId: string, availability: SessionResumeAvailability): ResumeActionResult {
  return {
    ok: false,
    sessionId,
    reason: availability.reason || '此会话无法直接恢复'
  }
}

async function buildGuardedCommand(
  options: GuardedResumeOptions,
  kind: 'resume' | 'fork'
): Promise<ResumeActionResult> {
  const summary = findSessionForGuard(options.sessions, options.sessionId)
  const availability = getSessionResumeAvailability(options.sessionId, summary)
  if (!availability.canResume) return unavailableResult(options.sessionId, availability)

  const indexedSessionId = getSessionDirPath(options.sessionId)
    ? options.sessionId
    : summary?.sessionId && getSessionDirPath(summary.sessionId)
      ? summary.sessionId
      : null
  const prepared: SessionResumePreparationResult = !options.prepareResumeTarget && !indexedSessionId
    ? { ok: true, sourcePath: availability.sourcePath || null }
    : await (options.prepareResumeTarget || ensureSessionResumeTarget)(indexedSessionId || options.sessionId, {
        allowRecovery: options.allowRecovery === true,
        requestedSessionId: options.sessionId
      })
  if (!prepared.ok) {
    return { ok: false, sessionId: options.sessionId, reason: prepared.reason || '此会话无法直接恢复' }
  }
  const context = await resolveSessionActionContext(options.sessionId, options.sessions, {
    reloadSessions: options.reloadSessions,
    permissionModeFallback: options.permissionMode,
    cwdFallback: options.cwd,
    restoredSourcePath: prepared.sourcePath
  })
  const command = kind === 'resume'
    ? buildResumeCommand(
      context.sessionId,
      context.permissionMode,
      context.cwd,
      context.source,
      context.claudeConfigDir
    )
    : buildForkCommand(
      context.sessionId,
      context.permissionMode,
      context.cwd,
      context.source,
      context.claudeConfigDir
    )

  return { ok: true, sessionId: context.sessionId, command }
}

export async function buildGuardedResumeCommand(options: GuardedResumeOptions): Promise<ResumeActionResult> {
  return buildGuardedCommand(options, 'resume')
}

export async function openGuardedResumeCommand(options: OpenGuardedResumeOptions): Promise<ResumeActionResult> {
  const result = await buildGuardedCommand({ ...options, allowRecovery: true }, 'resume')
  if (result.ok && result.command) options.openCommand(result.command)
  return result
}

export async function openGuardedForkCommand(options: OpenGuardedResumeOptions): Promise<ResumeActionResult> {
  const result = await buildGuardedCommand({ ...options, allowRecovery: true }, 'fork')
  if (result.ok && result.command) options.openCommand(result.command)
  return result
}
