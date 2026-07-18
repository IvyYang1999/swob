import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  SkillInvocation,
  ContentPart,
  FileAction,
  TokenUsage
} from './types'
import { findCodexSessionFiles, buildCodexSessionSummary, buildCodexSessionDetail, buildCodexSessionSummaryFromBackup } from './codex-loader'
import { findCursorSessionFiles, buildCursorSessionSummary, buildCursorSessionDetail, buildCursorSessionSummaryFromBackup } from './cursor-loader'
import { findOpencodeSessionFiles, buildOpencodeSessionSummary, buildOpencodeSessionDetail, buildOpencodeSessionSummaryFromBackup, stripOpencodeSessionRef } from './opencode-loader'
import { findZcodeSessionFiles, buildZcodeSessionSummary, buildZcodeSessionDetail, buildZcodeSessionSummaryFromBackup, stripZcodeSessionRef } from './zcode-loader'
import { estimateActiveTime } from './insights'
import { detectSessionSourceFromPath, detectSessionSourceForJsonl, sniffSessionSourceFromJsonl } from './session-source'

const HOME = process.env.HOME || ''

/**
 * True user message = type 'user' with real text content (not tool_result / task-notification).
 * Tool results have content as array of { type: 'tool_result' }.
 */
const SYSTEM_USER_MESSAGES = [
  'Continue from where you left off.',
  'Tool loaded.',
  'No response requested.'
]

const SYSTEM_USER_PREFIXES = [
  '<task-notification>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<user-prompt-submit-hook>',
  'Base directory for this skill:'
]

function isSystemText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return true
  if (SYSTEM_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true
  if (trimmed.startsWith('This session is being continued')) return true
  if (trimmed.startsWith('<system-reminder>') &&
    !trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()) return true
  // Pure [Image: source: ...] text (file path references alongside base64 images)
  if (/^\[Image: source: [^\]]+\](\s*\[Image: source: [^\]]+\])*\s*$/.test(trimmed)) return true
  return SYSTEM_USER_MESSAGES.includes(trimmed)
}

export function isRealUserMessage(m: RawJsonlMessage): boolean {
  if (m.type !== 'user' || !m.message) return false
  const c = m.message.content
  if (typeof c === 'string') {
    return !isSystemText(c)
  }
  if (Array.isArray(c)) {
    if (c.some((p) => p.type === 'tool_result')) return false
    // Extract all text parts, check if any is real user input
    const texts = c.filter((p) => p.type === 'text' && p.text).map((p) => p.text!)
    if (texts.length === 0) return false
    // If ALL text parts are system-generated, not a real message
    return texts.some((t) => !isSystemText(t))
  }
  return false
}

function getInitialSessionCwd(rawMessages: RawJsonlMessage[]): string | undefined {
  let earliest: { timestamp: string; cwd: string } | null = null
  for (const msg of rawMessages) {
    if (msg.isSidechain || !msg.cwd || !msg.timestamp) continue
    if (!earliest || msg.timestamp < earliest.timestamp) {
      earliest = { timestamp: msg.timestamp, cwd: msg.cwd }
    }
  }
  return earliest?.cwd
}

// --- Disk Cache for Session Summaries ---
const CACHE_DIR = path.join(HOME, '.claude-session-manager')
const CACHE_FILE = path.join(CACHE_DIR, 'summary-cache.json')
const CACHE_VERSION = 19 // per-file summaries + lineage metadata

type CachedSessionSource = 'claude-code' | 'codex' | 'cursor' | 'opencode' | 'zcode'

export interface CachedLineageMeta {
  /** Bump independently of the disk-cache version when compacted lineage fields change. */
  lineageFormatVersion: 2
  uuids: string[]
  firstParentUuid?: string
  // Compact message references, not the full JSONL records. These retain exactly the
  // fields used by clustering and light-summary rebuilding while dropping bulky
  // tool payloads, results, images, and other detail-only data.
  leafUuidRefs: RawJsonlMessage[]
  forkedFrom?: { sessionId: string; messageUuid: string }
  startTime: string
  endTime: string
  cwd?: string
  sessionId: string
}

interface PerFileCache {
  summary: SessionSummary | null
  lineageMeta: CachedLineageMeta
  source: CachedSessionSource
}

interface DiskCacheEntry {
  sig: string
  perFile: PerFileCache
}

interface DiskCache {
  version: number
  entries: Record<string, DiskCacheEntry>
}

function loadDiskCache(): DiskCache | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
      if (data.version === CACHE_VERSION && data.entries && typeof data.entries === 'object') return data
    }
  } catch { /* corrupt cache */ }
  return null
}

function saveDiskCache(entries: Record<string, DiskCacheEntry>): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
    const tempFile = `${CACHE_FILE}.tmp`
    fs.writeFileSync(tempFile, JSON.stringify({ version: CACHE_VERSION, entries }))
    fs.renameSync(tempFile, CACHE_FILE)
  } catch { /* ignore */ }
}

function computeFileSig(filePath: string, source: CachedSessionSource): string | null {
  try {
    const statPath = source === 'opencode'
      ? stripOpencodeSessionRef(filePath)
      : source === 'zcode'
        ? stripZcodeSessionRef(filePath)
        : filePath
    const stat = fs.statSync(statPath)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return null
  }
}

// --- Parallel Helper ---
async function parallelForEach<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const i = idx++
      await fn(items[i])
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  )
}

/**
 * Discover config files that would have been loaded for a session.
 * Claude Code loads CLAUDE.md from multiple levels:
 * 1. Global: ~/.claude/CLAUDE.md
 * 2. User-private project: ~/.claude/projects/<encoded-path>/CLAUDE.md
 * 3. Project root: <project>/.claude/CLAUDE.md and <project>/CLAUDE.md
 * 4. Settings: ~/.claude/settings.json, <project>/.claude/settings.json
 */
function discoverConfigFiles(cwds: string[], sessionProjectPath: string): string[] {
  const found: string[] = []
  const checked = new Set<string>()

  function check(p: string): void {
    if (checked.has(p)) return
    checked.add(p)
    if (fs.existsSync(p)) found.push(p)
  }

  // 1. User-private project config (same dir as the JSONL files)
  check(path.join(sessionProjectPath, 'CLAUDE.md'))
  check(path.join(sessionProjectPath, 'settings.json'))
  check(path.join(sessionProjectPath, 'memory', 'MEMORY.md'))

  // 2. Decode project root from sessionProjectPath dir name
  // e.g. ~/.claude/projects/-Users-yytyyf-newone/ → /Users/yytyyf/newone
  const encodedName = path.basename(sessionProjectPath)
  const decodedRoot = encodedName.replace(/^-/, '/').replace(/-/g, '/')
  // Skip if decodedRoot is HOME itself (would pick up global config)
  if (decodedRoot && decodedRoot !== '/' && decodedRoot !== HOME) {
    check(path.join(decodedRoot, 'CLAUDE.md'))
    check(path.join(decodedRoot, '.claude', 'CLAUDE.md'))
    check(path.join(decodedRoot, '.claude', 'settings.json'))
    check(path.join(decodedRoot, '.claude', 'settings.local.json'))
  }

  // 3. Walk up from each cwd to find project-level CLAUDE.md
  for (const cwd of cwds) {
    let dir = cwd
    const limit = 10
    for (let i = 0; i < limit && dir !== '/' && dir !== HOME; i++) {
      check(path.join(dir, 'CLAUDE.md'))
      check(path.join(dir, '.claude', 'CLAUDE.md'))
      if (i === 0) {
        check(path.join(dir, '.claude', 'settings.json'))
      }
      dir = path.dirname(dir)
    }
  }

  return found
}

function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

export function findClaudeProjectRoots(home = HOME): string[] {
  const roots: string[] = []
  const standardRoot = path.join(home, '.claude', 'projects')
  if (isDirectory(standardRoot)) roots.push(standardRoot)

  const claudeWindowRoot = path.join(home, '.claude-window')
  if (!isDirectory(claudeWindowRoot)) return roots

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(claudeWindowRoot, { withFileTypes: true })
  } catch {
    return roots
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const projectsRoot = path.join(claudeWindowRoot, entry.name, 'projects')
    if (isDirectory(projectsRoot)) roots.push(projectsRoot)
  }

  return roots
}

export function findSessionFilesInProjectRoots(projectRoots: string[]): string[] {
  const files = new Set<string>()

  for (const root of projectRoots) {
    let projects: fs.Dirent[]
    try {
      projects = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const proj of projects) {
      if (!proj.isDirectory()) continue
      const projDir = path.join(root, proj.name)
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(projDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.add(path.join(projDir, entry.name))
        }
      }
    }
  }

  return [...files]
}

