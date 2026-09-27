/**
 * ① Session inclusion: every physical unit falls into exactly one bucket
 * (session / merged / excluded / unsupported / not-included), so buckets add
 * up. The Swob side is derived [D] from the readout's coverage
 * (filePath / allFilePaths / subagents[].filePath, plus usage audit sources
 * for Codex children) — the kernel exposes no dispositions in C1a.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Finding, InclusionBucket, ReasonCode, Verdict } from '../contract'
import type { ClaudeUnit } from '../census/claude-census'
import { codexUnitParentId, codexUnitSessionId, type CodexUnit } from '../census/codex-census'
import {
  applicability,
  assembleCheck,
  hasClaudeData,
  hasCodexData,
  derived,
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

export interface UnitDisposition { bucket: InclusionBucket | null; reason?: ReasonCode }

const NOT_INCLUDED_EXPLAINED = new Set<ReasonCode>([
  'claude.subagent-orphan',
  'claude.subagent-owner-not-included',
  'claude.subagent-too-deep',
  'codex.nested-subagent-orphan',
  'codex.subagent-parent-missing',
  'codex.subagent-no-parent-id',
  'codex.child-usage-not-attributed'
])

function changedDisposition(ctx: CheckContext, unit: { path: string; unreadable: boolean }): UnitDisposition | null {
  if (unit.unreadable) return { bucket: null, reason: 'census.unreadable' }
  if (ctx.changed.has(unit.path)) return { bucket: null, reason: 'census.file-changed-during-run' }
  return null
}

// —— Claude ——

export function classifyClaudeUnits(ctx: CheckContext): Map<string, UnitDisposition> {
  const result = new Map<string, UnitDisposition>()
  const units = ctx.claude?.units ?? []
  const sessions = ctx.readout.sessions.filter((session) => session.source === 'claude-code')
  const primary = new Set(sessions.map((session) => session.primaryPath).filter((entry): entry is string => !!entry))
  const covered = new Set(sessions.flatMap((session) => session.paths))
  const mainsByProject = new Map<string, ClaudeUnit[]>()
  for (const unit of units) {
    if (unit.kind !== 'claude-main') continue
    const list = mainsByProject.get(unit.projectDir) ?? []
    list.push(unit)
    mainsByProject.set(unit.projectDir, list)
  }
  const mainIds = (main: ClaudeUnit): Set<string> => new Set([main.basenameId, ...main.sessionIds])

  for (const unit of units) {
    const changed = changedDisposition(ctx, unit)
    if (changed) {
      result.set(unit.path, changed)
      continue
    }
    if (unit.kind === 'claude-main') {
      if (primary.has(unit.path)) result.set(unit.path, { bucket: 'session' })
      else if (covered.has(unit.path)) result.set(unit.path, { bucket: 'merged', reason: 'claude.continuation-shard' })
      else if (unit.conversationRecords === 0) result.set(unit.path, { bucket: 'excluded', reason: 'claude.no-conversation-records' })
      else result.set(unit.path, { bucket: 'not-included', reason: 'inclusion.unexplained' })
      continue
    }
    if (unit.kind === 'claude-other') {
      result.set(unit.path, unit.conversationRecords === 0
        ? { bucket: 'excluded', reason: 'claude.no-conversation-records' }
        : { bucket: 'unsupported', reason: 'claude.unrecognized-jsonl-location' })
      continue
    }
    // subagent
    if (unit.userRecords + unit.assistantRecords === 0) {
      result.set(unit.path, { bucket: 'excluded', reason: 'claude.subagent-no-conversation' })
      continue
    }
    if (!(unit.subagentsSegment === 1 || unit.subagentsSegment === 2) || (unit.subagentDepth ?? 99) > 2) {
      result.set(unit.path, { bucket: 'not-included', reason: 'claude.subagent-too-deep' })
      continue
    }
    const candidates = (mainsByProject.get(unit.projectDir) ?? []).filter((main) =>
      unit.ownerDirName !== null
        ? main.basenameId === unit.ownerDirName
        : unit.sessionIds.some((id) => mainIds(main).has(id)))
    if (candidates.length === 0) {
      result.set(unit.path, { bucket: 'not-included', reason: 'claude.subagent-orphan' })
    } else if (candidates.some((main) => covered.has(main.path))) {
      result.set(unit.path, { bucket: 'merged', reason: 'claude.subagent-attached' })
    } else if (candidates.some((main) => ctx.changed.has(main.path) || main.unreadable)) {
      result.set(unit.path, { bucket: null, reason: 'census.file-changed-during-run' })
    } else {
      result.set(unit.path, { bucket: 'not-included', reason: 'claude.subagent-owner-not-included' })
    }
  }
  return result
}

// —— Codex ——

export function classifyCodexUnits(ctx: CheckContext): Map<string, UnitDisposition> {
  const result = new Map<string, UnitDisposition>()
  const units = ctx.codex?.units ?? []
  const sessions = ctx.readout.sessions.filter((session) => session.source === 'codex')
  const primary = new Set(sessions.map((session) => session.primaryPath).filter((entry): entry is string => !!entry))
  const covered = new Set(sessions.flatMap((session) => session.paths))
  const attachedPaths = new Set(sessions.flatMap((session) => session.subagentPaths))
  const swobSessionIds = new Set(sessions.filter((session) => !session.virtual).map((session) => session.sessionId))
  const unitsBySession = new Map<string, CodexUnit[]>()
  for (const unit of units) {
    const id = codexUnitSessionId(unit)
    if (!id) continue
    const list = unitsBySession.get(id) ?? []
    list.push(unit)
    unitsBySession.set(id, list)
  }
  const dbSource = new Map((ctx.codexDb?.threads ?? []).map((thread) => [thread.id, thread.threadSource]))

  /**
   * A zero-usage guardian's own parent is often itself a subagent, not a
   * top-level Swob session: session-loader.ts's codexSubagentsByTopLevel (F1b)
   * walks that whole chain when it attaches descendants, but only a
   * thread-spawn child ever lands in a parent's subagents (attachedPaths),
   * and a guardian that never produced usage of its own can never enter
   * attributedChildIds either — so a one-hop parent check alone misses a
   * guardian nested two or more levels down even though the kernel already
   * attached it. Self-contained walk mirroring that logic (does not touch
   * session-loader.ts), bounded and cycle-safe like the kernel's own cap.
   */
  const hasTopLevelCodexAncestor = (parentId: string | null): boolean => {
    const visited = new Set<string>()
    let current = parentId
    for (let hops = 0; current && hops < 16 && !visited.has(current); hops++) {
      if (swobSessionIds.has(current)) return true
      visited.add(current)
      const parents = unitsBySession.get(current) ?? []
      current = parents.map((parent) => codexUnitParentId(parent)).find((id): id is string => !!id) ?? null
    }
    return false
  }

  const childReason = (unit: CodexUnit): ReasonCode => {
    const parentId = codexUnitParentId(unit)
    if (!parentId) return 'codex.subagent-no-parent-id'
    if (!swobSessionIds.has(parentId)) {
      const parents = unitsBySession.get(parentId) ?? []
      const parentIsChild = parents.some((parent) => parent.meta && parent.meta.role !== 'top-level') ||
        (parents.length === 0 && dbSource.get(parentId) === 'subagent')
      return parentIsChild ? 'codex.nested-subagent-orphan' : 'codex.subagent-parent-missing'
    }
    if (unit.kind === 'codex-thread-spawn') return 'inclusion.unexplained'
    return 'codex.child-usage-not-attributed'
  }

  for (const unit of units) {
    const changed = changedDisposition(ctx, unit)
    if (changed) {
      result.set(unit.path, changed)
      continue
    }
    if (!unit.isRollout) {
      result.set(unit.path, { bucket: 'unsupported', reason: 'codex.non-rollout-file' })
      continue
    }
    const sessionId = codexUnitSessionId(unit)
    if (!sessionId) {
      result.set(unit.path, { bucket: 'unsupported', reason: 'codex.no-session-id' })
      continue
    }
    const role = unit.meta?.role ?? 'top-level'
    if (role === 'top-level') {
      if (primary.has(unit.path)) result.set(unit.path, { bucket: 'session' })
      else if (covered.has(unit.path)) result.set(unit.path, { bucket: 'merged', reason: 'codex.duplicate-session-copy' })
      else if (unit.assistantSide === 0) result.set(unit.path, { bucket: 'excluded', reason: 'codex.empty-session' })
      else result.set(unit.path, { bucket: 'not-included', reason: 'inclusion.unexplained' })
      continue
    }
    if (role === 'thread-spawn') {
      result.set(unit.path, attachedPaths.has(unit.path)
        ? { bucket: 'merged', reason: 'codex.child-attached' }
        : { bucket: 'not-included', reason: childReason(unit) })
      continue
    }
    // guardian / other subagent: usage-only merge into the structured parent
    const parentId = codexUnitParentId(unit)
    const hasUsage = unit.usageSnapshots + unit.usageRecords > 0
    if (ctx.readout.attributedChildIds.has(sessionId) ||
        (!hasUsage && hasTopLevelCodexAncestor(parentId))) {
      result.set(unit.path, { bucket: 'merged', reason: 'codex.child-attached' })
    } else {
      result.set(unit.path, { bucket: 'not-included', reason: childReason(unit) })
    }
  }
  return result
}

