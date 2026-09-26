/**
 * checkupDigest(report, { linkTarget }): the AI-diary one-liner (task C1b
 * deliverable 2, design §五 "AI 日记每日摘要"):
 *
 *   体检 · 全部 763 场会话（Codex 525 · ZCode 73 · OpenCode 63 · Claude Code 59 · Cursor 43） · 5 个来源
 *     · 丢 ≈120 条（不通过） · 压缩：Codex 原始 ≈968 处，Swob 认出 0 处（不通过）
 *     → [[Swob内核体检-…]]（≈ 为 [D]，其余为 [R]）
 *
 * Sources of each part: sessions and their split = the [R] sessions per source of readoutBySource
 * (the per-source overview's numbers) for a full-scope report, ① bySource[source].swob.sessions [R]
 * for older reports without it and for day/range scopes; a source listed by readout.source-empty is
 * always named (even when ① passes); ① gaps = ① swob.notIncluded [D]; ② = the counts of the
 * content.line-separator-split / content.unexplained-loss findings; ③ = oracle.perSessionUniqueSum [D]
 * and swob.compactCountSum [R], one part per source that did not pass (C1b-2, acceptance P2-3: a sum
 * hid that one source was fully right and another fully wrong), the graded sum only as a fallback.
 * Sources listed by readout.source-empty are named even when the overall verdict is undetermined
 * (acceptance P2-14). A --sources report (some source marked source.not-selected) leads with
 * 「体检（部分来源）」 and counts the selected sources only, also for reports written before C1c that
 * still carried counts of unselected sources (C1c; C1b-2 knownRisk).
 * ④⑤⑥ are undetermined in C1a and omitted. Numbers are [R] unless prefixed with 「≈」 ([D]); the
 * line ends with a note saying which. Scope all → 「全部」 (a --sources report: 「所选来源」, C1d),
 * day → 「今天」. An undetermined overall verdict gives 「无法判定（原因）」. Every part is registered
 * text and the line must pass scanMarkdownForPrivacy (else PrivacyViolationError).
 */
import type { CheckId, CheckResult, CheckupReport, Label, Measure } from './contract'
import { SOURCE_IDS } from './contract'
import { DIGEST_TEXT, SOURCE_LABELS, VERDICT_LABELS } from './templates'
import { assertMarkdownPrivacyClean } from './privacy'
import { notSelectedSources } from './compare'
import { REPORT_BASENAME_PATTERN, fillText, formatNumber, reasonText } from './render-markdown'

export interface DigestOptions {
  /** Report note name without extension (reportFileNames().base), linked as an Obsidian wikilink. */
  linkTarget?: string
}

const PROBLEM = new Set(['warn', 'fail'])
const GRADED = new Set(['pass', 'warn', 'fail'])
const LOSS_CODES = new Set(['content.line-separator-split', 'content.unexplained-loss'])

function findCheck(report: CheckupReport, id: CheckId): CheckResult | undefined {
  return report.checks.find((check) => check.id === id)
}

function gradedEntries(check: CheckResult | undefined): Array<[string, CheckResult['bySource'][string]]> {
  return Object.entries(check?.bySource ?? {}).filter(([, entry]) => GRADED.has(entry.verdict))
}

interface Sum { value: number; labels: Label[] }

function sum(measures: Array<Measure | undefined>): Sum | null {
  const present = measures.filter((measure): measure is Measure => !!measure && measure.value !== null)
  if (present.length === 0) return null
  return { value: present.reduce((total, measure) => total + (measure.value ?? 0), 0), labels: present.map((measure) => measure.label) }
}

