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
  FileAction
} from './types'

const CLAUDE_DIR = path.join(process.env.HOME || '', '.claude', 'projects')
const HOME = process.env.HOME || ''

// --- Disk Cache for Session Summaries ---
const CACHE_DIR = path.join(HOME, '.claude-session-manager')
const CACHE_FILE = path.join(CACHE_DIR, 'summary-cache.json')
const CACHE_VERSION = 2 // bumped for intra-file branch support

interface DiskCache {
  version: number
  manifest: string
  summaries: SessionSummary[]
}

function loadDiskCache(): DiskCache | null {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
      if (data.version === CACHE_VERSION) return data
    }
  } catch { /* corrupt cache */ }
  return null
}

function saveDiskCache(manifest: string, summaries: SessionSummary[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, manifest, summaries }))
  } catch { /* ignore */ }
}

function computeFileManifest(files: string[]): string {
  return files.sort().map((f) => {
    try {
      const s = fs.statSync(f)
      return `${f}:${s.mtimeMs}:${s.size}`
    } catch {
      return ''
    }
  }).filter(Boolean).join('\n')
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

export function findAllSessionFiles(): string[] {
  const files: string[] = []
  if (!fs.existsSync(CLAUDE_DIR)) return files

  const projects = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projDir = path.join(CLAUDE_DIR, proj.name)
    const entries = fs.readdirSync(projDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(projDir, entry.name))
      }
    }
  }
  return files
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

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }
  return messages
}

