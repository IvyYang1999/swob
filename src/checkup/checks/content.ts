/**
 * ② Content completeness. Oracle: spec reread of every unit (split on `\n`
 * only). Swob column: the kernel's own per-file read count [R] — parseSessionFile
 * (WithStats) per Claude main and subagent file (C1b deliverable 0) and
 * parseCodexFileWithStats per Codex rollout the kernel reads (C1c deliverable ①).
 * Per file, lost = parseable − read [D]; the file's split hazards (records a
 * CR/U+2028/U+2029-splitting reader cannot keep, design §4.2, §五) explain it,
 * most severe kind first, and the rest is unexplained. A file without a read
 * count (timed out, read error, not read) takes no part in the comparison and is
 * listed: nothing is inferred for it any more (C1c, dispatcher decision D6 — since
 * F1a the kernel reader keeps separator records, so "hazard = lost" no longer holds).
 */
import type { Finding, Measure, Verdict } from '../contract'
import { LOSS_KINDS, emptyLossKinds, type LossKind } from '../census/claude-census'
import type { JsonlFileStats } from '../census/jsonl-census'
import {
  assembleCheck,
  hasClaudeData,
  hasCodexData,
  derived,
  makeFinding,
  percentMeasure,
  remainingSources,
  reported,
  sampleIds,
  sourceVerdict,
  unavailable,
  type CheckContext,
  type SourceEntry
} from './common'

interface ContentUnit {
  path: string
  stats: JsonlFileStats
  hazardKinds: Record<LossKind, number>
  lineSeparatorKinds: Record<LossKind, number>
  unreadable: boolean
}

interface Tally {
  files: number
  nonBlank: number
  badLines: number
  parseable: number
  lineSeparatorRecords: number
  hazardRecords: number
  truncatedTails: number
  badLinePaths: string[]
  truncatedPaths: string[]
}

function tally(units: readonly ContentUnit[]): Tally {
  const result: Tally = { files: 0, nonBlank: 0, badLines: 0, parseable: 0, lineSeparatorRecords: 0, hazardRecords: 0, truncatedTails: 0, badLinePaths: [], truncatedPaths: [] }
  for (const unit of units) {
    result.files++
    result.nonBlank += unit.stats.nonBlank
    result.badLines += unit.stats.badLines
    result.parseable += unit.stats.parseable
    result.lineSeparatorRecords += unit.stats.lineSeparatorRecords
    result.hazardRecords += sumKinds(unit.hazardKinds)
    if (unit.stats.badLines > 0) result.badLinePaths.push(unit.path)
    if (unit.stats.truncatedTail) {
      result.truncatedTails++
      result.truncatedPaths.push(unit.path)
    }
  }
  return result
}

function sumKinds(kinds: Record<LossKind, number>): number {
  return LOSS_KINDS.reduce((sum, kind) => sum + kinds[kind], 0)
}

function addKinds(target: Record<LossKind, number>, source: Record<LossKind, number>): void {
  for (const kind of LOSS_KINDS) target[kind] += source[kind]
}

/** Allocate `lost` records to kinds, most severe first, bounded by the hazard kinds of the file. */
function allocateLoss(lost: number, hazards: Record<LossKind, number>): { kinds: Record<LossKind, number>; unexplained: number } {
  const kinds = emptyLossKinds()
  let remaining = lost
  for (const kind of ['user', 'assistant', 'tool_result', 'meta'] as const) {
    const take = Math.min(remaining, hazards[kind])
    kinds[kind] += take
    remaining -= take
  }
  return { kinds, unexplained: remaining }
}

function conversationLoss(kinds: Record<LossKind, number>, unexplained: number): number {
  return kinds.user + kinds.assistant + kinds.tool_result + unexplained
}

interface PerFileComparison {
  compared: ContentUnit[]
  read: number
  lost: number
  unexplained: number
  kinds: Record<LossKind, number>
  /** Files with any loss (explained or not). */
  lossPaths: string[]
  unexplainedPaths: string[]
  /** Files the kernel read more records from than the census found (listed, never a loss). */
  extraPaths: string[]
}

/**
 * Compare files that have a kernel read count, one by one: lost = parseable − read (never below 0),
 * allocated to the file's hazard kinds; what the hazards cannot explain is unexplained.
 */
