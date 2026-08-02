/**
 * tF32 R2: Global Library health status banner.
 *
 * Shows a persistent banner when the Library is NOT in `ready` state.
 * Cannot be permanently dismissed (data-trust requirement), but can be
 * collapsed to a small indicator badge.
 *
 * When compensation (catch-up) is in progress, the banner switches to
 * a progress display. On completion a toast is shown and the banner
 * disappears automatically once state returns to `ready`.
 *
 * Uses the canonical shared contract from t192 integrator.
 */
import { useState, useEffect, useRef } from 'react'
import { AlertTriangle, Info, Loader2, ChevronDown, ChevronUp, Database, X } from 'lucide-react'
import { useT } from '../i18n'
import {
  useLibraryHealth,
  retryCompensation,
  cancelCompensation,
  staleMinutes,
  type LibraryHealthState
} from '../hooks/useLibraryHealth'
import { useStore } from '../store'

// ---- Banner config per state ----

interface BannerConfig {
  icon: typeof AlertTriangle
  colorClasses: string
  messageKey: string
  stateKey: string
}

const BANNER_CONFIGS: Record<Exclude<LibraryHealthState, 'ready'>, BannerConfig> = {
  'writer-blocked': {
    icon: AlertTriangle,
    colorClasses: 'bg-soft-amber/10 border-soft-amber/30 text-soft-amber',
    messageKey: 'health.banner_paused',
    stateKey: 'health.state_label_writer_blocked'
  },
  'read-only': {
    icon: Info,
    colorClasses: 'bg-soft-amber/10 border-soft-amber/30 text-soft-amber',
    messageKey: 'health.banner_readonly',
    stateKey: 'health.state_label_read_only'
  },
  'corrupt': {
    icon: AlertTriangle,
    colorClasses: 'bg-soft-red/10 border-soft-red/30 text-soft-red',
    messageKey: 'health.banner_corrupt',
    stateKey: 'health.state_label_corrupt'
  },
  'identity-conflict': {
    icon: AlertTriangle,
    colorClasses: 'bg-soft-red/10 border-soft-red/30 text-soft-red',
    messageKey: 'health.banner_identity_conflict',
    stateKey: 'health.state_label_identity_conflict'
  },
  'initializing': {
    icon: Loader2,
    colorClasses: 'bg-surface border-edge text-muted',
    messageKey: 'health.banner_initializing',
    stateKey: 'health.state_label_initializing'
  }
}

// ---- Component ----

