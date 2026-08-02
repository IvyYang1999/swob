import { create } from 'zustand'
import {
  computeSections,
  sessionToMarkdown,
  downloadMarkdown,
  generateFilename
} from './utils/markdown'
import { resolveConfiguredLocale, resolveSystemLocale, translate, type LegacyLocale, type Locale } from './i18n'
import { defaultResumeMethodForSource } from '../../shared/settings-capabilities'
import { BUILTIN_LENSES, isLensEnabled } from '../../shared/lens-registry'
import { refreshHarnessIconOverrides } from './utils/harness-presentation'

// Note: computeSections, sessionToMarkdown, generateFilename still used by downloadSessionMarkdown

// Module-level unsubscribe handle for idempotent searchIndexUpdated subscription
let unsubscribeSearchIndex: (() => void) | undefined

export type ViewMode = 'compact' | 'full' | 'markdown'
export type ColorScheme = 'default' | 'paper' | 'nord'
export type ResumeSurface = 'terminal' | 'codex-desktop' | 'claude-desktop' | 'zcode-desktop' | 'remote-control'

interface SessionSummary {
  id: string
  sessionId: string
  resumeSessionId?: string
  successor?: string
  logicalSessionKey?: string
  duplicate?: boolean
  duplicatePackageCount?: number
  duplicatePackageHistory?: Array<{ createdAt: string; updatedAt: string; turnCount: number }>
  detailAvailability?: 'ready' | 'transcript-only' | 'source-recoverable' | 'unavailable'
  slug: string
  createdAt: string
  updatedAt: string
  messageCount: number
  turnCount: number
  compactCount: number
  cwds: string[]
  version: string
  firstUserMessage: string
  toolUsage: Record<string, number>
  skillInvocations: Array<{ skillName: string; timestamp: string; args?: string }>
  claudeMdContent?: string
  projectPath: string
  filePath: string
  fileSizeBytes: number
  allFilePaths?: string[]
  permissionMode?: string
  resumeCwd?: string
  lifecycleState?: 'active' | 'archived' | 'replayed'
  branchParentFilePaths?: string[]
  branchPointUuid?: string
  branchLeafUuid?: string
  branchParentId?: string
  branchChildIds?: string[]
  userImages?: string[]
  pastedImageCount?: number
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
  tokenAccounting?: {
    provenance: 'reported' | 'derived' | 'estimated' | 'unavailable'
    billingTotal: number | null
    conversationOnly: number | null
    unavailableReason?: string
  }
  referencedFiles?: Array<{ path: string; actions: string[]; exists: boolean }>
  configFiles?: string[]
  libraryDirPath?: string
  libraryMdPath?: string
  canResume?: boolean
  resumeUnavailableReason?: string
  isRemote?: boolean
  remoteHost?: string
  source?: string
  claudeConfigDir?: string
  estimatedTime?: number
  models?: string[]
}

interface ParsedMessage {
  uuid: string
  type: string
  subtype?: string
  timestamp: string
  textContent: string
  toolCalls: Array<{ id?: string; name: string; input: Record<string, unknown>; result?: string }>
  images: string[]
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
  isSidechain?: boolean
  isSharedContext?: boolean
  isSystemGenerated?: boolean
}

interface SessionDetail extends SessionSummary {
  messages: ParsedMessage[]
  detailFallback?: 'transcript'
  transcriptMarkdown?: string
  detailError?: 'DETAIL_UNAVAILABLE' | 'DETAIL_LOAD_FAILED'
}

type SessionDetailLoadResult =
  | (SessionDetail & { fallback: null; error?: never })
  | { fallback: 'transcript'; transcriptMarkdown: string; error?: never }
  | { fallback: null; error: 'DETAIL_UNAVAILABLE' | 'DETAIL_LOAD_FAILED' }

export function mergeSessionSummaryIntoDetail(
  detail: SessionDetail,
  summary: SessionSummary
): SessionDetail {
  return {
    ...detail,
    ...summary,
    // Summary owns the visible/logical identity, while the freshly parsed
    // detail owns fields intentionally omitted from lightweight projections.
    cwds: detail.cwds,
    toolUsage: detail.toolUsage,
    skillInvocations: detail.skillInvocations,
    claudeMdContent: detail.claudeMdContent,
    referencedFiles: detail.referencedFiles,
    configFiles: detail.configFiles,
    userImages: detail.userImages,
    pastedImageCount: detail.pastedImageCount,
    messages: detail.messages
  }
}

export function materializeSessionDetail(
  result: SessionDetailLoadResult,
  summary: SessionSummary
): SessionDetail {
  if (result.fallback === 'transcript') {
    return {
      ...summary,
      messages: [],
      detailAvailability: 'transcript-only',
      detailFallback: 'transcript',
      transcriptMarkdown: result.transcriptMarkdown
    }
  }
  if (result.error) {
    return {
      ...summary,
      messages: [],
      detailAvailability: summary.detailAvailability === 'source-recoverable'
        ? 'source-recoverable'
        : 'unavailable',
      detailError: result.error
    }
  }
  const { fallback: _fallback, ...detail } = result
  return {
    ...mergeSessionSummaryIntoDetail(detail, summary),
    detailAvailability: summary.detailAvailability || 'ready'
  }
}

