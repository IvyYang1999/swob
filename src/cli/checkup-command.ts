/**
 * `swob doctor checkup` (task C1b deliverables 4–5): the CLI side of the kernel checkup.
 *
 * The checkup never runs in this process: the kernel captured the real HOME
 * when the CLI loaded, so runKernelCheckup runs in the isolated child process
 * (src/checkup/cli-worker.ts; the `checkup-worker` build entry, shipped next to
 * cli.js). This module owns everything around it, in the order of the task:
 *
 *   1. platform (win32 → 1)
 *   2. arguments, the --compare file (missing → 3) and the --report target
 *   3. Swob app running (pgrep -x Swob → 6)
 *   4. one-shot stateDir in os.tmpdir(), validateStateDir (→ 5)
 *   5. metadata audit snapshot, then buildIsolatedHome
 *   6. spawn the worker with process.execPath (timeout; SIGINT/SIGTERM kill it)
 *   7. cleanup: isolated home, the handed-back report file, the stateDir itself
 *   8. read-only audit comparison (→ 5)
 *   9. JSON Schema (Ajv 2020) and JSON privacy scan (→ 7)
 *  10. previous report (explicit, or the latest comparable one in --report's directory)
 *  11. Markdown and digest, both privacy-scanned (→ 7)
 *  12. atomic writes, output, --fail-on (→ 4)
 *
 * Nothing but the --report files is written, and only over files this command
 * wrote before (first-line marker / v1 report). Errors and stderr carry reason
 * codes and counts, never paths; the worker's own output is only counted.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js'
import reportSchema from '../checkup/contract/kernel-checkup-report-v1.schema.json'
import { SOURCE_IDS, type CheckupReport, type Verdict } from '../checkup/contract'
import { compareCheckupReports, type CheckupComparison } from '../checkup/compare'
import { checkupDigest } from '../checkup/digest'
import { buildIsolatedHome, cleanupIsolatedHome, protectedLocations, validateStateDir, type IsolatedHome } from '../checkup/isolated-home'
import { PrivacyViolationError, derivePrivacySalt, saltFingerprint, scanForPrivacy } from '../checkup/privacy'
import {
  MARKDOWN_MARKER,
  REPORT_BASENAME_PATTERN,
  REPORT_FILE_PATTERN,
  localTime,
  renderCheckupMarkdown,
  reportFileNames
} from '../checkup/render-markdown'
import {
  CHECKUP_KERNEL_VERSION,
  CHECKUP_WORKER_EXIT,
  auditHeld,
  auditTargets,
  compareAudit,
  isolatedWorkerEnv,
  readMachineModel,
  reportTargetVerdict,
  swobAppRunning,
  takeAudit,
  type AuditResult
} from '../checkup/run-guard'

/** Exit codes of `swob doctor checkup` (4–7 are registered in CLI_EXIT_CODES for this command). */
export const CHECKUP_EXIT = { ok: 0, error: 1, compareMissing: 3, failOn: 4, notReadOnly: 5, appRunning: 6, privacy: 7 } as const

/** Test seam (runCli options.checkupWorker): how the worker is started. Production passes nothing. */
export interface CheckupWorkerLaunch {
  /** Script run with process.execPath; default: the worker next to the CLI bundle. */
  workerPath?: string
  /** Extra worker environment (tests: NODE_PATH to the repository's node_modules). */
  env?: Record<string, string>
  /** Kill the worker after this many milliseconds (default 10 minutes). */
  timeoutMs?: number
}

export interface DoctorCheckupContext {
  io: { stdout: (value: string) => void; stderr: (value: string) => void }
  /** The account home whose sources are checked (runtimeHome()). */
  realHome: string
  /** The CLI's library root after its read-only initLibrary (getLibraryRoot()). */
  libraryRoot: string | null
  /** Version stamped into the report as kernel.version (CLI_VERSION). */
  kernelVersion: string
  worker?: CheckupWorkerLaunch
}

type FailOn = 'fail' | 'warn' | 'never'

