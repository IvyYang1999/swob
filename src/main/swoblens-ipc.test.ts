import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerSwobLensIpc, type SwobLensIpcDependencies } from './swoblens-ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

describe('.swoblens IPC boundary', () => {
  let temporary: string
  let libraryRoot: string
  let handlers: Map<string, Handler>

  beforeEach(async () => {
    temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swoblens-ipc-'))
    libraryRoot = path.join(temporary, 'Library')
    await fs.promises.mkdir(libraryRoot)
    handlers = new Map()
  })

  afterEach(async () => {
    await fs.promises.rm(temporary, { recursive: true, force: true })
  })

  function register(overrides: Partial<Parameters<typeof registerSwobLensIpc>[0]> = {}) {
    let writerCalls = 0
    const withLibraryWriter: SwobLensIpcDependencies['withLibraryWriter'] = async <T>(operation: () => Promise<T> | T) => {
      writerCalls++
      return operation()
    }
    registerSwobLensIpc({
      ipcMain: overrides.ipcMain ?? { handle: (channel, handler) => { handlers.set(channel, handler) } },
      getLibraryRoot: overrides.getLibraryRoot ?? (() => libraryRoot),
      getAppVersion: overrides.getAppVersion ?? (() => '1.4.0'),
      withLibraryWriter: overrides.withLibraryWriter ?? withLibraryWriter,
      showOpenDialog: overrides.showOpenDialog ?? (async () => ({
        canceled: false,
        filePaths: [path.join(process.cwd(), 'docs', 'swoblens', 'examples', 'aurora-calm.swoblens')]
      }))
    })
    return { writerCalls: () => writerCalls }
  }

  it('registers the complete preview/install/list/state/uninstall surface', () => {
    register()
    expect([...handlers.keys()].sort()).toEqual([
      'swoblens:install',
      'swoblens:list',
      'swoblens:selectAndPreview',
      'swoblens:setEnabled',
      'swoblens:uninstall'
    ])
  })

  it('keeps package bytes in main and returns only validated preview data', async () => {
    register()
    const result = await handlers.get('swoblens:selectAndPreview')!(null) as any
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ manifest: { id: 'swob.aurora-calm', type: 'theme' } })
    expect(result.value).not.toHaveProperty('archive')
    expect(result.value).not.toHaveProperty('files')
  })

  it('uses the Library writer for every mutation', async () => {
    const registered = register()
    const preview = await handlers.get('swoblens:selectAndPreview')!(null) as any
    const installed = await handlers.get('swoblens:install')!(null, {
      sourcePath: preview.value.sourcePath,
      digest: preview.value.digest
    }) as any
    expect(installed.ok).toBe(true)
    expect(registered.writerCalls()).toBe(1)

    expect((await handlers.get('swoblens:setEnabled')!(null, { id: 'swob.aurora-calm', enabled: false }) as any).ok).toBe(true)
    expect((await handlers.get('swoblens:uninstall')!(null, 'swob.aurora-calm') as any).ok).toBe(true)
    expect(registered.writerCalls()).toBe(3)
  })

  it('fails closed with a readable code when the Library writer is blocked', async () => {
    const busy = Object.assign(new Error('Library writer is held by an active owner'), { code: 'LIBRARY_WRITER_BUSY' })
    register({ withLibraryWriter: async () => { throw busy } })
    const result = await handlers.get('swoblens:setEnabled')!(null, { id: 'swob.aurora-calm', enabled: true }) as any
    expect(result).toEqual({
      ok: false,
      error: { code: 'LIBRARY_WRITER_BUSY', message: 'Library writer is held by an active owner' }
    })
  })

  it('rejects malformed renderer requests before touching the writer', async () => {
    const registered = register()
    expect(await handlers.get('swoblens:install')!(null, { sourcePath: '/tmp/a', digest: 'bad' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
    expect(await handlers.get('swoblens:setEnabled')!(null, { id: 'x', enabled: 'yes' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' }
    })
    expect(registered.writerCalls()).toBe(0)
  })
})
