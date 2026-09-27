import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CheckResult, CheckupReport } from '../contract'
import { censusClaude } from '../census/claude-census'
import { censusCodex } from '../census/codex-census'
import type { SourcePresence } from '../census/source-roots'
import { CLAUDE_PARSE_TIMEOUT_MS, claudeParseResult, codexParseResult, type CodexParseResult, type ReadoutSession, type SwobReadout } from '../readout'
import { LS, claude, codex, codexRolloutPath, jsonl, syntheticTime, syntheticUuid, writeSample } from '../self-test/samples'
import { overallVerdict, runKernelCheckup, type CheckupInternals } from '../run'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../contract/kernel-checkup-report-v1.schema.json'
import { renderCheckupMarkdown } from '../render-markdown'
import { applicability, worstVerdict, type CheckContext } from './common'
import { compactionCheck, compactionThresholdVerdict } from './compaction'
import { buildCodexSessionSummary } from '../../main/codex-loader'
import { contentCheck, contentThresholdVerdict } from './content'
import { inclusionCheck } from './inclusion'

const homes: string[] = []
function home(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-checks-'))
  homes.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const CWD = '/synthetic/project'

function readout(sessions: ReadoutSession[], extra: Partial<SwobReadout> = {}): SwobReadout {
  return {
    status: 'ok', sessions, claudeParsed: new Map(), discovered: { claudeMain: new Set(), codex: new Set() },
    attributedChildIds: new Set(), consoleLines: 0, timingsMs: {}, ...extra
  }
}

function ctx(partial: Partial<CheckContext> & Pick<CheckContext, 'readout'>): CheckContext {
  return {
    salt: 'checks-salt', selected: new Set(['claude-code', 'codex', 'cursor', 'gemini', 'opencode', 'kimi', 'zcode']),
    claude: null, codex: null, codexDb: null, unscanned: null, presence: [], changed: new Set(), ...partial
  }
}

function codexSession(id: string, filePath: string, extra: Partial<ReadoutSession> = {}): ReadoutSession {
  return { source: 'codex', sessionId: id, primaryPath: filePath, paths: [filePath], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false, ...extra }
}

describe('verdict rules', () => {
  it('takes the worst graded verdict and ignores not-applicable / undetermined', () => {
    expect(worstVerdict(['pass', 'warn', 'undetermined'])).toBe('warn')
    expect(worstVerdict(['pass', 'fail', 'not-applicable'])).toBe('fail')
    expect(worstVerdict(['undetermined', 'not-applicable'])).toBe('undetermined')
    expect(worstVerdict(['not-applicable'])).toBe('not-applicable')
    expect(worstVerdict([])).toBe('undetermined')
  })

  it('② content thresholds: meta-only < 0.01 % warns, conversation loss or ≥ 0.01 % fails', () => {
    expect(contentThresholdVerdict({ parseable: 1_000_000, lost: 0, conversationLost: 0 })).toBe('pass')
    expect(contentThresholdVerdict({ parseable: 1_000_000, lost: 99, conversationLost: 0 })).toBe('warn')
    expect(contentThresholdVerdict({ parseable: 1_000_000, lost: 101, conversationLost: 0 })).toBe('fail')
    expect(contentThresholdVerdict({ parseable: 1_000_000, lost: 1, conversationLost: 1 })).toBe('fail')
  })

  it('③ compaction thresholds: ≤ 1 % explained mismatches warn, otherwise fail', () => {
    expect(compactionThresholdVerdict({ compared: 200, mismatched: 0, unexplained: 0 })).toBe('pass')
    expect(compactionThresholdVerdict({ compared: 200, mismatched: 2, unexplained: 0 })).toBe('warn')
    expect(compactionThresholdVerdict({ compared: 200, mismatched: 3, unexplained: 0 })).toBe('fail')
    expect(compactionThresholdVerdict({ compared: 200, mismatched: 1, unexplained: 1 })).toBe('fail')
  })

  it('overall verdict is undetermined unless the self-test fully passed', () => {
    const checks = [{ verdict: 'fail' }, { verdict: 'warn' }, { verdict: 'undetermined' }] as CheckResult[]
    expect(overallVerdict(checks, { passed: 6, total: 6 })).toEqual({ verdict: 'fail' })
    expect(overallVerdict(checks, { passed: 5, total: 6 })).toEqual({ verdict: 'undetermined', reason: 'checkup.self-test-failed' })
    expect(overallVerdict([{ verdict: 'undetermined' }] as CheckResult[], { passed: 6, total: 6 })).toEqual({ verdict: 'undetermined', reason: 'checkup.no-verdict-checks' })
  })

  it('judges not-applicable from the capability table and presence', () => {
    const presence: SourcePresence[] = [
      { source: 'gemini', roots: [], present: true },
      { source: 'cursor', roots: [], present: true },
      { source: 'opencode', roots: [], present: false }
    ]
    const selected = new Set(['gemini', 'cursor', 'opencode'])
    expect(applicability('cursor', 'tokens', { presence, selected })).toEqual({ verdict: 'not-applicable', reason: 'source.capability-unavailable' })
    expect(applicability('cursor', 'content', { presence, selected })).toEqual({ verdict: 'undetermined', reason: 'source.not-implemented' })
    expect(applicability('gemini', 'inclusion', { presence, selected })).toEqual({ verdict: 'undetermined', reason: 'readout.provider-host-not-parsed-readonly' })
    expect(applicability('opencode', 'inclusion', { presence, selected })).toEqual({ verdict: 'not-applicable', reason: 'source.no-data' })
    expect(applicability('pi', 'inclusion', { presence, selected })).toEqual({ verdict: 'not-applicable', reason: 'source.not-selected' })
  })
})

async function codexFixture(topLevel: number, extras: (root: string) => void): Promise<{ root: string; sessions: ReadoutSession[] }> {
  const root = home()
  const sessions: ReadoutSession[] = []
  for (let index = 0; index < topLevel; index++) {
    const id = syntheticUuid(1000 + index, 'c0de')
    const file = writeSample(root, codexRolloutPath(id, index), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(index), ordinal: 0, id, cwd: CWD }),
      codex.userMessage({ timestamp: syntheticTime(index), ordinal: 1, text: 'q' }),
      codex.assistantMessage({ timestamp: syntheticTime(index), ordinal: 2, text: 'a' })
    ]))
    sessions.push(codexSession(id, fs.realpathSync(file)))
  }
  extras(root)
  return { root, sessions }
}

