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
  buildSessionSummaryFromBackup
} from './session-loader'
import { findCodexSessionFiles } from './codex-loader'
import { findCursorSessionFiles } from './cursor-loader'
import {
  initLibrary,
  applyLibraryTree,
  libraryTreeToConfig,
  loadLibraryConfig,
  saveLibraryConfig,
  ensureSessionInLibrary,
  updateTranscript,
  getSessionMdPath,
  getSessionDirPath,
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
  type LibrarySession,
  type LibraryTree
} from './library-manager'
import { loadConfig, saveConfig } from './config-store'
import { spotlightSearch } from './spotlight-search'
import { searchIndexedSessions } from './session-search'
import { synchronizeSearchSources } from './search-index'
import { buildInsights } from './insights'
import { TranscriptWatcher, scanActiveTranscriptSourcesFromTree } from './transcript-watcher'
import { LibraryWorkerClient, type LibraryWorkerProgress } from './library-worker'
import { SessionSyncCoordinator, type SessionSyncRequest } from './session-sync-coordinator'
import { addSessionCoverage, collectSessionCoverage } from './session-coverage'
import {
  normalizeResumeTerminalSettings,
  openResumeTerminal
} from './resume-terminal'
import {
  buildGuardedResumeCommand,
  openGuardedForkCommand,
  openGuardedResumeAction,
  openGuardedResumeCommand,
  type ResumeActionResult
} from './resume-guard'
import type { ResumeLaunchAction, ResumeSurface } from './session-actions'
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
let libraryWorker: LibraryWorkerClient | null = null
let sessionSyncCoordinator: SessionSyncCoordinator | null = null
let libraryRescanTimer: ReturnType<typeof setTimeout> | null = null
let pendingSpotlightNavigationSessionId: string | null = null
const knownSessionIds = new Set<string>()
let libraryInitialized = false
let latestLibraryTree: LibraryTree | null = null
let libraryInitializationPromise: Promise<void> | null = null
let libraryHydrationGeneration = 0
let searchIndexWarmScheduled = false

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

function cachedSummaryForSource(filePath?: string, sessionId?: string): SessionSummary | undefined {
  if (filePath) {
    const byPath = cachedSessions.find((session) =>
      session.filePath === filePath || session.allFilePaths?.includes(filePath)
    )
    if (byPath) return byPath
  }
  if (!sessionId) return undefined
  return cachedSessions.find((session) =>
    session.sessionId === sessionId || session.id === sessionId || session.continuationSessionIds?.includes(sessionId)
  )
}

function markSessionActive(sessionId?: string): void {
  if (!sessionId || previousActiveIds.includes(sessionId)) return
  previousActiveIds = [...previousActiveIds, sessionId].sort()
  mainWindow?.webContents.send('sessions:activeChanged', previousActiveIds)
}

