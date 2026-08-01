import { createHash } from 'node:crypto'
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'
import schemaDocument from '../../schema/provider-protocol-v2.schema.json'
import {
  PROVIDER_PROTOCOL_SCHEMA_ID,
  PROVIDER_PROTOCOL_VERSION,
  PROVIDER_RESOURCE_LIMITS,
  type CanonicalEvent,
  type ParseChunk,
  type ProviderConformanceSample,
  type ProviderEnvelope,
  type ProviderManifest,
  type ResumeContract,
  type UsageRecord
} from './provider-schema-v2.generated'

export interface ProviderSchemaIssueV2 {
  path: string
  keyword: string
  message: string
}

export interface ProviderSchemaValidationV2<T> {
  ok: boolean
  value?: T
  issues: ProviderSchemaIssueV2[]
}

export interface ProviderConformanceReportV2 {
  ok: boolean
  providerId: string | null
  issues: ProviderSchemaIssueV2[]
  checkedEnvelopes: number
  completedSessions: number
}

export class ProviderProtocolV2ValidationError extends Error {
  readonly issues: ProviderSchemaIssueV2[]

  constructor(issues: ProviderSchemaIssueV2[]) {
    super(`ProviderProtocol v2 validation failed: ${issues.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`)
    this.name = 'ProviderProtocolV2ValidationError'
    this.issues = issues
  }
}

const ajv = new Ajv2020({ strict: true, allErrors: true })
ajv.addSchema(schemaDocument)

function schemaValidator<T>(definition: string): ValidateFunction<T> {
  const validator = ajv.getSchema<T>(`${PROVIDER_PROTOCOL_SCHEMA_ID}#/$defs/${definition}`)
  if (!validator) throw new Error(`Provider v2 schema definition is missing: ${definition}`)
  return validator
}

const validateEnvelopeSchema = schemaValidator<ProviderEnvelope>('ProviderEnvelope')
const validateManifestSchema = schemaValidator<ProviderManifest>('ProviderManifest')
const validateChunkSchema = schemaValidator<ParseChunk>('ParseChunk')
const validateUsageSchema = schemaValidator<UsageRecord>('UsageRecord')
const validateResumeContractSchema = schemaValidator<ResumeContract>('ResumeContract')

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]))
  }
  return value
}

