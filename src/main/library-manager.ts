import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { parseSessionFile, buildSessionSummary, filterMessagesByBranch } from './session-loader'
import { resolveSessionParent, DEFAULT_IGNORE_DIRS } from './session-placement'
import type { RawJsonlMessage, ContentPart, SessionSummary, Folder, UserConfig } from './types'

// ============ Types ============

export interface SessionMeta {
  sessionId: string
  sourceFilePaths: string[]
  customTitle?: string
  notes?: string
  highlights?: Array<{ id: string; text: string; turnUuid: string; note?: string; createdAt: string }>
  createdAt: string
  updatedAt: string
  projectPath: string
}

export interface LibrarySession {
  sessionId: string
  dirPath: string
  mdPath: string
  jsonlPath: string
  meta: SessionMeta
  isSymlink: boolean
}

export interface LibraryFolder {
  name: string
  dirPath: string
  sessions: LibrarySession[]
  children: LibraryFolder[]
}

export interface LibraryTree {
  root: string
  folders: LibraryFolder[]
  ungroupedSessions: LibrarySession[]
}

export interface SshConfig {
  host: string
  user: string
  remotePath?: string
}

export interface LibraryConfig {
  libraryRoot: string
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    sshConfig?: SshConfig
  }
  folderOrder?: string[]  // relative paths, determines display order
  branchFolders?: Record<string, string[]>  // branch unique ID → folder relative paths
  branchMeta?: Record<string, { customTitle?: string; notes?: string; highlights?: SessionMeta['highlights'] }>
  ignoreDirs?: string[]  // 库根设为整个 vault 时，扫描/放置时跳过的目录名（如 wiki、clipii）
}

// ============ Constants ============

const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'Swob')
const APP_CONFIG_DIR = path.join(os.homedir(), '.claude-session-manager')
const APP_CONFIG_FILE = path.join(APP_CONFIG_DIR, 'app-config.json')

