import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export const SWOB_APP_CLI_PATH = '/Applications/Swob.app/Contents/Resources/cli/cli.js'
export const PRIMARY_CLI_TARGET_DIR = '/usr/local/bin'
export const HOMEBREW_CLI_TARGET_DIR = '/opt/homebrew/bin'

type CliTargetKind = 'primary' | 'homebrew' | 'local'

export type CliTargetCandidate = {
  kind: CliTargetKind
  dir: string
  createIfMissing: boolean
}

export type CliInstallOptions = {
  homeDir?: string
  pathEnv?: string
  appCliPath?: string
  primaryTargetDir?: string
  homebrewTargetDir?: string
  localTargetDir?: string
}

export type CliInstallResult = {
  cliInstalled: boolean
  cliPath: string | null
  wrapperPath: string
  cliManualInstall: string | null
  attemptedCliPaths: string[]
  fallbackUsed: boolean
  error?: string
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
  return `#!/bin/bash\nexec node "${appCliPath}" "$@"\n`
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

export function getCliTargetCandidates(options: CliInstallOptions = {}): CliTargetCandidate[] {
  const homeDir = options.homeDir ?? os.homedir()
  const pathEnv = options.pathEnv ?? process.env.PATH ?? ''
  const primaryTargetDir = options.primaryTargetDir ?? PRIMARY_CLI_TARGET_DIR
  const homebrewTargetDir = options.homebrewTargetDir ?? HOMEBREW_CLI_TARGET_DIR
  const localTargetDir = options.localTargetDir ?? path.join(homeDir, '.local', 'bin')
  const candidates: CliTargetCandidate[] = [
    { kind: 'primary', dir: primaryTargetDir, createIfMissing: false }
  ]

  if (isDirInPath(homebrewTargetDir, pathEnv, homeDir)) {
    candidates.push({ kind: 'homebrew', dir: homebrewTargetDir, createIfMissing: false })
  }
  if (isDirInPath(localTargetDir, pathEnv, homeDir)) {
    candidates.push({ kind: 'local', dir: localTargetDir, createIfMissing: true })
  }

  return candidates
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
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
  const attemptedCliPaths: string[] = []
  const errors: string[] = []

  for (const candidate of candidates) {
    const cliPath = path.join(candidate.dir, 'swob')
    attemptedCliPaths.push(cliPath)
    try {
      if (isSymlinkTo(cliPath, wrapperPath)) {
        return {
          cliInstalled: true,
          cliPath,
          wrapperPath,
          cliManualInstall: null,
          attemptedCliPaths,
          fallbackUsed: candidate.kind !== 'primary'
        }
      }
      ensureTargetDir(candidate)
      replaceSymlinkAtomic(wrapperPath, cliPath)
      return {
        cliInstalled: true,
        cliPath,
        wrapperPath,
        cliManualInstall: null,
        attemptedCliPaths,
        fallbackUsed: candidate.kind !== 'primary'
      }
    } catch (error) {
      errors.push(`${cliPath}: ${errorMessage(error)}`)
    }
  }

  const manualTarget = path.join(options.primaryTargetDir ?? PRIMARY_CLI_TARGET_DIR, 'swob')
  return {
    cliInstalled: false,
    cliPath: null,
    wrapperPath,
    cliManualInstall: `sudo ln -sf ${shellQuote(wrapperPath)} ${shellQuote(manualTarget)}`,
    attemptedCliPaths,
    fallbackUsed: false,
    error: errors.join('; ')
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath)
    return true
  } catch {
    return false
  }
}

export function findInstalledSwobCommandPath(options: CliInstallOptions = {}): string | null {
  for (const candidate of getCliTargetCandidates(options)) {
    const cliPath = path.join(candidate.dir, 'swob')
    if (pathExists(cliPath)) return cliPath
  }
  return null
}
