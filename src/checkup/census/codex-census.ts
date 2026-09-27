/**
 * Codex oracle census: every JSONL unit under each Codex home's `sessions`
 * and `archived_sessions`, read with the spec reader. Roles come from the
 * rollout's own `session_meta` (first-party metadata), not from Swob code.
 */
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { readJsonlFile, emptyJsonlStats, sanitizeTypeName, type JsonlFileStats } from './jsonl-census'
import { fingerprint, realDirectory, walkFiles, TimeRange, type FileFingerprint } from './files'
import { emptyLossKinds, type LossKind } from './claude-census'

export type CodexRole = 'top-level' | 'thread-spawn' | 'guardian' | 'subagent'
export type CodexUnitKind =
  | 'codex-top-level' | 'codex-thread-spawn' | 'codex-guardian' | 'codex-subagent'
  | 'codex-unknown' | 'codex-non-rollout'

export interface CodexHome {
  realPath: string
  origin: 'default' | 'environment' | 'additional'
}

export interface CodexMeta {
  id: string | null
  role: CodexRole
  parentThreadId: string | null
  forkedFromId: string | null
  depth: number | null
  historyStartOrdinal: number | null
}

export interface CodexUnit {
  /** Real path (internal only). */
  path: string
  home: CodexHome
  container: 'sessions' | 'archived_sessions'
  fixedRoot: string
  isRollout: boolean
  kind: CodexUnitKind
  before: FileFingerprint | null
  after: FileFingerprint | null
  unreadable: boolean
  stats: JsonlFileStats
  sessionMetaCount: number
  meta: CodexMeta | null
  /** Session id embedded in a rollout file name (internal). */
  fileNameId: string | null
  userMessages: number
  /** Assistant-side records: assistant messages, reasoning, tool calls, agent_message events. */
  assistantSide: number
  compaction: {
    /** Legacy top-level `type: compacted` rows. */
    legacy: number
    /** New `response_item.type = compaction` rows. */
    items: number
    /** `event_msg item_completed(item.type = ContextCompaction)` (cross-check). */
    contextCompactionEvents: number
    /** `event_msg type = context_compacted` (cross-check). */
    contextCompactedEvents: number
    /** Unique primary-marker signatures (type + payload hash; timestamps excluded). */
    markerSigs: string[]
    legacySigs: string[]
    /**
     * Unique `response_item.compaction` signatures (= markerSigs minus legacySigs). With compactEvents
     * it lets the per-session comparison apply the kernel's rule — C1c, aligned with the kernel per
     * F1b (codex-loader.ts codexToRawMessages): per file the kernel counts `compacted` rows, else
     * `compaction` items (each once per payload), else every `*compact*` event row. markerSigs and
     * legacySigs keep their C1a meaning; no census count changes.
     */
    itemSigs: string[]
    /** `event_msg` rows whose payload type contains "compact" (every row counts, no payload dedup). */
    compactEvents: number
  }
  hazardKinds: Record<LossKind, number>
  lineSeparatorKinds: Record<LossKind, number>
  /** Hazard records by (sanitised) record type, e.g. `response_item:function_call_output`. */
  hazardTypes: Record<string, number>
  /** Cumulative token snapshots: signature of total (+ last total) and timestamp. */
  tokenSnapshots: Array<{ sig: string; ts: string | null }>
  usageSnapshots: number
  usageRecords: number
  timeRange: { min: string | null; max: string | null }
}

export interface ForkUsageCopies {
  /** Child snapshots whose cumulative totals equal a parent snapshot but whose timestamp differs. */
  rewritten: number
  /** Child snapshots identical to a parent snapshot including the timestamp. */
  sameTimestamp: number
  /** Child units that carry at least one inherited snapshot. */
  childUnits: number
}

export interface CodexCensus {
  homes: CodexHome[]
  roots: Array<{ fixedRoot: string; realPath: string; home: CodexHome; container: CodexUnit['container'] }>
  units: CodexUnit[]
  otherFiles: number
  otherBytes: number
  lowerSymlinks: number
  unreadableDirs: number
  codexHomeEnvSet: boolean
  additionalHomes: number
}

const ROLLOUT_ID = /^rollout-.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i
const ASSISTANT_RESPONSE_TYPES = new Set([
  'reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call',
  'tool_search_call', 'image_generation_call'
])
const TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'tool_search_output'])

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
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

