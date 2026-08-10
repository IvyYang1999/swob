import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

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

interface PathIdentity {
  path: string
  dev: number
  ino: number
  birthtimeMs: number
}

function captureParentIdentities(libraryRoot: string, filePath: string): PathIdentity[] {
  const root = path.resolve(libraryRoot)
  const parent = path.dirname(path.resolve(filePath))
  const relative = path.relative(root, parent)
  const identities: PathIdentity[] = []
  let current = root
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment)
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LibraryPathUnsafeError(current, 'parent-identity-not-directory')
    }
    identities.push({ path: current, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs })
  }
  return identities
}

function revalidateParentIdentities(libraryRoot: string, identities: readonly PathIdentity[]): void {
  for (const identity of identities) {
    assertSafeLibraryWritePath(libraryRoot, identity.path)
    const stat = fs.lstatSync(identity.path)
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev ||
      stat.ino !== identity.ino || stat.birthtimeMs !== identity.birthtimeMs) {
      throw new LibraryPathUnsafeError(identity.path, 'parent-identity-changed')
    }
  }
}

function sameIdentity(stat: fs.Stats, expected: PathIdentity): boolean {
  return stat.dev === expected.dev && stat.ino === expected.ino && stat.birthtimeMs === expected.birthtimeMs
}

function cleanupUnvalidatedCreatedFile(target: string, opened: fs.Stats): void {
  try {
    const current = fs.lstatSync(target)
    if (current.isFile() && current.size === 0 && current.nlink === 1 &&
      sameIdentity(current, { path: target, dev: opened.dev, ino: opened.ino, birthtimeMs: opened.birthtimeMs })) {
      fs.unlinkSync(target)
    }
  } catch { /* the unsafe path stays fail-closed */ }
}

/**
 * Read an existing regular file without trusting a lexical path after it has
 * been validated. Parent identities and the target inode are rechecked after
 * open, before any bytes are consumed, closing the ancestor-swap window that
 * O_NOFOLLOW alone cannot cover.
 */
export function readSafeLibraryFileSync(
  libraryRoot: string,
  filePath: string,
  options: { maxBytes?: number; beforeOpen?: () => void } = {}
): Buffer | null {
  const target = assertSafeLibraryFileTarget(libraryRoot, filePath)
  let expectedTarget: PathIdentity
  try {
    const stat = fs.lstatSync(target)
    expectedTarget = {
      path: target,
      dev: stat.dev,
      ino: stat.ino,
      birthtimeMs: stat.birthtimeMs
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const parentIdentities = captureParentIdentities(libraryRoot, target)
  options.beforeOpen?.()
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  let fd: number
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ELOOP' || code === 'ENOTDIR') {
      throw new LibraryPathUnsafeError(target, `read-target-changed:${code}`)
    }
    throw error
  }
  try {
    const opened = fs.fstatSync(fd)
    revalidateParentIdentities(libraryRoot, parentIdentities)
    assertSafeLibraryFileTarget(libraryRoot, target)
    const current = fs.lstatSync(target)
    if (!opened.isFile() || !sameIdentity(opened, expectedTarget) ||
      !sameIdentity(opened, {
        path: target,
        dev: current.dev,
        ino: current.ino,
        birthtimeMs: current.birthtimeMs
      })) {
      throw new LibraryPathUnsafeError(target, 'read-target-identity-changed')
    }
    if (options.maxBytes !== undefined && opened.size > options.maxBytes) {
      throw new LibraryPathUnsafeError(target, 'read-target-too-large')
    }
    return fs.readFileSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function writeSafeLibraryFileSync(
  libraryRoot: string,
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  options: { exclusive?: boolean; mode?: number; beforeOpen?: () => void } = {}
): void {
  const target = assertSafeLibraryFileTarget(libraryRoot, filePath)
  const parentIdentities = captureParentIdentities(libraryRoot, target)
  let expectedTarget: PathIdentity | null = null
  try {
    const stat = fs.lstatSync(target)
    expectedTarget = { path: target, dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  options.beforeOpen?.()
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  const createsNew = options.exclusive || !expectedTarget
  const flags = fs.constants.O_WRONLY | noFollow |
    (createsNew ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0)
  let fd: number | null = null
  let opened: fs.Stats | null = null
  let validated = false
  try {
    fd = fs.openSync(target, flags, options.mode ?? 0o600)
    opened = fs.fstatSync(fd)
    revalidateParentIdentities(libraryRoot, parentIdentities)
    assertSafeLibraryFileTarget(libraryRoot, target)
    if (expectedTarget && !sameIdentity(opened, expectedTarget)) {
      throw new LibraryPathUnsafeError(target, 'target-identity-changed')
    }
    const current = fs.lstatSync(target)
    if (!sameIdentity(opened, { path: target, dev: current.dev, ino: current.ino, birthtimeMs: current.birthtimeMs })) {
      throw new LibraryPathUnsafeError(target, 'opened-target-detached')
    }
    validated = true
    fs.ftruncateSync(fd, 0)
    fs.writeFileSync(fd, content)
    try {
      fs.fsyncSync(fd)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || 'unknown'
      // Keep the write fail-closed, but retain enough non-sensitive context to
      // distinguish a lock/config/manifest flush in packaged Windows logs.
      throw new LibraryPathUnsafeError(target, `file-fsync-failed:${code}:${path.basename(target)}`)
    }
  } finally {
    if (fd !== null) fs.closeSync(fd)
    if (!validated && createsNew && opened) cleanupUnvalidatedCreatedFile(target, opened)
  }
}

/**
 * Publish a complete new inode so a crash can leave either the old or new file,
 * never a truncated mixture. The temporary file is inside the already-checked
 * parent; rename replaces a symlink itself rather than following its target.
 */
export function replaceSafeLibraryFileSync(
  libraryRoot: string,
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  options: { mode?: number; beforePublish?: (tempPath: string) => void } = {}
): void {
  const target = assertSafeLibraryFileTarget(libraryRoot, filePath)
  const parent = path.dirname(target)
  const tempPath = path.join(parent, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeSafeLibraryFileSync(libraryRoot, tempPath, content, { exclusive: true, mode: options.mode })
    options.beforePublish?.(tempPath)
    assertSafeLibraryFileTarget(libraryRoot, target)
    fs.renameSync(tempPath, target)
    try { fs.chmodSync(target, options.mode ?? 0o600) } catch { /* mode is best effort on Windows */ }
    fsyncDirectorySync(parent)
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* retain the published target */ }
  }
}

export function isUnsupportedDirectoryFsyncError(
  error: unknown,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'win32') return false
  const code = (error as NodeJS.ErrnoException)?.code
  return code === 'EPERM' || code === 'EINVAL' || code === 'EISDIR'
}

export function fsyncDirectorySync(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r')
  try {
    try {
      fs.fsyncSync(fd)
    } catch (error) {
      // Windows does not expose a portable directory-handle flush through
      // Node. File contents are still fsynced before this durability barrier;
      // only the unsupported directory-entry flush is skipped. All other
      // platforms and unexpected Windows errors remain fail-closed.
      if (!isUnsupportedDirectoryFsyncError(error)) throw error
    }
  } finally {
    fs.closeSync(fd)
  }
}
