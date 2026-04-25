import type { SessionSummary, Folder } from './types'

export interface SourceStats {
  source: string
  label: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
}

export interface ProjectStats {
  project: string
  fullPath: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  sources: string[]
}

export interface FolderStats {
  folderId: string
  folderName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
}

export interface DateStats {
  date: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  bySource: Record<string, number>
  byProject: Record<string, number>
  totalTime: number
  byProjectTime: Record<string, number>
}

export interface HeatmapEntry {
  date: string
  value: number
  level: 0 | 1 | 2 | 3 | 4
}

export interface ModelStats {
  model: string
  totalTokens: number
  sessionCount: number
}

export interface InsightsData {
  totalTokens: number
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  totalTurns: number
  totalTime: number
  activeDays: number
  bySource: SourceStats[]
  byModel: ModelStats[]
  byProject: ProjectStats[]
  byFolder: FolderStats[]
  byDate: DateStats[]
  heatmap: HeatmapEntry[]
}

const SOURCE_ORDER = ['claude-code', 'codex', 'cursor'] as const
const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor'
}

function getProjectFromCwds(cwds: string[]): { project: string; fullPath: string } {
  const cwd = cwds[0] || ''
  const parts = cwd.split('/')
  const project = parts[parts.length - 1] || cwd
  return { project, fullPath: cwd }
}

function toDateStr(iso: string): string {
  return iso.slice(0, 10)
}

function getHeatmapLevel(tokens: number): 0 | 1 | 2 | 3 | 4 {
  if (tokens === 0) return 0
  if (tokens < 10_000) return 1
  if (tokens < 50_000) return 2
  if (tokens < 200_000) return 3
  return 4
}

function getLast365Days(): string[] {
  const days: string[] = []
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  for (let i = 364; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    days.push(`${y}-${m}-${day}`)
  }
  return days
}

function emptyDateStats(date: string): DateStats {
  return {
    date,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    sessionCount: 0,
    turnCount: 0,
    bySource: {},
    byProject: {},
    totalTime: 0,
    byProjectTime: {}
  }
}

const THIRTY_MINUTES = 30 * 60 * 1000

/** 相邻消息间隔累加，超过 30 分钟无消息截断 */
export function estimateActiveTime(messages: { timestamp: string }[]): number {
  if (messages.length < 2) return 0
  const sorted = [...messages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  let total = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()
    if (gap > 0 && gap < THIRTY_MINUTES) {
      total += gap
    }
  }
  return total
}

