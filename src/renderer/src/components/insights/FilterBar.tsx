import { useStore } from '../../store'
import { useAnalysisScope, scopeBasisLabel, scopeRangeLabel } from './scope'
import type { InsightsData } from './shared'
import { formatTokenCount } from './shared'

/**
 * v1 filter bar: live basis toggle + explicit range statement.
 * Time/source/model filters intentionally absent until the t114 event-level
 * data layer can actually re-aggregate — no dead controls.
 */
export function FilterBar({ data }: { data: InsightsData }) {
  const locale = useStore((s) => s.locale)
  const zh = locale === 'zh-CN'
  const { scope, setScope } = useAnalysisScope()

  const basisTotal = scope.basis === 'conversation' ? data.conversationOnlyTokens : data.totalTokens

  return (
    <div className="sticky top-0 z-10 -mx-4 -mt-4 border-b border-edge bg-panel/95 px-4 py-2 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="rounded bg-hover px-2 py-1 text-secondary">
          {zh ? '范围' : 'Scope'}: {scopeRangeLabel(scope, locale)}
        </span>

        <div className="flex overflow-hidden rounded border border-edge" role="group" aria-label={zh ? '统计口径' : 'Token basis'}>
          {(['billing', 'conversation'] as const).map((basis) => (
            <button
              key={basis}
              onClick={() => setScope({ ...scope, basis })}
              aria-pressed={scope.basis === basis}
              className={`px-2 py-1 transition-colors ${
                scope.basis === basis ? 'bg-accent/15 text-accent' : 'text-muted hover:text-primary'
              }`}
            >
              {basis === 'billing' ? (zh ? '计费口径' : 'Billing') : (zh ? '仅会话' : 'Conversation')}
            </button>
          ))}
        </div>

        <span className="text-muted">
          {scopeBasisLabel(scope, locale)} · {formatTokenCount(basisTotal)} tokens
        </span>

        <span className="ml-auto text-[10px] text-faint">
          {zh
            ? '时间/来源/模型筛选将随事件级账本(t114)上线'
            : 'Time/source/model filters arrive with the event-level ledger'}
        </span>
      </div>
    </div>
  )
}
