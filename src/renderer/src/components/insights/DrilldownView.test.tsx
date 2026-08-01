/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageFact, UsageFactPage } from '../../../../shared/analysis-scope-types'
import { DrilldownView } from './DrilldownView'

const store = vi.hoisted(() => ({
  state: { locale: 'zh-CN', openSession: vi.fn() }
}))

vi.mock('../../store', () => ({
  useStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))

function fact(eventId: string, model: string): UsageFact {
  return {
    eventId,
    billingFactId: eventId,
    billingIncluded: true,
    occurredAt: '2026-08-01T10:00:00.000Z',
    occurredDay: '2026-08-01',
    occurredHour: 18,
    sourceClient: 'codex',
    sessionId: 'large-session',
    rootSessionId: 'large-session',
    agentScope: 'main',
    projectPath: '/repo/swob',
    model,
    modelRaw: model,
    modelProvenance: 'provider',
    nonCachedInputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    usageProvenance: 'reported',
    callCount: 1,
    turnCount: 1,
    costUsd: 0.001,
    pricingProvenance: 'catalog',
    pricedTokens: 2,
    billableTokens: 2,
    financialCoveredTokens: 0,
    costLedgers: { swobEstimateUsd: 0.001 },
    priceRevision: 'test-revision',
    priceSnapshotHash: 'a'.repeat(64),
    pricingTrace: [],
    valuationHistory: []
  }
}

function page(events: UsageFact[], offset: number, total: number): UsageFactPage {
  return { events, offset, limit: 100, total, hasMore: offset + events.length < total }
}

describe('DrilldownView event pagination', () => {
  beforeEach(() => {
    store.state.openSession.mockReset()
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      drilldownInsights: vi.fn().mockResolvedValue([{
        sessionId: 'large-session',
        rootSessionId: 'large-session',
        sourceClient: 'codex',
        projectPath: '/repo/swob',
        models: ['gpt-page-1'],
        processedTokens: 2,
        billingTokens: 2,
        conversationTokens: 2,
        calls: 2,
        turns: 2,
        firstOccurredAt: '2026-08-01T10:00:00.000Z',
        lastOccurredAt: '2026-08-01T10:00:00.000Z',
        usageProvenance: ['reported']
      }]),
      getInsightSessionEvents: vi.fn()
        .mockResolvedValueOnce(page([fact('event-1', 'gpt-page-1')], 0, 2))
        .mockResolvedValueOnce(page([fact('event-2', 'gpt-page-2')], 1, 2))
    }
  })

  afterEach(cleanup)

  it('loads a bounded first page and appends subsequent audit events', async () => {
    render(
      <DrilldownView
        onClose={vi.fn()}
        dimension="global"
        dimensionLabel="成本账本"
        itemKey="global"
        itemLabel="查看逐调用账本"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: '审计账本' }))
    await screen.findByText('gpt-page-1')
    expect(window.api.getInsightSessionEvents).toHaveBeenLastCalledWith(
      'large-session',
      { range: '7d', metricBasis: 'billing' },
      { offset: 0, limit: 100 }
    )
    expect(screen.getByText(/1\/2/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '加载更多' }))
    await screen.findByText('gpt-page-2')
    await waitFor(() => expect(screen.getByText(/2\/2/)).toBeTruthy())
    expect(window.api.getInsightSessionEvents).toHaveBeenLastCalledWith(
      'large-session',
      { range: '7d', metricBasis: 'billing' },
      { offset: 1, limit: 100 }
    )
  })

  it('does not misreport a transport failure as an empty ledger', async () => {
    vi.mocked(window.api.getInsightSessionEvents)
      .mockReset()
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValueOnce(page([fact('event-retry', 'gpt-after-retry')], 0, 1))
    render(
      <DrilldownView
        onClose={vi.fn()}
        dimension="global"
        dimensionLabel="成本账本"
        itemKey="global"
        itemLabel="查看逐调用账本"
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: '审计账本' }))
    expect(await screen.findByText('计费事件加载失败，请重试')).toBeTruthy()
    expect(screen.queryByText('无匹配计费事件')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('gpt-after-retry')).toBeTruthy()
  })
})
