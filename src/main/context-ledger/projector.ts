import type { RawJsonlMessage, ContentPart } from '../types'
import type {
  Availability,
  ContextArtifact,
  ContextArtifactKind,
  DeferredToolsDelta,
  ContextInjection,
  ContextSnapshot,
  ContextTransition,
  EvidenceGrade,
  EvidenceRef,
  McpContextExposure,
  ToolSearchReceipt
} from '../../shared/contracts/truth-kernel'
import type { ContextLedgerExport, ContextLedgerProjection, PersistedContextLedgerFacts } from './types'

const schemaVersion = 1 as const

export interface ContextLedgerEventHint {
  contextArtifactId?: string
  kind: ContextArtifactKind
  /** A/B only when the provider or a capture receipt explicitly recorded it. */
  evidenceGrade?: 'A' | 'B'
  content?: string
  sourceUri?: string
  scope?: ContextArtifact['scope']
  operation?: ContextInjection['operation']
  trigger?: ContextInjection['trigger']
  visibleToModel?: ContextInjection['visibleToModel']
}

function available<T>(value: T): Availability<T> {
  return { status: 'available', value }
}

function unknown<T>(reason: string): Availability<T> {
  return { status: 'unknown', reason }
}

function eventHint(message: RawJsonlMessage): ContextLedgerEventHint | undefined {
  const data = message.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined
  const hint = (data as Record<string, unknown>).contextLedger
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return undefined
  const record = hint as Record<string, unknown>
  if (typeof record.kind !== 'string') return undefined
  return {
    contextArtifactId: typeof record.contextArtifactId === 'string' ? record.contextArtifactId : undefined,
    kind: record.kind as ContextArtifactKind,
    evidenceGrade: record.evidenceGrade === 'A' || record.evidenceGrade === 'B' ? record.evidenceGrade : undefined,
    content: typeof record.content === 'string' ? record.content : undefined,
    sourceUri: typeof record.sourceUri === 'string' ? record.sourceUri : undefined,
    scope: typeof record.scope === 'string' ? record.scope as ContextArtifact['scope'] : 'unknown',
    operation: typeof record.operation === 'string' ? record.operation as ContextInjection['operation'] : 'add',
    trigger: typeof record.trigger === 'string' ? record.trigger as ContextInjection['trigger'] : 'unknown',
    visibleToModel: record.visibleToModel === true || record.visibleToModel === false ? record.visibleToModel : 'unknown'
  }
}

function evidence(message: RawJsonlMessage, grade: EvidenceGrade): EvidenceRef {
  const claimByGrade: Record<EvidenceGrade, EvidenceRef['claim']> = {
    A: 'wire-exact', B: 'provider-confirmed', C: 'deterministically-reconstructed',
    D: 'heuristically-inferred', E: 'current-snapshot'
  }
  return {
    evidenceId: `context-evidence:${message.uuid}`,
    sourceId: `transcript:${message.sessionId}`,
    sourceKind: grade === 'A' ? 'runtime-capture' : 'transcript',
    providerId: message.providerId || message.provider || message.message?.providerId || 'unknown',
    logicalSessionId: message.sessionId,
    sourceEventId: message.uuid,
    sourceRecordId: message.uuid,
    eventTime: message.timestamp,
    capturedAt: message.timestamp,
    effectiveAt: message.timestamp,
    grade,
    claim: claimByGrade[grade]
  }
}

function textParts(message: RawJsonlMessage): ContentPart[] {
  const content = message.message?.content
  if (!Array.isArray(content)) return []
  return content
}

function artifactFromHint(message: RawJsonlMessage, hint: ContextLedgerEventHint, ordinal: number): ContextArtifact {
  const grade = hint.evidenceGrade || 'B'
  const content = hint.content === undefined
    ? unknown<string>('provider recorded the context event without a retained body')
    : available(hint.content)
  return {
    schemaVersion,
    contextArtifactId: hint.contextArtifactId || `context-artifact:${message.uuid}:${ordinal}`,
    kind: hint.kind,
    providerId: message.providerId || message.provider || message.message?.providerId || 'unknown',
    sourceUri: hint.sourceUri === undefined ? unknown('no source URI was recorded') : available(hint.sourceUri),
    scope: hint.scope || 'unknown',
    capturedAt: message.timestamp,
    effectiveAt: available(message.timestamp),
    contentDigest: unknown('the historical source did not record a content digest'),
    content,
    attachmentRef: unknown('not a binary attachment'),
    redaction: hint.content === undefined ? 'content-withheld' : 'none',
    tokenCount: unknown('no per-artifact token measurement was recorded'),
    tokenMeasurement: 'unavailable',
    evidence: [evidence(message, grade)]
  }
}

