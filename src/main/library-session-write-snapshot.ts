import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import {
  assertSafeLibraryFileTarget,
  assertSafeLibraryWritePath,
  ensureSafeLibraryDirectory,
  fsyncDirectorySync,
  replaceSafeLibraryFileSync,
  writeSafeLibraryFileSync
} from './library-path-safety'

const TRANSACTION_MARKER = '.swob-write-transaction.json'
const SNAPSHOT_PARENT = '.swob-write-snapshots'
const PROTECTED_FILES = ['transcript.md', 'backup.jsonl', '.swob-session.json'] as const

interface SnapshotFileRecord {
  name: typeof PROTECTED_FILES[number]
  present: boolean
  size?: number
  storage?: 'hard-link' | 'copy'
  sha256?: string
  dev?: number
  ino?: number
  birthtimeMs?: number
}

interface SessionWriteSnapshotManifest {
  schemaVersion: 1
  transactionId: string
  createdAt: string
  files: SnapshotFileRecord[]
}

interface SessionWriteTransactionMarker {
  schemaVersion: 1
  transactionId: string
  snapshotDirectory: string
  createdAt: string
}

export interface SessionWriteSnapshotHandle {
  transactionId: string
  commit(): void
  rollback(): void
}

export class SessionWriteSnapshotError extends Error {
  readonly code = 'SESSION_WRITE_SNAPSHOT_UNRECOVERABLE'

