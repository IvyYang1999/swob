import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync, spawnSync } from 'node:child_process'

export const SWOB_APP_CLI_PATH = '/Applications/Swob.app/Contents/Resources/cli/cli.js'
export const PRIMARY_CLI_TARGET_DIR = '/usr/local/bin'
export const HOMEBREW_CLI_TARGET_DIR = '/opt/homebrew/bin'

type CliTargetKind = 'primary' | 'homebrew' | 'local'

export type CliTargetCandidate = {
  kind: CliTargetKind
  dir: string
  createIfMissing: boolean
  exists: boolean
  writable: boolean
  inLoginPath: boolean
}

export type CliInstallOptions = {
  homeDir?: string
  pathEnv?: string
  loginPathEnv?: string
  loginShell?: string
  appCliPath?: string
  primaryTargetDir?: string
  homebrewTargetDir?: string
  localTargetDir?: string
  expectedVersion?: string
  allowShellRcUpdate?: boolean
  allowAuthorization?: boolean
  platform?: NodeJS.Platform
  testHomeDir?: string
  runLoginShell?: (shellPath: string, command: string, environment: NodeJS.ProcessEnv) => string
  authorizeWrite?: (filePath: string, content: string) => void
}

type CliInstallEnvironment = NodeJS.ProcessEnv & {
  SWOB_TEST_APP_CLI_PATH?: string
  SWOB_TEST_CLI_TARGET_DIR?: string
  SWOB_TEST_HOME?: string
}

export type CliInstallResult = {
  cliInstalled: boolean
  cliPath: string | null
  wrapperPath: string
  cliManualInstall: string | null
  attemptedCliPaths: string[]
  fallbackUsed: boolean
  cliVerified: boolean
  shellRcUpdated: boolean
  error?: string
}

/** Electron E2E homes are disposable and must never own a global CLI symlink. */
export function shouldAutoInstallCli(environment: NodeJS.ProcessEnv = process.env): boolean {
  return !environment.SWOB_TEST_HOME && environment.NODE_ENV !== 'test'
}

/**
 * Packaged CLI tests need to exercise `swob install` without touching the
 * machine's real /usr/local/bin or /opt/homebrew/bin. Overrides are accepted
 * only when the process is already running under an explicit SWOB_TEST_HOME.
 */
export function cliInstallOptionsForEnvironment(
  homeDir: string,
  environment: CliInstallEnvironment = process.env
): CliInstallOptions {
  if (!environment.SWOB_TEST_HOME) return { homeDir }

  const testHome = path.resolve(environment.SWOB_TEST_HOME)
  const resolvedHome = path.resolve(homeDir)
  const relativeHome = path.relative(testHome, resolvedHome)
  if (relativeHome.startsWith('..') || path.isAbsolute(relativeHome)) {
    throw new Error('SWOB_TEST_HOME must contain the CLI home directory')
  }

  const resolvedTarget = path.resolve(
    environment.SWOB_TEST_CLI_TARGET_DIR || path.join(testHome, 'bin')
  )
  const relativeTarget = path.relative(testHome, resolvedTarget)
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) {
    throw new Error('SWOB_TEST_CLI_TARGET_DIR must stay inside SWOB_TEST_HOME')
  }

  return {
    homeDir,
    appCliPath: environment.SWOB_TEST_APP_CLI_PATH,
    pathEnv: [resolvedTarget, environment.PATH || ''].filter(Boolean).join(path.delimiter),
    loginPathEnv: [resolvedTarget, environment.PATH || ''].filter(Boolean).join(path.delimiter),
    primaryTargetDir: resolvedTarget,
    homebrewTargetDir: path.join(testHome, 'unreachable-homebrew-bin'),
    localTargetDir: path.join(testHome, 'unreachable-local-bin'),
    testHomeDir: testHome,
    allowShellRcUpdate: false,
    allowAuthorization: false
  }
}

function expandHome(entry: string, homeDir: string): string {
  if (entry === '~') return homeDir
  if (entry.startsWith('~/')) return path.join(homeDir, entry.slice(2))
  return entry
}

function normalizeDir(dir: string, homeDir: string): string {
  return path.resolve(expandHome(dir, homeDir))
}

