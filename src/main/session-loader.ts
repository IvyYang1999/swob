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

  // 2. Decode project root from sessionProjectPath dir name
  // e.g. ~/.claude/projects/-Users-yytyyf-newone/ → /Users/yytyyf/newone
  const encodedName = path.basename(sessionProjectPath)
  const decodedRoot = encodedName.replace(/^-/, '/').replace(/-/g, '/')
  // Skip if decodedRoot is HOME itself (would pick up global config)
  if (decodedRoot && decodedRoot !== '/' && decodedRoot !== HOME) {
    check(path.join(decodedRoot, 'CLAUDE.md'))
    check(path.join(decodedRoot, '.claude', 'CLAUDE.md'))
    check(path.join(decodedRoot, '.claude', 'settings.json'))
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
    .map((p) => ({ name: p.name!, input: (p.input as Record<string, unknown>) || {} }))
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
  rawMessages: RawJsonlMessage[]
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
      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: m.subtype,
        timestamp: m.timestamp,
        role: m.message?.role,
        textContent: m.message ? extractText(m.message.content) : (m as any).content || '',
        toolCalls,
        isPreCompact: lastCompactIndex >= 0 && originalIndex < lastCompactIndex,
        isSidechain: !!m.isSidechain,
        isSharedContext: false,
        raw: m
      }
    })

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
  const files = findAllSessionFiles()

  // Group files by sessionId
  const filesBySession = new Map<string, FileEntry[]>()

  for (const file of files) {
    try {
      const raw = await parseSessionFile(file)
      const sessionId = raw.find((m) => m.sessionId)?.sessionId
      if (!sessionId) continue
      const { start, end } = getFileTimeRange(raw)
      if (!filesBySession.has(sessionId)) filesBySession.set(sessionId, [])
      filesBySession.get(sessionId)!.push({ filePath: file, raw, startTime: start, endTime: end })
    } catch {
      // skip files that can't be parsed
    }
  }

  const summaries: SessionSummary[] = []
  for (const [, group] of filesBySession) {
    // Cluster files: only merge continuations, keep branches separate
    const clusters = clusterFilesForMerge(group)

    // Build UUID index per cluster for parent linking
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
      const summary = buildSessionSummary(primaryFile, mergedRaw)
      if (summary) {
        summary.allFilePaths = cluster.map((g) => g.filePath)
        // Disambiguate id when same sessionId has multiple clusters (branches)
        if (clusters.length > 1) {
          summary.id = `${summary.sessionId}:branch-${ci}`

          // Find parent cluster: check if this cluster's first parentUuid exists in another cluster
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
      }
    }
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return summaries
}

export async function loadSessionDetail(
  filePath: string,
  allFilePaths?: string[],
  branchParentFilePaths?: string[],
  branchPointUuid?: string
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

  // Prepend shared context messages
  if (sharedContextRaw.length > 0) {
    const sharedMessages: ParsedMessage[] = sharedContextRaw
      .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
      .map((m) => {
        const toolCalls = m.message ? extractToolCalls(m.message.content) : []
        return {
          uuid: m.uuid,
          type: m.type as ParsedMessage['type'],
          subtype: m.subtype,
          timestamp: m.timestamp,
          role: m.message?.role,
          textContent: m.message ? extractText(m.message.content) : (m as any).content || '',
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
