import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash, randomUUID } from 'crypto'
import { parseSessionFile, buildSessionSummary, filterMessagesByBranch, detectIntraFileBranches } from './session-loader'
import { loadCodexRawMessages } from './codex-loader'
import { loadCursorRawMessages } from './cursor-loader'
import { loadOpencodeRawMessages, stripOpencodeSessionRef } from './opencode-loader'
import { loadZcodeRawMessages, stripZcodeSessionRef } from './zcode-loader'
import { resolveSessionParent, DEFAULT_IGNORE_DIRS } from './session-placement'
import { detectSessionSourceForJsonl, detectSessionSourceFromPath } from './session-source'
import { DERIVED_FILE_NAMES, SESSION_SUMMARY_COMPANION_FILE, getEnabledDerivedFileGenerators } from './derived-files'
import { redactSecrets } from './secret-redactor'
import { shellQuote } from './resume-terminal'
import {
  ensureClaudeResumeTarget,
  type ClaudeResumeRecoveryFailureReason
} from './resume-recovery-service'
import {
  extractRemoteUser,
  isRemoteProjectPathForUser,
  resolveSessionRemoteState,
  type SessionRemoteState
} from './session-remote-state'
import type { RawJsonlMessage, ContentPart, SessionSource, SessionSummary, Folder, UserConfig } from './types'

export { extractRemoteUser, resolveSessionRemoteState, type SessionRemoteState } from './session-remote-state'

// ============ Types ============

export interface SessionMeta {
  /**
   * Version 2 adds origin/sourceInstance. It stays optional so a v1
   * .swob-session.json can be read without migration or changed defaults.
   */
  schemaVersion?: 2
  sessionId: string
  sourceFilePaths: string[]
  customTitle?: string
  notes?: string
  highlights?: Array<{ id: string; text: string; turnUuid: string; note?: string; createdAt: string }>
  createdAt: string
  updatedAt: string
  projectPath: string
  turnCount?: number  // swob 权威轮数（各类型统一），持久化供外部脚本按真实轮数归档
  /** Expected bytes for strong iCloud materialization verification. */
  backupSha256?: string
  backupSize?: number
  /** Immutable identity of the installation that first captured this Library item. */
  origin?: SessionOrigin
  /** Describes the original harness instance; it is never an authorization to write there. */
  sourceInstance?: SessionSourceInstance
}

export interface SessionOrigin {
  deviceId: string
  hostname: string
  username: string
  capturedAt: string
}

export interface SessionSourceInstance {
  kind: 'claude-default' | 'claude-window' | 'other'
  configDir?: string
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
    resumeTerminal?: 'terminal-app' | 'iterm' | 'custom'
    resumeTerminalCommandTemplate?: string
    sshConfig?: SshConfig
    // 指定「未分组容器」：这两个文件夹的会话在 UI 底部按轮数罗列/折叠、不在树里显示。
    // 新中央会话也按轮数落进这俩文件夹。不配则为空，swob 行为完全通用。
    ungrouping?: { multiTurn: string; singleTurn: string }
  }
  folderOrder?: string[]  // relative paths, determines display order
  branchFolders?: Record<string, string[]>  // branch unique ID → folder relative paths
  branchMeta?: Record<string, { customTitle?: string; notes?: string; highlights?: SessionMeta['highlights'] }>
  ignoreDirs?: string[]  // 库根设为整个 vault 时，扫描/放置时跳过的目录名（如 wiki、clipii）
  derivedFiles?: {
    enabledGenerators?: string[]
  }
}

// ============ Constants ============

const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'Swob')
const APP_CONFIG_DIR = path.join(os.homedir(), '.claude-session-manager')
const APP_CONFIG_FILE = path.join(APP_CONFIG_DIR, 'app-config.json')

export interface AppConfig {
  libraryPath?: string
  /**
   * Per-home installation UUID. It is not a hardware or machine identifier.
   * It lives in ~/.claude-session-manager/app-config.json, never in Claude data dirs.
   */
  deviceId?: string
}

function isOriginalSessionSourcePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/')
  if (normalized.includes('/.local/share/opencode/opencode.db#ses_')) return true
  if (normalized.includes('/.zcode/cli/db/db.sqlite#sess_')) return true
  if (!filePath.endsWith('.jsonl')) return false
  return normalized.includes('/.claude/projects/') ||
    normalized.includes('/.claude-window/') ||
    normalized.includes('/.codex/sessions/') ||
    normalized.includes('/.cursor/projects/')
}

function sourceStatPath(filePath: string): string {
  const source = detectSessionSourceFromPath(filePath)
  if (source === 'opencode') return stripOpencodeSessionRef(filePath)
  if (source === 'zcode') return stripZcodeSessionRef(filePath)
  return filePath
}

function sourceFilePathsForMeta(session: SessionSummary): string[] {
  const candidates = session.allFilePaths && session.allFilePaths.length > 0
    ? session.allFilePaths
    : [session.filePath]
  return candidates.filter(isOriginalSessionSourcePath)
}

export function loadAppConfig(): AppConfig {
  return readAppConfigStrict().config
}

type AppConfigReadResult =
  | { state: 'missing'; config: AppConfig }
  | { state: 'valid'; config: AppConfig }
  | { state: 'invalid'; config: AppConfig; backupPath?: string }

function backupCorruptAppConfig(content: string): string {
  const mtime = Math.trunc(fs.statSync(APP_CONFIG_FILE).mtimeMs)
  const basePath = `${APP_CONFIG_FILE}.corrupt-${mtime}`
  let suffix = 0

  while (true) {
    const backupPath = suffix === 0 ? basePath : `${basePath}-${suffix}`
    try {
      fs.writeFileSync(backupPath, content, {
        encoding: 'utf-8',
        flag: 'wx',
        mode: 0o600
      })
      return backupPath
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (fs.readFileSync(backupPath, 'utf-8') === content) return backupPath
      } catch { /* choose another suffix */ }
      suffix++
    }
  }
}

function invalidAppConfig(content?: string): AppConfigReadResult {
  if (content === undefined) return { state: 'invalid', config: {} }
  try {
    return { state: 'invalid', config: {}, backupPath: backupCorruptAppConfig(content) }
  } catch {
    return { state: 'invalid', config: {} }
  }
}