const WORKER_TIMEOUT_MS = 10 * 60_000
const KILL_GRACE_MS = 5_000
const WORKER_REPORT_NAME = 'checkup-report.json'
const MAX_REPORT_BYTES = 64 * 1024 * 1024
const KNOWN_FLAGS = new Set(['report', 'json', 'sources', 'compare', 'fail-on'])
const FAIL_ON: readonly FailOn[] = ['fail', 'warn', 'never']
const USAGE = '用法: swob doctor checkup [--report <目录|文件.md>] [--json] [--sources a,b] [--compare <上次.json>|none] [--fail-on fail|warn|never]'

/** Owner-readable text of every failure code (stderr; no paths, no report content). */
const FAILURE_TEXT: Readonly<Record<string, string>> = {
  'checkup-windows-unsupported': 'Windows 上暂不支持 doctor checkup：隔离 HOME 的办法在 Windows 上不成立',
  'checkup-usage': USAGE,
  'checkup-unknown-option': `不认识的选项。${USAGE}`,
  'checkup-sources-invalid': '--sources 里有不认识的来源',
  'checkup-fail-on-invalid': '--fail-on 只能是 fail、warn 或 never',
  'checkup-home-invalid': 'HOME 不是一个存在的目录',
  'checkup-worker-missing': '找不到体检子进程的入口文件，安装可能不完整',
  'report-target-not-markdown': '--report 要么是已存在的目录，要么是以 .md 结尾的文件路径',
  'report-target-missing': '--report 的目录（或文件所在的目录）不存在',
  'report-target-not-directory': '--report 的目录不是目录',
  'report-target-not-file': '--report 的目标文件位置上已有不是普通文件的东西',
  'report-target-symlink': '--report 的目标是符号链接，拒绝写入',
  'report-target-in-state-dir': '--report 不能写进体检自己的临时目录',
  'report-target-in-swob-state': '--report 不能写进 Swob 的状态目录 ~/.claude-session-manager',
  'report-target-in-app-support': '--report 不能写进 ~/Library/Application Support/Swob',
  'report-target-in-source-root': '--report 不能写进任何会话来源目录',
  'report-target-in-library-state': '--report 不能写进库的 .swob 目录',
  'report-target-in-session-package': '--report 不能写进会话包目录',
  'report-target-not-own-file': '目标位置已有同名文件，而且不是本命令写的，不覆盖',
  'compare-file-missing': '--compare 指定的文件不存在',
  'compare-file-unreadable': '--compare 指定的文件读不了，或不是 v1 体检报告',
  'compare-fingerprint-missing': '--compare 指定的报告没有机器指纹（旧版体检生成的），不能比对',
  'compare-fingerprint-mismatch': '--compare 指定的报告来自另一台机器（机器指纹不同），不能比对',
  'swob-app-running': 'Swob app 正在运行（pgrep -x Swob），先退出 app 再体检',
  'state-dir-missing': '临时状态目录没有通过校验，未运行体检',
  'state-dir-not-directory': '临时状态目录没有通过校验，未运行体检',
  'state-dir-not-empty': '临时状态目录没有通过校验，未运行体检',
  'state-dir-outside-temp': '临时状态目录不在系统临时目录里，未运行体检',
  'state-dir-overlaps-protected': '临时状态目录和受保护的位置重叠，未运行体检',
  'checkup-worker-not-isolated': '体检子进程的隔离自检没有通过，未运行体检',
  'checkup-worker-failed': '体检子进程失败，未写报告',
  'checkup-worker-timeout': '体检子进程超时，已终止，未写报告',
  'checkup-interrupted': '体检被中断，已终止子进程，未写报告',
  'checkup-worker-no-report': '体检子进程没有交回报告',
  'state-dir-cleanup-incomplete': '临时状态目录没有删干净，未写报告',
  'readonly-audit-changed': '体检期间受保护的位置有变化，只读保证不成立，未写报告',
  'report-unreadable': '体检子进程交回的报告读不了',
  'report-schema-invalid': '体检报告没有通过 JSON Schema 校验，未写报告',
  'report-no-fingerprint': '体检报告没有机器指纹，无法生成带机器标签的文件名',
  'privacy-rejected': '隐私扫描拒绝了报告，未写任何文件',
  'report-write-failed': '写报告文件失败，一个文件都没有落地',
  'checkup-failed': '体检失败'
}

