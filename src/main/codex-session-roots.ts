import * as fs from 'node:fs'
import * as path from 'node:path'
import { runtimeHome } from './runtime-home'
import { resolvePathWithinRoot } from './path-containment'

export type CodexSessionLifecycle = 'active' | 'archived' | 'replayed'

export interface CodexRootDefinition {
  home: string
  sessionsDir: string
  archivedDir: string
  origin: 'default' | 'environment' | 'additional'
}

export interface CodexSessionPathMatch {
  root: CodexRootDefinition
  container: 'sessions' | 'archived_sessions'
  lifecycleState: 'active' | 'archived'
}

interface CodexHomesConfig {
  version: 1
  homes: string[]
}

const CODEX_HOMES_CONFIG_VERSION = 1
const MAX_ADDITIONAL_CODEX_HOMES = 32
const additionalHomesCache = new Map<string, { signature: string; homes: string[] }>()
const configuredRootsCache = new Map<string, CodexRootDefinition[]>()

function configPath(home = runtimeHome()): string {
  return path.join(home, '.claude-session-manager', 'codex-homes.json')
}

function fileSignature(filePath: string): string {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return 'missing'
  }
}

function resolveExistingDirectory(directory: string): { resolved: string; canonical: string } {
  const resolved = path.resolve(directory)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Codex home is not an existing directory: ${directory}`)
  }
  return { resolved, canonical: fs.realpathSync.native(resolved) }
}

export function normalizeAdditionalCodexHomes(
  homes: unknown,
  options: { mustExist?: boolean } = {}
): string[] {
  if (!Array.isArray(homes)) throw new Error('Codex homes must be an array')
  if (homes.length > MAX_ADDITIONAL_CODEX_HOMES) {
    throw new Error(`At most ${MAX_ADDITIONAL_CODEX_HOMES} additional Codex homes are supported`)
  }

  const normalized = new Map<string, string>()
  for (const value of homes) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
      throw new Error('Each Codex home must be a non-empty path')
    }
    const candidate = value.trim()
    if (!path.isAbsolute(candidate)) throw new Error(`Codex home must be absolute: ${candidate}`)
    if (['sessions', 'archived_sessions'].includes(path.basename(path.resolve(candidate)))) {
      throw new Error(`Choose CODEX_HOME itself, not its ${path.basename(candidate)} directory`)
    }
    const resolved = path.resolve(candidate)
    let directory: { resolved: string; canonical: string }
    if (fs.existsSync(resolved)) {
      directory = resolveExistingDirectory(candidate)
    } else if (options.mustExist === false) {
      directory = { resolved, canonical: resolved }
    } else {
      throw new Error(`Codex home is not an existing directory: ${candidate}`)
    }
    if (!normalized.has(directory.canonical)) normalized.set(directory.canonical, directory.resolved)
  }
  return [...normalized.values()]
}

export function loadAdditionalCodexHomes(home = runtimeHome()): string[] {
  const filePath = configPath(home)
  const signature = fileSignature(filePath)
  const cached = additionalHomesCache.get(filePath)
  if (cached?.signature === signature) return [...cached.homes]
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<CodexHomesConfig>
    if (parsed.version !== CODEX_HOMES_CONFIG_VERSION || !Array.isArray(parsed.homes)) return []
    const homes = normalizeAdditionalCodexHomes(parsed.homes, { mustExist: false })
    additionalHomesCache.set(filePath, { signature, homes })
    return [...homes]
  } catch {
    // Invalid machine-local configuration fails closed. Temporarily missing
    // roots remain valid above so removable volumes can return on a later run.
    additionalHomesCache.set(filePath, { signature, homes: [] })
    return []
  }
}

export function saveAdditionalCodexHomes(homes: unknown, home = runtimeHome()): string[] {
  const normalized = normalizeAdditionalCodexHomes(homes)
  const filePath = configPath(home)
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify({
      version: CODEX_HOMES_CONFIG_VERSION,
      homes: normalized
    } satisfies CodexHomesConfig, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'w'
    })
    fs.renameSync(temporaryPath, filePath)
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }) } catch { /* best effort */ }
  }
  additionalHomesCache.set(filePath, { signature: fileSignature(filePath), homes: normalized })
  configuredRootsCache.clear()
  return normalized
}

function rootDefinition(home: string, origin: CodexRootDefinition['origin']): CodexRootDefinition {
  return {
    home,
    sessionsDir: path.join(home, 'sessions'),
    archivedDir: path.join(home, 'archived_sessions'),
    origin
  }
}

/** Resolve all machine-local CODEX_HOME roots without entering any transcript directory. */
export function configuredCodexRoots(home = runtimeHome()): CodexRootDefinition[] {
  const additionalHomes = loadAdditionalCodexHomes(home)
  const cacheKey = [path.resolve(home), process.env.CODEX_HOME || '', ...additionalHomes].join('\0')
  const cached = configuredRootsCache.get(cacheKey)
  if (cached) return cached
  const candidates: Array<{ home: string; origin: CodexRootDefinition['origin'] }> = [
    { home: path.join(home, '.codex'), origin: 'default' }
  ]
  if (process.env.CODEX_HOME?.trim()) {
    const envHome = process.env.CODEX_HOME.trim()
    if (path.isAbsolute(envHome)) candidates.push({ home: path.resolve(envHome), origin: 'environment' })
  }
  candidates.push(...additionalHomes.map((additionalHome) => ({
    home: additionalHome,
    origin: 'additional' as const
  })))

  const roots = new Map<string, CodexRootDefinition>()
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.home)
    const canonical = fs.existsSync(resolved)
      ? fs.realpathSync.native(resolved)
      : resolved
    if (!roots.has(canonical)) roots.set(canonical, rootDefinition(resolved, candidate.origin))
  }
  const configured = [...roots.values()]
  configuredRootsCache.set(cacheKey, configured)
  return configured
}

export function codexSessionDirectories(home = runtimeHome()): string[] {
  return configuredCodexRoots(home).flatMap((root) => [root.sessionsDir, root.archivedDir])
}

function pathMatchWithin(containerDir: string, candidate: string): boolean {
  try {
    resolvePathWithinRoot(containerDir, candidate, { allowRoot: false })
    return true
  } catch {
    return false
  }
}

/**
 * Match only rollout files contained by configured session directories.
 * Existing symlink files are rejected so a configured root cannot become a
 * capability to read an unrelated transcript through an alias.
 */
export function matchConfiguredCodexSessionPath(
  filePath: string,
  home = runtimeHome()
): CodexSessionPathMatch | null {
  if (!path.isAbsolute(filePath) || !path.basename(filePath).startsWith('rollout-') ||
      path.extname(filePath) !== '.jsonl') return null
  try {
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) return null
  } catch {
    return null
  }
  for (const root of configuredCodexRoots(home)) {
    if (pathMatchWithin(root.sessionsDir, filePath)) {
      return { root, container: 'sessions', lifecycleState: 'active' }
    }
    if (pathMatchWithin(root.archivedDir, filePath)) {
      return { root, container: 'archived_sessions', lifecycleState: 'archived' }
    }
  }
  return null
}
