import type {
  CanonicalRecord as CanonicalRecordV1,
  MessageRecord as MessageRecordV1,
  ParseOutcome as ParseOutcomeV1,
  ProviderManifest as ProviderManifestV1,
  RecordProvenance as RecordProvenanceV1,
  SessionRecord as SessionRecordV1,
  ToolCallRecord as ToolCallRecordV1,
  UsageRecord as UsageRecordV1
} from '../shared/provider-schema.generated'
import type {
  CanonicalEvent,
  CanonicalEventKind,
  CapabilityDeclaration,
  Diagnostic,
  EventProvenance,
  JsonValue,
  ParseChunk,
  ProviderManifest,
  SessionIdentity,
  UsageRecord
} from '../shared/provider-schema-v2.generated'
import {
  PROVIDER_CAPABILITY_NAMES,
  PROVIDER_RESOURCE_LIMITS
} from '../shared/provider-schema-v2.generated'
import { createBuiltinToolRegistryV2 } from '../shared/tool-registry-v2'
import {
  buildCanonicalLogicalSessionIdentity,
  logicalSessionKey
} from './library-session-identity'

export const PROVIDER_V1_MIGRATION_CHUNK_EVENTS = 1_000
export const PROVIDER_V1_MIGRATION_CHUNK_BYTES = PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes - 128 * 1024

const V1_CAPABILITY_NAMES = new Set<string>([
  'discover', 'summary', 'transcript', 'tools', 'thinking', 'usage', 'relationships',
  'subagents', 'terminal-resume', 'native-resume', 'format-provenance'
])

function migratedCapability(
  manifest: ProviderManifestV1,
  name: typeof PROVIDER_CAPABILITY_NAMES[number],
  evidenceFixture: string,
  conformanceTestPrefix: string
): CapabilityDeclaration {
  const source = V1_CAPABILITY_NAMES.has(name)
    ? manifest.capabilities[name as keyof ProviderManifestV1['capabilities']]
    : null
  const status: CapabilityDeclaration['status'] = source?.status ||
    (name === 'identity' || name === 'chunked-transport'
      ? 'available'
      : name === 'interactions' || name === 'permissions' || name === 'context-timeline'
        ? 'experimental'
        : 'unavailable')
  const reason = source?.reason || (status === 'available'
    ? null
    : name === 'context-timeline'
      ? 'Protocol v1 has no authoritative model-context membership; migrated events retain unknown.'
      : name === 'interactions' || name === 'permissions'
        ? 'Known v1 tool aliases migrate to historical interaction facts; live channels require a native v2 provider.'
        : `Capability ${name} is unavailable in the v1 source manifest.`)
  return {
    status,
    reason,
    evidence: [{
      kind: status === 'unavailable' || status === 'not-applicable' ? 'missing' : 'test',
      fixture: evidenceFixture,
      conformanceTestId: `${conformanceTestPrefix}-${name.toUpperCase()}`,
      ...(source?.evidence[0]?.locator ? { locator: source.evidence[0].locator } : {})
    }]
  }
}

export function migrateProviderV1ManifestToV2(
  manifest: ProviderManifestV1,
  options: { evidenceFixture: string; conformanceTestPrefix: string }
): ProviderManifest {
  const resumeDeclared = ['available', 'experimental'].includes(manifest.capabilities['native-resume'].status) ||
    ['available', 'experimental'].includes(manifest.capabilities['terminal-resume'].status)
  return {
    schemaVersion: 2,
    providerId: manifest.providerId,
    displayName: manifest.displayName,
    implementationVersion: `${manifest.implementationVersion}+protocol-v2-migration`,
    parserDataVersion: manifest.parserDataVersion,
    formatVersions: manifest.formatVersions.length > 0 ? manifest.formatVersions : ['provider-v1-unspecified'],
    capabilities: Object.fromEntries(PROVIDER_CAPABILITY_NAMES.map((name) => [
      name,
      migratedCapability(manifest, name, options.evidenceFixture, options.conformanceTestPrefix)
    ])),
    resumeContract: resumeDeclared ? {
      mode: 'native-cli',
      supportedSurfaces: ['terminal'],
      supportsSubagent: false,
      idTransform: null,
      preflight: ['binary', 'version', 'help-capability', 'source-exists'],
      commandTemplate: null,
      expectedSideEffects: ['observe-source-after-launch'],
      postcondition: 'anchor-match'
    } : null
  }
}

