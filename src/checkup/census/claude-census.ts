/**
 * Claude Code oracle census: every physical JSONL unit under the Claude
 * project roots, read with the spec reader. Only counts, sanitised type names
 * and in-memory identities (never reported) are collected.
 */
import * as path from 'node:path'
import * as fs from 'node:fs'
import { readJsonlFile, emptyJsonlStats, type JsonlFileStats } from './jsonl-census'
import { fingerprint, realDirectory, walkFiles, TimeRange, type FileFingerprint } from './files'

export type LossKind = 'user' | 'assistant' | 'tool_result' | 'meta'
export const LOSS_KINDS: readonly LossKind[] = ['user', 'assistant', 'tool_result', 'meta']

export function emptyLossKinds(): Record<LossKind, number> {
  return { user: 0, assistant: 0, tool_result: 0, meta: 0 }
}

export type ClaudeUnitKind = 'claude-main' | 'claude-subagent' | 'claude-other'

/**
 * ⑤ Token: one assistant row's usage, reduced to its dedup identity and four billable components
 * (design §四 4.5, ccusage-style — the aggregate `cache_creation_input_tokens`, not the 5m/1h breakdown;
 * a difference from Swob's own breakdown-preferring total on requests that carry both is the registered
 * calibration difference `token-accounting.ts:554-568` documents).
 */
export interface ClaudeUsageSnapshot {
  messageId: string | null
  requestId: string | null
  /** Fallback identity when a row has neither id (kept so it is never silently dropped). */
  uuid: string | null
  hasStopReason: boolean
  nonCachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface ClaudeUnit {
  /** Real path (internal only; never reported). */
  path: string
  fixedRoot: '~/.claude/projects' | '~/.claude-window/*/projects'
  kind: ClaudeUnitKind
  /** Real path of `<root>/<project>`. */
  projectDir: string
  /** File name without `.jsonl`. */
  basenameId: string
  /** Subagent layout `<project>/<owner>/subagents/...`: the owner directory name. */
  ownerDirName: string | null
  /** Index of the `subagents` segment relative to the root (1 or 2 for layouts Swob knows). */
  subagentsSegment: number | null
  /** Directories between `subagents` and the file (Swob searches 0..2). */
  subagentDepth: number | null
  before: FileFingerprint | null
  after: FileFingerprint | null
  unreadable: boolean
  stats: JsonlFileStats
  sessionIds: string[]
  conversationRecords: number
  userRecords: number
  assistantRecords: number
  compactBoundaryRows: number
  compactBoundaryUuids: string[]
  /** compact_boundary rows without a string uuid (cannot be deduplicated; counted individually). */
  compactBoundaryRowsWithoutUuid: number
  compactSummaryRows: number
  /** Parseable records that a CR/U+2028/U+2029-splitting reader would lose, by kind. */
  hazardKinds: Record<LossKind, number>
  /** Subset of hazards caused by literal U+2028/U+2029. */
  lineSeparatorKinds: Record<LossKind, number>
  timeRange: { min: string | null; max: string | null }
  // —— C2b (④ lineage) additions: physical evidence, independent of any Swob lineage code ——
  /** Every distinct `uuid` seen in this file (any record type), for the cross-file overlap check below. */
  uuids: string[]
  /** Records carrying a non-null `parentUuid`. */
  parentUuidTotal: number
  /** Of those, how many resolve to a uuid found in this same file (the design's "same-file parent coverage"). */
  parentUuidSameFileCovered: number
  /** `forkedFrom` occurrences (rare/never observed in practice; kept small). */
  forkedFromRefs: Array<{ sessionId: string; messageUuid: string }>
  /** ⑤ Token: this file's own usage-bearing assistant rows (fork-inherited rows excluded, see below). */
  usageSnapshots: ClaudeUsageSnapshot[]
  /** Assistant rows with usage that carried Claude Code's own `forkedFrom` marker (excluded, not copies). */
  forkInheritedUsageRows: number
}

export interface ClaudeCensus {
  roots: Array<{ fixedRoot: ClaudeUnit['fixedRoot']; realPath: string }>
  units: ClaudeUnit[]
  otherFiles: number
  otherBytes: number
  lowerSymlinks: number
  unreadableDirs: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function claudeLossKind(record: Record<string, unknown>): LossKind {
  if (record.type === 'assistant') return 'assistant'
  if (record.type !== 'user') return 'meta'
  const message = record.message as { content?: unknown } | undefined
  if (Array.isArray(message?.content) &&
      message.content.some((part) => !!part && typeof part === 'object' && (part as { type?: unknown }).type === 'tool_result')) {
    return 'tool_result'
  }
  return record.isMeta === true ? 'meta' : 'user'
}

/** Claude project roots, mirroring the documented tool layout (not Swob's code). */
export function claudeProjectRoots(homeDir: string): { roots: ClaudeCensus['roots']; lowerSymlinks: number } {
  const roots: ClaudeCensus['roots'] = []
  let lowerSymlinks = 0
  const standard = realDirectory(path.join(homeDir, '.claude', 'projects'))
  if (standard) roots.push({ fixedRoot: '~/.claude/projects', realPath: standard })
  const windowRoot = realDirectory(path.join(homeDir, '.claude-window'))
  if (windowRoot) {
    let entries: fs.Dirent[] = []
    try { entries = fs.readdirSync(windowRoot, { withFileTypes: true }) } catch { entries = [] }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        lowerSymlinks++
        continue
      }
      if (!entry.isDirectory()) continue
      // Like the standard root, a `projects` root is resolved through its own link.
      const projects = realDirectory(path.join(windowRoot, entry.name, 'projects'))
      if (projects) roots.push({ fixedRoot: '~/.claude-window/*/projects', realPath: projects })
    }
  }
  return { roots, lowerSymlinks }
}