function readAppConfigStrict(): AppConfigReadResult {
  if (!fs.existsSync(APP_CONFIG_FILE)) return { state: 'missing', config: {} }

  let content: string
  try {
    content = fs.readFileSync(APP_CONFIG_FILE, 'utf-8')
  } catch {
    return invalidAppConfig()
  }

  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return invalidAppConfig(content)
    }
    const config = parsed as Record<string, unknown>
    if (
      (config.libraryPath !== undefined && typeof config.libraryPath !== 'string') ||
      (config.deviceId !== undefined && (typeof config.deviceId !== 'string' || config.deviceId.length === 0))
    ) {
      return invalidAppConfig(content)
    }
    return { state: 'valid', config: parsed as AppConfig }
  } catch {
    return invalidAppConfig(content)
  }
}

const APP_CONFIG_LOCK_FILE = `${APP_CONFIG_FILE}.lock`

function acquireAppConfigLock(): number {
  try {
    return fs.openSync(APP_CONFIG_LOCK_FILE, 'wx', 0o600)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') throw new Error('app-config-write-in-progress')
    throw error
  }
}

function writeAppConfigAtomically(config: AppConfig): void {
  const tempPath = `${APP_CONFIG_FILE}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600
    })
    fs.renameSync(tempPath, APP_CONFIG_FILE)
  } finally {
    try { fs.rmSync(tempPath, { force: true }) } catch { /* best effort */ }
  }
}

function updateAppConfigAtomically(
  update: (existing: AppConfig) => AppConfig,
  recoverCorrupt = false
): AppConfig {
  if (!fs.existsSync(APP_CONFIG_DIR)) {
    fs.mkdirSync(APP_CONFIG_DIR, { recursive: true })
  }
  const lockFd = acquireAppConfigLock()
  try {
    const current = readAppConfigStrict()
    if (current.state === 'invalid') {
      if (!recoverCorrupt) throw new Error('invalid-app-config')
      if (!current.backupPath) throw new Error('invalid-app-config-backup-failed')
    }
    const next = update(current.config)
    writeAppConfigAtomically(next)
    return next
  } finally {
    try { fs.closeSync(lockFd) } catch { /* best effort */ }
    try { fs.rmSync(APP_CONFIG_LOCK_FILE, { force: true }) } catch { /* best effort */ }
  }
}

export function saveAppConfig(config: AppConfig): void {
  updateAppConfigAtomically((existing) => ({ ...existing, ...config }))
}

/** The explicit Library picker is the only path allowed to replace a backed-up corrupt config. */
export function changeConfiguredLibraryPath(libraryPath: string): void {
  updateAppConfigAtomically(
    (existing) => ({ ...existing, libraryPath }),
    true
  )
}

/**
 * Return the installation identity, creating it once in app-config.json when absent.
 * Session metadata copies this value only when its origin is first established.
 */
export function getOrCreateLocalDeviceId(createId: () => string = randomUUID): string {
  const initial = readAppConfigStrict()
  if (initial.state === 'invalid') throw new Error('invalid-app-config')
  if (initial.config.deviceId) return initial.config.deviceId

  let deviceId = ''
  updateAppConfigAtomically((existing) => {
    if (existing.deviceId) {
      deviceId = existing.deviceId
      return existing
    }
    deviceId = createId()
    if (!deviceId) throw new Error('invalid-generated-device-id')
    return { ...existing, deviceId }
  })
  return deviceId
}

/**
 * Library-only discovery must survive unavailable/corrupt installation identity.
 * Missing identity is handled conservatively as "not proven to be this install".
 */
export function resolveLibrarySessionRemoteState(meta: SessionMeta): SessionRemoteState {
  let localDeviceId: string | undefined
  try {
    localDeviceId = getOrCreateLocalDeviceId()
  } catch {
    console.warn('[library-manager] Installation identity unavailable; keeping Library session visible')
  }
  return resolveSessionRemoteState(meta, localDeviceId)
}

export function captureLocalSessionOrigin(
  override: Partial<SessionOrigin> = {}
): SessionOrigin {
  return {
    deviceId: override.deviceId || getOrCreateLocalDeviceId(),
    hostname: override.hostname || os.hostname(),
    username: override.username || os.userInfo().username,
    capturedAt: override.capturedAt || new Date().toISOString()
  }
}

export function detectSessionSourceInstance(sourceFilePaths: string[]): SessionSourceInstance {
  for (const sourcePath of sourceFilePaths) {
    const normalized = sourcePath.split(path.sep).join('/')
    const windowMatch = normalized.match(/^(.*\/\.claude-window\/[^/]+)\/projects\/[^/]+\/[^/]+\.jsonl$/)
    if (windowMatch) return { kind: 'claude-window', configDir: windowMatch[1] }
    if (/\/\.claude\/projects\/[^/]+\/[^/]+\.jsonl$/.test(normalized)) {
      return { kind: 'claude-default' }
    }
  }
  return { kind: 'other' }
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
export const LOCAL_RESUME_UNAVAILABLE_REASON = '此会话数据在备份中，本机无源文件，无法直接恢复'

const SESSION_COMPANION_FILE_NAMES = new Set<string>([
  TRANSCRIPT_FILE,
  BACKUP_FILE,
  SESSION_SUMMARY_COMPANION_FILE,
  ...DERIVED_FILE_NAMES
])

export interface SessionResumeAvailability {
  canResume: boolean
  reason?: string
  sourcePath?: string | null
}

// ============ Library Manager ============

let _root: string = DEFAULT_ROOT
let _ignoreDirs: Set<string> = new Set(DEFAULT_IGNORE_DIRS)

export function getLibraryRoot(): string {
  return _root
}

export function getIgnoreDirs(): Set<string> {
  return _ignoreDirs
}

export interface InitLibraryOptions {
  readOnly?: boolean
}

export function initLibrary(root?: string, options: InitLibraryOptions = {}): void {
  _root = root || getConfiguredLibraryPath()
  if (!options.readOnly && !fs.existsSync(_root)) {
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isValidSessionOrigin(value: unknown): value is SessionOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const origin = value as Record<string, unknown>
  return isNonEmptyString(origin.deviceId) &&
    isNonEmptyString(origin.hostname) &&
    isNonEmptyString(origin.username) &&
    isNonEmptyString(origin.capturedAt)
}

/** Parse both legacy v1 and v2 metadata, rejecting malformed data at the boundary. */
export function parseSessionMeta(
  content: string,
  warn: (message: string) => void = console.warn
): SessionMeta | null {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warn('[library-manager] Ignoring invalid session metadata: expected object')
      return null
    }
    const meta = parsed as Record<string, unknown>
    if (!isNonEmptyString(meta.sessionId) || !isNonEmptyString(meta.projectPath)) {
      warn('[library-manager] Ignoring invalid session metadata: missing sessionId/projectPath')
      return null
    }
    if (!Array.isArray(meta.sourceFilePaths) || !meta.sourceFilePaths.every(isNonEmptyString)) {
      warn('[library-manager] Ignoring invalid session metadata: sourceFilePaths must be strings')
      return null
    }
    if (meta.origin !== undefined && !isValidSessionOrigin(meta.origin)) {
      warn('[library-manager] Ignoring invalid session metadata: malformed origin')
      return null
    }
    if (meta.backupSha256 !== undefined &&
      (typeof meta.backupSha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(meta.backupSha256))) {
      warn('[library-manager] Ignoring invalid session metadata: malformed backupSha256')
      return null
    }
    if (meta.backupSize !== undefined &&
      (typeof meta.backupSize !== 'number' || !Number.isSafeInteger(meta.backupSize) || meta.backupSize < 0)) {
      warn('[library-manager] Ignoring invalid session metadata: malformed backupSize')
      return null
    }
    return parsed as SessionMeta
  } catch {
    warn('[library-manager] Ignoring invalid session metadata: malformed JSON')
    return null
  }
}

function readSessionMeta(dirPath: string): SessionMeta | null {
  const metaPath = path.join(dirPath, SESSION_META_FILE)
  try {
    if (fs.existsSync(metaPath)) {
      return parseSessionMeta(fs.readFileSync(metaPath, 'utf-8'))
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

function isSessionCompanionFileName(name: string): boolean {
  if (SESSION_COMPANION_FILE_NAMES.has(name)) return true
  return /^transcript-intra-\d+\.md$/.test(name)
}

function sessionDirHasUserFiles(dirPath: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name.includes('.icloud')) continue
    const fullPath = path.join(dirPath, entry.name)

    let stat: fs.Stats
    try {
      stat = fs.statSync(fullPath)
    } catch {
      continue
    }

    if (stat.isFile()) {
      if (!isSessionCompanionFileName(entry.name)) return true
      continue
    }
    if (stat.isDirectory() && folderHasUserFiles(fullPath)) return true
  }

  return false
}

/** 把 swob 权威 turnCount 持久化进会话 meta（供外部整理脚本按真实轮数归档）。变化才写盘。 */
export function setSessionTurnCount(dirPath: string, turnCount: number): void {
  if (typeof turnCount !== 'number') return
  try {
    const m = readSessionMeta(dirPath)
    if (m && m.turnCount !== turnCount) {
      m.turnCount = turnCount
      writeSessionMeta(dirPath, m)
    }
  } catch { /* ignore */ }
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
      if (isSessionDir(realPath)) {
        if (sessionDirHasUserFiles(realPath)) return true
        continue
      }
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

function backupPathForDir(dirPath?: string | null): string | null {
  return dirPath ? path.join(dirPath, BACKUP_FILE) : null
}

function hasBackupForDir(dirPath?: string | null): boolean {
  const backupPath = backupPathForDir(dirPath)
  return !!backupPath && (
    fs.existsSync(backupPath) ||
    fs.existsSync(path.join(path.dirname(backupPath), `.${path.basename(backupPath)}.icloud`))
  )
}

function detectSourceFromSourcePaths(sourceFilePaths: string[], fallback?: SessionSource): SessionSource {
  for (const sourcePath of sourceFilePaths) {
    const source = detectSessionSourceFromPath(sourcePath)
    if (source) return source
  }
  return fallback || 'claude-code'
}

function sourceFilePathsFromSummary(session?: Pick<SessionSummary, 'filePath' | 'allFilePaths' | 'source'>): string[] {
  if (!session) return []
  const candidates = session.allFilePaths && session.allFilePaths.length > 0
    ? session.allFilePaths
    : [session.filePath]
  return candidates.filter(isOriginalSessionSourcePath)
}

function sourceFilePathsFromMeta(meta: SessionMeta): string[] | null {
  const raw = (meta as unknown as { sourceFilePaths?: unknown }).sourceFilePaths
  if (!Array.isArray(raw)) return null
  return raw.filter((src): src is string => typeof src === 'string' && src.length > 0)
}

function evaluateSourceResumeAvailability(
  sourceFilePaths: string[],
  source: SessionSource,
  dirPath?: string | null
): SessionResumeAvailability {
  const existingSource = sourceFilePaths.find((src) => fs.existsSync(sourceStatPath(src)))
  if (existingSource) return { canResume: true, sourcePath: existingSource }

  if (source === 'claude-code' && hasBackupForDir(dirPath)) {
    const restorableSource = sourceFilePaths.find(isRestorableLocalClaudeSource)
    if (restorableSource) return { canResume: true, sourcePath: restorableSource }
  }

  return {
    canResume: false,
    reason: LOCAL_RESUME_UNAVAILABLE_REASON,
    sourcePath: sourceFilePaths[0] || null
  }
}

export function getSessionResumeAvailability(
  sessionId: string,
  session?: Pick<SessionSummary, 'sessionId' | 'filePath' | 'allFilePaths' | 'source'>
): SessionResumeAvailability {
  const dirPath = sessionIndex.get(sessionId) || (session?.sessionId ? sessionIndex.get(session.sessionId) : null)
  const meta = dirPath ? readSessionMeta(dirPath) : null
  const summarySourceFilePaths = sourceFilePathsFromSummary(session)

  if (meta) {
    const metaSourceFilePaths = sourceFilePathsFromMeta(meta)
    if (metaSourceFilePaths && metaSourceFilePaths.length > 0) {
      return evaluateSourceResumeAvailability(
        metaSourceFilePaths,
        detectSourceFromSourcePaths(metaSourceFilePaths, session?.source),
        dirPath
      )
    }

    if (!metaSourceFilePaths || metaSourceFilePaths.length === 0) {
      if (summarySourceFilePaths.length > 0) {
        return evaluateSourceResumeAvailability(
          summarySourceFilePaths,
          detectSourceFromSourcePaths(summarySourceFilePaths, session?.source),
          null
        )
      }
      return {
        canResume: false,
        reason: LOCAL_RESUME_UNAVAILABLE_REASON,
        sourcePath: null
      }
    }
  }

  if (session) {
    const sourceFilePaths = summarySourceFilePaths
    if (sourceFilePaths.length > 0) {
      return evaluateSourceResumeAvailability(
        sourceFilePaths,
        detectSourceFromSourcePaths(sourceFilePaths, session.source),
        null
      )
    }
    return {
      canResume: false,
      reason: LOCAL_RESUME_UNAVAILABLE_REASON,
      sourcePath: null
    }
  }

  // No indexed metadata and no caller summary means no source inventory.
  return {
    canResume: false,
    reason: LOCAL_RESUME_UNAVAILABLE_REASON,
    sourcePath: null
  }
}

export interface SessionResumePreparationResult {
  ok: boolean
  sourcePath: string | null
  state?: 'source-present' | 'already-present' | 'restored'
  reason?: string
  failureCode?: ClaudeResumeRecoveryFailureReason | 'session-not-in-library' | 'missing-meta' |
    'missing-source-path' | 'recovery-required' | 'unsupported-source'
}

export interface SessionResumePreparationOptions {
  allowRecovery?: boolean
  requestedSessionId?: string
  allowUnverifiedBackup?: boolean
  preferredTargetInstanceId?: string
  /** Test/adapter boundary; production callers use the actual local installation. */
  runtimeIdentity?: {
    homeDir: string
    localDeviceId?: string
    localUsername: string
  }
}

function recoveryFailureMessage(reason: ClaudeResumeRecoveryFailureReason): string {
  if (reason === 'unverified-backup') return '备份缺少 SHA-256/大小证据，需要明确确认后才能复活'
  if (reason === 'invalid-backup') return '备份未通过严格 JSONL 校验，未写入 Claude 源目录'
  if (reason === 'target-conflict') return '目标 Claude 实例已有同名或同 ID 会话，已停止以避免覆盖'
  if (reason === 'recovery-locked') return '另一 Swob 进程正在复活该会话，请稍后重试'
  if (reason === 'remote-source-requires-explicit-target') return '这是其他安装的会话，需要先选择要导入的 Claude 实例'
  if (reason === 'target-instance-untrusted' || reason === 'target-instance-unavailable') {
    return '目标 Claude 实例不可用或未通过路径安全检查'
  }
  if (reason === 'materialization-failed') return 'iCloud 备份尚未完整下载或完整性证据不匹配'
  if (reason === 'missing-backup') return '找不到可用于复活的备份'
  if (reason === 'post-publish-verification-failed') return '目标已发布但最终校验失败，已保留现场且未自动删除'
  return `无法复活会话：${reason}`
}

/** The sole Library-to-Claude recovery adapter used by every local resume entry point. */
export async function ensureSessionResumeTarget(
  sessionId: string,
  options: SessionResumePreparationOptions = {}
): Promise<SessionResumePreparationResult> {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) {
    return { ok: false, sourcePath: null, failureCode: 'session-not-in-library', reason: '会话不在 Library 中' }
  }

  const meta = readSessionMeta(dirPath)
  if (!meta) return { ok: false, sourcePath: null, failureCode: 'missing-meta', reason: '会话元数据无效' }

  const sourceFilePaths = sourceFilePathsFromMeta(meta)
  if (!sourceFilePaths || sourceFilePaths.length === 0) {
    return { ok: false, sourcePath: null, failureCode: 'missing-source-path', reason: '会话缺少源路径' }
  }

  const claudeSourcePaths = sourceFilePaths.filter((sourcePath) =>
    detectSessionSourceFromPath(sourcePath) === 'claude-code')
  const lastClaudePhysicalId = claudeSourcePaths.length > 0
    ? path.basename(claudeSourcePaths[claudeSourcePaths.length - 1], '.jsonl')
    : undefined
  const requestedPhysicalId = options.requestedSessionId && options.requestedSessionId !== meta.sessionId &&
    claudeSourcePaths.some((sourcePath) => path.basename(sourcePath, '.jsonl') === options.requestedSessionId)
    ? options.requestedSessionId
    : lastClaudePhysicalId
  const sourcePathsRequiredForAction = requestedPhysicalId
    ? claudeSourcePaths.filter((sourcePath) => path.basename(sourcePath, '.jsonl') === requestedPhysicalId)
    : sourceFilePaths
  const existingSource = sourcePathsRequiredForAction.find((src) => fs.existsSync(sourceStatPath(src)))
  if (existingSource) return { ok: true, state: 'source-present', sourcePath: existingSource }

  const hasClaudeSource = sourceFilePaths.some((sourcePath) =>
    detectSessionSourceFromPath(sourcePath) === 'claude-code')
  if (!hasClaudeSource) {
    return {
      ok: false,
      sourcePath: sourceFilePaths[0],
      failureCode: 'unsupported-source',
      reason: LOCAL_RESUME_UNAVAILABLE_REASON
    }
  }
  if (!options.allowRecovery) {
    return {
      ok: false,
      sourcePath: sourceFilePaths[0],
      failureCode: 'recovery-required',
      reason: '源记录缺失；请先在 Swob 中执行复活。复制命令不会改写 Claude 源目录'
    }
  }

  const runtimeIdentity = options.runtimeIdentity || {
    homeDir: os.homedir(),
    localDeviceId: getOrCreateLocalDeviceId(),
    localUsername: os.userInfo().username
  }
  const recovery = await ensureClaudeResumeTarget({
    sessionId,
    libraryMeta: meta,
    backupPath: path.join(dirPath, BACKUP_FILE),
    homeDir: runtimeIdentity.homeDir,
    localDeviceId: runtimeIdentity.localDeviceId,
    localUsername: runtimeIdentity.localUsername,
    physicalSessionId: requestedPhysicalId,
    preferredTargetInstanceId: options.preferredTargetInstanceId,
    allowUnverifiedBackup: options.allowUnverifiedBackup
  })
  if (recovery.ok) return { ok: true, state: recovery.state, sourcePath: recovery.sourcePath }
  return {
    ok: false,
    sourcePath: recovery.sourcePath || sourceFilePaths[0],
    failureCode: recovery.reason,
    reason: recoveryFailureMessage(recovery.reason)
  }
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
  const sourceFilePaths = sourceFilePathsFromMeta(meta) || []
  for (const src of sourceFilePaths) {
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

  const summary = buildSessionSummary(sourceFilePaths[0], branchRaw, true, meta.sessionId)
  if (!summary) return null

  const title = customTitle || summary.firstUserMessage?.slice(0, 60) || branchId.slice(0, 12)
  const sourcePath = meta.sourceFilePaths[0] || ''
  const source = detectSourceForTranscript(meta, sourcePath)
  const md = generateTranscript(branchRaw, title, {
    createdAt: summary.createdAt,
    turnCount: summary.turnCount,
    toolUsage: summary.toolUsage,
    frontmatter: buildTranscriptFrontmatter({
      sessionId: branchId,
      resumeSessionId: baseId,
      source,
      sourcePath,
      rawMessages: branchRaw,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
      turnCount: summary.turnCount
    })
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

export function demoteMarkdownHeadings(text: string): string {
  const lines = text.split('\n')
  let inFence = false
  let fenceMarker: '`' | '~' | null = null
  let fenceLength = 0

  return lines.map((line) => {
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fence) {
      const marker = fence[1][0] as '`' | '~'
      const length = fence[1].length
      if (!inFence) {
        inFence = true
        fenceMarker = marker
        fenceLength = length
      } else if (marker === fenceMarker && length >= fenceLength) {
        inFence = false
        fenceMarker = null
        fenceLength = 0
      }
      return line
    }

    if (inFence) return line

    const match = line.match(/^( {0,3})#{1,6}(?:[ \t]+|$)(.*)$/)
    if (!match) return line

    const headingText = match[2].replace(/[ \t]+#{1,}[ \t]*$/, '').trim()
    if (!headingText) return line
    return `${match[1]}**${headingText.replace(/\*\*/g, '')}**`
  }).join('\n')
}

function firstLineSnippet(text: string, maxLen = 40): string {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || text
  const normalized = firstLine.replace(/\s+/g, ' ').trim()
  if (!normalized) return 'User prompt'
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen).trimEnd()}...` : normalized
}

interface TranscriptFrontmatter {
  sessionId?: string
  harness?: SessionSource
  model?: string
  device?: string
  cwd?: string
  turns?: number
  created?: string
  updated?: string
  resume?: string
  source?: string
}

interface TranscriptGenerationMeta {
  createdAt: string
  turnCount: number
  toolUsage?: Record<string, number>
  frontmatter?: TranscriptFrontmatter
}

const TRANSCRIPT_FRONTMATTER_KEYS: Array<keyof TranscriptFrontmatter> = [
  'sessionId',
  'harness',
  'model',
  'device',
  'cwd',
  'turns',
  'created',
  'updated',
  'resume',
  'source'
]

function formatYamlScalar(value: string | number): string {
  if (typeof value === 'number') return String(value)
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  return JSON.stringify(value)
}

function formatTranscriptFrontmatter(frontmatter?: TranscriptFrontmatter): string[] {
  if (!frontmatter) return []

  const lines: string[] = []
  for (const key of TRANSCRIPT_FRONTMATTER_KEYS) {
    const value = frontmatter[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) continue
      lines.push(`${key}: ${formatYamlScalar(value)}`)
      continue
    }
    if (!value.trim()) continue
    lines.push(`${key}: ${formatYamlScalar(value)}`)
  }

  return lines.length > 0 ? ['---', ...lines, '---'] : []
}

function modeString(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, { count: number; firstIdx: number }>()
  values.forEach((value, idx) => {
    const normalized = value?.trim()
    if (!normalized) return
    const current = counts.get(normalized)
    if (current) {
      current.count += 1
    } else {
      counts.set(normalized, { count: 1, firstIdx: idx })
    }
  })
  return [...counts.entries()]
    .sort(([, a], [, b]) => b.count - a.count || a.firstIdx - b.firstIdx)[0]?.[0]
}

function inferTranscriptModel(source: SessionSource, rawMessages: RawJsonlMessage[]): string | undefined {
  if (source === 'cursor') return undefined
  if (source === 'codex') {
    return modeString(rawMessages.flatMap((m) => [m.message?.model, m.version]))
  }
  return modeString(rawMessages.map((m) => m.message?.model))
}

function inferTranscriptCwd(rawMessages: RawJsonlMessage[]): string | undefined {
  let earliest: { timestamp: string; cwd: string } | null = null
  for (const msg of rawMessages) {
    if (msg.isSidechain) continue
    if (!msg.cwd) continue
    if (!msg.timestamp) return msg.cwd
    if (!earliest || msg.timestamp < earliest.timestamp) {
      earliest = { timestamp: msg.timestamp, cwd: msg.cwd }
    }
  }
  return earliest?.cwd
}

function inferDevice(sourcePath: string): string {
  const normalized = sourcePath.split(path.sep).join('/')
  const user = normalized.match(/\/Users\/([^/]+)\//)?.[1]
  if (user === 'yytyyf') return 'mac-mini'
  if (user === 'mac') return 'macbook'
  return os.hostname()
}

function buildResumeCommand(source: SessionSource, sessionId: string): string {
  if (source === 'codex') return `codex resume ${sessionId}`
  if (source === 'cursor') return `cursor-agent --resume=${sessionId}`
  if (source === 'opencode' || source === 'zcode') return `${source} --session ${sessionId}`
  return `claude --resume ${sessionId}`
}

function buildTranscriptFrontmatter(params: {
  sessionId: string
  resumeSessionId?: string
  source: SessionSource
  sourcePath: string
  rawMessages: RawJsonlMessage[]
  createdAt: string
  updatedAt: string
  turnCount: number
}): TranscriptFrontmatter {
  const model = inferTranscriptModel(params.source, params.rawMessages)
  const cwd = inferTranscriptCwd(params.rawMessages)
  return {
    sessionId: params.sessionId,
    harness: params.source,
    model,
    device: inferDevice(params.sourcePath),
    cwd,
    turns: params.turnCount,
    created: params.createdAt,
    updated: params.updatedAt,
    resume: buildResumeCommand(params.source, params.resumeSessionId || params.sessionId),
    source: params.sourcePath
  }
}

export function generateTranscript(
  rawMessages: RawJsonlMessage[],
  title: string,
  meta: TranscriptGenerationMeta
): string {
  const lines: string[] = []

  lines.push(...formatTranscriptFrontmatter(meta.frontmatter))

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
      lines.push(`## ${firstLineSnippet(text)}`)
      lines.push(text)
      lines.push('')
    } else if (msg.type === 'assistant') {
      const tools = extractToolCalls(msg.message?.content)
      if (!text && tools.length === 0) continue
      lines.push(`**Assistant** [${ts}]`)
      if (tools.length > 0) {
        for (const t of tools) lines.push(t)
      }
      if (text) lines.push(demoteMarkdownHeadings(text))
      lines.push('')
    }
  }

  return redactSecrets(lines.join('\n')).text
}

