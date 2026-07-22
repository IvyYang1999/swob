/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AnalysisScope,
  DashboardAnalysisDimension,
  InsightsQueryBundleResult,
  InsightsQueryResult,
  UsageAggregate
} from '../../../../shared/analysis-scope-types'
import { InsightsPage } from './InsightsPage'

const store = vi.hoisted(() => ({
  state: {
    config: { preferences: { projectViewMode: 'folders' } },
    sessions: [] as Array<Record<string, unknown>>,
    locale: 'zh-CN'
  }
}))

vi.mock('../../store', () => ({
  useStore: (selector: (state: typeof store.state) => unknown) => selector(store.state)
}))

vi.mock('./FilterBar', async () => {
  const { useContext } = await import('react')
  const { ScopeContext } = await import('./scope')
  return {
    FilterBar: () => {
      const { scope, setScope } = useContext(ScopeContext)
      return <button onClick={() => setScope({ ...scope, range: '30d' })}>change scope</button>
    }
  }
})

vi.mock('./DrilldownView', () => ({ DrilldownView: () => null }))
vi.mock('../../registry/builtin-widget-registry', () => ({
  DashboardPageWidgets: ({ context }: { context: { data: { totalTokens: number } } }) =>
    <div data-testid="total-tokens">{context.data.totalTokens}</div>
}))

function aggregate(tokens: number): UsageAggregate {
  return {
    key: 'global',
    label: 'All',
    nonCachedInputTokens: tokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    processedTokens: tokens,
    billingTokens: tokens,
    conversationTokens: tokens,
    calls: 1,
    turns: 1,
    eventCount: 1,
    sessionCount: 1,
    detectedSessionCount: 1,
    parsedSessionCount: 1,
    usageAvailableSessionCount: 1,
    usageUnavailableSessionCount: 0,
    usageCoverage: { covered: 1, total: 1, percent: 100 },
    modelCoverage: { covered: 1, total: 1, percent: 100 },
    pricingCoverage: { covered: 0, total: tokens, percent: 0, status: 'pending-t113' },
    costUsd: null,
    unknownTimeEvents: 0
  }
}

function bundle(tokens: number, scope: AnalysisScope): InsightsQueryBundleResult {
  const total = aggregate(tokens)
  const dimensions: DashboardAnalysisDimension[] = ['global', 'time', 'hour', 'source', 'model', 'project', 'session']
  const results = {} as Record<DashboardAnalysisDimension, InsightsQueryResult>
  for (const dimension of dimensions) {
    results[dimension] = {
      schemaVersion: 1,
      scope,
      dimension,
      range: { fromDay: null, toDay: null, label: 'All time' },
      items: dimension === 'global' ? [total] : [],
      total,
      previousPeriod: null,
      quality: { unknownTimeEvents: 0, lastIndexedAt: '2026-07-23T00:00:00.000Z' }
    }
  }
  return { schemaVersion: 1, usageRevision: String(tokens), scope, results }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('InsightsPage query lifecycle', () => {
  beforeEach(() => {
    store.state.sessions = []
    const scope: AnalysisScope = { range: '7d', metricBasis: 'billing' }
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dashboardLoadLayout: vi.fn().mockRejectedValue(new Error('use default')),
      queryInsightsBundle: vi.fn().mockResolvedValue(bundle(42, scope))
    }
  })

  afterEach(cleanup)

  it('does not requery the database when only the sessions array identity changes', async () => {
    const view = render(<InsightsPage />)
    await screen.findByText('42')
    expect(window.api.queryInsightsBundle).toHaveBeenCalledTimes(1)

    store.state.sessions = [{ id: 'new-shell', sessionId: 'new-shell' }]
    view.rerender(<InsightsPage />)

    await waitFor(() => expect(screen.getByTestId('total-tokens').textContent).toBe('42'))
    expect(window.api.queryInsightsBundle).toHaveBeenCalledTimes(1)
  })

  it('keeps existing content mounted while a new scope is loading', async () => {
    const next = deferred<InsightsQueryBundleResult>()
    const initialScope: AnalysisScope = { range: '7d', metricBasis: 'billing' }
    const nextScope: AnalysisScope = { range: '30d', metricBasis: 'billing' }
    vi.mocked(window.api.queryInsightsBundle)
      .mockResolvedValueOnce(bundle(42, initialScope))
      .mockImplementationOnce(() => next.promise)

    render(<InsightsPage />)
    await screen.findByText('42')
    fireEvent.click(screen.getByRole('button', { name: 'change scope' }))

    await screen.findByText('正在更新数据')
    expect(screen.getByTestId('total-tokens').textContent).toBe('42')

    await act(async () => next.resolve(bundle(7, nextScope)))
    await waitFor(() => expect(screen.getByTestId('total-tokens').textContent).toBe('7'))
    expect(window.api.queryInsightsBundle).toHaveBeenCalledTimes(2)
  })
})
