/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CostCard } from './CostCard'
import { PricingTraceCard } from './PricingTraceCard'
import type { Valuation } from './shared'

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

  it('exposes price revision and call-ledger drilldown', () => {
    const onOpenAudit = vi.fn()
    render(<PricingTraceCard valuation={valuation()} onOpenAudit={onOpenAudit} />)

    expect(screen.getByText(/official-snapshot-2026-08-01\.v2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看逐调用账本' }))
    expect(onOpenAudit).toHaveBeenCalledOnce()
  })
})
