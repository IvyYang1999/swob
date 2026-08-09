import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Bug, CheckCircle2, Database, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { retryCompensation, useLibraryHealth } from '../../hooks/useLibraryHealth'
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
  const [retrying, setRetrying] = useState(false)
  const [progress, setProgress] = useState<DuplicateRecoveryProgress | null>(null)
  const [report, setReport] = useState<DuplicateRecoverySummary | null>(null)
  const cancelRequested = useRef(false)
  const identity = health.dimensions.identityExceptions
  const backlog = health.dimensions.backgroundBacklog
  const actionableIdentityGroups = identity.unknownGroupCount + identity.evidenceMismatchGroupCount
  const backgroundFailures = backlog.failed
  const pausedBackgroundItems = backlog.state === 'paused' ? backlog.remaining : 0
  const backgroundProblemCount = backgroundFailures + pausedBackgroundItems
  const writerProblem = health.state === 'writer-blocked' || health.state === 'read-only' || health.state === 'corrupt'
  const actionableCount = actionableIdentityGroups + backgroundProblemCount + (writerProblem ? 1 : 0)
  const summary = report ? recoverySummary(report) : null
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

  const analyze = async () => {
    cancelRequested.current = false
    setAnalyzing(true)
    setReport(null)
    setProgress({ phase: 'discovering', discoveredPackages: 0, conflictPackages: 0, analyzedConflictPackages: 0 })
    const unsubscribe = window.api.onDuplicateRecoveryProgress?.((next) => setProgress(next))
    try {
      const next = await window.api.libraryAnalyzeDuplicateRecovery()
      setReport(next)
    } catch {
      if (!cancelRequested.current) showToast(t('diagnostics.analysis_failed'), 'error')
    } finally {
      unsubscribe?.()
      setAnalyzing(false)
    }
  }

  const cancelAnalysis = async () => {
    cancelRequested.current = true
    await window.api.libraryCancelDuplicateRecoveryAnalysis()
  }

  const apply = async () => {
    if (!report || report.autoRepairablePackageCount === 0) return
    const confirmed = window.confirm(t('diagnostics.apply_confirm', { n: report.autoRepairablePackageCount }))
    if (!confirmed) return
    setApplying(true)
    try {
      const result = await window.api.libraryApplyDuplicateRecovery(report.planId)
      showToast(t(result.restartRequired ? 'diagnostics.apply_done_restart' : 'diagnostics.apply_done', {
        n: result.appliedPackageCount
      }), 'success')
      setReport(null)
    } catch {
      showToast(t('diagnostics.apply_failed'), 'error')
    } finally {
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
            {actionableCount === 0
              ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-soft-green" />
              : <AlertTriangle size={16} className="mt-0.5 shrink-0 text-soft-amber" />}
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-primary">
                {health.state === 'initializing'
                  ? t('diagnostics.checking')
                  : actionableCount === 0
                  ? t('diagnostics.no_action_needed')
                  : t('diagnostics.action_needed', { n: actionableCount })}
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
            {!report && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="min-w-48 flex-1 text-[11px] leading-relaxed text-muted">
                  {t('diagnostics.analysis_privacy')}
                </p>
                <button
                  type="button"
                  onClick={analyzing ? cancelAnalysis : analyze}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent/15 px-3 py-1.5 text-xs font-medium text-accent hover:bg-accent/25 disabled:opacity-40"
                >
                  {analyzing && <Loader2 size={12} className="motion-safe:animate-spin" />}
                  {analyzing ? t('diagnostics.cancel_analysis') : t('diagnostics.analyze')}
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
            {report && summary && (
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
                  {t('diagnostics.result_boundary')}
                </p>
                <div className="flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={analyze}
                    disabled={analyzing || applying}
                    className="rounded-md px-3 py-1.5 text-xs text-secondary hover:bg-hover disabled:opacity-40"
                  >
                    {t('diagnostics.analyze_again')}
                  </button>
                  {summary.autoPackages > 0 && (
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

      {backgroundProblemCount > 0 && (
        <SettingField label={t('diagnostics.background_title')} icon={<RefreshCw size={12} />}>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-surface px-3 py-2.5">
            <span className="text-[11px] text-muted">
              {pausedBackgroundItems > 0
                ? t('diagnostics.background_paused', { n: pausedBackgroundItems })
                : t('diagnostics.background_failed', { n: backgroundFailures })}
            </span>
            {health.availableActions.includes('retry-compensation') && (
              <button
                type="button"
                disabled={retrying}
                onClick={async () => {
                  setRetrying(true)
                  const ok = await retryCompensation()
                  if (!ok) showToast(t('diagnostics.retry_failed'), 'error')
                  setRetrying(false)
                }}
                className="rounded-md px-3 py-1.5 text-xs text-accent hover:bg-accent/10 disabled:opacity-40"
              >
                {t('diagnostics.retry')}
              </button>
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
