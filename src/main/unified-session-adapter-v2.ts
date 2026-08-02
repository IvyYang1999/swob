import type {
  CanonicalEvent,
  CanonicalEventKind,
  EventProvenance,
  JsonValue,
  ParseChunk,
  SessionIdentity,
  UsageRecord
} from '../shared/provider-schema-v2.generated'
import {
  providerFingerprintV2,
  validateParseChunkV2
} from '../shared/provider-protocol-v2'
import { createBuiltinToolRegistryV2 } from '../shared/tool-registry-v2'
import {
  unifiedProviderDescriptorV2,
  type UnifiedProviderDescriptorV2
} from '../shared/seven-source-contract-v2'
import type {
  ContentPart,
  ParsedMessage,
  RawJsonlMessage,
  SessionDetail,
  TokenUsage,
  ToolCallInfo
} from './types'
import type { UsageEvent } from './token-accounting'
import { renderCanonicalEventPage } from './canonical-v2-projection'

export const UNIFIED_ADAPTER_CHUNK_EVENTS = 1_000

export interface UnifiedSessionAdapterResultV2 {
  descriptor: UnifiedProviderDescriptorV2
  events: CanonicalEvent[]
  chunks: ParseChunk[]
  detail: SessionDetail
}

interface EventInput {
  messageId?: string | null
  blockIndex?: number | null
  timestamp?: string | null
  actor: CanonicalEvent['actor']
  kind: CanonicalEventKind
  payload: JsonValue
  visibility?: CanonicalEvent['visibility']
  classification?: CanonicalEvent['classification']
  sourceRecordId: string
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonValue)
  if (!value || typeof value !== 'object') return String(value)
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, child]) => [key, jsonValue(child)]))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function sourceIdentity(detail: SessionDetail, descriptor: UnifiedProviderDescriptorV2): SessionIdentity {
  const physicalSourceId = `${descriptor.providerId}:${providerFingerprintV2(detail.filePath).slice(0, 24)}`
  const logicalSessionKey = detail.logicalSessionKey ||
    `v2\0${descriptor.providerId}\0${detail.sessionId}`
  return {
    physicalSourceId,
    logicalSessionKey,
    logicalSessionId: detail.sessionId,
    branchViewId: detail.branchLeafUuid || `${descriptor.providerId}:${detail.id}:default`,
    parentBranchViewId: detail.branchParentId || null
  }
}

function formatVersionForDetail(
  detail: SessionDetail,
  descriptor: UnifiedProviderDescriptorV2
): string | null {
  const observed = [
    detail.version,
    ...detail.messages.flatMap((message) => message.raw?.version ? [message.raw.version] : [])
  ].filter(Boolean)
  return descriptor.formatVersions.find((format) => observed.includes(format.id))?.id ||
    descriptor.formatVersions[0]?.id || null
}

function eventProvenance(
  descriptor: UnifiedProviderDescriptorV2,
  identity: SessionIdentity,
  sourceRecordId: string,
  formatVersion: string | null
): EventProvenance {
  return {
    providerId: descriptor.providerId,
    sourceRefId: identity.physicalSourceId,
    parserDataVersion: 't173.1',
    formatVersion,
    observedAt: null,
    sourceRecordId,
    rawRecordFingerprint: null
  }
}

function timeline(sequence: number): CanonicalEvent['timeline'] {
  return {
    archived: true,
    modelContext: [{
      contextRevision: 0,
      state: 'visible-to-model',
      fromSequence: sequence,
      untilSequence: null
    }]
  }
}

function inputForTool(input: JsonValue): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input }
}

function textFromJson(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const text = value.text
    if (typeof text === 'string') return text
  }
  try { return JSON.stringify(value) } catch { return String(value) }
}

