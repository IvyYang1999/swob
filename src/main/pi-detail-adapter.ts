import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  ContentPart,
  ParsedMessage,
  RawJsonlMessage,
  SessionDetail,
  TokenUsage,
  ToolCallInfo
} from './types'

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  modelId?: string
  summary?: string
  version?: number
  branchedFrom?: string
  message?: {
    role?: string
    content?: unknown
    timestamp?: number
    toolCallId?: string
    toolName?: string
    isError?: boolean
    usage?: Record<string, unknown>
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function timestamp(entry: PiEntry): string {
  if (typeof entry.timestamp === 'string') return entry.timestamp
  return typeof entry.message?.timestamp === 'number'
    ? new Date(entry.message.timestamp).toISOString()
    : ''
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function normalizedUsage(usage: Record<string, unknown> | undefined): TokenUsage | undefined {
  if (!usage) return undefined
  const cache = object(usage.cache)
  const observed = [
    usage.input, usage.output, usage.cacheRead, usage.cacheCreation,
    cache?.read, cache?.write
  ].some((value) => typeof value === 'number' && Number.isFinite(value))
  if (!observed) return undefined
  return {
    inputTokens: usageNumber(usage.input),
    outputTokens: usageNumber(usage.output),
    cacheReadTokens: usageNumber(usage.cacheRead ?? cache?.read),
    cacheCreationTokens: usageNumber(usage.cacheCreation ?? cache?.write)
  }
}

function activeEntryIds(entries: PiEntry[]): Set<string> {
  const treeEntries = entries.filter((entry) =>
    entry.id && Object.prototype.hasOwnProperty.call(entry, 'parentId')
  )
  // Pi v1/v2 are ordered logs. Treating their last id as a v3 active leaf would
  // incorrectly archive every earlier row.
  if (treeEntries.length === 0) return new Set()
  const byId = new Map(entries.flatMap((entry) => entry.id ? [[entry.id, entry] as const] : []))
  const active = new Set<string>()
  let current = treeEntries.at(-1)?.id
  while (current && !active.has(current)) {
    active.add(current)
    current = byId.get(current)?.parentId || undefined
  }
  return active
}

function activeLeafId(entries: PiEntry[]): string | undefined {
  return [...entries].reverse().find((entry) =>
    entry.id && Object.prototype.hasOwnProperty.call(entry, 'parentId')
  )?.id
}

function normalizedParts(content: unknown): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) {
    return content === undefined ? [] : [{ type: 'provider-extension', data: content }]
  }
  const parts: ContentPart[] = []
  for (const candidate of content) {
    const item = object(candidate)
    if (!item) {
      parts.push({ type: 'provider-extension', data: candidate })
      continue
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push({ type: 'text', text: item.text })
    } else if (item.type === 'thinking' && typeof item.thinking === 'string') {
      parts.push({ type: 'thinking', text: item.thinking })
    } else if (item.type === 'toolCall' && typeof item.name === 'string') {
      parts.push({
        type: 'tool_use',
        id: typeof item.id === 'string' ? item.id : undefined,
        name: item.name,
        input: object(item.arguments) || {}
      })
    } else {
      parts.push({
        type: typeof item.type === 'string' ? item.type : 'provider-extension',
        data: candidate
      })
    }
  }
  return parts
}

function parsed(raw: RawJsonlMessage): ParsedMessage {
  const content = raw.message?.content
  const parts = Array.isArray(content) ? content : []
  const toolCalls: ToolCallInfo[] = parts.flatMap((part) =>
    part.type === 'tool_use' && part.name
      ? [{ id: part.id, name: part.name, input: part.input || {} }]
      : []
  )
  const textContent = typeof content === 'string'
    ? content
    : parts.flatMap((part) => part.type === 'text' && part.text ? [part.text] : []).join('\n')
  const usage = raw.message?.usage
  return {
    uuid: raw.uuid,
    type: raw.type as ParsedMessage['type'],
    subtype: raw.subtype,
    timestamp: raw.timestamp,
    role: raw.message?.role,
    origin: raw.type === 'user' && !raw.toolUseResult ? 'human' : 'unknown',
    textContent,
    toolCalls,
    images: [],
    ...(usage ? {
      tokenUsage: {
        inputTokens: usageNumber(usage.input_tokens),
        outputTokens: usageNumber(usage.output_tokens),
        cacheCreationTokens: usageNumber(usage.cache_creation_input_tokens),
        cacheReadTokens: usageNumber(usage.cache_read_input_tokens)
      }
    } : {}),
    isPreCompact: false,
    isSidechain: Boolean(raw.isSidechain),
    isSharedContext: false,
    isSystemGenerated: raw.type === 'system' || Boolean(raw.toolUseResult),
    raw
  }
}

