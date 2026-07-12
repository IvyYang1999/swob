import * as fs from 'fs'
import * as path from 'path'
import {
  scanLibrary,
  updateTranscript,
  getSessionDirPath,
  type LibraryFolder,
  type LibrarySession,
  type LibraryTree
} from './library-manager'

export const TRANSCRIPT_ACTIVE_WINDOW_MS = 48 * 60 * 60 * 1000
export const TRANSCRIPT_DEBOUNCE_MS = 3_000
export const TRANSCRIPT_RESCAN_INTERVAL_MS = 10 * 60 * 1000
const WATCH_FILE_POLL_INTERVAL_MS = 3_000

export interface TranscriptWatchCandidate {
  sessionId: string
  sourcePath: string
}

export interface ActiveTranscriptSource {
  sourcePath: string
  sessionIds: string[]
}

export interface ActiveTranscriptScan {
  sources: ActiveTranscriptSource[]
  totalSessionCount: number
}

export interface TranscriptWatcherStats {
  activeSourceCount: number
  activeSessionCount: number
  totalSessionCount: number
}

interface ClosableWatcher {
  close(): void
}

export interface TranscriptWatcherOptions {
  scan?: () => ActiveTranscriptScan
  generate?: (sessionId: string) => Promise<boolean>
  watchSource?: (sourcePath: string, onChange: () => void) => ClosableWatcher
  now?: () => number
  debounceMs?: number
  rescanIntervalMs?: number
  logger?: Pick<Console, 'info' | 'error'>
}

function collectLibrarySessions(tree: LibraryTree): LibrarySession[] {
  const sessions = [...tree.ungroupedSessions]
  const visit = (folder: LibraryFolder): void => {
    sessions.push(...folder.sessions)
    folder.children.forEach(visit)
  }
  tree.folders.forEach(visit)
  return sessions
}

/** Pure active-set selection: recent, existing JSONL sources, deduplicated by path. */
export function selectActiveTranscriptSources(
  candidates: TranscriptWatchCandidate[],
  now = Date.now(),
  activeWindowMs = TRANSCRIPT_ACTIVE_WINDOW_MS
): ActiveTranscriptSource[] {
  const activeByPath = new Map<string, Set<string>>()
  const cutoff = now - activeWindowMs

  for (const candidate of candidates) {
    if (path.extname(candidate.sourcePath).toLowerCase() !== '.jsonl') continue
    let mtimeMs: number
    try {
      const stat = fs.statSync(candidate.sourcePath)
      if (!stat.isFile()) continue
      mtimeMs = stat.mtimeMs
    } catch {
      continue
    }
    if (mtimeMs < cutoff) continue

    const normalizedPath = path.resolve(candidate.sourcePath)
    let sessionIds = activeByPath.get(normalizedPath)
    if (!sessionIds) {
      sessionIds = new Set<string>()
      activeByPath.set(normalizedPath, sessionIds)
    }
    sessionIds.add(candidate.sessionId)
  }

  return [...activeByPath.entries()].map(([sourcePath, sessionIds]) => ({
    sourcePath,
    sessionIds: [...sessionIds]
  }))
}

export function scanActiveTranscriptSources(now = Date.now()): ActiveTranscriptScan {
  const sessions = collectLibrarySessions(scanLibrary())
  const candidates = sessions
    .filter((session) => getSessionDirPath(session.sessionId) !== null)
    .flatMap((session) => {
      const sourceFilePaths = Array.isArray(session.meta.sourceFilePaths)
        ? session.meta.sourceFilePaths.filter((sourcePath): sourcePath is string => typeof sourcePath === 'string')
        : []
      return sourceFilePaths.map((sourcePath) => ({
        sessionId: session.sessionId,
        sourcePath
      }))
    })
  return {
    sources: selectActiveTranscriptSources(candidates, now),
    totalSessionCount: sessions.length
  }
}

/**
 * Prefer native file events. If the platform rejects a file watch, fall back to
 * low-frequency stat polling for that file only.
 */
export function watchTranscriptSource(sourcePath: string, onChange: () => void): ClosableWatcher {
  let closed = false
  let nativeWatcher: fs.FSWatcher | null = null
  let polling = false

  const startPolling = (): void => {
    if (closed || polling) return
    polling = true
    fs.watchFile(
      sourcePath,
      { interval: WATCH_FILE_POLL_INTERVAL_MS, persistent: false },
      (current, previous) => {
        if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) onChange()
      }
    )
  }

  try {
    nativeWatcher = fs.watch(sourcePath, { persistent: false }, () => onChange())
    nativeWatcher.on('error', () => {
      nativeWatcher?.close()
      nativeWatcher = null
      startPolling()
    })
  } catch {
    startPolling()
  }

  return {
    close(): void {
      if (closed) return
      closed = true
      nativeWatcher?.close()
      nativeWatcher = null
      if (polling) fs.unwatchFile(sourcePath)
    }
  }
}

