import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface IsolationEnvironment {
  HOME?: string
  NODE_ENV?: string
  ELECTRON_RENDERER_URL?: string
  SWOB_E2E_RUNNER?: string
  SWOB_E2E_SANDBOX_ROOT?: string
  SWOB_TEST_SYSTEM_TEMP_ROOT?: string
  SWOB_TEST_HOME?: string
  SWOB_LIBRARY_ROOT?: string
  SWOB_USER_DATA_ROOT?: string
  SWOB_DEV_USE_REAL_LIBRARY?: string
  /** Adds a protected home for counterexample tests; it can never replace the native-home guard. */
  SWOB_ISOLATION_PROTECTED_HOME?: string
}

export interface RuntimeIsolationOptions {
  development?: boolean
  nativeHome?: string
  systemTemporaryRoot?: string
  userDataPath?: string
}

export interface RuntimeSafetyState {
  mode: 'production' | 'isolated-test' | 'isolated-development' | 'dangerous-real-library-development'
  dangerousRealLibrary: boolean
  marker: string | null
}

export interface ProtectedRealStateTarget {
  label: 'user-config' | 'library-locks' | 'global-cli-entry'
  targetPath: string
}

const REQUIRED_TEST_PATHS = [
  'HOME',
  'SWOB_TEST_HOME',
  'SWOB_E2E_SANDBOX_ROOT',
  'SWOB_TEST_SYSTEM_TEMP_ROOT',
  'SWOB_LIBRARY_ROOT',
  'SWOB_USER_DATA_ROOT'
] as const

export class E2ELibraryIsolationError extends Error {
  readonly candidatePath: string
  readonly sandboxRoot: string
  readonly reason: string

  constructor(candidatePath: string, sandboxRoot: string, reason: string) {
    super(`Runtime isolation failed: ${reason}`)
    this.name = 'E2ELibraryIsolationError'
    this.candidatePath = candidatePath
    this.sandboxRoot = sandboxRoot
    this.reason = reason
  }
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/**
 * Resolve every existing ancestor before appending missing path components.
 * This catches a sandbox-local symlink that points at a real user Vault.
 */
function canonicalPathThroughExistingAncestor(candidatePath: string): string {
  let existing = path.resolve(candidatePath)
  const missing: string[] = []
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    missing.unshift(path.basename(existing))
    existing = parent
  }
  const canonicalExisting = fs.realpathSync.native(existing)
  return path.resolve(canonicalExisting, ...missing)
}

function canonicalPathsOverlap(leftPath: string, rightPath: string): boolean {
  const left = canonicalPathThroughExistingAncestor(leftPath)
  const right = canonicalPathThroughExistingAncestor(rightPath)
  return isContained(left, right) || isContained(right, left)
}

function assertContained(candidatePath: string, sandboxRoot: string, label = 'path'): string {
  const resolvedCandidate = path.resolve(candidatePath)
  const resolvedSandbox = path.resolve(sandboxRoot)
  const lexicallyContained = isContained(resolvedSandbox, resolvedCandidate)

  let canonicalSandbox: string
  let canonicalCandidate: string
  try {
    canonicalSandbox = canonicalPathThroughExistingAncestor(resolvedSandbox)
    canonicalCandidate = canonicalPathThroughExistingAncestor(resolvedCandidate)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || 'unknown'
    throw new E2ELibraryIsolationError(resolvedCandidate, resolvedSandbox, `${label}-realpath-failed:${code}`)
  }
  if (!isContained(canonicalSandbox, canonicalCandidate)) {
    throw new E2ELibraryIsolationError(
      resolvedCandidate,
      resolvedSandbox,
      lexicallyContained ? `${label}-canonical-outside-sandbox` : `${label}-outside-sandbox`
    )
  }
  return candidatePath
}

function nativeAccountHome(): string {
  try {
    return os.userInfo().homedir
  } catch {
    return os.homedir()
  }
}

function readConfiguredLibrary(realHome: string): string | null {
  const configFile = path.join(realHome, '.claude-session-manager', 'app-config.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { libraryPath?: unknown }
    if (typeof parsed.libraryPath !== 'string' || !parsed.libraryPath.trim()) return null
    return path.isAbsolute(parsed.libraryPath)
      ? parsed.libraryPath
      : path.resolve(realHome, parsed.libraryPath)
  } catch {
    return null
  }
}

