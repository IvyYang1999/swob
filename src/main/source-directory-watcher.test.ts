import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as chokidar from 'chokidar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSourceWatchDefinition,
  watchSourceDirectory,
  type SourceWatcherFileEvent,
  type SourceWatcherId
} from './source-directory-watcher'
import { saveAdditionalCodexHomes } from './codex-session-roots'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function makeTemporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-source-watcher-'))
  temporaryRoots.push(home)
  return home
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000)
    timer.unref?.()
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

describe('source watcher path definitions', () => {
  it('passes only concrete directories to chokidar and filters all three source layouts', () => {
    const home = path.join(path.sep, 'fixture', 'home')
    const claude = createSourceWatchDefinition('claude-code', home)
    const codex = createSourceWatchDefinition('codex', home)
    const cursor = createSourceWatchDefinition('cursor', home)

    for (const root of [...claude.roots, ...codex.roots, ...cursor.roots]) {
      expect(root).not.toMatch(/[?*{}[\]]/)
    }

    expect(claude.matches(path.join(home, '.claude', 'projects', 'project', 'session.jsonl'))).toBe(true)
    expect(claude.matches(path.join(home, '.claude-window', 'profile', 'projects', 'project', 'session.jsonl'))).toBe(true)
    expect(claude.matches(path.join(home, '.claude', 'projects', 'project', 'subagents', 'agent.jsonl'))).toBe(false)
    expect(claude.matches(path.join(home, '.claude', 'projects', 'project', 'session.txt'))).toBe(false)

    expect(codex.matches(path.join(home, '.codex', 'sessions', '2026', '07', '22', 'rollout-session.jsonl'))).toBe(true)
    expect(codex.matches(path.join(home, '.codex', 'archived_sessions', 'rollout-archived.jsonl'))).toBe(true)
    expect(codex.matches(path.join(home, '.codex', 'sessions', '2026', '07', '22', 'session.jsonl'))).toBe(false)
    expect(codex.matches(path.join(home, '.codex', 'sessions', '2026', '07', '22', 'rollout-session.txt'))).toBe(false)
    expect(codex.matches(path.join(home, '.codex', 'archived_sessions', 'nested', 'rollout-archived.jsonl'))).toBe(false)

    expect(cursor.matches(path.join(
      home, '.cursor', 'projects', 'project', 'agent-transcripts', 'session', 'session.jsonl'
    ))).toBe(true)
    expect(cursor.matches(path.join(
      home, '.cursor', 'projects', 'project', 'other-transcripts', 'session', 'session.jsonl'
    ))).toBe(false)
    expect(cursor.matches(path.join(
      home, '.cursor', 'projects', 'project', 'agent-transcripts', 'session', 'nested', 'session.jsonl'
    ))).toBe(false)
  })

  it('watches every configured CODEX_HOME and accepts each root lifecycle layout', () => {
    const home = makeTemporaryHome()
    const customHome = path.join(home, 'codex-work')
    fs.mkdirSync(customHome)
    saveAdditionalCodexHomes([customHome], home)

    const codex = createSourceWatchDefinition('codex', home)

    expect(codex.roots).toEqual([path.join(home, '.codex'), customHome])
    expect(codex.matches(path.join(
      customHome, 'sessions', '2026', '08', '02', 'rollout-custom.jsonl'
    ))).toBe(true)
    expect(codex.matches(path.join(
      customHome, 'archived_sessions', 'rollout-custom-archived.jsonl'
    ))).toBe(true)
  })
})

class FakeFsWatcher extends EventEmitter {
  close = vi.fn(async () => undefined)
}

