/**
 * renderCheckupMarkdown(report, { audience, previous }): the Markdown report of
 * one CheckupReport (task C1b deliverable 1; layout of design §五 with every
 * heading two levels higher: overall verdict → six-check table → per-source
 * overview → per-check details → appendices).
 *
 * Pure (no file system, no process). Every fixed text comes from templates.ts;
 * every number carries its [R]/[D]/[E]/[U] label; a Measure whose value is null
 * is shown as 「—（原因）」, never as 0. Pre-filled C1a sentences (headline,
 * ownerLine) are used verbatim with one sentence-level label. The result must
 * pass scanMarkdownForPrivacy, otherwise a PrivacyViolationError is thrown
 * (the CLI maps it to exit code 7) and nothing may be written.
 *
 * Also exported for the CLI (C1b-2): report file names with the machine tag,
 * the fixed first-line marker, and local-time formatting.
 */
import {
  CHECK_ORDER,
  SOURCE_IDS,
  type CheckId,
  type CheckResult,
  type CheckupReport,
  type Finding,
  type Label,
  type Measure,
  type Verdict
} from './contract'
import {
  CHECK_LABELS,
  CHECK_SHORT_LABELS,
  COMPARE_TEXT,
  LINEAGE_EDGE_LABELS,
  LOSS_KIND_LABELS,
  MARKDOWN_MARKER,
  MARKDOWN_TEXT,
  MEASURE_LABELS,
  ORACLE_LABELS,
  REASON_SHORT_TEXT,
  REASON_TEXT,
  SOURCE_LABELS,
  UNIT_LABELS,
  VERDICT_LABELS
} from './templates'
import { MACHINE_MODEL, MARKDOWN_VERSION, assertMarkdownPrivacyClean } from './privacy'
import { checkedSources, compareCheckupReports, notSelectedSources, type CheckupComparison, type IssueDelta, type UnitGroup } from './compare'

export { MARKDOWN_MARKER } from './templates'

export type Audience = 'owner' | 'engineer'

export interface RenderOptions {
  /** owner (default): design §五; engineer: + locators, samples, all measure keys, diagnostics, timings. */
  audience?: Audience
  /** The last comparable report; renders the 「和上次比」 section (compareCheckupReports). */
  previous?: CheckupReport | null
  /** `sysctl -n hw.model` of the machine that produced the report (see run-guard.ts readMachineModel); omitted when absent. */
  machineModel?: string | null
  /** Offset used for local times and the file-name date; default: the local time zone at that instant. */
  utcOffsetMinutes?: number
}

// —— formatting ——

export const LABEL_TAGS: Readonly<Record<Label, string>> = { reported: '[R]', derived: '[D]', estimated: '[E]', unavailable: '[U]' }
const LABEL_RANK: Readonly<Record<Label, number>> = { reported: 0, derived: 1, estimated: 2, unavailable: 3 }
const GRADED: ReadonlySet<Verdict> = new Set<Verdict>(['pass', 'warn', 'fail'])
/** A count in a sentence: a digit not glued to a letter ("v2" in a name is not a count). */
const HAS_COUNT = /(?<![A-Za-z])\d/

/** Fill typed placeholders; a list is consumed left to right for repeated placeholders. */
export function fillText(template: string, values: Readonly<Record<string, string | number | ReadonlyArray<string | number>>> = {}): string {
  const cursor = new Map<string, number>()
  return template.replace(/\{([A-Za-z]+)\}/g, (_whole, name: string) => {
    const value = values[name]
    if (value === undefined) throw new Error(`no value for placeholder ${name}`)
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    const index = cursor.get(name) ?? 0
    cursor.set(name, index + 1)
    if (index >= value.length) throw new Error(`no value for placeholder ${name}`)
    return String(value[index])
  })
}

/** Thousands separators, at most three decimals (never a 12+ digit run the hex heuristic would flag). */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return (Math.round(value * 1000) / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })
}

export function formatSigned(value: number): string {
  return value > 0 ? `+${formatNumber(value)}` : formatNumber(value)
}

export interface LocalTime { date: string; time: string; offset: string }

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** Local date / `date hh:mm` / `UTC±hh:mm` of an ISO instant. */
export function localTime(iso: string, utcOffsetMinutes?: number): LocalTime {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) throw new Error('invalid report time')
  const offset = utcOffsetMinutes ?? -new Date(ms).getTimezoneOffset()
  const shifted = new Date(ms + offset * 60_000).toISOString()
  const date = shifted.slice(0, 10)
  const absolute = Math.abs(offset)
  return {
    date,
    time: `${date} ${shifted.slice(11, 16)}`,
    offset: `UTC${offset < 0 ? '-' : '+'}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`
  }
}

export function reasonText(code: string | undefined | null): string {
  const text = code ? (REASON_TEXT as Readonly<Record<string, string>>)[code] : undefined
  return text ?? MARKDOWN_TEXT.unknownReason
}

function sourceLabel(source: string): string | null {
  return SOURCE_LABELS[source] ?? null
}

function safeVersion(version: unknown): string {
  return typeof version === 'string' && MARKDOWN_VERSION.test(version) ? version : '—'
}

function shortCommit(commit: unknown): string {
  return typeof commit === 'string' && /^[0-9a-f]{7,40}$/.test(commit) ? commit.slice(0, 7) : '—'
}

function valueText(measure: Measure): string {
  const text = formatNumber(measure.value ?? 0)
  return measure.unit === 'percent' ? `${text}%` : text
}

/** Table cell of one Measure: number + label, or 「—（原因）」 when the value is null; '' when absent. */
export function measureCell(measure: Measure | undefined): string {
  if (!measure) return ''
  if (measure.value === null) return fillText(MARKDOWN_TEXT.unavailableCell, { reason: reasonText(measure.reason) })
  return `${valueText(measure)}${LABEL_TAGS[measure.label]}`
}

function weakest(labels: Iterable<Label>): Label | null {
  let result: Label | null = null
  for (const label of labels) if (!result || LABEL_RANK[label] > LABEL_RANK[result]) result = label
  return result
}

