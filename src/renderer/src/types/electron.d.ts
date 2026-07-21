type ResumeActionResult = { ok: boolean; sessionId: string; reason?: string; command?: string }

interface ElectronAPI {
  loadAllSessions: () => Promise<any[]>
  loadSessionDetail: (filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) => Promise<any>
  searchSessions: (
    query: string
  ) => Promise<
    Array<{
      sessionId: string
      filePath: string
      firstUserMessage: string
      matches: Array<{ text: string; timestamp: string }>
    }>
  >
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string) => Promise<ResumeActionResult>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, terminalApp: string) => Promise<ResumeActionResult[]>
  forkSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string) => Promise<ResumeActionResult>
  buildResumeCommand: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<string>
  getActiveSessions: () => Promise<string[]>
  loadConfig: () => Promise<any>
  saveConfig: (config: any) => Promise<any>
  createFolder: (opts: { name: string; color?: string | null; parentId?: string | null }) => Promise<any>
  moveFolder: (folderId: string, newParentId: string | null, position?: string, targetId?: string) => Promise<any>
  deleteFolder: (folderId: string) => Promise<any>
  renameFolder: (folderId: string, name: string) => Promise<any>
  addSessionToFolder: (
    folderId: string,
    sessionId: string
  ) => Promise<any>
  removeSessionFromFolder: (
    folderId: string,
    sessionId: string
  ) => Promise<any>
  setSessionMeta: (
    sessionId: string,
    meta: { customTitle?: string; notes?: string; highlights?: Array<{ id: string; text: string; turnUuid: string; note?: string; createdAt: string }> }
  ) => Promise<any>
  showSessionContextMenu: (data: { sessionId: string; canResume?: boolean; resumeUnavailableReason?: string; folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }> }) =>
    Promise<{ action: string; folderId?: string } | null>
  libraryGetRoot: () => Promise<string>
  libraryGetMdPath: (sessionId: string) => Promise<string | null>
  libraryGetDirPath: (sessionId: string) => Promise<string | null>
  libraryOpenInFinder: () => Promise<void>
  saveMarkdown: (dirPath: string, filename: string, content: string) => Promise<string>
  saveToTemp: (filename: string, content: string) => Promise<string>
  openPath: (filePath: string) => Promise<string>
  showItemInFolder: (filePath: string) => Promise<void>
  loadImage: (filePath: string) => Promise<{ dataUrl: string | null; status: string }>
  showImageContextMenu: (options: { path: string }) => Promise<void>
  startDrag: (filePath: string, title: string) => void
  onSessionAdded: (callback: (session: any) => void) => void
  onSessionUpdated: (callback: (session: any) => void) => void
  onSessionSummaryUpdated: (callback: (session: any) => void) => void
  onSessionsRefresh: (callback: () => void) => void
  onLibraryPatch: (callback: (patch: { sessions: any[]; config?: any }) => void) => void
  onActiveSessionsChanged: (callback: (ids: string[]) => void) => void
  spotlightSearch: (query: string) => Promise<any[]>
  spotlightResume: (sessionId: string, cwd?: string) => Promise<ResumeActionResult>
  spotlightHide: () => Promise<void>
  spotlightSelectInMain: (sessionId: string) => Promise<void>
  spotlightConsumePendingNavigation: () => Promise<string | null>
  spotlightToggle: () => Promise<void>
  onSpotlightNavigate: (callback: (sessionId: string) => void) => void

  // Auto Update
  onUpdateAvailable: (callback: (version: string, notes: string) => void) => void
  onUpdateDownloading: (callback: (version: string) => void) => void
  onUpdateReady: (callback: (version: string, notes: string) => void) => void
  checkForUpdates: () => Promise<void>
  downloadUpdate: () => Promise<void>
  installUpdate: () => Promise<void>

  // Lineage
  getLineageRegistry: () => Promise<any>

  // Claude Code Settings
  getCleanupDays: () => Promise<number>
  setCleanupDays: (days: number) => Promise<boolean>

  // Execution Tree
  getExecutionTree: (filePath: string) => Promise<any>

  // Insights Report
  generateInsightsJson: (options?: { startDate?: string; endDate?: string }) => Promise<{ ok: boolean; report?: any; error?: string }>
  generateInsights: (options?: { useLlm?: boolean }) => Promise<{ ok: boolean; path?: string; sessionCount?: number; llmUsed?: boolean; llmError?: string; error?: string }>
  listModels: () => Promise<string[]>
  getLlmSettings: () => Promise<{ provider: string; hasKey: boolean; keyHint: string; model: string; baseUrl: string }>
  setLlmSettings: (settings: { provider: string; apiKey?: string; model?: string; baseUrl?: string }) => Promise<boolean>
  onInsightsProgress: (callback: (data: { stage: string; current: number; total: number }) => void) => () => void

  // Session Audit
  auditSession: (filePath: string) => Promise<any>

  // Context Inspector
  getContextInspector: (filePath: string) => Promise<any>

  // CLI
  cliGetStatus: () => Promise<{ cliInstalled: boolean; symlinkInstalled: boolean; skillInstalled: boolean }>
  cliInstall: () => Promise<{ cliInstalled: boolean; skillInstalled: boolean; cliPath: string | null; cliManualInstall?: string; error?: string }>
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
