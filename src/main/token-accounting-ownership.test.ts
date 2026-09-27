/**
 * F1m ②: one load's cross-session ownership (token-accounting.ts assignCrossSessionUsageOwners).
 * Synthetic ledgers only. What must hold:
 * - a billing fact several sessions carry counts in one of them, the copy billing_rank puts first
 *   (precedesInBillingRank, the ledger's and Insights' rule); the other copies stay as 'inherited'
 *   audit rows and their sessions' totals and tokenUsage are recomputed without them;
 * - nothing else of a session changes, and no input ledger is mutated;
 * - idempotent, and reversible when the owner leaves the input;
 * - full usage events and compact rollups (summary-cache v31) give the same owners and totals.
 */
import { describe, expect, it } from 'vitest'
import {
  accountingFromUsageEvents,
  assignCrossSessionUsageOwners,
  compactUsageEventRollup,
  inheritedOwnerIndexes,
  markExcludedFromRollups,
  observedUsageScope,
  tokenUsageFromAccounting,
  uniqueBillingEvents,
  type TokenAccounting,
  type UsageEvent,
  type UsageScope
} from './token-accounting'
import { billingAgentScope, billingOccurredAt, precedesInBillingRank, usageFactEventId } from './billing-identity'
import { compactPerFileJson } from './summary-cache-compact.cjs'
import type { SessionSource, SessionSummary } from './session-types'

interface CallSpec {
  id: string
  input: number
  output?: number
  cacheRead?: number
  scope?: UsageScope
  timestamp?: string
  /** Default: a Claude call id, billingFactKey = dedupKey. `false`: a row without an id (session-scoped). */
  billingFactKey?: string | false
  provider?: SessionSource
}

function call(spec: CallSpec): UsageEvent {
  const key = spec.billingFactKey === false ? `claude:row:${spec.id}` : `claude:message:${spec.id}`
  return {
    provider: spec.provider || 'claude-code',
    providerFormatVersion: 'ownership-fixture-v1',
    dedupKey: key,
    ...(spec.billingFactKey === false ? {} : { billingFactKey: spec.billingFactKey || key }),
    ...(spec.timestamp ? { timestamp: spec.timestamp } : {}),
    modelProvenance: 'unknown',
    providerProvenance: 'unknown',
    scope: spec.scope || 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    components: {
      nonCachedInputTokens: spec.input, cacheReadTokens: spec.cacheRead || 0, cacheWriteTokens: 0,
      cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: spec.output || 0
    },
    semantics: 'anthropic-disjoint',
    warnings: []
  }
}

function session(sessionId: string, events: UsageEvent[], overrides: Partial<SessionSummary> = {}): SessionSummary {
  const tokenAccounting = accountingFromUsageEvents(overrides.source || 'claude-code', events)
  return {
    id: sessionId,
    sessionId,
    slug: sessionId,
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-02T00:00:00Z',
    messageCount: events.length * 2,
    turnCount: events.length,
    compactCount: 0,
    cwds: [`/ownership/${sessionId}`],
    version: 'fixture',
    firstUserMessage: sessionId,
    toolUsage: {},
    skillInvocations: [],
    projectPath: `/ownership/${sessionId}`,
    filePath: `/ownership/${sessionId}.jsonl`,
    fileSizeBytes: 1,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: tokenUsageFromAccounting(tokenAccounting),
    tokenAccounting,
    providerOutcome: { detected: 'detected', parse: 'parsed', usage: 'available' },
    referencedFiles: [],
    configFiles: [],
    source: 'claude-code',
    ...overrides
  }
}

const T = (minute: number, suffix = '.000Z'): string => `2026-07-01T10:${String(minute).padStart(2, '0')}:00${suffix}`

/** The winner by the shared rule, computed here from the same inputs the pass ranks by. */
function expectedOwner(copies: Array<{ session: SessionSummary; event: UsageEvent }>): string {
  const rank = ({ session: owner, event }: { session: SessionSummary; event: UsageEvent }) => ({
    agentScope: billingAgentScope(event.scope),
    occurredAt: billingOccurredAt(event.timestamp),
    eventId: usageFactEventId(owner.source || 'claude-code', owner.sessionId, event)
  })
  let winner = copies[0]
  for (const copy of copies.slice(1)) if (precedesInBillingRank(rank(copy), rank(winner))) winner = copy
  return winner.session.sessionId
}

