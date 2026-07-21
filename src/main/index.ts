import { app, shell, BrowserWindow, ipcMain, Menu, globalShortcut, screen } from 'electron'
import path from 'path'
const { join, dirname, basename, relative } = path
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { setupAutoUpdater as configureAutoUpdater } from './auto-updater'
import { exec, execSync } from 'child_process'
import * as fs from 'fs'
import * as chokidar from 'chokidar'
import {
  loadAllSessions,
  loadSessionDetail,
  findAllSessionFiles,
  parseSessionFile,
  buildSessionSummary,
  resolvePhysicalSessionId,
  buildSessionSummaryFromBackup
} from './session-loader'
import { findCodexSessionFiles, buildCodexSessionSummary } from './codex-loader'
import { findCursorSessionFiles, buildCursorSessionSummary } from './cursor-loader'
import {
  initLibrary,
  scanLibrary,
  libraryTreeToConfig,
  loadLibraryConfig,
  saveLibraryConfig,
  syncLibraryFromSessions,
  ensureSessionInLibrary,
  updateTranscript,
  syncBackup,
  getSessionMdPath,
  getSessionDirPath,
  setSessionTurnCount,
  getSessionResumeAvailability,
  createLibraryFolder,
  renameLibraryFolder,
  deleteLibraryFolder,
  moveSessionToFolder,
  addSessionToFolder as libAddSession,
  removeSessionFromFolder as libRemoveSession,
  setSessionMetaInLibrary,
  resolveFolderPath,
  getLibraryRoot,
  migrateFromOldConfig,
  reorderFolder,
  moveLibraryFolderToParent,
  addBranchToFolder,
  removeBranchFromFolder,
  setBranchMeta,
  getBranchMdPath,
  updateBranchTranscript,
  isSessionCloudOnly,
  triggerICloudDownload,
  getSshConfig,
  setSshConfig,
  buildSshResumeCommand,
  getRemoteCwdForSession,
  isRemoteProjectPath,
  extractRemoteUser,
  resolveLibrarySessionRemoteState,
  getConfiguredLibraryPath,
  changeConfiguredLibraryPath,
  isLibraryInitialized,
  findLibraryOnlySessions,
  findLibrarySessionsWithMissingSources
} from './library-manager'
import { loadConfig, saveConfig } from './config-store'
import { spotlightSearch } from './spotlight-search'
import { searchSessionFiles } from './session-search'
import { buildInsights } from './insights'
import { TranscriptWatcher } from './transcript-watcher'
import { addSessionCoverage, collectSessionCoverage } from './session-coverage'
import {
  normalizeResumeTerminalSettings,
  openResumeTerminal
} from './resume-terminal'
import {
  buildGuardedResumeCommand,
  openGuardedForkCommand,
  openGuardedResumeCommand,
  type ResumeActionResult
} from './resume-guard'
import {
  findInstalledSwobCommandPath,
  installSwobCli,
  SWOB_APP_CLI_PATH
} from './cli-install'
import {
  getSessionLineagePath,
  rebuildSessionLineageRegistry,
  writeSessionLineageRegistry
} from './session-lineage'
import type { Folder, Highlight, SessionSummary } from './types'

let mainWindow: BrowserWindow | null = null
let spotlightWindow: BrowserWindow | null = null
let watcher: chokidar.FSWatcher | null = null
let codexWatcher: chokidar.FSWatcher | null = null
let cursorWatcher: chokidar.FSWatcher | null = null
let libraryWatcher: chokidar.FSWatcher | null = null
let transcriptWatcher: TranscriptWatcher | null = null
let libraryRescanTimer: ReturnType<typeof setTimeout> | null = null
let pendingSpotlightNavigationSessionId: string | null = null
const knownSessionIds = new Set<string>()
let libraryInitialized = false

// --- Active Session Detection ---
let previousActiveIds: string[] = []
let activePoller: ReturnType<typeof setInterval> | null = null

function detectActiveSessionsFromProcesses(): Promise<Set<string>> {
  return new Promise((resolve) => {
    exec('ps -eo command', { timeout: 3000 }, (err, stdout) => {
      if (err) { resolve(new Set()); return }
      const active = new Set<string>()
      for (const line of stdout.split('\n')) {
        if (!line.includes('claude')) continue
        const match = line.match(/--resume\s+(\S+)/)
        if (match) active.add(match[1])
      }
      resolve(active)
    })
  })
}

async function pushActiveSessionIds(): Promise<void> {
  const fromProcesses = await detectActiveSessionsFromProcesses()
  const currentIds = Array.from(fromProcesses).sort()
  const prev = previousActiveIds
  if (currentIds.length !== prev.length || currentIds.some((id, i) => id !== prev[i])) {
    previousActiveIds = currentIds
    mainWindow?.webContents.send('sessions:activeChanged', currentIds)
  }
}

function startActiveSessionPoller(): void {
  // Run immediately, then every 1 second (async, non-blocking)
  pushActiveSessionIds()
  activePoller = setInterval(() => { pushActiveSessionIds() }, 1000)
}
let cachedSessions: SessionSummary[] = []

type UngroupBucket = 'grouped' | 'multi' | 'single' | 'root'

function computeUngroupBucket(session: SessionSummary, dirPath?: string | null): UngroupBucket | undefined {
  const libConfig = loadLibraryConfig()
  const branchFolders = libConfig.branchFolders || {}
  if ((session.id.includes(':intra-') || session.id.includes(':branch-')) && branchFolders[session.id]?.length) {
    return 'grouped'
  }

  const resolvedDir = dirPath || getSessionDirPath(session.sessionId)
  if (!resolvedDir) return undefined

  const parentDir = path.dirname(resolvedDir)
  const parent = path.basename(parentDir)
  const ungCfg = (libConfig.preferences as any)?.ungrouping
  if (ungCfg && parent === ungCfg.multiTurn) return 'multi'
  if (ungCfg && parent === ungCfg.singleTurn) return 'single'
  if (parentDir === getLibraryRoot()) return 'root'
  return 'grouped'
}

function annotateSessionForFrontend(session: SessionSummary, dirPath?: string | null): void {
  const resolvedDir = dirPath || getSessionDirPath(session.sessionId)
  if (resolvedDir) {
    session.libraryDirPath = resolvedDir
    session.libraryMdPath = getSessionMdPath(session.sessionId) || session.libraryMdPath
    if (!session.id.includes(':intra-') && !session.id.includes(':branch-')) {
      setSessionTurnCount(resolvedDir, session.turnCount)
    }
  }

  const resumeAvailability = getSessionResumeAvailability(session.sessionId, session)
  session.canResume = resumeAvailability.canResume
  if (resumeAvailability.canResume) {
    delete session.resumeUnavailableReason
  } else {
    session.resumeUnavailableReason = resumeAvailability.reason
  }

  const bucket = computeUngroupBucket(session, resolvedDir)
  if (bucket) (session as any).ungroupBucket = bucket
}