export function providerFingerprintV2(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

function issue(path: string, keyword: string, message: string): ProviderSchemaIssueV2 {
  return { path, keyword, message }
}

function ajvIssues(errors: ErrorObject[] | null | undefined): ProviderSchemaIssueV2[] {
  return (errors || []).map((entry) => ({
    path: `$${entry.instancePath}`,
    keyword: entry.keyword,
    message: entry.message || 'schema validation failed'
  }))
}

function resourceIssue(path: string, name: keyof typeof PROVIDER_RESOURCE_LIMITS, actual: number): ProviderSchemaIssueV2 {
  return issue(path, 'resource-limit', `${name} exceeded: ${actual} > ${PROVIDER_RESOURCE_LIMITS[name]}`)
}

function valueBudget(value: unknown): ProviderSchemaIssueV2[] {
  type Entry = { value: unknown; path: string; depth: number; leave?: boolean }
  const stack: Entry[] = [{ value, path: '$', depth: 1 }]
  const ancestors = new WeakSet<object>()
  let nodes = 0
  while (stack.length > 0) {
    const entry = stack.pop()!
    if (entry.leave) {
      ancestors.delete(entry.value as object)
      continue
    }
    nodes++
    if (nodes > PROVIDER_RESOURCE_LIMITS.maxNodes) {
      return [resourceIssue(entry.path, 'maxNodes', nodes)]
    }
    if (entry.depth > PROVIDER_RESOURCE_LIMITS.maxJsonDepth) {
      return [resourceIssue(entry.path, 'maxJsonDepth', entry.depth)]
    }
    if (typeof entry.value === 'string') {
      if (entry.value.length > PROVIDER_RESOURCE_LIMITS.maxStringCodeUnits) {
        return [resourceIssue(entry.path, 'maxStringCodeUnits', entry.value.length)]
      }
      continue
    }
    if (!entry.value || typeof entry.value !== 'object') continue
    if (ancestors.has(entry.value)) return [issue(entry.path, 'json-cycle', 'JSON values must not contain object cycles')]
    ancestors.add(entry.value)
    stack.push({ ...entry, leave: true })
    if (Array.isArray(entry.value)) {
      if (entry.value.length > PROVIDER_RESOURCE_LIMITS.maxArrayItems) {
        return [resourceIssue(entry.path, 'maxArrayItems', entry.value.length)]
      }
      for (let index = entry.value.length - 1; index >= 0; index--) {
        stack.push({ value: entry.value[index], path: `${entry.path}/${index}`, depth: entry.depth + 1 })
      }
      continue
    }
    const entries = Object.entries(entry.value as Record<string, unknown>)
    if (entries.length > PROVIDER_RESOURCE_LIMITS.maxObjectProperties) {
      return [resourceIssue(entry.path, 'maxObjectProperties', entries.length)]
    }
    for (let index = entries.length - 1; index >= 0; index--) {
      const [key, child] = entries[index]
      stack.push({ value: child, path: `${entry.path}/${key}`, depth: entry.depth + 1 })
    }
  }
  return []
}

function validateWithSchema<T>(value: unknown, validator: ValidateFunction<T>): ProviderSchemaValidationV2<T> {
  const budgetIssues = valueBudget(value)
  if (budgetIssues.length > 0) return { ok: false, issues: budgetIssues }
  if (!validator(value)) return { ok: false, issues: ajvIssues(validator.errors) }
  return { ok: true, value, issues: [] }
}

export function validateProviderEnvelopeV2(value: unknown): ProviderSchemaValidationV2<ProviderEnvelope> {
  return validateWithSchema(value, validateEnvelopeSchema)
}

export function validateProviderManifestV2(value: unknown): ProviderSchemaValidationV2<ProviderManifest> {
  return validateWithSchema(value, validateManifestSchema)
}

export function validateResumeContractV2(value: unknown): ProviderSchemaValidationV2<ResumeContract> {
  return validateWithSchema(value, validateResumeContractSchema)
}

export function validateParseChunkV2(value: unknown): ProviderSchemaValidationV2<ParseChunk> {
  const schema = validateWithSchema(value, validateChunkSchema)
  if (!schema.ok) return schema
  const issues: ProviderSchemaIssueV2[] = []
  const eventIds = new Set<string>()
  for (let index = 0; index < schema.value!.events.length; index++) {
    const event = schema.value!.events[index]
    if (!sameIdentity(schema.value!.identity, event.identity) ||
      event.provenance.providerId !== schema.value!.providerId ||
      event.provenance.sourceRefId !== schema.value!.identity.physicalSourceId) {
      issues.push(issue(`$/events/${index}`, 'event-identity', 'event identity/provenance must match its chunk'))
    }
    if (eventIds.has(event.id)) issues.push(issue(`$/events/${index}/id`, 'event-id', 'event id must be unique within a chunk'))
    eventIds.add(event.id)
    if (index > 0 && event.sequence !== schema.value!.events[index - 1].sequence + 1) {
      issues.push(issue(`$/events/${index}/sequence`, 'event-sequence', 'event sequence must be contiguous within a chunk'))
    }
    try { assertEventTimeline(event) } catch (error) {
      issues.push(issue(
        `$/events/${index}/timeline/modelContext`,
        'context-timeline',
        error instanceof Error ? error.message : String(error)
      ))
    }
    if (event.kind !== 'usage') continue
    const usage = event.payload as unknown as UsageRecord
    if (usage.relations.cacheRead === 'subset-of-input' && usage.input.total !== null &&
      usage.input.cacheRead !== null && usage.input.cacheRead > usage.input.total) {
      issues.push(issue(`$/events/${index}/payload/input/cacheRead`, 'usage-subset', 'cacheRead cannot exceed input.total'))
    }
    const cacheWrite = (usage.input.cacheWrite5m ?? 0) + (usage.input.cacheWrite1h ?? 0)
    if (usage.relations.cacheWrite === 'subset-of-input' && usage.input.total !== null && cacheWrite > usage.input.total) {
      issues.push(issue(`$/events/${index}/payload/input`, 'usage-subset', 'cache writes cannot exceed input.total'))
    }
    if (usage.relations.reasoning === 'subset-of-output' && usage.output.total !== null &&
      usage.output.reasoning !== null && usage.output.reasoning > usage.output.total) {
      issues.push(issue(`$/events/${index}/payload/output/reasoning`, 'usage-subset', 'reasoning cannot exceed output.total'))
    }
    const counters = [
      usage.input.total, usage.input.uncached, usage.input.cacheRead,
      usage.input.cacheWrite5m, usage.input.cacheWrite1h,
      usage.output.total, usage.output.visible, usage.output.reasoning, usage.providerTotal
    ]
    if (usage.measurement.source === 'unavailable' &&
      (counters.some((counter) => counter !== null) || usage.cost !== null || usage.measurement.confidence !== 'unavailable')) {
      issues.push(issue(`$/events/${index}/payload/measurement`, 'usage-unavailable', 'unavailable usage cannot contain counters or cost'))
    }
    if (usage.cost?.kind === 'derived' && !usage.priceRevision) {
      issues.push(issue(`$/events/${index}/payload/priceRevision`, 'price-revision', 'derived cost requires priceRevision'))
    }
  }
  return issues.length > 0 ? { ok: false, issues } : schema
}

export function decodeProviderEnvelopeV2(input: string | Uint8Array): ProviderSchemaValidationV2<ProviderEnvelope> {
  const bytes = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength
  if (bytes > PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes) {
    return { ok: false, issues: [resourceIssue('$', 'maxEnvelopeBytes', bytes)] }
  }
  let text: string
  try {
    text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: true }).decode(input)
  } catch {
    return { ok: false, issues: [issue('$', 'utf8', 'provider envelope must be valid UTF-8')] }
  }
  try {
    return validateProviderEnvelopeV2(JSON.parse(text))
  } catch {
    return { ok: false, issues: [issue('$', 'json-parse', 'provider envelope must be valid JSON')] }
  }
}

