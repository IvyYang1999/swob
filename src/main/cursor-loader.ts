import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  ContentPart
} from './types'
import { tokenUsageFromAccounting, unavailableTokenAccounting } from './token-accounting'
import { runtimeHome } from './runtime-home'

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

// --- Cursor JSONL line format ---

interface CursorLine {
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
}

// --- Parse raw lines ---

async function parseCursorFile(filePath: string): Promise<CursorLine[]> {
  const lines: CursorLine[] = []
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      lines.push(JSON.parse(line))
    } catch { /* skip */ }
  }
  return lines
}

export async function loadCursorRawMessages(filePath: string, sessionIdOverride?: string): Promise<RawJsonlMessage[]> {
  const lines = await parseCursorFile(filePath)
  if (lines.length === 0) return []
  const sessionId = sessionIdOverride || extractSessionId(filePath)
  return cursorToRawMessages(lines, sessionId, filePath)
}

// --- Derive project path from the transcript location ---

function deriveProjectPath(filePath: string): string {
  const parts = filePath.split(path.sep)
  const projectsIdx = parts.indexOf('projects')
  if (projectsIdx >= 0 && projectsIdx + 1 < parts.length) {
    const slug = parts[projectsIdx + 1]
    return '/' + slug.replace(/-/g, '/')
  }
  return ''
}

// --- Extract session ID from directory name ---

function extractSessionId(filePath: string): string {
  return path.basename(path.dirname(filePath))
}

// --- Convert to unified RawJsonlMessage[] ---

function cursorToRawMessages(lines: CursorLine[], sessionId: string, filePath: string): RawJsonlMessage[] {
  const messages: RawJsonlMessage[] = []
  const stat = fs.statSync(filePath)
  const fileTime = stat.mtime.toISOString()
  const projectPath = deriveProjectPath(filePath)
  const cwd = projectPath || undefined
  let msgIndex = 0

  for (const line of lines) {
    const uuid = `cursor-${sessionId}-${msgIndex++}`
    const parentUuid = messages.length > 0 ? messages[messages.length - 1].uuid : null

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
        timestamp: fileTime,
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
          timestamp: fileTime,
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
          if (p.type === 'reasoning') {
            return { type: 'text', text: '' } as ContentPart
          }
          return { type: 'text', text: '' } as ContentPart
        })
        messages.push({
          uuid,
          parentUuid,
          sessionId,
          type: 'assistant',
          timestamp: fileTime,
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
          timestamp: fileTime,
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
  const rawMessages = cursorToRawMessages(lines, sessionId, filePath)
  if (rawMessages.length === 0) return null

  const stat = fs.statSync(filePath)
  const projectPath = deriveProjectPath(filePath)
  const cwds = projectPath ? [projectPath] : []

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

  return {
    id: `cursor:${sessionId}`,
    sessionId,
    slug: '',
    createdAt: stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
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
    resumeCwd: projectPath || undefined,
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
  const rawMessages = cursorToRawMessages(lines, sessionId, filePath)

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
        images: [],
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
