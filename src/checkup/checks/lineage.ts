/**
 * ④ Lineage and branching (design §4.4).
 *
 * Standard answer, by source:
 * - Codex: derivation edges = the state db's `thread_spawn_edges` (read-only, census/codex-state-db.ts);
 *   fork edges = top-level sessions whose own `session_meta.forked_from_id` names another top-level
 *   session (census/codex-census.ts codexTopLevelForkEdges). Both are first-party records.
 * - Claude Code (no first-party table; physical evidence only):
 *   - continuation: a file's own `sessionId` occurrences name another main file's basenameId (already
 *     collected by claude-census.ts; the same evidence ①'s classifyClaudeUnits reads for
 *     claude.continuation-shard).
 *   - subagent: a subagent unit's candidate owner main (same directory/sessionId evidence as ①'s
 *     classifyClaudeUnits — reused here, not recomputed with different rules).
 *   - resume/fork: cross-file uuid-prefix overlap >= 8 (census/claude-census.ts findClaudeUuidOverlapPairs).
 *
 * Every oracle edge is reconciled against Swob's own already-computed lineage state (ReadoutSession's
 * branchParentId / branchChildIds / continuationSessionIds / subagents[], all from the same
 * loadAllSessions() the readout already ran — no second, independently-reimplemented Swob algorithm).
 * Three columns per edge type: expressed / not-expressed / Swob-extra ([E]: Swob has the edge but the
 * oracle has no evidence for it, e.g. the parent file was cleaned up).
 *
 * Registry comparison (session-lineage.ts's buildSessionLineageRegistryFromClaudeFiles) is out of scope:
 * `.session-lineage.json` is empty under the checkup's isolated HOME (it is only ever populated by real
 * usage), so there is no second implementation to diff against there (design §八, still unverified).
 *
 * Verdict (task book, authoritative — narrower than the design doc's original table): Codex derivation
 * edges 100% expressed AND Codex fork edges consistent (100% expressed) -> pass; derivation not-expressed
 * rate <= 1% (and fork edges still consistent) -> warn; otherwise fail. A Codex fork-edge inconsistency
 * (any missing) always keeps the verdict out of "pass" and, per the design doc's original "any first-party
 * edge unexpressed" rule, drops it to fail rather than warn. Claude's edges are physical evidence, never
 * first-party: any gap there is only ever an observation (warn at most, never fail) — this is what "两套
 * 实现的分歧只计数并报观察" resolves to now that the registry side cannot run in this environment: the
 * observation is census evidence vs Swob's own runtime state, not two Swob implementations.
 */
import type { Finding, Verdict } from '../contract'
import { claudeParentUuidCoverage, findClaudeUuidOverlapPairs, type ClaudeUnit } from '../census/claude-census'
import { codexTopLevelForkEdges, codexUnitSessionId } from '../census/codex-census'
import type { ReadoutSession } from '../readout'
import {
  assembleCheck,
  derived,
  hasClaudeData,
  hasCodexData,
  makeFinding,
  percentMeasure,
  reconcileCodexSpawnEdges,
  remainingSources,
  reported,
  sampleIds,
  sourceVerdict,
  unavailable,
  type CheckContext,
  type SourceEntry
} from './common'

// —— Codex ——

function codexEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.codex!
  const eligible = census.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path))
  const censusIds = new Set(eligible.map((unit) => codexUnitSessionId(unit)).filter((id): id is string => !!id))
  const db = ctx.codexDb
  if (!db || !db.available) {
    return { verdict: 'undetermined', swob: { status: unavailable('checks', db?.reason ?? 'codex.state-db-missing') }, oracle: {}, oracleIds: ['codex.state-db'] }
  }
  if (ctx.readout.status !== 'ok') {
    return { verdict: 'undetermined', swob: { status: unavailable('checks', ctx.readout.reason ?? 'readout.not-isolated') }, oracle: {}, oracleIds: ['codex.state-db', 'census.codex-jsonl'] }
  }
  const sessions = ctx.readout.sessions.filter((session) => session.source === 'codex')

  // — derivation edges (thread-spawn) —
  const reconciliation = reconcileCodexSpawnEdges(db.edges, sessions, censusIds)
  const derivationTotal = db.edges.length
  const derivationExpressed = reconciliation.attachedToRecordedParent
  const derivationNotExpressed = derivationTotal - derivationExpressed
  const derivationSwobExtra = reconciliation.swobExtraChildIds.length

  // — fork edges (top-level forked_from_id) —
  const forkEdges = codexTopLevelForkEdges(eligible)
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session] as const))
  let forkExpressed = 0
  const forkNotExpressedPaths: string[] = []
  for (const edge of forkEdges) {
    const child = sessionById.get(edge.childId)
    if (child?.branchParentId === `codex:${edge.parentId}`) forkExpressed++
    else forkNotExpressedPaths.push(edge.childPath)
  }
  const forkTotal = forkEdges.length
  const forkNotExpressed = forkNotExpressedPaths.length
  const forkEdgeChildIds = new Set(forkEdges.map((edge) => edge.childId))
  const forkSwobExtraPaths = sessions
    .filter((session) => session.branchParentId?.startsWith('codex:') && !forkEdgeChildIds.has(session.sessionId))
    .map((session) => session.primaryPath ?? session.paths[0] ?? '')
    .filter((path) => path)
  const forkSwobExtra = forkSwobExtraPaths.length

  // Threshold first (task book, authoritative): 0 not-expressed derivation edges AND fork edges
  // consistent -> pass; derivation rate <= 1% (fork edges still consistent) -> warn; otherwise fail. A
  // finding's own verdict must match this tier, not be hardcoded, or a >0-but-within-tolerance derivation
  // gap would drag the whole source to 'fail' via sourceVerdict's worst-of.
  const derivationRate = derivationTotal > 0 ? derivationNotExpressed / derivationTotal : 0
  const forkConsistent = forkNotExpressed === 0
  const threshold: Verdict = derivationNotExpressed === 0 && forkConsistent
    ? 'pass'
    : derivationRate <= 0.01 && forkConsistent ? 'warn' : 'fail'
  // A fork inconsistency alone (derivation clean) still keeps the tier out of "warn": any first-party edge
  // unexpressed is a fail (design doc's original table), so the derivation finding's own severity, when
  // there also is a fork gap, must not read "warn" while the source verdict reads "fail".
  const derivationFindingVerdict: Verdict = threshold === 'fail' ? 'fail' : 'warn'

  const sourceFindings: Finding[] = []
  if (derivationNotExpressed > 0) {
    sourceFindings.push(makeFinding({
      code: 'codex.derivation-edge-unexpressed', verdict: derivationFindingVerdict, source: 'codex',
      count: derived(derivationNotExpressed, 'edges'), numbers: [derivationNotExpressed, derivationTotal]
    }))
  }
  if (derivationSwobExtra > 0) {
    sourceFindings.push(makeFinding({ code: 'codex.derivation-edge-swob-extra', verdict: 'warn', source: 'codex', count: derived(derivationSwobExtra, 'edges') }))
  }
  if (forkNotExpressed > 0) {
    sourceFindings.push(makeFinding({
      code: 'codex.fork-edge-unexpressed', verdict: 'fail', source: 'codex',
      count: derived(forkNotExpressed, 'edges'), numbers: [forkNotExpressed, forkTotal], samples: sampleIds(ctx.salt, forkNotExpressedPaths)
    }))
  }
  if (forkSwobExtra > 0) {
    sourceFindings.push(makeFinding({ code: 'codex.fork-edge-swob-extra', verdict: 'warn', source: 'codex', count: derived(forkSwobExtra, 'edges'), samples: sampleIds(ctx.salt, forkSwobExtraPaths) }))
  }
  findings.push(...sourceFindings)

  return {
    verdict: sourceVerdict(threshold, sourceFindings, 'codex'),
    swob: {
      derivationExpressed: derived(derivationExpressed, 'edges'),
      derivationNotExpressed: derived(derivationNotExpressed, 'edges'),
      derivationSwobExtra: derived(derivationSwobExtra, 'edges'),
      forkExpressed: derived(forkExpressed, 'edges'),
      forkNotExpressed: derived(forkNotExpressed, 'edges'),
      forkSwobExtra: derived(forkSwobExtra, 'edges')
    },
    oracle: {
      derivationTotal: reported(derivationTotal, 'edges'),
      forkTotal: reported(forkTotal, 'edges')
    },
    oracleIds: ['codex.state-db', 'census.codex-jsonl']
  }
}

