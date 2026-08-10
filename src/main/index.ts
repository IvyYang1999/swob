// MUST stay the first import: rebinds defunct stdio fds before anything
// writes to console or spawns a child (see stdio-repair.ts).
import { logSpawnSelfTest } from './stdio-repair'
import { startupRuntimeSafety } from './runtime-isolation-bootstrap'
import { app, shell, BrowserWindow, ipcMain, Menu, globalShortcut, screen, dialog, clipboard, nativeImage, type WebContents } from 'electron'
import path from 'path'
const { join, dirname, relative } = path
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import { setupAutoUpdater as configureAutoUpdater } from './auto-updater'
import { startPackagedUpdateE2E } from './update-e2e-driver'
import { assertE2ELibraryPath, runtimeSafetyState } from './e2e-library-isolation'
import { registerAgentIpc, registerAgentShortcut, shutdownAgentRuntime } from './agent-window'
import { getAgentWorkspaceDir } from './agent-runner'
import { buildAgentHistory, registerFrontendIpc } from './frontend-ipc'
import { readDashboardLayout, writeDashboardLayout } from './dashboard-layout'
import {
  BUILTIN_COMMAND_IDS,
  createBuiltinCommandRegistry
} from '../shared/registry/builtin-commands'
import { parseActiveClaudeSessionIds } from '../shared/active-session-processes'
import { execFile, type ChildProcess } from 'child_process'
import { Worker } from 'node:worker_threads'
import * as fs from 'fs'
import { getLocalNetworkInfo, queryPublicIp } from './network-info'
import {
  loadAllSessions,
  loadAllSessionsWithProviderStatus,
  loadSessionDetail,
  loadSessionDetailWithFallback,
  findAllSessionFiles,
  findClaudeSessionFiles,
  buildSessionSummaryFromBackup
} from './session-loader'
import {
  beginSessionBootstrap,
  sessionSummaryForRenderer
} from './session-bootstrap'
import {
  findCodexSessionFiles,
  loadCodexRawMessages,
  refreshCodexSessionInventory,
  rememberCodexSessionFile
} from './codex-loader'
import {
  codexSessionDirectories,
  configuredCodexRoots,
  loadAdditionalCodexHomes,
  saveAdditionalCodexHomes
} from './codex-session-roots'
import { findCursorSessionFiles, loadCursorRawMessages } from './cursor-loader'
import {
  initLibrary,
  applyLibraryTree,
  libraryTreeToConfig,
  loadLibraryConfig,
  saveLibraryConfig,
  updateLibraryPreferencesAsync,
  ensureSessionInLibrary,
  updateTranscript,
  syncBackup,
  getSessionMdPath,
  getSessionDirPath,
  getImmediateSessionResumeAvailability,
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
  migrateLegacyDetailAvailability,
  collapseLibrarySessionsByLogicalKey,
  applyLibraryOrganization,
  undoLastLibraryOrganization,
  recoverInterruptedLibraryOrganization,
  closeLibraryWriterRuntime,
  withLibraryMaintenanceWriter,
  getLibrarySessionRegistryDiagnostics,
  getSessionFreshness,
  getStaleSessions,
  getStaleSessionsFromTree,
  type LibrarySession,
  type LibraryTree,
  type LibrarySyncOutcome
} from './library-manager'
import { mergeSettingsPreferencePatch, resolveRendererConfig } from './settings-config'
import {
  getLibraryHealth,
  getLibraryHealthRevision,
  beginLibraryBackgroundSync,
  transitionLibraryHealth,
  transitionWriterCapability,
  transitionActiveSourceFreshness,
  updateLibraryBackgroundProgress,
  updateLibraryBackgroundRecovery,
  finishLibraryBackgroundSync,
  updateLibraryIdentityExceptions,
  updateLibraryUnverifiableBuckets,
  createEmptyUnverifiableBuckets,
  classifyUnverifiableReason,
  computeSessionFreshness,
  healthAfterSuccessfulLibraryWrite,
  freshnessDiagnosticFingerprint,
  classifyLibraryError,
  recordLibraryDiagnostic,
  onLibraryHealthChanged,
  onLibraryDiagnostic,
  getCompensationProgress,
  onCompensationUpdate,
  runCompensation,
  retryCompensation,
  cancelCompensation,
  closeCompensation,
  enqueueCompensation,
  waitForCompensationIdle,
  configureLibraryHealthPersistence,
  clearLibraryHealthPersistence,
  resetLibraryHealth,
  updateLibraryWriterRecovery,
  type LibraryHealthSnapshot,
  type SessionFreshness,
  type CompensationProgress
} from './library-health'
import { advanceLibraryWriterArbiterEpoch } from './library-writer-lease'
import { loadConfig, saveConfig } from './config-store'
import {
  DuplicateRecoveryPlanExpiredError,
  type DuplicateRecoveryReport
} from './duplicate-recovery-planner'
import {
  DuplicateRecoveryMutationIncompleteError,
  executeDuplicateRecoveryPlan,
  recoverInterruptedDuplicateRecoveryTransactions
} from './duplicate-recovery-executor'
import type {
  DuplicateRecoveryApplyResult,
  DuplicateRecoveryProgress,
  DuplicateRecoverySummary
} from '../shared/duplicate-recovery-contract'
import {
  readDuplicateRecoverySummaryCache,
  writeDuplicateRecoverySummaryCache
} from './duplicate-recovery-summary-cache'
import { duplicateRecoveryErrorCode } from './duplicate-recovery-failure-code'
import { spotlightSearch } from './spotlight-search'
import { filterVisibleSearchSources, searchIndexedSessions } from './session-search'
import { detectSessionSourceFromPath } from './session-source'
import { providerUsesCanonicalRuntime } from '../shared/provider-capabilities'
import { closeSearchIndex } from './search-index'
import {
  closeSearchIndexWriteCoordinator,
  getSearchIndexWriteCoordinator,
  LARGE_SEARCH_WORKER_RECYCLE_BYTES
} from './search-index-writer'
import {
  cancelCanonicalProviders,
  withCanonicalProviderRefreshBarrier
} from './provider-runtime'
import { closeCanonicalSessionStore } from './canonical-store'
import { buildInsights } from './insights'
import {
  drilldownInsights,
  closeUsageFactStore,
  hasCompletedUsageFactSnapshot,
  initializeUsageFactStore,
  queryInsights,
  queryInsightsBundle,
  sessionUsageEvents
} from './usage-fact-store'
import { LatestSnapshotRunner } from './latest-snapshot-runner'
import { ReportJobManager, type ReportJobRunner } from './report-job-manager'
import { TranscriptWatcher, scanActiveTranscriptSourcesFromTree } from './transcript-watcher'
import { LibraryWorkerClient } from './library-worker'
import {
  LibraryStartupSyncInterruptedError,
  LibraryStartupBatchTransportError,
  runLibraryStartupTransaction,
  syncLibraryStartupIncrementally,
  type LibraryStartupProgress,
  type LibraryStartupRecoverySummary
} from './library-startup-sync'
import { summarizeLibraryIdentityHealth } from './library-session-registry'
import { SessionSyncCoordinator, type SessionSyncRequest } from './session-sync-coordinator'
import { LibraryRescanController } from './library-rescan-controller'
import { scheduleEpochBoundTask } from './epoch-bound-task'
import { WorkerRecycleGate } from './worker-recycle-gate'
import { mergeLiveSessionSummary } from './live-session-summary'
import { StartupProjectionGate } from './startup-projection-gate'
import {
  LibraryBacklogRecoveryQueue,
  libraryBacklogBatchFailurePolicy,
  libraryBacklogGlobalRetryDelay,
  libraryBacklogRecoveredHealthState,
  libraryBacklogWakeDisposition,
  shouldSelectLibraryBacklogItem
} from './library-backlog-recovery-queue'
import { boundedQuietWindowDelay } from './bounded-quiet-window'
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
  type OrganizationKind
} from './vault-organizer'
import { requestSmartOrganization } from './smart-organizer'
import { addSessionCoverage, collectSessionCoverage } from './session-coverage'
import { toRendererSessionDetail, toRendererSessionDetailLoadResult } from './renderer-session-detail'
import { assertPathWithinAllowedRoots, resolvePathWithinRoot } from './path-containment'
import { onboardingBackupSizeEstimator } from './onboarding-backup-size'
import { registerSwobLensIpc } from './swoblens-ipc'
import { recoverSwobLensTransactions } from './swoblens-installer'
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
  LlmProfileError,
  type SaveLlmProfileInput,
  type SmartFeatureBinding
} from './llm-profiles'
import type { OrganizerSmartPreviewResult } from '../shared/frontend-ipc-contract'
import type {
  ReportJobStartRequest,
  ReportJobStatusRequest,
  ReportJobType
} from '../shared/report-jobs'
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
  resolveConfiguredLocale,
  resolveSystemLocale,
  translate,
  type Locale
} from '../shared/i18n'
import {
  buildGuardedResumeCommand,
  openGuardedForkAction,
  openGuardedResumeAction,
  type ResumeActionResult
} from './resume-guard'
import type { ResumeLaunchAction, ResumeSurface } from './session-actions'
import {
  shouldAutoInstallCli,
  findInstalledSwobCommandPath,
  installSwobCli,
  SWOB_APP_CLI_PATH
} from './cli-install'
import {
  type SessionLineageRegistry,
  getSessionLineagePath,
  rebuildSessionLineageRegistry,
  resolveSessionSuccessor,
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
import { preferredSystemLanguagesForRuntime } from './runtime-locale'

let mainWindow: BrowserWindow | null = null
let spotlightWindow: BrowserWindow | null = null
// Keep the historical default: the experiment only changes this through IPC.
let spotlightNativeShadow = false
let watcher: SourceDirectoryWatcher | null = null
let codexWatcher: SourceDirectoryWatcher | null = null
let cursorWatcher: SourceDirectoryWatcher | null = null

function mainLocale(): Locale {
  const systemLocale = resolveSystemLocale(
    preferredSystemLanguagesForRuntime(app.getPreferredSystemLanguages())
  )
  try {
    return resolveConfiguredLocale(currentSettingsPreferences().locale, systemLocale)
  } catch {
    return systemLocale
  }
}

function mainT(key: string, params?: Record<string, string | number>): string {
  return translate(mainLocale(), key, params)
}
let libraryWatcher: LibraryDirectoryWatcher | null = null
let transcriptWatcher: TranscriptWatcher | null = null
let libraryWorker: LibraryWorkerClient | null = null
let liveSessionSyncWorker: LibraryWorkerClient | null = null
const liveSessionSyncWorkerRecycleGate = new WorkerRecycleGate()
let usageFactWorker: LibraryWorkerClient | null = null
let sessionSyncCoordinator: SessionSyncCoordinator | null = null
let libraryRescanController: LibraryRescanController | null = null
let pendingSpotlightNavigationSessionId: string | null = null
const knownSessionIds = new Set<string>()
let libraryInitialized = false
let latestLibraryTree: LibraryTree | null = null
let libraryInitializationPromise: Promise<void> | null = null
let latestProviderSettlementStatus: 'complete' | 'degraded' | null = null
let libraryHydrationGeneration = 0
let libraryHydrationActive = 0
let usageFactSyncError: unknown = null
interface UsageFactSyncSnapshot {
  sessions: SessionSummary[]
  folders: Folder[]
  rebuild: boolean
}
let usageFactSyncRunner: LatestSnapshotRunner<UsageFactSyncSnapshot, UsageFactSyncResult> | null = null
const startupProjectionGate = new StartupProjectionGate<UsageFactSyncResult>()
let runtimeShuttingDown = false
let libraryRuntimeEpoch = 0
let libraryRuntimePaused = false
let libraryStartupWriterProven = false
let libraryStartupChunkActive = false
let libraryBacklogRecoveryTimer: NodeJS.Timeout | null = null
let libraryBacklogGlobalRecoveryTimer: NodeJS.Timeout | null = null
let libraryBacklogGlobalRecoveryAttempts = 0
type LibraryGlobalRecoveryOperation =
  | { kind: 'initial' }
  | { kind: 'backlog'; mode: Exclude<LibraryBacklogRecoveryMode, 'initial'> }
  | { kind: 'refresh' }
let libraryBacklogGlobalRecoveryFault: {
  errorCode: string
  healthRevision: number
  operation: LibraryGlobalRecoveryOperation
} | null = null
let libraryBacklogSafetyStopEpoch: number | null = null
let libraryBacklogGlobalRecoveryExhaustedEpoch: number | null = null
let libraryBacklogRecoveryPromise: Promise<void> | null = null
const libraryBacklogRecoveryQueue = new LibraryBacklogRecoveryQueue()
let liveLibraryCommitGeneration = 0
let freshnessErrorSignature = ''
let freshnessMonitor: NodeJS.Timeout | null = null
const deferredLibrarySyncRequests = new Map<string, SessionSyncRequest>()
const LIBRARY_WRITER_RECOVERY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000] as const
const LIBRARY_WRITER_RECOVERY_STEADY_DELAY_MS = 30_000
const LIBRARY_WRITER_RECOVERY_JITTER_MS = 5_000
let libraryWriterRecoveryTimer: NodeJS.Timeout | null = null
let libraryWriterRecoveryAttempts = 0
let libraryWriterRecoveryPromise: Promise<void> | null = null
let activeDuplicateRecoveryAnalysis: {
  libraryRoot: string
  quarantineRoot: string
  writeGeneration: number
  worker: Worker
  reject: (error: Error) => void
  promise: Promise<DuplicateRecoveryReport>
} | null = null
let preparedDuplicateRecovery: {
  libraryRoot: string
  quarantineRoot: string
  writeGeneration: number
  report: DuplicateRecoveryReport
} | null = null
let cachedDuplicateRecoveryAnalysis: {
  libraryRoot: string
  writeGeneration: number
  report: DuplicateRecoveryReport
  completedAt: string
} | null = null
let pendingAutomaticDuplicateRecoveryAnalysis: {
  epoch: number
  libraryRoot: string
  writeGeneration: number
  attempt: number
  firstRequestedAt: number
  lastRequestedAt: number
} | null = null
let automaticDuplicateRecoveryAnalysisTimer: NodeJS.Timeout | null = null
let automaticDuplicateRecoveryAnalysisScheduled = false
let automaticDuplicateRecoveryAnalysisSuppressedGeneration: string | null = null
const automaticDuplicateRecoveryAnalysisWaiters = new Map<string, Set<{
  resolve: (summary: DuplicateRecoverySummary) => void
  reject: (error: Error) => void
}>>()
let duplicateRecoveryApplyInFlight: {
  planId: string
  promise: Promise<DuplicateRecoveryApplyResult>
} | null = null

function clearLibraryWriterRecoverySchedule(): void {
  if (libraryWriterRecoveryTimer) clearTimeout(libraryWriterRecoveryTimer)
  libraryWriterRecoveryTimer = null
  const recovery = getLibraryHealth().writerRecovery
  if (recovery.nextRetryAt !== null) {
    updateLibraryWriterRecovery({ ...recovery, nextRetryAt: null })
  }
}

function resetLibraryWriterRecoveryState(preserveLastReason = true): void {
  clearLibraryWriterRecoverySchedule()
  libraryWriterRecoveryAttempts = 0
  updateLibraryWriterRecovery({
    attempt: 0,
    nextRetryAt: null,
    lastReason: preserveLastReason ? getLibraryHealth().writerRecovery.lastReason : null
  })
}

function libraryWriterRecoveryDelay(attempt: number): number {
  const staged = LIBRARY_WRITER_RECOVERY_DELAYS_MS[attempt - 1]
  if (staged !== undefined) return staged
  return LIBRARY_WRITER_RECOVERY_STEADY_DELAY_MS +
    Math.floor(Math.random() * (LIBRARY_WRITER_RECOVERY_JITTER_MS + 1))
}

function scheduleLibraryWriterRecovery(): void {
  if (
    runtimeShuttingDown ||
    libraryRuntimePaused ||
    libraryWriterRecoveryTimer ||
    getLibraryHealth().state !== 'writer-blocked'
  ) return
  const attempt = libraryWriterRecoveryAttempts + 1
  const delay = libraryWriterRecoveryDelay(attempt)
  const scheduledEpoch = libraryRuntimeEpoch
  libraryWriterRecoveryAttempts = attempt
  const writerRecovery = {
    attempt,
    nextRetryAt: new Date(Date.now() + delay).toISOString(),
    lastReason: getLibraryHealth().writerRecovery.lastReason
  }
  updateLibraryWriterRecovery(writerRecovery)
  recordLibraryDiagnostic(
    'WRITER_RECOVERY_SCHEDULED',
    `Library writer recovery attempt ${attempt} scheduled`,
    writerRecovery.lastReason || undefined,
    writerRecovery
  )
  libraryWriterRecoveryTimer = setTimeout(() => {
    libraryWriterRecoveryTimer = null
    updateLibraryWriterRecovery({
      attempt,
      nextRetryAt: null,
      lastReason: getLibraryHealth().writerRecovery.lastReason
    })
    if (
      runtimeShuttingDown ||
      libraryRuntimePaused ||
      scheduledEpoch !== libraryRuntimeEpoch ||
      getLibraryHealth().state !== 'writer-blocked'
    ) return
    void retryLibraryAfterWriterBlocked(false).catch(() => { /* next bounded retry was scheduled */ })
  }, delay)
  libraryWriterRecoveryTimer.unref?.()
}

/**
 * The only recovery path allowed to clear writer-blocked. It proves the writer
 * by rerunning full Library initialization, then drains queued compensation.
 */