export function buildCliWrapperScript(appCliPath = SWOB_APP_CLI_PATH): string {
  // The packaged CLI runs under the system Node, outside the app's module tree.
  // Native deps (better-sqlite3 for grep/FTS) live in app.asar.unpacked, which
  // is only reachable when NODE_PATH points at it before Node starts.
  const unpackedNodeModules = path.join(
    path.dirname(path.dirname(appCliPath)),
    'app.asar.unpacked',
    'node_modules'
  )
  return `#!/bin/bash\n# Managed by Swob CLI installer\nexport NODE_PATH="${unpackedNodeModules}\${NODE_PATH:+:$NODE_PATH}"\nexec node "${appCliPath}" "$@"\n`
}

export function getCliWrapperPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.claude-session-manager', 'swob-cli.sh')
}

export function isDirInPath(dir: string, pathEnv = process.env.PATH || '', homeDir = os.homedir()): boolean {
  const target = normalizeDir(dir, homeDir)
  return pathEnv
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => normalizeDir(entry, homeDir) === target)
}

function allowedLoginShells(): Set<string> {
  try {
    return new Set(fs.readFileSync('/etc/shells', 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/')))
  } catch {
    return new Set(['/bin/zsh', '/bin/bash', '/bin/sh'])
  }
}

function resolveLoginShell(options: CliInstallOptions): string {
  const configured = options.loginShell || os.userInfo().shell || process.env.SHELL || '/bin/zsh'
  const allowed = allowedLoginShells()
  if (allowed.has(configured) && fs.existsSync(configured)) return configured
  for (const fallback of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (allowed.has(fallback) && fs.existsSync(fallback)) return fallback
  }
  return '/bin/sh'
}

function runLoginShell(
  options: CliInstallOptions,
  command: string,
  pathEnv?: string
): string {
  const shellPath = resolveLoginShell(options)
  const environment = {
    ...process.env,
    HOME: options.homeDir ?? os.homedir(),
    ...(pathEnv !== undefined ? { PATH: pathEnv } : {})
  }
  if (options.runLoginShell) return options.runLoginShell(shellPath, command, environment)
  return execFileSync(shellPath, ['-lic', command], {
    encoding: 'utf-8',
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000
  }).trim()
}

export function resolveLoginPathEnv(options: CliInstallOptions = {}): string {
  if (options.loginPathEnv !== undefined) return options.loginPathEnv
  if (options.pathEnv !== undefined) return options.pathEnv
  try {
    return runLoginShell(options, 'printf "%s" "$PATH"')
  } catch {
    return options.pathEnv ?? process.env.PATH ?? ''
  }
}

function nearestExistingDirectory(dir: string): string | null {
  let cursor = path.resolve(dir)
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) return null
    cursor = parent
  }
  try {
    return fs.statSync(cursor).isDirectory() ? cursor : null
  } catch {
    return null
  }
}

function probeWritableDirectory(dir: string, createIfMissing: boolean): { exists: boolean; writable: boolean } {
  try {
    const exists = fs.existsSync(dir)
    if (exists && !fs.statSync(dir).isDirectory()) return { exists: true, writable: false }
    const accessTarget = exists ? dir : createIfMissing ? nearestExistingDirectory(dir) : null
    if (!accessTarget) return { exists, writable: false }
    fs.accessSync(accessTarget, fs.constants.W_OK)
    return { exists, writable: true }
  } catch {
    return { exists: fs.existsSync(dir), writable: false }
  }
}

export function getCliTargetCandidates(options: CliInstallOptions = {}): CliTargetCandidate[] {
  const homeDir = options.homeDir ?? os.homedir()
  const loginPathEnv = resolveLoginPathEnv(options)
  const primaryTargetDir = options.primaryTargetDir ?? PRIMARY_CLI_TARGET_DIR
  const homebrewTargetDir = options.homebrewTargetDir ?? HOMEBREW_CLI_TARGET_DIR
  const localTargetDir = options.localTargetDir ?? path.join(homeDir, '.local', 'bin')
  const definitions: Array<Omit<CliTargetCandidate, 'exists' | 'writable' | 'inLoginPath'>> = [
    { kind: 'homebrew', dir: homebrewTargetDir, createIfMissing: false },
    { kind: 'primary', dir: primaryTargetDir, createIfMissing: false },
    { kind: 'local', dir: localTargetDir, createIfMissing: true }
  ]
  const candidates = definitions.map((candidate): CliTargetCandidate => {
    const probe = probeWritableDirectory(candidate.dir, candidate.createIfMissing)
    return {
      ...candidate,
      ...probe,
      inLoginPath: isDirInPath(candidate.dir, loginPathEnv, homeDir)
    }
  })
  const notInPathPriority: Record<CliTargetKind, number> = { local: 0, homebrew: 1, primary: 2 }
  return candidates.sort((left, right) => {
    const leftTier = left.writable ? (left.inLoginPath ? 0 : 1) : 2
    const rightTier = right.writable ? (right.inLoginPath ? 0 : 1) : 2
    if (leftTier !== rightTier) return leftTier - rightTier
    if (leftTier === 1) return notInPathPriority[left.kind] - notInPathPriority[right.kind]
    return 0
  })
}