describe('② tool-written broken lines are listed but never grade the check', () => {
  it('keeps ② at pass when the only problems are tool-written (Claude + Codex)', async () => {
    const root = home()
    const sid = syntheticUuid(90)
    const claudeFile = fs.realpathSync(writeSample(root, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(900), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: CWD, text: 'q' }),
      '{"parentUuid":"broken","isSidechain":false,"type":"user","message":',
      claude.assistant({ uuid: syntheticUuid(901), parentUuid: syntheticUuid(900), sessionId: sid, timestamp: syntheticTime(2), cwd: CWD, text: 'a', messageId: 'm90', requestId: 'r90' }),
      '{"parentUuid":"tail","isSidechain":false,"type":"assis'
    ], { trailingNewline: false })))
    const codexId = syntheticUuid(91, 'c0de')
    const codexFile = fs.realpathSync(writeSample(root, codexRolloutPath(codexId, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexId, cwd: CWD }),
      '{"timestamp":"2026-09-20T09:00:01.000Z","ordinal":1,"type":"response_item","payload":',
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'ok' })
    ])))
    const claudeCensus = await censusClaude(root)
    const codexCensus = await censusCodex(root, { env: {} })
    const parsed = new Map([[claudeFile, { records: 2, elapsedMs: 1, partial: false }]])
    // C1c: the kernel's per-file read count of the Codex file (the bad line is not a record).
    const codexParsed = new Map([[codexFile, { records: 2, elapsedMs: 1 }]])
    const result = contentCheck(ctx({ claude: claudeCensus, codex: codexCensus, readout: readout([], { claudeParsed: parsed, codexParsed }) }))
    expect(result.bySource['claude-code'].verdict).toBe('pass')
    expect(result.bySource.codex.verdict).toBe('pass')
    expect(result.verdict).toBe('pass')
    expect(result.bySource['claude-code'].oracle).toMatchObject({ toolBadLines: { value: 1, label: 'reported' }, toolTruncatedTails: { value: 1 } })
    expect(result.bySource.codex.oracle).toMatchObject({ toolBadLines: { value: 1 }, toolTruncatedTails: { value: 0 } })
    expect(result.findings.map((finding) => [finding.code, finding.source, finding.verdict, finding.count.value])).toEqual([
      ['content.tool-bad-line', 'claude-code', 'not-applicable', 1],
      ['content.truncated-tail', 'claude-code', 'not-applicable', 1],
      ['content.tool-bad-line', 'codex', 'not-applicable', 1]
    ])
    expect(result.headline).toBe('逐文件读全，没有记录丢失；另有 3 行是工具自己写坏的，不计入结论')
  })

  it('still fails ② on a Swob loss next to a tool-written line', async () => {
    const root = home()
    const sid = syntheticUuid(92)
    const file = fs.realpathSync(writeSample(root, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(920), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: CWD, text: `q${String.fromCharCode(0x2028)}` }),
      '{"broken":',
      claude.assistant({ uuid: syntheticUuid(921), parentUuid: syntheticUuid(920), sessionId: sid, timestamp: syntheticTime(2), cwd: CWD, text: 'a', messageId: 'm92', requestId: 'r92' })
    ])))
    const census = await censusClaude(root)
    const result = contentCheck(ctx({ claude: census, readout: readout([], { claudeParsed: new Map([[file, { records: 1, elapsedMs: 1, partial: false }]]) }) }))
    expect(result.bySource['claude-code'].verdict).toBe('fail')
    expect(result.findings.find((finding) => finding.code === 'content.line-separator-split')?.verdict).toBe('fail')
    expect(result.findings.find((finding) => finding.code === 'content.tool-bad-line')?.verdict).toBe('not-applicable')
  })
})

