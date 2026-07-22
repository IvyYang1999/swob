type ResumeSurface = 'terminal' | 'codex-desktop' | 'claude-desktop' | 'zcode-desktop' | 'remote-control'
type ResumeLaunchSpec = {
  executable: string
  args: string[]
  cwd?: string
  env?: Record<string, string>
  target: 'native'
  keepOpen: boolean
}
type ResumeLaunchAction =
  | { kind: 'terminal'; command: string; launchSpec: ResumeLaunchSpec }
  | { kind: 'deep-link'; url: string }
  | { kind: 'remote-control'; command: string; launchSpec: ResumeLaunchSpec }
type ResumeActionResult = {
  ok: boolean
  sessionId: string
  reason?: string
  surface?: ResumeSurface
  action?: ResumeLaunchAction
  command?: string
  notice?: string
}

type LlmProfile = {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'custom'
  model: string
  baseUrl?: string
  keyHint: string
}

type SmartFeatureBinding = {
  insights?: string
  smartOrganize?: string
  smartRename?: string
  globalAgent?: string
}

type SmartRenameResult<T> =
  | { ok: true; items: T; config?: any }
  | { ok: false; error: { code: string; message: string } }

type RendererAnalysisDimension = 'global' | 'time' | 'hour' | 'source' | 'model' | 'project' | 'folder' | 'session'
type RendererAnalysisScope = {
  range: { from?: string; to?: string } | 'today' | '7d' | '30d' | '90d' | 'all'
  sources?: string[]
  models?: string[]
  projectOrFolder?: { kind: 'project' | 'folder'; key: string }
  metricBasis: 'billing' | 'conversation'
}
type RendererCoverageMetric = { covered: number; total: number; percent: number | null }
type RendererUsageAggregate = {
  key: string
  label: string
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  processedTokens: number
  billingTokens: number
  conversationTokens: number
  calls: number
  turns: number
  eventCount: number
  sessionCount: number
  usageCoverage: RendererCoverageMetric
  modelCoverage: RendererCoverageMetric
  pricingCoverage: RendererCoverageMetric & { status: 'pending-t113' | 'available' }
  costUsd: number | null
  unknownTimeEvents: number
}
type RendererInsightsQueryResult = {
  schemaVersion: number
  scope: RendererAnalysisScope
  dimension: RendererAnalysisDimension
  range: { fromDay: string | null; toDay: string | null; label: string }
  items: RendererUsageAggregate[]
  total: RendererUsageAggregate
  previousPeriod: null | {
    range: { fromDay: string | null; toDay: string | null; label: string }
    processedTokens: number
    absoluteChange: number
    percentChange: number | null
  }
  quality: { unknownTimeEvents: number; lastIndexedAt: string | null }
}
type RendererInsightsDrilldownSession = {
  sessionId: string
  rootSessionId: string
  sourceClient: string
  projectPath: string
  models: string[]
  processedTokens: number
  billingTokens: number
  conversationTokens: number
  calls: number
  turns: number
  firstOccurredAt: string | null
  lastOccurredAt: string | null
  usageProvenance: string[]
}
type RendererUsageFact = {
  eventId: string
  occurredAt: string | null
  occurredDay: string
  occurredHour: number | null
  sourceClient: string
  sessionId: string
  rootSessionId: string
  agentScope: 'main' | 'subagent' | 'unknown'
  projectPath: string
  model: string | null
  modelRaw: string | null
  modelProvenance: string
  nonCachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  usageProvenance: string
  callCount: number
  turnCount: number
  costUsd?: number | null
  pricingProvenance?: string | null
  pricedTokens: number
  billableTokens: number
}
type RendererUsageFactSyncResult = {
  changedSessions: number
  unchangedSessions: number
  removedSessions: number
  factCount: number
  rebuilt: boolean
}

