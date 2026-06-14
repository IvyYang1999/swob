import { app, shell, BrowserWindow, ipcMain, Menu, globalShortcut, screen } from 'electron'
import path from 'path'
const { join, dirname, basename, relative } = path
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { exec, execSync } from 'child_process'
import * as fs from 'fs'
import * as chokidar from 'chokidar'
import {
  loadAllSessions,
  loadSessionDetail,
  findAllSessionFiles,
  parseSessionFile,
  buildSessionSummary
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
  restoreBackupToClaudeSource,
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
  getConfiguredLibraryPath,
  saveAppConfig,
  isLibraryInitialized,
  findLibraryOnlySessions,
  findLibrarySessionsWithMissingSources
} from './library-manager'
import { loadConfig, saveConfig } from './config-store'
import { spotlightSearch } from './spotlight-search'
import { searchSessionFiles } from './session-search'
import { buildInsights } from './insights'
import type { SessionSummary } from './types'

let mainWindow: BrowserWindow | null = null
let spotlightWindow: BrowserWindow | null = null
let watcher: chokidar.FSWatcher | null = null
let codexWatcher: chokidar.FSWatcher | null = null
let cursorWatcher: chokidar.FSWatcher | null = null
let libraryWatcher: chokidar.FSWatcher | null = null
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

