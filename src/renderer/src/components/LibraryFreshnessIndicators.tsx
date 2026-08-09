import { AlertTriangle, Database } from 'lucide-react'
import { useT } from '../i18n'
import { useLibraryHealth } from '../hooks/useLibraryHealth'

/** Contextual stale evidence stays next to the search/insight/share result it qualifies. */
export function StaleDisclaimer({ variant }: { variant: 'search' | 'insights' | 'share' }) {
  const t = useT()
  const health = useLibraryHealth()
  const freshness = health.dimensions.activeSourceFreshness
  if (freshness.state === 'durable') return null

  if (variant === 'share') {
    return <span className="text-[10px] text-soft-amber">{t('health.share_stale')}</span>
  }

  const key = variant === 'search' ? 'health.search_disclaimer' : 'health.insights_disclaimer'
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-soft-amber px-1 py-0.5 rounded bg-soft-amber/5">
      <Database size={10} className="shrink-0" />
      <span>{t(`${key}_unknown`)}</span>
    </div>
  )
}

/** Per-session freshness is local context, not a global application alarm. */
export function SessionStaleIndicator({ lagMs }: { lagMs: number | null }) {
  const t = useT()
  if (lagMs === null || lagMs < 60_000) return null

  const lagSeconds = lagMs / 1000
  const lagText = lagSeconds < 3600
    ? t('health.stale_minutes', { n: Math.round(lagSeconds / 60) })
    : t('health.stale_hours', { n: Math.round(lagSeconds / 3600) })
  return (
    <span className="text-soft-amber shrink-0" title={`${t('health.session_stale')} (${lagText})`}>
      <AlertTriangle size={10} />
    </span>
  )
}