function pairToolResults(messages: ParsedMessage[]): void {
  const calls = new Map(messages.flatMap((message) => message.toolCalls.flatMap((call) =>
    call.id ? [[call.id, call] as const] : []
  )))
  for (const message of messages) {
    const content = message.raw.message?.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part.type !== 'tool_result' || !part.tool_use_id) continue
      const result = typeof part.content === 'string'
        ? part.content
        : Array.isArray(part.content)
          ? part.content.flatMap((child) => child.text ? [child.text] : []).join('\n')
          : ''
      const call = calls.get(part.tool_use_id)
      if (call && result) call.result = result
    }
  }
}

/** Upgrade the display-side Pi projection without mutating the provider source. */
export async function enrichPiSessionDetailV2(detail: SessionDetail): Promise<SessionDetail> {
  const rows = (await fs.promises.readFile(detail.filePath, 'utf8'))
    .split(/\r?\n/)
    .flatMap((line): PiEntry[] => {
      if (!line.trim()) return []
      try { return [JSON.parse(line) as PiEntry] } catch { return [] }
    })
  const active = activeEntryIds(rows)
  const activeLeaf = activeLeafId(rows)
  const header = rows.find((entry) => entry.type === 'session')
  const rawMessages: RawJsonlMessage[] = []
  let syntheticIndex = 0

  for (const entry of rows) {
    const id = entry.id || `pi-row-${syntheticIndex++}`
    const sidechain = Boolean(
      entry.id &&
      Object.prototype.hasOwnProperty.call(entry, 'parentId') &&
      active.size > 0 &&
      !active.has(entry.id)
    )
    if (entry.type === 'compaction') {
      rawMessages.push({
        uuid: id,
        parentUuid: entry.parentId || null,
        sessionId: detail.sessionId,
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: timestamp(entry),
        isSidechain: sidechain,
        message: { role: 'system', content: entry.summary || '' }
      })
      continue
    }
    if (entry.type === 'model_change' && entry.modelId) {
      rawMessages.push({
        uuid: id,
        parentUuid: entry.parentId || null,
        sessionId: detail.sessionId,
        type: 'system',
        subtype: 'model-change',
        timestamp: timestamp(entry),
        isSidechain: sidechain,
        data: { modelId: entry.modelId }
      })
      continue
    }
    if (entry.type !== 'message' || !entry.message?.role) continue
    const role = entry.message.role
    if (role === 'toolResult') {
      const normalized = normalizedParts(entry.message.content)
      rawMessages.push({
        uuid: id,
        parentUuid: entry.parentId || null,
        sessionId: detail.sessionId,
        type: 'user',
        timestamp: timestamp(entry),
        isSidechain: sidechain,
        toolUseResult: true,
        message: {
          role: 'tool',
          content: [{
            type: 'tool_result',
            tool_use_id: entry.message.toolCallId || `missing:${id}`,
            is_error: typeof entry.message.isError === 'boolean' ? entry.message.isError : undefined,
            content: typeof entry.message.content === 'string'
              ? entry.message.content
              : normalized
          }]
        }
      })
      continue
    }
    if (role !== 'user' && role !== 'assistant') continue
    const normalized = normalizedParts(entry.message.content)
    const usage = normalizedUsage(entry.message.usage)
    rawMessages.push({
      uuid: id,
      parentUuid: entry.parentId || null,
      sessionId: detail.sessionId,
      type: role,
      timestamp: timestamp(entry),
      isSidechain: sidechain,
      message: {
        role,
        content: normalized,
        ...(usage ? {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_creation_input_tokens: usage.cacheCreationTokens,
            cache_read_input_tokens: usage.cacheReadTokens
          }
        } : {})
      }
    })
  }

  if (rawMessages.length === 0) return detail
  const messages = rawMessages.map(parsed)
  pairToolResults(messages)
  return {
    ...detail,
    version: header?.version === 2
      ? 'pi-jsonl-v2'
      : typeof header?.version === 'number' && header.version >= 3
        ? 'pi-jsonl-v3'
        : 'pi-jsonl-v1',
    ...(activeLeaf ? { branchLeafUuid: activeLeaf } : {}),
    ...(header?.branchedFrom ? {
      branchParentId: path.basename(header.branchedFrom, path.extname(header.branchedFrom))
    } : {}),
    messageCount: messages.length,
    turnCount: messages.filter((message) => message.type === 'user' && !message.isSystemGenerated).length,
    compactCount: rawMessages.filter((message) => message.subtype === 'compact_boundary').length,
    messages
  }
}