// —— check ——

interface BucketTotals {
  units: number
  evaluated: number
  session: number
  merged: number
  excluded: number
  unsupported: number
  notIncluded: number
  unexplained: number
  changed: number
}

function totals(dispositions: Map<string, UnitDisposition>): BucketTotals {
  const result: BucketTotals = { units: 0, evaluated: 0, session: 0, merged: 0, excluded: 0, unsupported: 0, notIncluded: 0, unexplained: 0, changed: 0 }
  for (const disposition of dispositions.values()) {
    result.units++
    if (disposition.bucket === null) { result.changed++; continue }
    result.evaluated++
    if (disposition.bucket === 'session') result.session++
    else if (disposition.bucket === 'merged') result.merged++
    else if (disposition.bucket === 'excluded') result.excluded++
    else if (disposition.bucket === 'unsupported') result.unsupported++
    else {
      result.notIncluded++
      if (!disposition.reason || !NOT_INCLUDED_EXPLAINED.has(disposition.reason)) result.unexplained++
    }
  }
  return result
}

function groupedFindings(
  ctx: CheckContext,
  source: string,
  dispositions: Map<string, UnitDisposition>,
  buckets: InclusionBucket[],
  verdictFor: (reason: ReasonCode) => Finding['verdict']
): Finding[] {
  const byReason = new Map<ReasonCode, string[]>()
  for (const [filePath, disposition] of dispositions) {
    if (!disposition.bucket || !buckets.includes(disposition.bucket) || !disposition.reason) continue
    const list = byReason.get(disposition.reason) ?? []
    list.push(filePath)
    byReason.set(disposition.reason, list)
  }
  return [...byReason.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([reason, paths]) => makeFinding({
    code: reason,
    verdict: verdictFor(reason),
    source,
    count: derived(paths.length, 'units'),
    samples: sampleIds(ctx.salt, paths)
  }))
}

