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
