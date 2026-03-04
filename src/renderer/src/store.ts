import { create } from 'zustand'

interface SessionSummary {
  id: string
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
}

interface ParsedMessage {
  uuid: string
  type: string
  subtype?: string
  timestamp: string
  role?: string
  textContent: string
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  isPreCompact: boolean
  raw: unknown
}

interface SessionDetail extends SessionSummary {
  messages: ParsedMessage[]
}

interface Folder {
  id: string
  name: string
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
  config: UserConfig | null
  searchResults: SearchResult[]
  searchQuery: string
  loading: boolean
  viewMode: 'compact' | 'full'
  selectedFolderId: string | null
  infoPanelOpen: boolean

  initialize: () => Promise<void>
  selectSession: (filePath: string) => Promise<void>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resumeSession: (sessionId: string) => Promise<void>
  toggleViewMode: () => void
  selectFolder: (folderId: string | null) => void
  toggleInfoPanel: () => void
  createFolder: (name: string, color?: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  addSessionToFolder: (folderId: string, sessionId: string) => Promise<void>
  removeSessionFromFolder: (folderId: string, sessionId: string) => Promise<void>
  setSessionMeta: (sessionId: string, meta: { customTitle?: string; notes?: string }) => Promise<void>
}

export type { SessionSummary, SessionDetail, ParsedMessage, Folder, UserConfig, SearchResult }

export const useStore = create<AppState>((set, get) => ({
  sessions: [],
  selectedSession: null,
  config: null,
  searchResults: [],
  searchQuery: '',
  loading: true,
  viewMode: 'compact',
  selectedFolderId: null,
  infoPanelOpen: true,

  initialize: async () => {
    set({ loading: true })
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

    window.api.onSessionAdded((session) => {
      set((state) => ({
        sessions: [session as SessionSummary, ...state.sessions]
      }))
    })
    window.api.onSessionUpdated((updated) => {
      set((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === (updated as SessionSummary).id ? (updated as SessionSummary) : s
        )
      }))
    })
  },

  selectSession: async (filePath) => {
    const detail = await window.api.loadSessionDetail(filePath)
    set({ selectedSession: detail as SessionDetail | null })
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

  resumeSession: async (sessionId) => {
    const terminalApp = get().config?.preferences.terminalApp || 'Terminal'
    await window.api.resumeSession(sessionId, terminalApp)
  },

  toggleViewMode: () =>
    set((state) => ({
      viewMode: state.viewMode === 'compact' ? 'full' : 'compact'
    })),

  selectFolder: (folderId) => set({ selectedFolderId: folderId }),
  toggleInfoPanel: () => set((state) => ({ infoPanelOpen: !state.infoPanelOpen })),

  createFolder: async (name, color) => {
    const config = await window.api.createFolder(name, color)
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
  }
}))