describe('resilient source watcher error handling', () => {
  it('temporarily watches the nearest ancestor on macOS and narrows when a Codex root appears', async () => {
    const home = makeTemporaryHome()
    const customHome = path.join(home, 'codex-work')
    fs.mkdirSync(customHome)
    saveAdditionalCodexHomes([customHome], home)
    const definition = createSourceWatchDefinition('codex', home)
    const handlers: Array<(changedPath: string, flags: number) => void> = []
    const watchedRoots: string[] = []
    const loadFSEvents = vi.fn(() => ({
      watch: vi.fn((root: string, handler: (changedPath: string, flags: number) => void) => {
        watchedRoots.push(root)
        handlers.push(handler)
        return vi.fn(async () => undefined)
      }),
      getInfo: () => ({ event: 'created', type: 'directory' }),
      constants: { MustScanSubDirs: 1, UserDropped: 2, KernelDropped: 4 }
    }))
    const onError = vi.fn()
    const controller = watchSourceDirectory({
      definition,
      onFile: vi.fn(),
      onError,
      platform: 'darwin',
      loadFSEvents,
      retryInitialMs: 5,
      retryMaxMs: 5
    })

    expect(watchedRoots).toEqual([
      fs.realpathSync.native(home),
      fs.realpathSync.native(customHome)
    ])
    fs.mkdirSync(definition.roots[0])
    handlers[0](fs.realpathSync.native(definition.roots[0]), 0)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'SOURCE_ROOT_APPEARED' }), {
      phase: 'runtime', retryInMs: 5, attempt: 0, backend: 'fsevents'
    })
    await vi.waitFor(() => expect(loadFSEvents).toHaveBeenCalledTimes(2))
    await controller.close()
  })

  it('handles an injected EMFILE, closes the failed instance, and rebuilds after backoff', async () => {
    const home = makeTemporaryHome()
    const definition = createSourceWatchDefinition('codex', home)
    const instances: FakeFsWatcher[] = []
    const watchFactory = vi.fn(() => {
      const instance = new FakeFsWatcher()
      instances.push(instance)
      return instance as unknown as chokidar.FSWatcher
    }) as unknown as typeof chokidar.watch
    const onError = vi.fn()
    const onFile = vi.fn()
    const controller = watchSourceDirectory({
      definition,
      onFile,
      onError,
      retryInitialMs: 5,
      retryMaxMs: 20,
      platform: 'linux',
      watchFactory
    })

    const injectedError = Object.assign(new Error('descriptor budget exhausted'), { code: 'EMFILE' })
    instances[0].emit('error', injectedError)

    expect(onError).toHaveBeenCalledWith(injectedError, {
      phase: 'runtime',
      retryInMs: 5,
      attempt: 0,
      backend: 'chokidar-directory'
    })
    expect(instances[0].close).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(watchFactory).toHaveBeenCalledTimes(2))

    instances[1].emit('ready')
    const watchedFile = path.join(definition.roots[0], 'sessions', '2026', '07', '22', 'rollout-session.jsonl')
    instances[1].emit('change', watchedFile)
    expect(onFile).toHaveBeenCalledWith(watchedFile, 'change')

    instances[1].emit('error', injectedError)
    expect(onError).toHaveBeenLastCalledWith(injectedError, {
      phase: 'runtime',
      retryInMs: 10,
      attempt: 1,
      backend: 'chokidar-directory'
    })
    await vi.waitFor(() => expect(watchFactory).toHaveBeenCalledTimes(3))

    await controller.close()
    expect(instances[2].close).toHaveBeenCalledTimes(1)
  })

  it('cancels a scheduled rebuild when application cleanup closes the controller', async () => {
    const definition = createSourceWatchDefinition('cursor', makeTemporaryHome())
    const instance = new FakeFsWatcher()
    const watchFactory = vi.fn(() => instance as unknown as chokidar.FSWatcher) as unknown as typeof chokidar.watch
    const controller = watchSourceDirectory({
      definition,
      onFile: vi.fn(),
      onError: vi.fn(),
      retryInitialMs: 20,
      retryMaxMs: 20,
      platform: 'linux',
      watchFactory
    })

    instance.emit('error', new Error('injected failure'))
    await controller.close()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(watchFactory).toHaveBeenCalledTimes(1)
  })

  it('treats dropped macOS FSEvents as an error and rebuilds the source stream', async () => {
    const home = makeTemporaryHome()
    const definition = createSourceWatchDefinition('codex', home)
    fs.mkdirSync(definition.roots[0], { recursive: true })
    const handlers: Array<(changedPath: string, flags: number) => void> = []
    const stops: Array<ReturnType<typeof vi.fn>> = []
    const loadFSEvents = vi.fn(() => ({
      watch: vi.fn((_root: string, handler: (changedPath: string, flags: number) => void) => {
        handlers.push(handler)
        const stop = vi.fn(async () => undefined)
        stops.push(stop)
        return stop
      }),
      getInfo: () => ({ event: 'modified', type: 'file' }),
      constants: { MustScanSubDirs: 1, UserDropped: 2, KernelDropped: 4 }
    }))
    const onReady = vi.fn()
    const onError = vi.fn()
    const onFile = vi.fn()
    const controller = watchSourceDirectory({
      definition,
      onFile,
      onReady,
      onError,
      platform: 'darwin',
      loadFSEvents,
      retryInitialMs: 5,
      retryMaxMs: 5
    })

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledWith(0, 'fsevents', []))
    const watchedFile = path.join(definition.roots[0], 'sessions', '2026', '07', '22', 'rollout-session.jsonl')
    handlers[0](watchedFile, 0)
    expect(onFile).toHaveBeenCalledWith(watchedFile, 'change')

    handlers[0](definition.roots[0], 2)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'FSEVENTS_DROPPED' }), {
      phase: 'runtime',
      retryInMs: 5,
      attempt: 0,
      backend: 'fsevents'
    })
    expect(stops[0]).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(loadFSEvents).toHaveBeenCalledTimes(2))
    await controller.close()
    expect(stops[1]).toHaveBeenCalledTimes(1)
  })
})

