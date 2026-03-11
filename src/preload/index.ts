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
  moveFolder: (folderId: string, newParentId: string | null, position?: string, targetId?: string) =>
    ipcRenderer.invoke('config:moveFolder', folderId, newParentId, position, targetId),
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

  // Native context menu
  showSessionContextMenu: (data: { sessionId: string; folders: Array<{ id: string; name: string; isIn: boolean }> }) =>
    ipcRenderer.invoke('context-menu:session', data),

  // Library
  libraryGetRoot: () => ipcRenderer.invoke('library:getRoot'),
  libraryGetMdPath: (sessionId: string) => ipcRenderer.invoke('library:getMdPath', sessionId),
  libraryGetDirPath: (sessionId: string) => ipcRenderer.invoke('library:getDirPath', sessionId),
  libraryOpenInFinder: () => ipcRenderer.invoke('library:openInFinder'),

  // Markdown
  saveMarkdown: (dirPath: string, filename: string, content: string) =>
    ipcRenderer.invoke('session:saveMarkdown', dirPath, filename, content),
  saveToTemp: (filename: string, content: string) =>
    ipcRenderer.invoke('session:saveToTemp', filename, content),

  // Shell
  openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // Native drag
  startDrag: (filePath: string, title: string) => ipcRenderer.send('session:startDrag', filePath, title),

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