function classify(segments: string[]): Pick<ClaudeUnit, 'kind' | 'ownerDirName' | 'subagentsSegment' | 'subagentDepth'> {
  if (segments.length === 2) return { kind: 'claude-main', ownerDirName: null, subagentsSegment: null, subagentDepth: null }
  const index = segments.indexOf('subagents')
  if (index >= 1 && index < segments.length - 1) {
    return {
      kind: 'claude-subagent',
      ownerDirName: index >= 2 ? segments[index - 1] : null,
      subagentsSegment: index,
      subagentDepth: segments.length - index - 2
    }
  }
  return { kind: 'claude-other', ownerDirName: null, subagentsSegment: null, subagentDepth: null }
}

export async function censusClaude(homeDir: string, options: { signal?: AbortSignal } = {}): Promise<ClaudeCensus> {
  const { roots, lowerSymlinks } = claudeProjectRoots(homeDir)
  const census: ClaudeCensus = { roots, units: [], otherFiles: 0, otherBytes: 0, lowerSymlinks, unreadableDirs: 0 }
  for (const root of roots) {
    const walked = walkFiles(root.realPath, { maxDepth: 8, accept: (name) => name.endsWith('.jsonl') })
    census.otherFiles += walked.otherFiles
    census.otherBytes += walked.otherBytes
    census.lowerSymlinks += walked.lowerSymlinks
    census.unreadableDirs += walked.unreadableDirs
    for (const file of walked.files) {
      census.units.push(await censusClaudeFile(file.path, file.segments, root, options))
    }
  }
  return census
}

