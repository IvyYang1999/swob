import { app, shell, BrowserWindow, ipcMain, Menu } from 'electron'
import { join, dirname, basename, relative } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { exec } from 'child_process'
import * as fs from 'fs'
import * as chokidar from 'chokidar'
import {
  loadAllSessions,
  loadSessionDetail,
  findAllSessionFiles,
  parseSessionFile,
  buildSessionSummary
} from './session-loader'
import {
  initLibrary,
  scanLibrary,
  libraryTreeToConfig,
  loadLibraryConfig,
  saveLibraryConfig,
  syncLibraryFromSessions,
  ensureSessionInLibrary,
  updateTranscript,
  syncBackup,
  getSessionMdPath,
  getSessionDirPath,
  createLibraryFolder,
  renameLibraryFolder,
  deleteLibraryFolder,
  moveSessionToFolder,
  addSessionToFolder as libAddSession,
  removeSessionFromFolder as libRemoveSession,
  setSessionMetaInLibrary,
  resolveFolderPath,
  getLibraryRoot,
  migrateFromOldConfig,
  reorderFolder,
  moveLibraryFolderToParent,
  addBranchToFolder,
  removeBranchFromFolder,
  setBranchMeta,
  getBranchMdPath,
  updateBranchTranscript
} from './library-manager'
import { loadConfig, saveConfig } from './config-store'
import type { SessionSummary } from './types'

let mainWindow: BrowserWindow | null = null
let watcher: chokidar.FSWatcher | null = null
const knownSessionIds = new Set<string>()
let libraryInitialized = false
let cachedSessions: SessionSummary[] = []

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#18181b',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // Prevent Electron from navigating when files/URLs are dropped
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow in-app navigation (same origin), block external
    if (!url.startsWith('file://') && !url.startsWith('http')) return
    event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function startFileWatcher(): void {
  const claudeDir = join(process.env.HOME || '', '.claude', 'projects')
  watcher = chokidar.watch(join(claudeDir, '*/*.jsonl'), {
    ignoreInitial: true,
    depth: 1
  })

  watcher.on('add', async (filePath) => {
    if (filePath.includes('/subagents/')) return
    try {
      const raw = await parseSessionFile(filePath)
      const sessionId = raw.find((m) => m.sessionId)?.sessionId
      if (!sessionId) return

      if (knownSessionIds.has(sessionId)) {
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(sessionId)
        const summary = buildSessionSummary(filePath, raw, true)
        if (summary) {
          // Create library entry for new session
          if (libraryInitialized) {
            try {
              const dirPath = await ensureSessionInLibrary(summary)
              await updateTranscript(sessionId)
              await syncBackup(sessionId)
              summary.libraryDirPath = dirPath
              summary.libraryMdPath = getSessionMdPath(sessionId) || undefined
            } catch { /* ignore */ }
          }
          mainWindow?.webContents.send('session:added', summary)
        }
      }
    } catch {
      /* ignore */
    }
  })

  watcher.on('change', async (filePath) => {
    if (filePath.includes('/subagents/')) return
    try {
      const raw = await parseSessionFile(filePath)
      const summary = buildSessionSummary(filePath, raw, true)
      if (summary) {
        // Update library transcript + backup
        if (libraryInitialized) {
          try {
            await ensureSessionInLibrary(summary)
            await updateTranscript(summary.sessionId)
            await syncBackup(summary.sessionId)
            summary.libraryDirPath = getSessionDirPath(summary.sessionId) || undefined
            summary.libraryMdPath = getSessionMdPath(summary.sessionId) || undefined
          } catch { /* ignore */ }
        }
        mainWindow?.webContents.send('session:updated', summary)
      }
    } catch {
      /* ignore */
    }
  })
}

// --- Library Initialization ---

async function initLibraryFromSessions(sessions: SessionSummary[]): Promise<void> {
  initLibrary()

  // Check if migration is needed (old config has folders but library is fresh)
  const oldConfig = loadConfig()
  const tree = scanLibrary()

  if (oldConfig.folders.length > 0 && tree.folders.length === 0 && tree.ungroupedSessions.length === 0) {
    // First run after upgrade — sync all sessions first, then migrate
    await syncLibraryFromSessions(sessions, oldConfig.sessionMeta)
    await migrateFromOldConfig(oldConfig.folders, oldConfig.sessionMeta)

    // Migrate preferences to library config
    const libConfig = loadLibraryConfig()
    libConfig.preferences = oldConfig.preferences
    saveLibraryConfig(libConfig)
  } else {
    // Normal sync — ensure all sessions are in library
    await syncLibraryFromSessions(sessions, oldConfig.sessionMeta)
  }

  libraryInitialized = true
  // Rescan so index is up to date, then notify renderer to refresh
  scanLibrary()
  mainWindow?.webContents.send('sessions:refresh')
}

