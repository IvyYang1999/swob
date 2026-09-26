/**
 * runKernelCheckup(): the single function that produces a CheckupReport.
 *
 * Order: self-test → census (oracle) → Swob readout (guarded kernel calls) →
 * final stat pass (units that changed during the run leave the comparison) →
 * checks ①②③ (④⑤⑥ undetermined in C1a) → privacy scan. Only things created
 * inside `stateDir` (the self-test work directory) are removed; `stateDir`
 * itself is never deleted.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  CHECK_ORDER,
  CHECKUP_VERSION,
  SOURCE_IDS,
  type CheckResult,
  type CheckupOptions,
  type CheckupReport,
  type CheckupUnit,
  type ReasonCode,
  type SourceId,
  type Verdict
} from './contract'
import { censusClaude, type ClaudeCensus } from './census/claude-census'
import { censusCodex, type CodexCensus } from './census/codex-census'
import { readCodexStateDb, type CodexStateDb } from './census/codex-state-db'
import { censusUnscannedRoots } from './census/unscanned-roots'
import { SOURCE_ROOTS, probeSourcePresence, sqliteSourceFiles } from './census/source-roots'
import { TimeRange, fingerprint, sameFingerprint, type FileFingerprint } from './census/files'
import { kernelHome, readSwobReadout, type SwobReadout } from './readout'
import { inclusionCheck, type UnitDisposition } from './checks/inclusion'
import { contentCheck } from './checks/content'
import { compactionCheck } from './checks/compaction'
import { pendingCheck } from './checks/pending'
import {
  applicabilityEntry,
  assembleCheck,
  reported,
  unavailable,
  worstVerdict,
  type CheckContext
} from './checks/common'
import { runSelfTest, type SelfTestResult } from './self-test/run-self-test'
import { assertPrivacyClean, derivePrivacySalt, hostHash, saltedId, unitSignature } from './privacy'

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('checkup aborted')
    error.name = 'AbortError'
    throw error
  }
}

function resolveStateDir(stateDir: string): string {
  const stat = fs.statSync(stateDir)
  if (!stat.isDirectory()) throw new Error('checkup stateDir must be an existing directory')
  return fs.realpathSync.native(stateDir)
}

function resolveInside(candidate: string, parent: string): string {
  const real = fs.realpathSync.native(candidate)
  const relative = path.relative(parent, real)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('checkup selfTestDir must be inside stateDir')
  return real
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since)
}

function mergeStateDbs(dbs: CodexStateDb[]): CodexStateDb | null {
  if (dbs.length === 0) return null
  const available = dbs.filter((db) => db.available)
  if (available.length === 0) return dbs.find((db) => db.reason === 'codex.state-db-unreadable') ?? dbs[0]
  const threads = new Map<string, CodexStateDb['threads'][number]>()
  const edges = new Map<string, CodexStateDb['edges'][number]>()
  for (const db of available) {
    for (const thread of db.threads) if (!threads.has(thread.id)) threads.set(thread.id, thread)
    for (const edge of db.edges) if (!edges.has(edge.child)) edges.set(edge.child, edge)
  }
  return {
    available: true,
    version: Math.max(...available.map((db) => db.version ?? 0)),
    candidates: dbs.reduce((sum, db) => sum + db.candidates, 0),
    threads: [...threads.values()],
    edges: [...edges.values()],
    audit: {
      mainBefore: available[0].audit?.mainBefore ?? null,
      mainAfter: available[0].audit?.mainAfter ?? null,
      sidecarsTouched: dbs.reduce((sum, db) => sum + (db.audit?.sidecarsTouched ?? 0), 0)
    }
  }
}

const SIDECARS = ['-wal', '-shm', '-journal'] as const
interface SqliteSnapshot { source: SourceId; file: string; main: FileFingerprint | null; sidecars: Array<FileFingerprint | null> }

function sqliteSnapshot(homeDir: string): SqliteSnapshot[] {
  return sqliteSourceFiles(homeDir).map(({ source, file }) => ({
    source,
    file,
    main: fingerprint(file),
    sidecars: SIDECARS.map((suffix) => fingerprint(`${file}${suffix}`))
  }))
}

function sideEffects(before: SqliteSnapshot[], after: SqliteSnapshot[], codexDb: CodexStateDb | null): NonNullable<CheckupReport['sideEffects']> {
  const effects: NonNullable<CheckupReport['sideEffects']> = []
  if (codexDb?.audit) {
    effects.push({ code: 'sqlite.readonly-sidecar-touch', source: 'codex', count: reported(codexDb.audit.sidecarsTouched, 'files') })
    if (codexDb.audit.mainBefore && !sameFingerprint(codexDb.audit.mainBefore, codexDb.audit.mainAfter)) {
      effects.push({ code: 'sqlite.main-db-changed', source: 'codex', count: reported(1, 'files') })
    }
  }
  for (const entry of before) {
    if (!entry.main) continue
    const later = after.find((candidate) => candidate.file === entry.file)
    const touched = entry.sidecars.filter((sidecar, index) => {
      const next = later?.sidecars[index] ?? null
      return !!next && (!sidecar || !sameFingerprint(sidecar, next))
    }).length
    effects.push({ code: 'sqlite.readonly-sidecar-touch', source: entry.source, count: reported(touched, 'files') })
    if (later && !sameFingerprint(entry.main, later.main)) {
      effects.push({ code: 'sqlite.main-db-changed', source: entry.source, count: reported(1, 'files') })
    }
  }
  return effects
}

function unitRecords(stats: { nonBlank: number; badLines: number; parseable: number; lineSeparatorRecords: number; truncatedTail: boolean }): CheckupUnit['records'] {
  return { nonBlank: stats.nonBlank, bad: stats.badLines, parseable: stats.parseable, lineSeparator: stats.lineSeparatorRecords, truncatedTail: stats.truncatedTail ? 1 : 0 }
}

function buildUnits(
  salt: string,
  claude: ClaudeCensus | null,
  codex: CodexCensus | null,
  dispositions: Map<string, UnitDisposition>,
  changed: ReadonlySet<string>,
  readout: SwobReadout
): CheckupUnit[] {
  const units: CheckupUnit[] = []
  const sig = (filePath: string, before: FileFingerprint | null): string =>
    unitSignature(salt, filePath, before?.mtimeMs ?? 0, before?.size ?? 0)
  const dispositionOf = (filePath: string): UnitDisposition => dispositions.get(filePath) ?? { bucket: null }
  for (const unit of claude?.units ?? []) {
    const disposition = dispositionOf(unit.path)
    const parsed = unit.kind === 'claude-main' ? readout.claudeParsed.get(unit.path) : undefined
    units.push({
      id: saltedId(salt, `unit:${unit.path}`),
      unitSig: sig(unit.path, unit.before),
      source: 'claude-code',
      kind: unit.kind,
      bucket: disposition.bucket,
      ...(disposition.reason ? { reason: disposition.reason } : {}),
      changed: changed.has(unit.path),
      records: unitRecords(unit.stats),
      swobRead: parsed && !parsed.partial ? parsed.records : null
    })
  }
  for (const unit of codex?.units ?? []) {
    const disposition = dispositionOf(unit.path)
    units.push({
      id: saltedId(salt, `unit:${unit.path}`),
      unitSig: sig(unit.path, unit.before),
      source: 'codex',
      kind: unit.kind,
      bucket: disposition.bucket,
      ...(disposition.reason ? { reason: disposition.reason } : {}),
      changed: changed.has(unit.path),
      records: unitRecords(unit.stats),
      swobRead: null
    })
  }
  return units
}

function censusInventory(
  source: SourceId,
  roots: Array<{ fixedRoot: string }>,
  units: Array<{ fixedRoot: string; before: FileFingerprint | null; timeRange: { min: string | null; max: string | null } }>
): CheckupReport['inventory'] {
  const rows: CheckupReport['inventory'] = []
  const fixedRoots = [...new Set([...SOURCE_ROOTS[source], ...roots.map((root) => root.fixedRoot)])]
  for (const fixedRoot of fixedRoots) {
    const inRoot = units.filter((unit) => unit.fixedRoot === fixedRoot)
    const range = new TimeRange()
    for (const unit of inRoot) range.merge(unit.timeRange)
    rows.push({
      source,
      root: fixedRoot,
      units: reported(inRoot.length, 'units'),
      bytes: reported(inRoot.reduce((sum, unit) => sum + (unit.before?.size ?? 0), 0), 'bytes'),
      timeRange: range.range(),
      scannedBySwob: true
    })
  }
  return rows
}

function buildInventory(
  claude: ClaudeCensus | null,
  codex: CodexCensus | null,
  presence: ReturnType<typeof probeSourcePresence>,
  unscanned: ReturnType<typeof censusUnscannedRoots>
): CheckupReport['inventory'] {
  const rows: CheckupReport['inventory'] = []
  for (const source of SOURCE_IDS) {
    if (source === 'claude-code' && claude) {
      rows.push(...censusInventory(source, claude.roots, claude.units))
      continue
    }
    if (source === 'codex' && codex) {
      rows.push(...censusInventory(source, codex.roots, codex.units))
      continue
    }
    const sourcePresence = presence.find((entry) => entry.source === source)
    for (const root of sourcePresence?.roots ?? []) {
      rows.push({
        source,
        root: root.fixedRoot,
        units: root.present ? unavailable('units', 'census.not-implemented') : reported(0, 'units'),
        bytes: root.present ? unavailable('bytes', 'census.not-implemented') : reported(0, 'bytes'),
        timeRange: [null, null],
        scannedBySwob: true
      })
    }
  }
  rows.push({
    source: 'kimi',
    root: '~/.kimi/sessions',
    units: reported(unscanned.kimiLegacy.units, 'units'),
    bytes: unscanned.kimiLegacy.units > 0 ? unavailable('bytes', 'census.not-implemented') : reported(0, 'bytes'),
    timeRange: [null, null],
    scannedBySwob: false
  })
  rows.push({
    source: 'zcode',
    root: '~/.zcode/v2',
    units: unscanned.zcodeV2.present ? unavailable('units', 'census.not-implemented') : reported(0, 'units'),
    bytes: unscanned.zcodeV2.present ? unavailable('bytes', 'census.not-implemented') : reported(0, 'bytes'),
    timeRange: [null, null],
    scannedBySwob: false
  })
  return rows
}

function scopeNotImplementedChecks(): CheckResult[] {
  return CHECK_ORDER.map((id) => {
    const bySource = Object.fromEntries(SOURCE_IDS.map((source) => [source, applicabilityEntry('undetermined', 'checkup.scope-not-implemented')]))
    return assembleCheck({ id, bySource, findings: [], headline: 'check.not-implemented', reason: 'checkup.scope-not-implemented' })
  })
}

/** Overall verdict (design §3.3 + §3.1 rule 4): worst graded check; undetermined unless the self-test fully passed. */
export function overallVerdict(checks: CheckResult[], selfTest: Pick<SelfTestResult, 'passed' | 'total'>): { verdict: Verdict; reason?: ReasonCode } {
  if (selfTest.passed < selfTest.total) return { verdict: 'undetermined', reason: 'checkup.self-test-failed' }
  const verdict = worstVerdict(checks.map((check) => check.verdict))
  if (verdict === 'undetermined' || verdict === 'not-applicable') return { verdict, reason: 'checkup.no-verdict-checks' }
  return { verdict }
}