export function getClaudeConfigDirForSessionFile(filePath: string, home = HOME): string | undefined {
  const claudeWindowRoot = path.resolve(home, '.claude-window')
  const rel = path.relative(claudeWindowRoot, path.resolve(filePath))
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined

  const parts = rel.split(path.sep)
  if (parts.length >= 3 && parts[0] && parts[1] === 'projects') {
    return path.join(claudeWindowRoot, parts[0])
  }

  return undefined
}

export function findAllSessionFiles(): string[] {
  return findSessionFilesInProjectRoots(findClaudeProjectRoots())
}

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

function extractToolResultText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((p) => {
      if (p.type === 'text' && p.text) return p.text
      if (typeof p === 'string') return p
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Extract base64 images as data URLs from message content */
function extractImages(content: string | ContentPart[] | undefined): string[] {
  if (!content || typeof content === 'string') return []
  const images: string[] = []
  for (const p of content) {
    if (p.type === 'image' && p.source?.type === 'base64' && p.source.data && p.source.media_type) {
      images.push(`data:${p.source.media_type};base64,${p.source.data}`)
    }
    // Also check inside tool_result content blocks
    if (p.type === 'tool_result' && Array.isArray(p.content)) {
      for (const sub of p.content) {
        if (typeof sub === 'object' && sub.type === 'image' && sub.source?.type === 'base64' && sub.source.data && sub.source.media_type) {
          images.push(`data:${sub.source.media_type};base64,${sub.source.data}`)
        }
      }
    }
  }
  return images
}

/** Extract token usage from API response */
function extractTokenUsage(msg: RawJsonlMessage): TokenUsage | undefined {
  const u = msg.message?.usage
  if (!u) return undefined
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0
  }
}

function extractSkillInvocations(toolCalls: ToolCallInfo[], timestamp: string): SkillInvocation[] {
  return toolCalls
    .filter((t) => t.name === 'Skill')
    .map((t) => ({
      skillName: (t.input.skill as string) || 'unknown',
      timestamp,
      args: t.input.args as string | undefined
    }))
}

export async function parseSessionFile(filePath: string): Promise<RawJsonlMessage[]> {
  const messages: RawJsonlMessage[] = []
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      rl.close()
      stream.destroy()
      resolve(messages)
    }, 30_000) // 30s timeout for large files or iCloud downloads

    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        messages.push(JSON.parse(line))
      } catch {
        // skip malformed lines
      }
    })

    rl.on('close', () => {
      clearTimeout(timeout)
      resolve(messages)
    })

    rl.on('error', () => {
      clearTimeout(timeout)
      resolve(messages)
    })
  })
}

export function buildSessionSummary(
  filePath: string,
  rawMessages: RawJsonlMessage[],
  light = false,
  sessionIdOverride?: string
): SessionSummary | null {
  if (filePath.includes('/subagents/')) return null

  const validMessages = rawMessages.filter(
    (m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system'
  )
  if (validMessages.length === 0) return null

  const sessionId = sessionIdOverride || resolvePhysicalSessionId(filePath, rawMessages)
  if (!sessionId) return null

  // Separate main chain and sidechain messages
  const mainChainMessages = rawMessages.filter((m) => !m.isSidechain)

  const cwds = [...new Set(rawMessages.map((m) => m.cwd).filter(Boolean) as string[])]
  const versions = [...new Set(rawMessages.map((m) => m.version).filter(Boolean) as string[])]
  const initialCwd = getInitialSessionCwd(rawMessages)
  const claudeConfigDir = getClaudeConfigDirForSessionFile(filePath, process.env.HOME || HOME)
  const latestPermissionMode = [...rawMessages].reverse().find((m) => m.permissionMode)?.permissionMode
  const latestVersion = [...rawMessages].reverse().find((m) => m.version)?.version
  // Use main chain timestamps for updatedAt (sidechain messages are rejected branches)
  const mainTimestamps = mainChainMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const allTimestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const timestamps = mainTimestamps.length > 0 ? mainTimestamps : allTimestamps

  const realUserMsgCount = validMessages.filter(isRealUserMessage).length
  const assistantMsgCount = validMessages.filter((m) => m.type === 'assistant').length
  const turnCount = Math.min(realUserMsgCount, assistantMsgCount)

  const compactCount = rawMessages.filter(
    (m) => m.type === 'system' && m.subtype === 'compact_boundary'
  ).length

  // Find first meaningful user message (skip interruptions, compact summaries, and synthetic command output)
  const skipPrefixes = ['[Request interrupted', 'This session is being continued']
  const firstUser = validMessages.find((m) => {
    if (m.type !== 'user') return false
    const text = m.message ? extractText(m.message.content).trim() : ''
    return text.length > 0 && !isSystemText(text) && !skipPrefixes.some((p) => text.startsWith(p))
  })
  let firstUserMessage = ''
  if (firstUser?.message) {
    firstUserMessage = extractText(firstUser.message.content).slice(0, 200)
  } else {
    const aiTitle = rawMessages.find((m) => (m as any).type === 'ai-title' && (m as any).aiTitle)
    firstUserMessage = ((aiTitle as any)?.aiTitle || sessionId).slice(0, 200)
  }

  const allUserTexts: string[] = []
  let totalLen = 0
  const USER_TEXT_LIMIT = 2000
  for (const m of validMessages) {
    if (m.type !== 'user' || !m.message) continue
    const text = extractText(m.message.content).trim()
    if (!text || isSystemText(text) || text === firstUserMessage) continue
    if (totalLen + text.length > USER_TEXT_LIMIT) {
      allUserTexts.push(text.slice(0, USER_TEXT_LIMIT - totalLen))
      break
    }
    allUserTexts.push(text)
    totalLen += text.length
  }
  const allUserMessages = allUserTexts.length > 0 ? allUserTexts.join(' ') : undefined

  // Accumulate token usage across all assistant messages
  const totalTokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
  let pastedImageCount = 0
  for (const msg of rawMessages) {
    if (msg.type === 'assistant' && msg.message?.usage) {
      const u = msg.message.usage
      totalTokenUsage.inputTokens += u.input_tokens || 0
      totalTokenUsage.outputTokens += u.output_tokens || 0
      totalTokenUsage.cacheCreationTokens += u.cache_creation_input_tokens || 0
      totalTokenUsage.cacheReadTokens += u.cache_read_input_tokens || 0
    }
    if (msg.type === 'user' && msg.message && Array.isArray(msg.message.content)) {
      for (const p of msg.message.content) {
        if (typeof p === 'object' && p.type === 'image' && (p as ContentPart).source?.type === 'base64') pastedImageCount++
      }
    }
  }

  // Light mode: skip expensive operations (tool extraction, file I/O, config discovery)
  if (light) {
    const stat = fs.statSync(filePath)
    return {
      id: sessionId,
      sessionId,
      resumeSessionId: sessionId,
      slug: rawMessages.find((m) => m.slug)?.slug || '',
      createdAt: timestamps[0] || '',
      updatedAt: timestamps[timestamps.length - 1] || '',
      messageCount: validMessages.length,
      turnCount,
      compactCount,
      cwds,
      version: latestVersion || versions[0] || '',
      firstUserMessage,
      toolUsage: {},
      skillInvocations: [],
      projectPath: path.dirname(filePath),
      filePath,
      fileSizeBytes: stat.size,
      permissionMode: latestPermissionMode,
      resumeCwd: initialCwd,
      userImages: [],
      pastedImageCount,
      tokenUsage: totalTokenUsage,
      referencedFiles: [],
      configFiles: [],
      source: 'claude-code',
      claudeConfigDir,
      allUserMessages,
      estimatedTime: estimateActiveTime(validMessages),
      models: [...new Set(rawMessages.map(m => m.message?.model).filter(Boolean) as string[])]
    }
  }

  const toolUsage: Record<string, number> = {}
  const skillInvocations: SkillInvocation[] = []

  for (const msg of rawMessages) {
    if (msg.type === 'assistant' && msg.message) {
      const tools = extractToolCalls(msg.message.content)
      for (const t of tools) {
        toolUsage[t.name] = (toolUsage[t.name] || 0) + 1
      }
      skillInvocations.push(...extractSkillInvocations(tools, msg.timestamp))
    }
  }

  let claudeMdContent: string | undefined
  // Track file actions: path → set of actions
  const fileActions = new Map<string, Set<FileAction>>()

  function addFileAction(fp: string, action: FileAction): void {
    if (!fp.startsWith('/')) return
    if (!fileActions.has(fp)) fileActions.set(fp, new Set())
    fileActions.get(fp)!.add(action)
  }

  for (const msg of rawMessages) {
    if (msg.type === 'system' && msg.message) {
      const text = extractText(msg.message.content)
      if (text.includes('claudeMd') || text.includes('CLAUDE.md')) {
        const match = text.match(/Contents of.*?CLAUDE\.md.*?:\n([\s\S]*?)(?:\n\nContents of|\n<\/|$)/)
        if (match) claudeMdContent = match[1].trim()
      }
    }

    // Extract user images from [Image: source: /path] patterns
    if (msg.type === 'user' && msg.message) {
      const content = msg.message.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && part.text) {
            const imgMatches = part.text.matchAll(/\[Image: source: ([^\]]+)\]/g)
            for (const m of imgMatches) {
              addFileAction(m[1].trim(), 'user-image')
            }
          }
        }
      }
    }

    // Extract file paths from tool calls with action type
    if (msg.type === 'assistant' && msg.message) {
      const tools = extractToolCalls(msg.message.content)
      for (const t of tools) {
        const fp = t.input.file_path as string | undefined
        if (fp) {
          if (t.name === 'Write') addFileAction(fp, 'write')
          else if (t.name === 'Edit') addFileAction(fp, 'edit')
          else if (t.name === 'Read') addFileAction(fp, 'read')
        }
      }
    }
  }

  // Build FileRef array with existence check
  const userImages = [...fileActions.entries()]
    .filter(([, actions]) => actions.has('user-image'))
    .map(([p]) => p)

  const referencedFiles = [...fileActions.entries()]
    .filter(([, actions]) => {
      // Exclude files that are ONLY read (too noisy)
      // Keep: written, edited, or user-uploaded
      return actions.has('write') || actions.has('edit') || actions.has('user-image')
        || (actions.has('read') && actions.size > 1)
    })
    .map(([p, actions]) => ({
      path: p,
      actions: [...actions],
      exists: fs.existsSync(p)
    }))
    .sort((a, b) => {
      // Sort: existing first, then by action priority (write > edit > read)
      if (a.exists !== b.exists) return a.exists ? -1 : 1
      const priority = (f: typeof a) =>
        f.actions.includes('write') ? 0 : f.actions.includes('edit') ? 1 : 2
      return priority(a) - priority(b)
    })

  // Discover config files from filesystem based on cwds and projectPath
  const configFiles = discoverConfigFiles(cwds, path.dirname(filePath))

  const stat = fs.statSync(filePath)
  const projectPath = path.dirname(filePath)

  return {
    id: sessionId,
    sessionId,
    resumeSessionId: sessionId,
    slug: rawMessages.find((m) => m.slug)?.slug || '',
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    messageCount: validMessages.length,
    turnCount,
    compactCount,
    cwds,
    version: latestVersion || versions[0] || '',
    firstUserMessage,
    toolUsage,
    skillInvocations,
    claudeMdContent,
    projectPath,
    filePath,
    fileSizeBytes: stat.size,
    permissionMode: latestPermissionMode,
    resumeCwd: initialCwd,
    userImages: [...userImages],
    pastedImageCount,
    tokenUsage: totalTokenUsage,
    referencedFiles: [...referencedFiles],
    configFiles,
    source: 'claude-code',
    claudeConfigDir,
    allUserMessages,
    estimatedTime: estimateActiveTime(validMessages),
    models: [...new Set(rawMessages.map(m => m.message?.model).filter(Boolean) as string[])]
  }
}