const RETRYABLE = new Set(['swob-app-running', 'readonly-audit-changed', 'checkup-worker-timeout', 'checkup-interrupted'])

class CheckupFailure extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    readonly details: Readonly<Record<string, number | string | null>> = {}
  ) {
    super(code)
    this.name = 'CheckupFailure'
  }
}

function fail(exitCode: number, code: string, details?: Record<string, number | string | null>): never {
  throw new CheckupFailure(exitCode, code, details)
}

// —— small file-system helpers (read only unless stated) ——

function realDirectory(target: string): string | null {
  try {
    const real = fs.realpathSync.native(target)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

function realOrResolved(target: string): string {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return path.resolve(target)
  }
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

let cachedValidator: ValidateFunction | null = null
function validateReport(value: unknown): value is CheckupReport {
  cachedValidator ??= new Ajv2020({ allErrors: true, strict: true }).compile(reportSchema)
  return cachedValidator(value) === true
}

/** A v1 checkup report file, or why not ('missing' only when nothing is there). */
function readReportFile(file: string): { report: CheckupReport } | { error: 'missing' | 'unreadable' } {
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return { error: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable' }
  }
  if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) return { error: 'unreadable' }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return validateReport(value) ? { report: value } : { error: 'unreadable' }
  } catch {
    return { error: 'unreadable' }
  }
}

// —— arguments ——

interface CheckupOptions {
  report: string | null
  json: boolean
  sources: string[] | null
  /** A file path, 'none', or null (automatic: the latest comparable report next to --report). */
  compare: string | null
  failOn: FailOn
}

function flagValue(flags: Record<string, string | true>, key: string): string | null {
  const value = flags[key]
  if (value === undefined) return null
  if (value === true || value === '') fail(CHECKUP_EXIT.error, 'checkup-usage')
  return value
}

function parseCheckupOptions(args: readonly string[], flags: Record<string, string | true>): CheckupOptions {
  if (args.length > 0) fail(CHECKUP_EXIT.error, 'checkup-usage')
  for (const key of Object.keys(flags)) if (!KNOWN_FLAGS.has(key)) fail(CHECKUP_EXIT.error, 'checkup-unknown-option')
  if (flags.json !== undefined && flags.json !== true) fail(CHECKUP_EXIT.error, 'checkup-usage')
  const sourcesText = flagValue(flags, 'sources')
  let sources: string[] | null = null
  if (sourcesText !== null) {
    const list = sourcesText.split(',').map((source) => source.trim())
    // run.ts silently drops unknown ids; the CLI refuses them instead.
    if (list.some((source) => !(SOURCE_IDS as readonly string[]).includes(source))) fail(CHECKUP_EXIT.error, 'checkup-sources-invalid')
    sources = [...new Set(list)]
  }
  const failOn = flagValue(flags, 'fail-on') ?? 'never'
  if (!(FAIL_ON as readonly string[]).includes(failOn)) fail(CHECKUP_EXIT.error, 'checkup-fail-on-invalid')
  return {
    report: flagValue(flags, 'report'),
    json: flags.json === true,
    sources,
    compare: flagValue(flags, 'compare'),
    failOn: failOn as FailOn
  }
}

// —— --report target ——

interface ReportTarget {
  kind: 'directory' | 'file'
  /** Real directory the files land in. */
  directory: string
  /** File mode: the Markdown file name. */
  markdownName: string | null
}

interface TargetContext { realHome: string; libraryRoot: string | null }