function verdictCell(verdict: Verdict, reason?: string, short = false): string {
  if (GRADED.has(verdict) || !reason) return VERDICT_LABELS[verdict]
  const text = short ? (REASON_SHORT_TEXT as Readonly<Record<string, string>>)[reason] ?? reasonText(reason) : reasonText(reason)
  return fillText(MARKDOWN_TEXT.verdictWithReason, { verdict: VERDICT_LABELS[verdict], reason: text })
}

/**
 * Sentence-level label of a check headline: the weakest label among the non-null Measures of the sources
 * that got a verdict (pass/warn/fail) — those are the numbers the headline is built from. None when the
 * sentence has no number.
 */
export function headlineLabel(check: CheckResult): Label | null {
  if (!HAS_COUNT.test(check.headline)) return null
  const labels: Label[] = []
  for (const entry of Object.values(check.bySource)) {
    if (!GRADED.has(entry.verdict)) continue
    for (const measure of [...Object.values(entry.swob), ...Object.values(entry.oracle)]) {
      if (measure.value !== null) labels.push(measure.label)
    }
  }
  return weakest(labels)
}

function table(header: string[], rows: string[][]): string[] {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)]
}

// —— file names ——

export const REPORT_FILE_PREFIX = 'Swob内核体检-'
/** `Swob内核体检-YYYY-MM-DD-<tag>.md|json` (tag = first 6 hex of saltFingerprint). */
export const REPORT_FILE_PATTERN = /^Swob内核体检-(\d{4}-\d{2}-\d{2})-([0-9a-f]{6})\.(md|json)$/
/** Report note name without extension (the digest's wikilink target). */
export const REPORT_BASENAME_PATTERN = /^Swob内核体检-(\d{4}-\d{2}-\d{2})-([0-9a-f]{6})$/
export const LATEST_FILE_PATTERN = /^最新-([0-9a-f]{6})\.md$/

export interface ReportFileNames { tag: string; date: string; base: string; markdown: string; json: string; latest: string }

/** Machine tag: the first six hex of the report's saltFingerprint (stable per machine, never the salt). */
export function machineTag(saltFingerprint: string | undefined | null): string {
  if (typeof saltFingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(saltFingerprint)) throw new Error('report has no saltFingerprint')
  return saltFingerprint.slice(0, 6)
}

/** File names for one report; the date is the local date of `generatedAt`. */
export function reportFileNames(report: Pick<CheckupReport, 'generatedAt' | 'saltFingerprint'>, options: { utcOffsetMinutes?: number } = {}): ReportFileNames {
  const tag = machineTag(report.saltFingerprint)
  const { date } = localTime(report.generatedAt, options.utcOffsetMinutes)
  const base = `${REPORT_FILE_PREFIX}${date}-${tag}`
  return { tag, date, base, markdown: `${base}.md`, json: `${base}.json`, latest: `最新-${tag}.md` }
}

// —— sections ——

function findCheck(report: CheckupReport, id: CheckId): CheckResult | undefined {
  return report.checks.find((check) => check.id === id)
}

/**
 * The scope line. A --sources report (some source marked source.not-selected, C1c) names the sources it
 * checked instead of claiming all raw data.
 */
function scopeLine(report: CheckupReport): string | null {
  const scope = report.scope
  const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  if (scope.kind === 'all') {
    const skipped = notSelectedSources(report)
    const checked = [...checkedSources(report)].filter((source) => sourceLabel(source) !== null)
    if (skipped.size === 0 || checked.length === 0) return MARKDOWN_TEXT.headScopeAll
    const order = (source: string): number => {
      const index = (SOURCE_IDS as readonly string[]).indexOf(source)
      return index < 0 ? SOURCE_IDS.length : index
    }
    return fillText(MARKDOWN_TEXT.headScopeSources, {
      sources: checked.sort((left, right) => order(left) - order(right)).map((source) => sourceLabel(source)!).join('、'),
      n: formatNumber(skipped.size)
    })
  }
  if (scope.kind === 'day' && isDate(scope.day)) return fillText(MARKDOWN_TEXT.headScopeDay, { date: scope.day })
  if (scope.kind === 'range' && isDate(scope.since) && isDate(scope.until)) return fillText(MARKDOWN_TEXT.headScopeRange, { date: [scope.since, scope.until] })
  return null
}

function headerLines(report: CheckupReport, options: RenderOptions): string[] {
  const at = localTime(report.generatedAt, options.utcOffsetMinutes)
  const machine = [fillText(MARKDOWN_TEXT.headGenerated, { time: at.time, offset: at.offset })]
  if (typeof options.machineModel === 'string' && MACHINE_MODEL.test(options.machineModel)) {
    machine.push(fillText(MARKDOWN_TEXT.headMachine, { model: options.machineModel }))
  }
  if (typeof report.saltFingerprint === 'string' && /^[0-9a-f]{8}$/.test(report.saltFingerprint)) {
    machine.push(fillText(MARKDOWN_TEXT.headMachineTag, { tag: machineTag(report.saltFingerprint) }))
  }
  const kernel = [
    fillText(MARKDOWN_TEXT.headKernel, { version: safeVersion(report.kernel.version), commit: shortCommit(report.kernel.commit) }),
    MARKDOWN_TEXT.headReadOnly,
    fillText(MARKDOWN_TEXT.headCheckup, { version: safeVersion(report.kernel.checkupVersion) }),
    fillText(MARKDOWN_TEXT.headSelfTest, { n: [formatNumber(report.kernel.selfTest.passed), formatNumber(report.kernel.selfTest.total)] })
  ]
  const run: string[] = []
  const scope = scopeLine(report)
  if (scope) run.push(scope)
  const total = report.timingsMs?.total
  if (typeof total === 'number' && Number.isFinite(total)) run.push(fillText(MARKDOWN_TEXT.headDuration, { n: formatNumber(Math.max(1, Math.round(total / 1000))) }))
  return [
    MARKDOWN_MARKER,
    `# ${fillText(MARKDOWN_TEXT.title, { date: at.date })}`,
    '',
    `> ${machine.join(' · ')}`,
    `> ${kernel.join(' · ')}`,
    ...(run.length > 0 ? [`> ${run.join(' · ')}`] : []),
    `> ${MARKDOWN_TEXT.headLegend}`
  ]
}

