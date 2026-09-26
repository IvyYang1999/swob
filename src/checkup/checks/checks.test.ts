import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CheckResult } from '../contract'
import { censusClaude } from '../census/claude-census'
import { censusCodex } from '../census/codex-census'
import type { SourcePresence } from '../census/source-roots'
import type { ReadoutSession, SwobReadout } from '../readout'
import { LS, claude, codex, codexRolloutPath, jsonl, syntheticTime, syntheticUuid, writeSample } from '../self-test/samples'
import { overallVerdict, runKernelCheckup } from '../run'
import Ajv2020 from 'ajv/dist/2020.js'
import schema from '../contract/kernel-checkup-report-v1.schema.json'
import { applicability, worstVerdict, type CheckContext } from './common'
import { compactionThresholdVerdict } from './compaction'
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
    writeSample(root, codexRolloutPath(codexId, 0), jsonl([
      codex.topLevelMeta({ timestamp: syntheticTime(0), ordinal: 0, id: codexId, cwd: CWD }),
      '{"timestamp":"2026-09-20T09:00:01.000Z","ordinal":1,"type":"response_item","payload":',
      codex.assistantMessage({ timestamp: syntheticTime(2), ordinal: 2, text: 'ok' })
    ]))
    const claudeCensus = await censusClaude(root)
    const codexCensus = await censusCodex(root, { env: {} })
    const parsed = new Map([[claudeFile, { records: 2, elapsedMs: 1, partial: false }]])
    const result = contentCheck(ctx({ claude: claudeCensus, codex: codexCensus, readout: readout([], { claudeParsed: parsed }) }))
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
    expect(byCode.get('content.line-separator-split')?.ownerLine).toBe('Claude Code：有 1 条记录没读进来，其中 1 条是你本人发的消息。原因是记录里有特殊的「行分隔符」，Swob 把一条记录切成两半后悄悄丢掉了')
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

  it('keeps the C1a inference for subagent files without a parse result (the self-test path)', async () => {
    const { context, main } = await subagentFixture()
    const result = contentCheck(context(new Map([[main, read(2)]])))
    const entry = result.bySource['claude-code']
    expect(entry.swob.subagentRead).toEqual({ value: null, label: 'unavailable', unit: 'records', reason: 'content.swob-per-file-unavailable' })
    expect(entry.swob.subagentLost).toEqual({ value: 1, label: 'derived', unit: 'records', reason: 'content.line-separator-split' })
    expect(entry.swob.subagentReadRate).toEqual({ value: null, label: 'unavailable', unit: 'percent', reason: 'content.swob-per-file-unavailable' })
    expect(result.findings.map((finding) => [finding.code, finding.count.value])).toEqual([['content.line-separator-split', 1]])
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

  it('reads nothing per source when the readout did not run, and raises no finding then', async () => {
    const { root } = await fixtureHome()
    const blocked = { ...readout([]), status: 'undetermined' as const, reason: 'readout.not-isolated' as const }
    const report = await runKernelCheckup({ homeDir: root, stateDir: home(), privacySalt: 'per-source' }, { readout: async () => blocked })
    expect(Object.values(report.readoutBySource ?? {}).every((entry) => entry.sessions.value === null && entry.sessions.reason === 'readout.not-isolated')).toBe(true)
    expect(report.checks[0].findings.some((finding) => finding.code === 'readout.source-empty')).toBe(false)
  })
})
