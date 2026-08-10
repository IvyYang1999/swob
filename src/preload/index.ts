import { contextBridge, ipcRenderer } from 'electron'
import type { AnalysisDimension, AnalysisScope, UsageFactSyncResult } from '../main/analysis-contract'
import type { OnboardingBackupSizeEstimate } from '../shared/onboarding-backup-size'
import type { LocalNetworkInfo, PublicIpQueryResult } from '../shared/network-info'
import type {
  AgentAlwaysOnTopState,
  AgentHistoryItem,
  AgentResumeState,
  FrontendIpcResult,
  HarnessIconOverride,
  HarnessIconOverrideInput,
  ImageSelectionResult,
  OrganizerSmartPreviewResult,
  ShareCopyPngResult,
  ShareSavePngResult,
  SpotlightNativeShadowState,
  UserIdentity,
  UserIdentityInput,
  TruthKernelSessionIpcReadModel,
  TruthKernelCatalogIpcState,
  TruthKernelExternalEvidenceAttachResult,
  TruthKernelPricingIpcState,
  TruthKernelPricingMutation,
  TruthKernelPricingMutationResult,
  TruthKernelProviderDoctorIpcInput
} from '../shared/frontend-ipc-contract'
import type { WorkspaceTab } from '../shared/contracts/truth-kernel'
import type { DashboardLayoutConfig } from '../shared/registry/builtin-widgets'
import {
  SWOBLENS_THEME_TOKEN_KEYS,
  type SwobLensThemeDeclaration,
  type InstalledSwobLensPackage,
  type SwobLensIpcResult,
  type SwobLensPackageList,
  type SwobLensPackagePreview
} from '../shared/swoblens-manifest'
import type {
  CompensationProgress,
  LibraryHealthSnapshot,
  SessionFreshness
} from '../shared/library-health-contract'
import type {
  DuplicateRecoveryApplyResult,
  DuplicateRecoveryProgress,
  DuplicateRecoverySummary
} from '../shared/duplicate-recovery-contract'
import type {
  ReportJobSnapshot,
  ReportJobStartRequest,
  ReportJobStatusRequest,
  ReportJobUpdateEvent
} from '../shared/report-jobs'

type ResumeSurface = 'terminal' | 'codex-desktop' | 'claude-desktop' | 'zcode-desktop' | 'remote-control'
type ResumeTargetInstanceOption = {
  id: string
  kind: 'standard' | 'claude-window' | 'non-standard'
  available: boolean
  trusted: boolean
}
type SshTargetConfig = {
  host: string
  user: string
  remotePath?: string
  deviceId?: string
  hostname?: string
  isDefault?: boolean
}

async function parseJsonIpcResult<T>(result: Promise<string | T>): Promise<T> {
  const value = await result
  return typeof value === 'string' ? JSON.parse(value) as T : value
}

