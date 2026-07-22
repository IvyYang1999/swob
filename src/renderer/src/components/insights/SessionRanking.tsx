import { translate } from '../../i18n'
import { useMemo } from 'react'
import { useStore } from '../../store'
import { useAnalysisScope } from './scope'
import { SOURCE_COLORS, formatTokenCount, type InsightsData } from './shared'

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil((sorted.length * p) / 100) - 1
  return sorted[Math.max(0, index)]
}

function projectTail(projectPath: string): string {
  const tail = projectPath.split('/').filter(Boolean).pop()
  return tail || projectPath || '—'
}

/** Top sessions by the active basis, plus distribution chips (P50/P90/P95). */
export function SessionRanking({ data }: { data: InsightsData }) {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const { scope } = useAnalysisScope()
  const sessions = useStore((s) => s.sessions)
  const selectSession = useStore((s) => s.selectSession)

  const openSession = (sessionId: string): void => {
    const session = sessions.find((item) => item.id === sessionId || item.sessionId === sessionId)
    if (session) void selectSession(session.filePath, session.allFilePaths, session.id)
  }

  const { ranked, p50, p90, p95, measured } = useMemo(() => {
    const value = (s: InsightsData['bySession'][number]): number | null =>
      scope.metricBasis === 'conversation' ? s.conversationOnlyTokens : s.totalTokens
    const withTokens = data.bySession
      .map((session) => ({ session, tokens: value(session) }))
      .filter((item): item is { session: InsightsData['bySession'][number]; tokens: number } =>
        item.tokens !== null && item.tokens > 0)
    const sortedValues = withTokens.map((item) => item.tokens).sort((a, b) => a - b)
    return {
      ranked: [...withTokens].sort((a, b) => b.tokens - a.tokens).slice(0, 12),
      p50: percentile(sortedValues, 50),
      p90: percentile(sortedValues, 90),
      p95: percentile(sortedValues, 95),
      measured: withTokens.length
    }
  }, [data.bySession, scope.metricBasis])

  const max = ranked[0]?.tokens || 1

  if (measured === 0) {
    return <div className="text-[11px] text-muted">{translate(zh ? 'zh-CN' : 'en', 'renderer.session_ranking.no_sessions_with_authoritative_usage')}</div>
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        {([['P50', p50], ['P90', p90], ['P95', p95]] as const).map(([label, value]) => (
          <span key={label} className="rounded bg-hover px-1.5 py-0.5 text-secondary">
            {label} {formatTokenCount(value)}
          </span>
        ))}
        <span className="rounded bg-hover px-1.5 py-0.5 text-faint">
          {translate(zh ? 'zh-CN' : 'en', 'renderer.session_ranking.value_measured_sessions', { value0: measured })}
        </span>
      </div>

      <div className="space-y-1">
        {ranked.map(({ session, tokens }) => (
          <button
            key={session.sessionId}
            onClick={() => openSession(session.sessionId)}
            className="group block w-full text-left"
            title={session.projectPath}
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: SOURCE_COLORS[session.source] || '#6b7280' }}
              />
              <span className="w-28 shrink-0 truncate text-secondary group-hover:text-primary">
                {projectTail(session.projectPath)}
              </span>
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-hover">
                <div
                  className="h-full rounded bg-soft-blue/70"
                  style={{ width: `${(tokens / max) * 100}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-medium text-primary">{formatTokenCount(tokens)}</span>
              {session.valuation.coveragePercent < 100 && (
                <span
                  className="shrink-0 text-[9px] text-soft-amber"
                  title={translate(zh ? 'zh-CN' : 'en', 'renderer.session_ranking.some_tokens_are_unpriced')}
                >
                  {session.valuation.coveragePercent.toFixed(0)}%
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