/** Role from Codex's own session_meta (source.subagent / thread_source). */
export function codexRoleFromMeta(payload: Record<string, unknown>): CodexMeta {
  const source = payload.source
  const subagent = asRecord(asRecord(source)?.subagent)
  const spawn = asRecord(subagent?.thread_spawn)
  const parentThreadId = asString(spawn?.parent_thread_id) ?? asString(payload.parent_thread_id)
  let role: CodexRole = 'top-level'
  if (subagent?.other === 'guardian') role = 'guardian'
  else if (spawn) role = 'thread-spawn'
  else if (subagent || payload.thread_source === 'subagent') role = 'subagent'
  return {
    id: asString(payload.id),
    role,
    parentThreadId: role === 'top-level' ? null : parentThreadId,
    forkedFromId: asString(payload.forked_from_id),
    depth: asNumber(spawn?.depth),
    historyStartOrdinal: asNumber(payload.subagent_history_start_ordinal)
  }
}

function codexLossKind(type: unknown, payload: Record<string, unknown> | null): LossKind {
  const payloadType = payload?.type
  if (type === 'response_item') {
    if (payloadType === 'message') return payload?.role === 'user' ? 'user' : payload?.role === 'assistant' ? 'assistant' : 'meta'
    if (typeof payloadType === 'string' && TOOL_OUTPUT_TYPES.has(payloadType)) return 'tool_result'
    if (typeof payloadType === 'string' && ASSISTANT_RESPONSE_TYPES.has(payloadType)) return 'assistant'
    return 'meta'
  }
  // event_msg rows are UI events (user_message/agent_message duplicate response items): "events" = meta.
  return 'meta'
}

function readAdditionalHomes(homeDir: string): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(homeDir, '.claude-session-manager', 'codex-homes.json'), 'utf8'))
    if (parsed?.version !== 1 || !Array.isArray(parsed.homes)) return []
    return parsed.homes.filter((entry: unknown): entry is string => typeof entry === 'string' && path.isAbsolute(entry.trim()))
      .map((entry: string) => entry.trim())
  } catch {
    return []
  }
}

/** Codex homes: `<home>/.codex`, `$CODEX_HOME`, then codex-homes.json (read-only), deduplicated by real path. */
export function codexHomes(homeDir: string, env: NodeJS.ProcessEnv = process.env): { homes: CodexHome[]; codexHomeEnvSet: boolean; additionalHomes: number } {
  const candidates: Array<{ dir: string; origin: CodexHome['origin'] }> = [{ dir: path.join(homeDir, '.codex'), origin: 'default' }]
  const envHome = env.CODEX_HOME?.trim()
  const codexHomeEnvSet = !!envHome && path.isAbsolute(envHome)
  if (codexHomeEnvSet) candidates.push({ dir: path.resolve(envHome!), origin: 'environment' })
  const additional = readAdditionalHomes(homeDir)
  candidates.push(...additional.map((dir) => ({ dir: path.resolve(dir), origin: 'additional' as const })))
  const homes = new Map<string, CodexHome>()
  for (const candidate of candidates) {
    const real = realDirectory(candidate.dir)
    if (real && !homes.has(real)) homes.set(real, { realPath: real, origin: candidate.origin })
  }
  return { homes: [...homes.values()], codexHomeEnvSet, additionalHomes: additional.length }
}

function fixedRootFor(home: CodexHome, container: CodexUnit['container']): string {
  const prefix = home.origin === 'default' ? '~/.codex' : home.origin === 'environment' ? '$CODEX_HOME' : '<additional-codex-home>'
  return `${prefix}/${container}`
}

export async function censusCodex(
  homeDir: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}
): Promise<CodexCensus> {
  const { homes, codexHomeEnvSet, additionalHomes } = codexHomes(homeDir, options.env)
  const census: CodexCensus = {
    homes, roots: [], units: [], otherFiles: 0, otherBytes: 0, lowerSymlinks: 0, unreadableDirs: 0,
    codexHomeEnvSet, additionalHomes
  }
  const seen = new Set<string>()
  for (const home of homes) {
    for (const container of ['sessions', 'archived_sessions'] as const) {
      const real = realDirectory(path.join(home.realPath, container))
      if (!real || seen.has(real)) continue
      seen.add(real)
      const root = { fixedRoot: fixedRootFor(home, container), realPath: real, home, container }
      census.roots.push(root)
      const walked = walkFiles(real, { maxDepth: 6, accept: (name) => name.endsWith('.jsonl') })
      census.otherFiles += walked.otherFiles
      census.otherBytes += walked.otherBytes
      census.lowerSymlinks += walked.lowerSymlinks
      census.unreadableDirs += walked.unreadableDirs
      for (const file of walked.files) census.units.push(await censusCodexFile(file.path, root, options))
    }
  }
  return census
}