const api = {
  // Static startup safety state; never exposes Library or HOME paths.
  runtimeGetSafetyState: () => {
    const dangerousRealLibrary = process.env.SWOB_RUNTIME_SAFETY_MODE === 'dangerous-real-library-development'
    return {
      mode: dangerousRealLibrary ? 'dangerous-real-library-development' as const : 'normal' as const,
      dangerousRealLibrary,
      marker: dangerousRealLibrary ? 'DEV · REAL LIBRARY' : null
    }
  },

  // Platform capabilities
  platformGetCapabilities: () => ipcRenderer.invoke('platform:getCapabilities'),

  // Sessions
  loadAllSessions: () => ipcRenderer.invoke('sessions:loadAll'),
  loadSessionDetail: (filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string, canonicalSessionRecordId?: string) =>
    parseJsonIpcResult(ipcRenderer.invoke(
      'sessions:loadDetail',
      filePath,
      allFilePaths,
      branchParentFilePaths,
      branchPointUuid,
      branchLeafUuid,
      canonicalSessionRecordId
    )),
  loadTruthKernelSession: (sessionId: string, filePath: string) =>
    ipcRenderer.invoke('truth-kernel:session-read-model', sessionId, filePath) as Promise<TruthKernelSessionIpcReadModel>,
  loadTruthKernelCatalog: () =>
    ipcRenderer.invoke('truth-kernel:catalog-state') as Promise<TruthKernelCatalogIpcState>,
  addTruthKernelCatalogRoot: () =>
    ipcRenderer.invoke('truth-kernel:catalog-add-root') as Promise<TruthKernelCatalogIpcState>,
  removeTruthKernelCatalogRoot: (rootId: string) =>
    ipcRenderer.invoke('truth-kernel:catalog-remove-root', rootId) as Promise<TruthKernelCatalogIpcState>,
  rescanTruthKernelCatalogRoot: (rootId: string) =>
    ipcRenderer.invoke('truth-kernel:catalog-rescan-root', rootId) as Promise<TruthKernelCatalogIpcState>,
  saveTruthKernelCatalogTab: (tab: WorkspaceTab) =>
    ipcRenderer.invoke('truth-kernel:catalog-save-tab', tab) as Promise<TruthKernelCatalogIpcState>,
  setActiveTruthKernelCatalogTab: (tabId: string) =>
    ipcRenderer.invoke('truth-kernel:catalog-active-tab', tabId) as Promise<TruthKernelCatalogIpcState>,
  removeTruthKernelCatalogTab: (tabId: string) =>
    ipcRenderer.invoke('truth-kernel:catalog-remove-tab', tabId) as Promise<TruthKernelCatalogIpcState>,
  decideTruthKernelCatalogOnboarding: (choice: 'default-library' | 'index-only' | 'skip') =>
    ipcRenderer.invoke('truth-kernel:catalog-onboarding', choice) as Promise<TruthKernelCatalogIpcState>,
  loadTruthKernelProviderDoctor: () =>
    ipcRenderer.invoke('truth-kernel:provider-doctor') as Promise<TruthKernelProviderDoctorIpcInput[]>,
  attachTruthKernelExternalEvidence: (sessionId: string, filePath: string) =>
    ipcRenderer.invoke('truth-kernel:external-evidence-attach', sessionId, filePath) as Promise<TruthKernelExternalEvidenceAttachResult>,
  listTruthKernelPricing: () =>
    ipcRenderer.invoke('truth-kernel:pricing-list') as Promise<TruthKernelPricingIpcState>,
  applyTruthKernelPricing: (command: TruthKernelPricingMutation) =>
    ipcRenderer.invoke('truth-kernel:pricing-apply', command) as Promise<TruthKernelPricingMutationResult>,
  rebuildSessionDetail: (sessionId: string) =>
    ipcRenderer.invoke('sessions:rebuildDetail', sessionId) as Promise<{ ok: boolean; error?: string }>,
  searchSessions: (query: string) =>
    ipcRenderer.invoke('sessions:search', query),

  // Terminal
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string, surface?: ResumeSurface, preferredTargetInstanceId?: string) =>
    ipcRenderer.invoke('terminal:resume', sessionId, terminalApp, permissionMode, cwd, surface, preferredTargetInstanceId),
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string; preferredTargetInstanceId?: string }>, terminalApp: string) =>
    ipcRenderer.invoke('terminal:resumeBatch', sessions, terminalApp),
  forkSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string, preferredTargetInstanceId?: string) =>
    ipcRenderer.invoke('terminal:fork', sessionId, terminalApp, permissionMode, cwd, preferredTargetInstanceId),
  buildResumeCommand: (sessionId: string, permissionMode?: string, cwd?: string) =>
    ipcRenderer.invoke('terminal:buildResumeCommand', sessionId, permissionMode, cwd),
  listResumeTargetInstances: () => ipcRenderer.invoke('resume:listTargetInstances') as Promise<ResumeTargetInstanceOption[]>,

  // Config
  getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown, preferencePatch?: Record<string, unknown>) =>
    ipcRenderer.invoke('config:save', config, preferencePatch),
  createFolder: (opts: { name: string; color?: string | null; parentId?: string | null }) =>
    ipcRenderer.invoke('config:createFolder', opts),
  moveFolder: (folderId: string, newParentId: string | null, position?: string, targetId?: string) =>
    ipcRenderer.invoke('config:moveFolder', folderId, newParentId, position, targetId),
  deleteFolder: (folderId: string) =>
    ipcRenderer.invoke('config:deleteFolder', folderId),
  renameFolder: (folderId: string, name: string) =>
    ipcRenderer.invoke('config:renameFolder', folderId, name),
  addSessionToFolder: (folderId: string, sessionId: string) =>
    ipcRenderer.invoke('config:addSessionToFolder', folderId, sessionId),
  removeSessionFromFolder: (folderId: string, sessionId: string) =>
    ipcRenderer.invoke('config:removeSessionFromFolder', folderId, sessionId),
  setSessionMeta: (
    sessionId: string,
    meta: {
      customTitle?: string
      notes?: string
      highlights?: unknown[]
      tags?: string[]
      topic?: string
      topicConfidence?: number
    }
  ) => ipcRenderer.invoke('config:setSessionMeta', sessionId, meta),

  // Vault organization
  organizerPreviewProject: () => ipcRenderer.invoke('organizer:previewProject'),
  organizerPreviewSmart: () => ipcRenderer.invoke('organizer:previewSmart') as Promise<OrganizerSmartPreviewResult>,
  organizerApply: (kind: string, items: unknown[]) => ipcRenderer.invoke('organizer:apply', kind, items),
  organizerUndo: () => ipcRenderer.invoke('organizer:undo'),

  // Native context menu
  showSessionContextMenu: (data: { sessionId: string; canResume?: boolean; resumeUnavailableReason?: string; folders: Array<{ id: string; name: string; isIn: boolean }> }) =>
    ipcRenderer.invoke('context-menu:session', data),

  // Library
  libraryGetRoot: () => ipcRenderer.invoke('library:getRoot'),
  dashboardLoadLayout: () => ipcRenderer.invoke('dashboard:loadLayout') as Promise<DashboardLayoutConfig>,
  dashboardSaveLayout: (layout: DashboardLayoutConfig) =>
    ipcRenderer.invoke('dashboard:saveLayout', layout) as Promise<DashboardLayoutConfig>,
  libraryGetMdPath: (sessionId: string) => ipcRenderer.invoke('library:getMdPath', sessionId),
  libraryGetDirPath: (sessionId: string) => ipcRenderer.invoke('library:getDirPath', sessionId),
  libraryOpenInFinder: () => ipcRenderer.invoke('library:openInFinder'),
  libraryGetConfiguredPath: () => ipcRenderer.invoke('library:getConfiguredPath'),
  libraryIsInitialized: (rootPath: string) => ipcRenderer.invoke('library:isInitialized', rootPath),
  librarySelectDirectory: () => ipcRenderer.invoke('library:selectDirectory'),
  libraryChangePath: (newPath: string) => ipcRenderer.invoke('library:changePath', newPath),

  // Library Health / Freshness / Compensation
  libraryGetHealth: () => ipcRenderer.invoke('library:getHealth') as Promise<LibraryHealthSnapshot>,
  libraryGetSessionFreshness: (sessionId: string) =>
    ipcRenderer.invoke('library:getSessionFreshness', sessionId) as Promise<SessionFreshness | null>,
  libraryGetStaleSessions: (thresholdMs?: number) =>
    ipcRenderer.invoke('library:getStaleSessions', thresholdMs) as Promise<SessionFreshness[]>,
  libraryGetCompensationProgress: () =>
    ipcRenderer.invoke('library:compensationProgress') as Promise<CompensationProgress>,
  libraryCompensationCancel: () => ipcRenderer.invoke('library:compensationCancel'),
  libraryCompensationRetry: () => ipcRenderer.invoke('library:compensationRetry'),
  libraryAnalyzeDuplicateRecovery: () =>
    ipcRenderer.invoke('library:analyzeDuplicateRecovery') as Promise<DuplicateRecoverySummary>,
  libraryGetCachedDuplicateRecoverySummary: () =>
    ipcRenderer.invoke('library:getCachedDuplicateRecoverySummary') as Promise<DuplicateRecoverySummary | null>,
  libraryCancelDuplicateRecoveryAnalysis: () =>
    ipcRenderer.invoke('library:cancelDuplicateRecoveryAnalysis') as Promise<boolean>,
  libraryApplyDuplicateRecovery: (planId: string) =>
    ipcRenderer.invoke('library:applyDuplicateRecovery', planId) as Promise<DuplicateRecoveryApplyResult>,
  onDuplicateRecoveryProgress: (callback: (progress: DuplicateRecoveryProgress) => void) => {
    const listener = (_event: unknown, progress: DuplicateRecoveryProgress) => callback(progress)
    ipcRenderer.on('library:duplicateRecoveryProgress', listener)
    return () => ipcRenderer.removeListener('library:duplicateRecoveryProgress', listener)
  },
  onLibraryHealthChanged: (callback: (snapshot: LibraryHealthSnapshot) => void) => {
    const listener = (_event: unknown, data: LibraryHealthSnapshot) => callback(data)
    ipcRenderer.on('library:healthChanged', listener)
    return () => ipcRenderer.removeListener('library:healthChanged', listener)
  },
  onCompensationUpdate: (callback: (progress: CompensationProgress) => void) => {
    const listener = (_event: unknown, progress: CompensationProgress) => callback(progress)
    ipcRenderer.on('library:compensationUpdate', listener)
    return () => ipcRenderer.removeListener('library:compensationUpdate', listener)
  },

  // Vault migration
  vaultMigrate: (targetPath: string) => ipcRenderer.invoke('vault:migrate', targetPath),
  vaultSelectMigrationTarget: () => ipcRenderer.invoke('vault:selectMigrationTarget'),
  onVaultMigrateProgress: (callback: (progress: { phase: string; copied: number; total: number }) => void) => {
    const listener = (_event: unknown, progress: { phase: string; copied: number; total: number }) => callback(progress)
    ipcRenderer.on('vault:migrateProgress', listener)
    return () => ipcRenderer.removeListener('vault:migrateProgress', listener)
  },

  // Onboarding
  onboardingGetState: () => ipcRenderer.invoke('onboarding:getState'),
  onboardingEstimateBackupSize: (excludedSources: string[]) =>
    ipcRenderer.invoke('onboarding:estimateBackupSize', excludedSources) as Promise<OnboardingBackupSizeEstimate>,
  onboardingComplete: (libraryPath: string, excludedSources: string[]) =>
    ipcRenderer.invoke('onboarding:complete', libraryPath, excludedSources),
  onboardingSetExcludedSources: (excludedSources: string[]) =>
    ipcRenderer.invoke('onboarding:setExcludedSources', excludedSources),
  onboardingExtendClaudeRetention: () => ipcRenderer.invoke('onboarding:extendClaudeRetention'),

  // Markdown
  saveMarkdown: (dirPath: string, filename: string, content: string) =>
    ipcRenderer.invoke('session:saveMarkdown', dirPath, filename, content),
  saveToTemp: (filename: string, content: string) =>
    ipcRenderer.invoke('session:saveToTemp', filename, content),

  // Shell
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  openExternalUrl: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Native drag
  startDrag: (filePath: string, title: string) => ipcRenderer.send('session:startDrag', filePath, title),

  // Image loading & context menu
  loadImage: (filePath: string) => ipcRenderer.invoke('image:load', filePath),
  showImageContextMenu: (options: { path: string }) => ipcRenderer.invoke('image:contextMenu', options),

  // Active sessions
  getActiveSessions: () => ipcRenderer.invoke('sessions:getActive'),

  // iCloud
  icloudIsCloudOnly: (sessionId: string) => ipcRenderer.invoke('icloud:isCloudOnly', sessionId),
  icloudDownload: (sessionId: string) => ipcRenderer.invoke('icloud:download', sessionId),
  icloudScanCloudSessions: () => ipcRenderer.invoke('icloud:scanCloudSessions'),

  // SSH
  sshGetConfig: () => ipcRenderer.invoke('ssh:getConfig'),
  sshSetConfig: (config: { host: string; user: string; remotePath?: string } | null) => ipcRenderer.invoke('ssh:setConfig', config),
  sshGetTargets: () => ipcRenderer.invoke('ssh:getTargets') as Promise<SshTargetConfig[]>,
  sshSetTargets: (targets: SshTargetConfig[]) => ipcRenderer.invoke('ssh:setTargets', targets),
  sshResume: (sessionId: string, permissionMode?: string) => ipcRenderer.invoke('ssh:resume', sessionId, permissionMode),
  sshFork: (sessionId: string, permissionMode?: string) => ipcRenderer.invoke('ssh:fork', sessionId, permissionMode),
  sshBuildCommand: (sessionId: string, permissionMode?: string) => ipcRenderer.invoke('ssh:buildCommand', sessionId, permissionMode),
  networkGetInfo: () => ipcRenderer.invoke('network:getInfo') as Promise<LocalNetworkInfo>,
  networkQueryPublicIp: () =>
    ipcRenderer.invoke('network:queryPublicIp') as Promise<PublicIpQueryResult>,

  // Insights
  getInsights: () => ipcRenderer.invoke('insights:get'),
  queryInsights: (scope: AnalysisScope, dimension: AnalysisDimension) =>
    ipcRenderer.invoke('insights:query', scope, dimension),
  queryInsightsBundle: (scope: AnalysisScope) =>
    ipcRenderer.invoke('insights:queryBundle', scope),
  drilldownInsights: (scope: AnalysisScope, dimension: AnalysisDimension, key: string) =>
    ipcRenderer.invoke('insights:drilldown', scope, dimension, key),
  getInsightSessionEvents: (
    sessionId: string,
    scope: AnalysisScope,
    page?: { offset?: number; limit?: number }
  ) => ipcRenderer.invoke('insights:sessionEvents', sessionId, scope, page),
  rebuildInsightsFacts: () => ipcRenderer.invoke('insights:rebuildFacts'),
  onInsightsFactsUpdated: (callback: (result: UsageFactSyncResult) => void) => {
    const listener = (_event: unknown, result: UsageFactSyncResult) => callback(result)
    ipcRenderer.on('insights:factsUpdated', listener)
    return () => ipcRenderer.removeListener('insights:factsUpdated', listener)
  },

  // Lineage
  getLineageRegistry: () => ipcRenderer.invoke('lineage:getRegistry'),
  getSessionSuccessor: (sessionId: string) => ipcRenderer.invoke('sessions:getSuccessor', sessionId),

  // Claude Code Settings
  getCleanupDays: () => ipcRenderer.invoke('claude:getCleanupDays'),
  setCleanupDays: (days: number) => ipcRenderer.invoke('claude:setCleanupDays', days),

  // Execution Tree
  getExecutionTree: (filePath: string) => ipcRenderer.invoke('session:getExecutionTree', filePath),

  // Insights Report
  reportStart: (request: ReportJobStartRequest): Promise<ReportJobSnapshot> => ipcRenderer.invoke('report:start', request),
  reportStatus: (request: ReportJobStatusRequest): Promise<ReportJobSnapshot | null> => ipcRenderer.invoke('report:status', request),
  reportSubscribe: (jobId: string): Promise<ReportJobSnapshot | null> => ipcRenderer.invoke('report:subscribe', jobId),
  reportCancel: (jobId: string): Promise<ReportJobSnapshot | null> => ipcRenderer.invoke('report:cancel', jobId),
  listModels: () => ipcRenderer.invoke('insights:listModels'),
  getLlmSettings: () => ipcRenderer.invoke('insights:getLlmSettings'),
  setLlmSettings: (settings: { provider: string; credential?: string; model?: string; baseUrl?: string }) =>
    ipcRenderer.invoke('insights:setLlmSettings', settings),
  llmListProfiles: () => ipcRenderer.invoke('llm:listProfiles'),
  llmSaveProfile: (profile: {
    id?: string
    name: string
    provider: 'anthropic' | 'openai' | 'custom'
    model?: string
    baseUrl?: string
    credential?: string
    clearCredential?: boolean
  }) => ipcRenderer.invoke('llm:saveProfile', profile),
  llmDeleteProfile: (profileId: string) => ipcRenderer.invoke('llm:deleteProfile', profileId),
  llmGetBindings: () => ipcRenderer.invoke('llm:getBindings'),
  llmSetBindings: (bindings: {
    insights?: string
    smartOrganize?: string
    smartRename?: string
    globalAgent?: string
  }) => ipcRenderer.invoke('llm:setBindings', bindings),
  smartRenamePreview: (sessionIds: string[]) => ipcRenderer.invoke('smartRename:preview', sessionIds),
  smartRenameApply: (items: Array<{ id: string; newTitle: string }>) =>
    ipcRenderer.invoke('smartRename:apply', items),
  agentGetStatus: () => ipcRenderer.invoke('agent:getStatus'),
  agentListHistory: () => ipcRenderer.invoke('agent:listHistory') as Promise<FrontendIpcResult<AgentHistoryItem[]>>,
  agentResumeSession: (sessionId: string) => ipcRenderer.invoke('agent:resumeSession', sessionId) as Promise<FrontendIpcResult<AgentResumeState>>,
  agentGetAlwaysOnTop: () => ipcRenderer.invoke('agent:getAlwaysOnTop') as Promise<FrontendIpcResult<AgentAlwaysOnTopState>>,
  agentSetAlwaysOnTop: (flag: boolean) => ipcRenderer.invoke('agent:setAlwaysOnTop', flag) as Promise<FrontendIpcResult<AgentAlwaysOnTopState>>,
  agentToggleWindow: () => ipcRenderer.invoke('agent:toggleWindow'),
  agentHideWindow: () => ipcRenderer.invoke('agent:hideWindow'),
  agentNewConversation: () => ipcRenderer.invoke('agent:newConversation'),
  agentOpenHistory: () => ipcRenderer.invoke('agent:openHistory'),
  agentSend: (prompt: string) => ipcRenderer.invoke('agent:send', prompt),
  agentCancel: () => ipcRenderer.invoke('agent:cancel'),
  onAgentEvent: (callback: (event: Record<string, unknown>) => void) => {
    const listener = (_e: unknown, data: Record<string, unknown>): void => callback(data)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },
  onInsightsProgress: (callback: (data: ReportJobUpdateEvent) => void) => {
    const listener = (_e: unknown, data: ReportJobUpdateEvent): void => callback(data)
    ipcRenderer.on('insights:progress', listener)
    return () => ipcRenderer.removeListener('insights:progress', listener)
  },

  // Session Audit
  auditSession: (filePath: string) => ipcRenderer.invoke('session:audit', filePath),

  // Context Inspector
  getContextInspector: (filePath: string) => ipcRenderer.invoke('session:getContextInspector', filePath),

  // Spotlight
  spotlightSearch: (query: string) => ipcRenderer.invoke('spotlight:search', query),
  spotlightResume: (sessionId: string, cwd?: string) => ipcRenderer.invoke('spotlight:resume', sessionId, cwd),
  spotlightHide: () => ipcRenderer.invoke('spotlight:hide'),
  spotlightSelectInMain: (sessionId: string) => ipcRenderer.invoke('spotlight:selectInMain', sessionId),
  spotlightConsumePendingNavigation: () => ipcRenderer.invoke('spotlight:consumePendingNavigation'),
  spotlightToggle: () => ipcRenderer.invoke('spotlight:toggle'),
  spotlightSetNativeShadow: (flag: boolean) => ipcRenderer.invoke('spotlight:setNativeShadow', flag) as Promise<FrontendIpcResult<SpotlightNativeShadowState>>,
  profileGetUserIdentity: () => ipcRenderer.invoke('profile:getUserIdentity') as Promise<FrontendIpcResult<UserIdentity>>,
  profileSetUserIdentity: (identity: UserIdentityInput) => ipcRenderer.invoke('profile:setUserIdentity', identity) as Promise<FrontendIpcResult<UserIdentity>>,
  profileSelectImage: () => ipcRenderer.invoke('profile:selectImage') as Promise<FrontendIpcResult<ImageSelectionResult>>,
  profileGetHarnessIconOverrides: () => ipcRenderer.invoke('profile:getHarnessIconOverrides') as Promise<FrontendIpcResult<HarnessIconOverride[]>>,
  profileSetHarnessIconOverride: (input: HarnessIconOverrideInput) => ipcRenderer.invoke('profile:setHarnessIconOverride', input) as Promise<FrontendIpcResult<HarnessIconOverride>>,
  shareSavePng: (base64: string, suggestedName: string) => ipcRenderer.invoke('share:savePng', base64, suggestedName) as Promise<FrontendIpcResult<ShareSavePngResult>>,
  shareCopyPngToClipboard: (base64: string) => ipcRenderer.invoke('share:copyPngToClipboard', base64) as Promise<FrontendIpcResult<ShareCopyPngResult>>,
  swobLensSelectAndPreview: () => ipcRenderer.invoke('swoblens:selectAndPreview') as Promise<SwobLensIpcResult<SwobLensPackagePreview | null>>,
  swobLensList: () => ipcRenderer.invoke('swoblens:list') as Promise<SwobLensIpcResult<SwobLensPackageList>>,
  swobLensInstall: (input: { sourcePath: string; digest: string }) =>
    ipcRenderer.invoke('swoblens:install', input) as Promise<SwobLensIpcResult<InstalledSwobLensPackage>>,
  swobLensSetEnabled: (input: { id: string; enabled: boolean }) =>
    ipcRenderer.invoke('swoblens:setEnabled', input) as Promise<SwobLensIpcResult<InstalledSwobLensPackage>>,
  swobLensUninstall: (id: string) => ipcRenderer.invoke('swoblens:uninstall', id) as Promise<SwobLensIpcResult<null>>,
  onSpotlightNavigate: (callback: (sessionId: string) => void) => {
    ipcRenderer.on('spotlight:navigate', (_event, sessionId) => callback(sessionId))
  },

  // Events from main
  onSessionAdded: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:added', (_event, session) => callback(session))
  },
  onSessionUpdated: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:updated', (_event, session) => callback(session))
  },
  onSessionSummaryUpdated: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:summaryUpdated', (_event, session) => callback(session))
  },
  onSessionsRefresh: (callback: () => void) => {
    ipcRenderer.on('sessions:refresh', () => callback())
  },
  onSearchIndexUpdated: (callback: () => void) => {
    const listener = (): void => callback()
    ipcRenderer.on('session:searchIndexUpdated', listener)
    return () => { ipcRenderer.removeListener('session:searchIndexUpdated', listener) }
  },
  onLibraryPatch: (callback: (patch: unknown) => void) => {
    ipcRenderer.on('sessions:libraryPatch', (_event, patch) => callback(patch))
  },
  onProviderPatch: (callback: (patch: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, patch: unknown): void => callback(patch)
    ipcRenderer.on('sessions:providerPatch', listener)
    return () => { ipcRenderer.removeListener('sessions:providerPatch', listener) }
  },
  onActiveSessionsChanged: (callback: (ids: string[]) => void) => {
    ipcRenderer.on('sessions:activeChanged', (_event, ids) => callback(ids))
  },
  // CLI
  cliGetStatus: () => ipcRenderer.invoke('cli:getStatus'),
  cliInstall: () => ipcRenderer.invoke('cli:install'),

  // Settings capability discovery
  getDetectedTerminals: (force = false) => ipcRenderer.invoke('settings:getDetectedTerminals', force),
  getAppInfo: () => ipcRenderer.invoke('settings:getAppInfo'),
  getCodexHomes: () => ipcRenderer.invoke('settings:getCodexHomes') as Promise<string[]>,
  selectCodexHomes: () => ipcRenderer.invoke('settings:selectCodexHomes') as Promise<string[]>,
  setCodexHomes: (homes: string[]) => ipcRenderer.invoke('settings:setCodexHomes', homes) as Promise<string[]>,

  // Auto Update
  onUpdateAvailable: (callback: (version: string, notes: string) => void) => {
    ipcRenderer.on('update:available', (_event, version, notes) => callback(version, notes))
  },
  onUpdateDownloading: (callback: (version: string) => void) => {
    ipcRenderer.on('update:downloading', (_event, version) => callback(version))
  },
  onUpdateReady: (callback: (version: string, notes: string) => void) => {
    ipcRenderer.on('update:ready', (_event, version, notes) => callback(version, notes))
  },
  onUpdateNotAvailable: (callback: () => void) => {
    ipcRenderer.on('update:notAvailable', () => callback())
  },
  onUpdateError: (callback: (kind: 'check' | 'download' | 'install', version: string) => void) => {
    ipcRenderer.on('update:error', (_event, kind, version) => callback(kind, version))
  },
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateDownloadPage: () => ipcRenderer.invoke('update:openDownload')
}