// --- IPC Handlers ---

ipcMain.handle('sessions:loadAll', async () => {
  const sessions = await loadAllSessions()
  cachedSessions = sessions
  knownSessionIds.clear()

  // Attach library paths
  for (const s of sessions) {
    knownSessionIds.add(s.sessionId)
    const isBranch = s.id.includes(':intra-')
    const dirPath = getSessionDirPath(s.sessionId)
    if (dirPath) {
      s.libraryDirPath = dirPath
      if (isBranch) {
        // Branch: use or generate independent transcript
        let branchMd = getBranchMdPath(s.id)
        if (!branchMd && s.branchLeafUuid) {
          const branchMeta = (await import('./library-manager')).loadLibraryConfig().branchMeta?.[s.id]
          branchMd = await updateBranchTranscript(s.id, s.branchLeafUuid, branchMeta?.customTitle) || undefined
        }
        s.libraryMdPath = branchMd || getSessionMdPath(s.sessionId) || undefined
      } else {
        s.libraryMdPath = getSessionMdPath(s.sessionId) || undefined
      }
    }
  }

  // Sync library in background (non-blocking)
  if (!libraryInitialized) {
    initLibraryFromSessions(sessions).catch(() => { /* ignore */ })
  }

  return sessions
})

ipcMain.handle(
  'sessions:loadDetail',
  async (_event, filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string, branchLeafUuid?: string) => {
    return loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid, branchLeafUuid)
  }
)

ipcMain.handle('sessions:search', async (_event, query: string) => {
  const files = findAllSessionFiles().filter((f) => !f.includes('/subagents/'))
  const results: Array<{
    sessionId: string
    filePath: string
    firstUserMessage: string
    matches: Array<{ text: string; timestamp: string }>
  }> = []

  for (const file of files) {
    try {
      const raw = await parseSessionFile(file)
      const sessionId = raw[0]?.sessionId
      if (!sessionId) continue

      const firstUser = raw.find((m) => m.type === 'user')
      let firstUserMessage = ''
      if (firstUser?.message) {
        const content = firstUser.message.content
        if (typeof content === 'string') firstUserMessage = content.slice(0, 200)
        else if (Array.isArray(content)) {
          firstUserMessage = content
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join(' ')
            .slice(0, 200)
        }
      }

      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const matches: Array<{ text: string; timestamp: string }> = []

      for (const msg of raw) {
        if (msg.type !== 'user' && msg.type !== 'assistant') continue
        const content = msg.message?.content
        let text = ''
        if (typeof content === 'string') text = content
        else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === 'text') text += (text ? ' ' : '') + (part.text || '')
            if (part.type === 'tool_result' && typeof part.content === 'string') text += ' ' + part.content
            if (part.type === 'tool_use' && part.input) {
              const inp = part.input as Record<string, unknown>
              if (inp.command) text += ' ' + String(inp.command)
              if (inp.file_path) text += ' ' + String(inp.file_path)
              if (inp.pattern) text += ' ' + String(inp.pattern)
              if (inp.content) text += ' ' + String(inp.content).slice(0, 500)
            }
          }
        }
        if (regex.test(text)) {
          const matchIndex = text.search(regex)
          const start = Math.max(0, matchIndex - 60)
          const end = Math.min(text.length, matchIndex + query.length + 60)
          matches.push({
            text:
              (start > 0 ? '...' : '') +
              text.slice(start, end) +
              (end < text.length ? '...' : ''),
            timestamp: msg.timestamp
          })
          regex.lastIndex = 0
        }
        if (matches.length >= 10) break
      }

      if (matches.length > 0) {
        results.push({ sessionId, filePath: file, firstUserMessage, matches })
      }
    } catch {
      /* skip */
    }
  }
  results.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length
    const aTime = new Date(a.matches[0]?.timestamp || 0).getTime()
    const bTime = new Date(b.matches[0]?.timestamp || 0).getTime()
    return bTime - aTime
  })
  return results
})

function buildResumeCommand(sessionId: string, permissionMode?: string, cwd?: string): string {
  const cmd = permissionMode === 'bypassPermissions'
    ? `claude --dangerously-skip-permissions --resume ${sessionId}`
    : `claude --resume ${sessionId}`
  if (cwd && fs.existsSync(cwd)) {
    return `cd ${JSON.stringify(cwd)} && ${cmd}`
  }
  return cmd
}

function openInTerminal(command: string): void {
  const tmpPath = `/tmp/csm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.command`
  // Script deletes itself after command finishes, so Terminal won't kill a running process
  fs.writeFileSync(tmpPath, `#!/bin/bash\n${command}\nrm -f "${tmpPath}"\n`)
  fs.chmodSync(tmpPath, 0o755)
  exec(`open "${tmpPath}"`)
}

