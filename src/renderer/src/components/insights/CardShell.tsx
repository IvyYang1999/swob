import type { ReactNode } from 'react'
import { useStore } from '../../store'
import { useAnalysisScope, scopeRangeLabel } from './scope'

/**
 * Uniform card chrome: title + explicit scope label on every aggregate, so no
 * two cards on the same page can silently use different denominators again.
 */
export function CardShell({ title, titleEn, children, tooltip, rangeOverride, className }: {
  title: string
  titleEn?: string
  tooltip?: string
  /** For cards whose data范围 differs from the global scope (e.g. 近30天趋势). */
  rangeOverride?: string
  className?: string
  children: ReactNode
}) {
  const locale = useStore((s) => s.locale)
  const { scope } = useAnalysisScope()
  const label = locale === 'zh-CN' ? title : (titleEn || title)
  return (
    <div className={`bg-surface rounded-lg p-4 border border-edge space-y-2 min-w-0 ${className || ''}`} title={tooltip}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium text-primary truncate">{label}</div>
        <span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-[9px] text-faint">
          {scopeRangeLabel(scope, locale, rangeOverride)}
        </span>
      </div>
      {children}
    </div>
  )
}