function compareLine(comparison: CheckupComparison | null, options: RenderOptions): string {
  if (!comparison) return COMPARE_TEXT.none
  if (!comparison.comparable || !comparison.issues) return fillText(COMPARE_TEXT.refused, { reason: reasonText(comparison.refusal) })
  const issues = comparison.issues
  const counts = [issues.added.length, issues.fixed.length, issues.unchanged.length, issues.firstCheck.length]
  // Previous issues this run could not look at are named here too, not only in the section below.
  return fillText(issues.notChecked.length > 0 ? COMPARE_TEXT.summaryWithNotChecked : COMPARE_TEXT.summary, {
    date: localTime(comparison.previous.generatedAt, options.utcOffsetMinutes).date,
    n: (issues.notChecked.length > 0 ? [...counts, issues.notChecked.length] : counts).map(formatNumber)
  })
}

/**
 * Sources whose raw data is present while the readout returned no session (readout.source-empty, listed
 * under ①), in source order. The finding never grades ①, so it is surfaced at the top as well.
 */
function emptySourceFindings(report: CheckupReport): Finding[] {
  const findings = (findCheck(report, 'inclusion')?.findings ?? [])
    .filter((finding) => finding.code === 'readout.source-empty' && sourceLabel(finding.source) !== null)
  const order = (source: string): number => {
    const index = (SOURCE_IDS as readonly string[]).indexOf(source)
    return index < 0 ? SOURCE_IDS.length : index
  }
  return findings.sort((left, right) => order(left.source) - order(right.source))
}

function overallLines(report: CheckupReport, comparison: CheckupComparison | null, options: RenderOptions): string[] {
  const checks = CHECK_ORDER.map((id) => findCheck(report, id)).filter((check): check is CheckResult => !!check)
  const count = (verdict: Verdict): string => formatNumber(checks.filter((check) => check.verdict === verdict).length)
  const lines = [`## ${fillText(MARKDOWN_TEXT.overall, { verdict: VERDICT_LABELS[report.verdict] })}`, '']
  lines.push(fillText(MARKDOWN_TEXT.overallCounts, {
    n: [formatNumber(checks.length), count('fail'), count('warn'), count('pass'), count('not-applicable'), count('undetermined')]
  }))
  if (report.verdict === 'undetermined') lines.push('', fillText(MARKDOWN_TEXT.overallReason, { reason: reasonText(report.verdictReason) }))
  const empty = emptySourceFindings(report)
  if (empty.length > 0) {
    lines.push('', fillText(MARKDOWN_TEXT.overallSourceEmpty, { sources: [...new Set(empty.map((finding) => sourceLabel(finding.source)!))].join('、') }))
  }
  const failing = checks.filter((check) => check.verdict === 'fail').map((check) => CHECK_LABELS[check.id])
  const warning = checks.filter((check) => check.verdict === 'warn').map((check) => CHECK_LABELS[check.id])
  if (failing.length > 0) lines.push('', fillText(MARKDOWN_TEXT.adviceFail, { checks: failing.join('、') }))
  else if (warning.length > 0) lines.push('', fillText(MARKDOWN_TEXT.adviceWarn, { checks: warning.join('、') }))
  else if (checks.some((check) => check.verdict === 'pass')) lines.push('', MARKDOWN_TEXT.advicePass)
  lines.push('', ...table(
    [MARKDOWN_TEXT.colCheck, MARKDOWN_TEXT.colVerdict, MARKDOWN_TEXT.colHeadline, MARKDOWN_TEXT.colAction],
    checks.map((check) => {
      const label = headlineLabel(check)
      return [CHECK_LABELS[check.id], verdictCell(check.verdict, check.reason), `${check.headline}${label ? LABEL_TAGS[label] : ''}`, check.ownerAction]
    })
  ))
  lines.push('', compareLine(comparison, options))
  // C2a and C2b each independently added a "本次新增了…的判定" line for this same transition (one here,
  // one in compareSection() below); merge keeps only compareSection()'s copy, next to the per-check
  // previous/current table it explains, rather than printing the identical sentence twice in one report.
  return lines
}

function orderedSources(report: CheckupReport): string[] {
  const seen = new Set<string>(SOURCE_IDS)
  for (const check of report.checks) for (const source of Object.keys(check.bySource)) seen.add(source)
  for (const source of Object.keys(report.readoutBySource ?? {})) seen.add(source)
  return [...seen].filter((source) => sourceLabel(source) !== null)
}

/** Findings that explain a graded per-source cell by themselves (short reason in brackets, own legend line). */
const ANNOTATED_FINDING_CODES: ReadonlySet<string> = new Set(['unsupported.kimi-legacy-sessions'])

/** The one annotated finding code behind a source's warn/fail in `check`, if that is its only problem. */
function annotatedFindingCode(check: CheckResult | undefined, source: string): string | null {
  const codes = new Set((check?.findings ?? [])
    .filter((finding) => finding.source === source && (finding.verdict === 'warn' || finding.verdict === 'fail'))
    .map((finding) => finding.code))
  const [code] = codes
  return codes.size === 1 && ANNOTATED_FINDING_CODES.has(code) && (REASON_SHORT_TEXT as Readonly<Record<string, string>>)[code] ? code : null
}