// —— Claude ——

/** Same file-identity set a main's basenameId/sessionIds carry (mirrors inclusion.ts's mainIds). */
function mainIds(main: ClaudeUnit): Set<string> {
  return new Set([main.basenameId, ...main.sessionIds])
}

function claudeEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.claude!
  const eligible = census.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path))
  if (ctx.readout.status !== 'ok') {
    return { verdict: 'undetermined', swob: { status: unavailable('checks', ctx.readout.reason ?? 'readout.not-isolated') }, oracle: {}, oracleIds: ['census.claude-jsonl'] }
  }
  const sessions = ctx.readout.sessions.filter((session) => session.source === 'claude-code' && !session.virtual)
  const sessionsByPath = new Map<string, ReadoutSession[]>()
  for (const session of sessions) {
    for (const filePath of session.paths) {
      const list = sessionsByPath.get(filePath) ?? []
      list.push(session)
      sessionsByPath.set(filePath, list)
    }
  }
  const sessionById = new Map(sessions.filter((session) => session.id).map((session) => [session.id!, session] as const))

  /** Any of the four ways design §4.4 counts an edge between two files as expressed. */
  const pairExpressed = (pathA: string, pathB: string): boolean => {
    const sessionsA = sessionsByPath.get(pathA) ?? []
    const sessionsB = sessionsByPath.get(pathB) ?? []
    if (sessionsA.some((session) => sessionsB.includes(session))) return true // same logical session
    for (const sessionA of sessionsA) {
      for (const sessionB of sessionsB) {
        if (sessionA.id && sessionB.branchParentId === sessionA.id) return true
        if (sessionB.id && sessionA.branchParentId === sessionB.id) return true
        if (sessionA.id && (sessionB.branchChildIds ?? []).includes(sessionA.id)) return true
        if (sessionB.id && (sessionA.branchChildIds ?? []).includes(sessionB.id)) return true
        if ((sessionA.continuationSessionIds ?? []).includes(sessionB.sessionId)) return true
        if ((sessionB.continuationSessionIds ?? []).includes(sessionA.sessionId)) return true
      }
    }
    return false
  }

  // — continuation: a main file's sessionIds naming another main's basenameId —
  const mains = eligible.filter((unit) => unit.kind === 'claude-main')
  const continuationSeen = new Set<string>()
  const continuationPairs: Array<[string, string]> = []
  for (const a of mains) {
    for (const b of mains) {
      if (a === b || !b.sessionIds.includes(a.basenameId)) continue
      const key = a.path < b.path ? `${a.path}\u0000${b.path}` : `${b.path}\u0000${a.path}`
      if (continuationSeen.has(key)) continue
      continuationSeen.add(key)
      continuationPairs.push([a.path, b.path])
    }
  }
  let continuationExpressed = 0
  const continuationNotExpressedPaths: string[] = []
  for (const [a, b] of continuationPairs) {
    if (pairExpressed(a, b)) continuationExpressed++
    else continuationNotExpressedPaths.push(a)
  }

  // — subagent: same candidate-owner evidence as ①'s classifyClaudeUnits (not recomputed with new rules) —
  const mainsByProject = new Map<string, ClaudeUnit[]>()
  for (const unit of mains) {
    const list = mainsByProject.get(unit.projectDir) ?? []
    list.push(unit)
    mainsByProject.set(unit.projectDir, list)
  }
  // Same validity rule as ①'s classifyClaudeUnits (subagentsSegment 1|2, depth <= 2): a subagent file
  // outside that layout is a different, already-reported problem (claude.subagent-too-deep /
  // claude.unrecognized-jsonl-location), not a lineage gap.
  const subagentUnits = eligible.filter((unit) => unit.kind === 'claude-subagent' && unit.userRecords + unit.assistantRecords > 0 &&
    (unit.subagentsSegment === 1 || unit.subagentsSegment === 2) && (unit.subagentDepth ?? 99) <= 2)
  let subagentExpressed = 0
  const subagentOrphanPaths: string[] = []
  const subagentOwnerNotIncludedPaths: string[] = []
  for (const unit of subagentUnits) {
    const candidates = (mainsByProject.get(unit.projectDir) ?? []).filter((main) =>
      unit.ownerDirName !== null ? main.basenameId === unit.ownerDirName : unit.sessionIds.some((id) => mainIds(main).has(id)))
    if (candidates.length === 0) {
      subagentOrphanPaths.push(unit.path)
      continue
    }
    if (candidates.some((main) => (sessionsByPath.get(main.path) ?? []).length > 0)) subagentExpressed++
    else subagentOwnerNotIncludedPaths.push(unit.path)
  }
  const subagentTotal = subagentUnits.length
  const subagentNotExpressed = subagentOrphanPaths.length + subagentOwnerNotIncludedPaths.length

  // — resume/fork: cross-file uuid-prefix overlap [E] —
  const overlapPairs = findClaudeUuidOverlapPairs(eligible)
  let resumeForkExpressed = 0
  const resumeForkNotExpressedPaths: string[] = []
  for (const pair of overlapPairs) {
    if (pairExpressed(pair.pathA, pair.pathB)) resumeForkExpressed++
    else resumeForkNotExpressedPaths.push(pair.pathA)
  }
  const resumeForkTotal = overlapPairs.length

  // — Swob-extra: a branch link Swob has that no uuid-overlap pair corroborates. Scoped to the
  // resume/fork edge type specifically: continuation and subagent attachment both read the very same
  // underlying fact Swob itself reads (sessionId cross-reference, directory ownership), so an
  // independent "extra" gap cannot arise there the way it can for the uuid-overlap heuristic. —
  const evidencedPairKeys = new Set(overlapPairs.map((pair) => pair.pathA < pair.pathB ? `${pair.pathA}\u0000${pair.pathB}` : `${pair.pathB}\u0000${pair.pathA}`))
  const resumeForkSwobExtraPaths: string[] = []
  for (const session of sessions) {
    if (!session.branchParentId) continue
    const parent = sessionById.get(session.branchParentId)
    if (!parent || parent.source !== 'claude-code') continue
    const childPath = session.primaryPath ?? session.paths[0]
    const parentPath = parent.primaryPath ?? parent.paths[0]
    if (!childPath || !parentPath) continue
    const key = childPath < parentPath ? `${childPath}\u0000${parentPath}` : `${parentPath}\u0000${childPath}`
    if (!evidencedPairKeys.has(key)) resumeForkSwobExtraPaths.push(childPath)
  }
  const resumeForkSwobExtra = resumeForkSwobExtraPaths.length

  const sourceFindings: Finding[] = []
  if (continuationNotExpressedPaths.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'claude.continuation-edge-unexpressed', verdict: 'warn', source: 'claude-code',
      count: derived(continuationNotExpressedPaths.length, 'edges'), samples: sampleIds(ctx.salt, continuationNotExpressedPaths)
    }))
  }
  if (subagentOrphanPaths.length > 0) {
    sourceFindings.push(makeFinding({ code: 'claude.subagent-orphan', verdict: 'warn', source: 'claude-code', count: derived(subagentOrphanPaths.length, 'edges'), samples: sampleIds(ctx.salt, subagentOrphanPaths) }))
  }
  if (subagentOwnerNotIncludedPaths.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'claude.subagent-owner-not-included', verdict: 'warn', source: 'claude-code',
      count: derived(subagentOwnerNotIncludedPaths.length, 'edges'), samples: sampleIds(ctx.salt, subagentOwnerNotIncludedPaths)
    }))
  }
  if (resumeForkNotExpressedPaths.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'claude.resume-fork-edge-unexpressed', verdict: 'warn', source: 'claude-code',
      count: derived(resumeForkNotExpressedPaths.length, 'edges'), samples: sampleIds(ctx.salt, resumeForkNotExpressedPaths)
    }))
  }
  if (resumeForkSwobExtra > 0) {
    sourceFindings.push(makeFinding({ code: 'claude.branch-edge-swob-extra', verdict: 'warn', source: 'claude-code', count: derived(resumeForkSwobExtra, 'edges'), samples: sampleIds(ctx.salt, resumeForkSwobExtraPaths) }))
  }
  findings.push(...sourceFindings)

  const coverage = claudeParentUuidCoverage(eligible)

  return {
    // Physical evidence only, never first-party: a gap here is an observation, at most warn (never fail).
    verdict: sourceVerdict('pass', sourceFindings, 'claude-code'),
    swob: {
      continuationExpressed: derived(continuationExpressed, 'edges'),
      continuationNotExpressed: derived(continuationNotExpressedPaths.length, 'edges'),
      subagentExpressed: derived(subagentExpressed, 'edges'),
      subagentNotExpressed: derived(subagentNotExpressed, 'edges'),
      resumeForkExpressed: derived(resumeForkExpressed, 'edges'),
      resumeForkNotExpressed: derived(resumeForkNotExpressedPaths.length, 'edges'),
      resumeForkSwobExtra: derived(resumeForkSwobExtra, 'edges')
    },
    oracle: {
      continuationTotal: reported(continuationPairs.length, 'edges'),
      subagentTotal: reported(subagentTotal, 'edges'),
      resumeForkTotal: reported(resumeForkTotal, 'edges'),
      sameFileParentCoverage: percentMeasure(coverage.covered, coverage.total)
    },
    oracleIds: ['census.claude-jsonl']
  }
}