function resolveReportTarget(raw: string, context: TargetContext): ReportTarget {
  const requested = path.resolve(raw)
  if (/\.md$/i.test(requested)) {
    const verdict = reportTargetVerdict(requested, { ...context, kind: 'file' })
    if (!verdict.ok) fail(CHECKUP_EXIT.error, verdict.reason)
    return { kind: 'file', directory: verdict.directory, markdownName: path.basename(verdict.target) }
  }
  const verdict = reportTargetVerdict(requested, { ...context, kind: 'directory' })
  if (!verdict.ok) fail(CHECKUP_EXIT.error, verdict.reason === 'report-target-not-directory' ? 'report-target-not-markdown' : verdict.reason)
  return { kind: 'directory', directory: verdict.directory, markdownName: null }
}

interface PlannedFiles { json: string; markdown: string; latest: string | null; link: string | null }

/** Directory: Swob内核体检-<date>-<tag>.md/.json + 最新-<tag>.md; file: <name>.md + <name>.json. */
function plannedFiles(target: ReportTarget, report: Pick<CheckupReport, 'generatedAt' | 'saltFingerprint'>): PlannedFiles {
  if (target.kind === 'file' && target.markdownName) {
    const base = target.markdownName.slice(0, -3)
    return { json: `${base}.json`, markdown: target.markdownName, latest: null, link: REPORT_BASENAME_PATTERN.test(base) ? base : null }
  }
  const names = reportFileNames(report)
  return { json: names.json, markdown: names.markdown, latest: names.latest, link: names.base }
}

function fileNames(files: PlannedFiles): string[] {
  return [files.json, files.markdown, ...(files.latest ? [files.latest] : [])]
}

function isOwnMarkdown(file: string): boolean {
  let handle: number | null = null
  try {
    handle = fs.openSync(file, 'r')
    const buffer = Buffer.alloc(256)
    const read = fs.readSync(handle, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, read).toString('utf8').split('\n')[0].replace(/\r$/, '') === MARKDOWN_MARKER
  } catch {
    return false
  } finally {
    if (handle !== null) fs.closeSync(handle)
  }
}

function isOwnJson(file: string): boolean {
  try {
    if (fs.statSync(file).size > MAX_REPORT_BYTES) return false
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as { schemaVersion?: unknown; kernel?: { checkupVersion?: unknown } } | null
    return value?.schemaVersion === 1 && typeof value.kernel?.checkupVersion === 'string'
  } catch {
    return false
  }
}

/** Every file may be written: allowed location, a regular file if present, and written by this command before. */
function assertWritable(directory: string, names: readonly string[], context: TargetContext): void {
  for (const name of names) {
    const file = path.join(directory, name)
    const verdict = reportTargetVerdict(file, { ...context, kind: 'file' })
    if (!verdict.ok) fail(CHECKUP_EXIT.error, verdict.reason)
    if (!lstatOrNull(file)) continue
    if (!(name.endsWith('.json') ? isOwnJson(file) : isOwnMarkdown(file))) fail(CHECKUP_EXIT.error, 'report-target-not-own-file')
  }
}

/**
 * Write every file or none: all contents go to dot-prefixed temp files first; each existing file is
 * moved aside before its replacement is renamed into place, and restored if any later step fails.
 */
function writeFilesAtomically(directory: string, entries: ReadonlyArray<{ name: string; content: string }>): void {
  const nonce = `${process.pid}-${randomBytes(4).toString('hex')}`
  const staged: Array<{ target: string; temp: string; backup: string | null; placed: boolean }> = []
  try {
    for (const entry of entries) {
      const temp = path.join(directory, `.${entry.name}.swob-tmp-${nonce}`)
      fs.writeFileSync(temp, entry.content, { flag: 'wx' })
      staged.push({ target: path.join(directory, entry.name), temp, backup: null, placed: false })
    }
    for (const item of staged) {
      if (lstatOrNull(item.target)) {
        item.backup = path.join(directory, `.${path.basename(item.target)}.swob-bak-${nonce}`)
        fs.renameSync(item.target, item.backup)
      }
      fs.renameSync(item.temp, item.target)
      item.placed = true
    }
  } catch {
    for (const item of [...staged].reverse()) {
      try {
        if (item.placed && !item.backup) fs.rmSync(item.target, { force: true })
        if (item.backup) fs.renameSync(item.backup, item.target)
      } catch { /* best effort: keep rolling back the others */ }
      try { fs.rmSync(item.temp, { force: true }) } catch { /* already moved or never written */ }
    }
    fail(CHECKUP_EXIT.error, 'report-write-failed')
  }
  for (const item of staged) {
    if (item.backup) {
      try { fs.rmSync(item.backup, { force: true }) } catch { /* a leftover dot-file backup is harmless */ }
    }
  }
}

