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
import {
  accountCodexUsage,
  tokenUsageFromAccounting,
  type CodexUsageSnapshot,
  type TokenAccounting
} from './token-accounting'
import { runtimeHome } from './runtime-home'

// --- Codex JSONL envelope types ---

export interface CodexLine {
  timestamp: string
  type: 'session_meta' | 'event_msg' | 'response_item' | 'turn_context'
  payload: Record<string, unknown>
}

interface CodexSessionMeta {
  id: string
  timestamp: string
  cwd: string
  cli_version: string
  model_provider?: string
  git?: { branch?: string; repository_url?: string }
}

function tokenNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function costNumber(record?: Record<string, unknown>): number | undefined {
  if (!record) return undefined
  for (const value of [record.costUSD, record.costUsd, record.cost_usd]) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  const cost = record.cost
  if (cost && typeof cost === 'object') {
    const total = (cost as Record<string, unknown>).total
    if (typeof total === 'number' && Number.isFinite(total) && total >= 0) return total
  }
  return undefined
}

function codexSnapshot(
  raw: Record<string, unknown>,
  kind: CodexUsageSnapshot['kind'],
  timestamp: string,
  model?: string,
  dedupHint?: string,
  providerRaw?: string,
  reportedCostUsd?: number
): CodexUsageSnapshot {
  return {
    timestamp,
    model,
    providerRaw,
    reportedCostUsd: reportedCostUsd ?? costNumber(raw),
    serviceTier: typeof raw.service_tier === 'string' ? raw.service_tier : undefined,
    inferenceRegion: typeof raw.inference_geo === 'string' ? raw.inference_geo : undefined,
    speed: typeof raw.speed === 'string' ? raw.speed : undefined,
    isBatch: typeof raw.is_batch === 'boolean' ? raw.is_batch : undefined,
    kind,
    inputTokens: tokenNumber(raw.input_tokens),
    outputTokens: tokenNumber(raw.output_tokens),
    cachedInputTokens: tokenNumber(raw.cached_input_tokens),
    cacheWriteTokens: tokenNumber(raw.cache_write_tokens) || tokenNumber(raw.cache_creation_input_tokens),
    reasoningTokens: tokenNumber(raw.reasoning_output_tokens) || tokenNumber(raw.reasoning_tokens),
    dedupHint
  }
}

export function extractCodexTokenAccounting(lines: CodexLine[]): TokenAccounting {
  const perTurn: CodexUsageSnapshot[] = []
  const cumulative: CodexUsageSnapshot[] = []
  let currentModel: string | undefined
  let currentProvider = (lines.find((line) => line.type === 'session_meta')?.payload as Partial<CodexSessionMeta> | undefined)?.model_provider

  for (const line of lines) {
    if (line.type === 'turn_context') {
      if (typeof line.payload.model === 'string') currentModel = line.payload.model
      if (typeof line.payload.model_provider === 'string') currentProvider = line.payload.model_provider
      else if (typeof line.payload.provider === 'string') currentProvider = line.payload.provider
    }
    if (line.type !== 'event_msg' || line.payload.type !== 'token_count') continue
    const info = line.payload.info as Record<string, unknown> | undefined
    if (!info) continue
    const last = info.last_token_usage as Record<string, unknown> | undefined
    const total = info.total_token_usage as Record<string, unknown> | undefined
    const turnId = typeof info.turn_id === 'string'
        ? info.turn_id
        : typeof line.payload.turn_id === 'string'
          ? line.payload.turn_id
          : undefined
    if (last) {
      const totalKey = total
        ? [
            tokenNumber(total.input_tokens), tokenNumber(total.output_tokens),
            tokenNumber(total.cached_input_tokens), tokenNumber(total.reasoning_output_tokens) || tokenNumber(total.reasoning_tokens)
          ].join(':')
        : undefined
      const dedupHint = turnId ? `codex:turn:${turnId}` : totalKey ? `codex:total:${totalKey}` : undefined
      perTurn.push(codexSnapshot(
        last,
        'incremental',
        line.timestamp,
        currentModel,
        dedupHint,
        currentProvider,
        costNumber(last) ?? costNumber(info) ?? costNumber(line.payload)
      ))
    } else if (total) {
      cumulative.push(codexSnapshot(
        total,
        'cumulative',
        line.timestamp,
        currentModel,
        undefined,
        currentProvider,
        costNumber(total) ?? costNumber(info) ?? costNumber(line.payload)
      ))
    }
  }

  return accountCodexUsage(perTurn.length > 0 ? perTurn : cumulative)
}