export function buildSessionDetail(
  filePath: string,
  rawMessages: RawJsonlMessage[],
  sessionIdOverride?: string
): SessionDetail | null {
  const summary = buildSessionSummary(filePath, rawMessages, false, sessionIdOverride)
  if (!summary) return null

  const compactIndices = rawMessages
    .map((m, i) => (m.type === 'system' && m.subtype === 'compact_boundary' ? i : -1))
    .filter((i) => i >= 0)

  const lastCompactIndex = compactIndices.length > 0 ? compactIndices[compactIndices.length - 1] : -1

  const messages: ParsedMessage[] = rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
    .map((m) => {
      const originalIndex = rawMessages.indexOf(m)
      const toolCalls = m.message ? extractToolCalls(m.message.content) : []
      const textContent = m.message ? extractText(m.message.content) : (m as any).content || ''
      // Detect system-injected messages masquerading as user messages
      const trimmed = textContent.trimStart()
      const isTaskNotification = m.type === 'user' && trimmed.startsWith('<task-notification>')
      const isSkillOutput = m.type === 'user' && trimmed.startsWith('Base directory for this skill:')
      const isCommandOutput = m.type === 'user' && /^<(?:local-command-stdout|local-command-caveat|user-prompt-submit-hook|command-name)>/.test(trimmed)
      const isSystemReminder = m.type === 'user' && trimmed.startsWith('<system-reminder>') &&
        !trimmed.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()
      const detectedSubtype = isTaskNotification ? 'task-notification'
        : isSkillOutput ? 'skill-output'
        : isCommandOutput ? 'command-output'
        : isSystemReminder ? 'system-reminder'
        : m.subtype
      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: detectedSubtype,
        timestamp: m.timestamp,
        role: m.message?.role,
        textContent,
        toolCalls,
        images: m.message ? extractImages(m.message.content) : [],
        tokenUsage: m.type === 'assistant' ? extractTokenUsage(m) : undefined,
        isPreCompact: lastCompactIndex >= 0 && originalIndex < lastCompactIndex,
        isSidechain: !!m.isSidechain,
        isSharedContext: false,
        isSystemGenerated: m.type === 'user' && !isRealUserMessage(m),
        raw: m
      }
    })

  // Pair tool results with tool calls
  for (let i = 0; i < rawMessages.length; i++) {
    const raw = rawMessages[i]
    if (raw.type !== 'user' || !raw.message) continue
    const content = raw.message.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part.type === 'tool_result' && part.tool_use_id && part.content) {
        const resultText = extractToolResultText(part.content)
        if (!resultText) continue
        // Find the matching tool call in any preceding assistant message
        for (const msg of messages) {
          const tc = msg.toolCalls.find((t) => t.id === part.tool_use_id)
          if (tc) {
            tc.result = resultText
            break
          }
        }
      }
    }
  }

  return { ...summary, messages }
}

interface FileEntry {
  filePath: string
  raw: RawJsonlMessage[]
  startTime: string
  endTime: string
}

function getFileTimeRange(raw: RawJsonlMessage[]): { start: string; end: string } {
  const timestamps = raw.map((m) => m.timestamp).filter(Boolean).sort()
  return { start: timestamps[0] || '', end: timestamps[timestamps.length - 1] || '' }
}

function compactLineageContent(content: string | ContentPart[] | undefined): string | ContentPart[] {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap((part): ContentPart[] => {
    if (part.type === 'text') return [{ type: 'text', text: part.text || '' }]
    if (part.type === 'tool_result') return [{ type: 'tool_result' }]
    if (part.type === 'image' && part.source?.type === 'base64') {
      return [{ type: 'image', source: { type: 'base64' } }]
    }
    return []
  })
}

/** Keep the data used by lineage and light summaries, excluding detail-only payloads. */
function compactLineageMessage(message: RawJsonlMessage): RawJsonlMessage {
  const compact: RawJsonlMessage = {
    uuid: message.uuid,
    parentUuid: message.parentUuid,
    sessionId: message.sessionId,
    type: message.type,
    timestamp: message.timestamp
  }
  if (message.logicalParentUuid !== undefined) compact.logicalParentUuid = message.logicalParentUuid
  if (message.subtype !== undefined) compact.subtype = message.subtype
  if (message.cwd !== undefined) compact.cwd = message.cwd
  if (message.version !== undefined) compact.version = message.version
  if (message.slug !== undefined) compact.slug = message.slug
  if (message.isSidechain !== undefined) compact.isSidechain = message.isSidechain
  if (message.permissionMode !== undefined) compact.permissionMode = message.permissionMode
  if (message.forkedFrom !== undefined) compact.forkedFrom = message.forkedFrom
  if (message.leafUuid !== undefined) compact.leafUuid = message.leafUuid
  if (message.message) {
    compact.message = {
      role: message.message.role,
      model: message.message.model,
      // Assistant prose/tool payloads do not participate in lineage or light
      // summaries; their count/model/usage do, and are retained separately.
      content: message.type === 'assistant' ? '' : compactLineageContent(message.message.content),
      usage: message.message.usage
    }
  }
  const aiTitle = (message as RawJsonlMessage & { aiTitle?: string }).aiTitle
  if (aiTitle !== undefined) (compact as RawJsonlMessage & { aiTitle?: string }).aiTitle = aiTitle
  return compact
}

function buildLineageMeta(filePath: string, raw: RawJsonlMessage[]): CachedLineageMeta {
  const { start, end } = getFileTimeRange(raw)
  const sessionId = resolvePhysicalSessionId(filePath, raw) || ''
  return {
    lineageFormatVersion: 2,
    uuids: raw.map((message) => message.uuid).filter(Boolean),
    firstParentUuid: raw.find(
      (message) => message.parentUuid && (message.type === 'user' || message.type === 'assistant')
    )?.parentUuid || undefined,
    leafUuidRefs: raw.map(compactLineageMessage),
    forkedFrom: raw.find((message) => message.forkedFrom)?.forkedFrom,
    startTime: start,
    endTime: end,
    cwd: getInitialSessionCwd(raw),
    sessionId
  }
}

