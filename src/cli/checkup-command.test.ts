import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import schema from '../checkup/contract/kernel-checkup-report-v1.schema.json'
import type { CheckupReport } from '../checkup/contract'
import { derivePrivacySalt, saltFingerprint, scanForPrivacy, scanMarkdownForPrivacy } from '../checkup/privacy'
import { LATEST_FILE_PATTERN, MARKDOWN_MARKER, REPORT_FILE_PATTERN, reportFileNames } from '../checkup/render-markdown'
import { SESSION_PACKAGE_MARKER } from '../checkup/run-guard'
import { CANARY, assertInsideTestSandbox, buildSampleHome } from '../checkup/__test-support__/sample-home'
import { bundleCheckupWorker, repositoryNodeModules } from '../checkup/__fixtures__/worker-bundle'
import { clone, mixedReport, passReport } from '../checkup/__fixtures__/checkup-reports'
import { resolveTypeScriptImport, runtimeRelativeImports } from '../main/__test-support__/typescript-runtime-closure'
import type { CliIo } from './index'
import { runDoctorCheckup, type CheckupWorkerLaunch } from './checkup-command'

// The sample HOME is the Vitest sandbox home (kernel modules of this process captured it at import time;
// the checkup itself runs in the spawned worker). The library root is a vault inside the sandbox.
const HOME = process.env.HOME!
assertInsideTestSandbox(HOME)
const SANDBOX = fs.realpathSync(process.env.SWOB_E2E_SANDBOX_ROOT!)
const ROOT = process.cwd()
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
const MACHINE_TAG = saltFingerprint(derivePrivacySalt()).slice(0, 6)

let runCli: typeof import('./index').runCli
let workerPath = ''
let fakeWorkerPath = ''
let vault = ''
let reportDir = ''
let sessionPackage = ''
let fakeBin = ''
let previousPath: string | undefined
const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

function mkdir(...segments: string[]): string {
  const dir = path.join(...segments)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** A stand-in worker for fault injection, driven by FAKE_WORKER_* variables of the launcher env. */
const FAKE_WORKER = `
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const get = (flag) => args[args.indexOf(flag) + 1]
const mode = process.env.FAKE_WORKER_MODE || 'report'
if (mode === 'exit') process.exit(Number(process.env.FAKE_WORKER_EXIT))
if (mode === 'sleep') setInterval(() => {}, 1000)
if (mode === 'noisy') {
  console.log(${JSON.stringify(CANARY.absolutePath)})
  console.error(${JSON.stringify(CANARY.userText)})
  console.error(get('--home'))
  process.exit(1)
}
if (mode === 'no-report') process.exit(0)
if (mode === 'touch-state') {
  fs.mkdirSync(path.join(get('--home'), '.claude-session-manager'), { recursive: true })
  fs.writeFileSync(path.join(get('--home'), '.claude-session-manager', 'intruder'), 'x')
}
if (mode === 'report' || mode === 'touch-state') {
  fs.copyFileSync(process.env.FAKE_WORKER_REPORT, get('--out'))
  process.exit(0)
}
`

interface Invocation { code: number; stdout: string; stderr: string }

async function invoke(args: string[], worker: CheckupWorkerLaunch = { workerPath, env: { NODE_PATH: repositoryNodeModules() } }): Promise<Invocation> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    stdout: (value) => { stdout += value },
    stderr: (value) => { stderr += value },
    readStdin: async () => ''
  }
  const code = await runCli(args, io, { libraryRoot: vault, checkupWorker: worker })
  return { code, stdout, stderr }
}

/** Launcher for the fake worker handing back `report` (or behaving as `mode` says). */
function fake(mode: string, report: CheckupReport | null = mixedReport(), extra: Record<string, string> = {}): CheckupWorkerLaunch {
  const env: Record<string, string> = { FAKE_WORKER_MODE: mode, ...extra }
  if (report) {
    const file = path.join(tempDir('checkup-fake-report-'), 'report.json')
    fs.writeFileSync(file, JSON.stringify(report))
    env.FAKE_WORKER_REPORT = file
  }
  return { workerPath: fakeWorkerPath, env }
}

