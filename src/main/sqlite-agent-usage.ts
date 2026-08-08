import {
  accountingFromUsageEvents,
  resolveUsageAttribution,
  unavailableTokenAccounting,
  type NormalizedTokenComponents,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'

type SqliteRow = Record<string, unknown>

export interface SqliteAgentUsageFieldContract {
  source: 'opencode' | 'zcode'
  sourceTable: 'message' | 'model_usage'
  providerField: string
  modelField: string
  timestampField: string
  statusField?: string
  billableStatuses?: readonly string[]
  dedupField: string
  inputCacheRelation: 'disjoint' | 'cache-subset-of-input' | 'provider-defined'
  reasoningRelation: 'disjoint-from-visible-output' | 'provider-defined'
  totalAuthority: string
}

/**
 * OpenCode 1.17.18 real-fixture contract. Field names alone do not prove
 * whether cache/reasoning are already included in input/output. A row becomes
 * billable-exact only when its own tokens.total proves the mutually-exclusive
 * composition. Other rows retain raw counters but stay provider-defined.
 */
export const OPENCODE_USAGE_FIELD_CONTRACT: SqliteAgentUsageFieldContract = Object.freeze({
  source: 'opencode',
  sourceTable: 'message',
  providerField: 'message.data.providerID',
  modelField: 'message.data.modelID',
  timestampField: 'message.data.time.created',
  dedupField: 'message.id',
  inputCacheRelation: 'provider-defined',
  reasoningRelation: 'provider-defined',
  totalAuthority: 'tokens.total is authoritative only after row-level composition equality'
})

/**
 * ZCode deliberately shares only the readonly SQLite snapshot transport with
 * OpenCode. Its schema and usage semantics are independent. A completed row is
 * accepted only when computed_total_tokens and its cache subset reconcile on
 * that row. The real fixture contains zero reasoning, so non-zero reasoning
 * remains provider-defined rather than inheriting or guessing a relation.
 */
export const ZCODE_USAGE_FIELD_CONTRACT: SqliteAgentUsageFieldContract = Object.freeze({
  source: 'zcode',
  sourceTable: 'model_usage',
  providerField: 'model_usage.provider_id',
  modelField: 'model_usage.model_id',
  timestampField: 'model_usage.started_at',
  statusField: 'model_usage.status',
  billableStatuses: Object.freeze(['completed']),
  dedupField: 'model_usage.id; billing identity uses logical_request_id + attempt_index only when both exist',
  inputCacheRelation: 'cache-subset-of-input',
  reasoningRelation: 'provider-defined',
  totalAuthority: 'computed_total_tokens; non-zero reasoning composition remains provider-defined'
})

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function string(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim()
}

function number(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value)
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.max(0, parsed)
  }
  return 0
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const parsed = optionalNumber(value)
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000
    return new Date(milliseconds).toISOString()
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return timestamp(numeric)
    const milliseconds = Date.parse(value)
    if (Number.isFinite(milliseconds)) return new Date(milliseconds).toISOString()
  }
  return undefined
}

function total(components: NormalizedTokenComponents): number {
  return components.nonCachedInputTokens + components.cacheReadTokens +
    components.cacheWriteTokens + components.cacheWrite5mTokens +
    components.cacheWrite1hTokens + components.outputTokens
}