// --- File discovery ---

export function findCodexSessionFiles(home = runtimeHome()): string[] {
  const files: string[] = []
  const codexDir = path.join(home, '.codex', 'sessions')
  if (!fs.existsSync(codexDir)) return files

  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(full)
      }
    }
  }
  walk(codexDir)
  return files
}

// --- Parse raw lines ---

async function parseCodexFile(filePath: string): Promise<CodexLine[]> {
  const lines: CodexLine[] = []
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

export async function loadCodexRawMessages(filePath: string, sessionIdOverride?: string): Promise<RawJsonlMessage[]> {
  const lines = await parseCodexFile(filePath)
  const sessionId = sessionIdOverride || extractSessionId(filePath, lines)
  if (!sessionId) return []
  return codexToRawMessages(lines, sessionId)
}

// --- Extract session ID from filename or meta ---

function extractSessionId(filePath: string, lines: CodexLine[]): string | undefined {
  const meta = lines.find((l) => l.type === 'session_meta')
  if (meta) return (meta.payload as unknown as CodexSessionMeta).id

  const match = path.basename(filePath).match(
    /rollout-[\dT-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/
  )
  return match?.[1]
}

const CODEX_AGENTS_PREFIXES = [
  '# AGENTS.md instructions',
  'AGENTS.md instructions'
]

const CODEX_SYSTEM_WRAPPER_TAGS = [
  '<permissions instructions>',
  '<environment_context>',
  '<user_instructions>',
  '<INSTRUCTIONS>',
  '<recommended_plugins>',
  '<skills_instructions>',
  '<apps_instructions>',
  '<plugins_instructions>',
  '<collaboration_mode>',
  '<turn_aborted>'
]

function isWholeWrappedByCodexTag(trimmed: string, openTag: string): boolean {
  const closeTag = openTag.replace(/^</, '</')
  return trimmed.startsWith(openTag) && trimmed.endsWith(closeTag)
}

function isCodexAgentsInjection(trimmed: string, beforeFirstRealUser: boolean): boolean {
  if (!beforeFirstRealUser) return false
  if (!CODEX_AGENTS_PREFIXES.some((p) => trimmed.startsWith(p))) return false
  return trimmed.includes('<INSTRUCTIONS>') || trimmed.length > 2000
}

function isCodexCollaborationInjection(trimmed: string, beforeFirstRealUser: boolean): boolean {
  if (!beforeFirstRealUser) return false
  if (!trimmed.startsWith('# Collaboration Mode:')) return false
  return trimmed.includes('<collaboration_mode>') || trimmed.length > 2000
}

function isCodexBootstrapInjection(trimmed: string, beforeFirstRealUser: boolean): boolean {
  if (!beforeFirstRealUser) return false

  const startsWithKnownInjection = CODEX_SYSTEM_WRAPPER_TAGS.some((tag) => trimmed.startsWith(tag)) ||
    CODEX_AGENTS_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
  if (!startsWithKnownInjection) return false

  const wrapperCount = CODEX_SYSTEM_WRAPPER_TAGS.filter((marker) => trimmed.includes(marker)).length
  const agentsMarkerCount = CODEX_AGENTS_PREFIXES.some((marker) => trimmed.includes(marker)) ? 1 : 0
  const markerCount = wrapperCount + agentsMarkerCount
  return markerCount >= 2
}

function normalizeCodexUserText(text: string, beforeFirstRealUser: boolean): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null

  const shellMatch = trimmed.match(/^<user_shell_command>\s*([\s\S]*?)\s*<\/user_shell_command>$/)
  if (shellMatch) return shellMatch[1].trim() || null
  if (trimmed.startsWith('<user_shell_command>')) {
    const withoutOpen = trimmed.replace(/^<user_shell_command>\s*/, '')
    return withoutOpen.replace(/\s*<\/user_shell_command>$/, '').trim() || null
  }

  if (isCodexAgentsInjection(trimmed, beforeFirstRealUser)) return null
  if (isCodexCollaborationInjection(trimmed, beforeFirstRealUser)) return null
  if (isCodexBootstrapInjection(trimmed, beforeFirstRealUser)) return null
  if (CODEX_SYSTEM_WRAPPER_TAGS.some((tag) => isWholeWrappedByCodexTag(trimmed, tag))) return null
  return text
}

function modeString(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, { count: number; firstIdx: number }>()
  values.forEach((value, idx) => {
    const normalized = value?.trim()
    if (!normalized) return
    const current = counts.get(normalized)
    if (current) {
      current.count += 1
    } else {
      counts.set(normalized, { count: 1, firstIdx: idx })
    }
  })
  return [...counts.entries()]
    .sort(([, a], [, b]) => b.count - a.count || a.firstIdx - b.firstIdx)[0]?.[0]
}

function extractCodexModel(lines: CodexLine[]): string | undefined {
  return modeString(lines.map((line) => {
    if (line.type !== 'turn_context') return undefined
    const model = (line.payload as Record<string, unknown>).model
    return typeof model === 'string' ? model : undefined
  }))
}

// --- Convert Codex lines to unified RawJsonlMessage[] ---

function codexToRawMessages(lines: CodexLine[], sessionId: string): RawJsonlMessage[] {
  const messages: RawJsonlMessage[] = []
  const meta = lines.find((l) => l.type === 'session_meta')?.payload as unknown as CodexSessionMeta | undefined
  const cwd = meta?.cwd
  const model = extractCodexModel(lines)
  let msgIndex = 0
  let seenRealUserMessage = false
  const assistantTextSourcesInTurn = new Map<string, 'event_msg' | 'response_item'>()

  const pushAssistantText = (text: string, timestamp: string, source: 'event_msg' | 'response_item'): void => {
    const dedupeKey = text.trim()
    if (!dedupeKey) return

    const previousSource = assistantTextSourcesInTurn.get(dedupeKey)
    if (previousSource && previousSource !== source) return
    if (!previousSource) assistantTextSourcesInTurn.set(dedupeKey, source)

    messages.push({
      uuid: `codex-${sessionId}-${msgIndex++}`,
      parentUuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
      sessionId,
      type: 'assistant',
      timestamp,
      cwd,
      version: model,
      message: {
        role: 'assistant',
        model,
        content: text
      }
    })
  }

  for (const line of lines) {
    const ts = line.timestamp

    if (line.type === 'event_msg') {
      const p = line.payload as Record<string, unknown>
      const etype = p.type as string

      // Skip user_message from event_msg — it duplicates response_item
      if (etype === 'agent_message') {
        pushAssistantText((p.message as string) || '', ts, 'event_msg')
      }
    } else if (line.type === 'response_item') {
      const p = line.payload as Record<string, unknown>
      const rtype = p.type as string

      if (rtype === 'message') {
        const role = p.role as string
        if (role === 'developer') continue
        if (role === 'user') {
          const content = p.content as Array<{ type: string; text: string }> | undefined
          const text = content?.filter((c) => c.type === 'input_text').map((c) => c.text).join('\n') || ''
          const normalizedText = normalizeCodexUserText(text, !seenRealUserMessage)
          if (normalizedText) {
            seenRealUserMessage = true
            assistantTextSourcesInTurn.clear()
            messages.push({
              uuid: `codex-${sessionId}-${msgIndex++}`,
              parentUuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
              sessionId,
              type: 'user',
              timestamp: ts,
              cwd,
              version: model,
              message: { role: 'user', model, content: normalizedText }
            })
          }
        } else if (role === 'assistant') {
          const content = p.content as Array<{ type: string; text: string }> | undefined
          const text = content?.filter((c) => c.type === 'output_text').map((c) => c.text).join('\n') || ''
          pushAssistantText(text, ts, 'response_item')
        }
      } else if (rtype === 'function_call') {
        const name = p.name as string || 'unknown'
        const argsStr = p.arguments as string || '{}'
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(argsStr) } catch { /* ignore */ }
        const callId = p.call_id as string

        messages.push({
          uuid: `codex-${sessionId}-${msgIndex++}`,
          parentUuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
          sessionId,
          type: 'assistant',
          timestamp: ts,
          cwd,
          version: model,
          message: {
            role: 'assistant',
            model,
            content: [{
              type: 'tool_use',
              id: callId,
              name,
              input: args
            }] as unknown as ContentPart[]
          }
        })
      } else if (rtype === 'function_call_output') {
        const callId = p.call_id as string
        const output = p.output as string || ''
        messages.push({
          uuid: `codex-${sessionId}-${msgIndex++}`,
          parentUuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
          sessionId,
          type: 'user',
          timestamp: ts,
          cwd,
          version: model,
          message: {
            role: 'user',
            model,
            content: [{
              type: 'tool_result',
              tool_use_id: callId,
              content: output
            }] as unknown as ContentPart[]
          }
        })
      }
    }
  }

  return messages
}

