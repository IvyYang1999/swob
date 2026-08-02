import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  ContentPart,
  SessionSubagentSummary
} from './types'
import {
  accountCodexUsage,
  tokenUsageFromAccounting,
  type CodexUsageSnapshot,
  type TokenAccounting
} from './token-accounting'
import { runtimeHome } from './runtime-home'
import { activityDaysFromTimestamps } from './activity-time'
import {
  stripTerminalControlSequences,
  stripTerminalControlSequencesDeep
} from '../shared/chat-format'
import { providerFingerprintV2 } from '../shared/provider-protocol-v2'
import {
  configuredCodexRoots,
  matchConfiguredCodexSessionPath,
  type CodexRootDefinition
} from './codex-session-roots'

// --- Codex JSONL envelope types ---

export interface CodexLine {
  timestamp: string
  type: 'session_meta' | 'event_msg' | 'response_item' | 'turn_context'
  payload: Record<string, unknown>
}

interface CodexThreadSpawnSource {
  parent_thread_id?: string
  depth?: number
  agent_path?: string
  agent_nickname?: string
  agent_role?: string | null
}

interface CodexSubagentSource {
  other?: string
  thread_spawn?: CodexThreadSpawnSource
}

export interface CodexSessionMeta {
  id: string
  session_id?: string
  timestamp: string
  cwd: string
  cli_version: string
  model_provider?: string
  git?: { branch?: string; repository_url?: string }
  source?: string | { subagent?: CodexSubagentSource }
  thread_source?: string
  parent_thread_id?: string
  forked_from_id?: string
  originator?: string
}

export type CodexSessionRole = 'top-level' | 'guardian' | 'thread-spawn' | 'subagent'

export interface CodexSessionClassification {
  role: CodexSessionRole
  parentThreadId?: string
  agentPath?: string
  agentNickname?: string
  agentRole?: string
}

export interface CodexSubagentRecord extends SessionSubagentSummary {
  tokenAccounting: TokenAccounting
}

export interface CodexSessionRecord {
  summary: SessionSummary | null
  subagent: CodexSubagentRecord | null
  classification: CodexSessionClassification
}

/**
 * A Codex source parse projected into both consumers used by live sync.
 * Keeping the raw projection beside the summary prevents the worker from
 * reopening a growing rollout solely to render the transcript.
 */
export interface CodexSessionRecordWithRaw extends CodexSessionRecord {
  rawMessages: RawJsonlMessage[]
}

