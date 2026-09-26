/**
 * checkupDigest(report, { linkTarget }): the AI-diary one-liner (task C1b
 * deliverable 2, design §五 "AI 日记每日摘要"):
 *
 *   体检 · 全部 584 场会话（Codex 525 · Claude Code 59） · 2 个来源 · 丢 ≈120 条（不通过）
 *     · 压缩：原始 ≈1,036 处，Swob 认出 68 处（不通过） → [[Swob内核体检-…]]（≈ 为 [D]，其余为 [R]）
 *
 * Sources of each part: sessions and their split = ① bySource[source].swob.sessions [R]; ① gaps =
 * ① swob.notIncluded [D]; ② = the counts of the content.line-separator-split / content.unexplained-loss
 * findings; ③ = oracle.perSessionUniqueSum [D] and swob.compactCountSum [R] of the graded sources.
 * ④⑤⑥ are undetermined in C1a and omitted. Numbers are [R] unless prefixed with 「≈」 ([D]); the
 * line ends with a note saying which. Scope all → 「全部」, day → 「今天」. An undetermined overall
 * verdict gives 「无法判定（原因）」. Every part is registered text and the line must pass
 * scanMarkdownForPrivacy (else PrivacyViolationError).
 */
import type { CheckId, CheckResult, CheckupReport, Label, Measure } from './contract'
import { SOURCE_IDS } from './contract'
import { DIGEST_TEXT, SOURCE_LABELS, VERDICT_LABELS } from './templates'
import { assertMarkdownPrivacyClean } from './privacy'
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
  const parts: string[] = [DIGEST_TEXT.lead]
  let approximate = false
  const number = (value: number, labels: Label[]): string => {
    const derived = labels.some((label) => label !== 'reported')
    if (derived) approximate = true
    return `${derived ? '≈' : ''}${formatNumber(value)}`
  }
  let hasNumbers = false

  if (report.verdict === 'undetermined') {
    parts.push(fillText(DIGEST_TEXT.undetermined, { reason: reasonText(report.verdictReason ?? 'checkup.no-verdict-checks') }))
  } else {
    hasNumbers = true
    const inclusion = findCheck(report, 'inclusion')
    const counts = SOURCE_IDS
      .map((source) => ({ source, measure: inclusion?.bySource[source]?.swob.sessions }))
      .filter((entry): entry is { source: typeof entry.source; measure: Measure } =>
        !!entry.measure && entry.measure.value !== null && entry.measure.value > 0 && entry.measure.label === 'reported')
      .sort((left, right) => (right.measure.value ?? 0) - (left.measure.value ?? 0))
    const total = counts.reduce((value, entry) => value + (entry.measure.value ?? 0), 0)
    const kind = report.scope.kind
    const sessionsTemplate = counts.length > 0
      ? kind === 'day' ? DIGEST_TEXT.sessionsDay : kind === 'range' ? DIGEST_TEXT.sessionsRange : DIGEST_TEXT.sessionsAll
      : kind === 'day' ? DIGEST_TEXT.sessionsDayBare : kind === 'range' ? DIGEST_TEXT.sessionsRangeBare : DIGEST_TEXT.sessionsAllBare
    parts.push(fillText(sessionsTemplate, {
      n: formatNumber(total),
      sourceCounts: counts.map((entry) => `${SOURCE_LABELS[entry.source]} ${formatNumber(entry.measure.value ?? 0)}`).join(' · ')
    }))
    parts.push(fillText(DIGEST_TEXT.sources, { n: formatNumber(counts.length) }))

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
