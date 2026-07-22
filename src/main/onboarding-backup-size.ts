import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { sessionBackupSourcePaths } from './library-manager'
import { DEFAULT_IGNORE_DIRS } from './session-placement'
import type { SessionSummary } from './types'
import type {
  OnboardingBackupSizeBySource,
  OnboardingBackupSizeEstimate
} from '../shared/onboarding-backup-size'

const CACHE_TTL_MS = 60_000
// The 2026-07-22 local calibration found transcript + metadata add 5.3% over raw backups.
// This keeps `bytes` aligned with the user-facing logical Library write, not only backup.jsonl.
const LIBRARY_OUTPUT_OVERHEAD_RATIO = 0.053
const LIBRARY_CONFIG_FILE = '.swob-config.json'
const SESSION_META_FILE = '.swob-session.json'

interface EstimateOptions {
  sessions: readonly SessionSummary[]
  excludedSources: readonly string[]
  targetPath: string
  forceRefresh?: boolean
}

interface LogicalSessionSize {
  sessionId: string
  source: string
  bytes: number
}

interface CacheEntry {
  expiresAt: number
  value: OnboardingBackupSizeEstimate
}

function cloneEstimate(value: OnboardingBackupSizeEstimate): OnboardingBackupSizeEstimate {
  return {
    ...value,
    perSource: value.perSource.map((row) => ({ ...row }))
  }
}

function nearestExistingPath(targetPath: string): string {
  let candidate = path.resolve(targetPath)
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return candidate
}

function diskFreeBytes(targetPath: string): number {
  try {
    const stats = fs.statfsSync(nearestExistingPath(targetPath))
    const bytes = Number(stats.bavail) * Number(stats.bsize)
    if (!Number.isFinite(bytes)) return 0
    return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(bytes)))
  } catch {
    return 0
  }
}

function readLibraryIgnoreDirs(rootPath: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(rootPath, LIBRARY_CONFIG_FILE), 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const ignoreDirs = (parsed as { ignoreDirs?: unknown }).ignoreDirs
      if (Array.isArray(ignoreDirs) && ignoreDirs.every((item) => typeof item === 'string')) {
        return new Set(ignoreDirs)
      }
    }
  } catch { /* use the same defaults as a normal Library scan */ }
  return new Set(DEFAULT_IGNORE_DIRS)
}

/** Read only Swob metadata and stat session-package files; unrelated user files are never opened. */
function sessionPackageBytes(dirPath: string): number {
  let bytes = 0
  try {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      bytes += fs.statSync(path.join(dirPath, entry.name)).size
    }
  } catch { /* package can be cloud-only or disappear during estimation */ }
  return bytes
}

function existingLibraryPackageSizes(rootPath: string): Map<string, number> {
  const sizes = new Map<string, number>()
  if (!fs.existsSync(path.join(rootPath, LIBRARY_CONFIG_FILE))) return sizes

  const ignoreDirs = readLibraryIgnoreDirs(rootPath)
  const pending = [rootPath]
  while (pending.length > 0) {
    const current = pending.pop()!
    const metaPath = path.join(current, SESSION_META_FILE)
    if (fs.existsSync(metaPath)) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        const sessionId = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { sessionId?: unknown }).sessionId
          : undefined
        if (typeof sessionId === 'string' && sessionId) {
          const size = sessionPackageBytes(current)
          sizes.set(sessionId, Math.max(sizes.get(sessionId) || 0, size))
        }
      } catch { /* missing, cloud-only, or malformed package */ }
      continue
    }

    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || ignoreDirs.has(entry.name)) continue
      if (entry.isDirectory()) pending.push(path.join(current, entry.name))
    }
  }
  return sizes
}

