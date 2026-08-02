import * as fs from 'node:fs'
import * as path from 'node:path'
import * as chokidar from 'chokidar'
import { hasPortablePathSegment } from './portable-path'
import { configuredCodexRoots } from './codex-session-roots'

export type SourceWatcherId = 'claude-code' | 'codex' | 'cursor'
export type SourceWatcherFileEvent = 'add' | 'change'
export type SourceWatcherBackend = 'fsevents' | 'chokidar-directory'

interface FSEventsBackend {
  watch: (root: string, handler: (changedPath: string, flags: number) => void) => () => Promise<void>
  getInfo: (changedPath: string, flags: number) => { event: string; type?: string }
  constants: {
    MustScanSubDirs: number
    UserDropped: number
    KernelDropped: number
  }
}

interface ActiveSourceBackend {
  backend: SourceWatcherBackend
  close: () => Promise<void>
}

export interface SourceWatchDefinition {
  id: SourceWatcherId
  roots: string[]
  depth: number
  /** Observe the nearest existing ancestor until roots created after startup can be watched directly. */
  watchMissingRoots?: boolean
  awaitWriteFinish?: chokidar.ChokidarOptions['awaitWriteFinish']
  matches: (filePath: string) => boolean
  ignores?: (candidatePath: string) => boolean
}

export interface SourceWatcherErrorContext {
  phase: 'start' | 'runtime' | 'close'
  retryInMs: number | null
  attempt: number
  backend: SourceWatcherBackend
}

export interface WatchSourceDirectoryOptions {
  definition: SourceWatchDefinition
  onFile: (filePath: string, event: SourceWatcherFileEvent) => void
  onReady?: (attempt: number, backend: SourceWatcherBackend, recoveryRoots: string[]) => void
  onError: (error: unknown, context: SourceWatcherErrorContext) => void
  retryInitialMs?: number
  retryMaxMs?: number
  platform?: NodeJS.Platform
  loadFSEvents?: () => FSEventsBackend
  watchFactory?: typeof chokidar.watch
}

export interface SourceDirectoryWatcher {
  readonly backend: SourceWatcherBackend
  close: () => Promise<void>
}

const DEFAULT_RETRY_INITIAL_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 30_000
const RETRY_RESET_AFTER_STABLE_MS = 60_000

function relativeSegments(root: string, candidatePath: string): string[] | null {
  const relative = path.relative(root, candidatePath)
  if (!relative || path.isAbsolute(relative)) return null
  const segments = relative.split(path.sep)
  if (segments.some((segment) => segment === '..' || segment === '')) return null
  return segments
}

function isJsonlFile(segments: string[]): boolean {
  return segments.at(-1)?.endsWith('.jsonl') === true
}

function nearestExistingWatchRoot(configuredRoot: string): {
  watchRoot: string
  missingDepth: number
} {
  let watchRoot = path.resolve(configuredRoot)
  let missingDepth = 0
  while (true) {
    try {
      if (fs.statSync(watchRoot).isDirectory()) return { watchRoot, missingDepth }
    } catch { /* walk to an existing ancestor */ }
    const parent = path.dirname(watchRoot)
    if (parent === watchRoot) return { watchRoot, missingDepth }
    watchRoot = parent
    missingDepth++
  }
}