describe('③ Codex multi-copy sessions and the kernel counting rule (C1c deliverable ②)', () => {
  const compacted = (minute: number, ordinal: number, label: string): Record<string, unknown> =>
    codex.compacted({ timestamp: syntheticTime(minute), ordinal, message: `${label} summary ${ordinal}`, window: ordinal })

  /**
   * 100 plain sessions (0 markers each) plus one session whose id has two copies that share no marker:
   * copy A in sessions/ with `markersA` legacy rows, copy B in archived_sessions/ with `markersB`.
   */
  async function multiCopyFixture(markersA: number, markersB: number): Promise<{
    context: (swob: number, changed?: string[]) => CheckContext; copyA: string; copyB: string
  }> {
    const id = syntheticUuid(1400, 'c0de')
    let copyA = ''
    let copyB = ''
    const { root, sessions } = await codexFixture(100, (dir) => {
      const head = (minute: number): Array<Record<string, unknown>> => [
        codex.topLevelMeta({ timestamp: syntheticTime(minute), ordinal: 0, id, cwd: CWD }),
        codex.userMessage({ timestamp: syntheticTime(minute), ordinal: 1, text: 'long task' }),
        codex.assistantMessage({ timestamp: syntheticTime(minute), ordinal: 2, text: 'working' })
      ]
      copyA = writeSample(dir, codexRolloutPath(id, 500), jsonl([...head(500), ...Array.from({ length: markersA }, (_, index) => compacted(500, index + 3, 'copy A'))]))
      copyB = writeSample(dir, codexRolloutPath(id, 501, 'archived_sessions'), jsonl([...head(501), ...Array.from({ length: markersB }, (_, index) => compacted(501, index + 3, 'copy B'))]))
    })
    const census = await censusCodex(root, { env: {} })
    const realA = fs.realpathSync(copyA)
    const realB = fs.realpathSync(copyB)
    return {
      context: (swob, changed = []) => ctx({
        codex: census,
        changed: new Set(changed),
        readout: readout([...sessions, codexSession(id, realA, { paths: [realA, realB], compactCount: swob })])
      }),
      copyA: realA,
      copyB: realB
    }
  }
  const codexFindings = (result: ReturnType<typeof compactionCheck>): Array<[string, string, number | null]> =>
    result.findings.filter((finding) => finding.source === 'codex').map((finding) => [finding.code, finding.verdict, finding.count.value])

  it('explains a two-copy session whose count equals one copy (35 + 2, nothing shared, Swob 35): warn, not a failure', async () => {
    const { context } = await multiCopyFixture(35, 2)
    const result = compactionCheck(context(35))
    const entry = result.bySource.codex
    expect(codexFindings(result)).toEqual([['compaction.multi-copy-explained', 'warn', 1]])
    const explained = result.findings.find((finding) => finding.code === 'compaction.multi-copy-explained')!
    expect(explained.count).toEqual({ value: 1, label: 'derived', unit: 'sessions' })
    expect(explained.samples).toHaveLength(1)
    expect(explained.ownerLine).toBe('Codex：有 1 场会话在磁盘上有多份副本，Swob 按其中一份计数，标准答案取各份的并集；差异已解释，不是识别错误')
    // Still counted as a mismatch: the ≤ 1 % threshold keeps guarding it (1 of 101 sessions).
    expect(entry.swob).toMatchObject({ sessionsCompared: { value: 101 }, sessionsMismatched: { value: 1 }, compactCountSum: { value: 35 } })
    expect(entry.oracle).toMatchObject({ perSessionUniqueSum: { value: 37 }, legacyCompactedRows: { value: 37 } })
    expect(entry.verdict).toBe('warn')
    expect(result.verdict).toBe('warn')
    // No file in two formats and none with events only: no rule-difference measure, no finding.
    expect(Object.keys(entry.oracle).filter((key) => key === 'bothFormatFiles' || key === 'eventOnlyFiles')).toEqual([])
  })

  it('keeps explained sessions under the ≤ 1 % threshold: 2 explained of 101 is a failure (C1d; C1c acceptance P2-1)', async () => {
    // 99 plain sessions plus two sessions with two copies each (35 + 2 legacy rows, nothing shared, Swob 35).
    const copied = [syntheticUuid(1450, 'c0de'), syntheticUuid(1451, 'c0de')]
    const files: Array<[string, string, string]> = []
    const { root, sessions } = await codexFixture(99, (dir) => {
      copied.forEach((id, index) => {
        const minute = 600 + index * 2
        const head = (at: number): Array<Record<string, unknown>> => [
          codex.topLevelMeta({ timestamp: syntheticTime(at), ordinal: 0, id, cwd: CWD }),
          codex.userMessage({ timestamp: syntheticTime(at), ordinal: 1, text: 'long task' }),
          codex.assistantMessage({ timestamp: syntheticTime(at), ordinal: 2, text: 'working' })
        ]
        const copyA = writeSample(dir, codexRolloutPath(id, minute), jsonl([
          ...head(minute), ...Array.from({ length: 35 }, (_, marker) => compacted(minute, marker + 3, `copy A${index}`))
        ]))
        const copyB = writeSample(dir, codexRolloutPath(id, minute + 1, 'archived_sessions'), jsonl([
          ...head(minute + 1), ...Array.from({ length: 2 }, (_, marker) => compacted(minute + 1, marker + 3, `copy B${index}`))
        ]))
        files.push([id, copyA, copyB])
      })
    })
    const census = await censusCodex(root, { env: {} })
    const multi = files.map(([id, copyA, copyB]) => {
      const realA = fs.realpathSync(copyA)
      return codexSession(id, realA, { paths: [realA, fs.realpathSync(copyB)], compactCount: 35 })
    })
    const result = compactionCheck(ctx({ codex: census, readout: readout([...sessions, ...multi]) }))
    const entry = result.bySource.codex
    expect(codexFindings(result)).toEqual([['compaction.multi-copy-explained', 'warn', 2]])
    expect(entry.swob).toMatchObject({ sessionsCompared: { value: 101 }, sessionsMismatched: { value: 2 } })
    // Explained, yet still counted as mismatches: 2 of 101 is over 1 %, so the source fails.
    expect(entry.verdict).toBe('fail')
    expect(result.verdict).toBe('fail')
  })

  it('keeps a count that equals no copy a failure: count-mismatch once Swob recognised some markers (D7), legacy-unrecognized only when none', async () => {
    const { context } = await multiCopyFixture(35, 2)
    const twenty = compactionCheck(context(20))
    expect(codexFindings(twenty)).toEqual([['compaction.count-mismatch', 'fail', 1]])
    expect(twenty.bySource.codex.verdict).toBe('fail')
    const none = compactionCheck(context(0))
    expect(codexFindings(none)).toEqual([['codex.legacy-compacted-unrecognized', 'fail', 1]])
    expect(none.findings[0].ownerLine).toBe('Codex：1 场会话里一共发生过 37 次上下文压缩，Swob 一次都没认出来')
  })

  it('never explains a Swob count of 0 by a copy without markers (guard: recognition fell back to 0)', async () => {
    const { context } = await multiCopyFixture(2, 0)
    const result = compactionCheck(context(0))
    expect(codexFindings(result)).toEqual([['codex.legacy-compacted-unrecognized', 'fail', 1]])
    expect(result.bySource.codex.verdict).toBe('fail')
  })

  it('leaves the whole session out when one copy changed during the run', async () => {
    const { context, copyB } = await multiCopyFixture(35, 2)
    const result = compactionCheck(context(35, [copyB]))
    expect(codexFindings(result)).toEqual([['census.file-changed-during-run', 'undetermined', 1]])
    expect(result.bySource.codex.swob).toMatchObject({ sessionsCompared: { value: 100 }, sessionsMismatched: { value: 0 }, sessionsExcludedChanged: { value: 1 } })
    expect(result.bySource.codex.verdict).toBe('pass')
  })

  /** One top-level session in one file, with the given rows after its session_meta. */
  async function singleFile(seed: number, rows: Array<Record<string, unknown>>, swob: number): Promise<{ result: ReturnType<typeof compactionCheck>; file: string }> {
    const root = home()
    const id = syntheticUuid(seed, 'c0de')
    const file = fs.realpathSync(writeSample(root, codexRolloutPath(id, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id, cwd: CWD }),
      ...rows
    ])))
    const census = await censusCodex(root, { env: {} })
    return { result: compactionCheck(ctx({ codex: census, readout: readout([codexSession(id, file, { compactCount: swob })]) })), file }
  }
  const both = (): Array<Record<string, unknown>> => [
    codex.compacted({ timestamp: syntheticTime(1), ordinal: 1, message: 'first', window: 1 }),
    codex.compactionItem({ timestamp: syntheticTime(2), ordinal: 2, id: 'item-1' }),
    codex.compacted({ timestamp: syntheticTime(3), ordinal: 3, message: 'second', window: 2 })
  ]
  const eventsOnly = (): Array<Record<string, unknown>> => [
    codex.contextCompactedEvent({ timestamp: syntheticTime(1), ordinal: 1 }),
    codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'go on' }),
    codex.contextCompactedEvent({ timestamp: syntheticTime(3), ordinal: 3 })
  ]

  it('(a) a file with legacy rows and compaction items counts its legacy rows only, like the kernel; listed as a known rule difference', async () => {
    const { result } = await singleFile(1410, both(), 2)
    const entry = result.bySource.codex
    expect(entry.swob).toMatchObject({ sessionsMismatched: { value: 0 }, sessionsEqual: { value: 1 } })
    expect(entry.oracle).toMatchObject({
      perSessionUniqueSum: { value: 2 }, globalUnique: { value: 2 },
      // The census rows keep counting every row.
      legacyCompactedRows: { value: 2 }, compactionItemRows: { value: 1 },
      bothFormatFiles: { value: 1, label: 'reported', unit: 'files' }
    })
    expect(entry.oracle.eventOnlyFiles).toBeUndefined()
    expect(codexFindings(result)).toEqual([['codex.compaction-rule-difference', 'not-applicable', 1]])
    expect(result.findings[0].ownerLine).toBe('Codex：有 1 个会话文件的压缩记录写法特殊（新旧两种并存 1 个、只有压缩事件 0 个），逐场比对按 Swob 的计法数；这是已知的口径差，单独列出，不计入本项结论')
    expect(entry.verdict).toBe('pass')
  })

  it('(b) a file with neither format counts every *compact* event row, like the kernel; listed as a known rule difference', async () => {
    const { result } = await singleFile(1411, eventsOnly(), 2)
    const entry = result.bySource.codex
    expect(entry.swob).toMatchObject({ sessionsMismatched: { value: 0 }, sessionsEqual: { value: 1 } })
    expect(entry.oracle).toMatchObject({
      perSessionUniqueSum: { value: 2 }, globalUnique: { value: 2 }, contextCompactedEvents: { value: 2 },
      eventOnlyFiles: { value: 1, label: 'reported', unit: 'files' }
    })
    expect(codexFindings(result)).toEqual([['codex.compaction-rule-difference', 'not-applicable', 1]])
    expect(entry.verdict).toBe('pass')
  })

  it('the aligned per-session count equals the kernel\'s own compactCount (codex-loader, F1b rule)', async () => {
    const cases: Array<[number, Array<Record<string, unknown>>]> = [
      [1420, both()],
      [1421, eventsOnly()],
      // Items and events: the items count, the events do not.
      [1422, [codex.compactionItem({ timestamp: syntheticTime(1), ordinal: 1, id: 'item-1' }), codex.contextCompactedEvent({ timestamp: syntheticTime(2), ordinal: 2 })]],
      // A repeated legacy payload counts once; ContextCompaction never counts.
      [1423, [
        codex.compacted({ timestamp: syntheticTime(1), ordinal: 1, message: 'same', window: 1 }),
        codex.compacted({ timestamp: syntheticTime(1), ordinal: 1, message: 'same', window: 1 }),
        codex.contextCompactionEvent({ timestamp: syntheticTime(2), ordinal: 2, threadId: 't', turnId: 'u', itemId: 'i' })
      ]]
    ]
    for (const [seed, rows] of cases) {
      const probe = await singleFile(seed, rows, 0)
      const kernel = (await buildCodexSessionSummary(probe.file))?.compactCount
      expect(probe.result.bySource.codex.oracle.perSessionUniqueSum.value, String(seed)).toBe(kernel)
    }
  })
})