async function retryLibraryAfterWriterBlocked(manual: boolean): Promise<void> {
  if (runtimeShuttingDown || libraryRuntimePaused) return
  if (manual) {
    resetLibraryWriterRecoveryState()
  }
  if (libraryWriterRecoveryPromise) {
    await libraryWriterRecoveryPromise
    if (manual && getCompensationProgress().pending > 0) {
      await retryCompensation(processLibraryCompensationEntry)
    }
    return
  }
  if (getLibraryHealth().state !== 'writer-blocked') {
    if (manual) await retryCompensation(processLibraryCompensationEntry)
    return
  }
  const recoveryEpoch = libraryRuntimeEpoch
  const attempt = Math.max(1, libraryWriterRecoveryAttempts)
  libraryWriterRecoveryAttempts = attempt
  updateLibraryWriterRecovery({
    attempt,
    nextRetryAt: null,
    lastReason: getLibraryHealth().writerRecovery.lastReason
  })
  const recovery = (async (): Promise<void> => {
    let attemptedWorker: LibraryWorkerClient | null = null
    try {
      const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
      attemptedWorker = worker
      await worker.probeWriter(getLibraryRoot())
      if (runtimeShuttingDown || libraryRuntimePaused || recoveryEpoch !== libraryRuntimeEpoch) return
      await initLibraryFromSessions(cachedSessions, { writerRecovery: true })
    } catch (error) {
      if (
        runtimeShuttingDown ||
        libraryRuntimePaused ||
        recoveryEpoch !== libraryRuntimeEpoch
      ) return
      const policy = handleLibraryGlobalFailure(
        error,
        { kind: 'initial' },
        attemptedWorker,
        'library-init'
      )
      if (policy !== 'writer-recovery') resetLibraryWriterRecoveryState()
      throw error
    }
    // Compensation has its own durable queue and diagnostics. It is not part
    // of initialization and must never relabel a ready Library as corrupt.
    resetLibraryWriterRecoveryState()
    if (manual) await retryCompensation(processLibraryCompensationEntry)
    else await runPendingLibraryCompensation()
  })()
  libraryWriterRecoveryPromise = recovery
  void recovery.finally(() => {
    if (libraryWriterRecoveryPromise === recovery) libraryWriterRecoveryPromise = null
    if (!runtimeShuttingDown && !libraryRuntimePaused &&
      getLibraryHealth().state !== 'writer-blocked' && libraryBacklogRecoveryQueue.size > 0) {
      const pendingMode = libraryBacklogRecoveryQueue.takeNext()
      if (pendingMode) queueMicrotask(() => { void runLibraryBacklogRecovery(pendingMode) })
    }
  }).catch(() => { /* the caller receives the original rejection */ })
  await libraryWriterRecoveryPromise
}

function recordCurrentFreshnessErrors(): void {
  // The periodic monitor must never rescan a large Library on Electron's main
  // thread. Reuse the last worker-built tree and perform only lightweight stats.
  if (!latestLibraryTree) return
  const freshness = getStaleSessionsFromTree(latestLibraryTree)
  const errors = freshness
    .filter((freshness) => freshness.severity === 'error')
  const signature = freshnessDiagnosticFingerprint(errors)
  if (!signature) {
    freshnessErrorSignature = ''
    return
  }
  if (signature === freshnessErrorSignature) return
  freshnessErrorSignature = signature
  recordLibraryDiagnostic(
    'SESSION_STALE_ERROR',
    `${errors.length} Library session projections exceed the five minute freshness error threshold`
  )
}
process.on('unhandledRejection', (reason) => {
  // Cooperative worker cancellation can reject a fire-and-forget chain after
  // its owner has already been stopped. That is an expected shutdown outcome,
  // not a process warning. Keep every other unhandled rejection visible.
  if (runtimeShuttingDown && reason instanceof Error && reason.name === 'AbortError') return
  console.error('[runtime] Unhandled promise rejection:', reason)
})
const reportJobManager = new ReportJobManager({ maxConcurrent: 2, cacheTtlMs: 5 * 60_000 })
reportJobManager.onUpdate((job) => {
  try { mainWindow?.webContents.send('insights:progress', job) } catch { /* window is closing */ }
})

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
      resolve(parseActiveClaudeSessionIds(stdout))
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
let currentLineageRegistry: SessionLineageRegistry | null = null
let currentLineageRegistryRoot: string | null = null
let lineageRegistryLoadPromise: Promise<SessionLineageRegistry | null> | null = null

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
    ...codexSessionDirectories(home)
  ]
  if (isSessionSourceSupported('cursor')) roots.push(join(home, '.cursor', 'projects'))
  if (isSessionSourceSupported('opencode')) roots.push(join(home, '.local', 'share', 'opencode'))
  if (isSessionSourceSupported('zcode')) roots.push(join(home, '.zcode', 'cli', 'db'))
  if (isSessionSourceSupported('pi')) roots.push(join(home, '.pi', 'agent', 'sessions'))
  if (isSessionSourceSupported('kimi')) {
    roots.push(join(home, '.kimi-code', 'sessions'))
    roots.push(join(home, '.kimi', 'sessions'))
  }
  if (isSessionSourceSupported('grok')) roots.push(join(home, '.grok', 'sessions'))
  if (isSessionSourceSupported('antigravity')) {
    roots.push(
      join(home, '.gemini', 'antigravity'),
      join(home, '.gemini', 'antigravity-cli'),
      join(home, '.gemini', 'antigravity-ide')
    )
  }
  if (isSessionSourceSupported('gemini')) roots.push(join(home, '.gemini', 'tmp'))
  if (isSessionSourceSupported('hermes')) roots.push(join(home, '.hermes', 'sessions'))
  if (isSessionSourceSupported('qoder')) roots.push(join(home, '.qoder', 'projects'))
  if (isSessionSourceSupported('trae')) {
    roots.push(
      join(home, 'Library', 'Application Support', 'Trae', 'User'),
      join(home, 'Library', 'Application Support', 'Trae CN', 'User'),
      join(home, 'Library', 'Application Support', 'TRAE SOLO CN', 'User')
    )
  }
  return roots
}

