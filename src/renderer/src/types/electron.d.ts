interface ElectronAPI {
  loadAllSessions: () => Promise<any[]>
  loadSessionDetail: (filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string) => Promise<any>
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
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string) => Promise<void>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string }>, terminalApp: string) => Promise<void>
  loadConfig: () => Promise<any>
  saveConfig: (config: any) => Promise<any>
  createFolder: (opts: { name: string; color?: string | null; parentId?: string | null }) => Promise<any>
  moveFolder: (folderId: string, newParentId: string | null) => Promise<any>
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
  openPath: (filePath: string) => Promise<string>
  showItemInFolder: (filePath: string) => Promise<void>
  onSessionAdded: (callback: (session: any) => void) => void
  onSessionUpdated: (callback: (session: any) => void) => void
  onSessionsRefresh: (callback: () => void) => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