function comparePerFile(measured: ReadonlyArray<{ unit: ContentUnit; read: number }>): PerFileComparison {
  const result: PerFileComparison = { compared: [], read: 0, lost: 0, unexplained: 0, kinds: emptyLossKinds(), lossPaths: [], unexplainedPaths: [], extraPaths: [] }
  for (const { unit, read } of measured) {
    result.compared.push(unit)
    result.read += read
    const lost = Math.max(0, unit.stats.parseable - read)
    if (read > unit.stats.parseable) result.extraPaths.push(unit.path)
    if (lost === 0) continue
    result.lossPaths.push(unit.path)
    result.lost += lost
    const allocation = allocateLoss(lost, unit.hazardKinds)
    addKinds(result.kinds, allocation.kinds)
    if (allocation.unexplained > 0) {
      result.unexplained += allocation.unexplained
      result.unexplainedPaths.push(unit.path)
    }
  }
  return result
}

/** Reason of a Swob-side measure when no file of the source has a kernel read count (nothing compared). */
const PER_FILE_UNAVAILABLE = 'content.swob-per-file-unavailable' as const

/** Threshold verdict (design §4.2): pass = nothing lost; warn = meta only and < 0.01 %; else fail. */
export function contentThresholdVerdict(input: { parseable: number; lost: number; conversationLost: number }): Verdict {
  if (input.parseable === 0 && input.lost === 0) return 'pass'
  if (input.lost === 0) return 'pass'
  const rate = (input.parseable - input.lost) / Math.max(1, input.parseable)
  if (input.conversationLost > 0 || rate < 0.9999) return 'fail'
  return 'warn'
}

/**
 * Lines the tool itself wrote broken (bad lines, truncated tails) are not Swob
 * losses: they are listed on their own (findings + `toolBadLines` /
 * `toolTruncatedTails`) and never grade check ② (dispatcher decision after the
 * C1a review). Their findings carry `not-applicable`, which takes no part in
 * any verdict, and they are also filtered out explicitly below.
 */
export const TOOL_SIDE_CODES: ReadonlySet<string> = new Set(['content.tool-bad-line', 'content.truncated-tail'])

function toolFindings(ctx: CheckContext, source: string, groups: Tally[]): Finding[] {
  const findings: Finding[] = []
  const badLines = groups.reduce((sum, group) => sum + group.badLines, 0)
  const truncated = groups.reduce((sum, group) => sum + group.truncatedTails, 0)
  if (badLines > 0) {
    findings.push(makeFinding({
      code: 'content.tool-bad-line', verdict: 'not-applicable', source, count: reported(badLines, 'lines'),
      samples: sampleIds(ctx.salt, groups.flatMap((group) => group.badLinePaths))
    }))
  }
  if (truncated > 0) {
    findings.push(makeFinding({
      code: 'content.truncated-tail', verdict: 'not-applicable', source, count: reported(truncated, 'files'),
      samples: sampleIds(ctx.salt, groups.flatMap((group) => group.truncatedPaths))
    }))
  }
  return findings
}

function toolMeasures(groups: Tally[]): Record<string, Measure> {
  return {
    toolBadLines: reported(groups.reduce((sum, group) => sum + group.badLines, 0), 'lines'),
    toolTruncatedTails: reported(groups.reduce((sum, group) => sum + group.truncatedTails, 0), 'files')
  }
}

/** Swob-side findings only: tool-side findings never change a source verdict. */
function swobSide(findings: readonly Finding[]): Finding[] {
  return findings.filter((finding) => !TOOL_SIDE_CODES.has(finding.code))
}

function lossKey(prefix: string, suffix: string): string {
  return prefix ? `${prefix}Lost${suffix}` : `lost${suffix}`
}

function lossMeasures(prefix: string, kinds: Record<LossKind, number>): Record<string, Measure> {
  return {
    [lossKey(prefix, 'User')]: derived(kinds.user, 'records'),
    [lossKey(prefix, 'Assistant')]: derived(kinds.assistant, 'records'),
    [lossKey(prefix, 'ToolResult')]: derived(kinds.tool_result, 'records'),
    [lossKey(prefix, 'Meta')]: derived(kinds.meta, 'records')
  }
}

function claudeEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.claude!
  const eligible = (unit: ContentUnit): boolean => !unit.unreadable && !ctx.changed.has(unit.path)
  const mains = census.units.filter((unit) => unit.kind === 'claude-main' && eligible(unit))
  const subagents = census.units.filter((unit) => unit.kind === 'claude-subagent' && eligible(unit))
  const changedFiles = census.units.filter((unit) => !eligible(unit)).length
  const mainTally = tally(mains)
  const subTally = tally(subagents)
  const toolSide = toolFindings(ctx, 'claude-code', [mainTally, subTally])
  const toolOracle = toolMeasures([mainTally, subTally])

  // Main files: Swob read count per file [R].
  if (ctx.readout.status !== 'ok') {
    findings.push(...toolSide)
    return {
      verdict: 'undetermined',
      swob: { mainRead: unavailable('records', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: {
        mainFiles: reported(mainTally.files, 'files'),
        mainParseable: reported(mainTally.parseable, 'records'),
        mainBadLines: reported(mainTally.badLines, 'lines'),
        subagentFiles: reported(subTally.files, 'files'),
        subagentParseable: reported(subTally.parseable, 'records'),
        subagentBadLines: reported(subTally.badLines, 'lines'),
        ...toolOracle,
        excludedChangedFiles: reported(changedFiles, 'files')
      },
      oracleIds: ['census.claude-jsonl']
    }
  }
  // Main files: the kernel's read count per file [R]; a timed-out or cut-short read is left out.
  const mainMeasured: Array<{ unit: ContentUnit; read: number }> = []
  const timedOut: string[] = []
  for (const unit of mains) {
    const parsed = ctx.readout.claudeParsed.get(unit.path)
    if (!parsed || parsed.partial) timedOut.push(unit.path)
    else mainMeasured.push({ unit, read: parsed.records })
  }
  const main = comparePerFile(mainMeasured)
  const comparedTally = tally(main.compared)
  // Subagent files: measured per file like a main file. A file without a parse result is left out
  // and listed (content.swob-read-error); nothing is inferred for it (C1c, D6).
  const subMeasured: Array<{ unit: ContentUnit; read: number }> = []
  const subTimedOut: string[] = []
  const subUnavailable: string[] = []
  for (const unit of subagents) {
    const parsed = ctx.readout.claudeParsed.get(unit.path)
    if (!parsed) subUnavailable.push(unit.path)
    else if (parsed.partial) subTimedOut.push(unit.path)
    else subMeasured.push({ unit, read: parsed.records })
  }
  const sub = comparePerFile(subMeasured)
  const subMeasuredTally = tally(sub.compared)
  const timedOutAll = [...timedOut, ...subTimedOut]
  const extraPaths = [...main.extraPaths, ...sub.extraPaths]

  const sourceFindings: Finding[] = [...toolSide]
  const lineSeparatorLost = main.lost - main.unexplained + sub.lost - sub.unexplained
  if (lineSeparatorLost > 0) {
    sourceFindings.push(makeFinding({
      code: 'content.line-separator-split', verdict: 'fail', source: 'claude-code',
      count: derived(lineSeparatorLost, 'records'),
      numbers: [lineSeparatorLost, main.kinds.user + sub.kinds.user],
      samples: sampleIds(ctx.salt, [...main.lossPaths, ...sub.lossPaths])
    }))
  }
  if (main.unexplained + sub.unexplained > 0) {
    sourceFindings.push(makeFinding({ code: 'content.unexplained-loss', verdict: 'fail', source: 'claude-code', count: derived(main.unexplained + sub.unexplained, 'records'), samples: sampleIds(ctx.salt, [...main.unexplainedPaths, ...sub.unexplainedPaths]) }))
  }
  if (extraPaths.length > 0) {
    sourceFindings.push(makeFinding({ code: 'content.swob-extra-records', verdict: 'warn', source: 'claude-code', count: derived(extraPaths.length, 'files'), samples: sampleIds(ctx.salt, extraPaths) }))
  }
  if (timedOutAll.length > 0) {
    sourceFindings.push(makeFinding({ code: 'readout.parse-timeout', verdict: 'undetermined', source: 'claude-code', count: reported(timedOutAll.length, 'files'), samples: sampleIds(ctx.salt, timedOutAll) }))
  }
  if (subUnavailable.length > 0) {
    sourceFindings.push(makeFinding({ code: 'content.swob-read-error', verdict: 'undetermined', source: 'claude-code', count: reported(subUnavailable.length, 'files'), samples: sampleIds(ctx.salt, subUnavailable) }))
  }
  if (changedFiles > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'claude-code', count: reported(changedFiles, 'files') }))
  }
  findings.push(...sourceFindings)

  const totalParseable = comparedTally.parseable + subMeasuredTally.parseable
  const totalLost = main.lost + sub.lost
  const conversationLost = conversationLoss(main.kinds, main.unexplained) + conversationLoss(sub.kinds, sub.unexplained)
  const threshold = contentThresholdVerdict({ parseable: totalParseable, lost: totalLost, conversationLost })
  const noReadCount = main.compared.length + sub.compared.length === 0 && timedOutAll.length + subUnavailable.length > 0
  const subMeasuredAny = sub.compared.length > 0
  return {
    verdict: noReadCount ? 'undetermined' : sourceVerdict(threshold, swobSide(sourceFindings), 'claude-code'),
    swob: {
      mainRead: reported(main.read, 'records'),
      mainLost: derived(main.lost, 'records'),
      ...lossMeasures('main', main.kinds),
      mainUnexplainedLost: derived(main.unexplained, 'records'),
      mainParseTimeouts: reported(timedOut.length, 'files'),
      subagentRead: subMeasuredAny ? reported(sub.read, 'records') : unavailable('records', PER_FILE_UNAVAILABLE),
      subagentLost: subMeasuredAny || subUnavailable.length === 0 ? derived(sub.lost, 'records') : unavailable('records', PER_FILE_UNAVAILABLE),
      ...lossMeasures('subagent', sub.kinds),
      subagentUnexplainedLost: derived(sub.unexplained, 'records'),
      subagentParseTimeouts: reported(subTimedOut.length, 'files'),
      mainReadRate: percentMeasure(comparedTally.parseable - main.lost, comparedTally.parseable),
      subagentReadRate: subMeasuredAny
        ? percentMeasure(subMeasuredTally.parseable - sub.lost, subMeasuredTally.parseable)
        : unavailable('percent', PER_FILE_UNAVAILABLE)
    },
    oracle: {
      mainFiles: reported(mainTally.files, 'files'),
      mainNonBlankLines: reported(mainTally.nonBlank, 'lines'),
      mainBadLines: reported(mainTally.badLines, 'lines'),
      mainParseable: reported(mainTally.parseable, 'records'),
      mainParseableCompared: reported(comparedTally.parseable, 'records'),
      mainLineSeparatorRecords: reported(mainTally.lineSeparatorRecords, 'records'),
      mainTruncatedTails: reported(mainTally.truncatedTails, 'files'),
      subagentFiles: reported(subTally.files, 'files'),
      subagentNonBlankLines: reported(subTally.nonBlank, 'lines'),
      subagentBadLines: reported(subTally.badLines, 'lines'),
      subagentParseable: reported(subTally.parseable, 'records'),
      subagentParseableCompared: reported(subMeasuredTally.parseable, 'records'),
      subagentLineSeparatorRecords: reported(subTally.lineSeparatorRecords, 'records'),
      subagentTruncatedTails: reported(subTally.truncatedTails, 'files'),
      ...toolOracle,
      excludedChangedFiles: reported(changedFiles, 'files')
    },
    oracleIds: ['census.claude-jsonl']
  }
}