function errorOf(invocation: Invocation): Record<string, unknown> {
  const lines = invocation.stderr.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1]).error
}

/** Strict snapshot (lstat identity + content hash) of `root`, skipping `exclude` subtrees. */
function snapshot(root: string, exclude: string[] = []): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      if (exclude.some((prefix) => full === prefix || full.startsWith(`${prefix}${path.sep}`))) continue
      const stat = fs.lstatSync(full)
      let signature = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      if (stat.isFile()) signature += `:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
      entries.set(full, signature)
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(root)
  return entries
}

function stateDirsLeft(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('swob-checkup-'))
}

function reportFiles(): string[] {
  return fs.readdirSync(reportDir).sort()
}

function clearReports(): void {
  for (const name of fs.readdirSync(reportDir)) fs.rmSync(path.join(reportDir, name), { recursive: true, force: true })
}

function expectNoCanary(...texts: string[]): void {
  for (const text of texts) {
    for (const canary of Object.values(CANARY)) expect(text.includes(canary), canary).toBe(false)
    expect(text.includes(SANDBOX), 'sandbox path').toBe(false)
  }
}

beforeAll(async () => {
  buildSampleHome(HOME)
  vault = mkdir(SANDBOX, 'vault')
  mkdir(vault, '.swob', 'index')
  fs.writeFileSync(path.join(vault, '.swob', 'index', 'state.txt'), 'library state')
  reportDir = mkdir(vault, '项目', '体检')
  sessionPackage = mkdir(vault, 'Swob', 'sessions', 'pkg-1')
  fs.writeFileSync(path.join(sessionPackage, SESSION_PACKAGE_MARKER), '{}')
  workerPath = await bundleCheckupWorker(tempDir('checkup-cli-worker-'))
  const fakeDir = tempDir('checkup-cli-fake-')
  fakeWorkerPath = path.join(fakeDir, 'fake-worker.cjs')
  fs.writeFileSync(fakeWorkerPath, FAKE_WORKER)
  // A pgrep stand-in keeps these tests independent of a Swob app running on the machine.
  fakeBin = mkdir(fakeDir, 'bin')
  fs.writeFileSync(path.join(fakeBin, 'pgrep'), '#!/bin/sh\nexit "${FAKE_PGREP_EXIT:-1}"\n', { mode: 0o755 })
  previousPath = process.env.PATH
  process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`
  ;({ runCli } = await import('./index'))
}, 120_000)