export async function censusClaudeFile(
  filePath: string,
  segments: string[],
  root: { fixedRoot: ClaudeUnit['fixedRoot']; realPath: string },
  options: { signal?: AbortSignal } = {}
): Promise<ClaudeUnit> {
  const classification = classify(segments)
  const sessionIds = new Set<string>()
  const compactUuids = new Set<string>()
  const hazardKinds = emptyLossKinds()
  const lineSeparatorKinds = emptyLossKinds()
  const timeRange = new TimeRange()
  let conversationRecords = 0
  let userRecords = 0
  let assistantRecords = 0
  let compactBoundaryRows = 0
  let compactBoundaryRowsWithoutUuid = 0
  let compactSummaryRows = 0
  const uuids = new Set<string>()
  const parentUuidRefs: string[] = []
  const forkedFromRefs: ClaudeUnit['forkedFromRefs'] = []
  const usageSnapshots: ClaudeUsageSnapshot[] = []
  let forkInheritedUsageRows = 0

  const before = fingerprint(filePath)
  let stats: JsonlFileStats = emptyJsonlStats()
  let unreadable = before === null
  if (!unreadable) {
    try {
      stats = await readJsonlFile(filePath, (record, meta) => {
        if (!record || typeof record !== 'object' || Array.isArray(record)) return
        const entry = record as Record<string, unknown>
        timeRange.add(entry.timestamp)
        if (typeof entry.sessionId === 'string' && sessionIds.size < 256) sessionIds.add(entry.sessionId)
        const type = entry.type
        if (type === 'user') userRecords++
        else if (type === 'assistant') {
          assistantRecords++
          // ⑤ Token oracle (design §四 4.5): Claude Code's own `forkedFrom` marker means this row is a
          // copy already counted in its origin session (token-accounting.ts accountClaudeUsage does the
          // same exclusion); everything else with a usage object is a candidate billing snapshot.
          if (entry.forkedFrom) {
            forkInheritedUsageRows++
          } else {
            const message = asRecord(entry.message)
            const usage = asRecord(message?.usage)
            if (usage) {
              usageSnapshots.push({
                messageId: asString(message?.id),
                requestId: asString(entry.requestId) ?? asString(message?.request_id),
                uuid: asString(entry.uuid),
                hasStopReason: !!message?.stop_reason,
                nonCachedInput: asNumber(usage.input_tokens) ?? 0,
                cacheRead: asNumber(usage.cache_read_input_tokens) ?? 0,
                cacheWrite: asNumber(usage.cache_creation_input_tokens) ?? 0,
                output: asNumber(usage.output_tokens) ?? 0
              })
            }
          }
        }
        if (type === 'user' || type === 'assistant' || type === 'system') conversationRecords++
        if (type === 'system' && entry.subtype === 'compact_boundary') {
          compactBoundaryRows++
          if (typeof entry.uuid === 'string') compactUuids.add(entry.uuid)
          else compactBoundaryRowsWithoutUuid++
        }
        if (entry.isCompactSummary === true) compactSummaryRows++
        if (typeof entry.uuid === 'string' && entry.uuid) uuids.add(entry.uuid)
        if (typeof entry.parentUuid === 'string' && entry.parentUuid) parentUuidRefs.push(entry.parentUuid)
        const forkedFrom = entry.forkedFrom as { sessionId?: unknown; messageUuid?: unknown } | undefined
        if (forkedFrom && typeof forkedFrom === 'object' &&
            typeof forkedFrom.sessionId === 'string' && forkedFrom.sessionId &&
            typeof forkedFrom.messageUuid === 'string' && forkedFrom.messageUuid &&
            forkedFromRefs.length < 16) {
          forkedFromRefs.push({ sessionId: forkedFrom.sessionId, messageUuid: forkedFrom.messageUuid })
        }
        if (meta.lineSeparator || meta.bareCr) {
          const kind = claudeLossKind(entry)
          hazardKinds[kind]++
          if (meta.lineSeparator) lineSeparatorKinds[kind]++
        }
      }, options)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      unreadable = true
    }
  }
  const after = fingerprint(filePath)
  const parentUuidSameFileCovered = parentUuidRefs.filter((ref) => uuids.has(ref)).length
  return {
    path: filePath,
    fixedRoot: root.fixedRoot,
    ...classification,
    projectDir: path.join(root.realPath, segments[0]),
    basenameId: path.basename(filePath, '.jsonl'),
    before,
    after,
    unreadable,
    stats,
    sessionIds: [...sessionIds],
    conversationRecords,
    userRecords,
    assistantRecords,
    compactBoundaryRows,
    compactBoundaryUuids: [...compactUuids],
    compactBoundaryRowsWithoutUuid,
    compactSummaryRows,
    hazardKinds,
    lineSeparatorKinds,
    timeRange: { min: timeRange.min, max: timeRange.max },
    uuids: [...uuids],
    parentUuidTotal: parentUuidRefs.length,
    parentUuidSameFileCovered,
    forkedFromRefs,
    usageSnapshots,
    forkInheritedUsageRows
  }
}