function openCodeMessageEvent(row: SqliteRow): UsageEvent | null {
  const data = object(row.data)
  if (string(data.role, row.role) !== 'assistant') return null
  const id = string(row.id, data.id)
  if (!id) return null
  const tokens = object(data.tokens)
  const cache = object(tokens.cache)
  const rawComponents = [
    tokens.input ?? tokens.inputTokens ?? tokens.input_tokens,
    tokens.cacheRead ?? tokens.cache_read_input_tokens ?? cache.read,
    tokens.cacheWrite ?? tokens.cache_creation_input_tokens ?? cache.write ?? cache.creation,
    tokens.output ?? tokens.outputTokens ?? tokens.output_tokens,
    tokens.reasoning ?? tokens.reasoningTokens ?? tokens.reasoning_tokens
  ]
  const parsedComponents = rawComponents.map(optionalNumber)
  const [parsedInput, parsedCacheRead, parsedCacheWrite, parsedVisibleOutput, parsedReasoning] = parsedComponents
  const input = parsedInput ?? 0
  const cacheRead = parsedCacheRead ?? 0
  const cacheWrite = parsedCacheWrite ?? 0
  const visibleOutput = parsedVisibleOutput ?? 0
  const reasoning = parsedReasoning ?? 0
  const providerTotal = optionalNumber(tokens.total ?? tokens.totalTokens ?? tokens.total_tokens)
  const provenDisjointTotal = input + cacheRead + cacheWrite + visibleOutput + reasoning
  const componentsExplicit = parsedComponents.every((value) => value !== undefined)
  const relationsProven = componentsExplicit && providerTotal === provenDisjointTotal
  const components: NormalizedTokenComponents = {
    nonCachedInputTokens: input,
    cacheReadTokens: relationsProven ? cacheRead : 0,
    cacheWriteTokens: relationsProven ? cacheWrite : 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: relationsProven ? visibleOutput + reasoning : visibleOutput,
    visibleOutputTokens: visibleOutput,
    reasoningTokens: reasoning
  }
  if (total(components) === 0) return null

  const modelObject = object(data.model)
  const modelRaw = string(data.modelID, data.modelId, data.model_id, modelObject.modelID, modelObject.modelId, data.model)
  const providerRaw = string(
    data.providerID, data.providerId, data.provider_id,
    modelObject.providerID, modelObject.providerId, modelObject.provider_id
  )
  const time = object(data.time)
  const reportedCostUsd = optionalNumber(data.cost)
  return {
    provider: 'opencode',
    providerFormatVersion: 'opencode-message-usage-v2',
    dedupKey: `opencode:message:${id}`,
    billingFactKey: `opencode:message:${id}`,
    sourceRowId: id,
    timestamp: timestamp(time.created ?? row.time_created ?? row.timeCreated),
    model: modelRaw,
    ...resolveUsageAttribution(modelRaw, modelRaw ? 'response' : 'unknown', providerRaw, {
      explicitProviderAuthoritative: true,
      inferProvider: false
    }),
    scope: 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    rawInputTokens: input,
    rawOutputTokens: visibleOutput,
    rawCacheReadTokens: cacheRead,
    rawCacheWriteTokens: cacheWrite,
    rawReasoningTokens: reasoning,
    components,
    semantics: 'provider-specific',
    fieldRelations: relationsProven
      ? {
          cacheRead: 'disjoint',
          cacheWrite: 'disjoint',
          reasoning: 'disjoint-from-visible-output'
        }
      : {
          cacheRead: 'provider-defined',
          cacheWrite: 'provider-defined',
          reasoning: 'provider-defined'
        },
    totalRelation: relationsProven ? 'components-sum' : 'provider-defined',
    // OpenCode's `cost` label is not enough to prove provider-billed versus a
    // harness estimate. Keep it out of financial ledgers until provenance is
    // evidenced; the source token fields remain independently auditable.
    warnings: [
      ...(!relationsProven
        ? [!componentsExplicit
            ? 'opencode-token-relations-provider-defined:component-missing-or-invalid'
            : providerTotal === undefined
              ? 'opencode-token-relations-provider-defined:total-missing'
              : 'opencode-token-relations-provider-defined:total-mismatch']
        : []),
      ...(reportedCostUsd !== undefined ? ['opencode-reported-cost-kind-provider-defined'] : [])
    ]
  }
}

export function accountOpenCodeMessageUsage(messageRows: SqliteRow[]): TokenAccounting {
  const events = uniqueSourceRows(
    messageRows.map(openCodeMessageEvent).filter((event): event is UsageEvent => event !== null)
  )
  const warnings = [...new Set(events.flatMap((event) => event.warnings))]
  return events.length > 0
    ? accountingFromUsageEvents('opencode', events, warnings)
    : unavailableTokenAccounting('opencode', 'No authoritative per-message OpenCode usage was found', warnings)
}

interface ParsedUsageRow {
  event: UsageEvent | null
  warnings: string[]
}

