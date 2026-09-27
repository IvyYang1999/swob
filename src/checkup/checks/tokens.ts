/**
 * ⑤ Token (C2a, design §四 4.5): Claude/Codex's own independent census-level recount
 * (`census/claude-census.ts#claudeRecountUsage`, `census/codex-census.ts#codexRecountB`) compared against
 * the kernel's own per-session ledger (`readout.ts`'s `ReadoutSession.tokens`), two ways:
 *   - source-level: the four components (non-cached input / cache read / output / reasoning; Claude also
 *     tracks cache write) summed across every session Swob listed, vs. the oracle's global dedup total.
 *   - session-level: per comparison group, all four components equal (C2a-2, package decision E1: a
 *     Claude "group" is a branch family — see `claudeBranchGroups` below; a Codex "group" is always the
 *     one listed top-level session, unchanged from C2a — package decision E2: Codex is not grouped, its
 *     own family already folds derived/spawned children in via `codexFamilies`).
 * Cursor and every other source without usage data fall through to `remainingSources` (declared
 * `usage: unavailable` in the shared capability table), which reports them not-applicable, [U].
 *
 * C2a-2 deliverable 1 (task book 2026-09-28, verified against F1m's own independent verification report
 * P1-1): branch-family grouping. F1m made the kernel's own per-session ledger attribute a shared prefix to
 * only one of two branch-linked sessions (the "billing_rank" owner; the other keeps an `inherited` audit
 * copy, excluded from its own `billingTotal`). But `claudeRecountUsage` recounts straight from the physical
 * files — which still both carry the full shared history on disk — so comparing each session one at a time
 * against *its own* solo-family oracle reintroduces the very double count F1m just fixed at the ledger
 * level: the non-owner's Swob total (correctly missing the shared part) no longer matches its own file's
 * full recount (which still has it). The fix: sessions connected by `branchParentId`/`branchChildIds` are
 * merged into one "branch family" group before comparing — Swob's side sums the group's members (whichever
 * of them the ledger made the owner), the oracle side calls `claudeRecountUsage` once on the *union* of the
 * group's physical units (which dedupes the shared history by message.id/requestId exactly once, matching
 * the summed Swob side).
 */
import type { Finding, Verdict } from '../contract'
import { claudeRecountUsage, type ClaudeUnit } from '../census/claude-census'
import { codexRecountB, codexUnitParentId, codexUnitSessionId, type CodexUnit } from '../census/codex-census'
import { unavailableReadoutTokens, type ReadoutSession, type ReadoutSessionTokens } from '../readout'
import {
  assembleCheck,
  derived,
  hasClaudeData,
  hasCodexData,
  makeFinding,
  reported,
  remainingSources,
  sampleIds,
  unavailable,
  worstVerdict,
  type CheckContext,
  type SourceEntry
} from './common'

interface Components { nonCachedInput: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number }

