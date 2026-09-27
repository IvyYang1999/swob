import * as fs from 'node:fs'
import * as path from 'node:path'
import { defaultLineageBackupDirectory } from './session-lineage'

/**
 * What Swob moves aside itself stays in its state directory, never in the
 * Library: the lineage registry backups (F1d-2, `lineage-backups/`) and, next
 * to them, the search indexes SQLite found corrupt (F1d-3). The directory is
 * derived from the lineage one, so the two stay siblings.
 */
export function searchIndexBackupDirectory(): string {
  return path.join(path.dirname(defaultLineageBackupDirectory()), 'search-backups')
}

/** What SQLite may keep next to a database; a moved index takes each along under its own suffix. */
export const SEARCH_INDEX_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const

/**
 * `search-<ISO time>-<pid>[-<n>].db.corrupt`: a search index moved aside
 * whole (F1d-3). Its companions keep SQLite's suffixes
 * (`….db.corrupt-wal`), so the copy opens together with them.
 */
export const SEARCH_INDEX_BACKUP_FILE_NAME =
  /^search-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(\d+)(?:-(\d+))?\.db\.corrupt(-wal|-shm|-journal)?$/

export function searchIndexBackupName(at: Date, pid: number, attempt: number): string {
  return `search-${at.toISOString().replace(/[:.]/g, '-')}-${pid}${attempt ? `-${attempt}` : ''}.db.corrupt`
}

/**
 * The lineage registry copies F1d-2 writes (session-lineage.ts,
 * createBackupFile): `session-lineage-<ISO time>-<pid>[-<n>].json`. Stricter
 * than the name F1d-2 recognises: a hand-named copy there is never pruned.
 */
export const LINEAGE_REGISTRY_BACKUP_FILE_NAME =
  /^session-lineage-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(\d+)(?:-(\d+))?\.json$/

/** How much of its own backups Swob keeps (F1d-3). */
export const PROGRAM_BACKUP_LIMITS = {
  /** Moved-aside search indexes: about as large as the index itself (hundreds of MB), so one. */
  searchIndexBackups: 1,
  /** Lineage registry copies: small, and the only other copy of aliases and decisions. */
  lineageRegistryBackups: 3,
  /** Both kinds together, oldest first; the newest of each kind is never deleted for it. */
  totalBytes: 1024 ** 3
} as const

export type ProgramBackupKind = 'search-index' | 'lineage-registry'

interface BackupFile {
  readonly name: string
  readonly bytes: number
  readonly dev: number
  readonly ino: number
}

/** One backup: a lineage copy, or a moved index with the companions that went with it. */
interface Backup {
  readonly kind: ProgramBackupKind
  /** The lineage copy's name, or the moved index's `.db.corrupt` name. */
  readonly name: string
  readonly stamp: string
  readonly attempt: number
  readonly files: BackupFile[]
  /** A lineage copy always; a moved index when its `.db.corrupt` file is there. */
  complete: boolean
  bytes: number
}

function backupDirectory(kind: ProgramBackupKind): string {
  return kind === 'search-index' ? searchIndexBackupDirectory() : defaultLineageBackupDirectory()
}

function backupPattern(kind: ProgramBackupKind): RegExp {
  return kind === 'search-index' ? SEARCH_INDEX_BACKUP_FILE_NAME : LINEAGE_REGISTRY_BACKUP_FILE_NAME
}

function olderFirst(left: Backup, right: Backup): number {
  if (left.stamp !== right.stamp) return left.stamp < right.stamp ? -1 : 1
  if (left.attempt !== right.attempt) return left.attempt - right.attempt
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}

/**
 * The backups of one kind, older first: only regular files directly in the
 * kind's directory whose names Swob gives them. Anything else there (another
 * name, a directory, a symbolic link) is not listed, so never touched.
 */
function listBackups(kind: ProgramBackupKind): Backup[] {
  const directory = backupDirectory(kind)
  let names: string[]
  try {
    if (!fs.lstatSync(directory).isDirectory()) return []
    names = fs.readdirSync(directory)
  } catch {
    return []
  }
  const backups = new Map<string, Backup>()
  for (const name of names) {
    const match = backupPattern(kind).exec(name)
    if (!match) continue
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(path.join(directory, name))
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    const companion = kind === 'search-index' ? match[4] : undefined
    const key = companion ? name.slice(0, -companion.length) : name
    const backup: Backup = backups.get(key) ?? {
      kind,
      name: key,
      stamp: match[1],
      attempt: Number(match[3] || 0),
      files: [],
      complete: kind === 'lineage-registry',
      bytes: 0
    }
    backup.files.push({ name, bytes: stat.size, dev: stat.dev, ino: stat.ino })
    backup.bytes += stat.size
    if (!companion) backup.complete = true
    backups.set(key, backup)
  }
  for (const backup of backups.values()) backup.files.sort((left, right) => (left.name < right.name ? -1 : 1))
  return [...backups.values()].sort(olderFirst)
}

