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
  ContentPart
} from './types'

const CLAUDE_DIR = path.join(process.env.HOME || '', '.claude', 'projects')

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

  const sessionId = rawMessages[0]?.sessionId
  if (!sessionId) return null

  const cwds = [...new Set(rawMessages.map((m) => m.cwd).filter(Boolean) as string[])]
  const versions = [...new Set(rawMessages.map((m) => m.version).filter(Boolean) as string[])]
  const timestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()

  const userMsgCount = validMessages.filter((m) => m.type === 'user').length
  const assistantMsgCount = validMessages.filter((m) => m.type === 'assistant').length
  const turnCount = Math.min(userMsgCount, assistantMsgCount)

  const compactCount = rawMessages.filter(
    (m) => m.type === 'system' && m.subtype === 'compact_boundary'
  ).length

  const firstUser = validMessages.find((m) => m.type === 'user')
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
  for (const msg of rawMessages) {
    if (msg.type === 'system' && msg.message) {
      const text = extractText(msg.message.content)
      if (text.includes('claudeMd') || text.includes('CLAUDE.md')) {
        const match = text.match(/Contents of.*?CLAUDE\.md.*?:\n([\s\S]*?)(?:\n\nContents of|\n<\/|$)/)
        if (match) claudeMdContent = match[1].trim()
      }
    }
  }

  const stat = fs.statSync(filePath)
  const projectPath = path.dirname(filePath)

  return {
    id: sessionId,
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
    fileSizeBytes: stat.size
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
        raw: m
      }
    })

  return { ...summary, messages }
}

export async function loadAllSessions(): Promise<SessionSummary[]> {
  const files = findAllSessionFiles()
  const summaries: SessionSummary[] = []

  for (const file of files) {
    try {
      const raw = await parseSessionFile(file)
      const summary = buildSessionSummary(file, raw)
      if (summary) summaries.push(summary)
    } catch {
      // skip files that can't be parsed
    }
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return summaries
}

export async function loadSessionDetail(filePath: string): Promise<SessionDetail | null> {
  const raw = await parseSessionFile(filePath)
  return buildSessionDetail(filePath, raw)
}
