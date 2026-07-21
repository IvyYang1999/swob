const LABELS = ['1-5', '6-20', '21-50', '51-100', '101-500', '500+']
const COLORS = ['#94a3b8', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af']

export function TurnDistribution({ buckets }: { buckets: number[] }) {
  const total = buckets.reduce((a, b) => a + b, 0) || 1
  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
      <div className="text-sm font-medium text-primary">Session Length Distribution</div>
      <div className="flex h-5 rounded overflow-hidden">
        {buckets.map((count, i) => count > 0 ? (
          <div
            key={i}
            style={{ width: `${(count / total) * 100}%`, backgroundColor: COLORS[i] }}
            title={`${LABELS[i]} turns: ${count} sessions (${Math.round((count / total) * 100)}%)`}
            className="flex items-center justify-center text-[9px] text-white font-medium"
          >
            {count > total * 0.08 ? count : ''}
          </div>
        ) : null)}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
        {buckets.map((count, i) => count > 0 ? (
          <div key={i} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: COLORS[i] }} />
            <span className="text-muted">{LABELS[i]} turns</span>
            <span className="text-secondary">{count}</span>
          </div>
        ) : null)}
      </div>
    </div>
  )
}