// —— previous report ——

function loadExplicitPrevious(raw: string, machineFingerprint: string): CheckupReport {
  const read = readReportFile(path.resolve(raw))
  if ('error' in read) fail(read.error === 'missing' ? CHECKUP_EXIT.compareMissing : CHECKUP_EXIT.error, read.error === 'missing' ? 'compare-file-missing' : 'compare-file-unreadable')
  const fingerprint = read.report.saltFingerprint
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{8}$/.test(fingerprint)) fail(CHECKUP_EXIT.error, 'compare-fingerprint-missing')
  if (fingerprint !== machineFingerprint) fail(CHECKUP_EXIT.error, 'compare-fingerprint-mismatch')
  return read.report
}

/**
 * The latest comparable earlier report in `directory`: only `Swob内核体检-<date>-<tag>.json` files of this
 * machine's tag, v1, the same saltFingerprint and scope kind; newest by the report's own generatedAt
 * (sync tools rewrite mtimes). Chosen before anything is written, so a same-day rerun compares with the
 * earlier run and then replaces it.
 */
function findPreviousReport(directory: string, current: CheckupReport): CheckupReport | null {
  const fingerprint = current.saltFingerprint
  if (typeof fingerprint !== 'string') return null
  const currentAt = Date.parse(current.generatedAt)
  let names: string[] = []
  try { names = fs.readdirSync(directory) } catch { return null }
  let best: CheckupReport | null = null
  let bestAt = Number.NEGATIVE_INFINITY
  for (const name of names) {
    const match = REPORT_FILE_PATTERN.exec(name)
    if (!match || match[3] !== 'json' || match[2] !== fingerprint.slice(0, 6)) continue
    const file = path.join(directory, name)
    if (!lstatOrNull(file)?.isFile()) continue
    const read = readReportFile(file)
    if ('error' in read) continue
    const candidate = read.report
    if (candidate.saltFingerprint !== fingerprint || candidate.scope?.kind !== current.scope.kind) continue
    const at = Date.parse(candidate.generatedAt)
    if (!Number.isFinite(at) || !(at < currentAt) || at <= bestAt) continue
    best = candidate
    bestAt = at
  }
  return best
}

type CompareMode = 'auto' | 'explicit' | 'disabled'

function compareSummary(mode: CompareMode, comparison: CheckupComparison | null): Record<string, unknown> {
  if (mode === 'disabled') return { status: 'disabled' }
  if (!comparison) return { status: 'none' }
  if (!comparison.comparable || !comparison.issues) return { status: 'refused', reason: comparison.refusal ?? null }
  const { issues, units } = comparison
  return {
    status: 'compared',
    previousDate: localTime(comparison.previous.generatedAt).date,
    issues: {
      added: issues.added.length,
      fixed: issues.fixed.length,
      unchanged: issues.unchanged.length,
      firstCheck: issues.firstCheck.length,
      notChecked: issues.notChecked.length
    },
    units: units
      ? { compared: units.compared, newOrChanged: units.newOrChanged, gone: units.gone, changedDuringRun: units.changedDuringRun }
      : null
  }
}

// —— the worker ——

/**
 * This module is bundled into cli.js itself (only the CLI entry imports it), so __dirname is cli.js's
 * directory: out/main in a build, Resources/cli in the packaged app, where the worker ships next to it.
 */