async function reloadSessionsForAction(): Promise<SessionSummary[]> {
  cachedSessions = await loadAllSessions()
  for (const s of cachedSessions) {
    knownSessionIds.add(s.sessionId)
    knownSessionIds.add(s.id)
    for (const continuationId of s.continuationSessionIds || []) {
      knownSessionIds.add(continuationId)
    }
  }
  return cachedSessions
}

function shouldReadLibraryConfig(): boolean {
  return libraryInitialized || isLibraryInitialized(getLibraryRoot())
}

function cleanupRuntimeResources(): void {
  watcher?.close()
  codexWatcher?.close()
  cursorWatcher?.close()
  watcher = null
  codexWatcher = null
  cursorWatcher = null
  transcriptWatcher?.stop()
  transcriptWatcher = null
  if (activePoller) {
    clearInterval(activePoller)
    activePoller = null
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Prevent Electron from navigating when files/URLs are dropped
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow in-app navigation (same origin), block external
    if (!url.startsWith('file://') && !url.startsWith('http')) return
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function showMainWindow(): BrowserWindow {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  return mainWindow!
}

function createSpotlightWindow(): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed()) {
    spotlightWindow.show()
    spotlightWindow.focus()
    return
  }

  const cursor = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(cursor)
  const { x, y, width, height } = display.workArea
  const winWidth = 720
  const winHeight = 520

  spotlightWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    x: x + Math.round((width - winWidth) / 2),
    y: y + Math.round((height - winHeight) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  spotlightWindow.on('blur', () => {
    spotlightWindow?.hide()
  })

  spotlightWindow.on('closed', () => {
    spotlightWindow = null
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    spotlightWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#spotlight')
  } else {
    spotlightWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'spotlight' })
  }

  spotlightWindow.once('ready-to-show', () => {
    spotlightWindow?.show()
  })
}

function toggleSpotlight(): void {
  if (spotlightWindow && !spotlightWindow.isDestroyed() && spotlightWindow.isVisible()) {
    spotlightWindow.hide()
  } else {
    createSpotlightWindow()
  }
}

const DEFAULT_SPOTLIGHT_SHORTCUT = 'CommandOrControl+Shift+Space'
let currentSpotlightShortcut: string | null = null

function registerSpotlightShortcut(shortcut?: string): void {
  const accelerator = shortcut || DEFAULT_SPOTLIGHT_SHORTCUT
  if (currentSpotlightShortcut) {
    globalShortcut.unregister(currentSpotlightShortcut)
  }
  const ok = globalShortcut.register(accelerator, toggleSpotlight)
  currentSpotlightShortcut = ok ? accelerator : null
}

function getSpotlightShortcut(): string {
  try {
    if (libraryInitialized) {
      const libConfig = loadLibraryConfig()
      return (libConfig.preferences as any)?.spotlightShortcut || DEFAULT_SPOTLIGHT_SHORTCUT
    }
    const cfg = loadConfig()
    return cfg.preferences?.spotlightShortcut || DEFAULT_SPOTLIGHT_SHORTCUT
  } catch { return DEFAULT_SPOTLIGHT_SHORTCUT }
}

function startFileWatcher(): void {
  const home = process.env.HOME || ''
  watcher = chokidar.watch([
    join(home, '.claude', 'projects', '*', '*.jsonl'),
    join(home, '.claude-window', '*', 'projects', '*', '*.jsonl')
  ], {
    ignoreInitial: true
  })

  watcher.on('add', async (filePath) => {
    if (filePath.includes('/subagents/')) return
    try {
      const raw = await parseSessionFile(filePath)
      const sessionId = resolvePhysicalSessionId(filePath, raw)
      if (!sessionId) return

      if (knownSessionIds.has(sessionId)) {
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(sessionId)
        const summary = buildSessionSummary(filePath, raw, true)
        if (summary) {
          // Create library entry for new session
          if (libraryInitialized) {
            try {
              const dirPath = await ensureSessionInLibrary(summary)
              await updateTranscript(sessionId)
              await syncBackup(sessionId)
              annotateSessionForFrontend(summary, dirPath)
            } catch { /* ignore */ }
          }
          annotateSessionForFrontend(summary)
          mainWindow?.webContents.send('sessions:refresh')
        }
      }
    } catch {
      /* ignore */
    }
  })

  watcher.on('change', async (filePath) => {
    if (filePath.includes('/subagents/')) return
    try {
      const raw = await parseSessionFile(filePath)
      const summary = buildSessionSummary(filePath, raw, true)
      if (summary) {
        // File changed = process is alive, immediately add to active set
        if (!previousActiveIds.includes(summary.sessionId)) {
          const next = [...previousActiveIds, summary.sessionId].sort()
          previousActiveIds = next
          mainWindow?.webContents.send('sessions:activeChanged', next)
        }

        // Update library transcript + backup
        if (libraryInitialized) {
          try {
            await ensureSessionInLibrary(summary)
            await updateTranscript(summary.sessionId)
            await syncBackup(summary.sessionId)
            annotateSessionForFrontend(summary)
          } catch { /* ignore */ }
        }
        annotateSessionForFrontend(summary)
        if (cachedSessions.some((s) => (s.continuationSessionIds || []).includes(summary.sessionId))) {
          mainWindow?.webContents.send('sessions:refresh')
        } else {
          mainWindow?.webContents.send('session:updated', summary)
        }
      }
    } catch {
      /* ignore */
    }
  })
}

function startCodexWatcher(): void {
  const codexDir = join(process.env.HOME || '', '.codex', 'sessions')
  if (!fs.existsSync(codexDir)) return
  codexWatcher = chokidar.watch(join(codexDir, '**/*.jsonl'), {
    ignoreInitial: true,
    depth: 4
  })

  const handleCodexFile = async (filePath: string) => {
    if (!basename(filePath).startsWith('rollout-')) return
    try {
      const summary = await buildCodexSessionSummary(filePath)
      if (!summary) return
      let dirPath: string | undefined
      if (libraryInitialized) {
        try {
          dirPath = await ensureSessionInLibrary(summary)
          await updateTranscript(summary.sessionId)
          await syncBackup(summary.sessionId)
        } catch { /* ignore */ }
      }
      annotateSessionForFrontend(summary, dirPath)
      if (knownSessionIds.has(summary.id) || knownSessionIds.has(summary.sessionId)) {
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(summary.id)
        knownSessionIds.add(summary.sessionId)
        mainWindow?.webContents.send('session:added', summary)
      }
    } catch { /* ignore */ }
  }

  codexWatcher.on('add', handleCodexFile)
  codexWatcher.on('change', handleCodexFile)
}

