/**
 * Where a checkup report may be written (task C1b, dispatcher addition 1).
 *
 * Shared by the dev runner (`scripts/checkup-dev.mjs --json`) and the CLI
 * (`swob doctor checkup --report`, C1b-2). The library root is deliberately
 * *not* protected as a whole: on the owner's machine it is the whole Obsidian
 * vault, which is exactly where the report belongs. Only Swob's own library
 * state (`<library>/.swob`) and session package directory trees (any directory
 * holding `.swob-session.json`, and everything below it) are refused, together
 * with the source roots, `~/.claude-session-manager`,
 * `~/Library/Application Support/Swob` and the one-shot stateDir.
 *
 * `protectedLocations()` in isolated-home.ts is intentionally left as it is: it
 * still guards the stateDir (which must never overlap the library root).
 *
 * Node built-ins and isolated-home.ts only. The dev runner evaluates this module
 * before the kernel, so it must never import a kernel module. It only reads
 * metadata (lstat / realpath / existence) and writes nothing.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { SOURCE_LINKS, SOURCE_LINK_PREFIXES } from './isolated-home'

/** File that marks a Swob library session package directory. */
export const SESSION_PACKAGE_MARKER = '.swob-session.json'

export type ReportTargetKind = 'file' | 'directory'

export type ReportTargetRefusal =
  | 'report-target-missing'
  | 'report-target-not-directory'
  | 'report-target-not-file'
  | 'report-target-symlink'
  | 'report-target-in-state-dir'
  | 'report-target-in-swob-state'
  | 'report-target-in-app-support'
  | 'report-target-in-source-root'
  | 'report-target-in-library-state'
  | 'report-target-in-session-package'

export type ReportTargetVerdict =
  | { ok: true; /** Resolved file path, or the resolved directory for kind 'directory'. */ target: string; /** Real directory the report files land in. */ directory: string }
  | { ok: false; reason: ReportTargetRefusal }