// --- Build summary ---

export async function buildCodexSessionSummary(filePath: string, sessionIdOverride?: string): Promise<SessionSummary | null> {
  const lines = await parseCodexFile(filePath)
  const sessionId = sessionIdOverride || extractSessionId(filePath, lines)
  if (!sessionId) return null

  const rawMessages = codexToRawMessages(lines, sessionId)
  if (rawMessages.length === 0) return null

  const meta = lines.find((l) => l.type === 'session_meta')?.payload as unknown as CodexSessionMeta | undefined
  const cwds = meta?.cwd ? [meta.cwd] : []

  const userMessages = rawMessages.filter((m) => m.type === 'user' && m.message && typeof m.message.content === 'string' && m.message.content.trim())
  const assistantMessages = rawMessages.filter((m) => m.type === 'assistant')
  const turnCount = Math.min(userMessages.length, assistantMessages.length)

  const timestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const firstUser = userMessages[0]
  const firstUserMessage = firstUser?.message
    ? (typeof firstUser.message.content === 'string' ? firstUser.message.content : '').slice(0, 200)
    : ''

  const allUserTexts: string[] = []
  let totalLen = 0
  const USER_TEXT_LIMIT = 2000
  for (const m of userMessages) {
    const text = typeof m.message?.content === 'string' ? m.message.content.trim() : ''
    if (!text || text === firstUserMessage) continue
    if (totalLen + text.length > USER_TEXT_LIMIT) {
      allUserTexts.push(text.slice(0, USER_TEXT_LIMIT - totalLen))
      break
    }
    allUserTexts.push(text)
    totalLen += text.length
  }
  const allUserMessages = allUserTexts.length > 0 ? allUserTexts.join(' ') : undefined

  // Codex input_tokens already includes cached_input_tokens. Normalize them to
  // mutually exclusive components and prefer per-turn usage when it is present.
  const tokenAccounting = extractCodexTokenAccounting(lines)
  const totalTokenUsage = tokenUsageFromAccounting(tokenAccounting)

  // Tool usage
  const toolUsage: Record<string, number> = {}
  for (const line of lines) {
    if (line.type === 'response_item' && (line.payload as any).type === 'function_call') {
      const name = (line.payload as any).name as string || 'unknown'
      toolUsage[name] = (toolUsage[name] || 0) + 1
    }
  }

  const stat = fs.statSync(filePath)
  const model = extractCodexModel(lines)

  return {
    id: `codex:${sessionId}`,
    sessionId,
    slug: '',
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    messageCount: rawMessages.length,
    turnCount,
    compactCount: 0,
    cwds,
    version: meta?.cli_version || model || '',
    firstUserMessage,
    toolUsage,
    skillInvocations: [],
    projectPath: path.dirname(filePath),
    filePath,
    fileSizeBytes: stat.size,
    permissionMode: undefined,
    resumeCwd: meta?.cwd,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: totalTokenUsage,
    tokenAccounting,
    referencedFiles: [],
    configFiles: [],
    source: 'codex',
    allUserMessages,
    models: model ? [model] : []
  }
}