interface Folder {
  id: string
  name: string
  parentId?: string | null
  sessionIds: string[]
  files?: VaultFile[]
  color?: string
  createdAt: string
}

interface VaultFile {
  name: string
  path: string
}

interface Highlight {
  id: string
  text: string
  turnUuid: string
  note?: string
  createdAt: string
}

interface UserConfig {
  folders: Folder[]
  rootFiles?: VaultFile[]
  sessionMeta: Record<string, {
    customTitle?: string
    notes?: string
    highlights?: Highlight[]
    tags?: string[]
    topic?: string
    topicConfidence?: number
  }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    resumeTerminal?: 'terminal-app' | 'iterm' | 'custom' | 'windows-terminal' | 'powershell' | 'cmd'
    resumeTerminalCommandTemplate?: string
    experimentalClaudeDesktopImport?: boolean
    locale?: LegacyLocale
    themeMode?: 'dark' | 'light' | 'system'
    colorScheme?: ColorScheme
    lightScheme?: ColorScheme
    darkScheme?: ColorScheme
    spotlightShortcut?: string
    sshConfig?: SshConfig
    projectViewMode?: 'folders' | 'paths'
    settingsSchemaVersion?: 1
    defaultTerminalId?: string
    resumeMethodByHarness?: Record<string, ResumeSurface>
    defaultSort?: import('../../shared/settings-capabilities').DefaultSort
    defaultGrouping?: import('../../shared/settings-capabilities').DefaultGrouping
    singleTurnBehavior?: import('../../shared/settings-capabilities').SingleTurnBehavior
    autoCheckUpdates?: boolean
    updateChannel?: import('../../shared/settings-capabilities').UpdateChannel
    // tF30: Lens platform preview
    enabledLenses?: string[] | null  // null/undefined = all enabled (backwards compat)
    lensOrder?: string[] | null      // custom ordering of lens cards
  }
}

// Background Library patches carry complete config snapshots that may have
// been read before a local preference write finished. Remember fields changed
// by this renderer and overlay them on every later snapshot for this app run.
let localPreferenceOverlay: Partial<UserConfig['preferences']> = {}
let preferenceWriteRevision = 0

function mergeLocalPreferences(config: UserConfig): UserConfig {
  if (Object.keys(localPreferenceOverlay).length === 0) return config
  return {
    ...config,
    preferences: { ...config.preferences, ...localPreferenceOverlay }
  }
}

export interface SshConfig {
  host: string
  user: string
  remotePath?: string
}

interface SearchResult {
  sessionId: string
  filePath: string
  firstUserMessage: string
  matches: Array<{ text: string; timestamp: string }>
}

export interface ToastMessage {
  id: string
  text: string
  type: 'info' | 'success' | 'error'
  action?: { label: string; onClick: () => void }
}

export interface OrganizationApplyItem {
  sessionId: string
  targetRelativeFolder: string
  topic?: string
  tags?: string[]
  confidence?: number
}

interface AppState {
  sessions: SessionSummary[]
  selectedSession: SessionDetail | null
  selectedUniqueId: string | null
  config: UserConfig | null
  searchResults: SearchResult[]
  searchQuery: string
  searchState: 'idle' | 'searching' | 'success' | 'empty' | 'error'
  loading: boolean
  viewMode: ViewMode
  locale: Locale
  theme: 'dark' | 'light'
  selectedFolderId: string | null
  infoPanelOpen: boolean
  selectedSessionMdPath: string | null
  activeSessionIds: Set<string>
  cloudSessionIds: Set<string>   // iCloud-only sessions not yet downloaded
  sshConfig: SshConfig | null
  sshModalOpen: boolean
  settingsOpen: boolean
  pendingSettingsCategory: string | null
  workspaceView: 'galaxy' | 'chat' | 'insights'
  toasts: ToastMessage[]