function emptyComponents(): Components {
  return { nonCachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
}

function addInto(target: Components, source: Components): void {
  target.nonCachedInput += source.nonCachedInput
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
  target.output += source.output
  target.reasoning += source.reasoning
}

function billingTotalOf(components: Components): number {
  return components.nonCachedInput + components.cacheRead + components.cacheWrite + components.output
}

function componentsEqual(left: Components, right: Components): boolean {
  return left.nonCachedInput === right.nonCachedInput && left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite && left.output === right.output && left.reasoning === right.reasoning
}

const PASS_PCT = 0.1
const NOTE_PCT = 1
const SESSION_MATCH_PCT = 99

/**
 * |swob − oracle| / oracle, in percent, after backing out `calibrationDeltaTokens` (a known, already
 * registered gap — task book: Claude's cache-write aggregate-vs-breakdown difference). `null` when the
 * oracle denominator is 0 and an unexplained remainder is left (swob is not 0 either): there is no ratio to
 * express, and the caller treats that the same as an over-threshold deviation.
 */
function adjustedDeviationPct(swob: number, oracle: number, calibrationDeltaTokens = 0): number | null {
  const remaining = Math.max(0, Math.abs(swob - oracle) - Math.max(0, calibrationDeltaTokens))
  if (oracle === 0) return remaining === 0 ? 0 : null
  return (remaining / Math.abs(oracle)) * 100
}

/** Signed, unadjusted percent for display; null under the same "no ratio to express" condition. */
function signedDeviationPct(swob: number, oracle: number): number | null {
  if (oracle === 0) return swob === 0 ? 0 : null
  return ((swob - oracle) / oracle) * 100
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

// —— per-session family grouping (Swob's own merge granularity; census units carry no notion of it) ——

/**
 * Codex units grouped by the top-level session Swob folded them into: walk each unit's session's parent
 * chain (`codexUnitParentId`, the same physical-evidence fields `session-loader.ts` itself follows) until
 * it reaches a session Swob actually listed. Mirrors F1b's family-scoped recompute (verified equal to the
 * global one on real data); units that never reach a listed session (should not happen once ④ is clean)
 * are simply not attributed to any family and only count toward the global oracle total.
 */
function codexFamilies(units: readonly CodexUnit[], listedTopLevel: ReadonlySet<string>): Map<string, CodexUnit[]> {
  const bySession = new Map<string, CodexUnit[]>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    if (!id) continue
    const list = bySession.get(id) ?? []
    list.push(unit)
    bySession.set(id, list)
  }
  const parentOf = (id: string): string | null => {
    for (const unit of bySession.get(id) ?? []) {
      const parentId = codexUnitParentId(unit)
      if (parentId) return parentId
    }
    return null
  }
  const familyCache = new Map<string, string | null>()
  const familyOfId = (id: string): string | null => {
    const cached = familyCache.get(id)
    if (cached !== undefined) return cached
    if (listedTopLevel.has(id)) {
      familyCache.set(id, id)
      return id
    }
    const visited = new Set<string>([id])
    let current = parentOf(id)
    let hops = 0
    while (current && hops++ < 64) {
      if (visited.has(current)) break
      if (listedTopLevel.has(current)) {
        familyCache.set(id, current)
        return current
      }
      visited.add(current)
      current = parentOf(current)
    }
    familyCache.set(id, null)
    return null
  }
  const families = new Map<string, CodexUnit[]>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    const family = id ? familyOfId(id) : null
    if (!family) continue
    const list = families.get(family) ?? []
    list.push(unit)
    families.set(family, list)
  }
  return families
}

/**
 * Claude units grouped by session. `ReadoutSession.subagentPaths` cannot be used for this: the kernel's
 * light/readOnly `buildSessionSummary` (session-loader.ts, the `light` branch) merges a subagent file's
 * messages into `tokenAccounting` directly but never populates `summary.subagents[]` there (that field is
 * only filled in the full, non-light build) — so under checkup's readOnly load it is always empty, for
 * every session, regardless of whether subagent files exist. Grouping here instead follows the same
 * physical-path convention the kernel itself locates subagents by (`findClaudeSubagentFilesNearMain`,
 * `<project>/<owner-session-id>/subagents/**`; census's own `ownerDirName`), independent of that gap.
 */
function claudeFamilies(units: readonly ClaudeUnit[], sessions: readonly ReadoutSession[]): Map<string, ClaudeUnit[]> {
  const byPath = new Map<string, ClaudeUnit>()
  for (const unit of units) byPath.set(unit.path, unit)
  const subagentsByOwner = new Map<string, ClaudeUnit[]>()
  for (const unit of units) {
    if (unit.kind !== 'claude-subagent' || !unit.ownerDirName) continue
    const list = subagentsByOwner.get(unit.ownerDirName) ?? []
    list.push(unit)
    subagentsByOwner.set(unit.ownerDirName, list)
  }
  const families = new Map<string, ClaudeUnit[]>()
  for (const session of sessions) {
    if (session.source !== 'claude-code' || session.virtual) continue
    const list: ClaudeUnit[] = []
    for (const filePath of session.paths) {
      const unit = byPath.get(filePath)
      if (unit) list.push(unit)
    }
    // A multi-file (continuation-shard) session's subagents can live under any of its shards' own ids,
    // not only the session's primary id.
    const owners = new Set([session.sessionId, ...list.map((unit) => unit.basenameId)])
    for (const owner of owners) for (const subagent of subagentsByOwner.get(owner) ?? []) list.push(subagent)
    families.set(session.sessionId, list)
  }
  return families
}