export function assertProviderEnvelopeV2(value: unknown): ProviderEnvelope {
  const result = validateProviderEnvelopeV2(value)
  if (!result.ok) throw new ProviderProtocolV2ValidationError(result.issues)
  return result.value!
}

export function helloForProviderV2(manifest: ProviderManifest) {
  return {
    protocolVersion: PROVIDER_PROTOCOL_VERSION,
    schemaId: PROVIDER_PROTOCOL_SCHEMA_ID,
    providerId: manifest.providerId,
    implementationVersion: manifest.implementationVersion,
    manifestFingerprint: providerFingerprintV2(manifest)
  } as const
}

interface ChunkStreamState {
  identity: ParseChunk['identity']
  providerId: string
  nextChunkIndex: number
  previousCursor: string | null
  nextSequence: number
  eventIds: Set<string>
  complete: boolean
}

function streamKey(chunk: ParseChunk): string {
  return `${chunk.identity.logicalSessionKey}\0${chunk.identity.branchViewId}`
}

function sameIdentity(left: ParseChunk['identity'], right: ParseChunk['identity']): boolean {
  return left.physicalSourceId === right.physicalSourceId &&
    left.logicalSessionKey === right.logicalSessionKey &&
    left.logicalSessionId === right.logicalSessionId &&
    left.branchViewId === right.branchViewId &&
    left.parentBranchViewId === right.parentBranchViewId
}

function assertEventTimeline(event: CanonicalEvent): void {
  let previousUntil = -1
  for (const interval of event.timeline.modelContext) {
    if (interval.untilSequence !== null && interval.untilSequence <= interval.fromSequence) {
      throw new Error('canonical-event-context-interval-invalid')
    }
    if (interval.fromSequence < previousUntil) throw new Error('canonical-event-context-interval-overlap')
    previousUntil = interval.untilSequence ?? Number.MAX_SAFE_INTEGER
  }
}