export function createSourceWatchDefinition(
  id: SourceWatcherId,
  home: string
): SourceWatchDefinition {
  if (id === 'claude-code') {
    const standardRoot = path.join(home, '.claude', 'projects')
    const windowRoot = path.join(home, '.claude-window')
    return {
      id,
      roots: [standardRoot, windowRoot],
      depth: 3,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignores: (candidatePath) => hasPortablePathSegment(candidatePath, 'subagents'),
      matches: (filePath) => {
        if (hasPortablePathSegment(filePath, 'subagents')) return false
        const standardSegments = relativeSegments(standardRoot, filePath)
        if (standardSegments?.length === 2 && isJsonlFile(standardSegments)) return true
        const windowSegments = relativeSegments(windowRoot, filePath)
        return windowSegments?.length === 4 && windowSegments[1] === 'projects' &&
          isJsonlFile(windowSegments)
      }
    }
  }

  if (id === 'codex') {
    const codexRoots = configuredCodexRoots(home)
    const activeRoots = codexRoots.map((root) => root.sessionsDir)
    const archivedRoots = codexRoots.map((root) => root.archivedDir)
    const roots = codexRoots.map((root) => root.home)
    return {
      id,
      roots,
      depth: 5,
      watchMissingRoots: true,
      matches: (filePath) => {
        try {
          if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) return false
        } catch {
          return false
        }
        if (!path.basename(filePath).startsWith('rollout-')) return false
        for (const root of activeRoots) {
          const segments = relativeSegments(root, filePath)
          if (segments !== null && segments.length >= 1 && segments.length <= 5 && isJsonlFile(segments)) {
            return true
          }
        }
        for (const root of archivedRoots) {
          const segments = relativeSegments(root, filePath)
          if (segments?.length === 1 && isJsonlFile(segments)) return true
        }
        return false
      }
    }
  }

  const root = path.join(home, '.cursor', 'projects')
  return {
    id,
    roots: [root],
    depth: 3,
    matches: (filePath) => {
      const segments = relativeSegments(root, filePath)
      return segments?.length === 4 && segments[1] === 'agent-transcripts' &&
        isJsonlFile(segments)
    }
  }
}

class ResilientSourceDirectoryWatcher implements SourceDirectoryWatcher {
  private readonly options: WatchSourceDirectoryOptions
  private readonly watchFactory: typeof chokidar.watch
  private readonly retryInitialMs: number
  private readonly retryMaxMs: number
  private readonly platform: NodeJS.Platform
  private readonly pendingCloses = new Set<Promise<void>>()
  private activeBackend: ActiveSourceBackend | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryResetTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private pendingRecoveryRoots: string[] = []
  private closed = false

  constructor(options: WatchSourceDirectoryOptions) {
    this.options = options
    this.watchFactory = options.watchFactory || chokidar.watch
    this.retryInitialMs = Math.max(1, options.retryInitialMs ?? DEFAULT_RETRY_INITIAL_MS)
    this.retryMaxMs = Math.max(this.retryInitialMs, options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS)
    this.platform = options.platform || process.platform
    this.start()
  }

