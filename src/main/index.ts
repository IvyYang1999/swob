// MUST stay the first import: rebinds defunct stdio fds before anything
// writes to console or spawns a child (see stdio-repair.ts).
import { logSpawnSelfTest } from './stdio-repair'
import { app, shell, BrowserWindow, ipcMain, Menu, globalShortcut, screen } from 'electron'
import path from 'path'
const { join, dirname, relative } = path
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { setupAutoUpdater as configureAutoUpdater } from './auto-updater'
import { registerAgentIpc, registerAgentShortcut, shutdownAgentRuntime } from './agent-window'
import { execFile, execSync, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import {
  loadAllSessions,
  loadSessionDetail,
  findAllSessionFiles,
  findClaudeSessionFiles,
  buildSessionSummaryFromBackup
} from './session-loader'
import { findCodexSessionFiles, loadCodexRawMessages } from './codex-loader'
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
  getSessionSshResumeAvailability,
  buildSessionSummaryFromManifest,
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
  getSshTargets,
  getSshConfigForSession,
  setSshConfig,
  setSshTargets,
  buildSshResumeCommand,
  getRemoteCwdForSession,
  isRemoteProjectPath,
  extractRemoteUser,
  resolveLibrarySessionRemoteState,
  getConfiguredLibraryPath,
  changeConfiguredLibraryPath,
  isLibraryInitialized,
  isOnboardingNeeded,
  getExcludedSources,
  setExcludedSources,
  completeOnboarding,
  getDefaultLibraryRoot,
  type LibrarySession,
  type LibraryTree
} from './library-manager'
import { loadConfig, saveConfig } from './config-store'
import { spotlightSearch } from './spotlight-search'
import { filterVisibleSearchSources, searchIndexedSessions } from './session-search'
import { synchronizeSearchSources } from './search-index'
import { buildInsights } from './insights'
import {
  drilldownInsights,
  queryInsights,
  sessionUsageEvents
} from './usage-fact-store'
import { TranscriptWatcher, scanActiveTranscriptSourcesFromTree } from './transcript-watcher'
import { LibraryWorkerClient, type LibraryWorkerProgress } from './library-worker'
import { SessionSyncCoordinator, type SessionSyncRequest } from './session-sync-coordinator'
import { LibraryRescanController } from './library-rescan-controller'
import {
  watchLibraryDirectory,
  type LibraryDirectoryWatcher
} from './library-directory-watcher'
import {
  createSourceWatchDefinition,
  watchSourceDirectory,
  type SourceDirectoryWatcher,
  type SourceWatcherErrorContext,
  type SourceWatcherId,
  type SourceWatchDefinition
} from './source-directory-watcher'
import { terminateChildProcess } from './child-process-termination'
import { runRuntimeCleanup } from './runtime-cleanup'
import {
  buildProjectOrganizationPreview,
  executeOrganization,
  undoLastOrganization,
  type OrganizationKind,
  type OrganizationInput
} from './vault-organizer'
import { requestSmartOrganization } from './smart-organizer'
import { addSessionCoverage, collectSessionCoverage } from './session-coverage'
import { toRendererSessionDetail } from './renderer-session-detail'
import { assertPathWithinAllowedRoots, resolvePathWithinRoot } from './path-containment'
import { onboardingBackupSizeEstimator } from './onboarding-backup-size'
import {
  getLlmSettingsForDisplay,
  getLlmSettingsWithSecret,
  setLlmSettings as persistLlmSettings
} from './llm-settings'
import {
  deleteLlmProfile,
  getSmartFeatureAvailability,
  getSmartFeatureBindings,
  listLlmProfiles,
  migrateLegacyLlmProfile,
  resolveProfileForFeature,
  saveLlmProfile,
  setSmartFeatureBindings,
  type SaveLlmProfileInput,
  type SmartFeatureBinding
} from './llm-profiles'
import {
  SmartRenameService,
  serializeSmartRenameError,
  type SmartRenameApplyItem,
  type SmartRenameCandidate
} from './smart-rename'
import {
  normalizeResumeTerminalSettings,
  openResumeLaunchSpec,
  openResumeTerminal
} from './resume-terminal'
import {
  getDetectedTerminals,
  peekDetectedTerminals,
  primeTerminalDetection
} from './terminal-detector'
import {
  defaultResumeMethodForSource,
  migrateSettingsPreferences
} from '../shared/settings-capabilities'
import {
  buildGuardedResumeCommand,
  openGuardedForkAction,
  openGuardedResumeAction,
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
import type { SshTargetConfig } from './types'
import type { AnalysisDimension, AnalysisScope, UsageFactSyncResult } from './analysis-contract'
import { generateSkillContent } from '../cli/command-registry'
import { runtimeHome } from './runtime-home'
import { getPlatformCapabilities, isSessionSourceSupported } from './platform-support'
import { assertRegisteredResumeProtocol } from './deep-link'
import { buildClaudeRecoveryInventory } from './resume-recovery-service'

let mainWindow: BrowserWindow | null = null
let spotlightWindow: BrowserWindow | null = null
let watcher: SourceDirectoryWatcher | null = null
let codexWatcher: SourceDirectoryWatcher | null = null
let cursorWatcher: SourceDirectoryWatcher | null = null
let libraryWatcher: LibraryDirectoryWatcher | null = null
let transcriptWatcher: TranscriptWatcher | null = null
let libraryWorker: LibraryWorkerClient | null = null
let sessionSyncCoordinator: SessionSyncCoordinator | null = null
let libraryRescanController: LibraryRescanController | null = null
let pendingSpotlightNavigationSessionId: string | null = null
const knownSessionIds = new Set<string>()
let libraryInitialized = false
let latestLibraryTree: LibraryTree | null = null
let libraryInitializationPromise: Promise<void> | null = null
let libraryHydrationGeneration = 0
let searchIndexWarmScheduled = false
let usageFactsInitialized = false
let usageFactSyncError: unknown = null
let usageFactSyncTail: Promise<void> = Promise.resolve()

// --- Active Session Detection ---
let previousActiveIds: string[] = []
let activePoller: ReturnType<typeof setInterval> | null = null
let activePollProcess: ChildProcess | null = null

function detectActiveSessionsFromProcesses(): Promise<Set<string>> {
  if (process.platform === 'win32') return Promise.resolve(new Set())
  if (activePollProcess) return Promise.resolve(new Set(previousActiveIds))
  return new Promise((resolve) => {
    let child!: ChildProcess
    child = execFile('/bin/ps', ['-eo', 'command'], {
      encoding: 'utf-8',
      timeout: 3000,
      maxBuffer: 4 * 1024 * 1024
    }, (err, stdout) => {
      if (activePollProcess === child) activePollProcess = null
      if (err) { resolve(new Set()); return }
      const active = new Set<string>()
      for (const line of stdout.split('\n')) {
        if (!line.includes('claude')) continue
        const match = line.match(/--resume\s+(\S+)/)
        if (match) active.add(match[1])
      }
      resolve(active)
    })
    activePollProcess = child
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
  void pushActiveSessionIds()
  activePoller = setInterval(() => { void pushActiveSessionIds() }, 1000)
}
let cachedSessions: SessionSummary[] = []

const approvedLibraryRoots = new Set<string>()
let onboardingEstimateTargetPath: string | null = null

function safeProjectRoots(): string[] {
  const home = path.resolve(runtimeHome())
  const roots = new Set<string>()
  for (const session of cachedSessions) {
    for (const candidate of [session.resumeCwd, ...(session.cwds || [])]) {
      if (!candidate || !path.isAbsolute(candidate)) continue
      const resolved = path.resolve(candidate)
      const volumeRoot = path.parse(resolved).root
      // A transcript is input data, not an authorization to expose a whole
      // home/volume. Only narrower project directories become capabilities.
      if (resolved === volumeRoot || resolved === home || home.startsWith(`${resolved}${path.sep}`)) continue
      roots.add(resolved)
    }
  }
  return [...roots]
}

function sessionSourceRoots(): string[] {
  const home = runtimeHome()
  const roots = [
    getLibraryRoot(),
    join(home, '.claude', 'projects'),
    join(home, '.claude-window'),
    join(home, '.codex', 'sessions')
  ]
  if (isSessionSourceSupported('cursor')) roots.push(join(home, '.cursor', 'projects'))
  if (isSessionSourceSupported('opencode')) roots.push(join(home, '.local', 'share', 'opencode'))
  if (isSessionSourceSupported('zcode')) roots.push(join(home, '.zcode', 'cli', 'db'))
  return roots
}

function assertSessionSourcePath(filePath: string): string {
  return assertPathWithinAllowedRoots(filePath, sessionSourceRoots())
}

function assertProjectOrLibraryPath(filePath: string): string {
  return assertPathWithinAllowedRoots(filePath, [getLibraryRoot(), ...safeProjectRoots()])
}

function assertResumeCwd(sessionId: string, cwd?: string): void {
  if (!cwd) return
  const session = cachedSessions.find((item) =>
    item.id === sessionId ||
    item.sessionId === sessionId ||
    (item.continuationSessionIds || []).includes(sessionId)
  )
  const roots = session
    ? [session.resumeCwd, ...(session.cwds || [])].filter((item): item is string => Boolean(item))
    : []
  assertPathWithinAllowedRoots(cwd, roots)
}

function approveLibraryRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath)
  if (!path.isAbsolute(rootPath) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Library root must be an existing absolute directory')
  }
  const canonical = fs.realpathSync.native(resolved)
  approvedLibraryRoots.add(canonical)
  return canonical
}

function assertApprovedLibraryRoot(rootPath: string): string {
  const resolved = path.resolve(rootPath)
  const canonical = fs.existsSync(resolved) ? fs.realpathSync.native(resolved) : resolved
  if (!approvedLibraryRoots.has(canonical)) throw new Error('Library path was not approved by the directory picker')
  return canonical
}

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
  session.canResumeLocal = resumeAvailability.canResume
  if (resumeAvailability.canResume) {
    delete session.resumeUnavailableReason
  } else {
    session.resumeUnavailableReason = resumeAvailability.reason
  }

  const sshAvailability = getSessionSshResumeAvailability(session.sessionId)
  session.canResumeSsh = sshAvailability.canResume
  if (sshAvailability.canResume) delete session.sshResumeUnavailableReason
  else session.sshResumeUnavailableReason = sshAvailability.reason
  if (sshAvailability.warning) session.sshResumeWarning = sshAvailability.warning
  else delete session.sshResumeWarning

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
    void scheduleUsageFactSync()
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
  void scheduleUsageFactSync()
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

function currentAnalysisFolders(): Folder[] {
  try {
    return latestLibraryTree
      ? libraryTreeToConfig(latestLibraryTree).folders || []
      : loadConfig().folders || []
  } catch {
    return []
  }
}

/**
 * Serialize fact writes in the Library worker. The query path only waits for
 * the current snapshot; it never parses source JSONL or performs a new scan.
 */
function scheduleUsageFactSync(options: { rebuild?: boolean } = {}): Promise<UsageFactSyncResult> {
  usageFactsInitialized = true
  const sessions = [...cachedSessions]
  const folders = currentAnalysisFolders()
  const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
  const run = usageFactSyncTail
    .catch(() => { /* the next snapshot supersedes a failed one */ })
    .then(() => worker.syncUsageFacts(getLibraryRoot(), sessions, folders, options))
  usageFactSyncTail = run.then(
    () => { usageFactSyncError = null },
    (error) => {
      usageFactSyncError = error
      console.error('[usage-facts] background synchronization failed:', error)
    }
  )
  return run
}

async function ensureUsageFactsReady(): Promise<void> {
  if (!usageFactsInitialized) {
    await scheduleUsageFactSync()
    return
  }
  await usageFactSyncTail
  if (usageFactSyncError) await scheduleUsageFactSync()
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
  void scheduleUsageFactSync()
  return cachedSessions
}

function shouldReadLibraryConfig(): boolean {
  return libraryInitialized || isLibraryInitialized(getLibraryRoot())
}

function openFileDescriptorCount(): number | null {
  if (process.platform !== 'darwin') return null
  try { return fs.readdirSync('/dev/fd').length } catch { return null }
}

function writeLifecycleLog(event: string, fields: Record<string, unknown> = {}): void {
  try {
    const logPath = join(runtimeHome(), '.claude-session-manager', 'lifecycle.log')
    fs.mkdirSync(dirname(logPath), { recursive: true })
    fs.appendFileSync(logPath, `${JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      event,
      openFds: openFileDescriptorCount(),
      ...fields
    })}\n`)
  } catch { /* lifecycle diagnostics must never block startup or quit */ }
}

let runtimeCleanupPromise: Promise<void> | null = null

function cleanupRuntimeResources(): Promise<void> {
  if (runtimeCleanupPromise) return runtimeCleanupPromise
  const sourceWatchers = [watcher, codexWatcher, cursorWatcher].filter(
    (candidate): candidate is SourceDirectoryWatcher => candidate !== null
  )
  watcher = null
  codexWatcher = null
  cursorWatcher = null
  const currentLibraryWatcher = libraryWatcher
  libraryWatcher = null
  const currentLibraryRescanController = libraryRescanController
  libraryRescanController = null
  const currentTranscriptWatcher = transcriptWatcher
  transcriptWatcher = null
  const currentLibraryWorker = libraryWorker
  libraryWorker = null
  const currentSessionSyncCoordinator = sessionSyncCoordinator
  sessionSyncCoordinator = null
  const currentActivePoller = activePoller
  activePoller = null
  const currentActivePollProcess = activePollProcess
  activePollProcess = null

  runtimeCleanupPromise = runRuntimeCleanup([
    { name: 'agent-child', timeoutMs: 800, run: shutdownAgentRuntime },
    {
      name: 'active-session-poller',
      timeoutMs: 250,
      run: async () => {
        if (currentActivePoller) clearInterval(currentActivePoller)
        if (currentActivePollProcess) {
          await terminateChildProcess(currentActivePollProcess, { graceMs: 100, killWaitMs: 100 })
        }
      }
    },
    {
      name: 'source-watchers',
      timeoutMs: 300,
      run: async () => { await Promise.all(sourceWatchers.map((sourceWatcher) => sourceWatcher.close())) }
    },
    {
      name: 'library-watcher',
      timeoutMs: 200,
      run: async () => { await currentLibraryWatcher?.close() }
    },
    {
      name: 'controllers',
      timeoutMs: 100,
      run: () => {
        currentLibraryRescanController?.dispose()
        currentTranscriptWatcher?.stop()
        currentSessionSyncCoordinator?.stop()
      }
    },
    {
      name: 'library-worker',
      timeoutMs: 300,
      run: async () => { await currentLibraryWorker?.close() }
    },
    { name: 'global-shortcuts', timeoutMs: 50, run: () => globalShortcut.unregisterAll() }
  ], {
    totalBudgetMs: 1_800,
    log: writeLifecycleLog
  }).then(() => undefined)
  return runtimeCleanupPromise
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 15, y: 15 } }
      : {}),
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

