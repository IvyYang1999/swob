/**
 * Hand-written CheckupReport fixtures for the C1b-1 renderer, digest and
 * comparison tests (test-only; never imported by production code). Every
 * sentence comes from templates.ts exactly as the checks produce it, and every
 * fixture is schema-valid (asserted by the tests).
 */
import {
  SOURCE_IDS,
  type CheckId,
  type CheckResult,
  type CheckupReport,
  type CheckupUnit,
  type Finding,
  type Label,
  type Measure,
  type ReasonCode,
  type Verdict
} from '../contract'
import { FINDING_TEXT, HEADLINES, OWNER_ACTIONS, fillTemplate } from '../templates'

export const FIXTURE_FINGERPRINT = 'a1b2c3d4'
export const OTHER_FINGERPRINT = '99887766'

type SourceEntry = CheckResult['bySource'][string]

export function measure(value: number | null, label: Label, unit: string, reason?: string): Measure {
  return reason ? { value, label, unit, reason } : { value, label, unit }
}
export const r = (value: number, unit: string): Measure => measure(value, 'reported', unit)
export const d = (value: number, unit: string, reason?: string): Measure => measure(value, 'derived', unit, reason)
export const u = (unit: string, reason: ReasonCode): Measure => measure(null, 'unavailable', unit, reason)

export function finding(code: ReasonCode, verdict: Finding['verdict'], source: string, count: Measure, numbers?: number[], samples: string[] = []): Finding {
  const text = FINDING_TEXT[code]
  if (!text) throw new Error(`fixture: no text for ${code}`)
  return {
    code,
    verdict,
    source,
    count,
    ownerLine: fillTemplate(text.ownerLine, numbers ?? [count.value ?? 0], source),
    engineerHint: fillTemplate(text.engineerHint, [], source),
    samples
  }
}

function status(verdict: Verdict, reason: ReasonCode): SourceEntry {
  return { verdict, swob: { status: u('checks', reason) }, oracle: {}, oracleIds: [] }
}

const WORST: Record<Verdict, number> = { pass: 1, warn: 2, fail: 3, undetermined: 0, 'not-applicable': 0 }

function assemble(id: CheckId, bySource: Record<string, SourceEntry>, findings: Finding[], headline: string, reason?: ReasonCode): CheckResult {
  const graded = Object.values(bySource).map((entry) => entry.verdict).filter((verdict) => WORST[verdict] > 0)
  const verdict: Verdict = graded.length > 0
    ? graded.reduce((worst, next) => WORST[next] > WORST[worst] ? next : worst)
    : Object.values(bySource).every((entry) => entry.verdict === 'not-applicable') ? 'not-applicable' : 'undetermined'
  const result: CheckResult = { id, verdict, headline, ownerAction: OWNER_ACTIONS[verdict], bySource, findings }
  if (reason) result.reason = reason
  return result
}

/** Sources other than Claude Code / Codex as C1a lists them: not implemented where data exists, else no data. */
function rest(present: readonly string[], reason: ReasonCode = 'source.not-implemented'): Record<string, SourceEntry> {
  const entries: Record<string, SourceEntry> = {}
  for (const source of SOURCE_IDS) {
    if (source === 'claude-code' || source === 'codex') continue
    entries[source] = present.includes(source) ? status('undetermined', reason) : status('not-applicable', 'source.no-data')
  }
  return entries
}

function pending(id: CheckId, present: readonly string[]): CheckResult {
  return assemble(id, {
    'claude-code': status('undetermined', 'check.not-implemented'),
    codex: status('undetermined', 'check.not-implemented'),
    ...rest(present, 'check.not-implemented')
  }, [], HEADLINES['check.not-implemented'], 'check.not-implemented')
}

export function unit(id: string, overrides: Partial<CheckupUnit> = {}): CheckupUnit {
  return {
    id,
    unitSig: `5${id.slice(1)}`,
    source: 'claude-code',
    kind: 'claude-main',
    bucket: 'session',
    changed: false,
    records: { nonBlank: 10, bad: 0, parseable: 10, lineSeparator: 0, truncatedTail: 0 },
    swobRead: 10,
    ...overrides
  }
}

