/**
 * Child-process entry of `swob doctor checkup` (task C1b deliverable 4).
 *
 *   node <worker> --home <real home> --state <stateDir> --out <file in stateDir>
 *                 [--sources a,b] [--kernel-version V]
 *
 * Why a child process: the kernel captures HOME when its modules load
 * (session-loader.ts), and the CLI process has already loaded them with the
 * real HOME. So the CLI spawns this entry with process.execPath and the
 * environment of buildIsolatedHome() (HOME and TMPDIR inside a one-shot
 * stateDir, the three SWOB_* store paths), so that the kernel evaluates here
 * against the isolated HOME. Never a worker thread: a worker's `env` only
 * replaces the JS copy of process.env, while os.homedir() keeps the real HOME.
 *
 * Fail closed: the kernel's own isolation self-check (currentKernelIsolation)
 * must pass before anything runs, and a report whose readout still says
 * readout.not-isolated is not written either (exit notIsolated → CLI 5). The
 * report goes to --out inside the stateDir and the CLI reads it back; stdout
 * is never used for data, because kernel modules may print while they load.
 * The worker itself prints nothing. The privacy salt is derived here from the
 * machine identifier, exactly as in the parent; it is never passed in.
 *
 * Must not import the CLI: src/cli/index.ts runs the CLI when it loads.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SOURCE_IDS, type CheckupReport } from './contract'
import { PrivacyViolationError } from './privacy'
import { currentKernelIsolation, defaultResumeProbe } from './readout'
import { runKernelCheckup } from './run'
import { CHECKUP_KERNEL_VERSION, CHECKUP_WORKER_EXIT } from './run-guard'

export interface CheckupWorkerArgs {
  home: string
  state: string
  out: string
  sources?: string[]
  kernelVersion?: string
}

const FLAGS = new Set(['--home', '--state', '--out', '--sources', '--kernel-version'])
const OUT_NAME = /^[A-Za-z0-9._-]{1,64}$/

function realDirectory(target: string): string | null {
  try {
    const real = fs.realpathSync.native(target)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

/** Strict argument parsing; null on any usage error (the caller exits with `usage`). */
export function parseCheckupWorkerArgs(argv: readonly string[]): CheckupWorkerArgs | null {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!FLAGS.has(flag) || value === undefined || value === '' || values.has(flag)) return null
    values.set(flag, value)
  }
  const home = values.get('--home')
  const state = values.get('--state')
  const out = values.get('--out')
  if (!home || !state || !out || !path.isAbsolute(home) || !path.isAbsolute(state) || !path.isAbsolute(out)) return null
  const realHome = realDirectory(home)
  const realState = realDirectory(state)
  if (!realHome || !realState) return null
  // The report file lives directly inside the stateDir and must not exist yet.
  if (realDirectory(path.dirname(path.resolve(out))) !== realState || !OUT_NAME.test(path.basename(out))) return null
  const target = path.join(realState, path.basename(out))
  if (fs.existsSync(target)) return null
  const args: CheckupWorkerArgs = { home: realHome, state: realState, out: target }
  const sources = values.get('--sources')
  if (sources !== undefined) {
    const list = sources.split(',')
    if (list.some((source) => !(SOURCE_IDS as readonly string[]).includes(source))) return null
    args.sources = [...new Set(list)]
  }
  const kernelVersion = values.get('--kernel-version')
  if (kernelVersion !== undefined) {
    if (!CHECKUP_KERNEL_VERSION.test(kernelVersion)) return null
    args.kernelVersion = kernelVersion
  }
  return args
}

export async function runCheckupWorker(argv: readonly string[]): Promise<number> {
  const args = parseCheckupWorkerArgs(argv)
  if (!args) return CHECKUP_WORKER_EXIT.usage
  // Fail closed before any kernel entry runs: the kernel must see a HOME whose
  // .claude-session-manager lives inside this stateDir.
  if (!currentKernelIsolation(args.state).isolated) return CHECKUP_WORKER_EXIT.notIsolated
  let report: CheckupReport
  try {
    report = await runKernelCheckup({
      homeDir: args.home,
      stateDir: args.state,
      ...(args.sources ? { sources: args.sources } : {}),
      ...(args.kernelVersion ? { kernelVersion: args.kernelVersion } : {}),
      kernelCommit: null,
      // ⑥ resume (C2c): built here, inside the worker process that actually runs the checkup — a
      // ResumeProbe is a function value and cannot cross the parent CLI's child_process boundary
      // (checkup-command.ts spawns this file with only serializable --flags). isolatedWorkerEnv()
      // (run-guard.ts) already passes the parent's PATH through unchanged, so process.env.PATH here is
      // the same login-shell PATH the parent CLI saw; checkup-command.ts needs no change for this.
      resumeProbe: defaultResumeProbe(process.env.PATH ?? '')
    })
  } catch (error) {
    return error instanceof PrivacyViolationError ? CHECKUP_WORKER_EXIT.privacy : CHECKUP_WORKER_EXIT.failure
  }
  if (report.readout?.reason === 'readout.not-isolated') return CHECKUP_WORKER_EXIT.notIsolated
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return CHECKUP_WORKER_EXIT.ok
}

// Runs as a script; Vitest only imports it for tests (the CLI's own entry uses the same guard).
if (process.env.VITEST !== 'true') {
  runCheckupWorker(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(CHECKUP_WORKER_EXIT.failure)
  )
}
