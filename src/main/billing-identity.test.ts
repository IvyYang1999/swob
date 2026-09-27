/**
 * F1m ①: the usage-facts identity and billing_rank live in billing-identity.ts, and
 * usage-fact-store, Insights and the session loader's ownership pass import them.
 *
 * - Bit-for-bit: the ids below were produced from billing-identity-ledger.ts by
 *   usage-fact-store's own private implementation, before the move; the ledger must
 *   keep deriving and writing exactly them.
 * - Parity: precedesInBillingRank picks, for every billing fact, the copy that the
 *   ledger's SQL (canonicalizeBillingFacts: the full rebuild's window function and the
 *   incremental UPDATE) marks billing_included — ties included.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  billingAgentScope,
  billingOccurredAt,
  precedesInBillingRank,
  scopeRank,
  stableHash,
  usageFactBillingFactId,
  usageFactEventId,
  type BillingRankKey
} from './billing-identity'
import { closeUsageFactStore, synchronizeUsageFacts, usageFactsForSession } from './usage-fact-store'
import { billingIdentityLedgerSessions } from './__fixtures__/billing-identity-ledger'
import type { SessionSummary } from './session-types'
import type { UsageEvent, UsageScope } from './token-accounting'
import type { UsageFact } from './analysis-contract'

/** [session, event_id, billing_fact_id, occurred_at, agent_scope, turn_count], in fixture order. */
const GOLDEN_FACTS: Array<[string, string, string, string | null, UsageFact['agentScope'], number]> = [
  ['bi-claude-a', '72a73a80e86abc1c40f4f6b8bfa5f9ab84a057ea6dea975f7b916ed29a100344', '0313292e5e48f7186fed2542122b714b526076eedad592a7da7b9a1811bb9d16', '2026-07-21T10:00:00.000Z', 'main', 1],
  ['bi-claude-a', 'd2f41b0b6070048b48b5ef6c491a42413ff4025adb1e0c65bdad74bb745ec2a9', 'c567fccb484f60bf164f429152133f85c7606915215ab3ed780ca1c32ae918d5', '2026-07-21T10:00:00Z', 'subagent', 0],
  ['bi-claude-a', '3ddbc06b0cd190bbfe49aacb6b2a4a96fe8e06d69c564860b7a72c3e2ab7cc2e', '9598d420501a1926cbd32109e78546484846a26c0635368844c9b56797765216', '2026-07-21T18:05:00+08:00', 'subagent', 0],
  ['bi-claude-a', '10212d7c9697d60166bf0ac983eed2565ce07fb5eb8eedf342853b623d338f66', '10212d7c9697d60166bf0ac983eed2565ce07fb5eb8eedf342853b623d338f66', null, 'main', 1],
  ['bi-claude-a', 'e163d310f6cc44ebf1b01a3a3d5845bb92b5dd97ffcebda6cadcbf546de5e125', '7596f87db5ab1f81f30920b7476955caecdfc60709dae292272f1edad0aa5614', null, 'main', 1],
  ['bi-claude-a', 'b48bfe1a580dff0760a52fa763abfd1cdc642d0fbce3fa97c3cc87ba6e229c45', '4c53cef01e5e7dd215efa4c8d78c093528ff88c71b2d1be3052f201eae102b00', '2026-07-21T10:06:00Z', 'main', 1],
  ['bi-claude-a', 'ebc8965cb29b6d22f8e2fab38005a90de8a543d70c9957f4e69a27dccb82922e', '73eb8f8aa281166b3d6945c3b290c1277d7f3a7e6898226c2d217cb9a90b0dc3', '2026-07-21T10:07:00Z', 'main', 1],
  ['bi-claude-b', 'a877b480cb5e6b409ef38616ba91e5f9b484ae9ab4a856628de1a489b7abeded', '0313292e5e48f7186fed2542122b714b526076eedad592a7da7b9a1811bb9d16', '2026-07-21T10:00:00.000Z', 'main', 1],
  ['bi-claude-b', '629c892b26ff0ad694e4291f4d6020d4539a37f3e8af7615288cf804321bdd0b', '629c892b26ff0ad694e4291f4d6020d4539a37f3e8af7615288cf804321bdd0b', null, 'main', 1],
  ['bi-codex', 'f2ffa46247c62b2f7c4e9bdbe44cd677e05b5ea1b93ee4b079761be1d14554d2', '9275d2dc5c2254e97c573a8c46d3ef3951581d8fff0497c496e67be7cadbdf2b', '2026-07-21T11:00:00.000Z', 'subagent', 0],
  ['bi-codex', '6f430d4fec9525cf2eeb75dd59119c2c5b2d2a580b48c26f0cd590b02a7a42df', '3740247b0a7a8f8109e40118626202720d4263622192f0f63d8400106ba2e39c', '2026-07-21T11:01:00.000Z', 'main', 1],
  ['bi-opencode', '922cbbbac294c3bc9f3838bbe6e20dd46623d2c0ed054b7f9cd77abce02dea4e', '922cbbbac294c3bc9f3838bbe6e20dd46623d2c0ed054b7f9cd77abce02dea4e', null, 'main', 1],
  ['bi-no-source', '524d7bd73d44c19d15f50b88707b0d7ea67be830981960436e2a9611576f5e7e', '12eb4eab2fa2674714af73bc5a1869cf00e29a40b8ff079e5be8cd213ba599b5', '2026-07-21T12:00:00.000Z', 'main', 1]
]

