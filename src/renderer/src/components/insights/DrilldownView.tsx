import { translate } from '../../i18n'
import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../../store'
import { useAnalysisScope } from './scope'
import { formatTokenCount } from './shared'
import type { AnalysisDimension, InsightsDrilldownSession } from '../../../../shared/analysis-scope-types'

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
  const sessions = useStore((s) => s.sessions)
  const selectSession = useStore((s) => s.selectSession)
  const setWorkspaceView = useStore((s) => s.setWorkspaceView)

  const [state, setState] = useState<DrilldownState>({
    level: 'sessions',
    dimension,
    dimensionLabel,
    key: itemKey,
    keyLabel: itemLabel,
  })

  const [sessionList, setSessionList] = useState<InsightsDrilldownSession[]>([])
  const [loading, setLoading] = useState(true)
  const [coverage, setCoverage] = useState<{ covered: number; total: number } | null>(null)

  // Fetch session list for level 2
  useEffect(() => {
    if (state.level !== 'sessions') return
    let cancelled = false
    setLoading(true)
    api.drilldownInsights(scope, state.dimension, state.key)
      .then((result: { sessions: InsightsDrilldownSession[]; coverage: { covered: number; total: number } }) => {
        if (cancelled) return
        setSessionList(result.sessions ?? [])
        setCoverage(result.coverage ?? null)
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

  const handleSessionClick = useCallback((sessionId: string) => {
    if (state.level !== 'sessions') return
    // Navigate to the session in the main session list
    const summary = sessions.find((s) => s.sessionId === sessionId)
    if (summary) {
      setWorkspaceView('chat') // close insights
      selectSession(summary.filePath, summary.allFilePaths, summary.id)
    }
  }, [sessions, selectSession, setWorkspaceView, state])

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
            <div className="grid grid-cols-[1fr_80px_60px_60px_60px_100px] gap-2 px-2 py-1 text-[10px] text-faint border-b border-edge">
              <span>Session</span>
              <span className="text-right">Tokens</span>
              <span className="text-right">Calls</span>
              <span className="text-right">Turns</span>
              <span>Source</span>
              <span>Time</span>
            </div>
            {sessionList.map((s) => {
              const displayProject = s.projectPath
                ? s.projectPath.split('/').pop() || s.projectPath
                : '—'
              const firstTime = s.firstOccurredAt
                ? new Date(s.firstOccurredAt).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '—'
              return (
                <button
                  key={s.sessionId}
                  onClick={() => handleSessionClick(s.sessionId)}
                  className="w-full grid grid-cols-[1fr_80px_60px_60px_60px_100px] gap-2 px-2 py-1.5 text-xs hover:bg-hover rounded transition-colors text-left"
                >
                  <span className="text-primary truncate" title={s.sessionId}>
                    {displayProject}
                    <span className="text-faint ml-1">{s.sessionId.slice(0, 8)}</span>
                  </span>
                  <span className="text-muted text-right">{formatTokenCount(s.processedTokens)}</span>
                  <span className="text-muted text-right">{s.calls}</span>
                  <span className="text-muted text-right">{s.turns}</span>
                  <span className="text-muted truncate">{s.sourceClient}</span>
                  <span className="text-faint truncate">{firstTime}</span>
                </button>
              )
            })}
          </div>
        )
      )}
    </div>
  )
}