function logicalSessionSizes(
  sessions: readonly SessionSummary[],
  excludedSources: ReadonlySet<string>
): LogicalSessionSize[] {
  const logicalSessions = new Map<string, {
    sessionId: string
    source: string
    paths: Set<string>
  }>()

  for (const session of sessions) {
    const source = session.source || 'claude-code'
    if (excludedSources.has(source)) continue
    const key = `${source}\0${session.sessionId}`
    let logical = logicalSessions.get(key)
    if (!logical) {
      logical = { sessionId: session.sessionId, source, paths: new Set() }
      logicalSessions.set(key, logical)
    }
    for (const filePath of sessionBackupSourcePaths(session)) logical.paths.add(filePath)
  }

  const countedPaths = new Set<string>()
  const output: LogicalSessionSize[] = []
  for (const logical of [...logicalSessions.values()].sort((a, b) =>
    a.source.localeCompare(b.source) || a.sessionId.localeCompare(b.sessionId)
  )) {
    let bytes = 0
    let countedFiles = 0
    for (const filePath of [...logical.paths].sort()) {
      const resolved = path.resolve(filePath)
      if (countedPaths.has(resolved)) continue
      try {
        const stat = fs.statSync(resolved)
        if (!stat.isFile()) continue
        countedPaths.add(resolved)
        bytes += stat.size
        countedFiles++
      } catch { /* a source can disappear between discovery and estimation */ }
    }
    // syncBackup concatenates multi-file logical sessions with one byte between files.
    if (countedFiles > 1) bytes += countedFiles - 1
    output.push({ sessionId: logical.sessionId, source: logical.source, bytes })
  }
  return output
}

function cacheKey(options: EstimateOptions): string {
  const hash = createHash('sha256')
  hash.update(path.resolve(options.targetPath))
  hash.update('\0')
  hash.update([...new Set(options.excludedSources)].sort().join('\0'))
  const descriptors = options.sessions.map((session) => [
    session.source || 'claude-code',
    session.sessionId,
    session.updatedAt,
    ...sessionBackupSourcePaths(session).sort()
  ].join('\0')).sort()
  for (const descriptor of descriptors) hash.update(`\n${descriptor}`)
  return hash.digest('hex')
}

export class OnboardingBackupSizeEstimator {
  private readonly cache = new Map<string, CacheEntry>()

  estimate(options: EstimateOptions): OnboardingBackupSizeEstimate {
    const key = cacheKey(options)
    const now = Date.now()
    for (const [cachedKey, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(cachedKey)
    }
    const cached = this.cache.get(key)
    if (!options.forceRefresh && cached && cached.expiresAt > now) {
      return cloneEstimate(cached.value)
    }

    const targetPath = path.resolve(options.targetPath)
    const targetIsExistingLibrary = fs.existsSync(path.join(targetPath, LIBRARY_CONFIG_FILE))
    const existingSizes = targetIsExistingLibrary
      ? existingLibraryPackageSizes(targetPath)
      : new Map<string, number>()
    const logical = logicalSessionSizes(options.sessions, new Set(options.excludedSources))
    const bySource = new Map<string, OnboardingBackupSizeBySource>()
    let totalBytes = 0
    const selectedSessionIds = new Set<string>()
    for (const session of logical) {
      const row = bySource.get(session.source) || { source: session.source, sessions: 0, bytes: 0 }
      row.sessions++
      row.bytes += session.bytes
      bySource.set(session.source, row)
      selectedSessionIds.add(session.sessionId)
    }
    for (const row of bySource.values()) {
      row.bytes = Math.ceil(row.bytes * (1 + LIBRARY_OUTPUT_OVERHEAD_RATIO))
      totalBytes += row.bytes
    }
    const existingSelectedBytes = [...selectedSessionIds].reduce(
      (sum, sessionId) => sum + (existingSizes.get(sessionId) || 0),
      0
    )
    const estimatedNewBytes = Math.max(0, totalBytes - existingSelectedBytes)

    const value: OnboardingBackupSizeEstimate = {
      perSource: [...bySource.values()].sort((a, b) => a.source.localeCompare(b.source)),
      totalBytes,
      diskFreeBytes: diskFreeBytes(targetPath),
      targetIsExistingLibrary,
      ...(targetIsExistingLibrary ? { estimatedNewBytes } : {})
    }
    this.cache.set(key, { expiresAt: now + CACHE_TTL_MS, value: cloneEstimate(value) })
    return value
  }
}

export const onboardingBackupSizeEstimator = new OnboardingBackupSizeEstimator()