function inheritedKeys(item: SessionSummary): Array<[string, string | undefined, string | undefined]> {
  return item.tokenAccounting!.usageEvents
    .filter((event) => event.scope === 'inherited')
    .map((event) => [event.dedupKey, event.inheritedFrom?.sessionId, event.inheritedFrom?.originalScope])
}

/** A session as a summary-cache v31 compact read hands it over: aggregates kept, events left on disk. */
function compacted(item: SessionSummary): SessionSummary {
  const accounting = JSON.parse(compactPerFileJson({ summary: { tokenAccounting: item.tokenAccounting } }))
    .summary.tokenAccounting as TokenAccounting
  return { ...item, tokenAccounting: { ...accounting, usageEvents: [], usageEventsOmitted: true } }
}

function totals(item: SessionSummary): unknown {
  const accounting = item.tokenAccounting!
  return [accounting.billingTotal, accounting.conversationOnly, accounting.components, accounting.provenance, accounting.warnings, item.tokenUsage]
}

describe('uniqueBillingEvents with inherited copies (F1m)', () => {
  it('an inherited copy never owns, marked by the pass or not; the others keep their order', () => {
    const events = [
      call({ id: 'a', input: 1 }),
      { ...call({ id: 'b', input: 2 }), scope: 'inherited' as const, inheritedFrom: { sessionId: 'other', originalScope: 'main' as const } },
      call({ id: 'c', input: 3, scope: 'sidechain' }),
      { ...call({ id: 'c', input: 4 }), scope: 'inherited' as const },
      call({ id: 'd', input: 5 })
    ]
    expect(uniqueBillingEvents(events).map((event) => event.dedupKey))
      .toEqual(['claude:message:a', 'claude:message:c', 'claude:message:d'])
    const accounting = accountingFromUsageEvents('claude-code', events)
    expect(accounting.billingTotal).toBe(1 + 3 + 5)
    expect(accounting.conversationOnly).toBe(1 + 5)
    expect(accounting.usageEvents).toHaveLength(5)
  })

  it('inheritedOwnerIndexes: per fact, the inherited copy uniqueBillingEvents would have picked by observed scope', () => {
    const inherit = (event: UsageEvent) => ({ ...event, scope: 'inherited' as const, inheritedFrom: { sessionId: 'owner', originalScope: observedUsageScope(event) as 'main' } })
    const events = [
      inherit(call({ id: 'x', input: 1, scope: 'sidechain' })),
      call({ id: 'y', input: 1 }),
      inherit(call({ id: 'x', input: 1 })),
      inherit(call({ id: 'z', input: 1, scope: 'subagent' })),
      inherit(call({ id: 'z', input: 1, scope: 'sidechain' }))
    ]
    expect(inheritedOwnerIndexes(events)).toEqual([2, 3])
  })
})

