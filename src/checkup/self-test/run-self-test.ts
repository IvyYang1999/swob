/**
 * Self-test: the referee (census + check logic) must detect six synthetic
 * fault classes before the checkup may report any verdict (design §3.1 rule 4,
 * §6.5 classes 1–6). The oracle side reads real sample files; the Swob side is
 * always an injected, fixed readout (never the kernel), so kernel fixes
 * (F1a/F1b) cannot change the self-test outcome. See CASE_SWOB_SIDE.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SELF_TEST_CASES, SELF_TEST_TOTAL, type SelfTestCaseId } from '../contract'
import { censusClaude } from '../census/claude-census'
import { censusCodex, countForkUsageCopies } from '../census/codex-census'
import { compactionCheck } from '../checks/compaction'
import { contentCheck } from '../checks/content'
import type { CheckContext } from '../checks/common'
import type { ClaudeParseResult, ReadoutSession, SwobReadout } from '../readout'
import {
  LS,
  claude,
  claudeProjectDir,
  codex,
  codexRolloutPath,
  jsonl,
  syntheticTime,
  syntheticUuid,
  writeSample
} from './samples'

/**
 * Which Swob side each class uses (recorded in the package decisions):
 * - `injected-loss`: the readout loses exactly the split-hazard records;
 * - `injected-complete`: the readout keeps every parseable record (both the
 *   current and a fixed parser skip genuinely bad lines / truncated tails);
 * - `injected-zero-compaction`: Swob recognises no legacy marker;
 * - `injected-per-row`: Swob counts every copied marker row per session;
 * - `census-only`: census-layer assertion (the reason code belongs to ⑤).
 */
export const CASE_SWOB_SIDE: Readonly<Record<SelfTestCaseId, string>> = {
  'line-separator-split': 'injected-loss',
  'tool-bad-line': 'injected-complete',
  'truncated-tail': 'injected-complete',
  'codex-legacy-compacted': 'injected-zero-compaction',
  'fork-inherited-compaction': 'injected-per-row',
  'fork-usage-copy': 'census-only'
}

export interface SelfTestResult {
  passed: number
  total: number
  cases: Array<{ id: SelfTestCaseId; passed: boolean }>
}

export interface SelfTestOptions {
  /** Empty directory owned by the caller (inside stateDir); samples are written below it. */
  workDir: string
  salt: string
}

const CWD = '/synthetic/checkup/project'
const CLAUDE_PROJECT = path.join('.claude', 'projects', claudeProjectDir(CWD))

function standInReadout(sessions: ReadoutSession[], claudeParsed = new Map<string, ClaudeParseResult>()): SwobReadout {
  return {
    status: 'ok',
    sessions,
    claudeParsed,
    discovered: { claudeMain: new Set(), codex: new Set() },
    attributedChildIds: new Set(),
    consoleLines: 0,
    timingsMs: {}
  }
}

function baseContext(salt: string, readout: SwobReadout, census: Partial<Pick<CheckContext, 'claude' | 'codex'>>): CheckContext {
  return {
    salt,
    selected: new Set(['claude-code', 'codex']),
    claude: census.claude ?? null,
    codex: census.codex ?? null,
    codexDb: null,
    unscanned: null,
    presence: [],
    readout,
    changed: new Set()
  }
}

function session(source: string, sessionId: string, filePath: string, compactCount: number, extraPaths: string[] = []): ReadoutSession {
  return { source, sessionId, primaryPath: filePath, paths: [filePath, ...extraPaths], subagentPaths: [], subagentIds: [], compactCount, virtual: false }
}

async function realpath(filePath: string): Promise<string> {
  return fs.promises.realpath(filePath)
}

function claudeConversation(sessionId: string, seed: number, texts: string[]): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = []
  let parent: string | null = null
  texts.forEach((text, index) => {
    const uuid = syntheticUuid(seed * 100 + index)
    records.push(index % 2 === 0
      ? claude.user({ uuid, parentUuid: parent, sessionId, timestamp: syntheticTime(index), cwd: CWD, text })
      : claude.assistant({ uuid, parentUuid: parent, sessionId, timestamp: syntheticTime(index), cwd: CWD, text, messageId: `msg_${seed}_${index}`, requestId: `req_${seed}_${index}` }))
    parent = uuid
  })
  return records
}