function startCursorWatcher(): void {
  const cursorDir = join(process.env.HOME || '', '.cursor', 'projects')
  if (!fs.existsSync(cursorDir)) return
  cursorWatcher = chokidar.watch(join(cursorDir, '*/agent-transcripts/*/*.jsonl'), {
    ignoreInitial: true,
    depth: 4
  })

  const handleCursorFile = async (filePath: string) => {
    try {
      const summary = await buildCursorSessionSummary(filePath)
      if (!summary) return
      let dirPath: string | undefined
      if (libraryInitialized) {
        try {
          dirPath = await ensureSessionInLibrary(summary)
          await updateTranscript(summary.sessionId)
          await syncBackup(summary.sessionId)
        } catch { /* ignore */ }
      }
      annotateSessionForFrontend(summary, dirPath)
      if (knownSessionIds.has(summary.id) || knownSessionIds.has(summary.sessionId)) {
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(summary.id)
        knownSessionIds.add(summary.sessionId)
        mainWindow?.webContents.send('session:added', summary)
      }
    } catch { /* ignore */ }
  }

  cursorWatcher.on('add', handleCursorFile)
  cursorWatcher.on('change', handleCursorFile)
}

// 监听库目录本身的「文件夹」变化。swob 原本只监听 ~/.claude 的 jsonl，察觉不到外部对库的
// 结构改动（整理脚本移动、iCloud 从别的机器同步进来的移动、手动挪动），导致目录树状态不及时。
// 这里只对 addDir/unlinkDir 反应（文件写入不触发，clipii/wiki 编辑很安静），debounce 后重扫并
// 通知前端刷新；前端收到 sessions:refresh 会重载会话与目录树。
function startLibraryWatcher(): void {
  if (libraryWatcher) { libraryWatcher.close(); libraryWatcher = null }
  const root = getLibraryRoot()
  if (!root || !fs.existsSync(root)) return
  libraryWatcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignorePermissionErrors: true,
    depth: 6,
    ignored: (p: string) =>
      p.includes('/node_modules/') || p.includes('/.git/') ||
      p.includes('/.obsidian/') || p.endsWith('.jsonl')
  })
  const schedule = (): void => {
    if (libraryRescanTimer) clearTimeout(libraryRescanTimer)
    libraryRescanTimer = setTimeout(() => {
      try { scanLibrary() } catch { /* ignore */ }
      transcriptWatcher?.refresh()
      mainWindow?.webContents.send('sessions:refresh')
    }, 1500)
  }
  libraryWatcher.on('addDir', schedule).on('unlinkDir', schedule)
}

// --- Library Initialization ---

async function initLibraryFromSessions(sessions: SessionSummary[]): Promise<void> {
  initLibrary()

  // Check if migration is needed (old config has folders but library is fresh)
  const oldConfig = loadConfig()
  const tree = scanLibrary()

  if (oldConfig.folders.length > 0 && tree.folders.length === 0 && tree.ungroupedSessions.length === 0) {
    // First run after upgrade — sync all sessions first, then migrate
    await syncLibraryFromSessions(sessions, oldConfig.sessionMeta)
    await migrateFromOldConfig(oldConfig.folders, oldConfig.sessionMeta)

    // Migrate preferences to library config
    const libConfig = loadLibraryConfig()
    libConfig.preferences = oldConfig.preferences
    saveLibraryConfig(libConfig)
  } else {
    // Normal sync — ensure all sessions are in library
    await syncLibraryFromSessions(sessions, oldConfig.sessionMeta)
  }

  libraryInitialized = true
  // Rescan so index is up to date, then notify renderer to refresh
  scanLibrary()
  transcriptWatcher?.refresh()
  mainWindow?.webContents.send('sessions:refresh')
}

// --- IPC Handlers ---

ipcMain.handle('sessions:getActive', () => previousActiveIds)

// --- Spotlight ---

ipcMain.handle('spotlight:search', (_event, query: string) => {
  const config = libraryInitialized ? (() => {
    const tree = scanLibrary()
    return libraryTreeToConfig(tree)
  })() : loadConfig()

  const folderMap = new Map<string, string>()
  for (const folder of config.folders) {
    for (const sid of folder.sessionIds) {
      folderMap.set(sid, folder.name)
    }
  }

  return spotlightSearch(query, cachedSessions, {
    sessionMeta: config.sessionMeta || {},
    folderMap
  })
})

ipcMain.handle('spotlight:resume', async (_event, sessionId: string, cwd?: string) => {
  const result = await openGuardedResumeCommand({
    sessionId,
    sessions: cachedSessions,
    cwd,
    reloadSessions: reloadSessionsForAction,
    openCommand: openInTerminal
  })
  if (result.ok) spotlightWindow?.hide()
  return result
})

ipcMain.handle('spotlight:hide', () => {
  spotlightWindow?.hide()
})

ipcMain.handle('spotlight:toggle', () => {
  toggleSpotlight()
})

ipcMain.handle('spotlight:selectInMain', (_event, sessionId: string) => {
  spotlightWindow?.hide()
  const hadMainWindow = !!mainWindow && !mainWindow.isDestroyed()
  const win = showMainWindow()
  if (hadMainWindow && !win.webContents.isLoading()) {
    win.webContents.send('spotlight:navigate', sessionId)
  } else {
    pendingSpotlightNavigationSessionId = sessionId
  }
})

ipcMain.handle('spotlight:consumePendingNavigation', () => {
  const sessionId = pendingSpotlightNavigationSessionId
  pendingSpotlightNavigationSessionId = null
  return sessionId
})

// --- iCloud ---

ipcMain.handle('icloud:isCloudOnly', (_event, sessionId: string) => {
  return isSessionCloudOnly(sessionId)
})

ipcMain.handle('icloud:download', (_event, sessionId: string) => {
  return triggerICloudDownload(sessionId)
})

