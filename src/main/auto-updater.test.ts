import { describe, expect, it, vi } from 'vitest'
import { setupAutoUpdater } from './auto-updater'

type Listener = (...args: any[]) => void

function createUpdater() {
  const listeners = new Map<string, Listener>()
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener)
      return updater
    }),
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: true }),
    downloadUpdate: vi.fn().mockResolvedValue([]),
    quitAndInstall: vi.fn()
  }
  return { updater, emit: (event: string, ...args: any[]) => listeners.get(event)?.(...args) }
}

describe('setupAutoUpdater', () => {
  it('keeps startup non-blocking and relays the checking/available/downloaded/error event flow', async () => {
    const { updater, emit } = createUpdater()
    const handlers = new Map<string, () => Promise<void> | void>()
    const sendToRenderer = vi.fn()
    const schedule = vi.fn()

    setupAutoUpdater({
      updater: updater as any,
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as () => Promise<void> | void) } },
      sendToRenderer,
      checkOnStartup: true,
      startupDelayMs: 1234,
      schedule
    })

    expect(updater.autoDownload).toBe(false)
    expect(updater.autoInstallOnAppQuit).toBe(false)
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1234)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()

    emit('checking-for-update')
    emit('update-available', { version: '1.2.0', releaseNotes: [{ note: '- Faster sync' }] })
    emit('error', new Error('offline'))
    emit('update-downloaded', { version: '1.2.0', releaseNotes: 'Ready to install' })

    expect(sendToRenderer.mock.calls).toEqual([
      ['update:checking'],
      ['update:available', '1.2.0', '- Faster sync'],
      ['update:ready', '1.2.0', 'Ready to install']
    ])

    await handlers.get('update:check')?.()
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('downloads only after the user requests it and installs only after download completion', async () => {
    const { updater, emit } = createUpdater()
    const handlers = new Map<string, () => Promise<void> | void>()
    const sendToRenderer = vi.fn()

    setupAutoUpdater({
      updater: updater as any,
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as () => Promise<void> | void) } },
      sendToRenderer,
      checkOnStartup: false
    })

    await handlers.get('update:download')?.()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    emit('update-available', { version: '1.2.0' })
    await handlers.get('update:download')?.()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(sendToRenderer).toHaveBeenLastCalledWith('update:downloading', '1.2.0')

    handlers.get('update:install')?.()
    expect(updater.quitAndInstall).not.toHaveBeenCalled()

    emit('update-downloaded', { version: '1.2.0' })
    handlers.get('update:install')?.()
    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('shows an actionable error after a user-requested download failure', async () => {
    const { updater, emit } = createUpdater()
    updater.downloadUpdate.mockRejectedValueOnce(new Error('offline'))
    const handlers = new Map<string, () => Promise<void> | void>()
    const sendToRenderer = vi.fn()

    setupAutoUpdater({
      updater: updater as any,
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as () => Promise<void> | void) } },
      sendToRenderer,
      checkOnStartup: false
    })

    emit('update-available', { version: '1.2.0', releaseNotes: 'Retry me' })
    await handlers.get('update:download')?.()

    expect(sendToRenderer.mock.calls).toEqual([
      ['update:available', '1.2.0', 'Retry me'],
      ['update:downloading', '1.2.0'],
      ['update:error', 'download', '1.2.0']
    ])
  })

  it('reports manual check outcomes without surfacing background network failures', async () => {
    const { updater } = createUpdater()
    updater.checkForUpdates
      .mockRejectedValueOnce(new Error('background offline'))
      .mockResolvedValueOnce({ isUpdateAvailable: false })
      .mockRejectedValueOnce(new Error('manual offline'))
    const handlers = new Map<string, () => Promise<void> | void>()
    const sendToRenderer = vi.fn()
    const scheduled: Array<() => void> = []

    setupAutoUpdater({
      updater: updater as any,
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as () => Promise<void> | void) } },
      sendToRenderer,
      checkOnStartup: true,
      schedule: (callback) => { scheduled.push(callback) }
    })

    scheduled[0]()
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledTimes(1))
    expect(sendToRenderer).not.toHaveBeenCalledWith('update:error', expect.anything(), expect.anything())

    await handlers.get('update:check')?.()
    expect(sendToRenderer).toHaveBeenCalledWith('update:notAvailable')

    await handlers.get('update:check')?.()
    expect(sendToRenderer).toHaveBeenCalledWith('update:error', 'check', '')
  })

  it('reports an install-stage signature failure and exposes the official download page action', async () => {
    const { updater, emit } = createUpdater()
    const handlers = new Map<string, () => Promise<void> | void>()
    const sendToRenderer = vi.fn()
    const openDownloadPage = vi.fn().mockResolvedValue(undefined)

    setupAutoUpdater({
      updater: updater as any,
      ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as () => Promise<void> | void) } },
      sendToRenderer,
      checkOnStartup: false,
      openDownloadPage
    })

    emit('update-available', { version: '1.3.1' })
    emit('update-downloaded', { version: '1.3.1' })
    handlers.get('update:install')?.()
    emit('error', new Error('signature validation failed'))

    expect(sendToRenderer).toHaveBeenLastCalledWith('update:error', 'install', '1.3.1')
    await handlers.get('update:openDownload')?.()
    expect(openDownloadPage).toHaveBeenCalledTimes(1)
  })
})