function changedFinding(ctx: CheckContext, source: string, dispositions: Map<string, UnitDisposition>): Finding[] {
  const changed = [...dispositions.entries()].filter(([, disposition]) => disposition.bucket === null)
  const findings: Finding[] = []
  for (const code of ['census.file-changed-during-run', 'census.unreadable'] as const) {
    const paths = changed.filter(([, disposition]) => disposition.reason === code).map(([filePath]) => filePath)
    if (paths.length === 0) continue
    findings.push(makeFinding({ code, verdict: 'undetermined', source, count: reported(paths.length, 'files'), samples: sampleIds(ctx.salt, paths) }))
  }
  return findings
}

function thresholdVerdict(bucketTotals: BucketTotals): Verdict {
  const denominator = bucketTotals.evaluated - bucketTotals.excluded - bucketTotals.unsupported
  if (bucketTotals.evaluated === 0) return 'undetermined'
  if (bucketTotals.unexplained > 0) return 'fail'
  if (denominator > 0 && bucketTotals.notIncluded / denominator > 0.01) return 'fail'
  if (bucketTotals.notIncluded > 0 || bucketTotals.unsupported > 0) return 'warn'
  return 'pass'
}

function bucketMeasures(bucketTotals: BucketTotals): Record<string, ReturnType<typeof derived>> {
  const denominator = bucketTotals.evaluated - bucketTotals.excluded - bucketTotals.unsupported
  return {
    becameSession: derived(bucketTotals.session, 'units'),
    merged: derived(bucketTotals.merged, 'units'),
    excluded: derived(bucketTotals.excluded, 'units'),
    unsupported: derived(bucketTotals.unsupported, 'units'),
    notIncluded: derived(bucketTotals.notIncluded, 'units'),
    notIncludedUnexplained: derived(bucketTotals.unexplained, 'units'),
    inclusionRate: percentMeasure(bucketTotals.session + bucketTotals.merged, denominator)
  }
}