// --- Ensure Session in Library ---

export async function ensureSessionInLibrary(
  session: SessionSummary,
  customTitle?: string,
  originOverride?: Partial<SessionOrigin>
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
        const nextSourceFilePaths = sourceFilePathsForMeta(session)
        if (nextSourceFilePaths.length > 0) {
          meta.sourceFilePaths = nextSourceFilePaths
        }
        changed = true
      }
      // Lazy, evidence-based migration: a source visible to this installation proves
      // only that this installation can capture the legacy item now. Never overwrite an
      // origin already synced from another device.
      const currentSourceFilePaths = sourceFilePathsForMeta(session)
      if (!meta.origin && currentSourceFilePaths.some((sourcePath) => fs.existsSync(sourceStatPath(sourcePath)))) {
        meta.origin = captureLocalSessionOrigin(originOverride)
        meta.schemaVersion = 2
        changed = true
      }
      if (!meta.sourceInstance && currentSourceFilePaths.length > 0) {
        meta.sourceInstance = detectSessionSourceInstance(currentSourceFilePaths)
        meta.schemaVersion = 2
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
  // 中央桶里的新会话按轮数落进 单轮会话/未分组 子目录（若库配置了 ungrouping），
  // 使其直接出现在 UI 底部的单轮折叠/未分组区，不在 AI会话 文件夹里一闪而过。
  const ung = (loadLibraryConfig().preferences as any)?.ungrouping
  const centralSubfolder = ung
    ? (session.turnCount > 1 ? ung.multiTurn : ung.singleTurn)
    : undefined
  const parentDir = resolveSessionParent(session.cwds, _root, _ignoreDirs, undefined, centralSubfolder)
  fs.mkdirSync(parentDir, { recursive: true })
  const dirName = findUniqueDirName(parentDir, baseName)
  const dirPath = path.join(parentDir, dirName)

  fs.mkdirSync(dirPath, { recursive: true })

  const sourceFilePaths = sourceFilePathsForMeta(session)
  const meta: SessionMeta = {
    schemaVersion: 2,
    sessionId: session.sessionId,
    sourceFilePaths,
    customTitle,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    projectPath: session.projectPath,
    turnCount: session.turnCount,
    origin: captureLocalSessionOrigin(originOverride),
    sourceInstance: detectSessionSourceInstance(sourceFilePaths)
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
  for (const src of sourceFilePathsFromMeta(meta) || []) {
    try {
      const source = detectSessionSourceFromPath(src)
      if (source === 'opencode' || source === 'zcode') continue
      if (fs.existsSync(src)) {
        allContent.push(fs.readFileSync(src, 'utf-8'))
      }
    } catch { /* skip */ }
  }
  if (allContent.length > 0) {
    const content = allContent.join('\n')
    fs.writeFileSync(backupPath, content, 'utf-8')
    meta.backupSha256 = createHash('sha256').update(content, 'utf-8').digest('hex')
    meta.backupSize = Buffer.byteLength(content, 'utf-8')
    meta.schemaVersion = 2
    writeSessionMeta(dirPath, meta)
  }
}

// --- Update Transcript ---

interface LoadedTranscriptRaw {
  raw: RawJsonlMessage[]
  source: SessionSource
  filePath: string
}

interface TranscriptSummaryForWrite {
  updatedAt: string
  turnCount: number
  firstUserMessage: string
  toolUsage: Record<string, number>
}

function detectSourceForTranscript(meta: SessionMeta, filePath: string): SessionSource {
  return detectSessionSourceForJsonl(filePath, sourceFilePathsFromMeta(meta) || [], { preferSourcePaths: true })
}

async function loadRawFileForTranscript(filePath: string, source: SessionSource, sessionId: string): Promise<RawJsonlMessage[]> {
  if (source === 'codex') return loadCodexRawMessages(filePath, sessionId)
  if (source === 'cursor') return loadCursorRawMessages(filePath, sessionId)
  if (source === 'opencode') return loadOpencodeRawMessages(filePath, sessionId)
  if (source === 'zcode') return loadZcodeRawMessages(filePath, sessionId)
  return parseSessionFile(filePath)
}

async function loadRawFromMeta(meta: SessionMeta, dirPath?: string): Promise<LoadedTranscriptRaw> {
  const allRaw: RawJsonlMessage[] = []
  const sourceFilePaths = sourceFilePathsFromMeta(meta) || []
  let foundSourceFile = false
  let firstLoadedPath = ''
  let firstLoadedSource: SessionSource | null = null

  for (const src of sourceFilePaths) {
    try {
      if (!fs.existsSync(sourceStatPath(src))) continue
      foundSourceFile = true
      const source = detectSourceForTranscript(meta, src)
      const raw = await loadRawFileForTranscript(src, source, meta.sessionId)
      if (!firstLoadedPath) {
        firstLoadedPath = src
        firstLoadedSource = source
      }
      allRaw.push(...raw)
    } catch { /* skip */ }
  }

  if (allRaw.length > 0) {
    return {
      raw: allRaw,
      source: firstLoadedSource || detectSessionSourceFromPath(sourceFilePaths[0]) || 'claude-code',
      filePath: firstLoadedPath || sourceFilePaths[0]
    }
  }

  if (!foundSourceFile && dirPath) {
    const backupPath = path.join(dirPath, BACKUP_FILE)
    if (fs.existsSync(backupPath)) {
      const source = detectSourceForTranscript(meta, backupPath)
      try {
        return {
          raw: await loadRawFileForTranscript(backupPath, source, meta.sessionId),
          source,
          filePath: backupPath
        }
      } catch { /* fall through */ }
    }
  }

  return {
    raw: [],
    source: detectSessionSourceFromPath(sourceFilePaths[0]) || 'claude-code',
    filePath: sourceFilePaths[0] || (dirPath ? path.join(dirPath, BACKUP_FILE) : '')
  }
}

function extractToolUsageForTranscript(rawMessages: RawJsonlMessage[]): Record<string, number> {
  const toolUsage: Record<string, number> = {}
  for (const msg of rawMessages) {
    if (msg.type !== 'assistant' || !msg.message || !Array.isArray(msg.message.content)) continue
    for (const part of msg.message.content) {
      if (part.type !== 'tool_use' || !part.name) continue
      toolUsage[part.name] = (toolUsage[part.name] || 0) + 1
    }
  }
  return toolUsage
}

function buildTranscriptSummaryForWrite(meta: SessionMeta, loaded: LoadedTranscriptRaw): TranscriptSummaryForWrite | null {
  if (loaded.raw.length === 0) return null

  if (loaded.source === 'claude-code') {
    const summary = buildSessionSummary(loaded.filePath, loaded.raw, true, meta.sessionId)
    if (!summary) return null
    return {
      updatedAt: summary.updatedAt,
      turnCount: summary.turnCount,
      firstUserMessage: summary.firstUserMessage,
      toolUsage: summary.toolUsage
    }
  }

  const validMessages = loaded.raw.filter((m) => (m.type === 'user' || m.type === 'assistant') && m.message)
  if (validMessages.length === 0) return null

  const userMessages = validMessages.filter((m) => m.type === 'user' && extractText(m.message?.content).trim())
  const assistantMessages = validMessages.filter((m) => {
    if (m.type !== 'assistant') return false
    const hasText = extractText(m.message?.content).trim().length > 0
    const hasTool = Array.isArray(m.message?.content) && m.message.content.some((p) => p.type === 'tool_use' && p.name)
    return hasText || hasTool
  })
  const timestamps = loaded.raw.map((m) => m.timestamp).filter(Boolean).sort()
  const firstUserMessage = userMessages.length > 0
    ? extractText(userMessages[0].message?.content).slice(0, 200)
    : meta.sessionId

  return {
    updatedAt: timestamps[timestamps.length - 1] || meta.updatedAt,
    turnCount: Math.min(userMessages.length, assistantMessages.length),
    firstUserMessage,
    toolUsage: extractToolUsageForTranscript(loaded.raw)
  }
}

function getEnabledDerivedGeneratorNames(config: LibraryConfig): string[] | undefined {
  const names = config.derivedFiles?.enabledGenerators
  if (names === undefined) return undefined
  return names.filter((name): name is string => typeof name === 'string')
}

function writeDerivedFilesFromLoadedRaw(sessionId: string, dirPath: string, rawMessages: RawJsonlMessage[]): void {
  const config = loadLibraryConfig()
  const generators = getEnabledDerivedFileGenerators(getEnabledDerivedGeneratorNames(config))

  for (const generator of generators) {
    const content = generator.generate(rawMessages, { sessionId })
    if (content === null) continue
    fs.writeFileSync(path.join(dirPath, generator.fileName), redactSecrets(content).text, 'utf-8')
  }
}

function writeTranscriptFromLoadedRaw(
  sessionId: string,
  dirPath: string,
  meta: SessionMeta,
  loaded: LoadedTranscriptRaw,
  summary: TranscriptSummaryForWrite,
  customTitle?: string
): void {
  const title = customTitle || meta.customTitle || summary.firstUserMessage?.slice(0, 60) || sessionId.slice(0, 12)
  const md = generateTranscript(loaded.raw, title, {
    createdAt: meta.createdAt,
    turnCount: summary.turnCount,
    toolUsage: summary.toolUsage,
    frontmatter: buildTranscriptFrontmatter({
      sessionId,
      source: loaded.source,
      sourcePath: loaded.filePath || meta.sourceFilePaths[0] || '',
      rawMessages: loaded.raw,
      createdAt: meta.createdAt,
      updatedAt: summary.updatedAt,
      turnCount: summary.turnCount
    })
  })

  const mdPath = path.join(dirPath, TRANSCRIPT_FILE)
  fs.writeFileSync(mdPath, md, 'utf-8')

  // Update meta timestamps + 权威轮数
  meta.updatedAt = summary.updatedAt
  meta.turnCount = summary.turnCount
  writeSessionMeta(dirPath, meta)
}

export async function updateTranscript(sessionId: string, customTitle?: string): Promise<boolean> {
  const dirPath = sessionIndex.get(sessionId)
  if (!dirPath) return false

  const meta = readSessionMeta(dirPath)
  if (!meta) return false

  const loaded = await loadRawFromMeta(meta, dirPath)
  const summary = buildTranscriptSummaryForWrite(meta, loaded)
  if (!summary) return false

  writeTranscriptFromLoadedRaw(sessionId, dirPath, meta, loaded, summary, customTitle)
  writeDerivedFilesFromLoadedRaw(sessionId, dirPath, loaded.raw)
  return true
}

export interface RebuildTranscriptsResult {
  libraryRoot: string
  dryRun: boolean
  missingOnly: boolean
  sessionCount: number
  branchCount: number
  transcriptCount: number
  written: number
  skipped: number
  failed: number
  failedSessionIds: string[]
  wouldWrite: number
}

export interface RedactLibraryTranscriptsResult {
  dryRun: boolean
  /** Number of files that contain at least one credential match. */
  files: number
  hits: number
}

function collectLibrarySessions(tree: LibraryTree): LibrarySession[] {
  const sessions: LibrarySession[] = [...tree.ungroupedSessions]
  const walk = (folder: LibraryFolder): void => {
    sessions.push(...folder.sessions)
    for (const child of folder.children) walk(child)
  }
  for (const folder of tree.folders) walk(folder)
  return sessions
}

function redactableMarkdownPaths(dirPath: string): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isFile() && isSessionCompanionFileName(entry.name) && entry.name.endsWith('.md'))
    .map((entry) => path.join(dirPath, entry.name))
}