// Scan all sessions and return which ones are cloud-only
// Also re-scans Library to discover newly downloaded sessions from other devices
ipcMain.handle('icloud:scanCloudSessions', async () => {
  const cloudSessions: string[] = []
  for (const session of cachedSessions) {
    if (isSessionCloudOnly(session.sessionId)) {
      cloudSessions.push(session.sessionId)
    }
  }

  // Re-scan Library for newly downloaded sessions (e.g. after iCloud download)
  // If the main session list hasn't loaded yet, every library entry would look
  // "library-only" and be pushed as a duplicate before the real list arrives.
  if (cachedSessions.length === 0) return cloudSessions

  try {
    const localIds = collectSessionCoverage(cachedSessions)
    const libraryOnly = findLibraryOnlySessions(localIds)
    for (const { sessionId, backupPath, meta } of libraryOnly) {
      try {
        const summary = await buildSessionSummaryFromBackup(backupPath, sessionId, meta)
        if (summary) {
          if (localIds.has(sessionId) || localIds.has(summary.sessionId) || localIds.has(summary.id)) continue
          summary.allFilePaths = [backupPath]
          annotateSessionForFrontend(summary, getSessionDirPath(sessionId))
          const remoteState = resolveLibrarySessionRemoteState(meta)
          summary.isRemote = remoteState.isRemote
          if (remoteState.remoteHost) summary.remoteHost = remoteState.remoteHost
          if (meta.customTitle) {
            ;(summary as any)._libraryTitle = meta.customTitle
          }
          cachedSessions.push(summary)
          localIds.add(sessionId)
          knownSessionIds.add(sessionId)
          addSessionCoverage(localIds, summary)
          addSessionCoverage(knownSessionIds, summary)
          mainWindow?.webContents.send('session:added', summary)
        }
      } catch { /* skip unparseable backup */ }
    }
  } catch { /* ignore */ }

  return cloudSessions
})

// --- SSH ---

ipcMain.handle('ssh:getConfig', () => getSshConfig())

ipcMain.handle('network:getInfo', async () => {
  const os = await import('os')
  const nets = os.networkInterfaces()
  const localIps: string[] = []
  for (const iface of Object.values(nets)) {
    for (const addr of iface ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        localIps.push(addr.address)
      }
    }
  }

  // Tailscale IP (100.x.x.x range)
  const tailscaleIp = localIps.find((ip) => ip.startsWith('100.')) ?? null

  // Public IP via external service (fast, no dependency)
  let publicIp: string | null = null
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
    const data = await res.json() as { ip: string }
    publicIp = data.ip
  } catch {
    // offline or slow
  }

  // macOS hostname
  let hostname = ''
  try {
    hostname = execSync('hostname', { encoding: 'utf-8' }).trim()
  } catch { /* ignore */ }

  // SSH remote login status (check if sshd is listening on port 22)
  let sshEnabled = false
  try {
    const out = execSync('launchctl list com.openssh.sshd 2>/dev/null || true', { encoding: 'utf-8' })
    sshEnabled = out.trim().length > 0 && !out.includes('-\t0\tcom.openssh.sshd')
  } catch { /* ignore */ }

  return { localIps, tailscaleIp, publicIp, hostname, sshEnabled }
})

ipcMain.handle('ssh:setConfig', (_event, sshConfig: { host: string; user: string; remotePath?: string } | null) => {
  setSshConfig(sshConfig)
})

ipcMain.handle('ssh:resume', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfig()
  if (!sshConfig) throw new Error('SSH config not set')
  // SSH resume/fork executes on the remote host, so local source-file availability is not authoritative here.
  // Do not attach the local resume guard to this path; the remote machine owns the recoverability check.
  const remoteCwd = getRemoteCwdForSession(sessionId)
  openInTerminal(buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd))
})

ipcMain.handle('ssh:fork', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfig()
  if (!sshConfig) throw new Error('SSH config not set')
  // Same SSH exemption as ssh:resume: the actual restore happens remotely, not on this machine.
  const remoteCwd = getRemoteCwdForSession(sessionId)
  const cmd = buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd)
  openInTerminal(cmd.replace('--resume', '--fork-session --resume'))
})

ipcMain.handle('ssh:buildCommand', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfig()
  if (!sshConfig) return null
  // Builds a remote command only; local Library/source guard would be the wrong boundary.
  const remoteCwd = getRemoteCwdForSession(sessionId)
  return buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd)
})

// Load a local image file as data URL, with fallback to ~/.claude/image-cache/
ipcMain.handle('image:load', async (_event, filePath: string) => {
  const tryLoad = (p: string): { dataUrl: string; status: string } | null => {
    try {
      if (!fs.existsSync(p)) return null
      const ext = path.extname(p).toLowerCase()
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
      const mime = mimeMap[ext] || 'image/png'
      const data = fs.readFileSync(p).toString('base64')
      return { dataUrl: `data:${mime};base64,${data}`, status: 'exists' }
    } catch { return null }
  }
  // Try original path
  const original = tryLoad(filePath)
  if (original) return original
  // Try image-cache: scan all subdirs for matching filename
  const cacheDir = path.join(process.env.HOME || '', '.claude', 'image-cache')
  try {
    if (fs.existsSync(cacheDir)) {
      const basename = path.basename(filePath)
      for (const sub of fs.readdirSync(cacheDir)) {
        const cached = path.join(cacheDir, sub, basename)
        const result = tryLoad(cached)
        if (result) return { ...result, status: 'cached' }
      }
    }
  } catch { /* ignore */ }
  return { dataUrl: null, status: 'missing' }
})

// Native context menu for images
ipcMain.handle('image:contextMenu', (_event, options: { path: string }) => {
  const { Menu, shell, clipboard } = require('electron')
  const menu = Menu.buildFromTemplate([
    { label: '打开图片', click: () => shell.openPath(options.path) },
    { label: '在 Finder 中显示', click: () => shell.showItemInFolder(options.path) },
    { type: 'separator' },
    { label: '复制路径', click: () => clipboard.writeText(options.path) }
  ])
  menu.popup()
})