  initialize: () => Promise<void>
  openSession: (sessionId: string) => void
  selectSession: (filePath: string, allFilePaths?: string[], uniqueId?: string, branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) => Promise<void>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resumeSession: (sessionId: string, permissionMode?: string, cwd?: string, surface?: ResumeSurface) => Promise<void>
  forkSession: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<void>
  buildResumeCommand: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<string>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>) => Promise<void>
  setViewMode: (mode: ViewMode) => void
  setLocale: (locale: Locale) => Promise<void>
  colorScheme: ColorScheme
  themeMode: 'dark' | 'light' | 'system'
  setColorScheme: (scheme: ColorScheme) => void
  setThemeMode: (mode: 'dark' | 'light' | 'system') => void
  toggleTheme: () => void
  selectFolder: (folderId: string | null) => void
  toggleInfoPanel: () => void
  toggleSettings: () => void
  openSettingsAt: (category: string) => void
  consumePendingSettingsCategory: () => string | null
  setWorkspaceView: (view: 'galaxy' | 'chat' | 'insights') => void
  savePreferences: (prefs: Record<string, unknown>) => Promise<void>
  createFolder: (name: string, color?: string, parentId?: string) => Promise<void>
  moveFolder: (folderId: string, newParentId: string | null, position?: 'before' | 'after' | 'inside', targetId?: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  addSessionToFolder: (folderId: string, sessionId: string) => Promise<void>
  removeSessionFromFolder: (folderId: string, sessionId: string) => Promise<void>
  setSessionMeta: (sessionId: string, meta: {
    customTitle?: string
    notes?: string
    tags?: string[]
    topic?: string
    topicConfidence?: number
  }) => Promise<void>
  smartRenameSingle: (sessionId: string) => Promise<void>
  applyOrganization: (kind: 'project' | 'smart' | 'archive', items: OrganizationApplyItem[]) => Promise<number>
  undoLastOrganization: () => Promise<number>
  addHighlight: (sessionId: string, highlight: Omit<Highlight, 'id' | 'createdAt'>) => Promise<void>
  removeHighlight: (sessionId: string, highlightId: string) => Promise<void>
  downloadSessionMarkdown: () => void
  // Toast
  showToast: (text: string, type?: 'info' | 'success' | 'error', action?: ToastMessage['action']) => void
  dismissToast: (id: string) => void
  // iCloud
  refreshCloudSessions: () => Promise<void>
  downloadCloudSession: (sessionId: string) => Promise<void>
  // SSH
  setSshConfig: (config: SshConfig | null) => Promise<void>
  sshResumeSession: (sessionId: string, permissionMode?: string) => Promise<void>
  sshForkSession: (sessionId: string, permissionMode?: string) => Promise<void>
  sshBuildCommand: (sessionId: string, permissionMode?: string) => Promise<string | null>
  openSshModal: () => void
  closeSshModal: () => void
  // tF30: Lens
  toggleLens: (lensId: string) => void
  reorderLenses: (orderedIds: string[]) => void
}

export type { SessionSummary, SessionDetail, ParsedMessage, Folder, VaultFile, UserConfig, SearchResult, Highlight, Locale }

// Read localStorage at module load time — before first render, zero flicker
const LOCAL_CACHE_VERSION = 12 // refresh physical resume ids and transcript metadata

function rendererSystemLocale(): Locale {
  try {
    return resolveSystemLocale(navigator.languages?.length ? navigator.languages : [navigator.language])
  } catch {
    return 'en'
  }
}

function hydrateFromCache(): { sessions: SessionSummary[]; config: UserConfig | null; loading: boolean; viewMode: ViewMode; locale: Locale } {
  const systemLocale = rendererSystemLocale()
  try {
    const ver = localStorage.getItem('csm:cacheVersion')
    if (ver !== String(LOCAL_CACHE_VERSION)) {
      localStorage.removeItem('csm:sessions')
      localStorage.setItem('csm:cacheVersion', String(LOCAL_CACHE_VERSION))
    }
    const cached = localStorage.getItem('csm:sessions')
    const cachedConfig = localStorage.getItem('csm:config')
    if (cached && cachedConfig) {
      const sessions = JSON.parse(cached)
      const config = JSON.parse(cachedConfig)
      return {
        sessions,
        config,
        loading: false,
        viewMode: config.preferences?.defaultViewMode || 'compact',
        locale: resolveConfiguredLocale(config.preferences?.locale, systemLocale)
      }
    }
  } catch { /* ignore */ }
  return { sessions: [], config: null, loading: true, viewMode: 'compact', locale: systemLocale }
}

const hydrated = hydrateFromCache()
if (typeof document !== 'undefined') document.documentElement.lang = hydrated.locale

function resolveThemeMode(): 'dark' | 'light' | 'system' {
  try {
    const saved = localStorage.getItem('csm:themeMode')
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved
    const legacySaved = localStorage.getItem('csm:theme')
    if (legacySaved === 'dark' || legacySaved === 'light') return legacySaved
    return 'system'
  } catch { return 'system' }
}

function resolveColorScheme(): ColorScheme {
  try {
    const saved = localStorage.getItem('csm:colorScheme')
    if (saved === 'paper' || saved === 'nord') return saved
    return 'default'
  } catch { return 'default' }
}

function effectiveTheme(mode: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (mode === 'system') {
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    } catch { return 'dark' }
  }
  return mode
}

function validColorScheme(value: unknown): ColorScheme | undefined {
  return value === 'default' || value === 'paper' || value === 'nord' ? value : undefined
}

function colorSchemeForTheme(
  preferences: UserConfig['preferences'] | undefined,
  theme: 'dark' | 'light',
  fallback: ColorScheme
): ColorScheme {
  const paired = theme === 'dark' ? preferences?.darkScheme : preferences?.lightScheme
  return validColorScheme(paired) || validColorScheme(preferences?.colorScheme) || fallback
}

const initialThemeMode = resolveThemeMode()
const initialTheme = effectiveTheme(initialThemeMode)
const initialColorScheme = colorSchemeForTheme(
  hydrated.config?.preferences,
  initialTheme,
  resolveColorScheme()
)

