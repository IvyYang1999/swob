import { formatTokenCount } from './shared'

export function CostCard({ costUsd, cacheRead, cacheCreate, totalInput }: {
  costUsd: number; cacheRead: number; cacheCreate: number; totalInput: number
}) {
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0
  const cacheSaved = cacheRead > 0 ? (cacheRead / 1_000_000) * 3 : 0 // input price saved

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="text-sm font-medium text-primary">Cost & Cache</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xl font-bold text-soft-amber">${costUsd.toFixed(0)}</div>
          <div className="text-[10px] text-muted">Est. Total Cost</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-soft-emerald">{cacheHitRate.toFixed(0)}%</div>
          <div className="text-[10px] text-muted">Cache Hit Rate</div>
        </div>
      </div>
      <div className="text-[11px] text-muted space-y-1">
        <div className="flex justify-between"><span>Cache read</span><span>{formatTokenCount(cacheRead)}</span></div>
        <div className="flex justify-between"><span>Cache create</span><span>{formatTokenCount(cacheCreate)}</span></div>
        <div className="flex justify-between"><span>Est. cache savings</span><span className="text-soft-emerald">${cacheSaved.toFixed(0)}</span></div>
      </div>
      <div className="text-[9px] text-faint">Cost = input×$3/M + output×$15/M (Sonnet rate). Actual varies by model.</div>
    </div>
  )
}