interface ElectronAPI {
  platformGetCapabilities: () => Promise<import('../components/WindowsAlphaNotice').PlatformCapabilities>
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
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string, surface?: ResumeSurface) => Promise<ResumeActionResult>
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
    meta: {
      customTitle?: string
      notes?: string
      highlights?: Array<{ id: string; text: string; turnUuid: string; note?: string; createdAt: string }>
      tags?: string[]
      topic?: string
      topicConfidence?: number
    }
  ) => Promise<any>
  organizerPreviewProject: () => Promise<Array<{
    sessionId: string
    sourceDir: string
    targetRelativeFolder: string
    title: string
    fromRelative: string
  }>>
  organizerPreviewSmart: () => Promise<Array<{
    sessionId: string
    folder: string
    topic: string
    tags: string[]
    confidence: number
    title: string
  }>>
  organizerApply: (kind: 'project' | 'smart' | 'archive', items: Array<{
    sessionId: string
    targetRelativeFolder: string
    topic?: string
    tags?: string[]
    confidence?: number
  }>) => Promise<{ operationId: string | null; moves: unknown[]; config: any }>
  organizerUndo: () => Promise<{ operationId: string | null; moves: unknown[]; config: any }>
  showSessionContextMenu: (data: { sessionId: string; canResume?: boolean; resumeUnavailableReason?: string; folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }> }) =>
    Promise<{ action: string; folderId?: string } | null>
  libraryGetRoot: () => Promise<string>
  libraryGetMdPath: (sessionId: string) => Promise<string | null>
  libraryGetDirPath: (sessionId: string) => Promise<string | null>
  libraryOpenInFinder: () => Promise<void>
  vaultMigrate: (targetPath: string) => Promise<{ ok: boolean; error?: string; newRoot?: string; movedMarkerPath?: string }>
  vaultSelectMigrationTarget: () => Promise<string | null>
  onVaultMigrateProgress: (callback: (progress: { phase: string; copied: number; total: number }) => void) => () => void
  onboardingGetState: () => Promise<{ needed: boolean; defaultPath: string; excludedSources: string[] }>
  onboardingComplete: (libraryPath: string, excludedSources: string[]) => Promise<string>
  onboardingSetExcludedSources: (excludedSources: string[]) => Promise<string[]>
  onboardingExtendClaudeRetention: () => Promise<{ ok: boolean; error?: string }>
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
  setLlmSettings: (settings: { provider: string; credential?: string; model?: string; baseUrl?: string }) => Promise<boolean>
  llmListProfiles: () => Promise<LlmProfile[]>
  llmSaveProfile: (profile: {
    id?: string
    name: string
    provider: 'anthropic' | 'openai' | 'custom'
    model?: string
    baseUrl?: string
    credential?: string
    clearCredential?: boolean
  }) => Promise<LlmProfile>
  llmDeleteProfile: (profileId: string) => Promise<boolean>
  llmGetBindings: () => Promise<SmartFeatureBinding>
  llmSetBindings: (bindings: SmartFeatureBinding) => Promise<SmartFeatureBinding>
  smartRenamePreview: (sessionIds: string[]) => Promise<SmartRenameResult<Array<{
    id: string
    oldTitle: string
    newTitle: string
  }>>>
  smartRenameApply: (items: Array<{ id: string; newTitle: string }>) => Promise<SmartRenameResult<Array<{
    id: string
    newTitle: string
  }>>>
  onInsightsProgress: (callback: (data: { stage: string; current: number; total: number }) => void) => () => void

  // Global agent floating window
  agentGetStatus: () => Promise<{ available: boolean; binaryPath?: string; reason?: string; sessionId: string | null; busy: boolean }>
  agentToggleWindow: () => Promise<void>
  agentHideWindow: () => Promise<boolean>
  agentNewConversation: () => Promise<boolean>
  agentOpenHistory: () => Promise<boolean>
  agentSend: (prompt: string) => Promise<{ ok: boolean; error?: string }>
  agentCancel: () => Promise<boolean>
  onAgentEvent: (callback: (event: {
    type: 'init' | 'assistant-text' | 'tool-use' | 'result'
    sessionId?: string
    text?: string
    name?: string
    summary?: string
    ok?: boolean
    durationMs?: number
    costUsd?: number
    error?: string
  }) => void) => () => void

  // AnalysisScope / UsageFact data layer (renderer integration is intentionally deferred)
  getInsights: () => Promise<any>
  queryInsights: (
    scope: RendererAnalysisScope,
    dimension: RendererAnalysisDimension
  ) => Promise<RendererInsightsQueryResult>
  drilldownInsights: (
    scope: RendererAnalysisScope,
    dimension: RendererAnalysisDimension,
    key: string
  ) => Promise<RendererInsightsDrilldownSession[]>
  getInsightSessionEvents: (
    sessionId: string,
    scope: RendererAnalysisScope
  ) => Promise<RendererUsageFact[]>
  rebuildInsightsFacts: () => Promise<RendererUsageFactSyncResult>

  // Session Audit
  auditSession: (filePath: string) => Promise<any>

  // Context Inspector
  getContextInspector: (filePath: string) => Promise<any>

  // CLI
  cliGetStatus: () => Promise<{
    cliInstalled: boolean
    symlinkInstalled: boolean
    skillInstalled: boolean
    cliPath: string | null
    commandPath: string | null
    skillPath: string | null
  }>
  cliInstall: () => Promise<{ cliInstalled: boolean; skillInstalled: boolean; cliPath: string | null; cliManualInstall?: string; error?: string }>
  getDetectedTerminals: (force?: boolean) => Promise<Array<{
    id: string
    name: string
    path: string
    executable?: string
    commandSupport: 'stable' | 'conditional' | 'none'
    canRunCommand: boolean
    limitation?: string
    evidence: 'system-path' | 'app-path' | 'bundle-id' | 'executable'
  }>>
  getAppInfo: () => Promise<{ version: string; platform: string }>
  networkGetInfo: () => Promise<{
    localIps: string[]
    tailscaleIp: string | null
    publicIp: string | null
    hostname: string
    sshEnabled: boolean
  }>
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
