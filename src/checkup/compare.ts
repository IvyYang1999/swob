/**
 * compareCheckupReports(previous, current): what changed since the last report
 * (task C1b deliverable 3). Pure; the result is only rendered, never written
 * back into a report (the schema is closed).
 *
 * Two reports are comparable only when both are schema v1, both carry a
 * saltFingerprint and they are equal (same machine: ids and unitSig only match
 * under one salt), and the scope kind is the same. Otherwise the comparison is
 * refused with a reason code — neither level is compared.
 *
 * - Issue level (all six checks): findings with a warn/fail verdict, keyed by
 *   (check, code, source) → added / fixed / unchanged (with the count delta).
 *   An issue found where the previous report could not look (the whole check
 *   was undetermined / not implemented, or the finding needs a report field the
 *   previous report lacks) is a first check, not a new issue. A previous issue
 *   whose check is undetermined now is "not checked", not fixed.
 * - Unit level (① ②, units[]): only units present in both with the same id and
 *   unitSig, unchanged during both runs and with a bucket. A unit has an
 *   inclusion problem when its bucket is not-included/unsupported, and a
 *   content problem when it is a Claude main/subagent file whose measured
 *   swobRead differs from its spec-parseable records (unknown when swobRead is
 *   null). Units only in the current report or with a different unitSig are
 *   "new or changed"; units only in the previous one are "gone".
 * Sources not checked in both runs (marked source.not-selected in either report) are
 * never new or fixed: their issues are first checks (not checked last time) or not
 * checked (not checked this time), and their units are counted apart.
 * Sample ids (sorted, at most five) are for display only.
 */
import {
  CHECK_ORDER,
  SOURCE_IDS,
  type CheckId,
  type CheckupReport,
  type CheckupUnit,
  type Finding,
  type Measure,
  type Verdict
} from './contract'

export type CompareRefusal =
  | 'compare.schema-mismatch'
  | 'compare.previous-no-fingerprint'
  | 'compare.current-no-fingerprint'
  | 'compare.fingerprint-mismatch'
  | 'compare.scope-mismatch'

export interface IssueDelta {
  check: CheckId
  code: string
  source: string
  /** Current verdict; the previous one for fixed / not-checked issues. */
  verdict: Finding['verdict']
  previous: Measure | null
  current: Measure | null
  /** current − previous when both counts are numbers, otherwise null. */
  delta: number | null
  /** Display only: current samples, or the previous ones for fixed / not-checked issues. */
  samples: string[]
}

export interface IssueComparison {
  added: IssueDelta[]
  fixed: IssueDelta[]
  unchanged: IssueDelta[]
  firstCheck: IssueDelta[]
  notChecked: IssueDelta[]
}

export type UnitProblem = 'inclusion' | 'content'
export type UnitOutcome = 'added' | 'fixed' | 'unchanged' | 'firstCheck' | 'notChecked'

export interface UnitGroup {
  outcome: UnitOutcome
  source: string
  problem: UnitProblem
  /** Inclusion reason code (current, or previous when fixed); null for content problems. */
  reason: string | null
  units: number
  samples: string[]
}

export interface UnitComparison {
  /** Units in both reports with the same id and unitSig, unchanged in both runs, with a bucket. */
  compared: number
  groups: UnitGroup[]
  newOrChanged: number
  gone: number
  /** Same id and unitSig but changed during a run or without a bucket in either report. */
  changedDuringRun: number
  /** Units of sources that only one of the two runs checked (neither compared, new nor gone). */
  sourceNotInBoth: number
}

export interface ReportSummary { generatedAt: string; verdict: Verdict; checkupVersion: string | null }

export interface CheckupComparison {
  comparable: boolean
  refusal?: CompareRefusal
  previous: ReportSummary
  current: ReportSummary
  checks: Array<{ id: CheckId; previous: Verdict | null; current: Verdict | null }>
  issues: IssueComparison | null
  units: UnitComparison | null
}

const PROBLEM_VERDICTS: ReadonlySet<string> = new Set(['warn', 'fail'])
const FINGERPRINT = /^[0-9a-f]{8}$/
const SAMPLE_LIMIT = 5

/** Findings that need a report field older reports do not have: absent → the previous report could not find them. */
const FINDING_NEEDS: Readonly<Record<string, (report: CheckupReport) => boolean>> = {
  'readout.source-empty': (report) => !!report.readoutBySource
}

function summary(report: CheckupReport): ReportSummary {
  return {
    generatedAt: report?.generatedAt,
    verdict: report?.verdict,
    checkupVersion: typeof report?.kernel?.checkupVersion === 'string' ? report.kernel.checkupVersion : null
  }
}

function wellFormed(report: CheckupReport): boolean {
  return report?.schemaVersion === 1 && Array.isArray(report.checks) && typeof report.generatedAt === 'string' &&
    Number.isFinite(Date.parse(report.generatedAt))
}

