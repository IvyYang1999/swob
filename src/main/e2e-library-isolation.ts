import * as fs from 'node:fs'
import * as path from 'node:path'

interface IsolationEnvironment {
  NODE_ENV?: string
  SWOB_E2E_SANDBOX_ROOT?: string
  SWOB_TEST_HOME?: string
  SWOB_LIBRARY_ROOT?: string
}

export class E2ELibraryIsolationError extends Error {
  readonly candidatePath: string
  readonly sandboxRoot: string
  readonly reason: string

  constructor(candidatePath: string, sandboxRoot: string, reason: string) {
    super(`E2E Library path is unsafe: ${reason}`)
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
  // On Windows, the portable JS implementation can preserve an 8.3 segment
  // (for example RUNNER~1) for the sandbox root while a deeper child resolves
  // to the long form (runneradmin). The native call asks Windows to canonicalize
  // both sides consistently; containment still uses the resolved real paths, so
  // a sandbox-local junction/symlink escape remains rejected.
  const canonicalExisting = fs.realpathSync.native(existing)
  return path.resolve(canonicalExisting, ...missing)
}

function assertContained(candidatePath: string, sandboxRoot: string): string {
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
    throw new E2ELibraryIsolationError(resolvedCandidate, resolvedSandbox, `realpath-failed:${code}`)
  }
  if (!isContained(canonicalSandbox, canonicalCandidate)) {
    throw new E2ELibraryIsolationError(
      resolvedCandidate,
      resolvedSandbox,
      lexicallyContained ? 'canonical-outside-sandbox' : 'outside-sandbox'
    )
  }
  return candidatePath
}

/** Explicit E2E runs may only read or write a Library inside their sandbox. */
export function assertE2ELibraryPath(
  candidatePath: string,
  environment: IsolationEnvironment = process.env
): string {
  const sandboxRoot = environment.SWOB_E2E_SANDBOX_ROOT
  if (!sandboxRoot) return candidatePath
  if (!environment.SWOB_TEST_HOME) {
    throw new E2ELibraryIsolationError(candidatePath, sandboxRoot, 'test-home-missing')
  }
  assertContained(environment.SWOB_TEST_HOME, sandboxRoot)
  return assertContained(candidatePath, sandboxRoot)
}

/**
 * Even before the E2E marker is consumed, an explicit test HOME must not pair
 * with an environment-selected default Library outside that HOME.
 */
export function assertTestDefaultLibraryPath(
  candidatePath: string,
  environment: IsolationEnvironment = process.env
): string {
  if (!environment.SWOB_TEST_HOME || !environment.SWOB_LIBRARY_ROOT) return candidatePath
  return assertContained(candidatePath, environment.SWOB_E2E_SANDBOX_ROOT || environment.SWOB_TEST_HOME)
}
