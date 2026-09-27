import type { SessionSummary, SessionGroup, SessionSource } from './session-types'
import {
  accountingForSession,
  processedTotal,
  totalCacheWriteTokens,
  uniqueBillingEvents,
  type TokenAccounting,
  type UsageEvent
} from './token-accounting'
import {
  aggregateValuations,
  valuationForAccounting,
  valueUsageEvent,
  type Valuation
} from './token-valuation'
import { usageFactsForSession } from './usage-fact-store'
import type { UsageFact } from './analysis-contract'
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  valuationCapabilityForSource,
  type ValuationCapability
} from '../shared/provider-capabilities'
import {
  sessionHasAuthoritativeUsage,
  sessionHasParsedTranscript
} from './session-provider-outcome'

export type TokenDataStatus = 'available' | 'partial' | 'unavailable' | 'no-data'

export interface SourceStats {
  source: string
  label: string
  valuationCapability: ValuationCapability
  totalTokens: number
  inputTokens: number
  outputTokens: number
  /** @deprecated Compatibility alias for detectedSessionCount. */
  sessionCount: number
  detectedSessionCount: number
  parsedSessionCount: number
  usageAvailableSessionCount: number
  usageUnavailableSessionCount: number
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
  /** @deprecated Compatibility alias for detectedSessionCount. */
  sessionCount: number
  detectedSessionCount: number
  parsedSessionCount: number
  usageAvailableSessionCount: number
  usageUnavailableSessionCount: number
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
  /** @deprecated Compatibility alias for detectedSessionCount. */
  sessionCount: number
  detectedSessionCount: number
  parsedSessionCount: number
  usageAvailableSessionCount: number
  usageUnavailableSessionCount: number
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
  byFolder: Record<string, number>
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
  /** @deprecated Compatibility alias for detectedSessionCount. */
  totalSessions: number
  detectedSessionCount: number
  parsedSessionCount: number
  usageAvailableSessionCount: number
  usageUnavailableSessionCount: number
  tokenAvailableSessions: number
  tokenUnavailableSessions: number
  totalTurns: number
  totalTime: number
  activeDays: number
  unknownTimeUsage: { eventCount: number; totalTokens: number }
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

const SOURCE_ORDER: SessionSource[] = BUILTIN_PROVIDER_DEFINITIONS.map((entry) => entry.sourceId)
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  BUILTIN_PROVIDER_DEFINITIONS.map((entry) => [entry.sourceId, entry.manifest.displayName])
)

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
    byFolder: {},
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

/**
 * One billing owner's UsageFact, cut down to what outlives the session it came
 * from: the keys of usage-facts' billing_rank, and what the day, hour and
 * unknown-time rollups add up. Whole facts (valuation history, pricing trace)
 * are not kept across sessions.
 */
interface OwnerFact {
  agentScope: UsageFact['agentScope']
  occurredAt: string | null
  eventId: string
  occurredDay: string
  occurredHour: number | null
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  callCount: number
  turnCount: number
}

function ownerFact(fact: UsageFact): OwnerFact {
  return {
    agentScope: fact.agentScope,
    occurredAt: fact.occurredAt,
    eventId: fact.eventId,
    occurredDay: fact.occurredDay,
    occurredHour: fact.occurredHour,
    nonCachedInputTokens: fact.nonCachedInputTokens,
    cacheReadTokens: fact.cacheReadTokens,
    cacheWriteTokens: fact.cacheWriteTokens,
    outputTokens: fact.outputTokens,
    callCount: fact.callCount,
    turnCount: fact.turnCount
  }
}

function scopeRank(scope: UsageFact['agentScope']): number {
  return scope === 'main' ? 0 : scope === 'subagent' ? 1 : 2
}

/**
 * Whether `a` comes before `b` in usage-facts' billing_rank, which picks the
 * copy of a billing fact that aggregates count (canonicalizeBillingFacts in
 * usage-fact-store.ts): main, then subagent, then any other scope; timestamped
 * before untimed; then occurred_at, then event_id. SQLite orders those two as
 * TEXT, byte by byte, so compare the raw strings: "…12:00:00.000Z" comes before
 * "…12:00:00Z", although both are the same instant.
 */
