import { getSessionDirPath } from '../main/library-manager'
import { buildGuardedResumeCommand } from '../main/resume-guard'
import { buildResumeCommand } from '../main/session-actions'
import { loadAllSessions } from '../main/session-loader'
import type { SessionSummary } from '../main/types'

export interface CliResumeResponse {
  command?: string
  error?: string
}

export interface CliResumeOptions {
  loadSessions?: () => Promise<SessionSummary[]>
}

function findKnownSession(sessions: SessionSummary[], sessionId: string): SessionSummary | undefined {
  return sessions.find((s) => s.id === sessionId || s.sessionId === sessionId) ||
    sessions.find((s) => (s.continuationSessionIds || []).includes(sessionId))
}

export async function buildCliResumeResponse(
  sessionId: string,
  flags: Record<string, string | true>,
  options: CliResumeOptions = {}
): Promise<CliResumeResponse> {
  const source = String(flags.source || 'claude-code') as 'claude-code' | 'codex' | 'cursor'
  const skipPermissions = flags['skip-permissions'] === true
  const permissionMode = skipPermissions ? 'bypassPermissions' : undefined
  const cwd = flags.cwd ? String(flags.cwd) : undefined
  const sessions = await (options.loadSessions || loadAllSessions)()
  const knownSession = findKnownSession(sessions, sessionId)

  if (knownSession || getSessionDirPath(sessionId)) {
    const result = await buildGuardedResumeCommand({
      sessionId,
      sessions,
      permissionMode,
      cwd
    })
    if (!result.ok || !result.command) return { error: result.reason || '此会话无法直接恢复' }
    return { command: result.command }
  }

  // Historical compatibility: only truly unknown ad-hoc ids skip the Library/local-source guard.
  return { command: buildResumeCommand(sessionId, permissionMode, cwd, source) }
}