export interface ReportTargetContext {
  /** The account home whose sources the checkup reads. */
  realHome: string
  /** Configured Swob library root (read-only; may be the owner's whole vault). */
  libraryRoot: string | null
  /** The checkup's one-shot state directory, when one exists. */
  stateDir?: string | null
  /** `file` (default): `target` is the file to write; `directory`: reports are written into `target`. */
  kind?: ReportTargetKind
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target)
  } catch {
    return null
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

/** Real path of `target` even when its tail does not exist yet (nearest existing ancestor resolved). */
function realpathOfPossiblyMissing(target: string): string {
  const tail: string[] = []
  let current = path.resolve(target)
  for (;;) {
    const real = realpathOrNull(current)
    if (real) return path.join(real, ...tail.reverse())
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(target)
    tail.push(path.basename(current))
    current = parent
  }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** A protected location as written and as resolved (a source root may itself be a symlink). */
function spellings(location: string): string[] {
  return [...new Set([path.resolve(location), realpathOfPossiblyMissing(location)])]
}

/** Top-level source roots under the home (same list the isolated HOME links). */
function sourceRoots(realHome: string): string[] {
  const roots = SOURCE_LINKS.map((relative) => path.join(realHome, relative))
  let names: string[] = []
  try { names = fs.readdirSync(realHome) } catch { names = [] }
  for (const name of names) {
    if (SOURCE_LINK_PREFIXES.some((prefix) => name.startsWith(prefix))) roots.push(path.join(realHome, name))
  }
  return roots
}

function insideAny(candidates: readonly string[], locations: readonly string[]): boolean {
  return locations.some((location) => spellings(location).some((spelling) => candidates.some((candidate) => inside(candidate, spelling))))
}

/** Whether `directory` or one of its ancestors is a session package (holds the marker file). */
function insideSessionPackage(directory: string): boolean {
  let current = directory
  for (;;) {
    if (lstatOrNull(path.join(current, SESSION_PACKAGE_MARKER))) return true
    const parent = path.dirname(current)
    if (parent === current) return false
    current = parent
  }
}

/**
 * Decide whether a report may be written at `target` (fail closed). The target
 * directory must exist and must not be a symlink; an existing target file must
 * be a regular file. Nothing is created or modified.
 */
export function reportTargetVerdict(target: string, context: ReportTargetContext): ReportTargetVerdict {
  const kind = context.kind ?? 'file'
  const requested = path.resolve(target)
  const dirPath = kind === 'directory' ? requested : path.dirname(requested)
  const dirStat = lstatOrNull(dirPath)
  if (!dirStat) return { ok: false, reason: 'report-target-missing' }
  if (dirStat.isSymbolicLink()) return { ok: false, reason: 'report-target-symlink' }
  if (!dirStat.isDirectory()) return { ok: false, reason: 'report-target-not-directory' }
  const directory = realpathOrNull(dirPath)
  if (!directory) return { ok: false, reason: 'report-target-missing' }
  let resolved = directory
  if (kind === 'file') {
    const fileStat = lstatOrNull(requested)
    if (fileStat?.isSymbolicLink()) return { ok: false, reason: 'report-target-symlink' }
    if (fileStat && !fileStat.isFile()) return { ok: false, reason: 'report-target-not-file' }
    resolved = path.join(directory, path.basename(requested))
  }
  const candidates = kind === 'file' ? [directory, resolved] : [directory]
  const home = realpathOrNull(context.realHome) ?? path.resolve(context.realHome)

  if (context.stateDir && insideAny(candidates, [context.stateDir])) return { ok: false, reason: 'report-target-in-state-dir' }
  if (insideAny(candidates, [path.join(home, '.claude-session-manager')])) return { ok: false, reason: 'report-target-in-swob-state' }
  if (insideAny(candidates, [path.join(home, 'Library', 'Application Support', 'Swob')])) return { ok: false, reason: 'report-target-in-app-support' }
  if (insideAny(candidates, sourceRoots(home))) return { ok: false, reason: 'report-target-in-source-root' }
  if (context.libraryRoot && insideAny(candidates, [path.join(context.libraryRoot, '.swob')])) {
    return { ok: false, reason: 'report-target-in-library-state' }
  }
  if (path.basename(resolved) === SESSION_PACKAGE_MARKER || insideSessionPackage(directory)) {
    return { ok: false, reason: 'report-target-in-session-package' }
  }
  return { ok: true, target: resolved, directory }
}

// —— machine model for the report header (dispatcher decision 3) ——

/** Hardware model identifier as printed by `sysctl -n hw.model` (e.g. Mac16,10); same shape as privacy.ts MACHINE_MODEL. */
const MACHINE_MODEL_TEXT = /^[A-Za-z]{2,24}\d{1,3},\d{1,3}$/

function sysctlModel(): string | null {
  try {
    return execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

/**
 * The Mac model (`sysctl -n hw.model`) shown in the report header so the owner can tell machines apart;
 * null on other platforms, on failure, or when the output is not a plain model id. Reads only.
 */
export function readMachineModel(platform: NodeJS.Platform = process.platform, read: () => string | null = sysctlModel): string | null {
  if (platform !== 'darwin') return null
  const model = read()?.trim() ?? ''
  return MACHINE_MODEL_TEXT.test(model) ? model : null
}

// —— the isolated checkup worker (C1b-2) ——

/**
 * Exit codes of the checkup worker (src/checkup/cli-worker.ts). The CLI maps
 * notIsolated to 5 (the isolation guarantee does not hold), privacy to 7 and
 * everything else to 1.
 */
export const CHECKUP_WORKER_EXIT = { ok: 0, failure: 1, usage: 2, notIsolated: 5, privacy: 7 } as const

/** Kernel versions the worker accepts for kernel.version (a plain x.y[.z[.w]] with an optional tag). */
export const CHECKUP_KERNEL_VERSION = /^\d{1,6}(?:\.\d{1,6}){1,3}(?:[-+][0-9A-Za-z.]{1,32})?$/

/**
 * Variables the worker must not inherit: the test-runtime markers (they would switch the kernel's
 * library guard, e2e-library-isolation.ts, into its test contract) and the library / user-data
 * overrides (the worker must never reach a real library through them). Same idea as the dev runner's
 * env cleaning (scripts/checkup-dev.mjs), which drops NODE_ENV, VITEST, SWOB_E2E_SANDBOX_ROOT and
 * SWOB_TEST_HOME.
 */
const WORKER_ENV_DROPPED: readonly string[] = [
  'NODE_ENV', 'VITEST', 'SWOB_E2E_RUNNER', 'SWOB_E2E_SANDBOX_ROOT', 'SWOB_LIBRARY_ROOT', 'SWOB_USER_DATA_ROOT'
]
const WORKER_ENV_DROPPED_PREFIXES: readonly string[] = ['SWOB_TEST_']

/**
 * Environment of the isolated worker: the parent's own (PATH, NODE_PATH for better-sqlite3, CODEX_HOME …
 * are kept) minus the variables above, then `extra` (a test launcher's additions), then the isolated
 * home's HOME, TMPDIR and store paths from buildIsolatedHome(), which always win. The privacy salt is
 * never passed: the worker derives the same one from the machine identifier.
 */
export function isolatedWorkerEnv(
  parent: NodeJS.ProcessEnv,
  isolated: Readonly<Record<string, string>>,
  extra: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined || WORKER_ENV_DROPPED.includes(key)) continue
    if (WORKER_ENV_DROPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
    env[key] = value
  }
  return { ...env, ...extra, ...isolated }
}

// —— run guards ported from scripts/checkup-dev.mjs (C1b-2) ——
//
// The dev runner keeps its own copy (a .mjs file cannot be bundled into the
// CLI); both implement the same rules: refuse while the Swob app runs, and
// compare metadata-only snapshots (lstat, file contents never read) of Swob's
// state, App Support/Swob, <library>/.swob and the source SQLite main files
// before and after the run. SQLite sidecars (-wal/-shm/-journal) are recorded,
// never counted as a change.

/** Whether the Swob desktop app is running: `pgrep -x Swob` exits 0 (same rule as the dev runner). */
export function swobAppRunning(probe: () => number | null = () => spawnSync('pgrep', ['-x', 'Swob'], { stdio: 'ignore' }).status): boolean {
  return probe() === 0
}

export interface AuditTargets {
  /** Directory trees that must not change; null when the location does not apply. */
  groups: { stateDirUnchanged: string; appSupportUnchanged: string; libraryDotSwobUnchanged: string | null }
  /** Source SQLite main files (their sidecars are recorded, not counted). */
  sqlite: string[]
}

export interface AuditSnapshot {
  groups: Record<keyof AuditTargets['groups'], Map<string, string>>
  files: Record<string, string | null>
}

export interface AuditResult {
  /** `~/.claude-session-manager` unchanged (the dev runner's name for Swob's own state directory). */
  stateDirUnchanged: boolean
  appSupportUnchanged: boolean
  libraryDotSwobUnchanged: boolean
  sourceMainDbUnchanged: boolean
  /** `~/`-relative names of SQLite sidecars that appeared or changed (recorded only). */
  sidecarsTouched: string[]
  /** Entries the directory snapshots covered. */
  protectedEntries: number
}

function statSignature(stat: fs.Stats): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
}

/** Metadata-only snapshot of a tree (lstat; symlinks are not followed; contents are never read). */
export function metaSnapshot(root: string): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (dir: string): void => {
    let names: string[]
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names) {
      const full = path.join(dir, name)
      let stat: fs.Stats
      try { stat = fs.lstatSync(full) } catch { continue }
      entries.set(full, statSignature(stat))
      if (stat.isDirectory()) walk(full)
    }
  }
  try {
    const stat = fs.lstatSync(root)
    entries.set(root, `${stat.isDirectory() ? 'dir' : stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`)
    if (stat.isDirectory()) walk(root)
  } catch { /* absent location: empty snapshot */ }
  return entries
}

