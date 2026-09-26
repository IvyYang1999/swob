import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import schema from './contract/kernel-checkup-report-v1.schema.json'
import { CHECK_ORDER, type CheckupReport } from './contract'
import { runKernelCheckup } from './run'
import { saltFingerprint, scanForPrivacy } from './privacy'
import { CANARY, assertInsideTestSandbox, buildSampleHome, type SampleHome } from './__test-support__/sample-home'

// One sample HOME per test file: kernel modules captured this HOME at import
// time and keep module-level caches (codexFileInventory, configuredRootsCache).
// Fail before anything else unless HOME is the Vitest sandbox home; the
// sandbox (and with it the sample HOME) is removed by isolate-home.ts.
const HOME = process.env.HOME!
assertInsideTestSandbox(HOME)
const SANDBOX = fs.realpathSync(process.env.SWOB_E2E_SANDBOX_ROOT!)

function strictSnapshot(root: string, exclude: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (exclude.some((prefix) => full === prefix || full.startsWith(prefix + path.sep))) continue
      const stat = fs.lstatSync(full)
      let signature = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      if (stat.isFile()) signature += `:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
      if (stat.isSymbolicLink()) signature += `:${fs.readlinkSync(full)}`
      out.set(full, signature)
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out
}

function diff(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = []
  for (const [file, signature] of before) if (after.get(file) !== signature) changes.push(`changed-or-removed:${path.relative(SANDBOX, file)}`)
  for (const file of after.keys()) if (!before.has(file)) changes.push(`added:${path.relative(SANDBOX, file)}`)
  return changes
}

let sample: SampleHome
const runs: Array<{ report: CheckupReport; consoleText: string; changes: string[]; stateAfter: string[] }> = []

async function capturedRun(): Promise<(typeof runs)[number]> {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-readonly-state-')))
  assertInsideTestSandbox(stateDir)
  const before = strictSnapshot(SANDBOX, [stateDir])
  const lines: string[] = []
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')) }))
  let report: CheckupReport
  try {
    report = await runKernelCheckup({ homeDir: HOME, stateDir, privacySalt: 'readonly-test-salt', kernelVersion: '1.4.0', kernelCommit: '4971632ac809b012357461c2f96f04a8a281eac5' })
  } finally {
    for (const spy of spies) spy.mockRestore()
  }
  const after = strictSnapshot(SANDBOX, [stateDir])
  const stateAfter = fs.readdirSync(stateDir)
  fs.rmSync(stateDir, { recursive: true, force: true })
  return { report, consoleText: lines.join('\n'), changes: diff(before, after), stateAfter }
}

beforeAll(async () => {
  sample = buildSampleHome(HOME)
  runs.push(await capturedRun())
  runs.push(await capturedRun())
}, 60_000)


describe('runKernelCheckup on a sample HOME (vitest sandbox)', () => {
  it('writes nothing outside stateDir and leaves stateDir as it found it', () => {
    for (const run of runs) {
      expect(run.changes).toEqual([])
      expect(run.stateAfter).toEqual([])
    }
    expect(fs.existsSync(path.join(HOME, '.claude-session-manager'))).toBe(false)
  })

  it('never leaks the canaries into the report or the captured console output', () => {
    for (const run of runs) {
      const serialized = JSON.stringify(run.report)
      for (const canary of Object.values(CANARY)) {
        expect(serialized.includes(canary), canary).toBe(false)
        expect(run.consoleText.includes(canary), canary).toBe(false)
      }
      expect(scanForPrivacy(run.report)).toEqual({ ok: true, hits: [] })
    }
  })

  it('produces a schema-valid v1 report with six checks in the fixed order', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    const validate = ajv.compile(schema)
    const report = runs[0].report
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([...CHECK_ORDER])
    expect(report.kernel).toMatchObject({ readOnly: true, selfTest: { passed: 6, total: 6 }, commit: '4971632ac809b012357461c2f96f04a8a281eac5' })
    expect(report.readout).toEqual({ status: 'ok' })
    expect(report.checks.slice(3).map((check) => [check.verdict, check.reason])).toEqual([
      ['undetermined', 'check.not-implemented'], ['undetermined', 'check.not-implemented'], ['undetermined', 'check.not-implemented']
    ])
  })

  it('reports oracle facts independent of the kernel and consistent buckets', () => {
    const report = runs[0].report
    const [inclusion, content, compaction] = report.checks
    expect(report.units).toHaveLength(sample.expected.claudeUnits + sample.expected.codexUnits)
    expect(content.bySource['claude-code'].oracle.mainBadLines.value).toBe(sample.expected.claudeMainBadLines)
    expect(content.bySource['claude-code'].oracle.toolBadLines.value).toBe(sample.expected.claudeMainBadLines)
    expect(content.findings.find((finding) => finding.code === 'content.tool-bad-line')?.verdict).toBe('not-applicable')
    expect(content.bySource['claude-code'].oracle.mainLineSeparatorRecords.value).toBe(sample.expected.claudeMainLineSeparatorRecords)
    expect(compaction.bySource.codex.oracle.legacyCompactedRows.value).toBe(sample.expected.codexTopLevelLegacyCompacted)
    expect(inclusion.bySource.kimi.oracle.legacyUnits.value).toBe(sample.expected.kimiLegacyUnits)
    for (const source of ['claude-code', 'codex']) {
      const swob = inclusion.bySource[source].swob
      const buckets = ['becameSession', 'merged', 'excluded', 'unsupported', 'notIncluded'].reduce((sum, key) => sum + (swob[key].value ?? 0), 0)
      expect(buckets + (swob.changedDuringRun.value ?? 0), source).toBe(inclusion.bySource[source].oracle.units.value)
    }
    const claudeSwob = content.bySource['claude-code'].swob
    expect((claudeSwob.mainRead.value ?? 0) + (claudeSwob.mainLost.value ?? 0))
      .toBe(content.bySource['claude-code'].oracle.mainParseableCompared.value)
    expect(content.bySource['claude-code'].swob.subagentRead).toEqual({ value: null, label: 'unavailable', unit: 'records', reason: 'content.swob-per-file-unavailable' })
    expect(report.oracles.find((oracle) => oracle.id === 'codex.state-db')).toEqual({ id: 'codex.state-db', available: true, version: '5' })
    for (const unit of report.units ?? []) {
      expect(unit.id).toMatch(/^[0-9a-f]{8}$/)
      expect(unit.unitSig).toMatch(/^[0-9a-f]{8}$/)
    }
  })

  it('is reproducible: unchanged data gives identical units and check results', () => {
    expect(runs[0].report.saltFingerprint).toBe(saltFingerprint('readonly-test-salt'))
    expect(runs[1].report.saltFingerprint).toBe(runs[0].report.saltFingerprint)
    expect(runs[1].report.units).toEqual(runs[0].report.units)
    expect(runs[1].report.checks).toEqual(runs[0].report.checks)
    expect(runs[1].report.verdict).toBe(runs[0].report.verdict)
  })

  it('refuses sample writes outside the Vitest sandbox (fail closed)', () => {
    expect(() => assertInsideTestSandbox(path.join(HOME, 'not-yet', 'created.db'))).not.toThrow()
    for (const outside of [os.userInfo().homedir, SANDBOX, path.join(SANDBOX, '..', 'escape'), '/']) {
      expect(() => assertInsideTestSandbox(outside)).toThrow(/outside the Vitest sandbox/)
    }
    const previous = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(() => assertInsideTestSandbox(HOME)).toThrow(/outside the Vitest sandbox/)
    } finally {
      process.env.NODE_ENV = previous
    }
  })

  it('records the SQLite read side effects instead of hiding them', () => {
    const effects = runs[0].report.sideEffects ?? []
    expect(effects.find((effect) => effect.source === 'codex' && effect.code === 'sqlite.readonly-sidecar-touch')?.count.value).toBe(0)
    expect(effects.some((effect) => effect.code === 'sqlite.main-db-changed')).toBe(false)
  })
})