async function performSessionSynchronization(request: SessionSyncRequest): Promise<void> {
  const cached = cachedSummaryForSource(request.filePath, request.sessionId)
  const filePath = request.filePath || cached?.filePath
  if (!filePath) return
  const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
  const { summary, dirPath } = await worker.syncSession({
    root: getLibraryRoot(),
    filePath,
    sessionId: request.sessionId,
    source: request.source,
    maintainLibrary: libraryInitialized
  })
  markSessionActive(summary.sessionId)
  annotateSessionForFrontend(summary, dirPath)
  if (dirPath) {
    summary.libraryDirPath = dirPath
    summary.libraryMdPath = path.join(dirPath, 'transcript.md')
  }

  const continuationParent = cachedSessions.find((session) =>
    session.continuationSessionIds?.includes(summary!.sessionId)
  )
  if (continuationParent) {
    const updatedParent: SessionSummary = {
      ...continuationParent,
      updatedAt: summary.updatedAt > continuationParent.updatedAt
        ? summary.updatedAt
        : continuationParent.updatedAt,
      permissionMode: summary.permissionMode || continuationParent.permissionMode,
      resumeCwd: summary.resumeCwd || continuationParent.resumeCwd
    }
    const parentIndex = cachedSessions.findIndex((session) => session.id === continuationParent.id)
    if (parentIndex >= 0) cachedSessions[parentIndex] = updatedParent
    mainWindow?.webContents.send('session:summaryUpdated', updatedParent)
    return
  }

  const existingIndex = cachedSessions.findIndex((session) => session.id === summary!.id)
  if (existingIndex >= 0) {
    cachedSessions[existingIndex] = summary
    knownSessionIds.add(summary.id)
    knownSessionIds.add(summary.sessionId)
    mainWindow?.webContents.send('session:summaryUpdated', summary)
  } else {
    cachedSessions = [summary, ...cachedSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    knownSessionIds.add(summary.id)
    knownSessionIds.add(summary.sessionId)
    mainWindow?.webContents.send('session:added', summary)
  }
}

function scheduleSessionSynchronization(request: SessionSyncRequest): void {
  const cached = cachedSummaryForSource(request.filePath, request.sessionId)
  markSessionActive(request.sessionId || cached?.sessionId)
  sessionSyncCoordinator?.schedule({
    ...request,
    sessionId: request.sessionId || cached?.sessionId
  })
}

function scheduleSearchIndexWarmup(): void {
  if (searchIndexWarmScheduled) return
  searchIndexWarmScheduled = true
  const timer = setTimeout(() => {
    void synchronizeSearchSources(currentSearchSources())
      .catch((error) => {
        console.error('[search-index] background warmup failed:', error)
      })
      .finally(() => { searchIndexWarmScheduled = false })
  }, 0)
  timer.unref?.()
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
  libraryWatcher?.close()
  libraryWatcher = null
  if (libraryRescanTimer) {
    clearTimeout(libraryRescanTimer)
    libraryRescanTimer = null
  }
  transcriptWatcher?.stop()
  transcriptWatcher = null
  libraryWorker?.close()
  libraryWorker = null
  sessionSyncCoordinator?.stop()
  sessionSyncCoordinator = null
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
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
  })

  watcher.on('add', (filePath) => {
    if (filePath.includes('/subagents/')) return
    scheduleSessionSynchronization({ filePath, source: 'claude-code', reason: 'add' })
  })

  watcher.on('change', (filePath) => {
    if (filePath.includes('/subagents/')) return
    scheduleSessionSynchronization({ filePath, source: 'claude-code', reason: 'change' })
  })
}

