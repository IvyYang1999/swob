import type { SessionSummary, Folder, SessionSource } from './types'
import {
  accountingForSession,
  processedTotal,
  totalCacheWriteTokens,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'
import {
  aggregateValuations,
  valuationForAccounting,
  valueUsageEvent,
  type Valuation
} from './token-valuation'

export type TokenDataStatus = 'available' | 'partial' | 'unavailable' | 'no-data'

export interface SourceStats {
  source: string
  label: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  tokenDataStatus: TokenDataStatus
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
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
}

export interface FolderStats {
  folderId: string
  folderName: string
  totalTokens: number
  inputTokens: number
  outputTokens: number
  sessionCount: number
  turnCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
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
  /** Processed/billing total after provider normalization and call deduplication. */
  totalTokens: number
  conversationOnlyTokens: number
  /** Processed input = non-cached input + cache read + cache write. */
  totalInputTokens: number
  totalOutputTokens: number
  totalSessions: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  totalTurns: number
  totalTime: number
  activeDays: number
  bySource: SourceStats[]
  byModel: ModelStats[]
  byProject: ProjectStats[]
  byFolder: FolderStats[]
  byDate: DateStats[]
  heatmap: HeatmapEntry[]
  bySession: Array<{
    sessionId: string
    projectPath: string
    source: string
    totalTokens: number | null
    conversationOnlyTokens: number | null
    provenance: string
    valuation: Valuation
  }>
  reconciliation: {
    global: number
    projects: number
    sessions: number
    difference: number
    ok: boolean
    valuation: {
      globalUsd: number | null
      sessionsUsd: number | null
      uniqueEventsUsd: number | null
      difference: number
      coverageDifference: number
      ok: boolean
    }
  }
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  valuation: Valuation
  hourlyDistribution: number[]
  turnCountDistribution: number[]
  topTools: Array<{ name: string; count: number }>
  codeChanges: { filesRead: number; filesWritten: number; filesEdited: number }
}

const SOURCE_ORDER: SessionSource[] = [
  'claude-code', 'codex', 'cursor', 'opencode', 'zcode', 'cc-mirror',
  'antigravity', 'grok', 'pi', 'kimi', 'hermes'
]
const SOURCE_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  zcode: 'ZCode',
  'cc-mirror': 'CC Mirror',
  antigravity: 'Antigravity',
  grok: 'Grok / Factory',
  pi: 'Pi',
  kimi: 'Kimi Code',
  hermes: 'Hermes'
}

function getProjectFromCwds(cwds: string[]): { project: string; fullPath: string } {
  const cwd = cwds[0] || '(unknown project)'
  const parts = cwd.split('/')
  const project = parts[parts.length - 1] || cwd
  return { project, fullPath: cwd }
}

function normalizeModelName(raw: string): string {
  let model = raw.includes('/') ? raw.split('/').pop()! : raw
  model = model.replace(/-thinking$/, '')
  model = model.replace(/^(claude-\w+-\d+-\d+)-\d{8}$/, '$1')
  const dated = model.match(/^claude-(\d+)\.(\d+)-(opus|sonnet|haiku)-\d{8}$/)
  if (dated) return `claude-${dated[3]}-${dated[1]}-${dated[2]}`
  return model.replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/, 'claude-$1-$2-$3')
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
    const date = new Date(now)
    date.setDate(date.getDate() - i)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    days.push(`${year}-${month}-${day}`)
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

function tokenStatus(available: number, unavailable: number): TokenDataStatus {
  if (available === 0 && unavailable === 0) return 'no-data'
  if (available === 0) return 'unavailable'
  if (unavailable > 0) return 'partial'
  return 'available'
}

function accountingInput(accounting: TokenAccounting): number {
  const components = accounting.components
  return components
    ? components.nonCachedInputTokens + components.cacheReadTokens + totalCacheWriteTokens(components)
    : 0
}

const THIRTY_MINUTES = 30 * 60 * 1000

/** Adjacent message gaps are accumulated, with idle gaps over 30 minutes excluded. */
export function estimateActiveTime(messages: { timestamp: string }[]): number {
  if (messages.length < 2) return 0
  const sorted = [...messages].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  let total = 0
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()
    if (gap > 0 && gap < THIRTY_MINUTES) total += gap
  }
  return total
}