function interactionPayload(
  callId: string,
  input: JsonValue,
  answered: boolean
): JsonValue {
  const object = inputForTool(input)
  const questions = Array.isArray(object.questions) ? object.questions : []
  const first = objectValue(questions[0])
  const options = Array.isArray(first.options) ? first.options : []
  return {
    requestId: callId,
    prompt: typeof first.question === 'string'
      ? first.question
      : typeof object.question === 'string' ? object.question : '',
    options: options.flatMap((candidate, index) => {
      const item = objectValue(candidate)
      const label = typeof item.label === 'string'
        ? item.label
        : typeof candidate === 'string' ? candidate : ''
      return label ? [{
        id: String(index),
        label,
        description: typeof item.description === 'string' ? item.description : null
      }] : []
    }),
    multiSelect: first.multiSelect === true || object.multiSelect === true,
    state: { state: 'historical', answered },
    toolCallId: callId,
    rawInput: input
  }
}

function permissionPayload(callId: string, input: JsonValue, answered: boolean): JsonValue {
  const object = inputForTool(input)
  return {
    requestId: callId,
    permission: typeof object.permission === 'string'
      ? object.permission
      : typeof object.tool_name === 'string' ? object.tool_name : 'unspecified',
    resource: jsonValue(object.resource ?? object.input ?? object),
    state: { state: 'historical', answered },
    toolCallId: callId,
    rawInput: input
  }
}

function resultText(part: ContentPart): string {
  if (typeof part.content === 'string') return part.content
  if (!Array.isArray(part.content)) return ''
  return part.content.flatMap((child) => child.text ? [child.text] : []).join('\n')
}

function resultOutput(part: ContentPart): JsonValue {
  if (typeof part.content === 'string') return part.content
  if (!Array.isArray(part.content)) return ''
  if (part.content.every((child) => child.type === 'text' && typeof child.text === 'string')) {
    return part.content.map((child) => child.text).join('\n')
  }
  return jsonValue(part.content)
}

function contentParts(message: ParsedMessage): ContentPart[] {
  const rawContent = message.raw?.message?.content
  if (Array.isArray(rawContent)) return rawContent
  if (typeof rawContent === 'string') return [{ type: 'text', text: rawContent }]
  return message.textContent ? [{ type: 'text', text: message.textContent }] : []
}

