import { create } from 'zustand'
import {
  computeSections,
  sessionToMarkdown,
  downloadMarkdown,
  generateFilename
} from './utils/markdown'

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
  branchParentFilePaths?: string[]
  branchPointUuid?: string
  userImages?: string[]
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
  isPreCompact: boolean
  isSidechain: boolean
  isSharedContext: boolean
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

interface UserConfig {
  folders: Folder[]
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>
  preferences: { defaultViewMode: 'compact' | 'full'; terminalApp: 'Terminal' | 'iTerm2' }
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
  selectedFolderId: string | null
  infoPanelOpen: boolean
  selectedSessionMdPath: string | null
  resumedSessionIds: Set<string>

  initialize: () => Promise<void>
  selectSession: (filePath: string, allFilePaths?: string[], uniqueId?: string, branchParentFilePaths?: string[], branchPointUuid?: string) => Promise<void>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resumeSession: (sessionId: string, permissionMode?: string, cwd?: string) => Promise<void>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>) => Promise<void>
  setViewMode: (mode: ViewMode) => void
  selectFolder: (folderId: string | null) => void
  toggleInfoPanel: () => void
  createFolder: (name: string, color?: string, parentId?: string) => Promise<void>
  moveFolder: (folderId: string, newParentId: string | null, position?: 'before' | 'after' | 'inside', targetId?: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  addSessionToFolder: (folderId: string, sessionId: string) => Promise<void>
  removeSessionFromFolder: (folderId: string, sessionId: string) => Promise<void>
  setSessionMeta: (sessionId: string, meta: { customTitle?: string; notes?: string }) => Promise<void>
  downloadSessionMarkdown: () => void
}

export type { SessionSummary, SessionDetail, ParsedMessage, Folder, UserConfig, SearchResult }

// Read localStorage at module load time — before first render, zero flicker
function hydrateFromCache(): { sessions: SessionSummary[]; config: UserConfig | null; loading: boolean; viewMode: ViewMode } {
  try {
    const cached = localStorage.getItem('csm:sessions')
    const cachedConfig = localStorage.getItem('csm:config')
    if (cached && cachedConfig) {
      const sessions = JSON.parse(cached)
      const config = JSON.parse(cachedConfig)
      return { sessions, config, loading: false, viewMode: config.preferences?.defaultViewMode || 'compact' }
    }
  } catch { /* ignore */ }
  return { sessions: [], config: null, loading: true, viewMode: 'compact' }
}

const hydrated = hydrateFromCache()

export const useStore = create<AppState>((set, get) => ({
  sessions: hydrated.sessions,
  selectedSession: null,
  selectedUniqueId: null,
  config: hydrated.config,
  searchResults: [],
  searchQuery: '',
  loading: hydrated.loading,
  viewMode: hydrated.viewMode,
  selectedFolderId: null,
  infoPanelOpen: true,
  selectedSessionMdPath: null,
  resumedSessionIds: new Set<string>(),

  initialize: async () => {
    const [sessions, config] = await Promise.all([
      window.api.loadAllSessions(),
      window.api.loadConfig()
    ])
    set({
      sessions,
      config,
      viewMode: config.preferences?.defaultViewMode || 'compact',
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
          u.filePath, u.allFilePaths, u.branchParentFilePaths, u.branchPointUuid
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
  },

  selectSession: async (filePath, allFilePaths?, uniqueId?, branchParentFilePaths?, branchPointUuid?) => {
    const detail = await window.api.loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid)
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
      const next = new Set(state.resumedSessionIds)
      next.add(sessionId)
      return { resumedSessionIds: next }
    })
  },

  resumeBatch: async (sessions) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    await window.api.resumeBatch(sessions, terminalApp)
    set((state) => {
      const next = new Set(state.resumedSessionIds)
      for (const s of sessions) next.add(s.sessionId)
      return { resumedSessionIds: next }
    })
  },

  setViewMode: (mode) => set({ viewMode: mode }),

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

  downloadSessionMarkdown: () => {
    const session = get().selectedSession
    if (!session) return
    const config = get().config
    const customTitle = config?.sessionMeta?.[session.sessionId]?.customTitle
    const sections = computeSections(session)
    const md = sessionToMarkdown(session, sections, customTitle)
    const filename = generateFilename(session)
    downloadMarkdown(`${filename}.md`, md)
  }
}))