function removeIfPresent(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true })
  } catch {
    // Best effort cleanup only.
  }
}

function replaceSymlinkAtomic(wrapperPath: string, cliPath: string): void {
  const targetDir = path.dirname(cliPath)
  const tempPath = path.join(targetDir, `.swob-${process.pid}-${Date.now()}.tmp`)
  removeIfPresent(tempPath)
  try {
    fs.symlinkSync(wrapperPath, tempPath)
    fs.renameSync(tempPath, cliPath)
  } finally {
    removeIfPresent(tempPath)
  }
}

function isSymlinkTo(filePath: string, expectedTarget: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isSymbolicLink()) return false
    const linkTarget = fs.readlinkSync(filePath)
    const resolvedTarget = path.isAbsolute(linkTarget)
      ? linkTarget
      : path.resolve(path.dirname(filePath), linkTarget)
    return path.resolve(resolvedTarget) === path.resolve(expectedTarget)
  } catch {
    return false
  }
}

function ensureTargetDir(candidate: CliTargetCandidate): void {
  if (candidate.createIfMissing) {
    fs.mkdirSync(candidate.dir, { recursive: true })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

function isManagedCliFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile() &&
      fs.readFileSync(filePath, 'utf-8').includes('# Managed by Swob CLI installer')
  } catch {
    return false
  }
}

function assertReplaceableCliPath(cliPath: string, wrapperPath: string): void {
  if (!pathExists(cliPath) || isSymlinkTo(cliPath, wrapperPath) || isManagedCliFile(cliPath)) return
  try {
    if (fs.lstatSync(cliPath).isSymbolicLink()) return
  } catch { /* handled below */ }
  throw new Error('target already exists and is not managed by Swob')
}

function shellRcPath(shellPath: string, homeDir: string): string {
  const name = path.basename(shellPath)
  if (name === 'zsh') return path.join(homeDir, '.zprofile')
  if (name === 'bash') return path.join(homeDir, '.bash_profile')
  return path.join(homeDir, '.profile')
}

function addDirectoryToShellPath(options: CliInstallOptions, dir: string): boolean {
  const homeDir = options.homeDir ?? os.homedir()
  const rcPath = shellRcPath(resolveLoginShell(options), homeDir)
  const existing = (() => {
    try { return fs.readFileSync(rcPath, 'utf-8') } catch { return '' }
  })()
  if (existing.split(/\r?\n/).some((line) => line.includes(dir) && line.includes('PATH'))) return false
  const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
  fs.appendFileSync(
    rcPath,
    `${prefix}# Added by Swob CLI installer\nexport PATH=${JSON.stringify(dir)}:"$PATH"\n`,
    'utf-8'
  )
  return true
}

