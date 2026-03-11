import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
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
  loadConfig,
  saveConfig,
  createFolder,
  deleteFolder,
  renameFolder,
  moveFolder,
  addSessionToFolder,
  removeSessionFromFolder,
  setSessionMeta
} from './config-store'
import type { UserConfig } from './types'

let mainWindow: BrowserWindow | null = null
let watcher: chokidar.FSWatcher | null = null
const knownSessionIds = new Set<string>()

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
        // Existing session got a new file (resume/branch) — need full refresh for correct clustering
        mainWindow?.webContents.send('sessions:refresh')
      } else {
        knownSessionIds.add(sessionId)
        const summary = buildSessionSummary(filePath, raw, true)
        if (summary) {
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
        mainWindow?.webContents.send('session:updated', summary)
      }
    } catch {
      /* ignore */
    }
  })
}

// --- IPC Handlers ---

ipcMain.handle('sessions:loadAll', async () => {
  const sessions = await loadAllSessions()
  knownSessionIds.clear()
  for (const s of sessions) knownSessionIds.add(s.sessionId)
  return sessions
})

ipcMain.handle(
  'sessions:loadDetail',
  async (_event, filePath: string, allFilePaths?: string[], branchParentFilePaths?: string[], branchPointUuid?: string) => {
    return loadSessionDetail(filePath, allFilePaths, branchParentFilePaths, branchPointUuid)
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
          text = content
            .filter((p) => p.type === 'text')
            .map((p) => p.text || '')
            .join(' ')
        }
        if (regex.test(text)) {
          const matchIndex = text.search(regex)
          const start = Math.max(0, matchIndex - 50)
          const end = Math.min(text.length, matchIndex + query.length + 50)
          matches.push({
            text:
              (start > 0 ? '...' : '') +
              text.slice(start, end) +
              (end < text.length ? '...' : ''),
            timestamp: msg.timestamp
          })
          regex.lastIndex = 0
        }
        if (matches.length >= 5) break
      }

      if (matches.length > 0) {
        results.push({ sessionId, filePath: file, firstUserMessage, matches })
      }
    } catch {
      /* skip */
    }
  }
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

// Open a .command file in the default terminal — no AppleScript, no permissions needed
function openInTerminal(command: string): void {
  const tmpPath = `/tmp/csm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.command`
  fs.writeFileSync(tmpPath, `#!/bin/bash\n${command}\n`)
  fs.chmodSync(tmpPath, 0o755)
  exec(`open "${tmpPath}"`, () => {
    setTimeout(() => {
      try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    }, 3000)
  })
}

// Single resume: opens a new terminal window
ipcMain.handle(
  'terminal:resume',
  async (_event, sessionId: string, _terminalApp: string, permissionMode?: string, cwd?: string) => {
    openInTerminal(buildResumeCommand(sessionId, permissionMode, cwd))
  }
)

// Batch resume: each session opens in its own terminal window
ipcMain.handle(
  'terminal:resumeBatch',
  async (_event, sessionIds: Array<{ sessionId: string; permissionMode?: string; cwd?: string }>, _terminalApp: string) => {
    for (const s of sessionIds) {
      openInTerminal(buildResumeCommand(s.sessionId, s.permissionMode, s.cwd))
    }
  }
)

ipcMain.handle('config:load', () => loadConfig())
ipcMain.handle('config:save', (_event, config: UserConfig) => {
  saveConfig(config)
  return config
})
ipcMain.handle(
  'config:createFolder',
  (_event, opts: { name: string; color?: string | null; parentId?: string | null }) => {
    const config = loadConfig()
    return createFolder(config, opts)
  }
)
ipcMain.handle(
  'config:moveFolder',
  (_event, folderId: string, newParentId: string | null) => {
    const config = loadConfig()
    return moveFolder(config, folderId, newParentId)
  }
)
ipcMain.handle('config:deleteFolder', (_event, folderId: string) => {
  const config = loadConfig()
  return deleteFolder(config, folderId)
})
ipcMain.handle(
  'config:renameFolder',
  (_event, folderId: string, name: string) => {
    const config = loadConfig()
    return renameFolder(config, folderId, name)
  }
)
ipcMain.handle(
  'config:addSessionToFolder',
  (_event, folderId: string, sessionId: string) => {
    const config = loadConfig()
    return addSessionToFolder(config, folderId, sessionId)
  }
)
ipcMain.handle(
  'config:removeSessionFromFolder',
  (_event, folderId: string, sessionId: string) => {
    const config = loadConfig()
    return removeSessionFromFolder(config, folderId, sessionId)
  }
)
ipcMain.handle(
  'config:setSessionMeta',
  (_event, sessionId: string, meta: { customTitle?: string; notes?: string }) => {
    const config = loadConfig()
    return setSessionMeta(config, sessionId, meta)
  }
)

ipcMain.handle('session:saveMarkdown', async (_event, dirPath: string, filename: string, content: string) => {
  const fullPath = join(dirPath, filename)
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