function sourceWatcherErrorHandler(source: SourceWatcherId) {
  return (error: unknown, context: SourceWatcherErrorContext): void => {
    const errorName = error instanceof Error ? error.name : typeof error
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : undefined
    console.error(`[source-watcher:${source}] ${context.phase} failed; ${
      context.retryInMs === null ? 'continuing' : `retrying in ${context.retryInMs}ms`
    }:`, error)
    writeLifecycleLog('source-watcher-error', {
      source,
      phase: context.phase,
      attempt: context.attempt,
      retryInMs: context.retryInMs,
      backend: context.backend,
      errorName,
      errorCode
    })
  }
}

function sourceWatcherReadyHandler(definition: SourceWatchDefinition) {
  return (attempt: number, backend: SourceDirectoryWatcher['backend']): void => {
    writeLifecycleLog('source-watcher-ready', {
      source: definition.id,
      backend,
      attempt
    })
    if (attempt === 0) return
    const files = definition.id === 'claude-code'
      ? findClaudeSessionFiles().filter(definition.matches)
      : definition.id === 'codex'
        ? findCodexSessionFiles().filter(definition.matches)
        : findCursorSessionFiles().filter(definition.matches)
    for (const filePath of files) {
      scheduleSessionSynchronization({ filePath, source: definition.id, reason: 'change' })
    }
    writeLifecycleLog('source-watcher-recovery-scheduled', {
      source: definition.id,
      fileCount: files.length
    })
  }
}

