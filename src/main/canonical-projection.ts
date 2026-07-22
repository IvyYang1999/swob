import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  CanonicalRecord,
  MessageRecord,
  SessionRecord,
  ToolCallRecord,
  ToolResultEvent,
  UsageRecord
} from '../shared/provider-schema.generated'
import { stripTerminalControlSequences, stripTerminalControlSequencesDeep } from '../shared/chat-format'
import { activityDaysFromTimestamps } from './activity-time'
import { estimateActiveTime } from './insights'
import {
  processedTotal,
  tokenUsageFromAccounting,
  totalCacheWriteTokens,
  unavailableTokenAccounting,
  type NormalizedTokenComponents,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'
import type {
  ParsedMessage,
  RawJsonlMessage,
  SessionDetail,
  SessionSource,
  SessionSummary,
  TokenUsage,
  ToolCallInfo
} from './types'

export interface CanonicalProjectionOptions {
  filePath?: string
  source?: SessionSource
  fileSizeBytes?: number
}

function oneSession(records: CanonicalRecord[]): SessionRecord {
  const sessions = records.filter((record): record is SessionRecord => record.recordType === 'session')
  if (sessions.length !== 1) throw new Error('canonical-projection-requires-one-session')
  return sessions[0]
}

function textForMessage(message: MessageRecord, includeThinking = true): string {
  return stripTerminalControlSequences(message.content.flatMap((content) => {
    if (content.kind === 'text') return [content.text]
    if (content.kind === 'thinking' && includeThinking && content.text) {
      return [`[Thinking]\n${content.text}\n[/Thinking]`]
    }
    return []
  }).join('\n'))
}

function plainTextForMessage(message: MessageRecord): string {
  return stripTerminalControlSequences(message.content
    .filter((content) => content.kind === 'text')
    .map((content) => content.text)
    .join('\n'))
}

function resultText(result: ToolResultEvent | undefined): string | undefined {
  if (!result) return undefined
  if (typeof result.content === 'string') return stripTerminalControlSequences(result.content)
  try { return JSON.stringify(stripTerminalControlSequencesDeep(result.content)) }
  catch { return String(result.content) }
}

function toolInput(input: ToolCallRecord['input']): Record<string, unknown> {
  const sanitized = stripTerminalControlSequencesDeep(input)
  return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : { value: sanitized }
}

function nonNegative(value: number | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function usageComponents(usage: UsageRecord): NormalizedTokenComponents {
  return {
    nonCachedInputTokens: nonNegative(usage.inputTokens),
    outputTokens: nonNegative(usage.outputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens),
    cacheWriteTokens: nonNegative(usage.cacheWriteTokens),
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    reasoningTokens: nonNegative(usage.reasoningTokens)
  }
}

function addComponents(
  left: NormalizedTokenComponents,
  right: NormalizedTokenComponents
): NormalizedTokenComponents {
  return {
    nonCachedInputTokens: left.nonCachedInputTokens + right.nonCachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    cacheWrite5mTokens: left.cacheWrite5mTokens + right.cacheWrite5mTokens,
    cacheWrite1hTokens: left.cacheWrite1hTokens + right.cacheWrite1hTokens,
    reasoningTokens: (left.reasoningTokens || 0) + (right.reasoningTokens || 0)
  }
}

function accountingFor(records: UsageRecord[], source: SessionSource): TokenAccounting {
  const reported = records.filter((record) => record.usageProvenance !== 'unavailable')
  if (reported.length === 0) {
    return unavailableTokenAccounting(source, 'No authoritative canonical usage records were reported.')
  }
  const events: UsageEvent[] = reported.map((record) => ({
    provider: source,
    providerFormatVersion: record.provenance.formatVersion || 'canonical-v1',
    dedupKey: record.id,
    sourceRowId: record.id,
    timestamp: record.timestamp || undefined,
    modelRaw: record.model || undefined,
    modelProvenance: record.model ? 'response' : 'unknown',
    providerProvenance: 'unknown',
    scope: 'main',
    counterKind: 'incremental',
    provenance: record.usageProvenance === 'estimated'
      ? 'estimated'
      : record.usageProvenance === 'derived'
        ? 'derived'
        : 'reported',
    components: usageComponents(record),
    semantics: 'provider-specific',
    ...(record.costUsd !== null ? { reportedCostUsd: record.costUsd } : {}),
    warnings: []
  }))
  const components = events.reduce<NormalizedTokenComponents>(
    (total, event) => addComponents(total, event.components),
    {
      nonCachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      reasoningTokens: 0
    } satisfies NormalizedTokenComponents
  )
  const provenance: TokenAccounting['provenance'] = events.some((event) => event.provenance === 'estimated')
    ? 'estimated'
    : events.some((event) => event.provenance === 'derived')
      ? 'derived'
      : 'reported'
  return {
    provider: source,
    metricVersion: 2,
    provenance,
    billingTotal: processedTotal(components),
    conversationOnly: processedTotal(components),
    components,
    usageEvents: events,
    warnings: []
  }
}

function sourceFileSize(filePath: string, explicit?: number): number {
  if (explicit !== undefined) return explicit
  try { return fs.statSync(filePath).size } catch { return 0 }
}

function rawForMessage(message: MessageRecord): RawJsonlMessage {
  const role = message.role === 'assistant' ? 'assistant' : message.role === 'system' ? 'system' : 'user'
  return {
    uuid: message.id,
    parentUuid: null,
    sessionId: message.sessionRecordId,
    type: role,
    timestamp: message.timestamp || '',
    message: {
      role,
      content: message.content.map((content) => content.kind === 'thinking'
        ? { type: 'thinking', text: content.text }
        : content.kind === 'text'
          ? { type: 'text', text: content.text }
          : { type: 'text', text: content.uri })
    }
  }
}

function messageTokenUsage(usage: UsageRecord | undefined): TokenUsage | undefined {
  if (!usage || usage.usageProvenance === 'unavailable') return undefined
  const components = usageComponents(usage)
  return {
    inputTokens: components.nonCachedInputTokens,
    outputTokens: components.outputTokens,
    cacheCreationTokens: totalCacheWriteTokens(components),
    cacheReadTokens: components.cacheReadTokens
  }
}

export function canonicalRecordsToSessionSummary(
  records: CanonicalRecord[],
  options: CanonicalProjectionOptions = {}
): SessionSummary {
  const session = oneSession(records)
  const source = options.source || 'pi'
  const filePath = options.filePath || session.sourceRef.displayLocator
  const messages = records
    .filter((record): record is MessageRecord => record.recordType === 'message')
    .sort((left, right) => left.ordinal - right.ordinal)
  const calls = records.filter((record): record is ToolCallRecord => record.recordType === 'tool-call')
  const usages = records.filter((record): record is UsageRecord => record.recordType === 'usage')
  const timestamps = messages.flatMap((message) => message.timestamp ? [message.timestamp] : []).sort()
  const firstUser = messages.find((message) => message.role === 'user')
  const userMessages = messages.filter((message) => message.role === 'user')
  const assistantMessages = messages.filter((message) => message.role === 'assistant')
  const tokenAccounting = accountingFor(usages, source)
  const toolUsage: Record<string, number> = {}
  for (const call of calls) toolUsage[call.name] = (toolUsage[call.name] || 0) + 1
  const projectedRaw = messages.map(rawForMessage)
  return {
    id: session.id,
    sessionId: session.sourceSessionId,
    resumeSessionId: session.sourceSessionId,
    slug: '',
    createdAt: session.createdAt || timestamps[0] || '',
    updatedAt: session.updatedAt || timestamps.at(-1) || session.createdAt || '',
    activityDays: activityDaysFromTimestamps(timestamps),
    messageCount: messages.length,
    turnCount: Math.min(userMessages.length, assistantMessages.length),
    compactCount: messages.filter((message) => message.role === 'system').length,
    cwds: session.cwd,
    version: session.provenance.formatVersion || '',
    firstUserMessage: (firstUser ? plainTextForMessage(firstUser) : session.providerTitle || session.sourceSessionId).slice(0, 200),
    toolUsage,
    skillInvocations: [],
    projectPath: session.projectPath || session.cwd[0] || path.dirname(filePath),
    filePath,
    fileSizeBytes: sourceFileSize(filePath, options.fileSizeBytes),
    allFilePaths: [filePath],
    resumeCwd: session.cwd[0],
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: tokenUsageFromAccounting(tokenAccounting),
    tokenAccounting,
    providerOutcome: {
      detected: 'detected',
      parse: 'parsed',
      usage: tokenAccounting.billingTotal === null ? 'unavailable' : 'available'
    },
    referencedFiles: [],
    configFiles: [],
    source,
    allUserMessages: userMessages.slice(1).map(plainTextForMessage).filter(Boolean).join(' ') || undefined,
    estimatedTime: estimateActiveTime(projectedRaw),
    models: [...new Set(usages.flatMap((usage) => usage.model ? [usage.model] : []))]
  }
}

export function canonicalRecordsToSessionDetail(
  records: CanonicalRecord[],
  options: CanonicalProjectionOptions = {}
): SessionDetail {
  const summary = canonicalRecordsToSessionSummary(records, options)
  const messages = records
    .filter((record): record is MessageRecord => record.recordType === 'message')
    .sort((left, right) => left.ordinal - right.ordinal)
  const calls = records.filter((record): record is ToolCallRecord => record.recordType === 'tool-call')
  const results = new Map(records
    .filter((record): record is ToolResultEvent => record.recordType === 'tool-result')
    .map((result) => [result.toolCallRecordId, result]))
  const usageByMessage = new Map(records
    .filter((record): record is UsageRecord => record.recordType === 'usage' && Boolean(record.messageRecordId))
    .map((usage) => [usage.messageRecordId!, usage]))
  const callsByMessage = new Map<string, ToolCallInfo[]>()
  for (const call of calls) {
    if (!call.messageRecordId) continue
    const list = callsByMessage.get(call.messageRecordId) || []
    list.push({
      id: call.id,
      name: call.name,
      input: toolInput(call.input),
      ...(results.has(call.id) ? { result: resultText(results.get(call.id)) } : {})
    })
    callsByMessage.set(call.messageRecordId, list)
  }
  const projected: ParsedMessage[] = messages.map((message) => {
    const type: ParsedMessage['type'] = message.role === 'assistant'
      ? 'assistant'
      : message.role === 'system'
        ? 'system'
        : 'user'
    return {
      uuid: message.id,
      type,
      timestamp: message.timestamp || '',
      role: message.role,
      origin: type === 'user' ? 'human' : 'unknown',
      textContent: textForMessage(message),
      toolCalls: callsByMessage.get(message.id) || [],
      images: [],
      tokenUsage: messageTokenUsage(usageByMessage.get(message.id)),
      isPreCompact: false,
      isSidechain: false,
      isSharedContext: false,
      isSystemGenerated: type === 'system',
      raw: rawForMessage(message)
    }
  })
  return { ...summary, messages: projected }
}