export function buildInsights(
  sessions: SessionSummary[],
  folders: Folder[],
  sessionTimes?: Map<string, number>
): InsightsData {
  // Intra-file branches are views over physical calls and must not inflate rollups.
  const rollupSessions = sessions.filter((session) =>
    !session.branchLeafUuid && session.tokenAccounting?.excludedFromRollups !== true
  )
  const sourceMap = new Map<string, SourceStats>()
  for (const source of SOURCE_ORDER) {
    sourceMap.set(source, {
      source,
      label: SOURCE_LABELS[source],
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionCount: 0,
      turnCount: 0,
      tokenAvailableSessions: 0,
      tokenUnavailableSessions: 0,
      tokenDataStatus: 'no-data'
    })
  }

  const projectMap = new Map<string, ProjectStats>()
  const dateMap = new Map<string, DateStats>()
  const modelMap = new Map<string, { totalTokens: number; sessionIds: Set<string> }>()
  const toolAgg = new Map<string, number>()
  const bySession: InsightsData['bySession'] = []
  const sessionValuations: Valuation[] = []
  const uniqueValuationEvents = new Map<string, UsageEvent>()
  const hourly = new Array(24).fill(0) as number[]
  const turnBuckets = [0, 0, 0, 0, 0, 0]
  let totalTokens = 0
  let conversationOnlyTokens = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheRead = 0
  let totalCacheCreate = 0
  let totalTurns = 0
  let totalTime = 0
  let tokenAvailableSessions = 0
  let tokenUnavailableSessions = 0
  let filesRead = 0
  let filesWritten = 0
  let filesEdited = 0

  for (const session of rollupSessions) {
    const source = session.source || 'claude-code'
    const accounting = accountingForSession(session)
    const available = accounting.billingTotal !== null && accounting.components !== null
    const input = available ? accountingInput(accounting) : 0
    const output = available ? accounting.components!.outputTokens : 0
    const tokens = available ? accounting.billingTotal! : 0
    const sessionValuation = valuationForAccounting(accounting)
    const { project, fullPath } = getProjectFromCwds(session.cwds)

    sessionValuations.push(sessionValuation)
    for (const event of accounting.usageEvents) {
      uniqueValuationEvents.set(`${session.sessionId}:${event.dedupKey}`, event)
    }

    bySession.push({
      sessionId: session.sessionId,
      projectPath: fullPath,
      source,
      totalTokens: accounting.billingTotal,
      conversationOnlyTokens: accounting.conversationOnly,
      provenance: accounting.provenance,
      valuation: sessionValuation
    })

    let sourceStats = sourceMap.get(source)
    if (!sourceStats) {
      sourceStats = {
        source,
        label: SOURCE_LABELS[source] || source,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionCount: 0,
        turnCount: 0,
        tokenAvailableSessions: 0,
        tokenUnavailableSessions: 0,
        tokenDataStatus: 'no-data'
      }
      sourceMap.set(source, sourceStats)
    }
    sourceStats.sessionCount++
    sourceStats.turnCount += session.turnCount

    let projectStats = projectMap.get(fullPath)
    if (!projectStats) {
      projectStats = {
        project,
        fullPath,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionCount: 0,
        turnCount: 0,
        sources: [],
        tokenAvailableSessions: 0,
        tokenUnavailableSessions: 0
      }
      projectMap.set(fullPath, projectStats)
    }
    projectStats.sessionCount++
    projectStats.turnCount += session.turnCount
    if (!projectStats.sources.includes(source)) projectStats.sources.push(source)

    if (available) {
      tokenAvailableSessions++
      sourceStats.tokenAvailableSessions++
      projectStats.tokenAvailableSessions++
      totalTokens += tokens
      conversationOnlyTokens += accounting.conversationOnly || 0
      totalInputTokens += input
      totalOutputTokens += output
      totalCacheRead += accounting.components!.cacheReadTokens
      totalCacheCreate += totalCacheWriteTokens(accounting.components!)
      sourceStats.totalTokens += tokens
      sourceStats.inputTokens += input
      sourceStats.outputTokens += output
      projectStats.totalTokens += tokens
      projectStats.inputTokens += input
      projectStats.outputTokens += output

      const eventsWithModels = accounting.usageEvents.filter((event) => event.modelCanonical || event.modelRaw)
      if (eventsWithModels.length > 0) {
        for (const event of eventsWithModels) {
          const model = event.modelCanonical || normalizeModelName(event.modelRaw!)
          const entry = modelMap.get(model) || { totalTokens: 0, sessionIds: new Set<string>() }
          entry.totalTokens += processedTotal(event.components)
          entry.sessionIds.add(session.sessionId)
          modelMap.set(model, entry)
        }
      }
    } else {
      tokenUnavailableSessions++
      sourceStats.tokenUnavailableSessions++
      projectStats.tokenUnavailableSessions++
    }

    totalTurns += session.turnCount
    try {
      const hour = new Date(session.createdAt).getHours()
      if (hour >= 0 && hour < 24) hourly[hour]++
    } catch { /* ignore invalid dates */ }
    const turns = session.turnCount
    if (turns <= 5) turnBuckets[0]++
    else if (turns <= 20) turnBuckets[1]++
    else if (turns <= 50) turnBuckets[2]++
    else if (turns <= 100) turnBuckets[3]++
    else if (turns <= 500) turnBuckets[4]++
    else turnBuckets[5]++
    for (const [name, count] of Object.entries(session.toolUsage)) {
      toolAgg.set(name, (toolAgg.get(name) || 0) + count)
    }
    for (const file of session.referencedFiles || []) {
      if (file.actions.includes('write')) filesWritten++
      else if (file.actions.includes('edit')) filesEdited++
      else if (file.actions.includes('read')) filesRead++
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
    dateStats.sessionCount++
    dateStats.turnCount += session.turnCount
    dateStats.bySource[source] = (dateStats.bySource[source] || 0) + tokens
    dateStats.byProject[project] = (dateStats.byProject[project] || 0) + tokens
    const estimatedTime = sessionTimes?.get(session.sessionId) || session.estimatedTime || 0
    totalTime += estimatedTime
    dateStats.totalTime += estimatedTime
    dateStats.byProjectTime[project] = (dateStats.byProjectTime[project] || 0) + estimatedTime
  }

  for (const stats of sourceMap.values()) {
    stats.tokenDataStatus = tokenStatus(stats.tokenAvailableSessions, stats.tokenUnavailableSessions)
  }

  const folderMap = new Map<string, FolderStats>()
  for (const folder of folders) {
    const sessionIds = new Set(folder.sessionIds)
    const stats: FolderStats = {
      folderId: folder.id,
      folderName: folder.name,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionCount: 0,
      turnCount: 0,
      tokenAvailableSessions: 0,
      tokenUnavailableSessions: 0
    }
    for (const session of rollupSessions) {
      if (!sessionIds.has(session.sessionId)) continue
      const accounting = accountingForSession(session)
      stats.sessionCount++
      stats.turnCount += session.turnCount
      if (accounting.billingTotal === null || !accounting.components) {
        stats.tokenUnavailableSessions++
        continue
      }
      stats.tokenAvailableSessions++
      stats.totalTokens += accounting.billingTotal
      stats.inputTokens += accountingInput(accounting)
      stats.outputTokens += accounting.components.outputTokens
    }
    folderMap.set(folder.id, stats)
  }

  const bySource = SOURCE_ORDER.map((source) => sourceMap.get(source)!).filter(Boolean)
  for (const [source, stats] of sourceMap) {
    if (!SOURCE_ORDER.includes(source as SessionSource)) bySource.push(stats)
  }
  const byProject = [...projectMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const byFolder = [...folderMap.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  const byModel = [...modelMap.entries()]
    .filter(([model]) => model !== 'unknown' && model !== '<synthetic>')
    .map(([model, value]) => ({ model, totalTokens: value.totalTokens, sessionCount: value.sessionIds.size }))
    .sort((a, b) => b.totalTokens - a.totalTokens)

  const last365 = getLast365Days()
  const byDate = last365.map((date) => dateMap.get(date) || emptyDateStats(date))
  const heatmap = last365.map<HeatmapEntry>((date) => {
    const value = dateMap.get(date)?.totalTokens || 0
    return { date, value, level: getHeatmapLevel(value) }
  })
  const activeDays = byDate.filter((date) => date.sessionCount > 0).length
  const projectsTotal = byProject.reduce((sum, project) => sum + project.totalTokens, 0)
  const sessionsTotal = bySession.reduce((sum, session) => sum + (session.totalTokens || 0), 0)
  const difference = Math.max(Math.abs(totalTokens - projectsTotal), Math.abs(totalTokens - sessionsTotal))
  const valuation = aggregateValuations(sessionValuations)
  const uniqueEventsValuation = aggregateValuations(
    [...uniqueValuationEvents.values()].map((event) => valueUsageEvent(event))
  )
  const globalUsd = valuation.usd ?? null
  const sessionsUsd = sessionValuations.some((item) => item.usd !== undefined)
    ? sessionValuations.reduce((sum, item) => sum + (item.usd || 0), 0)
    : null
  const uniqueEventsUsd = uniqueEventsValuation.usd ?? null
  const valuationDifference = Math.max(
    Math.abs((globalUsd || 0) - (sessionsUsd || 0)),
    Math.abs((globalUsd || 0) - (uniqueEventsUsd || 0))
  )
  const coverageDifference = Math.abs(valuation.coveragePercent - uniqueEventsValuation.coveragePercent)

  return {
    totalTokens,
    conversationOnlyTokens,
    totalInputTokens,
    totalOutputTokens,
    totalSessions: rollupSessions.length,
    tokenAvailableSessions,
    tokenUnavailableSessions,
    totalTurns,
    totalTime,
    activeDays,
    bySource,
    byModel,
    byProject,
    byFolder,
    byDate,
    heatmap,
    bySession,
    reconciliation: {
      global: totalTokens,
      projects: projectsTotal,
      sessions: sessionsTotal,
      difference,
      ok: difference === 0,
      valuation: {
        globalUsd,
        sessionsUsd,
        uniqueEventsUsd,
        difference: valuationDifference,
        coverageDifference,
        ok: valuationDifference < 1e-12 && coverageDifference < 1e-12
      }
    },
    totalCacheReadTokens: totalCacheRead,
    totalCacheCreationTokens: totalCacheCreate,
    valuation,
    hourlyDistribution: hourly,
    turnCountDistribution: turnBuckets,
    topTools: [...toolAgg.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    codeChanges: { filesRead, filesWritten, filesEdited }
  }
}