export function loadAppConfig(): { libraryPath?: string } {
  try {
    if (fs.existsSync(APP_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

export function saveAppConfig(config: { libraryPath?: string }): void {
  if (!fs.existsSync(APP_CONFIG_DIR)) {
    fs.mkdirSync(APP_CONFIG_DIR, { recursive: true })
  }
  const existing = loadAppConfig()
  fs.writeFileSync(APP_CONFIG_FILE, JSON.stringify({ ...existing, ...config }, null, 2), 'utf-8')
}

export function getConfiguredLibraryPath(): string {
  const appConfig = loadAppConfig()
  return appConfig.libraryPath || DEFAULT_ROOT
}

export function isLibraryInitialized(rootPath: string): boolean {
  const configFile = path.join(rootPath, LIBRARY_CONFIG_FILE)
  return fs.existsSync(configFile)
}
const SESSION_META_FILE = '.swob-session.json'
const LIBRARY_CONFIG_FILE = '.swob-config.json'
const TRANSCRIPT_FILE = 'transcript.md'
const BACKUP_FILE = 'backup.jsonl'

// ============ Library Manager ============

let _root: string = DEFAULT_ROOT
let _ignoreDirs: Set<string> = new Set(DEFAULT_IGNORE_DIRS)

export function getLibraryRoot(): string {
  return _root
}

export function getIgnoreDirs(): Set<string> {
  return _ignoreDirs
}

export function initLibrary(root?: string): void {
  _root = root || getConfiguredLibraryPath()
  if (!fs.existsSync(_root)) {
    fs.mkdirSync(_root, { recursive: true })
  }
  // 库根可能是整个 vault：加载忽略名单，避免扫描 wiki/clipii/日记 等非项目目录
  const cfg = loadLibraryConfig()
  _ignoreDirs = new Set(cfg.ignoreDirs && cfg.ignoreDirs.length ? cfg.ignoreDirs : DEFAULT_IGNORE_DIRS)
}

// --- Config ---

export function loadLibraryConfig(): LibraryConfig {
  const configPath = path.join(_root, LIBRARY_CONFIG_FILE)
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {
    libraryRoot: _root,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }
}

export function saveLibraryConfig(config: LibraryConfig): void {
  const configPath = path.join(_root, LIBRARY_CONFIG_FILE)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
}

// --- Session Dir Naming ---

function sanitizeDirName(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'untitled'
}

function findUniqueDirName(parentDir: string, baseName: string): string {
  let name = baseName
  let counter = 2
  while (fs.existsSync(path.join(parentDir, name))) {
    name = `${baseName} (${counter})`
    counter++
  }
  return name
}

// --- Session Meta ---

function readSessionMeta(dirPath: string): SessionMeta | null {
  const metaPath = path.join(dirPath, SESSION_META_FILE)
  try {
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
    }
  } catch { /* corrupt */ }
  return null
}

function writeSessionMeta(dirPath: string, meta: SessionMeta): void {
  const metaPath = path.join(dirPath, SESSION_META_FILE)
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8')
}

function isSessionDir(dirPath: string): boolean {
  return fs.existsSync(path.join(dirPath, SESSION_META_FILE))
}

/**
 * 文件夹（递归）是否含有「非会话」的用户文件。
 *
 * 库根可能 = 整个 vault，于是 wiki/、项目/飞搜/ 这类含笔记的真实目录会作为
 * 「文件夹」出现在 swob 里。删除文件夹是递归强删（fs.rmSync force），一旦误删
 * 这种目录就会毁掉用户笔记。此函数用于在删除前拦截：会话目录内部的文件
 * （transcript.md / backup.jsonl 等）是允许的，但非会话目录里的散文件 = 用户内容，
 * 一旦发现就拒绝删除。
 */
function folderHasUserFiles(dirPath: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dirPath, entry.name)
    let realPath = fullPath
    try {
      if (fs.lstatSync(fullPath).isSymbolicLink()) realPath = fs.realpathSync(fullPath)
    } catch {
      continue // broken symlink
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(realPath)
    } catch {
      continue
    }
    if (stat.isFile()) return true // 散文件 = 用户内容
    if (stat.isDirectory()) {
      if (isSessionDir(realPath)) continue // 会话目录内部文件是允许的
      if (folderHasUserFiles(realPath)) return true
    }
  }
  return false
}

// --- Index: sessionId → dirPath ---

const sessionIndex = new Map<string, string>()

export function getSessionDirPath(sessionId: string): string | null {
  return sessionIndex.get(sessionId) || null
}

export function getSessionMdPath(sessionId: string): string | null {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return null
  const mdPath = path.join(dirPath, TRANSCRIPT_FILE)
  return fs.existsSync(mdPath) ? mdPath : null
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const rel = path.relative(parentDir, childPath)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isRestorableLocalClaudeSource(sourcePath: string): boolean {
  const home = os.homedir()
  const localClaudeProjects = path.join(home, '.claude', 'projects')
  if (isPathInside(localClaudeProjects, sourcePath)) return true

  const localClaudeWindowRoot = path.join(home, '.claude-window')
  const rel = path.relative(localClaudeWindowRoot, sourcePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false
  const parts = rel.split(path.sep)
  return parts.length >= 4 && !!parts[0] && parts[1] === 'projects'
}

export function restoreBackupToClaudeSource(sessionId: string): {
  restored: boolean
  sourcePath: string | null
  reason?: string
} {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return { restored: false, sourcePath: null, reason: 'session-not-in-library' }

  const meta = readSessionMeta(dirPath)
  if (!meta) return { restored: false, sourcePath: null, reason: 'missing-meta' }

  const existingSource = meta.sourceFilePaths.find((src) => fs.existsSync(src))
  if (existingSource) return { restored: false, sourcePath: existingSource, reason: 'source-exists' }

  const sourcePath = meta.sourceFilePaths[0]
  if (!sourcePath) return { restored: false, sourcePath: null, reason: 'missing-source-path' }

  if (!isRestorableLocalClaudeSource(sourcePath)) {
    return { restored: false, sourcePath, reason: 'source-outside-local-claude-projects' }
  }

  const backupPath = path.join(dirPath, BACKUP_FILE)
  if (!fs.existsSync(backupPath)) return { restored: false, sourcePath, reason: 'missing-backup' }

  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.copyFileSync(backupPath, sourcePath)
  return { restored: true, sourcePath }
}

/**
 * Get or generate an independent transcript for a branch session.
 * Branch transcripts are stored alongside the main transcript as `transcript-intra-N.md`.
 */
export function getBranchMdPath(branchId: string): string | null {
  // branchId = "abc-123:intra-0" → baseId = "abc-123", suffix = "intra-0"
  const colonIdx = branchId.indexOf(':intra-')
  if (colonIdx === -1) return getSessionMdPath(branchId)
  const baseId = branchId.slice(0, colonIdx)
  const suffix = branchId.slice(colonIdx + 1) // "intra-0"
  const dirPath = sessionIndex.get(baseId)
  if (!dirPath) return null
  const mdPath = path.join(dirPath, `transcript-${suffix}.md`)
  return fs.existsSync(mdPath) ? mdPath : null
}

/**
 * Generate and write a branch-specific transcript.
 */
export async function updateBranchTranscript(
  branchId: string,
  branchLeafUuid: string,
  customTitle?: string
): Promise<string | null> {
  const colonIdx = branchId.indexOf(':intra-')
  if (colonIdx === -1) return null
  const baseId = branchId.slice(0, colonIdx)
  const suffix = branchId.slice(colonIdx + 1)
  const dirPath = sessionIndex.get(baseId)
  if (!dirPath) return null

  const meta = readSessionMeta(dirPath)
  if (!meta) return null

  // Parse source files
  const allRaw: RawJsonlMessage[] = []
  for (const src of meta.sourceFilePaths) {
    try {
      if (fs.existsSync(src)) {
        const raw = await parseSessionFile(src)
        allRaw.push(...raw)
      }
    } catch { /* skip */ }
  }
  if (allRaw.length === 0) return null

  // Filter to this branch's messages only
  const branchRaw = filterMessagesByBranch(allRaw, branchLeafUuid)
  if (branchRaw.length === 0) return null

  const summary = buildSessionSummary(meta.sourceFilePaths[0], branchRaw, true)
  if (!summary) return null

  const title = customTitle || summary.firstUserMessage?.slice(0, 60) || branchId.slice(0, 12)
  const md = generateTranscript(branchRaw, title, {
    createdAt: summary.createdAt,
    turnCount: summary.turnCount,
    toolUsage: summary.toolUsage
  })

  const mdPath = path.join(dirPath, `transcript-${suffix}.md`)
  fs.writeFileSync(mdPath, md, 'utf-8')
  return mdPath
}

// --- Scan Library ---

function scanDir(dirPath: string): { sessions: LibrarySession[]; folders: LibraryFolder[] } {
  const sessions: LibrarySession[] = []
  const folders: LibraryFolder[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return { sessions, folders }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    // Skip iCloud placeholder files (e.g. .filename.icloud)
    if (entry.name.includes('.icloud')) continue
    // 库根设为整个 vault 时，跳过 wiki/clipii/日记 等非项目目录
    if (_ignoreDirs.has(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)

    // Resolve symlinks
    let realPath = fullPath
    let isSymlink = false
    try {
      const lstat = fs.lstatSync(fullPath)
      isSymlink = lstat.isSymbolicLink()
      if (isSymlink) {
        realPath = fs.realpathSync(fullPath)
      }
    } catch {
      continue // broken symlink or iCloud download in progress
    }

    if (!fs.statSync(realPath).isDirectory()) continue

    if (isSessionDir(realPath)) {
      const meta = readSessionMeta(realPath)
      if (meta) {
        sessions.push({
          sessionId: meta.sessionId,
          dirPath: realPath,
          mdPath: path.join(realPath, TRANSCRIPT_FILE),
          jsonlPath: path.join(realPath, BACKUP_FILE),
          meta,
          isSymlink
        })
      }
    } else {
      // It's a user folder — recurse
      const sub = scanDir(fullPath)
      folders.push({
        name: entry.name,
        dirPath: fullPath,
        sessions: sub.sessions,
        children: sub.folders
      })
    }
  }

  return { sessions, folders }
}

export function scanLibrary(): LibraryTree {
  const { sessions, folders } = scanDir(_root)

  // Rebuild index
  sessionIndex.clear()
  function indexSessions(list: LibrarySession[]): void {
    for (const s of list) {
      if (!s.isSymlink) {
        sessionIndex.set(s.sessionId, s.dirPath)
      }
    }
  }
  function indexFolder(f: LibraryFolder): void {
    indexSessions(f.sessions)
    for (const child of f.children) indexFolder(child)
  }

  indexSessions(sessions)
  for (const f of folders) indexFolder(f)

  return { root: _root, folders, ungroupedSessions: sessions }
}

// --- Transcript Generation (main process) ---
// Format optimized for AI consumption: minimal tokens, max information.

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n')
}

function extractToolCalls(content: string | ContentPart[] | undefined): string[] {
  if (!content || typeof content === 'string') return []
  const calls: string[] = []
  for (const part of content) {
    if (part.type !== 'tool_use' || !part.name) continue
    const input = part.input || {}
    // Compact summary: tool name + most informative param
    if (part.name === 'Bash' && input.command) {
      const cmd = String(input.command).split('\n')[0].slice(0, 120)
      calls.push(`[${part.name}] ${cmd}`)
    } else if ((part.name === 'Read' || part.name === 'Write' || part.name === 'Edit') && input.file_path) {
      calls.push(`[${part.name}] ${input.file_path}`)
    } else if (part.name === 'Grep' && input.pattern) {
      calls.push(`[${part.name}] ${input.pattern}`)
    } else if (part.name === 'Agent' && input.prompt) {
      calls.push(`[${part.name}] ${String(input.prompt).slice(0, 80)}`)
    } else {
      calls.push(`[${part.name}]`)
    }
  }
  return calls
}

function formatTs(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function generateTranscript(
  rawMessages: RawJsonlMessage[],
  title: string,
  meta: { createdAt: string; turnCount: number; toolUsage?: Record<string, number> }
): string {
  const lines: string[] = []

  // Header: one compact block
  lines.push(`# ${title}\n`)
  const created = formatTs(meta.createdAt)
  const toolSummary = meta.toolUsage
    ? Object.entries(meta.toolUsage).sort(([, a], [, b]) => b - a).slice(0, 6)
        .map(([name, count]) => `${name}(${count})`).join(', ')
    : ''
  lines.push(`> ${created} | ${meta.turnCount} 轮对话${toolSummary ? ` | Tools: ${toolSummary}` : ''}`)
  lines.push('')

  // Messages: role label + content, no duplication
  const validMessages = rawMessages.filter(
    (m) => (m.type === 'user' || m.type === 'assistant') && m.message
  )

  for (const msg of validMessages) {
    const text = extractText(msg.message?.content).trim()
    const ts = msg.timestamp ? formatTs(msg.timestamp) : ''

    if (msg.type === 'user') {
      if (!text) continue
      lines.push(`**User** [${ts}]`)
      lines.push(text)
      lines.push('')
    } else if (msg.type === 'assistant') {
      const tools = extractToolCalls(msg.message?.content)
      if (!text && tools.length === 0) continue
      lines.push(`**Assistant** [${ts}]`)
      if (tools.length > 0) {
        for (const t of tools) lines.push(t)
      }
      if (text) lines.push(text)
      lines.push('')
    }
  }

  return lines.join('\n')
}

// --- Ensure Session in Library ---

export async function ensureSessionInLibrary(
  session: SessionSummary,
  customTitle?: string
): Promise<string> {
  const existing = sessionIndex.get(session.sessionId)

  if (existing && fs.existsSync(existing)) {
    // Already exists — update meta if needed
    const meta = readSessionMeta(existing)
    if (meta) {
      let changed = false
      if (customTitle && meta.customTitle !== customTitle) {
        meta.customTitle = customTitle
        changed = true
      }
      if (meta.updatedAt !== session.updatedAt) {
        meta.updatedAt = session.updatedAt
        meta.sourceFilePaths = session.allFilePaths || [session.filePath]
        changed = true
      }
      if (changed) writeSessionMeta(existing, meta)
    }
    return existing
  }

  // Create new session dir.
  // 按启动目录归档：vault 内项目目录启动 → <cwd>/AI会话/；否则 → 中央桶 <root>/AI会话/。
  // 任何会话都不会落在库根本身（即便库根 = vault）。
  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId.slice(0, 12)
  const baseName = sanitizeDirName(title)
  const parentDir = resolveSessionParent(session.cwds, _root, _ignoreDirs)
  fs.mkdirSync(parentDir, { recursive: true })
  const dirName = findUniqueDirName(parentDir, baseName)
  const dirPath = path.join(parentDir, dirName)

  fs.mkdirSync(dirPath, { recursive: true })

  const meta: SessionMeta = {
    sessionId: session.sessionId,
    sourceFilePaths: session.allFilePaths || [session.filePath],
    customTitle,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    projectPath: session.projectPath
  }
  writeSessionMeta(dirPath, meta)
  sessionIndex.set(session.sessionId, dirPath)

  return dirPath
}

// --- Sync JSONL Backup ---

export async function syncBackup(sessionId: string): Promise<void> {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return

  const meta = readSessionMeta(dirPath)
  if (!meta) return

  const backupPath = path.join(dirPath, BACKUP_FILE)

  // Concatenate all source files into one backup
  const allContent: string[] = []
  for (const src of meta.sourceFilePaths) {
    try {
      if (fs.existsSync(src)) {
        allContent.push(fs.readFileSync(src, 'utf-8'))
      }
    } catch { /* skip */ }
  }
  if (allContent.length > 0) {
    fs.writeFileSync(backupPath, allContent.join('\n'), 'utf-8')
  }
}

// --- Update Transcript ---

export async function updateTranscript(sessionId: string, customTitle?: string): Promise<void> {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return

  const meta = readSessionMeta(dirPath)
  if (!meta) return

  // Parse all source files
  const allRaw: RawJsonlMessage[] = []
  for (const src of meta.sourceFilePaths) {
    try {
      if (fs.existsSync(src)) {
        const raw = await parseSessionFile(src)
        allRaw.push(...raw)
      }
    } catch { /* skip */ }
  }
  if (allRaw.length === 0) return

  const summary = buildSessionSummary(meta.sourceFilePaths[0], allRaw, true)
  if (!summary) return

  const title = customTitle || meta.customTitle || summary.firstUserMessage?.slice(0, 60) || sessionId.slice(0, 12)
  const md = generateTranscript(allRaw, title, {
    createdAt: meta.createdAt,
    turnCount: summary.turnCount,
    toolUsage: summary.toolUsage
  })

  const mdPath = path.join(dirPath, TRANSCRIPT_FILE)
  fs.writeFileSync(mdPath, md, 'utf-8')

  // Update meta timestamps
  meta.updatedAt = summary.updatedAt
  writeSessionMeta(dirPath, meta)
}

// --- Folder Operations ---

export function createLibraryFolder(name: string, parentPath?: string): string {
  const parent = parentPath || _root
  const dirName = findUniqueDirName(parent, sanitizeDirName(name))
  const dirPath = path.join(parent, dirName)
  fs.mkdirSync(dirPath, { recursive: true })
  return dirPath
}

export function renameLibraryFolder(folderPath: string, newName: string): string {
  const parent = path.dirname(folderPath)
  const currentName = path.basename(folderPath)
  const sanitized = sanitizeDirName(newName)

  // Skip if name hasn't changed — avoids (2) suffix
  if (sanitized === currentName) return folderPath

  const newDirName = findUniqueDirName(parent, sanitized)
  const newPath = path.join(parent, newDirName)

  // Update folderOrder before rename
  updateFolderOrderPaths(path.relative(_root, folderPath), path.relative(_root, newPath))

  fs.renameSync(folderPath, newPath)
  return newPath
}

export function moveLibraryFolderToParent(srcPath: string, destParentPath: string): string {
  if (path.dirname(srcPath) === destParentPath) return srcPath

  const baseName = path.basename(srcPath)
  const newName = findUniqueDirName(destParentPath, baseName)
  const newPath = path.join(destParentPath, newName)

  // Update folderOrder before move
  updateFolderOrderPaths(path.relative(_root, srcPath), path.relative(_root, newPath))

  fs.renameSync(srcPath, newPath)
  return newPath
}

export function deleteLibraryFolder(folderPath: string): void {
  // Only delete if it's a folder (no .swob-session.json)
  if (isSessionDir(folderPath)) return

  // 安全护栏：库根可能 = 整个 vault，拒绝删除含用户笔记的真实目录（如 wiki/、项目/飞搜/）。
  // 正常的 swob 文件夹只含会话/子文件夹，不会触发；含散文件的目录会被拦下。
  if (folderHasUserFiles(folderPath)) {
    throw new Error(
      `拒绝删除：「${path.basename(folderPath)}」含有非会话文件（可能是你的笔记/文档）。` +
      `如果库根设成了整个 vault，请在文件系统里手动确认后再删。`
    )
  }

  // Recursively collect ALL sessions (including those in subfolders)
  function collectAllSessions(dirPath: string): LibrarySession[] {
    const result: LibrarySession[] = []
    const { sessions, folders } = scanDir(dirPath)
    result.push(...sessions)
    for (const f of folders) {
      result.push(...collectAllSessions(f.dirPath))
    }
    return result
  }

  const allSessions = collectAllSessions(folderPath)
  for (const s of allSessions) {
    if (!s.isSymlink) {
      const baseName = path.basename(s.dirPath)
      const newName = findUniqueDirName(_root, baseName)
      const newPath = path.join(_root, newName)
      fs.renameSync(s.dirPath, newPath)
      sessionIndex.set(s.sessionId, newPath)
    }
  }

  // Now delete the folder (only symlinks/empty subdirs remain)
  fs.rmSync(folderPath, { recursive: true, force: true })
}

export function moveSessionToFolder(sessionId: string, folderPath: string): void {
  const currentDir = sessionIndex.get(sessionId)
  if (!currentDir || !fs.existsSync(currentDir)) return

  const baseName = path.basename(currentDir)
  const newName = findUniqueDirName(folderPath, baseName)
  const newPath = path.join(folderPath, newName)

  // Remove any existing symlinks to this session in the target folder
  removeSessionSymlinksIn(currentDir, folderPath)

  fs.renameSync(currentDir, newPath)
  sessionIndex.set(sessionId, newPath)
}

export function addSessionToFolder(sessionId: string, folderPath: string): void {
  const currentDir = sessionIndex.get(sessionId)
  if (!currentDir || !fs.existsSync(currentDir)) return

  // Check if already in this folder (directly or via symlink)
  const baseName = path.basename(currentDir)
  const targetPath = path.join(folderPath, baseName)
  if (fs.existsSync(targetPath)) return

  // Create symlink
  fs.symlinkSync(currentDir, targetPath)
}

export function removeSessionFromFolder(sessionId: string, folderPath: string): void {
  const realDir = sessionIndex.get(sessionId)
  if (!realDir) return

  // Find and remove symlinks or the real dir in this folder
  const entries = fs.readdirSync(folderPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(folderPath, entry.name)
    try {
      const lstat = fs.lstatSync(fullPath)
      if (lstat.isSymbolicLink()) {
        const target = fs.realpathSync(fullPath)
        if (target === realDir) {
          fs.unlinkSync(fullPath)
          return
        }
      } else if (fullPath === realDir) {
        // It's the real dir — move to library root
        const newName = findUniqueDirName(_root, entry.name)
        fs.renameSync(fullPath, path.join(_root, newName))
        sessionIndex.set(sessionId, path.join(_root, newName))
        return
      }
    } catch { /* ignore */ }
  }
}

function removeSessionSymlinksIn(realDir: string, searchDir: string): void {
  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(searchDir, entry.name)
      try {
        const lstat = fs.lstatSync(fullPath)
        if (lstat.isSymbolicLink()) {
          const target = fs.realpathSync(fullPath)
          if (target === realDir) {
            fs.unlinkSync(fullPath)
          }
        }
      } catch { /* broken symlink */ }
    }
  } catch { /* ignore */ }
}

// --- Rename Session Dir (when custom title changes) ---

export function renameSessionDir(sessionId: string, newTitle: string): string | null {
  const currentDir = sessionIndex.get(sessionId)
  if (!currentDir || !fs.existsSync(currentDir)) return null

  const parent = path.dirname(currentDir)
  const newBaseName = sanitizeDirName(newTitle)
  if (newBaseName === path.basename(currentDir)) return currentDir

  const newDirName = findUniqueDirName(parent, newBaseName)
  const newPath = path.join(parent, newDirName)

  // Update any symlinks pointing to the old path
  updateSymlinksRecursive(_root, currentDir, newPath)

  fs.renameSync(currentDir, newPath)
  sessionIndex.set(sessionId, newPath)

  return newPath
}

function updateSymlinksRecursive(searchDir: string, oldTarget: string, newTarget: string): void {
  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(searchDir, entry.name)
      try {
        const lstat = fs.lstatSync(fullPath)
        if (lstat.isSymbolicLink()) {
          const target = fs.realpathSync(fullPath)
          if (target === oldTarget) {
            fs.unlinkSync(fullPath)
            fs.symlinkSync(newTarget, fullPath)
          }
        } else if (lstat.isDirectory() && !isSessionDir(fullPath)) {
          updateSymlinksRecursive(fullPath, oldTarget, newTarget)
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// --- Batch Initialize Library from Sessions ---

export async function syncLibraryFromSessions(
  sessions: SessionSummary[],
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>
): Promise<void> {
  for (const session of sessions) {
    const customTitle = sessionMeta[session.sessionId]?.customTitle
    const dirPath = await ensureSessionInLibrary(session, customTitle)

    // Update transcript
    const mdPath = path.join(dirPath, TRANSCRIPT_FILE)
    const metaPath = path.join(dirPath, SESSION_META_FILE)

    // Only regenerate transcript if source is newer
    let needsUpdate = !fs.existsSync(mdPath)
    if (!needsUpdate) {
      try {
        const mdMtime = fs.statSync(mdPath).mtimeMs
        for (const src of session.allFilePaths || [session.filePath]) {
          if (fs.existsSync(src) && fs.statSync(src).mtimeMs > mdMtime) {
            needsUpdate = true
            break
          }
        }
      } catch {
        needsUpdate = true
      }
    }

    if (needsUpdate) {
      await updateTranscript(session.sessionId, customTitle)
    }

    // Sync backup if needed
    const backupPath = path.join(dirPath, BACKUP_FILE)
    let backupNeedsUpdate = !fs.existsSync(backupPath)
    if (!backupNeedsUpdate) {
      try {
        const bkMtime = fs.statSync(backupPath).mtimeMs
        for (const src of session.allFilePaths || [session.filePath]) {
          if (fs.existsSync(src) && fs.statSync(src).mtimeMs > bkMtime) {
            backupNeedsUpdate = true
            break
          }
        }
      } catch {
        backupNeedsUpdate = true
      }
    }

    if (backupNeedsUpdate) {
      await syncBackup(session.sessionId)
    }
  }
}

// --- Migrate from Old Config ---

export async function migrateFromOldConfig(
  oldFolders: Array<{ id: string; name: string; parentId?: string | null; sessionIds: string[]; color?: string }>,
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>
): Promise<void> {
  // Build folder tree: id → folderPath
  const folderPaths = new Map<string, string>()

  // Create root-level folders first
  const rootFolders = oldFolders.filter((f) => !f.parentId)
  for (const f of rootFolders) {
    const dirPath = createLibraryFolder(f.name)
    folderPaths.set(f.id, dirPath)
  }

  // Create child folders
  let remaining = oldFolders.filter((f) => f.parentId)
  let maxIter = 10
  while (remaining.length > 0 && maxIter-- > 0) {
    const next: typeof remaining = []
    for (const f of remaining) {
      const parentPath = folderPaths.get(f.parentId!)
      if (parentPath) {
        const dirPath = createLibraryFolder(f.name, parentPath)
        folderPaths.set(f.id, dirPath)
      } else {
        next.push(f)
      }
    }
    remaining = next
  }

  // Move sessions into their folders
  for (const f of oldFolders) {
    const folderPath = folderPaths.get(f.id)
    if (!folderPath) continue

    for (const sessionId of f.sessionIds) {
      const sessionDir = sessionIndex.get(sessionId)
      if (!sessionDir) continue
      moveSessionToFolder(sessionId, folderPath)
    }
  }

  // Update custom titles in meta
  for (const [sessionId, meta] of Object.entries(sessionMeta)) {
    const dirPath = sessionIndex.get(sessionId)
    if (!dirPath) continue
    const existing = readSessionMeta(dirPath)
    if (existing) {
      if (meta.customTitle) existing.customTitle = meta.customTitle
      if (meta.notes) existing.notes = meta.notes
      writeSessionMeta(dirPath, existing)
    }
  }
}

// --- Adapter: Library Tree → Old Config Format ---
// Converts the file-based library structure into the UserConfig format
// that the frontend expects, minimizing frontend changes.

export function libraryTreeToConfig(tree: LibraryTree): UserConfig {
  const folders: Folder[] = []
  const sessionMeta: UserConfig['sessionMeta'] = {}

  function processFolder(f: LibraryFolder, parentId: string | null): void {
    const id = path.relative(_root, f.dirPath)
    folders.push({
      id,
      name: f.name,
      parentId,
      sessionIds: f.sessions.map((s) => s.sessionId),
      createdAt: ''
    })
    for (const s of f.sessions) {
      if (s.meta.customTitle || s.meta.notes || (s.meta.highlights && s.meta.highlights.length > 0)) {
        sessionMeta[s.sessionId] = {
          customTitle: s.meta.customTitle,
          notes: s.meta.notes,
          highlights: s.meta.highlights
        }
      }
    }
    // Sort children by folder order too
    const libConfig = loadLibraryConfig()
    const order = libConfig.folderOrder || []
    const sorted = [...f.children].sort((a, b) => {
      const ai = order.indexOf(path.relative(_root, a.dirPath))
      const bi = order.indexOf(path.relative(_root, b.dirPath))
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name)
      if (ai === -1) return 1
      if (bi === -1) return -1
      return ai - bi
    })
    for (const child of sorted) {
      processFolder(child, id)
    }
  }

  // Sort root-level folders by folder order
  const libConfig = loadLibraryConfig()
  const order = libConfig.folderOrder || []
  const sortedRoots = [...tree.folders].sort((a, b) => {
    const ai = order.indexOf(path.relative(_root, a.dirPath))
    const bi = order.indexOf(path.relative(_root, b.dirPath))
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })

  for (const f of sortedRoots) processFolder(f, null)
  for (const s of tree.ungroupedSessions) {
    if (s.meta.customTitle || s.meta.notes || (s.meta.highlights && s.meta.highlights.length > 0)) {
      sessionMeta[s.sessionId] = {
        customTitle: s.meta.customTitle,
        notes: s.meta.notes,
        highlights: s.meta.highlights
      }
    }
  }

  // Inject branch-to-folder assignments from config
  const branchFolders = libConfig.branchFolders || {}
  for (const [branchId, folderIds] of Object.entries(branchFolders)) {
    for (const fid of folderIds) {
      const folder = folders.find((f) => f.id === fid)
      if (folder && !folder.sessionIds.includes(branchId)) {
        folder.sessionIds.push(branchId)
      }
    }
  }

  // Inject branch meta from config
  const branchMetaMap = libConfig.branchMeta || {}
  for (const [branchId, meta] of Object.entries(branchMetaMap)) {
    sessionMeta[branchId] = meta
  }

  return {
    folders,
    sessionMeta,
    preferences: libConfig.preferences
  }
}

// Helper: update folderOrder entries when a folder is renamed or moved
function updateFolderOrderPaths(oldRelPath: string, newRelPath: string): void {
  const config = loadLibraryConfig()
  if (!config.folderOrder || config.folderOrder.length === 0) return
  let changed = false
  config.folderOrder = config.folderOrder.map(id => {
    if (id === oldRelPath) { changed = true; return newRelPath }
    if (id.startsWith(oldRelPath + '/')) { changed = true; return newRelPath + id.slice(oldRelPath.length) }
    return id
  })
  if (changed) saveLibraryConfig(config)
}

// Update folder display order: move folderId before/after targetId
export function reorderFolder(folderId: string, targetId: string, position: 'before' | 'after'): void {
  const config = loadLibraryConfig()
  let order = config.folderOrder || []

  // Ensure both folders are in the order array
  // First, collect all current folder IDs from the tree
  const tree = scanLibrary()
  function collectFolderIds(folders: LibraryFolder[], prefix: string): string[] {
    const ids: string[] = []
    for (const f of folders) {
      const id = prefix ? `${prefix}/${f.name}` : path.relative(_root, f.dirPath)
      ids.push(id)
      ids.push(...collectFolderIds(f.children, id))
    }
    return ids
  }
  const allIds = collectFolderIds(tree.folders, '')

  // Initialize order with all known IDs that aren't already in it
  for (const id of allIds) {
    if (!order.includes(id)) order.push(id)
  }

  // Remove the dragged folder from its current position
  order = order.filter((id) => id !== folderId)

  // Insert at the target position
  const targetIdx = order.indexOf(targetId)
  if (targetIdx === -1) {
    order.push(folderId)
  } else {
    const insertIdx = position === 'before' ? targetIdx : targetIdx + 1
    order.splice(insertIdx, 0, folderId)
  }

  config.folderOrder = order
  saveLibraryConfig(config)
}

// Resolve a folder ID (relative path) to absolute path
export function resolveFolderPath(folderId: string): string {
  return path.join(_root, folderId)
}

// --- Branch folder management (stored in config, not file system) ---

export function addBranchToFolder(branchId: string, folderId: string): void {
  const config = loadLibraryConfig()
  const map = config.branchFolders || {}
  const folders = map[branchId] || []
  if (!folders.includes(folderId)) folders.push(folderId)
  map[branchId] = folders
  config.branchFolders = map
  saveLibraryConfig(config)
}

export function removeBranchFromFolder(branchId: string, folderId: string): void {
  const config = loadLibraryConfig()
  const map = config.branchFolders || {}
  const folders = map[branchId] || []
  const idx = folders.indexOf(folderId)
  if (idx !== -1) folders.splice(idx, 1)
  if (folders.length === 0) delete map[branchId]
  else map[branchId] = folders
  config.branchFolders = map
  saveLibraryConfig(config)
}

export function setBranchMeta(
  branchId: string,
  meta: { customTitle?: string; notes?: string; highlights?: SessionMeta['highlights'] }
): void {
  const config = loadLibraryConfig()
  const map = config.branchMeta || {}
  map[branchId] = { ...(map[branchId] || {}), ...meta }
  config.branchMeta = map
  saveLibraryConfig(config)
}

// Update session meta (.swob-session.json) and optionally rename dir
export function setSessionMetaInLibrary(
  sessionId: string,
  meta: { customTitle?: string; notes?: string; highlights?: SessionMeta['highlights'] }
): void {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return

  const existing = readSessionMeta(dirPath)
  if (!existing) return

  if (meta.customTitle !== undefined) existing.customTitle = meta.customTitle
  if (meta.notes !== undefined) existing.notes = meta.notes
  if (meta.highlights !== undefined) existing.highlights = meta.highlights
  writeSessionMeta(dirPath, existing)

  // Rename dir if title changed
  if (meta.customTitle) {
    renameSessionDir(sessionId, meta.customTitle)
  }
}

// ============ Library-only Sessions ============

/**
 * Find sessions in Library that don't exist in the local session set.
 * Returns backup.jsonl paths for sessions only available via Library (e.g. from another device).
 */
export function findLibraryOnlySessions(localSessionIds: Set<string>): Array<{
  sessionId: string
  backupPath: string
  meta: SessionMeta
}> {
  const results: Array<{ sessionId: string; backupPath: string; meta: SessionMeta }> = []

  function walk(dirPath: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch { return }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dirPath, entry.name)
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue
      } catch { continue }

      if (isSessionDir(fullPath)) {
        const meta = readSessionMeta(fullPath)
        if (!meta) continue
        if (localSessionIds.has(meta.sessionId)) continue
        const backupPath = path.join(fullPath, BACKUP_FILE)
        if (fs.existsSync(backupPath)) {
          results.push({ sessionId: meta.sessionId, backupPath, meta })
          sessionIndex.set(meta.sessionId, fullPath)
        }
      } else {
        walk(fullPath)
      }
    }
  }

  walk(_root)
  return results
}

export function findLibrarySessionsWithMissingSources(): Array<{
  sessionId: string
  backupPath: string
  meta: SessionMeta
}> {
  const results: Array<{ sessionId: string; backupPath: string; meta: SessionMeta }> = []

  function walk(dirPath: string): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch { return }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(dirPath, entry.name)
      try {
        if (!fs.statSync(fullPath).isDirectory()) continue
      } catch { continue }

      if (isSessionDir(fullPath)) {
        const meta = readSessionMeta(fullPath)
        if (!meta) continue
        const hasExistingSource = meta.sourceFilePaths.some((src) => fs.existsSync(src))
        const backupPath = path.join(fullPath, BACKUP_FILE)
        if (!hasExistingSource && fs.existsSync(backupPath)) {
          results.push({ sessionId: meta.sessionId, backupPath, meta })
          sessionIndex.set(meta.sessionId, fullPath)
        }
      } else {
        walk(fullPath)
      }
    }
  }

  walk(_root)
  return results
}