export async function censusCodexFile(
  filePath: string,
  root: { fixedRoot: string; home: CodexHome; container: CodexUnit['container'] },
  options: { signal?: AbortSignal } = {}
): Promise<CodexUnit> {
  const baseName = path.basename(filePath)
  const isRollout = baseName.startsWith('rollout-') && baseName.endsWith('.jsonl')
  let meta: CodexMeta | null = null
  let sessionMetaCount = 0
  let userMessages = 0
  let assistantSide = 0
  let usageSnapshots = 0
  let usageRecords = 0
  const compaction = { legacy: 0, items: 0, contextCompactionEvents: 0, contextCompactedEvents: 0, compactEvents: 0 }
  const markerSigs = new Set<string>()
  const legacySigs = new Set<string>()
  const itemSigs = new Set<string>()
  const hazardKinds = emptyLossKinds()
  const lineSeparatorKinds = emptyLossKinds()
  const hazardTypes: Record<string, number> = {}
  const tokenSnapshots: CodexUnit['tokenSnapshots'] = []
  const timeRange = new TimeRange()

  const before = fingerprint(filePath)
  let stats: JsonlFileStats = emptyJsonlStats()
  let unreadable = before === null
  if (!unreadable) {
    try {
      stats = await readJsonlFile(filePath, (record, lineMeta) => {
        const entry = asRecord(record)
        if (!entry) return
        timeRange.add(entry.timestamp)
        const type = entry.type
        const payload = asRecord(entry.payload)
        const payloadType = payload?.type
        if (type === 'session_meta') {
          sessionMetaCount++
          if (sessionMetaCount === 1 && payload) meta = codexRoleFromMeta(payload)
        } else if (type === 'response_item') {
          if (payloadType === 'message') {
            if (payload?.role === 'user') userMessages++
            else if (payload?.role === 'assistant') assistantSide++
          } else if (typeof payloadType === 'string' && ASSISTANT_RESPONSE_TYPES.has(payloadType)) {
            assistantSide++
          } else if (payloadType === 'compaction') {
            compaction.items++
            const sig = stableDigest(`compaction\0${JSON.stringify(payload)}`)
            markerSigs.add(sig)
            itemSigs.add(sig)
          }
        } else if (type === 'event_msg') {
          // Aligned with the kernel's event rule (F1b): the type name contains "compact".
          if (typeof payloadType === 'string' && payloadType.includes('compact')) compaction.compactEvents++
          if (payloadType === 'agent_message') assistantSide++
          else if (payloadType === 'token_count') {
            const info = asRecord(payload?.info)
            if (info) usageSnapshots++
            const total = asRecord(info?.total_token_usage)
            if (total) {
              const last = asRecord(info?.last_token_usage)
              tokenSnapshots.push({
                sig: [total.input_tokens, total.cached_input_tokens, total.output_tokens,
                  total.reasoning_output_tokens, total.total_tokens, last?.total_tokens].map((value) => asNumber(value) ?? '').join('|'),
                ts: typeof entry.timestamp === 'string' ? entry.timestamp : null
              })
            }
          } else if (payloadType === 'context_compacted') {
            compaction.contextCompactedEvents++
          } else if (payloadType === 'item_completed' && asRecord(payload?.item)?.type === 'ContextCompaction') {
            compaction.contextCompactionEvents++
          }
        } else if (type === 'compacted') {
          compaction.legacy++
          const sig = stableDigest(`compacted\0${JSON.stringify(entry.payload ?? null)}`)
          markerSigs.add(sig)
          legacySigs.add(sig)
        } else if (type === 'token_usage_record') {
          usageRecords++
        }
        if (lineMeta.lineSeparator || lineMeta.bareCr) {
          const kind = codexLossKind(type, payload)
          hazardKinds[kind]++
          if (lineMeta.lineSeparator) lineSeparatorKinds[kind]++
          const typeName = type === 'response_item' || type === 'event_msg'
            ? `${sanitizeTypeName(type)}:${sanitizeTypeName(payloadType)}`
            : sanitizeTypeName(type)
          hazardTypes[typeName] = (hazardTypes[typeName] || 0) + 1
        }
      }, options)
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error
      unreadable = true
    }
  }
  const after = fingerprint(filePath)
  const resolvedMeta = meta as CodexMeta | null
  const kind: CodexUnitKind = !isRollout
    ? 'codex-non-rollout'
    : !resolvedMeta
      ? 'codex-unknown'
      : `codex-${resolvedMeta.role}` as CodexUnitKind
  return {
    path: filePath,
    home: root.home,
    container: root.container,
    fixedRoot: root.fixedRoot,
    isRollout,
    kind,
    before,
    after,
    unreadable,
    stats,
    sessionMetaCount,
    meta: resolvedMeta,
    fileNameId: ROLLOUT_ID.exec(baseName)?.[1]?.toLowerCase() ?? null,
    userMessages,
    assistantSide,
    compaction: { ...compaction, markerSigs: [...markerSigs], legacySigs: [...legacySigs], itemSigs: [...itemSigs] },
    hazardKinds,
    lineSeparatorKinds,
    hazardTypes,
    tokenSnapshots,
    usageSnapshots,
    usageRecords,
    timeRange: { min: timeRange.min, max: timeRange.max }
  }
}