/**
 * Test seam (not part of the §6.1 contract): replace the Swob-side readout with
 * an injected one. Production callers never pass it; the real run always uses
 * the guarded kernel readout.
 */
export interface CheckupInternals {
  readout?: (input: { stateDir: string; claudeMainFiles: readonly string[]; signal?: AbortSignal }) => Promise<SwobReadout>
}

export async function runKernelCheckup(options: CheckupOptions, internals: CheckupInternals = {}): Promise<CheckupReport> {
  const startedAt = performance.now()
  const timingsMs: Record<string, number> = {}
  const stateDir = resolveStateDir(options.stateDir)
  const salt = options.privacySalt ?? derivePrivacySalt()
  const homeDir = path.resolve(options.homeDir ?? kernelHome())
  const scope: CheckupReport['scope'] = options.scope ?? { kind: 'all' }
  const selected = new Set<string>(options.sources && options.sources.length > 0
    ? options.sources.filter((source) => (SOURCE_IDS as readonly string[]).includes(source))
    : SOURCE_IDS)

  // 1. Self-test (samples live in a fresh directory inside stateDir, removed afterwards).
  let phase = performance.now()
  const selfTestParent = options.selfTestDir ? resolveInside(options.selfTestDir, stateDir) : stateDir
  const workDir = fs.mkdtempSync(path.join(selfTestParent, 'checkup-self-test-'))
  let selfTest: SelfTestResult
  try {
    selfTest = await runSelfTest({ workDir, salt })
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true })
  }
  timingsMs.selfTest = elapsed(phase)
  abortIfNeeded(options.signal)

  const base = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    scope,
    kernel: {
      version: options.kernelVersion ?? '0.0.0-unknown',
      commit: options.kernelCommit ?? null,
      readOnly: true as const,
      checkupVersion: CHECKUP_VERSION,
      selfTest: { passed: selfTest.passed, total: selfTest.total }
    },
    machine: { platform: process.platform, hostHash: hostHash(salt), nodeVersion: process.version }
  }

  if (scope.kind !== 'all') {
    const checks = scopeNotImplementedChecks()
    const overall = overallVerdict(checks, selfTest)
    const report: CheckupReport = {
      ...base,
      verdict: overall.verdict,
      ...(overall.reason ? { verdictReason: overall.reason } : {}),
      checks,
      inventory: [],
      oracles: [],
      timingsMs: { ...timingsMs, total: elapsed(startedAt) },
      selfTestCases: selfTest.cases
    }
    assertPrivacyClean(report)
    return report
  }

  // 2. Census (oracle).
  const sqliteBefore = sqliteSnapshot(homeDir)
  phase = performance.now()
  const claude = selected.has('claude-code') ? await censusClaude(homeDir, { signal: options.signal }) : null
  timingsMs.censusClaude = elapsed(phase)
  phase = performance.now()
  const codex = selected.has('codex') ? await censusCodex(homeDir, { signal: options.signal }) : null
  timingsMs.censusCodex = elapsed(phase)
  phase = performance.now()
  const codexDb = codex ? mergeStateDbs(codex.homes.map((home) => readCodexStateDb(home.realPath))) : null
  timingsMs.codexStateDb = elapsed(phase)
  const unscanned = censusUnscannedRoots(homeDir)
  const presence = probeSourcePresence(homeDir)
  abortIfNeeded(options.signal)

  // 3. Swob readout (guarded).
  phase = performance.now()
  const readout = await (internals.readout ?? readSwobReadout)({
    stateDir,
    claudeMainFiles: (claude?.units ?? []).filter((unit) => unit.kind === 'claude-main' && !unit.unreadable).map((unit) => unit.path),
    signal: options.signal
  })
  timingsMs.readout = elapsed(phase)
  for (const [key, value] of Object.entries(readout.timingsMs)) timingsMs[`readout.${key}`] = value
  abortIfNeeded(options.signal)

  // 4. Final stat pass: anything that moved during the run leaves the comparison.
  const changed = new Set<string>()
  for (const unit of [...(claude?.units ?? []), ...(codex?.units ?? [])]) {
    if (unit.unreadable || !sameFingerprint(unit.before, unit.after) || !sameFingerprint(unit.before, fingerprint(unit.path))) {
      changed.add(unit.path)
    }
  }
  const sqliteAfter = sqliteSnapshot(homeDir)

  // 5. Checks.
  phase = performance.now()
  const ctx: CheckContext = { salt, selected, claude, codex, codexDb, unscanned, presence, readout, changed }
  const inclusion = inclusionCheck(ctx)
  const checks: CheckResult[] = [
    inclusion.result,
    contentCheck(ctx),
    compactionCheck(ctx),
    pendingCheck('lineage', ctx),
    pendingCheck('tokens', ctx),
    pendingCheck('resume', ctx)
  ]
  timingsMs.checks = elapsed(phase)
  const overall = overallVerdict(checks, selfTest)
  const allUnits = [...(claude?.units ?? []), ...(codex?.units ?? [])]
  const diagnostics: Record<string, number> = {
    kernelConsoleLines: readout.consoleLines,
    filesChangedDuringRun: [...changed].filter((filePath) => allUnits.some((unit) => unit.path === filePath && !unit.unreadable)).length,
    unreadableFiles: allUnits.filter((unit) => unit.unreadable).length,
    lowerSymlinks: (claude?.lowerSymlinks ?? 0) + (codex?.lowerSymlinks ?? 0),
    claudeParsedFiles: readout.claudeParsed.size,
    claudeParseTimeouts: [...readout.claudeParsed.values()].filter((entry) => entry.partial).length,
    readoutSessions: readout.sessions.length,
    codexHomeEnvSet: codex?.codexHomeEnvSet ? 1 : 0,
    additionalCodexHomes: codex?.additionalHomes ?? 0,
    codexStateDbCandidates: codexDb?.candidates ?? 0
  }
  const codexDbOracle: CheckupReport['oracles'][number] = codexDb?.available
    ? { id: 'codex.state-db', available: true, version: String(codexDb.version ?? 0) }
    : { id: 'codex.state-db', available: false, reason: codexDb?.reason ?? 'codex.state-db-missing' }
  const report: CheckupReport = {
    ...base,
    verdict: overall.verdict,
    ...(overall.reason ? { verdictReason: overall.reason } : {}),
    checks,
    inventory: buildInventory(claude, codex, presence, unscanned),
    oracles: [
      { id: 'census.claude-jsonl', available: !!claude },
      { id: 'census.codex-jsonl', available: !!codex },
      codexDbOracle,
      { id: 'census.unscanned-roots', available: true },
      { id: 'census.source-presence', available: true }
    ],
    timingsMs: { ...timingsMs, total: elapsed(startedAt) },
    selfTestCases: selfTest.cases,
    readout: readout.reason ? { status: readout.status, reason: readout.reason } : { status: readout.status },
    units: buildUnits(salt, claude, codex, inclusion.dispositions, changed, readout),
    sideEffects: sideEffects(sqliteBefore, sqliteAfter, codexDb),
    diagnostics
  }
  assertPrivacyClean(report)
  return report
}

export type { CheckupOptions, CheckupReport } from './contract'
