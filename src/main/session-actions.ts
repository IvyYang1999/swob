import * as fs from 'fs'
import {
  buildSessionSummary,
  getClaudeConfigDirForSessionFile,
  parseSessionFile
} from './session-loader'
import { shellQuote } from './resume-terminal'
import type { RawJsonlMessage, SessionSource, SessionSummary } from './types'
import { runtimeHome } from './runtime-home'
import { alphaUnsupportedReason } from './platform-support'
import { supportsVerifiedSessionFork } from '../shared/session-action-capabilities'
import { providerCapabilitiesForSource } from '../shared/provider-capabilities'
import { isAntigravityConversationId } from './providers/antigravity-resume'

export interface SessionActionContext {
  sessionId: string
  source?: SessionSource
  permissionMode?: string
  cwd?: string
  claudeConfigDir?: string
  summary?: SessionSummary
}

export interface ResolveSessionActionOptions {
  cwdFallback?: string
  permissionModeFallback?: string
  restoredSourcePath?: string | null
  reloadSessions?: () => Promise<SessionSummary[]>
  home?: string
}

export type ResumeSurface =
  | 'terminal'
  | 'codex-desktop'
  | 'claude-desktop'
  | 'zcode-desktop'
  | 'remote-control'

export type ResumeLaunchAction =
  | { kind: 'terminal'; command: string; launchSpec: LaunchSpec }
  | { kind: 'deep-link'; url: string }
  | { kind: 'remote-control'; command: string; launchSpec: LaunchSpec }

export interface LaunchSpec {
  executable: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  target: 'native'
  keepOpen: boolean
}

function withClaudeConfigDir(cmd: string, claudeConfigDir?: string): string {
  return claudeConfigDir ? `CLAUDE_CONFIG_DIR=${shellQuote(claudeConfigDir)} ${cmd}` : cmd
}

function existingDirectory(cwd?: string): string | undefined {
  if (!cwd) return undefined
  try {
    return fs.statSync(cwd).isDirectory() ? cwd : undefined
  } catch {
    return undefined
  }
}

function assertQoderResumeSessionId(sessionId: string): void {
  if (sessionId.includes(':subagent:')) {
    throw new Error('Qoder CLI 没有已验证的子代理 Resume 入口')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(sessionId)) {
    throw new Error('qoder session id 格式不合法')
  }
}

export function buildResumeLaunchSpec(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source: SessionSource = 'claude-code',
  claudeConfigDir?: string,
  platform: NodeJS.Platform = process.platform
): LaunchSpec {
  const unsupportedReason = alphaUnsupportedReason(source, platform)
  if (unsupportedReason) throw new Error(unsupportedReason)
  const terminalCapability = providerCapabilitiesForSource(source)?.['terminal-resume']
  if (terminalCapability && !['available', 'experimental'].includes(terminalCapability.status)) {
    throw new Error(terminalCapability.reason || `${source} does not expose a verified terminal resume command.`)
  }

  const launchCwd = existingDirectory(cwd)
  let executable: string
  let args: string[]

  if (source === 'codex') {
    executable = 'codex'
    args = ['resume', sessionId]
    if (launchCwd) args.push('-C', launchCwd)
  } else if (source === 'cursor') {
    executable = 'cursor-agent'
    args = [`--resume=${sessionId}`]
  } else if (source === 'opencode') {
    executable = 'opencode'
    args = [...(launchCwd ? [launchCwd] : []), '--session', sessionId]
  } else if (source === 'zcode') {
    throw new Error('ZCode 没有公开 CLI；请改用“打开 ZCode App”')
  } else if (source === 'kimi') {
    executable = 'kimi'
    args = ['--session', sessionId]
  } else if (source === 'antigravity') {
    if (!isAntigravityConversationId(sessionId)) throw new Error('antigravity-conversation-id-invalid')
    executable = 'agy'
    args = ['--conversation', sessionId]
  } else if (source === 'qoder') {
    assertQoderResumeSessionId(sessionId)
    executable = 'qodercli'
    args = ['-r', sessionId]
  } else {
    const executableBySource: Partial<Record<SessionSource, string>> = {
      'claude-code': 'claude',
      'cc-mirror': 'claude',
      grok: 'grok',
      pi: 'pi',
      kimi: 'kimi',
      hermes: 'hermes'
    }
    executable = executableBySource[source] || 'claude'
    args = [
      ...(source === 'claude-code' && permissionMode === 'bypassPermissions'
        ? ['--dangerously-skip-permissions']
        : []),
      '--resume',
      sessionId
    ]
  }

  return {
    executable,
    args,
    ...(launchCwd ? { cwd: launchCwd } : {}),
    ...(claudeConfigDir && source === 'claude-code'
      ? { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } }
      : {}),
    target: 'native',
    keepOpen: true
  }
}