function precedesInBillingRank(a: OwnerFact, b: OwnerFact): boolean {
  const scope = scopeRank(a.agentScope) - scopeRank(b.agentScope)
  if (scope !== 0) return scope < 0
  if ((a.occurredAt === null) !== (b.occurredAt === null)) return b.occurredAt === null
  if (a.occurredAt !== b.occurredAt) return a.occurredAt! < b.occurredAt!
  return a.eventId < b.eventId
}

interface SessionLedger {
  accounting: TokenAccounting
  parsed: boolean
  /** uniqueBillingEvents(accounting.usageEvents): one owner per billing fact within the session. */
  owners: UsageEvent[]
  /** facts[i] is owners[i]'s usage fact (parsed sessions only). */
  facts: OwnerFact[]
  /** Indexes into owners whose billing fact counts in another session. */
  lost?: Set<number>
}

/**
 * The cross-session pass. One billing fact can reach two sessions (a transcript
 * that carries calls another session also recorded). usage-facts, and so the
 * Insights page, counts it once by billing_fact_id, in the copy billing_rank
 * puts first; the global rollups do the same. Within a session the owners are
 * uniqueBillingEvents' as before; across sessions they compete by the
 * billingFactId usageFactsForSession derives. That id is session-scoped when a
 * call has no billingFactKey (legacy aggregates, the old Codex session total,
 * Claude rows without an id), so those calls never merge across sessions.
 *
 * A losing copy is recorded by session and owner index, never by event object:
 * two sessions can share one ledger object, and dropping the object would drop
 * both copies. Only slim owner facts are kept, and usageFactsForSession runs
 * once per session.
 */
function sessionLedgers(sessions: SessionSummary[]): SessionLedger[] {
  const ledgers: SessionLedger[] = []
  const winners = new Map<string, { session: number; owner: number }>()
  for (const session of sessions) {
    const accounting = accountingForSession(session)
    const parsed = sessionHasParsedTranscript(session)
    const ledger: SessionLedger = {
      accounting,
      parsed,
      owners: parsed ? uniqueBillingEvents(accounting.usageEvents) : [],
      facts: []
    }
    const sessionIndex = ledgers.push(ledger) - 1
    if (!parsed) continue
    // Facts map accounting.usageEvents one to one, copies included. Align by
    // index, not by object: a legacy session's accounting is rebuilt on every
    // accountingForSession call, usageFactsForSession's own included.
    const usageFacts = usageFactsForSession(session)
    const eventIndex = new Map(accounting.usageEvents.map((event, index) => [event, index] as const))
    ledger.owners.forEach((owner, ownerIndex) => {
      const usageFact = usageFacts[eventIndex.get(owner)!]
      const fact = ownerFact(usageFact)
      ledger.facts.push(fact)
      const winner = winners.get(usageFact.billingFactId)
      if (!winner) {
        winners.set(usageFact.billingFactId, { session: sessionIndex, owner: ownerIndex })
      } else if (precedesInBillingRank(fact, ledgers[winner.session].facts[winner.owner])) {
        (ledgers[winner.session].lost ??= new Set()).add(winner.owner)
        winners.set(usageFact.billingFactId, { session: sessionIndex, owner: ownerIndex })
      } else {
        (ledger.lost ??= new Set()).add(ownerIndex)
      }
    })
  }
  return ledgers
}