function emptyLineageMeta(summary: SessionSummary | null): CachedLineageMeta {
  return {
    lineageFormatVersion: 2,
    uuids: [],
    leafUuidRefs: [],
    startTime: summary?.createdAt || '',
    endTime: summary?.updatedAt || '',
    cwd: summary?.resumeCwd || summary?.cwds[0],
    sessionId: summary?.sessionId || ''
  }
}

/**
 * Detect intra-file branches: conversation threads that diverge within the same JSONL file.
 * Supports nested branches (branch of a branch) and parallel branches (multiple forks from same point).
 * Returns a flat list with parent-child relationships (like git commits).
 */
interface IntraBranch {
  branchIdx: number // stable index for ID generation
  branchPointUuid: string
  leafUuid: string
  firstUserMessage: string
  createdAt: string
  updatedAt: string
  turnCount: number
  messageCount: number
  parentIdx: number // -1 = main, otherwise index into branches array
  childIdxs: number[]
  path: string[] // full path from root to leaf
}

export function detectIntraFileBranches(raw: RawJsonlMessage[]): IntraBranch[] {
  const MIN_UNIQUE_TURNS = 1 // any divergence with at least 1 user message counts
  const skipPrefixes = ['[Request interrupted', 'This session is being continued']

  // Build uuid → index and children map
  const uuidToIdx = new Map<string, number>()
  const childrenOf = new Map<string, number[]>()
  for (let i = 0; i < raw.length; i++) {
    const u = raw[i].uuid
    const p = raw[i].parentUuid
    if (u) uuidToIdx.set(u, i)
    if (p) {
      if (!childrenOf.has(p)) childrenOf.set(p, [])
      childrenOf.get(p)!.push(i)
    }
  }

  // Find all leaf uuids
  const allUuids = new Set<string>()
  for (const m of raw) { if (m.uuid) allUuids.add(m.uuid) }
  const leafUuids = [...allUuids].filter((u) => !childrenOf.has(u))
  if (leafUuids.length <= 1) return []

  function traceToRoot(uuid: string): string[] {
    const path: string[] = []
    const visited = new Set<string>()
    let current: string | null | undefined = uuid
    while (current && !visited.has(current)) {
      visited.add(current)
      if (uuidToIdx.has(current)) path.push(current)
      const idx = uuidToIdx.get(current)
      if (idx === undefined) break
      const msg = raw[idx]
      // Follow parentUuid normally; at compact_boundary, cross via logicalParentUuid
      if (msg.parentUuid) {
        current = msg.parentUuid
      } else if (msg.subtype === 'compact_boundary' && msg.logicalParentUuid) {
        current = msg.logicalParentUuid
      } else {
        break
      }
    }
    return path.reverse()
  }

  function getFirstUserMsg(uuids: string[]): string {
    for (const u of uuids) {
      const idx = uuidToIdx.get(u)
      if (idx === undefined) continue
      const m = raw[idx]
      if (m.type !== 'user' || !m.message) continue
      const text = typeof m.message.content === 'string'
        ? m.message.content
        : (m.message.content as any[])?.filter((p: any) => p.type === 'text' && p.text).map((p: any) => p.text).join('\n') || ''
      const trimmed = text.trim()
      if (trimmed.length > 0 && !skipPrefixes.some((p) => trimmed.startsWith(p))) return trimmed.slice(0, 200)
    }
    return ''
  }

  function countUserTurns(uuids: string[]): number {
    return uuids.filter((u) => {
      const idx = uuidToIdx.get(u)
      return idx !== undefined && isRealUserMessage(raw[idx])
    }).length
  }

  // Collect all leaf paths, group similar ones (same fork point + same first message)
  interface PathGroup {
    leaves: string[]
    path: string[] // longest representative path
  }

  const allPathGroups: PathGroup[] = []
  const leafToGroup = new Map<string, number>()

  // Build all paths and group by (forkPoint relative to longest, firstMsg)
  const allPaths = leafUuids.map((lu) => ({ leaf: lu, path: traceToRoot(lu) }))
  allPaths.sort((a, b) => b.path.length - a.path.length) // longest first

  // The longest path is the "main" branch
  const mainPath = allPaths[0].path
  const mainSet = new Set(mainPath)

  // Group remaining leaves: for each leaf, find its divergence from the closest known branch
  // Start simple: group by divergence from main
  const groupByKey = new Map<string, PathGroup>()

  for (const { leaf, path } of allPaths) {
    // Find divergence from main
    let commonLen = 0
    for (let i = 0; i < Math.min(mainPath.length, path.length); i++) {
      if (mainPath[i] === path[i]) commonLen++
      else break
    }
    const uniquePortion = path.slice(commonLen)
    if (uniquePortion.length === 0) {
      // Same as main (or subset) — belongs to main group
      continue
    }
    const firstMsg = getFirstUserMsg(uniquePortion)
    if (!firstMsg) continue
    const branchPointUuid = path[commonLen - 1] || ''
    const groupKey = `${branchPointUuid}:${firstMsg.slice(0, 60)}`

    if (!groupByKey.has(groupKey)) {
      groupByKey.set(groupKey, { leaves: [], path })
    }
    const g = groupByKey.get(groupKey)!
    g.leaves.push(leaf)
    if (path.length > g.path.length) g.path = path
  }

  // Filter to significant groups — require TEMPORAL INTERLEAVING with main path.
  // Real --resume branches have two terminals writing simultaneously: their messages
  // alternate in time (many M→B and B→M transitions when sorted by timestamp).
  // Retries are single-threaded: retry messages form a contiguous block, few transitions.
  const MIN_TRANSITIONS = 3 // 3 switches = both terminals produced interleaving messages
  for (const [, g] of groupByKey) {
    let commonLen = 0
    for (let i = 0; i < Math.min(mainPath.length, g.path.length); i++) {
      if (mainPath[i] === g.path[i]) commonLen++
      else break
    }
    if (commonLen === 0 || commonLen >= mainPath.length) continue
    if (countUserTurns(g.path.slice(commonLen)) < MIN_UNIQUE_TURNS) continue

    // Count interleaving transitions: sort messages by timestamp, count M↔B switches
    const combined: Array<{ side: 'M' | 'B'; ts: string }> = []
    for (const u of mainPath.slice(commonLen)) {
      const i = uuidToIdx.get(u)
      if (i !== undefined && raw[i].timestamp) combined.push({ side: 'M', ts: raw[i].timestamp })
    }
    for (const u of g.path.slice(commonLen)) {
      const i = uuidToIdx.get(u)
      if (i !== undefined && raw[i].timestamp) combined.push({ side: 'B', ts: raw[i].timestamp })
    }
    combined.sort((a, b) => a.ts.localeCompare(b.ts))

    let transitions = 0
    for (let i = 1; i < combined.length; i++) {
      if (combined[i].side !== combined[i - 1].side) transitions++
    }
    if (transitions < MIN_TRANSITIONS) continue

    allPathGroups.push(g)
  }

  if (allPathGroups.length === 0) return []

  // Now build the branch tree: for each pair of groups, determine parent-child
  // A branch B is a child of branch A if B's path diverges from A's path (not from main)
  // Sort groups by divergence point from main (earlier fork = higher in tree)

  interface BranchNode {
    groupIdx: number
    path: string[]
    forkFromMainIdx: number // index in mainPath where this diverges
    parentNode: number // -1 = main
    childNodes: number[]
  }

  const nodes: BranchNode[] = allPathGroups.map((g, gi) => {
    let forkIdx = 0
    for (let i = 0; i < Math.min(mainPath.length, g.path.length); i++) {
      if (mainPath[i] === g.path[i]) forkIdx = i + 1
      else break
    }
    return { groupIdx: gi, path: g.path, forkFromMainIdx: forkIdx, parentNode: -1, childNodes: [] }
  })

  // Determine parent-child: for each node, find the best parent
  // The parent is the node whose path contains the fork point of this node AND
  // shares the longest common prefix with this node
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const nodePath = node.path
    let bestParent = -1 // default: child of main
    let bestCommon = node.forkFromMainIdx // shared with main

    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue
      const other = nodes[j]
      // How much does this node share with the other?
      let commonLen = 0
      for (let k = 0; k < Math.min(nodePath.length, other.path.length); k++) {
        if (nodePath[k] === other.path[k]) commonLen++
        else break
      }
      // This node is a child of other if they share MORE than what node shares with main,
      // AND the divergence point is on the other's unique portion (not on main)
      if (commonLen > bestCommon && commonLen > other.forkFromMainIdx) {
        bestParent = j
        bestCommon = commonLen
      }
    }
    node.parentNode = bestParent
  }

  // Build child lists
  for (let i = 0; i < nodes.length; i++) {
    const parentIdx = nodes[i].parentNode
    if (parentIdx >= 0) nodes[parentIdx].childNodes.push(i)
  }

  // Convert to IntraBranch results
  const branches: IntraBranch[] = nodes.map((node, idx) => {
    const group = allPathGroups[node.groupIdx]
    const path = group.path

    // Find the divergence point: compare with parent's path
    const parentPath = node.parentNode >= 0 ? nodes[node.parentNode].path : mainPath
    let commonLen = 0
    for (let i = 0; i < Math.min(parentPath.length, path.length); i++) {
      if (parentPath[i] === path[i]) commonLen++
      else break
    }
    const branchPointUuid = path[commonLen - 1] || path[0]
    const uniquePortion = path.slice(commonLen)

    const firstUserMessage = getFirstUserMsg(uniquePortion)
    // Count turns across the FULL path (shared + unique) for accurate display
    const fullUserCount = countUserTurns(path)
    const fullAssistantCount = path.filter((u) => {
      const i = uuidToIdx.get(u)
      return i !== undefined && raw[i].type === 'assistant'
    }).length

    let createdAt = ''
    let updatedAt = ''
    for (const u of uniquePortion) {
      const i = uuidToIdx.get(u)
      if (i === undefined) continue
      const ts = raw[i].timestamp
      if (ts) { if (!createdAt) createdAt = ts; updatedAt = ts }
    }

    return {
      branchIdx: idx,
      branchPointUuid,
      leafUuid: group.leaves.reduce((best, lu) => traceToRoot(lu).length > traceToRoot(best).length ? lu : best),
      firstUserMessage,
      createdAt,
      updatedAt,
      turnCount: Math.min(fullUserCount, fullAssistantCount),
      messageCount: path.length,
      parentIdx: node.parentNode,
      childIdxs: node.childNodes,
      path
    }
  })

  return branches
}

