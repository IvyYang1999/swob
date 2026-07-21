import type { IpcMain } from 'electron'
import type { AppUpdater } from 'electron-updater'

type Updater = Pick<
  AppUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'on' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall'
>

type ReleaseInfo = {
  version: string
  releaseNotes?: string | Array<{ note?: string | null }> | null
}

export type AutoUpdaterOptions = {
  updater: Updater
  ipcMain: Pick<IpcMain, 'handle'>
  sendToRenderer: (channel: string, ...args: unknown[]) => void
  checkOnStartup: boolean
  startupDelayMs?: number
  schedule?: (callback: () => void, delayMs: number) => unknown
}

export const AUTO_UPDATE_STARTUP_DELAY_MS = 3_000

function releaseNotes(info: ReleaseInfo): string {
  if (typeof info.releaseNotes === 'string') return info.releaseNotes
  if (Array.isArray(info.releaseNotes)) {
    return info.releaseNotes.map((item) => item.note || '').filter(Boolean).join('\n')
  }
  return ''
}

/**
 * Wires electron-updater to the renderer without making app startup wait on a
 * network request. Failures deliberately remain silent: an unavailable release
 * must never interrupt normal use of the app.
 */
export function setupAutoUpdater({
  updater,
  ipcMain,
  sendToRenderer,
  checkOnStartup,
  startupDelayMs = AUTO_UPDATE_STARTUP_DELAY_MS,
  schedule = setTimeout
}: AutoUpdaterOptions): void {
  let availableUpdate: { version: string; notes: string } | null = null
  let downloadInProgress = false
  let updateDownloaded = false

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false

  updater.on('checking-for-update', () => {
    sendToRenderer('update:checking')
  })

  updater.on('update-available', (info) => {
    const update = { version: info.version, notes: releaseNotes(info) }
    availableUpdate = update
    updateDownloaded = false
    sendToRenderer('update:available', update.version, update.notes)
  })

  updater.on('update-downloaded', (info) => {
    const version = info.version || availableUpdate?.version || ''
    const notes = releaseNotes(info)
    updateDownloaded = true
    sendToRenderer('update:ready', version, notes || availableUpdate?.notes || '')
  })

  // Update availability is non-critical. Network, malformed release, and
  // signature errors are intentionally quiet, per product requirements.
  updater.on('error', () => {
    if (downloadInProgress && availableUpdate) {
      sendToRenderer('update:available', availableUpdate.version, availableUpdate.notes)
    }
  })

  const checkSilently = async (): Promise<void> => {
    try {
      await updater.checkForUpdates()
    } catch {
      // Offline/no-release errors must not surface to users.
    }
  }

  ipcMain.handle('update:check', checkSilently)

  ipcMain.handle('update:download', async () => {
    if (!availableUpdate || downloadInProgress || updateDownloaded) return

    downloadInProgress = true
    sendToRenderer('update:downloading', availableUpdate.version)
    try {
      await updater.downloadUpdate()
    } catch {
      // Restore the actionable state so a transient network failure can retry.
      sendToRenderer('update:available', availableUpdate.version, availableUpdate.notes)
    } finally {
      downloadInProgress = false
    }
  })

  ipcMain.handle('update:install', () => {
    if (updateDownloaded) updater.quitAndInstall()
  })

  if (checkOnStartup) {
    schedule(() => { void checkSilently() }, startupDelayMs)
  }
}