function sourcesLines(report: CheckupReport): string[] {
  const withReadout = !!report.readoutBySource
  const header = [MARKDOWN_TEXT.colSource, ...CHECK_ORDER.map((id) => CHECK_SHORT_LABELS[id]), ...(withReadout ? [MARKDOWN_TEXT.colReadoutSessions] : [])]
  const groups = new Map<string, { sources: string[]; cells: string[] }>()
  const empty = new Map(emptySourceFindings(report).map((finding) => [finding.source, finding]))
  let annotated = false
  for (const source of orderedSources(report)) {
    const cells = CHECK_ORDER.map((id) => {
      const check = findCheck(report, id)
      const entry = check?.bySource[source]
      if (!entry) return '—'
      // e.g. 「注意（旧版目录）」: Kimi Code's ① warning comes only from the legacy Kimi directory.
      const code = GRADED.has(entry.verdict) ? annotatedFindingCode(check, source) : null
      if (code) {
        annotated = true
        return fillText(MARKDOWN_TEXT.verdictWithReason, { verdict: VERDICT_LABELS[entry.verdict], reason: (REASON_SHORT_TEXT as Readonly<Record<string, string>>)[code] })
      }
      return verdictCell(entry.verdict, entry.swob.status?.reason, true)
    })
    if (withReadout) {
      const cell = measureCell(report.readoutBySource?.[source]?.sessions) || '—'
      const flagged = empty.get(source)
      // 「0[R]（注意）」: raw data present, nothing read (readout.source-empty).
      cells.push(flagged ? fillText(MARKDOWN_TEXT.readoutCellFlagged, { n: cell, verdict: VERDICT_LABELS[flagged.verdict] }) : cell)
    }
    const key = cells.join('\u0000')
    const group = groups.get(key) ?? { sources: [], cells }
    group.sources.push(source)
    groups.set(key, group)
  }
  const rows = [...groups.values()].map((group) => [group.sources.map((source) => sourceLabel(source)!).join(' · '), ...group.cells])
  return [
    `## ${MARKDOWN_TEXT.sourcesHeading}`, '', ...table(header, rows), '', MARKDOWN_TEXT.sourcesLegend,
    ...(annotated ? ['', MARKDOWN_TEXT.sourcesLegendLegacy] : [])
  ]
}

type Entry = CheckResult['bySource'][string]

function measured(entry: Entry): boolean {
  return [...Object.keys(entry.swob), ...Object.keys(entry.oracle)].some((key) => key !== 'status')
}

function measuredSources(check: CheckResult): string[] {
  return Object.keys(check.bySource).filter((source) => sourceLabel(source) !== null && measured(check.bySource[source]))
}

interface Column { header: string; side: 'swob' | 'oracle'; key: string }

function columnsTable(check: CheckResult, columns: Column[], used: Set<string>): string[] {
  const rows: string[][] = []
  for (const source of measuredSources(check)) {
    const entry = check.bySource[source]
    if (!columns.some((column) => entry[column.side][column.key])) continue
    for (const column of columns) used.add(`${column.side}.${column.key}`)
    rows.push([sourceLabel(source)!, ...columns.map((column) => measureCell(entry[column.side][column.key]))])
  }
  return rows.length > 0 ? table([MARKDOWN_TEXT.colSource, ...columns.map((column) => column.header)], rows) : []
}

const INCLUSION_COLUMNS: Column[] = [
  { header: MARKDOWN_TEXT.colUnits, side: 'oracle', key: 'units' },
  { header: MARKDOWN_TEXT.colBecameSession, side: 'swob', key: 'becameSession' },
  { header: MARKDOWN_TEXT.colMerged, side: 'swob', key: 'merged' },
  { header: MARKDOWN_TEXT.colExcluded, side: 'swob', key: 'excluded' },
  { header: MARKDOWN_TEXT.colNotIncluded, side: 'swob', key: 'notIncluded' },
  { header: MARKDOWN_TEXT.colUnsupported, side: 'swob', key: 'unsupported' },
  { header: MARKDOWN_TEXT.colChanged, side: 'swob', key: 'changedDuringRun' },
  { header: MARKDOWN_TEXT.colInclusionRate, side: 'swob', key: 'inclusionRate' }
]

const LOSS_SUFFIXES: ReadonlyArray<[keyof typeof LOSS_KIND_LABELS, string]> = [
  ['user', 'User'], ['assistant', 'Assistant'], ['tool_result', 'ToolResult'], ['meta', 'Meta']
]