ipcMain.handle(
  'terminal:resume',
  async (_event, sessionId: string, _terminalApp: string, permissionMode?: string, cwd?: string) => {
    openInTerminal(buildResumeCommand(sessionId, permissionMode, cwd))
  }
)

ipcMain.handle(
  'terminal:resumeBatch',
  async (_event, sessionIds: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, _terminalApp: string) => {
    for (const s of sessionIds) {
      openInTerminal(buildResumeCommand(s.sessionId, s.permissionMode, s.cwd))
    }
  }
)

// --- Config / Library IPC ---
// These use the library manager but return the same shape the frontend expects

ipcMain.handle('config:load', () => {
  if (!libraryInitialized) {
    // Fallback to old config during initial load
    return loadConfig()
  }
  const tree = scanLibrary()
  return libraryTreeToConfig(tree)
})

ipcMain.handle('config:save', (_event, config: { preferences: { defaultViewMode: string; terminalApp: string } }) => {
  if (libraryInitialized) {
    const libConfig = loadLibraryConfig()
    libConfig.preferences = config.preferences as any
    saveLibraryConfig(libConfig)
  } else {
    saveConfig(config as any)
  }
  return config
})

ipcMain.handle(
  'config:createFolder',
  (_event, opts: { name: string; color?: string | null; parentId?: string | null }) => {
    if (libraryInitialized) {
      const parentPath = opts.parentId ? resolveFolderPath(opts.parentId) : undefined
      createLibraryFolder(opts.name, parentPath)
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    // Fallback
    const config = loadConfig()
    const { createFolder } = require('./config-store')
    return createFolder(config, opts)
  }
)

ipcMain.handle(
  'config:moveFolder',
  (_event, folderId: string, newParentId: string | null, position?: 'before' | 'after' | 'inside', targetId?: string) => {
    if (libraryInitialized) {
      const srcPath = resolveFolderPath(folderId)

      if (position && position !== 'inside' && targetId) {
        // Sibling reorder — may need physical move if parent differs
        const targetPath = resolveFolderPath(targetId)
        const targetParent = dirname(targetPath)
        const srcParent = dirname(srcPath)

        let newFolderId = folderId
        if (srcParent !== targetParent && fs.existsSync(srcPath)) {
          const newPath = moveLibraryFolderToParent(srcPath, targetParent)
          newFolderId = relative(getLibraryRoot(), newPath)
          scanLibrary()
        }
        reorderFolder(newFolderId, targetId, position)
      } else {
        // Move folder into a new parent
        const destParent = newParentId ? resolveFolderPath(newParentId) : getLibraryRoot()
        if (fs.existsSync(srcPath)) {
          moveLibraryFolderToParent(srcPath, destParent)
        }
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { moveFolder } = require('./config-store')
    return moveFolder(config, folderId, newParentId)
  }
)

ipcMain.handle('config:deleteFolder', (_event, folderId: string) => {
  if (libraryInitialized) {
    const folderPath = resolveFolderPath(folderId)
    deleteLibraryFolder(folderPath)
    const tree = scanLibrary()
    return libraryTreeToConfig(tree)
  }
  const config = loadConfig()
  const { deleteFolder } = require('./config-store')
  return deleteFolder(config, folderId)
})

ipcMain.handle(
  'config:renameFolder',
  (_event, folderId: string, name: string) => {
    if (libraryInitialized) {
      const folderPath = resolveFolderPath(folderId)
      renameLibraryFolder(folderPath, name)
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { renameFolder } = require('./config-store')
    return renameFolder(config, folderId, name)
  }
)

ipcMain.handle(
  'config:addSessionToFolder',
  async (_event, folderId: string, sessionId: string) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        // Branch sessions: store in config (independent of parent's file system location)
        addBranchToFolder(sessionId, folderId)
      } else {
        // Regular sessions: move directory in Library file system
        const dirPath = getSessionDirPath(sessionId)
        if (!dirPath) {
          const summary = cachedSessions.find((s) => s.sessionId === sessionId)
          if (summary) {
            await ensureSessionInLibrary(summary)
          }
        }
        const folderPath = resolveFolderPath(folderId)
        moveSessionToFolder(sessionId, folderPath)
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { addSessionToFolder } = require('./config-store')
    return addSessionToFolder(config, folderId, sessionId)
  }
)

ipcMain.handle(
  'config:removeSessionFromFolder',
  (_event, folderId: string, sessionId: string) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        removeBranchFromFolder(sessionId, folderId)
      } else {
        const folderPath = resolveFolderPath(folderId)
        libRemoveSession(sessionId, folderPath)
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { removeSessionFromFolder } = require('./config-store')
    return removeSessionFromFolder(config, folderId, sessionId)
  }
)

ipcMain.handle(
  'config:setSessionMeta',
  (_event, sessionId: string, meta: { customTitle?: string; notes?: string; highlights?: unknown[] }) => {
    const isBranch = sessionId.includes(':intra-') || sessionId.includes(':branch-')
    if (libraryInitialized) {
      if (isBranch) {
        setBranchMeta(sessionId, meta as Parameters<typeof setBranchMeta>[1])
      } else {
        setSessionMetaInLibrary(sessionId, meta)
      }
      const tree = scanLibrary()
      return libraryTreeToConfig(tree)
    }
    const config = loadConfig()
    const { setSessionMeta } = require('./config-store')
    return setSessionMeta(config, sessionId, meta)
  }
)

// --- Native Context Menu ---

ipcMain.handle(
  'context-menu:session',
  (event, data: { sessionId: string; folders: Array<{ id: string; name: string; parentId: string | null; isIn: boolean }> }) => {
    return new Promise((resolve) => {
      const template: Electron.MenuItemConstructorOptions[] = [
        { label: '重命名', click: () => resolve({ action: 'rename' }) },
      ]

      const removeItems = data.folders.filter(f => f.isIn)

      if (removeItems.length > 0) {
        template.push({ type: 'separator' })
        for (const f of removeItems) {
          template.push({
            label: `从「${f.name}」移除`,
            click: () => resolve({ action: 'removeFromFolder', folderId: f.id })
          })
        }
      }

      // Build hierarchical "移入" submenu
      const addItems = data.folders.filter(f => !f.isIn)
      if (addItems.length > 0) {
        type FNode = { id: string; name: string; parentId: string | null; children: FNode[] }
        const nodeMap = new Map<string, FNode>()
        for (const f of addItems) {
          nodeMap.set(f.id, { id: f.id, name: f.name, parentId: f.parentId, children: [] })
        }
        const roots: FNode[] = []
        for (const node of nodeMap.values()) {
          if (node.parentId && nodeMap.has(node.parentId)) {
            nodeMap.get(node.parentId)!.children.push(node)
          } else {
            roots.push(node)
          }
        }
        const buildSubmenu = (nodes: FNode[]): Electron.MenuItemConstructorOptions[] => {
          return nodes.map(n => {
            const item: Electron.MenuItemConstructorOptions = {
              label: n.name,
              click: () => resolve({ action: 'addToFolder', folderId: n.id })
            }
            if (n.children.length > 0) {
              item.submenu = [
                { label: `移入「${n.name}」`, click: () => resolve({ action: 'addToFolder', folderId: n.id }) },
                { type: 'separator' },
                ...buildSubmenu(n.children)
              ]
              item.click = undefined
            }
            return item
          })
        }
        template.push({ type: 'separator' })
        template.push({ label: '移入文件夹', enabled: false })
        template.push(...buildSubmenu(roots))
      }

      if (data.folders.length === 0) {
        template.push({ type: 'separator' })
        template.push({ label: '还没有文件夹，先创建一个', enabled: false })
      }

      const menu = Menu.buildFromTemplate(template)
      const win = BrowserWindow.fromWebContents(event.sender)
      menu.popup({ window: win!, callback: () => resolve(null) })
    })
  }
)

// --- Library-specific IPC ---

ipcMain.handle('library:getRoot', () => getLibraryRoot())

ipcMain.handle('library:getMdPath', (_event, sessionId: string) => {
  if (sessionId.includes(':intra-')) {
    return getBranchMdPath(sessionId) || getSessionMdPath(sessionId.split(':')[0])
  }
  return getSessionMdPath(sessionId)
})

ipcMain.handle('library:getDirPath', (_event, sessionId: string) => {
  return getSessionDirPath(sessionId)
})

ipcMain.handle('library:openInFinder', () => {
  shell.showItemInFolder(getLibraryRoot())
})

// --- File Operations ---

ipcMain.handle('session:saveMarkdown', async (_event, dirPath: string, filename: string, content: string) => {
  const fullPath = join(dirPath, filename)
  fs.writeFileSync(fullPath, content, 'utf-8')
  return fullPath
})

ipcMain.handle('session:saveToTemp', (_event, filename: string, content: string) => {
  const tmpDir = join(require('os').tmpdir(), 'swob-drag')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  const fullPath = join(tmpDir, filename)
  fs.writeFileSync(fullPath, content, 'utf-8')
  return fullPath
})

ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
  return shell.openPath(filePath)
})

ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
  shell.showItemInFolder(filePath)
})

// --- App Lifecycle ---

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.claude-session-manager')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Initialize library early so session paths are available on first load
  initLibrary()
  scanLibrary()

  createWindow()
  startFileWatcher()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher?.close()
  if (process.platform !== 'darwin') app.quit()
})