function mcpToolIdentity(part: ContentPart): { serverId: string; toolId: string } | undefined {
  if (part.type !== 'tool_use' || !part.name) return undefined
  const match = /^mcp__([^_]+)__(.+)$/.exec(part.name)
  return match ? { serverId: match[1], toolId: part.name } : undefined
}

function toolIdentity(toolName: string): { serverId: string; toolId: string } {
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(toolName)
  if (mcp) return { serverId: mcp[1], toolId: toolName }
  const slash = toolName.indexOf('/')
  return slash > 0
    ? { serverId: toolName.slice(0, slash), toolId: toolName }
    : { serverId: 'unknown', toolId: toolName }
}

function unknownBoolean(reason: string): McpContextExposure['configured'] {
  return { state: 'unknown', observedAt: unknown(reason), evidence: [] }
}

function observedBoolean(
  value: boolean,
  observedAt: ReturnType<typeof available<string>> | ReturnType<typeof unknown<string>>,
  refs: EvidenceRef[]
): McpContextExposure['configured'] {
  return { state: value ? 'observed-true' : 'observed-false', observedAt, evidence: refs }
}

function deltaTime(delta: DeferredToolsDelta): ReturnType<typeof available<string>> | ReturnType<typeof unknown<string>> {
  const ref = delta.evidence.find((entry) => entry.effectiveAt || entry.eventTime || entry.capturedAt)
  return ref
    ? available(ref.effectiveAt || ref.eventTime || ref.capturedAt)
    : unknown<string>('deferred-tools effective time was not persisted')
}

function exposureFromDeferredToolsDelta(
  logicalSessionId: string,
  toolName: string,
  delta: DeferredToolsDelta
): McpContextExposure {
  const identity = toolIdentity(toolName)
  const observedAt = deltaTime(delta)
  const added = delta.addedToolNames.includes(toolName)
  const removed = delta.removedToolNames.includes(toolName)
  const deferred = delta.deferredSchemaToolNames.includes(toolName)
  return {
    schemaVersion,
    exposureId: `mcp-exposure:deferred-tools:${delta.deltaId}:${toolName}`,
    logicalSessionId,
    interactionId: unknown('deferred-tools delta has no interaction ID'),
    serverId: identity.serverId,
    toolId: available(identity.toolId),
    configured: unknownBoolean('deferred-tools and tool-search receipts do not prove provider configuration'),
    serverInstructionsVisible: unknownBoolean('deferred-tools delta does not record server instructions'),
    toolNameVisible: added
      ? observedBoolean(true, observedAt, delta.evidence)
      : removed
        ? observedBoolean(false, observedAt, delta.evidence)
      : unknownBoolean('tool-name visibility was not recorded'),
    schemaState: deferred ? 'deferred' : removed ? 'unavailable' : 'unknown',
    schemaEvidence: deferred || removed ? delta.evidence : [],
    called: unknownBoolean('deferred-tools delta does not prove a call'),
    resultVisible: unknownBoolean('deferred-tools delta does not prove result visibility')
  }
}

function exposureFromToolSearchReceipt(
  logicalSessionId: string,
  toolName: string,
  receipt: ToolSearchReceipt
): McpContextExposure {
  const identity = toolIdentity(toolName)
  const observedAt = available(receipt.effectiveAt)
  const visible = receipt.visibleToolNames.includes(toolName)
  const loaded = receipt.loadedSchemaToolNames.includes(toolName)
  return {
    schemaVersion,
    exposureId: `mcp-exposure:tool-search:${receipt.receiptId}:${toolName}`,
    logicalSessionId,
    interactionId: available(receipt.interactionId),
    serverId: identity.serverId,
    toolId: available(identity.toolId),
    configured: unknownBoolean('tool-search receipt does not prove provider configuration'),
    serverInstructionsVisible: unknownBoolean('tool-search receipt does not record server instructions'),
    toolNameVisible: visible
      ? observedBoolean(true, observedAt, receipt.evidence)
      : unknownBoolean('tool-name visibility was not recorded'),
    schemaState: loaded ? 'loaded' : 'unknown',
    schemaEvidence: loaded ? receipt.evidence : [],
    called: unknownBoolean('tool-search receipt does not prove a call'),
    resultVisible: unknownBoolean('tool-search receipt does not prove result visibility')
  }
}