/** The same copies as ledger rows: [session_id, event_id, billing_fact_id, agent_scope, occurred_at, turn_count, billing_included], ordered by session, event. */
const GOLDEN_ROWS: Array<[string, string, string, UsageFact['agentScope'], string | null, number, number]> = [
  ['bi-claude-a', '10212d7c9697d60166bf0ac983eed2565ce07fb5eb8eedf342853b623d338f66', '10212d7c9697d60166bf0ac983eed2565ce07fb5eb8eedf342853b623d338f66', 'main', null, 1, 1],
  ['bi-claude-a', '3ddbc06b0cd190bbfe49aacb6b2a4a96fe8e06d69c564860b7a72c3e2ab7cc2e', '9598d420501a1926cbd32109e78546484846a26c0635368844c9b56797765216', 'subagent', '2026-07-21T18:05:00+08:00', 0, 1],
  ['bi-claude-a', '72a73a80e86abc1c40f4f6b8bfa5f9ab84a057ea6dea975f7b916ed29a100344', '0313292e5e48f7186fed2542122b714b526076eedad592a7da7b9a1811bb9d16', 'main', '2026-07-21T10:00:00.000Z', 1, 1],
  ['bi-claude-a', 'b48bfe1a580dff0760a52fa763abfd1cdc642d0fbce3fa97c3cc87ba6e229c45', '4c53cef01e5e7dd215efa4c8d78c093528ff88c71b2d1be3052f201eae102b00', 'main', '2026-07-21T10:06:00Z', 1, 1],
  ['bi-claude-a', 'd2f41b0b6070048b48b5ef6c491a42413ff4025adb1e0c65bdad74bb745ec2a9', 'c567fccb484f60bf164f429152133f85c7606915215ab3ed780ca1c32ae918d5', 'subagent', '2026-07-21T10:00:00Z', 0, 1],
  ['bi-claude-a', 'e163d310f6cc44ebf1b01a3a3d5845bb92b5dd97ffcebda6cadcbf546de5e125', '7596f87db5ab1f81f30920b7476955caecdfc60709dae292272f1edad0aa5614', 'main', null, 1, 1],
  ['bi-claude-a', 'ebc8965cb29b6d22f8e2fab38005a90de8a543d70c9957f4e69a27dccb82922e', '73eb8f8aa281166b3d6945c3b290c1277d7f3a7e6898226c2d217cb9a90b0dc3', 'main', '2026-07-21T10:07:00Z', 1, 1],
  ['bi-claude-b', '629c892b26ff0ad694e4291f4d6020d4539a37f3e8af7615288cf804321bdd0b', '629c892b26ff0ad694e4291f4d6020d4539a37f3e8af7615288cf804321bdd0b', 'main', null, 1, 1],
  ['bi-claude-b', 'a877b480cb5e6b409ef38616ba91e5f9b484ae9ab4a856628de1a489b7abeded', '0313292e5e48f7186fed2542122b714b526076eedad592a7da7b9a1811bb9d16', 'main', '2026-07-21T10:00:00.000Z', 1, 0],
  ['bi-codex', '6f430d4fec9525cf2eeb75dd59119c2c5b2d2a580b48c26f0cd590b02a7a42df', '3740247b0a7a8f8109e40118626202720d4263622192f0f63d8400106ba2e39c', 'main', '2026-07-21T11:01:00.000Z', 1, 1],
  ['bi-codex', 'f2ffa46247c62b2f7c4e9bdbe44cd677e05b5ea1b93ee4b079761be1d14554d2', '9275d2dc5c2254e97c573a8c46d3ef3951581d8fff0497c496e67be7cadbdf2b', 'subagent', '2026-07-21T11:00:00.000Z', 0, 1],
  ['bi-no-source', '524d7bd73d44c19d15f50b88707b0d7ea67be830981960436e2a9611576f5e7e', '12eb4eab2fa2674714af73bc5a1869cf00e29a40b8ff079e5be8cd213ba599b5', 'main', '2026-07-21T12:00:00.000Z', 1, 1],
  ['bi-opencode', '922cbbbac294c3bc9f3838bbe6e20dd46623d2c0ed054b7f9cd77abce02dea4e', '922cbbbac294c3bc9f3838bbe6e20dd46623d2c0ed054b7f9cd77abce02dea4e', 'main', null, 1, 1]
]