export function buildForkLaunchSpec(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source: SessionSource = 'claude-code',
  claudeConfigDir?: string,
  platform: NodeJS.Platform = process.platform
): LaunchSpec {
  if (!supportsVerifiedSessionFork(source)) {
    throw new Error(`session-fork-unavailable:${source}`)
  }
  const resume = buildResumeLaunchSpec(
    sessionId,
    permissionMode,
    cwd,
    source,
    claudeConfigDir,
    platform
  )
  if (source === 'codex') return { ...resume, args: ['fork', ...resume.args.slice(1)] }
  if (source !== 'claude-code') return resume

  const resumeIndex = resume.args.indexOf('--resume')
  return {
    ...resume,
    args: [
      ...resume.args.slice(0, resumeIndex),
      '--fork-session',
      ...resume.args.slice(resumeIndex)
    ]
  }
}

function buildTerminalResumeCommand(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source?: SessionSource,
  claudeConfigDir?: string
): string {
  let cmd: string
  const quotedSessionId = shellQuote(sessionId)
  if (source === 'codex') {
    cmd = `codex resume ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) {
      cmd += ` -C ${shellQuote(cwd)}`
    }
    return cmd
  }
  if (source === 'cursor') {
    cmd = `cursor agent --resume ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) {
      return `cd ${shellQuote(cwd)} && ${cmd}`
    }
    return cmd
  }
  if (source === 'opencode') {
    cmd = `opencode --session ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) {
      return `cd ${shellQuote(cwd)} && ${cmd}`
    }
    return cmd
  }
  if (source === 'zcode') {
    // ZCode does not install a public launcher today. This raw command mirrors
    // the bundled runtime syntax for audits/debugging; buildResumeAction()
    // deliberately does not expose it as a supported terminal surface.
    cmd = `zcode --resume ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) {
      return `cd ${shellQuote(cwd)} && ${cmd}`
    }
    return cmd
  }
  if (source === 'kimi') {
    cmd = `kimi --session ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) return `cd ${shellQuote(cwd)} && ${cmd}`
    return cmd
  }
  if (source === 'antigravity') {
    if (!isAntigravityConversationId(sessionId)) throw new Error('antigravity-conversation-id-invalid')
    cmd = `agy --conversation ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) return `cd ${shellQuote(cwd)} && ${cmd}`
    return cmd
  }
  if (source === 'qoder') {
    assertQoderResumeSessionId(sessionId)
    cmd = `qodercli -r ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) {
      return `cd ${shellQuote(cwd)} && ${cmd}`
    }
    return cmd
  }
  const newSourceCmds: Partial<Record<SessionSource, string>> = {
    'cc-mirror': 'claude', grok: 'grok',
    pi: 'pi', hermes: 'hermes'
  }
  const newCmd = source && newSourceCmds[source]
  if (newCmd) {
    cmd = `${newCmd} --resume ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) return `cd ${shellQuote(cwd)} && ${cmd}`
    return cmd
  }

  cmd = permissionMode === 'bypassPermissions'
    ? `claude --dangerously-skip-permissions --resume ${quotedSessionId}`
    : `claude --resume ${quotedSessionId}`
  cmd = withClaudeConfigDir(cmd, claudeConfigDir)
  if (cwd && fs.existsSync(cwd)) {
    return `cd ${shellQuote(cwd)} && ${cmd}`
  }
  return cmd
}

function assertDeepLinkSessionId(sessionId: string, source: 'codex' | 'claude' | 'zcode'): void {
  const valid = source === 'claude'
    ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
    : source === 'zcode'
      ? /^sess_[A-Za-z0-9_-]+$/.test(sessionId)
      : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sessionId)
  if (!valid) throw new Error(`${source} session id 格式不合法`)
}

function isClaudeCodeSource(source?: SessionSource): boolean {
  return !source || source === 'claude-code'
}