export type ResumeActionResult = {
  ok: boolean
  sessionId: string
  reasonCode?: string
  reasonParams?: Record<string, string | number>
  noticeCode?: string
  command?: string
}

contextBridge.exposeInMainWorld('api', api)

// Apply only main-process-validated theme tokens. No package bytes, CSS, or
// executable content cross into the renderer.
void ipcRenderer.invoke('swoblens:list').then((result: SwobLensIpcResult<SwobLensPackageList>) => {
  if (!result.ok) return
  const active = result.value.packages.find((item) => item.enabled && item.manifest.type === 'theme')
  if (!active) return
  const declaration = active.declaration as SwobLensThemeDeclaration
  const apply = () => {
    for (const token of SWOBLENS_THEME_TOKEN_KEYS) document.documentElement.style.removeProperty(`--color-${token}`)
    const mode = document.documentElement.dataset.theme || 'dark'
    if (declaration.mode !== 'both' && declaration.mode !== mode) return
    for (const [token, value] of Object.entries(declaration.tokens)) {
      document.documentElement.style.setProperty(`--color-${token}`, value)
    }
  }
  const start = () => {
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('unload', () => observer.disconnect(), { once: true })
  }
  if (document.documentElement) start()
  else window.addEventListener('DOMContentLoaded', start, { once: true })
}).catch(() => undefined)
