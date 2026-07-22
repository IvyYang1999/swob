import { contextBridge, ipcRenderer } from 'electron'
import type { AnalysisDimension, AnalysisScope } from '../main/analysis-contract'

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
  // Platform capabilities
  platformGetCapabilities: () => ipcRenderer.invoke('platform:getCapabilities'),

  // Sessions
  loadAllSessions: () => ipcRenderer.invoke('sessions:loadAll'),
  loadSessionDetail: (filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) =>
    parseJsonIpcResult(ipcRenderer.invoke(
      'sessions:loadDetail',
      filePath,
      allFilePaths,
      branchParentFilePaths,
      branchPointUuid,
      branchLeafUuid
    )),
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
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
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
  organizerPreviewSmart: () => ipcRenderer.invoke('organizer:previewSmart'),
  organizerApply: (kind: string, items: unknown[]) => ipcRenderer.invoke('organizer:apply', kind, items),
  organizerUndo: () => ipcRenderer.invoke('organizer:undo'),

  // Native context menu
  showSessionContextMenu: (data: { sessionId: string; canResume?: boolean; resumeUnavailableReason?: string; folders: Array<{ id: string; name: string; isIn: boolean }> }) =>
    ipcRenderer.invoke('context-menu:session', data),

  // Library
  libraryGetRoot: () => ipcRenderer.invoke('library:getRoot'),
  libraryGetMdPath: (sessionId: string) => ipcRenderer.invoke('library:getMdPath', sessionId),
  libraryGetDirPath: (sessionId: string) => ipcRenderer.invoke('library:getDirPath', sessionId),
  libraryOpenInFinder: () => ipcRenderer.invoke('library:openInFinder'),
  libraryGetConfiguredPath: () => ipcRenderer.invoke('library:getConfiguredPath'),
  libraryIsInitialized: (rootPath: string) => ipcRenderer.invoke('library:isInitialized', rootPath),
  librarySelectDirectory: () => ipcRenderer.invoke('library:selectDirectory'),
  libraryChangePath: (newPath: string) => ipcRenderer.invoke('library:changePath', newPath),

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
  networkGetInfo: () => ipcRenderer.invoke('network:getInfo') as Promise<{
    localIps: string[]
    tailscaleIp: string | null
    publicIp: string | null
    hostname: string
    sshEnabled: boolean
  }>,

  // Insights
  getInsights: () => ipcRenderer.invoke('insights:get'),
  queryInsights: (scope: AnalysisScope, dimension: AnalysisDimension) =>
    ipcRenderer.invoke('insights:query', scope, dimension),
  drilldownInsights: (scope: AnalysisScope, dimension: AnalysisDimension, key: string) =>
    ipcRenderer.invoke('insights:drilldown', scope, dimension, key),
  getInsightSessionEvents: (sessionId: string, scope: AnalysisScope) =>
    ipcRenderer.invoke('insights:sessionEvents', sessionId, scope),
  rebuildInsightsFacts: () => ipcRenderer.invoke('insights:rebuildFacts'),

  // Lineage
  getLineageRegistry: () => ipcRenderer.invoke('lineage:getRegistry'),

  // Claude Code Settings
  getCleanupDays: () => ipcRenderer.invoke('claude:getCleanupDays'),
  setCleanupDays: (days: number) => ipcRenderer.invoke('claude:setCleanupDays', days),

  // Execution Tree
  getExecutionTree: (filePath: string) => ipcRenderer.invoke('session:getExecutionTree', filePath),

  // Insights Report
  generateInsightsJson: (options?: { startDate?: string; endDate?: string }) => ipcRenderer.invoke('insights:generateJson', options),
  generateInsights: (options?: { useLlm?: boolean }) => ipcRenderer.invoke('insights:generate', options),
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
  onInsightsProgress: (callback: (data: { stage: string; current: number; total: number }) => void) => {
    const listener = (_e: unknown, data: { stage: string; current: number; total: number }): void => callback(data)
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
  onLibraryPatch: (callback: (patch: unknown) => void) => {
    ipcRenderer.on('sessions:libraryPatch', (_event, patch) => callback(patch))
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
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install')
}

export type ResumeActionResult = { ok: boolean; sessionId: string; reason?: string; command?: string }

contextBridge.exposeInMainWorld('api', api)