function oneSession(records: CanonicalRecordV1[]): SessionRecordV1 {
  const sessions = records.filter((record): record is SessionRecordV1 => record.recordType === 'session')
  if (sessions.length !== 1) throw new Error('provider-v1-migration-requires-one-session')
  return sessions[0]
}

function identityFor(session: SessionRecordV1): SessionIdentity {
  const logicalIdentity = buildCanonicalLogicalSessionIdentity(
    session.provenance.providerId,
    session.sourceRef.stableId,
    session.sourceSessionId
  )
  return {
    physicalSourceId: session.sourceRef.stableId,
    logicalSessionKey: logicalSessionKey(logicalIdentity),
    logicalSessionId: session.sourceSessionId,
    branchViewId: `${session.provenance.providerId}:${session.sourceSessionId}:default`,
    parentBranchViewId: null
  }
}

function provenanceFor(record: { id: string; provenance: RecordProvenanceV1 }): EventProvenance {
  return {
    providerId: record.provenance.providerId,
    sourceRefId: record.provenance.sourceRefId,
    parserDataVersion: record.provenance.parserDataVersion,
    formatVersion: record.provenance.formatVersion,
    observedAt: record.provenance.observedAt,
    sourceRecordId: record.id,
    rawRecordFingerprint: record.provenance.rawRecordFingerprint || null
  }
}

function actorFor(role: MessageRecordV1['role']): CanonicalEvent['actor'] {
  if (role === 'tool') return 'tool'
  return role
}

function classificationFor(role: MessageRecordV1['role']): CanonicalEvent['classification'] {
  if (role === 'user' || role === 'assistant') return 'user-content'
  if (role === 'system') return 'promoted-system'
  return 'unknown'
}

function timelineUnknown(sequence: number): CanonicalEvent['timeline'] {
  return {
    archived: true,
    modelContext: [{
      contextRevision: 0,
      state: 'unknown',
      fromSequence: sequence,
      untilSequence: null
    }]
  }
}

function baseEvent(input: {
  record: { id: string; provenance: RecordProvenanceV1 }
  identity: SessionIdentity
  sequence: number
  idSuffix?: string
  messageId: string | null
  messageBlockIndex: number | null
  timestamp: string | null
  actor: CanonicalEvent['actor']
  kind: CanonicalEventKind
  payload: JsonValue
  visibility?: CanonicalEvent['visibility']
  classification?: CanonicalEvent['classification']
}): CanonicalEvent {
  const id = `v2:${input.record.id}${input.idSuffix ? `:${input.idSuffix}` : ''}`
  return {
    id,
    identity: input.identity,
    sharedEventKey: `shared:${id}`,
    messageId: input.messageId,
    sequence: input.sequence,
    messageBlockIndex: input.messageBlockIndex,
    timestamp: input.timestamp,
    actor: input.actor,
    kind: input.kind,
    payload: input.payload,
    visibility: input.visibility || 'primary',
    classification: input.classification || 'unknown',
    timeline: timelineUnknown(input.sequence),
    provenance: provenanceFor(input.record),
    rawRef: null
  }
}

function nullable(value: number | null): number {
  return value ?? 0
}

function migratedUsage(record: UsageRecordV1): UsageRecord {
  const hasInput = record.inputTokens !== null || record.cacheReadTokens !== null || record.cacheWriteTokens !== null
  const inputTotal = hasInput
    ? nullable(record.inputTokens) + nullable(record.cacheReadTokens) + nullable(record.cacheWriteTokens)
    : null
  const hasOutput = record.outputTokens !== null || record.reasoningTokens !== null
  const outputTotal = hasOutput
    ? nullable(record.outputTokens) + nullable(record.reasoningTokens)
    : null
  const measurement: UsageRecord['measurement'] = record.usageProvenance === 'reported'
    ? { source: 'reported', confidence: 'exact', sourceField: 'provider-v1-usage-record' }
    : record.usageProvenance === 'derived'
      ? { source: 'derived', confidence: 'high', sourceField: 'provider-v1-usage-record' }
      : record.usageProvenance === 'estimated'
        ? { source: 'estimated', confidence: 'low', sourceField: 'provider-v1-usage-record' }
        : { source: 'unavailable', confidence: 'unavailable', sourceField: null }
  return {
    eventId: record.id,
    turnId: record.messageRecordId,
    modelId: record.model,
    input: {
      total: inputTotal,
      uncached: record.inputTokens,
      cacheRead: record.cacheReadTokens,
      cacheWrite5m: record.cacheWriteTokens,
      cacheWrite1h: null
    },
    output: {
      total: outputTotal,
      visible: record.outputTokens,
      reasoning: record.reasoningTokens
    },
    providerTotal: inputTotal === null && outputTotal === null
      ? null
      : nullable(inputTotal) + nullable(outputTotal),
    aggregation: 'per-message',
    relations: {
      cacheRead: 'subset-of-input',
      cacheWrite: 'subset-of-input',
      reasoning: 'subset-of-output'
    },
    dedupKey: record.id,
    billingFactKey: record.id,
    measurement,
    cost: record.costUsd === null
      ? null
      : { amount: record.costUsd, currency: 'USD', kind: record.usageProvenance === 'reported' ? 'reported' : 'derived' },
    priceRevision: record.costUsd !== null && record.usageProvenance !== 'reported'
      ? 'provider-v1-preserved'
      : null
  }
}