function startFileWatcher(): void {
  const definition = createSourceWatchDefinition('claude-code', runtimeHome())
  watcher = watchSourceDirectory({
    definition,
    onReady: sourceWatcherReadyHandler(definition),
    onError: sourceWatcherErrorHandler(definition.id),
    onFile: (filePath, event) => {
      scheduleSessionSynchronization({ filePath, source: definition.id, reason: event })
    }
  })
}

function startCodexWatcher(): void {
  const definition = createSourceWatchDefinition('codex', runtimeHome())
  if (!fs.existsSync(definition.roots[0])) return
  codexWatcher = watchSourceDirectory({
    definition,
    onReady: sourceWatcherReadyHandler(definition),
    onError: sourceWatcherErrorHandler(definition.id),
    onFile: (filePath) => {
      scheduleSessionSynchronization({ filePath, source: definition.id, reason: 'change' })
    }
  })
}

function startCursorWatcher(): void {
  if (!isSessionSourceSupported('cursor')) return
  const definition = createSourceWatchDefinition('cursor', runtimeHome())
  if (!fs.existsSync(definition.roots[0])) return
  cursorWatcher = watchSourceDirectory({
    definition,
    onReady: sourceWatcherReadyHandler(definition),
    onError: sourceWatcherErrorHandler(definition.id),
    onFile: (filePath) => {
      scheduleSessionSynchronization({ filePath, source: definition.id, reason: 'change' })
    }
  })
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
  if (cachedSessions.length > 0) void scheduleUsageFactSync()
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
  // If backup.jsonl is absent/placeholder/unparseable, the small manifest still
  // produces a visible session with explicit download/SSH capabilities.
  const coveredIds = collectSessionCoverage(cachedSessions)
  for (const librarySession of librarySessions) {
    if (generation !== libraryHydrationGeneration) return
    const { sessionId, jsonlPath: backupPath, meta } = librarySession
    if (coveredIds.has(sessionId)) continue
    try {
      const summary = fs.existsSync(backupPath)
        ? await buildSessionSummaryFromBackup(backupPath, sessionId, meta) || buildSessionSummaryFromManifest(librarySession)
        : buildSessionSummaryFromManifest(librarySession)
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
    } catch {
      const summary = buildSessionSummaryFromManifest(librarySession)
      if (coveredIds.has(summary.id) || coveredIds.has(summary.sessionId)) continue
      annotateSessionForFrontend(summary, getSessionDirPath(sessionId))
      const remoteState = resolveLibrarySessionRemoteState(meta)
      summary.isRemote = remoteState.isRemote
      if (remoteState.remoteHost) summary.remoteHost = remoteState.remoteHost
      if (meta.customTitle) (summary as any)._libraryTitle = meta.customTitle
      addSessionCoverage(coveredIds, summary)
      batch.push(summary)
      if (batch.length >= batchSize) await flush()
    }
  }
  await flush()
  void scheduleUsageFactSync()
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

// 监听库目录本身的结构变化。macOS 必须使用 FSEvents 的单一目录树事件流；chokidar 5/Node
// fs.watch 会为库内每个路径保留 fd，大库会撞上 launchd 的 10k fd 上限，令后续 spawn EBADF。
function startLibraryWatcher(): void {
  if (libraryWatcher) { void libraryWatcher.close(); libraryWatcher = null }
  libraryRescanController?.dispose()
  libraryRescanController = null
  const root = getLibraryRoot()
  if (!root || !fs.existsSync(root)) return
  libraryRescanController = new LibraryRescanController(async () => {
    const tree = await requestLibraryScan()
    await hydrateLibrarySessions(tree)
  }, 750)
  libraryWatcher = watchLibraryDirectory({
    root,
    onDirty: () => libraryRescanController?.markDirty(),
    onError: (error) => console.error('[library-watcher] failed:', error)
  })
  writeLifecycleLog('library-watcher-started', { backend: libraryWatcher.backend })
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
  assertResumeCwd(sessionId, cwd)
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
  if (!getPlatformCapabilities().features.cloudPlaceholders) return false
  return isSessionCloudOnly(sessionId)
})

ipcMain.handle('icloud:download', (_event, sessionId: string) => {
  if (!getPlatformCapabilities().features.cloudPlaceholders) {
    throw new Error('Windows Alpha 暂不支持 OneDrive/iCloud 占位文件下载')
  }
  return triggerICloudDownload(sessionId)
})

// Report the current cloud-only set. Library discovery is watcher-driven; this
// read-only status query must never trigger a full scan/hydration.
ipcMain.handle('icloud:scanCloudSessions', async () => {
  if (!getPlatformCapabilities().features.cloudPlaceholders) return []
  const cloudSessions: string[] = []
  for (const session of cachedSessions) {
    if (isSessionCloudOnly(session.sessionId)) {
      cloudSessions.push(session.sessionId)
    }
  }

  return cloudSessions
})

