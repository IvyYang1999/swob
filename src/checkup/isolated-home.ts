/**
 * Symlink-HOME isolation for running the kernel read-only against real
 * source data (design appendix A; task C1a deliverable 4).
 *
 * `<stateDir>/home` contains only top-level links to the real source roots and
 * a *real, empty* `.claude-session-manager`, so the kernel's summary cache,
 * canonical/search/usage stores and TMPDIR snapshots all land in stateDir.
 * The real `~/.claude-session-manager`, `~/Library/Application Support/Swob`
 * and the library root are never linked or copied (only `codex-homes.json`
 * is copied when it exists).
 *
 * This module must not import any kernel module: it runs before the kernel is
 * evaluated. Cleanup uses `fs.rmSync(recursive)` only, which unlinks symlinks
 * without following them.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** Top-level source roots linked into the isolated HOME (checked against session-loader.ts:621-781, opencode-loader.ts:29-33, codex-session-roots.ts:138, providers/*). */
export const SOURCE_LINKS: readonly string[] = [
  '.claude',
  '.claude-window',
  '.codex',
  '.cursor',
  '.gemini',
  '.hermes',
  '.pi',
  '.kimi',
  '.kimi-code',
  '.zcode',
  '.grok',
  '.factory',
  '.cc-mirror',
  '.local/share/opencode',
  'Library/Application Support/Trae',
  'Library/Application Support/Trae CN',
  'Library/Application Support/TRAE SOLO CN'
]

/** `.qoder*` roots are discovered by prefix at the top level of the real home. */
export const SOURCE_LINK_PREFIXES: readonly string[] = ['.qoder']

export const STATE_SUBDIRS = ['home', 'tmp', 'canonical', 'search', 'usage'] as const

export interface IsolatedHome {
  stateDir: string
  home: string
  tmp: string
  env: Record<string, string>
  linked: string[]
  missing: string[]
  copiedCodexHomes: boolean
  /** Entries this module created directly inside stateDir (cleanup removes exactly these). */
  created: string[]
}

function lexists(target: string): boolean {
  try {
    fs.lstatSync(target)
    return true
  } catch {
    return false
  }
}

function linkCandidates(realHome: string): string[] {
  const candidates = [...SOURCE_LINKS]
  let names: string[] = []
  try { names = fs.readdirSync(realHome) } catch { names = [] }
  for (const name of names.sort()) {
    if (SOURCE_LINK_PREFIXES.some((prefix) => name.startsWith(prefix)) && !candidates.includes(name)) candidates.push(name)
  }
  return candidates
}

export function buildIsolatedHome(input: { realHome: string; stateDir: string }): IsolatedHome {
  const stateDir = fs.realpathSync.native(input.stateDir)
  const created: string[] = []
  for (const name of STATE_SUBDIRS) {
    const target = path.join(stateDir, name)
    if (lexists(target)) throw new Error('isolated home: stateDir already contains a reserved entry')
    fs.mkdirSync(target)
    created.push(target)
  }
  const home = path.join(stateDir, 'home')
  const linked: string[] = []
  const missing: string[] = []
  for (const relative of linkCandidates(input.realHome)) {
    const target = path.join(input.realHome, relative)
    if (!lexists(target)) {
      missing.push(relative)
      continue
    }
    const link = path.join(home, relative)
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(target, link)
    linked.push(relative)
  }
  const cacheDir = path.join(home, '.claude-session-manager')
  fs.mkdirSync(cacheDir)
  let copiedCodexHomes = false
  const codexHomes = path.join(input.realHome, '.claude-session-manager', 'codex-homes.json')
  try {
    if (fs.lstatSync(codexHomes).isFile()) {
      fs.copyFileSync(codexHomes, path.join(cacheDir, 'codex-homes.json'), fs.constants.COPYFILE_EXCL)
      copiedCodexHomes = true
    }
  } catch { /* absent: no additional Codex homes */ }
  const tmp = path.join(stateDir, 'tmp')
  return {
    stateDir,
    home,
    tmp,
    env: {
      HOME: home,
      TMPDIR: tmp,
      SWOB_CANONICAL_STORE_DIR: path.join(stateDir, 'canonical'),
      SWOB_SEARCH_INDEX_DIR: path.join(stateDir, 'search'),
      SWOB_USAGE_INDEX_PATH: path.join(stateDir, 'usage', 'usage-facts.db')
    },
    linked,
    missing,
    copiedCodexHomes,
    created
  }
}

/** Remove exactly what buildIsolatedHome created; `fs.rmSync` never follows symlinks. */
export function cleanupIsolatedHome(isolated: Pick<IsolatedHome, 'created'>): void {
  for (const target of [...isolated.created].reverse()) {
    fs.rmSync(target, { recursive: true, force: true })
  }
}

// —— argument guards for the real run ——

function realOrResolved(target: string): string {
  try { return fs.realpathSync.native(target) } catch { return path.resolve(target) }
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Library root configured for the desktop app (read-only; never reported). */
export function configuredLibraryRoot(realHome: string): string | null {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(realHome, '.claude-session-manager', 'app-config.json'), 'utf8'))
    return typeof config?.libraryPath === 'string' && path.isAbsolute(config.libraryPath) ? config.libraryPath : null
  } catch {
    return null
  }
}

/** Locations a stateDir may never equal, contain or sit inside. */
export function protectedLocations(realHome: string): string[] {
  const locations = [
    realHome,
    path.join(realHome, '.claude-session-manager'),
    path.join(realHome, 'Library', 'Application Support', 'Swob'),
    ...linkCandidates(realHome).map((relative) => path.join(realHome, relative))
  ]
  const library = configuredLibraryRoot(realHome)
  if (library) locations.push(library)
  return locations.map(realOrResolved)
}

export function allowedStateRoots(): string[] {
  return [os.tmpdir(), '/private/var/folders', '/private/tmp'].map(realOrResolved)
}

export type StateDirVerdict = { ok: true; stateDir: string } | { ok: false; reason: string }

/** Fail-closed validation of `--state` (must exist, be empty, live under a temp root, and avoid protected locations). */
export function validateStateDir(input: { stateDir: string; realHome: string; allowedRoots?: string[]; protected?: string[] }): StateDirVerdict {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(input.stateDir)
  } catch {
    return { ok: false, reason: 'state-dir-missing' }
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: 'state-dir-not-directory' }
  if (fs.readdirSync(input.stateDir).length > 0) return { ok: false, reason: 'state-dir-not-empty' }
  const real = fs.realpathSync.native(input.stateDir)
  const roots = input.allowedRoots ?? allowedStateRoots()
  if (!roots.some((root) => inside(real, root) && real !== root)) return { ok: false, reason: 'state-dir-outside-temp' }
  for (const location of input.protected ?? protectedLocations(input.realHome)) {
    if (inside(real, location) || inside(location, real)) return { ok: false, reason: 'state-dir-overlaps-protected' }
  }
  return { ok: true, stateDir: real }
}