export class ProviderChunkAssembler {
  private readonly streams = new Map<string, ChunkStreamState>()
  private completed = 0

  accept(chunk: ParseChunk): { acceptedEvents: number; done: boolean } {
    const schema = validateParseChunkV2(chunk)
    if (!schema.ok) throw new ProviderProtocolV2ValidationError(schema.issues)
    const key = streamKey(chunk)
    let state = this.streams.get(key)
    if (!state) {
      if (chunk.chunkIndex !== 0 || chunk.previousCursor !== null) {
        throw new Error('parse-chunk-stream-must-start-at-zero')
      }
      state = {
        identity: structuredClone(chunk.identity),
        providerId: chunk.providerId,
        nextChunkIndex: 0,
        previousCursor: null,
        nextSequence: chunk.mode === 'append' ? (chunk.events[0]?.sequence ?? 0) : 0,
        eventIds: new Set(),
        complete: false
      }
      this.streams.set(key, state)
    }
    if (state.complete) throw new Error('parse-chunk-stream-already-complete')
    if (!sameIdentity(state.identity, chunk.identity) || state.providerId !== chunk.providerId) {
      throw new Error('parse-chunk-identity-mismatch')
    }
    if (chunk.chunkIndex !== state.nextChunkIndex) throw new Error('parse-chunk-index-mismatch')
    if (chunk.previousCursor !== state.previousCursor) throw new Error('parse-chunk-cursor-mismatch')
    if (chunk.done === (chunk.cursor !== null)) throw new Error('parse-chunk-done-cursor-invalid')

    for (const event of chunk.events) {
      if (!sameIdentity(chunk.identity, event.identity) || event.provenance.providerId !== chunk.providerId ||
        event.provenance.sourceRefId !== chunk.identity.physicalSourceId) {
        throw new Error('canonical-event-identity-mismatch')
      }
      if (event.sequence !== state.nextSequence) throw new Error('canonical-event-sequence-gap')
      if (state.eventIds.has(event.id)) throw new Error('canonical-event-id-duplicate')
      assertEventTimeline(event)
      state.eventIds.add(event.id)
      state.nextSequence++
    }
    state.nextChunkIndex++
    state.previousCursor = chunk.cursor
    state.complete = chunk.done
    if (chunk.done) this.completed++
    return { acceptedEvents: chunk.events.length, done: chunk.done }
  }

  completedSessions(): number {
    return this.completed
  }

  incompleteSessions(): number {
    return [...this.streams.values()].filter((state) => !state.complete).length
  }
}

function prefixIssues(prefix: string, issues: ProviderSchemaIssueV2[]): ProviderSchemaIssueV2[] {
  return issues.map((entry) => ({ ...entry, path: `${prefix}${entry.path.slice(1)}` }))
}

