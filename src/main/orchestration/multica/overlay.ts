import { createHash } from 'node:crypto'
import type { EvidenceRef, OrchestrationEntityLink, OrchestrationRun, SessionOrchestrationLink } from '../../../shared/contracts/truth-kernel'
import type { JsonValue } from '../../../shared/provider-schema-v2.generated'
import { multicaDoctor, type MulticaDiscoveryOptions } from './discovery'
import { reconcileMulticaUsage } from './reconciliation'
import { MULTICA_ORCHESTRATION_DESCRIPTOR, type MulticaEntityInput, type MulticaOverlayProjection, type MulticaUsageInput } from './types'

function evidence(item: Pick<MulticaEntityInput, 'id' | 'raw' | 'source'>, suffix = item.id): EvidenceRef {
  const digest = item.source?.sha256 || createHash('sha256').update(JSON.stringify(item.raw)).digest('hex')
  return {
    evidenceId: `multica-overlay-${suffix}-${digest.slice(0, 12)}`,
    sourceId: item.source ? `multica-file:${digest}` : `multica-derived:${item.id}`,
    sourceKind: item.source ? 'provider' : 'artifact',
    providerId: 'multica',
    sourceRecordId: item.id,
    capturedAt: item.source?.capturedAt || new Date().toISOString(),
    grade: item.source ? 'B' : 'C',
    claim: item.source ? 'provider-confirmed' : 'deterministically-reconstructed',
    locator: item.source ? { kind: 'source-record', locatorHash: digest, offset: 0, length: item.source.byteLength } : undefined,
    digest
  }
}

function availability(value: string | undefined, reason: string) {
  return value ? { status: 'available' as const, value } : { status: 'unknown' as const, reason }
}

function relationLink(item: MulticaEntityInput, fromEntityId: string, toEntityId: string, relation: OrchestrationEntityLink['relation'], nativeRelation: string): OrchestrationEntityLink {
  const edgeId = `multica-${relation}-${fromEntityId}-${toEntityId}`
  return { schemaVersion: 1, edgeId, orchestratorId: 'multica', fromEntityId, toEntityId, relation, nativeRelation: { status: 'available', value: nativeRelation }, evidence: [evidence(item, edgeId)] }
}

function runStatus(value: string | undefined): OrchestrationRun['status'] {
  if (value === 'queued' || value === 'running' || value === 'completed' || value === 'failed' || value === 'cancelled') return value
  return 'unknown'
}

function verifierOutcome(value: string | undefined): 'accepted' | 'rejected' | 'cancelled' | 'unknown' {
  return value === 'accepted' || value === 'rejected' || value === 'cancelled' ? value : 'unknown'
}

export interface MulticaOverlayInput {
  entities: MulticaEntityInput[]
  usages?: MulticaUsageInput[]
  discovery: MulticaDiscoveryOptions
}

