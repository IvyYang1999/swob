import * as fs from 'node:fs'
import * as path from 'node:path'
import * as chokidar from 'chokidar'

interface FSEventsBackend {
  watch: (root: string, handler: (changedPath: string, flags: number) => void) => () => Promise<void>
  getInfo: (changedPath: string, flags: number) => { event: string; type?: string }
  constants: {
    MustScanSubDirs: number
    UserDropped: number
    KernelDropped: number
  }
}

export interface LibraryDirectoryWatcher {
  readonly backend: 'fsevents' | 'chokidar' | 'shallow-fallback'
  close: () => Promise<void>
}

interface WatchLibraryDirectoryOptions {
  root: string
  onDirty: (changedPath: string) => void
  onError: (error: unknown) => void
  platform?: NodeJS.Platform
  loadFSEvents?: () => FSEventsBackend
  watchShallow?: typeof fs.watch
}

const IGNORED_SEGMENTS = new Set(['node_modules', '.git', '.obsidian'])

export function shouldRescanLibraryPath(changedPath: string): boolean {
  const segments = changedPath.split(/[\\/]+/).filter(Boolean)
  if (segments.some((segment) => IGNORED_SEGMENTS.has(segment))) return false
  const name = path.basename(changedPath)
  if (!name) return true
  return name === '.swob-session.json' ||
    name === '.swob-config.json' ||
    name === 'backup.jsonl' ||
    name.endsWith('.icloud') ||
    path.extname(name) === ''
}

function watchWithFSEvents(options: WatchLibraryDirectoryOptions): LibraryDirectoryWatcher {
  const fsevents = options.loadFSEvents?.() || require('fsevents') as FSEventsBackend
  const droppedMask = fsevents.constants.MustScanSubDirs |
    fsevents.constants.UserDropped |
    fsevents.constants.KernelDropped
  const stop = fsevents.watch(options.root, (changedPath, flags) => {
    try {
      const info = fsevents.getInfo(changedPath, flags)
      if ((flags & droppedMask) !== 0 || info.event === 'root-changed' ||
          info.type === 'directory' || shouldRescanLibraryPath(changedPath)) {
        options.onDirty(changedPath)
      }
    } catch (error) {
      options.onError(error)
    }
  })
  return { backend: 'fsevents', close: stop }
}

function watchShallowFallback(options: WatchLibraryDirectoryOptions): LibraryDirectoryWatcher {
  const watch = options.watchShallow || fs.watch
  const watcher = watch(options.root, { persistent: true }, (_event, filename) => {
    if (filename === null || shouldRescanLibraryPath(String(filename))) {
      options.onDirty(filename === null ? options.root : path.join(options.root, String(filename)))
    }
  })
  watcher.on('error', options.onError)
  return {
    backend: 'shallow-fallback',
    close: async () => { watcher.close() }
  }
}

function watchWithChokidar(options: WatchLibraryDirectoryOptions): LibraryDirectoryWatcher {
  const watcher = chokidar.watch(options.root, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    depth: 6,
    ignored: (candidate: string) => {
      const relative = path.relative(options.root, candidate)
      return relative.split(path.sep).some((segment) => IGNORED_SEGMENTS.has(segment))
    }
  })
  const markDirty = (changedPath: string): void => {
    if (shouldRescanLibraryPath(changedPath)) options.onDirty(changedPath)
  }
  watcher
    .on('addDir', options.onDirty)
    .on('unlinkDir', options.onDirty)
    .on('add', markDirty)
    .on('unlink', markDirty)
    .on('change', markDirty)
    .on('error', options.onError)
  return { backend: 'chokidar', close: () => watcher.close() }
}

export function watchLibraryDirectory(options: WatchLibraryDirectoryOptions): LibraryDirectoryWatcher {
  if ((options.platform || process.platform) !== 'darwin') return watchWithChokidar(options)
  try {
    return watchWithFSEvents(options)
  } catch (error) {
    options.onError(new Error(
      `macOS FSEvents unavailable; using non-recursive safety fallback: ${error instanceof Error ? error.message : String(error)}`
    ))
    return watchShallowFallback(options)
  }
}