/**
 * Given raw messages and a leaf uuid, return only the messages on the path
 * from root to that leaf (tracing parentUuid chain).
 */
export function filterMessagesByBranch(raw: RawJsonlMessage[], leafUuid: string): RawJsonlMessage[] {
  const uuidToIdx = new Map<string, number>()
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].uuid) uuidToIdx.set(raw[i].uuid, i)
  }

  // Trace from leaf to root, following logicalParentUuid through compact boundaries
  const pathUuids = new Set<string>()
  let current: string | null | undefined = leafUuid
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    if (uuidToIdx.has(current)) pathUuids.add(current)
    const idx = uuidToIdx.get(current)
    if (idx === undefined) break
    // Follow parentUuid; if null, try logicalParentUuid (crosses compact boundary)
    current = raw[idx].parentUuid || raw[idx].logicalParentUuid || undefined
  }

  return raw.filter((m) => pathUuids.has(m.uuid))
}

/**
 * Group files with the same sessionId into mergeable clusters.
 * Only merge files that are continuations (B starts after A ends).
 * Files that overlap in time (branches/subagents) stay separate.
 */
function clusterFilesForMerge(entries: FileEntry[]): FileEntry[][] {
  if (entries.length <= 1) return [entries]

  // Sort by start time
  entries.sort((a, b) => a.startTime.localeCompare(b.startTime))

  const clusters: FileEntry[][] = []
  const used = new Set<number>()

  for (let i = 0; i < entries.length; i++) {
    if (used.has(i)) continue

    const cluster = [entries[i]]
    used.add(i)

    // Try to chain: find next file that starts after current cluster ends
    let clusterEnd = entries[i].endTime

    for (let j = i + 1; j < entries.length; j++) {
      if (used.has(j)) continue

      // B is a continuation if it starts at or after A ends (within 1 second tolerance)
      const aEnd = new Date(clusterEnd).getTime()
      const bStart = new Date(entries[j].startTime).getTime()

      if (bStart >= aEnd - 1000) {
        // Continuation: B starts after A ends
        cluster.push(entries[j])
        used.add(j)
        clusterEnd = entries[j].endTime > clusterEnd ? entries[j].endTime : clusterEnd
      }
      // Otherwise: time overlap = branch, leave for separate cluster
    }

    clusters.push(cluster)
  }

  return clusters
}

interface SessionCluster {
  sessionId: string
  entries: FileEntry[]
  filePaths: string[]
  raw: RawJsonlMessage[]
  startTime: string
  endTime: string
  uuidSet: Set<string>
  branchSummaryId?: string
  branchParentFilePaths?: string[]
  branchPointUuid?: string
}

interface LogicalSessionCluster extends SessionCluster {
  continuationSessionIds: string[]
  coveredSessionIds: string[]
}

function getUuidSet(raw: RawJsonlMessage[]): Set<string> {
  const uuids = new Set<string>()
  for (const m of raw) {
    if (m.uuid) uuids.add(m.uuid)
  }
  return uuids
}

function getSessionIds(raw: RawJsonlMessage[]): string[] {
  return [...new Set(raw.map((m) => m.sessionId).filter(Boolean))]
}

const UUID_BASENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function resolvePhysicalSessionId(filePath: string, raw: RawJsonlMessage[]): string | null {
  const sessionIds = getSessionIds(raw)
  const fileStem = path.basename(filePath, path.extname(filePath))
  if (UUID_BASENAME_RE.test(fileStem) && sessionIds.includes(fileStem)) {
    return fileStem
  }

  const lastMainChainId = [...raw].reverse().find((m) => m.sessionId && !m.isSidechain)?.sessionId
  return lastMainChainId || [...raw].reverse().find((m) => m.sessionId)?.sessionId || null
}

function normalizePromptText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function getRealUserText(m: RawJsonlMessage): string {
  if (!isRealUserMessage(m) || !m.message) return ''
  return normalizePromptText(extractText(m.message.content))
}

function hasAssistantBetween(raw: RawJsonlMessage[], fromExclusive: number, toExclusive: number): boolean {
  for (let i = fromExclusive + 1; i < toExclusive; i++) {
    if (raw[i].type === 'assistant') return true
  }
  return false
}

function dedupeNearDuplicatePendingPrompts(raw: RawJsonlMessage[]): RawJsonlMessage[] {
  const lastByText = new Map<string, number>()
  const drop = new Set<number>()
  const TWO_MINUTES = 2 * 60 * 1000

  for (let i = 0; i < raw.length; i++) {
    const text = getRealUserText(raw[i])
    if (!text) continue

    const prevIdx = lastByText.get(text)
    if (prevIdx !== undefined && !drop.has(prevIdx)) {
      const prev = raw[prevIdx]
      const prevTs = prev.timestamp ? new Date(prev.timestamp).getTime() : Number.NaN
      const currTs = raw[i].timestamp ? new Date(raw[i].timestamp).getTime() : Number.NaN
      const closeInTime = Number.isFinite(prevTs) && Number.isFinite(currTs) && Math.abs(currTs - prevTs) <= TWO_MINUTES
      const differentPhysicalSession = prev.sessionId && raw[i].sessionId && prev.sessionId !== raw[i].sessionId
      if (closeInTime && differentPhysicalSession && !hasAssistantBetween(raw, prevIdx, i)) {
        drop.add(prevIdx)
      }
    }

    lastByText.set(text, i)
  }

  return raw.filter((_, idx) => !drop.has(idx))
}

function mergeRawMessages(rawMessages: RawJsonlMessage[]): RawJsonlMessage[] {
  const seenUuids = new Set<string>()
  const merged: RawJsonlMessage[] = []

  for (const m of rawMessages) {
    if (m.uuid) {
      if (seenUuids.has(m.uuid)) continue
      seenUuids.add(m.uuid)
    }
    merged.push(m)
  }

  return dedupeNearDuplicatePendingPrompts(merged)
}

function createSessionCluster(
  sessionId: string,
  entries: FileEntry[],
  branchSummaryId?: string,
  branchParentFilePaths?: string[],
  branchPointUuid?: string
): SessionCluster {
  const sortedEntries = [...entries].sort((a, b) => a.startTime.localeCompare(b.startTime))
  const raw = mergeRawMessages(sortedEntries.flatMap((g) => g.raw))
  const { start, end } = getFileTimeRange(raw)
  return {
    sessionId,
    entries: sortedEntries,
    filePaths: sortedEntries.map((g) => g.filePath),
    raw,
    startTime: start || sortedEntries[0]?.startTime || '',
    endTime: end || sortedEntries[sortedEntries.length - 1]?.endTime || '',
    uuidSet: getUuidSet(raw),
    branchSummaryId,
    branchParentFilePaths,
    branchPointUuid
  }
}

type BackupSummaryMeta = {
  sourceFilePaths?: string[]
}