/**
 * Claude "branch family" groups (C2a-2, package decisions E1/M2): the transitive closure of
 * `branchParentId`/`branchChildIds` over `sessions`, so two (or more) cross-session-branch-linked top-level
 * sessions are compared as one unit instead of each against its own solo-family oracle (see the module
 * header). Every session in `sessions` ends up in exactly one group — a session with no branch link of its
 * own is a group of one, identical to the pre-C2a-2 per-session comparison.
 *
 * The closure runs in the `.id` namespace, not `.sessionId`: `branchParentId`/`branchChildIds` are written
 * on `summary.id` (session-loader.ts), which only equals `sessionId` unless that same physical sessionId
 * was split into incompatible clusters — then the split summaries' `.id` takes the shape
 * `${sessionId}:branch-N` while `.sessionId` stays the shared, un-suffixed value. Closing over `.sessionId`
 * instead would silently fail to connect a split cluster to its cross-session parent/child (wrong node
 * key), and — worse — would silently merge two *different* split clusters of the same raw sessionId that
 * happen to share no branch link at all (same key, different sessions). A session without its own `.id`
 * (a fixture predating C2b, or a future source) falls back to its `sessionId` as a node key: still a valid
 * (isolated) group member, just not a link target — `branchParentId`/`branchChildIds` are always empty in
 * that case anyway.
 */
