/**
 * ③ Compaction recognition. Oracle: the tools' own markers.
 * - Claude: `system/compact_boundary`, deduplicated by uuid across the
 *   session's physical files (isCompactSummary rows as cross-check).
 * - Codex: primary markers = legacy `compacted` rows + `response_item.compaction`
 *   rows, deduplicated by payload signature across the session's files;
 *   `context_compacted` / `ContextCompaction` events are cross-checks.
 * Per session: Swob's compactCount must equal the oracle. Markers copied from a
 * parent (resume/fork) count per session but are removed from the global
 * count and reported with `compaction.fork-inherited-marker`.
 */
import type { Finding, Verdict } from '../contract'
import { countInheritedCodexMarkers } from '../census/codex-census'
import type { ClaudeUnit } from '../census/claude-census'
import type { CodexUnit } from '../census/codex-census'
import type { ReadoutSession } from '../readout'
import {
  assembleCheck,
  hasClaudeData,
  hasCodexData,
  derived,
  makeFinding,
  remainingSources,
  reported,
  sampleIds,
  sourceVerdict,
  unavailable,
  type CheckContext,
  type SourceEntry
} from './common'

interface SessionComparison {
  session: ReadoutSession
  oracle: number
  swob: number
  legacy: number
}

/** Threshold (design §4.3): pass = all equal; warn = ≤ 1 % differ and every difference is explained. */
export function compactionThresholdVerdict(input: { compared: number; mismatched: number; unexplained: number }): Verdict {
  if (input.compared === 0) return 'pass'
  if (input.mismatched === 0) return 'pass'
  if (input.unexplained === 0 && input.mismatched / input.compared <= 0.01) return 'warn'
  return 'fail'
}

function unitsForSession<T extends { path: string; unreadable: boolean }>(
  ctx: CheckContext,
  session: ReadoutSession,
  byPath: Map<string, T>
): T[] | null {
  const units: T[] = []
  for (const filePath of session.paths) {
    const unit = byPath.get(filePath)
    if (!unit || unit.unreadable || ctx.changed.has(filePath)) return null
    units.push(unit)
  }
  return units.length > 0 ? units : null
}

function claudeEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.claude!
  const mains = census.units.filter((unit) => unit.kind === 'claude-main')
  const byPath = new Map<string, ClaudeUnit>(mains.map((unit) => [unit.path, unit]))
  const eligibleMains = mains.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path))
  const oracle: SourceEntry['oracle'] = {
    markerRows: reported(eligibleMains.reduce((sum, unit) => sum + unit.compactBoundaryRows, 0), 'markers'),
    compactSummaryRows: reported(eligibleMains.reduce((sum, unit) => sum + unit.compactSummaryRows, 0), 'markers'),
    subagentMarkerRows: reported(census.units.filter((unit) => unit.kind === 'claude-subagent' && !ctx.changed.has(unit.path))
      .reduce((sum, unit) => sum + unit.compactBoundaryRows, 0), 'markers')
  }
  if (ctx.readout.status !== 'ok') {
    return { verdict: 'undetermined', swob: { compactCount: unavailable('markers', ctx.readout.reason ?? 'readout.not-isolated') }, oracle, oracleIds: ['census.claude-jsonl'] }
  }
  const comparisons: SessionComparison[] = []
  let excluded = 0
  const globalUuids = new Set<string>()
  let globalWithoutUuid = 0
  for (const session of ctx.readout.sessions) {
    if (session.source !== 'claude-code' || session.virtual) continue
    const units = unitsForSession(ctx, session, byPath)
    if (!units) {
      excluded++
      continue
    }
    const uuids = new Set<string>()
    let withoutUuid = 0
    for (const unit of units) {
      for (const uuid of unit.compactBoundaryUuids) uuids.add(uuid)
      withoutUuid += unit.compactBoundaryRowsWithoutUuid
    }
    for (const uuid of uuids) globalUuids.add(uuid)
    globalWithoutUuid += withoutUuid
    comparisons.push({ session, oracle: uuids.size + withoutUuid, swob: session.compactCount, legacy: 0 })
  }
  const mismatched = comparisons.filter((comparison) => comparison.oracle !== comparison.swob)
  const sourceFindings: Finding[] = []
  if (mismatched.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'compaction.count-mismatch', verdict: 'fail', source: 'claude-code', count: derived(mismatched.length, 'sessions'),
      samples: sampleIds(ctx.salt, mismatched.map((comparison) => comparison.session.primaryPath ?? comparison.session.paths[0] ?? ''))
    }))
  }
  if (excluded > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'claude-code', count: derived(excluded, 'sessions') }))
  }
  findings.push(...sourceFindings)
  const perSessionSum = comparisons.reduce((sum, comparison) => sum + comparison.oracle, 0)
  const globalUnique = globalUuids.size + globalWithoutUuid
  const threshold = compactionThresholdVerdict({ compared: comparisons.length, mismatched: mismatched.length, unexplained: mismatched.length })
  return {
    verdict: sourceVerdict(threshold, sourceFindings, 'claude-code'),
    swob: {
      compactCountSum: reported(comparisons.reduce((sum, comparison) => sum + comparison.swob, 0), 'markers'),
      sessionsCompared: derived(comparisons.length, 'sessions'),
      sessionsEqual: derived(comparisons.length - mismatched.length, 'sessions'),
      sessionsMismatched: derived(mismatched.length, 'sessions'),
      sessionsExcludedChanged: derived(excluded, 'sessions')
    },
    oracle: {
      ...oracle,
      sessionsWithMarkers: derived(comparisons.filter((comparison) => comparison.oracle > 0).length, 'sessions'),
      perSessionUniqueSum: derived(perSessionSum, 'markers'),
      globalUnique: derived(globalUnique, 'markers'),
      inheritedMarkers: derived(Math.max(0, perSessionSum - globalUnique), 'markers', 'compaction.fork-inherited-marker')
    },
    oracleIds: ['census.claude-jsonl']
  }
}

function codexEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.codex!
  const byPath = new Map<string, CodexUnit>(census.units.map((unit) => [unit.path, unit]))
  const eligible = census.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path))
  const topLevel = eligible.filter((unit) => unit.isRollout && (unit.meta?.role ?? 'top-level') === 'top-level')
  const children = eligible.filter((unit) => unit.isRollout && unit.meta && unit.meta.role !== 'top-level')
  const sum = (units: CodexUnit[], pick: (unit: CodexUnit) => number): number => units.reduce((total, unit) => total + pick(unit), 0)
  const inherited = countInheritedCodexMarkers(eligible)
  const oracle: SourceEntry['oracle'] = {
    legacyCompactedRows: reported(sum(topLevel, (unit) => unit.compaction.legacy), 'markers'),
    compactionItemRows: reported(sum(topLevel, (unit) => unit.compaction.items), 'markers'),
    contextCompactionEvents: reported(sum(topLevel, (unit) => unit.compaction.contextCompactionEvents), 'markers'),
    contextCompactedEvents: reported(sum(topLevel, (unit) => unit.compaction.contextCompactedEvents), 'markers'),
    subagentLegacyCompactedRows: reported(sum(children, (unit) => unit.compaction.legacy), 'markers'),
    subagentCompactionItemRows: reported(sum(children, (unit) => unit.compaction.items), 'markers'),
    subagentInheritedMarkers: derived(inherited.inherited, 'markers', 'compaction.fork-inherited-marker')
  }
  if (ctx.readout.status !== 'ok') {
    return { verdict: 'undetermined', swob: { compactCount: unavailable('markers', ctx.readout.reason ?? 'readout.not-isolated') }, oracle, oracleIds: ['census.codex-jsonl'] }
  }
  const comparisons: SessionComparison[] = []
  let excluded = 0
  const globalMarkers = new Set<string>()
  for (const session of ctx.readout.sessions) {
    if (session.source !== 'codex' || session.virtual) continue
    const units = unitsForSession(ctx, session, byPath)
    if (!units) {
      excluded++
      continue
    }
    const markers = new Set<string>()
    const legacy = new Set<string>()
    for (const unit of units) {
      for (const sig of unit.compaction.markerSigs) markers.add(sig)
      for (const sig of unit.compaction.legacySigs) legacy.add(sig)
    }
    for (const sig of markers) globalMarkers.add(sig)
    comparisons.push({ session, oracle: markers.size, swob: session.compactCount, legacy: legacy.size })
  }
  const mismatched = comparisons.filter((comparison) => comparison.oracle !== comparison.swob)
  const legacyUnrecognized = mismatched.filter((comparison) => comparison.legacy > 0 && comparison.swob < comparison.oracle)
  const other = mismatched.filter((comparison) => !legacyUnrecognized.includes(comparison))
  const sourceFindings: Finding[] = []
  const pathOf = (comparison: SessionComparison): string => comparison.session.primaryPath ?? comparison.session.paths[0] ?? ''
  if (legacyUnrecognized.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'codex.legacy-compacted-unrecognized', verdict: 'fail', source: 'codex',
      count: derived(legacyUnrecognized.length, 'sessions'),
      numbers: [legacyUnrecognized.length, legacyUnrecognized.reduce((total, comparison) => total + comparison.legacy, 0)],
      samples: sampleIds(ctx.salt, legacyUnrecognized.map(pathOf))
    }))
  }
  if (other.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'compaction.count-mismatch', verdict: 'fail', source: 'codex', count: derived(other.length, 'sessions'),
      samples: sampleIds(ctx.salt, other.map(pathOf))
    }))
  }
  if (excluded > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'codex', count: derived(excluded, 'sessions') }))
  }
  findings.push(...sourceFindings)
  const threshold = compactionThresholdVerdict({ compared: comparisons.length, mismatched: mismatched.length, unexplained: other.length })
  const perSessionSum = comparisons.reduce((total, comparison) => total + comparison.oracle, 0)
  return {
    verdict: sourceVerdict(threshold, sourceFindings, 'codex'),
    swob: {
      compactCountSum: reported(comparisons.reduce((total, comparison) => total + comparison.swob, 0), 'markers'),
      sessionsCompared: derived(comparisons.length, 'sessions'),
      sessionsEqual: derived(comparisons.length - mismatched.length, 'sessions'),
      sessionsMismatched: derived(mismatched.length, 'sessions'),
      sessionsExcludedChanged: derived(excluded, 'sessions')
    },
    oracle: {
      ...oracle,
      sessionsWithMarkers: derived(comparisons.filter((comparison) => comparison.oracle > 0).length, 'sessions'),
      perSessionUniqueSum: derived(perSessionSum, 'markers'),
      globalUnique: derived(globalMarkers.size, 'markers'),
      inheritedMarkers: derived(Math.max(0, perSessionSum - globalMarkers.size), 'markers', 'compaction.fork-inherited-marker')
    },
    oracleIds: ['census.codex-jsonl']
  }
}

export function compactionCheck(ctx: CheckContext): ReturnType<typeof assembleCheck> {
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
  Object.assign(bySource, remainingSources('compaction', ctx, evaluated))
  const compared = ['claude-code', 'codex'].reduce((total, source) => total + (bySource[source]?.swob.sessionsCompared?.value ?? 0), 0)
  const mismatched = ['claude-code', 'codex'].reduce((total, source) => total + (bySource[source]?.swob.sessionsMismatched?.value ?? 0), 0)
  const oracleTotal = ['claude-code', 'codex'].reduce((total, source) => total + (bySource[source]?.oracle.perSessionUniqueSum?.value ?? 0), 0)
  const swobTotal = ['claude-code', 'codex'].reduce((total, source) => total + (bySource[source]?.swob.compactCountSum?.value ?? 0), 0)
  const result = assembleCheck({
    id: 'compaction',
    bySource,
    findings,
    headline: mismatched === 0 ? 'compaction.pass' : 'compaction.mismatch',
    headlineNumbers: mismatched === 0 ? [compared] : [compared, mismatched, oracleTotal, swobTotal]
  })
  if (ctx.readout.status !== 'ok') result.reason = ctx.readout.reason ?? 'readout.not-isolated'
  return result
}