function prefixed(prefix: string, name: string): string {
  return prefix ? `${prefix}${name}` : `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

function lossKindsCell(swob: Record<string, Measure>, prefix: string, used: Set<string>): string {
  const parts: Array<[string, Measure | undefined]> = LOSS_SUFFIXES.map(([kind, suffix]) => {
    const key = prefix ? `${prefix}Lost${suffix}` : `lost${suffix}`
    used.add(`swob.${key}`)
    return [LOSS_KIND_LABELS[kind], swob[key]]
  })
  const unexplainedKey = prefix ? `${prefix}UnexplainedLost` : 'unexplainedLost'
  used.add(`swob.${unexplainedKey}`)
  parts.push([LOSS_KIND_LABELS.unexplained, swob[unexplainedKey]])
  const present = parts.filter((part): part is [string, Measure] => !!part[1])
  const counted = present.filter(([, measure]) => measure.value !== null && measure.value > 0)
  if (counted.length === 0) return present.length > 0 ? '—' : ''
  const label = weakest(counted.map(([, measure]) => measure.label))
  const text = fillText(MARKDOWN_TEXT.lossKinds, { kinds: counted.map(([name, measure]) => `${name} ${formatNumber(measure.value!)}`).join('、') })
  return `${text}${label ? LABEL_TAGS[label] : ''}`
}

function contentTable(check: CheckResult, used: Set<string>): string[] {
  const rows: string[][] = []
  for (const source of measuredSources(check)) {
    const entry = check.bySource[source]
    for (const prefix of ['main', 'subagent', '']) {
      const key = (name: string): string => prefixed(prefix, name)
      if (!entry.oracle[key('Parseable')]) continue
      const label = prefix === 'main'
        ? fillText(MARKDOWN_TEXT.rowMain, { source: sourceLabel(source)! })
        : prefix === 'subagent' ? fillText(MARKDOWN_TEXT.rowSubagent, { source: sourceLabel(source)! }) : sourceLabel(source)!
      for (const name of ['NonBlankLines', 'BadLines', 'Parseable']) used.add(`oracle.${key(name)}`)
      for (const name of ['Read', 'Lost', 'ReadRate']) used.add(`swob.${key(name)}`)
      rows.push([
        label,
        measureCell(entry.oracle[key('NonBlankLines')]),
        measureCell(entry.oracle[key('BadLines')]),
        measureCell(entry.oracle[key('Parseable')]),
        measureCell(entry.swob[key('Read')]),
        measureCell(entry.swob[key('Lost')]),
        lossKindsCell(entry.swob, prefix, used),
        measureCell(entry.swob[key('ReadRate')])
      ])
    }
  }
  const header = [MARKDOWN_TEXT.colSource, MARKDOWN_TEXT.colNonBlank, MARKDOWN_TEXT.colToolBad, MARKDOWN_TEXT.colParseable,
    MARKDOWN_TEXT.colSwobRead, MARKDOWN_TEXT.colLost, MARKDOWN_TEXT.colLostKinds, MARKDOWN_TEXT.colReadRate]
  return rows.length > 0 ? table(header, rows) : []
}

function ratioCell(numerator: Measure | undefined, denominator: Measure | undefined): string {
  if (!numerator || !denominator) return ''
  if (numerator.value === null) return measureCell(numerator)
  if (denominator.value === null) return measureCell(denominator)
  const label = weakest([numerator.label, denominator.label])
  return `${fillText(MARKDOWN_TEXT.sessionsRatio, { n: [formatNumber(numerator.value), formatNumber(denominator.value)] })}${label ? LABEL_TAGS[label] : ''}`
}

function compactionTable(check: CheckResult, used: Set<string>): string[] {
  const rows: string[][] = []
  for (const source of measuredSources(check)) {
    const entry = check.bySource[source]
    if (!entry.oracle.perSessionUniqueSum && !entry.swob.compactCountSum) continue
    for (const key of ['oracle.sessionsWithMarkers', 'oracle.perSessionUniqueSum', 'oracle.globalUnique', 'swob.compactCountSum', 'swob.sessionsEqual', 'swob.sessionsCompared']) used.add(key)
    rows.push([
      sourceLabel(source)!,
      measureCell(entry.oracle.sessionsWithMarkers),
      measureCell(entry.oracle.perSessionUniqueSum),
      measureCell(entry.oracle.globalUnique),
      measureCell(entry.swob.compactCountSum),
      ratioCell(entry.swob.sessionsEqual, entry.swob.sessionsCompared)
    ])
  }
  const header = [MARKDOWN_TEXT.colSource, MARKDOWN_TEXT.colSessionsWithMarkers, MARKDOWN_TEXT.colPerSession, MARKDOWN_TEXT.colGlobal,
    MARKDOWN_TEXT.colSwobCompact, MARKDOWN_TEXT.colSessionsEqual]
  return rows.length > 0 ? table(header, rows) : []
}

/** ④ lineage: one row per (source, edge type), same shape the checks/lineage.ts oracle/swob keys share. */
const LINEAGE_EDGE_TYPES: ReadonlyArray<{ source: string; key: keyof typeof LINEAGE_EDGE_LABELS }> = [
  { source: 'codex', key: 'derivation' },
  { source: 'codex', key: 'fork' },
  { source: 'claude-code', key: 'continuation' },
  { source: 'claude-code', key: 'subagent' },
  { source: 'claude-code', key: 'resumeFork' }
]

function lineageTable(check: CheckResult, used: Set<string>): string[] {
  const rows: string[][] = []
  for (const { source, key } of LINEAGE_EDGE_TYPES) {
    const entry = check.bySource[source]
    if (!entry) continue
    const totalKey = `${key}Total`
    const expressedKey = `${key}Expressed`
    const notExpressedKey = `${key}NotExpressed`
    const swobExtraKey = `${key}SwobExtra`
    if (!entry.oracle[totalKey]) continue
    used.add(`oracle.${totalKey}`)
    used.add(`swob.${expressedKey}`)
    used.add(`swob.${notExpressedKey}`)
    used.add(`swob.${swobExtraKey}`)
    rows.push([
      sourceLabel(source)!,
      LINEAGE_EDGE_LABELS[key],
      measureCell(entry.oracle[totalKey]),
      measureCell(entry.swob[expressedKey]),
      measureCell(entry.swob[notExpressedKey]),
      measureCell(entry.swob[swobExtraKey])
    ])
  }
  const header = [MARKDOWN_TEXT.colSource, MARKDOWN_TEXT.colEdgeType, MARKDOWN_TEXT.colEdgeTotal,
    MARKDOWN_TEXT.colEdgeExpressed, MARKDOWN_TEXT.colEdgeNotExpressed, MARKDOWN_TEXT.colEdgeSwobExtra]
  return rows.length > 0 ? table(header, rows) : []
}

/**
 * ⑤ Token (C2a): one row per source — the headline numbers (billing total both sides, deviation, per-
 * session exact match). The four components (`nonCachedInput`/`cacheRead`/`cacheWrite`/`output`/
 * `reasoning`) and the oracle's unique-fact count are not claimed here, so they fall through to
 * `otherNumbers()` (the generic per-check appendix), same as `compactionTable`'s finer numbers do.
 */
function tokensTable(check: CheckResult, used: Set<string>): string[] {
  const rows: string[][] = []
  for (const source of measuredSources(check)) {
    const entry = check.bySource[source]
    if (!entry.oracle.billingTotal && !entry.swob.billingTotal) continue
    for (const key of ['oracle.billingTotal', 'swob.billingTotal', 'swob.billingTotalDeviationPct', 'swob.sessionsEqual', 'swob.sessionsCompared']) used.add(key)
    rows.push([
      sourceLabel(source)!,
      measureCell(entry.oracle.billingTotal),
      measureCell(entry.swob.billingTotal),
      measureCell(entry.swob.billingTotalDeviationPct),
      ratioCell(entry.swob.sessionsEqual, entry.swob.sessionsCompared)
    ])
  }
  const header = [MARKDOWN_TEXT.colSource, MARKDOWN_TEXT.colOracleBillingTotal, MARKDOWN_TEXT.colSwobBillingTotal,
    MARKDOWN_TEXT.colDeviation, MARKDOWN_TEXT.colSessionsEqual]
  return rows.length > 0 ? table(header, rows) : []
}

const FINDING_ORDER: Readonly<Record<string, number>> = { fail: 0, warn: 1, undetermined: 2, 'not-applicable': 3 }

function findingLines(check: CheckResult, audience: Audience): string[] {
  const findings = [...check.findings].sort((left, right) => (FINDING_ORDER[left.verdict] ?? 9) - (FINDING_ORDER[right.verdict] ?? 9))
  const lines: string[] = []
  for (const finding of findings) {
    const label = HAS_COUNT.test(finding.ownerLine) ? LABEL_TAGS[finding.count.label] : ''
    lines.push(`- ${VERDICT_LABELS[finding.verdict]} · ${finding.ownerLine}${label}`)
    if (audience === 'engineer') {
      lines.push(`  - ${finding.engineerHint}`)
      if (finding.samples.length > 0) lines.push(`  - ${fillText(MARKDOWN_TEXT.samplesLine, { samples: finding.samples.join(' ') })}`)
    }
  }
  return lines
}

function otherNumbers(check: CheckResult, used: Set<string>, audience: Audience): string[] {
  const sources = measuredSources(check)
  const rows = new Map<string, { side: 'swob' | 'oracle'; key: string; unit: string; cells: Map<string, Measure> }>()
  for (const source of sources) {
    const entry = check.bySource[source]
    for (const side of ['swob', 'oracle'] as const) {
      for (const [key, measure] of Object.entries(entry[side])) {
        if (key === 'status' || used.has(`${side}.${key}`)) continue
        if (audience === 'owner' && !MEASURE_LABELS[key]) continue
        const rowKey = `${side}\u0000${key}`
        const row = rows.get(rowKey) ?? { side, key, unit: measure.unit, cells: new Map<string, Measure>() }
        row.cells.set(source, measure)
        rows.set(rowKey, row)
      }
    }
  }
  if (rows.size === 0) return []
  const columns = sources.filter((source) => [...rows.values()].some((row) => row.cells.has(source)))
  const header = [MARKDOWN_TEXT.colMeasure, MARKDOWN_TEXT.colSide, MARKDOWN_TEXT.colUnit, ...columns.map((source) => sourceLabel(source)!)]
  const body = [...rows.values()].map((row) => [
    MEASURE_LABELS[row.key] ?? row.key,
    row.side === 'swob' ? MARKDOWN_TEXT.sideSwob : MARKDOWN_TEXT.sideOracle,
    UNIT_LABELS[row.unit] ?? (audience === 'engineer' ? row.unit : ''),
    ...columns.map((source) => measureCell(row.cells.get(source)))
  ])
  return [`### ${MARKDOWN_TEXT.otherNumbers}`, '', ...table(header, body)]
}

