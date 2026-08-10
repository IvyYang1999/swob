import type { CanonicalEvent, Fingerprint, UsageRecord } from '../../shared/provider-schema-v2.generated'
import type {
  ArtifactVersionRef, Availability, BranchUsageRollup, EvidenceRef, FileAction, FileEntityRef,
  FileRevisionRef, ForkBoundary, Interaction, InteractionModelCallFact, InteractionTrajectoryReadModel,
  UsageAttribution
} from '../../shared/contracts/truth-kernel'

const unavailable = <T>(reason: string): Availability<T> => ({ status: 'unavailable', reason })
const available = <T>(value: T): Availability<T> => ({ status: 'available', value })

interface ProjectionScope {
  rootId?: string
  repositoryId?: string
  worktreeId?: string
}

export interface InteractionLedgerProjection {
  interactions: Interaction[]
  fileActions: FileAction[]
  usageAttributions: UsageAttribution[]
  branchUsageRollups: BranchUsageRollup[]
  forkBoundaries: ForkBoundary[]
}

function evidence(event: CanonicalEvent, claim: EvidenceRef['claim'] = 'wire-exact'): EvidenceRef {
  return {
    evidenceId: `event:${event.id}`,
    sourceId: event.provenance.sourceRefId,
    sourceKind: 'provider',
    providerId: event.provenance.providerId,
    logicalSessionId: event.identity.logicalSessionId,
    sourceEventId: event.id,
    eventTime: event.timestamp || undefined,
    capturedAt: event.provenance.observedAt || new Date(0).toISOString(),
    grade: claim === 'wire-exact' ? 'A' : 'B',
    claim,
    locator: event.rawRef ? {
      kind: 'provider-raw-ref', locatorHash: event.rawRef.locatorHash,
      offset: event.rawRef.offset, length: event.rawRef.length
    } : undefined
  }
}

function time(value: string | null): Availability<string> {
  return value ? available(value) : unavailable('provider-event-time-unavailable')
}

function duration(first: CanonicalEvent, last: CanonicalEvent): Availability<number> {
  if (!first.timestamp || !last.timestamp) return unavailable('interaction-boundary-time-unavailable')
  const start = Date.parse(first.timestamp)
  const end = Date.parse(last.timestamp)
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? available(end - start)
    : unavailable('interaction-boundary-time-invalid')
}

function payloadRecord(event: CanonicalEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {}
}

function fingerprint(value: unknown): Fingerprint | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const candidate = value as Partial<Fingerprint>
  return typeof candidate.value === 'string' && candidate.algorithm === 'sha256'
    ? candidate as Fingerprint
    : undefined
}

function entity(uri: string, scope: ProjectionScope, logicalSessionId: string): FileEntityRef {
  const identity = [scope.rootId || '?', scope.repositoryId || '?', scope.worktreeId || '?', uri]
    .map(encodeURIComponent).join(':')
  return {
    fileEntityId: `file:${identity}`,
    entityKind: uri.endsWith('/') || uri.endsWith('\\') ? 'directory' : 'file',
    scope: {
      rootId: scope.rootId ? available(scope.rootId) : unavailable('source-root-not-exposed'),
      repositoryId: scope.repositoryId ? available(scope.repositoryId) : unavailable('source-repository-not-exposed'),
      worktreeId: scope.worktreeId ? available(scope.worktreeId) : unavailable('source-worktree-not-exposed'),
      logicalPath: uri,
      originalPath: available(uri),
      displayPath: uri
    }
  }
}

function revision(target: FileEntityRef, digest: Fingerprint | undefined, event: CanonicalEvent, phase: 'before' | 'after'): Availability<FileRevisionRef> {
  if (!digest) return unavailable(`${phase}-content-hash-not-exposed`)
  return available({
    fileRevisionId: `${target.fileEntityId}:${digest.value}`,
    fileEntityId: target.fileEntityId,
    contentDigest: available(digest.value),
    observedAt: time(event.timestamp)
  })
}