async function caseLineSeparator(home: string, options: SelfTestOptions): Promise<boolean> {
  const sessionId = syntheticUuid(11)
  const records = claudeConversation(sessionId, 11, ['first question', 'first answer', `second${LS}question`])
  // A record with the *escaped* form must not count as a hazard.
  records.push(claude.assistant({ uuid: syntheticUuid(1199), parentUuid: syntheticUuid(1102), sessionId, timestamp: syntheticTime(4), cwd: CWD, text: 'x', messageId: 'msg_escaped', requestId: 'req_escaped' }))
  const text = jsonl(records).replace('"text":"x"', '"text":"escaped\\u2028form"')
  const filePath = await realpath(writeSample(home, path.join(CLAUDE_PROJECT, `${sessionId}.jsonl`), text))
  const census = await censusClaude(home)
  const unit = census.units.find((entry) => entry.path === filePath)
  if (!unit || unit.stats.parseable !== 4 || unit.stats.lineSeparatorRecords !== 1 || unit.hazardKinds.user !== 1) return false
  // Stand-in: a CR/U+2028-splitting reader keeps every record except the hazard.
  const readout = standInReadout([session('claude-code', sessionId, filePath, 0)],
    new Map([[filePath, { records: unit.stats.parseable - 1, elapsedMs: 0, partial: false }]]))
  const result = contentCheck(baseContext(options.salt, readout, { claude: census }))
  const finding = result.findings.find((entry) => entry.code === 'content.line-separator-split' && entry.source === 'claude-code')
  return !!finding && finding.count.value === 1 && result.bySource['claude-code']?.swob.mainLostUser?.value === 1 &&
    result.bySource['claude-code']?.verdict === 'fail'
}

/** Injected readout that keeps every parseable record of the file. */
function completeRead(parseable: number): ClaudeParseResult {
  return { records: parseable, elapsedMs: 0, partial: false }
}

async function caseToolBadLine(home: string, options: SelfTestOptions): Promise<boolean> {
  const sessionId = syntheticUuid(21)
  const records: Array<Record<string, unknown> | string> = claudeConversation(sessionId, 21, ['question', 'answer', 'follow-up'])
  records.splice(2, 0, '{"parentUuid":"broken","isSidechain":false,"type":"user","message":')
  const filePath = await realpath(writeSample(home, path.join(CLAUDE_PROJECT, `${sessionId}.jsonl`), jsonl(records)))
  const census = await censusClaude(home)
  const unit = census.units.find((entry) => entry.path === filePath)
  if (!unit || unit.stats.badLines !== 1 || unit.stats.parseable !== 3 || unit.stats.truncatedTail) return false
  const readout = standInReadout([session('claude-code', sessionId, filePath, 0)], new Map([[filePath, completeRead(unit.stats.parseable)]]))
  const result = contentCheck(baseContext(options.salt, readout, { claude: census }))
  const codes = result.findings.map((entry) => entry.code)
  const bad = result.findings.find((entry) => entry.code === 'content.tool-bad-line')
  const entry = result.bySource['claude-code']
  // Tool-written lines are listed but never grade ② (only Swob's own losses do).
  return !!bad && bad.count.value === 1 && bad.verdict === 'not-applicable' && entry?.verdict === 'pass' &&
    entry.oracle.toolBadLines?.value === 1 &&
    !codes.includes('content.line-separator-split') && !codes.includes('content.unexplained-loss')
}

async function caseTruncatedTail(home: string, options: SelfTestOptions): Promise<boolean> {
  const sessionId = syntheticUuid(31)
  const records: Array<Record<string, unknown> | string> = claudeConversation(sessionId, 31, ['question', 'answer'])
  records.push('{"parentUuid":"tail","isSidechain":false,"type":"assistant","message":{"role":"assis')
  const filePath = await realpath(writeSample(home, path.join(CLAUDE_PROJECT, `${sessionId}.jsonl`), jsonl(records, { trailingNewline: false })))
  const census = await censusClaude(home)
  const unit = census.units.find((entry) => entry.path === filePath)
  if (!unit || !unit.stats.truncatedTail || unit.stats.badLines !== 0 || unit.stats.parseable !== 2) return false
  const readout = standInReadout([session('claude-code', sessionId, filePath, 0)], new Map([[filePath, completeRead(unit.stats.parseable)]]))
  const result = contentCheck(baseContext(options.salt, readout, { claude: census }))
  const codes = result.findings.map((entry) => entry.code)
  const tail = result.findings.find((entry) => entry.code === 'content.truncated-tail')
  const entry = result.bySource['claude-code']
  return !!tail && tail.count.value === 1 && tail.verdict === 'not-applicable' && entry?.verdict === 'pass' &&
    entry.oracle.toolTruncatedTails?.value === 1 && !codes.includes('content.unexplained-loss')
}

