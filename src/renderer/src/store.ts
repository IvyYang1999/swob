import { create } from 'zustand'
import {
  computeSections,
  sessionToMarkdown,
  downloadMarkdown,
  generateFilename
} from './utils/markdown'
import type { Locale } from './i18n'

// Note: computeSections, sessionToMarkdown, generateFilename still used by downloadSessionMarkdown

export type ViewMode = 'compact' | 'full' | 'markdown'

interface SessionSummary {
  id: string
  sessionId: string
  resumeSessionId?: string
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
  branchParentFilePaths?: string[]
  branchPointUuid?: string
  branchLeafUuid?: string
  branchParentId?: string
  branchChildIds?: string[]
  userImages?: string[]
  pastedImageCount?: number
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
  referencedFiles?: Array<{ path: string; actions: string[]; exists: boolean }>
  configFiles?: string[]
  libraryDirPath?: string
  libraryMdPath?: string
  canResume?: boolean
  resumeUnavailableReason?: string
  isRemote?: boolean
  remoteHost?: string
  source?: 'claude-code' | 'codex' | 'cursor' | 'opencode'
  claudeConfigDir?: string
}

interface ParsedMessage {
  uuid: string
  type: string
  subtype?: string
  timestamp: string
  role?: string
  textContent: string
  toolCalls: Array<{ id?: string; name: string; input: Record<string, unknown>; result?: string }>
  images: string[]
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
  isPreCompact: boolean
  isSidechain: boolean
  isSharedContext: boolean
  isSystemGenerated: boolean
  raw: unknown
}

interface SessionDetail extends SessionSummary {
  messages: ParsedMessage[]
}

interface Folder {
  id: string
  name: string
  parentId?: string | null
  sessionIds: string[]
  color?: string
  createdAt: string
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
  sessionMeta: Record<string, { customTitle?: string; notes?: string; highlights?: Highlight[] }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    resumeTerminal?: 'terminal-app' | 'iterm' | 'custom'
    resumeTerminalCommandTemplate?: string
    locale?: Locale
    sshConfig?: SshConfig
    projectViewMode?: 'folders' | 'paths'
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
}

interface AppState {
  sessions: SessionSummary[]
  selectedSession: SessionDetail | null
  selectedUniqueId: string | null
  config: UserConfig | null
  searchResults: SearchResult[]
  searchQuery: string
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
  insightsOpen: boolean
  toasts: ToastMessage[]

  initialize: () => Promise<void>
  selectSession: (filePath: string, allFilePaths?: string[], uniqueId?: string, branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) => Promise<void>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resumeSession: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<void>
  forkSession: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<void>
  buildResumeCommand: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<string>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>) => Promise<void>
  setViewMode: (mode: ViewMode) => void
  setLocale: (locale: Locale) => void
  themeMode: 'dark' | 'light' | 'system'
  setThemeMode: (mode: 'dark' | 'light' | 'system') => void
  toggleTheme: () => void
  selectFolder: (folderId: string | null) => void
  toggleInfoPanel: () => void
  toggleSettings: () => void
  toggleInsights: () => void
  savePreferences: (prefs: Record<string, unknown>) => Promise<void>
  createFolder: (name: string, color?: string, parentId?: string) => Promise<void>
  moveFolder: (folderId: string, newParentId: string | null, position?: 'before' | 'after' | 'inside', targetId?: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  addSessionToFolder: (folderId: string, sessionId: string) => Promise<void>
  removeSessionFromFolder: (folderId: string, sessionId: string) => Promise<void>
  setSessionMeta: (sessionId: string, meta: { customTitle?: string; notes?: string }) => Promise<void>
  addHighlight: (sessionId: string, highlight: Omit<Highlight, 'id' | 'createdAt'>) => Promise<void>
  removeHighlight: (sessionId: string, highlightId: string) => Promise<void>
  downloadSessionMarkdown: () => void
  // Toast
  showToast: (text: string, type?: 'info' | 'success' | 'error') => void
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
}

export type { SessionSummary, SessionDetail, ParsedMessage, Folder, UserConfig, SearchResult, Highlight, Locale, ToastMessage }

// Read localStorage at module load time — before first render, zero flicker
const LOCAL_CACHE_VERSION = 12 // refresh physical resume ids and transcript metadata

function hydrateFromCache(): { sessions: SessionSummary[]; config: UserConfig | null; loading: boolean; viewMode: ViewMode; locale: Locale } {
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
      return { sessions, config, loading: false, viewMode: config.preferences?.defaultViewMode || 'compact', locale: config.preferences?.locale || 'zh-CN' }
    }
  } catch { /* ignore */ }
  return { sessions: [], config: null, loading: true, viewMode: 'compact', locale: 'zh-CN' }
}

const hydrated = hydrateFromCache()