interface IntegrationFixture {
  id: SourceWatcherId
  filePath: (home: string) => string
}

const integrationFixtures: IntegrationFixture[] = [
  {
    id: 'claude-code',
    filePath: (home) => path.join(home, '.claude', 'projects', 'project', 'session.jsonl')
  },
  {
    id: 'codex',
    filePath: (home) => path.join(home, '.codex', 'sessions', '2026', '07', '22', 'rollout-session.jsonl')
  },
  {
    id: 'cursor',
    filePath: (home) => path.join(
      home, '.cursor', 'projects', 'project', 'agent-transcripts', 'session', 'session.jsonl'
    )
  }
]

describe.sequential('source directory watcher integration', () => {
  for (const fixture of integrationFixtures) {
    it(`delivers ready and an appended JSONL change for ${fixture.id}`, async () => {
      const home = makeTemporaryHome()
      const definition = createSourceWatchDefinition(fixture.id, home)
      for (const root of definition.roots) fs.mkdirSync(root, { recursive: true })
      const filePath = fixture.filePath(home)
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '{"type":"initial"}\n')

      let resolveReady!: () => void
      const ready = new Promise<void>((resolve) => { resolveReady = resolve })
      let resolveFile!: (event: { filePath: string; event: SourceWatcherFileEvent }) => void
      const fileEvent = new Promise<{ filePath: string; event: SourceWatcherFileEvent }>((resolve) => {
        resolveFile = resolve
      })
      const errors: unknown[] = []
      const watchFactory = ((roots, options) => chokidar.watch(roots, {
        ...options,
        usePolling: true,
        interval: 50
      })) as typeof chokidar.watch
      const controller = watchSourceDirectory({
        definition,
        onReady: resolveReady,
        onError: (error) => errors.push(error),
        onFile: (changedPath, event) => resolveFile({ filePath: changedPath, event }),
        platform: 'linux',
        watchFactory
      })

      try {
        await withTimeout(ready, `${fixture.id} ready`)
        // Chokidar's polling backend can emit ready before fs.watchFile has
        // completed its first stat sample. Wait two polling intervals so the
        // append is unambiguously a post-ready change under parallel load.
        await new Promise((resolve) => setTimeout(resolve, 100))
        fs.appendFileSync(filePath, '{"type":"appended"}\n')
        const delivered = await withTimeout(fileEvent, `${fixture.id} appended change`)
        expect(delivered).toEqual({ filePath, event: 'change' })
        expect(errors).toEqual([])
      } finally {
        await controller.close()
      }
    }, 12_000)
  }

  it('delivers a Codex rollout when its configured root appears after startup', async () => {
    const home = makeTemporaryHome()
    const definition = createSourceWatchDefinition('codex', home)
    const filePath = path.join(
      home, '.codex', 'sessions', '2026', '08', '02', 'rollout-created-later.jsonl'
    )
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => { resolveReady = resolve })
    let resolveRecovery!: () => void
    const recovered = new Promise<void>((resolve) => { resolveRecovery = resolve })
    let resolveFile!: (event: { filePath: string; event: SourceWatcherFileEvent }) => void
    const fileEvent = new Promise<{ filePath: string; event: SourceWatcherFileEvent }>((resolve) => {
      resolveFile = resolve
    })
    const errors: unknown[] = []
    const watchFactory = ((roots, options) => chokidar.watch(roots, {
      ...options,
      usePolling: true,
      interval: 50
    })) as typeof chokidar.watch
    const controller = watchSourceDirectory({
      definition,
      onReady: (attempt) => { attempt === 0 ? resolveReady() : resolveRecovery() },
      onError: (error) => errors.push(error),
      onFile: (changedPath, event) => resolveFile({ filePath: changedPath, event }),
      platform: 'linux',
      watchFactory,
      retryInitialMs: 5,
      retryMaxMs: 5
    })

    try {
      await withTimeout(ready, 'missing Codex root ready')
      // `ready` can precede fs.watchFile's first stable sample under full-suite
      // load. Ten polling intervals make both transitions unambiguous deltas.
      await new Promise((resolve) => setTimeout(resolve, 500))
      fs.mkdirSync(path.join(home, '.codex'))
      await withTimeout(recovered, 'Codex watcher narrowed to created root')
      await new Promise((resolve) => setTimeout(resolve, 500))
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '{"type":"created"}\n')
      expect(await withTimeout(fileEvent, 'rollout under newly created Codex root')).toEqual({
        filePath,
        event: 'add'
      })
      expect(errors).toEqual([expect.objectContaining({ code: 'SOURCE_ROOT_APPEARED' })])
    } finally {
      await controller.close()
    }
  }, 12_000)
})