function startCodexWatcher(): void {
  const codexDir = join(process.env.HOME || '', '.codex', 'sessions')
  if (!fs.existsSync(codexDir)) return
  codexWatcher = chokidar.watch(join(codexDir, '**/*.jsonl'), {
    ignoreInitial: true,
    depth: 4
  })

  const handleCodexFile = (filePath: string) => {
    if (!basename(filePath).startsWith('rollout-')) return
    scheduleSessionSynchronization({ filePath, source: 'codex', reason: 'change' })
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

  const handleCursorFile = (filePath: string) => {
    scheduleSessionSynchronization({ filePath, source: 'cursor', reason: 'change' })
  }

  cursorWatcher.on('add', handleCursorFile)
  cursorWatcher.on('change', handleCursorFile)
}

function collectLibrarySessionsFromTree(tree: LibraryTree): LibrarySession[] {
  const bySessionId = new Map<string, LibrarySession>()
  const add = (session: LibrarySession): void => {
    const existing = bySessionId.get(session.sessionId)
    if (!existing || (existing.isSymlink && !session.isSymlink)) {
      bySessionId.set(session.sessionId, session)
    }
  }
  const visit = (folder: LibraryTree['folders'][number]): void => {
    folder.sessions.forEach(add)
    folder.children.forEach(visit)
  }
  tree.ungroupedSessions.forEach(add)
  tree.folders.forEach(visit)
  return [...bySessionId.values()]
}

function mergeSessionPatch(patch: SessionSummary[]): void {
  if (patch.length === 0) return
  const byId = new Map(cachedSessions.map((session) => [session.id, session]))
  for (const session of patch) {
    byId.set(session.id, session)
    knownSessionIds.add(session.id)
    knownSessionIds.add(session.sessionId)
    for (const continuationId of session.continuationSessionIds || []) {
      knownSessionIds.add(continuationId)
    }
  }
  cachedSessions = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function emitLibraryPatch(sessions: SessionSummary[], tree?: LibraryTree): void {
  mainWindow?.webContents.send('sessions:libraryPatch', {
    sessions,
    config: tree ? libraryTreeToConfig(tree) : undefined
  })
}

function adoptLibraryTree(tree: LibraryTree, notifyRenderer = true): LibraryTree {
  // Ignore a queued response for a root that was replaced while the worker was scanning.
  if (path.resolve(tree.root) !== path.resolve(getLibraryRoot())) return tree
  latestLibraryTree = tree
  applyLibraryTree(tree)
  refreshCachedMissingSources()
  scheduleSearchIndexWarmup()
  transcriptWatcher?.refresh()
  if (notifyRenderer) emitLibraryPatch([], tree)
  return tree
}

async function requestLibraryScan(notifyRenderer = true): Promise<LibraryTree> {
  const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
  const tree = await worker.scan(getLibraryRoot())
  return adoptLibraryTree(tree, notifyRenderer)
}

function reportLibrarySyncProgress(progress: LibraryWorkerProgress): void {
  mainWindow?.webContents.send('library:syncProgress', progress)
}

async function hydrateLibrarySessions(tree: LibraryTree): Promise<void> {
  const generation = ++libraryHydrationGeneration
  const batchSize = 20
  const librarySessions = collectLibrarySessionsFromTree(tree)
  const backupPaths = new Set(librarySessions.map((session) => session.jsonlPath))
  const yieldToMainLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  let batch: SessionSummary[] = []
  const flush = async (): Promise<void> => {
    if (generation !== libraryHydrationGeneration || batch.length === 0) return
    const patch = batch
    batch = []
    mergeSessionPatch(patch)
    emitLibraryPatch(patch)
    await yieldToMainLoop()
  }

  // Phase 2a: add Library metadata to the local summaries already rendered in phase 1.
  const localSnapshot = [...cachedSessions]
  for (const session of localSnapshot) {
    if (generation !== libraryHydrationGeneration) return
    if (backupPaths.has(session.filePath)) continue
    const dirPath = getSessionDirPath(session.sessionId)
    annotateSessionForFrontend(session, dirPath)
    if (dirPath && session.id.includes(':intra-')) {
      let branchMd: string | null | undefined = getBranchMdPath(session.id)
      if (!branchMd && session.branchLeafUuid) {
        const branchMeta = loadLibraryConfig().branchMeta?.[session.id]
        branchMd = await updateBranchTranscript(
          session.id,
          session.branchLeafUuid,
          branchMeta?.customTitle
        ) || undefined
      }
      session.libraryMdPath = branchMd || getSessionMdPath(session.sessionId) || undefined
    }
    batch.push(session)
    if (batch.length >= batchSize) await flush()
  }
  await flush()

  // Phase 2b: parse Library-only backups incrementally instead of blocking the first paint.
  const coveredIds = collectSessionCoverage(cachedSessions)
  for (const librarySession of librarySessions) {
    if (generation !== libraryHydrationGeneration) return
    const { sessionId, jsonlPath: backupPath, meta } = librarySession
    if (coveredIds.has(sessionId) || !fs.existsSync(backupPath)) continue
    try {
      const summary = await buildSessionSummaryFromBackup(backupPath, sessionId, meta)
      if (!summary || coveredIds.has(summary.id) || coveredIds.has(summary.sessionId)) continue
      summary.allFilePaths = [backupPath]
      annotateSessionForFrontend(summary, getSessionDirPath(sessionId))
      const remoteState = resolveLibrarySessionRemoteState(meta)
      summary.isRemote = remoteState.isRemote
      if (remoteState.remoteHost) summary.remoteHost = remoteState.remoteHost
      if (meta.customTitle) (summary as any)._libraryTitle = meta.customTitle
      addSessionCoverage(coveredIds, summary)
      batch.push(summary)
      if (batch.length >= batchSize) await flush()
    } catch { /* skip an unparseable or unavailable iCloud backup */ }
  }
  await flush()
}

async function initializeLibraryScanInBackground(): Promise<void> {
  try {
    const tree = await requestLibraryScan()
    transcriptWatcher?.start()
    if (cachedSessions.length > 0) void hydrateLibrarySessions(tree)
  } catch (error) {
    console.error('[library-worker] initial scan failed:', error)
  }
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
      void requestLibraryScan().then((tree) => hydrateLibrarySessions(tree)).catch((error) => {
        console.error('[library-worker] watched scan failed:', error)
      })
    }, 1500)
  }
  libraryWatcher.on('addDir', schedule).on('unlinkDir', schedule)
}

// --- Library Initialization ---

