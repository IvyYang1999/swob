import {
  ensureSessionResumeTarget,
  getSessionDirPath,
  getSessionResumeAvailability,
  type SessionResumeAvailability,
  type SessionResumePreparationResult
} from './library-manager'
import {
  buildForkCommand,
  buildForkLaunchSpec,
  buildResumeAction,
  resolveSessionActionContext
} from './session-actions'
import type { ResumeLaunchAction, ResumeSurface } from './session-actions'
import type { SessionSummary } from './types'
import {
  probeAntigravityResumeCapability,
  type AntigravityResumeCapability
} from './providers/antigravity-resume'

export interface ResumeActionResult {
  ok: boolean
  sessionId: string
  reasonCode?: string
  reasonParams?: Record<string, string | number>
  surface?: ResumeSurface
  action?: ResumeLaunchAction
  command?: string
  noticeCode?: string
}

export interface GuardedResumeOptions {
  sessionId: string
  sessions: SessionSummary[]
  permissionMode?: string
  cwd?: string
  surface?: ResumeSurface
  allowExperimentalClaudeDesktop?: boolean
  reloadSessions?: () => Promise<SessionSummary[]>
  /** Internal action boundary: command builders/copy never enable recovery. */
  allowRecovery?: boolean
  /** Explicit user choice required before importing a known-remote backup. */
  preferredTargetInstanceId?: string
  prepareResumeTarget?: (
    sessionId: string,
    options: {
      allowRecovery?: boolean
      requestedSessionId?: string
      preferredTargetInstanceId?: string
    }
  ) => Promise<SessionResumePreparationResult>
  /** Test seam for the shell-free `agy --help` capability probe. */
  antigravityResumePreflight?: () => Promise<AntigravityResumeCapability>
}

export interface OpenGuardedResumeOptions extends GuardedResumeOptions {
  openCommand: (command: string) => void
}

export interface OpenGuardedResumeActionOptions extends GuardedResumeOptions {
  openAction: (action: ResumeLaunchAction) => void | Promise<void>
}

function findSessionForGuard(sessions: SessionSummary[], sessionId: string): SessionSummary | undefined {
  return sessions.find((s) => s.id === sessionId || s.sessionId === sessionId) ||
    sessions.find((s) => (s.continuationSessionIds || []).includes(sessionId))
}

function unavailableResult(sessionId: string, availability: SessionResumeAvailability): ResumeActionResult {
  return {
    ok: false,
    sessionId,
    reasonCode: 'resume.error.unavailable'
  }
}