describe('① inclusion buckets and thresholds (Codex)', () => {
  it('attaches children, reports a nested orphan (≤ 1 % → warn) and excludes empty sessions', async () => {
    const parent = syntheticUuid(1000, 'c0de')
    const child = syntheticUuid(1, 'c0de')
    const grandchild = syntheticUuid(2, 'c0de')
    const guardian = syntheticUuid(3, 'c0de')
    const empty = syntheticUuid(4, 'c0de')
    const { root, sessions } = await codexFixture(100, (dir) => {
      writeSample(dir, codexRolloutPath(child, 200), jsonl([codex.threadSpawnMeta({ timestamp: syntheticTime(200), ordinal: 0, id: child, parentId: parent, cwd: CWD })]))
      writeSample(dir, codexRolloutPath(grandchild, 201), jsonl([codex.threadSpawnMeta({ timestamp: syntheticTime(201), ordinal: 0, id: grandchild, parentId: child, cwd: CWD, depth: 2 })]))
      writeSample(dir, codexRolloutPath(guardian, 202), jsonl([
        codex.guardianMeta({ timestamp: syntheticTime(202), ordinal: 0, id: guardian, parentId: parent, cwd: CWD }),
        codex.tokenCount({ timestamp: syntheticTime(203), ordinal: 1, total: { input: 1, cached: 0, output: 1 }, last: { input: 1, cached: 0, output: 1 } })
      ]))
      writeSample(dir, codexRolloutPath(empty, 204), jsonl([
        codex.topLevelMeta({ timestamp: syntheticTime(204), ordinal: 0, id: empty, cwd: CWD }),
        codex.userMessage({ timestamp: syntheticTime(205), ordinal: 1, text: 'hello?' })
      ]))
    })
    const census = await censusCodex(root, { env: {} })
    const childPath = census.units.find((unit) => unit.meta?.id === child)!.path
    sessions[0] = { ...sessions[0], subagentPaths: [childPath], subagentIds: [child] }
    const result = inclusionCheck(ctx({ codex: census, readout: readout(sessions, { attributedChildIds: new Set([guardian]) }) })).result
    const entry = result.bySource.codex
    expect(entry.swob).toMatchObject({
      becameSession: { value: 100 }, merged: { value: 2 }, excluded: { value: 1 }, notIncluded: { value: 1 }, notIncludedUnexplained: { value: 0 }
    })
    expect(entry.verdict).toBe('warn')
    expect(result.findings.map((finding) => finding.code)).toContain('codex.nested-subagent-orphan')
    expect(result.findings.find((finding) => finding.code === 'codex.nested-subagent-orphan')?.samples).toHaveLength(1)
  })

  it('attaches a zero-usage guardian nested under a thread-spawn child, not just one directly under the top-level session (C1e)', async () => {
    // Same shape as "reports a nested orphan" above, but the guardian's own
    // parent is the thread-spawn child (not the top-level session) and it
    // never produced any usage of its own: attributedChildIds can never carry
    // it (F1b), and the old one-hop parent check only recognized a guardian
    // parented directly to a top-level session. session-loader.ts's
    // codexSubagentsByTopLevel already walks the whole chain and attaches it;
    // before this fix inclusion.ts still called it a nested orphan.
    const parent = syntheticUuid(1000, 'c0de')
    const child = syntheticUuid(1, 'c0de')
    const nestedGuardian = syntheticUuid(2, 'c0de')
    const { root, sessions } = await codexFixture(3, (dir) => {
      writeSample(dir, codexRolloutPath(child, 200), jsonl([codex.threadSpawnMeta({ timestamp: syntheticTime(200), ordinal: 0, id: child, parentId: parent, cwd: CWD })]))
      writeSample(dir, codexRolloutPath(nestedGuardian, 201), jsonl([
        codex.guardianMeta({ timestamp: syntheticTime(201), ordinal: 0, id: nestedGuardian, parentId: child, cwd: CWD })
      ]))
    })
    const census = await censusCodex(root, { env: {} })
    const childPath = census.units.find((unit) => unit.meta?.id === child)!.path
    sessions[0] = { ...sessions[0], subagentPaths: [childPath], subagentIds: [child] }
    const result = inclusionCheck(ctx({ codex: census, readout: readout(sessions) })).result
    const entry = result.bySource.codex
    expect(entry.swob).toMatchObject({
      becameSession: { value: 3 }, merged: { value: 2 }, notIncluded: { value: 0 }
    })
    expect(entry.verdict).toBe('pass')
    expect(result.findings.map((finding) => finding.code)).not.toContain('codex.nested-subagent-orphan')
  })

  it('fails on an unexplained top-level gap and on > 1 % explained gaps', async () => {
    const { root, sessions } = await codexFixture(10, () => undefined)
    const census = await censusCodex(root, { env: {} })
    const result = inclusionCheck(ctx({ codex: census, readout: readout(sessions.slice(1)) })).result
    expect(result.bySource.codex.verdict).toBe('fail')
    expect(result.findings.find((finding) => finding.code === 'inclusion.unexplained')?.verdict).toBe('fail')

    const orphanParent = syntheticUuid(7, 'c0de')
    const withOrphans = await codexFixture(10, (dir) => {
      for (let index = 0; index < 2; index++) {
        const id = syntheticUuid(50 + index, 'c0de')
        writeSample(dir, codexRolloutPath(id, 300 + index), jsonl([codex.threadSpawnMeta({ timestamp: syntheticTime(300), ordinal: 0, id, parentId: orphanParent, cwd: CWD })]))
      }
    })
    const orphanCensus = await censusCodex(withOrphans.root, { env: {} })
    const orphanResult = inclusionCheck(ctx({ codex: orphanCensus, readout: readout(withOrphans.sessions) })).result
    expect(orphanResult.findings.map((finding) => finding.code)).toContain('codex.subagent-parent-missing')
    expect(orphanResult.bySource.codex.verdict).toBe('fail')
  })

  it('returns undetermined buckets when the readout is not isolated', async () => {
    const { root } = await codexFixture(1, () => undefined)
    const census = await censusCodex(root, { env: {} })
    const result = inclusionCheck(ctx({ codex: census, readout: { ...readout([]), status: 'undetermined', reason: 'readout.not-isolated' } }))
    expect(result.result.verdict).toBe('undetermined')
    expect(result.result.reason).toBe('readout.not-isolated')
    expect(result.dispositions.size).toBe(0)
  })
})

