import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { readJsonlRecords, type JsonlReadStats } from './jsonl-lines'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  ContentPart
} from './session-types'
import { tokenUsageFromAccounting, unavailableTokenAccounting } from './token-accounting'
import { runtimeHome } from './runtime-home'
import { activityDaysFromTimestamps, localActivityDay } from './activity-time'

const HOME = runtimeHome()
const CURSOR_PROJECTS_DIR = path.join(HOME, '.cursor', 'projects')

// --- File discovery ---

export function findCursorSessionFiles(home = HOME): string[] {
  const files: string[] = []
  const projectsDir = home === HOME ? CURSOR_PROJECTS_DIR : path.join(home, '.cursor', 'projects')
  if (!fs.existsSync(projectsDir)) return files

  for (const projEntry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projEntry.isDirectory()) continue
    const transcriptsDir = path.join(projectsDir, projEntry.name, 'agent-transcripts')
    if (!fs.existsSync(transcriptsDir)) continue

    for (const sessionEntry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
      if (!sessionEntry.isDirectory()) continue
      const jsonlPath = path.join(transcriptsDir, sessionEntry.name, `${sessionEntry.name}.jsonl`)
      if (fs.existsSync(jsonlPath)) {
        files.push(jsonlPath)
      }
    }
  }
  return files
}

export function findCursorResumeStores(home = HOME): string[] {
  const chatsRoot = path.join(home, '.cursor', 'chats')
  const stores: string[] = []
  let workspaces: fs.Dirent[]
  try { workspaces = fs.readdirSync(chatsRoot, { withFileTypes: true }) } catch { return stores }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = path.join(chatsRoot, workspace.name)
    let sessions: fs.Dirent[]
    try { sessions = fs.readdirSync(workspaceDir, { withFileTypes: true }) } catch { continue }
    for (const session of sessions) {
      if (!session.isDirectory()) continue
      const storePath = path.join(workspaceDir, session.name, 'store.db')
      if (fs.existsSync(storePath)) stores.push(storePath)
    }
  }
  return stores.sort()
}

export function findCursorSourceGenerations(home = HOME): {
  transcriptJsonl: string[]
  resumeStoreDb: string[]
} {
  return {
    transcriptJsonl: findCursorSessionFiles(home),
    resumeStoreDb: findCursorResumeStores(home)
  }
}

// --- Cursor JSONL line format ---

interface CursorLine {
  timestamp?: string
  role: 'user' | 'assistant' | 'tool'
  message: {
    content: string | CursorContentPart[]
  }
}

interface CursorContentPart {
  type: string
  text?: string
  name?: string
  id?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  toolCallId?: string
  toolName?: string
  result?: string
  content?: string | CursorContentPart[]
  args?: Record<string, unknown>
  source?: { type: string; media_type?: string; data?: string; url?: string }
}

// --- Parse raw lines ---

async function parseCursorFile(filePath: string): Promise<CursorLine[]> {
  return (await parseCursorFileWithStats(filePath)).lines
}

/**
 * parseCursorFile plus per-file read counts (see JsonlReadStats). Lines are
 * split at LF only (jsonl-lines.ts). A stream error still rejects (callers
 * catch it), so a returned result always has truncated = false.
 */
export async function parseCursorFileWithStats(
  filePath: string
): Promise<{ lines: CursorLine[] } & JsonlReadStats> {
  const { records, ...stats } = await readJsonlRecords<CursorLine>(filePath, { onStreamError: 'throw' })
  return { lines: records, ...stats }
}

export async function loadCursorRawMessages(filePath: string, sessionIdOverride?: string): Promise<RawJsonlMessage[]> {
  const lines = await parseCursorFile(filePath)
  if (lines.length === 0) return []
  const sessionId = sessionIdOverride || extractSessionId(filePath)
  return cursorToRawMessages(lines, sessionId, filePath, resolveCursorWorkspace(filePath, lines).cwd)
}

