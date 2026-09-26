/**
 * ③ Compaction recognition. Oracle: the tools' own markers.
 * - Claude: `system/compact_boundary`, deduplicated by uuid across the
 *   session's physical files (isCompactSummary rows as cross-check).
 * - Codex: primary markers = legacy `compacted` rows + `response_item.compaction`
 *   rows, deduplicated by payload signature across the session's files;
 *   `context_compacted` / `ContextCompaction` events are cross-checks. The
 *   per-session comparison counts each file under the kernel's rule (C1c,
 *   aligned with F1b): its primary format only — `compacted`, else `compaction`
 *   items, else every `*compact*` event row. A file where that rule differs from
 *   the census rows (both formats, or events only) is listed as a known rule
 *   difference (not-applicable); the census rows themselves are unchanged.
 * Per session: Swob's compactCount must equal the oracle. Markers copied from a
 * parent (resume/fork) count per session but are removed from the global
 * count and reported with `compaction.fork-inherited-marker`.
 * Codex keeps one copy of a session id that has several files (the one with the
 * largest bill): a mismatch whose Swob count equals one copy's count is explained
 * (C1c, dispatcher decision D1) — never when Swob counted 0 — and still counts as
 * a mismatch for the ≤ 1 % threshold. legacy-unrecognized means the session has
 * legacy rows and Swob recognised none of them (D7); other mismatches are
 * count-mismatch.
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
  /** Codex sessions with several files (copies of one id): each copy's markers under the kernel's rule. */
  copies: number[]
}

/**
 * A Codex file's markers under the kernel's counting rule (C1c, aligned with F1b; codex-loader.ts
 * codexToRawMessages): the file counts its primary format only — legacy `compacted` rows, else
 * `response_item.compaction` items (each once per payload), else every `*compact*` event row.
 */
function kernelRuleMarkers(unit: CodexUnit): { sigs: readonly string[]; events: number } {
  if (unit.compaction.legacy > 0) return { sigs: unit.compaction.legacySigs, events: 0 }
  if (unit.compaction.items > 0) return { sigs: unit.compaction.itemSigs, events: 0 }
  return { sigs: [], events: unit.compaction.compactEvents }
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
    comparisons.push({ session, oracle: uuids.size + withoutUuid, swob: session.compactCount, legacy: 0, copies: [] })
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
  let globalEvents = 0
  const bothFormatPaths: string[] = []
  const eventOnlyPaths: string[] = []
  for (const session of ctx.readout.sessions) {
    if (session.source !== 'codex' || session.virtual) continue
    const units = unitsForSession(ctx, session, byPath)
    if (!units) {
      excluded++
      continue
    }
    const markers = new Set<string>()
    const legacy = new Set<string>()
    let events = 0
    const copies: number[] = []
    for (const unit of units) {
      const counted = kernelRuleMarkers(unit)
      for (const sig of counted.sigs) markers.add(sig)
      events += counted.events
      copies.push(counted.sigs.length + counted.events)
      for (const sig of unit.compaction.legacySigs) legacy.add(sig)
      if (unit.compaction.legacy > 0 && unit.compaction.items > 0) bothFormatPaths.push(unit.path)
      else if (unit.compaction.legacy === 0 && unit.compaction.items === 0 && unit.compaction.compactEvents > 0) eventOnlyPaths.push(unit.path)
    }
    for (const sig of markers) globalMarkers.add(sig)
    globalEvents += events
    comparisons.push({ session, oracle: markers.size + events, swob: session.compactCount, legacy: legacy.size, copies: units.length > 1 ? copies : [] })
  }
  const mismatched = comparisons.filter((comparison) => comparison.oracle !== comparison.swob)
  // D1: the kernel keeps one copy of a multi-copy session, so a count equal to one copy's is explained —
  // decided before the legacy class, and never for a Swob count of 0 (recognition falling back to 0 must
  // not hide behind a copy without markers).
  const explained = new Set(mismatched.filter((comparison) => comparison.swob > 0 && comparison.copies.includes(comparison.swob)))
  // D7: legacy-unrecognized = the session has legacy rows and Swob recognised none of them.
  const legacyUnrecognized = new Set(mismatched.filter((comparison) => !explained.has(comparison) && comparison.legacy > 0 && comparison.swob === 0))
  const other = mismatched.filter((comparison) => !explained.has(comparison) && !legacyUnrecognized.has(comparison))
  const sourceFindings: Finding[] = []
  const pathOf = (comparison: SessionComparison): string => comparison.session.primaryPath ?? comparison.session.paths[0] ?? ''
  if (legacyUnrecognized.size > 0) {
    sourceFindings.push(makeFinding({
      code: 'codex.legacy-compacted-unrecognized', verdict: 'fail', source: 'codex',
      count: derived(legacyUnrecognized.size, 'sessions'),
      numbers: [legacyUnrecognized.size, [...legacyUnrecognized].reduce((total, comparison) => total + comparison.legacy, 0)],
      samples: sampleIds(ctx.salt, [...legacyUnrecognized].map(pathOf))
    }))
  }
  if (other.length > 0) {
    sourceFindings.push(makeFinding({
      code: 'compaction.count-mismatch', verdict: 'fail', source: 'codex', count: derived(other.length, 'sessions'),
      samples: sampleIds(ctx.salt, other.map(pathOf))
    }))
  }
  if (explained.size > 0) {
    sourceFindings.push(makeFinding({
      code: 'compaction.multi-copy-explained', verdict: 'warn', source: 'codex', count: derived(explained.size, 'sessions'),
      samples: sampleIds(ctx.salt, [...explained].map(pathOf))
    }))
  }
  if (excluded > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'codex', count: derived(excluded, 'sessions') }))
  }
  // D2: files where the kernel's rule differs from the census rows, listed as a known rule difference
  // (never grades ③; absent — and the report unchanged — when there is none).
  const ruleDifferences = bothFormatPaths.length + eventOnlyPaths.length
  if (ruleDifferences > 0) {
    sourceFindings.push(makeFinding({
      code: 'codex.compaction-rule-difference', verdict: 'not-applicable', source: 'codex', count: reported(ruleDifferences, 'files'),
      numbers: [ruleDifferences, bothFormatPaths.length, eventOnlyPaths.length],
      samples: sampleIds(ctx.salt, [...bothFormatPaths, ...eventOnlyPaths])
    }))
  }
  findings.push(...sourceFindings)
  const threshold = compactionThresholdVerdict({ compared: comparisons.length, mismatched: mismatched.length, unexplained: other.length })
  const perSessionSum = comparisons.reduce((total, comparison) => total + comparison.oracle, 0)
  const globalUnique = globalMarkers.size + globalEvents
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
      globalUnique: derived(globalUnique, 'markers'),
      inheritedMarkers: derived(Math.max(0, perSessionSum - globalUnique), 'markers', 'compaction.fork-inherited-marker'),
      ...(bothFormatPaths.length > 0 ? { bothFormatFiles: reported(bothFormatPaths.length, 'files') } : {}),
      ...(eventOnlyPaths.length > 0 ? { eventOnlyFiles: reported(eventOnlyPaths.length, 'files') } : {})
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

