# Claude Session Manager Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Electron desktop app that lets users browse, search, and manage all Claude Code sessions with full conversation history (including pre-compact), organize them into folders, and one-click resume in terminal.

**Architecture:** Electron main process handles JSONL parsing, file watching, and terminal launching via IPC. React renderer with three-column layout (sidebar, chat viewer, info panel). User config (folders, notes) stored separately from Claude Code data.

**Tech Stack:** Electron + electron-vite, React 19, TypeScript, Tailwind CSS 4, Zustand, chokidar, Lucide React icons

---

### Task 1: Scaffold Electron + React project

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`, `tsconfig.node.json`, `tsconfig.web.json`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `tailwind.config.js`
- Create: `postcss.config.js`

**Step 1: Scaffold with create-electron-vite**

Run:
```bash
cd ~/projects/claude-session-manager
npm create @electron-vite@latest . -- --template react-ts
```

If the tool asks to overwrite, say yes. This scaffolds the full project structure.

**Step 2: Install additional dependencies**

```bash
npm install zustand chokidar lucide-react
npm install -D tailwindcss @tailwindcss/vite
```

**Step 3: Configure Tailwind**

In `src/renderer/src/assets/main.css`, replace contents with:
```css
@import "tailwindcss";
```

In `electron.vite.config.ts`, add the Tailwind vite plugin to the renderer config:
```typescript
import tailwindcss from '@tailwindcss/vite'

// in renderer config plugins array:
plugins: [react(), tailwindcss()]
```

**Step 4: Verify it runs**

Run: `npm run dev`
Expected: Electron window opens with default React template

**Step 5: Commit**

```bash
git init && git add -A && git commit -m "chore: scaffold electron-vite react-ts project with tailwind and zustand"
```

---

### Task 2: JSONL Parser — Session Loader

**Files:**
- Create: `src/main/types.ts`
- Create: `src/main/session-loader.ts`

**Step 1: Define shared types**

Create `src/main/types.ts`:
```typescript
export interface RawJsonlMessage {
  uuid: string
  parentUuid: string | null
  sessionId: string
  type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot'
  subtype?: string
  timestamp: string
  cwd?: string
  version?: string
  slug?: string
  message?: {
    role: string
    content: string | ContentPart[]
  }
  data?: unknown
}

export interface ContentPart {
  type: string
  text?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string | ContentPart[]
}

export interface ParsedMessage {
  uuid: string
  type: 'user' | 'assistant' | 'system' | 'progress'
  subtype?: string
  timestamp: string
  role?: string
  textContent: string          // extracted plain text
  toolCalls: ToolCallInfo[]    // extracted tool calls
  isPreCompact: boolean
  raw: RawJsonlMessage
}

export interface ToolCallInfo {
  name: string
  input: Record<string, unknown>
}

export interface SkillInvocation {
  skillName: string
  timestamp: string
  args?: string
}

export interface SessionSummary {
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
  skillInvocations: SkillInvocation[]
  claudeMdContent?: string
  projectPath: string
  filePath: string
  fileSizeBytes: number
}

export interface SessionDetail extends SessionSummary {
  messages: ParsedMessage[]
}

export interface Folder {
  id: string
  name: string
  sessionIds: string[]
  color?: string
  createdAt: string
}

export interface UserConfig {
  folders: Folder[]
  sessionMeta: Record<string, {
    customTitle?: string
    notes?: string
  }>
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
  }
}
```

**Step 2: Implement session-loader.ts**

Create `src/main/session-loader.ts`:
```typescript
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  SkillInvocation,
  ContentPart
} from './types'

const CLAUDE_DIR = path.join(process.env.HOME || '', '.claude', 'projects')

export function findAllSessionFiles(): string[] {
  const files: string[] = []
  if (!fs.existsSync(CLAUDE_DIR)) return files

  const projects = fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    const projDir = path.join(CLAUDE_DIR, proj.name)
    const entries = fs.readdirSync(projDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(projDir, entry.name))
      }
    }
  }
  return files
}

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n')
}

function extractToolCalls(content: string | ContentPart[] | undefined): ToolCallInfo[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((p) => p.type === 'tool_use' && p.name)
    .map((p) => ({ name: p.name!, input: (p.input as Record<string, unknown>) || {} }))
}

function extractSkillInvocations(toolCalls: ToolCallInfo[], timestamp: string): SkillInvocation[] {
  return toolCalls
    .filter((t) => t.name === 'Skill')
    .map((t) => ({
      skillName: (t.input.skill as string) || 'unknown',
      timestamp,
      args: t.input.args as string | undefined
    }))
}

export async function parseSessionFile(filePath: string): Promise<RawJsonlMessage[]> {
  const messages: RawJsonlMessage[] = []
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      messages.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }
  return messages
}