function sameSnapshot(left: Map<string, string>, right: Map<string, string>): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) if (right.get(key) !== value) return false
  return true
}

export function auditTargets(home: string, libraryRoot: string | null): AuditTargets {
  const sqlite: string[] = []
  const codexHome = path.join(home, '.codex')
  try {
    for (const name of fs.readdirSync(codexHome)) if (/^state_\d+\.sqlite$/.test(name)) sqlite.push(path.join(codexHome, name))
  } catch { /* no codex */ }
  sqlite.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'), path.join(home, '.zcode', 'cli', 'db', 'db.sqlite'))
  return {
    groups: {
      stateDirUnchanged: path.join(home, '.claude-session-manager'),
      appSupportUnchanged: path.join(home, 'Library', 'Application Support', 'Swob'),
      libraryDotSwobUnchanged: libraryRoot ? path.join(libraryRoot, '.swob') : null
    },
    sqlite
  }
}

const SQLITE_SIDECARS = ['', '-wal', '-shm', '-journal'] as const

export function takeAudit(targets: AuditTargets): AuditSnapshot {
  const groups = {} as AuditSnapshot['groups']
  for (const [key, location] of Object.entries(targets.groups) as Array<[keyof AuditTargets['groups'], string | null]>) {
    groups[key] = location ? metaSnapshot(location) : new Map()
  }
  const files: Record<string, string | null> = {}
  for (const main of targets.sqlite) {
    for (const suffix of SQLITE_SIDECARS) {
      const file = `${main}${suffix}`
      try {
        files[file] = statSignature(fs.lstatSync(file))
      } catch {
        files[file] = null
      }
    }
  }
  return { groups, files }
}

export function compareAudit(before: AuditSnapshot, after: AuditSnapshot, targets: AuditTargets, home: string): AuditResult {
  return {
    stateDirUnchanged: sameSnapshot(before.groups.stateDirUnchanged, after.groups.stateDirUnchanged),
    appSupportUnchanged: sameSnapshot(before.groups.appSupportUnchanged, after.groups.appSupportUnchanged),
    libraryDotSwobUnchanged: sameSnapshot(before.groups.libraryDotSwobUnchanged, after.groups.libraryDotSwobUnchanged),
    sourceMainDbUnchanged: targets.sqlite.every((main) => before.files[main] === after.files[main]),
    sidecarsTouched: Object.keys(before.files)
      .filter((file) => !targets.sqlite.includes(file) && before.files[file] !== after.files[file])
      .map((file) => `~/${path.relative(home, file).split(path.sep).join('/')}`),
    protectedEntries: Object.values(before.groups).reduce((sum, snapshot) => sum + snapshot.size, 0)
  }
}

/** Whether the read-only guarantee held: every protected tree and every source SQLite main file unchanged. */
export function auditHeld(result: AuditResult): boolean {
  return result.stateDirUnchanged && result.appSupportUnchanged && result.libraryDotSwobUnchanged && result.sourceMainDbUnchanged
}