function codexEntry(ctx: CheckContext, findings: Finding[]): SourceEntry {
  const census = ctx.codex!
  const eligible = census.units.filter((unit) => !unit.unreadable && !ctx.changed.has(unit.path))
  const changedFiles = census.units.length - eligible.length
  const codexTally = tally(eligible)
  const toolSide = toolFindings(ctx, 'codex', [codexTally])
  const toolOracle = toolMeasures([codexTally])
  if (ctx.readout.status !== 'ok') {
    findings.push(...toolSide)
    return {
      verdict: 'undetermined',
      swob: { read: unavailable('records', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: {
        files: reported(codexTally.files, 'files'),
        parseable: reported(codexTally.parseable, 'records'),
        badLines: reported(codexTally.badLines, 'lines'),
        ...toolOracle,
        excludedChangedFiles: reported(changedFiles, 'files')
      },
      oracleIds: ['census.codex-jsonl']
    }
  }
  // C1c: the kernel's read count per rollout it reads (parseCodexFileWithStats) [R], compared per file
  // like a Claude main file. A non-rollout .jsonl is never read by the kernel (① counts it as
  // codex.non-rollout-file) and takes no part here; a rollout without a read count is left out and
  // listed (content.swob-read-error), nothing is inferred for it (D6).
  const measured: Array<{ unit: ContentUnit; read: number }> = []
  const unavailablePaths: string[] = []
  for (const unit of eligible) {
    if (!unit.isRollout) continue
    const parsed = ctx.readout.codexParsed?.get(unit.path)
    if (parsed && parsed.records !== null) measured.push({ unit, read: parsed.records })
    else unavailablePaths.push(unit.path)
  }
  const perFile = comparePerFile(measured)
  const comparedTally = tally(perFile.compared)
  const sourceFindings: Finding[] = [...toolSide]
  const lineSeparatorLost = perFile.lost - perFile.unexplained
  if (lineSeparatorLost > 0) {
    sourceFindings.push(makeFinding({
      code: 'content.line-separator-split', verdict: 'fail', source: 'codex', count: derived(lineSeparatorLost, 'records'),
      numbers: [lineSeparatorLost, perFile.kinds.user], samples: sampleIds(ctx.salt, perFile.lossPaths)
    }))
  }
  if (perFile.unexplained > 0) {
    sourceFindings.push(makeFinding({ code: 'content.unexplained-loss', verdict: 'fail', source: 'codex', count: derived(perFile.unexplained, 'records'), samples: sampleIds(ctx.salt, perFile.unexplainedPaths) }))
  }
  if (perFile.extraPaths.length > 0) {
    sourceFindings.push(makeFinding({ code: 'content.swob-extra-records', verdict: 'warn', source: 'codex', count: derived(perFile.extraPaths.length, 'files'), samples: sampleIds(ctx.salt, perFile.extraPaths) }))
  }
  if (unavailablePaths.length > 0) {
    sourceFindings.push(makeFinding({ code: 'content.swob-read-error', verdict: 'undetermined', source: 'codex', count: reported(unavailablePaths.length, 'files'), samples: sampleIds(ctx.salt, unavailablePaths) }))
  }
  if (changedFiles > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'codex', count: reported(changedFiles, 'files') }))
  }
  findings.push(...sourceFindings)
  const threshold = contentThresholdVerdict({ parseable: comparedTally.parseable, lost: perFile.lost, conversationLost: conversationLoss(perFile.kinds, perFile.unexplained) })
  const noReadCount = measured.length === 0 && unavailablePaths.length > 0
  return {
    verdict: noReadCount ? 'undetermined' : sourceVerdict(threshold, swobSide(sourceFindings), 'codex'),
    swob: {
      read: noReadCount ? unavailable('records', PER_FILE_UNAVAILABLE) : reported(perFile.read, 'records'),
      lost: noReadCount ? unavailable('records', PER_FILE_UNAVAILABLE) : derived(perFile.lost, 'records'),
      ...lossMeasures('', perFile.kinds),
      unexplainedLost: derived(perFile.unexplained, 'records'),
      readUnavailableFiles: reported(unavailablePaths.length, 'files'),
      readRate: noReadCount
        ? unavailable('percent', PER_FILE_UNAVAILABLE)
        : percentMeasure(comparedTally.parseable - perFile.lost, comparedTally.parseable)
    },
    oracle: {
      files: reported(codexTally.files, 'files'),
      nonBlankLines: reported(codexTally.nonBlank, 'lines'),
      badLines: reported(codexTally.badLines, 'lines'),
      parseable: reported(codexTally.parseable, 'records'),
      parseableCompared: reported(comparedTally.parseable, 'records'),
      lineSeparatorRecords: reported(codexTally.lineSeparatorRecords, 'records'),
      truncatedTails: reported(codexTally.truncatedTails, 'files'),
      ...toolOracle,
      excludedChangedFiles: reported(changedFiles, 'files')
    },
    oracleIds: ['census.codex-jsonl']
  }
}