// ============ iCloud Detection ============

/**
 * Check if a file path is an iCloud placeholder (not yet downloaded).
 * macOS stores cloud-only files as hidden .icloud files with the original name prefixed by dot.
 * E.g., "transcript.md" becomes ".transcript.md.icloud"
 */
export function isICloudPlaceholder(filePath: string): boolean {
  try {
    // Direct check: the file itself has .icloud extension
    if (filePath.endsWith('.icloud')) return true
    // Check if corresponding .icloud placeholder exists for this file
    const dir = path.dirname(filePath)
    const base = path.basename(filePath)
    const placeholder = path.join(dir, `.${base}.icloud`)
    return fs.existsSync(placeholder)
  } catch {
    return false
  }
}

/**
 * Check if a session directory is stored in iCloud and the content is cloud-only.
 * Returns true if the session dir exists but key files are not downloaded.
 */
export function isSessionCloudOnly(sessionId: string): boolean {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return false
  // Check if session meta file is a cloud placeholder
  const metaFile = path.join(dirPath, SESSION_META_FILE)
  return isICloudPlaceholder(metaFile) || !fs.existsSync(metaFile)
}

/**
 * Trigger iCloud download for a session directory.
 * Uses `brctl download` command (macOS iCloud daemon).
 * Returns true if download was triggered successfully.
 */