let root = ''
let previousUsageIndex: string | undefined

beforeEach(() => {
  closeUsageFactStore()
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-billing-identity-'))
  previousUsageIndex = process.env.SWOB_USAGE_INDEX_PATH
  process.env.SWOB_USAGE_INDEX_PATH = path.join(root, 'usage.db')
})

afterEach(() => {
  closeUsageFactStore()
  if (previousUsageIndex === undefined) delete process.env.SWOB_USAGE_INDEX_PATH
  else process.env.SWOB_USAGE_INDEX_PATH = previousUsageIndex
  fs.rmSync(root, { recursive: true, force: true })
})

function ledgerRows(): Array<Record<string, unknown>> {
  closeUsageFactStore()
  const db = new Database(process.env.SWOB_USAGE_INDEX_PATH!, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`
      SELECT session_id, event_id, billing_fact_id, agent_scope, occurred_at, turn_count, billing_included
      FROM usage_facts WHERE superseded = 0 ORDER BY session_id, event_id
    `).all() as Array<Record<string, unknown>>
  } finally {
    db.close()
  }
}

describe('billing identity: the ledger derives and writes the same ids as before the move (F1m ①)', () => {
  it('usageFactsForSession: event_id, billing_fact_id, occurred_at, agent_scope, turn_count copy for copy', () => {
    const facts = billingIdentityLedgerSessions().flatMap((session) => usageFactsForSession(session).map((fact) =>
      [fact.sessionId, fact.eventId, fact.billingFactId, fact.occurredAt, fact.agentScope, fact.turnCount]))
    expect(facts).toEqual(GOLDEN_FACTS)
  })

  it('synchronizeUsageFacts: the ledger rows and their billing_included, row for row', () => {
    synchronizeUsageFacts(billingIdentityLedgerSessions(), [])
    expect(ledgerRows().map((row) => Object.values(row))).toEqual(GOLDEN_ROWS)
  })

  it('the shared functions are the formulas those ids came from', () => {
    // An independent oracle for the hash: SHA-256 of the JSON, nothing else.
    expect(stableHash(['claude-code', 'x'])).toBe(createHash('sha256').update('["claude-code","x"]').digest('hex'))
    const [claudeA, claudeB, codex] = billingIdentityLedgerSessions()
    const copy = (session: SessionSummary, index: number): UsageEvent => session.tokenAccounting!.usageEvents[index]

    // No auditSourceId: the session stands in for the stream.
    expect(usageFactEventId('claude-code', 'bi-claude-a', copy(claudeA, 0))).toBe(GOLDEN_FACTS[0][1])
    // The audit stream is part of the copy's identity.
    expect(usageFactEventId('claude-code', 'bi-claude-a', copy(claudeA, 5))).toBe(GOLDEN_FACTS[5][1])
    expect(usageFactEventId('claude-code', 'bi-claude-a', { ...copy(claudeA, 5), auditSourceId: undefined }))
      .not.toBe(GOLDEN_FACTS[5][1])
    // null (a compact rollup's "none") is the same as absent.
    expect(usageFactEventId('codex', 'bi-codex', { dedupKey: copy(codex, 1).dedupKey, auditSourceId: null }))
      .toBe(GOLDEN_FACTS[10][1])
    // Same call in two sessions: one billing fact, two copies.
    expect(usageFactBillingFactId('claude-code', copy(claudeA, 0).billingFactKey, GOLDEN_FACTS[0][1])).toBe(GOLDEN_FACTS[0][2])
    expect(usageFactBillingFactId('claude-code', copy(claudeB, 0).billingFactKey, GOLDEN_FACTS[7][1])).toBe(GOLDEN_FACTS[0][2])
    // The same billingFactKey under another source is another fact.
    expect(usageFactBillingFactId('cc-mirror', copy(claudeA, 0).billingFactKey, GOLDEN_FACTS[0][1])).not.toBe(GOLDEN_FACTS[0][2])
    // Without a billingFactKey a copy is a fact of its own: its event id, never shared across sessions.
    expect(usageFactBillingFactId('claude-code', undefined, GOLDEN_FACTS[3][1])).toBe(GOLDEN_FACTS[3][1])
    expect(GOLDEN_FACTS[3][2]).not.toBe(GOLDEN_FACTS[8][2])
  })

  it('occurred_at keeps the raw string of a parsable timestamp; agent_scope folds sidechain into subagent', () => {
    expect(billingOccurredAt('2026-07-21T10:00:00.000Z')).toBe('2026-07-21T10:00:00.000Z')
    expect(billingOccurredAt('2026-07-21T10:00:00Z')).toBe('2026-07-21T10:00:00Z')
    expect(billingOccurredAt('2026-07-21T18:05:00+08:00')).toBe('2026-07-21T18:05:00+08:00')
    expect(billingOccurredAt('not-a-date')).toBeNull()
    expect(billingOccurredAt('')).toBeNull()
    expect(billingOccurredAt(undefined)).toBeNull()
    expect(billingOccurredAt(null)).toBeNull()
    const scopes: UsageScope[] = ['main', 'sidechain', 'subagent', 'inherited']
    expect(scopes.map(billingAgentScope)).toEqual(['main', 'subagent', 'subagent', 'unknown'])
    expect([scopeRank('main'), scopeRank('subagent'), scopeRank('unknown')]).toEqual([0, 1, 2])
  })

  it('precedesInBillingRank: scope, then timed before untimed, then occurred_at and event_id as raw text', () => {
    const key = (agentScope: BillingRankKey['agentScope'], occurredAt: string | null, eventId: string): BillingRankKey =>
      ({ agentScope, occurredAt, eventId })
    const ordered: Array<[BillingRankKey, BillingRankKey]> = [
      [key('main', null, 'f'), key('subagent', '2026-01-01T00:00:00Z', 'a')],
      [key('subagent', null, 'f'), key('unknown', '2026-01-01T00:00:00Z', 'a')],
      [key('main', '2026-01-02T00:00:00Z', 'f'), key('main', null, 'a')],
      [key('main', '2026-01-01T00:00:00Z', 'f'), key('main', '2026-01-02T00:00:00Z', 'a')],
      [key('main', '2026-01-01T00:00:00.000Z', 'f'), key('main', '2026-01-01T00:00:00Z', 'a')],
      [key('main', '2026-01-01T00:00:00+00:00', 'f'), key('main', '2026-01-01T00:00:00-00:00', 'a')],
      [key('main', '2026-01-01T00:00:00Z', 'a'), key('main', '2026-01-01T00:00:00Z', 'b')],
      [key('main', null, 'a'), key('main', null, 'b')]
    ]
    for (const [first, second] of ordered) {
      expect(precedesInBillingRank(first, second), JSON.stringify(first)).toBe(true)
      expect(precedesInBillingRank(second, first), JSON.stringify(second)).toBe(false)
    }
    // Equal keys: neither goes first (the caller keeps the copy it saw first).
    expect(precedesInBillingRank(key('main', null, 'a'), key('main', null, 'a'))).toBe(false)
  })
})