export const useStore = create<AppState>((set, get) => ({
  sessions: hydrated.sessions,
  selectedSession: null,
  selectedUniqueId: null,
  config: hydrated.config,
  searchResults: [],
  searchQuery: '',
  searchState: 'idle' as const,
  loading: hydrated.loading,
  viewMode: hydrated.viewMode,
  locale: hydrated.locale,
  colorScheme: initialColorScheme,
  themeMode: initialThemeMode,
  theme: initialTheme,
  selectedFolderId: null,
  settingsOpen: false,
  pendingSettingsCategory: null,
  workspaceView: isLensEnabled('galaxy', hydrated.config?.preferences || {}) ? 'galaxy' : 'chat',
  infoPanelOpen: true,
  selectedSessionMdPath: null,
  activeSessionIds: new Set<string>(),
  cloudSessionIds: new Set<string>(),
  sshConfig: null,
  sshModalOpen: false,
  toasts: [],

  initialize: async () => {
    let initialLoadComplete = false
    let queuedLibraryConfig: UserConfig | undefined
    const queuedLibrarySessions = new Map<string, SessionSummary>()
    const applyLibraryPatch = (patch: SessionSummary[], config?: UserConfig): void => {
      if (!initialLoadComplete) {
        for (const session of patch) queuedLibrarySessions.set(session.id, session)
        if (config) queuedLibraryConfig = config
        return
      }
      set((state) => {
        const byId = new Map(state.sessions.map((session) => [session.id, session]))
        for (const session of patch) byId.set(session.id, session)
        return {
          sessions: [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
          config: config ? mergeLocalPreferences(config) : state.config
        }
      })
    }
    window.api.onLibraryPatch(({ sessions, config }) => {
      applyLibraryPatch(sessions as SessionSummary[], config as UserConfig | undefined)
    })

    try {
      const [sessions, config, sshConfig, systemLocale] = await Promise.all([
        window.api.loadAllSessions(),
        window.api.loadConfig(),
        (window.api as any).sshGetConfig?.() ?? null,
        window.api.getSystemLocale()
      ])
      const mergedSessions = new Map((sessions as SessionSummary[]).map((session) => [session.id, session]))
      for (const session of queuedLibrarySessions.values()) mergedSessions.set(session.id, session)
      initialLoadComplete = true
      const hydratedSessions = [...mergedSessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      let hydratedConfig = (queuedLibraryConfig || config) as UserConfig
      const locale = resolveConfiguredLocale(hydratedConfig.preferences?.locale, systemLocale)
      if (hydratedConfig.preferences?.locale === 'ja') {
        hydratedConfig = {
          ...hydratedConfig,
          preferences: { ...hydratedConfig.preferences, locale }
        }
        await window.api.saveConfig(hydratedConfig)
      }
      document.documentElement.lang = locale
      try {
        await refreshHarnessIconOverrides()
      } catch { /* custom icons are optional; bundled glyphs remain available */ }
      set({
        sessions: hydratedSessions,
        config: hydratedConfig,
        viewMode: hydratedConfig.preferences?.defaultViewMode || 'compact',
        locale,
        sshConfig: sshConfig ?? null,
        loading: false
      })
      const prefThemeMode = hydratedConfig.preferences?.themeMode
      const nextThemeMode = prefThemeMode === 'light' || prefThemeMode === 'dark' || prefThemeMode === 'system'
        ? prefThemeMode
        : get().themeMode
      const resolvedTheme = effectiveTheme(nextThemeMode)
      const resolvedScheme = colorSchemeForTheme(hydratedConfig.preferences, resolvedTheme, get().colorScheme)
      document.documentElement.dataset.theme = resolvedTheme
      document.documentElement.dataset.colorScheme = resolvedScheme
      localStorage.setItem('csm:themeMode', nextThemeMode)
      localStorage.setItem('csm:colorScheme', resolvedScheme)
      set({ themeMode: nextThemeMode, theme: resolvedTheme, colorScheme: resolvedScheme })
      try {
        localStorage.setItem('csm:sessions', JSON.stringify(hydratedSessions))
        localStorage.setItem('csm:config', JSON.stringify(hydratedConfig))
      } catch { /* quota exceeded */ }
    } catch (err) {
      console.error('Failed to initialize:', err)
      set({ loading: false })
    }

    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const debouncedRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(async () => {
        const [freshSessions, freshConfig] = await Promise.all([
          window.api.loadAllSessions(),
          window.api.loadConfig()
        ])
        const mergedConfig = mergeLocalPreferences(freshConfig)
        set({ sessions: freshSessions, config: mergedConfig })
        try {
          localStorage.setItem('csm:sessions', JSON.stringify(freshSessions))
          localStorage.setItem('csm:config', JSON.stringify(mergedConfig))
        } catch { /* quota exceeded */ }
      }, 500)
    }

    window.api.onSessionAdded((session) => {
      const incoming = session as SessionSummary
      set((state) => ({
        sessions: [
          incoming,
          ...state.sessions.filter((s) => s.id !== incoming.id && s.sessionId !== incoming.sessionId)
        ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      }))
    })
    window.api.onSessionUpdated(async (updated) => {
      const u = updated as SessionSummary
      set((state) => ({
        sessions: state.sessions.map((s) => s.id === u.id ? u : s)
      }))
      // Auto-reload detail if this is the currently selected session
      const current = get().selectedSession
      if (current && current.id === u.id) {
        const result = await window.api.loadSessionDetail(
          u.filePath, u.allFilePaths, u.branchParentFilePaths, u.branchPointUuid, u.branchLeafUuid, u.id
        ) as SessionDetailLoadResult
        const detail = materializeSessionDetail(result, u)
        set({ selectedSession: detail })
        // Library transcript is auto-updated by main process file watcher
        try {
          const mdPath = await window.api.libraryGetMdPath(detail.sessionId)
          set({ selectedSessionMdPath: mdPath })
        } catch { /* ignore */ }
      }
    })
    window.api.onSessionSummaryUpdated((updated) => {
      const summary = updated as SessionSummary
      set((state) => ({
        sessions: state.sessions.map((session) => session.id === summary.id ? summary : session),
        selectedSession: state.selectedSession?.id === summary.id
          ? mergeSessionSummaryIntoDetail(state.selectedSession, summary)
          : state.selectedSession
      }))
    })
    window.api.onSessionsRefresh(() => {
      debouncedRefresh()
    })
    // Initialize active session detection
    try {
      const activeIds = await window.api.getActiveSessions()
      set({ activeSessionIds: new Set(activeIds) })
    } catch { /* ignore */ }
    window.api.onActiveSessionsChanged((ids) => {
      set({ activeSessionIds: new Set(ids) })
    })

    // Replay current search when t192 backend refreshes the search index.
    // Guard against stale results: capture query at invocation time and only
    // apply results if the query hasn't changed while the IPC was in flight.
    // The optional-chaining + unsubscribe storage ensures idempotent re-entry.
    if (unsubscribeSearchIndex) unsubscribeSearchIndex()
    unsubscribeSearchIndex = window.api.onSearchIndexUpdated?.(() => {
      const queryAtInvocation = get().searchQuery
      if (!queryAtInvocation) return
      window.api.searchSessions(queryAtInvocation).then((results) => {
        if (get().searchQuery === queryAtInvocation) {
          set({
            searchResults: results,
            searchState: (results as unknown[]).length > 0 ? 'success' : 'empty'
          })
        }
      }).catch(() => {
        if (get().searchQuery === queryAtInvocation) {
          set({ searchResults: [], searchState: 'error' })
        }
      })
    }) ?? undefined

    // System theme change listener
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (get().themeMode === 'system') {
        const resolved = effectiveTheme('system')
        const scheme = colorSchemeForTheme(get().config?.preferences, resolved, get().colorScheme)
        document.documentElement.setAttribute('data-theme', resolved)
        document.documentElement.dataset.colorScheme = scheme
        localStorage.setItem('csm:colorScheme', scheme)
        set({ theme: resolved, colorScheme: scheme })
      }
    })

    // Spotlight: navigate to session from spotlight window
    window.api.onSpotlightNavigate?.((sessionId: string) => {
      get().openSession(sessionId)
    })
    try {
      const pendingSessionId = await (window.api as any).spotlightConsumePendingNavigation?.()
      if (pendingSessionId) {
        get().openSession(pendingSessionId)
      }
    } catch { /* ignore */ }
  },

  openSession: (sessionId) => {
    const { sessions, selectSession, clearSearch, showToast } = get()
    const session = sessions.find(
      (s) => s.id === sessionId || s.sessionId === sessionId || s.filePath === sessionId
    )
    if (!session) {
      showToast(
        translate(get().locale, 'renderer.store.session_not_found'),
        'error'
      )
      return
    }
    set({ workspaceView: 'chat', settingsOpen: false })
    clearSearch()
    void selectSession(
      session.filePath,
      session.allFilePaths,
      session.id,
      session.branchParentFilePaths,
      session.branchPointUuid,
      session.branchLeafUuid
    )
  },

  selectSession: async (filePath, allFilePaths?, uniqueId?, branchParentFilePaths?, branchPointUuid?, branchLeafUuid?) => {
    const result = await window.api.loadSessionDetail(
      filePath,
      allFilePaths,
      branchParentFilePaths,
      branchPointUuid,
      branchLeafUuid,
      uniqueId
    ) as SessionDetailLoadResult
    const summary = get().sessions.find((session) =>
      session.id === uniqueId || session.filePath === filePath
    )
    if (!summary) {
      set({ selectedSession: null, selectedUniqueId: uniqueId || null })
      return
    }
    const detail = materializeSessionDetail(result, summary)
    set({ selectedSession: detail, selectedUniqueId: uniqueId || null })
    // Get library markdown path for drag
    try {
      const mdPath = await window.api.libraryGetMdPath(detail.sessionId)
      set({ selectedSessionMdPath: mdPath })
    } catch { /* ignore */ }
  },

  search: async (query) => {
    if (!query.trim()) {
      set({ searchResults: [], searchQuery: '', searchState: 'idle' })
      return
    }
    const queryAtInvocation = query
    set({ searchQuery: query, searchState: 'searching' })
    try {
      const results = await window.api.searchSessions(query)
      // Discard stale results if the query changed during the async call
      if (get().searchQuery !== queryAtInvocation) return
      set({
        searchResults: results,
        searchState: results.length > 0 ? 'success' : 'empty'
      })
    } catch {
      if (get().searchQuery !== queryAtInvocation) return
      set({ searchResults: [], searchState: 'error' })
    }
  },

  clearSearch: () => set({ searchResults: [], searchQuery: '', searchState: 'idle' }),

  resumeSession: async (sessionId, permissionMode?, cwd?, surface?) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    const matchedSession = get().sessions.find((session) =>
      session.id === sessionId || session.sessionId === sessionId || session.resumeSessionId === sessionId
    )
    const effectiveSurface = surface || defaultResumeMethodForSource(
      get().config?.preferences as unknown as Record<string, unknown>,
      matchedSession?.source
    ) as ResumeSurface
    const result = await window.api.resumeSession(
      sessionId,
      terminalApp,
      permissionMode,
      cwd,
      effectiveSurface
    )
    if (!result.ok) {
      get().showToast(
        result.reasonCode
          ? translate(get().locale, result.reasonCode, result.reasonParams)
          : result.reason || translate(get().locale, 'renderer.store.resume_unavailable'),
        'error'
      )
      return
    }
    if (result.noticeCode) get().showToast(translate(get().locale, result.noticeCode), 'info')
    else if (result.notice) get().showToast(result.notice, 'info')
    if (effectiveSurface === 'zcode-desktop') return
    set((state) => {
      const next = new Set(state.activeSessionIds)
      next.add(sessionId)
      return { activeSessionIds: next }
    })
  },

  forkSession: async (sessionId, permissionMode?, cwd?) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    const result = await window.api.forkSession(sessionId, terminalApp, permissionMode, cwd)
    if (!result.ok) {
      get().showToast(result.reasonCode
        ? translate(get().locale, result.reasonCode, result.reasonParams)
        : result.reason || translate(get().locale, 'renderer.store.resume_unavailable'), 'error')
    }
  },

  buildResumeCommand: async (sessionId, permissionMode?, cwd?) => {
    return window.api.buildResumeCommand(sessionId, permissionMode, cwd)
  },

  resumeBatch: async (sessions) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    const results = await window.api.resumeBatch(sessions, terminalApp)
    const blocked = results.filter((r) => !r.ok)
    if (blocked.length > 0) {
      const firstBlocked = blocked[0]
      const reason = firstBlocked.reasonCode
        ? translate(get().locale, firstBlocked.reasonCode, firstBlocked.reasonParams)
        : firstBlocked.reason || translate(get().locale, 'renderer.store.some_resume_unavailable')
      get().showToast(blocked.length === 1 ? reason : translate(get().locale, 'renderer.store.batch_resume_unavailable', { value0: blocked.length, value1: reason }), 'error')
    }
    set((state) => {
      const next = new Set(state.activeSessionIds)
      for (let i = 0; i < sessions.length; i++) {
        if (results[i]?.ok) next.add(sessions[i].sessionId)
      }
      return { activeSessionIds: next }
    })
  },

  setViewMode: (mode) => set({ viewMode: mode }),

  setLocale: async (locale) => {
    try {
      if (get().config) {
        await get().savePreferences({ locale })
        const savedConfig = get().config
        localStorage.setItem('csm:config', JSON.stringify(savedConfig))
        document.documentElement.lang = locale
        set({ locale })
      } else {
        document.documentElement.lang = locale
        set({ locale })
      }
    } catch (error) {
      console.error('Failed to persist locale:', error)
    }
  },

  setColorScheme: (scheme) => {
    document.documentElement.dataset.colorScheme = scheme
    localStorage.setItem('csm:colorScheme', scheme)
    set({ colorScheme: scheme })
    void get().savePreferences({ colorScheme: scheme })
  },

  setThemeMode: (mode) => {
    const resolved = effectiveTheme(mode)
    const scheme = colorSchemeForTheme(get().config?.preferences, resolved, get().colorScheme)
    document.documentElement.setAttribute('data-theme', resolved)
    document.documentElement.dataset.colorScheme = scheme
    localStorage.setItem('csm:themeMode', mode)
    localStorage.setItem('csm:colorScheme', scheme)
    set({ themeMode: mode, theme: resolved, colorScheme: scheme })
    void get().savePreferences({ themeMode: mode })
  },

  toggleTheme: () => {
    const currentMode = get().themeMode
    const next = currentMode === 'dark' ? 'light' : currentMode === 'light' ? 'system' : 'dark'
    get().setThemeMode(next)
  },

  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, workspaceView: 'chat' })),
  openSettingsAt: (category) => set({
    settingsOpen: true, workspaceView: 'chat', pendingSettingsCategory: category
  }),
  consumePendingSettingsCategory: () => {
    const pending = get().pendingSettingsCategory
    if (pending) set({ pendingSettingsCategory: null })
    return pending
  },
  setWorkspaceView: (view) => set((s) => {
    const preferences = s.config?.preferences || {}
    const allowed = view === 'galaxy'
      ? isLensEnabled('galaxy', preferences)
      : view === 'insights'
        ? isLensEnabled('token-insights', preferences) || isLensEnabled('audit', preferences)
        : true
    return {
      workspaceView: allowed && s.workspaceView !== view ? view : 'chat',
      settingsOpen: false
    }
  }),

  savePreferences: async (prefs) => {
    const config = get().config
    if (!config) return
    const previousOverlay = localPreferenceOverlay
    localPreferenceOverlay = { ...localPreferenceOverlay, ...prefs } as Partial<UserConfig['preferences']>
    const revision = ++preferenceWriteRevision
    const updated = { ...config, preferences: { ...config.preferences, ...prefs } }
    // Update controlled settings immediately. Besides avoiding a visible
    // snap-back while the Library writer publishes its patch, this ensures a
    // second rapid preference change merges on top of the first one.
    set({ config: updated as UserConfig })
    try {
      await window.api.saveConfig(updated)
    } catch (error) {
      if (revision === preferenceWriteRevision) {
        localPreferenceOverlay = previousOverlay
        set((state) => state.config ? {
          config: { ...state.config, preferences: config.preferences }
        } : {})
      }
      throw error
    }
  },

  selectFolder: (folderId) => set({ selectedFolderId: folderId }),
  toggleInfoPanel: () => set((state) => ({ infoPanelOpen: !state.infoPanelOpen })),

  createFolder: async (name, color, parentId) => {
    const config = await window.api.createFolder({
      name,
      color: color || null,
      parentId: parentId || null
    })
    set({ config: mergeLocalPreferences(config as UserConfig) })
  },
  moveFolder: async (folderId, newParentId, position?, targetId?) => {
    const config = await window.api.moveFolder(folderId, newParentId, position, targetId)
    set({ config: mergeLocalPreferences(config as UserConfig) })
  },
  deleteFolder: async (folderId) => {
    const config = await window.api.deleteFolder(folderId)
    set({ config: mergeLocalPreferences(config as UserConfig), selectedFolderId: null })
  },
  renameFolder: async (folderId, name) => {
    const config = await window.api.renameFolder(folderId, name)
    set({ config: mergeLocalPreferences(config as UserConfig) })
  },
  addSessionToFolder: async (folderId, sessionId) => {
    const config = await window.api.addSessionToFolder(folderId, sessionId)
    set({ config: mergeLocalPreferences(config as UserConfig) })
  },
  removeSessionFromFolder: async (folderId, sessionId) => {
    const config = await window.api.removeSessionFromFolder(folderId, sessionId)
    set({ config: mergeLocalPreferences(config as UserConfig) })
  },
  setSessionMeta: async (sessionId, meta) => {
    const config = await window.api.setSessionMeta(sessionId, meta)
    set({ config: mergeLocalPreferences(config as UserConfig) })
  },
  smartRenameSingle: async (sessionId) => {
    const { showToast } = get()
    const previousTitle = get().config?.sessionMeta[sessionId]?.customTitle || ''
    try {
      const preview = await window.api.smartRenamePreview([sessionId])
      if (!preview.ok) {
        const needsSetup = ['PROFILE_NOT_BOUND', 'PROFILE_KEY_MISSING', 'INVALID_PROFILE', 'PROFILE_NOT_FOUND']
          .includes(preview.error.code)
        showToast(
          translate(get().locale, 'renderer.store.smart_rename_failed', {
            value0: translate(get().locale, `smart_rename.error.${preview.error.code}`)
          }),
          'error',
          needsSetup ? { label: translate(get().locale, 'renderer.store.open_settings'), onClick: () => get().openSettingsAt('ai') } : undefined
        )
        return
      }
      const item = preview.items[0]
      if (!item || !item.newTitle || item.newTitle === item.oldTitle) {
        showToast(translate(get().locale, 'renderer.store.title_already_good'), 'info')
        return
      }
      const applied = await window.api.smartRenameApply([{ id: item.id, newTitle: item.newTitle }])
      if (!applied.ok) {
        showToast(translate(get().locale, 'renderer.store.smart_rename_failed', {
          value0: translate(get().locale, `smart_rename.error.${applied.error.code}`)
        }), 'error')
        return
      }
      if (applied.config) set({ config: mergeLocalPreferences(applied.config as UserConfig) })
      showToast(translate(get().locale, 'renderer.store.renamed', { value0: item.newTitle }), 'success', {
        label: translate(get().locale, 'renderer.store.undo'),
        onClick: () => { void get().setSessionMeta(sessionId, { customTitle: previousTitle }) }
      })
    } catch (error) {
      showToast(translate(get().locale, 'renderer.store.smart_rename_failed', { value0: error instanceof Error ? error.message : String(error) }), 'error')
    }
  },
  applyOrganization: async (kind, items) => {
    const result = await window.api.organizerApply(kind, items)
    set({ config: mergeLocalPreferences(result.config as UserConfig) })
    const moved = result.moves.length
    if (moved > 0) {
      get().showToast(translate(get().locale, 'renderer.store.organized', { value0: moved }), 'success', {
        label: translate(get().locale, 'renderer.store.undo'),
        onClick: () => { void get().undoLastOrganization() }
      })
    } else {
      get().showToast(translate(get().locale, 'renderer.store.already_organized'), 'info')
    }
    return moved
  },
  undoLastOrganization: async () => {
    const result = await window.api.organizerUndo()
    set({ config: mergeLocalPreferences(result.config as UserConfig) })
    const moved = result.moves.length
    get().showToast(moved > 0
      ? translate(get().locale, 'renderer.store.organization_undone', { value0: moved })
      : translate(get().locale, 'renderer.store.nothing_to_undo'), moved > 0 ? 'success' : 'info')
    return moved
  },
  addHighlight: async (sessionId, highlight) => {
    const config = get().config
    if (!config) return
    const existing = config.sessionMeta[sessionId]?.highlights || []
    const newHighlight: Highlight = {
      ...highlight,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }
    const updated = await window.api.setSessionMeta(sessionId, {
      highlights: [...existing, newHighlight]
    })
    set({ config: mergeLocalPreferences(updated as UserConfig) })
  },
  removeHighlight: async (sessionId, highlightId) => {
    const config = get().config
    if (!config) return
    const existing = config.sessionMeta[sessionId]?.highlights || []
    const updated = await window.api.setSessionMeta(sessionId, {
      highlights: existing.filter(h => h.id !== highlightId)
    })
    set({ config: mergeLocalPreferences(updated as UserConfig) })
  },

  downloadSessionMarkdown: () => {
    const session = get().selectedSession
    if (!session) return
    const config = get().config
    const locale = get().locale
    const customTitle = config?.sessionMeta?.[session.sessionId]?.customTitle
    const sections = computeSections(session, locale)
    const md = sessionToMarkdown(session, sections, customTitle, locale)
    const filename = generateFilename(session)
    downloadMarkdown(`${filename}.md`, md)
  },

  // Toast
  showToast: (text, type = 'info', action) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    set((state) => ({ toasts: [...state.toasts, { id, text, type, action }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
    }, 5000)
  },
  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }))
  },

  // iCloud
  refreshCloudSessions: async () => {
    const cloudIds: string[] = await (window.api as any).icloudScanCloudSessions?.() ?? []
    set({ cloudSessionIds: new Set(cloudIds) })
  },

  downloadCloudSession: async (sessionId: string) => {
    const { showToast } = get()
    showToast(translate(get().locale, 'renderer.store.icloud_triggering'), 'info')
    const ok = await (window.api as any).icloudDownload?.(sessionId)
    const cloudIds: string[] = await (window.api as any).icloudScanCloudSessions?.() ?? []
    set({ cloudSessionIds: new Set(cloudIds) })
    if (ok) {
      showToast(translate(get().locale, 'renderer.store.icloud_syncing'), 'success')
    } else {
      showToast(translate(get().locale, 'renderer.store.icloud_failed'), 'error')
    }
  },

  // SSH
  setSshConfig: async (config) => {
    await (window.api as any).sshSetConfig?.(config)
    set({ sshConfig: config })
  },

  sshResumeSession: async (sessionId, permissionMode) => {
    await (window.api as any).sshResume?.(sessionId, permissionMode)
  },

  sshForkSession: async (sessionId, permissionMode) => {
    await (window.api as any).sshFork?.(sessionId, permissionMode)
  },

  sshBuildCommand: async (sessionId, permissionMode) => {
    return (window.api as any).sshBuildCommand?.(sessionId, permissionMode) ?? null
  },

  openSshModal: () => set({ sshModalOpen: true }),
  closeSshModal: () => set({ sshModalOpen: false }),

  // tF30: Lens
  toggleLens: (lensId) => {
    const config = get().config
    if (!config) return
    const allIds = BUILTIN_LENSES.map((lens) => lens.id)
    if (!allIds.includes(lensId)) return
    const current = config.preferences.enabledLenses ?? allIds
    const next = current.includes(lensId)
      ? current.filter((id) => id !== lensId)
      : [...current, lensId]
    const currentView = get().workspaceView
    const routeInvalid = (currentView === 'galaxy' && !next.includes('galaxy')) ||
      (currentView === 'insights' && !next.includes('token-insights') && !next.includes('audit'))
    if (routeInvalid) set({ workspaceView: 'chat' })
    void get().savePreferences({ enabledLenses: next })
  },
  reorderLenses: (orderedIds) => {
    const known = BUILTIN_LENSES.map((lens) => lens.id)
    const sanitized = [...new Set(orderedIds.filter((id) => known.includes(id)))]
    for (const id of known) if (!sanitized.includes(id)) sanitized.push(id)
    void get().savePreferences({ lensOrder: sanitized })
  }
}))