export function buildSessionSummary(
  filePath: string,
  rawMessages: RawJsonlMessage[]
): SessionSummary | null {
  // Filter out subagent messages by checking file path
  if (filePath.includes('/subagents/')) return null

  const validMessages = rawMessages.filter(
    (m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system'
  )
  if (validMessages.length === 0) return null

  const sessionId = rawMessages[0]?.sessionId
  if (!sessionId) return null

  const cwds = [...new Set(rawMessages.map((m) => m.cwd).filter(Boolean) as string[])]
  const versions = [...new Set(rawMessages.map((m) => m.version).filter(Boolean) as string[])]
  const timestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()

  // Count turns (a turn = one user message + one assistant response)
  const userMsgCount = validMessages.filter((m) => m.type === 'user').length
  const assistantMsgCount = validMessages.filter((m) => m.type === 'assistant').length
  const turnCount = Math.min(userMsgCount, assistantMsgCount)

  // Count compacts
  const compactCount = rawMessages.filter(
    (m) => m.type === 'system' && m.subtype === 'compact_boundary'
  ).length

  // First user message
  const firstUser = validMessages.find((m) => m.type === 'user')
  let firstUserMessage = ''
  if (firstUser?.message) {
    firstUserMessage = extractText(firstUser.message.content).slice(0, 200)
  }

  // Tool usage and skill invocations
  const toolUsage: Record<string, number> = {}
  const skillInvocations: SkillInvocation[] = []

  for (const msg of rawMessages) {
    if (msg.type === 'assistant' && msg.message) {
      const tools = extractToolCalls(msg.message.content)
      for (const t of tools) {
        toolUsage[t.name] = (toolUsage[t.name] || 0) + 1
      }
      skillInvocations.push(...extractSkillInvocations(tools, msg.timestamp))
    }
  }

  // Extract CLAUDE.md content from system messages
  let claudeMdContent: string | undefined
  for (const msg of rawMessages) {
    if (msg.type === 'system' && msg.message) {
      const text = extractText(msg.message.content)
      if (text.includes('claudeMd') || text.includes('CLAUDE.md')) {
        const match = text.match(/Contents of.*?CLAUDE\.md.*?:\n([\s\S]*?)(?:\n\nContents of|\n<\/|$)/)
        if (match) claudeMdContent = match[1].trim()
      }
    }
  }

  const stat = fs.statSync(filePath)
  const projectPath = path.dirname(filePath)

  return {
    id: sessionId,
    slug: rawMessages.find((m) => m.slug)?.slug || '',
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    messageCount: validMessages.length,
    turnCount,
    compactCount,
    cwds,
    version: versions[0] || '',
    firstUserMessage,
    toolUsage,
    skillInvocations,
    claudeMdContent,
    projectPath,
    filePath,
    fileSizeBytes: stat.size
  }
}

export function buildSessionDetail(
  filePath: string,
  rawMessages: RawJsonlMessage[]
): SessionDetail | null {
  const summary = buildSessionSummary(filePath, rawMessages)
  if (!summary) return null

  // Find compact boundary indices
  const compactIndices = rawMessages
    .map((m, i) => (m.type === 'system' && m.subtype === 'compact_boundary' ? i : -1))
    .filter((i) => i >= 0)

  const lastCompactIndex = compactIndices.length > 0 ? compactIndices[compactIndices.length - 1] : -1

  const messages: ParsedMessage[] = rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
    .map((m, _i, _arr) => {
      const originalIndex = rawMessages.indexOf(m)
      const toolCalls = m.message ? extractToolCalls(m.message.content) : []
      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: m.subtype,
        timestamp: m.timestamp,
        role: m.message?.role,
        textContent: m.message ? extractText(m.message.content) : (m as any).content || '',
        toolCalls,
        isPreCompact: lastCompactIndex >= 0 && originalIndex < lastCompactIndex,
        raw: m
      }
    })

  return { ...summary, messages }
}

export async function loadAllSessions(): Promise<SessionSummary[]> {
  const files = findAllSessionFiles()
  const summaries: SessionSummary[] = []

  for (const file of files) {
    try {
      const raw = await parseSessionFile(file)
      const summary = buildSessionSummary(file, raw)
      if (summary) summaries.push(summary)
    } catch {
      // skip files that can't be parsed
    }
  }

  // Sort by updatedAt descending
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return summaries
}

export async function loadSessionDetail(filePath: string): Promise<SessionDetail | null> {
  const raw = await parseSessionFile(filePath)
  return buildSessionDetail(filePath, raw)
}
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add JSONL parser and session loader with type definitions"
```

---

### Task 3: User Config Store

**Files:**
- Create: `src/main/config-store.ts`

**Step 1: Implement config store**

Create `src/main/config-store.ts`:
```typescript
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import type { UserConfig, Folder } from './types'

const CONFIG_DIR = path.join(process.env.HOME || '', '.claude-session-manager')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULT_CONFIG: UserConfig = {
  folders: [],
  sessionMeta: {},
  preferences: {
    defaultViewMode: 'compact',
    terminalApp: 'Terminal'
  }
}

export function loadConfig(): UserConfig {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG }
    const data = fs.readFileSync(CONFIG_FILE, 'utf-8')
    return { ...DEFAULT_CONFIG, ...JSON.parse(data) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: UserConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8')
}

export function createFolder(config: UserConfig, name: string, color?: string): UserConfig {
  const folder: Folder = {
    id: randomUUID(),
    name,
    sessionIds: [],
    color,
    createdAt: new Date().toISOString()
  }
  config.folders.push(folder)
  saveConfig(config)
  return config
}

export function deleteFolder(config: UserConfig, folderId: string): UserConfig {
  config.folders = config.folders.filter((f) => f.id !== folderId)
  saveConfig(config)
  return config
}

export function renameFolder(config: UserConfig, folderId: string, name: string): UserConfig {
  const folder = config.folders.find((f) => f.id === folderId)
  if (folder) folder.name = name
  saveConfig(config)
  return config
}