function assertSessionSourcePath(filePath: string): string {
  const hermesStateDb = join(runtimeHome(), '.hermes', 'state.db')
  if (filePath.startsWith(`${hermesStateDb}#`) && !filePath.slice(hermesStateDb.length + 1).includes(path.sep)) {
    // A sqlite-row display locator is a virtual ref. Authorize only the exact
    // state.db physical file, never the whole ~/.hermes directory.
    assertPathWithinAllowedRoots(hermesStateDb, [hermesStateDb])
    return filePath
  }
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
  assertE2ELibraryPath(canonical)
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
  if (!session.detailAvailability) session.detailAvailability = 'ready'

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

async function processLibraryCompensationEntry(sessionId: string, dirPath: string): Promise<void> {
  // Canonical providers intentionally have no backup.jsonl. Their provider-host
  // projection is repaired by the full initialization retry, not this legacy
  // transcript+backup compensation path.
  if (getSessionFreshness(sessionId)?.basis === 'canonical-records') return
  await withLibraryMaintenanceWriter(async () => {
    await updateTranscript(sessionId, undefined, dirPath)
    await syncBackup(sessionId, dirPath)
  })
}

async function runPendingLibraryCompensation(): Promise<void> {
  try {
    await runCompensation(processLibraryCompensationEntry)
  } catch (error) {
    if (!runtimeShuttingDown) console.error('[library-compensation] retry failed:', error)
  }
}

function enqueueExistingLibrarySessionsForCompensation(sessions: readonly SessionSummary[]): void {
  const entries = sessions.flatMap((session) => {
    const dirPath = getSessionDirPath(session.sessionId)
    return dirPath ? [{ sessionId: session.sessionId, dirPath }] : []
  })
  if (entries.length > 0) enqueueCompensation(entries)
}

function deferLibrarySynchronization(request: SessionSyncRequest): void {
  if (runtimeShuttingDown) return
  const key = request.filePath || request.sessionId || `${request.source}:${request.reason}`
  deferredLibrarySyncRequests.set(key, request)
}

function flushDeferredLibrarySynchronizations(): void {
  if (runtimeShuttingDown || libraryRuntimePaused) return
  const requests = [...deferredLibrarySyncRequests.values()]
  deferredLibrarySyncRequests.clear()
  for (const request of requests) scheduleSessionSynchronization(request)
}

async function performSessionSynchronization(request: SessionSyncRequest): Promise<void> {
  if (runtimeShuttingDown) return
  if (libraryRuntimePaused) {
    deferLibrarySynchronization(request)
    return
  }
  const runtimeEpoch = libraryRuntimeEpoch
  await liveSessionSyncWorkerRecycleGate.wait().catch((error) => {
    recordLibraryDiagnostic('LIVE_WORKER_RECYCLE_FAILED', 'Live worker recycle failed; creating a replacement')
    console.error('[session-sync] live worker recycle failed:', error)
  })
  if (runtimeEpoch !== libraryRuntimeEpoch || runtimeShuttingDown || libraryRuntimePaused) {
    deferLibrarySynchronization(request)
    return
  }
  const maintainLibrary = libraryInitialized || libraryStartupWriterProven
  if (!maintainLibrary || libraryStartupChunkActive) {
    // Never freeze a source event as parse-only merely because startup has not
    // finished. Startup proves and releases the writer first, and an active
    // startup chunk defers live work so the source is parsed only once after
    // the transaction boundary instead of parsing, losing the lease, then
    // parsing the same 100MB session again.
    deferLibrarySynchronization(request)
    return
  }
  const cached = cachedSummaryForSource(request.filePath, request.sessionId)
  const filePath = request.filePath || cached?.filePath
  if (!filePath) return
  const worker = liveSessionSyncWorker || (liveSessionSyncWorker = new LibraryWorkerClient())
  let synchronized: Awaited<ReturnType<LibraryWorkerClient['syncSession']>>
  try {
    synchronized = await worker.syncSession({
      root: getLibraryRoot(),
      filePath,
      sessionId: request.sessionId,
      source: request.source,
      maintainLibrary
    })
  } catch (error) {
    if (runtimeEpoch !== libraryRuntimeEpoch || runtimeShuttingDown || libraryRuntimePaused) {
      deferLibrarySynchronization(request)
      return
    }
    const classification = classifyLibraryError(error)
    const typed = error as { name?: unknown; code?: unknown } | null
    const libraryFailure = typed?.name === 'LibraryWriterBusyError' ||
      typed?.name === 'LibraryWriterIdentityUnavailableError' ||
      typed?.name === 'SessionIdentityConflictError' ||
      typed?.name === 'LibraryPathUnsafeError' ||
      ['LIBRARY_WRITER_BUSY', 'WRITER_IDENTITY_UNAVAILABLE', 'SESSION_IDENTITY_CONFLICT',
        'EACCES', 'EPERM', 'ENOSPC', 'EIO']
        .includes(typeof typed?.code === 'string' ? typed.code : '')
    if (libraryFailure) {
      transitionLibraryHealth(
        classification.state,
        classification.errorCode,
        classification.message,
        classification.writerReason
      )
    } else {
      recordLibraryDiagnostic('SESSION_SYNC_FAILED', 'A source session failed to synchronize')
    }
    if (libraryFailure && classification.state === 'writer-blocked') {
      // A successful probe is evidence about one released lease, not a
      // permanent capability. External contention invalidates startup proof;
      // retain this exact source event for the bounded full-init recovery.
      libraryStartupWriterProven = false
      deferLibrarySynchronization(request)
      const sessionId = request.sessionId || cached?.sessionId
      const dirPath = sessionId ? getSessionDirPath(sessionId) : null
      if (sessionId && dirPath) enqueueCompensation([{ sessionId, dirPath }])
      scheduleLibraryWriterRecovery()
    }
    throw error
  }
  if (runtimeEpoch !== libraryRuntimeEpoch || runtimeShuttingDown || libraryRuntimePaused) {
    deferLibrarySynchronization(request)
    return
  }
  liveLibraryCommitGeneration++
  const { summary: synchronizedSummary, dirPath } = synchronized
  const summary = mergeLiveSessionSummary(synchronizedSummary, cachedSessions)
  let largeSource = false
  try { largeSource = fs.statSync(filePath).size >= LARGE_SEARCH_WORKER_RECYCLE_BYTES } catch { /* source may vanish */ }
  if (largeSource && liveSessionSyncWorker === worker) {
    // The Library commit is durable. Terminate its parse isolate before the
    // search worker rereads the source; allocator RSS may remain at high-water.
    // A sibling live request may already be queued on this same worker, so the
    // recycle path drains accepted work instead of cancelling it.
    await liveSessionSyncWorkerRecycleGate.begin(async () => {
      try {
        await worker.retire()
      } finally {
        if (liveSessionSyncWorker === worker) liveSessionSyncWorker = null
      }
    }).catch((error) => {
      // Library is already durable. Worker teardown is lifecycle hygiene, not
      // part of the commit, so it cannot reverse success or suppress search.
      recordLibraryDiagnostic('LIVE_WORKER_RECYCLE_FAILED', 'Live worker recycle failed after a durable commit')
      console.error('[session-sync] post-commit worker recycle failed:', error)
    })
    if (runtimeEpoch !== libraryRuntimeEpoch || runtimeShuttingDown || libraryRuntimePaused) {
      deferLibrarySynchronization(request)
      return
    }
  }
  // Library/transcript/backup are already committed. Search is a rebuildable
  // projection with its own single writer and must never turn that success
  // into a failed session synchronization.
  void getSearchIndexWriteCoordinator().scheduleLegacySource({
    filePath,
    sessionId: summary.sessionId,
    source: summary.source || request.source
  }).then(notifySearchIndexUpdated).catch((error) => {
    if (!runtimeShuttingDown) console.error('[search-index] live projection delayed:', error)
  })
  if (!maintainLibrary && getLibraryHealth().state === 'writer-blocked') {
    // A parse-only worker result proves nothing about Library writability. Retry
    // the full initialization; only that writer-backed path may clear the block.
    void retryLibraryAfterWriterBlocked(false).catch((error) => {
      const classification = classifyLibraryError(error)
      console.error('[library-init] writer recovery retry failed:', classification.errorCode)
    })
  } else if (maintainLibrary && dirPath && getLibraryHealth().state === 'writer-blocked') {
    const conflictCount = getLibrarySessionRegistryDiagnostics()
      .filter((binding) => binding.state === 'conflict').length
    const recoveredState = healthAfterSuccessfulLibraryWrite('writer-blocked', true, conflictCount)
    if (recoveredState === 'identity-conflict') {
      recordLibraryDiagnostic(
        'WRITER_RECOVERED',
        'Library writer recovered; queued sessions can resume',
        getLibraryHealth().writerRecovery.lastReason || undefined
      )
      transitionLibraryHealth(
        'identity-conflict',
        'IDENTITY_CONFLICT',
        `${conflictCount} logical session identities remain read-only after writer recovery`
      )
    } else if (recoveredState === 'ready') {
      transitionLibraryHealth(
        'ready',
        'WRITER_RECOVERED',
        'Library writer recovered; replaying queued sessions',
        getLibraryHealth().writerRecovery.lastReason || undefined
      )
    }
    resetLibraryWriterRecoveryState()
    void runPendingLibraryCompensation()
  }
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
    mainWindow?.webContents.send('session:summaryUpdated', sessionSummaryForRenderer(updatedParent))
    const backlogRecovery = getLibraryHealth().dimensions.backgroundBacklog.recovery
    if (hasSourceRecoveryWork(backlogRecovery)) {
      void runLibraryBacklogRecovery('automatic')
    }
    void scheduleUsageFactSync()
    return
  }

  const existingIndex = cachedSessions.findIndex((session) => session.id === summary!.id)
  if (existingIndex >= 0) {
    cachedSessions[existingIndex] = summary
    knownSessionIds.add(summary.id)
    knownSessionIds.add(summary.sessionId)
    mainWindow?.webContents.send('session:summaryUpdated', sessionSummaryForRenderer(summary))
  } else {
    cachedSessions = [summary, ...cachedSessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    knownSessionIds.add(summary.id)
    knownSessionIds.add(summary.sessionId)
    mainWindow?.webContents.send('session:added', sessionSummaryForRenderer(summary))
  }
  // Recovery fingerprints are derived from the loader summary. Publish the
  // new summary first so a source-evidence wake cannot re-plan stale facts and
  // then go dormant until an unrelated event arrives.
  const backlogRecovery = getLibraryHealth().dimensions.backgroundBacklog.recovery
  if (hasSourceRecoveryWork(backlogRecovery)) {
    void runLibraryBacklogRecovery('automatic')
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

function notifySearchIndexUpdated(): void {
  mainWindow?.webContents.send('session:searchIndexUpdated')
}

function scheduleSearchIndexWarmupNow(): Promise<void> {
  if (runtimeShuttingDown) return Promise.resolve()
  const scheduledEpoch = libraryRuntimeEpoch
  return new Promise<void>((resolve) => {
    let started = false
    scheduleEpochBoundTask({
      epoch: scheduledEpoch,
      currentEpoch: () => libraryRuntimeEpoch,
      isPaused: () => libraryRuntimePaused,
      isStopped: () => runtimeShuttingDown,
      run: () => {
        started = true
        void getSearchIndexWriteCoordinator().scheduleLegacySnapshot(currentSearchSources())
          .then(notifySearchIndexUpdated)
          .catch((error) => {
            if (!runtimeShuttingDown) console.error('[search-index] background warmup delayed:', error)
          })
          .finally(resolve)
      }
    })
    // scheduleEpochBoundTask intentionally does not call run for a replaced or
    // paused root. Its sibling timer settles the queue item in that case.
    const skipped = setImmediate(() => { if (!started) resolve() })
    skipped.unref?.()
  })
}

function scheduleSearchIndexWarmup(): void {
  void startupProjectionGate.scheduleSearch(scheduleSearchIndexWarmupNow).catch((error) => {
    if (!runtimeShuttingDown) console.error('[search-index] queued warmup dropped:', error)
  })
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
 * Serialize fact writes in a dedicated worker. The query path only waits for
 * the current snapshot; it never parses source JSONL or performs a new scan.
 */
function scheduleUsageFactSyncNow(options: { rebuild?: boolean } = {}): Promise<UsageFactSyncResult> {
  if (runtimeShuttingDown) {
    const stopped = Promise.reject<UsageFactSyncResult>(new Error('Runtime is shutting down'))
    void stopped.catch(() => { /* shutdown intentionally refuses new background work */ })
    return stopped
  }
  if (!usageFactSyncRunner) {
    usageFactSyncRunner = new LatestSnapshotRunner({
      run: async (snapshot: UsageFactSyncSnapshot) => {
        // Establish the main-thread WAL reader and finish any schema work
        // before the worker starts its long write transaction. Subsequent
        // Insights reads can then use the last committed snapshot immediately.
        initializeUsageFactStore()
        // Usage analytics has its own queue: a first-run Library maintenance
        // pass can touch thousands of packages and must not head-of-line block
        // the committed Insights snapshot for minutes.
        const worker = usageFactWorker || (usageFactWorker = new LibraryWorkerClient())
        try {
          const result = await worker.syncUsageFacts(
            getLibraryRoot(),
            snapshot.sessions,
            snapshot.folders,
            { rebuild: snapshot.rebuild }
          )
          usageFactSyncError = null
          mainWindow?.webContents.send('insights:factsUpdated', result)
          return result
        } catch (error) {
          usageFactSyncError = error
          throw error
        }
      },
      merge: (current: UsageFactSyncSnapshot, incoming: UsageFactSyncSnapshot) => ({
        ...incoming,
        rebuild: current.rebuild || incoming.rebuild
      }),
      onError: (error) => {
        usageFactSyncError = error
        if (!runtimeShuttingDown) console.error('[usage-facts] background synchronization failed:', error)
      }
    })
  }
  const run = usageFactSyncRunner.schedule({
    sessions: [...cachedSessions],
    folders: currentAnalysisFolders(),
    rebuild: options.rebuild === true
  })
  void run.catch(() => { /* error is retained for ensureUsageFactsReady */ })
  return run
}

function scheduleUsageFactSync(options: { rebuild?: boolean } = {}): Promise<UsageFactSyncResult | undefined> {
  if (runtimeShuttingDown) return scheduleUsageFactSyncNow(options)
  const run = startupProjectionGate.scheduleUsage(options, scheduleUsageFactSyncNow)
  void run.catch(() => { /* error is retained by the runner or root-transition reset */ })
  return run
}

function openStartupProjectionGate(): void {
  startupProjectionGate.open(scheduleSearchIndexWarmupNow, scheduleUsageFactSyncNow)
}

async function ensureUsageFactsReady(): Promise<void> {
  // A committed snapshot is transactionally consistent even while the worker
  // is preparing a newer one. Waiting for the runner to become fully idle can
  // starve forever when active transcripts continuously enqueue new snapshots.
  // Serve the last complete snapshot immediately; the renderer requeries when
  // `insights:factsUpdated` announces the next committed revision.
  try {
    if (hasCompletedUsageFactSnapshot()) return
  } catch {
    // First-run schema creation may briefly race the worker. Fall through and
    // await one scheduled snapshot rather than exposing a false empty ledger.
  }

  await scheduleUsageFactSync()
  if (usageFactSyncError) throw usageFactSyncError
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
  runtimeShuttingDown = true
  startupProjectionGate.reset(new Error('Runtime is shutting down'))
  libraryRuntimePaused = true
  libraryRuntimeEpoch++
  clearLibraryBacklogRecoverySchedule()
  clearLibraryBacklogGlobalRecoverySchedule()
  clearLibraryBacklogSafetyStop()
  advanceLibraryWriterArbiterEpoch()
  libraryStartupWriterProven = false
  libraryStartupChunkActive = false
  closeCompensation()
  const compensationClosePromise = waitForCompensationIdle()
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
  const currentLiveSessionSyncWorker = liveSessionSyncWorker
  const currentLiveSessionSyncWorkerRecycle = liveSessionSyncWorkerRecycleGate.wait().catch((error) => {
    console.error('[session-sync] shutdown recycle drain failed:', error)
  })
  liveSessionSyncWorker = null
  const currentUsageFactWorker = usageFactWorker
  const currentUsageFactSyncRunner = usageFactSyncRunner
  usageFactSyncRunner = null
  const currentSessionSyncCoordinator = sessionSyncCoordinator
  sessionSyncCoordinator = null
  const currentActivePoller = activePoller
  activePoller = null
  const currentActivePollProcess = activePollProcess
  activePollProcess = null
  const currentFreshnessMonitor = freshnessMonitor
  freshnessMonitor = null
  const currentDuplicateRecoveryAnalysis = activeDuplicateRecoveryAnalysis
  activeDuplicateRecoveryAnalysis = null
  pendingAutomaticDuplicateRecoveryAnalysis = null
  automaticDuplicateRecoveryAnalysisScheduled = false
  if (automaticDuplicateRecoveryAnalysisTimer) clearTimeout(automaticDuplicateRecoveryAnalysisTimer)
  automaticDuplicateRecoveryAnalysisTimer = null
  rejectAutomaticDuplicateRecoveryAnalysisWaiters('Runtime is shutting down')
  preparedDuplicateRecovery = null
  cachedDuplicateRecoveryAnalysis = null
  if (currentFreshnessMonitor) clearInterval(currentFreshnessMonitor)
  clearLibraryWriterRecoverySchedule()
  deferredLibrarySyncRequests.clear()
  currentUsageFactSyncRunner?.stop(new Error('Runtime is shutting down'))
  // Start draining immediately and overlap it with the bounded cleanup below.
  // LibraryWorkerClient refuses new requests once close() begins. Unlike the
  // other resources this promise must not be deadline-cancelled because
  // terminating active better-sqlite3 work can abort the whole process.
  const libraryWorkerClosePromise = Promise.all([
    currentLibraryWorker?.close() || Promise.resolve(),
    currentLiveSessionSyncWorker?.close() || Promise.resolve(),
    currentLiveSessionSyncWorkerRecycle,
    currentUsageFactWorker?.close() || Promise.resolve(),
    closeSearchIndexWriteCoordinator(new Error('Runtime is shutting down'))
  ])

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
      name: 'duplicate-recovery-analysis',
      timeoutMs: 250,
      run: async () => {
        if (!currentDuplicateRecoveryAnalysis) return
        currentDuplicateRecoveryAnalysis.reject(new Error('Runtime is shutting down'))
        await currentDuplicateRecoveryAnalysis.worker.terminate()
      }
    },
    {
      name: 'canonical-providers',
      timeoutMs: 100,
      run: () => {
        cancelCanonicalProviders()
        closeCanonicalSessionStore()
      }
    },
    { name: 'global-shortcuts', timeoutMs: 50, run: () => globalShortcut.unregisterAll() }
  ], {
    totalBudgetMs: 1_800,
    log: writeLifecycleLog
  }).then(async () => {
    const startedAt = Date.now()
    writeLifecycleLog('library-worker-drain-start')
    await compensationClosePromise
    await libraryWorkerClosePromise
    if (libraryWorker === currentLibraryWorker) libraryWorker = null
    if (liveSessionSyncWorker === currentLiveSessionSyncWorker) liveSessionSyncWorker = null
    if (usageFactWorker === currentUsageFactWorker) usageFactWorker = null
    closeUsageFactStore()
    closeSearchIndex()
    writeLifecycleLog('library-worker-drain-complete', { durationMs: Date.now() - startedAt })
  })
  return runtimeCleanupPromise
}

function createWindow(): void {
  const windowTitle = activeRuntimeSafety.dangerousRealLibrary ? 'Swob — DEV · REAL LIBRARY' : 'Swob'
  mainWindow = new BrowserWindow({
    title: windowTitle,
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

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.setTitle(windowTitle)
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
    hasShadow: process.platform === 'darwin' ? spotlightNativeShadow : false,
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
    if (shouldReadLibraryConfig()) {
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
  return (
    attempt: number,
    backend: SourceDirectoryWatcher['backend'],
    recoveryRoots: string[] = []
  ): void => {
    writeLifecycleLog('source-watcher-ready', {
      source: definition.id,
      backend,
      attempt
    })
    if (attempt === 0) return
    const configuredRecoveryRoots = definition.id === 'codex' && recoveryRoots.length > 0
      ? recoveryRoots.filter((root) => configuredCodexRoots().some((candidate) =>
          path.resolve(candidate.home) === path.resolve(root)
        ))
      : []
    const files = definition.id === 'claude-code'
      ? findClaudeSessionFiles().filter(definition.matches)
      : definition.id === 'codex'
        ? refreshCodexSessionInventory(configuredRecoveryRoots.length > 0
            ? configuredRecoveryRoots.flatMap((root) => [
                path.join(root, 'sessions'),
                path.join(root, 'archived_sessions')
              ])
            : undefined).filter(definition.matches)
        : findCursorSessionFiles().filter(definition.matches)
    for (const filePath of files) {
      scheduleSessionSynchronization({ filePath, source: definition.id, reason: 'change' })
    }
    writeLifecycleLog('source-watcher-recovery-scheduled', {
      source: definition.id,
      fileCount: files.length,
      rootCount: configuredRecoveryRoots.length || definition.roots.length
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
  codexWatcher = watchSourceDirectory({
    definition,
    onReady: sourceWatcherReadyHandler(definition),
    onError: sourceWatcherErrorHandler(definition.id),
    onFile: (filePath) => {
      rememberCodexSessionFile(filePath)
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
  const sessions: LibrarySession[] = []
  const visit = (folder: LibraryTree['folders'][number]): void => {
    sessions.push(...folder.sessions)
    folder.children.forEach(visit)
  }
  sessions.push(...tree.ungroupedSessions)
  tree.folders.forEach(visit)
  return collapseLibrarySessionsByLogicalKey(sessions)
}

function annotateDuplicatePackageEvidence(summary: SessionSummary, session: LibrarySession): void {
  summary.logicalSessionKey = session.logicalSessionKey
  summary.duplicate = session.duplicate === true
  summary.duplicatePackageCount = session.duplicatePackageCount || 1
  summary.duplicatePackageHistory = session.duplicatePackageHistory
}

function annotateSessionSuccessor(summary: SessionSummary): void {
  const successor = resolveSessionSuccessor(currentLineageRegistry, summary.sessionId)
  if (successor) summary.successor = successor
  else delete summary.successor
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
    sessions: sessions.map(sessionSummaryForRenderer),
    config: tree ? libraryTreeToConfig(tree) : undefined
  })
}

function emitProviderPatch(
  target: WebContents,
  sessions: SessionSummary[],
  status: 'complete' | 'degraded',
  errorCode?: string
): void {
  if (target.isDestroyed()) return
  target.send('sessions:providerPatch', {
    sessions: sessions.map(sessionSummaryForRenderer),
    status,
    ...(errorCode ? { errorCode } : {})
  })
}

function isProviderSession(session: SessionSummary): boolean {
  return providerUsesCanonicalRuntime(session.source || '')
}

function replaceCachedProviderSnapshot(snapshot: readonly SessionSummary[]): void {
  const byId = new Map(
    cachedSessions
      .filter((session) => !isProviderSession(session))
      .map((session) => [session.id, session])
  )
  for (const session of snapshot) byId.set(session.id, session)
  cachedSessions = [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

function refreshLibraryHealthInventory(tree: LibraryTree): void {
  const identity = summarizeLibraryIdentityHealth(getLibrarySessionRegistryDiagnostics())
  updateLibraryIdentityExceptions({
    ...identity,
    analysisGeneration: `${libraryRuntimeEpoch}:${tree.writeGeneration ?? -1}`
  })

  const buckets = createEmptyUnverifiableBuckets()
  for (const session of collectLibrarySessionsFromTree(tree)) {
    const remote = resolveLibrarySessionRemoteState(session.meta).isRemote
    const freshness = computeSessionFreshness(
      session.sessionId,
      session.dirPath,
      session.meta.sourceFilePaths,
      {
        canonicalRecordsFile: session.meta.canonicalProvider?.recordsFile,
        unverifiableReason: classifyUnverifiableReason(session.meta.sourceFilePaths, { remote })
      }
    )
    if (freshness.status === 'unverifiable') buckets[freshness.unverifiableReason || 'other']++
  }
  buckets['corrupt-manifest'] += (tree.identityIssues || [])
    .filter((issue) => issue.kind === 'corrupt-manifest').length
  updateLibraryUnverifiableBuckets(buckets)
}

function adoptLibraryTree(tree: LibraryTree, notifyRenderer = true): boolean {
  // Ignore a queued response for a root that was replaced while the worker was scanning.
  if (path.resolve(tree.root) !== path.resolve(getLibraryRoot())) return false
  if (!applyLibraryTree(tree)) return false
  if (activeDuplicateRecoveryAnalysis &&
    (path.resolve(activeDuplicateRecoveryAnalysis.libraryRoot) !== path.resolve(tree.root) ||
      activeDuplicateRecoveryAnalysis.writeGeneration !== (tree.writeGeneration ?? -1))) {
    void cancelActiveDuplicateRecoveryAnalysis('duplicate-recovery-inventory-changed-during-analysis')
  }
  if (cachedDuplicateRecoveryAnalysis &&
    (path.resolve(cachedDuplicateRecoveryAnalysis.libraryRoot) !== path.resolve(tree.root) ||
      cachedDuplicateRecoveryAnalysis.writeGeneration !== (tree.writeGeneration ?? -1))) {
    cachedDuplicateRecoveryAnalysis = null
    preparedDuplicateRecovery = null
  }
  latestLibraryTree = tree
  refreshLibraryHealthInventory(tree)
  const identity = getLibraryHealth().dimensions.identityExceptions
  if (identity.unknownGroupCount + identity.evidenceMismatchGroupCount > 0) {
    requestAutomaticDuplicateRecoveryAnalysis(tree)
  } else {
    clearAutomaticDuplicateRecoveryAnalysisSchedule()
    rejectAutomaticDuplicateRecoveryAnalysisWaiters('duplicate-recovery-no-longer-actionable')
    void cancelActiveDuplicateRecoveryAnalysis('duplicate-recovery-no-longer-actionable')
  }
  refreshCachedMissingSources()
  scheduleSearchIndexWarmup()
  if (cachedSessions.length > 0) void scheduleUsageFactSync()
  transcriptWatcher?.refresh()
  if (notifyRenderer) emitLibraryPatch([], tree)
  return true
}

async function requestLibraryScan(notifyRenderer = true): Promise<LibraryTree> {
  const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
  for (let attempt = 0; attempt < 5; attempt++) {
    const tree = await worker.scan(getLibraryRoot())
    if (adoptLibraryTree(tree, notifyRenderer)) return tree
  }
  throw new Error('Library 在持续写入，扫描结果已过期；请稍后重试')
}

function reportLibrarySyncProgress(progress: LibraryStartupProgress): void {
  updateLibraryBackgroundProgress({
    total: progress.total,
    completed: progress.completed,
    failed: progress.failed,
    remaining: progress.remaining,
    ...(progress.failureReason
      ? { failure: { sessionId: progress.sessionId, reasonCode: progress.failureReason } }
      : {})
  })
  mainWindow?.webContents.send('library:syncProgress', progress)
}

async function hydrateLibrarySessions(tree: LibraryTree): Promise<void> {
  libraryHydrationActive++
  try {
    await hydrateLibrarySessionsUnderGate(tree)
  } finally {
    libraryHydrationActive--
    if (libraryHydrationActive === 0) scheduleAutomaticDuplicateRecoveryAnalysis()
  }
}

async function hydrateLibrarySessionsUnderGate(tree: LibraryTree): Promise<void> {
  const generation = ++libraryHydrationGeneration
  const batchSize = 20
  const librarySessions = collectLibrarySessionsFromTree(tree)
  const backupPaths = new Set(librarySessions.map((session) => session.jsonlPath))
  const librarySessionById = new Map(librarySessions.map((session) => [session.sessionId, session]))
  const librarySessionBySource = new Map(librarySessions.flatMap((session) =>
    session.meta.sourceFilePaths.map((sourceFilePath) => [sourceFilePath, session] as const)
  ))
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
    const librarySession = librarySessionById.get(session.sessionId) ||
      librarySessionBySource.get(session.filePath)
    const dirPath = librarySession?.dirPath || getSessionDirPath(session.sessionId)
    if (librarySession) annotateDuplicatePackageEvidence(session, librarySession)
    annotateSessionSuccessor(session)
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
      annotateDuplicatePackageEvidence(summary, librarySession)
      annotateSessionSuccessor(summary)
      annotateSessionForFrontend(summary, librarySession.dirPath)
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
      annotateDuplicatePackageEvidence(summary, librarySession)
      annotateSessionSuccessor(summary)
      annotateSessionForFrontend(summary, librarySession.dirPath)
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
    let tree = await requestLibraryScan()
    if (await migrateLegacyDetailAvailability(tree) > 0) {
      tree = await requestLibraryScan()
    }
    transcriptWatcher?.start()
    if (cachedSessions.length > 0) void hydrateLibrarySessions(tree)
  } catch (error) {
    const classification = classifyLibraryError(error)
    transitionLibraryHealth(
      classification.state,
      classification.errorCode,
      classification.message,
      classification.writerReason
    )
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
    recordCurrentFreshnessErrors()
  }, 750)
  libraryWatcher = watchLibraryDirectory({
    root,
    onDirty: () => libraryRescanController?.markDirty(),
    onError: (error) => console.error('[library-watcher] failed:', error)
  })
  writeLifecycleLog('library-watcher-started', { backend: libraryWatcher.backend })
}

// --- Library Initialization ---

const STARTUP_HOT_SOURCE_WINDOW_MS = 5 * 60_000
// Bump only when Library startup projection semantics change. A bump makes the
// persisted checkpoint explicitly dirty every current source exactly once.
const LIBRARY_STARTUP_SCHEMA_GENERATION = 1

function scheduleHotStartupSessions(sessions: readonly SessionSummary[]): void {
  const cutoff = Date.now() - STARTUP_HOT_SOURCE_WINDOW_MS
  const hotSessions: Array<{
    sessionId: string
    filePath: string
    source: 'claude-code' | 'codex' | 'cursor'
    mtimeMs: number
  }> = []
  for (const session of sessions) {
    const candidates = (session.allFilePaths || [session.filePath]).flatMap((filePath) => {
      const source = detectSessionSourceFromPath(filePath)
      if (source !== 'claude-code' && source !== 'codex' && source !== 'cursor') return []
      try {
        const mtimeMs = fs.statSync(filePath).mtimeMs
        return mtimeMs >= cutoff ? [{ filePath, source, mtimeMs }] : []
      } catch {
        return []
      }
    }).sort((left, right) => right.mtimeMs - left.mtimeMs)
    const hottest = candidates[0]
    if (hottest) {
      hotSessions.push({
        sessionId: session.sessionId,
        filePath: hottest.filePath,
        source: hottest.source,
        mtimeMs: hottest.mtimeMs
      })
    }
  }
  // The coordinator assigns monotonically increasing generations. Schedule
  // oldest-first so maxEntries=1 below always prioritizes the hottest source.
  hotSessions.sort((left, right) => left.mtimeMs - right.mtimeMs)
  for (const session of hotSessions) {
    scheduleSessionSynchronization({ ...session, reason: 'change' })
  }
}

async function drainLiveSessionSynchronizations(): Promise<boolean> {
  const coordinator = sessionSyncCoordinator
  if (!coordinator || runtimeShuttingDown || libraryRuntimePaused) return false
  // A live request that arrived during an active startup chunk was deferred
  // before parsing. At this boundary force at most two round-robin keys' newest
  // generations through Library. Later arrivals remain queued for the next
  // boundary, so one active source cannot starve startup or a quieter peer.
  flushDeferredLibrarySynchronizations()
  const generationBeforeDrain = liveLibraryCommitGeneration
  await coordinator.flushPendingSnapshot({ maxEntries: 2 })
  return liveLibraryCommitGeneration > generationBeforeDrain
}

type LibraryBacklogRecoveryMode = 'initial' | 'automatic' | 'provider'

function backgroundRecoveryState(
  summary: LibraryStartupRecoverySummary,
  running = false
): LibraryHealthSnapshot['dimensions']['backgroundBacklog']['recovery'] {
  return {
    state: running
      ? 'running'
      : summary.retryScheduled > 0
        ? 'scheduled'
        : summary.waitingProvider > 0
          ? 'waiting-provider'
          : summary.attentionRequired > 0
            ? 'attention-required'
            : summary.exhausted > 0
              ? 'exhausted'
              : 'idle',
    ...summary
  }
}

function hasSourceRecoveryWork(
  recovery: LibraryHealthSnapshot['dimensions']['backgroundBacklog']['recovery']
): boolean {
  return recovery.retryScheduled + recovery.attentionRequired + recovery.exhausted > 0
}

function clearLibraryBacklogRecoverySchedule(): void {
  if (libraryBacklogRecoveryTimer) clearTimeout(libraryBacklogRecoveryTimer)
  libraryBacklogRecoveryTimer = null
}

function clearLibraryBacklogGlobalRecoverySchedule(resetAttempts = true): void {
  if (libraryBacklogGlobalRecoveryTimer) clearTimeout(libraryBacklogGlobalRecoveryTimer)
  libraryBacklogGlobalRecoveryTimer = null
  if (resetAttempts) {
    libraryBacklogGlobalRecoveryAttempts = 0
    libraryBacklogGlobalRecoveryFault = null
    libraryBacklogGlobalRecoveryExhaustedEpoch = null
  }
}

function clearLibraryBacklogSafetyStop(): void {
  libraryBacklogSafetyStopEpoch = null
}

function libraryBacklogSafetyStopped(): boolean {
  return libraryBacklogSafetyStopEpoch === libraryRuntimeEpoch
}

function libraryBacklogRecoveryStopped(): boolean {
  return libraryBacklogSafetyStopped() ||
    libraryBacklogGlobalRecoveryExhaustedEpoch === libraryRuntimeEpoch
}

function enterLibraryBacklogSafetyStop(): void {
  libraryBacklogSafetyStopEpoch = libraryRuntimeEpoch
  clearLibraryBacklogRecoverySchedule()
  clearLibraryBacklogGlobalRecoverySchedule()
  libraryBacklogRecoveryQueue.clear()
}

function scheduleLibraryBacklogGlobalRecovery(
  operation: LibraryGlobalRecoveryOperation,
  failure: { errorCode: string; healthRevision: number }
): void {
  if (runtimeShuttingDown || libraryRuntimePaused || libraryBacklogRecoveryStopped() ||
    libraryBacklogGlobalRecoveryTimer) return
  const attempt = libraryBacklogGlobalRecoveryAttempts + 1
  const delay = libraryBacklogGlobalRetryDelay(attempt)
  if (delay === null) {
    libraryBacklogGlobalRecoveryExhaustedEpoch = libraryRuntimeEpoch
    libraryBacklogRecoveryQueue.clear()
    return
  }
  libraryBacklogGlobalRecoveryAttempts = attempt
  libraryBacklogGlobalRecoveryFault = { ...failure, operation }
  clearLibraryBacklogRecoverySchedule()
  const epoch = libraryRuntimeEpoch
  libraryBacklogGlobalRecoveryTimer = setTimeout(() => {
    libraryBacklogGlobalRecoveryTimer = null
    if (runtimeShuttingDown || libraryRuntimePaused || libraryBacklogRecoveryStopped() ||
      epoch !== libraryRuntimeEpoch) return
    if (operation.kind === 'initial') void runInitialLibraryGlobalRecovery()
    else if (operation.kind === 'refresh') void runLibraryBacklogRefreshRecovery()
    else void runLibraryBacklogRecovery(operation.mode)
  }, delay)
}

function scheduleLibraryBacklogRecovery(summary: LibraryStartupRecoverySummary): void {
  clearLibraryBacklogRecoverySchedule()
  if (!summary.nextRetryAt || runtimeShuttingDown || libraryRuntimePaused) return
  const epoch = libraryRuntimeEpoch
  const delay = Math.max(0, Math.min(2_147_483_647, Date.parse(summary.nextRetryAt) - Date.now()))
  const runWhenInitializationSettles = (): void => {
    libraryBacklogRecoveryTimer = null
    if (runtimeShuttingDown || libraryRuntimePaused || epoch !== libraryRuntimeEpoch) return
    if (libraryInitializationPromise) {
      libraryBacklogRecoveryTimer = setTimeout(runWhenInitializationSettles, 1_000)
      return
    }
    void runLibraryBacklogRecovery('automatic')
  }
  libraryBacklogRecoveryTimer = setTimeout(runWhenInitializationSettles, delay)
}

function retireFailedLibraryWorker(attemptedWorker: LibraryWorkerClient | null): void {
  if (!attemptedWorker) return
  if (libraryWorker === attemptedWorker) libraryWorker = null
  void attemptedWorker.retire().catch(() => undefined)
}

function handleLibraryGlobalFailure(
  error: unknown,
  operation: LibraryGlobalRecoveryOperation,
  attemptedWorker: LibraryWorkerClient | null,
  logScope: 'library-init' | 'library-recovery' | 'library-switch'
): ReturnType<typeof libraryBacklogBatchFailurePolicy> {
  const cause = error instanceof LibraryStartupBatchTransportError ? error.cause : error
  const classification = classifyLibraryError(cause)
  const policy = libraryBacklogBatchFailurePolicy(cause)
  const healthRevision = transitionLibraryHealth(
    classification.state,
    classification.errorCode,
    classification.message,
    classification.writerReason
  )
  // Any error escaping the transaction boundary is global to that transaction,
  // even when it arose after the checkpoint commit during scan/hydration.
  // Retiring the worker prevents an invalid reply/exit from being reused.
  if (error instanceof LibraryStartupBatchTransportError || policy === 'global-retry') {
    retireFailedLibraryWorker(attemptedWorker)
  }
  if (policy === 'global-retry') {
    scheduleLibraryBacklogGlobalRecovery(
      operation,
      { errorCode: classification.errorCode, healthRevision }
    )
  }
  if (policy === 'safety-stop') enterLibraryBacklogSafetyStop()
  if (classification.state === 'writer-blocked') scheduleLibraryWriterRecovery()
  console.error(`[${logScope}] global Library transaction delayed:`,
    classification.errorCode, classification.message)
  return policy
}

function handleInitialLibraryGlobalFailure(error: unknown): ReturnType<typeof libraryBacklogBatchFailurePolicy> {
  return handleLibraryGlobalFailure(error, { kind: 'initial' }, libraryWorker, 'library-init')
}

async function runInitialLibraryGlobalRecovery(): Promise<void> {
  if (runtimeShuttingDown || libraryRuntimePaused || libraryBacklogRecoveryStopped()) return
  if (libraryInitialized) {
    clearLibraryBacklogGlobalRecoverySchedule()
    return
  }
  if (libraryInitializationPromise) return
  try {
    await initLibraryFromSessions(cachedSessions)
    clearLibraryBacklogGlobalRecoverySchedule()
  } catch (error) {
    if (runtimeShuttingDown || libraryRuntimePaused) return
    handleInitialLibraryGlobalFailure(error)
  }
}

function restoreOwnedLibraryGlobalHealth(): void {
  const recoveredFault = libraryBacklogGlobalRecoveryFault
  clearLibraryBacklogGlobalRecoverySchedule()
  const identityConflictCount = getLibrarySessionRegistryDiagnostics()
    .filter((binding) => binding.state === 'conflict').length
  const recoveredHealthState = libraryBacklogRecoveredHealthState(
    getLibraryHealthRevision(),
    recoveredFault?.healthRevision,
    identityConflictCount
  )
  if (recoveredHealthState === 'identity-conflict') {
    transitionLibraryHealth(
      'identity-conflict',
      'IDENTITY_CONFLICT',
      `${identityConflictCount} logical session identities have multiple read-only packages`
    )
  } else if (recoveredHealthState === 'ready') {
    transitionLibraryHealth('ready', 'SYNC_COMPLETE', 'Library background recovery completed')
  }
}

async function refreshLibraryAfterRecovery(): Promise<void> {
  const tree = await requestLibraryScan(false)
  await hydrateLibrarySessions(tree)
}

async function runLibraryBacklogRefreshRecovery(): Promise<void> {
  if (runtimeShuttingDown || libraryRuntimePaused || libraryBacklogRecoveryStopped() ||
    !libraryInitialized) return
  if (libraryBacklogRecoveryPromise) return libraryBacklogRecoveryPromise
  let recoveryBlocked = false
  const work = (async (): Promise<void> => {
    const attemptedWorker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
    try {
      await refreshLibraryAfterRecovery()
      restoreOwnedLibraryGlobalHealth()
    } catch (error) {
      if (runtimeShuttingDown || libraryRuntimePaused) return
      recoveryBlocked = true
      handleLibraryGlobalFailure(error, { kind: 'refresh' }, attemptedWorker, 'library-recovery')
    }
  })()
  libraryBacklogRecoveryPromise = work
  try {
    await work
  } finally {
    if (libraryBacklogRecoveryPromise === work) libraryBacklogRecoveryPromise = null
    if (!recoveryBlocked && libraryBacklogRecoveryQueue.size > 0 &&
      !runtimeShuttingDown && !libraryRuntimePaused) {
      const pendingMode = libraryBacklogRecoveryQueue.takeNext()
      if (pendingMode) queueMicrotask(() => { void runLibraryBacklogRecovery(pendingMode) })
    }
    scheduleAutomaticDuplicateRecoveryAnalysis()
  }
}

async function runLibraryBacklogRecovery(mode: Exclude<LibraryBacklogRecoveryMode, 'initial'>): Promise<void> {
  if (runtimeShuttingDown) return
  const wakeDisposition = libraryBacklogWakeDisposition(
    libraryRuntimeEpoch,
    libraryBacklogSafetyStopEpoch,
    libraryBacklogGlobalRecoveryTimer !== null,
    libraryBacklogGlobalRecoveryExhaustedEpoch,
    getLibraryHealth().state === 'writer-blocked' || libraryWriterRecoveryTimer !== null ||
      libraryWriterRecoveryPromise !== null
  )
  if (wakeDisposition === 'drop') return
  libraryBacklogRecoveryQueue.request(mode)
  // A whole-batch retry owns this delay. Other Provider/automatic wakes only
  // coalesce while the timer is active; they may not bypass global backoff.
  if (wakeDisposition === 'coalesce') return
  if (libraryRuntimePaused || !libraryInitialized || libraryInitializationPromise) return
  if (libraryBacklogRecoveryPromise) return libraryBacklogRecoveryPromise
  const epoch = libraryRuntimeEpoch
  let recoveryBlocked = false
  const work = (async () => {
    while (epoch === libraryRuntimeEpoch && !runtimeShuttingDown && !libraryRuntimePaused &&
      !libraryBacklogSafetyStopped()) {
      const nextMode = libraryBacklogRecoveryQueue.takeNext()
      if (!nextMode) break
      let attemptedWorker: LibraryWorkerClient | null = null
      let checkpointCommitted = false
      try {
        const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
        attemptedWorker = worker
        const oldConfig = loadConfig()
        const outcome = await syncStartupSessions(worker, cachedSessions, oldConfig.sessionMeta, nextMode)
        checkpointCommitted = outcome.completed > 0
        if (outcome.completed > 0 && epoch === libraryRuntimeEpoch && !runtimeShuttingDown && !libraryRuntimePaused) {
          await refreshLibraryAfterRecovery()
        }
        restoreOwnedLibraryGlobalHealth()
      } catch (error) {
        if (runtimeShuttingDown || libraryRuntimePaused || epoch !== libraryRuntimeEpoch) return
        recoveryBlocked = true
        const operation: LibraryGlobalRecoveryOperation = checkpointCommitted
          ? { kind: 'refresh' }
          : { kind: 'backlog', mode: nextMode }
        const policy = handleLibraryGlobalFailure(
          error,
          operation,
          attemptedWorker,
          'library-recovery'
        )
        if (policy === 'writer-recovery') libraryBacklogRecoveryQueue.request(nextMode)
        break
      }
    }
  })()
  libraryBacklogRecoveryPromise = work
  try {
    await work
  } finally {
    if (libraryBacklogRecoveryPromise === work) libraryBacklogRecoveryPromise = null
    if (!recoveryBlocked && libraryBacklogRecoveryQueue.size > 0 &&
      epoch === libraryRuntimeEpoch && !runtimeShuttingDown && !libraryRuntimePaused) {
      const pendingMode = libraryBacklogRecoveryQueue.takeNext()
      if (pendingMode) queueMicrotask(() => { void runLibraryBacklogRecovery(pendingMode) })
    }
    scheduleAutomaticDuplicateRecoveryAnalysis()
  }
}

async function syncStartupSessions(
  worker: LibraryWorkerClient,
  sessions: readonly SessionSummary[],
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
  mode: LibraryBacklogRecoveryMode = 'initial'
): Promise<LibrarySyncOutcome> {
  const synchronize = () => syncStartupSessionsUnderProviderBarrier(worker, sessions, sessionMeta, mode)
  return runLibraryStartupTransaction(() => sessions.some(isProviderSession)
    ? withCanonicalProviderRefreshBarrier(synchronize)
    : synchronize())
}

async function syncStartupSessionsUnderProviderBarrier(
  worker: LibraryWorkerClient,
  sessions: readonly SessionSummary[],
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
  mode: LibraryBacklogRecoveryMode
): Promise<LibrarySyncOutcome> {
  const syncEpoch = libraryRuntimeEpoch
  const plan = await worker.planStartup(
    getLibraryRoot(),
    [...sessions],
    sessionMeta,
    LIBRARY_STARTUP_SCHEMA_GENERATION,
    { preserveUnseen: latestProviderSettlementStatus !== 'complete' }
  )
  const recoveryByIndex = new Map(plan.recoveryItems.map((item) => [item.index, item.entry]))
  const now = Date.now()
  const selectedIndexes = plan.dirtyIndexes.filter((index) =>
    shouldSelectLibraryBacklogItem(
      mode,
      recoveryByIndex.get(index),
      now,
      isProviderSession(sessions[index])
    ))
  startupProjectionGate.prepareStartup(selectedIndexes.length > 0)
  const dirtySessions = selectedIndexes.map((index) => sessions[index])
  let latestRecoverySummary = plan.recoverySummary
  updateLibraryBackgroundRecovery(backgroundRecoveryState(latestRecoverySummary, dirtySessions.length > 0))
  beginLibraryBackgroundSync(dirtySessions.length)
  try {
    const outcome = await syncLibraryStartupIncrementally({
      sessions: dirtySessions,
      probeWriter: async () => {},
      writerAlreadyProven: true,
      onWriterProven: () => {
        libraryStartupWriterProven = true
        transitionWriterCapability('available', 'WRITER_PROVEN')
        scheduleHotStartupSessions(sessions)
      },
      resolveLatest: (initial) => cachedSummaryForSource(initial.filePath, initial.sessionId) || initial,
      syncBatch: async (batch) => {
        libraryStartupChunkActive = true
        try {
          const result = await worker.syncStartupBatch(
            getLibraryRoot(),
            [...batch],
            sessionMeta,
            { snapshotDigest: plan.snapshotDigest, schemaGeneration: plan.schemaGeneration },
            latestProviderSettlementStatus
          )
          latestRecoverySummary = result.recoverySummary
          return result.outcome
        } finally {
          libraryStartupChunkActive = false
        }
      },
      drainLive: drainLiveSessionSynchronizations,
      onFirstDurableBoundary: (kind) => {
        const readOnlyBoundary = kind === 'read-only-only'
        const failedBoundary = kind === 'failed'
        transitionActiveSourceFreshness(
          readOnlyBoundary || failedBoundary ? 'unverifiable' : 'durable',
          readOnlyBoundary
            ? 'ACTIVE_SOURCE_READ_ONLY'
            : failedBoundary
              ? 'ACTIVE_SOURCE_SYNC_FAILED'
              : 'ACTIVE_SOURCE_DURABLE'
        )
        // Full search/usage projections can consume hundreds of MB and several
        // CPU cores. Root switching stays paused until its whole sync commits;
        // normal startup opens here after a live commit or first startup chunk.
        if (!libraryRuntimePaused) openStartupProjectionGate()
      },
      onProgress: reportLibrarySyncProgress,
      shouldInterrupt: () => runtimeShuttingDown || syncEpoch !== libraryRuntimeEpoch,
      yieldToEventLoop: () => new Promise((resolve) => setImmediate(resolve))
    })
    finishLibraryBackgroundSync(false)
    updateLibraryBackgroundRecovery(backgroundRecoveryState(latestRecoverySummary))
    scheduleLibraryBacklogRecovery(latestRecoverySummary)
    return outcome
  } catch (error) {
    finishLibraryBackgroundSync(true)
    updateLibraryBackgroundRecovery(backgroundRecoveryState(latestRecoverySummary))
    if (!(error instanceof LibraryStartupBatchTransportError)) {
      scheduleLibraryBacklogRecovery(latestRecoverySummary)
    }
    throw error
  }
}

async function initLibraryFromSessions(
  sessions: SessionSummary[],
  options: { preserveForeground?: boolean; writerRecovery?: boolean } = {}
): Promise<void> {
  if (libraryInitializationPromise) return libraryInitializationPromise
  const work = (async (): Promise<void> => {
    initLibrary()
    configureLibraryHealthPersistence(
      getLibraryRoot(),
      path.join(runtimeHome(), '.claude-session-manager', 'diagnostics')
    )
    const recoveryReasonAtStart = options.writerRecovery
      ? getLibraryHealth().writerRecovery.lastReason || undefined
      : undefined
    if (!options.preserveForeground) transitionLibraryHealth('initializing')
    recordLibraryDiagnostic('SYNC_START', 'Library synchronization started')
    const worker = libraryWorker || (libraryWorker = new LibraryWorkerClient())
    const oldConfig = loadConfig()
    let tree = latestLibraryTree || await requestLibraryScan(false)
    const skippedConflictSessionIds = new Set<string>()
    const needsMigration = oldConfig.folders.length > 0 &&
      tree.folders.length === 0 && tree.ungroupedSessions.length === 0
    if (needsMigration) startupProjectionGate.prepareStartup(true)

    let startupInterrupted = false
    let initialSync: LibrarySyncOutcome = { total: sessions.length, completed: 0, skipped: [] }
    try {
      initialSync = await syncStartupSessions(worker, sessions, oldConfig.sessionMeta)
    } catch (error) {
      if (!(error instanceof LibraryStartupSyncInterruptedError)) throw error
      startupInterrupted = true
      recordLibraryDiagnostic(
        'BACKGROUND_SYNC_PAUSED',
        'Library background synchronization paused at a safe session boundary'
      )
    }
    initialSync.skipped
      .filter((entry) => entry.code === 'SESSION_IDENTITY_CONFLICT')
      .forEach((entry) => skippedConflictSessionIds.add(entry.sessionId))
    tree = await requestLibraryScan(false)
    if (!adoptLibraryTree(tree, false)) tree = await requestLibraryScan(false)

    if (needsMigration) {
      // This one-time directory migration needs the worker-built index but does not parse transcripts.
      await migrateFromOldConfig(oldConfig.folders, oldConfig.sessionMeta)
      const libConfig = loadLibraryConfig()
      libConfig.preferences = oldConfig.preferences
      saveLibraryConfig(libConfig)
      tree = await requestLibraryScan(false)
    }

    // Include any session that arrived while the initial worker batch was running.
    if (!startupInterrupted && cachedSessions.some((session) => !sessions.some((initial) => initial.id === session.id))) {
      // Replan against the complete current collection. Passing only the new
      // subset would replace the checkpoint universe and make every older
      // source look dirty again on the next launch.
      const catchUpSync = await syncStartupSessions(worker, cachedSessions, oldConfig.sessionMeta)
      catchUpSync.skipped
        .filter((entry) => entry.code === 'SESSION_IDENTITY_CONFLICT')
        .forEach((entry) => skippedConflictSessionIds.add(entry.sessionId))
      tree = await requestLibraryScan(false)
      if (!adoptLibraryTree(tree, false)) tree = await requestLibraryScan(false)
    }

    if (await migrateLegacyDetailAvailability(tree) > 0) {
      tree = await requestLibraryScan(false)
    }
    libraryInitialized = true
    libraryStartupWriterProven = false
    libraryStartupChunkActive = false
    if (!adoptLibraryTree(tree)) tree = await requestLibraryScan()
    await hydrateLibrarySessions(tree)
    recordCurrentFreshnessErrors()
    const conflictCount = Math.max(
      skippedConflictSessionIds.size,
      getLibrarySessionRegistryDiagnostics().filter((binding) => binding.state === 'conflict').length
    )
    const recoverySnapshot = getLibraryHealth()
    const writerRecovered = options.writerRecovery === true ||
      recoverySnapshot.state === 'writer-blocked' || recoverySnapshot.writerRecovery.attempt > 0
    const recoveryReason = recoveryReasonAtStart || recoverySnapshot.writerRecovery.lastReason || undefined
    if (startupInterrupted) {
      // The four dimensions already describe the safe partial state: writer
      // proof and any durable foreground boundary remain usable while the
      // background backlog is paused for an explicit retry.
      if (writerRecovered) {
        recordLibraryDiagnostic(
          'WRITER_RECOVERED',
          'Library writer recovered; background synchronization remains paused',
          recoveryReason
        )
      }
    } else if (conflictCount > 0) {
      if (writerRecovered) {
        recordLibraryDiagnostic(
          'WRITER_RECOVERED',
          'Library writer recovered; identity conflicts remain read-only',
          recoveryReason
        )
      }
      transitionLibraryHealth(
        'identity-conflict',
        'IDENTITY_CONFLICT',
        `${conflictCount} logical session identities have multiple read-only packages`
      )
    } else {
      transitionLibraryHealth(
        'ready',
        writerRecovered ? 'WRITER_RECOVERED' : 'SYNC_COMPLETE',
        writerRecovered
          ? 'Library writer recovered; Library synchronization completed'
          : 'Library synchronization completed',
        recoveryReason
      )
    }
    resetLibraryWriterRecoveryState()
    startupProjectionGate.finishStartup()
  })()
  libraryInitializationPromise = work
  try {
    await work
  } catch (error) {
    // A failure after the first scan may occur after the optimistic assignment
    // above. Never let the global retry mistake a partially hydrated runtime
    // for a completed initialization.
    libraryInitialized = false
    libraryStartupWriterProven = false
    libraryStartupChunkActive = false
    // A startup failure before the first durable boundary must not strand
    // Insights callers behind a gate that can no longer open. This only drops
    // deferred projections; work already handed to a worker remains untouched.
    startupProjectionGate.reset(
      error instanceof Error ? error : new Error('Library startup synchronization failed')
    )
    const classification = classifyLibraryError(error)
    if (classification.state === 'writer-blocked') {
      enqueueExistingLibrarySessionsForCompensation(sessions)
    }
    throw error
  } finally {
    if (libraryInitializationPromise === work) libraryInitializationPromise = null
    queueMicrotask(() => {
      void runLibraryBacklogRecovery('provider').finally(scheduleAutomaticDuplicateRecoveryAnalysis)
    })
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
    throw new Error('Windows Beta 暂不支持 OneDrive/iCloud 占位文件下载')
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

ipcMain.handle('network:getInfo', () => getLocalNetworkInfo())
ipcMain.handle('network:queryPublicIp', () => queryPublicIp())

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
    { label: mainT('native.image.open'), click: () => shell.openPath(safePath) },
    { label: mainT('native.image.reveal'), click: () => shell.showItemInFolder(safePath) },
    { type: 'separator' },
    { label: mainT('native.image.copy_path'), click: () => clipboard.writeText(safePath) }
  ])
  menu.popup()
})

function filterExcludedSources(sessions: SessionSummary[]): SessionSummary[] {
  const excluded = getExcludedSources()
  if (excluded.length === 0) return sessions
  const excludedSet = new Set(excluded)
  return sessions.filter((s) => !excludedSet.has(s.source || 'claude-code'))
}

function prepareImmediateSession(summary: SessionSummary): void {
  summary.detailAvailability = 'ready'
  annotateSessionSuccessor(summary)
  const immediateResume = getImmediateSessionResumeAvailability(summary)
  summary.canResume = immediateResume.canResume
  summary.canResumeLocal = immediateResume.canResume
  if (immediateResume.canResume) delete summary.resumeUnavailableReason
  else summary.resumeUnavailableReason = immediateResume.reason
  knownSessionIds.add(summary.sessionId)
  knownSessionIds.add(summary.id)
  for (const continuationId of summary.continuationSessionIds || []) {
    knownSessionIds.add(continuationId)
  }

  if (summary.source === 'codex' || summary.source === 'cursor' ||
      summary.source === 'opencode' || summary.source === 'zcode') return
  if (summary.projectPath && isRemoteProjectPath(summary.projectPath)) {
    summary.isRemote = true
    const remoteUser = extractRemoteUser(summary.projectPath)
    if (remoteUser) summary.remoteHost = `${remoteUser}@remote`
  }
}

function settleProviderBootstrap(
  completion: ReturnType<typeof loadAllSessionsWithProviderStatus>,
  target: WebContents
): void {
  void completion.then(({ sessions: loaded, providerStatus }) => {
    const completeSessions = filterExcludedSources(loaded)
    const patch = completeSessions.filter(isProviderSession)
    for (const session of patch) prepareImmediateSession(session)
    if (providerStatus === 'complete') replaceCachedProviderSnapshot(patch)
    else mergeSessionPatch(patch)
    emitProviderPatch(target, patch, providerStatus)
    if (providerStatus === 'complete' || providerStatus === 'degraded') {
      latestProviderSettlementStatus = providerStatus
      void runLibraryBacklogRecovery('provider')
    }
    if (patch.length > 0) {
      scheduleSearchIndexWarmup()
      void scheduleUsageFactSync()
    }
  }).catch((error) => {
    console.error('[session-bootstrap] additive provider refresh failed:', error)
    latestProviderSettlementStatus = 'degraded'
    emitProviderPatch(target, [], 'degraded', 'PROVIDER_REFRESH_FAILED')
    void runLibraryBacklogRecovery('provider')
  })
}

function readSessionLineageRegistry(): SessionLineageRegistry | null {
  const libraryRoot = getLibraryRoot()
  const registryPath = getSessionLineagePath(libraryRoot)
  try {
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as SessionLineageRegistry
      currentLineageRegistry = registry
      currentLineageRegistryRoot = libraryRoot
      return registry
    }
  } catch { /* a corrupt registry is rebuilt below */ }
  currentLineageRegistry = null
  currentLineageRegistryRoot = libraryRoot
  return null
}

async function loadSessionLineageRegistry(): Promise<SessionLineageRegistry | null> {
  const existing = readSessionLineageRegistry()
  if (existing) return existing
  if (lineageRegistryLoadPromise) return lineageRegistryLoadPromise
  const libraryRoot = getLibraryRoot()
  const registryPath = getSessionLineagePath(libraryRoot)
  lineageRegistryLoadPromise = (async () => {
    try {
      const registry = await rebuildSessionLineageRegistry(libraryRoot)
      currentLineageRegistry = registry
      currentLineageRegistryRoot = libraryRoot
      try {
        await withLibraryMaintenanceWriter(() => writeSessionLineageRegistry(registry, registryPath))
      } catch { /* a read-only Library still gets the in-memory evidence */ }
      return registry
    } catch {
      return null
    } finally {
      lineageRegistryLoadPromise = null
    }
  })()
  return lineageRegistryLoadPromise
}

ipcMain.handle('platform:getCapabilities', () => {
  // Playwright can exercise the Windows-only renderer state on a Mac builder;
  // production always uses the immutable native process.platform value.
  const platform = process.env.NODE_ENV === 'test' && process.env.SWOB_TEST_PLATFORM === 'win32'
    ? 'win32'
    : process.platform
  return getPlatformCapabilities(platform)
})

ipcMain.handle('sessions:loadAll', async (event) => {
  try {
  // Reading an existing registry is cheap. A first-run rebuild stays in the
  // background so lineage cannot delay the first session-list paint.
  const diskLineage = readSessionLineageRegistry()
  latestProviderSettlementStatus = null
  const bootstrap = await beginSessionBootstrap(
    () => loadAllSessions({ readOnly: true, migrateLegacyCache: true, quiet: true }),
    () => loadAllSessionsWithProviderStatus()
  )
  const sessions = filterExcludedSources(bootstrap.initial)
  const lastKnownProviderSessions = cachedSessions.filter(isProviderSession)
  cachedSessions = [...sessions, ...lastKnownProviderSessions]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  scheduleSearchIndexWarmup()
  void scheduleUsageFactSync()
  knownSessionIds.clear()

  // Phase 1: physical source summaries are authoritative and immediately
  // visible. Provider Host and canonical storage are additive phase 2 only.
  for (const session of sessions) prepareImmediateSession(session)
  settleProviderBootstrap(bootstrap.completion, event.sender)

  if (latestLibraryTree) void hydrateLibrarySessions(latestLibraryTree)
  if (!diskLineage) {
    void loadSessionLineageRegistry().then((registry) => {
      if (!registry) return
      const patch: SessionSummary[] = []
      for (const summary of cachedSessions) {
        const before = summary.successor
        annotateSessionSuccessor(summary)
        if (before !== summary.successor) patch.push(summary)
      }
      emitLibraryPatch(patch)
    })
  }

  // Sync library in background (non-blocking). During first-run onboarding the
  // library init waits until the user has chosen a vault location.
  if (!libraryInitialized && !isOnboardingNeeded() && !libraryBacklogRecoveryStopped() &&
    !libraryBacklogGlobalRecoveryTimer) {
    const recoveringWriter = getLibraryHealth().state === 'writer-blocked'
    const initialization = recoveringWriter
      ? retryLibraryAfterWriterBlocked(false)
      : initLibraryFromSessions(sessions)
    initialization.catch((error) => {
      // Coordinated shutdown and root switching deliberately close workers.
      // That cancellation is lifecycle success, not evidence that the Library
      // on disk became corrupt.
      if (runtimeShuttingDown || libraryRuntimePaused) return
      // retryLibraryAfterWriterBlocked owns classification/backoff for both its
      // probe and the full initialization it performs. Do not double-record it.
      if (recoveringWriter) return
      handleInitialLibraryGlobalFailure(error)
    })
  }

  return sessions.map(sessionSummaryForRenderer)
  } catch (err) {
    console.error('sessions:loadAll failed:', err)
    emitProviderPatch(event.sender, [], 'degraded', 'SOURCE_REFRESH_FAILED')
    throw err
  }
})

ipcMain.handle(
  'sessions:loadDetail',
  async (_event, filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string, canonicalSessionRecordId?: string) => {
    const safeFilePath = assertSessionSourcePath(filePath)
    const safeAllPaths = allFilePaths?.map(assertSessionSourcePath)
    const safeParentPaths = branchParentFilePaths?.map(assertSessionSourcePath)
    const transcriptPaths = [...new Set([safeFilePath, ...(safeAllPaths || [])]
      .map((candidate) => path.join(path.dirname(candidate), 'transcript.md')))]
      .flatMap((candidate) => {
        try {
          return [assertSessionSourcePath(candidate)]
        } catch {
          return []
        }
      })
    const detail = await loadSessionDetailWithFallback(
      safeFilePath,
      safeAllPaths,
      safeParentPaths,
      branchPointUuid,
      branchLeafUuid,
      transcriptPaths,
      canonicalSessionRecordId
    )
    // Electron's structured clone of thousands of nested message objects can
    // monopolize the renderer thread. One JSON string crosses IPC cheaply; the
    // preload restores the existing object-shaped API in a single parse.
    return JSON.stringify(toRendererSessionDetailLoadResult(detail))
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
  stateFilePath?: string
}> {
  // findAllSessionFiles is the historical Claude/new-provider scan and does
  // not include the separately discovered Codex or Cursor files. Use the
  // already filtered user-visible snapshot for those legacy loaders so the
  // first search warmup cannot silently omit an entire supported source.
  const loadedSpecialSourceFiles = cachedSessions.flatMap((session) =>
    session.source === 'codex' || session.source === 'cursor'
      ? (session.allFilePaths || [session.filePath])
      : [])
  const files = [...new Set([...findAllSessionFiles(), ...loadedSpecialSourceFiles])].filter((filePath) =>
    !filePath.includes('/subagents/') &&
    !providerUsesCanonicalRuntime(detectSessionSourceFromPath(filePath) || '')
  )
  const physicalSources = filterVisibleSearchSources(files.map((filePath) => {
    const source = detectSessionSourceFromPath(filePath) || undefined
    return {
      filePath,
      source
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
  // A previous bounded SQLITE_BUSY cycle keeps its latest intents. Searching
  // is an explicit recovery trigger even when no filesystem event arrives.
  // Never await an entire busy cycle: the UI can safely show the last
  // committed snapshot while the projection catches up.
  const recovery = getSearchIndexWriteCoordinator().retryPending()
  let returnedSnapshot = false
  void recovery.then(() => {
    if (returnedSnapshot) notifySearchIndexUpdated()
  }).catch((error) => {
    if (!runtimeShuttingDown) console.error('[search-index] query-triggered retry delayed:', error)
  })
  // Most retained work succeeds immediately once the external writer is gone,
  // so give it one animation-frame budget. A still-busy index never blocks
  // search beyond that; completion emits an observable refresh signal.
  await Promise.race([
    recovery.catch(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, 16))
  ])
  returnedSnapshot = true
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

function updateCurrentSettingsPreferences(patch: Record<string, unknown>): Record<string, unknown> {
  if (shouldReadLibraryConfig()) {
    const config = loadLibraryConfig()
    const preferences = {
      ...migrateSettingsPreferences(config.preferences as unknown as Record<string, unknown>),
      ...patch
    }
    config.preferences = preferences as any
    saveLibraryConfig(config)
    return preferences
  } else {
    const config = loadConfig()
    const preferences = {
      ...migrateSettingsPreferences(config.preferences as unknown as Record<string, unknown>),
      ...patch
    }
    saveConfig({ ...config, preferences } as any)
    return preferences
  }
}

function openInTerminal(command: string): void {
  if (process.platform === 'win32') {
    throw new Error('Windows Beta 只允许结构化 Resume，不执行原始 shell 命令')
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
    if (!result.ok || !result.command) throw new Error(result.reasonCode || 'resume.error.unavailable')
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

ipcMain.handle('insights:queryBundle', async (_event, scope: AnalysisScope) => {
  await ensureUsageFactsReady()
  return queryInsightsBundle(scope)
})

ipcMain.handle(
  'insights:drilldown',
  async (_event, scope: AnalysisScope, dimension: AnalysisDimension, key: string) => {
    await ensureUsageFactsReady()
    return drilldownInsights(scope, dimension, key)
  }
)

ipcMain.handle(
  'insights:sessionEvents',
  async (
    _event,
    sessionId: string,
    scope: AnalysisScope,
    page: { offset?: number; limit?: number } = {}
  ) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
      throw new Error('Invalid session id')
    }
    await ensureUsageFactsReady()
    return sessionUsageEvents(sessionId, scope, page)
  }
)

ipcMain.handle('insights:rebuildFacts', () => scheduleUsageFactSync({ rebuild: true }))

// --- Lineage IPC ---

ipcMain.handle('lineage:getRegistry', async () => {
  return loadSessionLineageRegistry()
})

ipcMain.handle('sessions:getSuccessor', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) return null
  const registry = currentLineageRegistryRoot === getLibraryRoot()
    ? currentLineageRegistry || await loadSessionLineageRegistry()
    : await loadSessionLineageRegistry()
  return resolveSessionSuccessor(registry, sessionId)
})

ipcMain.handle('sessions:rebuildDetail', async (_event, sessionId: string) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    return { ok: false, error: 'INVALID_SESSION_ID' }
  }
  const summary = cachedSessions.find((session) =>
    session.id === sessionId || session.sessionId === sessionId
  )
  if (!summary) return { ok: false, error: 'SESSION_NOT_FOUND' }
  try {
    const dirPath = getSessionDirPath(summary.sessionId) ||
      await ensureSessionInLibrary(summary)
    const customTitle = (latestLibraryTree ? libraryTreeToConfig(latestLibraryTree) : loadConfig())
      .sessionMeta?.[summary.sessionId]?.customTitle
    const transcriptWritten = await updateTranscript(summary.sessionId, customTitle, dirPath)
    await syncBackup(summary.sessionId, dirPath)
    if (!transcriptWritten) return { ok: false, error: 'SOURCE_UNREADABLE' }
    const tree = await requestLibraryScan()
    await hydrateLibrarySessions(tree)
    return { ok: true }
  } catch (error) {
    console.error('[detail-rebuild] failed:', error)
    return { ok: false, error: 'REBUILD_FAILED' }
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

function normalizeReportRequest(request: ReportJobStartRequest): ReportJobStartRequest {
  const allowed: ReportJobType[] = ['audit', 'quick', 'ai']
  if (!request || !allowed.includes(request.type)) throw new Error('invalid-report-job-type')
  if (request.type !== 'audit') return { type: request.type, params: {}, force: request.force === true }
  const params = request.params || {}
  for (const value of [params.startDate, params.endDate]) {
    if (value !== undefined && Number.isNaN(new Date(value).getTime())) throw new Error('invalid-report-date')
  }
  return { type: 'audit', params, force: request.force === true }
}

function createReportRunner(request: ReportJobStartRequest): ReportJobRunner {
  const sessionSnapshot = [...cachedSessions]
  if (request.type === 'audit') {
    return async ({ signal, progress }) => {
      const { generateInsightsReport } = await import('./session-insights')
      const start = request.params?.startDate ? new Date(request.params.startDate).getTime() : null
      const end = request.params?.endDate ? new Date(request.params.endDate).getTime() : Date.now()
      const sessions = start === null
        ? sessionSnapshot
        : sessionSnapshot.filter((session) => {
            const createdAt = new Date(session.createdAt).getTime()
            return createdAt >= start && createdAt <= end
          })
      const report = await generateInsightsReport(sessions, 500, progress, { signal })
      return { report }
    }
  }

  return async ({ signal, progress }) => {
    const {
      generateInsightsReport,
      generateLlmNarrative,
      renderInsightsHtml,
      renderNarrativeHtml
    } = await import('./session-insights')
    const osModule = await import('os')
    const report = await generateInsightsReport(sessionSnapshot, 200, progress, { signal })
    let html = renderInsightsHtml(report)
    let llmUsed = false
    let llmError: string | undefined
    if (request.type === 'ai') {
      try {
        const llmSettings = await getLlmSettingsWithSecret()
        if (!llmSettings) {
          llmError = 'no-api-key'
        } else {
          const narrative = await generateLlmNarrative(
            report,
            sessionSnapshot,
            llmSettings,
            progress,
            { signal }
          )
          const narrativeHtml = renderNarrativeHtml(narrative)
          html = html.replace('<h2>Health Distribution</h2>', `${narrativeHtml}\n<h2>Health Distribution</h2>`)
          llmUsed = true
        }
      } catch (error) {
        if (signal.aborted) throw error
        const typed = error instanceof Error ? error as Error & { code?: unknown } : null
        llmError = typeof typed?.code === 'string' ? typed.code : 'llm-request-failed'
      }
    }

    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    progress('writing', 0, 1)
    const reportDir = path.join(osModule.homedir(), '.claude-session-manager', 'reports')
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const reportPath = path.join(reportDir, `insights-${timestamp}.html`)
    const latestPath = path.join(reportDir, 'insights-latest.html')
    fs.writeFileSync(reportPath, html, 'utf-8')
    fs.writeFileSync(latestPath, html, 'utf-8')
    progress('writing', 1, 1)
    await shell.openPath(reportPath)
    return { path: reportPath, sessionCount: report.totalSessions, llmUsed, llmError }
  }
}

ipcMain.handle('report:start', (_event, rawRequest: ReportJobStartRequest) => {
  const request = normalizeReportRequest(rawRequest)
  return reportJobManager.start(request, createReportRunner(request))
})

ipcMain.handle('report:status', (_event, request: ReportJobStatusRequest) =>
  reportJobManager.status(request)
)

ipcMain.handle('report:subscribe', (_event, jobId: string) =>
  reportJobManager.subscribe(jobId)
)

ipcMain.handle('report:cancel', (_event, jobId: string) =>
  reportJobManager.cancel(jobId)
)

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
  const appConfig = loadConfig()
  const readsLibrary = shouldReadLibraryConfig()
  const libraryPreferences = readsLibrary
    ? loadLibraryConfig().preferences as unknown as Record<string, unknown>
    : undefined
  const hydratedLibraryConfig = readsLibrary && latestLibraryTree
    ? libraryTreeToConfig(latestLibraryTree)
    : undefined
  const config = resolveRendererConfig(appConfig, libraryPreferences, hydratedLibraryConfig)
  return { ...config, preferences: migrateSettingsPreferences(config.preferences as unknown as Record<string, unknown>) }
})

ipcMain.handle('app:getSystemLocale', () => resolveSystemLocale(
  preferredSystemLanguagesForRuntime(app.getPreferredSystemLanguages())
))

ipcMain.handle('config:save', async (
  _event,
  config: { preferences: Record<string, unknown> },
  preferencePatch?: Record<string, unknown>
) => {
  const patch = preferencePatch || config.preferences
  let migratedPreferences: Record<string, unknown>
  if (shouldReadLibraryConfig()) {
    migratedPreferences = await updateLibraryPreferencesAsync((current) =>
      mergeSettingsPreferencePatch(current, patch)
    )
  } else {
    migratedPreferences = mergeSettingsPreferencePatch(
      loadConfig().preferences as unknown as Record<string, unknown>,
      patch
    )
    const migratedConfig = { ...config, preferences: migratedPreferences }
    saveConfig(migratedConfig as any)
  }
  const migratedConfig = { ...config, preferences: migratedPreferences }
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
ipcMain.handle('settings:getCodexHomes', () => loadAdditionalCodexHomes())
ipcMain.handle('settings:selectCodexHomes', async () => {
  const options = {
    title: translate(mainLocale(), 'renderer.general_settings.codex_homes_picker'),
    properties: ['openDirectory', 'multiSelections'] as Array<'openDirectory' | 'multiSelections'>
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? [] : result.filePaths
})
ipcMain.handle('settings:setCodexHomes', async (_event, homes: unknown) => {
  const previousHomes = loadAdditionalCodexHomes()
  const saved = saveAdditionalCodexHomes(homes)
  const previousSet = new Set(previousHomes.map((home) => path.resolve(home)))
  const addedHomes = saved.filter((home) => !previousSet.has(path.resolve(home)))
  if (addedHomes.length > 0) {
    refreshCodexSessionInventory(addedHomes.flatMap((home) => [
      path.join(home, 'sessions'),
      path.join(home, 'archived_sessions')
    ]))
  }
  const previous = codexWatcher
  codexWatcher = null
  if (previous) await previous.close()
  if (!runtimeShuttingDown) startCodexWatcher()
  // The renderer owns the visible snapshot; its existing debounced refresh
  // path reloads source summaries and preserves normal Library annotations.
  mainWindow?.webContents.send('sessions:refresh')
  return saved
})

ipcMain.handle(
  'config:createFolder',
  async (_event, opts: { name: string; color?: string | null; parentId?: string | null }) => {
    if (shouldReadLibraryConfig()) {
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
    if (shouldReadLibraryConfig()) {
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
  if (shouldReadLibraryConfig()) {
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
    if (shouldReadLibraryConfig()) {
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
    if (shouldReadLibraryConfig()) {
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
    if (shouldReadLibraryConfig()) {
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
    if (shouldReadLibraryConfig()) {
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

ipcMain.handle('organizer:previewSmart', async (): Promise<OrganizerSmartPreviewResult> => {
  try {
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
    return {
      ok: true,
      items: suggestions.map((suggestion) => ({
        ...suggestion,
        title: config.sessionMeta[suggestion.sessionId]?.customTitle ||
          byId.get(suggestion.sessionId)?.firstUserMessage || suggestion.sessionId
      }))
    }
  } catch (error) {
    const setupRequired = error instanceof LlmProfileError ||
      (error instanceof Error && error.message.includes('missing-api-key'))
    return {
      ok: false,
      errorCode: setupRequired ? 'organizer.error.setup_required' : 'organizer.error.preview_failed'
    }
  }
})

ipcMain.handle('organizer:apply', async (_event, kind: OrganizationKind, items: Array<{
  sessionId: string
  targetRelativeFolder: string
  topic?: string
  tags?: string[]
  confidence?: number
}>) => {
  if (!['project', 'smart', 'archive'].includes(kind)) throw new Error('不支持的整理类型')
  const requests = items.map((item) => {
    return {
      sessionId: item.sessionId,
      targetRelativeFolder: item.targetRelativeFolder,
      metaPatch: kind === 'smart' ? {
        topic: item.topic,
        tags: item.tags,
        topicConfidence: item.confidence
      } : undefined
    }
  })
  const result = applyLibraryOrganization(kind as Exclude<OrganizationKind, 'manual'>, requests)
  const config = await refreshAfterOrganization()
  return { ...result, config }
})

ipcMain.handle('organizer:undo', async () => {
  const result = undoLastLibraryOrganization()
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
        session.branchLeafUuid,
        session.id
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

const nativeContextCommandRegistry = createBuiltinCommandRegistry()

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
      const runCommand = (commandId: string, payload?: { folderId?: string }) => {
        void nativeContextCommandRegistry.require(commandId).run({
          payload,
          sessionAction: (action) => resolve({ action, ...payload })
        })
      }
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: data.canResume === false
            ? mainT('native.session.resume_unavailable', {
                reason: data.resumeUnavailableReason || mainT('resume.error.unavailable')
              })
            : mainT('native.session.resume'),
          enabled: data.canResume !== false,
          click: () => runCommand(BUILTIN_COMMAND_IDS.sessionResume)
        },
        { type: 'separator' },
        { label: mainT('native.session.rename'), click: () => runCommand(BUILTIN_COMMAND_IDS.sessionRename) },
        {
          label: smartRename.enabled
            ? mainT('native.session.smart_rename')
            : mainT('native.session.smart_rename_unavailable'),
          enabled: smartRename.enabled,
          click: () => runCommand(BUILTIN_COMMAND_IDS.sessionSmartRename)
        },
      ]

      const removeItems = data.folders.filter(f => f.isIn)

      if (removeItems.length > 0) {
        template.push({ type: 'separator' })
        for (const f of removeItems) {
          template.push({
            label: mainT('native.session.remove_from_folder', { name: f.name }),
            click: () => runCommand(BUILTIN_COMMAND_IDS.sessionRemoveFromFolder, { folderId: f.id })
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
              click: () => runCommand(BUILTIN_COMMAND_IDS.sessionAddToFolder, { folderId: n.id })
            }
            if (n.children.length > 0) {
              item.submenu = [
                { label: mainT('native.session.move_into', { name: n.name }), click: () => runCommand(BUILTIN_COMMAND_IDS.sessionAddToFolder, { folderId: n.id }) },
                { type: 'separator' },
                ...buildSubmenu(n.children)
              ]
              item.click = undefined
            }
            return item
          })
        }
        template.push({ type: 'separator' })
        template.push({ label: mainT('native.session.move_to_folder'), enabled: false })
        template.push(...buildSubmenu(roots))
      }

      if (data.folders.length === 0) {
        template.push({ type: 'separator' })
        template.push({ label: mainT('native.session.no_folders'), enabled: false })
      }

      const menu = Menu.buildFromTemplate(template)
      const win = BrowserWindow.fromWebContents(event.sender)
      menu.popup({ window: win!, callback: () => resolve(null) })
    })
  }
)

// --- Library-specific IPC ---

ipcMain.handle('library:getRoot', () => getLibraryRoot())

ipcMain.handle('dashboard:loadLayout', () => readDashboardLayout(getLibraryRoot()))

ipcMain.handle('dashboard:saveLayout', (_event, layout) =>
  withLibraryMaintenanceWriter(() => writeDashboardLayout(getLibraryRoot(), layout)))

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

// --- Library Health / Freshness / Compensation ---

function duplicateRecoverySummary(
  report: DuplicateRecoveryReport,
  canApply = true,
  completedAt = new Date().toISOString()
): DuplicateRecoverySummary {
  const autoRepairable = report.conflicts.filter((conflict) =>
    conflict.classification === 'canonical-candidate' &&
    conflict.recovery.action === 'quarantine-equivalent-duplicates')
  const manualMergeGroupCount = report.conflicts
    .filter((conflict) => conflict.classification === 'merge-required').length
  return {
    schemaVersion: 1,
    planId: report.planId,
    completedAt,
    canApply,
    packageCount: report.summary.packageCount,
    conflictCount: report.summary.conflictCount,
    autoRepairableGroupCount: autoRepairable.length,
    autoRepairablePackageCount: autoRepairable
      .reduce((count, conflict) => count + conflict.recovery.moves.length, 0),
    manualMergeGroupCount,
    preservedGroupCount: report.summary.conflictCount - autoRepairable.length - manualMergeGroupCount
  }
}

function duplicateRecoverySummaryCachePath(): string {
  return path.join(
    app.getPath('userData'),
    'diagnostics',
    'duplicate-recovery-summary-v1.json'
  )
}

function duplicateRecoveryQuarantineRoot(): string {
  return path.join(app.getPath('userData'), 'Recovery Quarantine')
}

const AUTOMATIC_DUPLICATE_RECOVERY_RETRY_MS = [1_000, 5_000, 30_000, 120_000, 600_000] as const
const AUTOMATIC_DUPLICATE_RECOVERY_QUIET_MS = 750
const AUTOMATIC_DUPLICATE_RECOVERY_MAX_WAIT_MS = 30_000
const configuredDuplicateRecoveryE2EDelay = process.env.SWOB_E2E_SANDBOX_ROOT
  ? Number.parseInt(process.env.SWOB_TEST_DUPLICATE_RECOVERY_FIRST_DELAY_MS || '0', 10)
  : 0
let duplicateRecoveryAnalysisE2EDelayMs = Number.isFinite(configuredDuplicateRecoveryE2EDelay)
  ? Math.max(0, Math.min(60_000, configuredDuplicateRecoveryE2EDelay))
  : 0

function duplicateRecoveryAnalysisGeneration(epoch: number, writeGeneration: number): string {
  return `${epoch}:${writeGeneration}`
}

function clearAutomaticDuplicateRecoveryAnalysisSchedule(): void {
  if (automaticDuplicateRecoveryAnalysisTimer) clearTimeout(automaticDuplicateRecoveryAnalysisTimer)
  automaticDuplicateRecoveryAnalysisTimer = null
  pendingAutomaticDuplicateRecoveryAnalysis = null
}

function rejectAutomaticDuplicateRecoveryAnalysisWaiters(
  reason: string,
  exceptGeneration?: string
): void {
  for (const [generation, waiters] of automaticDuplicateRecoveryAnalysisWaiters) {
    if (generation === exceptGeneration) continue
    automaticDuplicateRecoveryAnalysisWaiters.delete(generation)
    for (const waiter of waiters) waiter.reject(new Error(reason))
  }
}

function resolveAutomaticDuplicateRecoveryAnalysisWaiters(
  generation: string,
  summary: DuplicateRecoverySummary
): void {
  const waiters = automaticDuplicateRecoveryAnalysisWaiters.get(generation)
  if (!waiters) return
  automaticDuplicateRecoveryAnalysisWaiters.delete(generation)
  for (const waiter of waiters) waiter.resolve(summary)
}

function requestAutomaticDuplicateRecoveryAnalysis(tree: LibraryTree): void {
  const writeGeneration = tree.writeGeneration ?? -1
  const generation = duplicateRecoveryAnalysisGeneration(libraryRuntimeEpoch, writeGeneration)
  rejectAutomaticDuplicateRecoveryAnalysisWaiters(
    'duplicate-recovery-analysis-generation-changed',
    generation
  )
  if (automaticDuplicateRecoveryAnalysisSuppressedGeneration === generation) return
  if (cachedDuplicateRecoveryAnalysis &&
    path.resolve(cachedDuplicateRecoveryAnalysis.libraryRoot) === path.resolve(tree.root) &&
    cachedDuplicateRecoveryAnalysis.writeGeneration === writeGeneration) return
  const previous = pendingAutomaticDuplicateRecoveryAnalysis
  const now = Date.now()
  if (automaticDuplicateRecoveryAnalysisTimer) clearTimeout(automaticDuplicateRecoveryAnalysisTimer)
  automaticDuplicateRecoveryAnalysisTimer = null
  const sameScope = previous?.epoch === libraryRuntimeEpoch &&
    path.resolve(previous.libraryRoot) === path.resolve(tree.root)
  const sameGeneration = sameScope && previous.writeGeneration === writeGeneration
  pendingAutomaticDuplicateRecoveryAnalysis = {
    epoch: libraryRuntimeEpoch,
    libraryRoot: tree.root,
    writeGeneration,
    attempt: sameGeneration ? previous.attempt : 0,
    firstRequestedAt: sameScope ? previous.firstRequestedAt : now,
    lastRequestedAt: now
  }
  scheduleAutomaticDuplicateRecoveryAnalysis()
}

function automaticDuplicateRecoveryAnalysisGateClosed(): boolean {
  return runtimeShuttingDown || libraryRuntimePaused || !libraryInitialized ||
    libraryHydrationActive > 0 || Boolean(libraryInitializationPromise) ||
    Boolean(libraryBacklogRecoveryPromise) || libraryStartupChunkActive
}

function scheduleAutomaticDuplicateRecoveryAnalysis(): void {
  if (automaticDuplicateRecoveryAnalysisScheduled || automaticDuplicateRecoveryAnalysisTimer ||
    !pendingAutomaticDuplicateRecoveryAnalysis || automaticDuplicateRecoveryAnalysisGateClosed()) return
  const now = Date.now()
  const delay = boundedQuietWindowDelay(
    pendingAutomaticDuplicateRecoveryAnalysis.firstRequestedAt,
    pendingAutomaticDuplicateRecoveryAnalysis.lastRequestedAt,
    now,
    AUTOMATIC_DUPLICATE_RECOVERY_QUIET_MS,
    AUTOMATIC_DUPLICATE_RECOVERY_MAX_WAIT_MS
  )
  if (delay > 0) {
    automaticDuplicateRecoveryAnalysisTimer = setTimeout(() => {
      automaticDuplicateRecoveryAnalysisTimer = null
      scheduleAutomaticDuplicateRecoveryAnalysis()
    }, delay)
    automaticDuplicateRecoveryAnalysisTimer.unref?.()
    return
  }
  automaticDuplicateRecoveryAnalysisScheduled = true
  queueMicrotask(() => {
    automaticDuplicateRecoveryAnalysisScheduled = false
    void drainAutomaticDuplicateRecoveryAnalysis()
  })
}

async function drainAutomaticDuplicateRecoveryAnalysis(): Promise<void> {
  const pending = pendingAutomaticDuplicateRecoveryAnalysis
  // Ownership can change after schedule() queues this microtask. Recheck every
  // I/O gate at the actual worker-start boundary so a newer Provider/backlog
  // drain cannot overlap the full-Library hashing pass.
  if (!pending || automaticDuplicateRecoveryAnalysisGateClosed()) return
  if (pending.epoch !== libraryRuntimeEpoch ||
    path.resolve(pending.libraryRoot) !== path.resolve(getLibraryRoot()) ||
    pending.writeGeneration !== (latestLibraryTree?.writeGeneration ?? -1)) {
    pendingAutomaticDuplicateRecoveryAnalysis = null
    return
  }
  pendingAutomaticDuplicateRecoveryAnalysis = null
  try {
    const summary = await analyzeDuplicateRecoveryForCurrentLibrary()
    resolveAutomaticDuplicateRecoveryAnalysisWaiters(
      duplicateRecoveryAnalysisGeneration(pending.epoch, pending.writeGeneration),
      summary
    )
  } catch (error) {
    if (runtimeShuttingDown || pending.epoch !== libraryRuntimeEpoch ||
      path.resolve(pending.libraryRoot) !== path.resolve(getLibraryRoot()) ||
      pending.writeGeneration !== (latestLibraryTree?.writeGeneration ?? -1) ||
      automaticDuplicateRecoveryAnalysisSuppressedGeneration ===
        duplicateRecoveryAnalysisGeneration(pending.epoch, pending.writeGeneration)) return
    const identity = getLibraryHealth().dimensions.identityExceptions
    if (identity.unknownGroupCount + identity.evidenceMismatchGroupCount === 0) return
    const attempt = pending.attempt + 1
    if (attempt > AUTOMATIC_DUPLICATE_RECOVERY_RETRY_MS.length) {
      rejectAutomaticDuplicateRecoveryAnalysisWaiters('duplicate-recovery-automatic-analysis-exhausted')
      return
    }
    pendingAutomaticDuplicateRecoveryAnalysis = {
      ...pending,
      attempt,
      lastRequestedAt: Date.now() - AUTOMATIC_DUPLICATE_RECOVERY_QUIET_MS
    }
    automaticDuplicateRecoveryAnalysisTimer = setTimeout(() => {
      automaticDuplicateRecoveryAnalysisTimer = null
      scheduleAutomaticDuplicateRecoveryAnalysis()
    }, AUTOMATIC_DUPLICATE_RECOVERY_RETRY_MS[attempt - 1])
    automaticDuplicateRecoveryAnalysisTimer.unref?.()
    console.error('[duplicate-recovery] automatic read-only analysis delayed:',
      duplicateRecoveryErrorCode(error))
  }
}

function runDuplicateRecoveryAnalysis(
  libraryRoot: string,
  quarantineRoot: string,
  writeGeneration: number
): Promise<DuplicateRecoveryReport> {
  if (cachedDuplicateRecoveryAnalysis &&
    path.resolve(cachedDuplicateRecoveryAnalysis.libraryRoot) === path.resolve(libraryRoot) &&
    cachedDuplicateRecoveryAnalysis.writeGeneration === writeGeneration) {
    return Promise.resolve(cachedDuplicateRecoveryAnalysis.report)
  }
  if (activeDuplicateRecoveryAnalysis &&
    path.resolve(activeDuplicateRecoveryAnalysis.libraryRoot) === path.resolve(libraryRoot) &&
    path.resolve(activeDuplicateRecoveryAnalysis.quarantineRoot) === path.resolve(quarantineRoot) &&
    activeDuplicateRecoveryAnalysis.writeGeneration === writeGeneration) {
    return activeDuplicateRecoveryAnalysis.promise
  }
  if (activeDuplicateRecoveryAnalysis) {
    const stale = activeDuplicateRecoveryAnalysis
    activeDuplicateRecoveryAnalysis = null
    stale.reject(new Error('duplicate-recovery-analysis-superseded'))
    void stale.worker.terminate()
  }
  const workerPath = path.join(__dirname, 'duplicate-recovery-worker.js')
  // A one-shot delay exists only inside the already-isolated E2E sandbox so
  // Playwright can deterministically inspect cancellation without racing a
  // fast fixture. Production never receives a delay from this path.
  const testDelayMs = duplicateRecoveryAnalysisE2EDelayMs
  duplicateRecoveryAnalysisE2EDelayMs = 0
  const worker = new Worker(workerPath, {
    workerData: { libraryRoot, quarantineRoot, testDelayMs }
  })
  let finish: (error?: Error, report?: DuplicateRecoveryReport) => void = () => {}
  const promise = new Promise<DuplicateRecoveryReport>((resolve, reject) => {
    let settled = false
    finish = (error?: Error, report?: DuplicateRecoveryReport) => {
      if (settled) return
      settled = true
      if (activeDuplicateRecoveryAnalysis?.worker === worker) activeDuplicateRecoveryAnalysis = null
      if (error) reject(error)
      else if (report) {
        const completedAt = new Date().toISOString()
        cachedDuplicateRecoveryAnalysis = { libraryRoot, writeGeneration, report, completedAt }
        try {
          writeDuplicateRecoverySummaryCache(
            duplicateRecoverySummaryCachePath(),
            libraryRoot,
            writeGeneration,
            duplicateRecoverySummary(report, false, completedAt)
          )
        } catch (cacheError) {
          console.error('[duplicate-recovery] summary cache write skipped:',
            duplicateRecoveryErrorCode(cacheError))
        }
        resolve(report)
      }
      else reject(new Error('duplicate-recovery-analysis-ended-without-report'))
    }
    worker.on('message', (message: {
      kind?: unknown
      progress?: DuplicateRecoveryProgress
      report?: DuplicateRecoveryReport
      errorCode?: unknown
    }) => {
      if (message.kind === 'progress' && message.progress) {
        mainWindow?.webContents.send('library:duplicateRecoveryProgress', message.progress)
      } else if (message.kind === 'complete' && message.report) {
        finish(undefined, message.report)
      } else if (message.kind === 'error') {
        finish(new Error(typeof message.errorCode === 'string'
          ? message.errorCode
          : 'DUPLICATE_RECOVERY_ANALYSIS_FAILED'))
      }
    })
    worker.once('error', (error: unknown) => finish(new Error(duplicateRecoveryErrorCode(error))))
    worker.once('exit', (code) => {
      if (!settled) finish(new Error(code === 0
        ? 'duplicate-recovery-analysis-ended-without-report'
        : 'duplicate-recovery-analysis-worker-failed'))
    })
  })
  activeDuplicateRecoveryAnalysis = {
    libraryRoot,
    quarantineRoot,
    writeGeneration,
    worker,
    reject: (error) => finish(error),
    promise
  }
  return promise
}

async function cancelActiveDuplicateRecoveryAnalysis(reason: string): Promise<boolean> {
  const active = activeDuplicateRecoveryAnalysis
  if (!active) return false
  activeDuplicateRecoveryAnalysis = null
  active.reject(new Error(reason))
  await active.worker.terminate()
  return true
}

async function analyzeDuplicateRecoveryForCurrentLibrary(): Promise<DuplicateRecoverySummary> {
  const libraryRoot = getLibraryRoot()
  const quarantineRoot = duplicateRecoveryQuarantineRoot()
  const writeGeneration = latestLibraryTree?.writeGeneration ?? -1
  const report = await runDuplicateRecoveryAnalysis(libraryRoot, quarantineRoot, writeGeneration)
  if (path.resolve(getLibraryRoot()) !== path.resolve(libraryRoot) ||
    (latestLibraryTree?.writeGeneration ?? -1) !== writeGeneration) {
    throw new Error('duplicate-recovery-library-changed-during-analysis')
  }
  preparedDuplicateRecovery = { libraryRoot, quarantineRoot, writeGeneration, report }
  return duplicateRecoverySummary(
    report,
    true,
    cachedDuplicateRecoveryAnalysis?.completedAt
  )
}

function waitForAutomaticDuplicateRecoveryAnalysis(): Promise<DuplicateRecoverySummary> {
  const tree = latestLibraryTree
  if (!tree) return Promise.reject(new Error('duplicate-recovery-inventory-unavailable'))
  const writeGeneration = tree.writeGeneration ?? -1
  const generation = duplicateRecoveryAnalysisGeneration(libraryRuntimeEpoch, writeGeneration)
  if (cachedDuplicateRecoveryAnalysis &&
    path.resolve(cachedDuplicateRecoveryAnalysis.libraryRoot) === path.resolve(tree.root) &&
    cachedDuplicateRecoveryAnalysis.writeGeneration === writeGeneration) {
    preparedDuplicateRecovery = {
      libraryRoot: tree.root,
      quarantineRoot: duplicateRecoveryQuarantineRoot(),
      writeGeneration,
      report: cachedDuplicateRecoveryAnalysis.report
    }
    return Promise.resolve(duplicateRecoverySummary(
      cachedDuplicateRecoveryAnalysis.report,
      true,
      cachedDuplicateRecoveryAnalysis.completedAt
    ))
  }
  automaticDuplicateRecoveryAnalysisSuppressedGeneration = null
  requestAutomaticDuplicateRecoveryAnalysis(tree)
  return new Promise<DuplicateRecoverySummary>((resolve, reject) => {
    const waiters = automaticDuplicateRecoveryAnalysisWaiters.get(generation) || new Set()
    waiters.add({ resolve, reject })
    automaticDuplicateRecoveryAnalysisWaiters.set(generation, waiters)
  })
}

ipcMain.handle('library:getHealth', (): LibraryHealthSnapshot => {
  return getLibraryHealth()
})

ipcMain.handle('library:getSessionFreshness', (_event, sessionId: string): SessionFreshness | null => {
  return getSessionFreshness(sessionId)
})

ipcMain.handle('library:getStaleSessions', (_event, thresholdMs?: number): SessionFreshness[] => {
  return getStaleSessions(thresholdMs)
})

ipcMain.handle('library:compensationProgress', (): CompensationProgress => {
  return getCompensationProgress()
})

ipcMain.handle('library:compensationCancel', () => {
  cancelCompensation()
})

ipcMain.handle('library:compensationRetry', async () => {
  await retryLibraryAfterWriterBlocked(true)
  return getCompensationProgress()
})

ipcMain.handle('library:analyzeDuplicateRecovery', async (): Promise<DuplicateRecoverySummary> => {
  return waitForAutomaticDuplicateRecoveryAnalysis()
})

ipcMain.handle('library:getCachedDuplicateRecoverySummary', (): DuplicateRecoverySummary | null => {
  return readDuplicateRecoverySummaryCache(duplicateRecoverySummaryCachePath(), getLibraryRoot())
})

ipcMain.handle('library:cancelDuplicateRecoveryAnalysis', async (): Promise<boolean> => {
  automaticDuplicateRecoveryAnalysisSuppressedGeneration = duplicateRecoveryAnalysisGeneration(
    libraryRuntimeEpoch,
    latestLibraryTree?.writeGeneration ?? -1
  )
  clearAutomaticDuplicateRecoveryAnalysisSchedule()
  rejectAutomaticDuplicateRecoveryAnalysisWaiters('duplicate-recovery-analysis-cancelled')
  return cancelActiveDuplicateRecoveryAnalysis('duplicate-recovery-analysis-cancelled')
})

async function applyPreparedDuplicateRecovery(planId: string): Promise<DuplicateRecoveryApplyResult> {
  const prepared = preparedDuplicateRecovery
  if (!prepared || prepared.report.planId !== planId ||
    path.resolve(prepared.libraryRoot) !== path.resolve(getLibraryRoot()) ||
    prepared.writeGeneration !== (latestLibraryTree?.writeGeneration ?? -1)) {
    throw new Error('duplicate-recovery-plan-not-prepared')
  }
  let result
  try {
    result = await withLibraryMaintenanceWriter(() => executeDuplicateRecoveryPlan(
      prepared.libraryRoot,
      prepared.report,
      { quarantineRoot: prepared.quarantineRoot }
    ))
  } catch (error) {
    preparedDuplicateRecovery = null
    cachedDuplicateRecoveryAnalysis = null
    if (error instanceof DuplicateRecoveryPlanExpiredError) {
      try {
        const tree = await requestLibraryScan()
        requestAutomaticDuplicateRecoveryAnalysis(tree)
      } catch (refreshError) {
        const tree = latestLibraryTree
        if (tree) requestAutomaticDuplicateRecoveryAnalysis(tree)
        console.error('[duplicate-recovery] stale-plan refresh delayed:',
          duplicateRecoveryErrorCode(refreshError))
      }
      return {
        schemaVersion: 1,
        status: 'stale',
        planId,
        appliedPackageCount: 0,
        restartRequired: false
      }
    }
    if (error instanceof DuplicateRecoveryMutationIncompleteError) {
      transitionLibraryHealth(
        'read-only',
        'DUPLICATE_RECOVERY_MUTATION_INCOMPLETE',
        'Duplicate recovery could not prove a complete rollback; all Library runtime work is stopping'
      )
      console.error('[duplicate-recovery] Mutation may be incomplete; stopping Library runtime')
      closeLibraryWriterRuntime()
      const shutdown = cleanupRuntimeResources()
      dialog.showErrorBox(
        mainT('native.duplicate_recovery.apply_fatal_title'),
        mainT('native.duplicate_recovery.apply_fatal_body')
      )
      void shutdown.finally(() => app.quit())
    }
    throw error
  }
  preparedDuplicateRecovery = null
  cachedDuplicateRecoveryAnalysis = null
  try {
    const tree = await requestLibraryScan()
    adoptLibraryTree(tree)
    const remainingConflictCount = getLibrarySessionRegistryDiagnostics()
      .filter((binding) => binding.state === 'conflict').length
    transitionLibraryHealth(
      remainingConflictCount > 0 ? 'identity-conflict' : 'ready',
      remainingConflictCount > 0 ? 'IDENTITY_CONFLICT' : 'DUPLICATE_RECOVERY_COMPLETE',
      remainingConflictCount > 0
        ? `${remainingConflictCount} logical session identities remain read-only after duplicate recovery`
        : 'Equivalent duplicate packages moved to recoverable quarantine'
    )
    return { ...result, restartRequired: false }
  } catch (error) {
    transitionLibraryHealth(
      'identity-conflict',
      'DUPLICATE_RECOVERY_REFRESH_FAILED',
      'Equivalent duplicate packages were quarantined, but the Library view must be refreshed after restart'
    )
    console.error('[duplicate-recovery] post-apply Library refresh failed:',
      duplicateRecoveryErrorCode(error))
    return { ...result, restartRequired: true }
  }
}

ipcMain.handle('library:applyDuplicateRecovery', async (_event, planId: unknown) => {
  if (typeof planId !== 'string' || !/^plan:[0-9a-f]{24}$/.test(planId)) {
    throw new Error('invalid-duplicate-recovery-plan-id')
  }
  if (duplicateRecoveryApplyInFlight) {
    if (duplicateRecoveryApplyInFlight.planId !== planId) {
      throw new Error('duplicate-recovery-apply-already-running')
    }
    return duplicateRecoveryApplyInFlight.promise
  }
  const promise = applyPreparedDuplicateRecovery(planId)
  duplicateRecoveryApplyInFlight = { planId, promise }
  try {
    return await promise
  } finally {
    if (duplicateRecoveryApplyInFlight?.promise === promise) duplicateRecoveryApplyInFlight = null
  }
})

ipcMain.handle('library:selectDirectory', async () => {
  if (!mainWindow) return null
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: mainT('native.library.select_title'),
    defaultPath: getLibraryRoot(),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: mainT('native.library.select_button')
  })
  if (result.canceled || result.filePaths.length === 0) return null
  const approved = approveLibraryRoot(result.filePaths[0])
  onboardingEstimateTargetPath = approved
  return approved
})

async function activateLibraryAt(newPath: string): Promise<string> {
  const duplicateRecoveryAnalysisCancellation = cancelActiveDuplicateRecoveryAnalysis(
    'duplicate-recovery-library-changed-during-analysis'
  )
  libraryRuntimeEpoch++
  clearLibraryBacklogRecoverySchedule()
  clearLibraryBacklogGlobalRecoverySchedule()
  clearLibraryBacklogSafetyStop()
  libraryBacklogRecoveryQueue.clear()
  clearAutomaticDuplicateRecoveryAnalysisSchedule()
  rejectAutomaticDuplicateRecoveryAnalysisWaiters('duplicate-recovery-library-changed-during-analysis')
  automaticDuplicateRecoveryAnalysisSuppressedGeneration = null
  cachedDuplicateRecoveryAnalysis = null
  preparedDuplicateRecovery = null
  advanceLibraryWriterArbiterEpoch()
  libraryRuntimePaused = true
  startupProjectionGate.reset(new Error('Library root is changing'))
  // Search backup paths and Usage folder dimensions are root-scoped. A root
  // switch is therefore a projection migration even when Library dirty=0.
  startupProjectionGate.prepareStartup(true)
  libraryStartupWriterProven = false
  libraryStartupChunkActive = false
  resetLibraryWriterRecoveryState(false)
  let librarySwitchCommitted = false
  let librarySwitchFailure: unknown = null
  try {
    await duplicateRecoveryAnalysisCancellation
    await libraryWriterRecoveryPromise?.catch(() => undefined)
    await libraryBacklogRecoveryPromise?.catch(() => undefined)
    await libraryInitializationPromise?.catch(() => undefined)
    await liveSessionSyncWorkerRecycleGate.wait().catch((error) => {
      recordLibraryDiagnostic('LIVE_WORKER_RECYCLE_FAILED', 'Live worker recycle failed during root change')
      console.error('[session-sync] root-change recycle drain failed:', error)
    })
    closeCompensation()
    await waitForCompensationIdle()
    const previousWorker = libraryWorker
    libraryWorker = null
    const previousLiveSessionSyncWorker = liveSessionSyncWorker
    liveSessionSyncWorker = null
    // The old runtime is no longer serviceable once its workers start closing.
    // Mark initialization incomplete before the first fallible teardown step so
    // any root-switch failure has one deterministic recovery owner.
    libraryInitialized = false
    libraryInitializationPromise = null
    latestLibraryTree = null
    libraryHydrationGeneration++
    await Promise.all([
      previousWorker?.close(),
      previousLiveSessionSyncWorker?.close(),
      // The old vault's pending backup paths must not land after the root
      // changes. The new root schedules a full prune snapshot after adoption.
      closeSearchIndexWriteCoordinator(new Error('Library root is changing'))
    ])
    clearLibraryHealthPersistence()
    changeConfiguredLibraryPath(newPath)
    initLibrary(newPath)
    configureLibraryHealthPersistence(
      getLibraryRoot(),
      path.join(runtimeHome(), '.claude-session-manager', 'diagnostics')
    )
    resetLibraryHealth()
    recordLibraryDiagnostic('SYNC_START', 'Library synchronization started after root change')
    startLibraryWatcher() // 跟随新库根重启目录监听
    const worker = libraryWorker = new LibraryWorkerClient()
    let tree: LibraryTree
    let skippedConflictCount = 0
    if (cachedSessions.length > 0) {
      const oldConfig = loadConfig()
      const syncResult = await syncStartupSessions(worker, cachedSessions, oldConfig.sessionMeta)
      tree = await worker.scan(getLibraryRoot())
      skippedConflictCount = syncResult.skipped.length
    } else {
      tree = await worker.scan(getLibraryRoot())
    }
    libraryInitialized = true
    // An empty vault writes no config on scan; persist the marker so the root
    // counts as initialized on the next launch.
    if (!isLibraryInitialized(getLibraryRoot())) {
      saveLibraryConfig(loadLibraryConfig())
    }
    if (!adoptLibraryTree(tree)) tree = await requestLibraryScan()
    if (await migrateLegacyDetailAvailability(tree) > 0) {
      tree = await requestLibraryScan()
    }
    await hydrateLibrarySessions(tree)
    freshnessErrorSignature = ''
    recordCurrentFreshnessErrors()
    const conflictCount = Math.max(
      skippedConflictCount,
      getLibrarySessionRegistryDiagnostics().filter((binding) => binding.state === 'conflict').length
    )
    if (conflictCount > 0) {
      transitionLibraryHealth(
        'identity-conflict',
        'IDENTITY_CONFLICT',
        `${conflictCount} logical session identities have multiple read-only packages`
      )
    } else {
      transitionLibraryHealth('ready', 'SYNC_COMPLETE', 'Library synchronization completed')
    }
    librarySwitchCommitted = true
    return getLibraryRoot()
  } catch (error) {
    // Adoption may already have queued projections for the new root. If the
    // switch does not commit, reject those waiters and discard its search
    // warmup so a later root generation starts from a clean closed gate.
    startupProjectionGate.reset(
      error instanceof Error ? error : new Error('Library root change failed')
    )
    libraryInitialized = false
    librarySwitchFailure = error
    throw error
  } finally {
    libraryStartupWriterProven = false
    libraryStartupChunkActive = false
    libraryRuntimePaused = false
    if (librarySwitchFailure) {
      const policy = handleLibraryGlobalFailure(
        librarySwitchFailure,
        { kind: 'initial' },
        libraryWorker,
        'library-switch'
      )
      if (policy === 'writer-recovery') {
        enqueueExistingLibrarySessionsForCompensation(cachedSessions)
      }
      if (policy !== 'safety-stop') {
        try { startLibraryWatcher() } catch (watchError) {
          console.error('[library-switch] watcher restart delayed:',
            classifyLibraryError(watchError).errorCode)
        }
      }
    }
    flushDeferredLibrarySynchronizations()
    // Root switching deliberately pauses live work. The completed full Library
    // synchronization is itself the durable boundary; only then release the
    // adoption-time projections for the new root.
    if (librarySwitchCommitted) openStartupProjectionGate()
    if (librarySwitchCommitted) startupProjectionGate.finishStartup()
    if (latestProviderSettlementStatus) libraryBacklogRecoveryQueue.request('provider')
    const pendingBacklogMode = libraryBacklogRecoveryQueue.takeNext()
    if (pendingBacklogMode) {
      void runLibraryBacklogRecovery(pendingBacklogMode)
    }
    scheduleAutomaticDuplicateRecoveryAnalysis()
  }
}

ipcMain.handle('library:changePath', async (_event, newPath: string) => {
  return activateLibraryAt(assertApprovedLibraryRoot(newPath))
})

// --- Vault migration ---

let vaultMigrationRunning = false

ipcMain.handle('vault:migrate', async (_event, targetPath: string) => {
  if (vaultMigrationRunning) return { ok: false, errorCode: 'vault.error.already_running' }
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    return { ok: false, errorCode: 'vault.error.invalid_target' }
  }
  let approvedTarget: string
  try {
    approvedTarget = assertApprovedLibraryRoot(targetPath)
  } catch {
    return { ok: false, errorCode: 'vault.error.unapproved_target' }
  }
  vaultMigrationRunning = true
  try {
    const sourceRoot = getLibraryRoot()
    const { migrateVault } = await import('./vault-migrator')
    const result = await withLibraryMaintenanceWriter(() => migrateVault(sourceRoot, approvedTarget, (progress) => {
      mainWindow?.webContents.send('vault:migrateProgress', progress)
    }))
    if (!result.ok) return result
    // Copy verified — point the app at the new home and reindex.
    await activateLibraryAt(approvedTarget)
    return { ...result, newRoot: getLibraryRoot() }
  } catch (error) {
    return {
      ok: false,
      errorCode: 'vault.error.migration_failed',
      errorParams: { details: error instanceof Error ? error.message : String(error) }
    }
  } finally {
    vaultMigrationRunning = false
  }
})

ipcMain.handle('vault:selectMigrationTarget', async () => {
  if (!mainWindow) return null
  const { dialog } = require('electron')
  const result = await dialog.showOpenDialog(mainWindow, {
    title: mainT('native.vault.migration_title'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: mainT('native.vault.migration_button')
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
  mainWindow?.webContents.send('sessions:updated', cachedSessions.map(sessionSummaryForRenderer))
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
      return { ok: false, errorCode: 'onboarding.retention.invalid_settings' }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, errorCode: 'onboarding.retention.read_failed' }
    }
  }
  settings.cleanupPeriodDays = 3650
  try {
    fs.mkdirSync(join(require('os').homedir(), '.claude'), { recursive: true })
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8')
    return { ok: true }
  } catch {
    return { ok: false, errorCode: 'onboarding.retention.write_failed' }
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

// --- External URL opening with domain whitelist ---
const ALLOWED_EXTERNAL_DOMAINS = new Set(['github.com', 'discord.gg', 'discord.com'])

ipcMain.handle('shell:openExternal', async (_event, url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only HTTPS URLs are allowed')
  }
  const hostname = parsed.hostname.toLowerCase()
  const allowed = [...ALLOWED_EXTERNAL_DOMAINS].some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  )
  if (!allowed) {
    throw new Error(`Domain not in allowlist: ${hostname}`)
  }
  await shell.openExternal(url)
})

ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
  shell.showItemInFolder(assertProjectOrLibraryPath(filePath))
})

// --- CLI Installation ---

function isCliInstalled(): boolean {
  return fs.existsSync(SWOB_APP_CLI_PATH)
}

function installCli(options: {
  allowShellRcUpdate?: boolean
  allowAuthorization?: boolean
} = {}): {
  cliInstalled: boolean
  skillInstalled: boolean
  cliPath: string | null
  cliManualInstall?: string
  cliVerified?: boolean
  shellRcUpdated?: boolean
  error?: string
} {
  if (!getPlatformCapabilities().features.cliInstall) {
    return {
      cliInstalled: false,
      skillInstalled: false,
      cliPath: null,
      error: 'Windows Beta 暂不支持 CLI 安装'
    }
  }
  const home = runtimeHome()
  const cliInstall = installSwobCli({
    homeDir: home || undefined,
    expectedVersion: app.getVersion(),
    allowShellRcUpdate: options.allowShellRcUpdate,
    allowAuthorization: options.allowAuthorization
  })

  // 2. Install skill
  const skillDir = join(home, '.claude', 'skills', 'swob')
  if (!fs.existsSync(skillDir)) fs.mkdirSync(skillDir, { recursive: true })
  const skillContent = generateSkillContent()
  fs.writeFileSync(join(skillDir, 'SKILL.md'), skillContent, 'utf-8')

  return {
    cliInstalled: cliInstall.cliInstalled,
    skillInstalled: true,
    cliPath: cliInstall.cliPath,
    cliManualInstall: cliInstall.cliManualInstall ?? undefined,
    cliVerified: cliInstall.cliVerified,
    shellRcUpdated: cliInstall.shellRcUpdated,
    error: cliInstall.error
  }
}

function autoInstallCliOnStartup(): void {
  if (!getPlatformCapabilities().features.cliInstall) return
  if (!shouldAutoInstallCli()) return
  try {
    installCli()
  } catch { /* ignore — user can manually install later */ }
}

ipcMain.handle('cli:getStatus', () => {
  const installed = isCliInstalled()
  const commandPath = findInstalledSwobCommandPath({ expectedVersion: app.getVersion() })
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
  return installCli({ allowShellRcUpdate: true, allowAuthorization: true })
})

// --- App Lifecycle ---

// --- Auto Update ---

function setupAutoUpdater(): void {
  // Windows Native Beta remains manually distributed while unsigned; no auto-update.
  if (!getPlatformCapabilities().features.autoUpdate) return
  const preferences = currentSettingsPreferences()
  autoUpdater.allowPrerelease = preferences.updateChannel === 'development'
  configureAutoUpdater({
    updater: autoUpdater,
    ipcMain,
    sendToRenderer: (channel, ...args) => mainWindow?.webContents.send(channel, ...args),
    openDownloadPage: () => shell.openExternal('https://github.com/IvyYang1999/swob/releases/latest'),
    // The window and all startup watchers are already running before this
    // delayed, fire-and-forget request is scheduled.
    checkOnStartup: !is.dev && preferences.autoCheckUpdates !== false
  })
}

const activeRuntimeSafety = runtimeSafetyState(getConfiguredLibraryPath(), process.env, {
  development: is.dev,
  userDataPath: app.getPath('userData')
})
if (activeRuntimeSafety.mode !== startupRuntimeSafety.mode) {
  process.env.SWOB_RUNTIME_SAFETY_MODE = activeRuntimeSafety.mode
}

const ownsGuiInstance = app.requestSingleInstanceLock()
if (!ownsGuiInstance) app.quit()
app.on('second-instance', () => showMainWindow())

app.whenReady().then(async () => {
  if (!ownsGuiInstance) return
  electronApp.setAppUserModelId('com.swob.app')
  // A dedicated, opt-in canary run owns the updater and exits after writing its
  // relaunch result. Normal users never enter this branch.
  if (startPackagedUpdateE2E({ app, updater: autoUpdater })) return
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Only resolve/create the root synchronously. Recursive scan and batch sync run in a Worker.
  initLibrary()
  approveLibraryRoot(getLibraryRoot())
  configureLibraryHealthPersistence(
    getLibraryRoot(),
    path.join(runtimeHome(), '.claude-session-manager', 'diagnostics')
  )
  try {
    await withLibraryMaintenanceWriter(() => recoverInterruptedDuplicateRecoveryTransactions(
      getLibraryRoot(),
      duplicateRecoveryQuarantineRoot()
    ))
  } catch (error) {
    console.error('[duplicate-recovery] Interrupted transaction rollback failed:',
      duplicateRecoveryErrorCode(error))
    dialog.showErrorBox(
      mainT('native.duplicate_recovery.fatal_title'),
      mainT('native.duplicate_recovery.fatal_body')
    )
    app.quit()
    return
  }
  try {
    recoverInterruptedLibraryOrganization()
  } catch (error) {
    console.error('[library-move] Interrupted transaction could not be rolled back:',
      error instanceof Error ? error.message : 'unknown error')
  }
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
  // Forward Library health state changes and compensation progress to renderer
  onLibraryHealthChanged((event) => {
    try { mainWindow?.webContents.send('library:healthChanged', event) } catch { /* window closing */ }
  })
  onLibraryDiagnostic(() => {
    try { mainWindow?.webContents.send('library:healthChanged', getLibraryHealth()) } catch { /* window closing */ }
  })
  onCompensationUpdate((progress) => {
    try { mainWindow?.webContents.send('library:compensationUpdate', progress) } catch { /* window closing */ }
    try { mainWindow?.webContents.send('library:healthChanged', getLibraryHealth()) } catch { /* window closing */ }
  })

  try {
    await withLibraryMaintenanceWriter(() => recoverSwobLensTransactions(getLibraryRoot()))
  } catch (error) {
    console.error('[swoblens] Interrupted package transaction recovery failed:',
      error instanceof Error ? error.message : 'unknown error')
  }

  registerSwobLensIpc({
    ipcMain,
    getLibraryRoot,
    getAppVersion: () => app.getVersion(),
    withLibraryWriter: withLibraryMaintenanceWriter,
    showOpenDialog: (options) => dialog.showOpenDialog(options)
  })

  createWindow()
  primeTerminalDetection()
  startFileWatcher()
  startLibraryWatcher()
  startCodexWatcher()
  startCursorWatcher()
  startActiveSessionPoller()
  freshnessMonitor = setInterval(() => {
    if (runtimeShuttingDown || libraryRuntimePaused) return
    try {
      recordCurrentFreshnessErrors()
    } catch (error) {
      console.error('[library-freshness] periodic health check failed:',
        error instanceof Error ? error.message : 'unknown error')
    }
  }, 60_000)
  freshnessMonitor.unref?.()
  void initializeLibraryScanInBackground()
  setupAutoUpdater()
  autoInstallCliOnStartup()

  logSpawnSelfTest()
  registerSpotlightShortcut(getSpotlightShortcut())
  registerFrontendIpc({
    ipcMain,
    profile: {
      getLibraryRoot,
      getPreferences: currentSettingsPreferences,
      updatePreferences: (patch) => { updateCurrentSettingsPreferences(patch) },
      withLibraryWriter: withLibraryMaintenanceWriter,
      showOpenDialog: (options) => dialog.showOpenDialog(options),
      convertSvgToPng: (buffer) => {
        const image = nativeImage.createFromDataURL(
          `data:image/svg+xml;base64,${buffer.toString('base64')}`
        )
        if (image.isEmpty()) throw new Error('SVG image could not be decoded')
        return image.toPNG()
      }
    },
    spotlight: {
      platform: process.platform,
      getWindow: () => spotlightWindow,
      setPreference: (flag) => { spotlightNativeShadow = flag }
    },
    share: {
      showSaveDialog: (options) => dialog.showSaveDialog(options),
      writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
      createImage: (data) => nativeImage.createFromBuffer(data),
      writeImage: (image) => clipboard.writeImage(image as Electron.NativeImage)
    }
  })
  registerAgentIpc({
    getLibraryRoot: () => {
      try { return getLibraryRoot() } catch { return null }
    },
    showMainWindow: () => showMainWindow(),
    listAgentHistory: async () => {
      const sessions = await loadAllSessions({ readOnly: true, quiet: true })
      const config = latestLibraryTree ? libraryTreeToConfig(latestLibraryTree) : loadConfig()
      return buildAgentHistory(sessions, getAgentWorkspaceDir(), (session) =>
        config.sessionMeta?.[session.sessionId]?.customTitle
      )
    },
    getAgentAlwaysOnTop: () => currentSettingsPreferences().agentAlwaysOnTop !== false,
    persistAgentAlwaysOnTop: (flag) => { updateCurrentSettingsPreferences({ agentAlwaysOnTop: flag }) },
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
            await withLibraryMaintenanceWriter(async () => {
              const assistantFolder = path.join(getLibraryRoot(), 'Swob 助手')
              if (!fs.existsSync(assistantFolder)) createLibraryFolder('Swob 助手')
              moveSessionToFolder(sessionId, assistantFolder)
            })
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