function defaultWorkerPath(): string {
  return path.join(__dirname, 'checkup-worker.js')
}

interface WorkerOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  interrupted: boolean
  stdoutLines: number
  stderrLines: number
}

function lineCounter(): { push: (chunk: Buffer) => void; total: () => number } {
  let lines = 0
  let open = false
  return {
    push: (chunk) => {
      for (const byte of chunk) {
        if (byte === 0x0a) {
          lines++
          open = false
        } else {
          open = true
        }
      }
    },
    total: () => lines + (open ? 1 : 0)
  }
}

/** Run the worker; its stdout/stderr are counted, never forwarded (they may contain paths). */
function runWorker(workerPath: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<WorkerOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = lineCounter()
    const stderr = lineCounter()
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    let timedOut = false
    let interrupted = false
    let settled = false
    let killTimer: NodeJS.Timeout | null = null
    const running = (): boolean => child.exitCode === null && child.signalCode === null
    const terminate = (): void => {
      if (!running()) return
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => { if (running()) child.kill('SIGKILL') }, KILL_GRACE_MS)
    }
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    const onSignal = (): void => {
      interrupted = true
      terminate()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killTimer) clearTimeout(killTimer)
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      resolve({ code, signal, timedOut, interrupted, stdoutLines: stdout.total(), stderrLines: stderr.total() })
    }
    // Only a spawn failure ends the run here; any later error is followed by 'close'.
    child.on('error', () => { if (child.pid === undefined) finish(null, null) })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