export function addSessionToFolder(
  config: UserConfig,
  folderId: string,
  sessionId: string
): UserConfig {
  const folder = config.folders.find((f) => f.id === folderId)
  if (folder && !folder.sessionIds.includes(sessionId)) {
    folder.sessionIds.push(sessionId)
    saveConfig(config)
  }
  return config
}

export function removeSessionFromFolder(
  config: UserConfig,
  folderId: string,
  sessionId: string
): UserConfig {
  const folder = config.folders.find((f) => f.id === folderId)
  if (folder) {
    folder.sessionIds = folder.sessionIds.filter((id) => id !== sessionId)
    saveConfig(config)
  }
  return config
}

export function setSessionMeta(
  config: UserConfig,
  sessionId: string,
  meta: { customTitle?: string; notes?: string }
): UserConfig {
  config.sessionMeta[sessionId] = {
    ...config.sessionMeta[sessionId],
    ...meta
  }
  saveConfig(config)
  return config
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add user config store for folders and session metadata"
```

---

### Task 4: IPC Bridge — Main Process Handlers

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Step 1: Set up IPC handlers in main process**

Replace `src/main/index.ts` with:
```typescript
import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { exec } from 'child_process'
import * as chokidar from 'chokidar'
import {
  loadAllSessions,
  loadSessionDetail,
  findAllSessionFiles,
  parseSessionFile,
  buildSessionSummary
} from './session-loader'
import { loadConfig, saveConfig, createFolder, deleteFolder, renameFolder, addSessionToFolder, removeSessionFromFolder, setSessionMeta } from './config-store'
import type { SessionSummary, UserConfig } from './types'

let mainWindow: BrowserWindow | null = null
let watcher: chokidar.FSWatcher | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
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
      const summary = buildSessionSummary(filePath, raw)
      if (summary) {
        mainWindow?.webContents.send('session:added', summary)
      }
    } catch { /* ignore */ }
  })

  watcher.on('change', async (filePath) => {
    if (filePath.includes('/subagents/')) return
    try {
      const raw = await parseSessionFile(filePath)
      const summary = buildSessionSummary(filePath, raw)
      if (summary) {
        mainWindow?.webContents.send('session:updated', summary)
      }
    } catch { /* ignore */ }
  })
}

// --- IPC Handlers ---

ipcMain.handle('sessions:loadAll', async () => {
  return loadAllSessions()
})

ipcMain.handle('sessions:loadDetail', async (_event, filePath: string) => {
  return loadSessionDetail(filePath)
})

ipcMain.handle('sessions:search', async (_event, query: string) => {
  const files = findAllSessionFiles().filter((f) => !f.includes('/subagents/'))
  const results: Array<{ sessionId: string; filePath: string; firstUserMessage: string; matches: Array<{ text: string; timestamp: string }> }> = []

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
          text = content.filter((p) => p.type === 'text').map((p) => p.text || '').join(' ')
        }
        if (regex.test(text)) {
          const matchIndex = text.search(regex)
          const start = Math.max(0, matchIndex - 50)
          const end = Math.min(text.length, matchIndex + query.length + 50)
          matches.push({
            text: (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : ''),
            timestamp: msg.timestamp
          })
          regex.lastIndex = 0
        }
        if (matches.length >= 5) break  // limit matches per session
      }

      if (matches.length > 0) {
        results.push({ sessionId, filePath: file, firstUserMessage, matches })
      }
    } catch { /* skip */ }
  }
  return results
})