function artifactVersion(payload: Record<string, unknown>, event: CanonicalEvent): ArtifactVersionRef[] {
  if (typeof payload.artifactId !== 'string') return []
  const digest = fingerprint(payload.artifactFingerprint ?? payload.fingerprint)
  return [{
    schemaVersion: 1,
    artifactVersionId: `${payload.artifactId}:${String(payload.version ?? event.id)}`,
    artifactId: payload.artifactId,
    contentDigest: digest ? available(digest.value) : unavailable('artifact-content-hash-not-exposed'),
    sourceVersion: typeof payload.version === 'string' ? available(payload.version) : unavailable('artifact-version-not-exposed'),
    evidence: [evidence(event)]
  }]
}

function fileAction(event: CanonicalEvent, interactionId: string, scope: ProjectionScope): FileAction | undefined {
  if (event.kind !== 'artifact' && event.kind !== 'tool.result' && event.kind !== 'tool.call') return undefined
  const payload = payloadRecord(event)
  const rawAction = typeof payload.action === 'string' ? payload.action : payload.fileAction
  const mapped = rawAction === 'reference' ? 'read' : rawAction === 'write' || rawAction === 'edit' ? 'update' : rawAction
  if (!['read', 'update', 'create', 'delete', 'rename', 'search', 'execute-produced'].includes(String(mapped))) return undefined
  const uri = mapped === 'rename' ? payload.toUri : payload.uri
  if (typeof uri !== 'string') return undefined
  const target = entity(uri, scope, event.identity.logicalSessionId)
  const fromUri = typeof payload.fromUri === 'string' ? payload.fromUri : undefined
  return {
    schemaVersion: 1,
    fileActionId: `file-action:${event.id}`,
    interactionId,
    sourceEventId: event.id,
    operation: mapped as FileAction['operation'],
    result: payload.result === 'failed' || payload.exists === false && mapped === 'read' ? 'failed'
      : payload.result === 'partial' ? 'partial' : payload.result === 'unknown' ? 'unknown' : 'succeeded',
    target,
    beforeRevision: revision(fromUri ? entity(fromUri, scope, event.identity.logicalSessionId) : target, fingerprint(payload.beforeFingerprint), event, 'before'),
    afterRevision: revision(target, fingerprint(payload.afterFingerprint ?? payload.fingerprint), event, 'after'),
    renameChain: mapped === 'rename' && fromUri ? [{
      from: entity(fromUri, scope, event.identity.logicalSessionId), to: target, evidence: [evidence(event)]
    }] : [],
    producedArtifactVersions: artifactVersion(payload, event),
    derivation: 'observed',
    evidence: [evidence(event)]
  }
}

type QuantityRow = {
  kind: UsageAttribution['quantityKind']
  unit: UsageAttribution['quantityUnit']
  value: number | null
}

function usageQuantities(usage: UsageRecord, payload: Record<string, unknown>): QuantityRow[] {
  const cacheWrite = usage.input.cacheWrite5m === null && usage.input.cacheWrite1h === null
    ? null
    : (usage.input.cacheWrite5m ?? 0) + (usage.input.cacheWrite1h ?? 0)
  const rows: QuantityRow[] = [
    { kind: 'input-token', unit: 'token', value: usage.input.uncached },
    { kind: 'output-token', unit: 'token', value: usage.output.total },
    { kind: 'cache-read-token', unit: 'token', value: usage.input.cacheRead },
    { kind: 'cache-write-token', unit: 'token', value: cacheWrite },
    { kind: 'reasoning-token', unit: 'token', value: usage.output.reasoning }
  ]
  const toolTokens = payload.toolTokens
  rows.push({ kind: 'tool-token', unit: 'token', value: typeof toolTokens === 'number' ? toolTokens : null })
  const nonToken = payload.nonToken
  if (nonToken && typeof nonToken === 'object' && !Array.isArray(nonToken)) {
    const record = nonToken as Record<string, unknown>
    const validUnits = ['request', 'image', 'second', 'byte', 'provider-unit']
    rows.push({
      kind: 'non-token',
      unit: validUnits.includes(String(record.unit)) ? record.unit as QuantityRow['unit'] : 'unknown',
      value: typeof record.quantity === 'number' ? record.quantity : null
    })
  } else {
    rows.push({ kind: 'non-token', unit: 'unknown', value: null })
  }
  return rows
}

