import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import type {
  CanonicalRecord,
  JsonValue as JsonValueV1,
  MessageContent,
  MessageRecord,
  ParseOutcome,
  RecordProvenance,
  SessionParseResult,
  SourceRef,
  ToolCallRecord,
  UsageRecord as UsageRecordV1
} from '../shared/provider-schema.generated'
import type {
  CanonicalEvent,
  JsonValue,
  ParseChunk,
  UsageRecord as UsageRecordV2
} from '../shared/provider-schema-v2.generated'
import { stableCanonicalRecordId } from '../shared/provider-protocol'

export const V2_LIFECYCLE_PROJECTION_EVIDENCE = 'provider-v2-consumer-projection:session-lifecycle'

/**
 * Provider Protocol v2 is the source of truth. The current sidebar, search and
 * Vault writers still consume v1 CanonicalRecord arrays, so this module creates
 * a deliberately lossy read model after a native-v2 stream has been validated.
 * Providers must never emit this projection themselves or route through the v1
 * migration path.
 */

function objectValue(value: JsonValue): Record<string, JsonValue> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null
}

function stringValue(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function booleanValue(value: JsonValue | undefined): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function v1Json(value: JsonValue | undefined): JsonValueV1 {
  return value === undefined ? null : value as JsonValueV1
}

function projectedRecordId(
  providerId: string,
  sourceRefId: string,
  recordType: string,
  sourceRecordId: string
): string {
  return stableCanonicalRecordId({ providerId, sourceRefStableId: sourceRefId, recordType, sourceRecordId })
}

function provenance(event: CanonicalEvent): RecordProvenance {
  return {
    providerId: event.provenance.providerId,
    sourceRefId: event.provenance.sourceRefId,
    parserDataVersion: event.provenance.parserDataVersion,
    formatVersion: event.provenance.formatVersion,
    observedAt: event.provenance.observedAt,
    ...(event.kind === 'session.lifecycle' ? {
      evidence: [{
        kind: 'compatibility-contract' as const,
        locator: V2_LIFECYCLE_PROJECTION_EVIDENCE,
        note: 'Projected lifecycle text is not a context compaction marker.'
      }]
    } : {}),
    ...(event.provenance.rawRecordFingerprint
      ? { rawRecordFingerprint: event.provenance.rawRecordFingerprint }
      : {})
  }
}

function eventText(event: CanonicalEvent): MessageContent | null {
  const payload = objectValue(event.payload)
  if (!payload) return null
  if (event.kind === 'message.text') {
    return { kind: 'text', text: typeof payload.text === 'string' ? payload.text : '' }
  }
  if (event.kind === 'message.thinking' || event.kind === 'message.reasoning') {
    const text = typeof payload.text === 'string'
      ? payload.text
      : typeof payload.summary === 'string'
        ? payload.summary
        : ''
    return { kind: 'thinking', text }
  }
  if (event.kind === 'context.summary') {
    return { kind: 'text', text: typeof payload.text === 'string' ? payload.text : '' }
  }
  if (event.kind === 'context.compaction') {
    const through = typeof payload.archivedThroughSequence === 'number'
      ? payload.archivedThroughSequence
      : null
    return {
      kind: 'text',
      text: through === null ? '[Context compacted]' : `[Context compacted through sequence ${through}]`
    }
  }
  if (event.kind === 'session.lifecycle' && typeof payload.phase === 'string' &&
    !payload.phase.startsWith('metadata.title:') && !payload.phase.startsWith('metadata.cwd:')) {
    return { kind: 'text', text: payload.phase }
  }
  return null
}

function messageRole(event: CanonicalEvent): MessageRecord['role'] {
  if (event.actor === 'user' || event.actor === 'assistant' || event.actor === 'system' || event.actor === 'tool') {
    return event.actor
  }
  return 'unknown'
}

function messageSourceId(event: CanonicalEvent): string {
  return event.messageId || `event:${event.id}`
}

function projectedMessageId(event: CanonicalEvent): string {
  return projectedRecordId(
    event.provenance.providerId,
    event.provenance.sourceRefId,
    'message',
    messageSourceId(event)
  )
}

function usageInput(payload: UsageRecordV2): {
  input: number | null
  cacheRead: number | null
  cacheWrite: number | null
} {
  const cacheRead = payload.input.cacheRead
  const cacheWrite = payload.input.cacheWrite5m === null && payload.input.cacheWrite1h === null
    ? null
    : (payload.input.cacheWrite5m || 0) + (payload.input.cacheWrite1h || 0)
  if (payload.input.uncached !== null) return { input: payload.input.uncached, cacheRead, cacheWrite }
  if (payload.input.total === null) return { input: null, cacheRead, cacheWrite }
  if (payload.relations.cacheRead === 'subset-of-input' && payload.relations.cacheWrite === 'subset-of-input') {
    return {
      input: Math.max(0, payload.input.total - (cacheRead || 0) - (cacheWrite || 0)),
      cacheRead,
      cacheWrite
    }
  }
  // v1 cannot express independent cache buckets without double-counting its
  // aggregate. Preserve the provider total and omit the ambiguous sub-buckets.
  return { input: payload.input.total, cacheRead: null, cacheWrite: null }
}

function usageOutput(payload: UsageRecordV2): { output: number | null; reasoning: number | null } {
  if (payload.output.visible !== null) {
    return { output: payload.output.visible, reasoning: payload.output.reasoning }
  }
  if (payload.output.total === null) return { output: null, reasoning: payload.output.reasoning }
  if (payload.relations.reasoning === 'subset-of-output') {
    return {
      output: Math.max(0, payload.output.total - (payload.output.reasoning || 0)),
      reasoning: payload.output.reasoning
    }
  }
  return { output: payload.output.total, reasoning: null }
}

function projectUsage(
  event: CanonicalEvent,
  sessionRecordId: string,
  payload: UsageRecordV2
): UsageRecordV1 {
  const input = usageInput(payload)
  const output = usageOutput(payload)
  return {
    id: projectedRecordId(
      event.provenance.providerId,
      event.provenance.sourceRefId,
      'usage',
      event.id
    ),
    recordType: 'usage',
    sessionRecordId,
    messageRecordId: event.messageId ? projectedMessageId(event) : null,
    timestamp: event.timestamp,
    model: payload.modelId,
    inputTokens: input.input,
    outputTokens: output.output,
    cacheReadTokens: input.cacheRead,
    cacheWriteTokens: input.cacheWrite,
    reasoningTokens: output.reasoning,
    costUsd: payload.cost?.amount ?? null,
    usageProvenance: payload.measurement.source,
    provenance: provenance(event)
  }
}

function fileUriPath(uri: string): string | null {
  try { return fileURLToPath(uri) } catch { return null }
}

function sourceProjectPath(source: SourceRef): string | null {
  if (source.kind === 'file') {
    const filePath = fileUriPath(source.uri)
    return filePath ? path.dirname(filePath) : null
  }
  if (source.kind === 'composite-directory') return fileUriPath(source.rootUri)
  if (source.kind === 'sqlite-row') {
    const databasePath = fileUriPath(source.databaseUri)
    return databasePath ? path.dirname(databasePath) : null
  }
  if (source.kind === 'import-package') {
    const packagePath = fileUriPath(source.packageUri)
    return packagePath ? path.dirname(packagePath) : null
  }
  return null
}

function projectSession(source: SourceRef, chunks: ParseChunk[]): SessionParseResult {
  const firstChunk = chunks[0]
  const identity = firstChunk.identity
  const seenSharedEvents = new Set<string>()
  const events = chunks
    .flatMap((chunk) => chunk.events)
    // Provider v2 sequence is the authoritative transcript order. Timestamps
    // are optional anchors, so sorting on them would move undated current rows
    // ahead of timestamped pre-compaction history.
    .sort((left, right) => left.sequence - right.sequence)
    .filter((event) => {
      if (seenSharedEvents.has(event.sharedEventKey)) return false
      seenSharedEvents.add(event.sharedEventKey)
      return true
    })
  const sessionRecordId = projectedRecordId(
    firstChunk.providerId,
    source.stableId,
    'session',
    identity.logicalSessionId
  )
  const timestamps = events.flatMap((event) => event.timestamp ? [event.timestamp] : []).sort()
  const metadataPhases = events.flatMap((event) => {
    if (event.kind !== 'session.lifecycle') return []
    const payload = objectValue(event.payload)
    return typeof payload?.phase === 'string' ? [payload.phase] : []
  })
  const providerTitle = metadataPhases
    .find((phase) => phase.startsWith('metadata.title:'))
    ?.slice('metadata.title:'.length).trim() || null
  const metadataCwds = metadataPhases
    .filter((phase) => phase.startsWith('metadata.cwd:'))
    .map((phase) => phase.slice('metadata.cwd:'.length).trim())
    .filter((cwd, index, all) => Boolean(cwd) && all.indexOf(cwd) === index)
  const fallbackProjectPath = sourceProjectPath(source)
  const firstEvent = events[0]
  const baseProvenance: RecordProvenance = firstEvent ? provenance(firstEvent) : {
    providerId: firstChunk.providerId,
    sourceRefId: source.stableId,
    parserDataVersion: firstChunk.parserDataVersion,
    formatVersion: firstChunk.formatVersion,
    observedAt: null
  }
  const records: CanonicalRecord[] = [{
    id: sessionRecordId,
    recordType: 'session',
    sourceRef: { ...source, fingerprint: firstChunk.fingerprint } as SourceRef,
    sourceSessionId: identity.logicalSessionId,
    createdAt: timestamps[0] || null,
    updatedAt: timestamps.at(-1) || timestamps[0] || null,
    cwd: metadataCwds,
    projectPath: metadataCwds[0] || fallbackProjectPath,
    providerTitle,
    provenance: baseProvenance
  }]
  const messages = new Map<string, MessageRecord>()
  const callsByRawId = new Map<string, string>()
  let ordinal = 0

  for (const event of events) {
    const content = eventText(event)
    if (content) {
      const id = projectedMessageId(event)
      const existing = messages.get(id)
      if (existing) {
        existing.content.push(content)
      } else {
        const message: MessageRecord = {
          id,
          recordType: 'message',
          sessionRecordId,
          ordinal: ordinal++,
          role: messageRole(event),
          timestamp: event.timestamp,
          content: [content],
          provenance: provenance(event)
        }
        messages.set(id, message)
        records.push(message)
      }
      continue
    }
    const payload = objectValue(event.payload)
    if (!payload) continue
    if (event.kind === 'tool.call') {
      const rawCallId = stringValue(payload.callId) || event.id
      const callId = projectedRecordId(
        event.provenance.providerId,
        event.provenance.sourceRefId,
        'tool-call',
        rawCallId
      )
      callsByRawId.set(rawCallId, callId)
      const call: ToolCallRecord = {
        id: callId,
        recordType: 'tool-call',
        sessionRecordId,
        messageRecordId: event.messageId ? projectedMessageId(event) : null,
        ordinal: ordinal++,
        name: stringValue(payload.rawName) || stringValue(payload.semanticToolId) || 'unknown-tool',
        input: v1Json(payload.input),
        provenance: provenance(event)
      }
      records.push(call)
      continue
    }
    if (event.kind === 'tool.result') {
      const rawCallId = stringValue(payload.callId) || `orphan:${event.id}`
      const callId = callsByRawId.get(rawCallId) || projectedRecordId(
        event.provenance.providerId,
        event.provenance.sourceRefId,
        'tool-call',
        rawCallId
      )
      records.push({
        id: projectedRecordId(
          event.provenance.providerId,
          event.provenance.sourceRefId,
          'tool-result',
          event.id
        ),
        recordType: 'tool-result',
        sessionRecordId,
        toolCallRecordId: callId,
        timestamp: event.timestamp,
        content: v1Json(payload.output),
        isError: booleanValue(payload.isError),
        provenance: provenance(event)
      })
      continue
    }
    if (event.kind === 'usage') {
      records.push(projectUsage(event, sessionRecordId, event.payload as UsageRecordV2))
      continue
    }
    if (event.kind === 'session.lifecycle' && typeof payload.relationshipType === 'string') {
      const from = stringValue(payload.fromSessionRecordId)
      const to = stringValue(payload.toSessionRecordId)
      const relationship = payload.relationshipType
      if (from && to && ['parent-child', 'continuation', 'fork', 'import-copy', 'subagent', 'related'].includes(relationship)) {
        records.push({
          id: projectedRecordId(
            event.provenance.providerId,
            event.provenance.sourceRefId,
            'relationship',
            event.id
          ),
          recordType: 'relationship',
          fromSessionRecordId: from,
          toSessionRecordId: to,
          relationshipType: relationship as 'parent-child' | 'continuation' | 'fork' | 'import-copy' | 'subagent' | 'related',
          provenance: provenance(event)
        })
      }
      continue
    }
    if (event.kind === 'artifact') {
      const uri = stringValue(payload.uri)
      const action = stringValue(payload.action)
      if (uri && action && ['read', 'write', 'edit', 'create', 'delete', 'reference'].includes(action)) {
        records.push({
          id: projectedRecordId(
            event.provenance.providerId,
            event.provenance.sourceRefId,
            'artifact',
            event.id
          ),
          recordType: 'artifact',
          sessionRecordId,
          messageRecordId: event.messageId ? projectedMessageId(event) : null,
          uri,
          action: action as 'read' | 'write' | 'edit' | 'create' | 'delete' | 'reference',
          exists: booleanValue(payload.exists),
          fingerprint: null,
          provenance: provenance(event)
        })
      }
    }
  }

  return {
    sourceRefId: source.stableId,
    sessionRecordId,
    status: firstChunk.mode === 'replace' ? 'replace' : 'complete',
    records,
    errors: [],
    replaceSessionRecordId: firstChunk.mode === 'replace' ? sessionRecordId : null,
    noDataReason: null
  }
}

export function projectNativeV2ChunksForConsumers(
  providerId: string,
  parserDataVersion: string,
  sources: SourceRef[],
  chunks: ParseChunk[]
): ParseOutcome[] {
  const sourceById = new Map(sources.map((source) => [source.stableId, source]))
  const bySource = new Map<string, ParseChunk[]>()
  for (const chunk of chunks) {
    const list = bySource.get(chunk.identity.physicalSourceId) || []
    list.push(chunk)
    bySource.set(chunk.identity.physicalSourceId, list)
  }
  return [...bySource.entries()].map(([sourceRefId, sourceChunks]) => {
    const source = sourceById.get(sourceRefId)
    if (!source) throw new Error(`provider-v2-consumer-source-missing:${sourceRefId}`)
    const bySession = new Map<string, ParseChunk[]>()
    for (const chunk of sourceChunks) {
      // Existing consumers are session-based, not branch-view based. Merge a
      // logical session's branches and deduplicate sharedEventKey copies; the
      // native v2 store remains the lossless branch-aware source of truth.
      const key = chunk.identity.logicalSessionKey
      const list = bySession.get(key) || []
      list.push(chunk)
      bySession.set(key, list)
    }
    const sessions = [...bySession.values()].map((sessionChunks) =>
      projectSession(source, sessionChunks.sort((left, right) => left.chunkIndex - right.chunkIndex)))
    const first = sourceChunks[0]
    return {
      providerId,
      parserDataVersion,
      formatVersion: first.formatVersion,
      fingerprint: first.fingerprint,
      status: sessions.some((session) => session.status === 'replace') ? 'replace' : 'complete',
      sessions,
      errors: [],
      tombstones: []
    }
  })
}