// --- SSH ---

ipcMain.handle('ssh:getConfig', () => getSshConfig())
ipcMain.handle('ssh:getTargets', () => getSshTargets())

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

ipcMain.handle('ssh:setTargets', (_event, targets: SshTargetConfig[]) => {
  setSshTargets(targets)
})

ipcMain.handle('ssh:resume', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfigForSession(sessionId)
  if (!sshConfig) throw new Error('SSH config not set for this origin device')
  // SSH resume/fork executes on the remote host, so local source-file availability is not authoritative here.
  // Do not attach the local resume guard to this path; the remote machine owns the recoverability check.
  const remoteCwd = getRemoteCwdForSession(sessionId)
  openInTerminal(buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd))
})

ipcMain.handle('ssh:fork', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfigForSession(sessionId)
  if (!sshConfig) throw new Error('SSH config not set for this origin device')
  // Same SSH exemption as ssh:resume: the actual restore happens remotely, not on this machine.
  const remoteCwd = getRemoteCwdForSession(sessionId)
  const cmd = buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd)
  openInTerminal(cmd.replace('--resume', '--fork-session --resume'))
})

ipcMain.handle('ssh:buildCommand', (_event, sessionId: string, permissionMode?: string) => {
  const sshConfig = getSshConfigForSession(sessionId)
  if (!sshConfig) return null
  // Builds a remote command only; local Library/source guard would be the wrong boundary.
  const remoteCwd = getRemoteCwdForSession(sessionId)
  return buildSshResumeCommand(sessionId, sshConfig, permissionMode, remoteCwd)
})

// Load a local image file as data URL, with fallback to ~/.claude/image-cache/
ipcMain.handle('image:load', async (_event, filePath: string) => {
  const safeOriginalPath = assertProjectOrLibraryPath(filePath)
  const tryLoad = (p: string): { dataUrl: string; status: string } | null => {
    try {
      if (!fs.existsSync(p)) return null
      const ext = path.extname(p).toLowerCase()
      const mimeMap: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }
      const mime = mimeMap[ext]
      if (!mime || fs.statSync(p).size > 25 * 1024 * 1024) return null
      const data = fs.readFileSync(p).toString('base64')
      return { dataUrl: `data:${mime};base64,${data}`, status: 'exists' }
    } catch { return null }
  }
  // Try original path
  const original = tryLoad(safeOriginalPath)
  if (original) return original
  // Try image-cache: scan all subdirs for matching filename
  const cacheDir = path.join(runtimeHome(), '.claude', 'image-cache')
  try {
    if (fs.existsSync(cacheDir)) {
      const basename = path.basename(safeOriginalPath)
      for (const sub of fs.readdirSync(cacheDir)) {
        try {
          const cached = resolvePathWithinRoot(cacheDir, path.join(sub, basename), {
            allowRoot: false,
            allowAbsolute: false
          })
          const result = tryLoad(cached)
          if (result) return { ...result, status: 'cached' }
        } catch {
          // A cache entry may be an untrusted symlink. Never follow it outside
          // the dedicated image-cache root.
        }
      }
    }
  } catch { /* ignore */ }
  return { dataUrl: null, status: 'missing' }
})

// Native context menu for images
ipcMain.handle('image:contextMenu', (_event, options: { path: string }) => {
  const { Menu, shell, clipboard } = require('electron')
  const safePath = assertProjectOrLibraryPath(options.path)
  const menu = Menu.buildFromTemplate([
    { label: '打开图片', click: () => shell.openPath(safePath) },
    { label: '在 Finder 中显示', click: () => shell.showItemInFolder(safePath) },
    { type: 'separator' },
    { label: '复制路径', click: () => clipboard.writeText(safePath) }
  ])
  menu.popup()
})

function filterExcludedSources(sessions: SessionSummary[]): SessionSummary[] {
  const excluded = getExcludedSources()
  if (excluded.length === 0) return sessions
  const excludedSet = new Set(excluded)
  return sessions.filter((s) => !excludedSet.has(s.source || 'claude-code'))
}

ipcMain.handle('platform:getCapabilities', () => {
  // Playwright can exercise the Windows-only renderer state on a Mac builder;
  // production always uses the immutable native process.platform value.
  const platform = process.env.NODE_ENV === 'test' && process.env.SWOB_TEST_PLATFORM === 'win32'
    ? 'win32'
    : process.platform
  return getPlatformCapabilities(platform)
})