/** A session's share of the global token totals. */
interface CountedUsage {
  tokens: number
  conversationOnly: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** The session's ledger less its owners whose billing fact counts in another session. */
function countedUsage(ledger: SessionLedger): CountedUsage {
  const { accounting, facts, lost } = ledger
  const components = accounting.components!
  const usage: CountedUsage = {
    tokens: accounting.billingTotal!,
    conversationOnly: accounting.conversationOnly || 0,
    input: accountingInput(accounting),
    output: components.outputTokens,
    cacheRead: components.cacheReadTokens,
    cacheWrite: totalCacheWriteTokens(components)
  }
  for (const ownerIndex of lost ?? []) {
    const fact = facts[ownerIndex]
    const input = fact.nonCachedInputTokens + fact.cacheReadTokens + fact.cacheWriteTokens
    const tokens = input + fact.outputTokens
    usage.tokens -= tokens
    if (fact.agentScope === 'main') usage.conversationOnly -= tokens
    usage.input -= input
    usage.output -= fact.outputTokens
    usage.cacheRead -= fact.cacheReadTokens
    usage.cacheWrite -= fact.cacheWriteTokens
  }
  return usage
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
  folders: SessionGroup[],
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
      valuationCapability: valuationCapabilityForSource(source),
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      sessionCount: 0,
      detectedSessionCount: 0,
      parsedSessionCount: 0,
      usageAvailableSessionCount: 0,
      usageUnavailableSessionCount: 0,
      turnCount: 0,
      tokenAvailableSessions: 0,
      tokenUnavailableSessions: 0,
      tokenDataStatus: 'no-data'
    })
  }

  const projectMap = new Map<string, ProjectStats>()
  const dateMap = new Map<string, DateStats>()
  const dateSessionIds = new Map<string, Set<string>>()
  const folderIdsBySession = new Map<string, string[]>()
  for (const folder of folders) {
    for (const sessionId of folder.sessionIds) {
      const ids = folderIdsBySession.get(sessionId) || []
      if (!ids.includes(folder.id)) ids.push(folder.id)
      folderIdsBySession.set(sessionId, ids)
    }
  }
  const modelMap = new Map<string, { totalTokens: number; sessionIds: Set<string> }>()
  const toolAgg = new Map<string, number>()
  const bySession: InsightsData['bySession'] = []
  const ledgers = sessionLedgers(rollupSessions)
  // Per rollup session: its share of the global token totals, null when its
  // usage is unavailable. byFolder reads it too.
  const countedUsages: Array<CountedUsage | null> = []
  const sessionValuations: Valuation[] = []
  // The global valuation's per-session parts: a session that lost copies is
  // revalued from the owners it keeps, any other reuses its own valuation, so
  // without cross-session copies the total is bit for bit what it was.
  const countedValuations: Valuation[] = []
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
  let parsedSessionCount = 0
  let filesRead = 0
  let filesWritten = 0
  let filesEdited = 0
  let unknownTimeEvents = 0
  let unknownTimeTokens = 0

  for (const [sessionIndex, session] of rollupSessions.entries()) {
    const source = session.source || 'claude-code'
    const ledger = ledgers[sessionIndex]
    const { accounting, parsed, owners, facts, lost } = ledger
    const available = sessionHasAuthoritativeUsage(session) && accounting.billingTotal !== null && accounting.components !== null
    const usage = available ? countedUsage(ledger) : null
    countedUsages.push(usage)
    const sessionValuation = valuationForAccounting(accounting)
    const { project, fullPath } = getProjectFromCwds(session.cwds)

    if (parsed) {
      parsedSessionCount++
      sessionValuations.push(sessionValuation)
      countedValuations.push(lost
        ? aggregateValuations(owners.filter((_, index) => !lost.has(index)).map((event) => valueUsageEvent(event)))
        : sessionValuation)
      // The billing owners valuationForAccounting values: a forked child's copy
      // shares its parent's keys and must not replace the parent's event here.
      for (const event of owners) {
        uniqueValuationEvents.set(`${session.sessionId}:${event.billingFactKey || event.dedupKey}`, event)
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
    }

    let sourceStats = sourceMap.get(source)
    if (!sourceStats) {
      sourceStats = {
        source,
        label: SOURCE_LABELS[source] || source,
        valuationCapability: valuationCapabilityForSource(source),
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionCount: 0,
        detectedSessionCount: 0,
        parsedSessionCount: 0,
        usageAvailableSessionCount: 0,
        usageUnavailableSessionCount: 0,
        turnCount: 0,
        tokenAvailableSessions: 0,
        tokenUnavailableSessions: 0,
        tokenDataStatus: 'no-data'
      }
      sourceMap.set(source, sourceStats)
    }
    sourceStats.sessionCount++
    sourceStats.detectedSessionCount++
    if (parsed) {
      sourceStats.parsedSessionCount++
      sourceStats.turnCount += session.turnCount
    }

    let projectStats = projectMap.get(fullPath)
    if (!projectStats) {
      projectStats = {
        project,
        fullPath,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        sessionCount: 0,
        detectedSessionCount: 0,
        parsedSessionCount: 0,
        usageAvailableSessionCount: 0,
        usageUnavailableSessionCount: 0,
        turnCount: 0,
        sources: [],
        tokenAvailableSessions: 0,
        tokenUnavailableSessions: 0
      }
      projectMap.set(fullPath, projectStats)
    }
    projectStats.sessionCount++
    projectStats.detectedSessionCount++
    if (parsed) {
      projectStats.parsedSessionCount++
      projectStats.turnCount += session.turnCount
    }
    if (!projectStats.sources.includes(source)) projectStats.sources.push(source)

    // Detected-only, empty and manifest placeholders remain visible as detected
    // inventory, but never enter usage/turn/session statistical denominators.
    if (!parsed) continue

    if (usage) {
      tokenAvailableSessions++
      sourceStats.tokenAvailableSessions++
      projectStats.tokenAvailableSessions++
      sourceStats.usageAvailableSessionCount++
      projectStats.usageAvailableSessionCount++
      totalTokens += usage.tokens
      conversationOnlyTokens += usage.conversationOnly
      totalInputTokens += usage.input
      totalOutputTokens += usage.output
      totalCacheRead += usage.cacheRead
      totalCacheCreate += usage.cacheWrite
      sourceStats.totalTokens += usage.tokens
      sourceStats.inputTokens += usage.input
      sourceStats.outputTokens += usage.output
      projectStats.totalTokens += usage.tokens
      projectStats.inputTokens += usage.input
      projectStats.outputTokens += usage.output

      // Billing owners only, the calls totalTokens counts: a forked child's
      // copy of its parent's call would add that call again under a model, and
      // so would a copy whose billing fact counts in another session.
      for (const [ownerIndex, event] of owners.entries()) {
        if (lost?.has(ownerIndex) || !(event.modelCanonical || event.modelRaw)) continue
        const model = event.modelCanonical || normalizeModelName(event.modelRaw!)
        const entry = modelMap.get(model) || { totalTokens: 0, sessionIds: new Set<string>() }
        entry.totalTokens += processedTotal(event.components)
        entry.sessionIds.add(session.sessionId)
        modelMap.set(model, entry)
      }
    } else {
      tokenUnavailableSessions++
      sourceStats.tokenUnavailableSessions++
      projectStats.tokenUnavailableSessions++
      sourceStats.usageUnavailableSessionCount++
      projectStats.usageUnavailableSessionCount++
    }

    totalTurns += session.turnCount
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

    const estimatedTime = sessionTimes?.get(session.sessionId) || session.estimatedTime || 0
    totalTime += estimatedTime

    const factDays = new Map<string, number>()
    // Billing owners' facts only, so byDate, heatmap, hourly and unknown-time
    // usage add up to totalTokens; a copy whose billing fact counts in another
    // session adds nothing either. The session was still active on that copy's
    // day, though: a day's session count and the session's time share follow
    // all of the session's own owners.
    for (const [ownerIndex, fact] of facts.entries()) {
      const counted = !lost?.has(ownerIndex)
      const factInput = fact.nonCachedInputTokens + fact.cacheReadTokens + fact.cacheWriteTokens
      const factTokens = factInput + fact.outputTokens
      if (fact.occurredDay === 'unknown-time' || fact.occurredHour === null) {
        if (counted) {
          unknownTimeEvents += fact.callCount
          unknownTimeTokens += factTokens
        }
        continue
      }

      let dateStats = dateMap.get(fact.occurredDay)
      if (!dateStats) {
        dateStats = emptyDateStats(fact.occurredDay)
        dateMap.set(fact.occurredDay, dateStats)
      }
      const ids = dateSessionIds.get(fact.occurredDay) || new Set<string>()
      ids.add(session.sessionId)
      dateSessionIds.set(fact.occurredDay, ids)
      factDays.set(fact.occurredDay, (factDays.get(fact.occurredDay) || 0) + fact.callCount)
      if (!counted) continue

      hourly[fact.occurredHour] += fact.callCount
      dateStats.totalTokens += factTokens
      dateStats.inputTokens += factInput
      dateStats.outputTokens += fact.outputTokens
      dateStats.turnCount += fact.turnCount
      dateStats.bySource[source] = (dateStats.bySource[source] || 0) + factTokens
      dateStats.byProject[project] = (dateStats.byProject[project] || 0) + factTokens
      for (const folderId of folderIdsBySession.get(session.sessionId) || []) {
        dateStats.byFolder[folderId] = (dateStats.byFolder[folderId] || 0) + factTokens
      }
    }

    // Active time has no request-level timestamp. Distribute it across the
    // session's real event days by call count instead of assigning it to updatedAt.
    const timedCalls = [...factDays.values()].reduce((sum, count) => sum + count, 0)
    if (estimatedTime > 0 && timedCalls > 0) {
      for (const [day, calls] of factDays) {
        const dateStats = dateMap.get(day)!
        const share = estimatedTime * calls / timedCalls
        dateStats.totalTime += share
        dateStats.byProjectTime[project] = (dateStats.byProjectTime[project] || 0) + share
      }
    }
  }

  for (const [date, sessionIds] of dateSessionIds) {
    const stats = dateMap.get(date)
    if (stats) stats.sessionCount = sessionIds.size
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
      detectedSessionCount: 0,
      parsedSessionCount: 0,
      usageAvailableSessionCount: 0,
      usageUnavailableSessionCount: 0,
      turnCount: 0,
      tokenAvailableSessions: 0,
      tokenUnavailableSessions: 0
    }
    for (const [sessionIndex, session] of rollupSessions.entries()) {
      if (!sessionIds.has(session.sessionId)) continue
      stats.sessionCount++
      stats.detectedSessionCount++
      if (!ledgers[sessionIndex].parsed) continue
      stats.parsedSessionCount++
      stats.turnCount += session.turnCount
      const usage = countedUsages[sessionIndex]
      if (!usage) {
        stats.tokenUnavailableSessions++
        stats.usageUnavailableSessionCount++
        continue
      }
      stats.tokenAvailableSessions++
      stats.usageAvailableSessionCount++
      stats.totalTokens += usage.tokens
      stats.inputTokens += usage.input
      stats.outputTokens += usage.output
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
  // activeDays intentionally spans the full fact history, while byDate and
  // heatmap retain their legacy 365-day presentation window.
  const activeDays = dateSessionIds.size
  const projectsTotal = byProject.reduce((sum, project) => sum + project.totalTokens, 0)
  const sessionsTotal = bySession.reduce((sum, session) => sum + (session.totalTokens || 0), 0)
  const difference = Math.max(Math.abs(totalTokens - projectsTotal), Math.abs(totalTokens - sessionsTotal))
  const valuation = aggregateValuations(countedValuations)
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
    detectedSessionCount: rollupSessions.length,
    parsedSessionCount,
    usageAvailableSessionCount: tokenAvailableSessions,
    usageUnavailableSessionCount: tokenUnavailableSessions,
    tokenAvailableSessions,
    tokenUnavailableSessions,
    totalTurns,
    totalTime,
    activeDays,
    unknownTimeUsage: { eventCount: unknownTimeEvents, totalTokens: unknownTimeTokens },
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
        // Per-session sums and the flat per-event sum add the same amounts in a
        // different order, so their last bits differ at real scale (1 ULP is
        // already above 1e-12 from $8,192). USD gets a tolerance relative to the
        // total; coverage stays near-exact, both sides divide exact token sums.
        ok: valuationDifference <= 1e-9 * Math.max(1, Math.abs(globalUsd || 0)) && coverageDifference <= 1e-9
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
