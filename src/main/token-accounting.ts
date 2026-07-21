import type { RawJsonlMessage, SessionSource, TokenUsage } from './types'

export type TokenProvenance = 'reported' | 'derived' | 'estimated' | 'unavailable'
export type UsageScope = 'main' | 'sidechain' | 'subagent' | 'inherited'

/** Components are mutually exclusive. Reasoning is metadata inside output. */
export interface NormalizedTokenComponents {
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens?: number
}

export interface UsageEvent {
  provider: SessionSource
  providerFormatVersion: string
  dedupKey: string
  sourceRowId?: string
  timestamp?: string
  model?: string
  scope: UsageScope
  counterKind: 'incremental' | 'cumulative-delta'
  provenance: Exclude<TokenProvenance, 'unavailable'>
  rawInputTokens?: number
  rawOutputTokens?: number
  rawCacheReadTokens?: number
  rawCacheWriteTokens?: number
  rawReasoningTokens?: number
  components: NormalizedTokenComponents
  warnings: string[]
}

export interface TokenAccounting {
  provider: SessionSource
  metricVersion: 1
  provenance: TokenProvenance
  /** Processed/billing total: non-cached input + cache read + cache write + output. */
  billingTotal: number | null
  /** Same arithmetic restricted to main-thread events. */
  conversationOnly: number | null
  components: NormalizedTokenComponents | null
  usageEvents: UsageEvent[]
  unavailableReason?: string
  warnings: string[]
  /** Synthetic branch views expose a value but must not be added to global rollups. */
  excludedFromRollups?: boolean
}

export interface CodexUsageSnapshot {
  timestamp?: string
  model?: string
  kind: 'incremental' | 'cumulative'
  inputTokens: number
  outputTokens: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  dedupHint?: string
}

const UNVERIFIED_TOKEN_SOURCES = new Set<SessionSource>([
  'antigravity',
  'grok',
  'pi',
  'kimi',
  'hermes'
])

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function processedTotal(components: NormalizedTokenComponents): number {
  return components.nonCachedInputTokens + components.cacheReadTokens +
    components.cacheWriteTokens + components.outputTokens
}

function addComponents(
  left: NormalizedTokenComponents,
  right: NormalizedTokenComponents
): NormalizedTokenComponents {
  return {
    nonCachedInputTokens: left.nonCachedInputTokens + right.nonCachedInputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: (left.reasoningTokens || 0) + (right.reasoningTokens || 0)
  }
}

function sumComponents(events: UsageEvent[]): NormalizedTokenComponents {
  return events.reduce<NormalizedTokenComponents>((total, event) => addComponents(total, event.components), {
    nonCachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0
  })
}

function accountingFromEvents(
  provider: SessionSource,
  events: UsageEvent[],
  provenance: TokenProvenance,
  warnings: string[] = []
): TokenAccounting {
  if (events.length === 0) {
    return unavailableTokenAccounting(provider, 'No authoritative token usage was found', warnings)
  }
  const components = sumComponents(events)
  const mainComponents = sumComponents(events.filter((event) => event.scope === 'main'))
  return {
    provider,
    metricVersion: 1,
    provenance,
    billingTotal: processedTotal(components),
    conversationOnly: processedTotal(mainComponents),
    components,
    usageEvents: events,
    warnings
  }
}

export function unavailableTokenAccounting(
  provider: SessionSource,
  reason: string,
  warnings: string[] = []
): TokenAccounting {
  return {
    provider,
    metricVersion: 1,
    provenance: 'unavailable',
    billingTotal: null,
    conversationOnly: null,
    components: null,
    usageEvents: [],
    unavailableReason: reason,
    warnings
  }
}

export function tokenUsageFromAccounting(accounting: TokenAccounting): TokenUsage {
  const components = accounting.components
  if (!components) {
    return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }
  }
  return {
    inputTokens: components.nonCachedInputTokens,
    outputTokens: components.outputTokens,
    cacheCreationTokens: components.cacheWriteTokens,
    cacheReadTokens: components.cacheReadTokens
  }
}