// --- Resolve the workspace (cwd) a transcript belongs to ---
//
// Cursor names the transcript folder after the workspace path, turning every run
// of non-alphanumeric characters into `-` (`<cursorRoot>/projects/<slug>/…`). The
// name alone cannot tell which `-` was a `/` and which belonged to a folder name.
// What Cursor records exactly is the md5 of the workspace path: a session's resume
// store sits at `<cursorRoot>/chats/<md5(workspace)>/<sessionId>/`. That directory
// name cannot be reversed, but it confirms a guessed path.
//
// Guesses come from the transcript itself (every absolute path in its text and
// tool inputs, e.g. <user_query>, `path`, `working_directory`, plus all their
// ancestor directories) and the old reading of the folder name; when those miss,
// from a walk of the real filesystem that only enters directories whose names
// fit the slug. Only directory names under chats/ are read; store.db is never
// opened.
//
//   reported  - md5(guess) names the chats directory that holds this session, so
//               the guess is the exact workspace Cursor recorded (the directory
//               may have been deleted since).
//   derived   - Cursor keeps no chats record of this session, and exactly one
//               existing directory taken from the transcript fits the slug.
//   estimated - nothing confirmed: the old reading of the folder name, every `-`
//               taken as `/`, kept exactly as before so nothing regresses.

type CwdProvenance = NonNullable<SessionSummary['cwdProvenance']>

export interface CursorWorkspaceResolution {
  /** '' when the transcript location gives nothing to go on (e.g. a Library backup). */
  cwd: string
  provenance?: CwdProvenance
}

interface CursorTranscriptLocation {
  /** The `.cursor` directory the transcript lives in; never the module-level HOME. */
  cursorRoot: string
  /** `projects/<slug>`: the workspace path as Cursor slugged it. */
  projectSlug: string
  /** The session folder under agent-transcripts; chats/ uses the same id. */
  transcriptSessionId: string
}

const MAX_WORKSPACE_CANDIDATES = 20_000
const MAX_PATH_VALUE_LENGTH = 4096
const MAX_CLUE_SCAN_DEPTH = 8
const SLUG_WALK_MAX_DIRS = 2_000
const SLUG_WALK_MAX_DEPTH = 32
const SLUG_WALK_MAX_MATCHES = 64

// An absolute POSIX path inside free text. It starts at a `/` that does not
// continue a URL (`://`), a relative path (`a/b`, `./b`, `../b`), `~/…` or a
// word, and runs until whitespace, a quote, `<>|\` or CJK punctuation.
const ABSOLUTE_PATH_IN_TEXT = /(?<![\w.:/~-])\/[^\s"'`<>|\\，。；：！？、（）「」『』【】《》“”‘’]+/gu
const FILE_URL_PREFIX = /file:\/\/(?=\/)/g

/** Cursor's folder name for a workspace path: runs of non-alphanumerics become `-`, trimmed. */
export function cursorProjectSlug(workspacePath: string): string {
  return workspacePath.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

/** `<cursorRoot>/projects/<slug>/agent-transcripts/<sessionId>/…/<file>.jsonl`, else null. */
function cursorTranscriptLocation(filePath: string): CursorTranscriptLocation | null {
  const parts = path.resolve(filePath).split(path.sep)
  const transcriptsIdx = parts.lastIndexOf('agent-transcripts')
  if (transcriptsIdx < 3 || parts[transcriptsIdx - 2] !== 'projects') return null
  if (transcriptsIdx + 2 >= parts.length) return null
  const projectSlug = parts[transcriptsIdx - 1]
  const transcriptSessionId = parts[transcriptsIdx + 1]
  if (!projectSlug || !transcriptSessionId || transcriptSessionId === '.' || transcriptSessionId === '..') return null
  return {
    cursorRoot: parts.slice(0, transcriptsIdx - 2).join(path.sep) || path.sep,
    projectSlug,
    transcriptSessionId
  }
}

/** The pre-F1c reading of the folder name: every `-` taken as `/`. */
function legacyWorkspaceGuess(projectSlug: string): string {
  return '/' + projectSlug.replace(/-/g, '/')
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function workspaceHash(workspacePath: string): string {
  return crypto.createHash('md5').update(workspacePath).digest('hex')
}

function forEachString(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > MAX_CLUE_SCAN_DEPTH || value === null || value === undefined) return
  if (typeof value === 'string') {
    visit(value)
  } else if (Array.isArray(value)) {
    for (const item of value) forEachString(item, visit, depth + 1)
  } else if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) forEachString(item, visit, depth + 1)
  }
}