async function caseCodexLegacyCompacted(home: string, options: SelfTestOptions): Promise<boolean> {
  const id = syntheticUuid(41, 'c0de')
  const rows = [
    codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id, cwd: CWD }),
    codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'long task' }),
    codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'working' }),
    codex.compacted({ timestamp: syntheticTime(3), ordinal: 3, message: 'summary one', window: 1 }),
    codex.assistantMessage({ timestamp: syntheticTime(4), ordinal: 4, text: 'still working' }),
    codex.compacted({ timestamp: syntheticTime(5), ordinal: 5, message: 'summary two', window: 2 }),
    codex.agentMessage({ timestamp: syntheticTime(6), ordinal: 6, text: 'done' })
  ]
  const filePath = await realpath(writeSample(home, codexRolloutPath(id, 0), jsonl(rows)))
  const census = await censusCodex(home, { env: {} })
  const unit = census.units.find((entry) => entry.path === filePath)
  if (!unit || unit.compaction.legacy !== 2 || unit.kind !== 'codex-top-level') return false
  // Stand-in: Swob recognises none of the legacy rows (compactCount 0).
  const readout = standInReadout([session('codex', id, filePath, 0)])
  const result = compactionCheck(baseContext(options.salt, readout, { codex: census }))
  const finding = result.findings.find((entry) => entry.code === 'codex.legacy-compacted-unrecognized')
  return !!finding && finding.count.value === 1 && result.bySource.codex?.oracle.perSessionUniqueSum?.value === 2 &&
    result.bySource.codex?.verdict === 'fail'
}

async function caseForkInheritedCompaction(home: string, options: SelfTestOptions): Promise<boolean> {
  // Claude: a resumed child file copies the parent's boundary (same uuid) and adds its own.
  const parentId = syntheticUuid(51)
  const childId = syntheticUuid(52)
  const boundary = { uuid: syntheticUuid(5100), logicalParentUuid: syntheticUuid(5101) }
  const parentRecords = [
    ...claudeConversation(parentId, 51, ['start', 'reply']),
    claude.compactBoundary({ ...boundary, parentUuid: null, sessionId: parentId, timestamp: syntheticTime(3), cwd: CWD }),
    claude.compactSummary({ uuid: syntheticUuid(5102), parentUuid: boundary.uuid, sessionId: parentId, timestamp: syntheticTime(4), cwd: CWD })
  ]
  const childRecords = [
    ...parentRecords.map((record) => ({ ...record, sessionId: childId })),
    claude.compactBoundary({ uuid: syntheticUuid(5200), logicalParentUuid: syntheticUuid(5102), parentUuid: null, sessionId: childId, timestamp: syntheticTime(9), cwd: CWD }),
    ...claudeConversation(childId, 52, ['next', 'answer'])
  ]
  const parentPath = await realpath(writeSample(home, path.join(CLAUDE_PROJECT, `${parentId}.jsonl`), jsonl(parentRecords)))
  const childPath = await realpath(writeSample(home, path.join(CLAUDE_PROJECT, `${childId}.jsonl`), jsonl(childRecords)))
  // Codex: a forked thread-spawn child copies the parent's compacted row with a rewritten timestamp.
  const codexParent = syntheticUuid(53, 'c0de')
  const codexChild = syntheticUuid(54, 'c0de')
  const copied = codex.compacted({ timestamp: syntheticTime(3), ordinal: 3, message: 'parent summary' })
  const codexParentPath = await realpath(writeSample(home, codexRolloutPath(codexParent, 0), jsonl([
    codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexParent, cwd: CWD }),
    codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'task' }),
    codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'ok' }),
    copied
  ])))
  await realpath(writeSample(home, codexRolloutPath(codexChild, 10), jsonl([
    codex.threadSpawnMeta({ timestamp: syntheticTime(10), ordinal: 0, id: codexChild, parentId: codexParent, cwd: CWD, historyStartOrdinal: 2 }),
    { ...copied, timestamp: syntheticTime(11), ordinal: 1 },
    codex.assistantMessage({ timestamp: syntheticTime(12), ordinal: 2, text: 'child work' })
  ])))
  const claudeCensus = await censusClaude(home)
  const codexCensus = await censusCodex(home, { env: {} })
  const readout = standInReadout([
    session('claude-code', parentId, parentPath, 1),
    session('claude-code', childId, childPath, 2),
    session('codex', codexParent, codexParentPath, 1)
  ])
  const result = compactionCheck(baseContext(options.salt, readout, { claude: claudeCensus, codex: codexCensus }))
  const claudeEntry = result.bySource['claude-code']
  const codexEntry = result.bySource.codex
  return claudeEntry?.oracle.inheritedMarkers?.value === 1 &&
    claudeEntry.oracle.inheritedMarkers.reason === 'compaction.fork-inherited-marker' &&
    claudeEntry.swob.sessionsMismatched?.value === 0 &&
    codexEntry?.oracle.subagentInheritedMarkers?.value === 1 &&
    codexEntry.oracle.subagentInheritedMarkers.reason === 'compaction.fork-inherited-marker' &&
    !result.findings.some((entry) => entry.code === 'compaction.count-mismatch')
}

