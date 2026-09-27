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
}

export interface ClaudeCensus {
  roots: Array<{ fixedRoot: ClaudeUnit['fixedRoot']; realPath: string }>
  units: ClaudeUnit[]
  otherFiles: number
  otherBytes: number
  lowerSymlinks: number
  unreadableDirs: number
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
        else if (type === 'assistant') assistantRecords++
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
    forkedFromRefs
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