interface ClaudeUsageGroup {
  hasStopReason: boolean
  /** Tie-break ("没有就取数值最大的"): sum of the four components, mirroring processedTotal's shape. */
  score: number
  nonCachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface RecountedClaudeUsage {
  components: { nonCachedInput: number; cacheRead: number; cacheWrite: number; output: number }
  /** nonCachedInput + cacheRead + cacheWrite + output (mirrors token-accounting.ts#processedTotal). */
  billingTotal: number
  uniqueRequests: number
  /** Rows excluded because they carried Claude Code's own `forkedFrom` marker. */
  forkInheritedRows: number
}

function betterClaudeGroup(candidate: ClaudeUsageGroup, current: ClaudeUsageGroup): boolean {
  const candidateRank = candidate.hasStopReason ? 1 : 0
  const currentRank = current.hasStopReason ? 1 : 0
  return candidateRank > currentRank || (candidateRank === currentRank && candidate.score > current.score)
}

function claudeUsageGroup(snapshot: ClaudeUsageSnapshot): ClaudeUsageGroup {
  return {
    hasStopReason: snapshot.hasStopReason,
    score: snapshot.nonCachedInput + snapshot.cacheRead + snapshot.cacheWrite + snapshot.output,
    nonCachedInput: snapshot.nonCachedInput,
    cacheRead: snapshot.cacheRead,
    cacheWrite: snapshot.cacheWrite,
    output: snapshot.output
  }
}

/** `message.id` / `requestId` aliases; a row with neither falls back to its own uuid, then its position. */
function claudeUsageAliases(snapshot: ClaudeUsageSnapshot, index: number): string[] {
  const aliases: string[] = []
  if (snapshot.messageId) aliases.push(`message:${snapshot.messageId}`)
  if (snapshot.requestId) aliases.push(`request:${snapshot.requestId}`)
  if (aliases.length > 0) return aliases
  if (snapshot.uuid) return [`uuid:${snapshot.uuid}`]
  return [`row:${index}`]
}

/**
 * ⑤ Token census-level Claude oracle (design §四 4.5, ccusage-style): every assistant row's usage across
 * `units`, deduplicated by `message.id`/`requestId`. A later row can be the first to carry both aliases at
 * once, merging two groups that until then looked separate (a partial streaming snapshot, then a complete
 * one); the group's kept snapshot is the one with a `stop_reason`, else the numerically larger one.
 *
 * Global by construction, like `codexRecountB`: it only reads `units[].usageSnapshots`, never a readout or
 * session list. Restricting to one family's units (main + its subagent files) for a per-session comparison
 * is `checks/tokens.ts`'s job — call this again with just that subset.
 */
export function claudeRecountUsage(units: readonly ClaudeUnit[]): RecountedClaudeUsage {
  const groupOf = new Map<string, string>()
  const groups = new Map<string, ClaudeUsageGroup>()
  let nextGroupId = 0
  let forkInheritedRows = 0
  let index = 0
  for (const unit of units) {
    forkInheritedRows += unit.forkInheritedUsageRows
    for (const snapshot of unit.usageSnapshots) {
      const aliases = claudeUsageAliases(snapshot, index++)
      const existingIds = [...new Set(aliases.map((alias) => groupOf.get(alias)).filter((id): id is string => !!id))]
      const targetId = existingIds[0] ?? `g${nextGroupId++}`
      // A row that bridges two previously separate groups: keep the better of the two, then delete the other.
      for (const otherId of existingIds.slice(1)) {
        if (otherId === targetId) continue
        const other = groups.get(otherId)
        const current = groups.get(targetId)
        if (other) groups.set(targetId, !current || betterClaudeGroup(other, current) ? other : current)
        groups.delete(otherId)
        for (const [alias, id] of groupOf) if (id === otherId) groupOf.set(alias, targetId)
      }
      const candidate = claudeUsageGroup(snapshot)
      const current = groups.get(targetId)
      groups.set(targetId, !current || betterClaudeGroup(candidate, current) ? candidate : current)
      for (const alias of aliases) groupOf.set(alias, targetId)
    }
  }
  const components = { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  for (const group of groups.values()) {
    components.nonCachedInput += group.nonCachedInput
    components.cacheRead += group.cacheRead
    components.cacheWrite += group.cacheWrite
    components.output += group.output
  }
  return {
    components,
    billingTotal: components.nonCachedInput + components.cacheRead + components.cacheWrite + components.output,
    uniqueRequests: groups.size,
    forkInheritedRows
  }
}

export interface ClaudeUuidOverlapPair { pathA: string; pathB: string; overlap: number }

/**
 * Cross-file uuid-prefix overlap (design §4.4): a new file whose beginning copies at least `threshold`
 * messages of an older file is physical evidence of a resume or fork, labelled [E] (estimated) in the
 * report because it cannot say which of the two it is. Evidence-level cost only (an inverted index +
 * pairwise counters), not the registry's decision-level single-parent disambiguation
 * (session-lineage.ts): a uuid normally lives in exactly one file, so the counted collisions stay small
 * even at real scale.
 */
export function findClaudeUuidOverlapPairs(units: readonly ClaudeUnit[], threshold = 8): ClaudeUuidOverlapPair[] {
  const owners = new Map<string, string[]>()
  for (const unit of units) {
    if (unit.unreadable) continue
    for (const uuid of unit.uuids) {
      const list = owners.get(uuid)
      if (list) { if (!list.includes(unit.path)) list.push(unit.path) } else owners.set(uuid, [unit.path])
    }
  }
  const pairCounts = new Map<string, number>()
  for (const paths of owners.values()) {
    if (paths.length < 2) continue
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const key = paths[i] < paths[j] ? `${paths[i]}\u0000${paths[j]}` : `${paths[j]}\u0000${paths[i]}`
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
      }
    }
  }
  const pairs: ClaudeUuidOverlapPair[] = []
  for (const [key, overlap] of pairCounts) {
    if (overlap < threshold) continue
    const [pathA, pathB] = key.split('\u0000')
    pairs.push({ pathA, pathB, overlap })
  }
  return pairs
}

/**
 * Auxiliary indicator (design §4.4, not part of the three-column edge tally): of every non-null
 * parentUuid pointer, what fraction resolves to a uuid found in the *same physical file*. A pointer that
 * does not resolve usually targets a file already cleaned up (not a Swob problem).
 */
export function claudeParentUuidCoverage(units: readonly ClaudeUnit[]): { covered: number; total: number } {
  let covered = 0
  let total = 0
  for (const unit of units) {
    if (unit.unreadable) continue
    covered += unit.parentUuidSameFileCovered
    total += unit.parentUuidTotal
  }
  return { covered, total }
}