function protectedHomes(
  environment: IsolationEnvironment,
  options: RuntimeIsolationOptions
): string[] {
  const homes = [options.nativeHome || nativeAccountHome()]
  if (environment.SWOB_ISOLATION_PROTECTED_HOME) {
    homes.push(environment.SWOB_ISOLATION_PROTECTED_HOME)
  }
  return [...new Set(homes.map((home) => path.resolve(home)))]
}

function protectedRealPaths(
  environment: IsolationEnvironment,
  options: RuntimeIsolationOptions
): string[] {
  return protectedHomes(environment, options).flatMap((home) => {
    const configDir = path.join(home, '.claude-session-manager')
    const library = readConfiguredLibrary(home) || path.join(home, 'Documents', 'Swob')
    return [configDir, library]
  })
}

export function protectedRealStateTargets(
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): ProtectedRealStateTarget[] {
  const targets: ProtectedRealStateTarget[] = []
  for (const home of protectedHomes(environment, options)) {
    targets.push({ label: 'user-config', targetPath: path.join(home, '.claude-session-manager') })
    const library = readConfiguredLibrary(home) || path.join(home, 'Documents', 'Swob')
    targets.push({ label: 'library-locks', targetPath: path.join(library, '.swob', 'locks') })
  }
  targets.push({ label: 'global-cli-entry', targetPath: '/opt/homebrew/bin/swob' })
  return targets
}

export function resolveBootstrapLibraryCandidate(
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): string {
  const nativeHome = options.nativeHome || nativeAccountHome()
  const runtimeHome = process.platform === 'win32'
    ? nativeHome
    : (environment.HOME || nativeHome)
  return environment.SWOB_LIBRARY_ROOT ||
    readConfiguredLibrary(runtimeHome) ||
    path.join(runtimeHome, 'Documents', 'Swob')
}

function testRuntimeRequested(environment: IsolationEnvironment): boolean {
  return environment.NODE_ENV === 'test' || Boolean(
    environment.SWOB_E2E_RUNNER ||
    environment.SWOB_E2E_SANDBOX_ROOT ||
    environment.SWOB_TEST_HOME
  )
}

function developmentRuntimeRequested(
  environment: IsolationEnvironment,
  options: RuntimeIsolationOptions
): boolean {
  return options.development === true || environment.NODE_ENV === 'development' || Boolean(environment.ELECTRON_RENDERER_URL)
}

function requiredTestPath(
  environment: IsolationEnvironment,
  name: typeof REQUIRED_TEST_PATHS[number]
): string {
  const value = environment[name]
  if (!value) {
    throw new E2ELibraryIsolationError('<unset>', environment.SWOB_E2E_SANDBOX_ROOT || '<unset>', `missing-${name}`)
  }
  return value
}

function assertNoProtectedRealOverlap(
  candidatePath: string,
  environment: IsolationEnvironment,
  options: RuntimeIsolationOptions,
  label: string
): void {
  for (const protectedPath of protectedRealPaths(environment, options)) {
    try {
      if (canonicalPathsOverlap(candidatePath, protectedPath)) {
        throw new E2ELibraryIsolationError(
          path.resolve(candidatePath),
          environment.SWOB_E2E_SANDBOX_ROOT || '<none>',
          `${label}-overlaps-protected-real-state`
        )
      }
    } catch (error) {
      if (error instanceof E2ELibraryIsolationError) throw error
      const code = (error as NodeJS.ErrnoException).code || 'unknown'
      throw new E2ELibraryIsolationError(candidatePath, '<none>', `${label}-realpath-failed:${code}`)
    }
  }
}

function assertTestContract(
  candidatePath: string,
  environment: IsolationEnvironment,
  options: RuntimeIsolationOptions
): void {
  const values = Object.fromEntries(REQUIRED_TEST_PATHS.map((name) => [name, requiredTestPath(environment, name)])) as
    Record<typeof REQUIRED_TEST_PATHS[number], string>
  const sandboxRoot = values.SWOB_E2E_SANDBOX_ROOT

  // Protected-state checks run before generic containment so a CI counterexample
  // reports the actual safety violation instead of merely "outside sandbox".
  for (const [label, value] of [
    ['HOME', values.HOME],
    ['SWOB_LIBRARY_ROOT', values.SWOB_LIBRARY_ROOT],
    ['SWOB_USER_DATA_ROOT', values.SWOB_USER_DATA_ROOT],
    ['Library-candidate', candidatePath]
  ] as const) {
    assertNoProtectedRealOverlap(value, environment, options, label)
  }

  assertContained(values.HOME, sandboxRoot, 'HOME')
  assertContained(values.SWOB_TEST_HOME, sandboxRoot, 'SWOB_TEST_HOME')
  assertContained(values.SWOB_LIBRARY_ROOT, sandboxRoot, 'SWOB_LIBRARY_ROOT')
  assertContained(values.SWOB_USER_DATA_ROOT, sandboxRoot, 'SWOB_USER_DATA_ROOT')
  assertContained(candidatePath, sandboxRoot, 'Library')
  assertContained(sandboxRoot, values.SWOB_TEST_SYSTEM_TEMP_ROOT, 'sandbox')

  if (options.userDataPath) {
    assertContained(options.userDataPath, sandboxRoot, 'actual-userData')
    if (canonicalPathThroughExistingAncestor(options.userDataPath) !==
      canonicalPathThroughExistingAncestor(values.SWOB_USER_DATA_ROOT)) {
      throw new E2ELibraryIsolationError(options.userDataPath, sandboxRoot, 'actual-userData-does-not-match-SWOB_USER_DATA_ROOT')
    }
  }

  if (options.systemTemporaryRoot) {
    assertContained(sandboxRoot, options.systemTemporaryRoot, 'sandbox')
  }
}