/** Classify only from structured metadata; never infer a role from conversation text. */
export function classifyCodexSession(
  meta?: Partial<CodexSessionMeta>
): CodexSessionClassification {
  const source = meta?.source
  const subagent = source && typeof source === 'object' ? source.subagent : undefined
  const spawn = subagent?.thread_spawn
  const parentThreadId = spawn?.parent_thread_id || meta?.parent_thread_id

  if (subagent?.other === 'guardian') {
    return { role: 'guardian', ...(parentThreadId ? { parentThreadId } : {}) }
  }
  if (spawn) {
    return {
      role: 'thread-spawn',
      ...(parentThreadId ? { parentThreadId } : {}),
      ...(spawn.agent_path ? { agentPath: spawn.agent_path } : {}),
      ...(spawn.agent_nickname ? { agentNickname: spawn.agent_nickname } : {}),
      ...(spawn.agent_role ? { agentRole: spawn.agent_role } : {})
    }
  }
  if (subagent || meta?.thread_source === 'subagent') {
    return { role: 'subagent', ...(parentThreadId ? { parentThreadId } : {}) }
  }
  return { role: 'top-level' }
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

function usageSignature(record?: Record<string, unknown>): string {
  if (!record) return 'none'
  return [
    tokenNumber(record.input_tokens),
    tokenNumber(record.output_tokens),
    tokenNumber(record.cached_input_tokens),
    tokenNumber(record.cache_write_tokens) || tokenNumber(record.cache_creation_input_tokens),
    tokenNumber(record.reasoning_output_tokens) || tokenNumber(record.reasoning_tokens),
    costNumber(record) ?? ''
  ].join(':')
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

export function extractCodexTokenAccounting(
  lines: CodexLine[],
  scope: 'main' | 'subagent' = 'main'
): TokenAccounting {
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
      const totalKey = total ? usageSignature(total) : undefined
      const dedupHint = totalKey
        ? `codex:total:${totalKey}`
        : turnId
          ? `codex:turn:${turnId}:${usageSignature(last)}`
          : undefined
      const snapshot = codexSnapshot(
        last,
        'incremental',
        line.timestamp,
        currentModel,
        dedupHint,
        currentProvider,
        costNumber(last) ?? costNumber(info) ?? costNumber(line.payload)
      )
      snapshot.billingFactKey = totalKey || turnId
        ? [
            'codex:event', line.timestamp, currentModel || 'unknown-model',
            currentProvider || 'unknown-provider', turnId || 'no-turn-id',
            usageSignature(last), totalKey || 'no-total'
          ].join(':')
        : undefined
      perTurn.push(snapshot)
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

  return accountCodexUsage(
    perTurn.length > 0 ? perTurn : cumulative,
    scope,
    { startsWithInheritedBaseline: scope === 'subagent' && perTurn.length === 0 }
  )
}

// --- File discovery ---

const codexFileInventory = new Map<string, Set<string>>()

function scanCodexDirectory(directory: string): Set<string> {
  const files: string[] = []
  if (!fs.existsSync(directory)) return new Set()

  function walk(dir: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        files.push(full)
      }
    }
  }
  walk(directory)
  return new Set(files)
}

function filesForDirectory(directory: string): string[] {
  let inventory = codexFileInventory.get(directory)
  if (!inventory) {
    inventory = scanCodexDirectory(directory)
    codexFileInventory.set(directory, inventory)
  }
  for (const filePath of inventory) {
    if (!fs.existsSync(filePath)) inventory.delete(filePath)
  }
  return [...inventory]
}

function rootsForDiscovery(home?: string): CodexRootDefinition[] {
  if (home !== undefined) {
    const codexHome = path.join(home, '.codex')
    return [{
      home: codexHome,
      sessionsDir: path.join(codexHome, 'sessions'),
      archivedDir: path.join(codexHome, 'archived_sessions'),
      origin: 'default'
    }]
  }
  return configuredCodexRoots()
}

/** Cold-scan each root once; watcher events maintain the per-directory inventory afterwards. */
export function findCodexSessionFiles(home?: string): string[] {
  return [...new Set(rootsForDiscovery(home).flatMap((root) => [
    ...filesForDirectory(root.sessionsDir),
    ...filesForDirectory(root.archivedDir)
  ]))].sort()
}

/** One-shot discovery for CLI processes, which have no watcher to maintain an inventory. */
export function scanCodexSessionFiles(home?: string): string[] {
  const directories = rootsForDiscovery(home).flatMap((root) => [root.sessionsDir, root.archivedDir])
  for (const directory of directories) {
    codexFileInventory.set(directory, scanCodexDirectory(directory))
  }
  return [...new Set(directories.flatMap(filesForDirectory))].sort()
}

export function rememberCodexSessionFile(filePath: string): boolean {
  const match = matchConfiguredCodexSessionPath(filePath)
  if (!match) return false
  const directory = match.container === 'sessions' ? match.root.sessionsDir : match.root.archivedDir
  let inventory = codexFileInventory.get(directory)
  if (!inventory) {
    inventory = new Set()
    codexFileInventory.set(directory, inventory)
  }
  inventory.add(filePath)
  return true
}