function interactionOptions(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry, index): JsonValue[] => {
    if (typeof entry === 'string' && entry) {
      return [{ id: String(index), label: entry, description: null }]
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return []
    const option = entry as Record<string, JsonValue>
    const label = typeof option.label === 'string'
      ? option.label
      : typeof option.value === 'string'
        ? option.value
        : null
    if (!label) return []
    return [{
      id: typeof option.id === 'string' ? option.id : String(index),
      label,
      description: typeof option.description === 'string' ? option.description : null
    }]
  })
}

function interactionPayload(record: ToolCallRecordV1, input: Record<string, JsonValue>): JsonValue {
  return {
    requestId: record.id,
    prompt: typeof input.question === 'string' ? input.question : '',
    options: interactionOptions(input.options),
    multiSelect: input.multiSelect === true,
    state: { state: 'historical', answered: false },
    toolCallId: record.id,
    rawInput: input
  }
}

function permissionPayload(record: ToolCallRecordV1, input: Record<string, JsonValue>): JsonValue {
  return {
    requestId: record.id,
    permission: typeof input.permission === 'string' ? input.permission : 'unknown',
    resource: input.resource ?? input,
    state: { state: 'historical', answered: false },
    toolCallId: record.id,
    rawInput: input
  }
}

function eventsForRecords(records: CanonicalRecordV1[], identity: SessionIdentity): CanonicalEvent[] {
  const registry = createBuiltinToolRegistryV2()
  const events: CanonicalEvent[] = []
  const emit = (input: Omit<Parameters<typeof baseEvent>[0], 'sequence' | 'identity'>): void => {
    events.push(baseEvent({ ...input, identity, sequence: events.length }))
  }
  for (const record of records) {
    if (record.recordType === 'session') continue
    if (record.recordType === 'message') {
      record.content.forEach((content, blockIndex) => {
        if (content.kind === 'text' || content.kind === 'thinking') {
          emit({
            record,
            idSuffix: `block:${blockIndex}`,
            messageId: record.id,
            messageBlockIndex: blockIndex,
            timestamp: record.timestamp,
            actor: actorFor(record.role),
            kind: content.kind === 'text' ? 'message.text' : 'message.thinking',
            payload: { text: content.text },
            classification: classificationFor(record.role)
          })
        } else {
          emit({
            record,
            idSuffix: `block:${blockIndex}`,
            messageId: record.id,
            messageBlockIndex: blockIndex,
            timestamp: record.timestamp,
            actor: actorFor(record.role),
            kind: 'artifact',
            payload: { uri: content.uri, mimeType: content.mimeType },
            classification: classificationFor(record.role)
          })
        }
      })
      continue
    }
    if (record.recordType === 'tool-call') {
      const resolved = registry.resolve({
        providerId: record.provenance.providerId,
        formatVersion: record.provenance.formatVersion,
        rawName: record.name,
        callId: record.id,
        input: record.input
      })
      const input = resolved.normalizedInput && typeof resolved.normalizedInput === 'object' && !Array.isArray(resolved.normalizedInput)
        ? resolved.normalizedInput as Record<string, JsonValue>
        : { value: resolved.normalizedInput }
      const payload = resolved.eventKind === 'interaction.request'
        ? interactionPayload(record, input)
        : resolved.eventKind === 'permission.request'
          ? permissionPayload(record, input)
          : {
              callId: record.id,
              rawName: record.name,
              semanticToolId: resolved.semanticToolId,
              input: resolved.normalizedInput
            }
      emit({
        record,
        messageId: record.messageRecordId,
        messageBlockIndex: null,
        timestamp: null,
        actor: 'assistant',
        kind: resolved.eventKind,
        payload,
        classification: resolved.eventKind === 'tool.call' ? 'user-content' : 'interaction'
      })
      continue
    }
    if (record.recordType === 'tool-result') {
      emit({
        record,
        messageId: null,
        messageBlockIndex: null,
        timestamp: record.timestamp,
        actor: 'tool',
        kind: 'tool.result',
        payload: {
          callId: record.toolCallRecordId,
          output: record.content,
          isError: record.isError,
          state: 'complete'
        },
        classification: 'user-content'
      })
      continue
    }
    if (record.recordType === 'usage') {
      emit({
        record,
        messageId: record.messageRecordId,
        messageBlockIndex: null,
        timestamp: record.timestamp,
        actor: 'assistant',
        kind: 'usage',
        payload: migratedUsage(record),
        visibility: 'collapsed',
        classification: 'lifecycle'
      })
      continue
    }
    if (record.recordType === 'relationship') {
      emit({
        record,
        messageId: null,
        messageBlockIndex: null,
        timestamp: null,
        actor: 'system',
        kind: 'session.lifecycle',
        payload: {
          relationshipType: record.relationshipType,
          fromSessionRecordId: record.fromSessionRecordId,
          toSessionRecordId: record.toSessionRecordId
        },
        visibility: 'collapsed',
        classification: 'lifecycle'
      })
      continue
    }
    emit({
      record,
      messageId: record.messageRecordId,
      messageBlockIndex: null,
      timestamp: null,
      actor: 'system',
      kind: 'artifact',
      payload: {
        uri: record.uri,
        action: record.action,
        exists: record.exists,
        fingerprint: record.fingerprint
      },
      classification: 'user-content'
    })
  }
  return events
}