  constructor(readonly reason: 'corrupt-marker' | 'corrupt-snapshot' | 'unsafe-snapshot') {
    super(`Library 会话写入快照无法安全恢复（${reason}）；已保留证据并停止写入`)
    this.name = 'SessionWriteSnapshotError'
  }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function parseMarker(content: string): SessionWriteTransactionMarker | null {
  try {
    const value = JSON.parse(content) as Partial<SessionWriteTransactionMarker>
    if (value.schemaVersion !== 1 || typeof value.transactionId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(value.transactionId) ||
      value.snapshotDirectory !== `snapshot-${value.transactionId}` ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null
    return value as SessionWriteTransactionMarker
  } catch {
    return null
  }
}

function parseManifest(content: string, transactionId: string): SessionWriteSnapshotManifest | null {
  try {
    const value = JSON.parse(content) as Partial<SessionWriteSnapshotManifest>
    if (value.schemaVersion !== 1 || value.transactionId !== transactionId ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      !Array.isArray(value.files) || value.files.length !== PROTECTED_FILES.length) return null
    for (let index = 0; index < PROTECTED_FILES.length; index++) {
      const file = value.files[index]
      if (!file || file.name !== PROTECTED_FILES[index] || typeof file.present !== 'boolean') return null
      if (file.present && (!Number.isSafeInteger(file.size) || file.size! < 0 ||
        (file.storage !== 'hard-link' && file.storage !== 'copy'))) return null
      if (file.storage === 'copy' && (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256))) return null
      if (file.storage === 'hard-link' && (!Number.isSafeInteger(file.dev) || !Number.isSafeInteger(file.ino) ||
        typeof file.birthtimeMs !== 'number' || !Number.isFinite(file.birthtimeMs))) return null
      if (!file.present && (file.size !== undefined || file.storage !== undefined || file.sha256 !== undefined ||
        file.dev !== undefined || file.ino !== undefined || file.birthtimeMs !== undefined)) return null
    }
    return value as SessionWriteSnapshotManifest
  } catch {
    return null
  }
}

function markerPath(sessionDir: string): string {
  return path.join(sessionDir, TRANSACTION_MARKER)
}

function readMarker(sessionDir: string): SessionWriteTransactionMarker | null {
  const filePath = markerPath(sessionDir)
  try {
    const marker = parseMarker(fs.readFileSync(filePath, 'utf8'))
    if (!marker) throw new SessionWriteSnapshotError('corrupt-marker')
    return marker
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    if (error instanceof SessionWriteSnapshotError) throw error
    throw new SessionWriteSnapshotError('corrupt-marker')
  }
}

function snapshotPath(sessionDir: string, marker: SessionWriteTransactionMarker): string {
  const parent = path.join(sessionDir, SNAPSHOT_PARENT)
  const result = path.join(parent, marker.snapshotDirectory)
  if (path.dirname(result) !== parent) throw new SessionWriteSnapshotError('unsafe-snapshot')
  return result
}

function readValidatedSnapshot(
  libraryRoot: string,
  sessionDir: string,
  marker: SessionWriteTransactionMarker
): Array<{ record: SnapshotFileRecord; snapshotFilePath?: string; content?: Buffer }> {
  const directory = snapshotPath(sessionDir, marker)
  assertSafeLibraryWritePath(libraryRoot, directory, { allowRoot: false })
  let manifest: SessionWriteSnapshotManifest | null = null
  try {
    const stat = fs.lstatSync(directory)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SessionWriteSnapshotError('unsafe-snapshot')
    manifest = parseManifest(fs.readFileSync(path.join(directory, 'snapshot.json'), 'utf8'), marker.transactionId)
  } catch (error) {
    if (error instanceof SessionWriteSnapshotError) throw error
  }
  if (!manifest) throw new SessionWriteSnapshotError('corrupt-snapshot')
  return manifest.files.map((record) => {
    if (!record.present) return { record }
    const filePath = path.join(directory, record.name)
    try {
      assertSafeLibraryFileTarget(libraryRoot, filePath)
      const stat = fs.lstatSync(filePath)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not-file')
      if (stat.size !== record.size || (record.storage === 'hard-link' &&
        (stat.dev !== record.dev || stat.ino !== record.ino || stat.birthtimeMs !== record.birthtimeMs))) {
        throw new Error('snapshot-evidence-mismatch')
      }
      if (record.storage === 'hard-link') return { record, snapshotFilePath: filePath }
      const content = fs.readFileSync(filePath)
      if (sha256(content) !== record.sha256) throw new Error('snapshot-hash-mismatch')
      return { record, snapshotFilePath: filePath, content }
    } catch {
      throw new SessionWriteSnapshotError('corrupt-snapshot')
    }
  })
}

function removeSnapshotEvidence(sessionDir: string, marker: SessionWriteTransactionMarker): void {
  const directory = snapshotPath(sessionDir, marker)
  fs.rmSync(directory, { recursive: true, force: false })
  const parent = path.dirname(directory)
  try { fs.rmdirSync(parent) } catch { /* a separate committed orphan may remain */ }
  fsyncDirectorySync(sessionDir)
}

/**
 * Internal write-boundary primitive: callers must already hold the root writer
 * lease. Restore is idempotent; the marker is removed only after all three old
 * files are durable.
 */
export function recoverIncompleteSessionWriteSnapshot(libraryRoot: string, sessionDir: string): boolean {
  const marker = readMarker(sessionDir)
  if (!marker) return false
  const files = readValidatedSnapshot(libraryRoot, sessionDir, marker)
  for (const { record, snapshotFilePath, content } of files) {
    const target = path.join(sessionDir, record.name)
    assertSafeLibraryFileTarget(libraryRoot, target)
    if (record.present) {
      if (record.storage === 'hard-link') {
        const tempPath = path.join(sessionDir, `.${record.name}.${process.pid}.${randomUUID()}.restore`)
        try {
          fs.linkSync(snapshotFilePath!, tempPath)
          assertSafeLibraryFileTarget(libraryRoot, target)
          fs.renameSync(tempPath, target)
          fsyncDirectorySync(sessionDir)
        } finally {
          try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* target stays authoritative */ }
        }
      } else {
        replaceSafeLibraryFileSync(libraryRoot, target, content!)
      }
    } else {
      try {
        const stat = fs.lstatSync(target)
        if (stat.isSymbolicLink() || !stat.isFile()) throw new SessionWriteSnapshotError('unsafe-snapshot')
        fs.unlinkSync(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  fsyncDirectorySync(sessionDir)
  fs.unlinkSync(markerPath(sessionDir))
  fsyncDirectorySync(sessionDir)
  removeSnapshotEvidence(sessionDir, marker)
  return true
}

export function beginSessionWriteSnapshot(libraryRoot: string, sessionDir: string): SessionWriteSnapshotHandle {
  recoverIncompleteSessionWriteSnapshot(libraryRoot, sessionDir)
  const transactionId = randomUUID()
  const snapshotParent = ensureSafeLibraryDirectory(libraryRoot, path.join(sessionDir, SNAPSHOT_PARENT))
  const directoryName = `snapshot-${transactionId}`
  const directory = path.join(snapshotParent, directoryName)
  assertSafeLibraryWritePath(libraryRoot, directory, { allowRoot: false })
  fs.mkdirSync(directory, { mode: 0o700 })
  fsyncDirectorySync(snapshotParent)

  const files: SnapshotFileRecord[] = []
  for (const name of PROTECTED_FILES) {
    const source = path.join(sessionDir, name)
    try {
      assertSafeLibraryFileTarget(libraryRoot, source)
      const stat = fs.lstatSync(source)
      if (stat.isSymbolicLink() || !stat.isFile()) throw new SessionWriteSnapshotError('unsafe-snapshot')
      const destination = path.join(directory, name)
      try {
        // A hard link is an O(1) immutable snapshot because every protected
        // writer publishes a new inode. Filesystems without hard-link support
        // retain the same safety via a durable byte copy.
        fs.linkSync(source, destination)
        files.push({
          name,
          present: true,
          size: stat.size,
          storage: 'hard-link',
          dev: stat.dev,
          ino: stat.ino,
          birthtimeMs: stat.birthtimeMs
        })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['EPERM', 'EACCES', 'EINVAL', 'EMLINK', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes(code || '')) {
          throw error
        }
        const content = fs.readFileSync(source)
        writeSafeLibraryFileSync(libraryRoot, destination, content, { exclusive: true, mode: 0o600 })
        files.push({ name, present: true, size: content.length, storage: 'copy', sha256: sha256(content) })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push({ name, present: false })
      else throw error
    }
  }
  const createdAt = new Date().toISOString()
  writeSafeLibraryFileSync(libraryRoot, path.join(directory, 'snapshot.json'), JSON.stringify({
    schemaVersion: 1,
    transactionId,
    createdAt,
    files
  } satisfies SessionWriteSnapshotManifest), { exclusive: true, mode: 0o600 })
  fsyncDirectorySync(directory)
  const marker: SessionWriteTransactionMarker = {
    schemaVersion: 1,
    transactionId,
    snapshotDirectory: directoryName,
    createdAt
  }
  writeSafeLibraryFileSync(libraryRoot, markerPath(sessionDir), JSON.stringify(marker), { exclusive: true, mode: 0o600 })
  fsyncDirectorySync(sessionDir)

  let finished = false
  return {
    transactionId,
    commit(): void {
      if (finished) return
      finished = true
      fs.unlinkSync(markerPath(sessionDir))
      fsyncDirectorySync(sessionDir)
      removeSnapshotEvidence(sessionDir, marker)
    },
    rollback(): void {
      if (finished) return
      recoverIncompleteSessionWriteSnapshot(libraryRoot, sessionDir)
      finished = true
    }
  }
}

export function withSessionWriteSnapshotSync<T>(
  libraryRoot: string,
  sessionDir: string,
  operation: () => T
): T {
  const snapshot = beginSessionWriteSnapshot(libraryRoot, sessionDir)
  try {
    const result = operation()
    snapshot.commit()
    return result
  } catch (error) {
    snapshot.rollback()
    throw error
  }
}

export async function withSessionWriteSnapshot<T>(
  libraryRoot: string,
  sessionDir: string,
  operation: () => Promise<T> | T
): Promise<T> {
  const snapshot = beginSessionWriteSnapshot(libraryRoot, sessionDir)
  try {
    const result = await operation()
    snapshot.commit()
    return result
  } catch (error) {
    snapshot.rollback()
    throw error
  }
}
