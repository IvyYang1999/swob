/**
 * ⑤ Token (C2a, package decision 1): `readoutTokensFromAccounting`'s dedup is an independent rewrite of
 * `token-accounting.ts#uniqueBillingEvents`, not an import of it (readout.ts is the only checkup module
 * allowed to reach into src/main, and even it may only call the entries the architecture test whitelists —
 * `uniqueBillingEvents` is not one of them). This file is the guard: it imports the real kernel function
 * (test files sit outside `kernel-gateway.architecture.test.ts`'s scan) and checks that, for the same set
 * of events, the rewrite produces the same numbers.
 */
import { describe, expect, it } from 'vitest'
import { accountingFromUsageEvents, unavailableTokenAccounting, type UsageEvent } from '../main/token-accounting'
import { readoutTokensFromAccounting, unavailableReadoutTokens } from './readout'

function usageEvent(overrides: Partial<UsageEvent> & Pick<UsageEvent, 'dedupKey'>): UsageEvent {
  return {
    provider: 'claude-code',
    providerFormatVersion: 'test-v1',
    modelProvenance: 'unknown',
    providerProvenance: 'unknown',
    scope: 'main',
    counterKind: 'incremental',
    provenance: 'reported',
    components: { nonCachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0 },
    semantics: 'anthropic-disjoint',
    warnings: [],
    ...overrides
  }
}

describe('readoutTokensFromAccounting (C2a decision 1 guard)', () => {
  it('is an independent rewrite of uniqueBillingEvents: same events in, same billingTotal and components out', () => {
    const events: UsageEvent[] = [
      // An earlier sidechain copy of a billing fact, then the main-thread event for the same fact with
      // different (correct) numbers: a rewrite that just kept "first wins" per key would get this wrong.
      usageEvent({
        dedupKey: 'a-side', billingFactKey: 'fact-1', scope: 'sidechain',
        components: { nonCachedInputTokens: 999, cacheReadTokens: 999, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 999 }
      }),
      usageEvent({
        dedupKey: 'a-main', billingFactKey: 'fact-1', scope: 'main',
        components: { nonCachedInputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 5 }
      }),
      // An independent fact with its own cache read/write and reasoning.
      usageEvent({
        dedupKey: 'b', billingFactKey: 'fact-2', scope: 'main',
        components: { nonCachedInputTokens: 3, cacheReadTokens: 7, cacheWriteTokens: 2, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1, reasoningTokens: 4 }
      }),
      // No billingFactKey at all: falls back to dedupKey, its own fact.
      usageEvent({ dedupKey: 'c', components: { nonCachedInputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1 } })
    ]
    const accounting = accountingFromUsageEvents('claude-code', events)
    const result = readoutTokensFromAccounting(accounting)
    // The kernel's own billingTotal/components (computed by uniqueBillingEvents itself) is the oracle here.
    expect(result.billingTotal).toBe(accounting.billingTotal)
    expect(result.components).toEqual({
      nonCachedInput: accounting.components!.nonCachedInputTokens,
      cacheRead: accounting.components!.cacheReadTokens,
      cacheWrite: accounting.components!.cacheWriteTokens + accounting.components!.cacheWrite5mTokens + accounting.components!.cacheWrite1hTokens,
      output: accounting.components!.outputTokens,
      reasoning: accounting.components!.reasoningTokens ?? 0
    })
    // Pinned expectation (not just "equal to the kernel"): the sidechain copy must not win.
    expect(result.components).toEqual({ nonCachedInput: 14, cacheRead: 7, cacheWrite: 2, output: 7, reasoning: 4 })
    expect(result.billingTotal).toBe(30)
    expect(result.provenance).toBe('reported')
  })

  it('F1m: skips a copy the kernel load counted in another session (inherited), as uniqueBillingEvents does', () => {
    const inherited = { sessionId: 'owner-session', originalScope: 'main' as const }
    const events: UsageEvent[] = [
      usageEvent({
        dedupKey: 'shared', billingFactKey: 'fact-shared', scope: 'inherited', inheritedFrom: inherited, rawCacheWriteTokens: 50,
        components: { nonCachedInputTokens: 500, cacheReadTokens: 5_000, cacheWriteTokens: 0, cacheWrite5mTokens: 20, cacheWrite1hTokens: 0, outputTokens: 50 }
      }),
      usageEvent({
        dedupKey: 'own', billingFactKey: 'fact-own',
        components: { nonCachedInputTokens: 10, cacheReadTokens: 100, cacheWriteTokens: 1, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 2 }
      }),
      // An inherited copy never wins a key either, even as the only other copy of a fact this session owns.
      usageEvent({
        dedupKey: 'own-copy', billingFactKey: 'fact-own', scope: 'inherited', inheritedFrom: inherited,
        components: { nonCachedInputTokens: 999, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0 }
      })
    ]
    const accounting = accountingFromUsageEvents('claude-code', events)
    const result = readoutTokensFromAccounting(accounting)
    expect(result.billingTotal).toBe(accounting.billingTotal)
    expect(result.components).toEqual({ nonCachedInput: 10, cacheRead: 100, cacheWrite: 1, output: 2, reasoning: 0 })
    expect(result.billingTotal).toBe(113)
    // The inherited copy's cache-write calibration gap belongs to the session that counts it.
    expect(result.cacheWriteCalibrationDeltaTokens).toBe(0)
  })

  it('reports unavailable exactly when the kernel has no authoritative usage for the session', () => {
    expect(readoutTokensFromAccounting(unavailableTokenAccounting('claude-code', 'no usage'))).toEqual(unavailableReadoutTokens())
    expect(readoutTokensFromAccounting(null)).toEqual(unavailableReadoutTokens())
    expect(readoutTokensFromAccounting(undefined)).toEqual(unavailableReadoutTokens())
  })

  it('surfaces the registered Claude cache-write calibration difference (token-accounting.ts:554-568)', () => {
    // A request whose 5m/1h breakdown disagrees with the raw aggregate: Swob bills the breakdown (600),
    // but rawCacheWriteTokens keeps the aggregate (1000) — the 400 gap is the known, already-warned one.
    const accounting = accountingFromUsageEvents('claude-code', [
      usageEvent({
        dedupKey: 'breakdown', billingFactKey: 'fact-breakdown', rawCacheWriteTokens: 1000,
        components: { nonCachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 400, cacheWrite1hTokens: 200, outputTokens: 0 },
        warnings: ['cache creation aggregate 1000 differs from 5m/1h breakdown 600']
      })
    ])
    const result = readoutTokensFromAccounting(accounting)
    expect(result.cacheWriteCalibrationDeltaTokens).toBe(400)
    expect(result.components!.cacheWrite).toBe(600)
  })

  it('never attributes a Codex cache-write difference to the Claude calibration delta', () => {
    // Codex's own clamping (normalizeCodexSnapshot) can also make rawCacheWriteTokens differ from the
    // billed component, but for an unrelated reason: it must not be counted as the Claude calibration gap.
    const accounting = accountingFromUsageEvents('codex', [
      usageEvent({
        provider: 'codex', dedupKey: 'codex-1', rawCacheWriteTokens: 5,
        components: { nonCachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 3, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0 }
      })
    ])
    expect(readoutTokensFromAccounting(accounting).cacheWriteCalibrationDeltaTokens).toBe(0)
  })
})
