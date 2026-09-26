/**
 * Read-only filesystem helpers for the census: directory walking that never
 * follows lower-level symlinks (Swob's discovery uses Dirent.isDirectory() /
 * isFile(), which do not follow them either) and cheap stat fingerprints.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface FileFingerprint { size: number; mtimeMs: number }

export function fingerprint(filePath: string): FileFingerprint | null {
  try {
    const stat = fs.lstatSync(filePath)
    if (!stat.isFile()) return null
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return null
  }
}

export function sameFingerprint(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  return !!left && !!right && left.size === right.size && left.mtimeMs === right.mtimeMs
}

export function isDirectory(dirPath: string): boolean {
  try {
    return fs.statSync(dirPath).isDirectory()
  } catch {
    return false
  }
}

/** Resolve a root through its own (top-level) symlinks; lower levels are never followed. */
export function realDirectory(dirPath: string): string | null {
  try {
    const real = fs.realpathSync.native(dirPath)
    return fs.statSync(real).isDirectory() ? real : null
  } catch {
    return null
  }
}

export interface WalkedFile {
  path: string
  /** Path segments relative to the walk root. */
  segments: string[]
}

export interface WalkResult {
  files: WalkedFile[]
  otherFiles: number
  otherBytes: number
  lowerSymlinks: number
  unreadableDirs: number
}

/** Recursively list files under `root` (already a real directory). */
export function walkFiles(
  root: string,
  options: { maxDepth: number; accept: (name: string, segments: string[]) => boolean }
): WalkResult {
  const result: WalkResult = { files: [], otherFiles: 0, otherBytes: 0, lowerSymlinks: 0, unreadableDirs: 0 }
  const visit = (dir: string, segments: string[]): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      result.unreadableDirs++
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      const childSegments = [...segments, entry.name]
      if (entry.isSymbolicLink()) {
        result.lowerSymlinks++
      } else if (entry.isDirectory()) {
        if (segments.length < options.maxDepth) visit(full, childSegments)
      } else if (entry.isFile()) {
        if (options.accept(entry.name, childSegments)) {
          result.files.push({ path: full, segments: childSegments })
        } else {
          result.otherFiles++
          try { result.otherBytes += fs.lstatSync(full).size } catch { /* vanished */ }
        }
      }
    }
  }
  visit(root, [])
  return result
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/

/** Only well-formed ISO timestamps may feed a reported time range. */
export function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

const Z_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

export class TimeRange {
  min: string | null = null
  max: string | null = null
  add(value: unknown): void {
    if (typeof value !== 'string') return
    const iso = Z_TIMESTAMP.test(value) ? value : isoTimestamp(value)
    if (!iso) return
    if (!this.min || iso < this.min) this.min = iso
    if (!this.max || iso > this.max) this.max = iso
  }
  merge(other: { min: string | null; max: string | null }): void {
    if (other.min) this.add(other.min)
    if (other.max) this.add(other.max)
  }
  /** Normalised [min, max] ISO strings. */
  range(): [string | null, string | null] {
    return [isoTimestamp(this.min), isoTimestamp(this.max)]
  }
}