afterAll(() => {
  process.env.PATH = previousPath
  delete process.env.FAKE_PGREP_EXIT
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe.sequential('swob doctor checkup (in process, isolated worker)', () => {
  it('writes the three report files into an ordinary vault directory, prints the digest and writes nothing else', async () => {
    const homeBefore = snapshot(HOME)
    const vaultBefore = snapshot(vault, [reportDir])
    const invocation = await invoke(['doctor', 'checkup', '--report', reportDir])
    expect(invocation.stderr).toBe('')
    expect(invocation.code).toBe(0)
    const names = reportFiles()
    expect(names).toHaveLength(3)
    const markdownName = names.find((name) => REPORT_FILE_PATTERN.exec(name)?.[3] === 'md')!
    const jsonName = names.find((name) => REPORT_FILE_PATTERN.exec(name)?.[3] === 'json')!
    const latestName = names.find((name) => LATEST_FILE_PATTERN.test(name))!
    expect(REPORT_FILE_PATTERN.exec(markdownName)?.[2]).toBe(MACHINE_TAG)
    expect(latestName).toBe(`最新-${MACHINE_TAG}.md`)
    expect(jsonName).toBe(markdownName.replace(/\.md$/, '.json'))
    const markdown = fs.readFileSync(path.join(reportDir, markdownName), 'utf8')
    const json = fs.readFileSync(path.join(reportDir, jsonName), 'utf8')
    expect(fs.readFileSync(path.join(reportDir, latestName), 'utf8')).toBe(markdown)
    expect(markdown.split('\n')[0]).toBe(MARKDOWN_MARKER)
    expect(markdown).toContain('和上次比：没有找到可比的上次报告。')
    expect(scanMarkdownForPrivacy(markdown)).toEqual({ ok: true, hits: [] })
    const report = JSON.parse(json)
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
    expect(scanForPrivacy(report)).toEqual({ ok: true, hits: [] })
    expect(report.readout).toEqual({ status: 'ok' })
    expect(report.kernel).toMatchObject({ commit: null, readOnly: true, selfTest: { passed: 6, total: 6 } })
    // stdout is the AI-diary line linking the dated note.
    const base = markdownName.replace(/\.md$/, '')
    expect(invocation.stdout).toMatch(new RegExp(`^体检 · .+ → \\[\\[${base}\\]\\]（.+）\\n$`))
    expect(scanMarkdownForPrivacy(invocation.stdout.trim()).ok).toBe(true)
    expectNoCanary(markdown, json, invocation.stdout, invocation.stderr)
    // Nothing else was written: the sample HOME and the vault outside the report directory are
    // byte-identical, and the one-shot stateDir is gone.
    expect(snapshot(HOME)).toEqual(homeBefore)
    expect(snapshot(vault, [reportDir])).toEqual(vaultBefore)
    expect(stateDirsLeft()).toEqual([])
  }, 120_000)

  it('a second run in the same directory compares with the first and replaces only its own files (--json summary)', async () => {
    const before = reportFiles()
    const invocation = await invoke(['doctor', 'checkup', '--report', reportDir, '--json'])
    expect(invocation.code, invocation.stderr).toBe(0)
    const summary = JSON.parse(invocation.stdout)
    expect(summary).toMatchObject({
      verdict: expect.stringMatching(/^(pass|warn|fail|not-applicable|undetermined)$/),
      compare: { status: 'compared', issues: { added: 0, fixed: 0, firstCheck: 0, notChecked: 0 } },
      readonlyAudit: { protectedEntries: expect.any(Number), sidecarsTouched: 0 },
      worker: { stdoutLines: 0, stderrLines: 0 }
    })
    expect([...summary.written].sort()).toEqual(before)
    expect(reportFiles()).toEqual(before)
    const markdownName = before.find((name) => REPORT_FILE_PATTERN.exec(name)?.[3] === 'md')!
    const markdown = fs.readFileSync(path.join(reportDir, markdownName), 'utf8')
    expect(markdown).toMatch(/和上次比（上次 \d{4}-\d{2}-\d{2}）：新增问题 0 项，已修复 0 项/)
    expect(markdown).toContain('## 和上次比')
    expect(JSON.stringify(summary)).not.toMatch(/\/|\\/)
    expect(stateDirsLeft()).toEqual([])
  }, 120_000)

  it('--json alone prints the full report and writes no file; --compare none switches the comparison off', async () => {
    const before = snapshot(reportDir)
    const jsonOnly = await invoke(['doctor', 'checkup', '--json'])
    expect(jsonOnly.code, jsonOnly.stderr).toBe(0)
    const report = JSON.parse(jsonOnly.stdout)
    expect(validate(report)).toBe(true)
    expectNoCanary(jsonOnly.stdout)
    expect(snapshot(reportDir)).toEqual(before)
    const disabled = await invoke(['doctor', 'checkup', '--report', reportDir, '--json', '--compare', 'none'], fake('report', passReport()))
    expect(disabled.code).toBe(0)
    expect(JSON.parse(disabled.stdout).compare).toEqual({ status: 'disabled' })
    const markdown = await invoke(['doctor', 'checkup'], fake('report', passReport()))
    expect(markdown.code).toBe(0)
    expect(markdown.stdout.split('\n')[0]).toBe(MARKDOWN_MARKER)
    expect(markdown.stdout).toContain('## 总评：通过')
  }, 120_000)

  it('writes <name>.md and <name>.json for a .md target; the digest links nothing then', async () => {
    clearReports()
    const target = path.join(reportDir, '自选.md')
    const invocation = await invoke(['doctor', 'checkup', '--report', target], fake('report', passReport()))
    expect(invocation.code, invocation.stderr).toBe(0)
    expect(fs.readFileSync(target, 'utf8').split('\n')[0]).toBe(MARKDOWN_MARKER)
    expect(JSON.parse(fs.readFileSync(path.join(reportDir, '自选.json'), 'utf8')).schemaVersion).toBe(1)
    expect(reportFiles()).toEqual(['自选.json', '自选.md'])
    expect(invocation.stdout).not.toContain('[[')
    expect(invocation.stdout).toMatch(/ · 数字均为 \[R\]\n$/)
    fs.rmSync(target)
    fs.rmSync(path.join(reportDir, '自选.json'))
  }, 60_000)

  it('--fail-on turns the overall verdict into exit 4 and still writes the report', async () => {
    clearReports()
    const failing = await invoke(['doctor', 'checkup', '--report', reportDir, '--fail-on', 'fail'], fake('report', mixedReport()))
    expect(failing.code).toBe(4)
    const names = reportFileNames(mixedReport())
    expect(reportFiles()).toEqual([names.json, names.markdown, names.latest].sort())
    const warnOnPass = await invoke(['doctor', 'checkup', '--report', reportDir, '--fail-on', 'warn'], fake('report', passReport()))
    expect(warnOnPass.code).toBe(0)
    const warnOnFail = await invoke(['doctor', 'checkup', '--json', '--fail-on', 'warn'], fake('report', mixedReport()))
    expect(warnOnFail.code).toBe(4)
    const never = await invoke(['doctor', 'checkup', '--json', '--fail-on', 'never'], fake('report', mixedReport()))
    expect(never.code).toBe(0)
    clearReports()
  }, 60_000)

  it('exit 3: the --compare file does not exist (nothing runs)', async () => {
    const invocation = await invoke(['doctor', 'checkup', '--report', reportDir, '--compare', path.join(reportDir, 'missing.json')], fake('exit', null, { FAKE_WORKER_EXIT: '0' }))
    expect(invocation.code).toBe(3)
    expect(errorOf(invocation)).toMatchObject({ code: 'compare-file-missing' })
    expect(invocation.stdout).toBe('')
    expect(reportFiles()).toEqual([])
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 1: a --compare report from another machine, without fingerprint, or not a v1 report', async () => {
    const dir = tempDir('checkup-compare-')
    // The fixture's fingerprint (a1b2c3d4) is not this machine's.
    const foreign = mixedReport()
    expect(saltFingerprint(derivePrivacySalt())).not.toBe(foreign.saltFingerprint)
    const legacy = mixedReport()
    delete legacy.saltFingerprint
    const cases: Array<[string, string]> = [
      [JSON.stringify(foreign), 'compare-fingerprint-mismatch'],
      [JSON.stringify(legacy), 'compare-fingerprint-missing'],
      ['{"schemaVersion":1}', 'compare-file-unreadable'],
      ['not json', 'compare-file-unreadable']
    ]
    for (const [content, code] of cases) {
      const file = path.join(dir, `${code}.json`)
      fs.writeFileSync(file, content)
      const invocation = await invoke(['doctor', 'checkup', '--compare', file, '--json'], fake('report'))
      expect(invocation.code, code).toBe(1)
      expect(errorOf(invocation), code).toMatchObject({ code })
      expect(invocation.stdout, code).toBe('')
    }
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 1: unknown sources or options, bad --fail-on, stray arguments', async () => {
    const cases: Array<[string[], string]> = [
      [['--sources', 'claude-code,not-a-source'], 'checkup-sources-invalid'],
      [['--fail-on', 'sometimes'], 'checkup-fail-on-invalid'],
      [['--day', '2026-09-26'], 'checkup-unknown-option'],
      [['--seed', 'x'], 'checkup-unknown-option'],
      [['extra'], 'checkup-usage'],
      [['--report'], 'checkup-usage']
    ]
    for (const [args, code] of cases) {
      const invocation = await invoke(['doctor', 'checkup', ...args], fake('report'))
      expect(invocation.code, args.join(' ')).toBe(1)
      expect(errorOf(invocation), args.join(' ')).toMatchObject({ code })
    }
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 1: --report inside a source root, Swob state, App Support/Swob, <library>/.swob, a session package, missing, linked or not Markdown', async () => {
    const swobState = mkdir(HOME, '.claude-session-manager')
    const appSupport = mkdir(HOME, 'Library', 'Application Support', 'Swob')
    const elsewhere = tempDir('checkup-elsewhere-')
    fs.symlinkSync(elsewhere, path.join(vault, 'linked-reports'))
    fs.writeFileSync(path.join(vault, 'notes.txt'), 'x')
    const homeBefore = snapshot(HOME)
    const vaultBefore = snapshot(vault)
    const cases: Array<[string, string]> = [
      [path.join(HOME, '.claude', 'projects'), 'report-target-in-source-root'],
      [path.join(HOME, '.codex', 'report.md'), 'report-target-in-source-root'],
      [swobState, 'report-target-in-swob-state'],
      [appSupport, 'report-target-in-app-support'],
      [path.join(vault, '.swob', 'index'), 'report-target-in-library-state'],
      [sessionPackage, 'report-target-in-session-package'],
      [path.join(vault, 'missing'), 'report-target-missing'],
      [path.join(vault, 'linked-reports'), 'report-target-symlink'],
      [path.join(vault, 'notes.txt'), 'report-target-not-markdown']
    ]
    try {
      for (const [target, code] of cases) {
        const invocation = await invoke(['doctor', 'checkup', '--report', target], fake('report'))
        expect(invocation.code, code).toBe(1)
        expect(errorOf(invocation), code).toMatchObject({ code })
        expect(invocation.stderr.includes(SANDBOX), code).toBe(false)
      }
      expect(snapshot(HOME)).toEqual(homeBefore)
      expect(snapshot(vault)).toEqual(vaultBefore)
      expect(fs.readdirSync(elsewhere)).toEqual([])
      expect(stateDirsLeft()).toEqual([])
    } finally {
      fs.rmSync(swobState, { recursive: true, force: true })
      fs.rmSync(path.join(HOME, 'Library'), { recursive: true, force: true })
      fs.rmSync(path.join(vault, 'linked-reports'))
      fs.rmSync(path.join(vault, 'notes.txt'))
    }
  })

  it('exit 1: never overwrites a same-name file this command did not write', async () => {
    clearReports()
    const latest = path.join(reportDir, `最新-${MACHINE_TAG}.md`)
    fs.writeFileSync(latest, '# 我自己的笔记\n')
    const first = await invoke(['doctor', 'checkup', '--report', reportDir], fake('report'))
    expect(first.code).toBe(1)
    expect(errorOf(first)).toMatchObject({ code: 'report-target-not-own-file' })
    expect(fs.readFileSync(latest, 'utf8')).toBe('# 我自己的笔记\n')
    expect(reportFiles()).toEqual([`最新-${MACHINE_TAG}.md`])
    fs.rmSync(latest)
    // Same rule for the JSON twin of a .md target, checked again right before writing.
    fs.writeFileSync(path.join(reportDir, '笔记.json'), '{"mine":true}')
    const second = await invoke(['doctor', 'checkup', '--report', path.join(reportDir, '笔记.md')], fake('report'))
    expect(second.code).toBe(1)
    expect(errorOf(second)).toMatchObject({ code: 'report-target-not-own-file' })
    expect(reportFiles()).toEqual(['笔记.json'])
    clearReports()
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 5: the stateDir guard, the worker isolation self-check and the read-only audit fail closed', async () => {
    clearReports()
    // a. TMPDIR inside HOME: the one-shot stateDir would overlap a protected location.
    const insideHome = mkdir(HOME, 'tmp-inside-home')
    const launcher = fake('report')
    const previousTmp = process.env.TMPDIR
    process.env.TMPDIR = insideHome
    try {
      const stateGuard = await invoke(['doctor', 'checkup', '--report', reportDir], launcher)
      expect(stateGuard.code).toBe(5)
      expect(errorOf(stateGuard)).toMatchObject({ code: 'state-dir-overlaps-protected' })
      expect(fs.readdirSync(insideHome)).toEqual([])
    } finally {
      process.env.TMPDIR = previousTmp
      fs.rmSync(insideHome, { recursive: true, force: true })
    }
    // b. The worker's own isolation self-check failed.
    const selfCheck = await invoke(['doctor', 'checkup', '--report', reportDir], fake('exit', null, { FAKE_WORKER_EXIT: '5' }))
    expect(selfCheck.code).toBe(5)
    expect(errorOf(selfCheck)).toMatchObject({ code: 'checkup-worker-not-isolated' })
    // c. A handed-back report whose readout was not isolated.
    const notIsolated = mixedReport()
    notIsolated.readout = { status: 'undetermined', reason: 'readout.not-isolated' }
    const readout = await invoke(['doctor', 'checkup', '--report', reportDir], fake('report', notIsolated))
    expect(readout.code).toBe(5)
    expect(errorOf(readout)).toMatchObject({ code: 'checkup-worker-not-isolated' })
    // d. Something wrote into ~/.claude-session-manager during the run: the audit refuses the report.
    try {
      const audit = await invoke(['doctor', 'checkup', '--report', reportDir], fake('touch-state'))
      expect(audit.code).toBe(5)
      expect(errorOf(audit)).toMatchObject({ code: 'readonly-audit-changed', retryable: true })
    } finally {
      fs.rmSync(path.join(HOME, '.claude-session-manager'), { recursive: true, force: true })
    }
    expect(reportFiles()).toEqual([])
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 6: the Swob app is running (pgrep -x Swob), nothing runs', async () => {
    process.env.FAKE_PGREP_EXIT = '0'
    try {
      const invocation = await invoke(['doctor', 'checkup', '--report', reportDir], fake('report'))
      expect(invocation.code).toBe(6)
      expect(errorOf(invocation)).toMatchObject({ code: 'swob-app-running', retryable: true })
    } finally {
      delete process.env.FAKE_PGREP_EXIT
    }
    expect(reportFiles()).toEqual([])
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 7: a report carrying text that is not whitelisted is refused and no file is written', async () => {
    const leaky = mixedReport()
    leaky.checks[0].headline = CANARY.userText
    expect(validate(leaky)).toBe(true)
    const invocation = await invoke(['doctor', 'checkup', '--report', reportDir, '--json'], fake('report', leaky))
    expect(invocation.code).toBe(7)
    expect(errorOf(invocation)).toMatchObject({ code: 'privacy-rejected' })
    expect(invocation.stdout).toBe('')
    expectNoCanary(invocation.stderr)
    // A leak in a field the owner Markdown never shows (engineerHint) is caught by the JSON scan itself.
    const hidden = mixedReport()
    hidden.checks[0].findings[0].engineerHint = CANARY.absolutePath
    const jsonOnly = await invoke(['doctor', 'checkup', '--report', reportDir], fake('report', hidden))
    expect(jsonOnly.code).toBe(7)
    expect(errorOf(jsonOnly)).toMatchObject({ code: 'privacy-rejected' })
    const workerRefused = await invoke(['doctor', 'checkup', '--report', reportDir], fake('exit', null, { FAKE_WORKER_EXIT: '7' }))
    expect(workerRefused.code).toBe(7)
    expect(reportFiles()).toEqual([])
    expect(stateDirsLeft()).toEqual([])
  })

  it('exit 1: worker crash, silence, timeout, schema-invalid report; worker output is counted, never forwarded', async () => {
    const noisy = await invoke(['doctor', 'checkup', '--report', reportDir], fake('noisy', null))
    expect(noisy.code).toBe(1)
    expect(errorOf(noisy)).toMatchObject({ code: 'checkup-worker-failed', workerExit: 1, workerStdoutLines: 1, workerStderrLines: 2 })
    expectNoCanary(noisy.stdout, noisy.stderr)
    const silent = await invoke(['doctor', 'checkup', '--report', reportDir], fake('no-report', null))
    expect(errorOf(silent)).toMatchObject({ code: 'checkup-worker-no-report' })
    const slow = await invoke(['doctor', 'checkup', '--report', reportDir], { ...fake('sleep', null), timeoutMs: 300 })
    expect(slow.code).toBe(1)
    expect(errorOf(slow)).toMatchObject({ code: 'checkup-worker-timeout' })
    const invalid = clone(mixedReport()) as unknown as Record<string, unknown>
    invalid.unexpectedField = 1
    const schemaInvalid = await invoke(['doctor', 'checkup', '--report', reportDir], fake('report', invalid as unknown as CheckupReport))
    expect(schemaInvalid.code).toBe(1)
    expect(errorOf(schemaInvalid)).toMatchObject({ code: 'report-schema-invalid' })
    const missing = await invoke(['doctor', 'checkup', '--report', reportDir], { workerPath: path.join(reportDir, 'no-such-worker.js') })
    expect(errorOf(missing)).toMatchObject({ code: 'checkup-worker-missing' })
    expect(reportFiles()).toEqual([])
    expect(stateDirsLeft()).toEqual([])
  }, 60_000)

  it('refuses Windows before touching anything (runtimeHome ignores HOME there)', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: 'win32' })
    let stderr = ''
    try {
      const code = await runDoctorCheckup([], { report: reportDir }, {
        io: { stdout: () => {}, stderr: (value) => { stderr += value } },
        realHome: HOME,
        libraryRoot: vault,
        kernelVersion: '1.4.0',
        worker: fake('report')
      })
      expect(code).toBe(1)
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
    expect(JSON.parse(stderr).error).toMatchObject({ code: 'checkup-windows-unsupported' })
    expect(reportFiles()).toEqual([])
  })
})