describe('① inclusion buckets (Claude) and ② content per file', () => {
  it('classifies sessions, continuation shards, attached/orphan/no-conversation subagents', async () => {
    const root = home()
    const project = path.join('.claude', 'projects', '-synthetic-project')
    const main = syntheticUuid(1)
    const shard = syntheticUuid(2)
    const gone = syntheticUuid(3)
    const conversation = (sid: string, seed: number) => jsonl([
      claude.user({ uuid: syntheticUuid(seed), parentUuid: null, sessionId: sid, timestamp: syntheticTime(seed), cwd: CWD, text: 'q' }),
      claude.assistant({ uuid: syntheticUuid(seed + 1), parentUuid: syntheticUuid(seed), sessionId: sid, timestamp: syntheticTime(seed + 1), cwd: CWD, text: 'a', messageId: `m${seed}`, requestId: `r${seed}` })
    ])
    const mainPath = fs.realpathSync(writeSample(root, path.join(project, `${main}.jsonl`), conversation(main, 10)))
    const shardPath = fs.realpathSync(writeSample(root, path.join(project, `${shard}.jsonl`), conversation(main, 20)))
    writeSample(root, path.join(project, 'summary-only.jsonl'), jsonl([{ type: 'summary', summary: 'x', leafUuid: syntheticUuid(99) }]))
    writeSample(root, path.join(project, main, 'subagents', 'agent-1.jsonl'), jsonl([claude.subagentUser({ uuid: syntheticUuid(30), parentUuid: null, sessionId: main, timestamp: syntheticTime(30), cwd: CWD, agentId: '1', text: 't' })]))
    writeSample(root, path.join(project, main, 'subagents', 'agent-meta.jsonl'), jsonl([{ type: 'launched', timestamp: syntheticTime(31) }]))
    writeSample(root, path.join(project, gone, 'subagents', 'agent-2.jsonl'), jsonl([claude.subagentUser({ uuid: syntheticUuid(32), parentUuid: null, sessionId: gone, timestamp: syntheticTime(32), cwd: CWD, agentId: '2', text: 't' })]))
    const census = await censusClaude(root)
    const sessions: ReadoutSession[] = [{ source: 'claude-code', sessionId: main, primaryPath: mainPath, paths: [mainPath, shardPath], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false }]
    const summaryOnly = census.units.find((unit) => path.basename(unit.path) === 'summary-only.jsonl')!.path
    const claudeParsed = new Map([
      [mainPath, { records: 2, elapsedMs: 1, partial: false }],
      [shardPath, { records: 2, elapsedMs: 40_000, partial: true }],
      [summaryOnly, { records: 1, elapsedMs: 1, partial: false }]
    ])
    const context = ctx({ claude: census, readout: readout(sessions, { claudeParsed }) })
    const { result, dispositions } = inclusionCheck(context)
    const reasons = [...dispositions.values()].map((entry) => `${entry.bucket}:${entry.reason ?? ''}`).sort()
    expect(reasons).toEqual([
      'excluded:claude.no-conversation-records',
      'excluded:claude.subagent-no-conversation',
      'merged:claude.continuation-shard',
      'merged:claude.subagent-attached',
      'not-included:claude.subagent-orphan',
      'session:'
    ])
    expect(result.bySource['claude-code'].verdict).toBe('fail')
    const content = contentCheck(context)
    expect(content.bySource['claude-code'].swob.mainParseTimeouts?.value).toBe(1)
    expect(content.findings.map((finding) => finding.code)).toContain('readout.parse-timeout')
    expect(content.bySource['claude-code'].verdict).toBe('pass')
  })
})