const nativeFSEventsIt = process.platform === 'darwin' && process.env.SWOB_NATIVE_FSEVENTS_TEST === '1'
  ? it
  : it.skip

describe('native macOS source watcher acceptance', () => {
  nativeFSEventsIt('delivers all three appends without leaking file descriptors', async () => {
    // This intentionally retains macOS's /var alias. Production canonicalizes
    // only the native watch root and maps callbacks back to configured paths.
    const home = makeTemporaryHome()
    const definitions = integrationFixtures.map((fixture) => ({
      fixture,
      definition: createSourceWatchDefinition(fixture.id, home),
      filePath: fixture.filePath(home)
    }))
    for (const { definition, filePath } of definitions) {
      for (const root of definition.roots) fs.mkdirSync(root, { recursive: true })
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '{"type":"initial"}\n')
    }

    const fdBefore = fs.readdirSync('/dev/fd').length
    const errors: unknown[] = []
    const readyPromises: Promise<void>[] = []
    const eventPromises: Array<Promise<{ id: SourceWatcherId; latencyMs: number }>> = []
    const controllers = definitions.map(({ fixture, definition, filePath }) => {
      let resolveReady!: () => void
      readyPromises.push(new Promise<void>((resolve) => { resolveReady = resolve }))
      let appendedAt = 0
      let resolveEvent!: (measurement: { id: SourceWatcherId; latencyMs: number }) => void
      eventPromises.push(new Promise((resolve) => { resolveEvent = resolve }))
      const controller = watchSourceDirectory({
        definition,
        onReady: resolveReady,
        onError: (error) => errors.push(error),
        onFile: (changedPath) => {
          if (changedPath === filePath && appendedAt > 0) {
            resolveEvent({ id: fixture.id, latencyMs: Date.now() - appendedAt })
          }
        }
      })
      return {
        controller,
        append: () => {
          appendedAt = Date.now()
          fs.appendFileSync(filePath, '{"type":"appended"}\n')
        }
      }
    })

    try {
      await withTimeout(Promise.all(readyPromises).then(() => undefined), 'native FSEvents ready')
      await new Promise((resolve) => setTimeout(resolve, 250))
      const fdDuring = fs.readdirSync('/dev/fd').length
      controllers.forEach(({ append }) => append())
      const measurements = await withTimeout(Promise.all(eventPromises), 'native FSEvents appends')
      expect(errors).toEqual([])
      expect(measurements.every(({ latencyMs }) => latencyMs < 5_000)).toBe(true)

      await Promise.all(controllers.map(({ controller }) => controller.close()))
      await new Promise((resolve) => setTimeout(resolve, 100))
      const fdAfter = fs.readdirSync('/dev/fd').length
      expect(fdAfter).toBeLessThanOrEqual(fdBefore + 2)
      console.info('[native-source-watcher-acceptance]', JSON.stringify({
        fdBefore,
        fdDuring,
        fdAfter,
        latencyMs: Object.fromEntries(measurements.map(({ id, latencyMs }) => [id, latencyMs]))
      }))
    } finally {
      await Promise.all(controllers.map(({ controller }) => controller.close()))
    }
  }, 15_000)
})