/** Recovery-only rescan for roots whose watcher reported dropped events. */
export function refreshCodexSessionInventory(directories?: string[]): string[] {
  const targets = directories || configuredCodexRoots().flatMap((root) => [root.sessionsDir, root.archivedDir])
  for (const directory of targets) codexFileInventory.set(directory, scanCodexDirectory(directory))
  return [...new Set(targets.flatMap(filesForDirectory))].sort()
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
  const normalized = stripTerminalControlSequences(text)
  const trimmed = normalized.trim()
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
  return normalized
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

function codexFunctionOutputText(output: unknown): string {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  return output.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const text = (item as Record<string, unknown>).text
    return typeof text === 'string' ? [text] : []
  }).join('\n')
}

function codexReasoningText(payload: Record<string, unknown>): string {
  const values = [payload.summary, payload.content]
  return values.flatMap((value) => Array.isArray(value)
    ? value.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const text = (item as Record<string, unknown>).text
        return typeof text === 'string' ? [text] : []
      })
    : typeof value === 'string' ? [value] : []).join('\n')
}

// --- Convert Codex lines to unified RawJsonlMessage[] ---

function codexToRawMessages(lines: CodexLine[], sessionId: string): RawJsonlMessage[] {
  const messages: RawJsonlMessage[] = []
  const meta = lines.find((l) => l.type === 'session_meta')?.payload as unknown as CodexSessionMeta | undefined
  const cwd = meta?.cwd
  const model = extractCodexModel(lines)
  let msgIndex = 0
  let seenRealUserMessage = false
  let turnOrdinal = 0
  const assistantTextSourcesInTurn = new Map<string, 'event_msg' | 'response_item'>()
  const visibleAssistantTextByTurn = new Map<number, Set<string>>()
  const reasoningTurnByMessageId = new Map<string, number>()

  const pushAssistantText = (text: string, timestamp: string, source: 'event_msg' | 'response_item'): void => {
    const normalizedText = stripTerminalControlSequences(text)
    const dedupeKey = normalizedText.trim()
    if (!dedupeKey) return

    const previousSource = assistantTextSourcesInTurn.get(dedupeKey)
    if (previousSource && previousSource !== source) return
    if (!previousSource) assistantTextSourcesInTurn.set(dedupeKey, source)
    const visibleInTurn = visibleAssistantTextByTurn.get(turnOrdinal) || new Set<string>()
    visibleInTurn.add(dedupeKey)
    visibleAssistantTextByTurn.set(turnOrdinal, visibleInTurn)

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
        content: normalizedText
      }
    })
  }

  const pushSystemFact = (subtype: string, timestamp: string, data: Record<string, unknown>): void => {
    messages.push({
      uuid: `codex-${sessionId}-${msgIndex++}`,
      parentUuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
      sessionId,
      type: 'system',
      subtype,
      timestamp,
      cwd,
      version: model,
      data
    })
  }

  for (const line of lines) {
    const ts = line.timestamp

    if (line.type === 'event_msg') {
      const p = line.payload as Record<string, unknown>
      const etype = typeof p.type === 'string' ? p.type : ''

      // Skip user_message from event_msg — it duplicates response_item
      if (etype === 'agent_message') {
        pushAssistantText((p.message as string) || '', ts, 'event_msg')
      } else if (etype.includes('compact')) {
        pushSystemFact('compact_boundary', ts, p)
      } else if (etype.includes('rollback') || etype.includes('rolled_back') || etype.includes('undo')) {
        pushSystemFact('rollback', ts, {
          toEventId: typeof p.to_event_id === 'string' ? p.to_event_id : undefined,
          reason: typeof p.reason === 'string' ? p.reason : etype
        })
      } else if ((etype.includes('agent') || etype.includes('collab')) && etype.includes('spawn')) {
        pushSystemFact('subagent-spawn', ts, {
          agentId: typeof p.agent_id === 'string' ? p.agent_id : undefined,
          parentAgentId: typeof p.parent_agent_id === 'string' ? p.parent_agent_id : sessionId
        })
      } else if (etype.includes('review')) {
        pushSystemFact('review', ts, p)
      }
    } else if (line.type === 'response_item') {
      const p = line.payload as Record<string, unknown>
      const rtype = p.type as string

      if (rtype === 'reasoning') {
        const reasoning = codexReasoningText(p)
        if (reasoning || typeof p.encrypted_content === 'string') {
          const content: ContentPart[] = reasoning
            ? [{ type: 'reasoning', text: reasoning }]
            : [{ type: 'redacted_thinking', digest: providerFingerprintV2(p.encrypted_content) }]
          const uuid = `codex-${sessionId}-${msgIndex++}`
          messages.push({
            uuid,
            parentUuid: messages.length > 0 ? messages[messages.length - 1].uuid : null,
            sessionId,
            type: 'assistant',
            timestamp: ts,
            cwd,
            version: model,
            message: { role: 'assistant', model, content }
          })
          reasoningTurnByMessageId.set(uuid, turnOrdinal)
        }
      } else if (rtype === 'compaction') {
        pushSystemFact('compact_boundary', ts, p)
      } else if (rtype === 'message') {
        const role = p.role as string
        if (role === 'developer') continue
        if (role === 'user') {
          const content = p.content as Array<{ type: string; text: string }> | undefined
          const text = content?.filter((c) => c.type === 'input_text').map((c) => c.text).join('\n') || ''
          const normalizedText = normalizeCodexUserText(text, !seenRealUserMessage)
          if (normalizedText) {
            seenRealUserMessage = true
            turnOrdinal++
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
              input: stripTerminalControlSequencesDeep(args)
            }] as unknown as ContentPart[]
          }
        })
      } else if (rtype === 'function_call_output') {
        const callId = p.call_id as string
        const output = stripTerminalControlSequences(codexFunctionOutputText(p.output))
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

  return messages.filter((message) => {
    const content = message.message?.content
    if (message.type !== 'assistant' || !Array.isArray(content) || content.length === 0) return true
    if (!content.every((part) => part.type === 'reasoning')) return true
    const reasoning = content.map((part) => part.text || '').join('\n').trim()
    const messageTurn = reasoningTurnByMessageId.get(message.uuid)
    return messageTurn === undefined || !visibleAssistantTextByTurn.get(messageTurn)?.has(reasoning)
  })
}