/**
 * Projects only facts persisted in the supplied transcript. No filesystem is
 * consulted: a current CLAUDE.md/AGENTS.md is not evidence of historical use.
 */
export function projectHistoricalContextLedger(
  messages: RawJsonlMessage[],
  logicalSessionId: string,
  persisted: PersistedContextLedgerFacts = {}
): ContextLedgerProjection {
  const artifacts: ContextArtifact[] = [...(persisted.contextArtifacts || [])]
  const injections: ContextInjection[] = [...(persisted.contextInjections || [])]
  const snapshots: ContextSnapshot[] = [...(persisted.contextSnapshots || [])]
  const transitions: ContextTransition[] = [...(persisted.contextTransitions || [])]
  const mcpExposures: McpContextExposure[] = [...(persisted.mcpExposures || [])]
  const evidenceCounts: ContextLedgerProjection['evidenceCounts'] = { A: 0, B: 0, C: 0, D: 0, E: 0 }
  let unknownArtifactCount = 0
  let revision = 0
  let previousSnapshot: ContextSnapshot | undefined = snapshots.at(-1)
  const activeInjectionIds: string[] = previousSnapshot ? [...previousSnapshot.activeInjectionIds] : []

  for (const artifact of artifacts) {
    for (const ref of artifact.evidence) evidenceCounts[ref.grade]++
  }

  const persistedExposureHistory: Array<{ at: string; revision: number; exposure: McpContextExposure }> = []
  for (const delta of persisted.deferredToolsDeltas || []) {
    const at = deltaTime(delta)
    const sortTime = at.status === 'available' ? at.value : ''
    const names = new Set([...delta.addedToolNames, ...delta.removedToolNames, ...delta.deferredSchemaToolNames])
    for (const toolName of names) {
      persistedExposureHistory.push({
        at: sortTime,
        revision: delta.contextRevision,
        exposure: exposureFromDeferredToolsDelta(logicalSessionId, toolName, delta)
      })
    }
  }
  for (const receipt of persisted.toolSearchReceipts || []) {
    const names = new Set([...receipt.visibleToolNames, ...receipt.loadedSchemaToolNames])
    for (const toolName of names) {
      persistedExposureHistory.push({
        at: receipt.effectiveAt,
        revision: Number.MAX_SAFE_INTEGER,
        exposure: exposureFromToolSearchReceipt(logicalSessionId, toolName, receipt)
      })
    }
  }
  persistedExposureHistory.sort((left, right) =>
    left.at.localeCompare(right.at) || left.revision - right.revision || left.exposure.exposureId.localeCompare(right.exposure.exposureId)
  )
  mcpExposures.push(...persistedExposureHistory.map((entry) => entry.exposure))

  for (const message of messages) {
    if (message.isSidechain) continue
    const additions: ContextArtifact[] = []
    const hint = eventHint(message)
    if (hint) additions.push(artifactFromHint(message, hint, additions.length))

    for (const artifact of additions) {
      if (!artifacts.some((entry) => entry.contextArtifactId === artifact.contextArtifactId)) {
        artifacts.push(artifact)
        const grade = artifact.evidence[0]?.grade
        if (grade) evidenceCounts[grade]++
      }
      const injection: ContextInjection = {
        schemaVersion,
        contextInjectionId: `context-injection:${artifact.contextArtifactId}`,
        logicalSessionId,
        requestId: message.requestId ? available(message.requestId) : unknown('no request ID persisted'),
        interactionId: available(message.uuid),
        contextRevision: revision,
        contextArtifactId: artifact.contextArtifactId,
        operation: hint?.operation || 'add',
        trigger: hint?.trigger || 'unknown',
        visibleToModel: hint?.visibleToModel || 'unknown',
        effectiveAt: available(message.timestamp),
        evidence: artifact.evidence
      }
      injections.push(injection)
      if (injection.operation === 'remove') {
        for (let index = activeInjectionIds.length - 1; index >= 0; index--) {
          const active = injections.find((entry) => entry.contextInjectionId === activeInjectionIds[index])
          if (active?.contextArtifactId === injection.contextArtifactId) activeInjectionIds.splice(index, 1)
        }
      } else {
        activeInjectionIds.push(injection.contextInjectionId)
      }
    }

    for (const part of textParts(message)) {
      const tool = mcpToolIdentity(part)
      if (!tool) continue
      const callEvidence = evidence(message, 'B')
      evidenceCounts.B++
      mcpExposures.push({
        schemaVersion,
        exposureId: `mcp-exposure:${message.uuid}:${part.id || tool.toolId}`,
        logicalSessionId,
        interactionId: available(message.uuid),
        serverId: tool.serverId,
        toolId: available(tool.toolId),
        configured: { state: 'unknown', observedAt: unknown('configuration was not persisted'), evidence: [] },
        serverInstructionsVisible: { state: 'unknown', observedAt: unknown('instructions were not persisted'), evidence: [] },
        toolNameVisible: { state: 'unknown', observedAt: unknown('tool listing was not persisted'), evidence: [] },
        schemaState: 'unknown',
        schemaEvidence: [],
        called: { state: 'observed-true', observedAt: available(message.timestamp), evidence: [callEvidence] },
        resultVisible: { state: 'unknown', observedAt: unknown('a call does not prove its result entered the next request'), evidence: [] }
      })
    }

    const usage = message.message?.usage
    if (!usage || typeof usage.input_tokens !== 'number') continue
    revision++
    const snapshot: ContextSnapshot = {
      schemaVersion,
      contextSnapshotId: `context-snapshot:${message.uuid}`,
      logicalSessionId,
      requestId: message.requestId ? available(message.requestId) : unknown('no request ID persisted'),
      interactionId: available(message.uuid),
      modelId: message.message?.model ? available(message.message.model) : unknown('no model ID persisted'),
      contextLimit: unknown('model context limit was not persisted'),
      contextRevision: revision,
      activeInjectionIds: [...activeInjectionIds],
      reportedInputTokens: available(usage.input_tokens),
      accountedInputTokens: unknown('per-artifact reported input tokens were not persisted'),
      unknownInputTokens: available(usage.input_tokens),
      coveragePercent: available(0),
      evidence: [evidence(message, 'B')]
    }
    snapshots.push(snapshot)
    evidenceCounts.B++

    if (previousSnapshot) {
      const previous = new Set(previousSnapshot.activeInjectionIds)
      const current = new Set(snapshot.activeInjectionIds)
      const deltas: ContextTransition['deltas'] = [
        ...[...current].filter((id) => !previous.has(id)).map((id) => ({
          contextArtifactId: injections.find((entry) => entry.contextInjectionId === id)?.contextArtifactId || id,
          disposition: 'introduced' as const,
          fromInjectionIds: [], toInjectionIds: [id], evidence: snapshot.evidence
        })),
        ...[...current].filter((id) => previous.has(id)).map((id) => ({
          contextArtifactId: injections.find((entry) => entry.contextInjectionId === id)?.contextArtifactId || id,
          disposition: 'preserved' as const,
          fromInjectionIds: [id], toInjectionIds: [id], evidence: snapshot.evidence
        })),
        ...[...previous].filter((id) => !current.has(id)).map((id) => ({
          contextArtifactId: injections.find((entry) => entry.contextInjectionId === id)?.contextArtifactId || id,
          disposition: 'dropped' as const,
          fromInjectionIds: [id], toInjectionIds: [], evidence: snapshot.evidence
        }))
      ]
      transitions.push({
        schemaVersion,
        contextTransitionId: `context-transition:${previousSnapshot.contextSnapshotId}:${snapshot.contextSnapshotId}`,
        kind: 'request',
        fromSnapshotId: available(previousSnapshot.contextSnapshotId),
        toSnapshotId: snapshot.contextSnapshotId,
        interactionId: available(message.uuid),
        effectiveAt: available(message.timestamp),
        deltas,
        derivation: 'derived',
        algorithmId: 't211C-historical-context-ledger',
        algorithmVersion: '1.0.0',
        evidence: snapshot.evidence
      })
    }
    previousSnapshot = snapshot
  }

  // Unknown is a first-class state even when no known artifact could be made.
  unknownArtifactCount = snapshots.filter((snapshot) =>
    snapshot.unknownInputTokens.status === 'available' && snapshot.unknownInputTokens.value > 0
  ).length
  return { logicalSessionId, artifacts, injections, snapshots, transitions, mcpExposures, evidenceCounts, unknownArtifactCount }
}

export function exportHistoricalContextLedger(projection: ContextLedgerProjection): ContextLedgerExport {
  return { schemaVersion: 1, contractVersion: '1.0.0', projection }
}