export function comparisonRefusal(previous: CheckupReport, current: CheckupReport): CompareRefusal | null {
  if (!wellFormed(previous) || !wellFormed(current)) return 'compare.schema-mismatch'
  if (typeof previous.saltFingerprint !== 'string' || !FINGERPRINT.test(previous.saltFingerprint)) return 'compare.previous-no-fingerprint'
  if (typeof current.saltFingerprint !== 'string' || !FINGERPRINT.test(current.saltFingerprint)) return 'compare.current-no-fingerprint'
  if (previous.saltFingerprint !== current.saltFingerprint) return 'compare.fingerprint-mismatch'
  if (previous.scope?.kind !== current.scope?.kind) return 'compare.scope-mismatch'
  return null
}

// —— issue level ——

interface IssueEntry { check: CheckId; finding: Finding }

function issueKey(check: string, code: string, source: string): string {
  return `${check}\u0000${code}\u0000${source}`
}

function mergeCount(left: Measure, right: Measure): Measure {
  if (left.value === null || right.value === null) return left.value === null ? left : right
  return { ...left, value: left.value + right.value }
}

function problemIssues(report: CheckupReport): Map<string, IssueEntry> {
  const issues = new Map<string, IssueEntry>()
  for (const check of report.checks ?? []) {
    for (const finding of check.findings ?? []) {
      if (!PROBLEM_VERDICTS.has(finding.verdict)) continue
      const key = issueKey(check.id, finding.code, finding.source)
      const existing = issues.get(key)
      issues.set(key, existing
        ? { check: check.id, finding: { ...existing.finding, count: mergeCount(existing.finding.count, finding.count), samples: [...new Set([...existing.finding.samples, ...finding.samples])].sort().slice(0, SAMPLE_LIMIT) } }
        : { check: check.id, finding })
    }
  }
  return issues
}

/** Sources a report looked at: every listed source except those marked source.not-selected. */
function checkedSources(report: CheckupReport): Set<string> {
  const skipped = new Set<string>()
  const listed = new Set<string>()
  for (const check of report.checks ?? []) {
    for (const [source, entry] of Object.entries(check.bySource ?? {})) {
      listed.add(source)
      if (entry?.swob?.status?.reason === 'source.not-selected') skipped.add(source)
    }
  }
  return new Set([...listed].filter((source) => !skipped.has(source)))
}

function checkLooked(report: CheckupReport, id: CheckId): boolean {
  const check = report.checks?.find((entry) => entry.id === id)
  return !!check && check.verdict !== 'undetermined' && check.reason !== 'check.not-implemented'
}

function delta(previous: Measure | null, current: Measure | null): number | null {
  if (!previous || !current || previous.value === null || current.value === null) return null
  return Math.round((current.value - previous.value) * 1000) / 1000
}

function issueDelta(entry: IssueEntry, previous: Measure | null, current: Measure | null): IssueDelta {
  return {
    check: entry.check,
    code: entry.finding.code,
    source: entry.finding.source,
    verdict: entry.finding.verdict,
    previous,
    current,
    delta: delta(previous, current),
    samples: [...entry.finding.samples].sort().slice(0, SAMPLE_LIMIT)
  }
}

const CHECK_RANK = new Map<string, number>(CHECK_ORDER.map((id, index) => [id, index]))
const SOURCE_RANK = new Map<string, number>(SOURCE_IDS.map((id, index) => [id, index]))

function byCheckSourceCode(left: IssueDelta, right: IssueDelta): number {
  return (CHECK_RANK.get(left.check) ?? 99) - (CHECK_RANK.get(right.check) ?? 99) ||
    (SOURCE_RANK.get(left.source) ?? 99) - (SOURCE_RANK.get(right.source) ?? 99) ||
    left.source.localeCompare(right.source) || left.code.localeCompare(right.code)
}

export function compareIssues(previous: CheckupReport, current: CheckupReport): IssueComparison {
  const before = problemIssues(previous)
  const after = problemIssues(current)
  const lookedBefore = checkedSources(previous)
  const lookedNow = checkedSources(current)
  const result: IssueComparison = { added: [], fixed: [], unchanged: [], firstCheck: [], notChecked: [] }
  for (const [key, entry] of after) {
    const earlier = before.get(key)
    if (earlier) {
      result.unchanged.push(issueDelta(entry, earlier.finding.count, entry.finding.count))
    } else if (!lookedBefore.has(entry.finding.source) || !checkLooked(previous, entry.check) ||
        !(FINDING_NEEDS[entry.finding.code]?.(previous) ?? true)) {
      result.firstCheck.push(issueDelta(entry, null, entry.finding.count))
    } else {
      result.added.push(issueDelta(entry, null, entry.finding.count))
    }
  }
  for (const [key, entry] of before) {
    if (after.has(key)) continue
    if (lookedNow.has(entry.finding.source) && checkLooked(current, entry.check)) result.fixed.push(issueDelta(entry, entry.finding.count, null))
    else result.notChecked.push(issueDelta(entry, entry.finding.count, null))
  }
  for (const list of Object.values(result)) list.sort(byCheckSourceCode)
  return result
}