export function buildResumeAction(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source?: SessionSource,
  claudeConfigDir?: string,
  surface: ResumeSurface = 'terminal',
  platform: NodeJS.Platform = process.platform
): ResumeLaunchAction {
  const effectiveSource = source || 'claude-code'
  const unsupportedReason = alphaUnsupportedReason(effectiveSource, platform)
  if (unsupportedReason) throw new Error(unsupportedReason)
  if (platform === 'win32') {
    const supportedSurface = surface === 'terminal' || (
      effectiveSource === 'codex' && surface === 'codex-desktop'
    )
    if (!supportedSurface) {
      throw new Error(`Windows Alpha 暂不支持 ${surface} Resume`)
    }
  }

  if (surface === 'terminal') {
    if (source === 'zcode') {
      throw new Error('ZCode 没有公开 CLI；请改用“打开 ZCode App”')
    }
    return {
      kind: 'terminal',
      command: buildTerminalResumeCommand(sessionId, permissionMode, cwd, source, claudeConfigDir),
      launchSpec: buildResumeLaunchSpec(
        sessionId,
        permissionMode,
        cwd,
        effectiveSource,
        claudeConfigDir,
        platform
      )
    }
  }

  if (surface === 'codex-desktop') {
    if (source !== 'codex') throw new Error('只有 Codex 会话可以在 Codex App 中继续')
    assertDeepLinkSessionId(sessionId, 'codex')
    return { kind: 'deep-link', url: `codex://threads/${encodeURIComponent(sessionId)}` }
  }

  if (surface === 'claude-desktop') {
    if (!isClaudeCodeSource(source)) throw new Error('只有 Claude Code 会话可以导入 Claude Desktop')
    assertDeepLinkSessionId(sessionId, 'claude')
    return { kind: 'deep-link', url: `claude://resume?session=${encodeURIComponent(sessionId)}` }
  }

  if (surface === 'zcode-desktop') {
    if (source !== 'zcode') throw new Error('只有 ZCode 会话可以打开 ZCode App')
    assertDeepLinkSessionId(sessionId, 'zcode')
    const url = cwd && fs.existsSync(cwd)
      ? `zcode://workspace/open?path=${encodeURIComponent(cwd)}`
      : 'zcode://'
    return { kind: 'deep-link', url }
  }

  if (!isClaudeCodeSource(source)) {
    throw new Error('Remote Control 只支持 Claude Code 会话')
  }
  const command = `${buildTerminalResumeCommand(
    sessionId,
    permissionMode,
    cwd,
    source,
    claudeConfigDir
  )} --remote-control`
  const launchSpec = buildResumeLaunchSpec(
    sessionId,
    permissionMode,
    cwd,
    source || 'claude-code',
    claudeConfigDir
  )
  return {
    kind: 'remote-control',
    command,
    launchSpec: { ...launchSpec, args: [...launchSpec.args, '--remote-control'] }
  }
}

/** Legacy raw command builder used by copy/audit call sites. Launches must use buildResumeAction. */
export function buildResumeCommand(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source?: SessionSource,
  claudeConfigDir?: string
): string {
  return buildTerminalResumeCommand(sessionId, permissionMode, cwd, source, claudeConfigDir)
}

export function buildForkCommand(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source?: SessionSource,
  claudeConfigDir?: string
): string {
  const effectiveSource = source || 'claude-code'
  if (!supportsVerifiedSessionFork(effectiveSource)) {
    throw new Error(`session-fork-unavailable:${effectiveSource}`)
  }
  let cmd: string
  const quotedSessionId = shellQuote(sessionId)
  if (source === 'codex') {
    cmd = `codex fork ${quotedSessionId}`
    if (cwd && fs.existsSync(cwd)) {
      cmd += ` -C ${shellQuote(cwd)}`
    }
    return cmd
  }
  cmd = permissionMode === 'bypassPermissions'
    ? `claude --dangerously-skip-permissions --fork-session --resume ${quotedSessionId}`
    : `claude --fork-session --resume ${quotedSessionId}`
  cmd = withClaudeConfigDir(cmd, claudeConfigDir)
  if (cwd && fs.existsSync(cwd)) {
    return `cd ${shellQuote(cwd)} && ${cmd}`
  }
  return cmd
}

function findSessionForAction(sessions: SessionSummary[], sessionId: string): SessionSummary | undefined {
  return sessions.find((s) => s.id === sessionId || s.sessionId === sessionId)
    || sessions.find((s) => (s.continuationSessionIds || []).includes(sessionId))
}

function hasClaudeWindowPath(summary: SessionSummary, home: string): boolean {
  const paths = [summary.filePath, ...(summary.allFilePaths || [])].filter(Boolean)
  return paths.some((p) => !!getClaudeConfigDirForSessionFile(p, home))
}