async function buildGuardedAction(
  options: GuardedResumeOptions,
  kind: 'resume' | 'fork'
): Promise<ResumeActionResult> {
  const summary = findSessionForGuard(options.sessions, options.sessionId)
  if (kind === 'fork' && summary?.source === 'hermes') {
    return {
      ok: false,
      sessionId: options.sessionId,
      surface: 'terminal',
      reasonCode: 'resume.error.build_action_failed',
      reasonParams: { details: 'Hermes has no verified CLI surface for forking a historical session' }
    }
  }
  const indexedSessionId = getSessionDirPath(options.sessionId)
    ? options.sessionId
    : summary?.sessionId && getSessionDirPath(summary.sessionId)
      ? summary.sessionId
      : null
  const availability = getSessionResumeAvailability(options.sessionId, summary)
  const explicitlyAuthorizedRemoteImport = options.allowRecovery === true &&
    !!options.preferredTargetInstanceId &&
    !!indexedSessionId
  if (!availability.canResume && !explicitlyAuthorizedRemoteImport) {
    return unavailableResult(options.sessionId, availability)
  }

  const prepared: SessionResumePreparationResult = !options.prepareResumeTarget && !indexedSessionId
    ? { ok: true, sourcePath: availability.sourcePath || null }
    : await (options.prepareResumeTarget || ensureSessionResumeTarget)(indexedSessionId || options.sessionId, {
        allowRecovery: options.allowRecovery === true,
        requestedSessionId: options.sessionId,
        preferredTargetInstanceId: options.preferredTargetInstanceId
      })
  if (!prepared.ok) {
    return {
      ok: false,
      sessionId: options.sessionId,
      reasonCode: prepared.failureCode ? `resume.error.${prepared.failureCode}` : 'resume.error.unavailable'
    }
  }
  const context = await resolveSessionActionContext(options.sessionId, options.sessions, {
    reloadSessions: options.reloadSessions,
    permissionModeFallback: options.permissionMode,
    cwdFallback: options.cwd,
    restoredSourcePath: prepared.sourcePath
  })
  const surface = kind === 'fork' ? 'terminal' : (options.surface || 'terminal')
  if (surface === 'claude-desktop' && options.allowExperimentalClaudeDesktop !== true) {
    return {
      ok: false,
      sessionId: context.sessionId,
      surface,
      reasonCode: 'resume.error.claude_desktop_disabled'
    }
  }

  if (kind === 'resume' && context.source === 'antigravity') {
    const capability = await (options.antigravityResumePreflight || probeAntigravityResumeCapability)()
    if (!capability.available) {
      return {
        ok: false,
        sessionId: context.sessionId,
        surface,
        reasonCode: 'resume.error.build_action_failed',
        reasonParams: { details: `antigravity-resume-${capability.reason}` }
      }
    }
  }

  try {
    const action: ResumeLaunchAction = kind === 'resume'
      ? buildResumeAction(
        context.sessionId,
        context.permissionMode,
        context.cwd,
        context.source,
        context.claudeConfigDir,
        surface
      )
      : {
        kind: 'terminal',
        command: buildForkCommand(
          context.sessionId,
          context.permissionMode,
          context.cwd,
          context.source,
          context.claudeConfigDir
        ),
        launchSpec: buildForkLaunchSpec(
          context.sessionId,
          context.permissionMode,
          context.cwd,
          context.source || 'claude-code',
          context.claudeConfigDir
        )
      }
    const command = action.kind === 'deep-link' ? undefined : action.command
    const noticeCode = surface === 'zcode-desktop'
      ? 'resume.notice.zcode_opened'
      : undefined
    return { ok: true, sessionId: context.sessionId, surface, action, command, noticeCode }
  } catch (error) {
    return {
      ok: false,
      sessionId: context.sessionId,
      surface,
      reasonCode: 'resume.error.build_action_failed',
      reasonParams: { details: error instanceof Error ? error.message : 'unknown' }
    }
  }
}

export async function buildGuardedResumeAction(options: GuardedResumeOptions): Promise<ResumeActionResult> {
  return buildGuardedAction(options, 'resume')
}

export async function buildGuardedResumeCommand(options: GuardedResumeOptions): Promise<ResumeActionResult> {
  return buildGuardedAction({ ...options, surface: 'terminal' }, 'resume')
}

export async function openGuardedResumeAction(
  options: OpenGuardedResumeActionOptions
): Promise<ResumeActionResult> {
  const result = await buildGuardedAction({ ...options, allowRecovery: true }, 'resume')
  if (!result.ok || !result.action) return result
  try {
    await options.openAction(result.action)
    return result
  } catch (error) {
    return {
      ...result,
      ok: false,
      reasonCode: 'resume.error.open_client_failed',
      reasonParams: { details: error instanceof Error ? error.message : 'unknown' }
    }
  }
}

export async function openGuardedForkAction(
  options: OpenGuardedResumeActionOptions
): Promise<ResumeActionResult> {
  const result = await buildGuardedAction({ ...options, allowRecovery: true, surface: 'terminal' }, 'fork')
  if (!result.ok || !result.action) return result
  try {
    await options.openAction(result.action)
    return result
  } catch (error) {
    return {
      ...result,
      ok: false,
      reasonCode: 'resume.error.open_terminal_failed',
      reasonParams: { details: error instanceof Error ? error.message : 'unknown' }
    }
  }
}

export async function openGuardedResumeCommand(options: OpenGuardedResumeOptions): Promise<ResumeActionResult> {
  const result = await buildGuardedAction({ ...options, allowRecovery: true, surface: 'terminal' }, 'resume')
  if (result.ok && result.command) options.openCommand(result.command)
  return result
}

export async function openGuardedForkCommand(options: OpenGuardedResumeOptions): Promise<ResumeActionResult> {
  const result = await buildGuardedAction({ ...options, allowRecovery: true, surface: 'terminal' }, 'fork')
  if (result.ok && result.command) options.openCommand(result.command)
  return result
}
