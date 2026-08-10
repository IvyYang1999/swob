import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bug, CheckCircle2, Database, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { useLibraryHealth } from '../../hooks/useLibraryHealth'
import type {
  DuplicateRecoveryProgress,
  DuplicateRecoverySummary
} from '../../../../shared/duplicate-recovery-contract'
import { SettingField, ToggleRow, useSettingsPreferences } from './shared'

function recoverySummary(report: DuplicateRecoverySummary) {
  return {
    autoGroups: report.autoRepairableGroupCount,
    autoPackages: report.autoRepairablePackageCount,
    manualGroups: report.manualMergeGroupCount,
    preservedGroups: report.preservedGroupCount
  }
}

export function DiagnosticsSettings() {
  const t = useT()
  const health = useLibraryHealth()
  const { savePreferences, showToast, sessionBootstrapState } = useStore()
  const preferences = useSettingsPreferences()
  const [debugMode, setDebugMode] = useState(preferences.debugMode === true)
  const debugModeTouched = useRef(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [applying, setApplying] = useState(false)
  const applyingRef = useRef(false)
  const [analysisFailed, setAnalysisFailed] = useState(false)
  const [analysisCancelled, setAnalysisCancelled] = useState(false)
  const [progress, setProgress] = useState<DuplicateRecoveryProgress | null>(null)
  const [liveReport, setLiveReport] = useState<DuplicateRecoverySummary | null>(null)
  const [cachedReport, setCachedReport] = useState<DuplicateRecoverySummary | null>(null)
  const cancelRequested = useRef(false)
  const analysisRequestId = useRef(0)
  const progressUnsubscribe = useRef<(() => void) | null>(null)
  const identity = health.dimensions.identityExceptions
  const backlog = health.dimensions.backgroundBacklog
  const backgroundRecovery = backlog.recovery
  const actionableIdentityGroups = identity.unknownGroupCount + identity.evidenceMismatchGroupCount
  const writerProblem = health.state === 'writer-blocked' || health.state === 'read-only' || health.state === 'corrupt'
  const writerRecoveryActive = health.state === 'writer-blocked' &&
    (health.writerRecovery.nextRetryAt !== null || health.writerRecovery.attempt > 0)
  const automaticRecoveryActive = backgroundRecovery.state === 'running' ||
    backgroundRecovery.state === 'scheduled' || backgroundRecovery.state === 'waiting-provider'
  const backgroundNeedsAttention = backgroundRecovery.attentionRequired + backgroundRecovery.exhausted
  const analysisKey = `${identity.analysisGeneration}:${identity.unknownGroupCount}:${identity.evidenceMismatchGroupCount}`
  const lastAutomaticAnalysis = useRef<string | null>(null)
  const displayedReport = liveReport || cachedReport
  const summary = displayedReport ? recoverySummary(displayedReport) : null
  const rawSnapshot = useMemo(() => JSON.stringify({
    state: health.state,
    reasonCode: health.reasonCode,
    writeCapability: health.writeCapability,
    sessionBootstrapState,
    dimensions: health.dimensions,
    compensation: health.compensation,
    writerRecovery: health.writerRecovery,
    diagnostics: health.diagnostics
  }, null, 2), [health, sessionBootstrapState])

  useEffect(() => {
    if (!debugModeTouched.current) setDebugMode(preferences.debugMode === true)
  }, [preferences.debugMode])

  const analyze = useCallback(async () => {
    const requestId = ++analysisRequestId.current
    progressUnsubscribe.current?.()
    progressUnsubscribe.current = null
    cancelRequested.current = false
    setAnalyzing(true)
    setAnalysisFailed(false)
    setAnalysisCancelled(false)
    setLiveReport(null)
    setProgress({ phase: 'discovering', discoveredPackages: 0, conflictPackages: 0, analyzedConflictPackages: 0 })
    const unsubscribe = window.api.onDuplicateRecoveryProgress?.((next) => {
      if (analysisRequestId.current === requestId) setProgress(next)
    })
    let progressReleased = false
    const releaseProgress = () => {
      if (progressReleased) return
      progressReleased = true
      unsubscribe?.()
    }
    progressUnsubscribe.current = releaseProgress
    try {
      const next = await window.api.libraryAnalyzeDuplicateRecovery()
      if (analysisRequestId.current === requestId) {
        setLiveReport(next)
        setCachedReport(null)
      }
    } catch {
      if (analysisRequestId.current === requestId && !cancelRequested.current) setAnalysisFailed(true)
    } finally {
      releaseProgress()
      if (progressUnsubscribe.current === releaseProgress) progressUnsubscribe.current = null
      if (analysisRequestId.current === requestId) setAnalyzing(false)
    }
  }, [showToast, t])

  useEffect(() => {
    let active = true
    setCachedReport(null)
    if (actionableIdentityGroups > 0) {
      void window.api.libraryGetCachedDuplicateRecoverySummary().then((cached) => {
        if (active && cached) setCachedReport(cached)
      }).catch(() => { /* a cache miss never blocks live analysis */ })
    }
    return () => { active = false }
  }, [actionableIdentityGroups, analysisKey])

  useEffect(() => () => {
    analysisRequestId.current++
    progressUnsubscribe.current?.()
    progressUnsubscribe.current = null
  }, [])

  useEffect(() => {
    if (actionableIdentityGroups === 0 || lastAutomaticAnalysis.current === analysisKey) return
    lastAutomaticAnalysis.current = analysisKey
    void analyze()
  }, [actionableIdentityGroups, analysisKey, analyze])

  const cancelAnalysis = async () => {
    cancelRequested.current = true
    analysisRequestId.current++
    progressUnsubscribe.current?.()
    progressUnsubscribe.current = null
    setAnalyzing(false)
    setProgress(null)
    setAnalysisCancelled(true)
    await window.api.libraryCancelDuplicateRecoveryAnalysis()
  }

  const apply = async () => {
    if (applyingRef.current || !liveReport || liveReport.canApply === false ||
      liveReport.autoRepairablePackageCount === 0) return
    const confirmed = window.confirm(t('diagnostics.apply_confirm', { n: liveReport.autoRepairablePackageCount }))
    if (!confirmed) return
    applyingRef.current = true
    setApplying(true)
    try {
      const result = await window.api.libraryApplyDuplicateRecovery(liveReport.planId)
      if (result.status === 'stale') {
        setLiveReport(null)
        setProgress({ phase: 'discovering', discoveredPackages: 0, conflictPackages: 0, analyzedConflictPackages: 0 })
        showToast(t('diagnostics.plan_changed_rechecking'), 'info')
        void analyze()
        return
      }
      showToast(t(result.restartRequired ? 'diagnostics.apply_done_restart' : 'diagnostics.apply_done', {
        n: result.appliedPackageCount
      }), 'success')
      setLiveReport(null)
    } catch {
      showToast(t('diagnostics.apply_failed'), 'error')
    } finally {
      applyingRef.current = false
      setApplying(false)
    }
  }

  return (
    <>
      <SettingField
        label={t('diagnostics.title')}
        hint={t('diagnostics.hint')}
        icon={<Database size={12} />}
      >
        <div
          data-testid="diagnostics-summary"
          className="rounded-lg border border-edge bg-surface px-3.5 py-3"
        >
          <div className="flex items-start gap-2.5">
            {!writerProblem && !automaticRecoveryActive && actionableIdentityGroups === 0 && backgroundNeedsAttention === 0
              ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-soft-green" />
              : <AlertTriangle size={16} className="mt-0.5 shrink-0 text-soft-amber" />}
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-primary">
                {health.state === 'initializing'
                  ? t('diagnostics.checking')
                  : writerProblem
                    ? t(writerRecoveryActive ? 'diagnostics.writer_recovering' : 'diagnostics.writer_unavailable')
                    : automaticRecoveryActive
                      ? t('diagnostics.automatic_recovery')
                      : actionableIdentityGroups > 0
                        ? t(liveReport && liveReport.canApply !== false
                          ? 'diagnostics.identity_reviewed'
                          : analysisCancelled
                            ? 'diagnostics.identity_paused'
                            : analysisFailed
                              ? 'diagnostics.identity_failed'
                              : analyzing
                                ? 'diagnostics.identity_review'
                                : 'diagnostics.identity_needs_review', {
                            n: actionableIdentityGroups
                          })
                        : backgroundNeedsAttention > 0
                          ? t('diagnostics.background_attention', { n: backgroundNeedsAttention })
                          : t('diagnostics.no_action_needed')}
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                {actionableIdentityGroups > 0
                  ? t('diagnostics.identity_summary', { n: actionableIdentityGroups })
                  : t('diagnostics.identity_clear')}
              </p>
              {identity.authorizedGroupCount > 0 && (
                <p className="mt-1 text-[10px] leading-relaxed text-faint">
                  {t('diagnostics.authorized_readonly', { n: identity.authorizedGroupCount })}
                </p>
              )}
            </div>
          </div>
        </div>
      </SettingField>

      {actionableIdentityGroups > 0 && (
        <SettingField
          label={t('diagnostics.duplicates_title')}
          hint={t('diagnostics.duplicates_hint')}
          icon={<ShieldCheck size={12} />}
        >
          <div className="rounded-lg border border-edge bg-base px-3.5 py-3 space-y-3">
            {!analysisFailed && !analysisCancelled && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-48 flex-1 text-[11px] leading-relaxed text-muted">
                  {analyzing ? t('diagnostics.analysis_automatic') : t('diagnostics.analysis_privacy')}
                </p>
                {analyzing && (
                  <button
                    type="button"
                    onClick={cancelAnalysis}
                    className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-secondary hover:bg-hover"
                  >
                    <Loader2 size={12} className="motion-safe:animate-spin" />
                    {t('diagnostics.cancel_analysis')}
                  </button>
                )}
              </div>
            )}
            {analysisFailed && (
              <div role="alert" className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-48 flex-1 text-[11px] leading-relaxed text-muted">
                  {t('diagnostics.analysis_failed')}
                </p>
                <button
                  type="button"
                  onClick={analyze}
                  className="rounded-md px-3 py-1.5 text-xs text-accent hover:bg-accent/10"
                >
                  {t('diagnostics.analysis_retry')}
                </button>
              </div>
            )}
            {analysisCancelled && (
              <div role="status" className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-48 flex-1 text-[11px] leading-relaxed text-muted">
                  {t('diagnostics.analysis_cancelled')}
                </p>
                <button
                  type="button"
                  onClick={analyze}
                  className="rounded-md px-3 py-1.5 text-xs text-accent hover:bg-accent/10"
                >
                  {t('diagnostics.analyze_again')}
                </button>
              </div>
            )}
            {analyzing && progress && (
              <div role="status" className="text-[10px] text-faint">
                {t('diagnostics.analysis_progress', {
                  found: progress.discoveredPackages,
                  done: progress.analyzedConflictPackages,
                  total: progress.conflictPackages
                })}
              </div>
            )}
            {displayedReport && summary && (
              <div data-testid="duplicate-recovery-result" className="space-y-3">
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div className="rounded-md bg-surface px-2.5 py-2">
                    <span className="block text-faint">{t('diagnostics.safe_duplicates')}</span>
                    <span className="mt-0.5 block font-medium text-primary">{summary.autoPackages}</span>
                  </div>
                  <div className="rounded-md bg-surface px-2.5 py-2">
                    <span className="block text-faint">{t('diagnostics.manual_groups')}</span>
                    <span className="mt-0.5 block font-medium text-primary">{summary.manualGroups + summary.preservedGroups}</span>
                  </div>
                </div>
                <p className="text-[10px] leading-relaxed text-faint">
                  {displayedReport.canApply === false
                    ? t(analysisCancelled
                        ? 'diagnostics.cached_paused'
                        : analysisFailed
                          ? 'diagnostics.cached_failed'
                          : 'diagnostics.cached_rechecking')
                    : t('diagnostics.result_boundary')}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  {liveReport && liveReport.canApply !== false && summary.autoPackages > 0 && (
                    <button
                      type="button"
                      onClick={apply}
                      disabled={applying}
                      className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
                    >
                      {applying
                        ? t('diagnostics.applying')
                        : t('diagnostics.apply_safe', { n: summary.autoPackages })}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </SettingField>
      )}

      {(automaticRecoveryActive || backgroundNeedsAttention > 0) && (
        <SettingField label={t('diagnostics.background_title')} icon={<RefreshCw size={12} />}>
          <div className="space-y-1.5 rounded-md bg-surface px-3 py-2.5">
            {backgroundRecovery.retryScheduled > 0 && (
              <p className="text-[11px] text-muted">
                {t('diagnostics.background_scheduled', { n: backgroundRecovery.retryScheduled })}
              </p>
            )}
            {backgroundRecovery.waitingProvider > 0 && (
              <p className="text-[11px] text-muted">
                {t('diagnostics.background_waiting_provider', { n: backgroundRecovery.waitingProvider })}
              </p>
            )}
            {backgroundRecovery.attentionRequired > 0 && (
              <p className="text-[11px] leading-relaxed text-muted">
                {t('diagnostics.background_identity_guard', { n: backgroundRecovery.attentionRequired })}
              </p>
            )}
            {backgroundRecovery.exhausted > 0 && (
              <p className="text-[11px] leading-relaxed text-muted">
                {t('diagnostics.background_exhausted', {
                  n: backgroundRecovery.exhausted,
                  attempts: backgroundRecovery.maxAttempts
                })}
              </p>
            )}
          </div>
        </SettingField>
      )}

      <SettingField label={t('diagnostics.debug_title')} icon={<Bug size={12} />}>
        <ToggleRow
          checked={debugMode}
          onChange={(nextDebugMode) => {
            debugModeTouched.current = true
            setDebugMode(nextDebugMode)
            void savePreferences({ debugMode: nextDebugMode }).catch(() => {
              showToast(t('diagnostics.debug_persist_failed'), 'error')
            })
          }}
          label={t('diagnostics.debug_mode')}
          hint={t('diagnostics.debug_hint')}
        />
        {debugMode && (
          <pre
            data-testid="diagnostics-raw"
            className="mt-3 max-h-72 overflow-auto rounded-md border border-edge bg-surface p-3 text-[10px] leading-relaxed text-muted"
          >
            {rawSnapshot}
          </pre>
        )}
      </SettingField>
    </>
  )
}