function realpathOrNull(target: string): string | null {
  try { return fs.realpathSync.native(target) } catch { return null }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Three-way reconciliation: census rollouts vs Codex thread table vs Swob. */
function codexReconciliation(ctx: CheckContext): { oracle: SourceEntry['oracle']; findings: Finding[] } {
  const db = ctx.codexDb
  const findings: Finding[] = []
  if (!db || !db.available) {
    const reason = db?.reason ?? 'codex.state-db-missing'
    if (reason === 'codex.state-db-unreadable') {
      findings.push(makeFinding({ code: 'codex.state-db-unreadable', verdict: 'undetermined', source: 'codex', count: unavailable('threads', reason) }))
    }
    return { oracle: { threadsInDb: unavailable('threads', reason) }, findings }
  }
  const units = ctx.codex?.units ?? []
  const censusPaths = new Set(units.map((unit) => unit.path))
  const censusIds = new Set(units.map((unit) => codexUnitSessionId(unit)).filter((id): id is string => !!id))
  const roots = (ctx.codex?.roots ?? []).map((root) => root.realPath)
  const missing: string[] = []
  const outside: string[] = []
  const notInCensus: string[] = []
  const threadPaths = new Set<string>()
  let withRollout = 0
  for (const thread of db.threads) {
    if (!thread.rolloutPath) continue
    withRollout++
    const real = realpathOrNull(thread.rolloutPath)
    if (!real) {
      missing.push(thread.rolloutPath)
      continue
    }
    threadPaths.add(real)
    if (censusPaths.has(real)) continue
    if (roots.some((root) => isInside(real, root))) notInCensus.push(real)
    else outside.push(real)
  }
  const threadIds = new Set(db.threads.map((thread) => thread.id))
  const rolloutsNotInDb = units.filter((unit) => unit.isRollout && !threadPaths.has(unit.path) &&
    !threadIds.has(codexUnitSessionId(unit) ?? ''))
  // ① only ever reads attachedAnywhere/childInCensus from this shared reconciliation (unchanged from before
  // the C2b extraction); the stronger parentSessionId match and the Swob-extra side are ④'s (checks/lineage.ts).
  const reconciliation = reconcileCodexSpawnEdges(db.edges, ctx.readout.sessions, censusIds)
  const edgesAttached = reconciliation.attachedAnywhere
  const edgesChildInCensus = reconciliation.childInCensus
  if (missing.length > 0) findings.push(makeFinding({ code: 'codex.thread-rollout-missing', verdict: 'warn', source: 'codex', count: derived(missing.length, 'threads') }))
  if (outside.length > 0) findings.push(makeFinding({ code: 'codex.thread-rollout-outside-roots', verdict: 'fail', source: 'codex', count: derived(outside.length, 'threads'), samples: sampleIds(ctx.salt, outside) }))
  if (notInCensus.length > 0) findings.push(makeFinding({ code: 'codex.thread-not-in-census', verdict: 'fail', source: 'codex', count: derived(notInCensus.length, 'threads'), samples: sampleIds(ctx.salt, notInCensus) }))
  if (rolloutsNotInDb.length > 0) {
    findings.push(makeFinding({
      code: 'codex.rollout-not-in-thread-db',
      verdict: 'warn',
      source: 'codex',
      count: derived(rolloutsNotInDb.length, 'files'),
      samples: sampleIds(ctx.salt, rolloutsNotInDb.map((unit) => unit.path))
    }))
  }
  return {
    oracle: {
      threadsInDb: reported(db.threads.length, 'threads'),
      threadsWithRollout: reported(withRollout, 'threads'),
      threadRolloutMissing: derived(missing.length, 'threads'),
      threadRolloutOutsideRoots: derived(outside.length, 'threads'),
      threadRolloutNotInCensus: derived(notInCensus.length, 'threads'),
      censusRolloutsNotInDb: derived(rolloutsNotInDb.length, 'files'),
      spawnEdges: reported(db.edges.length, 'edges'),
      spawnEdgesChildInCensus: derived(edgesChildInCensus, 'edges'),
      spawnEdgesAttachedBySwob: derived(edgesAttached, 'edges')
    },
    findings
  }
}

export function inclusionCheck(ctx: CheckContext): { result: ReturnType<typeof assembleCheck>; dispositions: Map<string, UnitDisposition> } {
  const bySource: Record<string, SourceEntry> = {}
  const findings: Finding[] = []
  const dispositions = new Map<string, UnitDisposition>()
  const evaluated = new Set<string>()
  const readoutOk = ctx.readout.status === 'ok'
  let headlineUnits = 0
  let headlineNotIncluded = 0
  let headlineUnsupported = 0

  const explainedVerdict = (reason: ReasonCode): Finding['verdict'] =>
    NOT_INCLUDED_EXPLAINED.has(reason) ? 'warn' : 'fail'

  if (hasClaudeData(ctx) && ctx.claude) {
    evaluated.add('claude-code')
    const units = ctx.claude.units
    const oracle: SourceEntry['oracle'] = {
      units: reported(units.length, 'units'),
      mainFiles: reported(units.filter((unit) => unit.kind === 'claude-main').length, 'files'),
      subagentFiles: reported(units.filter((unit) => unit.kind === 'claude-subagent').length, 'files'),
      otherJsonlFiles: reported(units.filter((unit) => unit.kind === 'claude-other').length, 'files'),
      nonSessionFiles: reported(ctx.claude.otherFiles, 'files'),
      lowerSymlinks: reported(ctx.claude.lowerSymlinks, 'units')
    }
    if (!readoutOk) {
      bySource['claude-code'] = { verdict: 'undetermined', swob: { sessions: unavailable('sessions', ctx.readout.reason ?? 'readout.not-isolated') }, oracle, oracleIds: ['census.claude-jsonl'] }
    } else {
      const claude = classifyClaudeUnits(ctx)
      for (const [filePath, disposition] of claude) dispositions.set(filePath, disposition)
      const bucketTotals = totals(claude)
      const sourceFindings = [
        ...groupedFindings(ctx, 'claude-code', claude, ['not-included'], explainedVerdict),
        ...groupedFindings(ctx, 'claude-code', claude, ['unsupported'], () => 'warn'),
        ...changedFinding(ctx, 'claude-code', claude)
      ]
      if (ctx.claude.lowerSymlinks > 0) {
        sourceFindings.push(makeFinding({ code: 'census.lower-symlink', verdict: 'warn', source: 'claude-code', count: reported(ctx.claude.lowerSymlinks, 'units') }))
      }
      findings.push(...sourceFindings)
      const sessions = ctx.readout.sessions.filter((session) => session.source === 'claude-code')
      bySource['claude-code'] = {
        verdict: sourceVerdict(thresholdVerdict(bucketTotals), sourceFindings, 'claude-code'),
        swob: {
          sessions: reported(sessions.filter((session) => !session.virtual).length, 'sessions'),
          branchViews: reported(sessions.filter((session) => session.virtual).length, 'sessions'),
          discoveredMainFiles: reported(ctx.readout.discovered.claudeMain.size, 'files'),
          ...bucketMeasures(bucketTotals),
          changedDuringRun: derived(bucketTotals.changed, 'units')
        },
        oracle,
        oracleIds: ['census.claude-jsonl']
      }
      headlineUnits += bucketTotals.evaluated
      headlineNotIncluded += bucketTotals.notIncluded
      headlineUnsupported += bucketTotals.unsupported
    }
  }

  if (hasCodexData(ctx) && ctx.codex) {
    evaluated.add('codex')
    const units = ctx.codex.units
    const roleCount = (kind: CodexUnit['kind']): number => units.filter((unit) => unit.kind === kind).length
    const baseOracle: SourceEntry['oracle'] = {
      units: reported(units.length, 'units'),
      topLevelFiles: reported(roleCount('codex-top-level'), 'files'),
      threadSpawnFiles: reported(roleCount('codex-thread-spawn'), 'files'),
      guardianFiles: reported(roleCount('codex-guardian'), 'files'),
      otherSubagentFiles: reported(roleCount('codex-subagent'), 'files'),
      unknownRoleFiles: reported(roleCount('codex-unknown'), 'files'),
      nonRolloutFiles: reported(roleCount('codex-non-rollout'), 'files'),
      lowerSymlinks: reported(ctx.codex.lowerSymlinks, 'units')
    }
    if (!readoutOk) {
      bySource.codex = { verdict: 'undetermined', swob: { sessions: unavailable('sessions', ctx.readout.reason ?? 'readout.not-isolated') }, oracle: baseOracle, oracleIds: ['census.codex-jsonl', 'codex.state-db'] }
    } else {
      const codex = classifyCodexUnits(ctx)
      for (const [filePath, disposition] of codex) dispositions.set(filePath, disposition)
      const bucketTotals = totals(codex)
      const reconciliation = codexReconciliation(ctx)
      const sourceFindings = [
        ...groupedFindings(ctx, 'codex', codex, ['not-included'], explainedVerdict),
        ...groupedFindings(ctx, 'codex', codex, ['unsupported'], () => 'warn'),
        ...changedFinding(ctx, 'codex', codex),
        ...reconciliation.findings
      ]
      if (ctx.codex.lowerSymlinks > 0) {
        sourceFindings.push(makeFinding({ code: 'census.lower-symlink', verdict: 'warn', source: 'codex', count: reported(ctx.codex.lowerSymlinks, 'units') }))
      }
      findings.push(...sourceFindings)
      const sessions = ctx.readout.sessions.filter((session) => session.source === 'codex')
      bySource.codex = {
        verdict: sourceVerdict(thresholdVerdict(bucketTotals), sourceFindings, 'codex'),
        swob: {
          sessions: reported(sessions.length, 'sessions'),
          attachedSubagents: reported(sessions.reduce((sum, session) => sum + session.subagentPaths.length, 0), 'units'),
          discoveredFiles: reported(ctx.readout.discovered.codex.size, 'files'),
          ...bucketMeasures(bucketTotals),
          changedDuringRun: derived(bucketTotals.changed, 'units')
        },
        oracle: { ...baseOracle, ...reconciliation.oracle },
        oracleIds: ['census.codex-jsonl', 'codex.state-db']
      }
      headlineUnits += bucketTotals.evaluated
      headlineNotIncluded += bucketTotals.notIncluded
      headlineUnsupported += bucketTotals.unsupported
    }
  }

  const rest = remainingSources('inclusion', ctx, evaluated)
  const kimiLegacy = ctx.unscanned?.kimiLegacy
  if (ctx.selected.has('kimi') && kimiLegacy && kimiLegacy.units > 0) {
    const finding = makeFinding({ code: 'unsupported.kimi-legacy-sessions', verdict: 'warn', source: 'kimi', count: reported(kimiLegacy.units, 'sessions') })
    findings.push(finding)
    const base = applicability('kimi', 'inclusion', ctx)
    rest.kimi = {
      verdict: sourceVerdict(base.verdict, [finding], 'kimi'),
      swob: { status: unavailable('checks', base.reason) },
      oracle: { legacyUnits: reported(kimiLegacy.units, 'units') },
      oracleIds: ['census.unscanned-roots']
    }
    headlineUnsupported += kimiLegacy.units
  }
  if (ctx.selected.has('zcode') && ctx.unscanned?.zcodeV2.present) {
    findings.push(makeFinding({ code: 'unscanned.zcode-v2-tasks', verdict: 'undetermined', source: 'zcode', count: unavailable('units', 'census.not-implemented') }))
  }
  Object.assign(bySource, rest)
  const result = assembleCheck({
    id: 'inclusion',
    bySource,
    findings,
    headline: headlineNotIncluded + headlineUnsupported === 0 ? 'inclusion.pass' : 'inclusion.gaps',
    headlineNumbers: headlineNotIncluded + headlineUnsupported === 0 ? [headlineUnits] : [headlineUnits, headlineNotIncluded, headlineUnsupported]
  })
  if (!readoutOk) result.reason = ctx.readout.reason ?? 'readout.not-isolated'
  return { result, dispositions }
}