/** Projects native Multica records. It has no write path and never replaces native transcript Providers. */
export function projectMulticaOverlay(input: MulticaOverlayInput): MulticaOverlayProjection {
  const entities = input.entities.map((item) => ({
    schemaVersion: 1 as const,
    orchestrationEntityId: `multica-${item.kind}-${item.id}`,
    orchestratorId: 'multica',
    nativeKind: item.kind,
    nativeId: item.id,
    rawPayload: item.raw as JsonValue,
    evidence: [evidence(item, `${item.kind}-${item.id}`)]
  }))
  const links: OrchestrationEntityLink[] = []
  const runs: OrchestrationRun[] = []
  const sessionLinks: SessionOrchestrationLink[] = []
  const taskByAttempt = new Map<string, string>()
  for (const task of input.entities.filter((item) => item.kind === 'task')) {
    for (const attemptId of [...(task.attemptIds || []), ...(task.attemptId ? [task.attemptId] : [])]) taskByAttempt.set(attemptId, task.id)
  }
  for (const attempt of input.entities.filter((item) => item.kind === 'attempt' && item.taskId)) taskByAttempt.set(attempt.id, attempt.taskId!)

  const seenEdges = new Set<string>()
  const entityIds = new Set(entities.map((entity) => entity.orchestrationEntityId))
  const add = (edge: OrchestrationEntityLink): void => { if (!seenEdges.has(edge.edgeId)) { seenEdges.add(edge.edgeId); links.push(edge) } }
  for (const item of input.entities) {
    const entityId = `multica-${item.kind}-${item.id}`
    if (item.parentId) add(relationLink(item, `multica-${item.parentKind || 'issue'}-${item.parentId}`, entityId, 'parent-of', `${item.parentKind || 'issue'}-${item.kind}`))
    for (const dependencyId of item.dependencyIds || []) add(relationLink(item, entityId, `multica-task-${dependencyId}`, 'depends-on', 'dependency'))
    if (item.kind === 'task') for (const attemptId of [...(item.attemptIds || []), ...(item.attemptId ? [item.attemptId] : [])]) add(relationLink(item, entityId, `multica-attempt-${attemptId}`, 'executes', 'task-attempt'))
    if (item.kind === 'task' && item.agentId) add(relationLink(item, `multica-agent-${item.agentId}`, entityId, 'executes', 'agent-task'))
    if (item.kind === 'attempt' && taskByAttempt.has(item.id)) add(relationLink(item, `multica-task-${taskByAttempt.get(item.id)}`, entityId, 'executes', 'task-attempt'))
    if (item.kind === 'stage') for (const taskId of [...(item.taskIds || []), ...(item.taskId ? [item.taskId] : [])]) add(relationLink(item, entityId, `multica-task-${taskId}`, 'contains', 'stage-task'))
    if (item.kind === 'verifier' && item.subjectId) add(relationLink(item, entityId, `multica-task-${item.subjectId}`, 'verifies', 'verifier-subject'))
    if (item.kind === 'verifier') for (const evidenceId of item.evidenceIds || []) {
      const evidenceEntityId = `multica-evidence-${evidenceId}`
      if (entityIds.has(evidenceEntityId)) add(relationLink(item, entityId, evidenceEntityId, 'uses-evidence', 'verifier-evidence'))
    }
    if (item.kind === 'artifact' && item.producerAttemptId) add(relationLink(item, entityId, `multica-attempt-${item.producerAttemptId}`, 'produced-by', 'artifact-producer'))
    if (item.kind === 'comment' && item.taskId) add(relationLink(item, `multica-task-${item.taskId}`, entityId, 'contains', 'task-comment-route'))
    if (item.kind === 'attempt') {
      const runId = `multica-attempt-${item.id}`
      runs.push({ schemaVersion: 1, orchestrationRunId: runId, orchestratorId: 'multica', nativeEntityIds: [entityId], startedAt: availability(undefined, 'Attempt start time was not present in the source record.'), endedAt: availability(undefined, 'Attempt end time was not present in the source record.'), status: runStatus(item.status), evidence: [evidence(item, `run-${item.id}`)] })
      for (const sessionId of item.sessionIds || []) sessionLinks.push({ schemaVersion: 1, linkId: `multica-link-${item.id}-${sessionId}`, orchestrationRunId: runId, logicalSessionId: sessionId, relation: 'attempt', evidence: [evidence(item, `link-${item.id}-${sessionId}`)] })
    }
  }

  const attempts = input.entities.filter((item) => item.kind === 'attempt').map((item) => {
    const taskId = taskByAttempt.get(item.id)
    const activePeer = input.entities.find((peer) => peer.kind === 'attempt' && peer.id !== item.id && taskByAttempt.get(peer.id) === taskId && ['running', 'queued'].includes(peer.status || ''))
    const duplicateOf = item.duplicateOf || (item.status === 'queued' && activePeer?.status === 'running' ? activePeer.id : undefined)
    const status = runStatus(item.status)
    return { attemptId: item.id, taskId, status, duplicateOf, isDuplicate: Boolean(duplicateOf), successful: status === 'completed' }
  })
  const verifiers = input.entities.filter((item) => item.kind === 'verifier').map((item) => {
    const outcome = verifierOutcome(item.outcome || item.status)
    return { verifierId: item.id, outcome, successful: outcome === 'accepted' }
  })
  const stageBarriers = input.entities.filter((item) => item.kind === 'stage').map((stage) => {
    const taskIds = [...new Set([...(stage.taskIds || []), ...(stage.taskId ? [stage.taskId] : [])])]
    const verifierIds = stage.verifierIds || []
    const stageAttempts = attempts.filter((attempt) => attempt.taskId && taskIds.includes(attempt.taskId) && !attempt.isDuplicate)
    const stageVerifiers = verifiers.filter((verifier) => verifierIds.includes(verifier.verifierId))
    const satisfied = taskIds.length > 0 && stageAttempts.length > 0 && stageAttempts.every((attempt) => attempt.successful) && verifierIds.length > 0 && stageVerifiers.length === verifierIds.length && stageVerifiers.every((verifier) => verifier.successful)
    return { stageId: stage.id, taskIds, verifierIds, satisfied, reason: satisfied ? 'All non-duplicate attempts completed and all required verifiers accepted.' : 'Barrier remains closed: cancelled/failed/running attempts and cancelled/rejected/missing verifiers are not success.' }
  })
  const doctor = multicaDoctor(input.discovery)
  const missingDimensions = [...(doctor.capabilities.discovery === 'unavailable' ? ['workspace discovery'] : []), ...(doctor.schemaVersion.status === 'available' ? [] : ['schema version'])]
  return {
    descriptor: MULTICA_ORCHESTRATION_DESCRIPTOR,
    entities,
    entityLinks: links,
    runs,
    sessionLinks,
    usageAggregates: reconcileMulticaUsage(input.usages || []),
    coverage: { state: missingDimensions.length === 0 ? 'complete' : 'partial', coveredFactIds: entities.map((entry) => entry.orchestrationEntityId), missingDimensions, evidence: input.entities.length ? [evidence(input.entities[0], 'coverage')] : [] },
    doctor,
    semantics: { attempts, verifiers, stageBarriers }
  }
}
