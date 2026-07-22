import { useT } from '../../i18n'
import { useState, useEffect } from 'react'
import { useStore } from '../../store'
import { useReportJob } from './useReportJob'
import type { ReportJobSnapshot } from '../../../../shared/report-jobs'

const EMPTY_REPORT_PARAMS = {}

function isActive(job: ReportJobSnapshot | null): boolean {
  return job?.state === 'queued' || job?.state === 'running'
}

function stageKey(stage: string): string {
  if (stage === 'queued') return 'renderer.report_job.stage_queued'
  if (stage === 'starting') return 'renderer.report_job.stage_starting'
  if (stage === 'analyzing') return 'renderer.report_job.stage_analyzing'
  if (stage === 'sampling') return 'renderer.report_job.stage_sampling'
  if (stage === 'llm') return 'renderer.report_job.stage_llm'
  if (stage === 'writing') return 'renderer.report_job.stage_writing'
  return 'renderer.report_job.stage_working'
}

/** Cross-session HTML report generation (quick / LLM narrative), extracted from the old stats tab. */
export function ReportGenerator() {
  const t = useT()
  const openSettingsAt = useStore((s) => s.openSettingsAt)
  const [llmAvailable, setLlmAvailable] = useState(false)
  const [confirmingLlm, setConfirmingLlm] = useState(false)
  const quick = useReportJob('quick', EMPTY_REPORT_PARAMS)
  const ai = useReportJob('ai', EMPTY_REPORT_PARAMS)

  useEffect(() => {
    window.api.getLlmSettings().then(s => setLlmAvailable(s.hasKey)).catch(() => {})
  }, [])

  const runGenerate = (useLlm: boolean): void => {
    setConfirmingLlm(false)
    void (useLlm ? ai.start(true) : quick.start(true))
  }

  const jobs = [quick.job, ai.job].filter((job): job is ReportJobSnapshot => job !== null)
  const activeJob = jobs.find(isActive) || null
  const latestJob = jobs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] || null
  const job = activeJob || latestJob
  const activeController = activeJob?.type === 'ai' ? ai : quick
  const generating = isActive(activeJob) || quick.pendingRequest || ai.pendingRequest
  const requestError = quick.requestError || ai.requestError

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-primary">{t('renderer.report_generator.audit_report_html')}</div>
          <div className="text-[11px] text-muted">{t('renderer.report_generator.description')}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runGenerate(false)}
            disabled={generating}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-hover text-secondary hover:text-primary disabled:opacity-50 transition-colors"
          >
            {t('renderer.report_generator.quick_report')}
          </button>
          <button
            onClick={() => setConfirmingLlm(true)}
            disabled={generating}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-soft-emerald/15 text-soft-emerald hover:bg-soft-emerald/25 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            title={llmAvailable ? '' : t('renderer.report_generator.configure_api_key_first')}
          >
            ✨ {t('renderer.report_generator.ai_report')}
          </button>
        </div>
      </div>

      {confirmingLlm && (
        <div className="bg-soft-amber/5 border border-soft-amber/20 rounded-md p-3 space-y-2">
          <div className="text-xs text-soft-amber font-medium">⚠️ {t('renderer.report_generator.privacy_notice')}</div>
          <div className="text-[11px] text-secondary leading-relaxed">
            {t('renderer.report_generator.privacy_body')}
            {!llmAvailable && (
              <span className="text-soft-amber">
                {' '}{t('renderer.report_generator.no_api_key_configured_yet')}
                <button
                  onClick={() => openSettingsAt('ai')}
                  className="ml-1 underline underline-offset-2 hover:text-primary"
                >
                  {t('renderer.report_generator.open_settings_ai_smart')}
                </button>
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => runGenerate(true)}
              disabled={!llmAvailable}
              className="px-2.5 py-1 rounded text-[11px] font-medium bg-soft-emerald/20 text-soft-emerald hover:bg-soft-emerald/30 disabled:opacity-40"
            >
              {t('renderer.report_generator.confirm_generate')}
            </button>
            <button
              onClick={() => setConfirmingLlm(false)}
              className="px-2.5 py-1 rounded text-[11px] text-muted hover:text-primary"
            >
              {t('renderer.report_job.cancel')}
            </button>
          </div>
        </div>
      )}

      {generating && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex items-center gap-2 text-[11px] text-secondary">
            <div className="animate-spin w-3 h-3 border border-soft-blue border-t-transparent rounded-full" />
            {activeJob
              ? `${t(stageKey(activeJob.progress.stage))}… ${activeJob.progress.current}/${activeJob.progress.total}`
              : `${t('renderer.report_job.stage_starting')}…`}
            {activeJob && (
              <button onClick={() => void activeController.cancel()} className="ml-1 text-muted hover:text-primary underline underline-offset-2">
                {t('renderer.report_job.cancel')}
              </button>
            )}
          </div>
          {activeJob && activeJob.progress.total > 1 && (
            <div className="h-1 rounded-full bg-edge overflow-hidden">
              <div
                className="h-full bg-soft-blue rounded-full transition-all duration-300"
                style={{ width: `${activeJob.progress.percent}%` }}
              />
            </div>
          )}
        </div>
      )}

      {!generating && requestError && (
        <div className="text-[11px] text-red-400">{t('renderer.report_job.failed_with_code', { value0: requestError })}</div>
      )}
      {!generating && !requestError && job?.state === 'failed' && (
        <div className="text-[11px] text-red-400">
          {t('renderer.report_job.failed_with_code', { value0: job.error?.code || 'report-failed' })}
          {' · '}{t('renderer.report_job.failed_stage', { value0: t(stageKey(job.error?.stage || job.progress.stage)) })}
        </div>
      )}
      {!generating && !requestError && job?.state === 'cancelled' && (
        <div className="text-[11px] text-muted">{t('renderer.report_job.cancelled')}</div>
      )}
      {!generating && !requestError && job?.state === 'completed' && (
        <div className="text-[11px] text-muted">
          {t('renderer.report_generator.generated', { value0: job.result?.sessionCount || 0 })}
          {job.type === 'ai' && job.result?.llmUsed ? ` · ${t('renderer.report_generator.ai_included')}` : ''}
          {job.type === 'ai' && job.result?.llmError
            ? ` · ${t('renderer.report_generator.ai_failed_with_code', { value0: job.result.llmError })}`
            : ''}
        </div>
      )}
    </div>
  )
}