function claudeUsageAliases(message: RawJsonlMessage, index: number): string[] {
  const rawMessage = message.message as (RawJsonlMessage['message'] & { id?: string; request_id?: string }) | undefined
  const messageId = rawMessage?.id
  const requestId = message.requestId || rawMessage?.request_id
  const aliases: string[] = []
  if (messageId) aliases.push(`claude:message:${messageId}`)
  if (requestId) aliases.push(`claude:request:${requestId}`)
  if (aliases.length > 0) return aliases
  if (message.uuid) return [`claude:uuid:${message.uuid}`]
  return [`claude:row:${index}`]
}

function claudeSnapshotScore(message: RawJsonlMessage, components: NormalizedTokenComponents): [number, number] {
  const stopReason = (message.message as (RawJsonlMessage['message'] & { stop_reason?: unknown }) | undefined)?.stop_reason
  return [stopReason ? 1 : 0, processedTotal(components)]
}

function isBetterClaudeSnapshot(
  candidate: { score: [number, number] },
  current: { score: [number, number] }
): boolean {
  return candidate.score[0] > current.score[0] ||
    (candidate.score[0] === current.score[0] && candidate.score[1] > current.score[1])
}

function preferMainScope<T extends { event: UsageEvent }>(
  selected: T,
  left?: T,
  right?: T
): T {
  if (left?.event.scope === 'main' || right?.event.scope === 'main') {
    selected.event = { ...selected.event, scope: 'main' }
  }
  return selected
}

/**
 * Claude usage is per API call, but Claude Code may persist several cumulative
 * streaming snapshots for the same message/request. Select one snapshot per key.
 */
export function accountClaudeUsage(
  messages: RawJsonlMessage[],
  provider: 'claude-code' | 'cc-mirror' = 'claude-code',
  scopeOverride?: Exclude<UsageScope, 'inherited'>,
  scopeResolver?: (message: RawJsonlMessage) => Exclude<UsageScope, 'inherited'> | undefined
): TokenAccounting {
  const selected = new Map<string, { event: UsageEvent; score: [number, number] }>()
  const aliasToKey = new Map<string, string>()
  let duplicateRows = 0
  let inheritedRows = 0

  messages.forEach((message, index) => {
    if (message.type !== 'assistant' || !message.message?.usage) return
    if (message.forkedFrom) {
      inheritedRows++
      return
    }

    const usage = message.message.usage
    const components: NormalizedTokenComponents = {
      nonCachedInputTokens: nonNegative(usage.input_tokens),
      cacheReadTokens: nonNegative(usage.cache_read_input_tokens),
      cacheWriteTokens: nonNegative(usage.cache_creation_input_tokens),
      outputTokens: nonNegative(usage.output_tokens)
    }
    const aliases = claudeUsageAliases(message, index)
    const existingKeys = [...new Set(aliases.map((alias) => aliasToKey.get(alias)).filter((value): value is string => Boolean(value)))]
    const key = existingKeys[0] || aliases[0]
    // A later row can be the first one carrying both identifiers. Merge any
    // previously separate message-id/request-id groups before scoring it.
    for (const duplicateKey of existingKeys.slice(1)) {
      const duplicate = selected.get(duplicateKey)
      const current = selected.get(key)
      if (duplicate) {
        duplicateRows++
        const winner = !current || isBetterClaudeSnapshot(duplicate, current) ? duplicate : current
        selected.set(key, preferMainScope(winner, current, duplicate))
        selected.delete(duplicateKey)
      }
      for (const [alias, mappedKey] of aliasToKey) {
        if (mappedKey === duplicateKey) aliasToKey.set(alias, key)
      }
    }
    const event: UsageEvent = {
      provider,
      providerFormatVersion: 'claude-message-usage-v1',
      dedupKey: key,
      sourceRowId: message.uuid || undefined,
      timestamp: message.timestamp || undefined,
      model: message.message.model,
      scope: scopeOverride || scopeResolver?.(message) || (message.isSidechain ? 'sidechain' : 'main'),
      counterKind: 'incremental',
      provenance: 'reported',
      rawInputTokens: nonNegative(usage.input_tokens),
      rawOutputTokens: nonNegative(usage.output_tokens),
      rawCacheReadTokens: nonNegative(usage.cache_read_input_tokens),
      rawCacheWriteTokens: nonNegative(usage.cache_creation_input_tokens),
      components,
      warnings: []
    }
    const candidate = { event, score: claudeSnapshotScore(message, components) }
    const current = selected.get(key)
    if (!current) selected.set(key, candidate)
    else {
      duplicateRows++
      const winner = isBetterClaudeSnapshot(candidate, current) ? candidate : current
      selected.set(key, preferMainScope(winner, current, candidate))
    }
    for (const alias of aliases) aliasToKey.set(alias, key)
  })

  const warnings: string[] = []
  if (duplicateRows > 0) warnings.push(`deduplicated ${duplicateRows} streaming usage snapshot(s)`)
  if (inheritedRows > 0) warnings.push(`excluded ${inheritedRows} fork-inherited usage row(s)`)
  return accountingFromEvents(provider, [...selected.values()].map((item) => item.event), 'reported', warnings)
}