export async function buildSessionSummaryFromBackup(
  backupPath: string,
  sessionIdOverride: string,
  meta?: BackupSummaryMeta
): Promise<SessionSummary | null> {
  const source = detectSessionSourceForJsonl(backupPath, meta?.sourceFilePaths || [])
  if (source === 'codex') return buildCodexSessionSummaryFromBackup(backupPath, sessionIdOverride)
  if (source === 'cursor') return buildCursorSessionSummaryFromBackup(backupPath, sessionIdOverride)
  if (source === 'opencode') return buildOpencodeSessionSummaryFromBackup(backupPath, sessionIdOverride)
  if (source === 'zcode') return buildZcodeSessionSummaryFromBackup(backupPath, sessionIdOverride)

  const raw = await parseSessionFile(backupPath)
  return buildSessionSummary(backupPath, raw, true, sessionIdOverride)
}

function readBackupSessionIdOverride(filePath: string): string | undefined {
  if (path.basename(filePath) !== 'backup.jsonl') return undefined
  try {
    const metaPath = path.join(path.dirname(filePath), '.swob-session.json')
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    return typeof meta.sessionId === 'string' ? meta.sessionId : undefined
  } catch {
    return undefined
  }
}

function buildInitialSessionClusters(filesBySession: Map<string, FileEntry[]>): SessionCluster[] {
  const initialClusters: SessionCluster[] = []

  for (const [sessionId, group] of filesBySession) {
    const clusters = clusterFilesForMerge(group)
    const clusterUuids: Set<string>[] = clusters.map((cluster) => {
      const uuids = new Set<string>()
      for (const entry of cluster) {
        for (const m of entry.raw) {
          if (m.uuid) uuids.add(m.uuid)
        }
      }
      return uuids
    })

    for (let ci = 0; ci < clusters.length; ci++) {
      let branchSummaryId: string | undefined
      let branchParentFilePaths: string[] | undefined
      let branchPointUuid: string | undefined

      if (clusters.length > 1) {
        branchSummaryId = `${sessionId}:branch-${ci}`

        const mergedRaw = mergeRawMessages(clusters[ci].flatMap((g) => g.raw))
        const firstParentUuid = mergedRaw.find(
          (m) => m.parentUuid && (m.type === 'user' || m.type === 'assistant')
        )?.parentUuid
        if (firstParentUuid) {
          for (let pi = 0; pi < clusters.length; pi++) {
            if (pi === ci) continue
            if (clusterUuids[pi].has(firstParentUuid)) {
              branchParentFilePaths = clusters[pi].map((g) => g.filePath)
              branchPointUuid = firstParentUuid
              break
            }
          }
        }
      }

      initialClusters.push(createSessionCluster(
        sessionId,
        clusters[ci],
        branchSummaryId,
        branchParentFilePaths,
        branchPointUuid
      ))
    }
  }

  return initialClusters
}

function findContinuationAnchor(raw: RawJsonlMessage[]): string | null {
  const uuidMessages = raw.filter((m) => m.uuid).slice(0, 30)
  for (let i = 0; i < uuidMessages.length; i++) {
    const m = uuidMessages[i]
    if (m.type !== 'system' || m.subtype !== 'compact_boundary' || !m.uuid) continue
    const hasContinuationSummary = uuidMessages.slice(i + 1, i + 5).some((next) => {
      if (next.type !== 'user' || !next.message) return false
      return extractText(next.message.content).trim().startsWith('This session is being continued')
    })
    if (hasContinuationSummary) return m.uuid
  }
  return null
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const u of a) {
    if (b.has(u)) count++
  }
  return count
}

function createsContinuationCycle(childIdx: number, parentIdx: number, childToParent: Map<number, number>): boolean {
  let current: number | undefined = parentIdx
  while (current !== undefined) {
    if (current === childIdx) return true
    current = childToParent.get(current)
  }
  return false
}

function findContinuationParentIdx(childIdx: number, clusters: SessionCluster[]): number | null {
  const child = clusters[childIdx]
  const anchorUuid = findContinuationAnchor(child.raw)
  if (!anchorUuid) return null
  if (child.uuidSet.size === 0) return null

  let best: { idx: number; overlap: number; ratio: number } | null = null
  for (let i = 0; i < clusters.length; i++) {
    if (i === childIdx) continue
    const parent = clusters[i]
    if (parent.sessionId === child.sessionId) continue
    if (!parent.uuidSet.has(anchorUuid)) continue

    const overlap = countOverlap(child.uuidSet, parent.uuidSet)
    const ratio = overlap / child.uuidSet.size
    if (overlap < 8 || ratio < 0.7) continue
    if (!best || overlap > best.overlap || (overlap === best.overlap && ratio > best.ratio)) {
      best = { idx: i, overlap, ratio }
    }
  }

  return best?.idx ?? null
}

function buildLogicalSessionClusters(initialClusters: SessionCluster[]): LogicalSessionCluster[] {
  const childToParent = new Map<number, number>()
  const childrenByParent = new Map<number, number[]>()

  for (let childIdx = 0; childIdx < initialClusters.length; childIdx++) {
    const parentIdx = findContinuationParentIdx(childIdx, initialClusters)
    if (parentIdx === null) continue
    if (createsContinuationCycle(childIdx, parentIdx, childToParent)) continue

    childToParent.set(childIdx, parentIdx)
    if (!childrenByParent.has(parentIdx)) childrenByParent.set(parentIdx, [])
    childrenByParent.get(parentIdx)!.push(childIdx)
  }

  function collectDescendants(idx: number, out: number[]): void {
    const children = childrenByParent.get(idx) || []
    children.sort((a, b) => initialClusters[a].startTime.localeCompare(initialClusters[b].startTime))
    for (const child of children) {
      out.push(child)
      collectDescendants(child, out)
    }
  }

  const logical: LogicalSessionCluster[] = []
  for (let idx = 0; idx < initialClusters.length; idx++) {
    if (childToParent.has(idx)) continue

    const descendantIdxs: number[] = []
    collectDescendants(idx, descendantIdxs)
    const parts = [idx, ...descendantIdxs].map((partIdx) => initialClusters[partIdx])
    const root = initialClusters[idx]
    const raw = mergeRawMessages(parts.flatMap((p) => p.raw))
    const { start, end } = getFileTimeRange(raw)
    const filePaths = [...new Set(parts.flatMap((p) => p.filePaths))]
    const coveredSessionIds = [...new Set(parts.flatMap((p) => getSessionIds(p.raw)))]
    const continuationSessionIds = coveredSessionIds.filter((sid) => sid !== root.sessionId)

    logical.push({
      ...root,
      entries: parts.flatMap((p) => p.entries),
      filePaths,
      raw,
      startTime: start || root.startTime,
      endTime: end || root.endTime,
      uuidSet: getUuidSet(raw),
      continuationSessionIds,
      coveredSessionIds
    })
  }

  return logical
}

function latestSharedUuid(a: SessionCluster, b: SessionCluster): string | null {
  let best: { uuid: string; ts: string } | null = null
  const aByUuid = new Map<string, RawJsonlMessage>()
  for (const m of a.raw) {
    if (m.uuid) aByUuid.set(m.uuid, m)
  }

  for (const m of b.raw) {
    if (!m.uuid || !aByUuid.has(m.uuid)) continue
    const ts = m.timestamp || aByUuid.get(m.uuid)?.timestamp || ''
    if (!best || ts > best.ts) best = { uuid: m.uuid, ts }
  }

  return best?.uuid || null
}

function uniqueRealUserTextsAfter(cluster: SessionCluster, otherUuids: Set<string>, branchPointUuid: string): string[] {
  let afterBranchPoint = false
  const texts: string[] = []
  const seen = new Set<string>()

  for (const m of cluster.raw) {
    if (m.uuid === branchPointUuid) {
      afterBranchPoint = true
      continue
    }
    if (!afterBranchPoint) continue
    if (m.uuid && otherUuids.has(m.uuid)) continue
    const text = getRealUserText(m)
    if (!text || seen.has(text)) continue
    seen.add(text)
    texts.push(text)
  }

  return texts
}

function hasMaterialUserTailDivergence(
  child: LogicalSessionCluster,
  parent: LogicalSessionCluster,
  branchPointUuid: string
): boolean {
  const childTexts = uniqueRealUserTextsAfter(child, parent.uuidSet, branchPointUuid)
  const parentTexts = uniqueRealUserTextsAfter(parent, child.uuidSet, branchPointUuid)
  if (childTexts.length === 0 || parentTexts.length === 0) return false

  const childSet = new Set(childTexts)
  const parentSet = new Set(parentTexts)
  return childTexts.some((t) => !parentSet.has(t)) && parentTexts.some((t) => !childSet.has(t))
}

function canBeCrossSessionBranchParent(
  parent: { summary: SessionSummary; cluster: LogicalSessionCluster },
  child: { summary: SessionSummary; cluster: LogicalSessionCluster }
): boolean {
  if (parent.summary.createdAt < child.summary.createdAt) return true
  if (parent.summary.createdAt > child.summary.createdAt) return false
  return parent.summary.id < child.summary.id
}

