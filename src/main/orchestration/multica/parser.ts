import { createHash } from 'node:crypto'
import type { JsonValue } from '../../../shared/provider-schema-v2.generated'
import type { MulticaEntityInput, MulticaSourceEvidence, MulticaUsageInput, MulticaWorkspaceSnapshot } from './types'

export interface ParsedMulticaWorkspace {
  schemaVersion?: string
  entities: MulticaEntityInput[]
  usages: MulticaUsageInput[]
  diagnostics: string[]
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((entry) => string(entry) ? [entry as string] : []) : []
}

function json(value: unknown): JsonValue | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) {
    const converted = value.map(json)
    return converted.every((entry) => entry !== null) ? converted as JsonValue : null
  }
  const record = object(value)
  if (!record) return null
  const converted: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>
  for (const [key, entry] of Object.entries(record)) {
    const child = json(entry)
    if (child === null && entry !== null) return null
    converted[key] = child
  }
  return converted
}

function list(snapshot: MulticaWorkspaceSnapshot, key: keyof MulticaWorkspaceSnapshot): Record<string, unknown>[] {
  return Array.isArray(snapshot[key]) ? snapshot[key].flatMap((entry) => object(entry) ? [entry] : []) : []
}

function parseEntity(kind: string, input: Record<string, unknown>, diagnostics: string[], source?: MulticaSourceEvidence): MulticaEntityInput | null {
  // A native object must carry its own id. Relationship ids must never impersonate it.
  const id = string(input.id)
  const raw = json(input)
  if (!id || !raw || Array.isArray(raw)) {
    diagnostics.push(`Ignored ${kind}: it lacks its own JSON object id.`)
    return null
  }
  return {
    id,
    kind,
    status: string(input.status) || string(input.state),
    outcome: string(input.outcome) || string(input.verdict),
    sessionIds: strings(input.sessionIds || input.sessions),
    parentId: string(input.parentId) || (kind === 'project' ? string(input.workspaceId) : kind === 'issue' ? string(input.projectId) : kind === 'task' ? string(input.issueId) : undefined),
    parentKind: kind === 'project' && string(input.workspaceId) ? 'workspace' : kind === 'issue' && string(input.projectId) ? 'project' : kind === 'task' && string(input.issueId) ? 'issue' : undefined,
    dependencyIds: strings(input.dependencyIds || input.dependsOn),
    taskId: string(input.taskId),
    taskIds: strings(input.taskIds || input.tasks),
    attemptId: string(input.attemptId),
    attemptIds: strings(input.attemptIds || input.attempts),
    subjectId: string(input.subjectId),
    evidenceIds: strings(input.evidenceIds),
    verifierIds: strings(input.verifierIds || input.verifiers),
    producerAttemptId: string(input.producerAttemptId),
    duplicateOf: string(input.duplicateOf),
    agentId: string(input.agentId),
    nativeRoute: string(input.nativeRoute),
    raw,
    source
  }
}

function parseNativeFacts(value: unknown): MulticaUsageInput['nativeUsageFacts'] {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry) => {
    const row = object(entry)
    const factId = string(row?.factId)
    const metric = string(row?.metric)
    const unit = string(row?.unit)
    const total = row?.total
    if (!row || !factId || !unit || typeof total !== 'number' || !Number.isFinite(total) ||
      !['input-token', 'output-token', 'cache-read-token', 'cache-write-token', 'cost', 'other'].includes(metric || '')) return []
    return [{ factId, metric: metric as MulticaUsageInput['metric'], unit, total, providerId: string(row.providerId), modelId: string(row.modelId), authoritative: row.authoritative === true }]
  })
}

function parseUsage(input: Record<string, unknown>, diagnostics: string[], source?: MulticaSourceEvidence): MulticaUsageInput | null {
  const id = string(input.id)
  const scopeKind = string(input.scopeKind)
  const scopeId = string(input.scopeId)
  const metric = string(input.metric)
  const unit = string(input.unit)
  if (!id || !scopeId || !unit || !['task', 'issue', 'attempt'].includes(scopeKind || '') ||
    !['input-token', 'output-token', 'cache-read-token', 'cache-write-token', 'cost', 'other'].includes(metric || '')) {
    diagnostics.push('Ignored usage row: id, scope, metric, or unit is unsupported.')
    return null
  }
  const nativeCoverage = string(input.nativeCoverage)
  return {
    id,
    scopeKind: scopeKind as MulticaUsageInput['scopeKind'],
    scopeId,
    metric: metric as MulticaUsageInput['metric'],
    unit,
    total: typeof input.total === 'number' && Number.isFinite(input.total) ? input.total : undefined,
    providerId: string(input.providerId),
    modelId: string(input.modelId),
    nativeCoverage: ['complete', 'partial', 'unknown'].includes(nativeCoverage || '') ? nativeCoverage as MulticaUsageInput['nativeCoverage'] : undefined,
    nativeUsageFacts: parseNativeFacts(input.nativeUsageFacts),
    source
  }
}

export function parseMulticaWorkspace(snapshot: MulticaWorkspaceSnapshot, source?: MulticaSourceEvidence): ParsedMulticaWorkspace {
  const diagnostics: string[] = []
  const entityKinds: Array<[keyof MulticaWorkspaceSnapshot, string]> = [
    ['workspaces', 'workspace'], ['projects', 'project'], ['issues', 'issue'], ['tasks', 'task'], ['attempts', 'attempt'], ['stages', 'stage'],
    ['agents', 'agent'], ['verifiers', 'verifier'], ['evidences', 'evidence'], ['artifacts', 'artifact'], ['comments', 'comment']
  ]
  const entities = entityKinds.flatMap(([key, kind]) => list(snapshot, key).flatMap((entry) => {
    const parsed = parseEntity(kind, entry, diagnostics, source)
    return parsed ? [parsed] : []
  }))
  const usages = list(snapshot, 'usages').flatMap((entry) => {
    const parsed = parseUsage(entry, diagnostics, source)
    return parsed ? [parsed] : []
  })
  return { schemaVersion: string(snapshot.schemaVersion), entities, usages, diagnostics }
}

/** Parses exact source bytes so every projected fact can cite the real byte digest. */
export function parseMulticaWorkspaceBytes(bytes: Uint8Array, locator: string, capturedAt: string): ParsedMulticaWorkspace {
  const source: MulticaSourceEvidence = {
    locator,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    capturedAt,
    byteLength: bytes.byteLength
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return { entities: [], usages: [], diagnostics: [`Ignored ${locator}: invalid JSON (${source.sha256}).`] }
  }
  const snapshot = object(value)
  if (!snapshot) return { entities: [], usages: [], diagnostics: [`Ignored ${locator}: root is not a JSON object (${source.sha256}).`] }
  return parseMulticaWorkspace(snapshot as MulticaWorkspaceSnapshot, source)
}