ipcMain.handle('terminal:resume', async (_event, sessionId: string, terminalApp: string) => {
  const command = `claude --resume ${sessionId}`
  if (terminalApp === 'iTerm2') {
    const script = `
      tell application "iTerm2"
        activate
        tell current window
          create tab with default profile
          tell current session
            write text "${command}"
          end tell
        end tell
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`)
  } else {
    const script = `
      tell application "Terminal"
        activate
        do script "${command}"
      end tell
    `
    exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`)
  }
})

ipcMain.handle('config:load', () => loadConfig())
ipcMain.handle('config:save', (_event, config: UserConfig) => { saveConfig(config); return config })
ipcMain.handle('config:createFolder', (_event, name: string, color?: string) => {
  const config = loadConfig()
  return createFolder(config, name, color)
})
ipcMain.handle('config:deleteFolder', (_event, folderId: string) => {
  const config = loadConfig()
  return deleteFolder(config, folderId)
})
ipcMain.handle('config:renameFolder', (_event, folderId: string, name: string) => {
  const config = loadConfig()
  return renameFolder(config, folderId, name)
})
ipcMain.handle('config:addSessionToFolder', (_event, folderId: string, sessionId: string) => {
  const config = loadConfig()
  return addSessionToFolder(config, folderId, sessionId)
})
ipcMain.handle('config:removeSessionFromFolder', (_event, folderId: string, sessionId: string) => {
  const config = loadConfig()
  return removeSessionFromFolder(config, folderId, sessionId)
})
ipcMain.handle('config:setSessionMeta', (_event, sessionId: string, meta: { customTitle?: string; notes?: string }) => {
  const config = loadConfig()
  return setSessionMeta(config, sessionId, meta)
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
```

**Step 2: Set up preload bridge**

Replace `src/preload/index.ts` with:
```typescript
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  // Sessions
  loadAllSessions: () => ipcRenderer.invoke('sessions:loadAll'),
  loadSessionDetail: (filePath: string) => ipcRenderer.invoke('sessions:loadDetail', filePath),
  searchSessions: (query: string) => ipcRenderer.invoke('sessions:search', query),

  // Terminal
  resumeSession: (sessionId: string, terminalApp: string) =>
    ipcRenderer.invoke('terminal:resume', sessionId, terminalApp),

  // Config
  loadConfig: () => ipcRenderer.invoke('config:load'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('config:save', config),
  createFolder: (name: string, color?: string) => ipcRenderer.invoke('config:createFolder', name, color),
  deleteFolder: (folderId: string) => ipcRenderer.invoke('config:deleteFolder', folderId),
  renameFolder: (folderId: string, name: string) => ipcRenderer.invoke('config:renameFolder', folderId, name),
  addSessionToFolder: (folderId: string, sessionId: string) => ipcRenderer.invoke('config:addSessionToFolder', folderId, sessionId),
  removeSessionFromFolder: (folderId: string, sessionId: string) => ipcRenderer.invoke('config:removeSessionFromFolder', folderId, sessionId),
  setSessionMeta: (sessionId: string, meta: { customTitle?: string; notes?: string }) => ipcRenderer.invoke('config:setSessionMeta', sessionId, meta),

  // Events from main
  onSessionAdded: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:added', (_event, session) => callback(session))
  },
  onSessionUpdated: (callback: (session: unknown) => void) => {
    ipcRenderer.on('session:updated', (_event, session) => callback(session))
  }
}

contextBridge.exposeInMainWorld('api', api)
```

**Step 3: Add type declaration for renderer**

Create `src/renderer/src/types/electron.d.ts`:
```typescript
interface ElectronAPI {
  loadAllSessions: () => Promise<import('../../../../main/types').SessionSummary[]>
  loadSessionDetail: (filePath: string) => Promise<import('../../../../main/types').SessionDetail | null>
  searchSessions: (query: string) => Promise<Array<{
    sessionId: string
    filePath: string
    firstUserMessage: string
    matches: Array<{ text: string; timestamp: string }>
  }>>
  resumeSession: (sessionId: string, terminalApp: string) => Promise<void>
  loadConfig: () => Promise<import('../../../../main/types').UserConfig>
  saveConfig: (config: import('../../../../main/types').UserConfig) => Promise<import('../../../../main/types').UserConfig>
  createFolder: (name: string, color?: string) => Promise<import('../../../../main/types').UserConfig>
  deleteFolder: (folderId: string) => Promise<import('../../../../main/types').UserConfig>
  renameFolder: (folderId: string, name: string) => Promise<import('../../../../main/types').UserConfig>
  addSessionToFolder: (folderId: string, sessionId: string) => Promise<import('../../../../main/types').UserConfig>
  removeSessionFromFolder: (folderId: string, sessionId: string) => Promise<import('../../../../main/types').UserConfig>
  setSessionMeta: (sessionId: string, meta: { customTitle?: string; notes?: string }) => Promise<import('../../../../main/types').UserConfig>
  onSessionAdded: (callback: (session: import('../../../../main/types').SessionSummary) => void) => void
  onSessionUpdated: (callback: (session: import('../../../../main/types').SessionSummary) => void) => void
}

declare global {
  interface Window {
    api: ElectronAPI
  }
}

export {}
```

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add IPC bridge with session, search, config, and terminal handlers"
```

---

### Task 5: Zustand Store

**Files:**
- Create: `src/renderer/src/store.ts`

**Step 1: Create the store**

```typescript
import { create } from 'zustand'

// Re-declare minimal types to avoid cross-boundary imports
interface SessionSummary {
  id: string; slug: string; createdAt: string; updatedAt: string
  messageCount: number; turnCount: number; compactCount: number
  cwds: string[]; version: string; firstUserMessage: string
  toolUsage: Record<string, number>; skillInvocations: Array<{ skillName: string; timestamp: string; args?: string }>
  claudeMdContent?: string; projectPath: string; filePath: string; fileSizeBytes: number
}

interface ParsedMessage {
  uuid: string; type: string; subtype?: string; timestamp: string
  role?: string; textContent: string
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>
  isPreCompact: boolean; raw: unknown
}

interface SessionDetail extends SessionSummary { messages: ParsedMessage[] }
interface Folder { id: string; name: string; sessionIds: string[]; color?: string; createdAt: string }
interface UserConfig {
  folders: Folder[]
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>
  preferences: { defaultViewMode: 'compact' | 'full'; terminalApp: 'Terminal' | 'iTerm2' }
}

interface SearchResult {
  sessionId: string; filePath: string; firstUserMessage: string
  matches: Array<{ text: string; timestamp: string }>
}

interface AppState {
  // Data
  sessions: SessionSummary[]
  selectedSession: SessionDetail | null
  config: UserConfig | null
  searchResults: SearchResult[]
  searchQuery: string

  // UI
  loading: boolean
  viewMode: 'compact' | 'full'
  selectedFolderId: string | null  // null = "All Sessions"
  infoPanelOpen: boolean

  // Actions
  initialize: () => Promise<void>
  selectSession: (filePath: string) => Promise<void>
  search: (query: string) => Promise<void>
  clearSearch: () => void
  resumeSession: (sessionId: string) => Promise<void>
  toggleViewMode: () => void
  selectFolder: (folderId: string | null) => void
  toggleInfoPanel: () => void

  // Folder actions
  createFolder: (name: string, color?: string) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  renameFolder: (folderId: string, name: string) => Promise<void>
  addSessionToFolder: (folderId: string, sessionId: string) => Promise<void>
  removeSessionFromFolder: (folderId: string, sessionId: string) => Promise<void>
  setSessionMeta: (sessionId: string, meta: { customTitle?: string; notes?: string }) => Promise<void>
}

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
      viewMode: config.preferences.defaultViewMode,
      loading: false
    })

    // Listen for live updates
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
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add zustand store with all session, folder, and search actions"
```

---

### Task 6: Sidebar Component — Folder Tree + Session List

**Files:**
- Create: `src/renderer/src/components/Sidebar.tsx`

**Step 1: Implement Sidebar**

```tsx
import { useState } from 'react'
import { useStore } from '../store'
import {
  FolderPlus, FolderOpen, Folder, ChevronRight, ChevronDown,
  MessageSquare, Clock, MoreVertical
} from 'lucide-react'

