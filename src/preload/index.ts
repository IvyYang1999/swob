import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Sessions
  loadAllSessions: () => ipcRenderer.invoke('sessions:loadAll'),
  loadSessionDetail: (filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string) =>
    ipcRenderer.invoke('sessions:loadDetail', filePath, allFilePaths, branchParentFilePaths, branchPointUuid),
  searchSessions: (query: string) =>
    ipcRenderer.invoke('sessions:search', query),

  // Terminal
  resumeSession: (sessionId: string, terminalApp: string, permissionMode?: string, cwd?: string) =>
    ipcRenderer.invoke('terminal:resume', sessionId, terminalApp, permissionMode, cwd),
  resumeBatch: (sessions: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, terminalApp: string) =>
    ipcRenderer.invoke('terminal:resumeBatch', sessions, terminalApp),

  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  createFolder: (opts: { name: string; color?: string | null; parentId?: string | null }) =>
    ipcRenderer.invoke('config:createFolder', opts),
  moveFolder: (folderId: string, newParentId: string | null) =>
    ipcRenderer.invoke('config:moveFolder', folderId, newParentId),
  deleteFolder: (folderId: string) =>
    ipcRenderer.invoke('config:deleteFolder', folderId),
  renameFolder: (folderId: string, name: string) =>
    ipcRenderer.invoke('config:renameFolder', folderId, name),
  addSessionToFolder: (folderId: string, sessionId: string) =>
    ipcRenderer.invoke('config:addSessionToFolder', folderId, sessionId),
  removeSessionFromFolder: (folderId: string, sessionId: string) =>
    ipcRenderer.invoke('config:removeSessionFromFolder', folderId, sessionId),
  setSessionMeta: (
    sessionId: string,
    meta: { customTitle?: string; notes?: string }
  ) => ipcRenderer.invoke('config:setSessionMeta', sessionId, meta),

  // Markdown
  saveMarkdown: (dirPath: string, filename: string, content: string) =>
    ipcRenderer.invoke('session:saveMarkdown', dirPath, filename, content),

  // Shell
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // Events from main
  onSessionAdded: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:added', (_event, session) => callback(session))
  },
  onSessionUpdated: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:updated', (_event, session) => callback(session))
  },
  onSessionsRefresh: (callback: () => void) => {
    ipcRenderer.on('sessions:refresh', () => callback())
  }
}

contextBridge.exposeInMainWorld('api', api)