function canonicalEventsForMessages(
  detail: SessionDetail,
  descriptor: UnifiedProviderDescriptorV2,
  identity: SessionIdentity
): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  const registry = createBuiltinToolRegistryV2()
  const toolSemantics = new Map<string, string>()
  const answeredToolCalls = new Set(detail.messages.flatMap((message) =>
    contentParts(message).flatMap((part) => part.type === 'tool_result' && part.tool_use_id ? [part.tool_use_id] : [])
  ))
  const formatVersion = formatVersionForDetail(detail, descriptor)

  const push = (input: EventInput): CanonicalEvent => {
    const sequence = events.length
    const event: CanonicalEvent = {
      id: `${descriptor.providerId}:event:${sequence}`,
      identity,
      sharedEventKey: `${descriptor.providerId}:shared:${input.sourceRecordId}:${input.blockIndex ?? 'event'}`,
      messageId: input.messageId ?? null,
      sequence,
      messageBlockIndex: input.blockIndex ?? null,
      timestamp: input.timestamp || null,
      actor: input.actor,
      kind: input.kind,
      payload: input.payload,
      visibility: input.visibility || 'primary',
      classification: input.classification || 'unknown',
      timeline: timeline(sequence),
      provenance: eventProvenance(descriptor, identity, input.sourceRecordId, formatVersion),
      rawRef: null
    }
    events.push(event)
    return event
  }

  for (const message of detail.messages) {
    const raw = message.raw || {} as RawJsonlMessage
    const subtype = (message.subtype || raw.subtype || '').toLowerCase()
    const messageEventStart = events.length
    const outsideActiveBranch = message.isSidechain || Boolean(raw.isSidechain)
    const finishMessage = (): void => {
      if (!outsideActiveBranch) return
      for (const event of events.slice(messageEventStart)) {
        event.visibility = 'collapsed'
        event.timeline.modelContext = [{
          contextRevision: 0,
          state: 'archived',
          fromSequence: event.sequence,
          untilSequence: null
        }]
      }
    }
    const actor: CanonicalEvent['actor'] = message.type === 'assistant'
      ? 'assistant'
      : message.type === 'user'
        ? message.isSystemGenerated ? 'tool' : 'user'
        : 'system'

    if (subtype.includes('compact')) {
      const compaction = push({
        messageId: message.uuid,
        timestamp: message.timestamp,
        actor: 'system',
        kind: 'context.compaction',
        payload: {
          contextRevision: 0,
          archivedThroughSequence: Math.max(0, events.length - 1),
          summaryEventId: null
        },
        visibility: 'collapsed',
        classification: 'lifecycle',
        sourceRecordId: message.uuid
      })
      if (message.textContent) {
        const summary = push({
          messageId: message.uuid,
          timestamp: message.timestamp,
          actor: 'system',
          kind: 'context.summary',
          payload: { text: message.textContent, contextRevision: 0 },
          visibility: 'collapsed',
          classification: 'promoted-system',
          sourceRecordId: message.uuid
        })
        const compactionPayload = compaction.payload as Record<string, JsonValue>
        compactionPayload.summaryEventId = summary.id
      }
      finishMessage()
      continue
    }

    if (subtype === 'model-change') {
      const data = objectValue(raw.data)
      if (typeof data.modelId === 'string' && data.modelId) {
        push({
          messageId: message.uuid,
          timestamp: message.timestamp,
          actor: 'system',
          kind: 'model.changed',
          payload: { fromModelId: null, toModelId: data.modelId },
          visibility: 'collapsed',
          classification: 'lifecycle',
          sourceRecordId: message.uuid
        })
      }
      finishMessage()
      continue
    }

    if (subtype === 'rollback') {
      const data = objectValue(raw.data)
      push({
        timestamp: message.timestamp,
        actor: 'system',
        kind: 'rollback',
        payload: {
          toEventId: typeof data.toEventId === 'string' ? data.toEventId : message.uuid,
          reason: typeof data.reason === 'string' ? data.reason : 'provider rollback'
        },
        visibility: 'collapsed',
        classification: 'lifecycle',
        sourceRecordId: message.uuid
      })
      finishMessage()
      continue
    }

    if (subtype === 'subagent-spawn') {
      const data = objectValue(raw.data)
      push({
        timestamp: message.timestamp,
        actor: 'system',
        kind: 'subagent.spawn',
        payload: {
          agentId: typeof data.agentId === 'string' ? data.agentId : message.uuid,
          parentAgentId: typeof data.parentAgentId === 'string' ? data.parentAgentId : detail.sessionId
        },
        visibility: 'collapsed',
        classification: 'lifecycle',
        sourceRecordId: message.uuid
      })
      finishMessage()
      continue
    }

    if (subtype === 'review') {
      push({
        timestamp: message.timestamp,
        actor: 'system',
        kind: 'mode.changed',
        payload: { fromMode: null, toMode: 'review' },
        visibility: 'collapsed',
        classification: 'lifecycle',
        sourceRecordId: message.uuid
      })
      finishMessage()
      continue
    }

    let blockIndex = 0
    for (const part of contentParts(message)) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text) {
        push({
          messageId: message.uuid,
          blockIndex: blockIndex++,
          timestamp: message.timestamp,
          actor,
          kind: 'message.text',
          payload: { text: part.text },
          visibility: message.type === 'system' ? 'collapsed' : 'primary',
          classification: message.type === 'system' || message.isSystemGenerated
            ? 'promoted-system'
            : 'user-content',
          sourceRecordId: message.uuid
        })
        continue
      }
      if ((part.type === 'thinking' || part.type === 'reasoning') && typeof part.text === 'string') {
        push({
          messageId: message.uuid,
          blockIndex: blockIndex++,
          timestamp: message.timestamp,
          actor: 'assistant',
          kind: part.type === 'thinking' ? 'message.thinking' : 'message.reasoning',
          payload: { text: part.text },
          visibility: 'collapsed',
          classification: 'user-content',
          sourceRecordId: message.uuid
        })
        continue
      }
      if (part.type === 'redacted_thinking') {
        const value = objectValue(part)
        push({
          messageId: message.uuid,
          blockIndex: blockIndex++,
          timestamp: message.timestamp,
          actor: 'assistant',
          kind: 'message.redacted-thinking',
          payload: {
            reason: typeof value.reason === 'string' ? value.reason : null,
            digest: typeof value.digest === 'string' ? value.digest : null
          },
          visibility: 'collapsed',
          classification: 'user-content',
          sourceRecordId: message.uuid
        })
        continue
      }
      if (part.type === 'tool_use' && part.name) {
        const callId = part.id || `${message.uuid}:tool:${blockIndex}`
        const resolved = registry.resolve({
          providerId: descriptor.providerId,
          formatVersion,
          rawName: part.name,
          callId,
          input: jsonValue(part.input || {})
        })
        toolSemantics.set(callId, resolved.semanticToolId)
        push({
          messageId: message.uuid,
          blockIndex: blockIndex++,
          timestamp: message.timestamp,
          actor: 'assistant',
          kind: 'tool.call',
          payload: {
            callId,
            rawName: part.name,
            semanticToolId: resolved.semanticToolId,
            input: resolved.normalizedInput
          },
          classification: 'user-content',
          sourceRecordId: message.uuid
        })
        if (resolved.semanticToolId === 'interaction.question') {
          push({
            messageId: message.uuid,
            blockIndex: blockIndex++,
            timestamp: message.timestamp,
            actor: 'assistant',
            kind: 'interaction.request',
            payload: interactionPayload(callId, resolved.normalizedInput, answeredToolCalls.has(callId)),
            classification: 'interaction',
            sourceRecordId: message.uuid
          })
        } else if (resolved.semanticToolId === 'permission.request') {
          push({
            messageId: message.uuid,
            blockIndex: blockIndex++,
            timestamp: message.timestamp,
            actor: 'assistant',
            kind: 'permission.request',
            payload: permissionPayload(callId, resolved.normalizedInput, answeredToolCalls.has(callId)),
            classification: 'interaction',
            sourceRecordId: message.uuid
          })
        }
        continue
      }
      if (part.type === 'tool_result' && part.tool_use_id) {
        const callId = part.tool_use_id
        const output = resultOutput(part)
        const outputText = resultText(part)
        push({
          messageId: message.uuid,
          blockIndex: blockIndex++,
          timestamp: message.timestamp,
          actor: 'tool',
          kind: 'tool.result',
          payload: {
            callId,
            output,
            isError: typeof part.is_error === 'boolean' ? part.is_error : null,
            state: part.is_error ? 'error' : 'complete'
          },
          visibility: 'collapsed',
          classification: 'user-content',
          sourceRecordId: message.uuid
        })
        const semantic = toolSemantics.get(callId)
        if (semantic === 'interaction.question') {
          push({
            messageId: message.uuid,
            blockIndex: blockIndex++,
            timestamp: message.timestamp,
            actor: 'user',
            kind: 'interaction.response',
            payload: { requestId: callId, outcome: 'answered', answers: outputText ? [outputText] : [], toolCallId: callId },
            classification: 'interaction',
            sourceRecordId: message.uuid
          })
        } else if (semantic === 'permission.request') {
          push({
            messageId: message.uuid,
            blockIndex: blockIndex++,
            timestamp: message.timestamp,
            actor: 'user',
            kind: 'permission.response',
            payload: {
              requestId: callId,
              decision: /deny|denied|reject/i.test(outputText)
                ? 'deny'
                : /allow|allowed|approve/i.test(outputText) ? 'allow' : 'cancelled',
              toolCallId: callId
            },
            classification: 'interaction',
            sourceRecordId: message.uuid
          })
        }
        continue
      }
      push({
        messageId: message.uuid,
        blockIndex: blockIndex++,
        timestamp: message.timestamp,
        actor,
        kind: 'unknown',
        payload: { rawType: `content.${part.type || 'unknown'}`, rawPayload: jsonValue(part) },
        visibility: 'collapsed',
        classification: 'unknown',
        sourceRecordId: message.uuid
      })
    }

    if (raw.data !== undefined) {
      push({
        messageId: message.uuid,
        timestamp: message.timestamp,
        actor,
        kind: 'unknown',
        payload: { rawType: `${raw.type || 'message'}.extension`, rawPayload: jsonValue(raw.data) },
        visibility: 'collapsed',
        classification: 'unknown',
        sourceRecordId: message.uuid
      })
    }
    finishMessage()
  }

  return events
}

