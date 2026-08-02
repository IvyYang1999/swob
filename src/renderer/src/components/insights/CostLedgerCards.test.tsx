/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CostCard } from './CostCard'
import { PricingTraceCard } from './PricingTraceCard'
import type { Valuation } from './shared'
import { valuationCapabilityForSource } from '../../../../shared/provider-capabilities'

vi.mock('../../store', () => ({
  useStore: (selector: (state: { locale: 'zh-CN' }) => unknown) => selector({ locale: 'zh-CN' })
}))

afterEach(cleanup)

function valuation(): Valuation {
  return {
    usd: 0.14,
    mode: 'mixed',
    pricingMatch: 'exact',
    ledgerBreakdown: {
      providerBilledUsd: 0.12,
      harnessListEstimateUsd: 0.7,
      swobEstimateUsd: 0.14,
      subscriptionAllocatedUsd: 0.08
    },
    coveredTokens: 200_000,
    totalBillableTokens: 200_000,
    coveragePercent: 100,
    financialCoveredTokens: 200_000,
    financialCoveragePercent: 100,
    missingReasons: [],
    pricingRules: [],
    priceRevision: 'official-snapshot-2026-08-01.v2',
    priceSnapshotHash: '6745f57f',
    priceRevisions: ['official-snapshot-2026-08-01.v2'],
    revisionNotices: [{
      revision: 'official-snapshot-2026-08-01.v2',
      notice: { 'zh-CN': '因官方价格目录更新而修订', en: 'Revised after an official pricing catalog update' }
    }],
    modeBreakdown: {
      'provider-billed': 0.12,
      'harness-list-estimate': 0.7,
      'swob-estimate': 0.14,
      'subscription-allocated': 0.08
    }
  }
}

describe('auditable cost ledger cards', () => {
  it('shows all ledgers without calling estimates actual spend', () => {
    render(<CostCard valuation={valuation()} cacheRead={50_000} cacheCreate={10_000} totalInput={100_000} />)

    expect(screen.getByText('Provider 实际账单')).toBeTruthy()
    expect(screen.getByText('Harness 标价估算')).toBeTruthy()
    expect(screen.getByText('Swob API 等价值')).toBeTruthy()
    expect(screen.getByText('订阅摊销')).toBeTruthy()
    expect(screen.getByText('因官方价格目录更新而修订')).toBeTruthy()
    expect(screen.getByText('财务覆盖')).toBeTruthy()
  })

  it('shows mixed badge when mode is mixed, never exact', () => {
    render(<CostCard valuation={valuation()} cacheRead={50_000} cacheCreate={10_000} totalInput={100_000} />)

    // mode='mixed' must NOT produce an "exact" label even with 100% coverage
    expect(screen.getByText('混合')).toBeTruthy()
    expect(screen.queryByText('精确')).toBeNull()
  })

  it('shows exact badge only when provider-billed with full coverage', () => {
    const exact: Valuation = {
      ...valuation(),
      mode: 'provider-billed',
      pricingMatch: 'reported',
      modeBreakdown: { 'provider-billed': 0.14 },
      ledgerBreakdown: { providerBilledUsd: 0.14 },
    }
    render(<CostCard valuation={exact} cacheRead={50_000} cacheCreate={10_000} totalInput={100_000} />)
    expect(screen.getByText('精确')).toBeTruthy()
  })

  it('shows estimate badge for non-provider-billed full coverage', () => {
    const estimated: Valuation = {
      ...valuation(),
      mode: 'swob-estimate',
      pricingMatch: 'alias',
      modeBreakdown: { 'swob-estimate': 0.14 },
      ledgerBreakdown: { swobEstimateUsd: 0.14 },
    }
    render(<CostCard valuation={estimated} cacheRead={50_000} cacheCreate={10_000} totalInput={100_000} />)
    expect(screen.getByText('估算')).toBeTruthy()
    expect(screen.queryByText('精确')).toBeNull()
  })

  it('shows partial badge when coverage is below 100%', () => {
    const partial: Valuation = {
      ...valuation(),
      mode: 'provider-billed',
      pricingMatch: 'reported',
      coveragePercent: 72,
      modeBreakdown: { 'provider-billed': 0.10 },
      ledgerBreakdown: { providerBilledUsd: 0.10 },
      missingReasons: ['aggregate-unpriced-tokens'],
    }
    render(<CostCard valuation={partial} cacheRead={50_000} cacheCreate={10_000} totalInput={100_000} />)
    expect(screen.getByText('部分覆盖')).toBeTruthy()
    expect(screen.queryByText('精确')).toBeNull()
  })

  it('exposes price revision and call-ledger drilldown', () => {
    const onOpenAudit = vi.fn()
    render(<PricingTraceCard valuation={valuation()} onOpenAudit={onOpenAudit} />)

    expect(screen.getByText(/official-snapshot-2026-08-01\.v2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看逐调用账本' }))
    expect(onOpenAudit).toHaveBeenCalledOnce()
  })

  it('labels a measured source without an amount instead of rendering blank or zero', () => {
    const unpriced: Valuation = {
      ...valuation(),
      usd: undefined,
      mode: 'unpriced',
      pricingMatch: 'none',
      ledgerBreakdown: {},
      coveredTokens: 0,
      financialCoveredTokens: 0,
      coveragePercent: 0,
      financialCoveragePercent: 0,
      modeBreakdown: {}
    }
    render(
      <CostCard
        valuation={unpriced}
        cacheRead={0}
        cacheCreate={0}
        totalInput={120}
        sources={[{
          source: 'opencode',
          label: 'OpenCode',
          valuationCapability: valuationCapabilityForSource('opencode'),
          valuation: unpriced,
          totalTokens: 150,
          inputTokens: 120,
          outputTokens: 30,
          sessionCount: 1,
          turnCount: 1,
          tokenAvailableSessions: 1,
          tokenUnavailableSessions: 0,
          tokenDataStatus: 'available',
          tokenBreakdown: {
            nonCachedInputTokens: 120,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 30,
            reasoningTokens: 0,
          },
          costUsd: null,
          coveragePercent: null,
        }]}
      />
    )

    expect(screen.getByText('按来源计价')).toBeTruthy()
    expect(screen.getByText('OpenCode')).toBeTruthy()
    expect(screen.getByText('仅计量，未计价')).toBeTruthy()
    expect(screen.queryByText('$0.00')).toBeNull()
  })
})
