import * as fs from 'node:fs'
import * as path from 'node:path'

export class PathContainmentError extends Error {
  readonly code = 'PATH_OUTSIDE_ALLOWED_ROOTS'

  constructor(message = 'Path is outside the allowed roots') {
    super(message)
    this.name = 'PathContainmentError'
  }
}

export interface ResolveWithinRootOptions {
  allowRoot?: boolean
  allowAbsolute?: boolean
  mustExist?: boolean
}

function isWithin(candidate: string, root: string, allowRoot: boolean): boolean {
  if (candidate === root) return allowRoot
  return candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

function canonicalizeWithExistingAncestor(input: string): string {
  let cursor = path.resolve(input)
  const missing: string[] = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    missing.unshift(path.basename(cursor))
    cursor = parent
  }
  const base = fs.existsSync(cursor) ? fs.realpathSync.native(cursor) : path.resolve(cursor)
  return path.resolve(base, ...missing)
}

export function resolvePathWithinRoot(
  root: string,
  input: string,
  options: ResolveWithinRootOptions = {}
): string {
  const allowRoot = options.allowRoot !== false
  const allowAbsolute = options.allowAbsolute !== false
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new PathContainmentError('Path must be a non-empty string')
  }
  if (!allowAbsolute && path.isAbsolute(input)) {
    throw new PathContainmentError('Absolute paths are not accepted here')
  }

  const lexicalRoot = path.resolve(root)
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(lexicalRoot, input)
  if (!isWithin(candidate, lexicalRoot, allowRoot)) throw new PathContainmentError()

  const canonicalRoot = canonicalizeWithExistingAncestor(lexicalRoot)
  const canonicalCandidate = canonicalizeWithExistingAncestor(candidate)
  if (!isWithin(canonicalCandidate, canonicalRoot, allowRoot)) {
    throw new PathContainmentError('Path escapes the allowed root through a symlink')
  }
  if (options.mustExist && !fs.existsSync(candidate)) {
    throw new PathContainmentError('Path does not exist')
  }
  return candidate
}

export function assertPathWithinAllowedRoots(
  input: string,
  roots: string[],
  options: Omit<ResolveWithinRootOptions, 'allowAbsolute'> = {}
): string {
  if (typeof input !== 'string' || !path.isAbsolute(input)) {
    throw new PathContainmentError('Only absolute paths are accepted')
  }
  for (const root of roots) {
    if (!root) continue
    try {
      return resolvePathWithinRoot(root, input, { ...options, allowAbsolute: true })
    } catch (error) {
      if (!(error instanceof PathContainmentError)) throw error
    }
  }
  throw new PathContainmentError()
}
