import { describe, expect, it } from 'vitest'
import { getPricingLabel } from './pricing-label'
import type { Valuation } from '../components/insights/shared'

function base(): Valuation {
  return {
    usd: 1.00,
    mode: 'provider-billed',
    pricingMatch: 'reported',
    ledgerBreakdown: { providerBilledUsd: 1.00 },
    coveredTokens: 100_000,
    totalBillableTokens: 100_000,
    coveragePercent: 100,
    financialCoveredTokens: 100_000,
    financialCoveragePercent: 100,
    missingReasons: [],
    pricingRules: [],
    priceRevision: 'v1',
    priceSnapshotHash: 'abc',
    priceRevisions: ['v1'],
    revisionNotices: [],
    modeBreakdown: { 'provider-billed': 1.00 },
  }
}

describe('getPricingLabel', () => {
  it('returns exact when provider-billed, reported match, 100% coverage, no missing', () => {
    expect(getPricingLabel(base())).toBe('exact')
  })

  it('returns exact when pricingMatch is exact (not just reported)', () => {
    expect(getPricingLabel({ ...base(), pricingMatch: 'exact' })).toBe('exact')
  })

  it('returns unpriced when usd is undefined', () => {
    const v = { ...base(), usd: undefined }
    expect(getPricingLabel(v)).toBe('unpriced')
  })

  it('returns unpriced when mode is unpriced', () => {
    expect(getPricingLabel({ ...base(), mode: 'unpriced' })).toBe('unpriced')
  })

  it('returns mixed when mode is mixed', () => {
    expect(getPricingLabel({ ...base(), mode: 'mixed' })).toBe('mixed')
  })

  it('returns mixed when pricingMatch is mixed', () => {
    expect(getPricingLabel({ ...base(), pricingMatch: 'mixed' })).toBe('mixed')
  })

  it('returns partial when coverage < 100%', () => {
    expect(getPricingLabel({ ...base(), coveragePercent: 85, missingReasons: ['aggregate-unpriced-tokens'] })).toBe('partial')
  })

  it('returns estimate for swob-estimate with full coverage', () => {
    expect(getPricingLabel({ ...base(), mode: 'swob-estimate', pricingMatch: 'alias' })).toBe('estimate')
  })

  it('returns estimate for harness-list-estimate with full coverage', () => {
    expect(getPricingLabel({ ...base(), mode: 'harness-list-estimate', pricingMatch: 'alias' })).toBe('estimate')
  })

  it('does NOT return exact when provider-billed but has missingReasons', () => {
    expect(getPricingLabel({ ...base(), missingReasons: ['model-not-in-catalog'] })).not.toBe('exact')
  })

  it('does NOT return exact when provider-billed but coverage < 100', () => {
    expect(getPricingLabel({ ...base(), coveragePercent: 99 })).not.toBe('exact')
  })

  it('does NOT return exact when pricingMatch is alias (even if provider-billed)', () => {
    expect(getPricingLabel({ ...base(), pricingMatch: 'alias' })).toBe('estimate')
  })

  it('returns subscription for subscription-allocated mode', () => {
    expect(getPricingLabel({
      ...base(),
      mode: 'subscription-allocated',
      pricingMatch: 'alias',
      ledgerBreakdown: { subscriptionAllocatedUsd: 1.00 },
      modeBreakdown: { 'subscription-allocated': 1.00 },
    })).toBe('subscription')
  })
})