// --- Build summary ---

function buildCodexSessionSummaryFromLines(
  filePath: string,
  lines: CodexLine[],
  sessionId: string,
  tokenAccounting: TokenAccounting,
  rawMessages: RawJsonlMessage[] = codexToRawMessages(lines, sessionId)
): SessionSummary | null {
  if (rawMessages.length === 0) return null

  const meta = lines.find((l) => l.type === 'session_meta')?.payload as unknown as CodexSessionMeta | undefined
  const cwds = meta?.cwd ? [meta.cwd] : []

  const userMessages = rawMessages.filter((m) => m.type === 'user' && m.message && typeof m.message.content === 'string' && m.message.content.trim())
  const assistantMessages = rawMessages.filter((m) => m.type === 'assistant')
  const turnCount = Math.min(userMessages.length, assistantMessages.length)

  const timestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const activityDays = activityDaysFromTimestamps(timestamps)
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
  const replayParentId = extractCodexReplayParentId(lines, sessionId)
  const pathLifecycle = matchConfiguredCodexSessionPath(filePath)?.lifecycleState
  const lifecycleState = pathLifecycle === 'archived'
    ? 'archived'
    : replayParentId
      ? 'replayed'
      : 'active'

  return {
    id: `codex:${sessionId}`,
    sessionId,
    slug: '',
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    activityDays,
    messageCount: rawMessages.length,
    turnCount,
    compactCount: rawMessages.filter((message) => message.type === 'system' && message.subtype === 'compact_boundary').length,
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
    lifecycleState,
    ...(replayParentId ? { branchParentId: `codex:${replayParentId}` } : {}),
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: totalTokenUsage,
    tokenAccounting,
    providerOutcome: {
      detected: 'detected',
      parse: 'parsed',
      usage: tokenAccounting.billingTotal === null ? 'unavailable' : 'available'
    },
    referencedFiles: [],
    configFiles: [],
    source: 'codex',
    allUserMessages,
    models: model ? [model] : []
  }
}

