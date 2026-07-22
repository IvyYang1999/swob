import { formatTokenCount } from './shared'
import type { Valuation } from './shared'

export function CostCard({ valuation, cacheRead, cacheCreate, totalInput }: {
  valuation: Valuation; cacheRead: number; cacheCreate: number; totalInput: number
}) {
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput) * 100 : 0
  const amount = valuation.usd === undefined ? '未计价' : `$${valuation.usd.toFixed(2)}`

  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-3">
      <div className="text-sm font-medium text-primary">API 等价值(估算)与缓存</div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xl font-bold text-soft-amber">{amount}</div>
          <div className="text-[10px] text-muted">API 等价值(估算)</div>
        </div>
        <div>
          <div className="text-2xl font-bold text-soft-emerald">{cacheHitRate.toFixed(0)}%</div>
          <div className="text-[10px] text-muted">Cache Hit Rate</div>
        </div>
      </div>
      <div className="text-[11px] text-muted space-y-1">
        <div className="flex justify-between"><span>Cache read</span><span>{formatTokenCount(cacheRead)}</span></div>
        <div className="flex justify-between"><span>Cache create</span><span>{formatTokenCount(cacheCreate)}</span></div>
        <div className="flex justify-between"><span>价格覆盖</span><span>{valuation.coveragePercent.toFixed(1)}%</span></div>
      </div>
      <div className="text-[9px] text-faint">逐请求按模型、Provider、时间与缓存桶估算；未知项不套默认价，不代表实际现金支出。</div>
    </div>
  )
}