/** Absolute paths the transcript mentions, each with all its ancestor directories. */
function workspaceCandidatesFromTranscript(lines: readonly unknown[]): Set<string> {
  const candidates = new Set<string>()
  const addWithAncestors = (clue: string): void => {
    if (clue.includes('\0')) return
    let dir = path.posix.resolve(clue)
    while (dir !== '/' && !candidates.has(dir) && candidates.size < MAX_WORKSPACE_CANDIDATES) {
      candidates.add(dir)
      dir = path.posix.dirname(dir)
    }
  }
  for (const line of lines) {
    forEachString(line, (text) => {
      if (candidates.size >= MAX_WORKSPACE_CANDIDATES) return
      // A whole value that is one absolute path (tool inputs such as `path` or
      // `working_directory`) is taken as is, so spaces inside it survive.
      const value = text.trim()
      if (value.startsWith('/') && value.length <= MAX_PATH_VALUE_LENGTH && !value.includes('\n')) {
        addWithAncestors(value)
      }
      for (const match of text.replace(FILE_URL_PREFIX, ' ').matchAll(ABSOLUTE_PATH_IN_TEXT)) {
        addWithAncestors(match[0])
      }
    })
  }
  return candidates
}

/** Workspace hashes under `<cursorRoot>/chats/` that hold a folder for this session. */
function chatWorkspaceHashes(location: CursorTranscriptLocation): Set<string> {
  const hashes = new Set<string>()
  const chatsRoot = path.join(location.cursorRoot, 'chats')
  let workspaces: fs.Dirent[]
  try {
    workspaces = fs.readdirSync(chatsRoot, { withFileTypes: true })
  } catch {
    return hashes
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory() && !workspace.isSymbolicLink()) continue
    if (isDirectory(path.join(chatsRoot, workspace.name, location.transcriptSessionId))) {
      hashes.add(workspace.name)
    }
  }
  return hashes
}

/**
 * Existing directories whose Cursor slug equals `projectSlug`, found by walking
 * down from `/` and entering only entries whose slug fits the rest of the slug.
 * A name without alphanumerics (a CJK folder, say) adds nothing to the slug.
 */
function directoriesMatchingSlug(projectSlug: string): string[] {
  const found: string[] = []
  const pending: Array<{ dir: string; rest: string; depth: number }> = [{ dir: '/', rest: projectSlug, depth: 0 }]
  let visited = 0
  while (pending.length > 0 && found.length < SLUG_WALK_MAX_MATCHES && visited < SLUG_WALK_MAX_DIRS) {
    const { dir, rest, depth } = pending.pop()!
    visited++
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const segment = cursorProjectSlug(entry.name)
      const complete = segment === rest
      const consumes = segment !== '' && rest.startsWith(`${segment}-`)
      if (segment !== '' && !complete && !consumes) continue
      const child = path.posix.join(dir, entry.name)
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(child))) continue
      if (complete) found.push(child)
      if (depth + 1 >= SLUG_WALK_MAX_DEPTH) continue
      const nextRest = segment === '' ? rest : complete ? '' : rest.slice(segment.length + 1)
      pending.push({ dir: child, rest: nextRest, depth: depth + 1 })
    }
  }
  return found
}

/** Prefer a workspace that still exists, then the one the transcript folder is named after. */
function preferredWorkspace(verified: readonly string[], projectSlug: string): string {
  const rank = (candidate: string): number =>
    (isDirectory(candidate) ? 0 : 2) + (cursorProjectSlug(candidate) === projectSlug ? 0 : 1)
  return [...verified].sort((left, right) =>
    rank(left) - rank(right) || (left < right ? -1 : left > right ? 1 : 0)
  )[0]
}