ipcMain.handle('sessions:loadAll', async () => {
  try {
  const sessions = await loadAllSessions()
  cachedSessions = sessions
  knownSessionIds.clear()

  // Attach library paths + physical location bucket + detect remote sessions.
  // Every summary sent to the renderer must carry the same bucket semantics;
  // otherwise the sidebar treats missing data as bottom "ungrouped" noise.
  for (const s of sessions) {
    knownSessionIds.add(s.sessionId)
    knownSessionIds.add(s.id)
    for (const continuationId of s.continuationSessionIds || []) {
      knownSessionIds.add(continuationId)
    }
    const dirPath = getSessionDirPath(s.sessionId)
    annotateSessionForFrontend(s, dirPath)

    // Skip library/remote processing for non-Claude-Code sessions
    if (s.source === 'codex' || s.source === 'cursor' || s.source === 'opencode' || s.source === 'zcode') continue

    if (s.projectPath && isRemoteProjectPath(s.projectPath)) {
      s.isRemote = true
      const remoteUser = extractRemoteUser(s.projectPath)
      if (remoteUser) s.remoteHost = `${remoteUser}@remote`
    }
    const isBranch = s.id.includes(':intra-')
    if (dirPath) {
      if (isBranch) {
        let branchMd: string | null | undefined = getBranchMdPath(s.id)
        if (!branchMd && s.branchLeafUuid) {
          const branchMeta = loadLibraryConfig().branchMeta?.[s.id]
          branchMd = await updateBranchTranscript(s.id, s.branchLeafUuid, branchMeta?.customTitle) || undefined
        }
        s.libraryMdPath = branchMd || getSessionMdPath(s.sessionId) || undefined
      }
    }
  }

  // Load Library-only sessions (from other devices via iCloud sync)
  try {
    const localIds = collectSessionCoverage(sessions)
    const libraryOnly = findLibraryOnlySessions(localIds)
    for (const { sessionId, backupPath, meta } of libraryOnly) {
      try {
        const summary = await buildSessionSummaryFromBackup(backupPath, sessionId, meta)
        if (summary) {
          if (localIds.has(sessionId) || localIds.has(summary.sessionId) || localIds.has(summary.id)) continue
          summary.allFilePaths = [backupPath]
          annotateSessionForFrontend(summary, getSessionDirPath(sessionId))
          const remoteState = resolveLibrarySessionRemoteState(meta)
          summary.isRemote = remoteState.isRemote
          if (remoteState.remoteHost) summary.remoteHost = remoteState.remoteHost
          if (meta.customTitle) {
            ;(summary as any)._libraryTitle = meta.customTitle
          }
          sessions.push(summary)
          localIds.add(sessionId)
          knownSessionIds.add(sessionId)
          addSessionCoverage(localIds, summary)
          addSessionCoverage(knownSessionIds, summary)
        }
      } catch { /* skip unparseable backup */ }
    }
    // Re-sort after adding library-only sessions
    if (libraryOnly.length > 0) {
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    }
  } catch { /* ignore */ }

  cachedSessions = sessions

  // Sync library in background (non-blocking)
  if (!libraryInitialized) {
    initLibraryFromSessions(sessions).catch(() => { /* ignore */ })
  }

  return sessions
  } catch (err) {
    console.error('sessions:loadAll failed:', err)
    return cachedSessions // return whatever we have
  }
})

ipcMain.handle(
  'sessions:loadDetail',
  async (_event, filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) => {
    const detail = await loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid, branchLeafUuid)
    if (detail?.messages) {
      for (const msg of detail.messages) {
        (msg as any).raw = undefined
      }
    }
    return detail
  }
)

ipcMain.handle('sessions:search', async (_event, query: string) => {
  // Ensure library is initialized before searching backups
  if (!libraryInitialized) {
    try { initLibrary() } catch { /* ignore */ }
  }
  const files = findAllSessionFiles().filter((f) => !f.includes('/subagents/'))
  const missingSourceLibrarySessions = findLibrarySessionsWithMissingSources()
  return searchSessionFiles(query, [
    ...files.map((filePath) => ({ filePath })),
    ...missingSourceLibrarySessions.map(({ backupPath }) => ({ filePath: backupPath }))
  ])
})

function openInTerminal(command: string): void {
  let preferences: Record<string, unknown> | undefined
  try {
    preferences = shouldReadLibraryConfig()
      ? loadLibraryConfig().preferences as unknown as Record<string, unknown>
      : loadConfig().preferences as unknown as Record<string, unknown>
  } catch {
    preferences = undefined
  }
  openResumeTerminal(command, normalizeResumeTerminalSettings(preferences))
}

ipcMain.handle(
  'terminal:resume',
  async (_event, sessionId: string, _terminalApp: string, permissionMode?: string, cwd?: string) => {
    return openGuardedResumeCommand({
      sessionId,
      sessions: cachedSessions,
      permissionMode,
      cwd,
      reloadSessions: reloadSessionsForAction,
      openCommand: openInTerminal
    })
  }
)

ipcMain.handle(
  'terminal:resumeBatch',
  async (_event, sessionIds: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, _terminalApp: string) => {
    const results: ResumeActionResult[] = []
    for (const s of sessionIds) {
      results.push(await openGuardedResumeCommand({
        sessionId: s.sessionId,
        sessions: cachedSessions,
        permissionMode: s.permissionMode,
        cwd: s.cwd,
        reloadSessions: reloadSessionsForAction,
        openCommand: openInTerminal
      }))
    }
    return results
  }
)

ipcMain.handle(
  'terminal:fork',
  async (_event, sessionId: string, _terminalApp: string, permissionMode?: string, cwd?: string) => {
    return openGuardedForkCommand({
      sessionId,
      sessions: cachedSessions,
      permissionMode,
      cwd,
      reloadSessions: reloadSessionsForAction,
      openCommand: openInTerminal
    })
  }
)

ipcMain.handle(
  'terminal:buildResumeCommand',
  async (_event, sessionId: string, permissionMode?: string, cwd?: string) => {
    const result = await buildGuardedResumeCommand({
      sessionId,
      sessions: cachedSessions,
      permissionMode,
      cwd,
      reloadSessions: reloadSessionsForAction
    })
    if (!result.ok || !result.command) throw new Error(result.reason || '此会话无法直接恢复')
    return result.command
  }
)

// --- Insights IPC ---
ipcMain.handle('insights:get', () => {
  const sessions = cachedSessions
  let folders: Folder[] = []
  try {
    if (libraryInitialized) {
      const tree = scanLibrary()
      const cfg = libraryTreeToConfig(tree)
      folders = cfg.folders || []
    } else {
      const cfg = loadConfig()
      folders = cfg.folders || []
    }
  } catch { /* ignore */ }
  const sessionTimes = new Map<string, number>()
  for (const s of sessions) {
    if (s.estimatedTime) sessionTimes.set(s.sessionId, s.estimatedTime)
  }
  return buildInsights(sessions, folders, sessionTimes)
})

// --- Lineage IPC ---

ipcMain.handle('lineage:getRegistry', async () => {
  const libraryRoot = getLibraryRoot()
  const registryPath = getSessionLineagePath(libraryRoot)
  try {
    if (fs.existsSync(registryPath)) {
      return JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
    }
  } catch { /* fall through to rebuild */ }
  try {
    const registry = await rebuildSessionLineageRegistry(libraryRoot)
    try { writeSessionLineageRegistry(registry, registryPath) } catch { /* ignore write failure */ }
    return registry
  } catch {
    return null
  }
})

// --- Claude Code Settings (cleanupPeriodDays) ---

ipcMain.handle('claude:getCleanupDays', async () => {
  try {
    const home = (await import('os')).homedir()
    const settingsPath = path.join(home, '.claude', 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      return data.cleanupPeriodDays ?? 30
    }
  } catch { /* ignore */ }
  return 30
})