async function initLibraryFromSessions(sessions: SessionSummary[]): Promise<void> {
  if (libraryInitializationPromise) return libraryInitializationPromise
  const work = (async (): Promise<void> => {
    initLibrary()
    const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
    const oldConfig = loadConfig()
    let tree = latestLibraryTree || await requestLibraryScan(false)
    const needsMigration = oldConfig.folders.length > 0 &&
      tree.folders.length === 0 && tree.ungroupedSessions.length === 0

    tree = await worker.sync(getLibraryRoot(), sessions, oldConfig.sessionMeta, {
      onProgress: reportLibrarySyncProgress
    })
    adoptLibraryTree(tree, false)

    if (needsMigration) {
      // This one-time directory migration needs the worker-built index but does not parse transcripts.
      await migrateFromOldConfig(oldConfig.folders, oldConfig.sessionMeta)
      const libConfig = loadLibraryConfig()
      libConfig.preferences = oldConfig.preferences
      saveLibraryConfig(libConfig)
      tree = await requestLibraryScan(false)
    }

    // Include any session that arrived while the initial worker batch was running.
    if (cachedSessions.some((session) => !sessions.some((initial) => initial.id === session.id))) {
      tree = await worker.sync(getLibraryRoot(), cachedSessions, oldConfig.sessionMeta, {
        onProgress: reportLibrarySyncProgress
      })
      adoptLibraryTree(tree, false)
    }

    libraryInitialized = true
    adoptLibraryTree(tree)
    await hydrateLibrarySessions(tree)
  })()
  libraryInitializationPromise = work
  try {
    await work
  } finally {
    if (libraryInitializationPromise === work) libraryInitializationPromise = null
  }
}

// --- IPC Handlers ---

ipcMain.handle('sessions:getActive', () => previousActiveIds)

// --- Spotlight ---