/**
 * Backfill generated markdown only. Original JSONL, backups, metadata and user
 * notes are deliberately outside this traversal.
 */
export function redactLibraryTranscripts(options: { dryRun?: boolean } = {}): RedactLibraryTranscriptsResult {
  const dryRun = options.dryRun === true
  const sessions = collectLibrarySessions(scanLibrary())
  const visitedDirs = new Set<string>()
  let files = 0
  let hits = 0

  for (const session of sessions) {
    let realDir: string
    try {
      realDir = fs.realpathSync(session.dirPath)
    } catch {
      continue
    }
    if (visitedDirs.has(realDir)) continue
    visitedDirs.add(realDir)

    for (const mdPath of redactableMarkdownPaths(realDir)) {
      let content: string
      try {
        content = fs.readFileSync(mdPath, 'utf-8')
      } catch {
        continue
      }
      const result = redactSecrets(content)
      if (result.hits === 0) continue
      files++
      hits += result.hits
      if (!dryRun) fs.writeFileSync(mdPath, result.text, 'utf-8')
    }
  }

  return { dryRun, files, hits }
}

export async function rebuildAllTranscripts(options: { dryRun?: boolean; missingOnly?: boolean } = {}): Promise<RebuildTranscriptsResult> {
  const dryRun = options.dryRun === true
  const missingOnly = options.missingOnly === true
  const tree = scanLibrary()
  const sessions = collectLibrarySessions(tree)
  const config = loadLibraryConfig()
  let branchCount = 0
  let written = 0
  let skipped = 0
  let wouldWrite = 0
  const failedSessionIds: string[] = []

  for (const session of sessions) {
    if (missingOnly && fs.existsSync(session.mdPath)) {
      skipped++
      continue
    }

    const loaded = await loadRawFromMeta(session.meta, session.dirPath)
    const summary = buildTranscriptSummaryForWrite(session.meta, loaded)
    if (loaded.raw.length === 0 || !summary) {
      failedSessionIds.push(session.sessionId)
      continue
    }

    const branches = loaded.source === 'claude-code' ? detectIntraFileBranches(loaded.raw) : []
    branchCount += branches.length

    if (dryRun) {
      wouldWrite += 1 + branches.length
      continue
    }

    writeTranscriptFromLoadedRaw(session.sessionId, session.dirPath, session.meta, loaded, summary, session.meta.customTitle)
    writeDerivedFilesFromLoadedRaw(session.sessionId, session.dirPath, loaded.raw)
    written++
    for (let idx = 0; idx < branches.length; idx++) {
      const branchId = `${session.sessionId}:intra-${idx}`
      const branchTitle = config.branchMeta?.[branchId]?.customTitle
      const branchMd = await updateBranchTranscript(branchId, branches[idx].leafUuid, branchTitle)
      if (branchMd) written++
    }
  }

  return {
    libraryRoot: _root,
    dryRun,
    missingOnly,
    sessionCount: sessions.length,
    branchCount,
    transcriptCount: dryRun ? wouldWrite : written,
    written,
    skipped,
    failed: failedSessionIds.length,
    failedSessionIds,
    wouldWrite: dryRun ? wouldWrite : written
  }
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

    // 持久化 swob 权威 turnCount 进 meta（各会话类型统一），供外部整理脚本按真实轮数归档
    try {
      const m = readSessionMeta(dirPath)
      if (m && m.turnCount !== session.turnCount) {
        m.turnCount = session.turnCount
        writeSessionMeta(dirPath, m)
      }
    } catch { /* ignore */ }

    // Update transcript
    const mdPath = path.join(dirPath, TRANSCRIPT_FILE)
    const metaPath = path.join(dirPath, SESSION_META_FILE)

    // Only regenerate transcript if source is newer
    let needsUpdate = !fs.existsSync(mdPath)
    if (!needsUpdate) {
      try {
        const mdMtime = fs.statSync(mdPath).mtimeMs
        for (const src of session.allFilePaths || [session.filePath]) {
          const statPath = sourceStatPath(src)
          if (fs.existsSync(statPath) && fs.statSync(statPath).mtimeMs > mdMtime) {
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
          const statPath = sourceStatPath(src)
          if (fs.existsSync(statPath) && fs.statSync(statPath).mtimeMs > bkMtime) {
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
        const hasExistingSource = (sourceFilePathsFromMeta(meta) || []).some((src) => fs.existsSync(sourceStatPath(src)))
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
export function isRemoteProjectPath(projectPath: string): boolean {
  return isRemoteProjectPathForUser(projectPath, os.userInfo().username)
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
  const quotedSessionId = shellQuote(sessionId)
  const args = permissionMode === 'bypassPermissions'
    ? `--dangerously-skip-permissions --resume ${quotedSessionId}`
    : `--resume ${quotedSessionId}`
  const claudeCmd = `${shellQuote(claudeBin)} ${args}`
  const fullCmd = remoteCwd ? `cd ${shellQuote(remoteCwd)} && ${claudeCmd}` : claudeCmd
  // Use interactive login shell (-li) so both ~/.zprofile AND ~/.zshrc are loaded.
  const remoteCmd = `zsh -li -c ${shellQuote(fullCmd)}`
  return `ssh -t ${shellQuote(`${sshConfig.user}@${sshConfig.host}`)} ${shellQuote(remoteCmd)}`
}