ipcMain.handle('claude:setCleanupDays', async (_event, days: number) => {
  try {
    const home = (await import('os')).homedir()
    const settingsPath = path.join(home, '.claude', 'settings.json')
    let data: Record<string, unknown> = {}
    if (fs.existsSync(settingsPath)) {
      data = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    }
    data.cleanupPeriodDays = Math.max(1, Math.round(days))
    const tmpPath = settingsPath + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2))
    fs.renameSync(tmpPath, settingsPath)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('session:getExecutionTree', async (_event, filePath: string) => {
  try {
    const { parseSessionFile } = await import('./session-loader')
    const { buildExecutionTree } = await import('./execution-tree')
    const messages = await parseSessionFile(filePath)
    const sessionId = path.basename(filePath, '.jsonl')
    return buildExecutionTree(messages, sessionId)
  } catch {
    return null
  }
})

ipcMain.handle('insights:generate', async (event, options?: { useLlm?: boolean }) => {
  const sendProgress = (stage: string, current: number, total: number): void => {
    try { event.sender.send('insights:progress', { stage, current, total }) } catch { /* ignore */ }
  }
  try {
    const { generateInsightsReport, generateLlmNarrative, renderInsightsHtml, renderNarrativeHtml } = await import('./session-insights')
    const osModule = await import('os')
    const report = await generateInsightsReport(cachedSessions, 200, sendProgress)
    let html = renderInsightsHtml(report)

    let llmUsed = false
    let llmError: string | undefined
    if (options?.useLlm) {
      try {
        const libConfig = loadLibraryConfig() as unknown as Record<string, unknown>
        const llmSettings = libConfig.llmSettings as { provider: 'anthropic' | 'openai' | 'custom'; apiKey: string; model?: string; baseUrl?: string } | undefined
        if (!llmSettings?.apiKey) {
          llmError = 'no-api-key'
        } else {
          const narrative = await generateLlmNarrative(report, cachedSessions, llmSettings, sendProgress)
          const narrativeHtml = renderNarrativeHtml(narrative)
          html = html.replace('<h2>Health Distribution</h2>', `${narrativeHtml}\n<h2>Health Distribution</h2>`)
          llmUsed = true
        }
      } catch (e) {
        llmError = e instanceof Error ? e.message : String(e)
      }
    }

    sendProgress('writing', 1, 1)
    const reportDir = path.join(osModule.homedir(), '.claude-session-manager', 'reports')
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const reportPath = path.join(reportDir, `insights-${timestamp}.html`)
    const latestPath = path.join(reportDir, 'insights-latest.html')
    fs.writeFileSync(reportPath, html, 'utf-8')
    fs.writeFileSync(latestPath, html, 'utf-8')
    const { shell } = await import('electron')
    shell.openPath(reportPath)
    return { ok: true, path: reportPath, sessionCount: report.totalSessions, llmUsed, llmError }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
})

ipcMain.handle('insights:getLlmSettings', () => {
  try {
    const libConfig = loadLibraryConfig() as unknown as Record<string, unknown>
    const s = libConfig.llmSettings as { provider?: string; apiKey?: string; model?: string; baseUrl?: string } | undefined
    // Mask the key for display: only reveal last 4 chars
    return {
      provider: s?.provider || 'anthropic',
      hasKey: Boolean(s?.apiKey),
      keyHint: s?.apiKey ? `…${s.apiKey.slice(-4)}` : '',
      model: s?.model || '',
      baseUrl: s?.baseUrl || ''
    }
  } catch {
    return { provider: 'anthropic', hasKey: false, keyHint: '', model: '', baseUrl: '' }
  }
})

ipcMain.handle('insights:setLlmSettings', (_event, settings: { provider: string; apiKey?: string; model?: string; baseUrl?: string }) => {
  try {
    const libConfig = loadLibraryConfig() as unknown as Record<string, unknown>
    const existing = (libConfig.llmSettings as { apiKey?: string } | undefined) || {}
    libConfig.llmSettings = {
      provider: settings.provider,
      // Empty apiKey means "keep existing"
      apiKey: settings.apiKey?.trim() ? settings.apiKey.trim() : existing.apiKey || '',
      model: settings.model?.trim() || '',
      baseUrl: settings.baseUrl?.trim() || ''
    }
    saveLibraryConfig(libConfig as never)
    return true
  } catch {
    return false
  }
})

ipcMain.handle('session:audit', async (_event, filePath: string) => {
  try {
    const { parseSessionFile } = await import('./session-loader')
    const { auditSession } = await import('./session-audit')
    const messages = await parseSessionFile(filePath)
    const sessionId = path.basename(filePath, '.jsonl')
    return auditSession(messages, sessionId)
  } catch {
    return null
  }
})

ipcMain.handle('session:getContextInspector', async (_event, filePath: string) => {
  try {
    const { parseSessionFile } = await import('./session-loader')
    const { buildContextInspector } = await import('./context-inspector')
    const messages = await parseSessionFile(filePath)
    const sessionId = path.basename(filePath, '.jsonl')
    return buildContextInspector(messages, sessionId)
  } catch {
    return null
  }
})

// --- Config / Library IPC ---
// These use the library manager but return the same shape the frontend expects

ipcMain.handle('config:load', () => {
  if (!shouldReadLibraryConfig()) {
    // Fallback to old config during initial load
    return loadConfig()
  }
  const tree = scanLibrary()
  return libraryTreeToConfig(tree)
})

ipcMain.handle('config:save', (_event, config: { preferences: Record<string, unknown> }) => {
  if (libraryInitialized) {
    const libConfig = loadLibraryConfig()
    libConfig.preferences = config.preferences as any
    saveLibraryConfig(libConfig)
  } else {
    saveConfig(config as any)
  }
  // If spotlight shortcut changed, re-register it
  const shortcut = (config.preferences?.spotlightShortcut as string) || DEFAULT_SPOTLIGHT_SHORTCUT
  if (shortcut !== currentSpotlightShortcut) {
    registerSpotlightShortcut(shortcut)
  }
  return config
})

ipcMain.handle(
  'config:createFolder',
  (_event, opts: { name: string; color?: string | null; parentId?: string | null }) => {
    if (libraryInitialized) {
      const parentPath = opts.parentId ? resolveFolderPath(opts.parentId) : undefined
      createLibraryFolder(opts.name, parentPath)
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    // Fallback
    const config = loadConfig()
    const { createFolder } = require('./config-store')
    return createFolder(config, opts)
  }
)

ipcMain.handle(
  'config:moveFolder',
  (_event, folderId: string, newParentId: string | null, position?: 'before' | 'after' | 'inside', targetId?: string) => {
    if (libraryInitialized) {
      const srcPath = resolveFolderPath(folderId)

      if (position && position !== 'inside' && targetId) {
        // Sibling reorder — may need physical move if parent differs
        const targetPath = resolveFolderPath(targetId)
        const targetParent = dirname(targetPath)
        const srcParent = dirname(srcPath)

        let newFolderId = folderId
        if (srcParent !== targetParent && fs.existsSync(srcPath)) {
          const newPath = moveLibraryFolderToParent(srcPath, targetParent)
          newFolderId = relative(getLibraryRoot(), newPath)
          scanLibrary()
        }
        reorderFolder(newFolderId, targetId, position)
      } else {
        // Move folder into a new parent
        const destParent = newParentId ? resolveFolderPath(newParentId) : getLibraryRoot()
        if (fs.existsSync(srcPath)) {
          moveLibraryFolderToParent(srcPath, destParent)
        }
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { moveFolder } = require('./config-store')
    return moveFolder(config, folderId, newParentId)
  }
)

ipcMain.handle('config:deleteFolder', (_event, folderId: string) => {
  if (libraryInitialized) {
    const folderPath = resolveFolderPath(folderId)
    deleteLibraryFolder(folderPath)
    const tree = scanLibrary()
    return libraryTreeToConfig(tree)
  }
  const config = loadConfig()
  const { deleteFolder } = require('./config-store')
  return deleteFolder(config, folderId)
})

ipcMain.handle(
  'config:renameFolder',
  (_event, folderId: string, name: string) => {
    if (libraryInitialized) {
      const folderPath = resolveFolderPath(folderId)
      renameLibraryFolder(folderPath, name)
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { renameFolder } = require('./config-store')
    return renameFolder(config, folderId, name)
  }
)

ipcMain.handle(
  'config:addSessionToFolder',
  async (_event, folderId: string, sessionId: string) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        // Branch sessions: store in config (independent of parent's file system location)
        addBranchToFolder(sessionId, folderId)
      } else {
        // Regular sessions: move directory in Library file system
        const dirPath = getSessionDirPath(sessionId)
        if (!dirPath) {
          const summary = cachedSessions.find((s) => s.sessionId === sessionId)
          if (summary) {
            await ensureSessionInLibrary(summary)
          }
        }
        const folderPath = resolveFolderPath(folderId)
        moveSessionToFolder(sessionId, folderPath)
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { addSessionToFolder } = require('./config-store')
    return addSessionToFolder(config, folderId, sessionId)
  }
)

ipcMain.handle(
  'config:removeSessionFromFolder',
  (_event, folderId: string, sessionId: string) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        removeBranchFromFolder(sessionId, folderId)
      } else {
        const folderPath = resolveFolderPath(folderId)
        libRemoveSession(sessionId, folderPath)
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { removeSessionFromFolder } = require('./config-store')
    return removeSessionFromFolder(config, folderId, sessionId)
  }
)

ipcMain.handle(
  'config:setSessionMeta',
  (_event, sessionId: string, meta: { customTitle?: string; notes?: string; highlights?: Highlight[] }) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        setBranchMeta(sessionId, meta as Parameters<typeof setBranchMeta>[1])
      } else {
        setSessionMetaInLibrary(sessionId, meta)
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { setSessionMeta } = require('./config-store')
    return setSessionMeta(config, sessionId, meta)
  }
)

// --- Native Context Menu ---

ipcMain.handle(
  'context-menu:session',
  (event, data: {
    sessionId: string
    canResume?: boolean
    resumeUnavailableReason?: string
    folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }>
  }) => {
    return new Promise((resolve) => {
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: data.canResume === false
            ? `Resume（${data.resumeUnavailableReason || '不可恢复'}）`
            : 'Resume',
          enabled: data.canResume !== false,
          click: () => resolve({ action: 'resume' })
        },
        { type: 'separator' },
        { label: '重命名', click: () => resolve({ action: 'rename' }) },
      ]

      const removeItems = data.folders.filter(f => f.isIn)

      if (removeItems.length > 0) {
        template.push({ type: 'separator' })
        for (const f of removeItems) {
          template.push({
            label: `从「${f.name}」移除`,
            click: () => resolve({ action: 'removeFromFolder', folderId: f.id })
          })
        }
      }

      // Build hierarchical "移入" submenu
      const addItems = data.folders.filter(f => !f.isIn)
      if (addItems.length > 0) {
        type FNode = { id: string; name: string; parentId: string | null; children: FNode[] }
        const nodeMap = new Map<string, FNode>()
        for (const f of addItems) {
          nodeMap.set(f.id, { id: f.id, name: f.name, parentId: f.parentId, children: [] })
        }
        const roots: FNode[] = []
        for (const node of nodeMap.values()) {
          if (node.parentId && nodeMap.has(node.parentId)) {
            nodeMap.get(node.parentId)!.children.push(node)
          } else {
            roots.push(node)
          }
        }
        const buildSubmenu = (nodes: FNode[]): Electron.MenuItemConstructorOptions[] => {
          return nodes.map(n => {
            const item: Electron.MenuItemConstructorOptions = {
              label: n.name,
              click: () => resolve({ action: 'addToFolder', folderId: n.id })
            }
            if (n.children.length > 0) {
              item.submenu = [
                { label: `移入「${n.name}」`, click: () => resolve({ action: 'addToFolder', folderId: n.id }) },
                { type: 'separator' },
                ...buildSubmenu(n.children)
              ]
              item.click = undefined
            }
            return item
          })
        }
        template.push({ type: 'separator' })
        template.push({ label: '移入文件夹', enabled: false })
        template.push(...buildSubmenu(roots))
      }

      if (data.folders.length === 0) {
        template.push({ type: 'separator' })
        template.push({ label: '还没有文件夹，先创建一个', enabled: false })
      }

      const menu = Menu.buildFromTemplate(template)
      const win = BrowserWindow.fromWebContents(event.sender)
      menu.popup({ window: win!, callback: () => resolve(null) })
    })
  }
)