type EventFieldRelations = NonNullable<UsageEvent['fieldRelations']>

function cacheRelationForV2(
  relation: EventFieldRelations['cacheRead']
): UsageRecord['relations']['cacheRead'] {
  return relation === 'disjoint' ? 'independent' : relation
}

function reasoningRelationForV2(
  relation: EventFieldRelations['reasoning']
): UsageRecord['relations']['reasoning'] {
  return relation === 'disjoint-from-visible-output' ? 'independent' : relation
}

function usagePayload(event: UsageEvent): UsageRecord {
  const components = event.components
  const writes = components.cacheWriteTokens + components.cacheWrite5mTokens + components.cacheWrite1hTokens
  const inputTotal = components.nonCachedInputTokens + components.cacheReadTokens + writes
  const reasoning = components.reasoningTokens ?? null
  const visibleOutput = components.visibleOutputTokens ?? (reasoning === null
    ? components.outputTokens
    : Math.max(0, components.outputTokens - reasoning))
  const legacySubset = event.semantics === 'openai-input-subset'
  return {
    eventId: event.sourceRowId || null,
    turnId: event.sourceRowId || null,
    modelId: event.modelCanonical || event.modelRaw || event.model || null,
    input: {
      total: inputTotal,
      uncached: components.nonCachedInputTokens,
      cacheRead: components.cacheReadTokens,
      cacheWrite5m: components.cacheWrite5mTokens + components.cacheWriteTokens,
      cacheWrite1h: components.cacheWrite1hTokens
    },
    output: {
      total: components.outputTokens,
      visible: visibleOutput,
      reasoning
    },
    providerTotal: inputTotal + components.outputTokens,
    aggregation: event.counterKind === 'cumulative-delta' ? 'delta' : 'per-message',
    relations: {
      cacheRead: cacheRelationForV2(event.fieldRelations?.cacheRead || (legacySubset ? 'subset-of-input' : 'provider-defined')),
      cacheWrite: cacheRelationForV2(event.fieldRelations?.cacheWrite || (legacySubset ? 'subset-of-input' : 'provider-defined')),
      reasoning: reasoningRelationForV2(event.fieldRelations?.reasoning || (legacySubset ? 'subset-of-output' : 'provider-defined'))
    },
    dedupKey: event.dedupKey,
    billingFactKey: event.billingFactKey || `${event.provider}:${event.dedupKey}`,
    measurement: {
      source: event.provenance,
      confidence: event.provenance === 'reported' ? 'exact' : event.provenance === 'derived' ? 'high' : 'low',
      sourceField: event.providerFormatVersion
    },
    cost: event.reportedCostUsd === undefined
      ? null
      : { amount: event.reportedCostUsd, currency: 'USD', kind: 'reported' },
    priceRevision: null
  }
}