function claudeBranchGroups(sessions: readonly ReadoutSession[]): ReadoutSession[][] {
  const nodeKey = (session: ReadoutSession): string => session.id ?? session.sessionId
  const bySessionKey = new Map<string, ReadoutSession>()
  for (const session of sessions) bySessionKey.set(nodeKey(session), session)

  const parent = new Map<string, string>()
  for (const session of sessions) parent.set(nodeKey(session), nodeKey(session))
  const find = (key: string): string => {
    let root = key
    while (parent.get(root) !== root) root = parent.get(root)!
    let cursor = key
    while (cursor !== root) {
      const next = parent.get(cursor)!
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }
  for (const session of sessions) {
    const key = nodeKey(session)
    const linked = [...(session.branchParentId ? [session.branchParentId] : []), ...(session.branchChildIds ?? [])]
    for (const other of linked) {
      if (!bySessionKey.has(other)) continue // no listed session at the other end (e.g. its file was cleaned up)
      union(key, other)
    }
  }

  const groups = new Map<string, ReadoutSession[]>()
  for (const session of sessions) {
    const root = find(nodeKey(session))
    const list = groups.get(root) ?? []
    list.push(session)
    groups.set(root, list)
  }
  return [...groups.values()]
}

/** Sorted, joined sessionIds: a stable, order-independent label for a comparison group (a size-1 group's label is just that session's own id — identical to pre-C2a-2 sample text). */
function groupLabel(group: readonly ReadoutSession[]): string {
  return group.map((session) => session.sessionId).sort().join('+')
}

/** Union (by physical path) of every unit belonging to any member of `group`, via each member's own solo-family unit set. */
function unitsForGroup(group: readonly ReadoutSession[], familiesBySessionId: ReadonlyMap<string, ClaudeUnit[]>): ClaudeUnit[] {
  const byPath = new Map<string, ClaudeUnit>()
  for (const session of group) for (const unit of familiesBySessionId.get(session.sessionId) ?? []) byPath.set(unit.path, unit)
  return [...byPath.values()]
}

interface SessionTally {
  swobGlobal: Components
  /** Post-grouping comparison count (E1: "组算 1") — a multi-member group counts once, same as a singleton. */
  sessionsCompared: number
  sessionsEqual: number
  mismatchSamples: string[]
  unavailableAsZero: number
  unavailableAsZeroSamples: string[]
  calibrationDeltaTokens: number
  /** Pre-grouping session count ("N" in the report's "N 场按分支家族并为 M 组比对"). */
  ungroupedSessionsCompared: number
  /** Largest comparison group's member count this run (S2 sentinel; 1 when nothing ever groups, e.g. Codex — package decision E2). */
  maxGroupSize: number
}

function emptyTally(): SessionTally {
  return {
    swobGlobal: emptyComponents(), sessionsCompared: 0, sessionsEqual: 0, mismatchSamples: [],
    unavailableAsZero: 0, unavailableAsZeroSamples: [], calibrationDeltaTokens: 0,
    ungroupedSessionsCompared: 0, maxGroupSize: 0
  }
}

/**
 * Walks every comparison group once (Codex: always a single listed session — package decision E2; Claude:
 * a branch family, `claudeBranchGroups`). A member with no usable Swob ledger is checked on its own against
 * its own solo-family oracle via `singleSessionOracle` — that question (`tokens.swob-unavailable-as-zero`:
 * did Swob's ledger for *this one session* go missing) is unrelated to branch grouping and unaffected by
 * it, identical to pre-C2a-2 behaviour. The group's remaining ("available") members, if any, are summed
 * and compared once against `groupOracle` (E1: "组算 1") — for a group of one this reduces exactly to the
 * pre-C2a-2 per-session comparison.
 */
function tallySessions(input: {
  groups: readonly ReadoutSession[][]
  singleSessionOracle: (sessionId: string) => Components
  groupOracle: (group: readonly ReadoutSession[]) => Components
}): SessionTally {
  const result = emptyTally()
  for (const group of input.groups) {
    result.ungroupedSessionsCompared += group.length
    if (group.length > result.maxGroupSize) result.maxGroupSize = group.length

    const available: ReadoutSession[] = []
    for (const session of group) {
      const tokens: ReadoutSessionTokens = session.tokens ?? unavailableReadoutTokens()
      result.calibrationDeltaTokens += tokens.cacheWriteCalibrationDeltaTokens
      if (tokens.provenance === 'unavailable' || !tokens.components) {
        result.sessionsCompared++
        const oracle = input.singleSessionOracle(session.sessionId)
        const oracleHasUsage = oracle.nonCachedInput + oracle.cacheRead + oracle.cacheWrite + oracle.output + oracle.reasoning > 0
        if (oracleHasUsage) {
          result.unavailableAsZero++
          result.unavailableAsZeroSamples.push(session.sessionId)
        } else {
          result.sessionsEqual++
        }
        continue
      }
      available.push(session)
    }
    if (available.length === 0) continue // whole group unavailable: nothing left to sum/compare (matches a lone unavailable session's old behaviour)

    const groupComponents = emptyComponents()
    for (const session of available) addInto(groupComponents, session.tokens!.components!)
    addInto(result.swobGlobal, groupComponents)
    const oracle = input.groupOracle(group)
    result.sessionsCompared++
    if (componentsEqual(groupComponents, oracle)) result.sessionsEqual++
    else result.mismatchSamples.push(groupLabel(group))
  }
  return result
}

interface MetricNumbers { swob: Components; swobBillingTotal: number; oracle: Components; oracleBillingTotal: number }

/** Worst (largest-magnitude) calibration-adjusted deviation among the four components + billing total. */
function worstAdjustedPct(numbers: MetricNumbers, calibrationDeltaTokens: number): number | null {
  const candidates = [
    adjustedDeviationPct(numbers.swob.nonCachedInput, numbers.oracle.nonCachedInput),
    adjustedDeviationPct(numbers.swob.cacheRead, numbers.oracle.cacheRead),
    adjustedDeviationPct(numbers.swob.cacheWrite, numbers.oracle.cacheWrite, calibrationDeltaTokens),
    adjustedDeviationPct(numbers.swob.output, numbers.oracle.output),
    adjustedDeviationPct(numbers.swob.reasoning, numbers.oracle.reasoning),
    adjustedDeviationPct(numbers.swobBillingTotal, numbers.oracleBillingTotal, calibrationDeltaTokens)
  ]
  if (candidates.some((value) => value === null)) return null
  return Math.max(...(candidates as number[]).map(Math.abs))
}

function sourceVerdictFor(input: { worst: number | null; sessionMatchPct: number; hasUnavailableAsZero: boolean }): Verdict {
  if (input.hasUnavailableAsZero) return 'fail'
  if (input.worst === null || input.worst > NOTE_PCT) return 'fail'
  // 标签一致性由仓库内契约测试负责（T-1）——设计 §4.5「注意」档的第三个析取项（标签不一致）不在此实现：
  // C2a-2 第二轮决定 M3，见任务书；那是 CLI/文档文本审计，不是这里能从 ReadoutSession/oracle 数值算出的东西。
  if (input.worst > PASS_PCT || input.sessionMatchPct < SESSION_MATCH_PCT) return 'warn'
  return 'pass'
}

function componentMeasures(components: Components, billingTotal: number): Record<string, ReturnType<typeof derived>> {
  return {
    nonCachedInput: derived(components.nonCachedInput, 'tokens'),
    cacheRead: derived(components.cacheRead, 'tokens'),
    cacheWrite: derived(components.cacheWrite, 'tokens'),
    output: derived(components.output, 'tokens'),
    reasoning: derived(components.reasoning, 'tokens'),
    billingTotal: derived(billingTotal, 'tokens')
  }
}

function buildSourceEntry(input: {
  ctx: CheckContext
  source: 'claude-code' | 'codex'
  oracleGlobal: Components
  oracleUniqueFacts: number
  oracleId: 'census.claude-jsonl' | 'census.codex-jsonl'
  tally: SessionTally
  findings: Finding[]
}): SourceEntry {
  const { ctx, source, oracleGlobal, tally, findings } = input
  const swobBillingTotal = billingTotalOf(tally.swobGlobal)
  const oracleBillingTotal = billingTotalOf(oracleGlobal)
  const numbers: MetricNumbers = { swob: tally.swobGlobal, swobBillingTotal, oracle: oracleGlobal, oracleBillingTotal }
  const worst = worstAdjustedPct(numbers, tally.calibrationDeltaTokens)
  const sessionMatchPct = tally.sessionsCompared > 0 ? (tally.sessionsEqual / tally.sessionsCompared) * 100 : 100
  const verdict = sourceVerdictFor({ worst, sessionMatchPct, hasUnavailableAsZero: tally.unavailableAsZero > 0 })

  if (tally.unavailableAsZero > 0) {
    findings.push(makeFinding({
      code: 'tokens.swob-unavailable-as-zero', verdict: 'fail', source, count: reported(tally.unavailableAsZero, 'sessions'),
      samples: sampleIds(ctx.salt, tally.unavailableAsZeroSamples)
    }))
  }
  const rawBillingDeviation = signedDeviationPct(swobBillingTotal, oracleBillingTotal)
  // Reported unconditionally whenever present, whether or not it turns out to fully explain the remaining
  // deviation below (`worst` already has this backed out of the cache-write / billing-total metrics, so a
  // gap can be partially explained: some of it calibration, some of it a genuine remaining deviation).
  if (tally.calibrationDeltaTokens > 0) {
    findings.push(makeFinding({
      code: 'tokens.cache-write-calibration-difference', verdict: 'warn', source,
      count: derived(Math.round(tally.calibrationDeltaTokens), 'tokens')
    }))
  }
  if (worst !== null && worst > PASS_PCT) {
    findings.push(makeFinding({
      code: worst > NOTE_PCT ? 'tokens.deviation-high' : 'tokens.deviation-note',
      verdict: worst > NOTE_PCT ? 'fail' : 'warn', source,
      count: derived(round3(worst), 'percent'), numbers: [round3(worst)]
    }))
  } else if (worst === null) {
    // Oracle found none of some component while Swob reports some: no ratio to a zero denominator, but
    // unambiguously over threshold. Shown as a sentinel 100% rather than [U] — this is a real, large gap,
    // not a case where the source itself provides no usage data.
    findings.push(makeFinding({ code: 'tokens.deviation-high', verdict: 'fail', source, count: derived(100, 'percent'), numbers: [100] }))
  }
  if (tally.mismatchSamples.length > 0) {
    findings.push(makeFinding({
      code: 'tokens.session-mismatch', verdict: 'warn', source, count: derived(tally.mismatchSamples.length, 'sessions'),
      samples: sampleIds(ctx.salt, tally.mismatchSamples)
    }))
  }

  return {
    verdict,
    swob: {
      ...componentMeasures(tally.swobGlobal, swobBillingTotal),
      billingTotalDeviationPct: rawBillingDeviation === null ? derived(100, 'percent') : derived(round3(rawBillingDeviation), 'percent'),
      sessionsCompared: derived(tally.sessionsCompared, 'sessions'),
      sessionsEqual: derived(tally.sessionsEqual, 'sessions'),
      // C2a-2 deliverable 1 (package decision E1): only meaningful where grouping happens at all (Claude —
      // package decision E2 keeps Codex ungrouped, so its own N always equals M and its max is always 1;
      // shown only for Claude to avoid implying Codex was considered for grouping and wasn't).
      ...(source === 'claude-code' ? {
        sessionsRawCompared: derived(tally.ungroupedSessionsCompared, 'sessions'),
        maxBranchGroupSize: derived(tally.maxGroupSize, 'sessions')
      } : {})
    },
    oracle: {
      ...componentMeasures(oracleGlobal, oracleBillingTotal),
      uniqueFacts: reported(input.oracleUniqueFacts, input.source === 'codex' ? 'snapshots' : 'records')
    },
    oracleIds: [input.oracleId]
  }
}

/** Codex's oracle never tracks cache write (task book: its four components are non-cached input / cache read / output / reasoning). */
function withZeroCacheWrite(components: { nonCachedInput: number; cacheRead: number; output: number; reasoning: number }): Components {
  return { ...components, cacheWrite: 0 }
}

function codexEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.codex!
  const eligible = census.units.filter((unit) => unit.isRollout && !unit.unreadable && !ctx.changed.has(unit.path))
  const oracle = codexRecountB(eligible)
  const oracleComponents = withZeroCacheWrite(oracle.components)
  if (ctx.readout.status !== 'ok') {
    return {
      verdict: 'undetermined',
      swob: { billingTotal: unavailable('tokens', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: { ...componentMeasures(oracleComponents, oracle.billingTotal), uniqueFacts: reported(oracle.uniqueSnapshots, 'snapshots') },
      oracleIds: ['census.codex-jsonl']
    }
  }
  const sessions = ctx.readout.sessions.filter((session) => session.source === 'codex' && !session.virtual)
  const listedTopLevel = new Set(sessions.map((session) => session.sessionId))
  const families = codexFamilies(eligible, listedTopLevel)
  // Package decision E2: Codex is not grouped by branch — each listed session stays its own comparison unit
  // (its own family, via `codexFamilies`, already folds in derived/spawned children — unchanged from C2a).
  const groups: ReadoutSession[][] = sessions.map((session) => [session])
  const tally = tallySessions({
    groups,
    singleSessionOracle: (sessionId) => withZeroCacheWrite(codexRecountB(families.get(sessionId) ?? []).components),
    // A Codex group is always exactly the one listed session (E2): the same recount as singleSessionOracle.
    groupOracle: (group) => withZeroCacheWrite(codexRecountB(families.get(group[0].sessionId) ?? []).components)
  })
  return buildSourceEntry({
    ctx, source: 'codex', oracleGlobal: oracleComponents, oracleUniqueFacts: oracle.uniqueSnapshots,
    oracleId: 'census.codex-jsonl', tally, findings
  })
}

function claudeEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.claude!
  const eligible = census.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path) &&
    (unit.kind === 'claude-main' || unit.kind === 'claude-subagent'))
  const oracle = claudeRecountUsage(eligible)
  const oracleComponents: Components = { ...oracle.components, reasoning: 0 }
  if (ctx.readout.status !== 'ok') {
    return {
      verdict: 'undetermined',
      swob: { billingTotal: unavailable('tokens', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: { ...componentMeasures(oracleComponents, oracle.billingTotal), uniqueFacts: reported(oracle.uniqueRequests, 'records') },
      oracleIds: ['census.claude-jsonl']
    }
  }
  const sessions = ctx.readout.sessions.filter((session) => session.source === 'claude-code' && !session.virtual)
  const families = claudeFamilies(eligible, sessions)
  const branchGroups = claudeBranchGroups(sessions) // deliverable 1 (package decisions E1/M2)
  const tally = tallySessions({
    groups: branchGroups,
    singleSessionOracle: (sessionId) => {
      const recount = claudeRecountUsage(families.get(sessionId) ?? [])
      return { ...recount.components, reasoning: 0 }
    },
    groupOracle: (group) => {
      const recount = claudeRecountUsage(unitsForGroup(group, families))
      return { ...recount.components, reasoning: 0 }
    }
  })
  return buildSourceEntry({
    ctx, source: 'claude-code', oracleGlobal: oracleComponents, oracleUniqueFacts: oracle.uniqueRequests,
    oracleId: 'census.claude-jsonl', tally, findings
  })
}

export function tokensCheck(ctx: CheckContext): ReturnType<typeof assembleCheck> {
  const bySource: Record<string, SourceEntry> = {}
  const findings: Finding[] = []
  const evaluated = new Set<string>()
  if (hasClaudeData(ctx) && ctx.claude) {
    evaluated.add('claude-code')
    bySource['claude-code'] = claudeEntry(ctx, findings)
  }
  if (hasCodexData(ctx) && ctx.codex) {
    evaluated.add('codex')
    bySource.codex = codexEntry(ctx, findings)
  }
  Object.assign(bySource, remainingSources('tokens', ctx, evaluated))
  const evaluatedVerdicts = [...evaluated].map((source) => bySource[source].verdict)
  const overall = worstVerdict(evaluatedVerdicts)
  const problemFindings = findings.filter((finding) => finding.verdict === 'warn' || finding.verdict === 'fail')
  const headline = overall === 'fail' ? 'tokens.mismatch' : overall === 'warn' ? 'tokens.note' : 'tokens.pass'
  const headlineNumbers = overall === 'pass' ? [evaluated.size] : [evaluated.size, problemFindings.length]
  return assembleCheck({ id: 'tokens', bySource, findings, headline, headlineNumbers })
}