function zcodeModelUsageEvent(row: SqliteRow): ParsedUsageRow {
  if (row.status !== 'completed') return { event: null, warnings: [] }
  const id = string(row.id)
  if (!id) return { event: null, warnings: ['zcode-completed-row-rejected:source-row-id-missing'] }
  const requiredCounters = [
    row.input_tokens,
    row.output_tokens,
    row.reasoning_tokens,
    row.cache_read_input_tokens,
    row.cache_creation_input_tokens
  ].map(optionalNumber)
  if (requiredCounters.some((value) => value === undefined)) {
    return { event: null, warnings: ['zcode-completed-row-rejected:required-counter-missing-or-invalid'] }
  }
  const [inputTotal, rawOutput, reasoning, rawCacheRead, rawCacheWrite] = requiredCounters as number[]
  const cacheRead = Math.min(inputTotal, rawCacheRead)
  const cacheWrite = Math.min(Math.max(0, inputTotal - cacheRead), rawCacheWrite)
  const computedTotal = optionalNumber(row.computed_total_tokens)
  const providerTotal = optionalNumber(row.provider_total_tokens)
  if (computedTotal === undefined) {
    return { event: null, warnings: ['zcode-completed-row-rejected:computed-total-missing'] }
  }
  if (row.provider_total_tokens !== null && row.provider_total_tokens !== undefined &&
      row.provider_total_tokens !== '' && providerTotal === undefined) {
    return { event: null, warnings: ['zcode-completed-row-rejected:provider-total-invalid'] }
  }
  if (providerTotal !== undefined && providerTotal !== computedTotal) {
    return { event: null, warnings: ['zcode-completed-row-rejected:provider-total-mismatch'] }
  }
  if (rawCacheRead + rawCacheWrite > inputTotal) {
    return { event: null, warnings: ['zcode-completed-row-rejected:cache-input-exceeds-input'] }
  }
  const matchesVisibleComposition = computedTotal === inputTotal + rawOutput
  const matchesDisjointComposition = computedTotal === inputTotal + rawOutput + reasoning
  if (!matchesVisibleComposition && !matchesDisjointComposition) {
    return { event: null, warnings: ['zcode-completed-row-rejected:total-composition-provider-defined'] }
  }
  // computed_total_tokens proves the aggregate input/output total, but the
  // zero-reasoning fixture cannot prove whether a non-zero reasoning counter
  // is already inside raw output. Preserve both raw counters and price neither
  // interpretation until a real non-zero sample proves the relation.
  const reasoningProviderDefined = reasoning > 0
  const billedOutput = computedTotal - inputTotal
  const components: NormalizedTokenComponents = {
    nonCachedInputTokens: Math.max(0, inputTotal - cacheRead - cacheWrite),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: billedOutput,
    visibleOutputTokens: rawOutput,
    reasoningTokens: reasoning
  }
  if (total(components) === 0) {
    return { event: null, warnings: ['zcode-completed-row-rejected:zero-total'] }
  }

  const modelRaw = string(row.model_id)
  const providerRaw = string(row.provider_id)
  const logicalRequestId = string(row.logical_request_id)
  const attemptIndex = optionalNonNegativeInteger(row.attempt_index)
  const completeBillingIdentity = logicalRequestId !== undefined && attemptIndex !== undefined
  const billingFactKey = completeBillingIdentity
    ? `zcode:request:${logicalRequestId}:attempt:${attemptIndex}`
    : `zcode:model-usage:${id}`
  const warnings = [
    ...(!logicalRequestId ? ['zcode-billing-identity-fallback:logical-request-id-missing'] : []),
    ...(attemptIndex === undefined ? ['zcode-billing-identity-fallback:attempt-index-missing-or-invalid'] : []),
    ...(reasoningProviderDefined ? ['zcode-token-relations-provider-defined:nonzero-reasoning'] : [])
  ]
  return { event: {
    provider: 'zcode',
    providerFormatVersion: 'zcode-model-usage-v1',
    dedupKey: `zcode:model-usage:${id}`,
    billingFactKey,
    sourceRowId: id,
    timestamp: timestamp(row.started_at),
    model: modelRaw,
    ...resolveUsageAttribution(modelRaw, modelRaw ? 'response' : 'unknown', providerRaw, {
      explicitProviderAuthoritative: true,
      inferProvider: false
    }),
    scope: 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    rawInputTokens: inputTotal,
    rawOutputTokens: rawOutput,
    rawCacheReadTokens: rawCacheRead,
    rawCacheWriteTokens: rawCacheWrite,
    rawReasoningTokens: reasoning,
    components,
    semantics: 'provider-specific',
    fieldRelations: {
      cacheRead: 'subset-of-input',
      cacheWrite: 'subset-of-input',
      reasoning: 'provider-defined'
    },
    totalRelation: reasoningProviderDefined ? 'provider-defined' : 'components-sum',
    warnings
  }, warnings }
}

function uniqueSourceRows(events: UsageEvent[]): UsageEvent[] {
  const unique = new Map<string, UsageEvent>()
  for (const event of events) {
    if (!unique.has(event.dedupKey)) unique.set(event.dedupKey, event)
  }
  return [...unique.values()]
}

function zcodeExcludedStatusWarnings(rows: SqliteRow[]): string[] {
  const counts = new Map<'failed' | 'pending' | 'cancelled' | 'unknown' | 'missing', number>()
  for (const row of rows) {
    const status = row.status
    if (status === 'completed') continue
    const category = status === 'failed' || status === 'pending' || status === 'cancelled'
      ? status
      : status === null || status === undefined
        ? 'missing'
        : 'unknown'
    counts.set(category, (counts.get(category) || 0) + 1)
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `zcode-model-usage-status-excluded:${status}:${count}`)
}

export function accountZCodeModelUsage(rows: SqliteRow[]): TokenAccounting {
  const parsed = rows
    .filter((row) => row.status === 'completed')
    .map(zcodeModelUsageEvent)
  const events = uniqueSourceRows(parsed.flatMap((result) => result.event ? [result.event] : []))
  const warnings = [...new Set([
    ...zcodeExcludedStatusWarnings(rows),
    ...parsed.flatMap((result) => result.warnings)
  ])]
  return events.length > 0
    ? accountingFromUsageEvents('zcode', events, warnings)
    : unavailableTokenAccounting(
      'zcode',
      'No completed authoritative per-call ZCode model_usage rows were found',
      warnings
    )
}

export function isPerCallSqliteAgentAccounting(accounting: TokenAccounting): boolean {
  return accounting.usageEvents.length > 0 && accounting.usageEvents.every((event) =>
    event.providerFormatVersion === 'opencode-message-usage-v2' ||
    event.providerFormatVersion === 'zcode-model-usage-v1'
  )
}