export async function buildCodexSessionSummaryFromBackup(
  filePath: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return buildCodexSessionSummary(filePath, sessionIdOverride)
}

// --- Build detail ---

export async function buildCodexSessionDetail(filePath: string, sessionIdOverride?: string): Promise<SessionDetail | null> {
  const lines = await parseCodexFile(filePath)
  const sessionId = sessionIdOverride || extractSessionId(filePath, lines)
  if (!sessionId) return null

  const summary = await buildCodexSessionSummary(filePath, sessionId)
  if (!summary) return null

  const rawMessages = codexToRawMessages(lines, sessionId)

  const messages: ParsedMessage[] = rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant')
    .map((m) => {
      const content = m.message?.content
      const isToolResult = Array.isArray(content) && content.some((p: any) => p.type === 'tool_result')
      const isToolCall = Array.isArray(content) && content.some((p: any) => p.type === 'tool_use')
      const textContent = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as any[]).filter((p) => p.type === 'text' || p.type === 'output_text' || p.type === 'input_text').map((p) => p.text).join('\n')
          : ''

      const toolCalls: ToolCallInfo[] = isToolCall
        ? (content as any[]).filter((p) => p.type === 'tool_use').map((p) => ({
            id: p.id,
            name: p.name,
            input: p.input || {}
          }))
        : []

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
      if (part.type === 'tool_result' && part.tool_use_id && part.content) {
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
