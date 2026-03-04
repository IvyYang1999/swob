interface ElectronAPI {
  loadAllSessions: () => Promise<any[]>
  loadSessionDetail: (filePath: string) => Promise<any>
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
  resumeSession: (sessionId: string, terminalApp: string) => Promise<void>
  loadConfig: () => Promise<any>
  saveConfig: (config: any) => Promise<any>
  createFolder: (name: string, color?: string) => Promise<any>
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
    meta: { customTitle?: string; notes?: string }
  ) => Promise<any>
  onSessionAdded: (callback: (session: any) => void) => void
  onSessionUpdated: (callback: (session: any) => void) => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