describe('billing rank: precedesInBillingRank picks the copy the ledger SQL marks billing_included (F1m ①)', () => {
  const T = (minute: number, suffix = 'Z'): string => `2026-07-21T10:${String(minute).padStart(2, '0')}:00${suffix}`
  interface Copy { session: string; scope?: UsageScope; timestamp?: string; auditSourceId?: string }
  // Every group is one billing fact; its copies sit in different sessions except where noted.
  const GROUPS: Array<[string, Copy[]]> = [
    ['same occurred_at, event_id decides', [{ session: 's1', timestamp: T(1) }, { session: 's2', timestamp: T(1) }, { session: 's3', timestamp: T(1) }]],
    ['timed before untimed', [{ session: 's1' }, { session: 's2', timestamp: T(9) }]],
    ['main before an earlier sidechain', [{ session: 's1', scope: 'sidechain', timestamp: T(0) }, { session: 's2', timestamp: T(2) }]],
    ['sidechain and subagent are one tier: time decides', [{ session: 's1', scope: 'subagent', timestamp: T(3) }, { session: 's2', scope: 'sidechain', timestamp: T(2) }]],
    ['subagent before any other scope', [{ session: 's1', scope: 'inherited', timestamp: T(0) }, { session: 's2', scope: 'subagent', timestamp: T(5) }]],
    ['".000Z" before "Z" (TEXT)', [{ session: 's1', timestamp: T(4, 'Z') }, { session: 's2', timestamp: T(4, '.000Z') }]],
    ['"+00:00" before "-00:00" (bytes, not locale)', [{ session: 's1', timestamp: T(6, '-00:00') }, { session: 's2', timestamp: T(6, '+00:00') }]],
    ['mixed three: main timed wins', [{ session: 's1', scope: 'sidechain' }, { session: 's2' }, { session: 's3', timestamp: T(7) }]],
    ['all untimed main: event_id decides', [{ session: 's1' }, { session: 's2' }, { session: 's3' }, { session: 's4' }]],
    ['an unparsable timestamp is untimed', [{ session: 's1', timestamp: 'not-a-date' }, { session: 's2' }]],
    ['two other scopes: time decides', [{ session: 's1', scope: 'inherited', timestamp: T(8) }, { session: 's2', scope: 'inherited', timestamp: T(7) }]],
    ['the audit stream changes the event_id', [{ session: 's1', timestamp: T(1), auditSourceId: 'stream-x' }, { session: 's2', timestamp: T(1), auditSourceId: 'stream-y' }]],
    ['two copies in one session and one outside', [{ session: 's1', timestamp: T(3) }, { session: 's1', scope: 'subagent', timestamp: T(3), auditSourceId: 'child' }, { session: 's2', timestamp: T(3) }]]
  ]

  function event(fact: number, copyIndex: number, copy: Copy, extra = 0): UsageEvent {
    const key = `claude:message:rank-${fact}`
    return {
      provider: 'claude-code',
      providerFormatVersion: 'billing-rank-fixture-v1',
      // Two copies of one fact in one session differ by stream; dedupKey is the call's either way.
      dedupKey: key,
      billingFactKey: key,
      ...(copy.auditSourceId ? { auditSourceId: copy.auditSourceId } : {}),
      ...(copy.timestamp ? { timestamp: copy.timestamp } : {}),
      modelProvenance: 'unknown',
      providerProvenance: 'unknown',
      scope: copy.scope || 'main',
      counterKind: 'incremental',
      provenance: 'reported',
      components: {
        nonCachedInputTokens: 100 * (fact + 1) + copyIndex + extra, cacheReadTokens: 0, cacheWriteTokens: 0,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1
      },
      semantics: 'anthropic-disjoint',
      warnings: []
    }
  }

  function sessions(extra = 0): SessionSummary[] {
    const bySession = new Map<string, UsageEvent[]>()
    GROUPS.forEach(([, copies], fact) => copies.forEach((copy, copyIndex) => {
      const events = bySession.get(copy.session) || []
      events.push(event(fact, copyIndex, copy))
      bySession.set(copy.session, events)
    }))
    return [...bySession].map(([sessionId, events]) => {
      // A changed session (a later sync) gets one more call of its own: its facts are rewritten.
      if (extra) events = [...events, { ...event(99, 0, { session: sessionId, timestamp: T(59) }), dedupKey: `own-${sessionId}-${extra}`, billingFactKey: `own-${sessionId}-${extra}` }]
      const total = events.reduce((sum, item) => sum + item.components.nonCachedInputTokens + 1, 0)
      return {
        id: sessionId, sessionId, slug: sessionId, createdAt: T(0), updatedAt: T(0), messageCount: 2, turnCount: 1,
        compactCount: 0, cwds: ['/rank'], version: 'fixture', firstUserMessage: sessionId, toolUsage: {},
        skillInvocations: [], projectPath: '/rank', filePath: `/rank/${sessionId}.jsonl`, fileSizeBytes: 1,
        userImages: [], pastedImageCount: 0,
        tokenUsage: { inputTokens: total, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        tokenAccounting: {
          provider: 'claude-code', metricVersion: 2, provenance: 'reported', billingTotal: total, conversationOnly: total,
          components: { nonCachedInputTokens: total, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, reasoningTokens: 0 },
          usageEvents: events, warnings: []
        },
        providerOutcome: { detected: 'detected', parse: 'parsed', usage: 'available' },
        referencedFiles: [], configFiles: [], source: 'claude-code'
      } satisfies SessionSummary
    })
  }

  /** billing_fact_id → the event_id precedesInBillingRank puts first (first seen on a full tie). */
  function tsWinners(input: SessionSummary[]): Map<string, string> {
    const winners = new Map<string, UsageFact>()
    for (const fact of input.flatMap((session) => usageFactsForSession(session))) {
      const current = winners.get(fact.billingFactId)
      if (!current || precedesInBillingRank(fact, current)) winners.set(fact.billingFactId, fact)
    }
    return new Map([...winners].map(([billingFactId, fact]) => [billingFactId, fact.eventId]))
  }

  function sqlWinners(): Map<string, string> {
    const winners = new Map<string, string>()
    for (const row of ledgerRows()) {
      if (row.billing_included !== 1) continue
      expect(winners.has(row.billing_fact_id as string), `one billing_included copy per fact`).toBe(false)
      winners.set(row.billing_fact_id as string, row.event_id as string)
    }
    return winners
  }

  it('full rebuild and incremental canonicalization both agree with the TS rule, group for group', () => {
    const first = sessions()
    synchronizeUsageFacts(first, [])
    const expected = tsWinners(first)
    expect(expected.size).toBe(GROUPS.length)
    expect(sqlWinners()).toEqual(expected)

    // Every session changes: the next sync canonicalizes each affected fact with the incremental UPDATE.
    const second = sessions(1)
    synchronizeUsageFacts(second, [])
    expect(sqlWinners()).toEqual(tsWinners(second))

    // The fixture discriminates: another comparator would pick another copy somewhere.
    const naive = new Map<string, string>()
    for (const fact of first.flatMap((session) => usageFactsForSession(session))) {
      if (!naive.has(fact.billingFactId)) naive.set(fact.billingFactId, fact.eventId)
    }
    expect(naive).not.toEqual(expected)
  })
})