/**
 * A full-scope report with every kind of cell: graded, undetermined and not-applicable sources,
 * unavailable measures, tool-side and undetermined findings, a silently empty source and units.
 */
export function mixedReport(): CheckupReport {
  const present = ['cursor', 'opencode', 'zcode', 'gemini', 'kimi']
  const inclusion = assemble('inclusion', {
    'claude-code': {
      verdict: 'pass',
      swob: {
        sessions: r(12, 'sessions'), branchViews: r(1, 'sessions'), discoveredMainFiles: r(12, 'files'),
        becameSession: d(12, 'units'), merged: d(30, 'units'), excluded: d(2, 'units'), unsupported: d(0, 'units'),
        notIncluded: d(0, 'units'), notIncludedUnexplained: d(0, 'units'), inclusionRate: d(100, 'percent'), changedDuringRun: d(1, 'units')
      },
      oracle: { units: r(45, 'units'), mainFiles: r(13, 'files'), subagentFiles: r(32, 'files'), otherJsonlFiles: r(0, 'files'), nonSessionFiles: r(4, 'files'), lowerSymlinks: r(0, 'units') },
      oracleIds: ['census.claude-jsonl']
    },
    codex: {
      verdict: 'warn',
      swob: {
        sessions: r(40, 'sessions'), attachedSubagents: r(9, 'units'), discoveredFiles: r(52, 'files'),
        becameSession: d(40, 'units'), merged: d(9, 'units'), excluded: d(1, 'units'), unsupported: d(0, 'units'),
        notIncluded: d(2, 'units'), notIncludedUnexplained: d(0, 'units'), inclusionRate: d(96.078, 'percent'), changedDuringRun: d(0, 'units')
      },
      oracle: { units: r(52, 'units'), topLevelFiles: r(41, 'files'), threadsInDb: r(41, 'threads'), spawnEdges: r(11, 'edges') },
      oracleIds: ['census.codex-jsonl', 'codex.state-db']
    },
    ...rest(present),
    kimi: { verdict: 'warn', swob: { status: u('checks', 'source.no-data') }, oracle: { legacyUnits: r(3, 'units') }, oracleIds: ['census.unscanned-roots'] }
  }, [
    finding('codex.nested-subagent-orphan', 'warn', 'codex', d(2, 'units'), undefined, ['0a0a0a0a', '0b0b0b0b']),
    finding('unsupported.kimi-legacy-sessions', 'warn', 'kimi', r(3, 'sessions')),
    finding('census.file-changed-during-run', 'undetermined', 'claude-code', r(1, 'files'), undefined, ['0c0c0c0c']),
    finding('readout.source-empty', 'warn', 'opencode', u('units', 'census.not-implemented'))
  ], fillTemplate(HEADLINES['inclusion.gaps'], [96, 2, 3]))
  const content = assemble('content', {
    'claude-code': {
      verdict: 'fail',
      swob: {
        mainRead: r(997, 'records'), mainLost: d(3, 'records'), mainLostUser: d(2, 'records'), mainLostAssistant: d(0, 'records'),
        mainLostToolResult: d(0, 'records'), mainLostMeta: d(1, 'records'), mainUnexplainedLost: d(0, 'records'), mainParseTimeouts: r(0, 'files'),
        subagentRead: r(500, 'records'), subagentLost: d(0, 'records'), subagentLostUser: d(0, 'records'), subagentLostAssistant: d(0, 'records'),
        subagentLostToolResult: d(0, 'records'), subagentLostMeta: d(0, 'records'), subagentUnexplainedLost: d(0, 'records'),
        subagentParseTimeouts: r(0, 'files'), mainReadRate: d(99.7, 'percent'), subagentReadRate: d(100, 'percent')
      },
      oracle: {
        mainFiles: r(12, 'files'), mainNonBlankLines: r(1001, 'lines'), mainBadLines: r(1, 'lines'), mainParseable: r(1000, 'records'),
        mainParseableCompared: r(1000, 'records'), subagentFiles: r(32, 'files'), subagentNonBlankLines: r(500, 'lines'),
        subagentBadLines: r(0, 'lines'), subagentParseable: r(500, 'records'), subagentParseableCompared: r(500, 'records'),
        toolBadLines: r(1, 'lines'), toolTruncatedTails: r(0, 'files')
      },
      oracleIds: ['census.claude-jsonl']
    },
    codex: {
      verdict: 'pass',
      swob: {
        read: u('records', 'content.swob-per-file-unavailable'), lost: d(0, 'records', 'content.line-separator-split'),
        lostUser: d(0, 'records'), lostAssistant: d(0, 'records'), lostToolResult: d(0, 'records'), lostMeta: d(0, 'records'),
        'lostByType:event_msg:token_count': d(0, 'records'), readRate: d(100, 'percent')
      },
      oracle: { files: r(52, 'files'), nonBlankLines: r(9000, 'lines'), badLines: r(0, 'lines'), parseable: r(9000, 'records'), toolBadLines: r(0, 'lines') },
      oracleIds: ['census.codex-jsonl']
    },
    ...rest(present)
  }, [
    finding('content.line-separator-split', 'fail', 'claude-code', d(3, 'records'), [3, 2], ['0d0d0d0d']),
    finding('content.tool-bad-line', 'not-applicable', 'claude-code', r(1, 'lines'), undefined, ['0e0e0e0e'])
  ], fillTemplate(HEADLINES['content.loss'], [3, 2]))
  const compaction = assemble('compaction', {
    'claude-code': {
      verdict: 'pass',
      swob: { compactCountSum: r(5, 'markers'), sessionsCompared: d(12, 'sessions'), sessionsEqual: d(12, 'sessions'), sessionsMismatched: d(0, 'sessions'), sessionsExcludedChanged: d(0, 'sessions') },
      oracle: { markerRows: r(6, 'markers'), sessionsWithMarkers: d(3, 'sessions'), perSessionUniqueSum: d(5, 'markers'), globalUnique: d(4, 'markers'), inheritedMarkers: d(1, 'markers', 'compaction.fork-inherited-marker') },
      oracleIds: ['census.claude-jsonl']
    },
    codex: {
      verdict: 'fail',
      swob: { compactCountSum: r(0, 'markers'), sessionsCompared: d(40, 'sessions'), sessionsEqual: d(36, 'sessions'), sessionsMismatched: d(4, 'sessions'), sessionsExcludedChanged: d(0, 'sessions') },
      oracle: { legacyCompactedRows: r(9, 'markers'), sessionsWithMarkers: d(4, 'sessions'), perSessionUniqueSum: d(9, 'markers'), globalUnique: d(9, 'markers') },
      oracleIds: ['census.codex-jsonl']
    },
    ...rest(present)
  }, [
    finding('codex.legacy-compacted-unrecognized', 'fail', 'codex', d(4, 'sessions'), [4, 9], ['0f0f0f0f'])
  ], fillTemplate(HEADLINES['compaction.mismatch'], [52, 4, 14, 5]))
  const tokens = pending('tokens', present)
  tokens.bySource.cursor = status('not-applicable', 'source.capability-unavailable')
  tokens.bySource.codex = { ...tokens.bySource.codex, oracle: { forkUsageCopies: d(7, 'snapshots', 'codex.fork-usage-copy') }, oracleIds: ['census.codex-jsonl'] }
  const units: CheckupUnit[] = [
    unit('10000001'),
    unit('10000002', { swobRead: 9, records: { nonBlank: 10, bad: 0, parseable: 10, lineSeparator: 1, truncatedTail: 0 } }),
    unit('10000003', { kind: 'claude-subagent', bucket: 'merged', reason: 'claude.subagent-attached', swobRead: 5, records: { nonBlank: 5, bad: 0, parseable: 5, lineSeparator: 0, truncatedTail: 0 } }),
    unit('20000001', { source: 'codex', kind: 'codex-top-level', swobRead: null }),
    unit('20000002', { source: 'codex', kind: 'codex-thread-spawn', bucket: 'not-included', reason: 'codex.nested-subagent-orphan', swobRead: null }),
    unit('20000003', { source: 'codex', kind: 'codex-thread-spawn', bucket: 'not-included', reason: 'codex.nested-subagent-orphan', swobRead: null }),
    unit('30000001', { changed: true, bucket: null, reason: 'census.file-changed-during-run' })
  ]
  const readoutBySource: NonNullable<CheckupReport['readoutBySource']> = {}
  for (const source of SOURCE_IDS) {
    readoutBySource[source] = source === 'claude-code' ? { sessions: r(12, 'sessions') }
      : source === 'codex' ? { sessions: r(40, 'sessions') }
        : source === 'cursor' ? { sessions: r(7, 'sessions') }
          : ['antigravity', 'grok', 'pi', 'kimi', 'hermes', 'qoder', 'trae', 'gemini'].includes(source)
            ? { sessions: u('sessions', 'readout.provider-host-not-parsed-readonly') }
            : { sessions: r(0, 'sessions') }
  }
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-27T01:02:03.000Z',
    scope: { kind: 'all' },
    kernel: { version: '1.4.0', commit: 'e51a952ac9d7580c67fafdc24c99f6d38355860a', readOnly: true, checkupVersion: '1.0.0', selfTest: { passed: 6, total: 6 } },
    machine: { platform: 'darwin', hostHash: '0123abcd', nodeVersion: 'v24.21.0' },
    saltFingerprint: FIXTURE_FINGERPRINT,
    verdict: 'fail',
    checks: [inclusion, content, compaction, pending('lineage', present), tokens, pending('resume', present)],
    inventory: [
      { source: 'claude-code', root: '~/.claude/projects', units: r(45, 'units'), bytes: r(52_428_800, 'bytes'), timeRange: ['2026-06-10T15:07:49.995Z', '2026-09-26T14:02:14.454Z'], scannedBySwob: true },
      { source: 'codex', root: '~/.codex/sessions', units: r(51, 'units'), bytes: r(1_073_741_824, 'bytes'), timeRange: ['2026-03-09T16:14:56.511Z', '2026-09-26T14:02:31.431Z'], scannedBySwob: true },
      { source: 'codex', root: '~/.codex/archived_sessions', units: r(1, 'units'), bytes: r(19_643, 'bytes'), timeRange: ['2026-09-17T05:46:35.935Z', '2026-09-17T05:46:35.935Z'], scannedBySwob: true },
      { source: 'opencode', root: '~/.local/share/opencode', units: u('units', 'census.not-implemented'), bytes: u('bytes', 'census.not-implemented'), timeRange: [null, null], scannedBySwob: true },
      { source: 'grok', root: '~/.grok/sessions', units: r(0, 'units'), bytes: r(0, 'bytes'), timeRange: [null, null], scannedBySwob: true },
      { source: 'kimi', root: '~/.kimi/sessions', units: r(3, 'units'), bytes: u('bytes', 'census.not-implemented'), timeRange: [null, null], scannedBySwob: false }
    ],
    oracles: [
      { id: 'census.claude-jsonl', available: true },
      { id: 'census.codex-jsonl', available: true },
      { id: 'codex.state-db', available: true, version: '5' },
      { id: 'census.unscanned-roots', available: true },
      { id: 'census.source-presence', available: true }
    ],
    timingsMs: { selfTest: 21, readout: 40_000, 'readout.loadAllSessions': 36_000, total: 61_234 },
    selfTestCases: [
      { id: 'line-separator-split', passed: true }, { id: 'tool-bad-line', passed: true }, { id: 'truncated-tail', passed: true },
      { id: 'codex-legacy-compacted', passed: true }, { id: 'fork-inherited-compaction', passed: true }, { id: 'fork-usage-copy', passed: true }
    ],
    readout: { status: 'ok' },
    readoutBySource,
    units,
    sideEffects: [
      { code: 'sqlite.readonly-sidecar-touch', source: 'codex', count: r(0, 'files') },
      { code: 'sqlite.readonly-sidecar-touch', source: 'opencode', count: r(1, 'files') }
    ],
    diagnostics: { kernelConsoleLines: 0, filesChangedDuringRun: 1, readoutSessions: 59 }
  }
}