export function resolveCursorWorkspace(filePath: string, lines: readonly unknown[]): CursorWorkspaceResolution {
  const location = cursorTranscriptLocation(filePath)
  if (!location) return { cwd: '' }
  const estimated: CursorWorkspaceResolution = {
    cwd: legacyWorkspaceGuess(location.projectSlug),
    provenance: 'estimated'
  }
  // Windows keeps the old reading: Cursor hashes a drive path there, and the
  // transcript scan below only understands POSIX paths.
  if (process.platform === 'win32') return estimated

  const candidates = workspaceCandidatesFromTranscript(lines)
  const hashes = chatWorkspaceHashes(location)
  if (hashes.size === 0) {
    const derived = [...candidates].filter((candidate) =>
      cursorProjectSlug(candidate) === location.projectSlug && isDirectory(candidate)
    )
    return derived.length === 1 ? { cwd: derived[0], provenance: 'derived' } : estimated
  }

  const confirmed = (paths: Iterable<string>): string[] =>
    [...new Set(paths)].filter((candidate) => hashes.has(workspaceHash(candidate)))
  let verified = confirmed([...candidates, path.posix.resolve(estimated.cwd)])
  const namesTranscriptFolder = verified.some((candidate) => cursorProjectSlug(candidate) === location.projectSlug)
  if (!namesTranscriptFolder && new Set(verified.map(workspaceHash)).size < hashes.size) {
    verified = [...new Set([...verified, ...confirmed(directoriesMatchingSlug(location.projectSlug))])]
  }
  if (verified.length > 0) {
    return { cwd: preferredWorkspace(verified, location.projectSlug), provenance: 'reported' }
  }
  // Cursor filed this session under a workspace none of the guesses is, so no
  // guess can be called derived.
  return estimated
}

// --- Extract session ID from directory name ---

function extractSessionId(filePath: string): string {
  return path.basename(path.dirname(filePath))
}

// --- Convert to unified RawJsonlMessage[] ---

function cursorToRawMessages(
  lines: CursorLine[],
  sessionId: string,
  filePath: string,
  workspaceCwd: string
): RawJsonlMessage[] {
  const messages: RawJsonlMessage[] = []
  const stat = fs.statSync(filePath)
  const fileTime = stat.mtime.toISOString()
  const cwd = workspaceCwd || undefined
  let msgIndex = 0

  for (const line of lines) {
    const uuid = `cursor-${sessionId}-${msgIndex++}`
    const parentUuid = messages.length > 0 ? messages[messages.length - 1].uuid : null
    // Some Cursor transcript versions expose an event timestamp. Older ones
    // do not; file mtime remains a display fallback but is not activity proof.
    const timestamp = localActivityDay(line.timestamp) ? line.timestamp! : fileTime

    if (line.role === 'user') {
      const content = line.message.content
      let textContent = ''
      let contentParts: ContentPart[] | undefined

      if (typeof content === 'string') {
        textContent = cleanUserText(content)
      } else if (Array.isArray(content)) {
        const hasToolResult = content.some((p) => p.type === 'tool_result' || p.type === 'tool-result')
        if (hasToolResult) {
          contentParts = content.map((p) => {
            if (p.type === 'tool_result' || p.type === 'tool-result') {
              return {
                type: 'tool_result',
                tool_use_id: p.tool_use_id || p.toolCallId,
                content: (typeof p.result === 'string' ? p.result : p.text) || ''
              } as ContentPart
            }
            return { type: 'text', text: p.text || '' } as ContentPart
          })
        } else {
          const rawText = content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('\n')
          textContent = cleanUserText(rawText)
        }
      }

      messages.push({
        uuid,
        parentUuid,
        sessionId,
        type: 'user',
        timestamp,
        cwd,
        message: {
          role: 'user',
          content: contentParts || textContent
        }
      })
    } else if (line.role === 'assistant') {
      const content = line.message.content
      if (typeof content === 'string') {
        messages.push({
          uuid,
          parentUuid,
          sessionId,
          type: 'assistant',
          timestamp,
          cwd,
          message: { role: 'assistant', content }
        })
      } else if (Array.isArray(content)) {
        const parts: ContentPart[] = content.map((p) => {
          if (p.type === 'tool_use' || p.type === 'tool-call') {
            return {
              type: 'tool_use',
              id: p.id || p.toolCallId,
              name: p.name || p.toolName || 'unknown',
              input: p.input || p.args || {}
            } as ContentPart
          }
          if (p.type === 'text') {
            return { type: 'text', text: p.text || '' } as ContentPart
          }
          if (p.type === 'reasoning' || p.type === 'thinking') {
            return { type: 'reasoning', text: p.text || '' } as ContentPart
          }
          if (p.type === 'image' && p.source) {
            return { type: 'image', source: p.source } as ContentPart
          }
          return { type: 'text', text: '' } as ContentPart
        })
        messages.push({
          uuid,
          parentUuid,
          sessionId,
          type: 'assistant',
          timestamp,
          cwd,
          message: { role: 'assistant', content: parts }
        })
      }
    } else if (line.role === 'tool') {
      const content = line.message.content
      if (Array.isArray(content)) {
        const parts: ContentPart[] = content.map((p) => {
          if (p.type === 'tool_result' || p.type === 'tool-result') {
            return {
              type: 'tool_result',
              tool_use_id: p.tool_use_id || p.toolCallId,
              content: (typeof p.result === 'string' ? p.result : p.text) || ''
            } as ContentPart
          }
          return { type: 'text', text: p.text || '' } as ContentPart
        })
        messages.push({
          uuid,
          parentUuid,
          sessionId,
          type: 'user',
          timestamp,
          cwd,
          message: { role: 'user', content: parts }
        })
      }
    }
  }

  return messages
}

