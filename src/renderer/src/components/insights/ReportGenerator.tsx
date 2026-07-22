import { useState, useEffect, useCallback } from 'react'
import { useStore } from '../../store'

/** Cross-session HTML report generation (quick / LLM narrative), extracted from the old stats tab. */
export function ReportGenerator() {
  const locale = useStore((s) => s.locale)
  const openSettingsAt = useStore((s) => s.openSettingsAt)
  const zh = locale === 'zh-CN'
  const [generating, setGenerating] = useState(false)
  const [reportResult, setReportResult] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ stage: string; current: number; total: number } | null>(null)
  const [llmAvailable, setLlmAvailable] = useState(false)
  const [confirmingLlm, setConfirmingLlm] = useState(false)

  useEffect(() => {
    window.api.getLlmSettings().then(s => setLlmAvailable(s.hasKey)).catch(() => {})
  }, [])

  useEffect(() => {
    if (!generating) return
    const unsubscribe = window.api.onInsightsProgress((p) => setProgress(p))
    return unsubscribe
  }, [generating])

  const runGenerate = useCallback(async (useLlm: boolean) => {
    setGenerating(true)
    setReportResult(null)
    setProgress(null)
    setConfirmingLlm(false)
    try {
      const result = await window.api.generateInsights({ useLlm })
      if (result.ok) {
        let msg = `Report generated: ${result.sessionCount} sessions analyzed`
        if (useLlm && result.llmUsed) msg += ' · AI narrative included'
        if (useLlm && result.llmError === 'no-api-key') msg += ' · No API key configured (Settings → AI Analysis)'
        else if (useLlm && result.llmError) msg += ` · AI failed: ${result.llmError.slice(0, 80)}`
        setReportResult(msg)
      } else {
        setReportResult(`Error: ${result.error}`)
      }
    } catch (e) {
      setReportResult(`Error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setGenerating(false)
      setProgress(null)
    }
  }, [])

  const stageLabel = (s: string): string =>
    s === 'analyzing' ? 'Auditing sessions'
    : s === 'sampling' ? 'Sampling content'
    : s === 'llm' ? 'AI analyzing'
    : s === 'writing' ? 'Writing report'
    : s

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-primary">{zh ? 'HTML 审计报告' : 'Audit Report (HTML)'}</div>
          <div className="text-[11px] text-muted">Cross-session quality audit · health scores · anti-patterns · AI narrative</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runGenerate(false)}
            disabled={generating}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-hover text-secondary hover:text-primary disabled:opacity-50 transition-colors"
          >
            Quick Report
          </button>
          <button
            onClick={() => setConfirmingLlm(true)}
            disabled={generating}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-soft-emerald/15 text-soft-emerald hover:bg-soft-emerald/25 disabled:opacity-50 transition-colors flex items-center gap-1.5"
            title={llmAvailable ? '' : 'Configure API key in Settings first'}
          >
            ✨ AI Report
          </button>
        </div>
      </div>

      {confirmingLlm && (
        <div className="bg-soft-amber/5 border border-soft-amber/20 rounded-md p-3 space-y-2">
          <div className="text-xs text-soft-amber font-medium">⚠️ Privacy Notice</div>
          <div className="text-[11px] text-secondary leading-relaxed">
            AI Report samples <strong>real content from your recent sessions</strong> (user messages, up to 60 sessions)
            and sends it to your configured LLM provider for analysis.
            {!llmAvailable && (
              <span className="text-soft-amber">
                {' '}{zh ? '还没有配置 API key。' : 'No API key configured yet.'}
                <button
                  onClick={() => openSettingsAt('ai')}
                  className="ml-1 underline underline-offset-2 hover:text-primary"
                >
                  {zh ? '去设置 → AI 智能' : 'Open Settings → AI & Smart'}
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
              I understand, generate
            </button>
            <button
              onClick={() => setConfirmingLlm(false)}
              className="px-2.5 py-1 rounded text-[11px] text-muted hover:text-primary"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {generating && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] text-secondary">
            <div className="animate-spin w-3 h-3 border border-soft-blue border-t-transparent rounded-full" />
            {progress ? `${stageLabel(progress.stage)}… ${progress.current}/${progress.total}` : 'Starting…'}
          </div>
          {progress && progress.total > 1 && (
            <div className="h-1 rounded-full bg-edge overflow-hidden">
              <div
                className="h-full bg-soft-blue rounded-full transition-all duration-300"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {reportResult && !generating && <div className="text-[11px] text-muted">{reportResult}</div>}
    </div>
  )
}