/** Deep copy (fixtures are mutated by the tests). */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Nothing could be judged: the readout was not isolated and the self-test failed. */
export function allUndeterminedReport(): CheckupReport {
  const report = mixedReport()
  const present = ['cursor', 'opencode', 'zcode', 'gemini', 'kimi']
  const blocked = (id: CheckId): CheckResult => assemble(id, {
    'claude-code': { verdict: 'undetermined', swob: { sessions: u('sessions', 'readout.not-isolated') }, oracle: { units: r(45, 'units') }, oracleIds: ['census.claude-jsonl'] },
    codex: { verdict: 'undetermined', swob: { sessions: u('sessions', 'readout.not-isolated') }, oracle: { units: r(52, 'units') }, oracleIds: ['census.codex-jsonl'] },
    ...rest(present)
  }, [], HEADLINES['check.undetermined'], 'readout.not-isolated')
  report.checks = [blocked('inclusion'), blocked('content'), blocked('compaction'), pending('lineage', present), pending('tokens', present), pending('resume', present)]
  report.verdict = 'undetermined'
  report.verdictReason = 'checkup.self-test-failed'
  report.kernel.selfTest = { passed: 5, total: 6 }
  report.selfTestCases = report.selfTestCases!.map((entry) => entry.id === 'fork-usage-copy' ? { ...entry, passed: false } : entry)
  report.readout = { status: 'undetermined', reason: 'readout.not-isolated' }
  for (const source of Object.keys(report.readoutBySource!)) report.readoutBySource![source] = { sessions: u('sessions', 'readout.not-isolated') }
  report.units = report.units!.map((entry) => {
    const blocked: CheckupUnit = { ...entry, bucket: null, swobRead: null }
    delete blocked.reason
    return blocked
  })
  return report
}