function linkCrossSessionBranches(
  pairs: Array<{ summary: SessionSummary; cluster: LogicalSessionCluster }>
): void {
  for (let childIdx = 0; childIdx < pairs.length; childIdx++) {
    const child = pairs[childIdx]
    if (child.summary.branchParentId) continue

    let best: { parentIdx: number; overlap: number; branchPointUuid: string } | null = null
    for (let parentIdx = 0; parentIdx < pairs.length; parentIdx++) {
      if (parentIdx === childIdx) continue
      const parent = pairs[parentIdx]
      if (parent.summary.sessionId === child.summary.sessionId) continue
      if (!canBeCrossSessionBranchParent(parent, child)) continue

      const overlap = countOverlap(child.cluster.uuidSet, parent.cluster.uuidSet)
      if (overlap < 3) continue
      const branchPointUuid = latestSharedUuid(parent.cluster, child.cluster)
      if (!branchPointUuid) continue

      if (!hasMaterialUserTailDivergence(child.cluster, parent.cluster, branchPointUuid)) continue

      if (!best || overlap > best.overlap) {
        best = { parentIdx, overlap, branchPointUuid }
      }
    }

    if (!best) continue
    const parent = pairs[best.parentIdx]
    child.summary.branchParentId = parent.summary.id
    child.summary.branchPointUuid = best.branchPointUuid
    child.summary.branchParentFilePaths = parent.summary.allFilePaths || [parent.summary.filePath]
    if (!parent.summary.branchChildIds) parent.summary.branchChildIds = []
    if (!parent.summary.branchChildIds.includes(child.summary.id)) {
      parent.summary.branchChildIds.push(child.summary.id)
    }
  }
}

async function buildPerFileCache(filePath: string, source: CachedSessionSource): Promise<PerFileCache> {
  if (source === 'claude-code') {
    const raw = await parseSessionFile(filePath)
    const lineageMeta = buildLineageMeta(filePath, raw)
    const summary = lineageMeta.sessionId
      ? buildSessionSummary(filePath, raw, true, lineageMeta.sessionId)
      : null
    return { summary, lineageMeta, source }
  }

  let summary: SessionSummary | null = null
  if (source === 'codex') summary = await buildCodexSessionSummary(filePath)
  else if (source === 'cursor') summary = await buildCursorSessionSummary(filePath)
  else if (source === 'opencode') summary = await buildOpencodeSessionSummary(filePath)
  else summary = await buildZcodeSessionSummary(filePath)
  return { summary, lineageMeta: emptyLineageMeta(summary), source }
}

export interface CachedClaudeLineageFile {
  filePath: string
  meta: CachedLineageMeta
}

export interface CachedClaudeLineageLoadResult {
  files: CachedClaudeLineageFile[]
  parsedFileCount: number
  reusedFileCount: number
}

/**
 * Return Claude lineage metadata from the same incremental per-file cache used by
 * the session loader. A changed file is parsed once; unchanged files are reused
 * directly, so lineage never needs to rescan every JSONL just to rebuild its UUID
 * index.
 */
export async function loadCachedClaudeLineageMetadata(
  filePaths: string[] = findAllSessionFiles()
): Promise<CachedClaudeLineageLoadResult> {
  const cache = loadDiskCache()
  const currentFiles = filePaths.flatMap((filePath) => {
    const sig = computeFileSig(filePath, 'claude-code')
    return sig ? [{ filePath, sig }] : []
  })
  const currentPaths = new Set(currentFiles.map(({ filePath }) => filePath))
  const entries: Record<string, DiskCacheEntry> = { ...(cache?.entries || {}) }

  // This entry point only owns Claude files. Keep cached summaries from other
  // sources intact while pruning Claude files that were removed from disk.
  for (const [filePath, entry] of Object.entries(entries)) {
    if (entry.perFile?.source === 'claude-code' && !currentPaths.has(filePath)) {
      delete entries[filePath]
    }
  }

  let parsedFileCount = 0
  let reusedFileCount = 0
  await parallelForEach(currentFiles, 4, async ({ filePath, sig }) => {
    const cached = cache?.entries[filePath]
    if (cached?.sig === sig && cached.perFile?.source === 'claude-code' &&
      cached.perFile.lineageMeta?.lineageFormatVersion === 2 &&
      Array.isArray(cached.perFile.lineageMeta?.leafUuidRefs)) {
      entries[filePath] = cached
      reusedFileCount++
      return
    }

    parsedFileCount++
    try {
      entries[filePath] = { sig, perFile: await buildPerFileCache(filePath, 'claude-code') }
    } catch {
      entries[filePath] = {
        sig,
        perFile: { summary: null, lineageMeta: emptyLineageMeta(null), source: 'claude-code' }
      }
    }
  })

  saveDiskCache(entries)
  return {
    files: currentFiles.flatMap(({ filePath }) => {
      const meta = entries[filePath]?.perFile.lineageMeta
      return meta?.sessionId ? [{ filePath, meta }] : []
    }),
    parsedFileCount,
    reusedFileCount
  }
}

export interface LoadAllSessionsOptions {
  /** Do not update the summary cache. Used by commands that promise read-only auditing. */
  readOnly?: boolean
  /** Suppress progress output so structured CLI output remains valid JSON. */
  quiet?: boolean
}

