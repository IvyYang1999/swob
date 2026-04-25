import { useState, useEffect, useMemo } from 'react'
import { useStore } from '../../store'
import { StatsCards } from './StatsCards'
import { TokenHeatmap } from './TokenHeatmap'
import { SourceDonut } from './SourceDonut'
import { ProjectRanking } from './ProjectRanking'
import { DailyTrend } from './DailyTrend'
import { DailyTimeline } from './DailyTimeline'
import { ModelBreakdown } from './ModelBreakdown'
import type { InsightsData } from './shared'

export function InsightsPage() {
  const api = (window as any).api
  const config = useStore((s) => s.config)
  const [data, setData] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    api.getInsights().then((d: InsightsData) => {
      if (!cancelled) {
        setData(d)
        setLoading(false)
      }
    })
    return () => { cancelled = true }
  }, [])

  const projectViewMode = config?.preferences?.projectViewMode || 'folders'

  const projectData = useMemo(() => {
    if (!data) return []
    return projectViewMode === 'paths' ? data.byProject : data.byFolder
  }, [data, projectViewMode])

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <StatsCards data={data} />

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Token Heatmap</div>
        <div className="overflow-x-auto">
          <TokenHeatmap data={data.heatmap} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">By Source</div>
          <SourceDonut sources={data.bySource} />
        </div>
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">By Model</div>
          <ModelBreakdown models={data.byModel ?? []} />
        </div>
        <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
          <div className="text-sm font-medium text-primary">Top Projects</div>
          <ProjectRanking projects={projectData} />
        </div>
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Daily Trend (30d)</div>
        <DailyTrend data={data.byDate} />
      </div>

      <div className="bg-surface rounded-lg p-4 border border-edge space-y-2">
        <div className="text-sm font-medium text-primary">Daily Insights</div>
        <DailyTimeline data={data.byDate} projectKey={projectViewMode === 'paths' ? 'byProject' : 'byFolder'} />
      </div>
    </div>
  )
}