describe('assignCrossSessionUsageOwners (F1m)', () => {
  function pair(): SessionSummary[] {
    return [
      session('owner-a', [
        call({ id: 'shared-1', input: 100, output: 10, timestamp: T(1) }),
        call({ id: 'shared-2', input: 200, output: 20, cacheRead: 2_000, timestamp: T(2) }),
        call({ id: 'a-own', input: 1_000, output: 100, timestamp: T(10) })
      ], { branchChildIds: ['owner-b'] }),
      session('owner-b', [
        call({ id: 'shared-1', input: 100, output: 10, timestamp: T(1) }),
        call({ id: 'shared-2', input: 200, output: 20, cacheRead: 2_000, timestamp: T(2) }),
        call({ id: 'b-own', input: 3_000, output: 300, timestamp: T(11) })
      ], { branchParentId: 'owner-a', branchPointUuid: 'fixture-branch-point', branchParentFilePaths: ['/ownership/owner-a.jsonl'] })
    ]
  }

  it('each shared call counts in the copy billing_rank puts first; the other copy stays as an inherited audit row', () => {
    const input = pair()
    const pristine = structuredClone(input)
    const expectedOwners = ['shared-1', 'shared-2'].map((id) => expectedOwner(input.map((item) => ({
      session: item, event: item.tokenAccounting!.usageEvents.find((event) => event.dedupKey === `claude:message:${id}`)!
    }))))

    const stats = assignCrossSessionUsageOwners(input)

    expect(stats).toMatchObject({ sessions: 2, sharedFacts: 2, inheritedCopies: 2 })
    const byId = Object.fromEntries(input.map((item) => [item.sessionId, item]))
    const sharedTokens = { 'shared-1': 110, 'shared-2': 2_220 }
    let global = 0
    for (const item of input) {
      const lost = (['shared-1', 'shared-2'] as const).filter((id, index) => expectedOwners[index] !== item.sessionId)
      expect(inheritedKeys(item)).toEqual(lost.map((id) => [`claude:message:${id}`, expectedOwners[['shared-1', 'shared-2'].indexOf(id)], 'main']))
      const pristineTotal = pristine.find((copy) => copy.sessionId === item.sessionId)!.tokenAccounting!.billingTotal!
      expect(item.tokenAccounting!.billingTotal).toBe(pristineTotal - lost.reduce((sum, id) => sum + sharedTokens[id], 0))
      expect(item.tokenAccounting!.conversationOnly).toBe(item.tokenAccounting!.billingTotal)
      // Copies stay: an inherited copy is an audit row, not a deletion.
      expect(item.tokenAccounting!.usageEvents).toHaveLength(3)
      expect(item.tokenUsage).toEqual(tokenUsageFromAccounting(item.tokenAccounting!))
      global += item.tokenAccounting!.billingTotal!
    }
    // Σ sessions == every call once.
    expect(global).toBe(110 + 2_220 + 1_100 + 3_300)
    expect(byId['owner-a'].tokenAccounting!.billingTotal! + byId['owner-b'].tokenAccounting!.billingTotal!)
      .toBe(pristine[0].tokenAccounting!.billingTotal! + pristine[1].tokenAccounting!.billingTotal! - 110 - 2_220)
  })

  it('changes nothing but tokenAccounting and tokenUsage, and never mutates an input ledger', () => {
    const input = pair()
    const ledgers = input.map((item) => item.tokenAccounting!)
    const before = structuredClone(input)
    assignCrossSessionUsageOwners(input)
    // The ledgers the summaries held (shared with the summary cache in a real load) are untouched.
    expect(ledgers).toEqual(before.map((item) => item.tokenAccounting))
    input.forEach((item, index) => {
      // A session that lost a copy gets a new ledger; one that owns all it carries keeps its own.
      if (inheritedKeys(item).length > 0) expect(item.tokenAccounting).not.toBe(ledgers[index])
      else expect(item.tokenAccounting).toBe(ledgers[index])
      const { tokenAccounting: _after, tokenUsage: _afterUsage, ...rest } = item
      const { tokenAccounting: _before, tokenUsage: _beforeUsage, ...restBefore } = before[index]
      // Branch metadata (branchParentId, branchChildIds, branchPointUuid, branchParentFilePaths) and all else.
      expect(rest).toEqual(restBefore)
    })
  })

  it('is idempotent and reversible: a copy whose owner left the input owns its fact again', () => {
    const input = pair()
    assignCrossSessionUsageOwners(input)
    const once = structuredClone(input)
    assignCrossSessionUsageOwners(input)
    expect(input).toEqual(once)

    // Drop whichever session owns shared-1; the other one's inherited copies all come back.
    const pristine = pair()
    for (const gone of ['owner-a', 'owner-b']) {
      const rest = structuredClone(once).filter((item) => item.sessionId !== gone)
      const stats = assignCrossSessionUsageOwners(rest)
      expect(stats).toMatchObject({ sessions: 1, sharedFacts: 0, inheritedCopies: 0, sessionsWithInheritedCopies: 0 })
      const alone = pristine.find((item) => item.sessionId !== gone)!
      expect(rest[0].tokenAccounting).toEqual(alone.tokenAccounting)
      expect(rest[0].tokenUsage).toEqual(alone.tokenUsage)
    }
  })

  it('compact rollups (a cached ledger whose events stayed on disk) give the same owners and totals as full events', () => {
    const full = pair()
    const compact = pair().map(compacted)
    assignCrossSessionUsageOwners(full)
    assignCrossSessionUsageOwners(compact)
    compact.forEach((item, index) => {
      expect(totals(item)).toEqual(totals(full[index]))
      const marked = item.tokenAccounting!.usageEventRollups!
        .filter((rollup) => rollup[2] === 'inherited')
        .map((rollup) => [rollup[0], rollup[13]?.sessionId, rollup[13]?.originalScope])
      expect(marked).toEqual(inheritedKeys(full[index]))
    })
    // Mixed (one session re-parsed this load, the other cached) decides the same way too.
    const mixed = [pair()[0], compacted(pair()[1])]
    assignCrossSessionUsageOwners(mixed)
    mixed.forEach((item, index) => expect(totals(item)).toEqual(totals(full[index])))
  })

  it('compact rollups are idempotent and reversible too', () => {
    const input = pair().map(compacted)
    assignCrossSessionUsageOwners(input)
    const once = structuredClone(input)
    const again = assignCrossSessionUsageOwners(input)
    expect(input).toEqual(once)
    expect(again.inheritedCopies).toBe(once.flatMap((item) => item.tokenAccounting!.usageEventRollups!).filter((rollup) => rollup[2] === 'inherited').length)
    for (const gone of ['owner-a', 'owner-b']) {
      const rest = structuredClone(once).filter((item) => item.sessionId !== gone)
      assignCrossSessionUsageOwners(rest)
      const alone = compacted(pair().find((item) => item.sessionId !== gone)!)
      expect(rest[0].tokenAccounting).toEqual(alone.tokenAccounting)
      expect(rest[0].tokenUsage).toEqual(alone.tokenUsage)
    }
  })

  it('differential: over copies that differ in scope, time, time format, audit stream and key, rollups decide exactly as events', () => {
    // Deterministic variety: every field the rank reads differs somewhere, and some calls carry a
    // dedupKey apart from their billingFactKey (the event id is built from the dedupKey).
    const scopes: UsageScope[] = ['main', 'sidechain', 'subagent', 'main']
    const stamps = [T(1), T(1, 'Z'), undefined, T(2), 'not-a-date', T(1, '+00:00')]
    const build = (sessionIndex: number) => session(`diff-${sessionIndex}`, Array.from({ length: 40 }, (_, fact) => {
      const variant = fact * 7 + sessionIndex * 3
      const event = call({
        id: `diff-${fact}`, input: 10 + fact, output: sessionIndex,
        scope: scopes[variant % scopes.length], timestamp: stamps[(fact + sessionIndex * 5) % stamps.length]
      })
      return {
        ...event,
        ...(fact % 3 === 0 ? { dedupKey: `diff-dedup-${fact}-${sessionIndex % 2}` } : {}),
        ...(fact % 4 === 1 ? { auditSourceId: `diff-stream-${sessionIndex}` } : {})
      }
    }), { updatedAt: `2026-07-0${2 + sessionIndex}T00:00:00Z` })
    const full = [0, 1, 2].map(build)
    const compact = [0, 1, 2].map(build).map(compacted)
    const fullStats = assignCrossSessionUsageOwners(full)
    const compactStats = assignCrossSessionUsageOwners(compact)
    expect(compactStats).toEqual(fullStats)
    expect(fullStats.sharedFacts).toBe(40)
    compact.forEach((item, index) => {
      expect(totals(item)).toEqual(totals(full[index]))
      expect(item.tokenAccounting!.usageEventRollups!.filter((rollup) => rollup[2] === 'inherited')
        .map((rollup) => [rollup[0], rollup[13]?.sessionId, rollup[13]?.originalScope]))
        .toEqual(inheritedKeys(full[index]))
    })
    // And the owners are the rule's: per fact, the copy precedesInBillingRank puts first.
    for (let fact = 0; fact < 40; fact++) {
      const copies = full.map((item) => ({ session: item, event: item.tokenAccounting!.usageEvents.find((event) => event.billingFactKey === `claude:message:diff-${fact}`)! }))
      const owner = expectedOwner(copies.map(({ session: item, event }) => ({ session: item, event: event.scope === 'inherited' ? { ...event, scope: event.inheritedFrom!.originalScope } : event })))
      for (const { session: item, event } of copies) expect(event.scope === 'inherited', `${fact} ${item.sessionId}`).toBe(item.sessionId !== owner)
    }
  })

  it('the TS rollup equals the cached (summary-cache-compact.cjs) rollup of the same copy', () => {
    const event = { ...call({ id: 'r', input: 7, output: 3, cacheRead: 5, scope: 'sidechain', timestamp: T(3, 'Z') }), auditSourceId: 'stream' }
    const cached = JSON.parse(compactPerFileJson({ summary: { tokenAccounting: accountingFromUsageEvents('claude-code', [event]) } }))
      .summary.tokenAccounting.usageEventRollups[0]
    expect(compactUsageEventRollup(event)).toEqual(cached)
    expect(cached).toEqual(['claude:message:r', 'claude:message:r', 'sidechain', 'reported', 7, 5, 0, 0, 0, 3, 0, T(3, 'Z'), 'stream'])
  })

  it('three copies: scope first, then timestamped before untimed, then time; branch views, unparsed and excluded ledgers never compete', () => {
    const shared = (spec: Partial<CallSpec>) => call({ id: 'three', input: 50, ...spec })
    const sessions = [
      session('s-side', [shared({ scope: 'sidechain', timestamp: T(0) })]),
      session('s-untimed', [shared({})]),
      session('s-late', [shared({ timestamp: T(9) })]),
      session('s-early', [shared({ timestamp: T(5) })]),
      // Not candidates: an intra-file branch view, a ledger excluded from rollups, an unparsed placeholder.
      session('s-view', [shared({ timestamp: T(1) })], { branchLeafUuid: 'leaf' }),
      { ...session('s-excluded', [shared({ timestamp: T(1) })]), tokenAccounting: markExcludedFromRollups(accountingFromUsageEvents('claude-code', [shared({ timestamp: T(1) })])) },
      session('s-placeholder', [shared({ timestamp: T(1) })], { providerOutcome: { detected: 'detected', parse: 'placeholder', usage: 'unavailable' } })
    ]
    const stats = assignCrossSessionUsageOwners(sessions)
    expect(stats).toMatchObject({ sessions: 4, sharedFacts: 1, inheritedCopies: 3, sessionsWithInheritedCopies: 3 })
    const owners = sessions.filter((item) => item.tokenAccounting!.billingTotal === 50).map((item) => item.sessionId)
    // s-early: main and timed and earlier than s-late; the view/excluded/placeholder copies are untouched.
    expect(owners).toEqual(['s-early', 's-view', 's-excluded', 's-placeholder'])
    for (const id of ['s-side', 's-untimed', 's-late']) {
      expect(inheritedKeys(sessions.find((item) => item.sessionId === id)!)).toEqual([['claude:message:three', 's-early', id === 's-side' ? 'sidechain' : 'main']])
    }
  })

  it('never merges across sessions without a billingFactKey, nor the same key under another source', () => {
    const rowOnly = [
      session('row-a', [call({ id: '7', input: 10, billingFactKey: false, timestamp: T(1) })]),
      session('row-b', [call({ id: '7', input: 10, billingFactKey: false, timestamp: T(1) })])
    ]
    expect(assignCrossSessionUsageOwners(rowOnly)).toMatchObject({ sharedFacts: 0, inheritedCopies: 0 })
    const sources = [
      session('src-claude', [call({ id: 'k', input: 10, timestamp: T(1) })]),
      session('src-mirror', [call({ id: 'k', input: 10, timestamp: T(1), provider: 'cc-mirror' })], { source: 'cc-mirror' })
    ]
    expect(assignCrossSessionUsageOwners(sources)).toMatchObject({ sharedFacts: 0, inheritedCopies: 0 })
    expect(sources.map((item) => item.tokenAccounting!.billingTotal)).toEqual([10, 10])
  })

  it('a complete tie (two summaries sharing a sessionId, one event_id) goes to the one listed first, newest first', () => {
    const older = session('same-id', [call({ id: 'tie', input: 10, timestamp: T(1) })], { id: 'same-id:branch-0', updatedAt: '2026-07-02T00:00:00Z' })
    const newer = session('same-id', [call({ id: 'tie', input: 10, timestamp: T(1) })], { id: 'same-id:branch-1', updatedAt: '2026-07-03T00:00:00Z' })
    const input = [older, newer]
    assignCrossSessionUsageOwners(input)
    expect(newer.tokenAccounting!.billingTotal).toBe(10)
    expect(older.tokenAccounting!.billingTotal).toBe(0)
    expect(inheritedKeys(older)).toEqual([['claude:message:tie', 'same-id', 'main']])
  })
})