/** Everything that was graded passed; ④⑤⑥ still undetermined. */
export function passReport(): CheckupReport {
  const report = mixedReport()
  const [inclusion, content, compaction] = report.checks
  inclusion.bySource.codex.verdict = 'pass'
  inclusion.bySource.codex.swob.notIncluded = d(0, 'units')
  inclusion.bySource.kimi = { verdict: 'not-applicable', swob: { status: u('checks', 'source.no-data') }, oracle: {}, oracleIds: [] }
  inclusion.findings = []
  inclusion.verdict = 'pass'
  inclusion.headline = fillTemplate(HEADLINES['inclusion.pass'], [97])
  inclusion.ownerAction = OWNER_ACTIONS.pass
  content.bySource['claude-code'].verdict = 'pass'
  content.findings = []
  content.verdict = 'pass'
  content.headline = HEADLINES['content.pass']
  content.ownerAction = OWNER_ACTIONS.pass
  compaction.bySource.codex.verdict = 'pass'
  compaction.findings = []
  compaction.verdict = 'pass'
  compaction.headline = fillTemplate(HEADLINES['compaction.pass'], [52])
  compaction.ownerAction = OWNER_ACTIONS.pass
  report.verdict = 'pass'
  return report
}

/** A hand-made one-day report (C1a does not implement day scope yet): the digest's 「今天」 branch. */
export function dayReport(): CheckupReport {
  const report = mixedReport()
  report.scope = { kind: 'day', day: '2026-09-26' }
  const [inclusion, content, compaction] = report.checks
  inclusion.bySource['claude-code'].swob.sessions = r(1, 'sessions')
  inclusion.bySource.codex.swob.sessions = r(6, 'sessions')
  inclusion.bySource.codex.verdict = 'pass'
  inclusion.bySource.kimi = { verdict: 'not-applicable', swob: { status: u('checks', 'source.no-data') }, oracle: {}, oracleIds: [] }
  inclusion.findings = []
  inclusion.verdict = 'pass'
  inclusion.headline = fillTemplate(HEADLINES['inclusion.pass'], [9])
  inclusion.ownerAction = OWNER_ACTIONS.pass
  content.bySource['claude-code'].verdict = 'pass'
  content.findings = []
  content.verdict = 'pass'
  content.headline = HEADLINES['content.pass']
  content.ownerAction = OWNER_ACTIONS.pass
  compaction.bySource.codex.swob.compactCountSum = r(0, 'markers')
  compaction.bySource.codex.oracle.perSessionUniqueSum = r(4, 'markers')
  compaction.bySource['claude-code'].oracle.perSessionUniqueSum = r(0, 'markers')
  compaction.bySource['claude-code'].swob.compactCountSum = r(0, 'markers')
  return report
}