export function buildInsights(
  sessions: SessionSummary[],
  folders: Folder[],
  sessionTimes?: Map<string, number>
): InsightsData {
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalTurns = 0
  let totalTime = 0

  const sourceMap = new Map<string, SourceStats>()
  for (const s of SOURCE_ORDER) {
    sourceMap.set(s, {
      source: s,
      label: SOURCE_LABELS[s],
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionCount: 0,
      turnCount: 0
    })
  }

  const modelMap = new Map<string, ModelStats>()

  const projectMap = new Map<string, ProjectStats>()
  const dateMap = new Map<string, DateStats>()
  const folderSessionSet = new Map<string, Set<string>>()

  for (const session of sessions) {
    const input = session.tokenUsage.inputTokens
    const output = session.tokenUsage.outputTokens
    const cacheCreate = session.tokenUsage.cacheCreationTokens || 0
    const cacheRead = session.tokenUsage.cacheReadTokens || 0
    const tokens = input + output + cacheCreate + cacheRead
    totalInputTokens += input
    totalOutputTokens += output
    totalTurns += session.turnCount

    const source = session.source || 'claude-code'
    let srcStats = sourceMap.get(source)
    if (!srcStats) {
      srcStats = {
        source,
        label: SOURCE_LABELS[source] || source,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionCount: 0,
        turnCount: 0
      }
      sourceMap.set(source, srcStats)
    }
    srcStats.totalTokens += tokens
    srcStats.inputTokens += input
    srcStats.outputTokens += output
    srcStats.sessionCount += 1
    srcStats.turnCount += session.turnCount

    // byModel: split tokens equally across models used in this session
    const sessionModels = session.models?.length ? session.models : ['unknown']
    const tokensPerModel = Math.round(tokens / sessionModels.length)
    for (const m of sessionModels) {
      let ms = modelMap.get(m)
      if (!ms) { ms = { model: m, totalTokens: 0, sessionCount: 0 }; modelMap.set(m, ms) }
      ms.totalTokens += tokensPerModel
      ms.sessionCount += 1
    }

    const { project, fullPath } = getProjectFromCwds(session.cwds)
    let projStats = projectMap.get(fullPath)
    if (!projStats) {
      projStats = {
        project,
        fullPath,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionCount: 0,
        turnCount: 0,
        sources: []
      }
      projectMap.set(fullPath, projStats)
    }
    projStats.totalTokens += tokens
    projStats.inputTokens += input
    projStats.outputTokens += output
    projStats.sessionCount += 1
    projStats.turnCount += session.turnCount
    if (!projStats.sources.includes(source)) {
      projStats.sources.push(source)
    }

    const dateKey = toDateStr(session.updatedAt)
    let dateStats = dateMap.get(dateKey)
    if (!dateStats) {
      dateStats = emptyDateStats(dateKey)
      dateMap.set(dateKey, dateStats)
    }
    dateStats.totalTokens += tokens
    dateStats.inputTokens += input
    dateStats.outputTokens += output
    dateStats.sessionCount += 1
    dateStats.turnCount += session.turnCount
    dateStats.bySource[source] = (dateStats.bySource[source] || 0) + tokens
    dateStats.byProject[project] = (dateStats.byProject[project] || 0) + tokens
    const estTime = sessionTimes?.get(session.sessionId) || session.estimatedTime || 0
    totalTime += estTime
    dateStats.totalTime += estTime
    dateStats.byProjectTime[project] = (dateStats.byProjectTime[project] || 0) + estTime
  }

  const folderMap = new Map<string, FolderStats>()
  for (const folder of folders) {
    const sessionIdSet = new Set(folder.sessionIds)
    folderSessionSet.set(folder.id, sessionIdSet)
    const stats: FolderStats = {
      folderId: folder.id,
      folderName: folder.name,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionCount: 0,
      turnCount: 0
    }
    for (const session of sessions) {
      if (sessionIdSet.has(session.sessionId)) {
        const input = session.tokenUsage.inputTokens
        const output = session.tokenUsage.outputTokens
        stats.totalTokens += input + output
        stats.inputTokens += input
        stats.outputTokens += output
        stats.sessionCount += 1
        stats.turnCount += session.turnCount
      }
    }
    folderMap.set(folder.id, stats)
  }

  const bySource = SOURCE_ORDER.map(s => sourceMap.get(s)!).filter(Boolean)
  for (const [key, stats] of sourceMap) {
    if (!SOURCE_ORDER.includes(key as typeof SOURCE_ORDER[number])) {
      bySource.push(stats)
    }
  }

  const byProject = Array.from(projectMap.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  const byFolder = Array.from(folderMap.values()).sort((a, b) => b.totalTokens - a.totalTokens)
  const INTERNAL_MODEL_NAMES = new Set(['unknown', '<synthetic>'])
  const byModel = Array.from(modelMap.values())
    .filter(m => !INTERNAL_MODEL_NAMES.has(m.model))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const last365 = getLast365Days()
  const byDate = last365.map(date => dateMap.get(date) || emptyDateStats(date))
  const heatmap: HeatmapEntry[] = last365.map(date => {
    const stats = dateMap.get(date)
    const value = stats?.totalTokens || 0
    return { date, value, level: getHeatmapLevel(value) }
  })

  const activeDays = byDate.filter(d => d.totalTokens > 0).length

  return {
    totalTokens: Array.from(sourceMap.values()).reduce((s, m) => s + m.totalTokens, 0),
    totalInputTokens,
    totalOutputTokens,
    totalSessions: sessions.length,
    totalTurns,
    totalTime,
    activeDays,
    bySource,
    byModel,
    byProject,
    byFolder,
    byDate,
    heatmap
  }
}
