import { contextBridge, ipcRenderer } from 'electron'

type ResumeSurface = 'terminal' | 'codex-desktop' | 'claude-desktop' | 'zcode-desktop' | 'remote-control'

const api = {
  // Sessions
  loadAllSessions: () => ipcRenderer.invoke('sessions:loadAll'),
  loadSessionDetail: (filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) =>
    ipcRenderer.invoke('sessions:loadDetail', filePath, allFilePaths, branchParentFilePaths, branchPointUuid, branchLeafUuid),
  searchSessions: (query: string) =>
    ipcRenderer.invoke('sessions:search', query),

  // Terminal
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string, surface?: ResumeSurface) =>
    ipcRenderer.invoke('terminal:resume', sessionId, terminalApp, permissionMode, cwd, surface),
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, terminalApp: string) =>
    ipcRenderer.invoke('terminal:resumeBatch', sessions, terminalApp),
  forkSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string) =>
    ipcRenderer.invoke('terminal:fork', sessionId, terminalApp, permissionMode, cwd),
  buildResumeCommand: (sessionId: string, permissionMode?: string, cwd?: string) =>
    ipcRenderer.invoke('terminal:buildResumeCommand', sessionId, permissionMode, cwd),

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
  setLlmSettings: (settings: { provider: string; apiKey?: string; model?: string; baseUrl?: string }) =>
    ipcRenderer.invoke('insights:setLlmSettings', settings),
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
