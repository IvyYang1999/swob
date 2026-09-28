/**
 * One billing fact, one owner (F1m). A billing fact can reach several usage
 * copies: a session's streams (a subagent file, a merged Codex child) and other
 * sessions whose transcripts carry the same call. Three places pick the copy
 * the totals count, and they must pick the same one:
 *
 * - the usage ledger: usage-fact-store derives each copy's event_id,
 *   billing_fact_id, occurred_at and agent_scope with the functions below, and
 *   canonicalizeBillingFacts ranks the copies of a billing_fact_id in SQL
 *   (billing_rank = 1 counts);
 * - Insights (insights.ts sessionLedgers) ranks the sessions' owners in memory;
 * - the session loader's cross-session ownership pass
 *   (token-accounting.ts assignCrossSessionUsageOwners) ranks the sessions'
 *   copies of one call.
 *
 * The rule is precedesInBillingRank, the in-memory form of billing_rank's
 * ORDER BY. The identity functions are usage-fact-store's own, moved here so
 * the other two use the same ones instead of a copy.
 *
 * A leaf: node:crypto only (type imports aside), no Electron, no SQLite.
 */
import { createHash } from 'node:crypto'
import type { UsageScope } from './token-accounting'

/** SHA-256 of the JSON of `value`: every usage-facts id and signature. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * usage_facts.event_id of one copy: its source, its session, the stream that
 * carried it (its auditSourceId, else the session) and its dedupKey.
 */
export function usageFactEventId(
  source: string,
  sessionId: string,
  copy: { auditSourceId?: string | null; dedupKey: string }
): string {
  return stableHash([source, sessionId, copy.auditSourceId || sessionId, copy.dedupKey])
}

/**
 * usage_facts.billing_fact_id: the billing identity copies share, source and
 * billingFactKey. A copy without a billingFactKey is a fact of its own: its
 * event_id, so it never merges across sessions (or sources).
 */
export function usageFactBillingFactId(
  source: string,
  billingFactKey: string | null | undefined,
  eventId: string
): string {
  return billingFactKey ? stableHash([source, billingFactKey]) : eventId
}

/**
 * usage_facts.occurred_at: the timestamp as written when it parses as a date,
 * else null. It stays the raw string: billing_rank orders it as TEXT.
 */
export function billingOccurredAt(timestamp?: string | null): string | null {
  if (!timestamp) return null
  return Number.isNaN(new Date(timestamp).getTime()) ? null : timestamp
}

export type BillingAgentScope = 'main' | 'subagent' | 'unknown'

/** usage_facts.agent_scope of a copy observed with `scope`. */
export function billingAgentScope(scope: UsageScope): BillingAgentScope {
  if (scope === 'main') return 'main'
  if (scope === 'sidechain' || scope === 'subagent') return 'subagent'
  return 'unknown'
}

/** What billing_rank orders a copy by. */
export interface BillingRankKey {
  agentScope: BillingAgentScope
  occurredAt: string | null
  eventId: string
}

/** billing_rank's first key: main 0, subagent 1, any other scope 2. */
export function scopeRank(scope: BillingAgentScope): number {
  return scope === 'main' ? 0 : scope === 'subagent' ? 1 : 2
}

/**
 * Whether `a` comes before `b` in usage-facts' billing_rank, which picks the
 * copy of a billing fact that aggregates count (canonicalizeBillingFacts in
 * usage-fact-store.ts): main, then subagent, then any other scope; timestamped
 * before untimed; then occurred_at, then event_id. SQLite orders those two as
 * TEXT, byte by byte, so compare the raw strings: "…12:00:00.000Z" comes before
 * "…12:00:00Z", although both are the same instant. Two equal keys: neither
 * precedes, and a caller keeps the copy it saw first.
 */
export function precedesInBillingRank(a: BillingRankKey, b: BillingRankKey): boolean {
  const scope = scopeRank(a.agentScope) - scopeRank(b.agentScope)
  if (scope !== 0) return scope < 0
  if ((a.occurredAt === null) !== (b.occurredAt === null)) return b.occurredAt === null
  if (a.occurredAt !== b.occurredAt) return a.occurredAt! < b.occurredAt!
  return a.eventId < b.eventId
}