/** Runtime closure over relative imports; ESM-style `./x.js` specifiers (packages/core) resolve to their `.ts` sources. */
function runtimeClosure(entry: string): string[] {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const fileName = pending.pop()!
    if (seen.has(fileName)) continue
    seen.add(fileName)
    if (!/\.(?:ts|tsx|mts|cts)$/.test(fileName)) continue
    for (const specifier of runtimeRelativeImports(fs.readFileSync(fileName, 'utf8'), fileName)) {
      let resolved: string
      try {
        resolved = resolveTypeScriptImport(fileName, specifier)
      } catch (error) {
        if (!specifier.endsWith('.js')) throw error
        resolved = resolveTypeScriptImport(fileName, specifier.slice(0, -3))
      }
      pending.push(resolved)
    }
  }
  return [...seen]
}

describe('module boundary of the CLI side', () => {
  const rel = (fileName: string): string => path.relative(ROOT, fileName).split(path.sep).join('/')

  it('the CLI never loads the checkup kernel side (worker, run, readout, census)', () => {
    const checkup = runtimeClosure(path.join(ROOT, 'src', 'cli', 'index.ts')).map(rel).filter((fileName) => fileName.startsWith('src/checkup/'))
    expect(checkup).toContain('src/checkup/run-guard.ts')
    for (const fileName of checkup) {
      expect(/^src\/checkup\/(?:cli-worker|run|readout)\.ts$|^src\/checkup\/census\//.test(fileName), fileName).toBe(false)
    }
  })

  it('only the CLI entry imports checkup-command (so its __dirname is the directory of cli.js)', () => {
    const importers: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && /['"][./]+(?:cli\/)?checkup-command['"]/.test(fs.readFileSync(full, 'utf8'))) importers.push(rel(full))
      }
    }
    walk(path.join(ROOT, 'src'))
    expect(importers).toEqual(['src/cli/index.ts'])
  })
})