function modelCalls(group: CanonicalEvent[]): InteractionModelCallFact[] {
  let model: string | undefined
  let mode: string | undefined
  const calls: InteractionModelCallFact[] = []
  for (const event of group) {
    const payload = payloadRecord(event)
    if (event.kind === 'model.changed' && typeof payload.toModelId === 'string') model = payload.toModelId
    if (event.kind === 'mode.changed' && typeof payload.toMode === 'string') mode = payload.toMode
    if (event.kind === 'usage') {
      const usage = event.payload as unknown as UsageRecord
      const observedModelId = usage.modelId ?? model
      if (observedModelId) calls.push({
        providerId: event.provenance.providerId,
        observedModelId,
        canonicalModelId: unavailable('user-model-alias-not-resolved'),
        mode: mode ? available(mode) : unavailable('provider-mode-not-exposed'),
        evidence: [evidence(event)]
      })
    }
  }
  return calls.filter((call, index) => calls.findIndex((candidate) => candidate.observedModelId === call.observedModelId) === index)
}

function projectionScopes(events: readonly CanonicalEvent[]): Map<string, ProjectionScope> {
  const scopes = new Map<string, ProjectionScope>()
  for (const event of events) {
    if (event.kind !== 'session.metadata') continue
    const payload = payloadRecord(event)
    const cwd = Array.isArray(payload.cwd) ? payload.cwd.filter((value): value is string => typeof value === 'string')[0] : undefined
    scopes.set(event.identity.logicalSessionId, {
      rootId: typeof payload.rootId === 'string' ? payload.rootId : cwd,
      repositoryId: typeof payload.repositoryId === 'string' ? payload.repositoryId : typeof payload.projectPath === 'string' ? payload.projectPath : undefined,
      worktreeId: typeof payload.worktreeId === 'string' ? payload.worktreeId : cwd
    })
  }
  return scopes
}

function deriveForkBoundaries(events: readonly CanonicalEvent[], interactions: Interaction[]): ForkBoundary[] {
  const sessions = new Map<string, CanonicalEvent[]>()
  for (const event of events) {
    const rows = sessions.get(event.identity.logicalSessionId) ?? []
    rows.push(event)
    sessions.set(event.identity.logicalSessionId, rows)
  }
  const keySessions = new Map<string, Set<string>>()
  for (const event of events) {
    const owners = keySessions.get(event.sharedEventKey) ?? new Set<string>()
    owners.add(event.identity.logicalSessionId)
    keySessions.set(event.sharedEventKey, owners)
  }
  const boundaries: ForkBoundary[] = []
  for (const [sessionId, rows] of sessions) {
    const parentBranch = rows.find((row) => row.identity.parentBranchViewId)?.identity.parentBranchViewId
    const shared = rows.filter((row) => (keySessions.get(row.sharedEventKey)?.size ?? 0) > 1)
    if (!parentBranch && shared.length === 0) continue
    const firstIndependent = rows.find((row) => !shared.includes(row))
    const sharedEvent = shared.at(-1)
    const sharedInteraction = sharedEvent && interactions.find((row) => row.sourceEventIds.includes(sharedEvent.id))
    const independentInteraction = firstIndependent && interactions.find((row) => row.sourceEventIds.includes(firstIndependent.id))
    boundaries.push({
      schemaVersion: 1,
      forkBoundaryId: `fork:${sessionId}:${parentBranch ?? 'shared-key'}`,
      parentLogicalSessionId: unavailable('parent-logical-session-id-not-exposed'),
      childLogicalSessionId: sessionId,
      forkEventId: unavailable('fork-event-id-not-exposed'),
      firstIndependentEventId: firstIndependent ? available(firstIndependent.id) : unavailable('no-independent-event-observed'),
      sharedAncestorInteractionId: sharedInteraction ? available(sharedInteraction.interactionId) : unavailable('shared-ancestor-interaction-not-observed'),
      firstIndependentInteractionId: independentInteraction ? available(independentInteraction.interactionId) : unavailable('first-independent-interaction-not-observed'),
      sharedEventKeys: shared.map((row) => row.sharedEventKey),
      detection: shared.length > 0 ? 'shared-event-key' : 'harness-metadata',
      evidence: [...shared, ...(firstIndependent ? [firstIndependent] : [])].map((row) => evidence(row, 'deterministically-reconstructed'))
    })
  }
  return boundaries
}