// —— unit level ——

type ProblemState = 'problem' | 'ok' | 'unknown'

function inclusionProblem(unit: CheckupUnit): string | null {
  if (unit.bucket === 'not-included' || unit.bucket === 'unsupported') return unit.reason ?? unit.bucket
  return null
}

function contentState(unit: CheckupUnit): ProblemState {
  if (unit.kind !== 'claude-main' && unit.kind !== 'claude-subagent') return 'unknown'
  if (unit.swobRead === null || unit.swobRead === undefined) return 'unknown'
  return unit.swobRead !== unit.records?.parseable ? 'problem' : 'ok'
}

function outcome(previous: ProblemState, current: ProblemState): UnitOutcome | null {
  if (current === 'problem') return previous === 'problem' ? 'unchanged' : previous === 'ok' ? 'added' : 'firstCheck'
  if (previous === 'problem') return current === 'ok' ? 'fixed' : 'notChecked'
  return null
}

const OUTCOME_ORDER: readonly UnitOutcome[] = ['added', 'fixed', 'unchanged', 'firstCheck', 'notChecked']

export function compareUnits(previous: CheckupReport, current: CheckupReport): UnitComparison | null {
  if (!Array.isArray(previous.units) || !Array.isArray(current.units)) return null
  const before = new Map(previous.units.map((unit) => [unit.id, unit]))
  const after = new Set(current.units.map((unit) => unit.id))
  const lookedBefore = checkedSources(previous)
  const both = new Set([...checkedSources(current)].filter((source) => lookedBefore.has(source)))
  const outside = new Set<string>()
  const groups = new Map<string, { group: UnitGroup; ids: string[] }>()
  const add = (kind: UnitOutcome, unit: CheckupUnit, problem: UnitProblem, reason: string | null): void => {
    const key = `${kind}\u0000${unit.source}\u0000${problem}\u0000${reason ?? ''}`
    const entry = groups.get(key) ?? { group: { outcome: kind, source: unit.source, problem, reason, units: 0, samples: [] }, ids: [] }
    entry.group.units++
    entry.ids.push(unit.id)
    groups.set(key, entry)
  }
  let compared = 0
  let newOrChanged = 0
  let changedDuringRun = 0
  for (const unit of current.units) {
    if (!both.has(unit.source)) {
      outside.add(unit.id)
      continue
    }
    const earlier = before.get(unit.id)
    if (!earlier || earlier.unitSig !== unit.unitSig) {
      newOrChanged++
      continue
    }
    if (earlier.changed || unit.changed || earlier.bucket === null || unit.bucket === null) {
      changedDuringRun++
      continue
    }
    compared++
    const previousInclusion = inclusionProblem(earlier)
    const currentInclusion = inclusionProblem(unit)
    const inclusionOutcome = outcome(previousInclusion ? 'problem' : 'ok', currentInclusion ? 'problem' : 'ok')
    if (inclusionOutcome) add(inclusionOutcome, unit, 'inclusion', currentInclusion ?? previousInclusion)
    const contentOutcome = outcome(contentState(earlier), contentState(unit))
    if (contentOutcome) add(contentOutcome, unit, 'content', null)
  }
  for (const unit of previous.units) if (!both.has(unit.source)) outside.add(unit.id)
  const gone = previous.units.filter((unit) => both.has(unit.source) && !after.has(unit.id)).length
  const sorted = [...groups.values()].map(({ group, ids }) => ({ ...group, samples: [...new Set(ids)].sort().slice(0, SAMPLE_LIMIT) }))
  sorted.sort((left, right) =>
    OUTCOME_ORDER.indexOf(left.outcome) - OUTCOME_ORDER.indexOf(right.outcome) ||
    (SOURCE_RANK.get(left.source) ?? 99) - (SOURCE_RANK.get(right.source) ?? 99) ||
    left.problem.localeCompare(right.problem) || (left.reason ?? '').localeCompare(right.reason ?? ''))
  return { compared, groups: sorted, newOrChanged, gone, changedDuringRun, sourceNotInBoth: outside.size }
}

export function compareCheckupReports(previous: CheckupReport, current: CheckupReport): CheckupComparison {
  const base = { previous: summary(previous), current: summary(current) }
  const refusal = comparisonRefusal(previous, current)
  if (refusal) return { comparable: false, refusal, ...base, checks: [], issues: null, units: null }
  return {
    comparable: true,
    ...base,
    checks: CHECK_ORDER.map((id) => ({
      id,
      previous: previous.checks.find((check) => check.id === id)?.verdict ?? null,
      current: current.checks.find((check) => check.id === id)?.verdict ?? null
    })),
    issues: compareIssues(previous, current),
    units: compareUnits(previous, current)
  }
}