function resolveThemeMode(): 'dark' | 'light' | 'system' {
  try {
    const saved = localStorage.getItem('csm:themeMode')
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved
    const legacySaved = localStorage.getItem('csm:theme')
    if (legacySaved === 'dark' || legacySaved === 'light') return legacySaved
    return 'system'
  } catch { return 'system' }
}

function effectiveTheme(mode: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (mode === 'system') {
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
    } catch { return 'dark' }
  }
  return mode
}

export const useStore = create<AppState>((set, get) => ({
  sessions: hydrated.sessions,
  selectedSession: null,
  selectedUniqueId: null,
  config: hydrated.config,
  searchResults: [],
  searchQuery: '',
  loading: hydrated.loading,
  viewMode: hydrated.viewMode,
  locale: hydrated.locale,
  themeMode: resolveThemeMode(),
  theme: effectiveTheme(resolveThemeMode()),
  selectedFolderId: null,
  settingsOpen: false,
  insightsOpen: false,
  infoPanelOpen: true,
  selectedSessionMdPath: null,
  activeSessionIds: new Set<string>(),
  cloudSessionIds: new Set<string>(),
  sshConfig: null,
  sshModalOpen: false,
  toasts: [],

  initialize: async () => {
    try {
      const [sessions, config, sshConfig] = await Promise.all([
        window.api.loadAllSessions(),
        window.api.loadConfig(),
        (window.api as any).sshGetConfig?.() ?? null
      ])
      set({
        sessions,
        config,
        viewMode: config.preferences?.defaultViewMode || 'compact',
        locale: (config.preferences as any)?.locale || 'zh-CN',
        sshConfig: sshConfig ?? null,
        loading: false
      })
      try {
        localStorage.setItem('csm:sessions', JSON.stringify(sessions))
        localStorage.setItem('csm:config', JSON.stringify(config))
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
        set({ sessions: freshSessions, config: freshConfig })
        try {
          localStorage.setItem('csm:sessions', JSON.stringify(freshSessions))
          localStorage.setItem('csm:config', JSON.stringify(freshConfig))
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
        const detail = await window.api.loadSessionDetail(
          u.filePath, u.allFilePaths, u.branchParentFilePaths, u.branchPointUuid, u.branchLeafUuid
        )
        set({ selectedSession: detail as SessionDetail | null })
        // Library transcript is auto-updated by main process file watcher
        if (detail) {
          try {
            const mdPath = await window.api.libraryGetMdPath((detail as SessionDetail).sessionId)
            set({ selectedSessionMdPath: mdPath })
          } catch { /* ignore */ }
        }
      }
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

    // System theme change listener
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (get().themeMode === 'system') {
        const resolved = effectiveTheme('system')
        document.documentElement.setAttribute('data-theme', resolved)
        set({ theme: resolved })
      }
    })

    // Spotlight: navigate to session from spotlight window
    window.api.onSpotlightNavigate?.((sessionId: string) => {
      const { sessions, selectSession } = get()
      const session = sessions.find((s) => s.id === sessionId || s.sessionId === sessionId)
      if (session) {
        selectSession(session.filePath, session.allFilePaths, session.id)
      }
    })
    try {
      const pendingSessionId = await (window.api as any).spotlightConsumePendingNavigation?.()
      if (pendingSessionId) {
        const { sessions, selectSession } = get()
        const session = sessions.find((s) => s.id === pendingSessionId || s.sessionId === pendingSessionId)
        if (session) {
          selectSession(session.filePath, session.allFilePaths, session.id)
        }
      }
    } catch { /* ignore */ }
  },

  selectSession: async (filePath, allFilePaths?, uniqueId?, branchParentFilePaths?, branchPointUuid?, branchLeafUuid?) => {
    const detail = await window.api.loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid, branchLeafUuid)
    // Merge branch relationship fields from summary into detail (detail is freshly built and lacks them)
    if (detail && uniqueId) {
      const summary = get().sessions.find((s) => s.id === uniqueId)
      if (summary) {
        const d = detail as any
        d.id = summary.id
        d.sessionId = summary.sessionId
        d.resumeSessionId = summary.resumeSessionId
        d.filePath = summary.filePath
        d.allFilePaths = summary.allFilePaths
        d.branchParentFilePaths = summary.branchParentFilePaths
        d.branchPointUuid = summary.branchPointUuid
        d.branchParentId = summary.branchParentId
        d.branchChildIds = summary.branchChildIds
        d.branchLeafUuid = summary.branchLeafUuid
        d.libraryDirPath = summary.libraryDirPath
        d.libraryMdPath = summary.libraryMdPath
        d.isRemote = summary.isRemote
        d.remoteHost = summary.remoteHost
      }
    }
    set({ selectedSession: detail as SessionDetail | null, selectedUniqueId: uniqueId || null })
    // Get library markdown path for drag
    if (detail) {
      const d = detail as SessionDetail
      try {
        const mdPath = await window.api.libraryGetMdPath(d.sessionId)
        set({ selectedSessionMdPath: mdPath })
      } catch { /* ignore */ }
    }
  },

  search: async (query) => {
    if (!query.trim()) {
      set({ searchResults: [], searchQuery: '' })
      return
    }
    set({ searchQuery: query })
    const results = await window.api.searchSessions(query)
    set({ searchResults: results })
  },

  clearSearch: () => set({ searchResults: [], searchQuery: '' }),

  resumeSession: async (sessionId, permissionMode?, cwd?) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    const result = await window.api.resumeSession(sessionId, terminalApp, permissionMode, cwd)
    if (!result.ok) {
      get().showToast(result.reason || '此会话无法直接恢复', 'error')
      return
    }
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
      get().showToast(result.reason || '此会话无法直接恢复', 'error')
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
      const reason = blocked[0].reason || '部分会话无法直接恢复'
      get().showToast(blocked.length === 1 ? reason : `${blocked.length} 个会话无法直接恢复：${reason}`, 'error')
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

  setLocale: (locale) => {
    set({ locale })
    try {
      const cachedConfig = localStorage.getItem('csm:config')
      if (cachedConfig) {
        const config = JSON.parse(cachedConfig)
        config.preferences = { ...config.preferences, locale }
        localStorage.setItem('csm:config', JSON.stringify(config))
      }
    } catch { /* ignore */ }
  },

  setThemeMode: (mode) => {
    const resolved = effectiveTheme(mode)
    document.documentElement.setAttribute('data-theme', resolved)
    localStorage.setItem('csm:themeMode', mode)
    set({ themeMode: mode, theme: resolved })
  },

  toggleTheme: () => {
    const currentMode = get().themeMode
    const next = currentMode === 'dark' ? 'light' : currentMode === 'light' ? 'system' : 'dark'
    get().setThemeMode(next)
  },

  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen, insightsOpen: false })),
  toggleInsights: () => set((s) => ({ insightsOpen: !s.insightsOpen, settingsOpen: false })),

  savePreferences: async (prefs) => {
    const config = get().config
    if (!config) return
    const updated = { ...config, preferences: { ...config.preferences, ...prefs } }
    await window.api.saveConfig(updated)
    set({ config: updated as UserConfig })
  },

  selectFolder: (folderId) => set({ selectedFolderId: folderId }),
  toggleInfoPanel: () => set((state) => ({ infoPanelOpen: !state.infoPanelOpen })),

  createFolder: async (name, color, parentId) => {
    const config = await window.api.createFolder({
      name,
      color: color || null,
      parentId: parentId || null
    })
    set({ config: config as UserConfig })
  },
  moveFolder: async (folderId, newParentId, position?, targetId?) => {
    const config = await window.api.moveFolder(folderId, newParentId, position, targetId)
    set({ config: config as UserConfig })
  },
  deleteFolder: async (folderId) => {
    const config = await window.api.deleteFolder(folderId)
    set({ config: config as UserConfig, selectedFolderId: null })
  },
  renameFolder: async (folderId, name) => {
    const config = await window.api.renameFolder(folderId, name)
    set({ config: config as UserConfig })
  },
  addSessionToFolder: async (folderId, sessionId) => {
    const config = await window.api.addSessionToFolder(folderId, sessionId)
    set({ config: config as UserConfig })
  },
  removeSessionFromFolder: async (folderId, sessionId) => {
    const config = await window.api.removeSessionFromFolder(folderId, sessionId)
    set({ config: config as UserConfig })
  },
  setSessionMeta: async (sessionId, meta) => {
    const config = await window.api.setSessionMeta(sessionId, meta)
    set({ config: config as UserConfig })
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
    set({ config: updated as UserConfig })
  },
  removeHighlight: async (sessionId, highlightId) => {
    const config = get().config
    if (!config) return
    const existing = config.sessionMeta[sessionId]?.highlights || []
    const updated = await window.api.setSessionMeta(sessionId, {
      highlights: existing.filter(h => h.id !== highlightId)
    })
    set({ config: updated as UserConfig })
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
  showToast: (text, type = 'info') => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    set((state) => ({ toasts: [...state.toasts, { id, text, type }] }))
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
    showToast('正在触发 iCloud 下载...', 'info')
    const ok = await (window.api as any).icloudDownload?.(sessionId)
    const cloudIds: string[] = await (window.api as any).icloudScanCloudSessions?.() ?? []
    set({ cloudSessionIds: new Set(cloudIds) })
    if (ok) {
      showToast('已触发下载，iCloud 同步中', 'success')
    } else {
      showToast('下载触发失败', 'error')
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
  closeSshModal: () => set({ sshModalOpen: false })
}))
