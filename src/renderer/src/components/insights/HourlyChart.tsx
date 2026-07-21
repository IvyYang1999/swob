export function HourlyChart({ hours }: { hours: number[] }) {
  const max = Math.max(...hours, 1)
  return (
    <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
      <div className="text-sm font-medium text-primary">Activity by Hour</div>
      <div className="flex items-end gap-[2px] h-16">
        {hours.map((count, hour) => (
          <div key={hour} className="flex-1 flex flex-col items-center justify-end gap-0.5">
            <div
              className="w-full rounded-t bg-soft-blue transition-all"
              style={{ height: `${(count / max) * 100}%`, minHeight: count > 0 ? 2 : 0, opacity: 0.3 + (count / max) * 0.7 }}
              title={`${hour}:00 — ${count} sessions`}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[9px] text-faint">
        <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>24h</span>
      </div>
    </div>
  )
}