function verifyCli(
  options: CliInstallOptions,
  cliPath: string,
  effectivePathEnv: string
): { ok: boolean; error?: string } {
  try {
    const output = runLoginShell(
      options,
      'command -v swob >/dev/null 2>&1 && swob --version',
      effectivePathEnv
    )
    const version = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || ''
    if (!version) return { ok: false, error: 'swob --version returned no version' }
    if (options.expectedVersion && version !== options.expectedVersion) {
      return {
        ok: false,
        error: `swob --version returned ${version}, expected ${options.expectedVersion}`
      }
    }
    try {
      if (!fs.statSync(cliPath).isFile()) return { ok: false, error: 'installed command is not a file' }
    } catch {
      return { ok: false, error: 'installed command is not readable' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function authorizeWriteFile(options: CliInstallOptions, filePath: string, content: string): void {
  if (options.authorizeWrite) {
    options.authorizeWrite(filePath, content)
    return
  }
  const authopen = '/usr/libexec/authopen'
  const args = pathExists(filePath)
    ? ['-w', filePath]
    : ['-c', '-m', '0755', '-w', filePath]
  const result = spawnSync(authopen, args, {
    input: content,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error((result.stderr || '').trim() || `authopen exited ${result.status}`)
  }
}

export function installSwobCli(options: CliInstallOptions = {}): CliInstallResult {
  const homeDir = options.homeDir ?? os.homedir()
  const appCliPath = options.appCliPath ?? SWOB_APP_CLI_PATH
  const wrapperPath = getCliWrapperPath(homeDir)
  const wrapperDir = path.dirname(wrapperPath)

  fs.mkdirSync(wrapperDir, { recursive: true })
  fs.writeFileSync(wrapperPath, buildCliWrapperScript(appCliPath), 'utf-8')
  fs.chmodSync(wrapperPath, 0o755)

  const candidates = getCliTargetCandidates(options)
  const initialLoginPath = resolveLoginPathEnv(options)
  const attemptedCliPaths: string[] = []
  const errors: string[] = []

  for (const candidate of candidates) {
    const cliPath = path.join(candidate.dir, 'swob')
    attemptedCliPaths.push(cliPath)
    if (!candidate.writable || (!candidate.inLoginPath && !options.allowShellRcUpdate)) continue
    try {
      ensureTargetDir(candidate)
      assertReplaceableCliPath(cliPath, wrapperPath)
      if (!isSymlinkTo(cliPath, wrapperPath)) {
        replaceSymlinkAtomic(wrapperPath, cliPath)
      }
      const shellRcUpdated = candidate.inLoginPath
        ? false
        : addDirectoryToShellPath(options, candidate.dir)
      const effectivePath = candidate.inLoginPath
        ? initialLoginPath
        : [candidate.dir, initialLoginPath].filter(Boolean).join(path.delimiter)
      const verification = verifyCli(options, cliPath, effectivePath)
      if (!verification.ok) throw new Error(verification.error)
      return {
        cliInstalled: true,
        cliPath,
        wrapperPath,
        cliManualInstall: null,
        attemptedCliPaths,
        fallbackUsed: candidate.kind !== 'primary',
        cliVerified: true,
        shellRcUpdated
      }
    } catch (error) {
      errors.push(`${cliPath}: ${errorMessage(error)}`)
    }
  }

  const canAuthorize = options.allowAuthorization === true &&
    !options.testHomeDir &&
    (options.platform ?? process.platform) === 'darwin'
  if (canAuthorize) {
    for (const candidate of candidates.filter((item) => item.exists && item.inLoginPath && !item.writable)) {
      const cliPath = path.join(candidate.dir, 'swob')
      if (!attemptedCliPaths.includes(cliPath)) attemptedCliPaths.push(cliPath)
      try {
        assertReplaceableCliPath(cliPath, wrapperPath)
        if (pathExists(cliPath) && !isManagedCliFile(cliPath)) {
          throw new Error('authorization will not replace an existing non-Swob command')
        }
        authorizeWriteFile(options, cliPath, buildCliWrapperScript(appCliPath))
        const verification = verifyCli(options, cliPath, initialLoginPath)
        if (!verification.ok) throw new Error(verification.error)
        return {
          cliInstalled: true,
          cliPath,
          wrapperPath,
          cliManualInstall: null,
          attemptedCliPaths,
          fallbackUsed: candidate.kind !== 'primary',
          cliVerified: true,
          shellRcUpdated: false
        }
      } catch (error) {
        errors.push(`${cliPath}: ${errorMessage(error)}`)
      }
    }
  }

  return {
    cliInstalled: false,
    cliPath: null,
    wrapperPath,
    cliManualInstall: null,
    attemptedCliPaths,
    fallbackUsed: false,
    cliVerified: false,
    shellRcUpdated: false,
    error: errors.join('; ') || 'No writable CLI directory is available in the login shell PATH'
  }
}

export function findInstalledSwobCommandPath(options: CliInstallOptions = {}): string | null {
  const loginPathEnv = resolveLoginPathEnv(options)
  for (const candidate of getCliTargetCandidates(options)) {
    if (!candidate.inLoginPath) continue
    const cliPath = path.join(candidate.dir, 'swob')
    if (!pathExists(cliPath)) continue
    if (verifyCli(options, cliPath, loginPathEnv).ok) return cliPath
  }
  return null
}
