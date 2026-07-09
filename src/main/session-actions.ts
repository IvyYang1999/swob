import * as fs from 'fs'
import {
  buildSessionSummary,
  getClaudeConfigDirForSessionFile,
  parseSessionFile
} from './session-loader'
import { shellQuote } from './resume-terminal'
import type { RawJsonlMessage, SessionSource, SessionSummary } from './types'

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

function withClaudeConfigDir(cmd: string, claudeConfigDir?: string): string {
  return claudeConfigDir ? `CLAUDE_CONFIG_DIR=${shellQuote(claudeConfigDir)} ${cmd}` : cmd
}

export function buildResumeCommand(
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

  cmd = permissionMode === 'bypassPermissions'
    ? `claude --dangerously-skip-permissions --resume ${quotedSessionId}`
    : `claude --resume ${quotedSessionId}`
  cmd = withClaudeConfigDir(cmd, claudeConfigDir)
  if (cwd && fs.existsSync(cwd)) {
    return `cd ${shellQuote(cwd)} && ${cmd}`
  }
  return cmd
}

export function buildForkCommand(
  sessionId: string,
  permissionMode?: string,
  cwd?: string,
  source?: SessionSource,
  claudeConfigDir?: string
): string {
  let cmd: string
  const quotedSessionId = shellQuote(sessionId)
  if (source === 'codex') {
    cmd = `codex fork ${quotedSessionId}`
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
  if (summary.source === 'codex' || summary.source === 'cursor' || summary.source === 'opencode') return false
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
  home = process.env.HOME || ''
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

  const home = options.home || process.env.HOME || ''
  let currentSessions = sessions
  let summary = findSessionForAction(currentSessions, requestedSessionId)

  if (needsSessionReload(summary, home) && options.reloadSessions) {
    currentSessions = await options.reloadSessions()
    summary = findSessionForAction(currentSessions, requestedSessionId) || summary
  }

  if (summary && summary.source !== 'codex' && summary.source !== 'cursor' && summary.source !== 'opencode') {
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