export function assertTestLaunchContract(
  environment: IsolationEnvironment,
  userDataPath: string,
  options: Omit<RuntimeIsolationOptions, 'userDataPath'> = {}
): void {
  const candidate = environment.SWOB_LIBRARY_ROOT || '<unset>'
  assertTestContract(candidate, environment, { ...options, userDataPath })
}

export function assertExplicitTemporaryLaunchPaths(
  environment: IsolationEnvironment,
  sandboxRoot: string,
  userDataPath: string,
  systemTemporaryRoot: string
): void {
  for (const name of ['HOME', 'SWOB_LIBRARY_ROOT', 'SWOB_USER_DATA_ROOT'] as const) {
    if (!environment[name]) {
      throw new E2ELibraryIsolationError('<unset>', sandboxRoot, `missing-${name}`)
    }
  }
  assertContained(environment.HOME!, sandboxRoot, 'HOME')
  assertContained(environment.SWOB_LIBRARY_ROOT!, sandboxRoot, 'SWOB_LIBRARY_ROOT')
  assertContained(environment.SWOB_USER_DATA_ROOT!, sandboxRoot, 'SWOB_USER_DATA_ROOT')
  assertContained(userDataPath, sandboxRoot, 'actual-userData')
  assertContained(sandboxRoot, systemTemporaryRoot, 'sandbox')
  if (canonicalPathThroughExistingAncestor(userDataPath) !==
    canonicalPathThroughExistingAncestor(environment.SWOB_USER_DATA_ROOT!)) {
    throw new E2ELibraryIsolationError(userDataPath, sandboxRoot, 'actual-userData-does-not-match-SWOB_USER_DATA_ROOT')
  }
}

export function runtimeSafetyState(
  candidatePath: string,
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): RuntimeSafetyState {
  if (testRuntimeRequested(environment)) {
    assertTestContract(candidatePath, environment, options)
    return { mode: 'isolated-test', dangerousRealLibrary: false, marker: null }
  }

  if (developmentRuntimeRequested(environment, options)) {
    let overlapsRealState = false
    try {
      overlapsRealState = protectedRealPaths(environment, options)
        .some((protectedPath) => canonicalPathsOverlap(candidatePath, protectedPath))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || 'unknown'
      throw new E2ELibraryIsolationError(candidatePath, '<none>', `development-realpath-failed:${code}`)
    }
    if (overlapsRealState) {
      if (environment.SWOB_DEV_USE_REAL_LIBRARY !== '1') {
        throw new E2ELibraryIsolationError(candidatePath, '<none>', 'development-real-library-requires-SWOB_DEV_USE_REAL_LIBRARY=1')
      }
      return {
        mode: 'dangerous-real-library-development',
        dangerousRealLibrary: true,
        marker: 'DEV · REAL LIBRARY'
      }
    }
    return { mode: 'isolated-development', dangerousRealLibrary: false, marker: null }
  }

  return { mode: 'production', dangerousRealLibrary: false, marker: null }
}

/** Every runtime Library selection passes through the same test/dev safety gate. */
export function assertE2ELibraryPath(
  candidatePath: string,
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): string {
  runtimeSafetyState(candidatePath, environment, options)
  return candidatePath
}

/** Guard the module-level default before any Library/config write path is reachable. */
export function assertTestDefaultLibraryPath(
  candidatePath: string,
  environment: IsolationEnvironment = process.env,
  options: RuntimeIsolationOptions = {}
): string {
  return assertE2ELibraryPath(candidatePath, environment, options)
}