export function buildSessionSummary(
  filePath: string,
  rawMessages: RawJsonlMessage[],
  light = false
): SessionSummary | null {
  if (filePath.includes('/subagents/')) return null

  const validMessages = rawMessages.filter(
    (m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system'
  )
  if (validMessages.length === 0) return null

  const sessionId = rawMessages.find((m) => m.sessionId)?.sessionId
  if (!sessionId) return null

  // Separate main chain and sidechain messages
  const mainChainMessages = rawMessages.filter((m) => !m.isSidechain)

  const cwds = [...new Set(rawMessages.map((m) => m.cwd).filter(Boolean) as string[])]
  const versions = [...new Set(rawMessages.map((m) => m.version).filter(Boolean) as string[])]
  // Use main chain timestamps for updatedAt (sidechain messages are rejected branches)
  const mainTimestamps = mainChainMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const allTimestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const timestamps = mainTimestamps.length > 0 ? mainTimestamps : allTimestamps

  const userMsgCount = validMessages.filter((m) => m.type === 'user').length
  const assistantMsgCount = validMessages.filter((m) => m.type === 'assistant').length
  const turnCount = Math.min(userMsgCount, assistantMsgCount)

  const compactCount = rawMessages.filter(
    (m) => m.type === 'system' && m.subtype === 'compact_boundary'
  ).length

  // Find first meaningful user message (skip interruptions and empty messages)
  const skipPrefixes = ['[Request interrupted', 'This session is being continued']
  const firstUser = validMessages.find((m) => {
    if (m.type !== 'user') return false
    const text = m.message ? extractText(m.message.content).trim() : ''
    return text.length > 0 && !skipPrefixes.some((p) => text.startsWith(p))
  }) || validMessages.find((m) => m.type === 'user')
  let firstUserMessage = ''
  if (firstUser?.message) {
    firstUserMessage = extractText(firstUser.message.content).slice(0, 200)
  }

  // Light mode: skip expensive operations (tool extraction, file I/O, config discovery)
  if (light) {
    const permissionMode = rawMessages.find((m) => m.permissionMode)?.permissionMode
    const stat = fs.statSync(filePath)
    return {
      id: sessionId,
      sessionId,
      slug: rawMessages.find((m) => m.slug)?.slug || '',
      createdAt: timestamps[0] || '',
      updatedAt: timestamps[timestamps.length - 1] || '',
      messageCount: validMessages.length,
      turnCount,
      compactCount,
      cwds,
      version: versions[0] || '',
      firstUserMessage,
      toolUsage: {},
      skillInvocations: [],
      projectPath: path.dirname(filePath),
      filePath,
      fileSizeBytes: stat.size,
      permissionMode,
      userImages: [],
      referencedFiles: [],
      configFiles: []
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

  // Extract permission mode from the first user message that has it
  const permissionMode = rawMessages.find((m) => m.permissionMode)?.permissionMode

  const stat = fs.statSync(filePath)
  const projectPath = path.dirname(filePath)

  return {
    id: sessionId,
    sessionId,
    slug: rawMessages.find((m) => m.slug)?.slug || '',
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    messageCount: validMessages.length,
    turnCount,
    compactCount,
    cwds,
    version: versions[0] || '',
    firstUserMessage,
    toolUsage,
    skillInvocations,
    claudeMdContent,
    projectPath,
    filePath,
    fileSizeBytes: stat.size,
    permissionMode,
    userImages: [...userImages],
    referencedFiles: [...referencedFiles],
    configFiles
  }
}

export function buildSessionDetail(
  filePath: string,
  rawMessages: RawJsonlMessage[]
): SessionDetail | null {
  const summary = buildSessionSummary(filePath, rawMessages)
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
      const isSystemInjected = isTaskNotification || isSkillOutput
      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: isSystemInjected ? (isTaskNotification ? 'task-notification' : 'skill-output') : m.subtype,
        timestamp: m.timestamp,
        role: m.message?.role,
        textContent,
        toolCalls,
        isPreCompact: lastCompactIndex >= 0 && originalIndex < lastCompactIndex,
        isSidechain: !!m.isSidechain,
        isSharedContext: false,
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

/**
 * Detect intra-file branches: when `claude --resume` creates a new conversation
 * thread within the same JSONL file (they share a common trunk via parentUuid).
 * Returns info about each significant branch (branches with >= MIN_UNIQUE_TURNS user/assistant turns).
 */
interface IntraBranch {
  branchPointUuid: string
  leafUuid: string
  firstUserMessage: string
  createdAt: string
  updatedAt: string
  userMsgCount: number
  turnCount: number
  pathUuids: Set<string>
}

function detectIntraFileBranches(raw: RawJsonlMessage[]): IntraBranch[] {
  const MIN_UNIQUE_TURNS = 5

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

  // Find all leaf uuids (no children)
  const allUuids = new Set<string>()
  for (const m of raw) { if (m.uuid) allUuids.add(m.uuid) }
  const leafUuids = [...allUuids].filter((u) => !childrenOf.has(u))
  if (leafUuids.length <= 1) return []

  // Trace path from a uuid to root
  function traceToRoot(uuid: string): string[] {
    const path: string[] = []
    const visited = new Set<string>()
    let current: string | null | undefined = uuid
    while (current && !visited.has(current)) {
      visited.add(current)
      if (uuidToIdx.has(current)) path.push(current)
      const idx = uuidToIdx.get(current)
      current = idx !== undefined ? raw[idx].parentUuid : undefined
    }
    return path.reverse() // root → leaf order
  }

  // Get the longest path (main branch)
  let mainPath: string[] = []
  let mainLeaf = ''
  for (const lu of leafUuids) {
    const p = traceToRoot(lu)
    if (p.length > mainPath.length) {
      mainPath = p
      mainLeaf = lu
    }
  }

  const mainSet = new Set(mainPath)

  // Find branches that diverge significantly from main
  // Group by (branchPointUuid, firstUserMessage) to avoid counting retry-leaves as separate branches
  const branchGroups = new Map<string, { leaves: string[]; path: string[]; branchPointUuid: string }>()

  for (const lu of leafUuids) {
    if (lu === mainLeaf) continue
    const leafPath = traceToRoot(lu)
    if (leafPath.length < 10) continue

    // Find divergence point from main
    let commonLen = 0
    for (let i = 0; i < Math.min(mainPath.length, leafPath.length); i++) {
      if (mainPath[i] === leafPath[i]) commonLen++
      else break
    }
    if (commonLen === 0) continue

    const uniquePortion = leafPath.slice(commonLen)
    const uniqueUserMsgs = uniquePortion.filter((u) => {
      const idx = uuidToIdx.get(u)
      return idx !== undefined && raw[idx].type === 'user'
    })

    if (uniqueUserMsgs.length < MIN_UNIQUE_TURNS) continue

    const branchPointUuid = leafPath[commonLen - 1]
    // Get first user message unique to this branch
    let firstMsg = ''
    const skipPrefixes = ['[Request interrupted', 'This session is being continued']
    for (const u of uniquePortion) {
      const idx = uuidToIdx.get(u)
      if (idx === undefined) continue
      const m = raw[idx]
      if (m.type !== 'user' || !m.message) continue
      const text = typeof m.message.content === 'string'
        ? m.message.content
        : (m.message.content as any[])?.filter((p: any) => p.type === 'text' && p.text).map((p: any) => p.text).join('\n') || ''
      const trimmed = text.trim()
      if (trimmed.length > 0 && !skipPrefixes.some((p) => trimmed.startsWith(p))) {
        firstMsg = trimmed.slice(0, 200)
        break
      }
    }
    if (!firstMsg) continue

    // Group key: fork point + first 60 chars of first msg
    const groupKey = `${branchPointUuid}:${firstMsg.slice(0, 60)}`
    if (!branchGroups.has(groupKey)) {
      branchGroups.set(groupKey, { leaves: [], path: leafPath, branchPointUuid })
    }
    const group = branchGroups.get(groupKey)!
    group.leaves.push(lu)
    // Keep the longest path in the group
    if (leafPath.length > group.path.length) group.path = leafPath
  }

  // Convert groups to IntraBranch results
  const branches: IntraBranch[] = []
  for (const [, group] of branchGroups) {
    const pathUuids = new Set(group.path)
    // Use the deepest leaf as representative
    const leafUuid = group.leaves.reduce((best, lu) => {
      const p = traceToRoot(lu)
      return p.length > traceToRoot(best).length ? lu : best
    })

    // Compute stats for the unique portion
    const commonLen = group.path.findIndex((u) => !mainSet.has(u))
    const uniqueUuids = commonLen >= 0 ? group.path.slice(commonLen) : []

    let userCount = 0
    let assistantCount = 0
    let firstUserMessage = ''
    let createdAt = ''
    let updatedAt = ''
    const skipPrefixes = ['[Request interrupted', 'This session is being continued']

    for (const u of uniqueUuids) {
      const idx = uuidToIdx.get(u)
      if (idx === undefined) continue
      const m = raw[idx]
      if (m.timestamp) {
        if (!createdAt) createdAt = m.timestamp
        updatedAt = m.timestamp
      }
      if (m.type === 'user') {
        userCount++
        if (!firstUserMessage && m.message) {
          const text = typeof m.message.content === 'string'
            ? m.message.content
            : (m.message.content as any[])?.filter((p: any) => p.type === 'text' && p.text).map((p: any) => p.text).join('\n') || ''
          const trimmed = text.trim()
          if (trimmed.length > 0 && !skipPrefixes.some((p) => trimmed.startsWith(p))) {
            firstUserMessage = trimmed.slice(0, 200)
          }
        }
      }
      if (m.type === 'assistant') assistantCount++
    }

    if (userCount >= MIN_UNIQUE_TURNS) {
      branches.push({
        branchPointUuid: group.branchPointUuid,
        leafUuid,
        firstUserMessage,
        createdAt,
        updatedAt,
        userMsgCount: userCount,
        turnCount: Math.min(userCount, assistantCount),
        pathUuids
      })
    }
  }

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

  // Trace from leaf to root
  const pathUuids = new Set<string>()
  let current: string | null | undefined = leafUuid
  const visited = new Set<string>()
  while (current && !visited.has(current)) {
    visited.add(current)
    if (uuidToIdx.has(current)) pathUuids.add(current)
    const idx = uuidToIdx.get(current)
    current = idx !== undefined ? raw[idx].parentUuid : undefined
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

export async function loadAllSessions(): Promise<SessionSummary[]> {
  const allFiles = findAllSessionFiles()
  const manifest = computeFileManifest(allFiles)

  // Fast path: return cached summaries if no files changed
  const cache = loadDiskCache()
  if (cache && cache.manifest === manifest) {
    return cache.summaries
  }

  // Slow path: parse all files with parallel I/O + light summaries
  const filesBySession = new Map<string, FileEntry[]>()

  await parallelForEach(allFiles, 4, async (file) => {
    try {
      const raw = await parseSessionFile(file)
      const sessionId = raw.find((m) => m.sessionId)?.sessionId
      if (!sessionId) return
      const { start, end } = getFileTimeRange(raw)
      if (!filesBySession.has(sessionId)) filesBySession.set(sessionId, [])
      filesBySession.get(sessionId)!.push({ filePath: file, raw, startTime: start, endTime: end })
    } catch {
      // skip files that can't be parsed
    }
  })

  const summaries: SessionSummary[] = []
  for (const [, group] of filesBySession) {
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
      const cluster = clusters[ci]
      cluster.sort((a, b) => a.startTime.localeCompare(b.startTime))
      const mergedRaw = cluster.flatMap((g) => g.raw)
      const primaryFile = cluster[cluster.length - 1].filePath
      const summary = buildSessionSummary(primaryFile, mergedRaw, true)
      if (summary) {
        summary.allFilePaths = cluster.map((g) => g.filePath)
        if (clusters.length > 1) {
          summary.id = `${summary.sessionId}:branch-${ci}`

          const firstParentUuid = mergedRaw.find(
            (m) => m.parentUuid && (m.type === 'user' || m.type === 'assistant')
          )?.parentUuid
          if (firstParentUuid) {
            for (let pi = 0; pi < clusters.length; pi++) {
              if (pi === ci) continue
              if (clusterUuids[pi].has(firstParentUuid)) {
                summary.branchParentFilePaths = clusters[pi].map((g) => g.filePath)
                summary.branchPointUuid = firstParentUuid
                break
              }
            }
          }
        }
        summaries.push(summary)

        // Detect intra-file branches (e.g. from claude --resume within same file)
        const intraBranches = detectIntraFileBranches(mergedRaw)
        for (let bi = 0; bi < intraBranches.length; bi++) {
          const branch = intraBranches[bi]
          const branchSummary: SessionSummary = {
            ...summary,
            id: `${summary.sessionId}:intra-${bi}`,
            firstUserMessage: branch.firstUserMessage,
            createdAt: branch.createdAt,
            updatedAt: branch.updatedAt,
            turnCount: branch.turnCount,
            messageCount: branch.pathUuids.size,
            branchPointUuid: branch.branchPointUuid,
            branchLeafUuid: branch.leafUuid
          }
          summaries.push(branchSummary)
        }
      }
    }
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  saveDiskCache(manifest, summaries)
  return summaries
}

export async function loadSessionDetail(
  filePath: string,
  allFilePaths?: string[],
  branchParentFilePaths?: string[],
  branchPointUuid?: string,
  branchLeafUuid?: string
): Promise<SessionDetail | null> {
  let mainRaw: RawJsonlMessage[]

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
    mainRaw = entries.flatMap((g) => g.raw)
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

  const detail = buildSessionDetail(filePath, mainRaw)
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
        const detectedSubtype = isTaskNotification ? 'task-notification' : isSkillOutput ? 'skill-output' : m.subtype
        return {
          uuid: m.uuid,
          type: m.type as ParsedMessage['type'],
          subtype: detectedSubtype,
          timestamp: m.timestamp,
          role: m.message?.role,
          textContent,
          toolCalls,
          isPreCompact: false,
          isSidechain: !!m.isSidechain,
          isSharedContext: true,
          raw: m
        }
      })
    detail.messages = [...sharedMessages, ...detail.messages]
  }

  return detail
}