function normalizeCodexSnapshot(snapshot: CodexUsageSnapshot): NormalizedTokenComponents {
  const input = nonNegative(snapshot.inputTokens)
  const cached = Math.min(input, nonNegative(snapshot.cachedInputTokens))
  const output = nonNegative(snapshot.outputTokens)
  const reasoning = Math.min(output, nonNegative(snapshot.reasoningTokens))
  return {
    nonCachedInputTokens: Math.max(0, input - cached),
    cacheReadTokens: cached,
    cacheWriteTokens: nonNegative(snapshot.cacheWriteTokens),
    outputTokens: output,
    reasoningTokens: reasoning
  }
}

function delta(current: number, previous: number): { value: number; reset: boolean } {
  if (current >= previous) return { value: current - previous, reset: false }
  return { value: current, reset: true }
}

/** Normalize Codex per-turn usage, falling back to deltas of cumulative counters. */
export function accountCodexUsage(snapshots: CodexUsageSnapshot[]): TokenAccounting {
  const events: UsageEvent[] = []
  const seenIncremental = new Set<string>()
  let previous: CodexUsageSnapshot | null = null
  let resetCount = 0

  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index]
    let normalizedSnapshot = snapshot
    let counterKind: UsageEvent['counterKind'] = 'incremental'
    let provenance: UsageEvent['provenance'] = 'reported'

    if (snapshot.kind === 'cumulative') {
      counterKind = 'cumulative-delta'
      provenance = 'derived'
      if (previous) {
        const input = delta(nonNegative(snapshot.inputTokens), nonNegative(previous.inputTokens))
        const output = delta(nonNegative(snapshot.outputTokens), nonNegative(previous.outputTokens))
        const cached = delta(nonNegative(snapshot.cachedInputTokens), nonNegative(previous.cachedInputTokens))
        const cacheWrite = delta(nonNegative(snapshot.cacheWriteTokens), nonNegative(previous.cacheWriteTokens))
        const reasoning = delta(nonNegative(snapshot.reasoningTokens), nonNegative(previous.reasoningTokens))
        if (input.reset || output.reset || cached.reset || cacheWrite.reset || reasoning.reset) resetCount++
        normalizedSnapshot = {
          ...snapshot,
          inputTokens: input.value,
          outputTokens: output.value,
          cachedInputTokens: cached.value,
          cacheWriteTokens: cacheWrite.value,
          reasoningTokens: reasoning.value
        }
      }
      previous = snapshot
    }

    const components = normalizeCodexSnapshot(normalizedSnapshot)
    if (processedTotal(components) === 0) continue
    const rawKey = [
      snapshot.timestamp || '', snapshot.model || '', snapshot.inputTokens,
      snapshot.outputTokens, snapshot.cachedInputTokens || 0,
      snapshot.cacheWriteTokens || 0, snapshot.reasoningTokens || 0
    ].join(':')
    const dedupKey = snapshot.dedupHint || `codex:${rawKey}`
    if (snapshot.kind === 'incremental' && seenIncremental.has(dedupKey)) continue
    seenIncremental.add(dedupKey)

    events.push({
      provider: 'codex',
      providerFormatVersion: 'codex-token-count-v1',
      dedupKey,
      timestamp: snapshot.timestamp,
      model: snapshot.model,
      scope: 'main',
      counterKind,
      provenance,
      rawInputTokens: nonNegative(normalizedSnapshot.inputTokens),
      rawOutputTokens: nonNegative(normalizedSnapshot.outputTokens),
      rawCacheReadTokens: nonNegative(normalizedSnapshot.cachedInputTokens),
      rawCacheWriteTokens: nonNegative(normalizedSnapshot.cacheWriteTokens),
      rawReasoningTokens: nonNegative(normalizedSnapshot.reasoningTokens),
      components,
      warnings: []
    })
  }

  const warnings = resetCount > 0 ? [`handled ${resetCount} cumulative counter reset(s)`] : []
  const provenance: TokenProvenance = events.some((event) => event.provenance === 'derived') ? 'derived' : 'reported'
  return accountingFromEvents('codex', events, provenance, warnings)
}