  get backend(): SourceWatcherBackend {
    return this.activeBackend?.backend || (this.platform === 'darwin' ? 'fsevents' : 'chokidar-directory')
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.retryResetTimer) {
      clearTimeout(this.retryResetTimer)
      this.retryResetTimer = null
    }
    const activeBackend = this.activeBackend
    this.activeBackend = null
    if (activeBackend) await this.closeBackend(activeBackend)
    await Promise.all([...this.pendingCloses])
  }

  private start(): void {
    if (this.closed) return
    if (this.platform === 'darwin') {
      try {
        const backend = this.startFSEvents()
        this.activate(backend)
        return
      } catch (error) {
        this.reportError(error, {
          phase: 'start',
          retryInMs: null,
          attempt: this.retryAttempt,
          backend: 'fsevents'
        })
      }
    }

    try {
      this.activate(this.startChokidar())
    } catch (error) {
      this.scheduleRetry(error, 'start', 'chokidar-directory')
    }
  }

  private startFSEvents(): ActiveSourceBackend {
    const roots = this.options.definition.roots.flatMap((configuredRoot) => {
      if (!this.options.definition.watchMissingRoots && !fs.existsSync(configuredRoot)) return []
      const resolved = nearestExistingWatchRoot(configuredRoot)
      return [{
        configuredRoot,
        lexicalWatchRoot: resolved.watchRoot,
        watchedRoot: fs.realpathSync.native(resolved.watchRoot),
        missingAtStart: resolved.missingDepth > 0
      }]
    })
    if (roots.length === 0) throw new Error('No source directory exists yet')
    const fsevents = this.options.loadFSEvents?.() || require('fsevents') as FSEventsBackend
    const droppedMask = fsevents.constants.MustScanSubDirs |
      fsevents.constants.UserDropped |
      fsevents.constants.KernelDropped
    const stops: Array<() => Promise<void>> = []
    let backend!: ActiveSourceBackend

    try {
      for (const { configuredRoot, lexicalWatchRoot, watchedRoot, missingAtStart } of roots) {
        stops.push(fsevents.watch(watchedRoot, (changedPath, flags) => {
          if (this.closed || this.activeBackend !== backend) return
          if ((flags & droppedMask) !== 0) {
            const error = Object.assign(new Error('FSEvents dropped source changes; watcher rebuild required'), {
              code: 'FSEVENTS_DROPPED'
            })
            this.handleRuntimeError(backend, error)
            return
          }
          try {
            const info = fsevents.getInfo(changedPath, flags)
            if (missingAtStart && fs.existsSync(configuredRoot)) {
              const error = Object.assign(new Error('Configured source root appeared; narrowing watcher'), {
                code: 'SOURCE_ROOT_APPEARED'
              })
              this.handleRuntimeError(backend, error, [configuredRoot])
              return
            }
            if (info.event === 'root-changed') {
              const error = Object.assign(new Error('FSEvents source root changed; watcher rebuild required'), {
                code: 'FSEVENTS_ROOT_CHANGED'
              })
              this.handleRuntimeError(backend, error)
              return
            }
            const changedRelative = path.relative(watchedRoot, changedPath)
            const configuredPath = !path.isAbsolute(changedRelative) &&
                !changedRelative.split(path.sep).includes('..')
              ? path.join(lexicalWatchRoot, changedRelative)
              : changedPath
            if (info.event === 'created') this.handleFile(backend, configuredPath, 'add')
            else if (info.event === 'modified') this.handleFile(backend, configuredPath, 'change')
          } catch (error) {
            this.handleRuntimeError(backend, error)
          }
        }))
      }
    } catch (error) {
      void Promise.all(stops.map((stop) => stop())).catch(() => undefined)
      throw error
    }

    backend = {
      backend: 'fsevents',
      close: async () => { await Promise.all(stops.map((stop) => stop())) }
    }
    return backend
  }

  private startChokidar(): ActiveSourceBackend {
    const resolvedRoots = this.options.definition.roots.map((configuredRoot) => ({
      configuredRoot,
      ...(this.options.definition.watchMissingRoots
        ? nearestExistingWatchRoot(configuredRoot)
        : { watchRoot: configuredRoot, missingDepth: 0 })
    }))
    const missingRoots = resolvedRoots
      .filter(({ missingDepth }) => missingDepth > 0)
      .map(({ configuredRoot }) => configuredRoot)
    const watchRoots = [...new Set(resolvedRoots.map(({ watchRoot }) => watchRoot))]
    const depth = this.options.definition.depth + Math.max(
      0,
      ...resolvedRoots.map(({ missingDepth }) => missingDepth)
    )
    const watcher = this.watchFactory(watchRoots, {
      ignoreInitial: true,
      ignorePermissionErrors: true,
      followSymlinks: false,
      depth,
      awaitWriteFinish: this.options.definition.awaitWriteFinish,
      ignored: this.options.definition.ignores
    })
    const backend: ActiveSourceBackend = {
      backend: 'chokidar-directory',
      close: () => watcher.close()
    }
    watcher
      .on('ready', () => this.handleReady(backend))
      .on('addDir', () => {
        if (missingRoots.some((configuredRoot) => fs.existsSync(configuredRoot))) {
          const error = Object.assign(new Error('Configured source root appeared; narrowing watcher'), {
            code: 'SOURCE_ROOT_APPEARED'
          })
          this.handleRuntimeError(backend, error, missingRoots.filter((configuredRoot) =>
            fs.existsSync(configuredRoot)
          ))
        }
      })
      .on('add', (filePath) => this.handleFile(backend, filePath, 'add'))
      .on('change', (filePath) => this.handleFile(backend, filePath, 'change'))
      .on('error', (error) => this.handleRuntimeError(backend, error))
    return backend
  }

  private activate(backend: ActiveSourceBackend): void {
    this.activeBackend = backend
    if (backend.backend === 'fsevents') {
      queueMicrotask(() => this.handleReady(backend))
    }
  }

  private handleReady(backend: ActiveSourceBackend): void {
    if (this.closed || this.activeBackend !== backend) return
    const attempt = this.retryAttempt
    const recoveryRoots = this.pendingRecoveryRoots
    this.pendingRecoveryRoots = []
    if (this.retryResetTimer) clearTimeout(this.retryResetTimer)
    if (attempt > 0) {
      this.retryResetTimer = setTimeout(() => {
        this.retryResetTimer = null
        if (!this.closed && this.activeBackend === backend) this.retryAttempt = 0
      }, RETRY_RESET_AFTER_STABLE_MS)
      this.retryResetTimer.unref?.()
    }
    try {
      this.options.onReady?.(attempt, backend.backend, recoveryRoots)
    } catch (error) {
      this.reportError(error, {
        phase: 'runtime',
        retryInMs: null,
        attempt,
        backend: backend.backend
      })
    }
  }

  private handleFile(
    backend: ActiveSourceBackend,
    filePath: string,
    event: SourceWatcherFileEvent
  ): void {
    if (this.closed || this.activeBackend !== backend || !this.options.definition.matches(filePath)) return
    try {
      this.options.onFile(filePath, event)
    } catch (error) {
      this.reportError(error, {
        phase: 'runtime',
        retryInMs: null,
        attempt: this.retryAttempt,
        backend: backend.backend
      })
    }
  }

  private handleRuntimeError(
    backend: ActiveSourceBackend,
    error: unknown,
    recoveryRoots: string[] = []
  ): void {
    if (this.closed || this.activeBackend !== backend) return
    if (this.retryResetTimer) {
      clearTimeout(this.retryResetTimer)
      this.retryResetTimer = null
    }
    this.activeBackend = null
    void this.closeBackend(backend)
    this.scheduleRetry(error, 'runtime', backend.backend, recoveryRoots)
  }

  private scheduleRetry(
    error: unknown,
    phase: 'start' | 'runtime',
    backend: SourceWatcherBackend,
    recoveryRoots: string[] = []
  ): void {
    if (this.closed || this.retryTimer) return
    const attempt = this.retryAttempt
    const retryInMs = Math.min(this.retryInitialMs * (2 ** attempt), this.retryMaxMs)
    this.retryAttempt++
    this.pendingRecoveryRoots = [...new Set(recoveryRoots.map((root) => path.resolve(root)))]
    this.reportError(error, { phase, retryInMs, attempt, backend })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.start()
    }, retryInMs)
    this.retryTimer.unref?.()
  }

  private closeBackend(backend: ActiveSourceBackend): Promise<void> {
    let closePromise: Promise<void>
    try {
      closePromise = backend.close()
    } catch (error) {
      this.reportError(error, {
        phase: 'close',
        retryInMs: null,
        attempt: this.retryAttempt,
        backend: backend.backend
      })
      return Promise.resolve()
    }
    const tracked = closePromise.catch((error) => {
      this.reportError(error, {
        phase: 'close',
        retryInMs: null,
        attempt: this.retryAttempt,
        backend: backend.backend
      })
    })
    this.pendingCloses.add(tracked)
    void tracked.finally(() => this.pendingCloses.delete(tracked))
    return tracked
  }

  private reportError(error: unknown, context: SourceWatcherErrorContext): void {
    try { this.options.onError(error, context) } catch { /* diagnostics must not crash the watcher */ }
  }
}

export function watchSourceDirectory(options: WatchSourceDirectoryOptions): SourceDirectoryWatcher {
  return new ResilientSourceDirectoryWatcher(options)
}
