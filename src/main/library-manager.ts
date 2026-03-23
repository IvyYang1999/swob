import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { parseSessionFile, buildSessionSummary } from './session-loader'
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

export interface LibraryConfig {
  libraryRoot: string
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
  }
  folderOrder?: string[]  // relative paths, determines display order
  branchFolders?: Record<string, string[]>  // branch unique ID → folder relative paths
  branchMeta?: Record<string, { customTitle?: string; notes?: string; highlights?: SessionMeta['highlights'] }>
}

// ============ Constants ============

const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'Swob')
const SESSION_META_FILE = '.swob-session.json'
const LIBRARY_CONFIG_FILE = '.swob-config.json'
const TRANSCRIPT_FILE = 'transcript.md'
const BACKUP_FILE = 'backup.jsonl'

// ============ Library Manager ============

let _root: string = DEFAULT_ROOT

export function getLibraryRoot(): string {
  return _root
}

export function initLibrary(root?: string): void {
  _root = root || DEFAULT_ROOT
  if (!fs.existsSync(_root)) {
    fs.mkdirSync(_root, { recursive: true })
  }
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
      continue // broken symlink
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

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n')
}

export function generateTranscript(
  rawMessages: RawJsonlMessage[],
  title: string,
  meta: { createdAt: string; turnCount: number; toolUsage?: Record<string, number> }
): string {
  const lines: string[] = []

  // Header
  lines.push(`# ${title}\n`)
  const created = new Date(meta.createdAt).toLocaleString('zh-CN')
  lines.push(`> ${created} | ${meta.turnCount} 轮对话`)
  if (meta.toolUsage) {
    const toolSummary = Object.entries(meta.toolUsage)
      .sort(([, a], [, b]) => b - a).slice(0, 6)
      .map(([name, count]) => `${name}(${count})`).join(', ')
    if (toolSummary) lines.push(`> Tools: ${toolSummary}`)
  }
  lines.push('')

  // Messages
  const validMessages = rawMessages.filter(
    (m) => (m.type === 'user' || m.type === 'assistant') && m.message
  )

  for (const msg of validMessages) {
    const text = extractText(msg.message?.content).trim()
    if (!text) continue

    if (msg.type === 'user') {
      const snippet = text.split('\n')[0].slice(0, 80)
      lines.push(`##### ${snippet}\n`)
      // Blockquote user message
      lines.push(text.split('\n').map((l) => `> ${l}`).join('\n'))
      lines.push('')
    } else if (msg.type === 'assistant') {
      // Demote headings to bold to avoid TOC pollution
      const demoted = text.replace(/^(#{1,6})\s+(.+)$/gm, '**$2**')
      lines.push(demoted)
      lines.push('\n---\n')
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

  // Create new session dir
  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId.slice(0, 12)
  const baseName = sanitizeDirName(title)
  const dirName = findUniqueDirName(_root, baseName)
  const dirPath = path.join(_root, dirName)

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