function checkSection(check: CheckResult, audience: Audience): string[] {
  const heading = check.reason && !GRADED.has(check.verdict)
    ? fillText(MARKDOWN_TEXT.checkHeadingReason, { check: CHECK_LABELS[check.id], verdict: VERDICT_LABELS[check.verdict], reason: reasonText(check.reason) })
    : fillText(MARKDOWN_TEXT.checkHeading, { check: CHECK_LABELS[check.id], verdict: VERDICT_LABELS[check.verdict] })
  const lines = [`## ${heading}`, '']
  const oracleIds = [...new Set(measuredSources(check).flatMap((source) => check.bySource[source].oracleIds))]
    .filter((id) => ORACLE_LABELS[id])
  if (oracleIds.length > 0) lines.push(fillText(MARKDOWN_TEXT.oracleLine, { oracles: oracleIds.map((id) => ORACLE_LABELS[id]).join('、') }), '')
  const used = new Set<string>()
  const main = check.id === 'inclusion' ? columnsTable(check, INCLUSION_COLUMNS, used)
    : check.id === 'content' ? contentTable(check, used)
      : check.id === 'compaction' ? compactionTable(check, used)
        : check.id === 'lineage' ? lineageTable(check, used)
          : check.id === 'tokens' ? tokensTable(check, used) : []
  if (main.length > 0) lines.push(...main, '')
  if (main.length === 0 && check.findings.length === 0) {
    const label = headlineLabel(check)
    lines.push(`${check.headline}${label ? LABEL_TAGS[label] : ''}`, '')
  }
  const findings = findingLines(check, audience)
  if (findings.length > 0) lines.push(...findings, '')
  const other = otherNumbers(check, used, audience)
  if (other.length > 0) lines.push(...other, '')
  return lines
}

function issueRows(group: string, issues: IssueDelta[]): string[][] {
  return issues.map((issue) => [
    group,
    CHECK_LABELS[issue.check],
    sourceLabel(issue.source) ?? '—',
    reasonText(issue.code),
    issue.previous ? measureCell(issue.previous) : '—',
    issue.current ? measureCell(issue.current) : '—',
    issue.delta === null ? '—' : formatSigned(issue.delta)
  ])
}

const UNIT_GROUP_LABEL: Readonly<Record<UnitGroup['outcome'], string>> = {
  added: COMPARE_TEXT.groupAdded,
  fixed: COMPARE_TEXT.groupFixed,
  unchanged: COMPARE_TEXT.groupUnchanged,
  firstCheck: COMPARE_TEXT.groupFirstCheck,
  notChecked: COMPARE_TEXT.groupNotChecked
}

