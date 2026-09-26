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
    timeRange: { min: timeRange.min, max: timeRange.max }
  }
}