// --- Library-specific IPC ---

ipcMain.handle('library:getRoot', () => getLibraryRoot())

ipcMain.handle('library:getMdPath', (_event, sessionId: string) => {
  if (sessionId.includes(':intra-')) {
    return getBranchMdPath(sessionId) || getSessionMdPath(sessionId.split(':')[0])
  }
  return getSessionMdPath(sessionId)
})

ipcMain.handle('library:getDirPath', (_event, sessionId: string) => {
  return getSessionDirPath(sessionId)
})

ipcMain.handle('library:openInFinder', () => {
  shell.showItemInFolder(getLibraryRoot())
})

ipcMain.handle('library:getConfiguredPath', () => {
  return getConfiguredLibraryPath()
})

ipcMain.handle('library:isInitialized', (_event, rootPath: string) => {
  return isLibraryInitialized(rootPath)
})

ipcMain.handle('library:selectDirectory', async () => {
  if (!mainWindow) return null
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择 Swob Library 存储位置',
    defaultPath: getLibraryRoot(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '选择此文件夹'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('library:changePath', async (_event, newPath: string) => {
  changeConfiguredLibraryPath(newPath)
  // Re-initialize library at new path
  initLibrary(newPath)
  const tree = scanLibrary()
  libraryInitialized = true
  startLibraryWatcher() // 跟随新库根重启目录监听
  // Re-sync sessions from source
  if (cachedSessions.length > 0) {
    const oldConfig = loadConfig()
    await syncLibraryFromSessions(cachedSessions, oldConfig.sessionMeta)
    // Rescan after sync
    scanLibrary()
  }
  transcriptWatcher?.refresh()
  mainWindow?.webContents.send('sessions:refresh')
  return getLibraryRoot()
})

// --- File Operations ---

ipcMain.handle('session:saveMarkdown', async (_event, dirPath: string, filename: string, content: string) => {
  const fullPath = join(dirPath, filename)
  fs.writeFileSync(fullPath, content, 'utf-8')
  return fullPath
})

ipcMain.handle('session:saveToTemp', (_event, filename: string, content: string) => {
  const tmpDir = join(require('os').tmpdir(), 'swob-drag')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  const fullPath = join(tmpDir, filename)
  fs.writeFileSync(fullPath, content, 'utf-8')
  return fullPath
})

ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
  return shell.openPath(filePath)
})

ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// --- CLI Installation ---

function isCliInstalled(): boolean {
  return fs.existsSync(SWOB_APP_CLI_PATH)
}

function installCli(): { cliInstalled: boolean; skillInstalled: boolean; cliPath: string | null; cliManualInstall?: string; error?: string } {
  const home = process.env.HOME || ''
  const cliInstall = installSwobCli({ homeDir: home || undefined })

  // 2. Install skill
  const skillDir = join(home, '.claude', 'skills', 'swob')
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
  const skillContent = generateSkillMd()
  fs.writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

  return {
    cliInstalled: cliInstall.cliInstalled,
    skillInstalled: true,
    cliPath: cliInstall.cliPath,
    cliManualInstall: cliInstall.cliManualInstall ?? undefined
  }
}

function generateSkillMd(): string {
  return `# Swob CLI — Agent Skill

Swob 是 Claude Code / Codex / Cursor 的会话管理工具。通过 \`swob\` CLI 你可以搜索、浏览、恢复和整理用户的所有 AI 编程助手聊天记录。

## 使用前提

用户已安装 Swob 桌面应用并执行过 \`swob install\`。

## 命令参考

所有命令输出 JSON，可直接解析。

### 搜索 session

\`\`\`bash
swob search "关键词"
swob search "项目名" --limit 10
\`\`\`

返回匹配的 session 列表，按相关性排序。支持中英文、项目名、文件夹名、时间（今天/昨天/本周）、来源（cc/codex/cursor/opencode/zcode）。

### 列出 session

\`\`\`bash
swob list
swob list --folder "项目名"
swob list --source claude-code
swob list --project swob
swob list --limit 20
\`\`\`

### 查看 session 详情

\`\`\`bash
swob show <sessionId>
\`\`\`

返回完整的 session 信息，包括消息列表、工具调用、token 统计。

### 恢复 session（获取 resume 命令）

\`\`\`bash
swob resume <sessionId>
swob resume <sessionId> --skip-permissions
swob resume <sessionId> --cwd /path/to/project
\`\`\`

返回 \\\`{ "command": "claude --resume ..." }\\\`，你可以直接执行该命令。

### 列出文件夹

\`\`\`bash
swob folders
\`\`\`

### 创建文件夹

\`\`\`bash
swob folder create "文件夹名"
swob folder create "子文件夹" --parent "父文件夹id"
\`\`\`

### 重命名文件夹

\`\`\`bash
swob folder rename <folderId> "新名称"
\`\`\`

### 删除文件夹

\`\`\`bash
swob folder delete <folderId>
\`\`\`

### 移动 session 到文件夹

\`\`\`bash
swob move <sessionId> <folderId>
\`\`\`

### 重命名 session

\`\`\`bash
swob rename <sessionId> "新标题"
\`\`\`

### 查看统计数据

\`\`\`bash
swob insights
swob insights --json
\`\`\`

返回 token 消耗、活跃天数、项目排行、模型使用等统计。

### 查看/修改设置

\`\`\`bash
swob config get
swob config get terminalApp
swob config set terminalApp iTerm2
swob config set defaultViewMode compact
\`\`\`

### 查看活跃 session

\`\`\`bash
swob active
\`\`\`

### 安装/更新 CLI 和 Skill

\`\`\`bash
swob install
\`\`\`

## 典型工作流

### 整理某个项目的所有 session

1. \\\`swob list --project myproject\\\` 找到所有相关 session
2. \\\`swob folders\\\` 查看现有文件夹
3. \\\`swob folder create "myproject"\\\` 创建文件夹（如不存在）
4. 对每个 session 执行 \\\`swob move <sessionId> <folderId>\\\`
5. 可选：\\\`swob rename <sessionId> "描述性标题"\\\` 重命名

### 快速找到并恢复之前的对话

1. \\\`swob search "我在做的事情"\\\` 搜索
2. 从结果中找到目标 sessionId
3. \\\`swob resume <sessionId>\\\` 获取恢复命令
4. 执行返回的命令

### 查看工作统计

\\\`swob insights\\\` 查看总览，包括 token 消耗和活跃时间。
`
}

function autoInstallCliOnStartup(): void {
  try {
    installCli()
  } catch { /* ignore — user can manually install later */ }
}

ipcMain.handle('cli:getStatus', () => {
  const installed = isCliInstalled()
  const symlinkExists = findInstalledSwobCommandPath() !== null
  const skillExists = fs.existsSync(join(process.env.HOME || '', '.claude', 'skills', 'swob', 'SKILL.md'))
  return { cliInstalled: installed, symlinkInstalled: symlinkExists, skillInstalled: skillExists }
})

ipcMain.handle('cli:install', () => {
  return installCli()
})

// --- App Lifecycle ---

// --- Auto Update ---

function setupAutoUpdater(): void {
  configureAutoUpdater({
    updater: autoUpdater,
    ipcMain,
    sendToRenderer: (channel, ...args) => mainWindow?.webContents.send(channel, ...args),
    // The window and all startup watchers are already running before this
    // delayed, fire-and-forget request is scheduled.
    checkOnStartup: !is.dev
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.claude-session-manager')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize library early so session paths are available on first load
  initLibrary()
  scanLibrary()
  transcriptWatcher = new TranscriptWatcher()
  transcriptWatcher.start()

  createWindow()
  startFileWatcher()
  startLibraryWatcher()
  startCodexWatcher()
  startCursorWatcher()
  startActiveSessionPoller()
  setupAutoUpdater()
  autoInstallCliOnStartup()

  registerSpotlightShortcut(getSpotlightShortcut())
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS: don't unregister shortcuts — app stays alive and user expects Cmd+Shift+Space to work
  if (process.platform !== 'darwin') {
    cleanupRuntimeResources()
    globalShortcut.unregisterAll()
    app.quit()
  }
})

app.on('before-quit', () => {
  cleanupRuntimeResources()
})