export class TranscriptWatcher {
  private readonly scan: () => ActiveTranscriptScan
  private readonly generate: (sessionId: string) => Promise<boolean>
  private readonly watchSource: (sourcePath: string, onChange: () => void) => ClosableWatcher
  private readonly now: () => number
  private readonly debounceMs: number
  private readonly rescanIntervalMs: number
  private readonly logger: Pick<Console, 'info' | 'error'>
  private readonly watches = new Map<string, { watcher: ClosableWatcher; sessionIds: Set<string> }>()
  private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly generating = new Set<string>()
  private readonly rerunRequested = new Set<string>()
  private rescanTimer: ReturnType<typeof setInterval> | null = null
  private stopped = true
  private lastStatsKey = ''
  private totalSessionCount = 0

  constructor(options: TranscriptWatcherOptions = {}) {
    this.now = options.now || Date.now
    this.scan = options.scan || (() => scanActiveTranscriptSources(this.now()))
    this.generate = options.generate || updateTranscript
    this.watchSource = options.watchSource || watchTranscriptSource
    this.debounceMs = options.debounceMs ?? TRANSCRIPT_DEBOUNCE_MS
    this.rescanIntervalMs = options.rescanIntervalMs ?? TRANSCRIPT_RESCAN_INTERVAL_MS
    this.logger = options.logger || console
  }

  start(): TranscriptWatcherStats {
    if (!this.stopped) return this.getStats()
    this.stopped = false
    const stats = this.refresh()
    this.rescanTimer = setInterval(() => this.refresh(), this.rescanIntervalMs)
    this.rescanTimer.unref?.()
    return stats
  }

  refresh(): TranscriptWatcherStats {
    if (this.stopped) return this.getStats()

    let result: ActiveTranscriptScan
    try {
      result = this.scan()
    } catch (error) {
      this.logger.error('[transcript-watcher] active-set scan failed:', error)
      return this.getStats()
    }
    this.totalSessionCount = result.totalSessionCount

    const desired = new Map(result.sources.map((source) => [source.sourcePath, new Set(source.sessionIds)]))

    for (const [sourcePath, entry] of this.watches) {
      const sessionIds = desired.get(sourcePath)
      if (sessionIds) {
        entry.sessionIds = sessionIds
        desired.delete(sourcePath)
      } else {
        entry.watcher.close()
        this.watches.delete(sourcePath)
      }
    }

    for (const [sourcePath, sessionIds] of desired) {
      try {
        const entry = {
          sessionIds,
          watcher: this.watchSource(sourcePath, () => this.handleSourceChange(sourcePath))
        }
        this.watches.set(sourcePath, entry)
      } catch (error) {
        this.logger.error(`[transcript-watcher] failed to watch ${sourcePath}:`, error)
      }
    }

    const activeSessionIds = this.activeSessionIds()
    for (const [sessionId, timer] of this.debounceTimers) {
      if (activeSessionIds.has(sessionId)) continue
      clearTimeout(timer)
      this.debounceTimers.delete(sessionId)
      this.rerunRequested.delete(sessionId)
    }

    const stats = this.getStats(result.totalSessionCount)
    const statsKey = `${stats.activeSourceCount}:${stats.activeSessionCount}:${stats.totalSessionCount}`
    if (statsKey !== this.lastStatsKey) {
      this.lastStatsKey = statsKey
      this.logger.info(
        `[transcript-watcher] active sources=${stats.activeSourceCount}, ` +
        `active sessions=${stats.activeSessionCount}, total library sessions=${stats.totalSessionCount}`
      )
    }
    return stats
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.rescanTimer) clearInterval(this.rescanTimer)
    this.rescanTimer = null
    for (const { watcher } of this.watches.values()) watcher.close()
    this.watches.clear()
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    this.debounceTimers.clear()
    this.rerunRequested.clear()
  }

  getStats(totalSessionCount = this.totalSessionCount): TranscriptWatcherStats {
    return {
      activeSourceCount: this.watches.size,
      activeSessionCount: this.activeSessionIds().size,
      totalSessionCount
    }
  }

  private activeSessionIds(): Set<string> {
    const ids = new Set<string>()
    for (const { sessionIds } of this.watches.values()) {
      for (const sessionId of sessionIds) ids.add(sessionId)
    }
    return ids
  }

  private handleSourceChange(sourcePath: string): void {
    if (this.stopped) return
    const entry = this.watches.get(sourcePath)
    if (!entry) return
    for (const sessionId of entry.sessionIds) this.scheduleGeneration(sessionId)
  }

  private scheduleGeneration(sessionId: string): void {
    const existing = this.debounceTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(sessionId)
      void this.runGeneration(sessionId)
    }, this.debounceMs)
    this.debounceTimers.set(sessionId, timer)
  }

  private async runGeneration(sessionId: string): Promise<void> {
    if (this.stopped || !this.activeSessionIds().has(sessionId)) return
    if (this.generating.has(sessionId)) {
      this.rerunRequested.add(sessionId)
      return
    }

    this.generating.add(sessionId)
    try {
      do {
        this.rerunRequested.delete(sessionId)
        try {
          const updated = await this.generate(sessionId)
          if (!updated) this.logger.error(`[transcript-watcher] transcript update returned false for ${sessionId}`)
        } catch (error) {
          this.logger.error(`[transcript-watcher] transcript update failed for ${sessionId}:`, error)
        }
      } while (!this.stopped && this.rerunRequested.has(sessionId))
    } finally {
      this.generating.delete(sessionId)
      this.rerunRequested.delete(sessionId)
    }
  }
}