ipcMain.handle('sessions:loadAll', async () => {
  try {
  const sessions = filterExcludedSources(await loadAllSessions())
  cachedSessions = sessions
  scheduleSearchIndexWarmup()
  void scheduleUsageFactSync()
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

  // Sync library in background (non-blocking). During first-run onboarding the
  // library init waits until the user has chosen a vault location.
  if (!libraryInitialized && !isOnboardingNeeded()) {
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
    const safeFilePath = assertSessionSourcePath(filePath)
    const safeAllPaths = allFilePaths?.map(assertSessionSourcePath)
    const safeParentPaths = branchParentFilePaths?.map(assertSessionSourcePath)
    const detail = await loadSessionDetail(safeFilePath, safeAllPaths, safeParentPaths, branchPointUuid, branchLeafUuid)
    // Electron's structured clone of thousands of nested message objects can
    // monopolize the renderer thread. One JSON string crosses IPC cheaply; the
    // preload restores the existing object-shaped API in a single parse.
    return JSON.stringify(toRendererSessionDetail(detail))
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

function currentSearchSources(): Array<{
  filePath: string
  sessionId?: string
  source?: string
  isLibraryBackup?: boolean
  loadRaw?: () => Promise<import('./types').RawJsonlMessage[]>
}> {
  const files = findAllSessionFiles().filter((filePath) => !filePath.includes('/subagents/'))
  const physicalSources = filterVisibleSearchSources(files.map((filePath) => {
    const source = detectSessionSourceFromPath(filePath) || undefined
    return {
      filePath,
      source,
      ...(source === 'codex' ? { loadRaw: () => loadCodexRawMessages(filePath) } : {})
    }
  }), cachedSessions)
  return [
    ...physicalSources,
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

function currentSettingsPreferences(): Record<string, unknown> {
  try {
    const preferences = shouldReadLibraryConfig()
      ? loadLibraryConfig().preferences as unknown as Record<string, unknown>
      : loadConfig().preferences as unknown as Record<string, unknown>
    return migrateSettingsPreferences(preferences)
  } catch {
    return migrateSettingsPreferences()
  }
}

function openInTerminal(command: string): void {
  if (process.platform === 'win32') {
    throw new Error('Windows Alpha 只允许结构化 Resume，不执行原始 shell 命令')
  }
  const preferences = currentSettingsPreferences()
  const settings = normalizeResumeTerminalSettings(preferences)
  settings.terminalExecutable = peekDetectedTerminals()
    .find((terminal) => terminal.id === settings.defaultTerminalId && terminal.canRunCommand)
    ?.executable
  openResumeTerminal(command, settings)
}

async function openResumeAction(action: ResumeLaunchAction): Promise<void> {
  if (action.kind === 'terminal' || action.kind === 'remote-control') {
    if (process.platform === 'win32') {
      await openResumeLaunchSpec(
        action.launchSpec,
        normalizeResumeTerminalSettings(currentSettingsPreferences(), 'win32')
      )
      return
    }
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

  if (process.platform === 'darwin' || process.platform === 'win32') {
    let handler = ''
    try {
      handler = app.getApplicationNameForProtocol(action.url)
    } catch {
      handler = ''
    }
    if (process.platform === 'darwin' && !handler && protocol === 'zcode:') {
      const zcodeAppPath = '/Applications/ZCode.app'
      if (fs.existsSync(zcodeAppPath)) {
        const error = await shell.openPath(zcodeAppPath)
        if (error) throw new Error(`无法打开 ZCode App：${error}`)
        return
      }
    }
    assertRegisteredResumeProtocol(protocol, handler, process.platform)
  }

  await shell.openExternal(action.url)
}

function experimentalClaudeDesktopImportEnabled(): boolean {
  return currentSettingsPreferences().experimentalClaudeDesktopImport === true
}

function defaultResumeSurfaceForSession(sessionId: string): ResumeSurface {
  const session = cachedSessions.find((candidate) =>
    candidate.id === sessionId ||
    candidate.sessionId === sessionId ||
    candidate.resumeSessionId === sessionId ||
    (candidate.continuationSessionIds || []).includes(sessionId)
  )
  const preferred = defaultResumeMethodForSource(
    currentSettingsPreferences(),
    session?.source
  ) as ResumeSurface
  if (process.platform !== 'win32') return preferred
  return session?.source === 'codex' && preferred === 'codex-desktop'
    ? 'codex-desktop'
    : 'terminal'
}

ipcMain.handle('resume:listTargetInstances', () => {
  return buildClaudeRecoveryInventory(runtimeHome()).map((instance) => ({
    id: instance.id,
    kind: instance.kind,
    available: instance.available,
    trusted: instance.trusted
  }))
})

ipcMain.handle(
  'terminal:resume',
  async (
    _event,
    sessionId: string,
    _terminalApp: string,
    permissionMode?: string,
    cwd?: string,
    surface?: ResumeSurface,
    preferredTargetInstanceId?: string
  ) => {
    assertResumeCwd(sessionId, cwd)
    const effectiveSurface = surface || defaultResumeSurfaceForSession(sessionId)
    return openGuardedResumeAction({
      sessionId,
      sessions: cachedSessions,
      permissionMode,
      cwd,
      surface: effectiveSurface,
      allowExperimentalClaudeDesktop: experimentalClaudeDesktopImportEnabled(),
      preferredTargetInstanceId,
      reloadSessions: reloadSessionsForAction,
      openAction: openResumeAction
    })
  }
)

ipcMain.handle(
  'terminal:resumeBatch',
  async (_event, sessionIds: Array<{
    sessionId: string
    permissionMode?: string
    cwd?: string
    preferredTargetInstanceId?: string
  }>, _terminalApp: string) => {
    const results: ResumeActionResult[] = []
    for (const s of sessionIds) {
      assertResumeCwd(s.sessionId, s.cwd)
      results.push(await openGuardedResumeAction({
        sessionId: s.sessionId,
        sessions: cachedSessions,
        permissionMode: s.permissionMode,
        cwd: s.cwd,
        surface: 'terminal',
        preferredTargetInstanceId: s.preferredTargetInstanceId,
        reloadSessions: reloadSessionsForAction,
        openAction: openResumeAction
      }))
    }
    return results
  }
)

ipcMain.handle(
  'terminal:fork',
  async (
    _event,
    sessionId: string,
    _terminalApp: string,
    permissionMode?: string,
    cwd?: string,
    preferredTargetInstanceId?: string
  ) => {
    assertResumeCwd(sessionId, cwd)
    return openGuardedForkAction({
      sessionId,
      sessions: cachedSessions,
      permissionMode,
      cwd,
      preferredTargetInstanceId,
      reloadSessions: reloadSessionsForAction,
      openAction: openResumeAction
    })
  }
)

ipcMain.handle(
  'terminal:buildResumeCommand',
  async (_event, sessionId: string, permissionMode?: string, cwd?: string) => {
    assertResumeCwd(sessionId, cwd)
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
  const folders = currentAnalysisFolders()
  const sessionTimes = new Map<string, number>()
  for (const s of sessions) {
    if (s.estimatedTime) sessionTimes.set(s.sessionId, s.estimatedTime)
  }
  return buildInsights(sessions, folders, sessionTimes)
})

ipcMain.handle(
  'insights:query',
  async (_event, scope: AnalysisScope, dimension: AnalysisDimension) => {
    await ensureUsageFactsReady()
    return queryInsights(scope, dimension)
  }
)

ipcMain.handle(
  'insights:drilldown',
  async (_event, scope: AnalysisScope, dimension: AnalysisDimension, key: string) => {
    await ensureUsageFactsReady()
    return drilldownInsights(scope, dimension, key)
  }
)

ipcMain.handle(
  'insights:sessionEvents',
  async (_event, sessionId: string, scope: AnalysisScope) => {
    await ensureUsageFactsReady()
    return sessionUsageEvents(sessionId, scope)
  }
)

ipcMain.handle('insights:rebuildFacts', () => scheduleUsageFactSync({ rebuild: true }))

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
  const safeFilePath = assertSessionSourcePath(filePath)
  try {
    const { parseSessionFile } = await import('./session-loader')
    const { buildExecutionTree } = await import('./execution-tree')
    const cached = cachedSessions.find((session) =>
      session.filePath === safeFilePath || session.allFilePaths?.includes(safeFilePath)
    )
    const sessionId = cached?.sessionId || path.basename(safeFilePath, '.jsonl')
    const messages = cached?.source === 'codex'
      ? await loadCodexRawMessages(safeFilePath, sessionId)
      : await parseSessionFile(safeFilePath)
    return buildExecutionTree(messages, sessionId, cached?.subagents || [])
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
        const llmSettings = await getLlmSettingsWithSecret()
        if (!llmSettings) {
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
    const settings = await getLlmSettingsWithSecret()
    return settings ? await listModels(settings) : []
  } catch {
    return []
  }
})

ipcMain.handle('insights:getLlmSettings', async () => {
  try {
    return await getLlmSettingsForDisplay()
  } catch {
    return { provider: 'anthropic', hasKey: false, keyHint: '', model: '', baseUrl: '' }
  }
})

ipcMain.handle('insights:setLlmSettings', async (_event, settings: { provider: string; credential?: string; model?: string; baseUrl?: string }) => {
  try {
    await persistLlmSettings({
      provider: settings.provider,
      value: settings.credential,
      model: settings.model?.trim() || '',
      baseUrl: settings.baseUrl?.trim() || ''
    })
    return true
  } catch {
    return false
  }
})

// LLM Profile secrets are accepted on save but are never returned to renderer IPC.
ipcMain.handle('llm:listProfiles', () => listLlmProfiles())
ipcMain.handle('llm:saveProfile', (_event, input: SaveLlmProfileInput) => saveLlmProfile(input))
ipcMain.handle('llm:deleteProfile', (_event, profileId: string) => deleteLlmProfile(profileId))
ipcMain.handle('llm:getBindings', () => getSmartFeatureBindings())
ipcMain.handle('llm:setBindings', (_event, bindings: SmartFeatureBinding) => setSmartFeatureBindings(bindings))

ipcMain.handle('session:audit', async (_event, filePath: string) => {
  const safeFilePath = assertSessionSourcePath(filePath)
  try {
    const { parseSessionFile } = await import('./session-loader')
    const { auditSession } = await import('./session-audit')
    const messages = await parseSessionFile(safeFilePath)
    const sessionId = path.basename(safeFilePath, '.jsonl')
    const session = cachedSessions.find((candidate) =>
      candidate.filePath === safeFilePath || candidate.allFilePaths?.includes(safeFilePath)
    )
    return auditSession(messages, sessionId, session?.tokenAccounting)
  } catch {
    return null
  }
})

ipcMain.handle('session:getContextInspector', async (_event, filePath: string) => {
  const safeFilePath = assertSessionSourcePath(filePath)
  try {
    const { parseSessionFile } = await import('./session-loader')
    const { buildContextInspector } = await import('./context-inspector')
    const messages = await parseSessionFile(safeFilePath)
    const sessionId = path.basename(safeFilePath, '.jsonl')
    return buildContextInspector(messages, sessionId)
  } catch {
    return null
  }
})

// --- Config / Library IPC ---
// These use the library manager but return the same shape the frontend expects

ipcMain.handle('config:load', () => {
  let config
  if (!shouldReadLibraryConfig() || !latestLibraryTree) {
    // Fallback to old config during initial load
    config = loadConfig()
  } else {
    config = libraryTreeToConfig(latestLibraryTree)
  }
  return { ...config, preferences: migrateSettingsPreferences(config.preferences as unknown as Record<string, unknown>) }
})

ipcMain.handle('config:save', (_event, config: { preferences: Record<string, unknown> }) => {
  const migratedPreferences = migrateSettingsPreferences(config.preferences)
  const migratedConfig = { ...config, preferences: migratedPreferences }
  if (libraryInitialized) {
    const libConfig = loadLibraryConfig()
    libConfig.preferences = migratedPreferences as any
    saveLibraryConfig(libConfig)
  } else {
    saveConfig(migratedConfig as any)
  }
  autoUpdater.allowPrerelease = migratedPreferences.updateChannel === 'development'
  // If spotlight shortcut changed, re-register it
  const shortcut = (migratedPreferences.spotlightShortcut as string) || DEFAULT_SPOTLIGHT_SHORTCUT
  if (shortcut !== currentSpotlightShortcut) {
    registerSpotlightShortcut(shortcut)
  }
  return migratedConfig
})

ipcMain.handle('settings:getDetectedTerminals', (_event, force = false) => getDetectedTerminals(force === true))
ipcMain.handle('settings:getAppInfo', () => ({ version: app.getVersion(), platform: process.platform }))

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
  async (_event, sessionId: string, meta: {
    customTitle?: string
    notes?: string
    highlights?: Highlight[]
    tags?: string[]
    topic?: string
    topicConfidence?: number
  }) => {
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

async function refreshAfterOrganization(): Promise<ReturnType<typeof libraryTreeToConfig>> {
  const tree = await requestLibraryScan(false)
  for (const session of cachedSessions) annotateSessionForFrontend(session)
  emitLibraryPatch(cachedSessions, tree)
  return libraryTreeToConfig(tree)
}

ipcMain.handle('organizer:previewProject', () => {
  const config = latestLibraryTree ? libraryTreeToConfig(latestLibraryTree) : loadConfig()
  return buildProjectOrganizationPreview(getLibraryRoot(), cachedSessions
    .filter((session) => !session.id.includes(':intra-') && !session.id.includes(':branch-'))
    .map((session) => ({
      ...session,
      firstUserMessage: config.sessionMeta[session.sessionId]?.customTitle || session.firstUserMessage,
      libraryDirPath: getSessionDirPath(session.sessionId) || undefined
    })))
})

ipcMain.handle('organizer:previewSmart', async () => {
  const settings = await resolveProfileForFeature('smartOrganize')

  const config = latestLibraryTree ? libraryTreeToConfig(latestLibraryTree) : loadConfig()
  const candidates = cachedSessions.filter((session) => {
    if (session.id.includes(':intra-') || session.id.includes(':branch-')) return false
    if (!getSessionDirPath(session.sessionId)) return false
    return !config.sessionMeta[session.sessionId]?.topic
  })
  const suggestions = await requestSmartOrganization(
    settings as Parameters<typeof requestSmartOrganization>[0],
    candidates.map((session) => ({
      sessionId: session.sessionId,
      title: config.sessionMeta[session.sessionId]?.customTitle || session.firstUserMessage || session.id,
      summary: session.firstUserMessage || ''
    })),
    config.folders.map((folder) => folder.id)
  )
  const byId = new Map(candidates.map((session) => [session.sessionId, session]))
  return suggestions.map((suggestion) => ({
    ...suggestion,
    title: config.sessionMeta[suggestion.sessionId]?.customTitle ||
      byId.get(suggestion.sessionId)?.firstUserMessage || suggestion.sessionId
  }))
})

ipcMain.handle('organizer:apply', async (_event, kind: OrganizationKind, items: Array<{
  sessionId: string
  targetRelativeFolder: string
  topic?: string
  tags?: string[]
  confidence?: number
}>) => {
  if (!['project', 'smart', 'archive'].includes(kind)) throw new Error('不支持的整理类型')
  const inputs: OrganizationInput[] = items.map((item) => {
    const sourceDir = getSessionDirPath(item.sessionId)
    if (!sourceDir) throw new Error(`会话不在当前 Vault：${item.sessionId}`)
    return {
      sessionId: item.sessionId,
      sourceDir,
      targetRelativeFolder: item.targetRelativeFolder,
      metaPatch: kind === 'smart' ? {
        topic: item.topic,
        tags: item.tags,
        topicConfidence: item.confidence
      } : undefined
    }
  })
  const result = executeOrganization(getLibraryRoot(), kind, inputs)
  const config = await refreshAfterOrganization()
  return { ...result, config }
})

ipcMain.handle('organizer:undo', async () => {
  const result = undoLastOrganization(getLibraryRoot())
  const config = await refreshAfterOrganization()
  return { ...result, config }
})

async function loadSmartRenameCandidates(sessionIds: readonly string[]): Promise<SmartRenameCandidate[]> {
  const config = latestLibraryTree ? libraryTreeToConfig(latestLibraryTree) : loadConfig()
  const candidates: SmartRenameCandidate[] = []
  for (const sessionId of sessionIds) {
    const session = cachedSessions.find((item) =>
      !item.id.includes(':intra-') && !item.id.includes(':branch-') &&
      (item.sessionId === sessionId || item.id === sessionId)
    )
    if (!session || !getSessionDirPath(session.sessionId)) continue
    let conversationSummary = session.allUserMessages || ''
    try {
      const detail = await loadSessionDetail(
        session.filePath,
        session.allFilePaths,
        session.branchParentFilePaths,
        session.branchPointUuid,
        session.branchLeafUuid
      )
      if (detail) {
        conversationSummary = detail.messages
          .filter((message) =>
            (message.type === 'assistant' && Boolean(message.textContent.trim())) ||
            (message.type === 'user' && message.origin === 'human' && !message.isSystemGenerated)
          )
          .slice(0, 8)
          .map((message) => `${message.type === 'user' ? '用户' : '助手'}：${message.textContent.trim()}`)
          .join('\n')
      }
    } catch { /* summary fallback is sufficient for rename */ }
    candidates.push({
      id: session.sessionId,
      oldTitle: config.sessionMeta[session.sessionId]?.customTitle || session.firstUserMessage || session.sessionId,
      firstUserMessage: session.firstUserMessage || '',
      conversationSummary
    })
  }
  return candidates
}

function createSmartRenameService(): SmartRenameService {
  return new SmartRenameService({
    resolveProfile: () => resolveProfileForFeature('smartRename'),
    loadCandidates: loadSmartRenameCandidates,
    setCustomTitle: (sessionId, title) => {
      const exists = cachedSessions.some((session) => session.sessionId === sessionId) &&
        Boolean(getSessionDirPath(sessionId))
      if (!exists) throw new Error('session-not-found')
      setSessionMetaInLibrary(sessionId, { customTitle: title })
    }
  })
}

ipcMain.handle('smartRename:preview', async (_event, sessionIds: string[]) => {
  try {
    return { ok: true as const, items: await createSmartRenameService().preview(sessionIds) }
  } catch (error) {
    return { ok: false as const, error: serializeSmartRenameError(error) }
  }
})

ipcMain.handle('smartRename:apply', async (_event, items: SmartRenameApplyItem[]) => {
  try {
    const applied = await createSmartRenameService().apply(items)
    const config = await refreshAfterOrganization()
    return { ok: true as const, items: applied, config }
  } catch (error) {
    return { ok: false as const, error: serializeSmartRenameError(error) }
  }
})

// --- Native Context Menu ---

ipcMain.handle(
  'context-menu:session',
  async (event, data: {
    sessionId: string
    canResume?: boolean
    resumeUnavailableReason?: string
    folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }>
  }) => {
    const smartRename = await getSmartFeatureAvailability('smartRename')
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
        {
          label: smartRename.enabled
            ? '智能重命名'
            : `智能重命名（${smartRename.reason || '未绑定 Profile'}）`,
          enabled: smartRename.enabled,
          click: () => resolve({ action: 'smartRename' })
        },
      ]

      const removeItems = data.folders.filter(f => f.isIn)

      if (removeItems.length > 0) {
        template.push({ type: 'separator' })
        for (const f of removeItems) {
          template.push({
            label: `移出「${f.name}」(回到根目录)`,
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
  return isLibraryInitialized(assertApprovedLibraryRoot(rootPath))
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
  const approved = approveLibraryRoot(result.filePaths[0])
  onboardingEstimateTargetPath = approved
  return approved
})

async function activateLibraryAt(newPath: string): Promise<string> {
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
  // An empty vault writes no config on scan; persist the marker so the root
  // counts as initialized on the next launch.
  if (!isLibraryInitialized(getLibraryRoot())) {
    saveLibraryConfig(loadLibraryConfig())
  }
  adoptLibraryTree(tree)
  await hydrateLibrarySessions(tree)
  return getLibraryRoot()
}

ipcMain.handle('library:changePath', async (_event, newPath: string) => {
  return activateLibraryAt(assertApprovedLibraryRoot(newPath))
})

// --- Vault migration ---

let vaultMigrationRunning = false

ipcMain.handle('vault:migrate', async (_event, targetPath: string) => {
  if (vaultMigrationRunning) return { ok: false, error: '已有迁移在进行中' }
  if (typeof targetPath !== 'string' || !targetPath.trim()) return { ok: false, error: '目标位置无效' }
  let approvedTarget: string
  try {
    approvedTarget = assertApprovedLibraryRoot(targetPath)
  } catch {
    return { ok: false, error: '目标位置未经目录选择器确认' }
  }
  vaultMigrationRunning = true
  try {
    const sourceRoot = getLibraryRoot()
    const { migrateVault } = await import('./vault-migrator')
    const result = migrateVault(sourceRoot, approvedTarget, (progress) => {
      mainWindow?.webContents.send('vault:migrateProgress', progress)
    })
    if (!result.ok) return result
    // Copy verified — point the app at the new home and reindex.
    await activateLibraryAt(approvedTarget)
    return { ...result, newRoot: getLibraryRoot() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    vaultMigrationRunning = false
  }
})

ipcMain.handle('vault:selectMigrationTarget', async () => {
  if (!mainWindow) return null
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '选择迁移目标位置（须为空文件夹）',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '迁移到这里'
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return approveLibraryRoot(result.filePaths[0])
})

// --- First-run onboarding ---

ipcMain.handle('onboarding:getState', () => {
  onboardingEstimateTargetPath ||= getDefaultLibraryRoot()
  return {
    needed: isOnboardingNeeded(),
    defaultPath: getDefaultLibraryRoot(),
    excludedSources: getExcludedSources()
  }
})

ipcMain.handle('onboarding:estimateBackupSize', (_event, excludedSources: string[]) => {
  const excluded = Array.isArray(excludedSources)
    ? excludedSources.filter((item) => typeof item === 'string')
    : []
  return onboardingBackupSizeEstimator.estimate({
    sessions: cachedSessions,
    excludedSources: excluded,
    targetPath: onboardingEstimateTargetPath || getDefaultLibraryRoot()
  })
})

ipcMain.handle('onboarding:complete', async (_event, libraryPath: string, excludedSources: string[]) => {
  const requested = typeof libraryPath === 'string' && libraryPath.trim() ? libraryPath : getDefaultLibraryRoot()
  // The main-process default root is trusted by construction; any other path
  // must have come through the directory picker (which registers approval).
  let targetPath: string
  if (path.resolve(requested) === path.resolve(getDefaultLibraryRoot())) {
    fs.mkdirSync(requested, { recursive: true })
    targetPath = approveLibraryRoot(requested)
  } else {
    targetPath = assertApprovedLibraryRoot(requested)
  }
  const excluded = Array.isArray(excludedSources) ? excludedSources.filter((item) => typeof item === 'string') : []
  // Active transcripts may have grown while the user was reading onboarding.
  // Force the same estimator used by the preview to refresh at the commit boundary.
  onboardingBackupSizeEstimator.estimate({
    sessions: cachedSessions,
    excludedSources: excluded,
    targetPath,
    forceRefresh: true
  })
  completeOnboarding(targetPath, excluded)
  cachedSessions = filterExcludedSources(cachedSessions)
  const root = await activateLibraryAt(targetPath)
  mainWindow?.webContents.send('sessions:updated', cachedSessions)
  return root
})

ipcMain.handle('onboarding:setExcludedSources', (_event, excludedSources: string[]) => {
  const excluded = Array.isArray(excludedSources) ? excludedSources.filter((item) => typeof item === 'string') : []
  setExcludedSources(excluded)
  cachedSessions = filterExcludedSources(cachedSessions)
  return excluded
})

/**
 * Claude Code deletes session history after cleanupPeriodDays (default 30).
 * With explicit user consent we extend it to 10 years via ~/.claude/settings.json.
 */
ipcMain.handle('onboarding:extendClaudeRetention', () => {
  const settingsPath = join(require('os').homedir(), '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    } else {
      return { ok: false, error: 'settings.json 格式异常，未修改' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: '无法读取 ~/.claude/settings.json，未修改' }
    }
  }
  settings.cleanupPeriodDays = 3650
  try {
    fs.mkdirSync(join(require('os').homedir(), '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    return { ok: true }
  } catch {
    return { ok: false, error: '写入 ~/.claude/settings.json 失败' }
  }
})

// --- File Operations ---

ipcMain.handle('session:saveMarkdown', async (_event, dirPath: string, filename: string, content: string) => {
  const safeDir = assertPathWithinAllowedRoots(dirPath, [getLibraryRoot()], { mustExist: true })
  const fullPath = resolvePathWithinRoot(safeDir, filename, {
    allowRoot: false,
    allowAbsolute: false
  })
  fs.writeFileSync(fullPath, content, { encoding: 'utf-8', mode: 0o600 })
  return fullPath
})

ipcMain.handle('session:saveToTemp', (_event, filename: string, content: string) => {
  const tmpDir = join(require('os').tmpdir(), 'swob-drag')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  const fullPath = resolvePathWithinRoot(tmpDir, filename, {
    allowRoot: false,
    allowAbsolute: false
  })
  fs.writeFileSync(fullPath, content, { encoding: 'utf-8', mode: 0o600 })
  return fullPath
})

ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
  return shell.openPath(assertProjectOrLibraryPath(filePath))
})

ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
  shell.showItemInFolder(assertProjectOrLibraryPath(filePath))
})

// --- CLI Installation ---

function isCliInstalled(): boolean {
  return fs.existsSync(SWOB_APP_CLI_PATH)
}

function installCli(): { cliInstalled: boolean; skillInstalled: boolean; cliPath: string | null; cliManualInstall?: string; error?: string } {
  if (!getPlatformCapabilities().features.cliInstall) {
    return {
      cliInstalled: false,
      skillInstalled: false,
      cliPath: null,
      error: 'Windows Alpha 暂不支持 CLI 安装'
    }
  }
  const home = runtimeHome()
  const cliInstall = installSwobCli({ homeDir: home || undefined })

  // 2. Install skill
  const skillDir = join(home, '.claude', 'skills', 'swob')
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
  const skillContent = generateSkillContent()
  fs.writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

  return {
    cliInstalled: cliInstall.cliInstalled,
    skillInstalled: true,
    cliPath: cliInstall.cliPath,
    cliManualInstall: cliInstall.cliManualInstall ?? undefined
  }
}

function autoInstallCliOnStartup(): void {
  if (!getPlatformCapabilities().features.cliInstall) return
  try {
    installCli()
  } catch { /* ignore — user can manually install later */ }
}

ipcMain.handle('cli:getStatus', () => {
  const installed = isCliInstalled()
  const commandPath = findInstalledSwobCommandPath()
  const skillPath = join(runtimeHome(), '.claude', 'skills', 'swob', 'SKILL.md')
  const skillExists = fs.existsSync(skillPath)
  return {
    cliInstalled: installed,
    symlinkInstalled: commandPath !== null,
    skillInstalled: skillExists,
    cliPath: installed ? SWOB_APP_CLI_PATH : null,
    commandPath,
    skillPath: skillExists ? skillPath : null
  }
})

ipcMain.handle('cli:install', () => {
  return installCli()
})

// --- App Lifecycle ---

// --- Auto Update ---

function setupAutoUpdater(): void {
  // t107 Windows Native Alpha: unsigned internal builds do not auto-update.
  if (!getPlatformCapabilities().features.autoUpdate) return
  const preferences = currentSettingsPreferences()
  autoUpdater.allowPrerelease = preferences.updateChannel === 'development'
  configureAutoUpdater({
    updater: autoUpdater,
    ipcMain,
    sendToRenderer: (channel, ...args) => mainWindow?.webContents.send(channel, ...args),
    // The window and all startup watchers are already running before this
    // delayed, fire-and-forget request is scheduled.
    checkOnStartup: !is.dev && preferences.autoCheckUpdates !== false
  })
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.swob.app')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Only resolve/create the root synchronously. Recursive scan and batch sync run in a Worker.
  initLibrary()
  approveLibraryRoot(getLibraryRoot())
  try {
    await migrateLegacyLlmProfile()
  } catch (error) {
    console.error(
      '[llm-profiles] Keychain migration failed; plaintext config was preserved:',
      error instanceof Error ? error.message : 'unknown error'
    )
  }
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
  primeTerminalDetection()
  startFileWatcher()
  startLibraryWatcher()
  startCodexWatcher()
  startCursorWatcher()
  startActiveSessionPoller()
  void initializeLibraryScanInBackground()
  setupAutoUpdater()
  autoInstallCliOnStartup()

  logSpawnSelfTest()
  registerSpotlightShortcut(getSpotlightShortcut())
  registerAgentIpc({
    getLibraryRoot: () => {
      try { return getLibraryRoot() } catch { return null }
    },
    showMainWindow: () => showMainWindow(),
    archiveAgentSession: (sessionId: string) => {
      // The scanner needs a beat to index the fresh session before it can be
      // filed under the assistant folder; failure just leaves it in the root.
      setTimeout(() => {
        void (async () => {
          try {
            if (!getSessionDirPath(sessionId)) {
              const summary = cachedSessions.find((s) => s.sessionId === sessionId)
              if (summary) await ensureSessionInLibrary(summary)
            }
            fs.mkdirSync(path.join(getLibraryRoot(), 'Swob 助手'), { recursive: true })
            moveSessionToFolder(sessionId, 'Swob 助手')
          } catch { /* not indexed yet; session stays in vault root */ }
        })()
      }, 8000)
    }
  })
  registerAgentShortcut()
  app.on('activate', () => {
    showMainWindow()
  })
})

app.on('window-all-closed', () => {
  // macOS: don't unregister shortcuts — app stays alive and user expects Cmd+Shift+Space to work
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let quitCleanupStartedAt: number | null = null
let quitCleanupComplete = false

app.on('before-quit', (event) => {
  writeLifecycleLog('before-quit', {
    cleanupStarted: quitCleanupStartedAt !== null,
    cleanupComplete: quitCleanupComplete
  })
  if (quitCleanupComplete) return
  event.preventDefault()
  if (quitCleanupStartedAt !== null) return
  quitCleanupStartedAt = Date.now()
  void cleanupRuntimeResources().finally(() => {
    quitCleanupComplete = true
    writeLifecycleLog('cleanup-release-quit', { durationMs: Date.now() - quitCleanupStartedAt! })
    app.quit()
  })
})

app.on('will-quit', () => {
  writeLifecycleLog('will-quit', {
    durationSinceBeforeQuitMs: quitCleanupStartedAt === null ? null : Date.now() - quitCleanupStartedAt
  })
})