function readWorkerReport(file: string): string | null {
  const stat = lstatOrNull(file)
  if (!stat?.isFile() || stat.size > MAX_REPORT_BYTES) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function createStateDir(realHome: string, libraryRoot: string | null): string {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-checkup-'))
  const verdict = validateStateDir({
    stateDir: created,
    realHome,
    protected: [...protectedLocations(realHome), ...(libraryRoot ? [realOrResolved(libraryRoot)] : [])]
  })
  if (!verdict.ok) {
    fs.rmSync(created, { recursive: true, force: true })
    fail(CHECKUP_EXIT.notReadOnly, verdict.reason)
  }
  return verdict.stateDir
}

function failOnTriggered(failOn: FailOn, verdict: Verdict): boolean {
  if (failOn === 'fail') return verdict === 'fail'
  if (failOn === 'warn') return verdict === 'warn' || verdict === 'fail'
  return false
}

// —— the command ——

async function doctorCheckup(args: readonly string[], flags: Record<string, string | true>, ctx: DoctorCheckupContext): Promise<number> {
  // 1. Platform: runtimeHome() ignores HOME on Windows, so the symlinked HOME cannot isolate the kernel.
  if (process.platform === 'win32') fail(CHECKUP_EXIT.error, 'checkup-windows-unsupported')

  // 2. Arguments, the --compare file and the --report target (nothing is created yet).
  const options = parseCheckupOptions(args, flags)
  const realHome = realDirectory(ctx.realHome) ?? fail(CHECKUP_EXIT.error, 'checkup-home-invalid')
  const targetContext: TargetContext = { realHome, libraryRoot: ctx.libraryRoot }
  const target = options.report !== null ? resolveReportTarget(options.report, targetContext) : null
  const workerPath = ctx.worker?.workerPath ?? defaultWorkerPath()
  if (!lstatOrNull(workerPath)?.isFile()) fail(CHECKUP_EXIT.error, 'checkup-worker-missing')
  // Same machine identifier as the worker (the salt stays in memory, never passed on).
  const machineFingerprint = saltFingerprint(derivePrivacySalt())
  const compareMode: CompareMode = options.compare === 'none' ? 'disabled' : options.compare !== null ? 'explicit' : 'auto'
  const explicitPrevious = compareMode === 'explicit' ? loadExplicitPrevious(options.compare!, machineFingerprint) : null
  if (target) {
    // Early refusal with the names this run will most likely use (checked again before writing).
    assertWritable(target.directory, fileNames(plannedFiles(target, { generatedAt: new Date().toISOString(), saltFingerprint: machineFingerprint })), targetContext)
  }

  // 3. The desktop app would write Swob's state while the audit watches it.
  if (swobAppRunning()) fail(CHECKUP_EXIT.appRunning, 'swob-app-running')

  // 4. One-shot stateDir (fail closed).
  const stateDir = createStateDir(realHome, ctx.libraryRoot)

  // 5.–7. Audit snapshot, isolated HOME, the worker, cleanup.
  const targets = auditTargets(realHome, ctx.libraryRoot)
  const before = takeAudit(targets)
  let isolated: IsolatedHome | null = null
  let outcome: WorkerOutcome | null = null
  let reportText: string | null = null
  let cleanupIncomplete = false
  try {
    isolated = buildIsolatedHome({ realHome, stateDir })
    const out = path.join(stateDir, WORKER_REPORT_NAME)
    const workerArgs = ['--home', realHome, '--state', stateDir, '--out', out]
    if (options.sources) workerArgs.push('--sources', options.sources.join(','))
    if (CHECKUP_KERNEL_VERSION.test(ctx.kernelVersion)) workerArgs.push('--kernel-version', ctx.kernelVersion)
    outcome = await runWorker(workerPath, workerArgs, isolatedWorkerEnv(process.env, isolated.env, ctx.worker?.env ?? {}), ctx.worker?.timeoutMs ?? WORKER_TIMEOUT_MS)
    if (outcome.code === CHECKUP_WORKER_EXIT.ok && !outcome.timedOut && !outcome.interrupted) reportText = readWorkerReport(out)
  } finally {
    try {
      if (isolated) cleanupIsolatedHome(isolated)
    } catch {
      cleanupIncomplete = true
    }
    try {
      fs.rmSync(stateDir, { recursive: true, force: true })
    } catch {
      cleanupIncomplete = true
    }
    if (lstatOrNull(stateDir)) cleanupIncomplete = true
  }

  // 8. Read-only audit (SQLite sidecars are recorded, never counted).
  const audit: AuditResult = compareAudit(before, takeAudit(targets), targets, realHome)
  if (!auditHeld(audit)) fail(CHECKUP_EXIT.notReadOnly, 'readonly-audit-changed')
  if (cleanupIncomplete) fail(CHECKUP_EXIT.error, 'state-dir-cleanup-incomplete')
  const worker = { stdoutLines: outcome?.stdoutLines ?? 0, stderrLines: outcome?.stderrLines ?? 0 }
  if (!outcome || outcome.interrupted) fail(CHECKUP_EXIT.error, 'checkup-interrupted')
  if (outcome.timedOut) fail(CHECKUP_EXIT.error, 'checkup-worker-timeout')
  if (outcome.code === CHECKUP_WORKER_EXIT.notIsolated) fail(CHECKUP_EXIT.notReadOnly, 'checkup-worker-not-isolated')
  if (outcome.code === CHECKUP_WORKER_EXIT.privacy) fail(CHECKUP_EXIT.privacy, 'privacy-rejected')
  if (outcome.code !== CHECKUP_WORKER_EXIT.ok) {
    fail(CHECKUP_EXIT.error, 'checkup-worker-failed', { workerExit: outcome.code, workerSignal: outcome.signal, workerStdoutLines: worker.stdoutLines, workerStderrLines: worker.stderrLines })
  }
  if (reportText === null) fail(CHECKUP_EXIT.error, 'checkup-worker-no-report')

  // 9. The handed-back report: isolation, schema, JSON privacy scan.
  let parsed: unknown
  try {
    parsed = JSON.parse(reportText)
  } catch {
    fail(CHECKUP_EXIT.error, 'report-unreadable')
  }
  if ((parsed as CheckupReport | null)?.readout?.reason === 'readout.not-isolated') fail(CHECKUP_EXIT.notReadOnly, 'checkup-worker-not-isolated')
  if (!validateReport(parsed)) fail(CHECKUP_EXIT.error, 'report-schema-invalid')
  const report = parsed
  if (!scanForPrivacy(report).ok) fail(CHECKUP_EXIT.privacy, 'privacy-rejected')
  if (target?.kind === 'directory' && typeof report.saltFingerprint !== 'string') fail(CHECKUP_EXIT.error, 'report-no-fingerprint')

  // 10. Previous report (before anything is written) and the comparison.
  const previous = explicitPrevious ?? (compareMode === 'auto' && target ? findPreviousReport(target.directory, report) : null)
  const comparison = previous ? compareCheckupReports(previous, report) : null
  if (compareMode === 'explicit' && comparison && !comparison.comparable) {
    ctx.io.stderr(`${JSON.stringify({ warning: { code: comparison.refusal ?? 'compare.schema-mismatch', message: '--compare 指定的报告不能和这次比对，报告里写明了原因' } })}\n`)
  }

  // 11. Markdown and digest (each throws PrivacyViolationError instead of returning unregistered text).
  const files = target ? plannedFiles(target, report) : null
  let markdown: string | null = null
  let digest: string | null = null
  try {
    if (target || !options.json) markdown = renderCheckupMarkdown(report, { audience: 'owner', previous, machineModel: readMachineModel() })
    if (files) digest = checkupDigest(report, files.link ? { linkTarget: files.link } : {})
  } catch (error) {
    if (error instanceof PrivacyViolationError) fail(CHECKUP_EXIT.privacy, 'privacy-rejected')
    throw error
  }

  // 12. Files (all or none), output, --fail-on.
  if (target && files && markdown !== null) {
    const entries = [
      { name: files.json, content: `${JSON.stringify(report, null, 2)}\n` },
      { name: files.markdown, content: markdown },
      ...(files.latest ? [{ name: files.latest, content: markdown }] : [])
    ]
    assertWritable(target.directory, entries.map((entry) => entry.name), targetContext)
    writeFilesAtomically(target.directory, entries)
    if (options.json) {
      ctx.io.stdout(`${JSON.stringify({
        verdict: report.verdict,
        written: entries.map((entry) => entry.name),
        compare: compareSummary(compareMode, comparison),
        readonlyAudit: { protectedEntries: audit.protectedEntries, sidecarsTouched: audit.sidecarsTouched.length },
        worker
      }, null, 2)}\n`)
    } else {
      ctx.io.stdout(`${digest}\n`)
    }
  } else if (options.json) {
    ctx.io.stdout(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    ctx.io.stdout(markdown ?? '')
  }
  return failOnTriggered(options.failOn, report.verdict) ? CHECKUP_EXIT.failOn : CHECKUP_EXIT.ok
}

/**
 * Run `swob doctor checkup`; returns the exit code. Every failure is reported on stderr as
 * `{"error":{"message","code","retryable",…}}` with a reason code and counts only: messages or stacks of
 * unexpected errors are never echoed (they may contain paths).
 */
export async function runDoctorCheckup(args: readonly string[], flags: Record<string, string | true>, ctx: DoctorCheckupContext): Promise<number> {
  try {
    return await doctorCheckup(args, flags, ctx)
  } catch (error) {
    const failure = error instanceof CheckupFailure
      ? error
      : new CheckupFailure(CHECKUP_EXIT.error, 'checkup-failed', {
          errorName: error instanceof Error ? error.name.replace(/[^A-Za-z]/g, '').slice(0, 40) : 'unknown',
          errorCode: typeof (error as NodeJS.ErrnoException)?.code === 'string' ? (error as NodeJS.ErrnoException).code!.replace(/[^A-Z0-9_]/g, '').slice(0, 40) : null
        })
    ctx.io.stderr(`${JSON.stringify({
      error: {
        message: FAILURE_TEXT[failure.code] ?? FAILURE_TEXT['checkup-failed'],
        code: failure.code,
        retryable: RETRYABLE.has(failure.code),
        ...failure.details
      }
    })}\n`)
    return failure.exitCode
  }
}