function extractCodexReplayParentId(lines: CodexLine[], sessionId: string): string | undefined {
  const metas = lines
    .filter((line) => line.type === 'session_meta')
    .map((line) => line.payload as unknown as Partial<CodexSessionMeta>)
  const explicit = metas[0]?.forked_from_id
  if (typeof explicit === 'string' && explicit && explicit !== sessionId) return explicit

  // Older fork/replay rollouts can lack forked_from_id while still copying the
  // original SessionMeta into the new file. A distinct inherited id is direct
  // structural evidence; conversation text is never used for lineage.
  const inherited = metas.slice(1).find((candidate) =>
    typeof candidate.id === 'string' && candidate.id && candidate.id !== sessionId
  )?.id
  return inherited
}

export async function loadCodexSessionRecordWithRaw(
  filePath: string,
  sessionIdOverride?: string
): Promise<CodexSessionRecordWithRaw> {
  const lines = await parseCodexFile(filePath)
  const meta = lines.find((line) => line.type === 'session_meta')?.payload as unknown as CodexSessionMeta | undefined
  const classification = classifyCodexSession(meta)
  const sessionId = sessionIdOverride || extractSessionId(filePath, lines)
  if (!sessionId) return { summary: null, subagent: null, classification, rawMessages: [] }

  const rawMessages = codexToRawMessages(lines, sessionId)

  const tokenAccounting = extractCodexTokenAccounting(
    lines,
    classification.role === 'top-level' ? 'main' : 'subagent'
  )
  if (classification.role === 'top-level') {
    return {
      summary: buildCodexSessionSummaryFromLines(filePath, lines, sessionId, tokenAccounting, rawMessages),
      subagent: null,
      classification,
      rawMessages
    }
  }

  const timestamps = lines.map((line) => line.timestamp).filter(Boolean).sort()
  const model = extractCodexModel(lines)
  const completed = lines.some((line) =>
    line.type === 'event_msg' && line.payload.type === 'task_complete'
  )
  return {
    summary: null,
    classification,
    rawMessages,
    subagent: {
      sessionId,
      ...(classification.parentThreadId ? { parentSessionId: classification.parentThreadId } : {}),
      role: classification.role,
      filePath,
      createdAt: timestamps[0] || meta?.timestamp || '',
      updatedAt: timestamps[timestamps.length - 1] || meta?.timestamp || '',
      ...(classification.agentPath ? { agentPath: classification.agentPath } : {}),
      ...(classification.agentNickname ? { agentNickname: classification.agentNickname } : {}),
      ...(classification.agentRole ? { agentRole: classification.agentRole } : {}),
      ...(model ? { model } : {}),
      status: completed ? 'completed' : 'unknown',
      tokenAccounting
    }
  }
}

export async function loadCodexSessionRecord(
  filePath: string,
  sessionIdOverride?: string
): Promise<CodexSessionRecord> {
  const { rawMessages: _rawMessages, ...record } = await loadCodexSessionRecordWithRaw(
    filePath,
    sessionIdOverride
  )
  return record
}

export async function buildCodexSessionSummary(
  filePath: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return (await loadCodexSessionRecord(filePath, sessionIdOverride)).summary
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
  const meta = lines.find((line) => line.type === 'session_meta')?.payload as unknown as CodexSessionMeta | undefined
  const classification = classifyCodexSession(meta)
  if (classification.role !== 'top-level') return null

  const summary = buildCodexSessionSummaryFromLines(
    filePath,
    lines,
    sessionId,
    extractCodexTokenAccounting(lines, 'main')
  )
  if (!summary) return null

  const rawMessages = codexToRawMessages(lines, sessionId)

  const messages: ParsedMessage[] = rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
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
        subtype: m.subtype,
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