function formatDate(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / 86400000)
  if (days === 0) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return '昨天'
  if (days < 7) return `${days}天前`
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function groupSessionsByDate(sessions: Array<{ createdAt: string; id: string }>) {
  const today = new Date().toDateString()
  const yesterday = new Date(Date.now() - 86400000).toDateString()
  const groups: Record<string, typeof sessions> = {}

  for (const s of sessions) {
    const dateStr = new Date(s.createdAt).toDateString()
    let label: string
    if (dateStr === today) label = '今天'
    else if (dateStr === yesterday) label = '昨天'
    else label = new Date(s.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })

    if (!groups[label]) groups[label] = []
    groups[label].push(s)
  }
  return groups
}

export function Sidebar() {
  const {
    sessions, config, selectedSession, selectedFolderId,
    selectSession, selectFolder, createFolder
  } = useStore()
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set())
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const handleCreateFolder = () => {
    if (newFolderName.trim()) {
      createFolder(newFolderName.trim())
      setNewFolderName('')
      setShowNewFolder(false)
    }
  }

  // Filter sessions based on selected folder
  const displaySessions = selectedFolderId
    ? sessions.filter((s) => {
        const folder = config?.folders.find((f) => f.id === selectedFolderId)
        return folder?.sessionIds.includes(s.id)
      })
    : sessions

  const ungroupedSessionIds = new Set(sessions.map((s) => s.id))
  config?.folders.forEach((f) => f.sessionIds.forEach((id) => ungroupedSessionIds.delete(id)))

  return (
    <div className="w-60 h-full flex flex-col border-r border-zinc-700 bg-zinc-900">
      {/* Header */}
      <div className="p-3 flex items-center justify-between border-b border-zinc-700">
        <span className="text-sm font-medium text-zinc-300">Sessions</span>
        <button
          onClick={() => setShowNewFolder(true)}
          className="p-1 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-200"
          title="新建文件夹"
        >
          <FolderPlus size={16} />
        </button>
      </div>

      {/* New folder input */}
      {showNewFolder && (
        <div className="p-2 border-b border-zinc-700">
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreateFolder()
              if (e.key === 'Escape') setShowNewFolder(false)
            }}
            onBlur={handleCreateFolder}
            placeholder="文件夹名称"
            className="w-full px-2 py-1 text-sm bg-zinc-800 border border-zinc-600 rounded text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-400"
          />
        </div>
      )}

      {/* Scrollable list */}
      <div className="flex-1 overflow-y-auto">
        {/* All Sessions */}
        <button
          onClick={() => selectFolder(null)}
          className={`w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 ${
            !selectedFolderId ? 'bg-zinc-800 text-white' : 'text-zinc-400'
          }`}
        >
          <FolderOpen size={14} />
          <span>全部 ({sessions.length})</span>
        </button>

        {/* User folders */}
        {config?.folders.map((folder) => (
          <div key={folder.id}>
            <button
              onClick={() => {
                selectFolder(folder.id)
                toggleFolder(folder.id)
              }}
              className={`w-full px-3 py-2 flex items-center gap-2 text-sm hover:bg-zinc-800 ${
                selectedFolderId === folder.id ? 'bg-zinc-800 text-white' : 'text-zinc-400'
              }`}
            >
              {expandedFolders.has(folder.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Folder size={14} style={folder.color ? { color: folder.color } : undefined} />
              <span className="truncate">{folder.name} ({folder.sessionIds.length})</span>
            </button>
          </div>
        ))}

        {/* Divider */}
        <div className="mx-3 my-2 border-t border-zinc-700" />

        {/* Session list */}
        {displaySessions.map((session) => {
          const meta = config?.sessionMeta[session.id]
          const title = meta?.customTitle || session.firstUserMessage || session.id.slice(0, 12)
          return (
            <button
              key={session.id}
              onClick={() => selectSession(session.filePath)}
              className={`w-full px-3 py-2 text-left hover:bg-zinc-800 group ${
                selectedSession?.id === session.id ? 'bg-zinc-800' : ''
              }`}
            >
              <div className="text-sm text-zinc-200 truncate">{title.slice(0, 60)}</div>
              <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                <Clock size={10} />
                <span>{formatDate(session.updatedAt)}</span>
                <MessageSquare size={10} />
                <span>{session.turnCount}轮</span>
                {session.compactCount > 0 && (
                  <span className="px-1 bg-amber-900/50 text-amber-400 rounded text-[10px]">
                    compact
                  </span>
                )}
              </div>
            </button>
          )
        })}
      </div>

      {/* Status bar */}
      <div className="p-2 border-t border-zinc-700 text-[11px] text-zinc-500">
        {sessions.length} sessions · {(sessions.reduce((a, s) => a + s.fileSizeBytes, 0) / 1024 / 1024).toFixed(0)}MB
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add Sidebar component with folder tree and session list"
```

---

### Task 7: ChatViewer Component

**Files:**
- Create: `src/renderer/src/components/ChatViewer.tsx`

**Step 1: Implement ChatViewer**

```tsx
import { useRef, useEffect, useState } from 'react'
import { useStore } from '../store'
import { User, Bot, Terminal, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function ToolCallBlock({ name, input }: { name: string; input: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="my-1 border border-zinc-700 rounded bg-zinc-800/50">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-300"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Terminal size={12} />
        <span className="font-mono">{name}</span>
        {name === 'Bash' && input.command && (
          <span className="truncate text-zinc-500 ml-1">
            {String(input.command).slice(0, 80)}
          </span>
        )}
        {name === 'Read' && input.file_path && (
          <span className="truncate text-zinc-500 ml-1">{String(input.file_path)}</span>
        )}
        {name === 'Skill' && input.skill && (
          <span className="truncate text-zinc-500 ml-1">{String(input.skill)}</span>
        )}
      </button>
      {expanded && (
        <pre className="px-3 py-2 text-xs text-zinc-400 overflow-x-auto border-t border-zinc-700 max-h-64 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function ChatViewer() {
  const { selectedSession, viewMode, searchQuery } = useStore()
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Don't auto-scroll to bottom on load
  }, [selectedSession])

  if (!selectedSession) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-500">
        <div className="text-center">
          <MessagePlaceholder />
        </div>
      </div>
    )
  }

  const messages = selectedSession.messages.filter((m) => {
    if (viewMode === 'compact') {
      return m.type === 'user' || m.type === 'assistant'
    }
    return m.type !== 'progress'
  })

  // Find compact boundary position
  const compactBoundaryIndex = messages.findIndex(
    (m) => m.type === 'system' && m.subtype === 'compact_boundary'
  )

  function highlightText(text: string): React.ReactNode {
    if (!searchQuery) return text
    const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = text.split(regex)
    return parts.map((part, i) =>
      regex.test(part) ? (
        <mark key={i} className="bg-yellow-500/40 text-yellow-200 rounded px-0.5">{part}</mark>
      ) : (
        part
      )
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.map((msg, i) => {
        // Compact boundary marker
        if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
          return (
            <div key={msg.uuid} className="flex items-center gap-3 py-3">
              <div className="flex-1 border-t border-amber-600/50" />
              <div className="flex items-center gap-2 text-amber-500 text-xs px-3 py-1 bg-amber-900/20 rounded-full">
                <AlertTriangle size={12} />
                Conversation compacted
              </div>
              <div className="flex-1 border-t border-amber-600/50" />
            </div>
          )
        }

        // System messages (full mode only)
        if (msg.type === 'system') {
          return (
            <div key={msg.uuid} className="text-xs text-zinc-500 bg-zinc-800/30 rounded px-3 py-2 font-mono">
              [system] {msg.textContent.slice(0, 300)}
            </div>
          )
        }

        const isUser = msg.type === 'user'
        const isPreCompact = msg.isPreCompact

        return (
          <div
            key={msg.uuid}
            className={`flex gap-3 ${isPreCompact ? 'opacity-60' : ''}`}
          >
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
              isUser ? 'bg-blue-600' : 'bg-orange-600'
            }`}>
              {isUser ? <User size={14} /> : <Bot size={14} />}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-medium text-zinc-400">
                  {isUser ? 'User' : 'Assistant'}
                </span>
                <span className="text-[11px] text-zinc-600">{formatTime(msg.timestamp)}</span>
                {isPreCompact && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded">
                    compact前
                  </span>
                )}
              </div>
              {msg.textContent && (
                <div className="text-sm text-zinc-200 whitespace-pre-wrap break-words leading-relaxed">
                  {highlightText(msg.textContent)}
                </div>
              )}
              {/* Tool calls */}
              {viewMode === 'full' && msg.toolCalls.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.toolCalls.map((tc, j) => (
                    <ToolCallBlock key={j} name={tc.name} input={tc.input} />
                  ))}
                </div>
              )}
              {viewMode === 'compact' && msg.toolCalls.length > 0 && (
                <div className="mt-1 text-[11px] text-zinc-500">
                  {msg.toolCalls.map((tc) => tc.name).join(', ')} ({msg.toolCalls.length} calls)
                </div>
              )}
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}

function MessagePlaceholder() {
  return (
    <div className="text-center">
      <div className="text-4xl mb-3">💬</div>
      <div className="text-zinc-400">选择一个 Session 查看对话</div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add ChatViewer component with compact/full modes and highlight"
```

---

### Task 8: InfoPanel Component

**Files:**
- Create: `src/renderer/src/components/InfoPanel.tsx`

**Step 1: Implement InfoPanel**

```tsx
import { useStore } from '../store'
import {
  Clock, MessageSquare, FolderOpen, Wrench, Zap, FileText, HardDrive
} from 'lucide-react'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1048576).toFixed(1)}MB`
}

export function InfoPanel() {
  const { selectedSession, infoPanelOpen } = useStore()

  if (!infoPanelOpen || !selectedSession) return null

  const s = selectedSession
  const toolEntries = Object.entries(s.toolUsage).sort((a, b) => b[1] - a[1])

  return (
    <div className="w-70 h-full border-l border-zinc-700 bg-zinc-900 overflow-y-auto">
      <div className="p-4 space-y-4">
        <h3 className="text-sm font-medium text-zinc-300">Session Info</h3>

        {/* Basic metadata */}
        <section className="space-y-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-400">
            <Clock size={12} />
            <span>创建：{formatDateTime(s.createdAt)}</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-400">
            <Clock size={12} />
            <span>修改：{formatDateTime(s.updatedAt)}</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-400">
            <MessageSquare size={12} />
            <span>{s.turnCount} 轮对话 ({s.messageCount} 条消息)</span>
          </div>
          {s.compactCount > 0 && (
            <div className="flex items-center gap-2 text-amber-400">
              <span>Compact: {s.compactCount} 次</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-zinc-400">
            <HardDrive size={12} />
            <span>{formatSize(s.fileSizeBytes)} · v{s.version}</span>
          </div>
        </section>

        {/* Working directories */}
        <section>
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
            <FolderOpen size={12} />
            <span>关联目录</span>
          </div>
          <div className="space-y-1">
            {s.cwds.map((cwd) => (
              <div key={cwd} className="text-xs text-zinc-500 font-mono truncate" title={cwd}>
                {cwd.replace(process.env.HOME || '/Users', '~')}
              </div>
            ))}
          </div>
        </section>

        {/* Tool usage */}
        {toolEntries.length > 0 && (
          <section>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              <Wrench size={12} />
              <span>工具调用</span>
            </div>
            <div className="space-y-1">
              {toolEntries.map(([name, count]) => (
                <div key={name} className="flex items-center justify-between text-xs">
                  <span className="text-zinc-400 font-mono">{name}</span>
                  <span className="text-zinc-500">{count}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Skill invocations */}
        {s.skillInvocations.length > 0 && (
          <section>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              <Zap size={12} />
              <span>Skill 调用</span>
            </div>
            <div className="space-y-1">
              {s.skillInvocations.map((si, i) => (
                <div key={i} className="text-xs">
                  <span className="text-zinc-400 font-mono">{si.skillName}</span>
                  <span className="text-zinc-600 ml-2">{formatDateTime(si.timestamp)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* CLAUDE.md content */}
        {s.claudeMdContent && (
          <section>
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400 mb-2">
              <FileText size={12} />
              <span>.claude 文档</span>
            </div>
            <pre className="text-[11px] text-zinc-500 bg-zinc-800 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">
              {s.claudeMdContent}
            </pre>
          </section>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add InfoPanel component with metadata, tools, skills, and claude docs"
```

---

### Task 9: Search Panel + Toolbar

**Files:**
- Create: `src/renderer/src/components/Toolbar.tsx`
- Create: `src/renderer/src/components/SearchResults.tsx`

**Step 1: Implement Toolbar**

Create `src/renderer/src/components/Toolbar.tsx`:
```tsx
import { useState, useCallback } from 'react'
import { useStore } from '../store'
import { Search, Eye, EyeOff, Play, PanelRight, X } from 'lucide-react'

export function Toolbar() {
  const {
    searchQuery, search, clearSearch,
    viewMode, toggleViewMode,
    selectedSession, resumeSession,
    infoPanelOpen, toggleInfoPanel
  } = useStore()
  const [inputValue, setInputValue] = useState(searchQuery)
  const [searchTimeout, setSearchTimeout] = useState<ReturnType<typeof setTimeout> | null>(null)

  const handleSearch = useCallback((value: string) => {
    setInputValue(value)
    if (searchTimeout) clearTimeout(searchTimeout)
    const timeout = setTimeout(() => {
      search(value)
    }, 300)
    setSearchTimeout(timeout)
  }, [search, searchTimeout])

  return (
    <div className="h-12 flex items-center gap-3 px-4 border-b border-zinc-700 bg-zinc-900 shrink-0"
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Spacer for traffic lights */}
      <div className="w-16 shrink-0" />

      {/* Search */}
      <div className="flex-1 max-w-lg relative" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          value={inputValue}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="搜索所有对话..."
          className="w-full pl-8 pr-8 py-1.5 text-sm bg-zinc-800 border border-zinc-700 rounded-md text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
        />
        {inputValue && (
          <button
            onClick={() => { setInputValue(''); clearSearch() }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={toggleViewMode}
          className="px-2 py-1 text-xs rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          title={viewMode === 'compact' ? '切换到完整模式' : '切换到精简模式'}
        >
          {viewMode === 'compact' ? <Eye size={14} /> : <EyeOff size={14} />}
          <span>{viewMode === 'compact' ? '精简' : '完整'}</span>
        </button>

        <button
          onClick={toggleInfoPanel}
          className={`p-1.5 rounded hover:bg-zinc-700 ${infoPanelOpen ? 'text-zinc-200' : 'text-zinc-500'}`}
          title="切换信息面板"
        >
          <PanelRight size={16} />
        </button>

        {selectedSession && (
          <button
            onClick={() => resumeSession(selectedSession.id)}
            className="ml-2 px-3 py-1 text-xs rounded bg-green-700 hover:bg-green-600 text-white flex items-center gap-1"
          >
            <Play size={12} />
            Resume
          </button>
        )}
      </div>
    </div>
  )
}
```

**Step 2: Implement SearchResults**

Create `src/renderer/src/components/SearchResults.tsx`:
```tsx
import { useStore } from '../store'
import { Search } from 'lucide-react'

export function SearchResults() {
  const { searchResults, searchQuery, sessions, selectSession } = useStore()

  if (!searchQuery || searchResults.length === 0) return null

  return (
    <div className="absolute inset-0 top-12 bg-zinc-900/95 z-50 overflow-y-auto p-4">
      <div className="max-w-2xl mx-auto">
        <div className="text-sm text-zinc-400 mb-4">
          <Search size={14} className="inline mr-2" />
          搜索 "{searchQuery}" — {searchResults.length} 个 session 匹配
        </div>
        <div className="space-y-3">
          {searchResults.map((result) => (
            <button
              key={result.sessionId}
              onClick={() => {
                selectSession(result.filePath)
              }}
              className="w-full text-left p-3 bg-zinc-800 hover:bg-zinc-750 rounded-lg border border-zinc-700 hover:border-zinc-600"
            >
              <div className="text-sm text-zinc-200 font-medium truncate mb-2">
                {result.firstUserMessage.slice(0, 100) || result.sessionId.slice(0, 12)}
              </div>
              {result.matches.map((match, i) => (
                <div key={i} className="text-xs text-zinc-400 mt-1 font-mono bg-zinc-900 rounded px-2 py-1">
                  <span className="text-zinc-600 mr-2">
                    {new Date(match.timestamp).toLocaleString('zh-CN', {
                      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                    })}
                  </span>
                  {match.text}
                </div>
              ))}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add Toolbar with search, view toggle, resume button, and SearchResults overlay"
```

---

### Task 10: App Shell — Assemble All Components

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/main.tsx`

**Step 1: Wire up App.tsx**

Replace `src/renderer/src/App.tsx`:
```tsx
import { useEffect } from 'react'
import { useStore } from './store'
import { Sidebar } from './components/Sidebar'
import { ChatViewer } from './components/ChatViewer'
import { InfoPanel } from './components/InfoPanel'
import { Toolbar } from './components/Toolbar'
import { SearchResults } from './components/SearchResults'

export default function App() {
  const { initialize, loading, searchQuery } = useStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-zinc-900 text-zinc-400">
        <div className="text-center">
          <div className="animate-spin w-8 h-8 border-2 border-zinc-600 border-t-zinc-300 rounded-full mx-auto mb-3" />
          <div className="text-sm">Loading sessions...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-900 text-white">
      <Toolbar />
      <div className="flex-1 flex overflow-hidden relative">
        <Sidebar />
        <ChatViewer />
        <InfoPanel />
        {searchQuery && <SearchResults />}
      </div>
    </div>
  )
}
```

**Step 2: Clean up main.tsx**

Ensure `src/renderer/src/main.tsx` has:
```tsx
import './assets/main.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

**Step 3: Verify it runs**

Run: `npm run dev`
Expected: App launches with sidebar showing all sessions, clicking one shows chat

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: assemble app shell with all components"
```

---

### Task 11: Drag-and-Drop Session to Folder

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

**Step 1: Add drag-and-drop**

Add to session card in Sidebar:
```tsx
// On the session button element, add:
draggable
onDragStart={(e) => {
  e.dataTransfer.setData('sessionId', session.id)
}}

// On folder buttons, add:
onDragOver={(e) => e.preventDefault()}
onDrop={(e) => {
  e.preventDefault()
  const sessionId = e.dataTransfer.getData('sessionId')
  if (sessionId) addSessionToFolder(folder.id, sessionId)
}}
```

Also add a right-click context menu to session cards with options:
- "移动到文件夹" → submenu with folder list
- "重命名"
- "从文件夹移除" (if in a folder view)

Use a simple state-managed dropdown rather than an external context menu library.

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add drag-and-drop sessions to folders and context menu"
```

---

### Task 12: Final Polish + Build Config

**Files:**
- Modify: `electron-builder.yml` or `electron.vite.config.ts`
- Create: `resources/icon.icns` (placeholder)

**Step 1: Configure app metadata**

In `package.json`, update:
```json
{
  "name": "claude-session-manager",
  "version": "1.0.0",
  "description": "Visual session manager for Claude Code",
  "productName": "Claude Session Manager"
}
```

**Step 2: Test build**

Run: `npm run build`
Expected: Builds to `dist/` directory

**Step 3: Verify all features work**

- [ ] All sessions load in sidebar
- [ ] Clicking a session shows full conversation (including pre-compact)
- [ ] Compact boundary is clearly marked
- [ ] Full/compact view mode toggle works
- [ ] Search finds text across all sessions
- [ ] Info panel shows metadata, tools, skills, CWD
- [ ] Resume button opens terminal with correct command
- [ ] Create/rename/delete folder works
- [ ] Drag session to folder works
- [ ] File watcher picks up new sessions

**Step 4: Final commit**

```bash
git add -A && git commit -m "chore: configure build, finalize v1.0"
```

---

## Summary

| Task | What | Estimated Complexity |
|------|------|---------------------|
| 1 | Scaffold project | Low |
| 2 | JSONL Parser | Medium |
| 3 | Config Store | Low |
| 4 | IPC Bridge | Medium |
| 5 | Zustand Store | Medium |
| 6 | Sidebar | Medium |
| 7 | ChatViewer | Medium |
| 8 | InfoPanel | Low |
| 9 | Search + Toolbar | Medium |
| 10 | App Shell | Low |
| 11 | Drag-and-Drop | Low |
| 12 | Polish + Build | Low |

Total: 12 tasks, all code provided inline.