/** The session id Codex (and Swob) would use: session_meta.id, else the rollout file name id. */
export function codexUnitSessionId(unit: CodexUnit): string | null {
  return unit.meta?.id ?? unit.fileNameId
}

/** Parent session id for non-top-level units: forked_from_id, else parent_thread_id. */
export function codexUnitParentId(unit: CodexUnit): string | null {
  if (!unit.meta || unit.meta.role === 'top-level') return null
  return unit.meta.parentThreadId ?? unit.meta.forkedFromId
}

/**
 * Census-level count of usage snapshots a forked child copied from its parent
 * (same cumulative totals; timestamps rewritten or kept). Relationship comes
 * from the child's session_meta (forked_from_id, else parent_thread_id).
 */
export function countForkUsageCopies(units: readonly CodexUnit[]): ForkUsageCopies {
  const bySession = new Map<string, CodexUnit[]>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    if (!id) continue
    const list = bySession.get(id) ?? []
    list.push(unit)
    bySession.set(id, list)
  }
  const parentIndex = new Map<string, Map<string, Set<string | null>>>()
  const indexFor = (parentId: string): Map<string, Set<string | null>> | null => {
    const cached = parentIndex.get(parentId)
    if (cached) return cached
    const parents = bySession.get(parentId)
    if (!parents) return null
    const index = new Map<string, Set<string | null>>()
    for (const parent of parents) {
      for (const snapshot of parent.tokenSnapshots) {
        const set = index.get(snapshot.sig) ?? new Set<string | null>()
        set.add(snapshot.ts)
        index.set(snapshot.sig, set)
      }
    }
    parentIndex.set(parentId, index)
    return index
  }
  const result: ForkUsageCopies = { rewritten: 0, sameTimestamp: 0, childUnits: 0 }
  for (const unit of units) {
    const parentId = unit.meta?.forkedFromId ?? codexUnitParentId(unit)
    if (!parentId || parentId === codexUnitSessionId(unit)) continue
    const index = indexFor(parentId)
    if (!index) continue
    const seen = new Set<string>()
    let inherited = 0
    for (const snapshot of unit.tokenSnapshots) {
      if (seen.has(snapshot.sig)) continue
      seen.add(snapshot.sig)
      const parentTimestamps = index.get(snapshot.sig)
      if (!parentTimestamps) continue
      inherited++
      if (parentTimestamps.has(snapshot.ts)) result.sameTimestamp++
      else result.rewritten++
    }
    if (inherited > 0) result.childUnits++
  }
  return result
}

export interface CodexForkEdge { parentId: string; childId: string; childPath: string }

/**
 * Top-level Codex sessions that are a fork/replay of another top-level session
 * (session_meta.forked_from_id on the child; design §4.4's "顶层分叉"). Distinct from the thread-spawn
 * derivation edges in the state db: a subagent's own forked_from_id (used as a parentThreadId fallback,
 * codexUnitParentId) is not counted here to avoid double-reporting the same physical relationship under
 * both edge types.
 */
export function codexTopLevelForkEdges(units: readonly CodexUnit[]): CodexForkEdge[] {
  const edges: CodexForkEdge[] = []
  for (const unit of units) {
    if (unit.unreadable || !unit.isRollout || !unit.meta || unit.meta.role !== 'top-level') continue
    const childId = codexUnitSessionId(unit)
    const parentId = unit.meta.forkedFromId
    if (!childId || !parentId || parentId === childId) continue
    edges.push({ parentId, childId, childPath: unit.path })
  }
  return edges
}

/** Primary compaction markers in child units that are copies of a parent's markers. */
export function countInheritedCodexMarkers(units: readonly CodexUnit[]): { inherited: number; childUnits: number } {
  const markersBySession = new Map<string, Set<string>>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    if (!id) continue
    const set = markersBySession.get(id) ?? new Set<string>()
    for (const sig of unit.compaction.markerSigs) set.add(sig)
    markersBySession.set(id, set)
  }
  let inherited = 0
  let childUnits = 0
  for (const unit of units) {
    const parentId = unit.meta?.forkedFromId ?? codexUnitParentId(unit)
    if (!parentId || parentId === codexUnitSessionId(unit)) continue
    const parentMarkers = markersBySession.get(parentId)
    if (!parentMarkers) continue
    const copied = unit.compaction.markerSigs.filter((sig) => parentMarkers.has(sig)).length
    inherited += copied
    if (copied > 0) childUnits++
  }
  return { inherited, childUnits }
}