function migrationDiagnostics(): Diagnostic[] {
  return [{
    level: 'info',
    code: 'provider-v1-migrated',
    message: 'Migrated from Provider Protocol v1; context membership not present in v1 remains unknown.',
    eventId: null
  }]
}

export function migrateProviderV1OutcomeToV2Chunks(
  outcome: ParseOutcomeV1,
  chunkSize = PROVIDER_V1_MIGRATION_CHUNK_EVENTS
): ParseChunk[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 2_048) {
    throw new Error('provider-v1-migration-chunk-size-invalid')
  }
  const chunks: ParseChunk[] = []
  for (const result of outcome.sessions) {
    if (!result.sessionRecordId || result.records.length === 0) continue
    const session = oneSession(result.records)
    const identity = identityFor(session)
    const events = eventsForRecords(result.records, identity)
    const pages: CanonicalEvent[][] = []
    let page: CanonicalEvent[] = []
    let pageBytes = 0
    for (const event of events) {
      const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
      if (page.length > 0 && (page.length >= chunkSize || pageBytes + eventBytes > PROVIDER_V1_MIGRATION_CHUNK_BYTES)) {
        pages.push(page)
        page = []
        pageBytes = 0
      }
      page.push(event)
      pageBytes += eventBytes
    }
    if (page.length > 0 || pages.length === 0) pages.push(page)
    const pageCount = pages.length
    for (let chunkIndex = 0; chunkIndex < pageCount; chunkIndex++) {
      const done = chunkIndex === pageCount - 1
      chunks.push({
        providerId: outcome.providerId,
        parserDataVersion: outcome.parserDataVersion,
        formatVersion: outcome.formatVersion,
        fingerprint: outcome.fingerprint,
        identity,
        mode: outcome.status === 'replace' ? 'replace' : 'initial',
        chunkIndex,
        previousCursor: chunkIndex === 0 ? null : `v1:${result.sessionRecordId}:${chunkIndex - 1}`,
        cursor: done ? null : `v1:${result.sessionRecordId}:${chunkIndex}`,
        done,
        events: pages[chunkIndex],
        diagnostics: chunkIndex === 0 ? migrationDiagnostics() : []
      })
    }
  }
  return chunks
}
