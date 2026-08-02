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
  inputCacheRelation: 'disjoint' | 'cache-subset-of-input'
  reasoningRelation: 'disjoint-from-visible-output' | 'provider-defined'
  totalAuthority: string
}

/**
 * OpenCode current-schema contract, pinned to upstream message-v2/getUsage:
 * input has already had cache read/write removed; output is visible output and
 * reasoning is a separate billable output bucket.
 */
export const OPENCODE_USAGE_FIELD_CONTRACT: SqliteAgentUsageFieldContract = Object.freeze({
  source: 'opencode',
  sourceTable: 'message',
  providerField: 'message.data.providerID',
  modelField: 'message.data.modelID',
  timestampField: 'message.data.time.created',
  dedupField: 'message.id',
  inputCacheRelation: 'disjoint',
  reasoningRelation: 'disjoint-from-visible-output',
  totalAuthority: 'input + cache.read + cache.write + output + reasoning'
})

/**
 * ZCode is deliberately independent from OpenCode. Its model_usage input is
 * inclusive of cache buckets and computed_total_tokens is the authoritative
 * request total. The persisted schema does not yet prove how a non-zero
 * reasoning bucket relates to raw output, so that relation remains explicit.
 */
export const ZCODE_USAGE_FIELD_CONTRACT: SqliteAgentUsageFieldContract = Object.freeze({
  source: 'zcode',
  sourceTable: 'model_usage',
  providerField: 'model_usage.provider_id',
  modelField: 'model_usage.model_id',
  timestampField: 'model_usage.started_at',
  statusField: 'model_usage.status',
  billableStatuses: Object.freeze(['completed']),
  dedupField: 'model_usage.logical_request_id + attempt_index (fallback id)',
  inputCacheRelation: 'cache-subset-of-input',
  reasoningRelation: 'provider-defined',
  totalAuthority: 'computed_total_tokens'
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
  const input = number(tokens.input ?? tokens.inputTokens ?? tokens.input_tokens)
  const cacheRead = number(tokens.cacheRead ?? tokens.cache_read_input_tokens ?? cache.read)
  const cacheWrite = number(tokens.cacheWrite ?? tokens.cache_creation_input_tokens ?? cache.write ?? cache.creation)
  const visibleOutput = number(tokens.output ?? tokens.outputTokens ?? tokens.output_tokens)
  const reasoning = number(tokens.reasoning ?? tokens.reasoningTokens ?? tokens.reasoning_tokens)
  const components: NormalizedTokenComponents = {
    nonCachedInputTokens: input,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: visibleOutput + reasoning,
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
    fieldRelations: {
      cacheRead: 'disjoint',
      cacheWrite: 'disjoint',
      reasoning: 'disjoint-from-visible-output'
    },
    reportedCostUsd,
    ...(reportedCostUsd !== undefined ? { reportedCostKind: 'harness-list-estimate' as const } : {}),
    warnings: []
  }
}

export function accountOpenCodeMessageUsage(messageRows: SqliteRow[]): TokenAccounting {
  const events = messageRows.map(openCodeMessageEvent).filter((event): event is UsageEvent => event !== null)
  return events.length > 0
    ? accountingFromUsageEvents('opencode', events)
    : unavailableTokenAccounting('opencode', 'No authoritative per-message OpenCode usage was found')
}

function zcodeModelUsageEvent(row: SqliteRow): UsageEvent | null {
  if (row.status !== 'completed') return null
  const id = string(row.id)
  if (!id) return null
  const inputTotal = number(row.input_tokens)
  const rawCacheRead = number(row.cache_read_input_tokens)
  const rawCacheWrite = number(row.cache_creation_input_tokens)
  const cacheRead = Math.min(inputTotal, rawCacheRead)
  const cacheWrite = Math.min(Math.max(0, inputTotal - cacheRead), rawCacheWrite)
  const rawOutput = number(row.output_tokens)
  const reasoning = number(row.reasoning_tokens)
  const computedTotal = optionalNumber(row.computed_total_tokens)
  const billedOutput = computedTotal === undefined
    ? rawOutput
    : Math.max(0, computedTotal - inputTotal)
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
  if (total(components) === 0) return null

  const modelRaw = string(row.model_id)
  const providerRaw = string(row.provider_id)
  const logicalRequestId = string(row.logical_request_id)
  const attemptIndex = Math.trunc(number(row.attempt_index))
  const billingFactKey = logicalRequestId
    ? `zcode:request:${logicalRequestId}:attempt:${attemptIndex}`
    : `zcode:model-usage:${id}`
  const warnings = [
    ...(rawCacheRead + rawCacheWrite > inputTotal ? ['cache-input-exceeds-input'] : []),
    ...(computedTotal !== undefined && computedTotal < inputTotal ? ['computed-total-less-than-input'] : []),
    ...(reasoning > 0 && computedTotal === undefined ? ['reasoning-relation-unverified-without-computed-total'] : [])
  ]
  return {
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
    warnings
  }
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
  const events = rows.map(zcodeModelUsageEvent).filter((event): event is UsageEvent => event !== null)
  const warnings = zcodeExcludedStatusWarnings(rows)
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