function rollups(attributions: UsageAttribution[], eventsById: Map<string, CanonicalEvent>, interactions: Interaction[]): BranchUsageRollup[] {
  const groups = new Map<string, UsageAttribution[]>()
  for (const row of attributions) {
    const event = eventsById.get(row.usageFactIds[0])
    const session = event?.identity.logicalSessionId ?? 'unknown'
    const key = `${session}\0${row.quantityKind}\0${row.quantityUnit}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const canonicalOwner = new Map<string, string>()
  for (const event of eventsById.values()) {
    const current = canonicalOwner.get(event.sharedEventKey)
    if (!current || event.identity.logicalSessionId.localeCompare(current) < 0) canonicalOwner.set(event.sharedEventKey, event.identity.logicalSessionId)
  }
  const sum = (rows: UsageAttribution[]): Availability<number> => {
    const values = rows.filter((row) => row.quantity.status === 'available').map((row) => row.quantity.status === 'available' ? row.quantity.value : 0)
    return rows.length === values.length ? available(values.reduce((total, value) => total + value, 0)) : unavailable('one-or-more-quantities-unavailable')
  }
  return [...groups.entries()].map(([key, rows]) => {
    const [logicalSessionId, quantityKind, quantityUnit] = key.split('\0') as [string, UsageAttribution['quantityKind'], UsageAttribution['quantityUnit']]
    const total = sum(rows)
    const forked = interactions.some((row) => row.logicalSessionId === logicalSessionId && row.lineagePhase !== 'unknown')
    const branchRows = forked ? rows.filter((row) => interactions.find((interaction) => interaction.interactionId === row.interactionId)?.lineagePhase === 'independent') : rows
    const uniqueRows = rows.filter((row) => {
      const event = eventsById.get(row.usageFactIds[0])
      return !event || canonicalOwner.get(event.sharedEventKey) === logicalSessionId
    })
    const branchTotal = sum(branchRows)
    const uniqueTotal = sum(uniqueRows)
    const billingFactIds = [...new Set(rows.flatMap((row) => row.billingFactIds))]
    const residual = total.status === 'available' ? available(0) : unavailable<number>('source-total-unavailable')
    const basis = (name: BranchUsageRollup['bases'][number]['basis'], basisTotal: Availability<number>) => ({ basis: name, total: basisTotal, residual: basisTotal.status === 'available' ? available(0) : unavailable<number>('basis-total-unavailable'), billingFactIds })
    const anomalyRows = rows.filter((row) => row.quantity.status === 'unavailable' && row.quantity.reason.startsWith('cumulative-counter-'))
    return {
      schemaVersion: 1,
      rollupId: `rollup:${logicalSessionId}:${quantityKind}:${quantityUnit}`,
      logicalSessionId,
      quantityKind,
      quantityUnit,
      bases: [basis('physical-session-usage', total), basis('current-branch-incremental-usage', branchTotal), basis('lineage-unique-usage', uniqueTotal)],
      sourceTotal: total,
      attributedTotal: total,
      anomalyRefs: anomalyRows.map((row) => ({
        code: row.quantity.status === 'unavailable' && row.quantity.reason === 'cumulative-counter-reset' ? 'counter-reset' : 'negative-delta',
        usageFactIds: row.usageFactIds,
        evidence: row.evidence
      })),
      evidence: rows.flatMap((row) => row.evidence)
    }
  })
}

/** Deterministic projector. Cumulative snapshots are converted to adjacent deltas before attribution. */
export function projectInteractionLedger(events: readonly CanonicalEvent[]): InteractionLedgerProjection {
  const ordered = [...events].sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
  const sessionGroups = new Map<string, CanonicalEvent[][]>()
  for (const event of ordered) {
    const groups = sessionGroups.get(event.identity.logicalSessionId) ?? []
    if (event.actor === 'user' || groups.length === 0) groups.push([])
    groups.at(-1)?.push(event)
    sessionGroups.set(event.identity.logicalSessionId, groups)
  }
  const groups = [...sessionGroups.values()].flat().sort((a, b) => a[0].sequence - b[0].sequence || a[0].id.localeCompare(b[0].id))
  const scopes = projectionScopes(ordered)
  const fileActions: FileAction[] = []
  const usageAttributions: UsageAttribution[] = []
  const cumulative = new Map<string, number>()
  const sessionOrdinals = new Map<string, number>()
  const interactions: Interaction[] = groups.filter((group) => group.length > 0).map((group) => {
    const first = group[0]
    const last = group.at(-1)!
    const interactionId = `interaction:${first.identity.logicalSessionId}:${first.id}`
    const ordinal = (sessionOrdinals.get(first.identity.logicalSessionId) ?? 0) + 1
    sessionOrdinals.set(first.identity.logicalSessionId, ordinal)
    const scope = scopes.get(first.identity.logicalSessionId) ?? {}
    const actionRows = group.map((event) => fileAction(event, interactionId, scope)).filter((row): row is FileAction => Boolean(row))
    const usageRows: UsageAttribution[] = []
    for (const event of group.filter((row) => row.kind === 'usage')) {
      const usage = event.payload as unknown as UsageRecord
      const payload = payloadRecord(event)
      const sourceGranularity = usage.aggregation === 'cumulative' ? 'cumulative-snapshot' : 'per-call'
      for (const quantity of usageQuantities(usage, payload)) {
        let value: Availability<number>
        let measurement: UsageAttribution['measurement']
        if (quantity.value === null || !Number.isFinite(quantity.value) || quantity.value < 0) {
          value = unavailable(usage.aggregation === 'cumulative' && typeof quantity.value === 'number' && quantity.value < 0 ? 'cumulative-counter-negative-delta' : 'provider-counter-unavailable')
          measurement = 'unavailable'
        } else if (usage.aggregation === 'cumulative') {
          const counterKey = `${event.identity.logicalSessionId}\0${usage.modelId ?? 'unknown-model'}\0${quantity.kind}\0${quantity.unit}`
          const previous = cumulative.get(counterKey)
          cumulative.set(counterKey, quantity.value)
          if (previous !== undefined && quantity.value < previous) {
            value = unavailable('cumulative-counter-reset')
            measurement = 'unavailable'
          } else {
            value = available(previous === undefined ? quantity.value : quantity.value - previous)
            measurement = previous === undefined ? 'exact' : 'derived'
          }
        } else {
          value = available(quantity.value)
          measurement = usage.measurement.confidence === 'exact' ? 'exact' : usage.measurement.source === 'estimated' ? 'estimated' : 'derived'
        }
        usageRows.push({
          schemaVersion: 1,
          usageAttributionId: `usage:${event.id}:${quantity.kind}:${quantity.unit}`,
          interactionId,
          usageFactIds: [event.id],
          billingFactIds: [usage.billingFactKey],
          quantityKind: quantity.kind,
          quantityUnit: quantity.unit,
          quantity: value,
          measurement,
          residual: value.status === 'available' ? available(0) : unavailable('quantity-unavailable'),
          sourceGranularity,
          lineageScope: 'physical-session',
          evidence: [evidence(event, usage.aggregation === 'cumulative' ? 'deterministically-reconstructed' : 'wire-exact')]
        })
      }
    }
    fileActions.push(...actionRows)
    usageAttributions.push(...usageRows)
    const wall = duration(first, last)
    return {
      schemaVersion: 1,
      interactionId,
      logicalSessionId: first.identity.logicalSessionId,
      ordinal,
      trigger: first.actor === 'user' ? 'user' : 'system',
      startEventId: first.id,
      endEventId: last.id,
      sourceEventIds: group.map((event) => event.id),
      startedAt: time(first.timestamp),
      endedAt: time(last.timestamp),
      modelCalls: modelCalls(group),
      toolEventIds: group.filter((event) => event.kind === 'tool.call').map((event) => event.id),
      toolCount: group.filter((event) => event.kind === 'tool.call').length,
      timing: {
        wall: { milliseconds: wall, measurement: wall.status === 'available' ? 'exact' : 'unavailable', evidence: [evidence(first), evidence(last)] },
        agentActive: { milliseconds: unavailable('provider-active-duration-not-exposed'), measurement: 'unavailable', evidence: [] },
        wait: { milliseconds: unavailable('provider-wait-duration-not-exposed'), measurement: 'unavailable', evidence: [] }
      },
      usageAttributionIds: usageRows.map((row) => row.usageAttributionId),
      fileActionIds: actionRows.map((row) => row.fileActionId),
      consumedArtifactVersionIds: [],
      producedArtifactVersionIds: actionRows.flatMap((row) => row.producedArtifactVersions.map((artifact) => artifact.artifactVersionId)),
      contextSnapshotIds: [],
      lineagePhase: 'unknown',
      evidence: group.map((event) => evidence(event))
    } satisfies Interaction
  })
  const forkBoundaries = deriveForkBoundaries(ordered, interactions)
  for (const boundary of forkBoundaries) {
    if (boundary.sharedAncestorInteractionId.status === 'available') {
      const sharedInteractionId = boundary.sharedAncestorInteractionId.value
      const sharedOrdinal = interactions.find((row) => row.interactionId === sharedInteractionId)?.ordinal ?? 0
      for (const interaction of interactions.filter((row) => row.logicalSessionId === boundary.childLogicalSessionId)) {
        interaction.lineagePhase = interaction.ordinal <= sharedOrdinal ? 'shared-prefix' : 'independent'
      }
    }
  }
  return {
    interactions,
    fileActions,
    usageAttributions,
    branchUsageRollups: rollups(usageAttributions, new Map(ordered.map((event) => [event.id, event])), interactions),
    forkBoundaries
  }
}

export function projectTrajectory(
  interaction: Interaction,
  usageAttributions: UsageAttribution[],
  fileActions: FileAction[],
  forkBoundary?: ForkBoundary,
  branchUsageRollups: BranchUsageRollup[] = []
): InteractionTrajectoryReadModel {
  return {
    schemaVersion: 1,
    interactionId: interaction.interactionId,
    logicalSessionId: interaction.logicalSessionId,
    ordinal: interaction.ordinal,
    modelCalls: interaction.modelCalls,
    toolCount: interaction.toolCount,
    timing: interaction.timing,
    usageAttributions: usageAttributions.filter((row) => row.interactionId === interaction.interactionId),
    branchUsageRollups: branchUsageRollups.filter((row) => row.logicalSessionId === interaction.logicalSessionId),
    valuations: [],
    fileActions: fileActions.filter((row) => row.interactionId === interaction.interactionId),
    toolEventIds: interaction.toolEventIds,
    contextPhase: 'unknown',
    lineagePhase: interaction.lineagePhase === 'shared-prefix' ? 'inherited' : interaction.lineagePhase === 'independent' ? 'independent' : 'unknown',
    forkBoundary: forkBoundary ? available(forkBoundary) : unavailable('fork-boundary-not-observed')
  }
}