ipcMain.handle('spotlight:search', (_event, query: string) => {
  const config = latestLibraryTree ? libraryTreeToConfig(latestLibraryTree) : loadConfig()

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
  const result = await openGuardedResumeAction({
    sessionId,
    sessions: cachedSessions,
    cwd,
    surface: defaultResumeSurfaceForSession(sessionId),
    reloadSessions: reloadSessionsForAction,
    openAction: openResumeAction
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
    const tree = await requestLibraryScan()
    await hydrateLibrarySessions(tree)
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
  scheduleSearchIndexWarmup()
  knownSessionIds.clear()

  // Phase 1 only: return source summaries immediately. Library annotation and
  // cross-device backups arrive through sessions:libraryPatch after worker scan.
  for (const s of sessions) {
    knownSessionIds.add(s.sessionId)
    knownSessionIds.add(s.id)
    for (const continuationId of s.continuationSessionIds || []) {
      knownSessionIds.add(continuationId)
    }
    // Skip library/remote processing for non-Claude-Code sessions
    if (s.source === 'codex' || s.source === 'cursor' || s.source === 'opencode' || s.source === 'zcode') continue

    if (s.projectPath && isRemoteProjectPath(s.projectPath)) {
      s.isRemote = true
      const remoteUser = extractRemoteUser(s.projectPath)
      if (remoteUser) s.remoteHost = `${remoteUser}@remote`
    }
  }

  cachedSessions = sessions

  if (latestLibraryTree) void hydrateLibrarySessions(latestLibraryTree)

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

// Refreshed only by Library scan/sync events. Search queries never recurse the vault.
let cachedMissingSources: Array<{ sessionId: string; backupPath: string }> | null = null

function refreshCachedMissingSources(): void {
  if (!latestLibraryTree) {
    cachedMissingSources ||= []
    return
  }
  cachedMissingSources = collectLibrarySessionsFromTree(latestLibraryTree)
    .filter((session) => {
      const sources = Array.isArray(session.meta.sourceFilePaths) ? session.meta.sourceFilePaths : []
      return sources.length === 0 || !sources.some((sourcePath) => {
        const branchMarker = sourcePath.indexOf('#')
        const physicalPath = branchMarker >= 0 ? sourcePath.slice(0, branchMarker) : sourcePath
        return fs.existsSync(physicalPath)
      })
    })
    .filter((session) => fs.existsSync(session.jsonlPath))
    .map((session) => ({ sessionId: session.sessionId, backupPath: session.jsonlPath }))
}

function currentSearchSources(): Array<{ filePath: string; sessionId?: string; isLibraryBackup?: boolean }> {
  const files = findAllSessionFiles().filter((filePath) => !filePath.includes('/subagents/'))
  return [
    ...files.map((filePath) => ({ filePath })),
    ...(cachedMissingSources || []).map(({ sessionId, backupPath }) => ({
      filePath: backupPath,
      sessionId,
      isLibraryBackup: true
    }))
  ]
}

ipcMain.handle('sessions:search', async (_event, query: string) => {
  return searchIndexedSessions(query)
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

async function openResumeAction(action: ResumeLaunchAction): Promise<void> {
  if (action.kind === 'terminal' || action.kind === 'remote-control') {
    openInTerminal(action.command)
    return
  }

  let protocol: string
  try {
    protocol = new URL(action.url).protocol
  } catch {
    throw new Error('Resume deep link 格式不合法')
  }
  if (!['codex:', 'claude:', 'zcode:'].includes(protocol)) {
    throw new Error('Resume deep link 协议不受支持')
  }

  if (process.platform === 'darwin') {
    let handler = ''
    try {
      handler = app.getApplicationNameForProtocol(action.url)
    } catch {
      handler = ''
    }
    if (!handler && protocol === 'zcode:') {
      const zcodeAppPath = '/Applications/ZCode.app'
      if (fs.existsSync(zcodeAppPath)) {
        const error = await shell.openPath(zcodeAppPath)
        if (error) throw new Error(`无法打开 ZCode App：${error}`)
        return
      }
    }
    if (!handler) {
      const client = protocol === 'codex:' ? 'Codex/ChatGPT' : protocol === 'claude:' ? 'Claude' : 'ZCode'
      throw new Error(`未检测到可处理 ${protocol} 的 ${client} App`)
    }
    const expectedHandler = protocol === 'codex:'
      ? /^(Codex|ChatGPT)$/i
      : protocol === 'claude:'
        ? /^Claude$/i
        : /^ZCode$/i
    if (!expectedHandler.test(handler.trim())) {
      throw new Error(`${protocol} 当前由非官方应用“${handler}”处理，已拒绝打开`)
    }
  }

  await shell.openExternal(action.url)
}

function experimentalClaudeDesktopImportEnabled(): boolean {
  try {
    const preferences = shouldReadLibraryConfig()
      ? loadLibraryConfig().preferences
      : loadConfig().preferences
    return preferences?.experimentalClaudeDesktopImport === true
  } catch {
    return false
  }
}

function defaultResumeSurfaceForSession(sessionId: string): ResumeSurface {
  const session = cachedSessions.find((candidate) =>
    candidate.id === sessionId ||
    candidate.sessionId === sessionId ||
    candidate.resumeSessionId === sessionId ||
    (candidate.continuationSessionIds || []).includes(sessionId)
  )
  return session?.source === 'zcode' ? 'zcode-desktop' : 'terminal'
}

ipcMain.handle(
  'terminal:resume',
  async (
    _event,
    sessionId: string,
    _terminalApp: string,
    permissionMode?: string,
    cwd?: string,
    surface?: ResumeSurface
  ) => {
    const effectiveSurface = surface || defaultResumeSurfaceForSession(sessionId)
    return openGuardedResumeAction({
      sessionId,
      sessions: cachedSessions,
      permissionMode,
      cwd,
      surface: effectiveSurface,
      allowExperimentalClaudeDesktop: experimentalClaudeDesktopImportEnabled(),
      reloadSessions: reloadSessionsForAction,
      openAction: openResumeAction
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
    if (latestLibraryTree) {
      const cfg = libraryTreeToConfig(latestLibraryTree)
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

// Return raw JSON report for in-app rendering (no HTML file)
ipcMain.handle('insights:generateJson', async (event, options?: { startDate?: string; endDate?: string }) => {
  const sendProgress = (stage: string, current: number, total: number): void => {
    try { event.sender.send('insights:progress', { stage, current, total }) } catch { /* ignore */ }
  }
  try {
    const { generateInsightsReport } = await import('./session-insights')
    let sessions = cachedSessions
    if (options?.startDate) {
      const start = new Date(options.startDate).getTime()
      const end = options?.endDate ? new Date(options.endDate).getTime() : Date.now()
      sessions = sessions.filter(s => {
        const t = new Date(s.createdAt).getTime()
        return t >= start && t <= end
      })
    }
    const report = await generateInsightsReport(sessions, 500, sendProgress)
    return { ok: true, report }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
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

ipcMain.handle('insights:listModels', async () => {
  try {
    const { listModels } = await import('./llm-client')
    const libConfig = loadLibraryConfig() as unknown as Record<string, unknown>
    const s = libConfig.llmSettings as { provider?: string; apiKey?: string; baseUrl?: string } | undefined
    if (!s?.apiKey) return []
    return await listModels({
      provider: (s.provider || 'anthropic') as 'anthropic' | 'openai' | 'custom',
      apiKey: s.apiKey,
      baseUrl: s.baseUrl
    })
  } catch {
    return []
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
  if (!shouldReadLibraryConfig() || !latestLibraryTree) {
    // Fallback to old config during initial load
    return loadConfig()
  }
  return libraryTreeToConfig(latestLibraryTree)
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
  async (_event, opts: { name: string; color?: string | null; parentId?: string | null }) => {
    if (libraryInitialized) {
      const parentPath = opts.parentId ? resolveFolderPath(opts.parentId) : undefined
      createLibraryFolder(opts.name, parentPath)
      const tree = await requestLibraryScan()
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
  async (_event, folderId: string, newParentId: string | null, position?: 'before' | 'after' | 'inside', targetId?: string) => {
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
        }
        reorderFolder(newFolderId, targetId, position)
      } else {
        // Move folder into a new parent
        const destParent = newParentId ? resolveFolderPath(newParentId) : getLibraryRoot()
        if (fs.existsSync(srcPath)) {
          moveLibraryFolderToParent(srcPath, destParent)
        }
      }
      const tree = await requestLibraryScan()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { moveFolder } = require('./config-store')
    return moveFolder(config, folderId, newParentId)
  }
)

ipcMain.handle('config:deleteFolder', async (_event, folderId: string) => {
  if (libraryInitialized) {
    const folderPath = resolveFolderPath(folderId)
    deleteLibraryFolder(folderPath)
    const tree = await requestLibraryScan()
    return libraryTreeToConfig(tree)
  }
  const config = loadConfig()
  const { deleteFolder } = require('./config-store')
  return deleteFolder(config, folderId)
})

ipcMain.handle(
  'config:renameFolder',
  async (_event, folderId: string, name: string) => {
    if (libraryInitialized) {
      const folderPath = resolveFolderPath(folderId)
      renameLibraryFolder(folderPath, name)
      const tree = await requestLibraryScan()
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
      const tree = await requestLibraryScan()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { addSessionToFolder } = require('./config-store')
    return addSessionToFolder(config, folderId, sessionId)
  }
)

ipcMain.handle(
  'config:removeSessionFromFolder',
  async (_event, folderId: string, sessionId: string) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        removeBranchFromFolder(sessionId, folderId)
      } else {
        const folderPath = resolveFolderPath(folderId)
        libRemoveSession(sessionId, folderPath)
      }
      const tree = await requestLibraryScan()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { removeSessionFromFolder } = require('./config-store')
    return removeSessionFromFolder(config, folderId, sessionId)
  }
)

ipcMain.handle(
  'config:setSessionMeta',
  async (_event, sessionId: string, meta: { customTitle?: string; notes?: string; highlights?: Highlight[] }) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        setBranchMeta(sessionId, meta as Parameters<typeof setBranchMeta>[1])
      } else {
        setSessionMetaInLibrary(sessionId, meta)
      }
      const tree = await requestLibraryScan()
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
  initLibrary(newPath)
  latestLibraryTree = null
  libraryInitialized = false
  libraryInitializationPromise = null
  libraryHydrationGeneration++
  startLibraryWatcher() // 跟随新库根重启目录监听
  const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
  let tree: LibraryTree
  if (cachedSessions.length > 0) {
    const oldConfig = loadConfig()
    tree = await worker.sync(getLibraryRoot(), cachedSessions, oldConfig.sessionMeta, {
      onProgress: reportLibrarySyncProgress
    })
  } else {
    tree = await worker.scan(getLibraryRoot())
  }
  libraryInitialized = true
  adoptLibraryTree(tree)
  await hydrateLibrarySessions(tree)
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

  // Only resolve/create the root synchronously. Recursive scan and batch sync run in a Worker.
  initLibrary()
  libraryWorker = new LibraryWorkerClient()
  sessionSyncCoordinator = new SessionSyncCoordinator({
    quietWindowMs: 2_000,
    concurrency: 2,
    sync: performSessionSynchronization
  })
  transcriptWatcher = new TranscriptWatcher({
    scan: () => latestLibraryTree
      ? scanActiveTranscriptSourcesFromTree(latestLibraryTree)
      : { sources: [], totalSessionCount: 0 },
    schedule: ({ sessionId, sourcePath }) => {
      scheduleSessionSynchronization({
        sessionId,
        filePath: sourcePath,
        source: 'transcript',
        reason: 'transcript-watcher'
      })
    }
  })
  createWindow()
  startFileWatcher()
  startLibraryWatcher()
  startCodexWatcher()
  startCursorWatcher()
  startActiveSessionPoller()
  void initializeLibraryScanInBackground()
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
