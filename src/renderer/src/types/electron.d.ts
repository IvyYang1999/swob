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
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string) => Promise<void>
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, terminalApp: string) => Promise<void>
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
  showSessionContextMenu: (data: { sessionId: string; folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }> }) =>
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
  onSessionsRefresh: (callback: () => void) => void
  onActiveSessionsChanged: (callback: (ids: string[]) => void) => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