/** The last check before a deletion: a file Swob did not name, or outside its directories, is never deleted. */
export function assertProgramBackupFile(kind: ProgramBackupKind, filePath: string): void {
  if (path.dirname(filePath) !== backupDirectory(kind) || !backupPattern(kind).test(path.basename(filePath))) {
    throw new Error(`program-backups: refusing to delete ${path.basename(filePath)}, a file Swob did not name`)
  }
}

export interface ProgramBackupPruneOptions {
  /** Each deletion is logged before and after it (lifecycle.log in the app): kind, file name, size, rule. */
  readonly log: (event: string, fields: Record<string, unknown>) => void
  /**
   * The moved index a repair has just written and checked whole (its
   * `.db.corrupt` name). Given, older moved indexes are retired only when it
   * is the newest whole one here.
   */
  readonly verifiedSearchIndexBackup?: string
  readonly limits?: Partial<typeof PROGRAM_BACKUP_LIMITS>
}

export interface ProgramBackupPruneReport {
  readonly deleted: readonly string[]
  readonly failed: readonly string[]
  readonly keptBytes: number
  readonly overCap: boolean
}

/**
 * The one place Swob deletes its own backups (F1d-3), with every rule here:
 * - it looks only in search-backups/ and lineage-backups/, and only at
 *   regular files with the names Swob gives them; anything else, such as a
 *   hand-made `state-*-predeploy` copy, is never touched;
 * - moved search indexes: the newest whole one is kept (with any newer
 *   partial one, e.g. a repair still moving its files); older ones go. With
 *   no whole one, or when the one a repair has just checked is not the
 *   newest whole one, none goes;
 * - lineage registry copies: the newest 3 are kept;
 * - then, while both kinds together exceed 1 GiB, the oldest remaining one
 *   goes, except the newest of each kind, which is never deleted for size
 *   (program-backups-over-cap is logged instead).
 * Each deletion is logged before and after; a file that changed since it
 * was listed is left alone.
 */
export function pruneProgramBackups(options: ProgramBackupPruneOptions): ProgramBackupPruneReport {
  const limits = { ...PROGRAM_BACKUP_LIMITS, ...options.limits }
  const search = listBackups('search-index')
  const lineage = listBackups('lineage-registry')
  const doomed = new Map<Backup, 'count' | 'size-cap'>()
  const protectedBackups = new Set<Backup>()

  const whole = search.filter((backup) => backup.complete)
  const newestWhole = whole[whole.length - 1]
  const verified = newestWhole !== undefined &&
    (options.verifiedSearchIndexBackup === undefined || newestWhole.name === options.verifiedSearchIndexBackup)
  if (!verified) {
    // No whole copy yet, or the one a repair just checked is not the newest: none goes.
    for (const backup of search) protectedBackups.add(backup)
  } else {
    const oldestKept = whole[Math.max(0, whole.length - limits.searchIndexBackups)]
    for (const backup of search) {
      if (olderFirst(backup, oldestKept) < 0) doomed.set(backup, 'count')
      else if (olderFirst(backup, newestWhole) >= 0) protectedBackups.add(backup)
    }
  }
  const newestLineage = lineage[lineage.length - 1]
  if (newestLineage) protectedBackups.add(newestLineage)
  for (const backup of lineage.slice(0, Math.max(0, lineage.length - limits.lineageRegistryBackups))) {
    doomed.set(backup, 'count')
  }

  const kept = [...search, ...lineage].filter((backup) => !doomed.has(backup)).sort(olderFirst)
  let keptBytes = kept.reduce((total, backup) => total + backup.bytes, 0)
  for (const backup of kept) {
    if (keptBytes <= limits.totalBytes) break
    if (protectedBackups.has(backup)) continue
    doomed.set(backup, 'size-cap')
    keptBytes -= backup.bytes
  }

  const deleted: string[] = []
  const failed: string[] = []
  for (const [backup, rule] of doomed) {
    for (const file of backup.files) {
      const filePath = path.join(backupDirectory(backup.kind), file.name)
      assertProgramBackupFile(backup.kind, filePath)
      const fields = { kind: backup.kind, fileName: file.name, bytes: file.bytes, rule }
      options.log('program-backup-deleting', fields)
      try {
        const current = fs.lstatSync(filePath)
        if (!current.isFile() || current.dev !== file.dev || current.ino !== file.ino) {
          throw Object.assign(new Error('changed since listed'), { code: 'ECHANGED' })
        }
        fs.unlinkSync(filePath)
        options.log('program-backup-deleted', fields)
        deleted.push(file.name)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code || 'unknown'
        options.log('program-backup-delete-failed', { ...fields, code })
        failed.push(file.name)
        keptBytes += file.bytes
      }
    }
  }
  const overCap = keptBytes > limits.totalBytes
  if (overCap) options.log('program-backups-over-cap', { keptBytes, capBytes: limits.totalBytes })
  return { deleted, failed, keptBytes, overCap }
}