function compareSection(comparison: CheckupComparison, options: RenderOptions, audience: Audience): string[] {
  if (!comparison.comparable || !comparison.issues) return []
  const previousAt = localTime(comparison.previous.generatedAt, options.utcOffsetMinutes)
  const lines = [`## ${COMPARE_TEXT.heading}`, '']
  lines.push(`${fillText(COMPARE_TEXT.previousReport, { time: previousAt.time, offset: previousAt.offset })} · ${fillText(COMPARE_TEXT.verdicts, {
    verdict: [VERDICT_LABELS[comparison.previous.verdict] ?? '—', VERDICT_LABELS[comparison.current.verdict] ?? '—']
  })}`)
  const versions = [comparison.previous.checkupVersion, comparison.current.checkupVersion]
  if (versions[0] !== versions[1] && versions.every((version) => typeof version === 'string' && MARKDOWN_VERSION.test(version))) {
    lines.push('', fillText(COMPARE_TEXT.versionChanged, { version: versions as string[] }))
  }
  lines.push('', ...table([MARKDOWN_TEXT.colCheck, COMPARE_TEXT.colPrevious, COMPARE_TEXT.colCurrent], comparison.checks.map((check) => [
    CHECK_LABELS[check.id],
    check.previous ? VERDICT_LABELS[check.previous] : '—',
    check.current ? VERDICT_LABELS[check.current] : '—'
  ])))
  // A check that moved from undetermined (check.not-implemented) to a real verdict: never a "new issue"
  // (compareIssues already routes it to firstCheck), just named here so it is not misread as regressed.
  const newlyImplemented = comparison.checks
    .filter((check) => check.previous === 'undetermined' && check.current !== null && check.current !== 'undetermined')
    .map((check) => CHECK_LABELS[check.id])
  if (newlyImplemented.length > 0) lines.push('', fillText(COMPARE_TEXT.newlyImplementedChecks, { checks: newlyImplemented.join('、') }))
  const issues = comparison.issues
  lines.push('', `### ${COMPARE_TEXT.issueHeading}`, '', ...table([COMPARE_TEXT.colGroup, COMPARE_TEXT.colCount], [
    [COMPARE_TEXT.groupAdded, formatNumber(issues.added.length)],
    [COMPARE_TEXT.groupFixed, formatNumber(issues.fixed.length)],
    [COMPARE_TEXT.groupUnchanged, formatNumber(issues.unchanged.length)],
    [COMPARE_TEXT.groupFirstCheck, formatNumber(issues.firstCheck.length)],
    ...(issues.notChecked.length > 0 ? [[COMPARE_TEXT.groupNotChecked, formatNumber(issues.notChecked.length)]] : [])
  ]))
  const detail = [
    ...issueRows(COMPARE_TEXT.groupAdded, issues.added),
    ...issueRows(COMPARE_TEXT.groupFixed, issues.fixed),
    ...issueRows(COMPARE_TEXT.groupUnchanged, issues.unchanged),
    ...issueRows(COMPARE_TEXT.groupFirstCheck, issues.firstCheck),
    ...issueRows(COMPARE_TEXT.groupNotChecked, issues.notChecked)
  ]
  if (detail.length > 0) {
    lines.push('', ...table([COMPARE_TEXT.colGroup, MARKDOWN_TEXT.colCheck, MARKDOWN_TEXT.colSource, COMPARE_TEXT.colProblem,
      COMPARE_TEXT.colPrevious, COMPARE_TEXT.colCurrent, COMPARE_TEXT.colDelta], detail))
  }
  lines.push('', `### ${COMPARE_TEXT.unitHeading}`, '')
  const units = comparison.units
  if (!units) {
    lines.push(COMPARE_TEXT.unitsUnavailable)
    return lines
  }
  const inGroup = (outcome: UnitGroup['outcome']): string =>
    formatNumber(units.groups.filter((group) => group.outcome === outcome).reduce((sum, group) => sum + group.units, 0))
  lines.push(...table([COMPARE_TEXT.colGroup, COMPARE_TEXT.colUnitCount], [
    [COMPARE_TEXT.unitsCompared, formatNumber(units.compared)],
    [COMPARE_TEXT.groupAdded, inGroup('added')],
    [COMPARE_TEXT.groupFixed, inGroup('fixed')],
    [COMPARE_TEXT.groupUnchanged, inGroup('unchanged')],
    [COMPARE_TEXT.groupFirstCheck, inGroup('firstCheck')],
    [COMPARE_TEXT.groupNotChecked, inGroup('notChecked')],
    [COMPARE_TEXT.unitsNewOrChanged, formatNumber(units.newOrChanged)],
    [COMPARE_TEXT.unitsGone, formatNumber(units.gone)],
    [COMPARE_TEXT.unitsChangedDuringRun, formatNumber(units.changedDuringRun)],
    ...(units.sourceNotInBoth > 0 ? [[COMPARE_TEXT.unitsSourceNotInBoth, formatNumber(units.sourceNotInBoth)]] : [])
  ]))
  const groups = units.groups.filter((group) => sourceLabel(group.source) !== null)
  if (groups.length > 0) {
    const header: string[] = [COMPARE_TEXT.colGroup, MARKDOWN_TEXT.colSource, COMPARE_TEXT.colProblem, COMPARE_TEXT.colReason, COMPARE_TEXT.colUnitCount]
    if (audience === 'engineer') header.push(COMPARE_TEXT.colSamples)
    lines.push('', ...table(header, groups.map((group) => [
      UNIT_GROUP_LABEL[group.outcome],
      sourceLabel(group.source)!,
      group.problem === 'inclusion' ? COMPARE_TEXT.problemInclusion : COMPARE_TEXT.problemContent,
      group.reason ? reasonText(group.reason) : '—',
      formatNumber(group.units),
      ...(audience === 'engineer' ? [group.samples.length > 0 ? fillText(MARKDOWN_TEXT.samplesLine, { samples: group.samples.join(' ') }) : '—'] : [])
    ])))
  }
  return lines
}

/** Bytes as MB (one decimal), or KB below 1 MB so a small non-empty root never reads as 0. */
function sizeText(bytes: number): string {
  if (bytes >= 1_048_576) return fillText(MARKDOWN_TEXT.megabytes, { n: formatNumber(Math.round((bytes / 1_048_576) * 10) / 10) })
  return fillText(MARKDOWN_TEXT.kilobytes, { n: formatNumber(bytes === 0 ? 0 : Math.max(0.1, Math.round((bytes / 1024) * 10) / 10)) })
}

/**
 * Roots Swob does not scan that belong to an older or auxiliary layout get their own registered names
 * (SOURCE_LABELS 'kimi-legacy' / 'zcode-v2'), so the legacy Kimi directory is not read as Kimi Code
 * (acceptance P2-8).
 */
const UNSCANNED_ROOT_LABELS: Readonly<Record<string, string>> = { '~/.kimi/sessions': 'kimi-legacy', '~/.zcode/v2': 'zcode-v2' }

function inventorySourceLabel(row: CheckupReport['inventory'][number]): string {
  const own = !row.scannedBySwob ? UNSCANNED_ROOT_LABELS[row.root] : undefined
  return (own ? sourceLabel(own) : null) ?? sourceLabel(row.source)!
}