async function caseForkUsageCopy(home: string): Promise<boolean> {
  const parentId = syntheticUuid(61, 'c0de')
  const childId = syntheticUuid(62, 'c0de')
  const first = { total: { input: 100, cached: 20, output: 10 }, last: { input: 100, cached: 20, output: 10 } }
  const second = { total: { input: 250, cached: 60, output: 25 }, last: { input: 150, cached: 40, output: 15 } }
  await realpath(writeSample(home, codexRolloutPath(parentId, 0), jsonl([
    codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: parentId, cwd: CWD }),
    codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'task' }),
    codex.tokenCount({ timestamp: syntheticTime(2), ordinal: 2, ...first }),
    codex.assistantMessage({ timestamp: syntheticTime(3), ordinal: 3, text: 'step' }),
    codex.tokenCount({ timestamp: syntheticTime(4), ordinal: 4, ...second })
  ])))
  await realpath(writeSample(home, codexRolloutPath(childId, 10), jsonl([
    codex.threadSpawnMeta({ timestamp: syntheticTime(10), ordinal: 0, id: childId, parentId, cwd: CWD, historyStartOrdinal: 3 }),
    // Copied history: same cumulative totals, rewritten timestamps.
    codex.tokenCount({ timestamp: syntheticTime(11), ordinal: 1, ...first }),
    codex.tokenCount({ timestamp: syntheticTime(11), ordinal: 2, ...second }),
    codex.assistantMessage({ timestamp: syntheticTime(12), ordinal: 3, text: 'own work' }),
    codex.tokenCount({ timestamp: syntheticTime(13), ordinal: 4, total: { input: 400, cached: 90, output: 40 }, last: { input: 150, cached: 30, output: 15 } })
  ])))
  const census = await censusCodex(home, { env: {} })
  const copies = countForkUsageCopies(census.units)
  return copies.rewritten === 2 && copies.sameTimestamp === 0 && copies.childUnits === 1
}

const CASES: Record<SelfTestCaseId, (home: string, options: SelfTestOptions) => Promise<boolean>> = {
  'line-separator-split': caseLineSeparator,
  'tool-bad-line': caseToolBadLine,
  'truncated-tail': caseTruncatedTail,
  'codex-legacy-compacted': caseCodexLegacyCompacted,
  'fork-inherited-compaction': caseForkInheritedCompaction,
  'fork-usage-copy': (home) => caseForkUsageCopy(home)
}

export async function runSelfTest(options: SelfTestOptions): Promise<SelfTestResult> {
  const cases: SelfTestResult['cases'] = []
  for (const id of SELF_TEST_CASES) {
    const home = path.join(options.workDir, id, 'home')
    let passed = false
    try {
      fs.mkdirSync(home, { recursive: true })
      passed = await CASES[id](home, options)
    } catch {
      passed = false
    }
    cases.push({ id, passed })
  }
  return { passed: cases.filter((entry) => entry.passed).length, total: SELF_TEST_TOTAL, cases }
}
