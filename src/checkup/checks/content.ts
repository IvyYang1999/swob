/**
 * ② Content completeness. Oracle: spec reread of every unit (split on `\n`
 * only). Swob column: `parseSessionFile` per Claude main file [R]; Claude
 * subagents and Codex expose no per-file read count, so their Swob column is
 * [U] and the loss is derived [D] from records a CR/U+2028/U+2029-splitting
 * reader cannot keep (design §4.2, §五).
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

/** Threshold verdict (design §4.2): pass = nothing lost; warn = meta only and < 0.01 %; else fail. */
export function contentThresholdVerdict(input: { parseable: number; lost: number; conversationLost: number }): Verdict {
  if (input.parseable === 0 && input.lost === 0) return 'pass'
  if (input.lost === 0) return 'pass'
  const rate = (input.parseable - input.lost) / Math.max(1, input.parseable)
  if (input.conversationLost > 0 || rate < 0.9999) return 'fail'
  return 'warn'
}

function toolFindings(ctx: CheckContext, source: string, groups: Tally[]): Finding[] {
  const findings: Finding[] = []
  const badLines = groups.reduce((sum, group) => sum + group.badLines, 0)
  const truncated = groups.reduce((sum, group) => sum + group.truncatedTails, 0)
  if (badLines > 0) {
    findings.push(makeFinding({
      code: 'content.tool-bad-line', verdict: 'warn', source, count: reported(badLines, 'lines'),
      samples: sampleIds(ctx.salt, groups.flatMap((group) => group.badLinePaths))
    }))
  }
  if (truncated > 0) {
    findings.push(makeFinding({
      code: 'content.truncated-tail', verdict: 'warn', source, count: reported(truncated, 'files'),
      samples: sampleIds(ctx.salt, groups.flatMap((group) => group.truncatedPaths))
    }))
  }
  return findings
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

  // Main files: Swob read count per file [R].
  if (ctx.readout.status !== 'ok') {
    const mainTally = tally(mains)
    const subTally = tally(subagents)
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
        excludedChangedFiles: reported(changedFiles, 'files')
      },
      oracleIds: ['census.claude-jsonl']
    }
  }
  const compared: ContentUnit[] = []
  const timedOut: string[] = []
  let swobRead = 0
  let mainLost = 0
  let mainUnexplained = 0
  const extraPaths: string[] = []
  const unexplainedPaths: string[] = []
  const lossPaths: string[] = []
  const mainKinds = emptyLossKinds()
  for (const unit of mains) {
    const parsed = ctx.readout.claudeParsed.get(unit.path)
    if (!parsed || parsed.partial) {
      timedOut.push(unit.path)
      continue
    }
    compared.push(unit)
    swobRead += parsed.records
    const lost = Math.max(0, unit.stats.parseable - parsed.records)
    if (parsed.records > unit.stats.parseable) extraPaths.push(unit.path)
    if (lost === 0) continue
    lossPaths.push(unit.path)
    mainLost += lost
    const allocation = allocateLoss(lost, unit.hazardKinds)
    addKinds(mainKinds, allocation.kinds)
    if (allocation.unexplained > 0) {
      mainUnexplained += allocation.unexplained
      unexplainedPaths.push(unit.path)
    }
  }
  const mainTally = tally(mains)
  const comparedTally = tally(compared)
  const subTally = tally(subagents)
  const subKinds = emptyLossKinds()
  for (const unit of subagents) addKinds(subKinds, unit.hazardKinds)
  const subLost = sumKinds(subKinds)
  const subLossPaths = subagents.filter((unit) => sumKinds(unit.hazardKinds) > 0).map((unit) => unit.path)

  const sourceFindings: Finding[] = [...toolFindings(ctx, 'claude-code', [mainTally, subTally])]
  const explainedMainLost = mainLost - mainUnexplained
  const lineSeparatorLost = explainedMainLost + subLost
  if (lineSeparatorLost > 0) {
    sourceFindings.push(makeFinding({
      code: 'content.line-separator-split', verdict: 'fail', source: 'claude-code',
      count: derived(lineSeparatorLost, 'records'),
      numbers: [lineSeparatorLost, mainKinds.user + subKinds.user],
      samples: sampleIds(ctx.salt, [...lossPaths, ...subLossPaths])
    }))
  }
  if (mainUnexplained > 0) {
    sourceFindings.push(makeFinding({ code: 'content.unexplained-loss', verdict: 'fail', source: 'claude-code', count: derived(mainUnexplained, 'records'), samples: sampleIds(ctx.salt, unexplainedPaths) }))
  }
  if (extraPaths.length > 0) {
    sourceFindings.push(makeFinding({ code: 'content.swob-extra-records', verdict: 'warn', source: 'claude-code', count: derived(extraPaths.length, 'files'), samples: sampleIds(ctx.salt, extraPaths) }))
  }
  if (timedOut.length > 0) {
    sourceFindings.push(makeFinding({ code: 'readout.parse-timeout', verdict: 'undetermined', source: 'claude-code', count: reported(timedOut.length, 'files'), samples: sampleIds(ctx.salt, timedOut) }))
  }
  if (changedFiles > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'claude-code', count: reported(changedFiles, 'files') }))
  }
  findings.push(...sourceFindings)

  const totalParseable = comparedTally.parseable + subTally.parseable
  const totalLost = mainLost + subLost
  const conversationLost = conversationLoss(mainKinds, mainUnexplained) + conversationLoss(subKinds, 0)
  const threshold = contentThresholdVerdict({ parseable: totalParseable, lost: totalLost, conversationLost })
  return {
    verdict: sourceVerdict(threshold, sourceFindings, 'claude-code'),
    swob: {
      mainRead: reported(swobRead, 'records'),
      mainLost: derived(mainLost, 'records'),
      ...lossMeasures('main', mainKinds),
      mainUnexplainedLost: derived(mainUnexplained, 'records'),
      mainParseTimeouts: reported(timedOut.length, 'files'),
      subagentRead: unavailable('records', 'content.swob-per-file-unavailable'),
      subagentLost: derived(subLost, 'records', 'content.line-separator-split'),
      ...lossMeasures('subagent', subKinds),
      mainReadRate: percentMeasure(comparedTally.parseable - mainLost, comparedTally.parseable)
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
      subagentLineSeparatorRecords: reported(subTally.lineSeparatorRecords, 'records'),
      subagentTruncatedTails: reported(subTally.truncatedTails, 'files'),
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
  if (ctx.readout.status !== 'ok') {
    return {
      verdict: 'undetermined',
      swob: { read: unavailable('records', ctx.readout.reason ?? 'readout.not-isolated') },
      oracle: {
        files: reported(codexTally.files, 'files'),
        parseable: reported(codexTally.parseable, 'records'),
        badLines: reported(codexTally.badLines, 'lines'),
        excludedChangedFiles: reported(changedFiles, 'files')
      },
      oracleIds: ['census.codex-jsonl']
    }
  }
  const kinds = emptyLossKinds()
  for (const unit of eligible) addKinds(kinds, unit.hazardKinds)
  const lost = sumKinds(kinds)
  const lossPaths = eligible.filter((unit) => sumKinds(unit.hazardKinds) > 0).map((unit) => unit.path)
  const byType: Record<string, number> = {}
  for (const unit of eligible) {
    for (const [type, count] of Object.entries(unit.hazardTypes)) byType[type] = (byType[type] || 0) + count
  }
  const typeMeasures: Record<string, Measure> = {}
  for (const type of Object.keys(byType).sort()) typeMeasures[`lostByType:${type}`] = derived(byType[type], 'records')
  const sourceFindings: Finding[] = [...toolFindings(ctx, 'codex', [codexTally])]
  if (lost > 0) {
    sourceFindings.push(makeFinding({
      code: 'content.line-separator-split', verdict: 'fail', source: 'codex', count: derived(lost, 'records'),
      numbers: [lost, kinds.user], samples: sampleIds(ctx.salt, lossPaths)
    }))
  }
  if (changedFiles > 0) {
    sourceFindings.push(makeFinding({ code: 'census.file-changed-during-run', verdict: 'undetermined', source: 'codex', count: reported(changedFiles, 'files') }))
  }
  findings.push(...sourceFindings)
  const threshold = contentThresholdVerdict({ parseable: codexTally.parseable, lost, conversationLost: conversationLoss(kinds, 0) })
  return {
    verdict: sourceVerdict(threshold, sourceFindings, 'codex'),
    swob: {
      read: unavailable('records', 'content.swob-per-file-unavailable'),
      lost: derived(lost, 'records', 'content.line-separator-split'),
      ...lossMeasures('', kinds),
      ...typeMeasures,
      readRate: percentMeasure(codexTally.parseable - lost, codexTally.parseable)
    },
    oracle: {
      files: reported(codexTally.files, 'files'),
      nonBlankLines: reported(codexTally.nonBlank, 'lines'),
      badLines: reported(codexTally.badLines, 'lines'),
      parseable: reported(codexTally.parseable, 'records'),
      lineSeparatorRecords: reported(codexTally.lineSeparatorRecords, 'records'),
      truncatedTails: reported(codexTally.truncatedTails, 'files'),
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
      pick('subagentLostUser') + pick('subagentLostAssistant') + pick('subagentLostToolResult') +
      pick('lostUser') + pick('lostAssistant') + pick('lostToolResult')
  }, 0)
  const result = assembleCheck({
    id: 'content',
    bySource,
    findings,
    headline: lost === 0 ? 'content.pass' : conversationLost > 0 ? 'content.loss' : 'content.meta-only',
    headlineNumbers: lost === 0 ? [] : conversationLost > 0 ? [lost, conversationLost] : [lost]
  })
  if (ctx.readout.status !== 'ok') result.reason = ctx.readout.reason ?? 'readout.not-isolated'
  return result
}