function inventoryLines(report: CheckupReport, options: RenderOptions): string[] {
  const shown = report.inventory.filter((row) => sourceLabel(row.source) !== null && (row.units.value === null || row.units.value > 0))
  if (report.inventory.length === 0) return []
  const rows = shown.map((row) => {
    const bytes = row.bytes.value === null ? measureCell(row.bytes) : `${sizeText(row.bytes.value)}${LABEL_TAGS[row.bytes.label]}`
    const [min, max] = row.timeRange
    const span = min && max
      ? fillText(MARKDOWN_TEXT.timeSpan, { date: [localTime(min, options.utcOffsetMinutes).date, localTime(max, options.utcOffsetMinutes).date] })
      : '—'
    return [inventorySourceLabel(row), row.root, measureCell(row.units), bytes, span, row.scannedBySwob ? MARKDOWN_TEXT.scannedYes : MARKDOWN_TEXT.scannedNo]
  })
  const lines = [`## ${MARKDOWN_TEXT.inventoryHeading}`, '']
  if (rows.length > 0) {
    lines.push(...table([MARKDOWN_TEXT.colSource, MARKDOWN_TEXT.colRoot, MARKDOWN_TEXT.colPhysical, MARKDOWN_TEXT.colBytes,
      MARKDOWN_TEXT.colTimeSpan, MARKDOWN_TEXT.colScanned], rows))
  }
  const rest = report.inventory.length - shown.length
  if (rest > 0) lines.push('', fillText(MARKDOWN_TEXT.inventoryEmptyRest, { n: formatNumber(rest) }))
  return lines
}

function sideEffectLines(report: CheckupReport): string[] {
  const effects = (report.sideEffects ?? []).filter((effect) => sourceLabel(effect.source) !== null && (effect.count.value === null || effect.count.value > 0))
  const lines = [`## ${MARKDOWN_TEXT.sideEffectsHeading}`, '']
  if (effects.length === 0) return [...lines, MARKDOWN_TEXT.sideEffectsNone]
  return [...lines, ...table([MARKDOWN_TEXT.colSource, MARKDOWN_TEXT.colEffect, MARKDOWN_TEXT.colCount],
    effects.map((effect) => [sourceLabel(effect.source)!, reasonText(effect.code), measureCell(effect.count)]))]
}

function oracleLines(report: CheckupReport): string[] {
  const oracles = report.oracles.filter((oracle) => ORACLE_LABELS[oracle.id])
  if (oracles.length === 0) return []
  return [`## ${MARKDOWN_TEXT.oraclesHeading}`, '', ...table([MARKDOWN_TEXT.colOracle, MARKDOWN_TEXT.colStatus], oracles.map((oracle) => [
    ORACLE_LABELS[oracle.id],
    !oracle.available
      ? fillText(MARKDOWN_TEXT.oracleUnavailable, { reason: reasonText(oracle.reason) })
      : oracle.version && /^\d{1,6}$/.test(oracle.version)
        ? fillText(MARKDOWN_TEXT.oracleAvailableVersion, { n: oracle.version })
        : MARKDOWN_TEXT.oracleAvailable
  ]))]
}

function libraryLines(report: CheckupReport, options: RenderOptions): string[] {
  const library = report.library
  if (!library) return []
  const lastWrite = library.lastWriteAt && Number.isFinite(Date.parse(library.lastWriteAt))
    ? localTime(library.lastWriteAt, options.utcOffsetMinutes).date
    : '—'
  return [`## ${MARKDOWN_TEXT.libraryHeading}`, '', ...table([MARKDOWN_TEXT.colItem, MARKDOWN_TEXT.colValue], [
    [MARKDOWN_TEXT.libraryPackages, measureCell(library.packages)],
    [MARKDOWN_TEXT.libraryLastWrite, lastWrite],
    [MARKDOWN_TEXT.libraryMissingLive, measureCell(library.missingLive)],
    [MARKDOWN_TEXT.libraryStaleLive, measureCell(library.staleLive)]
  ])]
}

function numberTable(heading: string, keyHeader: string, valueHeader: string, values: Record<string, number> | undefined): string[] {
  const entries = Object.entries(values ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
  if (entries.length === 0) return []
  return [`## ${heading}`, '', ...table([keyHeader, valueHeader], entries.map(([key, value]) => [key, formatNumber(value)]))]
}

function engineerLines(report: CheckupReport): string[] {
  const lines: string[] = []
  if (report.selfTestCases && report.selfTestCases.length > 0) {
    lines.push(`## ${MARKDOWN_TEXT.selfTestHeading}`, '', ...table([MARKDOWN_TEXT.colSelfTestCase, MARKDOWN_TEXT.colResult],
      report.selfTestCases.map((entry) => [entry.id, entry.passed ? VERDICT_LABELS.pass : VERDICT_LABELS.fail])), '')
  }
  const diagnostics = numberTable(MARKDOWN_TEXT.diagnosticsHeading, MARKDOWN_TEXT.colDiagnostic, MARKDOWN_TEXT.colValue, report.diagnostics)
  if (diagnostics.length > 0) lines.push(...diagnostics, '')
  lines.push(...numberTable(MARKDOWN_TEXT.timingsHeading, MARKDOWN_TEXT.colPhase, MARKDOWN_TEXT.colMilliseconds, report.timingsMs))
  return lines
}

/**
 * Render one report. Throws PrivacyViolationError when the result does not
 * pass scanMarkdownForPrivacy (fail closed: nothing may be written then).
 */
export function renderCheckupMarkdown(report: CheckupReport, options: RenderOptions = {}): string {
  const audience: Audience = options.audience ?? 'owner'
  const comparison = options.previous ? compareCheckupReports(options.previous, report) : null
  const blocks: string[][] = [
    headerLines(report, options),
    overallLines(report, comparison, options),
    sourcesLines(report),
    ...CHECK_ORDER.map((id) => findCheck(report, id)).filter((check): check is CheckResult => !!check).map((check) => checkSection(check, audience)),
    comparison ? compareSection(comparison, options, audience) : [],
    inventoryLines(report, options),
    sideEffectLines(report),
    oracleLines(report),
    libraryLines(report, options),
    audience === 'engineer' ? engineerLines(report) : []
  ]
  const markdown = `${blocks.filter((block) => block.length > 0).map((block) => block.join('\n').trimEnd()).join('\n\n')}\n`
  assertMarkdownPrivacyClean(markdown, { engineer: audience === 'engineer' })
  return markdown
}

export type { CheckupComparison }