function needsSessionReload(summary: SessionSummary | undefined, home: string): boolean {
  if (!summary) return true
  if (summary.source === 'codex' || summary.source === 'cursor' || summary.source === 'opencode' || summary.source === 'zcode') return false
  return hasClaudeWindowPath(summary, home) && !summary.claudeConfigDir
}

function timestampValue(timestamp?: string): number {
  if (!timestamp) return Number.POSITIVE_INFINITY
  const parsed = Date.parse(timestamp)
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY
}

function getRawTimeRange(raw: RawJsonlMessage[]): { start: number; end: number } {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const msg of raw) {
    const value = timestampValue(msg.timestamp)
    if (!Number.isFinite(value)) continue
    if (value < start) start = value
    if (value > end) end = value
  }
  return { start, end }
}

async function buildFreshClaudeSummary(
  summary: SessionSummary,
  restoredSourcePath?: string | null,
  home = runtimeHome()
): Promise<SessionSummary | null> {
  const sourcePaths = restoredSourcePath && fs.existsSync(restoredSourcePath)
    ? [restoredSourcePath]
    : (summary.allFilePaths && summary.allFilePaths.length > 0 ? summary.allFilePaths : [summary.filePath])

  const entries: Array<{ filePath: string; raw: RawJsonlMessage[]; start: number; end: number }> = []
  for (const filePath of sourcePaths) {
    if (!filePath || !fs.existsSync(filePath)) continue
    try {
      const raw = await parseSessionFile(filePath)
      if (raw.length === 0) continue
      const range = getRawTimeRange(raw)
      entries.push({ filePath, raw, start: range.start, end: range.end })
    } catch {
      // Ignore unreadable shards and fall back to the existing summary.
    }
  }

  if (entries.length === 0) return null

  entries.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start
    return a.filePath.localeCompare(b.filePath)
  })

  const primaryFile = entries[0].filePath
  const raw = entries.flatMap((entry) => entry.raw)
  const sessionIdOverride = summary.continuationSessionIds && summary.continuationSessionIds.length > 0
    ? summary.sessionId
    : undefined
  const fresh = buildSessionSummary(primaryFile, raw, true, sessionIdOverride)
  if (!fresh) return null

  fresh.allFilePaths = entries.map((entry) => entry.filePath)
  fresh.id = summary.id
  fresh.branchParentFilePaths = summary.branchParentFilePaths
  fresh.branchPointUuid = summary.branchPointUuid
  fresh.branchLeafUuid = summary.branchLeafUuid
  fresh.branchParentId = summary.branchParentId
  fresh.branchChildIds = summary.branchChildIds
  fresh.continuationSessionIds = summary.continuationSessionIds
  fresh.resumeSessionId = summary.resumeSessionId || fresh.sessionId
  fresh.libraryDirPath = summary.libraryDirPath
  fresh.libraryMdPath = summary.libraryMdPath
  fresh.isRemote = summary.isRemote
  fresh.remoteHost = summary.remoteHost
  fresh.source = 'claude-code'

  if (!fresh.claudeConfigDir && hasClaudeWindowPath(fresh, home)) {
    fresh.claudeConfigDir = getClaudeConfigDirForSessionFile(primaryFile, home)
  }

  return fresh
}

export async function resolveSessionActionContext(
  requestedSessionId: string,
  sessions: SessionSummary[],
  options: ResolveSessionActionOptions = {}
): Promise<SessionActionContext> {
  if (requestedSessionId.includes(':intra-')) {
    throw new Error('Intra-file branches cannot be resumed independently')
  }

  const home = options.home || runtimeHome()
  let currentSessions = sessions
  let summary = findSessionForAction(currentSessions, requestedSessionId)

  if (needsSessionReload(summary, home) && options.reloadSessions) {
    currentSessions = await options.reloadSessions()
    summary = findSessionForAction(currentSessions, requestedSessionId) || summary
  }

  if (summary && (summary.source === 'claude-code' || summary.source === 'cc-mirror')) {
    const fresh = await buildFreshClaudeSummary(summary, options.restoredSourcePath, home)
    if (fresh) summary = { ...summary, ...fresh }
  }

  const commandSessionId = summary?.resumeSessionId || summary?.sessionId || requestedSessionId
  return {
    sessionId: commandSessionId,
    source: summary?.source,
    permissionMode: summary?.permissionMode || options.permissionModeFallback,
    cwd: summary?.resumeCwd || options.cwdFallback,
    claudeConfigDir: summary?.claudeConfigDir,
    summary
  }
}