export function LibraryHealthBanner() {
  const t = useT()
  const health = useLibraryHealth()
  const showToast = useStore((s) => s.showToast)
  const [collapsed, setCollapsed] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const prevCompensation = useRef(health.compensation)

  // Track compensation completion and show toast with appropriate tone
  useEffect(() => {
    const prev = prevCompensation.current
    prevCompensation.current = health.compensation

    if (
      prev.inProgress &&
      !health.compensation.inProgress &&
      prev.total > 0
    ) {
      if (health.compensation.cancelled) {
        showToast(
          t('health.compensation_cancelled'),
          'info'
        )
      } else if (health.compensation.failed > 0 && health.compensation.completed === 0) {
        showToast(
          t('health.compensation_failed', { n: health.compensation.failed }),
          'error'
        )
      } else if (health.compensation.failed > 0) {
        showToast(
          t('health.compensation_partial', {
            done: health.compensation.completed,
            failed: health.compensation.failed
          }),
          'info'
        )
      } else {
        showToast(
          t('health.compensation_done', { n: health.compensation.completed }),
          'success'
        )
      }
    }
  }, [health.compensation, showToast, t])

  // Nothing to show when ready and no compensation in progress
  if (health.state === 'ready' && !health.compensation.inProgress) {
    return null
  }

  // Compensation progress mode overrides the state banner
  if (health.compensation.inProgress) {
    const fraction = health.compensation.total > 0
      ? health.compensation.completed / health.compensation.total
      : 0
    return (
      <div
        data-testid="library-health-banner"
        className="shrink-0 border-b border-edge bg-soft-blue/5 px-4 py-2 flex items-center gap-3 text-xs text-soft-blue"
      >
        <Loader2 size={14} className="animate-spin shrink-0" />
        <span className="flex-1">
          {t('health.compensation_progress', {
            total: health.compensation.total,
            done: health.compensation.completed
          })}
        </span>
        <div className="w-24 h-1.5 rounded-full bg-surface overflow-hidden shrink-0">
          <div
            className="h-full bg-soft-blue rounded-full transition-all duration-300"
            style={{ width: `${Math.round(fraction * 100)}%` }}
          />
        </div>
        {health.availableActions.includes('cancel-compensation') && (
          <button
            onClick={async () => {
              setCancelling(true)
              await cancelCompensation()
              setTimeout(() => setCancelling(false), 1500)
            }}
            disabled={cancelling}
            className="px-2 py-0.5 rounded border border-current/20 hover:bg-base/30 text-[11px] disabled:opacity-40"
          >
            <X size={10} />
          </button>
        )}
      </div>
    )
  }

  const config = BANNER_CONFIGS[health.state as Exclude<LibraryHealthState, 'ready'>]
  if (!config) return null

  const Icon = config.icon
  const showRetry = health.availableActions.includes('retry-compensation')

  // Collapsed badge mode
  if (collapsed) {
    return (
      <div
        data-testid="library-health-banner"
        className={`shrink-0 border-b border-edge ${config.colorClasses} px-4 py-1 flex items-center gap-2 text-[11px] cursor-pointer`}
        onClick={() => setCollapsed(false)}
        title={t('health.expand')}
      >
        <Icon size={12} className={config.icon === Loader2 ? 'animate-spin shrink-0' : 'shrink-0'} />
        <span className="truncate">{t(config.messageKey)}</span>
        <ChevronDown size={10} className="ml-auto shrink-0 opacity-60" />
      </div>
    )
  }

  const handleRetry = async () => {
    setRecovering(true)
    await retryCompensation()
    // Give the IPC event a moment to arrive before clearing spinner
    setTimeout(() => setRecovering(false), 1500)
  }

  return (
    <div
      data-testid="library-health-banner"
      className={`shrink-0 border-b ${config.colorClasses} px-4 py-2 flex items-center gap-3 text-xs`}
    >
      <Icon size={14} className={config.icon === Loader2 ? 'animate-spin shrink-0' : 'shrink-0'} />
      <span className="flex-1 min-w-0">
        {t(config.messageKey)}
        {health.reasonCode && (
          <span className="opacity-60 ml-1.5">
            &mdash; {t(config.stateKey)}
          </span>
        )}
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => useStore.getState().openSettingsAt('general')}
          className="px-2 py-0.5 rounded border border-current/20 hover:bg-base/30 text-[11px]"
        >
          {t('health.view_details')}
        </button>
        {showRetry && (
          <button
            onClick={handleRetry}
            disabled={recovering}
            className="px-2 py-0.5 rounded border border-current/20 hover:bg-base/30 text-[11px] disabled:opacity-40"
          >
            {t('health.try_recover')}
          </button>
        )}
        <button
          onClick={() => setCollapsed(true)}
          className="p-0.5 opacity-50 hover:opacity-100"
          title={t('health.collapse')}
        >
          <ChevronUp size={12} />
        </button>
      </div>
    </div>
  )
}

// ---- Inline stale disclaimer for search / insights ----

export function StaleDisclaimer({ variant }: { variant: 'search' | 'insights' | 'share' }) {
  const t = useT()
  const health = useLibraryHealth()

  // Use the shared snapshot — check state and compensation diagnostics
  if (health.state === 'ready' && health.diagnostics.length === 0) return null

  // For non-ready states, show the disclaimer
  if (variant === 'share') {
    return (
      <span className="text-[10px] text-soft-amber">
        {t('health.share_stale')}
      </span>
    )
  }

  const minutes = staleMinutes(null)

  const key = variant === 'search' ? 'health.search_disclaimer' : 'health.insights_disclaimer'

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-soft-amber px-1 py-0.5 rounded bg-soft-amber/5">
      <Database size={10} className="shrink-0" />
      <span>{minutes > 0 ? t(key, { n: minutes }) : t(key + '_unknown')}</span>
    </div>
  )
}

// ---- Session stale indicator for sidebar ----

export function SessionStaleIndicator({ lagMs }: { lagMs: number | null }) {
  const t = useT()

  if (lagMs === null || lagMs < 60_000) return null

  const lagSeconds = lagMs / 1000
  const lagText = lagSeconds < 3600
    ? t('health.stale_minutes', { n: Math.round(lagSeconds / 60) })
    : t('health.stale_hours', { n: Math.round(lagSeconds / 3600) })

  return (
    <span
      className="text-soft-amber shrink-0"
      title={`${t('health.session_stale')} (${lagText})`}
    >
      <AlertTriangle size={10} />
    </span>
  )
}
