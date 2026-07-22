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
  openDownloadPage?: () => Promise<unknown>
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
 * network request. Background failures remain silent so release-service
 * availability never interrupts normal use; user-triggered failures get a
 * bounded error category and a recovery action.
 */
export function setupAutoUpdater({
  updater,
  ipcMain,
  sendToRenderer,
  checkOnStartup,
  startupDelayMs = AUTO_UPDATE_STARTUP_DELAY_MS,
  schedule = setTimeout,
  openDownloadPage = async () => {}
}: AutoUpdaterOptions): void {
  let availableUpdate: { version: string; notes: string } | null = null
  let downloadInProgress = false
  let updateDownloaded = false
  let installRequested = false

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false

  updater.on('checking-for-update', () => {
    sendToRenderer('update:checking')
  })

  updater.on('update-available', (info) => {
    const update = { version: info.version, notes: releaseNotes(info) }
    availableUpdate = update
    updateDownloaded = false
    installRequested = false
    sendToRenderer('update:available', update.version, update.notes)
  })

  updater.on('update-downloaded', (info) => {
    const version = info.version || availableUpdate?.version || ''
    const notes = releaseNotes(info)
    updateDownloaded = true
    downloadInProgress = false
    sendToRenderer('update:ready', version, notes || availableUpdate?.notes || '')
  })

  // Errors outside a user-triggered download/install stay quiet. Do not send
  // the raw updater error to the renderer: it may contain paths or request data.
  updater.on('error', () => {
    if (installRequested) sendToRenderer('update:error', 'install', availableUpdate?.version || '')
    else if (downloadInProgress) sendToRenderer('update:error', 'download', availableUpdate?.version || '')
  })

  const check = async (manual: boolean): Promise<void> => {
    try {
      const result = await updater.checkForUpdates()
      if (manual && result && result.isUpdateAvailable === false) {
        sendToRenderer('update:notAvailable')
      }
    } catch {
      // Background checks stay quiet. A user-requested check must explain the
      // failure and offer the official manual download path.
      if (manual) sendToRenderer('update:error', 'check', '')
    }
  }

  ipcMain.handle('update:check', () => check(true))
  ipcMain.handle('update:openDownload', openDownloadPage)

  ipcMain.handle('update:download', async () => {
    if (!availableUpdate || downloadInProgress || updateDownloaded) return

    downloadInProgress = true
    sendToRenderer('update:downloading', availableUpdate.version)
    try {
      await updater.downloadUpdate()
    } catch {
      sendToRenderer('update:error', 'download', availableUpdate.version)
    } finally {
      downloadInProgress = false
    }
  })

  ipcMain.handle('update:install', () => {
    if (updateDownloaded) {
      installRequested = true
      updater.quitAndInstall()
    }
  })

  if (checkOnStartup) {
    schedule(() => { void check(false) }, startupDelayMs)
  }
}