export function checkupDigest(report: CheckupReport, options: DigestOptions = {}): string {
  if (options.linkTarget !== undefined && !REPORT_BASENAME_PATTERN.test(options.linkTarget)) throw new Error('digest link target must be a report note name')
  const skipped = notSelectedSources(report)
  const parts: string[] = [skipped.size > 0 ? DIGEST_TEXT.leadPartial : DIGEST_TEXT.lead]
  let approximate = false
  const number = (value: number, labels: Label[]): string => {
    const derived = labels.some((label) => label !== 'reported')
    if (derived) approximate = true
    return `${derived ? '≈' : ''}${formatNumber(value)}`
  }
  let hasNumbers = false
  const inclusionCheck = findCheck(report, 'inclusion')
  const empty = (inclusionCheck?.findings ?? []).filter((finding) => finding.code === 'readout.source-empty' && SOURCE_LABELS[finding.source])
  const emptyPart = empty.length > 0
    ? fillText(DIGEST_TEXT.sourceEmpty, {
        sources: [...new Set(empty.map((finding) => SOURCE_LABELS[finding.source]))].join('、'),
        verdict: VERDICT_LABELS[empty[0].verdict]
      })
    : null

  if (report.verdict === 'undetermined') {
    parts.push(fillText(DIGEST_TEXT.undetermined, { reason: reasonText(report.verdictReason ?? 'checkup.no-verdict-checks') }))
    if (emptyPart) parts.push(emptyPart)
  } else {
    hasNumbers = true
    const inclusion = inclusionCheck
    const sessionsOf = report.scope.kind === 'all' && report.readoutBySource
      ? (source: string): Measure | undefined => report.readoutBySource?.[source]?.sessions
      : (source: string): Measure | undefined => inclusion?.bySource[source]?.swob.sessions
    const counts = SOURCE_IDS
      .filter((source) => !skipped.has(source))
      .map((source) => ({ source, measure: sessionsOf(source) }))
      .filter((entry): entry is { source: typeof entry.source; measure: Measure } =>
        !!entry.measure && entry.measure.value !== null && entry.measure.value > 0 && entry.measure.label === 'reported')
      .sort((left, right) => (right.measure.value ?? 0) - (left.measure.value ?? 0))
    const total = counts.reduce((value, entry) => value + (entry.measure.value ?? 0), 0)
    const kind = report.scope.kind
    // C1d (C1c acceptance P2-2): the counts of a --sources report cover its selected sources only, so they
    // are never called 「全部」.
    const partial = skipped.size > 0
    const sessionsTemplate = counts.length > 0
      ? kind === 'day' ? DIGEST_TEXT.sessionsDay : kind === 'range' ? DIGEST_TEXT.sessionsRange : partial ? DIGEST_TEXT.sessionsPartial : DIGEST_TEXT.sessionsAll
      : kind === 'day' ? DIGEST_TEXT.sessionsDayBare : kind === 'range' ? DIGEST_TEXT.sessionsRangeBare : partial ? DIGEST_TEXT.sessionsPartialBare : DIGEST_TEXT.sessionsAllBare
    parts.push(fillText(sessionsTemplate, {
      n: formatNumber(total),
      sourceCounts: counts.map((entry) => `${SOURCE_LABELS[entry.source]} ${formatNumber(entry.measure.value ?? 0)}`).join(' · ')
    }))
    parts.push(fillText(DIGEST_TEXT.sources, { n: formatNumber(counts.length) }))
    if (emptyPart) parts.push(emptyPart)

    if (report.verdict === 'pass') {
      const graded = report.checks.filter((check) => GRADED.has(check.verdict)).length
      parts.push(graded === report.checks.length ? DIGEST_TEXT.allPass : fillText(DIGEST_TEXT.checkedPass, { n: formatNumber(graded) }))
    } else {
      if (inclusion && PROBLEM.has(inclusion.verdict)) {
        const gaps = sum(gradedEntries(inclusion).map(([, entry]) => entry.swob.notIncluded))
        if (gaps && gaps.value > 0) {
          parts.push(fillText(DIGEST_TEXT.inclusionGaps, { n: number(gaps.value, gaps.labels), verdict: VERDICT_LABELS[inclusion.verdict] }))
        }
      }
      const content = findCheck(report, 'content')
      if (content?.verdict === 'pass') {
        parts.push(DIGEST_TEXT.contentComplete)
      } else if (content && PROBLEM.has(content.verdict)) {
        const lost = sum(content.findings.filter((finding) => LOSS_CODES.has(finding.code)).map((finding) => finding.count))
        if (lost && lost.value > 0) {
          parts.push(fillText(DIGEST_TEXT.contentLost, { n: number(lost.value, lost.labels), verdict: VERDICT_LABELS[content.verdict] }))
        }
      }
      const compaction = findCheck(report, 'compaction')
      if (compaction && PROBLEM.has(compaction.verdict)) {
        const entries = gradedEntries(compaction)
        const failing = entries
          .filter(([source, entry]) => PROBLEM.has(entry.verdict) && SOURCE_LABELS[source])
          .map(([source, entry]) => ({ source, verdict: entry.verdict, oracle: sum([entry.oracle.perSessionUniqueSum]), swob: sum([entry.swob.compactCountSum]) }))
          .filter((part) => part.oracle && part.swob)
        if (failing.length > 0) {
          for (const part of failing) {
            parts.push(fillText(DIGEST_TEXT.compactionSource, {
              source: SOURCE_LABELS[part.source],
              n: [number(part.oracle!.value, part.oracle!.labels), number(part.swob!.value, part.swob!.labels)],
              verdict: VERDICT_LABELS[part.verdict]
            }))
          }
        } else {
          const oracle = sum(entries.map(([, entry]) => entry.oracle.perSessionUniqueSum))
          const swob = sum(entries.map(([, entry]) => entry.swob.compactCountSum))
          if (oracle && swob) {
            parts.push(fillText(DIGEST_TEXT.compaction, {
              n: [number(oracle.value, oracle.labels), number(swob.value, swob.labels)],
              verdict: VERDICT_LABELS[compaction.verdict]
            }))
          }
        }
      }
    }
  }

  let line = parts.join(' · ')
  if (options.linkTarget) {
    const tail = !hasNumbers ? DIGEST_TEXT.link : approximate ? DIGEST_TEXT.linkNoteDerived : DIGEST_TEXT.linkNoteReported
    line += ` → ${fillText(tail, { link: options.linkTarget })}`
  } else if (hasNumbers) {
    line += ` · ${approximate ? DIGEST_TEXT.noteDerived : DIGEST_TEXT.noteReported}`
  }
  assertMarkdownPrivacyClean(line)
  return line
}
