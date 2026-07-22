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

export interface ResumeActionResult {
  ok: boolean
  sessionId: string
  reason?: string
  surface?: ResumeSurface
  action?: ResumeLaunchAction
  command?: string
  notice?: string
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
  prepareResumeTarget?: (
    sessionId: string,
    options: { allowRecovery?: boolean; requestedSessionId?: string }
  ) => Promise<SessionResumePreparationResult>
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
    reason: availability.reason || '此会话无法直接恢复'
  }
}

async function buildGuardedAction(
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
  const surface = kind === 'fork' ? 'terminal' : (options.surface || 'terminal')
  if (surface === 'claude-desktop' && options.allowExperimentalClaudeDesktop !== true) {
    return {
      ok: false,
      sessionId: context.sessionId,
      surface,
      reason: '请先在设置中开启“实验：导入到 Claude Desktop”'
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
    const notice = surface === 'zcode-desktop'
      ? 'ZCode 已打开，但当前不支持跳转到指定历史会话'
      : undefined
    return { ok: true, sessionId: context.sessionId, surface, action, command, notice }
  } catch (error) {
    return {
      ok: false,
      sessionId: context.sessionId,
      surface,
      reason: error instanceof Error ? error.message : '无法构建 Resume 动作'
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
      reason: error instanceof Error ? error.message : '无法打开目标客户端'
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
      reason: error instanceof Error ? error.message : '无法打开终端'
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