export async function loadAllSessions(options: LoadAllSessionsOptions = {}): Promise<SessionSummary[]> {
  const startedAt = Date.now()
  const allFiles = findAllSessionFiles()
  const codexFiles = findCodexSessionFiles()
  const cursorFiles = findCursorSessionFiles()
  const opencodeFiles = await findOpencodeSessionFiles()
  const zcodeFiles = await findZcodeSessionFiles()
  const cache = loadDiskCache()
  const descriptors: Array<{ filePath: string; source: CachedSessionSource }> = [
    ...allFiles.map((filePath) => ({ filePath, source: 'claude-code' as const })),
    ...codexFiles.map((filePath) => ({ filePath, source: 'codex' as const })),
    ...cursorFiles.map((filePath) => ({ filePath, source: 'cursor' as const })),
    ...opencodeFiles.map((filePath) => ({ filePath, source: 'opencode' as const })),
    ...zcodeFiles.map((filePath) => ({ filePath, source: 'zcode' as const }))
  ]
  const currentFiles = descriptors.flatMap((descriptor) => {
    const sig = computeFileSig(descriptor.filePath, descriptor.source)
    return sig ? [{ ...descriptor, sig }] : []
  })
  const entries: Record<string, DiskCacheEntry> = {}
  let parsedCount = 0
  let reusedCount = 0

  await parallelForEach(currentFiles, 4, async ({ filePath, source, sig }) => {
    const cached = cache?.entries[filePath]
    if (cached?.sig === sig && cached.perFile?.source === source &&
      (source !== 'claude-code' || cached.perFile.lineageMeta?.lineageFormatVersion === 2) &&
      Array.isArray(cached.perFile.lineageMeta?.leafUuidRefs)) {
      entries[filePath] = cached
      reusedCount++
      return
    }

    parsedCount++
    try {
      entries[filePath] = { sig, perFile: await buildPerFileCache(filePath, source) }
    } catch {
      entries[filePath] = { sig, perFile: { summary: null, lineageMeta: emptyLineageMeta(null), source } }
    }
  })

  // Rebuild lineage from every file's cached metadata. Only changed/new files were parsed above.
  const filesBySession = new Map<string, FileEntry[]>()
  for (const file of allFiles) {
    const meta = entries[file]?.perFile.lineageMeta
    if (!meta?.sessionId) continue
    if (!filesBySession.has(meta.sessionId)) filesBySession.set(meta.sessionId, [])
    filesBySession.get(meta.sessionId)!.push({
      filePath: file,
      raw: meta.leafUuidRefs,
      startTime: meta.startTime,
      endTime: meta.endTime
    })
  }

  const summaries: SessionSummary[] = []
  const initialClusters = buildInitialSessionClusters(filesBySession)
  const logicalClusters = buildLogicalSessionClusters(initialClusters)
  const summaryClusterPairs: Array<{ summary: SessionSummary; cluster: LogicalSessionCluster }> = []

  for (const cluster of logicalClusters) {
    const primaryFile = cluster.filePaths[0]
    // A one-file logical session already has an exact cached summary. Rebuilding it
    // from lineage refs would turn the hot path back into an all-message scan.
    const perFileSummary = cluster.entries.length === 1
      ? entries[primaryFile]?.perFile.summary
      : null
    const summary = perFileSummary
      ? { ...perFileSummary }
      : buildSessionSummary(primaryFile, cluster.raw, true, cluster.sessionId)
    if (summary) {
      summary.allFilePaths = cluster.filePaths
      if (cluster.branchSummaryId) summary.id = cluster.branchSummaryId
      if (cluster.branchParentFilePaths) summary.branchParentFilePaths = cluster.branchParentFilePaths
      if (cluster.branchPointUuid) summary.branchPointUuid = cluster.branchPointUuid
      if (cluster.continuationSessionIds.length > 0) {
        summary.continuationSessionIds = cluster.continuationSessionIds
      }
      summaries.push(summary)
      summaryClusterPairs.push({ summary, cluster })

      // Detect intra-file branches (e.g. from claude --resume within same file).
      // Run on the logical raw stream so compact continuation shards don't appear as standalone sessions.
      const intraBranches = detectIntraFileBranches(cluster.raw)
      if (intraBranches.length > 0) {
        const branchIds: string[] = intraBranches.map((_, bi) => `${summary.sessionId}:intra-${bi}`)

        // Set child IDs on the main summary (direct children only)
        summary.branchChildIds = intraBranches
          .filter((b) => b.parentIdx === -1)
          .map((b) => branchIds[b.branchIdx])

        for (let bi = 0; bi < intraBranches.length; bi++) {
          const branch = intraBranches[bi]
          const branchId = branchIds[bi]
          const parentId = branch.parentIdx === -1 ? summary.id : branchIds[branch.parentIdx]

          const branchSummary: SessionSummary = {
            ...summary,
            id: branchId,
            firstUserMessage: branch.firstUserMessage,
            createdAt: branch.createdAt,
            updatedAt: branch.updatedAt,
            turnCount: branch.turnCount,
            messageCount: branch.messageCount,
            branchPointUuid: branch.branchPointUuid,
            branchLeafUuid: branch.leafUuid,
            resumeSessionId: undefined,
            branchParentId: parentId,
            branchChildIds: branch.childIdxs.map((ci) => branchIds[ci])
          }
          summaries.push(branchSummary)
        }
      }
    }
  }

  linkCrossSessionBranches(summaryClusterPairs)

  // Detect /fork and /branch relationships via forkedFrom field
  const summaryById = new Map<string, SessionSummary>()
  for (const s of summaries) summaryById.set(s.sessionId, s)

  for (const [, entries] of filesBySession) {
    for (const entry of entries) {
      const forkMsg = entry.raw.find((m) => m.forkedFrom)
      if (!forkMsg?.forkedFrom) continue
      const { sessionId: parentSessionId, messageUuid } = forkMsg.forkedFrom
      const childSessionId = forkMsg.sessionId
      const child = summaryById.get(childSessionId)
      const parent = summaryById.get(parentSessionId)
      if (!child || !parent) continue

      // Link child → parent
      child.branchParentId = parent.id
      child.branchPointUuid = messageUuid
      child.branchParentFilePaths = parent.allFilePaths || [parent.filePath]

      // Link parent → child
      if (!parent.branchChildIds) parent.branchChildIds = []
      if (!parent.branchChildIds.includes(child.id)) {
        parent.branchChildIds.push(child.id)
      }
    }
  }

  for (const { filePath, source } of descriptors) {
    if (source === 'claude-code') continue
    const summary = entries[filePath]?.perFile.summary
    if (summary) summaries.push(summary)
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  if (!options.readOnly) saveDiskCache(entries)
  if (!options.quiet) {
    console.info(
      `[session-loader] incremental cache: parsed ${parsedCount}, reused ${reusedCount}, ` +
      `files ${currentFiles.length}, ${Date.now() - startedAt}ms`
    )
  }
  return summaries
}

export async function loadSessionDetail(
  filePath: string,
  allFilePaths?: string[],
  branchParentFilePaths?: string[],
  branchPointUuid?: string,
  branchLeafUuid?: string
): Promise<SessionDetail | null> {
  // Dispatch to source-specific loaders
  const source = detectSessionSourceFromPath(filePath) || sniffSessionSourceFromJsonl(filePath)
  if (source === 'codex') return buildCodexSessionDetail(filePath, readBackupSessionIdOverride(filePath))
  if (source === 'opencode') return buildOpencodeSessionDetail(filePath, readBackupSessionIdOverride(filePath))
  if (source === 'zcode') return buildZcodeSessionDetail(filePath, readBackupSessionIdOverride(filePath))
  if (source === 'cursor') {
    const sessionIdOverride = readBackupSessionIdOverride(filePath)
    if (path.basename(filePath) === 'backup.jsonl' && !sessionIdOverride) return null
    return buildCursorSessionDetail(filePath, sessionIdOverride)
  }

  let mainRaw: RawJsonlMessage[]
  let detailSessionId: string | undefined

  if (allFilePaths && allFilePaths.length > 1) {
    const entries: FileEntry[] = []
    for (const fp of allFilePaths) {
      try {
        const raw = await parseSessionFile(fp)
        const { start, end } = getFileTimeRange(raw)
        entries.push({ filePath: fp, raw, startTime: start, endTime: end })
      } catch { /* skip */ }
    }
    entries.sort((a, b) => a.startTime.localeCompare(b.startTime))
    detailSessionId = entries[0] ? resolvePhysicalSessionId(entries[0].filePath, entries[0].raw) || undefined : undefined
    mainRaw = mergeRawMessages(entries.flatMap((g) => g.raw))
  } else {
    mainRaw = await parseSessionFile(filePath)
  }

  // For intra-file branches, split into shared trunk + branch-specific messages
  let intraBranchSharedRaw: RawJsonlMessage[] = []
  if (branchLeafUuid && branchPointUuid) {
    const filtered = filterMessagesByBranch(mainRaw, branchLeafUuid)
    // Split at branchPointUuid: everything up to and including it is shared context
    const splitIdx = filtered.findIndex((m) => m.uuid === branchPointUuid)
    if (splitIdx >= 0) {
      intraBranchSharedRaw = filtered.slice(0, splitIdx + 1)
      mainRaw = filtered.slice(splitIdx + 1)
    } else {
      mainRaw = filtered
    }
  } else if (branchLeafUuid) {
    mainRaw = filterMessagesByBranch(mainRaw, branchLeafUuid)
  }

  if (!branchLeafUuid && branchParentFilePaths && branchPointUuid) {
    const splitIdx = mainRaw.findIndex((m) => m.uuid === branchPointUuid)
    if (splitIdx >= 0) {
      mainRaw = mainRaw.slice(splitIdx + 1)
    }
  }

  // Load shared context from parent session if this is a branch
  let sharedContextRaw: RawJsonlMessage[] = []
  if (branchParentFilePaths && branchPointUuid) {
    const parentEntries: FileEntry[] = []
    for (const fp of branchParentFilePaths) {
      try {
        const raw = await parseSessionFile(fp)
        const { start, end } = getFileTimeRange(raw)
        parentEntries.push({ filePath: fp, raw, startTime: start, endTime: end })
      } catch { /* skip */ }
    }
    parentEntries.sort((a, b) => a.startTime.localeCompare(b.startTime))
    const parentRaw = parentEntries.flatMap((g) => g.raw)

    // Include messages up to and including the branch point
    for (const m of parentRaw) {
      sharedContextRaw.push(m)
      if (m.uuid === branchPointUuid) break
    }
  }

  const detail = buildSessionDetail(filePath, mainRaw, detailSessionId)
  if (!detail) return null

  // Prepend shared context from intra-file branch (same format as multi-file branch)
  if (intraBranchSharedRaw.length > 0) {
    sharedContextRaw = intraBranchSharedRaw
  }

  // Prepend shared context messages
  if (sharedContextRaw.length > 0) {
    const sharedMessages: ParsedMessage[] = sharedContextRaw
      .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
      .map((m) => {
        const toolCalls = m.message ? extractToolCalls(m.message.content) : []
        const textContent = m.message ? extractText(m.message.content) : (m as any).content || ''
        const trimmedText = textContent.trimStart()
        const isTaskNotification = m.type === 'user' && trimmedText.startsWith('<task-notification>')
        const isSkillOutput = m.type === 'user' && trimmedText.startsWith('Base directory for this skill:')
        const isCommandOutput = m.type === 'user' && /^<(?:local-command-stdout|local-command-caveat|user-prompt-submit-hook|command-name)>/.test(trimmedText)
        const isSystemReminder = m.type === 'user' && trimmedText.startsWith('<system-reminder>') &&
          !trimmedText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()
        const detectedSubtype = isTaskNotification ? 'task-notification'
          : isSkillOutput ? 'skill-output'
          : isCommandOutput ? 'command-output'
          : isSystemReminder ? 'system-reminder'
          : m.subtype
        return {
          uuid: m.uuid,
          type: m.type as ParsedMessage['type'],
          subtype: detectedSubtype,
          timestamp: m.timestamp,
          role: m.message?.role,
          textContent,
          toolCalls,
          images: m.message ? extractImages(m.message.content) : [],
          tokenUsage: m.type === 'assistant' ? extractTokenUsage(m) : undefined,
          isPreCompact: false,
          isSidechain: !!m.isSidechain,
          isSharedContext: true,
          isSystemGenerated: m.type === 'user' && !isRealUserMessage(m),
          raw: m
        }
      })
    detail.messages = [...sharedMessages, ...detail.messages]
  }

  return detail
}