export function runProviderConformanceV2(input: ProviderConformanceSample | {
  manifest: unknown
  envelopes: unknown[]
}): ProviderConformanceReportV2 {
  const issues: ProviderSchemaIssueV2[] = []
  const manifestResult = validateProviderManifestV2(input.manifest)
  if (!manifestResult.ok) issues.push(...prefixIssues('manifest', manifestResult.issues))
  const manifest = manifestResult.value
  const assembler = new ProviderChunkAssembler()
  let helloCount = 0
  let manifestCount = 0

  for (let index = 0; index < input.envelopes.length; index++) {
    const result = validateProviderEnvelopeV2(input.envelopes[index])
    if (!result.ok) {
      issues.push(...prefixIssues(`envelopes/${index}`, result.issues))
      continue
    }
    const envelope = result.value!
    if (envelope.kind === 'hello') {
      helloCount++
      if (manifest && envelope.payload.providerId !== manifest.providerId) {
        issues.push(issue(`envelopes/${index}/payload/providerId`, 'provider-identity', 'hello and manifest providerId differ'))
      }
      if (manifest && envelope.payload.manifestFingerprint !== providerFingerprintV2(manifest)) {
        issues.push(issue(`envelopes/${index}/payload/manifestFingerprint`, 'manifest-fingerprint', 'hello fingerprint does not match manifest'))
      }
    } else if (envelope.kind === 'manifest') {
      manifestCount++
      if (manifest && providerFingerprintV2(envelope.payload) !== providerFingerprintV2(manifest)) {
        issues.push(issue(`envelopes/${index}/payload`, 'manifest-mismatch', 'manifest envelope does not match conformance manifest'))
      }
    } else if (envelope.kind === 'parse-chunk') {
      try { assembler.accept(envelope.payload) } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        issues.push(issue(`envelopes/${index}/payload`, 'stream-invariant', message))
      }
    }
  }
  if (helloCount !== 1) issues.push(issue('envelopes', 'hello-count', 'conformance sample requires exactly one hello envelope'))
  if (manifestCount !== 1) issues.push(issue('envelopes', 'manifest-count', 'conformance sample requires exactly one manifest envelope'))
  if (assembler.incompleteSessions() > 0) issues.push(issue('envelopes', 'incomplete-stream', 'all parse chunk streams must finish'))
  if (assembler.completedSessions() === 0) issues.push(issue('envelopes', 'missing-stream', 'conformance sample requires a completed parse stream'))
  return {
    ok: issues.length === 0,
    providerId: manifest?.providerId || null,
    issues,
    checkedEnvelopes: input.envelopes.length,
    completedSessions: assembler.completedSessions()
  }
}

function numericDelta(current: number | null, previous: number | null): number | null {
  if (current === null) return null
  if (previous !== null && current < previous) return current
  return current - (previous ?? 0)
}

function usageRecord(value: unknown): UsageRecord {
  if (!validateUsageSchema(value)) {
    throw new ProviderProtocolV2ValidationError(ajvIssues(validateUsageSchema.errors))
  }
  return value
}

/** Convert cumulative provider snapshots into independent facts before summing. */
export function deltaUsageRecords(values: unknown[]): UsageRecord[] {
  const previousBySeries = new Map<string, UsageRecord>()
  const seenDedupKeys = new Set<string>()
  const seenBillingFacts = new Set<string>()
  const result: UsageRecord[] = []
  for (const value of values) {
    const current = structuredClone(usageRecord(value))
    if (seenDedupKeys.has(current.dedupKey) || seenBillingFacts.has(current.billingFactKey)) continue
    seenDedupKeys.add(current.dedupKey)
    seenBillingFacts.add(current.billingFactKey)
    if (current.aggregation !== 'cumulative') {
      result.push(current)
      continue
    }
    const series = `${current.modelId || ''}\0${current.turnId || ''}`
    const previous = previousBySeries.get(series)
    previousBySeries.set(series, current)
    result.push({
      ...current,
      aggregation: 'delta',
      input: {
        total: numericDelta(current.input.total, previous?.input.total ?? null),
        uncached: numericDelta(current.input.uncached, previous?.input.uncached ?? null),
        cacheRead: numericDelta(current.input.cacheRead, previous?.input.cacheRead ?? null),
        cacheWrite5m: numericDelta(current.input.cacheWrite5m, previous?.input.cacheWrite5m ?? null),
        cacheWrite1h: numericDelta(current.input.cacheWrite1h, previous?.input.cacheWrite1h ?? null)
      },
      output: {
        total: numericDelta(current.output.total, previous?.output.total ?? null),
        visible: numericDelta(current.output.visible, previous?.output.visible ?? null),
        reasoning: numericDelta(current.output.reasoning, previous?.output.reasoning ?? null)
      },
      providerTotal: numericDelta(current.providerTotal, previous?.providerTotal ?? null),
      cost: current.cost
        ? { ...current.cost, amount: Math.max(0, current.cost.amount - (previous?.cost?.amount ?? 0)) }
        : null,
      measurement: {
        source: 'derived',
        confidence: current.measurement.confidence,
        sourceField: current.measurement.sourceField
      }
    })
  }
  return result
}