export function accountingFromMutuallyExclusiveUsage(
  provider: SessionSource,
  usage: TokenUsage,
  provenance: Exclude<TokenProvenance, 'unavailable'> = 'reported',
  warning?: string
): TokenAccounting {
  const components: NormalizedTokenComponents = {
    nonCachedInputTokens: nonNegative(usage.inputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens),
    cacheWriteTokens: nonNegative(usage.cacheCreationTokens),
    outputTokens: nonNegative(usage.outputTokens)
  }
  if (processedTotal(components) === 0) {
    return unavailableTokenAccounting(provider, 'No authoritative token usage was found', warning ? [warning] : [])
  }
  const event: UsageEvent = {
    provider,
    providerFormatVersion: `${provider}-aggregate-v1`,
    dedupKey: `${provider}:aggregate`,
    scope: 'main',
    counterKind: 'incremental',
    provenance,
    components,
    warnings: warning ? [warning] : []
  }
  return accountingFromEvents(provider, [event], provenance, warning ? [warning] : [])
}

/** Compatibility bridge for old caches and tests that only contain TokenUsage. */
export function accountingFromLegacyUsage(provider: SessionSource, usage: TokenUsage): TokenAccounting {
  if (provider === 'cursor') {
    return unavailableTokenAccounting(provider, 'Local Cursor transcripts do not expose authoritative token usage')
  }
  if (UNVERIFIED_TOKEN_SOURCES.has(provider)) {
    return unavailableTokenAccounting(provider, `${provider} token schema has not been verified`)
  }
  if (provider === 'codex') {
    const accounting = accountCodexUsage([{
      kind: 'incremental',
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheCreationTokens,
      dedupHint: 'codex:legacy-session-total'
    }])
    accounting.warnings.push('normalized from legacy Codex aggregate; cached input is a subset of input')
    return accounting
  }
  return accountingFromMutuallyExclusiveUsage(provider, usage, 'derived', 'normalized from legacy session aggregate')
}

export function accountingForSession(session: {
  source?: SessionSource
  tokenUsage: TokenUsage
  tokenAccounting?: TokenAccounting
}): TokenAccounting {
  return session.tokenAccounting || accountingFromLegacyUsage(session.source || 'claude-code', session.tokenUsage)
}

export function markExcludedFromRollups(accounting: TokenAccounting): TokenAccounting {
  return { ...accounting, excludedFromRollups: true }
}
