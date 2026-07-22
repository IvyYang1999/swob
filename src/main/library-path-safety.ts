import * as fs from 'node:fs'
import * as path from 'node:path'

export class LibraryPathUnsafeError extends Error {
  readonly code = 'LIBRARY_PATH_UNSAFE'

  constructor(readonly targetPath: string, readonly reason: string) {
    super(`Library write path is unsafe: ${reason}`)
    this.name = 'LibraryPathUnsafeError'
  }
}

function isWithin(root: string, candidate: string, allowRoot = true): boolean {
  const relative = path.relative(root, candidate)
  if (relative === '') return allowRoot
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Resolve the configured Library root once while rejecting a root that is
 * itself a symlink/junction. Symlinks above the configured boundary are fine:
 * only descendants of the canonical root are controlled by Swob.
 */
export function canonicalLibraryRootForWrite(libraryRoot: string): string {
  const resolvedRoot = path.resolve(libraryRoot)
  let rootStat: fs.Stats
  try {
    rootStat = fs.lstatSync(resolvedRoot)
  } catch (error) {
    throw new LibraryPathUnsafeError(resolvedRoot, `library-root-unreadable:${(error as NodeJS.ErrnoException).code || 'unknown'}`)
  }
  if (rootStat.isSymbolicLink()) throw new LibraryPathUnsafeError(resolvedRoot, 'library-root-is-link')
  if (!rootStat.isDirectory()) throw new LibraryPathUnsafeError(resolvedRoot, 'library-root-not-directory')
  try {
    return fs.realpathSync(resolvedRoot)
  } catch (error) {
    throw new LibraryPathUnsafeError(resolvedRoot, `library-root-realpath-failed:${(error as NodeJS.ErrnoException).code || 'unknown'}`)
  }
}

/**
 * Validate every existing component below the Library root. This catches
 * POSIX symlinks and Windows junction/reparse aliases before the first write.
 */
export function assertSafeLibraryWritePath(
  libraryRoot: string,
  targetPath: string,
  options: { allowRoot?: boolean } = {}
): string {
  const lexicalRoot = path.resolve(libraryRoot)
  const lexicalTarget = path.resolve(targetPath)
  if (!isWithin(lexicalRoot, lexicalTarget, options.allowRoot !== false)) {
    throw new LibraryPathUnsafeError(lexicalTarget, 'lexical-escape')
  }

  const canonicalRoot = canonicalLibraryRootForWrite(lexicalRoot)
  const relative = path.relative(lexicalRoot, lexicalTarget)
  let current = lexicalRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw new LibraryPathUnsafeError(current, `ancestor-unreadable:${(error as NodeJS.ErrnoException).code || 'unknown'}`)
    }
    if (stat.isSymbolicLink()) throw new LibraryPathUnsafeError(current, 'link-or-junction-component')
    let canonicalCurrent: string
    try {
      canonicalCurrent = fs.realpathSync(current)
    } catch (error) {
      throw new LibraryPathUnsafeError(current, `realpath-failed:${(error as NodeJS.ErrnoException).code || 'unknown'}`)
    }
    if (!isWithin(canonicalRoot, canonicalCurrent, true)) {
      throw new LibraryPathUnsafeError(current, 'canonical-escape')
    }
  }
  return lexicalTarget
}

/** Create missing descendants one level at a time, revalidating each parent. */
export function ensureSafeLibraryDirectory(
  libraryRoot: string,
  targetDir: string,
  mode = 0o700
): string {
  const lexicalRoot = path.resolve(libraryRoot)
  const lexicalTarget = assertSafeLibraryWritePath(lexicalRoot, targetDir)
  const relative = path.relative(lexicalRoot, lexicalTarget)
  let current = lexicalRoot
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    assertSafeLibraryWritePath(lexicalRoot, current)
    current = path.join(current, segment)
    try {
      fs.mkdirSync(current, { mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LibraryPathUnsafeError(current, 'created-component-not-directory')
    }
    assertSafeLibraryWritePath(lexicalRoot, current)
  }
  return lexicalTarget
}

export function assertSafeLibraryFileTarget(libraryRoot: string, filePath: string): string {
  const target = assertSafeLibraryWritePath(libraryRoot, filePath, { allowRoot: false })
  assertSafeLibraryWritePath(libraryRoot, path.dirname(target))
  try {
    const stat = fs.lstatSync(target)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new LibraryPathUnsafeError(target, 'target-not-regular-file')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return target
}

export function writeSafeLibraryFileSync(
  libraryRoot: string,
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  options: { exclusive?: boolean; mode?: number } = {}
): void {
  const target = assertSafeLibraryFileTarget(libraryRoot, filePath)
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollow |
    (options.exclusive ? fs.constants.O_EXCL : fs.constants.O_TRUNC)
  const fd = fs.openSync(target, flags, options.mode ?? 0o600)
  try {
    fs.writeFileSync(fd, content)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function fsyncDirectorySync(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}
