/**
 * 升版本 = 有意识地同时改这三处 + CHANGELOG 一行。
 *
 * Summary-cache version guard (F1d-3, from F1m's verification P2-1: moving
 * CACHE_VERSION back to 30 failed no test). A compact row stores each usage
 * copy as a positional tuple, and a build reads a row back by position, so
 * the version and the tuple change together, deliberately:
 *   1. session-loader.ts          CACHE_VERSION (a row of another version is
 *                                 never reused: the first load re-reads
 *                                 every session);
 *   2. summary-cache-compact.cjs  usageEventRollup, which writes the tuple;
 *   3. token-accounting.ts        CompactUsageEventRollup and
 *                                 compactUsageEventRollup, which read and
 *                                 rebuild it in memory;
 * plus one CHANGELOG line (the first launch re-reads every session). Change
 * any of them and this file fails until it is updated too: bump the version
 * here and in session-loader.ts, and write the new tuple below in full, in
 * order. Every value here is synthetic.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SUMMARY_CACHE_VERSION } from './session-loader'
import { compactPerFileJson } from './summary-cache-compact.cjs'
import {
  compactUsageEventRollup,
  type CompactUsageEventRollup,
  type InheritedUsage,
  type TokenProvenance,
  type UsageEvent,
  type UsageScope
} from './token-accounting'

/** The tuple as cache v31 stores it, element by element (compile-time half of the pin). */
type PinnedRollup = readonly [
  dedupKey: string,
  billingFactKey: string | null,
  scope: UsageScope,
  provenance: Exclude<TokenProvenance, 'unavailable'>,
  nonCachedInputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  cacheWrite5mTokens: number,
  cacheWrite1hTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  timestamp: string | null,
  auditSourceId: string | null,
  inheritedFrom?: InheritedUsage
]
type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false
const rollupTypeIsPinned: Same<CompactUsageEventRollup, PinnedRollup> = true

function usageEvent(overrides: Partial<UsageEvent> & Pick<UsageEvent, 'dedupKey' | 'components'>): UsageEvent {
  return {
    provider: 'claude-code',
    providerFormatVersion: 'guard',
    modelProvenance: 'response',
    providerProvenance: 'explicit',
    scope: 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    semantics: 'anthropic-disjoint',
    warnings: [],
    ...overrides
  }
}

/** Every field the tuple carries, each with a value no other field has. */
const FULL = usageEvent({
  dedupKey: 'guard:dedup',
  billingFactKey: 'guard:billing-fact',
  scope: 'subagent',
  provenance: 'derived',
  components: {
    nonCachedInputTokens: 101,
    cacheReadTokens: 202,
    cacheWriteTokens: 303,
    cacheWrite5mTokens: 404,
    cacheWrite1hTokens: 505,
    outputTokens: 606,
    reasoningTokens: 707
  },
  timestamp: '2026-09-28T01:02:03.004Z',
  auditSourceId: 'guard:audit-stream',
  sourceRowId: 'guard:not-in-the-tuple',
  modelRaw: 'guard-model-not-in-the-tuple'
})
const FULL_TUPLE = [
  'guard:dedup',
  'guard:billing-fact',
  'subagent',
  'derived',
  101,
  202,
  303,
  404,
  505,
  606,
  707,
  '2026-09-28T01:02:03.004Z',
  'guard:audit-stream'
]

/** The optional fields absent: the tuple keeps their places. */
const SPARSE = usageEvent({
  dedupKey: 'guard:sparse',
  components: {
    nonCachedInputTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    cacheWrite5mTokens: 4,
    cacheWrite1hTokens: 5,
    outputTokens: 6
  }
})
const SPARSE_TUPLE = ['guard:sparse', null, 'main', 'reported', 1, 2, 3, 4, 5, 6, 0, null, null]

/** What the summary cache's compact column stores for one session holding these copies. */
function cachedRollups(events: UsageEvent[]): unknown[] {
  const perFile = {
    summary: {
      tokenAccounting: {
        provider: 'claude-code',
        metricVersion: 2,
        provenance: 'reported',
        billingTotal: 1,
        conversationOnly: 1,
        components: null,
        usageEvents: events,
        warnings: []
      }
    }
  }
  const compact = JSON.parse(compactPerFileJson(perFile)).summary.tokenAccounting
  expect(Object.keys(compact).sort()).toEqual(
    ['billingTotal', 'components', 'conversationOnly', 'metricVersion', 'provenance', 'provider', 'usageEventRollups', 'warnings']
  )
  return compact.usageEventRollups
}

describe('summary cache version guard (F1d-3)', () => {
  it('CACHE_VERSION is 31, in the code and in session-loader.ts\'s text', () => {
    expect(SUMMARY_CACHE_VERSION).toBe(31)
    const loader = fs.readFileSync(path.join(__dirname, 'session-loader.ts'), 'utf8')
    expect(loader.match(/^const CACHE_VERSION = (\d+)$/m)?.[1]).toBe('31')
  })

  it('summary-cache-compact.cjs writes each copy as this 13-element tuple, in this order', () => {
    expect(rollupTypeIsPinned).toBe(true)
    expect(cachedRollups([FULL, SPARSE])).toEqual([FULL_TUPLE, SPARSE_TUPLE])
  })

  it('token-accounting.ts rebuilds the same tuple, in the same order', () => {
    expect(compactUsageEventRollup(FULL)).toEqual(FULL_TUPLE)
    expect(compactUsageEventRollup(SPARSE)).toEqual(SPARSE_TUPLE)
    expect(compactUsageEventRollup(FULL)).toHaveLength(13)
  })

  it('an inherited mark lives only in memory: the 14th element in token-accounting.ts, never in the cache', () => {
    const inheritedFrom: InheritedUsage = { sessionId: 'guard-owner', originalScope: 'sidechain' }
    const inherited = { ...FULL, scope: 'inherited' as const, inheritedFrom }
    const expected = [...FULL_TUPLE.slice(0, 2), 'inherited', ...FULL_TUPLE.slice(3)]
    expect(compactUsageEventRollup(inherited)).toEqual([...expected, inheritedFrom])
    expect(cachedRollups([inherited])).toEqual([expected])
  })
})