export function triggerICloudDownload(sessionId: string): boolean {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath || !fs.existsSync(dirPath)) return false
  try {
    const { execSync } = require('child_process')
    execSync(`brctl download "${dirPath}"`, { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

// ============ SSH Config ============

export function getSshConfig(): SshConfig | undefined {
  const config = loadLibraryConfig()
  return config.preferences?.sshConfig
}

export function setSshConfig(sshConfig: SshConfig | null): void {
  const config = loadLibraryConfig()
  if (sshConfig === null) {
    delete config.preferences.sshConfig
  } else {
    config.preferences.sshConfig = sshConfig
  }
  saveLibraryConfig(config)
}

/**
 * Build SSH resume command for a session.
 * ssh user@host "cd /path && claude --resume sessionId"
 */
/**
 * Check if a session's projectPath belongs to a different user than the current machine.
 * projectPath format: `/Users/mac/.claude/projects/-Users-mac-projects-scsp`
 * The dir name `-Users-mac-projects-scsp` encodes the user as the second segment.
 */
export function isRemoteProjectPath(projectPath: string): boolean {
  const localUser = os.userInfo().username
  const dirName = path.basename(projectPath)
  if (!dirName.startsWith('-')) return false
  const segments = dirName.slice(1).split('-')
  // Typical: ["Users", "mac", "projects", "scsp"] — second segment is username
  if (segments.length >= 2 && segments[0] === 'Users') {
    return segments[1] !== localUser
  }
  // Linux: ["home", "mac", "projects", ...] — second segment is username
  if (segments.length >= 2 && segments[0] === 'home') {
    return segments[1] !== localUser
  }
  return false
}

/**
 * Extract the hostname hint from a projectPath.
 * Uses the username from the path; actual hostname comes from .swob-session.json if available.
 */
export function extractRemoteUser(projectPath: string): string | null {
  const dirName = path.basename(projectPath)
  if (!dirName.startsWith('-')) return null
  const segments = dirName.slice(1).split('-')
  if (segments.length >= 2 && (segments[0] === 'Users' || segments[0] === 'home')) {
    return segments[1]
  }
  return null
}

/**
 * Convert a Claude project storage path like
 *   `/Users/mac/.claude/projects/-Users-mac-projects-scsp`
 * to the actual project directory: `/Users/mac/projects/scsp`
 */
export function claudeProjectPathToCwd(projectPath: string): string | null {
  const dirName = path.basename(projectPath)
  if (!dirName.startsWith('-')) return null
  return dirName.replace(/^-/, '/').replace(/-/g, '/')
}

/**
 * Look up the remote working directory for a session from its Library metadata.
 */
export function getRemoteCwdForSession(sessionId: string): string | null {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return null
  const meta = readSessionMeta(dirPath)
  if (!meta?.projectPath) return null
  return claudeProjectPathToCwd(meta.projectPath)
}

export function buildSshResumeCommand(
  sessionId: string,
  sshConfig: SshConfig,
  permissionMode?: string,
  remoteCwd?: string | null
): string {
  const claudeBin = sshConfig.remotePath || 'claude'
  const args = permissionMode === 'bypassPermissions'
    ? `--dangerously-skip-permissions --resume ${sessionId}`
    : `--resume ${sessionId}`
  const claudeCmd = `${claudeBin} ${args}`
  const fullCmd = remoteCwd ? `cd ${remoteCwd} && ${claudeCmd}` : claudeCmd
  // Use interactive login shell (-li) so both ~/.zprofile AND ~/.zshrc are loaded.
  const remoteCmd = `zsh -li -c '${fullCmd}'`
  return `ssh -t ${sshConfig.user}@${sshConfig.host} "${remoteCmd.replace(/"/g, '\\"')}"`
}