// --- Helpers ---

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n')
}

function extractToolCalls(content: string | ContentPart[] | undefined): ToolCallInfo[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((p) => p.type === 'tool_use' && p.name)
    .map((p) => ({ id: p.id, name: p.name!, input: (p.input as Record<string, unknown>) || {} }))
}

function extractImages(content: string | ContentPart[] | undefined): string[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (part.type !== 'image' || !part.source) return []
    if (part.source.type === 'base64' && part.source.data) {
      return [`data:${part.source.media_type || 'image/png'};base64,${part.source.data}`]
    }
    return part.source.url ? [part.source.url] : []
  })
}

// --- Strip XML wrappers from user queries ---

function cleanUserText(text: string): string {
  let result = text
  // Strip <user_query> wrapper
  const match = result.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/)
  if (match) result = match[1].trim()
  // Strip leading [Image] / [Image #N] references (actual images follow as separate data)
  result = result.replace(/^\[Image(?:\s*#\d+)?\]\s*/g, '')
  return result.trim()
}

// --- Build summary ---

export async function buildCursorSessionSummary(filePath: string, sessionIdOverride?: string): Promise<SessionSummary | null> {
  const lines = await parseCursorFile(filePath)
  if (lines.length === 0) return null

  const sessionId = sessionIdOverride || extractSessionId(filePath)
  const workspace = resolveCursorWorkspace(filePath, lines)
  const rawMessages = cursorToRawMessages(lines, sessionId, filePath, workspace.cwd)
  if (rawMessages.length === 0) return null

  const stat = fs.statSync(filePath)
  const cwds = workspace.cwd ? [workspace.cwd] : []

  const userMessages = rawMessages.filter((m) =>
    m.type === 'user' && m.message &&
    typeof m.message.content === 'string' && m.message.content.trim()
  )
  const assistantMessages = rawMessages.filter((m) =>
    m.type === 'assistant' && m.message
  )
  const turnCount = Math.min(userMessages.length, assistantMessages.length)

  let firstUserMessage = ''
  for (const m of userMessages) {
    const text = typeof m.message!.content === 'string' ? m.message!.content : ''
    const cleaned = cleanUserText(text)
    if (cleaned) { firstUserMessage = cleaned.slice(0, 200); break }
  }

  const allUserTexts: string[] = []
  let totalLen = 0
  const USER_TEXT_LIMIT = 2000
  for (const m of userMessages) {
    const text = typeof m.message!.content === 'string' ? cleanUserText(m.message!.content) : ''
    if (!text || text === firstUserMessage) continue
    if (totalLen + text.length > USER_TEXT_LIMIT) {
      allUserTexts.push(text.slice(0, USER_TEXT_LIMIT - totalLen))
      break
    }
    allUserTexts.push(text)
    totalLen += text.length
  }
  const allUserMessages = allUserTexts.length > 0 ? allUserTexts.join(' ') : undefined

  const toolUsage: Record<string, number> = {}
  for (const m of rawMessages) {
    if (m.type === 'assistant' && m.message && Array.isArray(m.message.content)) {
      for (const tc of extractToolCalls(m.message.content)) {
        toolUsage[tc.name] = (toolUsage[tc.name] || 0) + 1
      }
    }
  }

  const tokenAccounting = unavailableTokenAccounting(
    'cursor',
    'Local Cursor transcripts do not expose authoritative token usage'
  )
  const totalTokenUsage = tokenUsageFromAccounting(tokenAccounting)
  const activityDays = activityDaysFromTimestamps(lines.map((line) => line.timestamp))

  return {
    id: `cursor:${sessionId}`,
    sessionId,
    slug: '',
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    activityDays,
    messageCount: rawMessages.length,
    turnCount,
    compactCount: 0,
    cwds,
    version: '',
    firstUserMessage,
    toolUsage,
    skillInvocations: [],
    projectPath: path.dirname(filePath),
    filePath,
    fileSizeBytes: stat.size,
    permissionMode: undefined,
    resumeCwd: workspace.cwd || undefined,
    ...(workspace.cwd && workspace.provenance ? { cwdProvenance: workspace.provenance } : {}),
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: totalTokenUsage,
    tokenAccounting,
    providerOutcome: { detected: 'detected', parse: 'parsed', usage: 'unavailable' },
    referencedFiles: [],
    configFiles: [],
    source: 'cursor',
    allUserMessages
  }
}

export async function buildCursorSessionSummaryFromBackup(
  filePath: string,
  sessionIdOverride: string
): Promise<SessionSummary | null> {
  return buildCursorSessionSummary(filePath, sessionIdOverride)
}

// --- Build detail ---

export async function buildCursorSessionDetail(filePath: string, sessionIdOverride?: string): Promise<SessionDetail | null> {
  const summary = await buildCursorSessionSummary(filePath, sessionIdOverride)
  if (!summary) return null

  const lines = await parseCursorFile(filePath)
  const sessionId = sessionIdOverride || extractSessionId(filePath)
  const rawMessages = cursorToRawMessages(lines, sessionId, filePath, summary.resumeCwd || '')

  const messages: ParsedMessage[] = rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant')
    .map((m) => {
      const content = m.message?.content
      const isToolResult = Array.isArray(content) && (content as any[]).some((p) => p.type === 'tool_result')
      const textContent = extractText(content as string | ContentPart[] | undefined)
      const toolCalls = Array.isArray(content) ? extractToolCalls(content as ContentPart[]) : []

      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: undefined,
        timestamp: m.timestamp,
        role: m.message?.role,
        origin: 'unknown',
        textContent,
        toolCalls,
        images: extractImages(content as string | ContentPart[] | undefined),
        tokenUsage: undefined,
        isPreCompact: false,
        isSidechain: false,
        isSharedContext: false,
        isSystemGenerated: isToolResult,
        raw: m
      }
    })

  // Pair tool results with tool calls
  for (const m of rawMessages) {
    if (m.type !== 'user' || !m.message || !Array.isArray(m.message.content)) continue
    for (const part of m.message.content as any[]) {
      if ((part.type === 'tool_result') && part.tool_use_id && part.content) {
        const resultText = typeof part.content === 'string' ? part.content : ''
        for (const msg of messages) {
          const tc = msg.toolCalls.find((t) => t.id === part.tool_use_id)
          if (tc) { tc.result = resultText; break }
        }
      }
    }
  }

  return { ...summary, messages }
}