function unavailableUsagePayload(detail: SessionDetail): UsageRecord {
  return {
    eventId: null,
    turnId: null,
    modelId: null,
    input: { total: null, uncached: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    output: { total: null, visible: null, reasoning: null },
    providerTotal: null,
    aggregation: 'per-message',
    relations: { cacheRead: 'provider-defined', cacheWrite: 'provider-defined', reasoning: 'provider-defined' },
    dedupKey: `${detail.source}:usage-unavailable:${detail.sessionId}`,
    billingFactKey: `${detail.source}:usage-unavailable:${detail.sessionId}`,
    measurement: { source: 'unavailable', confidence: 'unavailable', sourceField: null },
    cost: null,
    priceRevision: null
  }
}

function appendUsageAndRelationships(
  detail: SessionDetail,
  descriptor: UnifiedProviderDescriptorV2,
  identity: SessionIdentity,
  events: CanonicalEvent[]
): void {
  const formatVersion = formatVersionForDetail(detail, descriptor)
  const append = (input: EventInput): void => {
    const sequence = events.length
    events.push({
      id: `${descriptor.providerId}:event:${sequence}`,
      identity,
      sharedEventKey: `${descriptor.providerId}:shared:${input.sourceRecordId}`,
      messageId: input.messageId ?? null,
      sequence,
      messageBlockIndex: input.blockIndex ?? null,
      timestamp: input.timestamp || null,
      actor: input.actor,
      kind: input.kind,
      payload: input.payload,
      visibility: input.visibility || 'collapsed',
      classification: input.classification || 'lifecycle',
      timeline: timeline(sequence),
      provenance: eventProvenance(descriptor, identity, input.sourceRecordId, formatVersion),
      rawRef: null
    })
  }

  const accounting = detail.tokenAccounting
  if (accounting?.usageEvents.length) {
    for (const usage of accounting.usageEvents) {
      append({
        messageId: usage.sourceRowId || null,
        timestamp: usage.timestamp || null,
        actor: 'assistant',
        kind: 'usage',
        payload: usagePayload(usage),
        sourceRecordId: usage.sourceRowId || usage.dedupKey
      })
    }
  } else {
    append({
      actor: 'system',
      kind: 'usage',
      payload: unavailableUsagePayload(detail),
      sourceRecordId: `usage-unavailable:${detail.sessionId}`
    })
  }

  if (detail.branchParentId) {
    append({
      actor: 'system',
      kind: 'session.lifecycle',
      payload: { relationshipType: 'fork', parentBranchViewId: detail.branchParentId },
      sourceRecordId: `branch-parent:${detail.branchParentId}`
    })
  }
  for (const continuation of detail.continuationSessionIds || []) {
    append({
      actor: 'system',
      kind: 'session.lifecycle',
      payload: {
        relationshipType: 'continuation',
        fromSessionRecordId: detail.sessionId,
        toSessionRecordId: continuation
      },
      sourceRecordId: `continuation:${continuation}`
    })
  }
  for (const subagent of detail.subagents || []) {
    append({
      actor: 'system',
      kind: 'subagent.spawn',
      payload: {
        agentId: subagent.sessionId,
        parentAgentId: subagent.parentSessionId || detail.sessionId
      },
      sourceRecordId: `subagent:${subagent.sessionId}`
    })
  }
}

function applyContextTimeline(events: CanonicalEvent[]): void {
  const outsideActiveBranch = new Set(events.flatMap((event) =>
    event.timeline.modelContext.length === 1 &&
    event.timeline.modelContext[0].state === 'archived' &&
    event.timeline.modelContext[0].fromSequence === event.sequence
      ? [event.sequence]
      : []
  ))
  const compactions = events.filter((event) =>
    event.kind === 'context.compaction' && !outsideActiveBranch.has(event.sequence)
  )
  for (const event of events.filter((candidate) => candidate.kind === 'context.compaction')) {
    const activeIndex = compactions.indexOf(event)
    const contextRevision = activeIndex >= 0
      ? activeIndex + 1
      : compactions.filter((compaction) => compaction.sequence <= event.sequence).length
    const compactionPayload = event.payload as Record<string, JsonValue>
    compactionPayload.contextRevision = contextRevision
    const summary = events.find((candidate) =>
      candidate.kind === 'context.summary' && candidate.messageId === event.messageId
    )
    if (summary) (summary.payload as Record<string, JsonValue>).contextRevision = contextRevision
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (outsideActiveBranch.has(event.sequence)) {
      const priorRevision = compactions.filter((compaction) => compaction.sequence <= event.sequence).length
      event.timeline.modelContext = [{
        contextRevision: priorRevision,
        state: 'archived',
        fromSequence: event.sequence,
        untilSequence: null
      }]
      continue
    }
    const laterCompactions = compactions.filter((compaction) => compaction.sequence > event.sequence)
    const first = laterCompactions[0]
    if (!first) {
      const priorRevision = compactions.filter((compaction) => compaction.sequence <= event.sequence).length
      event.timeline.modelContext = [{
        contextRevision: priorRevision,
        state: event.kind === 'usage' || event.classification === 'lifecycle' ? 'unknown' : 'visible-to-model',
        fromSequence: event.sequence,
        untilSequence: null
      }]
      continue
    }
    const revision = compactions.filter((compaction) => compaction.sequence < first.sequence).length
    event.timeline.modelContext = [
      { contextRevision: revision, state: 'visible-to-model', fromSequence: event.sequence, untilSequence: first.sequence },
      { contextRevision: revision + 1, state: 'archived', fromSequence: first.sequence, untilSequence: null }
    ]
  }
}

function buildChunks(
  descriptor: UnifiedProviderDescriptorV2,
  identity: SessionIdentity,
  events: CanonicalEvent[],
  detail: SessionDetail
): ParseChunk[] {
  const fingerprint = { algorithm: 'sha256' as const, value: providerFingerprintV2({
    source: detail.filePath,
    session: detail.sessionId,
    messages: detail.messageCount,
    updatedAt: detail.updatedAt
  }) }
  const slices: CanonicalEvent[][] = []
  for (let index = 0; index < events.length; index += UNIFIED_ADAPTER_CHUNK_EVENTS) {
    slices.push(events.slice(index, index + UNIFIED_ADAPTER_CHUNK_EVENTS))
  }
  if (slices.length === 0) slices.push([])
  const chunks = slices.map((slice, index): ParseChunk => ({
    providerId: descriptor.providerId,
    parserDataVersion: 't173.1',
    formatVersion: formatVersionForDetail(detail, descriptor),
    fingerprint,
    identity,
    mode: 'replace',
    chunkIndex: index,
    previousCursor: index === 0 ? null : `t173:${index - 1}`,
    cursor: index === slices.length - 1 ? null : `t173:${index}`,
    done: index === slices.length - 1,
    events: slice,
    diagnostics: []
  }))
  for (const chunk of chunks) {
    const validation = validateParseChunkV2(chunk)
    if (!validation.ok) {
      throw new Error(`unified-provider-v2-conformance:${validation.issues.map((issue) => `${issue.path}:${issue.message}`).join('|')}`)
    }
  }
  return chunks
}

function projectedUsage(payload: JsonValue): TokenUsage | undefined {
  const usage = objectValue(payload)
  const measurement = objectValue(usage.measurement)
  if (measurement.source === 'unavailable') return undefined
  const input = objectValue(usage.input)
  const output = objectValue(usage.output)
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  return {
    inputTokens: number(input.uncached),
    outputTokens: number(output.total),
    cacheCreationTokens: number(input.cacheWrite5m) + number(input.cacheWrite1h),
    cacheReadTokens: number(input.cacheRead)
  }
}

function eventNotice(event: CanonicalEvent): { subtype: string; text: string } | null {
  const payload = objectValue(event.payload)
  if (event.kind === 'rollback') {
    return { subtype: 'rollback', text: `Rollback: ${String(payload.reason || 'provider rollback')}` }
  }
  if (event.kind === 'subagent.spawn') {
    return { subtype: 'subagent-spawn', text: `Subagent: ${String(payload.agentId || '')}` }
  }
  if (event.kind === 'mode.changed') {
    return { subtype: 'review', text: `Mode: ${String(payload.toMode || '')}` }
  }
  if (event.kind === 'session.lifecycle') {
    return { subtype: 'lifecycle', text: `Relationship: ${String(payload.relationshipType || payload.phase || '')}` }
  }
  return null
}

export function projectCanonicalEventsToDetailV2(
  detail: SessionDetail,
  events: CanonicalEvent[]
): SessionDetail {
  const renderedById = new Map(renderCanonicalEventPage(events).map((event) => [event.id, event]))
  const messages = detail.messages.map((message): ParsedMessage => ({
    ...message,
    toolCalls: message.toolCalls.map((tool) => ({ ...tool, input: { ...tool.input } })),
    images: [...message.images]
  }))
  const byId = new Map(messages.map((message) => [message.uuid, message]))
  const textByMessage = new Map<string, string[]>()
  const toolsByMessage = new Map<string, ToolCallInfo[]>()
  const resultByCall = new Map<string, string>()
  const firstSequence = new Map<string, number>()
  const extras: Array<{ sequence: number; message: ParsedMessage }> = []

  for (const event of events) {
    if (event.messageId && !firstSequence.has(event.messageId)) {
      firstSequence.set(event.messageId, event.sequence)
    }
    if (event.messageId && [
      'message.text', 'message.thinking', 'message.reasoning', 'message.redacted-thinking', 'context.summary'
    ].includes(event.kind)) {
      const fragments = textByMessage.get(event.messageId) || []
      const text = renderedById.get(event.id)?.text || textFromJson(event.payload)
      if (event.kind === 'message.thinking') fragments.push(`[Thinking]\n${text}\n[/Thinking]`)
      else if (event.kind === 'message.reasoning') fragments.push(`[Reasoning]\n${text}\n[/Reasoning]`)
      else if (event.kind === 'message.redacted-thinking') fragments.push('[Redacted thinking]')
      else fragments.push(text)
      textByMessage.set(event.messageId, fragments)
    }
    if (event.kind === 'tool.call' && event.messageId) {
      const payload = objectValue(event.payload)
      const callId = typeof payload.callId === 'string' ? payload.callId : undefined
      const call: ToolCallInfo = {
        ...(callId ? { id: callId } : {}),
        name: typeof payload.rawName === 'string' ? payload.rawName : 'unknown',
        input: inputForTool(renderedById.get(event.id)?.payload ?? jsonValue(payload.input ?? {}))
      }
      const list = toolsByMessage.get(event.messageId) || []
      list.push(call)
      toolsByMessage.set(event.messageId, list)
    }
    if (event.kind === 'tool.result') {
      const payload = objectValue(event.payload)
      if (typeof payload.callId === 'string') {
        resultByCall.set(payload.callId, textFromJson(jsonValue(payload.output ?? '')))
      }
    }
    if (event.kind === 'usage' && event.messageId) {
      const target = byId.get(event.messageId)
      const usage = projectedUsage(event.payload)
      if (target && usage) target.tokenUsage = usage
    }
    if (event.kind === 'context.compaction' && event.messageId) {
      const target = byId.get(event.messageId)
      if (target) {
        target.type = 'system'
        target.subtype = 'compact_boundary'
        target.isSystemGenerated = true
      }
    }
    const notice = eventNotice(event)
    if (notice) {
      extras.push({
        sequence: event.sequence,
        message: {
          uuid: event.id,
          type: 'system',
          subtype: notice.subtype,
          timestamp: event.timestamp || '',
          role: 'system',
          origin: 'unknown',
          textContent: notice.text,
          toolCalls: [],
          images: [],
          isPreCompact: false,
          isSidechain: false,
          isSharedContext: false,
          isSystemGenerated: true,
          raw: {
            uuid: event.id,
            parentUuid: null,
            sessionId: detail.sessionId,
            type: 'system',
            subtype: notice.subtype,
            timestamp: event.timestamp || '',
            data: event.payload
          }
        }
      })
    }
  }

  for (const message of messages) {
    const fragments = textByMessage.get(message.uuid)
    if (fragments) message.textContent = fragments.filter(Boolean).join('\n')
    const tools = toolsByMessage.get(message.uuid)
    if (tools) {
      message.toolCalls = tools.map((tool) => ({
        ...tool,
        ...(tool.id && resultByCall.has(tool.id) ? { result: resultByCall.get(tool.id) } : {})
      }))
    }
  }

  const ordered = [
    ...messages.map((message, index) => ({
      sequence: firstSequence.get(message.uuid) ?? Number.MAX_SAFE_INTEGER - messages.length + index,
      message
    })),
    ...extras
  ].sort((left, right) => left.sequence - right.sequence)

  return { ...detail, messages: ordered.map((entry) => entry.message) }
}

export function adaptSessionDetailV2(detail: SessionDetail): UnifiedSessionAdapterResultV2 {
  const source = detail.source || 'claude-code'
  const descriptor = unifiedProviderDescriptorV2(source)
  if (!descriptor) throw new Error(`unified-provider-v2-source-unsupported:${source}`)
  const identity = sourceIdentity(detail, descriptor)
  const events = canonicalEventsForMessages(detail, descriptor, identity)
  appendUsageAndRelationships(detail, descriptor, identity, events)
  applyContextTimeline(events)
  const chunks = buildChunks(descriptor, identity, events, detail)
  return {
    descriptor,
    events,
    chunks,
    detail: projectCanonicalEventsToDetailV2(detail, events)
  }
}