export function contentCheck(ctx: CheckContext): ReturnType<typeof assembleCheck> {
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
  Object.assign(bySource, remainingSources('content', ctx, evaluated))
  const lost = findings.filter((finding) => finding.code === 'content.line-separator-split' || finding.code === 'content.unexplained-loss')
    .reduce((sum, finding) => sum + (finding.count.value ?? 0), 0)
  const conversationLost = Object.values(bySource).reduce((sum, entry) => {
    const pick = (key: string): number => entry.swob[key]?.value ?? 0
    return sum + pick('mainLostUser') + pick('mainLostAssistant') + pick('mainLostToolResult') + pick('mainUnexplainedLost') +
      pick('subagentLostUser') + pick('subagentLostAssistant') + pick('subagentLostToolResult') + pick('subagentUnexplainedLost') +
      pick('lostUser') + pick('lostAssistant') + pick('lostToolResult') + pick('unexplainedLost')
  }, 0)
  // Tool-written broken lines (bad lines + truncated tails) are named in the pass headline, never graded.
  const toolLines = Object.values(bySource).reduce((sum, entry) =>
    sum + (entry.oracle.toolBadLines?.value ?? 0) + (entry.oracle.toolTruncatedTails?.value ?? 0), 0)
  const passHeadline = toolLines > 0 ? 'content.pass-tool-lines' : 'content.pass'
  const result = assembleCheck({
    id: 'content',
    bySource,
    findings,
    headline: lost === 0 ? passHeadline : conversationLost > 0 ? 'content.loss' : 'content.meta-only',
    headlineNumbers: lost === 0 ? (toolLines > 0 ? [toolLines] : []) : conversationLost > 0 ? [lost, conversationLost] : [lost]
  })
  if (ctx.readout.status !== 'ok') result.reason = ctx.readout.reason ?? 'readout.not-isolated'
  return result
}