function cleanupRuntimeResources(): void {
  watcher?.close()
  codexWatcher?.close()
  cursorWatcher?.close()
  watcher = null
  codexWatcher = null
  cursorWatcher = null
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
      const sessionId = raw.find((m) => m.sessionId)?.sessionId
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
              summary.libraryDirPath = dirPath
              summary.libraryMdPath = getSessionMdPath(sessionId) || undefined
            } catch { /* ignore */ }
          }
          mainWindow?.webContents.send('session:added', summary)
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
            summary.libraryDirPath = getSessionDirPath(summary.sessionId) || undefined
            summary.libraryMdPath = getSessionMdPath(summary.sessionId) || undefined
          } catch { /* ignore */ }
        }
        mainWindow?.webContents.send('session:updated', summary)
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
      if (knownSessionIds.has(summary.id)) {
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(summary.id)
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
      if (knownSessionIds.has(summary.id)) {
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(summary.id)
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

ipcMain.handle('spotlight:resume', (_event, sessionId: string, cwd?: string) => {
  const session = cachedSessions.find((s) => s.sessionId === sessionId)
  if (!session) return
  restoreBackupToClaudeSource(sessionId)
  openInTerminal(buildResumeCommand(sessionId, session.permissionMode, session.resumeCwd || cwd, session.source, session.claudeConfigDir))
  spotlightWindow?.hide()
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
  try {
    const localIds = new Set(cachedSessions.map((s) => s.sessionId))
    const libraryOnly = findLibraryOnlySessions(localIds)
    for (const { sessionId, backupPath, meta } of libraryOnly) {
      try {
        const raw = await parseSessionFile(backupPath)
        const summary = buildSessionSummary(backupPath, raw, true)
        if (summary) {
          summary.allFilePaths = [backupPath]
          summary.libraryDirPath = getSessionDirPath(sessionId) || undefined
          summary.libraryMdPath = getSessionMdPath(sessionId) || undefined
          const remoteByPath = meta.projectPath ? isRemoteProjectPath(meta.projectPath) : true
          summary.isRemote = remoteByPath
          if (remoteByPath) {
            const remoteUser = meta.projectPath ? extractRemoteUser(meta.projectPath) : null
            if (remoteUser) summary.remoteHost = `${remoteUser}@remote`
          }
          if (meta.customTitle) {
            ;(summary as any)._libraryTitle = meta.customTitle
          }
          cachedSessions.push(summary)
          knownSessionIds.add(sessionId)
          mainWindow?.webContents.send('sessions:added', summary)
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
  const remoteCwd = getRemoteCwdForSession(sessionId)
  openInTerminal(buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd))
})

ipcMain.handle('ssh:fork', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfig()
  if (!sshConfig) throw new Error('SSH config not set')
  const remoteCwd = getRemoteCwdForSession(sessionId)
  const cmd = buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd)
  openInTerminal(cmd.replace('--resume', '--fork-session --resume'))
})

ipcMain.handle('ssh:buildCommand', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfig()
  if (!sshConfig) return null
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

  // Attach library paths + detect remote sessions
  const ungCfg = (loadLibraryConfig().preferences as any)?.ungrouping
  const libRoot = getLibraryRoot()
  for (const s of sessions) {
    knownSessionIds.add(s.sessionId)
    knownSessionIds.add(s.id)

    // 给每个会话打【物理位置标签】+ 持久化权威 turnCount。前端据标签判定底部归属，
    // 不靠脆弱的 id 匹配（Codex/Cursor 的 live id 常与库里存的对不齐，会导致已分组会话漏进底部、重复显示）。
    if (!s.id.includes(':intra-')) {
      const ld = getSessionDirPath(s.sessionId)
      if (ld) {
        setSessionTurnCount(ld, s.turnCount)
        const parent = path.basename(path.dirname(ld))
        if (ungCfg && parent === ungCfg.multiTurn) (s as any).ungroupBucket = 'multi'
        else if (ungCfg && parent === ungCfg.singleTurn) (s as any).ungroupBucket = 'single'
        else if (path.dirname(ld) === libRoot) (s as any).ungroupBucket = 'root'
        else (s as any).ungroupBucket = 'grouped' // 在某主题文件夹里 → 只在树里显示，绝不进底部
      }
    }

    // Skip library/remote processing for non-Claude-Code sessions
    if (s.source === 'codex' || s.source === 'cursor') continue

    if (s.projectPath && isRemoteProjectPath(s.projectPath)) {
      s.isRemote = true
      const remoteUser = extractRemoteUser(s.projectPath)
      if (remoteUser) s.remoteHost = `${remoteUser}@remote`
    }
    const isBranch = s.id.includes(':intra-')
    const dirPath = getSessionDirPath(s.sessionId)
    if (dirPath) {
      s.libraryDirPath = dirPath
      if (isBranch) {
        let branchMd = getBranchMdPath(s.id)
        if (!branchMd && s.branchLeafUuid) {
          const branchMeta = loadLibraryConfig().branchMeta?.[s.id]
          branchMd = await updateBranchTranscript(s.id, s.branchLeafUuid, branchMeta?.customTitle) || undefined
        }
        s.libraryMdPath = branchMd || getSessionMdPath(s.sessionId) || undefined
      } else {
        s.libraryMdPath = getSessionMdPath(s.sessionId) || undefined
      }
    }
  }

  // Load Library-only sessions (from other devices via iCloud sync)
  try {
    const localIds = new Set(sessions.map((s) => s.sessionId))
    const libraryOnly = findLibraryOnlySessions(localIds)
    for (const { sessionId, backupPath, meta } of libraryOnly) {
      try {
        const raw = await parseSessionFile(backupPath)
        const summary = buildSessionSummary(backupPath, raw, true)
        if (summary) {
          summary.allFilePaths = [backupPath]
          summary.libraryDirPath = getSessionDirPath(sessionId) || undefined
          summary.libraryMdPath = getSessionMdPath(sessionId) || undefined
          const remoteByPath = meta.projectPath ? isRemoteProjectPath(meta.projectPath) : true
          summary.isRemote = remoteByPath
          if (remoteByPath) {
            const remoteUser = meta.projectPath ? extractRemoteUser(meta.projectPath) : null
            if (remoteUser) summary.remoteHost = `${remoteUser}@remote`
          }
          if (meta.customTitle) {
            ;(summary as any)._libraryTitle = meta.customTitle
          }
          sessions.push(summary)
          knownSessionIds.add(sessionId)
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
    return loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid, branchLeafUuid)
  }
)

ipcMain.handle('sessions:search', async (_event, query: string) => {
  const files = findAllSessionFiles().filter((f) => !f.includes('/subagents/'))
  const missingSourceLibrarySessions = findLibrarySessionsWithMissingSources()
  return searchSessionFiles(query, [
    ...files.map((filePath) => ({ filePath })),
    ...missingSourceLibrarySessions.map(({ backupPath }) => ({ filePath: backupPath }))
  ])
})

function withClaudeConfigDir(cmd: string, claudeConfigDir?: string): string {
  return claudeConfigDir ? `CLAUDE_CONFIG_DIR=${JSON.stringify(claudeConfigDir)} ${cmd}` : cmd
}

function buildResumeCommand(sessionId: string, permissionMode?: string, cwd?: string, source?: string, claudeConfigDir?: string): string {
  let cmd: string
  if (source === 'codex') {
    cmd = `codex resume ${sessionId}`
    if (cwd && fs.existsSync(cwd)) {
      cmd += ` -C ${JSON.stringify(cwd)}`
    }
    return cmd
  }
  if (source === 'cursor') {
    cmd = `cursor agent --resume ${sessionId}`
    if (cwd && fs.existsSync(cwd)) {
      return `cd ${JSON.stringify(cwd)} && ${cmd}`
    }
    return cmd
  }
  // Claude Code (default)
  cmd = permissionMode === 'bypassPermissions'
    ? `claude --dangerously-skip-permissions --resume ${sessionId}`
    : `claude --resume ${sessionId}`
  cmd = withClaudeConfigDir(cmd, claudeConfigDir)
  if (cwd && fs.existsSync(cwd)) {
    return `cd ${JSON.stringify(cwd)} && ${cmd}`
  }
  return cmd
}

function buildForkCommand(sessionId: string, permissionMode?: string, cwd?: string, source?: string, claudeConfigDir?: string): string {
  let cmd: string
  if (source === 'codex') {
    cmd = `codex fork ${sessionId}`
    if (cwd && fs.existsSync(cwd)) {
      cmd += ` -C ${JSON.stringify(cwd)}`
    }
    return cmd
  }
  // Cursor 没有 fork 命令，走 resume
  if (source === 'cursor') {
    cmd = `cursor agent --resume ${sessionId}`
    if (cwd && fs.existsSync(cwd)) {
      return `cd ${JSON.stringify(cwd)} && ${cmd}`
    }
    return cmd
  }
  // Claude Code (default)
  cmd = permissionMode === 'bypassPermissions'
    ? `claude --dangerously-skip-permissions --fork-session --resume ${sessionId}`
    : `claude --fork-session --resume ${sessionId}`
  cmd = withClaudeConfigDir(cmd, claudeConfigDir)
  if (cwd && fs.existsSync(cwd)) {
    return `cd ${JSON.stringify(cwd)} && ${cmd}`
  }
  return cmd
}

function openInTerminal(command: string): void {
  const tmpPath = `/tmp/csm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.command`
  // Script deletes itself after command finishes, so Terminal won't kill a running process
  fs.writeFileSync(tmpPath, `#!/bin/bash\n${command}\nrm -f "${tmpPath}"\n`)
  fs.chmodSync(tmpPath, 0o755)
  exec(`open "${tmpPath}"`)
}

ipcMain.handle(
  'terminal:resume',
  async (_event, sessionId: string, _terminalApp: string, permissionMode?: string, cwd?: string) => {
    const session = cachedSessions.find((s) => s.sessionId === sessionId)
    const source = session?.source
    restoreBackupToClaudeSource(sessionId)
    openInTerminal(buildResumeCommand(sessionId, permissionMode, session?.resumeCwd || cwd, source, session?.claudeConfigDir))
  }
)

ipcMain.handle(
  'terminal:resumeBatch',
  async (_event, sessionIds: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, _terminalApp: string) => {
    for (const s of sessionIds) {
      const session = cachedSessions.find((ss) => ss.sessionId === s.sessionId)
      restoreBackupToClaudeSource(s.sessionId)
      openInTerminal(buildResumeCommand(s.sessionId, s.permissionMode, session?.resumeCwd || s.cwd, session?.source, session?.claudeConfigDir))
    }
  }
)

ipcMain.handle(
  'terminal:fork',
  async (_event, sessionId: string, _terminalApp: string, permissionMode?: string, cwd?: string) => {
    const session = cachedSessions.find((s) => s.sessionId === sessionId)
    const source = session?.source
    restoreBackupToClaudeSource(sessionId)
    openInTerminal(buildForkCommand(sessionId, permissionMode, session?.resumeCwd || cwd, source, session?.claudeConfigDir))
  }
)

// --- Insights IPC ---
ipcMain.handle('insights:get', () => {
  const sessions = cachedSessions
  let folders: Array<{ id: string; name: string; parentId?: string | null; sessionIds: string[] }> = []
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

// --- Config / Library IPC ---
// These use the library manager but return the same shape the frontend expects

ipcMain.handle('config:load', () => {
  if (!libraryInitialized) {
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
  (_event, sessionId: string, meta: { customTitle?: string; notes?: string; highlights?: unknown[] }) => {
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
  (event, data: { sessionId: string; folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }> }) => {
    return new Promise((resolve) => {
      const template: Electron.MenuItemConstructorOptions[] = [
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
  saveAppConfig({ libraryPath: newPath })
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

function getCliSourceDir(): string {
  // In packaged app: Resources/cli/
  // In dev: out/main/
  if (is.dev) {
    return join(__dirname)
  }
  return join(process.resourcesPath, 'cli')
}

function getCliInstallDir(): string {
  return join(process.env.HOME || '', '.claude-session-manager', 'cli')
}

function isCliInstalled(): boolean {
  const installDir = getCliInstallDir()
  return fs.existsSync(join(installDir, 'cli.js'))
}

function installCli(): { cliInstalled: boolean; skillInstalled: boolean; cliPath: string | null; error?: string } {
  const sourceDir = getCliSourceDir()
  const installDir = getCliInstallDir()
  const home = process.env.HOME || ''

  // 1. Copy CLI files
  if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true })

  const sourceCliJs = join(sourceDir, 'cli.js')
  if (!fs.existsSync(sourceCliJs)) {
    return { cliInstalled: false, skillInstalled: false, cliPath: null, error: `CLI 源文件不存在: ${sourceCliJs}` }
  }

  fs.copyFileSync(sourceCliJs, join(installDir, 'cli.js'))

  // Copy chunks directory
  const sourceChunks = join(sourceDir, 'chunks')
  const destChunks = join(installDir, 'chunks')
  if (fs.existsSync(sourceChunks)) {
    if (!fs.existsSync(destChunks)) fs.mkdirSync(destChunks, { recursive: true })
    for (const file of fs.readdirSync(sourceChunks)) {
      fs.copyFileSync(join(sourceChunks, file), join(destChunks, file))
    }
  }

  // 2. Create wrapper script
  const wrapperPath = join(home, '.claude-session-manager', 'swob-cli.sh')
  fs.writeFileSync(wrapperPath, `#!/bin/bash\nexec node "${join(installDir, 'cli.js')}" "$@"\n`, { mode: 0o755 })

  // 3. Create symlink
  const cliTarget = '/usr/local/bin/swob'
  let cliInstalled = false
  try {
    if (fs.existsSync(cliTarget) || fs.lstatSync(cliTarget).isSymbolicLink()) {
      fs.unlinkSync(cliTarget)
    }
  } catch { /* doesn't exist */ }
  try {
    fs.symlinkSync(wrapperPath, cliTarget)
    cliInstalled = true
  } catch {
    cliInstalled = false
  }

  // 4. Install skill
  const skillDir = join(home, '.claude', 'skills', 'swob')
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
  const skillContent = generateSkillMd()
  fs.writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

  return {
    cliInstalled,
    skillInstalled: true,
    cliPath: cliInstalled ? cliTarget : null
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

返回匹配的 session 列表，按相关性排序。支持中英文、项目名、文件夹名、时间（今天/昨天/本周）、来源（cc/codex/cursor）。

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
  const symlinkExists = fs.existsSync('/usr/local/bin/swob')
  const skillExists = fs.existsSync(join(process.env.HOME || '', '.claude', 'skills', 'swob', 'SKILL.md'))
  return { cliInstalled: installed, symlinkInstalled: symlinkExists, skillInstalled: skillExists }
})

ipcMain.handle('cli:install', () => {
  return installCli()
})

// --- App Lifecycle ---

// --- Auto Update ---

function setupAutoUpdater(): void {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update:downloading', info.version, '')
  })

  autoUpdater.on('update-downloaded', (info) => {
    // releaseNotes 可能是 string 或 ReleaseNoteInfo[]
    let notes = ''
    if (typeof info.releaseNotes === 'string') {
      notes = info.releaseNotes
    } else if (Array.isArray(info.releaseNotes)) {
      notes = info.releaseNotes.map((n) => n.note || '').join('\n')
    }
    mainWindow?.webContents.send('update:ready', info.version, notes)
  })

  autoUpdater.on('error', (err) => {
    console.error('自动更新出错:', err.message)
  })

  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall()
  })

  if (!is.dev) {
    autoUpdater.checkForUpdates().catch(() => { /* ignore */ })
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.claude-session-manager')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize library early so session paths are available on first load
  initLibrary()
  scanLibrary()

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
