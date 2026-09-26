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
import { execFileSync } from 'node:child_process'
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
