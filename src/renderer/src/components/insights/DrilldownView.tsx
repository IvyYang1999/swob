import { translate } from '../../i18n'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useStore } from '../../store'
import { useAnalysisScope } from './scope'
import { formatTokenCount } from './shared'
import type {
  AnalysisDimension,
  InsightsDrilldownSession,
  UsageFact,
  UsageFactPage
} from '../../../../shared/analysis-scope-types'

const USAGE_EVENT_PAGE_SIZE = 100

type DrilldownState =
  | { level: 'overview' }
  | {
      level: 'sessions'
      dimension: AnalysisDimension
      dimensionLabel: string
      key: string
      keyLabel: string
    }
  | {
      level: 'session-detail'
      dimension: AnalysisDimension
      dimensionLabel: string
      key: string
      keyLabel: string
      sessionId: string
    }

interface DrilldownViewProps {
  onClose: () => void
  dimension: AnalysisDimension
  dimensionLabel: string
  itemKey: string
  itemLabel: string
}

export function DrilldownView({ onClose, dimension, dimensionLabel, itemKey, itemLabel }: DrilldownViewProps) {
  const api = (window as any).api
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const { scope } = useAnalysisScope()
  const openSession = useStore((s) => s.openSession)

  const [state, setState] = useState<DrilldownState>({
    level: 'sessions',
    dimension,
    dimensionLabel,
    key: itemKey,
    keyLabel: itemLabel,
  })

  const [sessionList, setSessionList] = useState<InsightsDrilldownSession[]>([])
  const [usageEvents, setUsageEvents] = useState<UsageFact[]>([])
  const [usageEventPage, setUsageEventPage] = useState<UsageFactPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [eventLoadError, setEventLoadError] = useState(false)
  const [eventRetryRevision, setEventRetryRevision] = useState(0)
  const [coverage, setCoverage] = useState<{ covered: number; total: number } | null>(null)
  const eventRequestGeneration = useRef(0)

  // Fetch session list for level 2
  useEffect(() => {
    if (state.level !== 'sessions') return
    let cancelled = false
    setLoading(true)
    api.drilldownInsights(scope, state.dimension, state.key)
      .then((result: InsightsDrilldownSession[] | {
        sessions: InsightsDrilldownSession[]
        coverage?: { covered: number; total: number }
      }) => {
        if (cancelled) return
        setSessionList(Array.isArray(result) ? result : result.sessions ?? [])
        setCoverage(Array.isArray(result) ? null : result.coverage ?? null)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) {
          setSessionList([])
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [state.level === 'sessions' ? `${(state as any).dimension}:${(state as any).key}` : '', scope])

  useEffect(() => {
    if (state.level !== 'session-detail') return
    const generation = ++eventRequestGeneration.current
    let cancelled = false
    setLoading(true)
    setLoadingMore(false)
    setEventLoadError(false)
    setUsageEvents([])
    setUsageEventPage(null)
    api.getInsightSessionEvents(state.sessionId, scope, { offset: 0, limit: USAGE_EVENT_PAGE_SIZE })
      .then((page: UsageFactPage) => {
        if (cancelled || generation !== eventRequestGeneration.current) return
        setUsageEvents(page.events ?? [])
        setUsageEventPage(page)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled || generation !== eventRequestGeneration.current) return
        setEventLoadError(true)
        setLoading(false)
      })
    return () => {
      cancelled = true
      eventRequestGeneration.current += 1
    }
  }, [state.level === 'session-detail' ? (state as any).sessionId : '', scope, eventRetryRevision])

  const loadMoreUsageEvents = useCallback(async () => {
    if (state.level !== 'session-detail' || !usageEventPage?.hasMore || loadingMore) return
    const generation = eventRequestGeneration.current
    setLoadingMore(true)
    setEventLoadError(false)
    try {
      const page = await api.getInsightSessionEvents(state.sessionId, scope, {
        offset: usageEventPage.offset + usageEventPage.events.length,
        limit: USAGE_EVENT_PAGE_SIZE
      }) as UsageFactPage
      if (generation !== eventRequestGeneration.current) return
      setUsageEvents((current) => {
        const known = new Set(current.map((event) => event.eventId))
        return [...current, ...page.events.filter((event) => !known.has(event.eventId))]
      })
      setUsageEventPage(page)
    } catch {
      if (generation === eventRequestGeneration.current) setEventLoadError(true)
    } finally {
      if (generation === eventRequestGeneration.current) setLoadingMore(false)
    }
  }, [api, loadingMore, scope, state, usageEventPage])

  const handleSessionClick = useCallback((sessionId: string) => {
    if (state.level !== 'sessions') return
    openSession(sessionId)
  }, [openSession, state])

  const handleAuditClick = useCallback((sessionId: string) => {
    if (state.level !== 'sessions') return
    setState({ ...state, level: 'session-detail', sessionId })
  }, [state])

  const breadcrumbs = (() => {
    const crumbs: Array<{ label: string; onClick?: () => void }> = [
      { label: translate(zh ? 'zh-CN' : 'en', 'renderer.drilldown_view.overview'), onClick: onClose },
    ]
    if (state.level === 'sessions' || state.level === 'session-detail') {
      crumbs.push({
        label: `${state.dimensionLabel}: ${state.keyLabel}`,
        onClick: state.level === 'session-detail' ? () => setState({
          level: 'sessions',
          dimension: state.dimension,
          dimensionLabel: state.dimensionLabel,
          key: state.key,
          keyLabel: state.keyLabel,
        }) : undefined,
      })
    }
    if (state.level === 'session-detail') crumbs.push({ label: state.sessionId.slice(0, 8) })
    return crumbs
  })()

  return (
    <div className="bg-surface rounded-lg border border-edge p-4 space-y-3">
      {/* Breadcrumb */}
      <div className="flex items-center justify-between gap-2">
        <nav className="flex items-center gap-1 text-xs">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-faint">/</span>}
              {crumb.onClick ? (
                <button onClick={crumb.onClick} className="text-accent hover:underline">
                  {crumb.label}
                </button>
              ) : (
                <span className="text-primary font-medium">{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
        {coverage && (
          <span className="text-[10px] text-muted shrink-0">
            {coverage.covered}/{coverage.total} {translate(zh ? 'zh-CN' : 'en', 'renderer.drilldown_view.covered')}
          </span>
        )}
      </div>

      {/* Session list (Level 2) */}
      {state.level === 'sessions' && (
        loading ? (
          <div className="text-xs text-muted py-4 text-center">Loading...</div>
        ) : sessionList.length === 0 ? (
          <div className="text-xs text-muted py-4 text-center">
            {translate(zh ? 'zh-CN' : 'en', 'renderer.drilldown_view.no_matching_sessions')}
          </div>
        ) : (
          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {/* Header */}
            <div className="grid grid-cols-[minmax(120px,1fr)_72px_44px_44px_60px_96px_72px] gap-2 px-2 py-1 text-[10px] text-faint border-b border-edge">
              <span>Session</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Calls</span>
              <span className="text-right">Turns</span>
              <span>Source</span>
              <span>Time</span>
              <span />
            </div>
            {sessionList.map((s) => {
              const displayProject = s.projectPath
                ? s.projectPath.split('/').pop() || s.projectPath
                : '—'
              const firstTime = s.firstOccurredAt
                ? new Date(s.firstOccurredAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '—'
              return (
                <div
                  key={s.sessionId}
                  className="grid grid-cols-[minmax(120px,1fr)_72px_44px_44px_60px_96px_72px] items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-hover"
                >
                  <button
                    type="button"
                    onClick={() => handleSessionClick(s.sessionId)}
                    className="truncate text-left text-primary hover:text-accent"
                    title={translate(locale, 'renderer.drilldown_view.open_session')}
                  >
                    {displayProject}
                    <span className="text-faint ml-1">{s.sessionId.slice(0, 8)}</span>
                  </button>
                  <span className="text-muted text-right">{formatTokenCount(s.processedTokens)}</span>
                  <span className="text-muted text-right">{s.calls}</span>
                  <span className="text-muted text-right">{s.turns}</span>
                  <span className="text-muted truncate">{s.sourceClient}</span>
                  <span className="text-faint truncate">{firstTime}</span>
                  <button
                    type="button"
                    onClick={() => handleAuditClick(s.sessionId)}
                    className="text-right text-[10px] font-medium text-accent hover:underline"
                  >
                    {translate(locale, 'renderer.drilldown_view.audit_ledger')}
                  </button>
                </div>
              )
            })}
          </div>
        )
      )}

      {state.level === 'session-detail' && (
        loading ? (
          <div className="py-4 text-center text-xs text-muted">Loading...</div>
        ) : eventLoadError && usageEvents.length === 0 ? (
          <div className="space-y-2 py-4 text-center text-xs text-muted">
            <div>{translate(locale, 'renderer.drilldown_view.load_failed')}</div>
            <button type="button" onClick={() => setEventRetryRevision((revision) => revision + 1)} className="text-accent hover:underline">
              {translate(locale, 'renderer.drilldown_view.retry')}
            </button>
          </div>
        ) : usageEvents.length === 0 ? (
          <div className="py-4 text-center text-xs text-muted">
            {translate(locale, 'renderer.drilldown_view.no_usage_events')}
          </div>
        ) : (
          <div className="max-h-[520px] space-y-2 overflow-y-auto pr-1">
            {usageEvents.map((event) => {
              const ledgers = [
                [translate(locale, 'renderer.cost_card.provider_billed'), event.costLedgers.providerBilledUsd],
                [translate(locale, 'renderer.cost_card.harness_estimate'), event.costLedgers.harnessListEstimateUsd],
                [translate(locale, 'renderer.cost_card.swob_estimate'), event.costLedgers.swobEstimateUsd],
                [translate(locale, 'renderer.cost_card.subscription_allocated'), event.costLedgers.subscriptionAllocatedUsd]
              ] as const
              return (
                <article key={event.eventId} className="space-y-2 rounded border border-edge bg-base/30 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium text-primary">
                        {event.model || event.modelRaw || 'unknown-model'}
                      </div>
                      <div className="text-[10px] text-faint">
                        {event.occurredAt ? new Date(event.occurredAt).toLocaleString(locale) : 'unknown-time'}
                      </div>
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[10px] ${
                      event.billingIncluded
                        ? 'bg-soft-emerald/10 text-soft-emerald'
                        : 'bg-soft-amber/10 text-soft-amber'
                    }`}>
                      {translate(locale, event.billingIncluded
                        ? 'renderer.drilldown_view.counted'
                        : 'renderer.drilldown_view.deduplicated_copy')}
                    </span>
                  </div>

                  <div className="grid gap-x-4 gap-y-1 text-[10px] sm:grid-cols-2">
                    {ledgers.filter(([, amount]) => amount !== undefined).map(([label, amount]) => (
                      <div key={label} className="flex justify-between gap-2">
                        <span className="text-muted">{label}</span>
                        <span className="font-medium tabular-nums text-primary">${amount!.toFixed(6)}</span>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-0.5 border-t border-edge pt-2 text-[10px]">
                    <div className="flex justify-between gap-3">
                      <span className="text-muted">{translate(locale, 'renderer.drilldown_view.price_revision')}</span>
                      <span className="truncate font-mono text-primary" title={event.priceRevision}>{event.priceRevision}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-muted">{translate(locale, 'renderer.drilldown_view.snapshot_hash')}</span>
                      <span className="truncate font-mono text-faint" title={event.priceSnapshotHash}>{event.priceSnapshotHash.slice(0, 16)}…</span>
                    </div>
                  </div>

                  {event.pricingTrace.flatMap((trace) => trace.calculation.map((line) => (
                    <div key={`${trace.pricingRuleId}:${line.component}`} className="flex flex-wrap justify-between gap-2 text-[10px]">
                      <span className="text-muted">{translate(locale, 'renderer.drilldown_view.calculation')} · {line.component}</span>
                      <span className="font-mono text-secondary">
                        {formatTokenCount(line.tokens)} × ${line.usdPerMillion}/M × {line.multiplier} = ${line.usd.toFixed(6)}
                      </span>
                    </div>
                  )))}

                  {event.revisionNotice && (
                    <div className="rounded border border-soft-amber/25 bg-soft-amber/5 px-2 py-1 text-[10px] text-soft-amber">
                      {event.revisionNotice.notice[locale] || event.revisionNotice.notice.en}
                      {' · '}{event.valuationHistory.map((item) => item.priceRevision).join(' → ')}
                    </div>
                  )}
                </article>
              )
            })}
            <div className="sticky bottom-0 flex items-center justify-center gap-3 border-t border-edge bg-surface/95 py-2 text-[10px] text-muted backdrop-blur-sm">
              <span>
                {translate(locale, 'renderer.drilldown_view.showing_events')}
                {' '}{usageEvents.length}/{usageEventPage?.total ?? usageEvents.length}
              </span>
              {usageEventPage?.hasMore && (
                <button
                  type="button"
                  onClick={loadMoreUsageEvents}
                  disabled={loadingMore}
                  className="font-medium text-accent hover:underline disabled:cursor-wait disabled:opacity-60"
                >
                  {loadingMore
                    ? translate(locale, 'renderer.drilldown_view.loading_more')
                    : translate(locale, 'renderer.drilldown_view.load_more')}
                </button>
              )}
              {eventLoadError && usageEvents.length > 0 && (
                <span className="text-soft-amber">{translate(locale, 'renderer.drilldown_view.load_failed')}</span>
              )}
            </div>
          </div>
        )
      )}
    </div>
  )
}
