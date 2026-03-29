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
  userImages?: string[]
  pastedImageCount?: number
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }
  referencedFiles?: Array<{ path: string; actions: string[]; exists: boolean }>
  configFiles?: string[]
  libraryDirPath?: string
  libraryMdPath?: string
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
  preferences: { defaultViewMode: 'compact' | 'full'; terminalApp: 'Terminal' | 'iTerm2'; locale?: Locale }
}

interface SearchResult {
  sessionId: string
  filePath: string
  firstUserMessage: string
  matches: Array<{ text: string; timestamp: string }>
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

  initialize: () => Promise<void>
  selectSession: (filePath: string, allFilePaths?: string[], uniqueId?: string, branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) => Promise<void>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resumeSession: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<void>
  forkSession: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<void>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>) => Promise<void>
  setViewMode: (mode: ViewMode) => void
  setLocale: (locale: Locale) => void
  toggleTheme: () => void
  selectFolder: (folderId: string | null) => void
  toggleInfoPanel: () => void
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
}

export type { SessionSummary, SessionDetail, ParsedMessage, Folder, UserConfig, SearchResult, Highlight, Locale }

// Read localStorage at module load time — before first render, zero flicker
const LOCAL_CACHE_VERSION = 6 // bump: traceToRoot compact crossing + store field rename

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

function resolveTheme(): 'dark' | 'light' {
  try {
    const saved = localStorage.getItem('csm:theme')
    if (saved === 'dark' || saved === 'light') return saved
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch { return 'dark' }
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
  theme: resolveTheme(),
  selectedFolderId: null,
  infoPanelOpen: true,
  selectedSessionMdPath: null,
  activeSessionIds: new Set<string>(),

  initialize: async () => {
    const [sessions, config] = await Promise.all([
      window.api.loadAllSessions(),
      window.api.loadConfig()
    ])
    set({
      sessions,
      config,
      viewMode: config.preferences?.defaultViewMode || 'compact',
      locale: (config.preferences as any)?.locale || 'zh-CN',
      loading: false
    })
    try {
      localStorage.setItem('csm:sessions', JSON.stringify(sessions))
      localStorage.setItem('csm:config', JSON.stringify(config))
    } catch { /* quota exceeded */ }

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
      set((state) => ({
        sessions: [session as SessionSummary, ...state.sessions]
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
  },

  selectSession: async (filePath, allFilePaths?, uniqueId?, branchParentFilePaths?, branchPointUuid?, branchLeafUuid?) => {
    const detail = await window.api.loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid, branchLeafUuid)
    // Merge branch relationship fields from summary into detail (detail is freshly built and lacks them)
    if (detail && uniqueId) {
      const summary = get().sessions.find((s) => s.id === uniqueId)
      if (summary) {
        const d = detail as any
        if ((summary as any).branchParentId) d.branchParentId = (summary as any).branchParentId
        if ((summary as any).branchChildIds) d.branchChildIds = (summary as any).branchChildIds
        if ((summary as any).branchLeafUuid) d.branchLeafUuid = (summary as any).branchLeafUuid
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
    await window.api.resumeSession(sessionId, terminalApp, permissionMode, cwd)
    set((state) => {
      const next = new Set(state.activeSessionIds)
      next.add(sessionId)
      return { activeSessionIds: next }
    })
  },

  forkSession: async (sessionId, permissionMode?, cwd?) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    await window.api.forkSession(sessionId, terminalApp, permissionMode, cwd)
  },

  resumeBatch: async (sessions) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    await window.api.resumeBatch(sessions, terminalApp)
    set((state) => {
      const next = new Set(state.activeSessionIds)
      for (const s of sessions) next.add(s.sessionId)
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

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark'
    document.documentElement.setAttribute('data-theme', next)
    localStorage.setItem('csm:theme', next)
    set({ theme: next })
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
  }
}))