// —— check ——

export function lineageCheck(ctx: CheckContext): ReturnType<typeof assembleCheck> {
  const bySource: Record<string, SourceEntry> = {}
  const findings: Finding[] = []
  const evaluated = new Set<string>()
  let codexDerivationTotal = 0
  let codexDerivationNotExpressed = 0
  let codexForkNotExpressed = 0
  if (hasClaudeData(ctx) && ctx.claude) {
    evaluated.add('claude-code')
    bySource['claude-code'] = claudeEntry(ctx, findings)
  }
  if (hasCodexData(ctx) && ctx.codex) {
    evaluated.add('codex')
    const entry = codexEntry(ctx, findings)
    bySource.codex = entry
    codexDerivationTotal = entry.oracle.derivationTotal?.value ?? 0
    codexDerivationNotExpressed = entry.swob.derivationNotExpressed?.value ?? 0
    codexForkNotExpressed = entry.swob.forkNotExpressed?.value ?? 0
  }
  Object.assign(bySource, remainingSources('lineage', ctx, evaluated))
  const gaps = codexDerivationNotExpressed > 0 || codexForkNotExpressed > 0
  const result = assembleCheck({
    id: 'lineage',
    bySource,
    findings,
    headline: gaps ? 'lineage.gaps' : 'lineage.pass',
    headlineNumbers: gaps ? [codexDerivationTotal, codexDerivationNotExpressed] : [codexDerivationTotal]
  })
  if (ctx.readout.status !== 'ok') result.reason = ctx.readout.reason ?? 'readout.not-isolated'
  return result
}
