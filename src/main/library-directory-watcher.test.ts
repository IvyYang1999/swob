import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { shouldRescanLibraryPath, watchLibraryDirectory } from './library-directory-watcher'

describe('library directory watcher path filter', () => {
  it('accepts structural and Swob state changes but ignores content edits and excluded trees', () => {
    expect(shouldRescanLibraryPath('/vault/new folder')).toBe(true)
    expect(shouldRescanLibraryPath('/vault/session/.swob-session.json')).toBe(true)
    expect(shouldRescanLibraryPath('/vault/session/backup.jsonl')).toBe(true)
    expect(shouldRescanLibraryPath('/vault/session/transcript.md')).toBe(false)
    expect(shouldRescanLibraryPath('/vault/.obsidian/config')).toBe(false)
    expect(shouldRescanLibraryPath('/vault/project/node_modules/package')).toBe(false)
  })
})

describe('library directory watcher backend', () => {
  it('uses one FSEvents stream on macOS and closes it explicitly', async () => {
    let handler!: (changedPath: string, flags: number) => void
    const stop = vi.fn(async () => undefined)
    const onDirty = vi.fn()
    const watch = vi.fn((_root: string, callback: typeof handler) => {
      handler = callback
      return stop
    })
    const watcher = watchLibraryDirectory({
      root: '/vault',
      platform: 'darwin',
      onDirty,
      onError: vi.fn(),
      loadFSEvents: () => ({
        watch,
        getInfo: (changedPath) => ({
          event: 'modified',
          type: changedPath.endsWith('folder.with-dot') ? 'directory' : 'file'
        }),
        constants: { MustScanSubDirs: 1, UserDropped: 2, KernelDropped: 4 }
      })
    })

    expect(watcher.backend).toBe('fsevents')
    expect(watch).toHaveBeenCalledTimes(1)
    handler('/vault/session/transcript.md', 0)
    handler('/vault/new folder', 0)
    handler('/vault/folder.with-dot', 0)
    expect(onDirty).toHaveBeenCalledTimes(2)
    await watcher.close()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('falls back to one shallow watcher when FSEvents cannot load', async () => {
    const onError = vi.fn()
    const close = vi.fn()
    const emitter = new EventEmitter() as EventEmitter & { close: () => void }
    emitter.close = close
    const watchShallow = vi.fn((_root, _options, callback) => {
      callback('rename', 'new folder')
      return emitter
    }) as unknown as typeof import('node:fs').watch
    const onDirty = vi.fn()

    const watcher = watchLibraryDirectory({
      root: '/vault',
      platform: 'darwin',
      onDirty,
      onError,
      loadFSEvents: () => { throw new Error('missing native module') },
      watchShallow
    })

    expect(watcher.backend).toBe('shallow-fallback')
    expect(watchShallow).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDirty).toHaveBeenCalledWith('/vault/new folder')
    await watcher.close()
    expect(close).toHaveBeenCalledTimes(1)
  })
})
