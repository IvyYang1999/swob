import * as fs from 'node:fs'
import Database from 'better-sqlite3'

/**
 * Synthetic damage for a synthetic search.db (F1d-3 tests): never applied to
 * a real index. Each helper writes the damage SQLite reports for a real
 * failure: a file cut short (SQLITE_CORRUPT), a header that is not SQLite's
 * (SQLITE_NOTADB), b-tree page headers overwritten (SQLITE_CORRUPT when the
 * pages are read).
 */

/** Cut the file to half its size: pages the header promises are missing. */
export function truncateSearchIndex(filePath: string): void {
  fs.truncateSync(filePath, Math.floor(fs.statSync(filePath).size / 2))
}

/** Overwrite the 16-byte "SQLite format 3\0" magic: the file is no database at all. */
export function overwriteSearchIndexHeader(filePath: string): void {
  const descriptor = fs.openSync(filePath, 'r+')
  try {
    fs.writeSync(descriptor, Buffer.from('not a database!\0', 'latin1'), 0, 16, 0)
  } finally {
    fs.closeSync(descriptor)
  }
}

function pageSizeOf(filePath: string): number {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const header = Buffer.alloc(2)
    fs.readSync(descriptor, header, 0, 2, 16)
    const size = header.readUInt16BE(0)
    return size === 1 ? 65_536 : size
  } finally {
    fs.closeSync(descriptor)
  }
}

/** Overwrite the b-tree page header of each page with 0xff: an invalid page type. */
export function breakPageHeaders(filePath: string, pages: number[]): void {
  const pageSize = pageSizeOf(filePath)
  const descriptor = fs.openSync(filePath, 'r+')
  try {
    for (const page of pages) {
      const offset = (page - 1) * pageSize + (page === 1 ? 100 : 0)
      fs.writeSync(descriptor, Buffer.alloc(12, 0xff), 0, 12, offset)
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

/**
 * Break the root pages of the full-text shadow tables only (the index must be
 * closed, checkpointed): `sessions` stays readable, so a writer's hot pass is
 * fine while a full-text query fails. The lookup connection is the last one
 * and closes cleanly, so it leaves no -wal/-shm behind.
 */
export function breakFullTextPages(filePath: string): number[] {
  const db = new Database(filePath, { fileMustExist: true })
  let pages: number[]
  try {
    pages = (db.prepare(
      "SELECT rootpage FROM sqlite_master WHERE name IN ('messages_fts_data', 'messages_fts_idx', 'messages_fts_content') AND rootpage > 1"
    ).all() as Array<{ rootpage: number }>).map((row) => row.rootpage)
  } finally {
    db.close()
  }
  breakPageHeaders(filePath, pages)
  return pages
}

/**
 * Append pages no b-tree or freelist refers to and count them in the header
 * (the index must be closed, checkpointed). Every query still works; only
 * PRAGMA quick_check sees it ("Page N: never used"): damage no reader or
 * writer ever trips over, that only the active check finds.
 */
export function addUnusedPages(filePath: string, count = 2): void {
  const pageSize = pageSizeOf(filePath)
  const descriptor = fs.openSync(filePath, 'r+')
  try {
    const header = Buffer.alloc(4)
    fs.readSync(descriptor, header, 0, 4, 28)
    const pages = header.readUInt32BE(0)
    fs.writeSync(descriptor, Buffer.alloc(pageSize * count, 0), 0, pageSize * count, pages * pageSize)
    header.writeUInt32BE(pages + count, 0)
    fs.writeSync(descriptor, header, 0, 4, 28)
  } finally {
    fs.closeSync(descriptor)
  }
}