describe('② Claude subagent files are measured per file (C1b deliverable 0)', () => {
  const project = path.join('.claude', 'projects', '-synthetic-project')

  /** One main session with three subagent files: clean, one U+2028 record, and a plain one. */
  async function subagentFixture(): Promise<{ context: (claudeParsed: Map<string, { records: number; elapsedMs: number; partial: boolean }>) => CheckContext; main: string; clean: string; split: string; plain: string }> {
    const root = home()
    const sid = syntheticUuid(60)
    const record = (seed: number, text: string, agentId = 'a'): Record<string, unknown> =>
      claude.subagentUser({ uuid: syntheticUuid(seed), parentUuid: null, sessionId: sid, timestamp: syntheticTime(seed), cwd: CWD, agentId, text })
    const main = fs.realpathSync(writeSample(root, path.join(project, `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(600), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: CWD, text: 'q' }),
      claude.assistant({ uuid: syntheticUuid(601), parentUuid: syntheticUuid(600), sessionId: sid, timestamp: syntheticTime(2), cwd: CWD, text: 'a', messageId: 'm60', requestId: 'r60' })
    ])))
    const clean = fs.realpathSync(writeSample(root, path.join(project, sid, 'subagents', 'agent-clean.jsonl'), jsonl([record(610, 'one'), record(611, 'two')])))
    const split = fs.realpathSync(writeSample(root, path.join(project, sid, 'subagents', 'agent-split.jsonl'), jsonl([record(620, 'one'), record(621, `two${LS}halves`), record(622, 'three')])))
    const plain = fs.realpathSync(writeSample(root, path.join(project, sid, 'subagents', 'agent-plain.jsonl'), jsonl([record(630, 'one'), record(631, 'two')])))
    const census = await censusClaude(root)
    const session: ReadoutSession = { source: 'claude-code', sessionId: sid, primaryPath: main, paths: [main], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false }
    return {
      context: (claudeParsed) => ctx({ claude: census, readout: readout([session], { claudeParsed }) }),
      main, clean, split, plain
    }
  }
  const read = (records: number, partial = false): { records: number; elapsedMs: number; partial: boolean } => ({ records, elapsedMs: partial ? 40_000 : 1, partial })

  it('attributes a measured subagent loss to the line separator, and the rest to an unexplained loss', async () => {
    const { context, main, clean, split, plain } = await subagentFixture()
    const result = contentCheck(context(new Map([[main, read(2)], [clean, read(2)], [split, read(2)], [plain, read(1)]])))
    const entry = result.bySource['claude-code']
    expect(entry.swob).toMatchObject({
      subagentRead: { value: 5, label: 'reported', unit: 'records' },
      subagentLost: { value: 2, label: 'derived' },
      subagentLostUser: { value: 1 },
      subagentUnexplainedLost: { value: 1 },
      subagentParseTimeouts: { value: 0 },
      subagentReadRate: { value: 71.429, label: 'derived', unit: 'percent' }
    })
    expect(entry.swob.subagentLost.reason).toBeUndefined()
    expect(entry.oracle.subagentParseableCompared).toEqual({ value: 7, label: 'reported', unit: 'records' })
    const byCode = new Map(result.findings.map((finding) => [finding.code, finding]))
    expect(byCode.get('content.line-separator-split')?.count).toEqual({ value: 1, label: 'derived', unit: 'records' })
    expect(byCode.get('content.line-separator-split')?.ownerLine).toBe('Claude Code：有 1 条记录没读进来，其中 1 条是你本人发的消息。这些记录里带有特殊的行分隔符，Swob 这次读到的比原始记录少（旧版 Swob 也曾在这类记录上丢数据）')
    expect(byCode.get('content.unexplained-loss')?.count.value).toBe(1)
    expect(byCode.get('content.unexplained-loss')?.samples).toHaveLength(1)
    expect(entry.verdict).toBe('fail')
    expect(result.headline).toBe('有 2 条记录没读进来，其中 2 条是对话内容')
  })

  it('passes when every subagent record is read', async () => {
    const { context, main, clean, split, plain } = await subagentFixture()
    const result = contentCheck(context(new Map([[main, read(2)], [clean, read(2)], [split, read(3)], [plain, read(2)]])))
    const entry = result.bySource['claude-code']
    expect(entry.swob).toMatchObject({ subagentRead: { value: 7, label: 'reported' }, subagentLost: { value: 0 }, subagentReadRate: { value: 100 } })
    expect(result.findings.map((finding) => finding.code)).toEqual([])
    expect(entry.verdict).toBe('pass')
  })

  it('leaves a timed-out subagent read out of the comparison and reports it', async () => {
    const { context, main, clean, split, plain } = await subagentFixture()
    const result = contentCheck(context(new Map([[main, read(2)], [clean, read(2)], [split, read(1, true)], [plain, read(2)]])))
    const entry = result.bySource['claude-code']
    expect(entry.swob).toMatchObject({ subagentRead: { value: 4 }, subagentLost: { value: 0 }, subagentParseTimeouts: { value: 1, label: 'reported', unit: 'files' }, mainParseTimeouts: { value: 0 } })
    expect(result.findings.map((finding) => [finding.code, finding.count.value])).toEqual([['readout.parse-timeout', 1]])
    expect(entry.verdict).toBe('pass')
  })

  it('leaves subagent files without a parse result out of the comparison: no inference (C1c, dispatcher decision D6)', async () => {
    const { context, main } = await subagentFixture()
    const result = contentCheck(context(new Map([[main, read(2)]])))
    const entry = result.bySource['claude-code']
    expect(entry.swob.subagentRead).toEqual({ value: null, label: 'unavailable', unit: 'records', reason: 'content.swob-per-file-unavailable' })
    expect(entry.swob.subagentLost).toEqual({ value: null, label: 'unavailable', unit: 'records', reason: 'content.swob-per-file-unavailable' })
    expect(entry.swob.subagentReadRate).toEqual({ value: null, label: 'unavailable', unit: 'percent', reason: 'content.swob-per-file-unavailable' })
    expect(entry.oracle.subagentParseableCompared).toEqual({ value: 0, label: 'reported', unit: 'records' })
    expect(result.findings.map((finding) => [finding.code, finding.verdict, finding.count.value, finding.count.unit]))
      .toEqual([['content.swob-read-error', 'undetermined', 3, 'files']])
    expect(result.findings[0].samples).toHaveLength(3)
    // The main file was measured, so the source is still graded.
    expect(entry.verdict).toBe('pass')
  })

  it('is undetermined, not a vacuous pass, when no Claude file has a read count', async () => {
    const { context } = await subagentFixture()
    const result = contentCheck(context(new Map()))
    expect(result.bySource['claude-code'].verdict).toBe('undetermined')
    expect(result.findings.map((finding) => [finding.code, finding.count.value])).toEqual([['readout.parse-timeout', 1], ['content.swob-read-error', 3]])
  })
})

describe('② Codex files are measured per file (C1c deliverable ①)', () => {
  /**
   * Two top-level rollouts — one with a U+2028 user message and a U+2028 tool output (5 records), one
   * plain (3 records) — and a non-rollout .jsonl next to them (1 record with U+2028) that the kernel never reads.
   */
  async function codexContentFixture(): Promise<{ context: (codexParsed?: Map<string, CodexParseResult>) => CheckContext; split: string; plain: string }> {
    const root = home()
    const splitId = syntheticUuid(1300, 'c0de')
    const plainId = syntheticUuid(1301, 'c0de')
    const split = fs.realpathSync(writeSample(root, codexRolloutPath(splitId, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: splitId, cwd: CWD }),
      codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: `first${LS}line` }),
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'ok' }),
      codex.functionCallOutput({ timestamp: syntheticTime(3), ordinal: 3, callId: 'call_1', output: `out${LS}put` }),
      codex.agentMessage({ timestamp: syntheticTime(4), ordinal: 4, text: 'done' })
    ])))
    const plain = fs.realpathSync(writeSample(root, codexRolloutPath(plainId, 5), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(5), ordinal: 0, id: plainId, cwd: CWD }),
      codex.userMessage({ timestamp: syntheticTime(6), ordinal: 1, text: 'q' }),
      codex.assistantMessage({ timestamp: syntheticTime(7), ordinal: 2, text: 'a' })
    ])))
    writeSample(root, path.join('.codex', 'sessions', '2026', '09', '20', 'notes.jsonl'), jsonl([
      codex.userMessage({ timestamp: syntheticTime(8), ordinal: 0, text: `note${LS}text` })
    ]))
    const census = await censusCodex(root, { env: {} })
    const sessions = [codexSession(splitId, split), codexSession(plainId, plain)]
    return {
      context: (codexParsed) => ctx({ codex: census, readout: readout(sessions, codexParsed ? { codexParsed } : {}) }),
      split, plain
    }
  }
  const read = (records: number | null): CodexParseResult => ({ records, elapsedMs: 1 })

  it('reads U+2028 records completely: read = parseable gives no loss and a pass (nothing inferred)', async () => {
    const { context, split, plain } = await codexContentFixture()
    const result = contentCheck(context(new Map([[split, read(5)], [plain, read(3)]])))
    const entry = result.bySource.codex
    expect(entry.swob).toMatchObject({
      read: { value: 8, label: 'reported', unit: 'records' },
      lost: { value: 0, label: 'derived', unit: 'records' },
      unexplainedLost: { value: 0 },
      readUnavailableFiles: { value: 0, label: 'reported', unit: 'files' },
      readRate: { value: 100, label: 'derived', unit: 'percent' }
    })
    expect(entry.swob.lost.reason).toBeUndefined()
    expect(Object.keys(entry.swob).filter((key) => key.startsWith('lostByType:'))).toEqual([])
    // The non-rollout file stays in the census columns but takes no part in the comparison (① counts it).
    expect(entry.oracle).toMatchObject({
      files: { value: 3 }, parseable: { value: 9 }, lineSeparatorRecords: { value: 3 },
      parseableCompared: { value: 8, label: 'reported', unit: 'records' }
    })
    expect(result.findings).toEqual([])
    expect(entry.verdict).toBe('pass')
    expect(result.headline).toBe('逐文件读全，没有记录丢失')
  })

  it('measures a loss per file: read [R], lost [D] split by the file\'s hazards, the rest unexplained', async () => {
    const { context, split, plain } = await codexContentFixture()
    // One record short in the file with separators: explained by them, the most severe kind first.
    const explained = contentCheck(context(new Map([[split, read(4)], [plain, read(3)]])))
    expect(explained.bySource.codex.swob).toMatchObject({
      read: { value: 7, label: 'reported' }, lost: { value: 1, label: 'derived' },
      lostUser: { value: 1 }, lostToolResult: { value: 0 }, unexplainedLost: { value: 0 }, readRate: { value: 87.5 }
    })
    const separator = explained.findings.find((finding) => finding.code === 'content.line-separator-split')
    expect(separator).toMatchObject({ verdict: 'fail', source: 'codex', count: { value: 1, label: 'derived', unit: 'records' } })
    expect(separator?.ownerLine).toBe('Codex：有 1 条记录没读进来，其中 1 条是你本人发的消息。这些记录里带有特殊的行分隔符，Swob 这次读到的比原始记录少（旧版 Swob 也曾在这类记录上丢数据）')
    expect(separator?.samples).toHaveLength(1)
    expect(explained.bySource.codex.verdict).toBe('fail')
    // One record short in a file without separators: measured, and unexplained.
    const unexplained = contentCheck(context(new Map([[split, read(5)], [plain, read(2)]])))
    expect(unexplained.bySource.codex.swob).toMatchObject({ read: { value: 7, label: 'reported' }, lost: { value: 1 }, unexplainedLost: { value: 1 } })
    expect(unexplained.findings.map((finding) => [finding.code, finding.verdict, finding.count.value])).toEqual([['content.unexplained-loss', 'fail', 1]])
    expect(unexplained.headline).toBe('有 1 条记录没读进来，其中 1 条是对话内容')
    expect(unexplained.bySource.codex.verdict).toBe('fail')
    // More records than the census: listed per file (the Claude code), never a loss.
    const extra = contentCheck(context(new Map([[split, read(6)], [plain, read(3)]])))
    expect(extra.findings.map((finding) => [finding.code, finding.verdict, finding.count.value])).toEqual([['content.swob-extra-records', 'warn', 1]])
    expect(extra.bySource.codex.swob.lost.value).toBe(0)
    expect(extra.bySource.codex.verdict).toBe('warn')
  })

  it('leaves a file without a read count out (no inference) and lists it as undetermined', async () => {
    const { context, split, plain } = await codexContentFixture()
    const partly = contentCheck(context(new Map([[split, read(null)], [plain, read(3)]])))
    expect(partly.bySource.codex.swob).toMatchObject({ read: { value: 3, label: 'reported' }, lost: { value: 0 }, readUnavailableFiles: { value: 1 } })
    expect(partly.bySource.codex.oracle.parseableCompared).toEqual({ value: 3, label: 'reported', unit: 'records' })
    expect(partly.findings.map((finding) => [finding.code, finding.verdict, finding.count.value, finding.count.unit]))
      .toEqual([['content.swob-read-error', 'undetermined', 1, 'files']])
    expect(partly.bySource.codex.verdict).toBe('pass')
    // No file has a read count (the read threw, or the readout carries no Codex counts): undetermined, nothing inferred.
    for (const codexParsed of [new Map([[split, read(null)]]), undefined]) {
      const none = contentCheck(context(codexParsed))
      const entry = none.bySource.codex
      expect(entry.verdict).toBe('undetermined')
      expect(entry.swob.read).toEqual({ value: null, label: 'unavailable', unit: 'records', reason: 'content.swob-per-file-unavailable' })
      expect(entry.swob.lost).toEqual({ value: null, label: 'unavailable', unit: 'records', reason: 'content.swob-per-file-unavailable' })
      expect(entry.swob.readRate).toMatchObject({ value: null, label: 'unavailable', unit: 'percent' })
      expect(none.findings.map((finding) => [finding.code, finding.count.value])).toEqual([['content.swob-read-error', 2]])
    }
  })

  it('names a source that got no read count at all instead of saying every file was read (C1d; C1c acceptance P2-3)', async () => {
    /** A Claude main file (2 records) and a Codex rollout (3 records, plus a tool-written broken line when asked). */
    const twoSources = async (codexBrokenLine: boolean): Promise<{
      check: (claudeParsed: SwobReadout['claudeParsed'], codexParsed: Map<string, CodexParseResult>) => ReturnType<typeof contentCheck>
      claudeRead: SwobReadout['claudeParsed']; codexRead: Map<string, CodexParseResult>; codexThrew: Map<string, CodexParseResult>
      root: string; sessions: ReadoutSession[]
    }> => {
      const root = home()
      const sid = syntheticUuid(97)
      const claudeFile = fs.realpathSync(writeSample(root, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
        claude.user({ uuid: syntheticUuid(970), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: CWD, text: 'q' }),
        claude.assistant({ uuid: syntheticUuid(971), parentUuid: syntheticUuid(970), sessionId: sid, timestamp: syntheticTime(2), cwd: CWD, text: 'a', messageId: 'm97', requestId: 'r97' })
      ])))
      const codexId = syntheticUuid(98, 'c0de')
      const codexFile = fs.realpathSync(writeSample(root, codexRolloutPath(codexId, 0), jsonl([
        codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexId, cwd: CWD }),
        codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'q' }),
        ...(codexBrokenLine ? ['{"timestamp":"2026-09-20T09:00:02.000Z","ordinal":2,"type":"response_item","payload":'] : []),
        codex.assistantMessage({ timestamp: syntheticTime(3), ordinal: 3, text: 'a' })
      ])))
      const claudeCensus = await censusClaude(root)
      const codexCensus = await censusCodex(root, { env: {} })
      return {
        check: (claudeParsed, codexParsed) => contentCheck(ctx({ claude: claudeCensus, codex: codexCensus, readout: readout([], { claudeParsed, codexParsed }) })),
        claudeRead: new Map([[claudeFile, { records: 2, elapsedMs: 1, partial: false }]]),
        codexRead: new Map([[codexFile, read(3)]]),
        codexThrew: new Map([[codexFile, read(null)]]),
        root,
        sessions: [
          { source: 'claude-code', sessionId: sid, primaryPath: claudeFile, paths: [claudeFile], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false },
          codexSession(codexId, codexFile)
        ]
      }
    }
    const clean = await twoSources(false)
    // Codex: its only file's read threw, so none of it was compared (D6: undetermined); Claude Code passed.
    const codexUnread = clean.check(clean.claudeRead, clean.codexThrew)
    expect(codexUnread.bySource.codex.verdict).toBe('undetermined')
    expect(codexUnread.bySource['claude-code'].verdict).toBe('pass')
    expect(codexUnread.verdict).toBe('pass')
    expect(codexUnread.headline).toBe('Codex：本轮未取得读数，没有参与比对；已比对的来源没有记录丢失')
    // Claude Code without any parse result, Codex measured.
    expect(clean.check(new Map(), clean.codexRead).headline).toBe('Claude Code：本轮未取得读数，没有参与比对；已比对的来源没有记录丢失')
    // Both measured: every file was read. Neither: ② cannot be judged.
    expect(clean.check(clean.claudeRead, clean.codexRead).headline).toBe('逐文件读全，没有记录丢失')
    expect(clean.check(new Map(), clean.codexThrew).headline).toBe('本项这次无法判定')
    // Tool-written broken lines keep their note.
    const broken = await twoSources(true)
    const brokenUnread = broken.check(broken.claudeRead, broken.codexThrew)
    expect(brokenUnread.headline).toBe('Codex：本轮未取得读数，没有参与比对；已比对的来源没有记录丢失；另有 1 行是工具自己写坏的，不计入结论')
    for (const result of [codexUnread, brokenUnread]) expect(result.headline).not.toContain('逐文件读全')
    // End to end (a readout without Codex read counts): the six-check table names Codex and passes the Markdown scanner.
    const report = await runKernelCheckup({ homeDir: clean.root, stateDir: home(), privacySalt: 'unread-source' }, {
      readout: async () => readout(clean.sessions, { claudeParsed: clean.claudeRead })
    })
    expect(renderCheckupMarkdown(report, { utcOffsetMinutes: 480 }))
      .toContain('| ② 内容完整 | 通过 | Codex：本轮未取得读数，没有参与比对；已比对的来源没有记录丢失 | 不用管 |')
  })
})

describe('readout: per-file results from the kernel read stats (C1c)', () => {
  it('Claude: partial when the kernel says the read was cut short (truncated) or it took the kernel timeout', () => {
    expect(claudeParseResult({ recordsRead: 7, truncated: false }, 12)).toEqual({ records: 7, elapsedMs: 12, partial: false })
    expect(claudeParseResult({ recordsRead: 3, truncated: true }, 12)).toEqual({ records: 3, elapsedMs: 12, partial: true })
    expect(claudeParseResult({ recordsRead: 7, truncated: false }, CLAUDE_PARSE_TIMEOUT_MS)).toMatchObject({ partial: true })
    expect(claudeParseResult({ recordsRead: 7, truncated: false }, CLAUDE_PARSE_TIMEOUT_MS - 1_000)).toMatchObject({ partial: false })
  })

  it('Codex: the read count of a completed read; no count when the kernel read throws (never partial by time)', async () => {
    await expect(codexParseResult(async () => ({ recordsRead: 5 }))).resolves.toMatchObject({ records: 5 })
    await expect(codexParseResult(async () => { throw new Error('stream failed') })).resolves.toMatchObject({ records: null })
  })
})

describe('Swob readout per source (C1b)', () => {
  async function fixtureHome(): Promise<{ root: string; sessions: ReadoutSession[] }> {
    const root = home()
    const sid = syntheticUuid(70)
    const main = fs.realpathSync(writeSample(root, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(700), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: CWD, text: 'q' }),
      claude.assistant({ uuid: syntheticUuid(701), parentUuid: syntheticUuid(700), sessionId: sid, timestamp: syntheticTime(2), cwd: CWD, text: 'a', messageId: 'm70', requestId: 'r70' })
    ])))
    const codexId = syntheticUuid(71, 'c0de')
    const rollout = fs.realpathSync(writeSample(root, codexRolloutPath(codexId, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexId, cwd: CWD }),
      codex.userMessage({ timestamp: syntheticTime(1), ordinal: 1, text: 'q' }),
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'a' })
    ])))
    // OpenCode's store exists (the census does not count it yet); Gemini is a provider-host source.
    writeSample(root, path.join('.local', 'share', 'opencode', 'opencode.db'), '')
    fs.mkdirSync(path.join(root, '.gemini', 'tmp'), { recursive: true })
    return {
      root,
      sessions: [
        { source: 'claude-code', sessionId: sid, primaryPath: main, paths: [main], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: false },
        { source: 'claude-code', sessionId: `${sid}:intra-1`, primaryPath: main, paths: [main], subagentPaths: [], subagentIds: [], compactCount: 0, virtual: true },
        codexSession(codexId, rollout)
      ]
    }
  }

  it('counts sessions per source and lists a present source that read nothing (without grading ①)', async () => {
    const { root, sessions } = await fixtureHome()
    const report = await runKernelCheckup({ homeDir: root, stateDir: home(), privacySalt: 'per-source' }, { readout: async () => readout(sessions) })
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    const sessionsOf = (source: string): unknown => report.readoutBySource?.[source]?.sessions
    expect(sessionsOf('claude-code')).toEqual({ value: 1, label: 'reported', unit: 'sessions' })
    expect(sessionsOf('codex')).toEqual({ value: 1, label: 'reported', unit: 'sessions' })
    expect(sessionsOf('opencode')).toEqual({ value: 0, label: 'reported', unit: 'sessions' })
    expect(sessionsOf('gemini')).toEqual({ value: null, label: 'unavailable', unit: 'sessions', reason: 'readout.provider-host-not-parsed-readonly' })
    const inclusion = report.checks[0]
    expect(inclusion.findings.filter((finding) => finding.code === 'readout.source-empty').map((finding) => [finding.source, finding.verdict, finding.count]))
      .toEqual([['opencode', 'warn', { value: null, label: 'unavailable', unit: 'units', reason: 'census.not-implemented' }]])
    expect(inclusion.findings.find((finding) => finding.code === 'readout.source-empty')?.ownerLine).toBe('OpenCode：本机有这个来源的数据，但 Swob 这次一场会话都没读到')
    // ① is still graded by C1a's rules only: the new finding does not move any verdict.
    expect(inclusion.bySource.opencode.verdict).toBe('undetermined')
    expect(inclusion.verdict).toBe('pass')
  })

  it('hands the census Codex files to the readout and reports their measured read counts per unit (C1c)', async () => {
    const { root, sessions } = await fixtureHome()
    const [main, , rollout] = sessions.map((session) => session.primaryPath!)
    let given = null as Parameters<NonNullable<CheckupInternals['readout']>>[0] | null
    const report = await runKernelCheckup({ homeDir: root, stateDir: home(), privacySalt: 'per-source' }, {
      readout: async (input) => {
        given = input
        return readout(sessions, {
          claudeParsed: new Map([[main, { records: 2, elapsedMs: 1, partial: false }]]),
          codexParsed: new Map([[rollout, { records: 3, elapsedMs: 1 }]])
        })
      }
    })
    expect(given!.codexFiles).toEqual([rollout])
    expect((report.units ?? []).filter((unit) => unit.source === 'codex').map((unit) => [unit.swobRead, unit.records.parseable])).toEqual([[3, 3]])
    expect(report.checks[1].bySource.codex.swob.read).toEqual({ value: 3, label: 'reported', unit: 'records' })
    expect(report.checks[1].bySource.codex.verdict).toBe('pass')
    expect(report.diagnostics).toMatchObject({ codexParsedFiles: 1, codexReadErrors: 0 })
  })

  it('marks what a --sources run did not select: readout counts and inventory rows read 「本次未选」 (C1c)', async () => {
    const { root, sessions } = await fixtureHome()
    writeSample(root, path.join('.kimi', 'sessions', 'ws', 'old-session', 'context.jsonl'), jsonl([{ role: 'user', content: 'x' }]))
    fs.mkdirSync(path.join(root, '.zcode', 'v2'), { recursive: true })
    const report = await runKernelCheckup({ homeDir: root, stateDir: home(), privacySalt: 'per-source', sources: ['claude-code'] }, {
      readout: async () => readout(sessions.filter((session) => session.source === 'claude-code'), {
        claudeParsed: new Map([[sessions[0].primaryPath!, { records: 2, elapsedMs: 1, partial: false }]])
      })
    })
    const notSelected = (unit: string): unknown => ({ value: null, label: 'unavailable', unit, reason: 'source.not-selected' })
    expect(report.readoutBySource?.['claude-code']?.sessions).toEqual({ value: 1, label: 'reported', unit: 'sessions' })
    for (const source of ['codex', 'opencode', 'gemini', 'cursor']) expect(report.readoutBySource?.[source]?.sessions, source).toEqual(notSelected('sessions'))
    const row = (source: string, fixedRoot: string): CheckupReport['inventory'][number] | undefined =>
      report.inventory.find((entry) => entry.source === source && entry.root === fixedRoot)
    expect(row('claude-code', '~/.claude/projects')).toMatchObject({ units: { value: 1, label: 'reported' } })
    expect(row('codex', '~/.codex/sessions')).toMatchObject({ units: notSelected('units'), bytes: notSelected('bytes') })
    expect(row('opencode', '~/.local/share/opencode')).toMatchObject({ units: notSelected('units'), bytes: notSelected('bytes') })
    expect(row('kimi', '~/.kimi/sessions')).toMatchObject({ units: notSelected('units'), bytes: notSelected('bytes'), scannedBySwob: false })
    expect(row('zcode', '~/.zcode/v2')).toMatchObject({ units: notSelected('units'), scannedBySwob: false })
    // Roots without data stay 0 (listed as 「没有数据」 as before).
    expect(row('codex', '~/.codex/archived_sessions')).toMatchObject({ units: { value: 0, label: 'reported' } })
    expect(report.checks[0].findings.some((finding) => finding.source !== 'claude-code' && finding.code === 'readout.source-empty')).toBe(false)
    const markdown = renderCheckupMarkdown(report, { utcOffsetMinutes: 480 })
    expect(markdown).toContain('范围：本次只体检 Claude Code（其余 13 个来源未选）')
    expect(markdown).toContain('| Codex | ~/.codex/sessions | —（这次没有选这个来源） | —（这次没有选这个来源） | — | 读 |')
  })

  it('reads nothing per source when the readout did not run, and raises no finding then', async () => {
    const { root } = await fixtureHome()
    const blocked = { ...readout([]), status: 'undetermined' as const, reason: 'readout.not-isolated' as const }
    const report = await runKernelCheckup({ homeDir: root, stateDir: home(), privacySalt: 'per-source' }, { readout: async () => blocked })
    expect(Object.values(report.readoutBySource ?? {}).every((entry) => entry.sessions.value === null && entry.sessions.reason === 'readout.not-isolated')).toBe(true)
    expect(report.checks[0].findings.some((finding) => finding.code === 'readout.source-empty')).toBe(false)
  })
})
