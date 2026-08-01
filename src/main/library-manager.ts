import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash, randomUUID } from 'crypto'
import { execFile } from 'node:child_process'
import { parseSessionFile, buildSessionSummary, filterMessagesByBranch, detectIntraFileBranches } from './session-loader'
import { loadCodexRawMessages } from './codex-loader'
import { loadCursorRawMessages } from './cursor-loader'
import { loadOpencodeRawMessages, stripOpencodeSessionRef } from './opencode-loader'
import { loadZcodeRawMessages, stripZcodeSessionRef } from './zcode-loader'
import { DEFAULT_IGNORE_DIRS } from './session-placement'
import {
  executeOrganization,
  recoverInterruptedOrganization,
  undoLastOrganization,
  type OrganizationInput,
  type OrganizationKind,
  type OrganizationMove,
  type OrganizationResult
} from './vault-organizer'
import { detectSessionSourceForJsonl, detectSessionSourceFromPath } from './session-source'
import { DERIVED_FILE_NAMES, SESSION_SUMMARY_COMPANION_FILE, getEnabledDerivedFileGenerators } from './derived-files'
import { redactSecrets } from './secret-redactor'
import {
  stripTerminalControlSequences,
  stripTerminalControlSequencesDeep
} from '../shared/chat-format'
import { shellQuote } from './resume-terminal'
import { detectTranscriptOrigin, formatTranscriptOriginHeader } from './transcript-origin'
import { resolvePathWithinRoot } from './path-containment'
import { runtimeHome } from './runtime-home'
import { assertE2ELibraryPath, assertTestDefaultLibraryPath } from './e2e-library-isolation'
import {
  ensureClaudeResumeTarget,
  type ClaudeResumeRecoveryFailureReason
} from './resume-recovery-service'
import { recoveryFailureMessage } from './recovery-failure-message'
import { recordRecoveryAttempt } from './recovery-metrics'
import {
  extractRemoteUser,
  isRemoteProjectPathForUser,
  resolveSessionRemoteState,
  type SessionRemoteState
} from './session-remote-state'
import {
  buildCanonicalLogicalSessionIdentity,
  buildLogicalSessionIdentityFromMeta,
  buildLogicalSessionIdentityFromSummary,
  isValidLogicalSessionIdentity,
  logicalSessionKey,
  type LogicalSessionIdentity,
  type LogicalSessionKey
} from './library-session-identity'
import {
  CANONICAL_PROVENANCE_FILE,
  CANONICAL_RECORDS_FILE,
  encodeCanonicalPackageProvenance,
  encodeCanonicalPackageRecords,
  isCanonicalPackageDescriptor,
  readCanonicalPackageRecords,
  type CanonicalPackageDescriptor,
  type CanonicalPackageProvenance,
  type CanonicalPackageRecords
} from './canonical-package'
import { canonicalRecordsToSessionDetail, canonicalRecordsToSessionSummary } from './canonical-projection'
import { getCanonicalSessionStore, getLoadedCanonicalSession } from './canonical-store'
import {
  builtinProviderForId,
  builtinProviderForSource,
  isLegacySessionSource
} from '../shared/provider-capabilities'
import type { CanonicalRecord, SourceRef, Tombstone } from '../shared/provider-schema.generated'
import {
  candidateFromManifest,
  LibrarySessionRegistry,
  type LibrarySessionBinding,
  type LibrarySessionCandidate,
  type SessionIdResolution
} from './library-session-registry'
import {
  acquireSessionCreateLock,
  getLocalBootIdentity,
  getProcessStartFingerprint,
  SessionCreateBusyError,
  type SessionCreateLockOwner
} from './session-create-lock'
import {
  assertSafeLibraryFileTarget,
  assertSafeLibraryWritePath,
  canonicalLibraryRootForWrite,
  ensureSafeLibraryDirectory,
  fsyncDirectorySync,
  LibraryPathUnsafeError,
  writeSafeLibraryFileSync
} from './library-path-safety'
import {
  assertLibraryWriterHeld,
  readLibraryWriteGeneration,
  runWithLibraryWriter,
  runWithLibraryWriterSync,
  staleScanEvent
} from './library-write-coordinator'
import { LibraryWriterBusyError, type LibraryWriterMode } from './library-writer-lease'
import type {
  RawJsonlMessage,
  ContentPart,
  SessionSource,
  SessionSummary,
  SessionDetailAvailability,
  Folder,
  UserConfig,
  SshConfig,
  SshTargetConfig
} from './types'

export { extractRemoteUser, resolveSessionRemoteState, type SessionRemoteState } from './session-remote-state'

// ============ Types ============

export interface SessionMeta {
  /**
   * Version 2 adds origin/sourceInstance. It stays optional so a v1
   * .swob-session.json can be read without migration or changed defaults.
   */
  schemaVersion?: 2 | 3
  /** Immutable package identity. Present on schema v3 packages created by Swob. */
  packageId?: string
  /** Stable provider/instance/session identity. Absolute source paths never enter this value. */
  logicalIdentity?: LogicalSessionIdentity
  sessionId: string
  sourceFilePaths: string[]
  customTitle?: string
  notes?: string
  highlights?: Array<{ id: string; text: string; turnUuid: string; note?: string; createdAt: string }>
  createdAt: string
  updatedAt: string
  projectPath: string
  /** Exact cwd captured from the source transcript; never reconstructed from projectPath. */
  resumeCwd?: string
  turnCount?: number  // swob 权威轮数（各类型统一），持久化供外部脚本按真实轮数归档
  /** Multi-membership metadata used by the tag lens. */
  tags?: string[]
  /** Cached smart-organization classification. */
  topic?: string
  topicConfidence?: number
  /** Expected bytes for strong iCloud materialization verification. */
  backupSha256?: string
  backupSize?: number
  /** Append-only checkpoint used to copy just the new JSONL tail on the next sync. */
  backupSourceState?: {
    path: string
    dev: number
    ino: number
    size: number
    mtimeMs: number
  }
  /** Immutable identity of the installation that first captured this Library item. */
  origin?: SessionOrigin
  /** Describes the original harness instance; it is never an authorization to write there. */
  sourceInstance?: SessionSourceInstance
  /** Canonical provider package metadata. backup.jsonl remains absent for this path. */
  canonicalProvider?: CanonicalPackageDescriptor
  /** Migrated capability hint. Runtime summaries always recompute this from live files. */
  detailAvailability?: SessionDetailAvailability
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

export { SessionCreateBusyError }
export { LibraryPathUnsafeError }
export { LibraryWriterBusyError }
export type { LogicalSessionIdentity, LogicalSessionKey, LibrarySessionBinding, SessionIdResolution }

export interface LibrarySession {
  sessionId: string
  dirPath: string
  mdPath: string
  jsonlPath: string
  meta: SessionMeta
  isSymlink: boolean
  /** Worker-scanned signature lets the main thread prime its cache without stat calls. */
  metaMtimeMs?: number
  metaSize?: number
  /** Runtime-only duplicate evidence; never persisted into the package manifest. */
  logicalSessionKey?: string
  duplicate?: boolean
  duplicatePackageCount?: number
  duplicatePackageHistory?: Array<{
    createdAt: string
    updatedAt: string
    turnCount: number
  }>
}

/**
 * Collapse physical packages only when their canonical LogicalSessionKey is
 * identical. Content is never merged: the newest manifest remains visible and
 * carries the number of packages it represents.
 */
export function collapseLibrarySessionsByLogicalKey(sessions: LibrarySession[]): LibrarySession[] {
  const groups = new Map<string, LibrarySession[]>()
  for (const session of sessions) {
    const key = String(logicalSessionKey(buildLogicalSessionIdentityFromMeta(session.meta)))
    const group = groups.get(key) || []
    group.push(session)
    groups.set(key, group)
  }

  return [...groups.entries()].map(([key, group]) => {
    // Folder views can contain a symlink and its canonical target. They are
    // two navigation entries, not two packages, so count immutable packageId
    // (or real path for legacy manifests) before declaring a duplicate.
    const physicalPackages = new Map<string, LibrarySession>()
    for (const session of group) {
      let physicalPath = path.resolve(session.dirPath)
      try { physicalPath = fs.realpathSync.native(session.dirPath) } catch { /* unresolved legacy path */ }
      const physicalKey = session.meta.packageId
        ? `package:${session.meta.packageId}`
        : `path:${physicalPath}`
      const existing = physicalPackages.get(physicalKey)
      if (!existing || (existing.isSymlink && !session.isSymlink)) {
        physicalPackages.set(physicalKey, session)
      }
    }
    const packages = [...physicalPackages.values()]
    const sorted = packages.sort((left, right) =>
      right.meta.updatedAt.localeCompare(left.meta.updatedAt) ||
      Number(left.isSymlink) - Number(right.isSymlink) ||
      right.dirPath.localeCompare(left.dirPath)
    )
    const winner = sorted[0]
    return {
      ...winner,
      logicalSessionKey: key,
      duplicate: packages.length > 1,
      duplicatePackageCount: packages.length,
      duplicatePackageHistory: sorted.map((session) => ({
        createdAt: session.meta.createdAt,
        updatedAt: session.meta.updatedAt,
        turnCount: session.meta.turnCount || 0
      }))
    }
  })
}

export interface LibraryFolder {
  name: string
  dirPath: string
  sessions: LibrarySession[]
  children: LibraryFolder[]
  files: LibraryFile[]
}

export interface LibraryFile {
  name: string
  path: string
}

export interface LibraryTree {
  root: string
  folders: LibraryFolder[]
  ungroupedSessions: LibrarySession[]
  rootFiles: LibraryFile[]
  /** Read-only identity blockers; callers must not infer a package from these paths. */
  identityIssues?: LibraryIdentityScanIssue[]
  /** Explicit evidence quality; omitted worker trees are never authoritative. */
  identityScanStatus?: 'authoritative-complete' | 'incomplete'
  /** Persisted Library write generation captured before this scan started. */
  writeGeneration?: number
  /** True when a writer committed while the recursive scan was in flight. */
  scanStale?: boolean
}

export interface LibraryConfig {
  libraryRoot: string
  preferences: {
    defaultViewMode: 'compact' | 'full'
    terminalApp: 'Terminal' | 'iTerm2'
    resumeTerminal?: 'terminal-app' | 'iterm' | 'custom' | 'windows-terminal' | 'powershell' | 'cmd'
    resumeTerminalCommandTemplate?: string
    experimentalClaudeDesktopImport?: boolean
    locale?: import('../shared/i18n').LegacyLocale
    settingsSchemaVersion?: 1
    defaultTerminalId?: string
    resumeMethodByHarness?: Record<string, import('../shared/settings-capabilities').ResumeMethod>
    defaultSort?: import('../shared/settings-capabilities').DefaultSort
    defaultGrouping?: import('../shared/settings-capabilities').DefaultGrouping
    singleTurnBehavior?: import('../shared/settings-capabilities').SingleTurnBehavior
    autoCheckUpdates?: boolean
    updateChannel?: import('../shared/settings-capabilities').UpdateChannel
    sshConfig?: SshConfig
    sshTargets?: SshTargetConfig[]
    llmProfiles?: import('./llm-profiles').LlmProfile[]
    smartFeatureBindings?: import('./llm-profiles').SmartFeatureBinding
    agentAlwaysOnTop?: boolean
    userIdentity?: { displayName: string; avatarRelPath?: string }
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
  llmSettings?: {
    provider: 'anthropic' | 'openai' | 'custom'
    keyHint: string
    model: string
    baseUrl: string
  }
}

// ============ Constants ============

const DEFAULT_ROOT = assertTestDefaultLibraryPath(
  process.env.SWOB_LIBRARY_ROOT || path.join(runtimeHome(), 'Documents', 'Swob')
)
const APP_CONFIG_DIR = path.join(runtimeHome(), '.claude-session-manager')
const APP_CONFIG_FILE = path.join(APP_CONFIG_DIR, 'app-config.json')

export interface AppConfig {
  libraryPath?: string
  /**
   * Per-home installation UUID. It is not a hardware or machine identifier.
   * It lives in ~/.claude-session-manager/app-config.json, never in Claude data dirs.
   */
  deviceId?: string
  /** First-run onboarding finished (or inherited from a pre-onboarding install). */
  onboardingCompleted?: boolean
  /** Harness sources the user chose to exclude entirely (no display, no backup). */
  excludedSources?: string[]
}

function isOriginalSessionSourcePath(filePath: string): boolean {
  return detectSessionSourceFromPath(filePath) !== null
}

function sourceStatPath(filePath: string): string {
  const source = detectSessionSourceFromPath(filePath)
  if (source === 'opencode') return stripOpencodeSessionRef(filePath)
  if (source === 'zcode') return stripZcodeSessionRef(filePath)
  if (source === 'hermes' && filePath.includes('/.hermes/state.db#')) return filePath.split('#')[0]
  return filePath
}

function sourceFilePathsForMeta(session: SessionSummary): string[] {
  const candidates = session.allFilePaths && session.allFilePaths.length > 0
    ? session.allFilePaths
    : [session.filePath]
  return candidates.filter(isOriginalSessionSourcePath)
}

function isFileBackedBackupSource(filePath: string): boolean {
  const source = detectSessionSourceFromPath(filePath)
  return source === 'claude-code' || source === 'codex' || source === 'cursor'
}

/** Source files that syncBackup physically writes into backup.jsonl. */
export function sessionBackupSourcePaths(
  session: Pick<SessionSummary, 'filePath' | 'allFilePaths'>
): string[] {
  const candidates = session.allFilePaths && session.allFilePaths.length > 0
    ? session.allFilePaths
    : [session.filePath]
  return candidates.filter((filePath) =>
    isOriginalSessionSourcePath(filePath) && isFileBackedBackupSource(filePath)
  )
}

export function loadAppConfig(): AppConfig {
  const config = readAppConfigStrict().config
  if (config.libraryPath) assertE2ELibraryPath(config.libraryPath)
  return config
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
      (config.deviceId !== undefined && (typeof config.deviceId !== 'string' || config.deviceId.length === 0)) ||
      (config.onboardingCompleted !== undefined && typeof config.onboardingCompleted !== 'boolean') ||
      (config.excludedSources !== undefined && (
        !Array.isArray(config.excludedSources) || !config.excludedSources.every((item) => typeof item === 'string')
      ))
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
    if (next.libraryPath) assertE2ELibraryPath(next.libraryPath)
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

/**
 * First-run onboarding is needed only for genuinely fresh installs. Pre-onboarding
 * installs (an initialized library already exists at the configured/default root)
 * are grandfathered in and marked completed on first check.
 */
export function isOnboardingNeeded(): boolean {
  const appConfig = loadAppConfig()
  if (appConfig.onboardingCompleted) return false
  if (appConfig.libraryPath || isLibraryInitialized(getConfiguredLibraryPath())) {
    try {
      updateAppConfigAtomically((existing) => ({ ...existing, onboardingCompleted: true }))
    } catch { /* best effort; recheck next launch */ }
    return false
  }
  return true
}

export function getExcludedSources(): string[] {
  return loadAppConfig().excludedSources || []
}

export function completeOnboarding(libraryPath: string, excludedSources: string[]): void {
  updateAppConfigAtomically(
    (existing) => ({
      ...existing,
      libraryPath,
      excludedSources: excludedSources.length > 0 ? excludedSources : undefined,
      onboardingCompleted: true
    }),
    true
  )
}

export function setExcludedSources(excludedSources: string[]): void {
  updateAppConfigAtomically((existing) => ({
    ...existing,
    excludedSources: excludedSources.length > 0 ? excludedSources : undefined
  }))
}

export function getDefaultLibraryRoot(): string {
  return DEFAULT_ROOT
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
export const ICLOUD_BACKUP_WAITING_REASON = '会话备份正在等待 iCloud 下载'
export const SSH_RESUME_UNAVAILABLE_REASON = '此会话没有可用的远程设备 SSH 配置'
export const SSH_RESUME_CWD_WARNING = '存量会话缺少精确工作目录；SSH Resume 将在远程默认目录启动，路径可能不准'

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

export interface SessionSshResumeAvailability {
  canResume: boolean
  reason?: string
  warning?: string
  target?: SshTargetConfig
}

// ============ Library Manager ============

let _root: string = DEFAULT_ROOT
let _ignoreDirs: Set<string> = new Set(DEFAULT_IGNORE_DIRS)
let _readOnly = false
let _appliedWriteGeneration = 0
let _localWriterDepth = 0

async function withLibraryWriter<T>(mode: LibraryWriterMode, operation: () => Promise<T> | T): Promise<T> {
  const writerRoot = _root
  _localWriterDepth++
  try {
    return await runWithLibraryWriter(writerRoot, getOrCreateLocalDeviceId(), mode, operation)
  } finally {
    _localWriterDepth--
    _appliedWriteGeneration = Math.max(_appliedWriteGeneration, readLibraryWriteGeneration(writerRoot))
  }
}

function withLibraryWriterSync<T>(mode: LibraryWriterMode, operation: () => T): T {
  const writerRoot = _root
  _localWriterDepth++
  try {
    return runWithLibraryWriterSync(writerRoot, getOrCreateLocalDeviceId(), mode, operation)
  } finally {
    _localWriterDepth--
    _appliedWriteGeneration = Math.max(_appliedWriteGeneration, readLibraryWriteGeneration(writerRoot))
  }
}

/** Batch boundary used by the worker so ensure/transcript/backup cannot be interleaved with a CLI move. */
export function withLibraryMaintenanceWriter<T>(operation: () => Promise<T> | T): Promise<T> {
  return withLibraryWriter('maintenance', operation)
}

export function getLibraryRoot(): string {
  return _root
}

export function getIgnoreDirs(): Set<string> {
  return _ignoreDirs
}

export interface InitLibraryOptions {
  readOnly?: boolean
  ignoreDirs?: string[]
}

export function initLibrary(root?: string, options: InitLibraryOptions = {}): void {
  const nextRoot = root || getConfiguredLibraryPath()
  if (path.resolve(nextRoot) !== path.resolve(_root) && _localWriterDepth > 0) {
    throw new LibraryWriterBusyError('active-owner')
  }
  if (path.resolve(nextRoot) !== path.resolve(_root)) {
    sessionMetaCache.clear()
    sessionMetaDiskReads = 0
    sessionRegistry.clear()
    lastIdentityScanIssues = []
  }
  _cachedLibraryConfig = null
  _cachedLibraryConfigRoot = ''
  _root = nextRoot
  _readOnly = options.readOnly === true
  _appliedWriteGeneration = readLibraryWriteGeneration(_root)
  if (!options.readOnly && !fs.existsSync(_root)) {
    fs.mkdirSync(_root, { recursive: true })
  }
  if (!options.readOnly) canonicalLibraryRootForWrite(_root)
  // 库根可能是整个 vault：加载忽略名单，避免扫描 wiki/clipii/日记 等非项目目录
  const cfg = loadLibraryConfig()
  _ignoreDirs = new Set(
    options.ignoreDirs || (cfg.ignoreDirs && cfg.ignoreDirs.length ? cfg.ignoreDirs : DEFAULT_IGNORE_DIRS)
  )
}

// --- Config (cached to avoid thousands of readFileSync per load cycle) ---

let _cachedLibraryConfig: LibraryConfig | null = null
let _cachedLibraryConfigRoot: string = ''
let _configSaveQueue: Promise<void> = Promise.resolve()

export function loadLibraryConfig(): LibraryConfig {
  if (_cachedLibraryConfig && _cachedLibraryConfigRoot === _root) return _cachedLibraryConfig
  const configPath = path.join(_root, LIBRARY_CONFIG_FILE)
  try {
    if (fs.existsSync(configPath)) {
      _cachedLibraryConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
      _cachedLibraryConfigRoot = _root
      return _cachedLibraryConfig!
    }
  } catch { /* ignore */ }
  _cachedLibraryConfig = {
    libraryRoot: _root,
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }
  _cachedLibraryConfigRoot = _root
  return _cachedLibraryConfig
}

export function saveLibraryConfig(config: LibraryConfig): void {
  withLibraryWriterSync('config', () => saveLibraryConfigUnderWriter(config))
}

/**
 * Persist config without blocking the main event loop while another local
 * Library operation owns the writer lease. IPC handlers should prefer this
 * variant so an in-flight maintenance batch can finish and release its lock.
 */
export async function saveLibraryConfigAsync(config: LibraryConfig): Promise<void> {
  // The filesystem lease coordinates processes but does not promise FIFO to
  // several waiters in this process. Preserve IPC arrival order explicitly so
  // a slower, older preferences snapshot can never overwrite a newer one.
  _localWriterDepth++
  const pending = _configSaveQueue.then(() =>
    withLibraryWriter('config', () => saveLibraryConfigUnderWriter(config))
  )
  const completed = pending.finally(() => { _localWriterDepth-- })
  _configSaveQueue = completed.catch(() => undefined)
  await completed
}

function saveLibraryConfigUnderWriter(config: LibraryConfig): void {
  assertLibraryWriterHeld(_root)
  const configPath = path.join(_root, LIBRARY_CONFIG_FILE)
  if (!fs.existsSync(_root)) fs.mkdirSync(_root, { recursive: true })
  canonicalLibraryRootForWrite(_root)
  assertSafeLibraryFileTarget(_root, configPath)
  const tempPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeSafeLibraryFileSync(_root, tempPath, JSON.stringify(config, null, 2), { exclusive: true })
    fs.renameSync(tempPath, configPath)
    fsyncDirectorySync(_root)
    fs.chmodSync(configPath, 0o600)
  } finally {
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true })
  }
  _cachedLibraryConfig = config
  _cachedLibraryConfigRoot = _root
}

export function invalidateLibraryConfigCache(): void {
  _cachedLibraryConfig = null
  _cachedLibraryConfigRoot = ''
}

// --- Session Dir Naming ---

/** Emoji marker distinguishing session packages from ordinary folders in Obsidian/Finder. */
export const SESSION_DIR_PREFIX = '💬 '

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function isWindowsCompatibleLibraryName(name: string): boolean {
  return name.length > 0 &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) &&
    !WINDOWS_RESERVED_NAME.test(name)
}

export function sanitizeLibraryEntryName(title: string): string {
  let sanitized = title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .replace(/[. ]+$/g, '')

  if (!sanitized) sanitized = 'untitled'
  if (WINDOWS_RESERVED_NAME.test(sanitized)) sanitized = `_${sanitized}`
  return sanitized
}

function sanitizeDirName(title: string): string {
  return sanitizeLibraryEntryName(title)
}

type SymlinkWriter = (target: fs.PathLike, linkPath: fs.PathLike, type?: fs.symlink.Type) => void

export function createSessionFolderReference(
  targetPath: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
  writeSymlink: SymlinkWriter = fs.symlinkSync
): void {
  // Directory junctions do not require Windows Developer Mode/admin rights,
  // while preserving the existing logical multi-folder reference semantics.
  if (platform === 'win32') {
    writeSymlink(targetPath, linkPath, 'junction')
    return
  }
  writeSymlink(targetPath, linkPath)
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

function isValidBackupSourceState(value: unknown): value is NonNullable<SessionMeta['backupSourceState']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return isNonEmptyString(state.path) &&
    ['dev', 'ino', 'size', 'mtimeMs'].every((field) =>
      typeof state[field] === 'number' && Number.isFinite(state[field]) && (state[field] as number) >= 0
    )
}

/** Parse legacy v1/v2 and identity-bearing v3 metadata, rejecting malformed data at the boundary. */
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
    if (meta.schemaVersion !== undefined && meta.schemaVersion !== 2 && meta.schemaVersion !== 3) {
      warn('[library-manager] Ignoring invalid session metadata: unsupported schemaVersion')
      return null
    }
    if (meta.packageId !== undefined && !isNonEmptyString(meta.packageId)) {
      warn('[library-manager] Ignoring invalid session metadata: malformed packageId')
      return null
    }
    if (meta.logicalIdentity !== undefined && !isValidLogicalSessionIdentity(meta.logicalIdentity)) {
      warn('[library-manager] Ignoring invalid session metadata: malformed logicalIdentity')
      return null
    }
    if (meta.logicalIdentity && (meta.logicalIdentity as LogicalSessionIdentity).sessionId !== meta.sessionId) {
      warn('[library-manager] Ignoring invalid session metadata: logical identity mismatch')
      return null
    }
    if (meta.schemaVersion === 3 && (!isNonEmptyString(meta.packageId) ||
      !isValidLogicalSessionIdentity(meta.logicalIdentity))) {
      warn('[library-manager] Ignoring invalid session metadata: incomplete v3 identity')
      return null
    }
    if (meta.resumeCwd !== undefined && !isNonEmptyString(meta.resumeCwd)) {
      warn('[library-manager] Ignoring invalid session metadata: resumeCwd must be a non-empty string')
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
    if (meta.backupSourceState !== undefined && !isValidBackupSourceState(meta.backupSourceState)) {
      warn('[library-manager] Ignoring invalid session metadata: malformed backupSourceState')
      return null
    }
    if (meta.tags !== undefined &&
      (!Array.isArray(meta.tags) || !meta.tags.every((tag) => typeof tag === 'string'))) {
      warn('[library-manager] Ignoring invalid session metadata: tags must be strings')
      return null
    }
    if (meta.topic !== undefined && typeof meta.topic !== 'string') {
      warn('[library-manager] Ignoring invalid session metadata: topic must be a string')
      return null
    }
    if (meta.topicConfidence !== undefined &&
      (typeof meta.topicConfidence !== 'number' || !Number.isFinite(meta.topicConfidence) ||
        meta.topicConfidence < 0 || meta.topicConfidence > 1)) {
      warn('[library-manager] Ignoring invalid session metadata: topicConfidence must be between 0 and 1')
      return null
    }
    if (meta.canonicalProvider !== undefined && !isCanonicalPackageDescriptor(meta.canonicalProvider)) {
      warn('[library-manager] Ignoring invalid session metadata: malformed canonicalProvider')
      return null
    }
    if (meta.detailAvailability !== undefined &&
      !['ready', 'transcript-only', 'source-recoverable', 'unavailable'].includes(
        meta.detailAvailability as string
      )) {
      warn('[library-manager] Ignoring invalid session metadata: malformed detailAvailability')
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
    assertSafeLibraryFileTarget(_root, metaPath)
    const stat = fs.statSync(metaPath)
    const cached = sessionMetaCache.get(metaPath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return structuredClone(cached.meta)
    }
    const meta = parseSessionMeta(fs.readFileSync(metaPath, 'utf-8'))
    sessionMetaDiskReads++
    if (!meta) return null
    sessionMetaCache.set(metaPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta: structuredClone(meta) })
    return meta
  } catch { /* corrupt */ }
  return null
}

function assertCurrentSessionWriteAuthorized(dirPath: string, meta: SessionMeta): void {
  assertSafeLibraryWritePath(_root, dirPath, { allowRoot: false })
  const key = logicalSessionKey(buildLogicalSessionIdentityFromMeta(meta))
  const binding = sessionRegistry.get(key)
  if (binding.state === 'conflict') throw new SessionIdentityConflictError(key, binding.candidates)
  if (binding.state === 'missing') {
    if (binding.reason === 'previously-seen') {
      throw new SessionIdentityMissingError(key, binding.lastKnownCandidates)
    }
    throw new Error('session-write-without-bound-registry')
  }
  if (path.resolve(binding.candidate.dirPath) !== path.resolve(dirPath)) {
    throw new Error('session-binding-mismatch')
  }
}

function writeSessionMetaFile(dirPath: string, meta: SessionMeta, exclusive = false): void {
  assertLibraryWriterHeld(_root)
  const metaPath = path.join(dirPath, SESSION_META_FILE)
  if (!exclusive && fs.existsSync(metaPath)) {
    const existing = readSessionMeta(dirPath)
    if (existing?.packageId && existing.packageId !== meta.packageId) {
      throw new Error('immutable-package-id')
    }
    if (existing?.logicalIdentity &&
      logicalSessionKey(existing.logicalIdentity) !==
      logicalSessionKey(meta.logicalIdentity || buildLogicalSessionIdentityFromMeta(meta))) {
      throw new Error('immutable-logical-session-identity')
    }
  }
  writeSafeLibraryFileSync(_root, metaPath, JSON.stringify(meta, null, 2), { exclusive })
  try {
    const stat = fs.statSync(metaPath)
    sessionMetaCache.set(metaPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta: structuredClone(meta) })
  } catch {
    sessionMetaCache.delete(metaPath)
  }
}

function writeSessionMeta(dirPath: string, meta: SessionMeta): void {
  assertCurrentSessionWriteAuthorized(dirPath, meta)
  writeSessionMetaFile(dirPath, meta)
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
  return withLibraryWriterSync('metadata', () => setSessionTurnCountUnderWriter(dirPath, turnCount))
}

function setSessionTurnCountUnderWriter(dirPath: string, turnCount: number): void {
  if (typeof turnCount !== 'number') return
  const m = readSessionMeta(dirPath)
  if (m && m.turnCount !== turnCount) {
    requireWritableSessionDir(m.sessionId, dirPath)
    m.turnCount = turnCount
    writeSessionMeta(dirPath, m)
  }
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

// --- Logical identity registry: identity is stable; dirPath is only a binding ---

const sessionRegistry = new LibrarySessionRegistry()
const sessionMetaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta }>()
let sessionMetaDiskReads = 0
let lastIdentityScanIssues: LibraryIdentityScanIssue[] = []

export class SessionIdentityConflictError extends Error {
  readonly code = 'SESSION_IDENTITY_CONFLICT'

  constructor(readonly logicalKey: LogicalSessionKey, readonly candidates: LibrarySessionCandidate[]) {
    super('Multiple Library packages claim the same logical session identity')
    this.name = 'SessionIdentityConflictError'
  }
}

export class SessionIdentityAmbiguousError extends Error {
  readonly code = 'SESSION_IDENTITY_AMBIGUOUS'

  constructor(readonly sessionId: string, readonly candidates: LibrarySessionCandidate[]) {
    super('The legacy sessionId resolves to more than one logical session')
    this.name = 'SessionIdentityAmbiguousError'
  }
}

export class SessionIdentityUnresolvedError extends Error {
  readonly code = 'SESSION_IDENTITY_UNRESOLVED'

  constructor(readonly issueKinds: LibraryIdentityScanIssue['kind'][]) {
    super('Library identity cannot be proven while unresolved package markers exist')
    this.name = 'SessionIdentityUnresolvedError'
  }
}

export class SessionIdentityMissingError extends Error {
  readonly code = 'SESSION_IDENTITY_MISSING'

  constructor(readonly logicalKey: LogicalSessionKey, readonly lastKnownCandidates: LibrarySessionCandidate[]) {
    super('A previously observed Library package is temporarily missing; automatic recreation is blocked')
    this.name = 'SessionIdentityMissingError'
  }
}

export class SessionPackageIdCollisionError extends Error {
  readonly code = 'SESSION_PACKAGE_ID_COLLISION'

  constructor() {
    super('Unable to allocate a unique package identity')
    this.name = 'SessionPackageIdCollisionError'
  }
}

export function resolveSessionBinding(sessionId: string): SessionIdResolution {
  return sessionRegistry.resolveSessionId(sessionId)
}

export function getLibrarySessionRegistryDiagnostics(): LibrarySessionBinding[] {
  return sessionRegistry.diagnostics()
}

export function getLibraryIdentityScanIssues(): LibraryIdentityScanIssue[] {
  return structuredClone(lastIdentityScanIssues)
}

function uniqueSessionDir(sessionId: string): string | null {
  const resolution = sessionRegistry.resolveSessionId(sessionId)
  if (resolution.state !== 'bound') return null
  return fs.existsSync(resolution.candidate.dirPath) ? resolution.candidate.dirPath : null
}

function throwForUnsafeResolution(resolution: SessionIdResolution): never {
  if (resolution.state === 'conflict') {
    throw new SessionIdentityConflictError(resolution.logicalKey, resolution.candidates)
  }
  if (resolution.state === 'ambiguous') {
    throw new SessionIdentityAmbiguousError(resolution.sessionId, resolution.candidates)
  }
  if (resolution.state === 'missing' && resolution.logicalKey && resolution.reason === 'previously-seen') {
    throw new SessionIdentityMissingError(resolution.logicalKey, resolution.lastKnownCandidates || [])
  }
  throw new Error(`Session "${resolution.sessionId}" 不存在`)
}

function requireWritableSessionDir(sessionId: string, expectedDirPath?: string): string {
  const issues = refreshSessionRegistryFromDisk()
  throwIfIdentityScanUnresolved(issues)
  if (expectedDirPath) {
    const meta = readSessionMeta(expectedDirPath)
    if (!meta || meta.sessionId !== sessionId) throw new Error('session-binding-mismatch')
    const key = logicalSessionKey(buildLogicalSessionIdentityFromMeta(meta))
    const binding = sessionRegistry.get(key)
    if (binding.state === 'conflict') throw new SessionIdentityConflictError(key, binding.candidates)
    if (binding.state === 'missing' && binding.reason === 'previously-seen') {
      throw new SessionIdentityMissingError(key, binding.lastKnownCandidates)
    }
    if (binding.state !== 'bound' || path.resolve(binding.candidate.dirPath) !== path.resolve(expectedDirPath)) {
      throw new Error('session-binding-mismatch')
    }
    assertSafeLibraryWritePath(_root, expectedDirPath, { allowRoot: false })
    return expectedDirPath
  }

  const resolution = sessionRegistry.resolveSessionId(sessionId)
  if (resolution.state !== 'bound') return throwForUnsafeResolution(resolution)
  assertSafeLibraryWritePath(_root, resolution.candidate.dirPath, { allowRoot: false })
  return resolution.candidate.dirPath
}

function writableSessionDirOrNull(sessionId: string, expectedDirPath?: string): string | null {
  if (expectedDirPath) return requireWritableSessionDir(sessionId, expectedDirPath)
  const resolution = sessionRegistry.resolveSessionId(sessionId)
  if (resolution.state === 'missing') return null
  return requireWritableSessionDir(sessionId)
}

export function getLibraryMetaCacheStats(): { entries: number; diskReads: number } {
  return { entries: sessionMetaCache.size, diskReads: sessionMetaDiskReads }
}

export function getSessionDirPath(sessionId: string): string | null {
  return uniqueSessionDir(sessionId)
}

export function getSessionMdPath(sessionId: string): string | null {
  const dirPath = uniqueSessionDir(sessionId)
  if (!dirPath) return null
  const mdPath = path.join(dirPath, TRANSCRIPT_FILE)
  return fs.existsSync(mdPath) ? mdPath : null
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const rel = path.relative(parentDir, childPath)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function isRestorableLocalClaudeSource(sourcePath: string): boolean {
  const home = runtimeHome()
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

export type SessionBackupState = 'ready' | 'icloud-placeholder' | 'missing'

function backupStateForDir(dirPath?: string | null): SessionBackupState {
  const backupPath = backupPathForDir(dirPath)
  if (!backupPath) return 'missing'
  if (fs.existsSync(backupPath)) return 'ready'
  return isICloudPlaceholder(backupPath) ? 'icloud-placeholder' : 'missing'
}

export function getSessionBackupState(sessionId: string): SessionBackupState {
  return backupStateForDir(uniqueSessionDir(sessionId))
}

function hasBackupForDir(dirPath?: string | null): boolean {
  return backupStateForDir(dirPath) !== 'missing'
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
  dirPath?: string | null,
  remoteManifestOnly = false
): SessionResumeAvailability {
  const provider = builtinProviderForSource(source)
  if (provider) {
    const terminal = provider.manifest.capabilities['terminal-resume']
    const native = provider.manifest.capabilities['native-resume']
    const supported = [terminal, native].some((declaration) =>
      declaration.status === 'available' || declaration.status === 'experimental'
    )
    if (!supported) {
      return {
        canResume: false,
        reason: terminal.reason || native.reason || LOCAL_RESUME_UNAVAILABLE_REASON,
        sourcePath: sourceFilePaths[0] || null
      }
    }
  }
  if (source === 'hermes' && sourceFilePaths.every((sourcePath) =>
    sourceStatPath(sourcePath).toLocaleLowerCase('en-US').endsWith('.json'))) {
    return {
      canResume: false,
      reason: 'Legacy Hermes JSON snapshots are read-only; Hermes resumes sessions from state.db.',
      sourcePath: sourceFilePaths[0] || null
    }
  }
  const existingSource = sourceFilePaths.find((src) => fs.existsSync(sourceStatPath(src)))
  if (existingSource) return { canResume: true, sourcePath: existingSource }

  if (source === 'claude-code' && hasBackupForDir(dirPath)) {
    const restorableSource = sourceFilePaths.find(isRestorableLocalClaudeSource)
    if (restorableSource) return { canResume: true, sourcePath: restorableSource }
  }

  return {
    canResume: false,
    reason: backupStateForDir(dirPath) === 'icloud-placeholder' ||
      (backupStateForDir(dirPath) === 'missing' && remoteManifestOnly)
      ? ICLOUD_BACKUP_WAITING_REASON
      : LOCAL_RESUME_UNAVAILABLE_REASON,
    sourcePath: sourceFilePaths[0] || null
  }
}

/**
 * Conservative phase-one Resume truth for freshly discovered summaries.
 * This deliberately avoids Library registry/meta reads so the first session
 * list remains fast. Background Library hydration may later upgrade a missing
 * local source to a recoverable backup or SSH path.
 */
export function getImmediateSessionResumeAvailability(
  session: Pick<SessionSummary, 'filePath' | 'allFilePaths' | 'source'>
): SessionResumeAvailability {
  const sourceFilePaths = sourceFilePathsFromSummary(session)
  if (sourceFilePaths.length === 0) {
    const provider = session.source ? builtinProviderForSource(session.source) : undefined
    const terminal = provider?.manifest.capabilities['terminal-resume']
    const native = provider?.manifest.capabilities['native-resume']
    return {
      canResume: false,
      reason: terminal?.reason || native?.reason || LOCAL_RESUME_UNAVAILABLE_REASON,
      sourcePath: null
    }
  }
  return evaluateSourceResumeAvailability(
    sourceFilePaths,
    detectSourceFromSourcePaths(sourceFilePaths, session.source),
    null
  )
}

export function getSessionResumeAvailability(
  sessionId: string,
  session?: Pick<SessionSummary, 'sessionId' | 'filePath' | 'allFilePaths' | 'source'>
): SessionResumeAvailability {
  const dirPath = uniqueSessionDir(sessionId) || (session?.sessionId ? uniqueSessionDir(session.sessionId) : null)
  const meta = dirPath ? readSessionMeta(dirPath) : null
  const summarySourceFilePaths = sourceFilePathsFromSummary(session)

  if (meta) {
    const metaSourceFilePaths = sourceFilePathsFromMeta(meta)
    if (metaSourceFilePaths && metaSourceFilePaths.length > 0) {
      return evaluateSourceResumeAvailability(
        metaSourceFilePaths,
        detectSourceFromSourcePaths(metaSourceFilePaths, session?.source),
        dirPath,
        resolveLibrarySessionRemoteState(meta).isRemote
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

/** The sole Library-to-Claude recovery adapter used by every local resume entry point. */
export async function ensureSessionResumeTarget(
  sessionId: string,
  options: SessionResumePreparationOptions = {}
): Promise<SessionResumePreparationResult> {
  const dirPath = uniqueSessionDir(sessionId)
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
    homeDir: runtimeHome(),
    localDeviceId: getOrCreateLocalDeviceId(),
    localUsername: os.userInfo().username
  }
  const recoveryStartedAt = Date.now()
  let recovery: Awaited<ReturnType<typeof ensureClaudeResumeTarget>>
  try {
    recovery = await ensureClaudeResumeTarget({
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
  } catch {
    recovery = { ok: false, reason: 'io-error' }
  }
  try {
    withLibraryWriterSync('metadata', () => {
      recordRecoveryAttempt(getLibraryRoot(), {
        sessionId,
        physicalSessionId: requestedPhysicalId,
        attemptedAt: new Date(recoveryStartedAt).toISOString(),
        durationMs: Date.now() - recoveryStartedAt,
        result: recovery
      })
    })
  } catch {
    // Metrics must never turn a successful recovery into a user-visible failure.
    console.warn('[recovery-metrics] failed to append recovery attempt')
  }
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
  const dirPath = uniqueSessionDir(baseId)
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
  return withLibraryWriter('transcript', () =>
    updateBranchTranscriptUnderWriter(branchId, branchLeafUuid, customTitle))
}

async function updateBranchTranscriptUnderWriter(
  branchId: string,
  branchLeafUuid: string,
  customTitle?: string
): Promise<string | null> {
  const colonIdx = branchId.indexOf(':intra-')
  if (colonIdx === -1) return null
  const baseId = branchId.slice(0, colonIdx)
  const suffix = branchId.slice(colonIdx + 1)
  const dirPath = writableSessionDirOrNull(baseId)
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
  assertCurrentSessionWriteAuthorized(dirPath, meta)
  writeSafeLibraryFileSync(_root, mdPath, md)
  return mdPath
}

// --- Scan Library ---

export interface LibraryIdentityScanIssue {
  kind: 'corrupt-manifest' | 'icloud-placeholder' | 'unreadable-link' |
    'unreadable-directory' | 'incomplete-publish' | 'identity-evidence-unavailable'
  dirPath: string
  code?: string
  logicalKeyHash?: string
}

function scanDir(
  dirPath: string,
  identityIssues: LibraryIdentityScanIssue[] = [],
  inheritedSymlink = false
): { sessions: LibrarySession[]; folders: LibraryFolder[]; files: LibraryFile[] } {
  const sessions: LibrarySession[] = []
  const folders: LibraryFolder[] = []
  const files: LibraryFile[] = []

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true })
  } catch (error) {
    identityIssues.push({
      kind: 'unreadable-directory',
      dirPath,
      code: (error as NodeJS.ErrnoException).code
    })
    return { sessions, folders, files }
  }

  const incompleteMarker = path.join(dirPath, '.swob-incomplete.json')
  if (fs.existsSync(incompleteMarker) && !fs.existsSync(path.join(dirPath, SESSION_META_FILE))) {
    identityIssues.push({ kind: 'incomplete-publish', dirPath })
  }

  if (!fs.existsSync(path.join(dirPath, SESSION_META_FILE)) &&
    (fs.existsSync(path.join(dirPath, `${SESSION_META_FILE}.icloud`)) ||
      isICloudPlaceholder(path.join(dirPath, SESSION_META_FILE)))) {
    identityIssues.push({ kind: 'icloud-placeholder', dirPath })
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      if (entry.isDirectory() && entry.name.startsWith('.swob-create-')) {
        identityIssues.push({ kind: 'incomplete-publish', dirPath: path.join(dirPath, entry.name) })
      }
      continue
    }
    // Skip iCloud placeholder files (e.g. .filename.icloud)
    if (entry.name.includes('.icloud')) continue
    // 库根设为整个 vault 时，跳过 wiki/clipii/日记 等非项目目录
    if (_ignoreDirs.has(entry.name)) continue
    const fullPath = path.join(dirPath, entry.name)

    if (entry.isFile()) {
      files.push({ name: entry.name, path: fullPath })
      continue
    }

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
      identityIssues.push({ kind: 'unreadable-link', dirPath: fullPath })
      continue // broken symlink or iCloud download in progress
    }

    try {
      if (!fs.statSync(realPath).isDirectory()) continue
    } catch {
      if (isSymlink) identityIssues.push({ kind: 'unreadable-link', dirPath: fullPath })
      continue
    }

    if (isSessionDir(realPath)) {
      try {
        fs.accessSync(path.join(realPath, SESSION_META_FILE), fs.constants.R_OK)
      } catch (error) {
        identityIssues.push({
          kind: 'unreadable-directory',
          dirPath: realPath,
          code: (error as NodeJS.ErrnoException).code
        })
        continue
      }
      const meta = readSessionMeta(realPath)
      if (meta) {
        const metaSignature = sessionMetaCache.get(path.join(realPath, SESSION_META_FILE))
        sessions.push({
          sessionId: meta.sessionId,
          dirPath: realPath,
          mdPath: path.join(realPath, TRANSCRIPT_FILE),
          jsonlPath: path.join(realPath, BACKUP_FILE),
          meta,
          isSymlink: inheritedSymlink || isSymlink,
          metaMtimeMs: metaSignature?.mtimeMs,
          metaSize: metaSignature?.size
        })
      } else {
        identityIssues.push({ kind: 'corrupt-manifest', dirPath: realPath })
      }
    } else {
      // It's a user folder — recurse
      const sub = scanDir(fullPath, identityIssues, inheritedSymlink || isSymlink)
      folders.push({
        name: entry.name,
        dirPath: fullPath,
        sessions: sub.sessions,
        children: sub.folders,
        files: sub.files
      })
    }
  }

  files.sort((a, b) => a.name.localeCompare(b.name))
  return { sessions, folders, files }
}

export function scanLibrary(): LibraryTree {
  const writeGeneration = readLibraryWriteGeneration(_root)
  const identityIssues: LibraryIdentityScanIssue[] = []
  const { sessions, folders, files } = scanDir(_root, identityIssues)
  const scanCompletedGeneration = readLibraryWriteGeneration(_root)
  const tree: LibraryTree = {
    root: _root,
    folders,
    ungroupedSessions: sessions,
    rootFiles: files,
    identityIssues,
    identityScanStatus: identityIssues.length === 0 ? 'authoritative-complete' : 'incomplete',
    writeGeneration,
    scanStale: scanCompletedGeneration !== writeGeneration
  }
  applyLibraryTree(tree)
  return tree
}

function sessionsFromLibraryTree(tree: LibraryTree): LibrarySession[] {
  const sessions: LibrarySession[] = [...tree.ungroupedSessions]
  const visit = (folder: LibraryFolder): void => {
    sessions.push(...folder.sessions)
    folder.children.forEach(visit)
  }
  tree.folders.forEach(visit)
  return sessions
}

/**
 * One-time schema-v2 repair for packages that retained a Markdown transcript
 * but lost their JSONL backup. The live file check remains authoritative; the
 * persisted field lets older packages advertise the capability to other Swob
 * installations before they have been reparsed.
 */
export async function migrateLegacyDetailAvailability(tree: LibraryTree): Promise<number> {
  if (_readOnly) return 0
  const candidates = sessionsFromLibraryTree(tree).filter((session) =>
    !session.isSymlink &&
    session.meta.schemaVersion === 2 &&
    session.meta.detailAvailability === undefined &&
    resolveLibraryDetailAvailability(session) === 'transcript-only'
  )
  if (candidates.length === 0) return 0

  return withLibraryWriter('metadata', () => {
    let migrated = 0
    for (const session of candidates) {
      try {
        const current = readSessionMeta(session.dirPath)
        if (!current || current.schemaVersion !== 2 || current.detailAvailability !== undefined) continue
        requireWritableSessionDir(current.sessionId, session.dirPath)
        current.detailAvailability = 'transcript-only'
        writeSessionMeta(session.dirPath, current)
        migrated++
      } catch {
        // Identity conflicts and concurrent package changes are intentionally
        // skipped; a later authoritative scan can retry without guessing.
      }
    }
    return migrated
  })
}

/** Apply a tree scanned by the Library worker without rereading every meta file. */
export function applyLibraryTree(tree: LibraryTree): boolean {
  if (path.resolve(tree.root) !== path.resolve(_root)) return false
  const incomingGeneration = tree.writeGeneration ?? 0
  const currentGeneration = Math.max(_appliedWriteGeneration, readLibraryWriteGeneration(_root))
  if (tree.scanStale || incomingGeneration < currentGeneration) {
    staleScanEvent(_root, incomingGeneration, currentGeneration)
    return false
  }
  _appliedWriteGeneration = incomingGeneration
  lastIdentityScanIssues = structuredClone(tree.identityIssues || [])
  const registryCandidates: LibrarySessionCandidate[] = []
  const liveMetaPaths = new Set<string>()
  function indexSessions(list: LibrarySession[]): void {
    for (const s of list) {
      registryCandidates.push(candidateFromManifest(s.dirPath, s.meta, s.isSymlink))
      const metaPath = path.join(s.dirPath, SESSION_META_FILE)
      liveMetaPaths.add(metaPath)
      if (typeof s.metaMtimeMs === 'number' && typeof s.metaSize === 'number') {
        sessionMetaCache.set(metaPath, {
          mtimeMs: s.metaMtimeMs,
          size: s.metaSize,
          meta: structuredClone(s.meta)
        })
      } else try {
        const stat = fs.statSync(metaPath)
        sessionMetaCache.set(metaPath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          meta: structuredClone(s.meta)
        })
      } catch { /* source may be an iCloud placeholder */ }
    }
  }
  function indexFolder(f: LibraryFolder): void {
    indexSessions(f.sessions)
    for (const child of f.children) indexFolder(child)
  }

  indexSessions(tree.ungroupedSessions)
  for (const f of tree.folders) indexFolder(f)
  if (tree.identityScanStatus === 'authoritative-complete' && lastIdentityScanIssues.length === 0) {
    try {
      persistObservedLogicalSessionKeys(registryCandidates)
    } catch (error) {
      lastIdentityScanIssues.push({
        kind: 'identity-evidence-unavailable',
        dirPath: path.join(_root, '.swob', 'logical-sessions'),
        code: (error as NodeJS.ErrnoException).code
      })
      tree.identityScanStatus = 'incomplete'
      tree.identityIssues = structuredClone(lastIdentityScanIssues)
    }
  }
  sessionRegistry.replace(registryCandidates, {
    authoritative: tree.identityScanStatus === 'authoritative-complete' && lastIdentityScanIssues.length === 0
  })
  for (const metaPath of sessionMetaCache.keys()) {
    if (!liveMetaPaths.has(metaPath)) sessionMetaCache.delete(metaPath)
  }
  return true
}

/** Read-only disk recovery used after a stale/missing binding and before every create transaction. */
function refreshSessionRegistryFromDisk(): LibraryIdentityScanIssue[] {
  const identityIssues: LibraryIdentityScanIssue[] = []
  const { sessions, folders } = scanDir(_root, identityIssues)
  const candidates: LibrarySessionCandidate[] = []
  const collectSessions = (items: LibrarySession[]): void => {
    for (const item of items) candidates.push(candidateFromManifest(item.dirPath, item.meta, item.isSymlink))
  }
  const collectFolder = (folder: LibraryFolder): void => {
    collectSessions(folder.sessions)
    for (const child of folder.children) collectFolder(child)
  }
  collectSessions(sessions)
  for (const folder of folders) collectFolder(folder)
  if (identityIssues.length === 0) {
    try {
      persistObservedLogicalSessionKeys(candidates)
    } catch (error) {
      identityIssues.push({
        kind: 'identity-evidence-unavailable',
        dirPath: path.join(_root, '.swob', 'logical-sessions'),
        code: (error as NodeJS.ErrnoException).code
      })
    }
  }
  sessionRegistry.replace(candidates, { authoritative: identityIssues.length === 0 })
  _appliedWriteGeneration = Math.max(_appliedWriteGeneration, readLibraryWriteGeneration(_root))
  lastIdentityScanIssues = structuredClone(identityIssues)
  return identityIssues
}

/**
 * Build a lightweight renderer summary from the manifest only. This keeps a
 * remote session discoverable while backup.jsonl is still an iCloud placeholder.
 */
export function resolveLibraryDetailAvailability(session: LibrarySession): SessionDetailAvailability {
  if (backupStateForDir(session.dirPath) === 'ready') return 'ready'
  try {
    if (fs.statSync(session.mdPath).isFile()) return 'transcript-only'
  } catch { /* no readable transcript */ }
  if ((sourceFilePathsFromMeta(session.meta) || []).some((sourcePath) => {
    try {
      return fs.statSync(sourceStatPath(sourcePath)).isFile()
    } catch {
      return false
    }
  })) return 'source-recoverable'
  return 'unavailable'
}

export function buildSessionSummaryFromManifest(session: LibrarySession): SessionSummary {
  const { meta } = session
  if (meta.canonicalProvider) {
    const descriptor = meta.canonicalProvider
    const canonicalPath = path.join(session.dirPath, descriptor.recordsFile)
    const canonicalPackage = readCanonicalPackageRecords(canonicalPath)
    const source = builtinProviderForId(descriptor.providerId)?.sourceId
    if (canonicalPackage && source &&
      canonicalPackage.providerId === descriptor.providerId &&
      canonicalPackage.sourceRef.stableId === descriptor.sourceRefStableId &&
      canonicalPackage.sessionRecordId === descriptor.sessionRecordId) {
      const summary = canonicalRecordsToSessionSummary(canonicalPackage.records, {
        filePath: canonicalPath,
        source,
        fileSizeBytes: fs.statSync(canonicalPath).size
      })
      return {
        ...summary,
        libraryDirPath: session.dirPath,
        libraryMdPath: fs.existsSync(session.mdPath) ? session.mdPath : undefined,
        cloudBackupState: 'ready',
        isManifestOnly: false,
        detailAvailability: 'ready'
      }
    }
  }
  const logicalSource = meta.logicalIdentity?.sourceFamily
  const persistedSource = logicalSource && isLegacySessionSource(logicalSource)
    ? logicalSource
    : undefined
  const source = detectSourceFromSourcePaths(sourceFilePathsFromMeta(meta) || [], persistedSource)
  const backupState = backupStateForDir(session.dirPath)
  let fileSizeBytes = meta.backupSize || 0
  if (backupState === 'ready') {
    try { fileSizeBytes = fs.statSync(session.jsonlPath).size } catch { /* keep manifest size */ }
  }
  const id = source === 'claude-code' ? meta.sessionId : `${source}:${meta.sessionId}`
  const firstUserMessage = meta.customTitle || `云端会话 ${meta.sessionId.slice(0, 12)}`
  return {
    id,
    sessionId: meta.sessionId,
    resumeSessionId: meta.sessionId,
    slug: '',
    createdAt: meta.createdAt || meta.updatedAt || '',
    updatedAt: meta.updatedAt || meta.createdAt || '',
    messageCount: 0,
    turnCount: meta.turnCount || 0,
    compactCount: 0,
    cwds: meta.resumeCwd ? [meta.resumeCwd] : [],
    version: '',
    firstUserMessage,
    toolUsage: {},
    skillInvocations: [],
    projectPath: meta.projectPath,
    filePath: session.jsonlPath,
    fileSizeBytes,
    allFilePaths: [session.jsonlPath],
    resumeCwd: meta.resumeCwd,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    libraryDirPath: session.dirPath,
    libraryMdPath: fs.existsSync(session.mdPath) ? session.mdPath : undefined,
    source,
    models: [],
    isManifestOnly: true,
    detailAvailability: resolveLibraryDetailAvailability(session),
    cloudBackupState: backupState
  }
}

// --- Transcript Generation (main process) ---
// Format optimized for AI consumption: minimal tokens, max information.

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return stripTerminalControlSequences(content)
  return stripTerminalControlSequences(content
    .filter((p) => p.type === 'text' && p.text)
    .map((p) => p.text!)
    .join('\n'))
}

function extractToolCalls(content: string | ContentPart[] | undefined): string[] {
  if (!content || typeof content === 'string') return []
  const calls: string[] = []
  for (const part of content) {
    if (part.type !== 'tool_use' || !part.name) continue
    const input = stripTerminalControlSequencesDeep(part.input || {})
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

function buildResumeCommand(source: SessionSource, sessionId: string): string | undefined {
  if (source === 'codex') return `codex resume ${sessionId}`
  if (source === 'cursor') return `cursor-agent --resume=${sessionId}`
  if (source === 'opencode') return `opencode --session ${sessionId}`
  if (source === 'zcode') return `zcode --resume ${sessionId}`
  if (source === 'qoder') {
    if (sessionId.includes(':subagent:')) return undefined
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(sessionId)) return undefined
    return `qodercli -r ${shellQuote(sessionId)}`
  }
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
  lines.push(`# ${stripTerminalControlSequences(title)}\n`)
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
      const source = meta.frontmatter?.harness || 'claude-code'
      const originHeader = formatTranscriptOriginHeader(detectTranscriptOrigin(msg, source))
      lines.push(`**User** [${ts}]`)
      if (originHeader) lines.push(originHeader)
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

interface IncompleteSessionPublishMarker {
  schemaVersion: 1
  packageId: string
  logicalKeyHash: string
  owner: SessionCreateLockOwner
  createdAt: string
}

interface PackageIdReservation {
  packageId: string
  logicalKeyHash: string
  state: 'pending' | 'committed'
  owner?: SessionCreateLockOwner
}

interface PublishDirectoryClaim {
  schemaVersion: 1
  packageId: string
  logicalKeyHash: string
  relativeDirPath: string
  owner: SessionCreateLockOwner
  createdAt: string
}

interface PublishDirectoryFingerprint {
  schemaVersion: 1
  packageId: string
  ownerNonce: string
  dev: number
  ino: number
  birthtimeMs: number
}

export interface SessionCreateInstrumentation {
  packageIdFactory?: () => string
  onStage?: (stage: 'before-publish-reservation' | 'publish-directory-created' | 'publish-directory-durable' |
    'incomplete-durable' | 'manifest-durable') => void | Promise<void>
}

function logicalKeyHash(key: LogicalSessionKey): string {
  return createHash('sha256').update(key).digest('hex')
}

function logicalSeenEvidencePath(keyHash: string): string {
  return path.join(_root, '.swob', 'logical-sessions', `${keyHash}.seen.json`)
}

function readLogicalSeenEvidence(keyHash: string): boolean | null {
  const evidencePath = logicalSeenEvidencePath(keyHash)
  try {
    assertSafeLibraryFileTarget(_root, evidencePath)
    const value = JSON.parse(fs.readFileSync(evidencePath, 'utf-8')) as Record<string, unknown>
    return value.schemaVersion === 1 && value.logicalKeyHash === keyHash
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : false
  }
}

function persistObservedLogicalSessionKeys(candidates: readonly LibrarySessionCandidate[]): void {
  if (_readOnly || candidates.length === 0) return
  const evidenceDir = ensureSafeLibraryDirectory(_root, path.join(_root, '.swob', 'logical-sessions'))
  for (const keyHash of new Set(candidates.map((candidate) => logicalKeyHash(candidate.logicalKey)))) {
    const evidencePath = logicalSeenEvidencePath(keyHash)
    const existing = readLogicalSeenEvidence(keyHash)
    if (existing === true) continue
    if (existing === false) throw new Error('logical-seen-evidence-corrupt')
    const content = JSON.stringify({
      schemaVersion: 1,
      logicalKeyHash: keyHash,
      firstObservedAt: new Date().toISOString()
    })
    const tempPath = `${evidencePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      // Publish a fully written inode with an atomic no-replace hard link.
      // Readers can observe either ENOENT or complete JSON, never a partial
      // final evidence file while concurrent scans start.
      writeSafeLibraryFileSync(_root, tempPath, content, { exclusive: true })
      assertSafeLibraryFileTarget(_root, evidencePath)
      fs.linkSync(tempPath, evidencePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || readLogicalSeenEvidence(keyHash) !== true) throw error
    } finally {
      try {
        const stat = fs.lstatSync(tempPath)
        if (stat.isFile()) fs.unlinkSync(tempPath)
      } catch { /* already removed or uncertain */ }
    }
  }
  fsyncDirectorySync(evidenceDir)
}

function packageReservationPath(packageId: string): string {
  return path.join(
    _root,
    '.swob',
    'package-ids',
    `${createHash('sha256').update(packageId).digest('hex')}.json`
  )
}

function packageReservationCommitPath(packageId: string): string {
  return packageReservationPath(packageId).replace(/\.json$/, '.committed.json')
}

function publishClaimPaths(targetDir: string): { claimPath: string; fingerprintPath: string } {
  const relative = path.relative(_root, targetDir).split(path.sep).join('/')
  const digest = createHash('sha256').update(relative).digest('hex')
  const claimDir = path.join(_root, '.swob', 'publish-paths')
  return {
    claimPath: path.join(claimDir, `${digest}.claim.json`),
    fingerprintPath: path.join(claimDir, `${digest}.created.json`)
  }
}

function isValidSessionCreateLockOwner(value: unknown): value is SessionCreateLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const owner = value as Partial<SessionCreateLockOwner>
  return owner.schemaVersion === 1 && typeof owner.ownerNonce === 'string' &&
    typeof owner.deviceId === 'string' && typeof owner.pid === 'number' &&
    typeof owner.bootIdentity === 'string' && typeof owner.processStartFingerprint === 'string' &&
    typeof owner.acquiredAt === 'string' && typeof owner.leaseExpiresAt === 'string'
}

function readPublishDirectoryClaim(filePath: string): PublishDirectoryClaim | null {
  try {
    assertSafeLibraryFileTarget(_root, filePath)
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<PublishDirectoryClaim>
    if (value.schemaVersion !== 1 || typeof value.packageId !== 'string' ||
      typeof value.logicalKeyHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.logicalKeyHash) ||
      typeof value.relativeDirPath !== 'string' || path.isAbsolute(value.relativeDirPath) ||
      !isValidSessionCreateLockOwner(value.owner) || typeof value.createdAt !== 'string') return null
    const target = path.resolve(_root, value.relativeDirPath)
    assertSafeLibraryWritePath(_root, target, { allowRoot: false })
    return value as PublishDirectoryClaim
  } catch {
    return null
  }
}

function readPublishDirectoryFingerprint(filePath: string): PublishDirectoryFingerprint | null {
  try {
    assertSafeLibraryFileTarget(_root, filePath)
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<PublishDirectoryFingerprint>
    if (value.schemaVersion !== 1 || typeof value.packageId !== 'string' ||
      typeof value.ownerNonce !== 'string' ||
      ![value.dev, value.ino, value.birthtimeMs].every((field) => typeof field === 'number' && Number.isFinite(field))) {
      return null
    }
    return value as PublishDirectoryFingerprint
  } catch {
    return null
  }
}

function removeOwnedPublishDirectoryClaim(claimPath: string, expected: PublishDirectoryClaim): void {
  const current = readPublishDirectoryClaim(claimPath)
  if (!current || current.packageId !== expected.packageId ||
    current.owner.ownerNonce !== expected.owner.ownerNonce ||
    current.relativeDirPath !== expected.relativeDirPath) return
  const fingerprintPath = claimPath.replace(/\.claim\.json$/, '.created.json')
  const fingerprintExists = fs.existsSync(fingerprintPath)
  const fingerprint = readPublishDirectoryFingerprint(fingerprintPath)
  if (fingerprintExists && (fingerprint?.packageId !== expected.packageId ||
    fingerprint.ownerNonce !== expected.owner.ownerNonce)) return
  if (fingerprint) fs.unlinkSync(fingerprintPath)
  fs.unlinkSync(claimPath)
  fsyncDirectorySync(path.dirname(claimPath))
}

function readPackageReservation(filePath: string): PackageIdReservation | null {
  try {
    assertSafeLibraryFileTarget(_root, filePath)
    const value = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>
    if (value.schemaVersion !== 1 || typeof value.packageId !== 'string' ||
      typeof value.logicalKeyHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.logicalKeyHash)) return null
    const state = value.state === undefined ? 'committed' : value.state
    if (state !== 'pending' && state !== 'committed') return null
    if (state === 'pending' && !isValidSessionCreateLockOwner(value.owner)) return null
    return {
      packageId: value.packageId,
      logicalKeyHash: value.logicalKeyHash,
      state,
      owner: isValidSessionCreateLockOwner(value.owner) ? value.owner : undefined
    }
  } catch {
    return null
  }
}

function packageReservationIsCommitted(reservation: PackageIdReservation): boolean {
  if (reservation.state === 'committed') return true
  const commitPath = packageReservationCommitPath(reservation.packageId)
  try {
    assertSafeLibraryFileTarget(_root, commitPath)
    const value = JSON.parse(fs.readFileSync(commitPath, 'utf-8')) as Record<string, unknown>
    if (value.schemaVersion === 1 && value.packageId === reservation.packageId &&
      value.logicalKeyHash === reservation.logicalKeyHash) return true
    throw new SessionIdentityUnresolvedError(['corrupt-manifest'])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    if (error instanceof SessionIdentityUnresolvedError) throw error
    throw new SessionIdentityUnresolvedError(['corrupt-manifest'])
  }
}

function markPackageReservationCommitted(packageId: string, expectedLogicalKeyHash: string): void {
  const reservationPath = packageReservationPath(packageId)
  const reservation = readPackageReservation(reservationPath)
  if (!reservation || reservation.packageId !== packageId ||
    reservation.logicalKeyHash !== expectedLogicalKeyHash) throw new SessionPackageIdCollisionError()
  if (packageReservationIsCommitted(reservation)) return
  const commitPath = packageReservationCommitPath(packageId)
  try {
    writeSafeLibraryFileSync(_root, commitPath, JSON.stringify({
      schemaVersion: 1,
      packageId,
      logicalKeyHash: expectedLogicalKeyHash,
      committedAt: new Date().toISOString()
    }), { exclusive: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !packageReservationIsCommitted(reservation)) {
      throw error
    }
  }
  fsyncDirectorySync(path.dirname(commitPath))
}

function removeOwnedPackageReservation(packageId: string, expectedLogicalKeyHash: string): void {
  const reservationPath = packageReservationPath(packageId)
  const reservation = readPackageReservation(reservationPath)
  if (!reservation || reservation.packageId !== packageId ||
    reservation.logicalKeyHash !== expectedLogicalKeyHash || packageReservationIsCommitted(reservation)) return
  fs.unlinkSync(reservationPath)
  fsyncDirectorySync(path.dirname(reservationPath))
}

function parseIncompletePublishMarker(content: string): IncompleteSessionPublishMarker | null {
  try {
    const value = JSON.parse(content) as Partial<IncompleteSessionPublishMarker>
    if (value.schemaVersion !== 1 || typeof value.packageId !== 'string' ||
      typeof value.logicalKeyHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.logicalKeyHash) ||
      !value.owner || typeof value.owner !== 'object' || typeof value.createdAt !== 'string') return null
    if (!isValidSessionCreateLockOwner(value.owner)) return null
    return value as IncompleteSessionPublishMarker
  } catch {
    return null
  }
}

function incompleteOwnerIsProvablyDead(owner: SessionCreateLockOwner, localDeviceId: string): boolean {
  if (owner.deviceId !== localDeviceId) return false
  const bootIdentity = getLocalBootIdentity()
  if (!bootIdentity) return false
  if (owner.bootIdentity !== bootIdentity) return true
  const currentStart = getProcessStartFingerprint(owner.pid)
  return currentStart === 'missing' || (typeof currentStart === 'string' && currentStart !== owner.processStartFingerprint)
}

function recoverPublishDirectoryClaims(localDeviceId: string): LibraryIdentityScanIssue[] {
  const issues: LibraryIdentityScanIssue[] = []
  const claimDir = path.join(_root, '.swob', 'publish-paths')
  let names: string[]
  try {
    assertSafeLibraryWritePath(_root, claimDir, { allowRoot: false })
    names = fs.readdirSync(claimDir).filter((name) => name.endsWith('.claim.json'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return issues
    return [{ kind: 'unreadable-directory', dirPath: claimDir, code: (error as NodeJS.ErrnoException).code }]
  }

  for (const name of names) {
    const claimPath = path.join(claimDir, name)
    const fingerprintPath = claimPath.replace(/\.claim\.json$/, '.created.json')
    const claim = readPublishDirectoryClaim(claimPath)
    if (!claim) {
      issues.push({ kind: 'incomplete-publish', dirPath: claimPath })
      continue
    }
    const targetDir = path.resolve(_root, claim.relativeDirPath)
    const blocker = (): void => {
      issues.push({ kind: 'incomplete-publish', dirPath: targetDir, logicalKeyHash: claim.logicalKeyHash })
    }
    if (!incompleteOwnerIsProvablyDead(claim.owner, localDeviceId)) {
      blocker()
      continue
    }

    if (!fs.existsSync(targetDir)) {
      removeOwnedPublishDirectoryClaim(claimPath, claim)
      removeOwnedPackageReservation(claim.packageId, claim.logicalKeyHash)
      continue
    }

    let stat: fs.Stats
    let entries: string[]
    try {
      assertSafeLibraryWritePath(_root, targetDir, { allowRoot: false })
      stat = fs.lstatSync(targetDir)
      entries = fs.readdirSync(targetDir)
    } catch {
      blocker()
      continue
    }
    const fingerprintFileExists = fs.existsSync(fingerprintPath)
    const fingerprint = readPublishDirectoryFingerprint(fingerprintPath)
    const matches = fingerprint?.packageId === claim.packageId &&
      fingerprint.ownerNonce === claim.owner.ownerNonce && fingerprint.dev === stat.dev &&
      fingerprint.ino === stat.ino && fingerprint.birthtimeMs === stat.birthtimeMs
    // Threat boundary: every Swob writer must first win the exclusive path
    // claim. If the owner died in the single mkdir->fingerprint window, that
    // exclusive claim plus an unchanged empty regular directory is sufficient
    // to recover. Once a fingerprint file exists it must match exactly;
    // malformed, non-empty, linked, or replaced evidence always blocks.
    const ownershipProven = fingerprintFileExists ? matches : true
    if (!stat.isSymbolicLink() && stat.isDirectory() && entries.length === 0 && ownershipProven) {
      try {
        // Revalidate immediately before rmdir; rmdir itself refuses any
        // directory that gained content after this check.
        const current = fs.lstatSync(targetDir)
        if (current.dev !== stat.dev || current.ino !== stat.ino || current.birthtimeMs !== stat.birthtimeMs) {
          blocker()
          continue
        }
        fs.rmdirSync(targetDir)
        fsyncDirectorySync(path.dirname(targetDir))
        removeOwnedPublishDirectoryClaim(claimPath, claim)
        removeOwnedPackageReservation(claim.packageId, claim.logicalKeyHash)
        continue
      } catch {
        blocker()
        continue
      }
    }
    blocker()
  }
  return issues
}

/** Recover only marker-owned, otherwise-empty reservations or finalize committed packages. */
function recoverIncompleteSessionPublishes(localDeviceId: string): LibraryIdentityScanIssue[] {
  const issues: LibraryIdentityScanIssue[] = []
  canonicalLibraryRootForWrite(_root)

  const walk = (dirPath: string): void => {
    assertSafeLibraryWritePath(_root, dirPath)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch (error) {
      issues.push({ kind: 'unreadable-directory', dirPath, code: (error as NodeJS.ErrnoException).code })
      return
    }

    const markerPath = path.join(dirPath, '.swob-incomplete.json')
    const markerEntry = entries.find((entry) => entry.name === '.swob-incomplete.json' && entry.isFile())
    if (markerEntry) {
      let marker: IncompleteSessionPublishMarker | null = null
      try { marker = parseIncompletePublishMarker(fs.readFileSync(markerPath, 'utf-8')) } catch { /* blocker below */ }
      const manifestPath = path.join(dirPath, SESSION_META_FILE)
      if (marker && fs.existsSync(manifestPath)) {
        const meta = readSessionMeta(dirPath)
        if (meta?.schemaVersion === 3 && meta.packageId === marker.packageId) {
          markPackageReservationCommitted(marker.packageId, marker.logicalKeyHash)
          fs.unlinkSync(markerPath)
          fsyncDirectorySync(dirPath)
          fsyncDirectorySync(path.dirname(dirPath))
          return
        }
      }
      if (marker && !fs.existsSync(manifestPath) && entries.length === 1 &&
        incompleteOwnerIsProvablyDead(marker.owner, localDeviceId)) {
        fs.unlinkSync(markerPath)
        fs.rmdirSync(dirPath)
        fsyncDirectorySync(path.dirname(dirPath))
        removeOwnedPackageReservation(marker.packageId, marker.logicalKeyHash)
        return
      }
      issues.push({ kind: 'incomplete-publish', dirPath })
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.swob') continue
      if (entry.name.startsWith('.swob-create-')) {
        issues.push({ kind: 'incomplete-publish', dirPath: path.join(dirPath, entry.name) })
        continue
      }
      const child = path.join(dirPath, entry.name)
      let stat: fs.Stats
      try { stat = fs.lstatSync(child) } catch {
        issues.push({ kind: 'unreadable-link', dirPath: child })
        continue
      }
      if (stat.isSymbolicLink()) continue
      walk(child)
    }
  }
  walk(_root)
  issues.push(...recoverPublishDirectoryClaims(localDeviceId))
  return issues
}

function reservePackageIdRecord(
  packageId: string,
  key: LogicalSessionKey,
  owner?: SessionCreateLockOwner
): string {
  const reservationDir = ensureSafeLibraryDirectory(_root, path.join(_root, '.swob', 'package-ids'))
  const reservationPath = packageReservationPath(packageId)
  writeSafeLibraryFileSync(_root, reservationPath, JSON.stringify({
    schemaVersion: 1,
    packageId,
    logicalKeyHash: logicalKeyHash(key),
    state: owner ? 'pending' : 'committed',
    ...(owner ? { owner } : {}),
    reservedAt: new Date().toISOString()
  }), { exclusive: true })
  fsyncDirectorySync(reservationDir)
  return reservationPath
}

function ensureExistingPackageIdReservation(packageId: string | undefined, key: LogicalSessionKey): void {
  if (!packageId) return
  const reservationPath = packageReservationPath(packageId)
  const existing = readPackageReservation(reservationPath)
  if (existing) {
    if (existing.packageId !== packageId || existing.logicalKeyHash !== logicalKeyHash(key)) {
      throw new SessionPackageIdCollisionError()
    }
    markPackageReservationCommitted(packageId, logicalKeyHash(key))
    return
  }
  try {
    reservePackageIdRecord(packageId, key)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const raced = readPackageReservation(reservationPath)
    if (!raced || raced.packageId !== packageId || raced.logicalKeyHash !== logicalKeyHash(key)) {
      throw new SessionPackageIdCollisionError()
    }
  }
}

function throwIfDurableIdentityWasPreviouslySeen(key: LogicalSessionKey, localDeviceId: string): void {
  const reservationDir = path.join(_root, '.swob', 'package-ids')
  let names: string[]
  try { names = fs.readdirSync(reservationDir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') names = []
    else throw new SessionIdentityUnresolvedError(['unreadable-directory'])
  }
  const wanted = logicalKeyHash(key)
  for (const name of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(name)) continue
    const reservation = readPackageReservation(path.join(reservationDir, name))
    if (!reservation) throw new SessionIdentityUnresolvedError(['corrupt-manifest'])
    if (reservation.logicalKeyHash !== wanted) continue
    if (!packageReservationIsCommitted(reservation) && reservation.owner &&
      incompleteOwnerIsProvablyDead(reservation.owner, localDeviceId)) {
      removeOwnedPackageReservation(reservation.packageId, wanted)
      continue
    }
    throw new SessionIdentityMissingError(key, [])
  }
  const seen = readLogicalSeenEvidence(wanted)
  if (seen === false) throw new SessionIdentityUnresolvedError(['identity-evidence-unavailable'])
  if (seen === true) throw new SessionIdentityMissingError(key, [])
}

function reserveUniquePackageId(
  key: LogicalSessionKey,
  owner: SessionCreateLockOwner,
  packageIdFactory: () => string = randomUUID
): { packageId: string; reservationPath: string } {
  for (let attempt = 0; attempt < 32; attempt++) {
    const packageId = packageIdFactory()
    if (!packageId || sessionRegistry.hasPackageId(packageId)) continue
    try {
      return { packageId, reservationPath: reservePackageIdRecord(packageId, key, owner) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new SessionPackageIdCollisionError()
}

function preserveSchemaV3OrUpgradeToV2(meta: SessionMeta): void {
  if (meta.schemaVersion !== 3) meta.schemaVersion = 2
}

function assertCreationIdentityIsUnambiguous(
  identity: LogicalSessionIdentity,
  key: LogicalSessionKey
): void {
  const resolution = sessionRegistry.resolveSessionId(identity.sessionId)
  if (resolution.state === 'missing') return
  if (resolution.state === 'conflict' && resolution.logicalKey === key) {
    throw new SessionIdentityConflictError(key, resolution.candidates)
  }
  const candidates = resolution.state === 'bound' ? [resolution.candidate] : resolution.candidates
  const includesLegacy = candidates.some((candidate) => candidate.identity.sourceFamily === 'legacy-ambiguous')
  if (identity.sourceFamily === 'legacy-ambiguous' || includesLegacy) {
    throw new SessionIdentityAmbiguousError(identity.sessionId, candidates)
  }
  // Different verified provider/semantic instances are distinct logical sessions.
}

function updateExistingLibrarySession(
  dirPath: string,
  session: SessionSummary,
  requestedKey: LogicalSessionKey,
  customTitle?: string,
  originOverride?: Partial<SessionOrigin>
): string {
  const meta = readSessionMeta(dirPath)
  if (!meta || meta.sessionId !== session.sessionId ||
    logicalSessionKey(buildLogicalSessionIdentityFromMeta(meta)) !== requestedKey) {
    throw new Error('session-binding-mismatch')
  }

  let changed = false
  if (customTitle && meta.customTitle !== customTitle) {
    meta.customTitle = customTitle
    changed = true
  }
  if (meta.updatedAt !== session.updatedAt) {
    meta.updatedAt = session.updatedAt
    const nextSourceFilePaths = sourceFilePathsForMeta(session)
    if (nextSourceFilePaths.length > 0) {
      const proposed = { ...meta, sourceFilePaths: nextSourceFilePaths }
      if (logicalSessionKey(buildLogicalSessionIdentityFromMeta(proposed)) === requestedKey) {
        meta.sourceFilePaths = nextSourceFilePaths
      }
    }
    changed = true
  }
  const currentSourceFilePaths = sourceFilePathsForMeta(session)
  if (!meta.origin && currentSourceFilePaths.some((sourcePath) => fs.existsSync(sourceStatPath(sourcePath)))) {
    meta.origin = captureLocalSessionOrigin(originOverride)
    preserveSchemaV3OrUpgradeToV2(meta)
    changed = true
  }
  if (!meta.sourceInstance && currentSourceFilePaths.length > 0) {
    meta.sourceInstance = detectSessionSourceInstance(currentSourceFilePaths)
    preserveSchemaV3OrUpgradeToV2(meta)
    changed = true
  }
  if (!meta.resumeCwd && session.resumeCwd &&
    currentSourceFilePaths.some((sourcePath) => fs.existsSync(sourceStatPath(sourcePath)))) {
    meta.resumeCwd = session.resumeCwd
    preserveSchemaV3OrUpgradeToV2(meta)
    changed = true
  }
  if (changed) writeSessionMeta(dirPath, meta)
  return dirPath
}

function throwIfIdentityScanUnresolved(issues: LibraryIdentityScanIssue[]): void {
  if (issues.length > 0) throw new SessionIdentityUnresolvedError([...new Set(issues.map((issue) => issue.kind))])
}

function unresolvedIssuesForEnsure(
  issues: LibraryIdentityScanIssue[],
  key: LogicalSessionKey
): LibraryIdentityScanIssue[] {
  const wanted = logicalKeyHash(key)
  return issues.filter((issue) => {
    if (issue.kind !== 'incomplete-publish') return true
    if (issue.logicalKeyHash) return issue.logicalKeyHash !== wanted
    try {
      const marker = parseIncompletePublishMarker(fs.readFileSync(
        path.join(issue.dirPath, '.swob-incomplete.json'),
        'utf-8'
      ))
      return marker?.logicalKeyHash !== wanted
    } catch {
      return true
    }
  })
}

function resolveExactBindingForEnsure(
  key: LogicalSessionKey,
  session: SessionSummary,
  customTitle?: string,
  originOverride?: Partial<SessionOrigin>,
  allowOwnedIncomplete = false
): string | null {
  throwIfIdentityScanUnresolved(
    allowOwnedIncomplete ? unresolvedIssuesForEnsure(lastIdentityScanIssues, key) : lastIdentityScanIssues
  )
  const binding = sessionRegistry.get(key)
  if (binding.state === 'conflict') throw new SessionIdentityConflictError(key, binding.candidates)
  if (binding.state === 'missing') {
    if (allowOwnedIncomplete && binding.reason === 'scan-incomplete') return null
    if (!binding.creationAllowed || binding.reason !== 'never-seen') {
      if (binding.reason === 'previously-seen') {
        throw new SessionIdentityMissingError(key, binding.lastKnownCandidates)
      }
      throw new SessionIdentityUnresolvedError(['unreadable-directory'])
    }
    return null
  }
  if (!fs.existsSync(binding.candidate.dirPath)) return null
  ensureExistingPackageIdReservation(binding.candidate.packageId, key)
  return updateExistingLibrarySession(
    binding.candidate.dirPath,
    session,
    key,
    customTitle,
    originOverride
  )
}

async function reserveSessionPublishDir(
  parentDir: string,
  baseName: string,
  packageId: string,
  key: LogicalSessionKey,
  owner: SessionCreateLockOwner,
  instrumentation: SessionCreateInstrumentation
): Promise<{ dirPath: string; claimPath: string; claim: PublishDirectoryClaim }> {
  const claimDir = ensureSafeLibraryDirectory(_root, path.join(_root, '.swob', 'publish-paths'))
  for (let counter = 1; counter <= 10_000; counter++) {
    const dirName = counter === 1 ? baseName : `${baseName} (${counter})`
    const finalDir = path.join(parentDir, dirName)
    assertSafeLibraryWritePath(_root, finalDir, { allowRoot: false })
    const { claimPath, fingerprintPath } = publishClaimPaths(finalDir)
    const claim: PublishDirectoryClaim = {
      schemaVersion: 1,
      packageId,
      logicalKeyHash: logicalKeyHash(key),
      relativeDirPath: path.relative(_root, finalDir),
      owner,
      createdAt: new Date().toISOString()
    }
    try {
      writeSafeLibraryFileSync(_root, claimPath, JSON.stringify(claim), { exclusive: true })
      fsyncDirectorySync(claimDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      // mkdir is the atomic no-replace reservation on every supported platform.
      fs.mkdirSync(finalDir, { recursive: false, mode: 0o700 })
    } catch (error) {
      try { removeOwnedPublishDirectoryClaim(claimPath, claim) } catch { /* preserve uncertain evidence */ }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
    try {
      const stat = fs.lstatSync(finalDir)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new LibraryPathUnsafeError(finalDir, 'publish-target-not-directory')
      fsyncDirectorySync(parentDir)
      await instrumentation.onStage?.('publish-directory-created')
      writeSafeLibraryFileSync(_root, fingerprintPath, JSON.stringify({
        schemaVersion: 1,
        packageId,
        ownerNonce: owner.ownerNonce,
        dev: stat.dev,
        ino: stat.ino,
        birthtimeMs: stat.birthtimeMs
      } satisfies PublishDirectoryFingerprint), { exclusive: true })
      fsyncDirectorySync(claimDir)
      await instrumentation.onStage?.('publish-directory-durable')
      return { dirPath: finalDir, claimPath, claim }
    } catch (error) {
      try {
        const stat = fs.lstatSync(finalDir)
        const fingerprint = readPublishDirectoryFingerprint(fingerprintPath)
        if (fingerprint?.packageId === packageId && fingerprint.ownerNonce === owner.ownerNonce &&
          fingerprint.dev === stat.dev && fingerprint.ino === stat.ino &&
          fingerprint.birthtimeMs === stat.birthtimeMs && fs.readdirSync(finalDir).length === 0) {
          fs.rmdirSync(finalDir)
          fsyncDirectorySync(parentDir)
          removeOwnedPublishDirectoryClaim(claimPath, claim)
        }
      } catch { /* preserve uncertain evidence */ }
      throw error
    }
  }
  throw new Error('session-directory-name-exhausted')
}

export async function ensureSessionInLibrary(
  session: SessionSummary,
  customTitle?: string,
  originOverride?: Partial<SessionOrigin>,
  instrumentation: SessionCreateInstrumentation = {}
): Promise<string> {
  const canonical = getLoadedCanonicalSession(session.id)
  if (canonical) {
    const providerId = canonical.sessionRecord.provenance.providerId
    const definition = builtinProviderForId(providerId)
    if (!definition || definition.sourceId !== session.source) {
      throw new Error('canonical-package-summary-provider-mismatch')
    }
    return (await ensureCanonicalPackage(
      providerId,
      canonical.sessionRecord.sourceRef,
      canonical.records
    )).dirPath
  }
  // Pi has no legacy backup path after the runtime bridge. Falling through
  // here would copy its raw JSONL and create a second logical package.
  if (session.source && builtinProviderForSource(session.source)?.ingestion === 'provider-host') {
    throw new Error('canonical-provider-session-not-found')
  }
  return withLibraryWriter('package-create', () =>
    ensureSessionInLibraryUnderWriter(session, customTitle, originOverride, instrumentation))
}

async function ensureSessionInLibraryUnderWriter(
  session: SessionSummary,
  customTitle?: string,
  originOverride?: Partial<SessionOrigin>,
  instrumentation: SessionCreateInstrumentation = {},
  canonicalOptions?: {
    identity: LogicalSessionIdentity
    descriptor: CanonicalPackageDescriptor
    beforeManifest?: (dirPath: string, meta: SessionMeta) => void | Promise<void>
  }
): Promise<string> {
  const identity = canonicalOptions?.identity || buildLogicalSessionIdentityFromSummary(session)
  const key = logicalSessionKey(identity)
  const localDeviceId = getOrCreateLocalDeviceId()

  // Recover only cryptographically/owner-bound incomplete evidence before the
  // authoritative scan. Existing complete bindings can never be erased by 0.
  const recoveryIssues = recoverIncompleteSessionPublishes(localDeviceId)
  throwIfIdentityScanUnresolved(unresolvedIssuesForEnsure(recoveryIssues, key))
  const initialIssues = refreshSessionRegistryFromDisk()
  throwIfIdentityScanUnresolved(unresolvedIssuesForEnsure(initialIssues, key))
  const current = resolveExactBindingForEnsure(key, session, customTitle, originOverride, true)
  if (current) return current
  assertCreationIdentityIsUnambiguous(identity, key)

  const title = customTitle || session.firstUserMessage?.slice(0, 60) || session.sessionId.slice(0, 12)
  const baseName = `${SESSION_DIR_PREFIX}${sanitizeDirName(title)}`
  const ungrouping = loadLibraryConfig().preferences?.ungrouping
  const containerName = ungrouping
    ? (session.turnCount <= 1 ? ungrouping.singleTurn : ungrouping.multiTurn)
    : null
  const parentDir = containerName ? path.join(_root, containerName) : _root
  ensureSafeLibraryDirectory(_root, parentDir)
  const lock = await acquireSessionCreateLock(_root, key, localDeviceId)
  try {
    const lockedRecoveryIssues = recoverIncompleteSessionPublishes(localDeviceId)
    throwIfIdentityScanUnresolved(lockedRecoveryIssues)
    const lockedIssues = refreshSessionRegistryFromDisk()
    throwIfIdentityScanUnresolved(lockedIssues)
    const concurrentlyCreated = resolveExactBindingForEnsure(key, session, customTitle, originOverride)
    if (concurrentlyCreated) return concurrentlyCreated
    assertCreationIdentityIsUnambiguous(identity, key)
    throwIfDurableIdentityWasPreviouslySeen(key, localDeviceId)

    const { packageId } = reserveUniquePackageId(key, lock.owner, instrumentation.packageIdFactory)
    let dirPath: string | null = null
    let publishClaim: { claimPath: string; claim: PublishDirectoryClaim } | null = null
    try {
      await instrumentation.onStage?.('before-publish-reservation')
      const reservation = await reserveSessionPublishDir(
        parentDir,
        baseName,
        packageId,
        key,
        lock.owner,
        instrumentation
      )
      dirPath = reservation.dirPath
      publishClaim = { claimPath: reservation.claimPath, claim: reservation.claim }
      const markerPath = path.join(dirPath, '.swob-incomplete.json')
      const marker: IncompleteSessionPublishMarker = {
        schemaVersion: 1,
        packageId,
        logicalKeyHash: logicalKeyHash(key),
        owner: lock.owner,
        createdAt: new Date().toISOString()
      }
      writeSafeLibraryFileSync(_root, markerPath, JSON.stringify(marker), { exclusive: true })
      fsyncDirectorySync(dirPath)
      removeOwnedPublishDirectoryClaim(publishClaim.claimPath, publishClaim.claim)
      publishClaim = null
      await instrumentation.onStage?.('incomplete-durable')
      const sourceFilePaths = sourceFilePathsForMeta(session)
      const meta: SessionMeta = {
        schemaVersion: 3,
        packageId,
        logicalIdentity: identity,
        sessionId: session.sessionId,
        sourceFilePaths,
        customTitle,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        projectPath: session.projectPath,
        resumeCwd: session.resumeCwd,
        turnCount: session.turnCount,
        origin: captureLocalSessionOrigin(originOverride),
        sourceInstance: detectSessionSourceInstance(sourceFilePaths),
        ...(canonicalOptions ? { canonicalProvider: canonicalOptions.descriptor } : {})
      }
      await canonicalOptions?.beforeManifest?.(dirPath, meta)
      // Manifest is the commit marker and is created exclusively only after
      // every incomplete marker and directory entry is durable.
      writeSessionMetaFile(dirPath, meta, true)
      fsyncDirectorySync(dirPath)
      markPackageReservationCommitted(packageId, logicalKeyHash(key))
      await instrumentation.onStage?.('manifest-durable')
      try {
        fs.unlinkSync(markerPath)
      } catch (error) {
        // A concurrent recovery may already have finalized this committed
        // package. Missing is success; every other unlink failure is unsafe.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      fsyncDirectorySync(dirPath)
      fsyncDirectorySync(parentDir)
      refreshSessionRegistryFromDisk()
      const binding = sessionRegistry.get(key)
      if (binding.state === 'conflict') throw new SessionIdentityConflictError(key, binding.candidates)
      if (binding.state !== 'bound' || path.resolve(binding.candidate.dirPath) !== path.resolve(dirPath)) {
        throw new Error('session-create-binding-verification-failed')
      }
      return dirPath
    } catch (error) {
      // Synchronous failures are cleaned only when this transaction still owns
      // the exact incomplete marker and no committed manifest exists. SIGKILL
      // intentionally leaves durable evidence for the next process to recover.
      try {
        if (!dirPath) {
          removeOwnedPackageReservation(packageId, logicalKeyHash(key))
        } else {
          const markerPath = path.join(dirPath, '.swob-incomplete.json')
          const currentMarker = parseIncompletePublishMarker(fs.readFileSync(markerPath, 'utf-8'))
          if (currentMarker?.owner.ownerNonce === lock.owner.ownerNonce &&
            !fs.existsSync(path.join(dirPath, SESSION_META_FILE)) && fs.readdirSync(dirPath).length === 1) {
            fs.unlinkSync(markerPath)
            fs.rmdirSync(dirPath)
            fsyncDirectorySync(parentDir)
            removeOwnedPackageReservation(packageId, logicalKeyHash(key))
          }
          if (publishClaim) removeOwnedPublishDirectoryClaim(publishClaim.claimPath, publishClaim.claim)
        }
      } catch { /* preserve uncertain evidence */ }
      throw error
    }
  } finally {
    lock.release()
  }
}

export interface EnsureCanonicalPackageResult {
  dirPath: string
  recordsPath: string
  provenancePath: string
  contentChanged: boolean
}

function writeCanonicalFileIfChanged(filePath: string, content: string): boolean {
  assertSafeLibraryFileTarget(_root, filePath)
  try {
    if (fs.readFileSync(filePath, 'utf8') === content) return false
  } catch { /* write the missing or unreadable projection */ }
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeSafeLibraryFileSync(_root, tempPath, content, { exclusive: true })
    fs.renameSync(tempPath, filePath)
    fs.chmodSync(filePath, 0o600)
    fsyncDirectorySync(path.dirname(filePath))
    return true
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* preserve final result */ }
  }
}

function canonicalTranscript(records: CanonicalRecord[], filePath: string, source: SessionSource): string {
  const detail = canonicalRecordsToSessionDetail(records, { filePath, source })
  const lines = [`# ${detail.firstUserMessage || detail.sessionId}`, '']
  for (const message of detail.messages) {
    const label = message.type === 'assistant' ? 'Assistant' : message.type === 'user' ? 'User' : 'System'
    lines.push(`**${label}**${message.timestamp ? ` [${formatTs(message.timestamp)}]` : ''}`)
    for (const call of message.toolCalls) {
      lines.push(`[${call.name}] ${JSON.stringify(call.input)}`)
      if (call.result) lines.push(call.result)
    }
    if (message.textContent) lines.push(demoteMarkdownHeadings(message.textContent))
    lines.push('')
  }
  return redactSecrets(lines.join('\n')).text
}

async function ensureCanonicalPackageUnderWriter(
  providerId: string,
  sourceRef: SourceRef,
  canonicalRecords: CanonicalRecord[]
): Promise<EnsureCanonicalPackageResult> {
  assertLibraryWriterHeld(_root)
  const sourceDefinition = builtinProviderForId(providerId)
  if (!sourceDefinition) throw new Error('canonical-package-provider-not-registered')
  const source = sourceDefinition.sourceId
  const summary = canonicalRecordsToSessionSummary(canonicalRecords, {
    filePath: sourceRef.displayLocator,
    source
  })
  const sessionRecord = canonicalRecords.find((record) => record.recordType === 'session')
  if (!sessionRecord || sessionRecord.recordType !== 'session' ||
    sourceRef.providerId !== providerId ||
    sessionRecord.sourceRef.providerId !== providerId ||
    sessionRecord.sourceRef.stableId !== sourceRef.stableId ||
    sessionRecord.provenance.providerId !== providerId) {
    throw new Error('canonical-package-session-identity-mismatch')
  }
  const identity = buildCanonicalLogicalSessionIdentity(
    providerId,
    sourceRef.stableId,
    sessionRecord.sourceSessionId
  )
  const descriptor: CanonicalPackageDescriptor = {
    schemaVersion: 1,
    providerId,
    sourceRefStableId: sourceRef.stableId,
    sessionRecordId: sessionRecord.id,
    fingerprint: sourceRef.fingerprint,
    parserDataVersion: sessionRecord.provenance.parserDataVersion,
    formatVersion: sessionRecord.provenance.formatVersion,
    recordsFile: CANONICAL_RECORDS_FILE,
    provenanceFile: CANONICAL_PROVENANCE_FILE
  }
  const recordsPackage: CanonicalPackageRecords = {
    schemaVersion: 1,
    providerId,
    parserDataVersion: descriptor.parserDataVersion,
    formatVersion: descriptor.formatVersion,
    fingerprint: descriptor.fingerprint,
    sourceRef,
    sessionRecordId: sessionRecord.id,
    records: canonicalRecords
  }
  const provenancePackage: CanonicalPackageProvenance = {
    schemaVersion: 1,
    providerId,
    parserDataVersion: descriptor.parserDataVersion,
    formatVersion: descriptor.formatVersion,
    fingerprint: descriptor.fingerprint,
    sourceRef,
    sessionRecordId: sessionRecord.id,
    archivedAt: sessionRecord.provenance.observedAt || summary.updatedAt || summary.createdAt,
    tombstone: null
  }
  const recordsContent = encodeCanonicalPackageRecords(recordsPackage)
  const provenanceContent = encodeCanonicalPackageProvenance(provenancePackage)
  let createdRecordsPath = ''
  let createdProvenancePath = ''
  let contentChanged = false
  const dirPath = await ensureSessionInLibraryUnderWriter(
    summary,
    undefined,
    undefined,
    {},
    {
      identity,
      descriptor,
      beforeManifest: (createdDir) => {
        createdRecordsPath = path.join(createdDir, CANONICAL_RECORDS_FILE)
        createdProvenancePath = path.join(createdDir, CANONICAL_PROVENANCE_FILE)
        contentChanged = writeCanonicalFileIfChanged(createdRecordsPath, recordsContent) || contentChanged
        contentChanged = writeCanonicalFileIfChanged(createdProvenancePath, provenanceContent) || contentChanged
      }
    }
  )
  const recordsPath = createdRecordsPath || path.join(dirPath, CANONICAL_RECORDS_FILE)
  const provenancePath = createdProvenancePath || path.join(dirPath, CANONICAL_PROVENANCE_FILE)
  contentChanged = writeCanonicalFileIfChanged(recordsPath, recordsContent) || contentChanged
  contentChanged = writeCanonicalFileIfChanged(provenancePath, provenanceContent) || contentChanged
  const transcriptPath = path.join(dirPath, TRANSCRIPT_FILE)
  contentChanged = writeCanonicalFileIfChanged(
    transcriptPath,
    canonicalTranscript(canonicalRecords, recordsPath, source)
  ) || contentChanged

  const meta = readSessionMeta(dirPath)
  if (!meta) throw new Error('canonical-package-manifest-missing')
  const nextSourcePaths = [sourceRef.displayLocator]
  if (JSON.stringify(meta.canonicalProvider) !== JSON.stringify(descriptor) ||
    JSON.stringify(meta.sourceFilePaths) !== JSON.stringify(nextSourcePaths) ||
    meta.updatedAt !== summary.updatedAt || meta.turnCount !== summary.turnCount) {
    meta.canonicalProvider = descriptor
    meta.sourceFilePaths = nextSourcePaths
    meta.updatedAt = summary.updatedAt
    meta.turnCount = summary.turnCount
    writeSessionMeta(dirPath, meta)
  }
  return { dirPath, recordsPath, provenancePath, contentChanged }
}

export async function ensureCanonicalPackage(
  providerId: string,
  sourceRef: SourceRef,
  canonicalRecords: CanonicalRecord[]
): Promise<EnsureCanonicalPackageResult> {
  return withLibraryWriter('maintenance', () =>
    ensureCanonicalPackageUnderWriter(providerId, sourceRef, canonicalRecords))
}

function librarySessions(tree: LibraryTree): LibrarySession[] {
  const sessions = [...tree.ungroupedSessions]
  const visit = (folders: LibraryFolder[]): void => {
    for (const folder of folders) {
      sessions.push(...folder.sessions)
      visit(folder.children)
    }
  }
  visit(tree.folders)
  return sessions
}

export async function markCanonicalPackageTombstone(
  providerId: string,
  sourceRefStableId: string,
  sessionRecordId: string,
  tombstone: Tombstone
): Promise<string | null> {
  if (!fs.existsSync(_root)) return null
  return withLibraryWriter('maintenance', () => {
    const tree = scanLibrary()
    const candidate = librarySessions(tree).find((session) => {
      const descriptor = session.meta.canonicalProvider
      return descriptor?.providerId === providerId &&
        descriptor.sourceRefStableId === sourceRefStableId &&
        descriptor.sessionRecordId === sessionRecordId
    })
    if (!candidate?.meta.canonicalProvider) return null
    const recordsPath = path.join(candidate.dirPath, candidate.meta.canonicalProvider.recordsFile)
    const recordsPackage = readCanonicalPackageRecords(recordsPath)
    if (!recordsPackage || recordsPackage.providerId !== providerId ||
      recordsPackage.sourceRef.stableId !== sourceRefStableId ||
      recordsPackage.sessionRecordId !== sessionRecordId) return null
    const descriptor = { ...candidate.meta.canonicalProvider, tombstone }
    const provenance: CanonicalPackageProvenance = {
      schemaVersion: 1,
      providerId,
      parserDataVersion: descriptor.parserDataVersion,
      formatVersion: descriptor.formatVersion,
      fingerprint: descriptor.fingerprint,
      sourceRef: recordsPackage.sourceRef,
      sessionRecordId,
      archivedAt: new Date().toISOString(),
      tombstone
    }
    writeCanonicalFileIfChanged(
      path.join(candidate.dirPath, descriptor.provenanceFile),
      encodeCanonicalPackageProvenance(provenance)
    )
    const meta = readSessionMeta(candidate.dirPath)
    if (!meta) return null
    meta.canonicalProvider = descriptor
    meta.updatedAt = tombstone.deletedAt || meta.updatedAt
    writeSessionMeta(candidate.dirPath, meta)
    return candidate.dirPath
  })
}

// --- Sync JSONL Backup ---

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function appendSourceTail(sourcePath: string, backupPath: string, start: number): Promise<void> {
  assertSafeLibraryFileTarget(_root, backupPath)
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0
  const fd = fs.openSync(backupPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | noFollow)
  const output = fs.createWriteStream(backupPath, { fd, autoClose: true })
  try {
    for await (const chunk of fs.createReadStream(sourcePath, { start })) {
      if (!output.write(chunk)) await new Promise<void>((resolve) => output.once('drain', resolve))
    }
    await new Promise<void>((resolve, reject) => {
      output.end(resolve)
      output.once('error', reject)
    })
  } catch (error) {
    output.destroy()
    throw error
  }
}

async function concatenateSources(sourcePaths: string[], destination: string): Promise<void> {
  assertSafeLibraryFileTarget(_root, destination)
  const tempPath = `${destination}.tmp-${process.pid}-${randomUUID()}`
  assertSafeLibraryFileTarget(_root, tempPath)
  const handle = await fs.promises.open(tempPath, 'wx', 0o600)
  try {
    for (let index = 0; index < sourcePaths.length; index++) {
      for await (const chunk of fs.createReadStream(sourcePaths[index])) {
        await handle.write(chunk as Buffer)
      }
      if (index < sourcePaths.length - 1) await handle.write('\n')
    }
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => {})
    await fs.promises.unlink(tempPath).catch(() => {})
    throw error
  }
  await handle.close()
  assertSafeLibraryFileTarget(_root, destination)
  await fs.promises.rename(tempPath, destination)
  fsyncDirectorySync(path.dirname(destination))
}

async function replaceBackupFromSource(sourcePath: string, backupPath: string): Promise<void> {
  assertSafeLibraryFileTarget(_root, backupPath)
  const tempPath = `${backupPath}.tmp-${process.pid}-${randomUUID()}`
  assertSafeLibraryFileTarget(_root, tempPath)
  await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL)
  await fs.promises.chmod(tempPath, 0o600).catch(() => {})
  const handle = await fs.promises.open(tempPath, 'r')
  try { await handle.sync() } finally { await handle.close() }
  try {
    assertSafeLibraryFileTarget(_root, backupPath)
    await fs.promises.rename(tempPath, backupPath)
    fsyncDirectorySync(path.dirname(backupPath))
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {})
  }
}

export async function syncBackup(sessionId: string, expectedDirPath?: string): Promise<void> {
  return withLibraryWriter('maintenance', () => syncBackupUnderWriter(sessionId, expectedDirPath))
}

async function syncBackupUnderWriter(sessionId: string, expectedDirPath?: string): Promise<void> {
  const dirPath = writableSessionDirOrNull(sessionId, expectedDirPath)
  if (!dirPath) return

  const meta = readSessionMeta(dirPath)
  if (!meta) return

  const backupPath = path.join(dirPath, BACKUP_FILE)
  assertSafeLibraryFileTarget(_root, backupPath)

  const sourcePaths = (sourceFilePathsFromMeta(meta) || []).filter((src) => {
    return isFileBackedBackupSource(src) && fs.existsSync(src)
  })
  if (sourcePaths.length === 0) return

  let nextSourceState: SessionMeta['backupSourceState'] | undefined
  if (sourcePaths.length === 1) {
    const sourcePath = sourcePaths[0]
    const sourceStat = await fs.promises.stat(sourcePath)
    const backupStat = await fs.promises.stat(backupPath).catch(() => null)
    const previous = meta.backupSourceState
    const canAppend = Boolean(
      previous && backupStat &&
      previous.path === sourcePath && previous.dev === sourceStat.dev && previous.ino === sourceStat.ino &&
      previous.size === backupStat.size && sourceStat.size > previous.size
    )

    if (canAppend) await appendSourceTail(sourcePath, backupPath, previous!.size)
    else if (!backupStat || sourceStat.size !== backupStat.size || sourceStat.mtimeMs !== previous?.mtimeMs) {
      await replaceBackupFromSource(sourcePath, backupPath)
    }

    nextSourceState = {
      path: sourcePath,
      dev: sourceStat.dev,
      ino: sourceStat.ino,
      size: sourceStat.size,
      mtimeMs: sourceStat.mtimeMs
    }
  } else {
    await concatenateSources(sourcePaths, backupPath)
  }

  const backupStat = await fs.promises.stat(backupPath)
  meta.backupSha256 = await hashFileSha256(backupPath)
  meta.backupSize = backupStat.size
  meta.backupSourceState = nextSourceState
  preserveSchemaV3OrUpgradeToV2(meta)
  writeSessionMeta(dirPath, meta)
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
  const sourceFamily = meta.logicalIdentity?.sourceFamily
  if (sourceFamily && isLegacySessionSource(sourceFamily)) {
    return sourceFamily as SessionSource
  }
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
  const meta = readSessionMeta(dirPath)
  if (!meta || meta.sessionId !== sessionId) throw new Error('session-binding-mismatch')
  assertCurrentSessionWriteAuthorized(dirPath, meta)
  const config = loadLibraryConfig()
  const generators = getEnabledDerivedFileGenerators(getEnabledDerivedGeneratorNames(config))

  for (const generator of generators) {
    const content = generator.generate(rawMessages, { sessionId })
    if (content === null) continue
    writeSafeLibraryFileSync(_root, path.join(dirPath, generator.fileName), redactSecrets(content).text)
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
  assertCurrentSessionWriteAuthorized(dirPath, meta)
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
  writeSafeLibraryFileSync(_root, mdPath, md)

  // Update meta timestamps + 权威轮数
  meta.updatedAt = summary.updatedAt
  meta.turnCount = summary.turnCount
  writeSessionMeta(dirPath, meta)
}

export async function updateTranscript(
  sessionId: string,
  customTitle?: string,
  expectedDirPath?: string
): Promise<boolean> {
  return withLibraryWriter('transcript', () =>
    updateTranscriptUnderWriter(sessionId, customTitle, expectedDirPath))
}

async function updateTranscriptUnderWriter(
  sessionId: string,
  customTitle?: string,
  expectedDirPath?: string
): Promise<boolean> {
  const dirPath = writableSessionDirOrNull(sessionId, expectedDirPath)
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

/** Reuse a coordinator/worker parse instead of rereading a large Claude JSONL. */
export function updateTranscriptFromRaw(
  sessionId: string,
  raw: RawJsonlMessage[],
  source: SessionSource,
  filePath: string,
  customTitle?: string,
  expectedDirPath?: string
): boolean {
  return withLibraryWriterSync('transcript', () =>
    updateTranscriptFromRawUnderWriter(sessionId, raw, source, filePath, customTitle, expectedDirPath))
}

function updateTranscriptFromRawUnderWriter(
  sessionId: string,
  raw: RawJsonlMessage[],
  source: SessionSource,
  filePath: string,
  customTitle?: string,
  expectedDirPath?: string
): boolean {
  const dirPath = writableSessionDirOrNull(sessionId, expectedDirPath)
  if (!dirPath) return false
  const meta = readSessionMeta(dirPath)
  if (!meta) return false
  const loaded: LoadedTranscriptRaw = { raw, source, filePath }
  const summary = buildTranscriptSummaryForWrite(meta, loaded)
  if (!summary) return false
  writeTranscriptFromLoadedRaw(sessionId, dirPath, meta, loaded, summary, customTitle)
  writeDerivedFilesFromLoadedRaw(sessionId, dirPath, raw)
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
  if (options.dryRun === true) return redactLibraryTranscriptsUnderWriter(options)
  return withLibraryWriterSync('transcript', () => redactLibraryTranscriptsUnderWriter(options))
}

function redactLibraryTranscriptsUnderWriter(
  options: { dryRun?: boolean } = {}
): RedactLibraryTranscriptsResult {
  const dryRun = options.dryRun === true
  const sessions = collectLibrarySessions(scanLibrary())
  if (!dryRun) {
    throwIfIdentityScanUnresolved(lastIdentityScanIssues)
    for (const binding of sessionRegistry.diagnostics()) {
      if (binding.state === 'bound') continue
      if (binding.state === 'conflict') {
        throw new SessionIdentityConflictError(binding.logicalKey, binding.candidates)
      }
    }
    // Gate every target before the first byte is changed.
    for (const session of sessions) requireWritableSessionDir(session.sessionId, session.dirPath)
  }
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

    for (const mdPath of redactableMarkdownPaths(session.dirPath)) {
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
      if (!dryRun) writeSafeLibraryFileSync(_root, mdPath, result.text)
    }
  }

  return { dryRun, files, hits }
}

export async function rebuildAllTranscripts(options: { dryRun?: boolean; missingOnly?: boolean } = {}): Promise<RebuildTranscriptsResult> {
  if (options.dryRun === true) return rebuildAllTranscriptsUnderWriter(options)
  return withLibraryWriter('transcript', () => rebuildAllTranscriptsUnderWriter(options))
}

async function rebuildAllTranscriptsUnderWriter(
  options: { dryRun?: boolean; missingOnly?: boolean } = {}
): Promise<RebuildTranscriptsResult> {
  const dryRun = options.dryRun === true
  const missingOnly = options.missingOnly === true
  const tree = scanLibrary()
  const sessions = collectLibrarySessions(tree)
  if (!dryRun) {
    throwIfIdentityScanUnresolved(lastIdentityScanIssues)
    for (const binding of sessionRegistry.diagnostics()) {
      if (binding.state === 'bound') continue
      if (binding.state === 'conflict') {
        throw new SessionIdentityConflictError(binding.logicalKey, binding.candidates)
      }
    }
    for (const session of sessions) requireWritableSessionDir(session.sessionId, session.dirPath)
  }
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

function authorizeOrganizationMoves(moves: readonly OrganizationMove[]): void {
  const issues = refreshSessionRegistryFromDisk()
  throwIfIdentityScanUnresolved(issues)
  for (const move of moves) {
    const currentDir = fs.existsSync(move.from) ? move.from : move.to
    requireWritableSessionDir(move.sessionId, currentDir)
    assertSafeLibraryWritePath(_root, move.from, { allowRoot: false })
    assertSafeLibraryWritePath(_root, move.to, { allowRoot: false })
    assertSafeLibraryWritePath(_root, path.dirname(move.to))
  }
}

function executeAuthorizedOrganization(
  kind: OrganizationKind,
  inputs: readonly OrganizationInput[],
  beforeWriteAuthorization?: () => void
): OrganizationResult {
  return executeOrganization(_root, kind, inputs, {
    authorizeMoves(moves): void {
      beforeWriteAuthorization?.()
      authorizeOrganizationMoves(moves)
    }
  })
}

export interface LibraryOrganizationRequest {
  sessionId: string
  targetRelativeFolder: string
  metaPatch?: OrganizationInput['metaPatch']
}

export function applyLibraryOrganization(
  kind: Exclude<OrganizationKind, 'manual'>,
  requests: readonly LibraryOrganizationRequest[],
  instrumentation: { beforeWriteAuthorization?: () => void } = {}
): OrganizationResult {
  const result = withLibraryWriterSync('move', () =>
    applyLibraryOrganizationUnderWriter(kind, requests, instrumentation))
  return { ...result, writeGeneration: readLibraryWriteGeneration(_root) }
}

function applyLibraryOrganizationUnderWriter(
  kind: Exclude<OrganizationKind, 'manual'>,
  requests: readonly LibraryOrganizationRequest[],
  instrumentation: { beforeWriteAuthorization?: () => void }
): OrganizationResult {
  if (!['project', 'smart', 'archive'].includes(kind)) throw new Error('不支持的整理类型')
  const inputs = requests.map((request) => ({
    sessionId: request.sessionId,
    sourceDir: requireIndexedSessionDir(request.sessionId),
    targetRelativeFolder: request.targetRelativeFolder,
    metaPatch: request.metaPatch
  }))
  const result = executeAuthorizedOrganization(kind, inputs, instrumentation.beforeWriteAuthorization)
  refreshSessionRegistryFromDisk()
  return result
}

export function createLibraryFolder(name: string, parentPath?: string): string {
  return withLibraryWriterSync('config', () => createLibraryFolderUnderWriter(name, parentPath))
}

function createLibraryFolderUnderWriter(name: string, parentPath?: string): string {
  const parent = parentPath
    ? resolvePathWithinRoot(_root, parentPath, { mustExist: true })
    : path.resolve(_root)
  const dirName = findUniqueDirName(parent, sanitizeDirName(name))
  const dirPath = resolvePathWithinRoot(_root, path.join(parent, dirName))
  ensureSafeLibraryDirectory(_root, dirPath)
  return dirPath
}

function assertManagedFolderPath(folderPath: string): void {
  const relative = path.relative(_root, folderPath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('只能整理当前 Vault 内的子文件夹')
  }
  if (isSessionDir(folderPath)) throw new Error('会话包不能作为文件夹整体整理')
  if (folderHasUserFiles(folderPath)) {
    throw new Error(`拒绝移动：「${path.basename(folderPath)}」含有普通笔记或文档；只允许整理会话包。`)
  }
}

function collectRealSessionsRecursively(dirPath: string): LibrarySession[] {
  const result: LibrarySession[] = []
  const { sessions, folders } = scanDir(dirPath)
  result.push(...sessions.filter((session) => !session.isSymlink))
  for (const folder of folders) result.push(...collectRealSessionsRecursively(folder.dirPath))
  return result
}

/**
 * Materialize a folder rename/move as a batch of marker-verified session moves.
 * The organizer writes the full reverse plan before the first package moves;
 * the old shell is removed only after every package has landed successfully.
 */
function relocateManagedFolder(folderPath: string, newPath: string): string {
  assertManagedFolderPath(folderPath)
  const sessions = collectRealSessionsRecursively(folderPath)

  if (sessions.length === 0) {
    assertSafeLibraryWritePath(_root, folderPath, { allowRoot: false })
    assertSafeLibraryWritePath(_root, newPath, { allowRoot: false })
    fs.renameSync(folderPath, newPath)
    return newPath
  }

  const inputs = sessions.map((session) => {
    const writableDir = requireWritableSessionDir(session.sessionId, session.dirPath)
    const relativeParent = path.relative(folderPath, path.dirname(session.dirPath))
    return {
      sessionId: session.sessionId,
      sourceDir: writableDir,
      targetRelativeFolder: path.relative(_root, path.join(newPath, relativeParent))
    }
  })
  const result = executeAuthorizedOrganization('manual', inputs)
  refreshSessionRegistryFromDisk()

  // The preflight above proved this tree contains no ordinary files. At this
  // point only empty directories and aliases remain; session data is at target.
  fs.rmSync(folderPath, { recursive: true, force: true })
  return newPath
}

export function renameLibraryFolder(folderPath: string, newName: string): string {
  return withLibraryWriterSync('move', () => renameLibraryFolderUnderWriter(folderPath, newName))
}

function renameLibraryFolderUnderWriter(folderPath: string, newName: string): string {
  folderPath = resolvePathWithinRoot(_root, folderPath, { allowRoot: false, mustExist: true })
  const parent = path.dirname(folderPath)
  const currentName = path.basename(folderPath)
  const sanitized = sanitizeDirName(newName)

  // Skip if name hasn't changed — avoids (2) suffix
  if (sanitized === currentName) return folderPath

  const newDirName = findUniqueDirName(parent, sanitized)
  const newPath = resolvePathWithinRoot(_root, path.join(parent, newDirName), { allowRoot: false })

  const movedPath = relocateManagedFolder(folderPath, newPath)
  updateFolderOrderPaths(path.relative(_root, folderPath), path.relative(_root, movedPath))
  return movedPath
}

export function moveLibraryFolderToParent(srcPath: string, destParentPath: string): string {
  return withLibraryWriterSync('move', () => moveLibraryFolderToParentUnderWriter(srcPath, destParentPath))
}

function moveLibraryFolderToParentUnderWriter(srcPath: string, destParentPath: string): string {
  srcPath = resolvePathWithinRoot(_root, srcPath, { allowRoot: false, mustExist: true })
  destParentPath = resolvePathWithinRoot(_root, destParentPath, { mustExist: true })
  if (path.dirname(srcPath) === destParentPath) return srcPath
  const relativeParent = path.relative(_root, destParentPath)
  if (relativeParent === '..' || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) {
    throw new Error('目标文件夹必须位于当前 Vault 内')
  }
  const relativeToSource = path.relative(srcPath, destParentPath)
  if (!relativeToSource || (!relativeToSource.startsWith(`..${path.sep}`) && relativeToSource !== '..')) {
    throw new Error('不能把文件夹移动到自身内部')
  }

  const baseName = path.basename(srcPath)
  const newName = findUniqueDirName(destParentPath, baseName)
  const newPath = resolvePathWithinRoot(_root, path.join(destParentPath, newName), { allowRoot: false })

  const movedPath = relocateManagedFolder(srcPath, newPath)
  updateFolderOrderPaths(path.relative(_root, srcPath), path.relative(_root, movedPath))
  return movedPath
}

export function deleteLibraryFolder(folderPath: string): void {
  return withLibraryWriterSync('move', () => deleteLibraryFolderUnderWriter(folderPath))
}

function deleteLibraryFolderUnderWriter(folderPath: string): void {
  folderPath = resolvePathWithinRoot(_root, folderPath, { allowRoot: false, mustExist: true })
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

  const allSessions = collectRealSessionsRecursively(folderPath)
  const result = executeAuthorizedOrganization('manual', allSessions.map((session) => ({
    sessionId: session.sessionId,
    sourceDir: requireWritableSessionDir(session.sessionId, session.dirPath),
    targetRelativeFolder: '.'
  })))
  refreshSessionRegistryFromDisk()

  // Now delete the folder (only symlinks/empty subdirs remain)
  fs.rmSync(folderPath, { recursive: true, force: true })
}

export interface LibraryMoveRequest {
  sessionId: string
  folderId: string
}

export interface LibraryRenameRequest {
  sessionId: string
  title: string
}

function requireIndexedSessionDir(sessionId: string): string {
  const indexedDir = requireWritableSessionDir(sessionId)
  if (!fs.existsSync(indexedDir)) throw new Error(`Session "${sessionId}" 不存在`)
  return resolvePathWithinRoot(_root, indexedDir, { allowRoot: false, mustExist: true })
}

export function moveSessionsToFolders(requests: readonly LibraryMoveRequest[]): OrganizationResult {
  const result = withLibraryWriterSync('move', () => moveSessionsToFoldersUnderWriter(requests))
  return { ...result, writeGeneration: readLibraryWriteGeneration(_root) }
}

function moveSessionsToFoldersUnderWriter(requests: readonly LibraryMoveRequest[]): OrganizationResult {
  if (requests.length === 0) throw new Error('批量移动输入为空')
  const prepared = requests.map(({ sessionId, folderId }) => {
    const currentDir = requireIndexedSessionDir(sessionId)
    const folderPath = resolveFolderPath(folderId)
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      throw new Error(`文件夹 "${folderId}" 不存在`)
    }
    const relative = path.relative(_root, folderPath)
    return {
      sessionId,
      sourceDir: currentDir,
      targetRelativeFolder: relative === '' ? '.' : relative
    }
  })
  const result = executeAuthorizedOrganization('manual', prepared)
  for (const move of result.moves) {
    if (move.from !== move.to) updateSymlinksRecursive(_root, move.from, move.to)
  }
  refreshSessionRegistryFromDisk()
  return result
}

export function renameSessionsInLibrary(requests: readonly LibraryRenameRequest[]): OrganizationResult {
  const result = withLibraryWriterSync('move', () => renameSessionsInLibraryUnderWriter(requests))
  return { ...result, writeGeneration: readLibraryWriteGeneration(_root) }
}

function renameSessionsInLibraryUnderWriter(requests: readonly LibraryRenameRequest[]): OrganizationResult {
  if (requests.length === 0) throw new Error('批量重命名输入为空')
  const prepared = requests.map(({ sessionId, title }) => {
    if (!title.trim()) throw new Error(`Session "${sessionId}" 的标题不能为空`)
    const currentDir = requireIndexedSessionDir(sessionId)
    const relativeParent = path.relative(_root, path.dirname(currentDir))
    return {
      sessionId,
      sourceDir: currentDir,
      targetRelativeFolder: relativeParent === '' ? '.' : relativeParent,
      targetBaseName: title,
      metaPatch: { customTitle: title }
    }
  })
  const result = executeAuthorizedOrganization('manual', prepared)
  for (const move of result.moves) {
    if (move.from !== move.to) updateSymlinksRecursive(_root, move.from, move.to)
  }
  refreshSessionRegistryFromDisk()
  return result
}

export function undoLastLibraryOrganization(): OrganizationResult {
  const result = withLibraryWriterSync('move', undoLastLibraryOrganizationUnderWriter)
  return { ...result, writeGeneration: readLibraryWriteGeneration(_root) }
}

export function recoverInterruptedLibraryOrganization(): OrganizationResult {
  const result = withLibraryWriterSync('move', () => {
    const result = recoverInterruptedOrganization(_root, { authorizeMoves: authorizeOrganizationMoves })
    if (result.operationId) refreshSessionRegistryFromDisk()
    return result
  })
  return { ...result, writeGeneration: readLibraryWriteGeneration(_root) }
}

function undoLastLibraryOrganizationUnderWriter(): OrganizationResult {
  const result = undoLastOrganization(_root, { authorizeMoves: authorizeOrganizationMoves })
  for (const move of result.moves) {
    if (move.from !== move.to) updateSymlinksRecursive(_root, move.from, move.to)
  }
  refreshSessionRegistryFromDisk()
  return result
}

export function moveSessionToFolder(sessionId: string, folderPath: string): void {
  return withLibraryWriterSync('move', () => moveSessionToFolderUnderWriter(sessionId, folderPath))
}

function moveSessionToFolderUnderWriter(sessionId: string, folderPath: string): void {
  folderPath = resolvePathWithinRoot(_root, folderPath, { mustExist: true })
  const currentDir = requireIndexedSessionDir(sessionId)

  // Remove any existing symlinks to this session in the target folder
  removeSessionSymlinksIn(currentDir, folderPath)

  // Moves go through executeOrganization so every manual drag is undoable.
  const relative = path.relative(_root, folderPath)
  const targetRelativeFolder = relative === '' ? '.' : relative
  const result = executeAuthorizedOrganization('manual', [{
    sessionId,
    sourceDir: currentDir,
    targetRelativeFolder
  }])
  if (result.moves[0]) refreshSessionRegistryFromDisk()
}

export function addSessionToFolder(sessionId: string, folderPath: string): void {
  return withLibraryWriterSync('move', () => addSessionToFolderUnderWriter(sessionId, folderPath))
}

function addSessionToFolderUnderWriter(sessionId: string, folderPath: string): void {
  folderPath = resolvePathWithinRoot(_root, folderPath, { mustExist: true })
  const indexedDir = writableSessionDirOrNull(sessionId)
  if (!indexedDir || !fs.existsSync(indexedDir)) return
  const currentDir = resolvePathWithinRoot(_root, indexedDir, { allowRoot: false, mustExist: true })

  // Check if already in this folder (directly or via symlink)
  const baseName = path.basename(currentDir)
  const targetPath = path.join(folderPath, baseName)
  if (fs.existsSync(targetPath)) return

  // Windows uses a directory junction so Alpha does not require admin or
  // Developer Mode; macOS keeps the existing symlink behavior unchanged.
  createSessionFolderReference(currentDir, targetPath)
}

export function removeSessionFromFolder(sessionId: string, folderPath: string): void {
  return withLibraryWriterSync('move', () => removeSessionFromFolderUnderWriter(sessionId, folderPath))
}

function removeSessionFromFolderUnderWriter(sessionId: string, folderPath: string): void {
  folderPath = resolvePathWithinRoot(_root, folderPath, { mustExist: true })
  const indexedDir = writableSessionDirOrNull(sessionId)
  if (!indexedDir) return
  const realDir = resolvePathWithinRoot(_root, indexedDir, { allowRoot: false, mustExist: true })

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
        // Removing a physical assignment returns the session to the vault root.
        const result = executeAuthorizedOrganization('manual', [{
          sessionId,
          sourceDir: fullPath,
          targetRelativeFolder: '.'
        }])
        if (result.moves[0]) refreshSessionRegistryFromDisk()
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
  return withLibraryWriterSync('move', () => renameSessionDirUnderWriter(sessionId, newTitle))
}

function renameSessionDirUnderWriter(sessionId: string, newTitle: string): string | null {
  const currentDir = writableSessionDirOrNull(sessionId)
  if (!currentDir || !fs.existsSync(currentDir)) return null

  const parent = path.dirname(currentDir)
  const newBaseName = sanitizeDirName(newTitle)
  if (newBaseName === path.basename(currentDir)) return currentDir

  const result = executeAuthorizedOrganization('manual', [{
    sessionId,
    sourceDir: currentDir,
    targetRelativeFolder: path.relative(_root, parent) || '.',
    targetBaseName: newBaseName,
    metaPatch: { customTitle: newTitle }
  }])
  const newPath = result.moves[0]?.to || currentDir
  if (newPath !== currentDir) updateSymlinksRecursive(_root, currentDir, newPath)
  refreshSessionRegistryFromDisk()

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
            createSessionFolderReference(newTarget, fullPath)
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
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
  onProgress?: (progress: { current: number; total: number; sessionId: string }) => void,
  shouldCancel?: () => boolean
): Promise<void> {
  return withLibraryWriter('maintenance', () =>
    syncLibraryFromSessionsUnderWriter(sessions, sessionMeta, onProgress, shouldCancel))
}

async function syncLibraryFromSessionsUnderWriter(
  sessions: SessionSummary[],
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>,
  onProgress?: (progress: { current: number; total: number; sessionId: string }) => void,
  shouldCancel?: () => boolean
): Promise<void> {
  for (let index = 0; index < sessions.length; index++) {
    if (shouldCancel?.()) {
      const error = new Error('Library synchronization cancelled')
      error.name = 'AbortError'
      throw error
    }
    const session = sessions[index]
    const customTitle = sessionMeta[session.sessionId]?.customTitle
    const canonicalDefinition = session.source ? builtinProviderForSource(session.source) : undefined
    if (canonicalDefinition?.ingestion === 'provider-host') {
      const stored = getCanonicalSessionStore().getSession(session.id)
      if (stored) {
        await ensureCanonicalPackageUnderWriter(
          canonicalDefinition.manifest.providerId,
          stored.sessionRecord.sourceRef,
          stored.records
        )
        onProgress?.({ current: index + 1, total: sessions.length, sessionId: session.sessionId })
        continue
      }
      throw new Error('canonical-provider-session-not-found')
    }
    const dirPath = await ensureSessionInLibrary(session, customTitle)

    // 持久化 swob 权威 turnCount 进 meta（各会话类型统一），供外部整理脚本按真实轮数归档
    const m = readSessionMeta(dirPath)
    if (m && m.turnCount !== session.turnCount) {
      requireWritableSessionDir(m.sessionId, dirPath)
      m.turnCount = session.turnCount
      writeSessionMeta(dirPath, m)
    }

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
      await updateTranscript(session.sessionId, customTitle, dirPath)
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
      await syncBackup(session.sessionId, dirPath)
    }
    if (shouldCancel?.()) {
      const error = new Error('Library synchronization cancelled')
      error.name = 'AbortError'
      throw error
    }
    onProgress?.({ current: index + 1, total: sessions.length, sessionId: session.sessionId })
  }
}

// --- Migrate from Old Config ---

export async function migrateFromOldConfig(
  oldFolders: Array<{ id: string; name: string; parentId?: string | null; sessionIds: string[]; color?: string }>,
  sessionMeta: Record<string, { customTitle?: string; notes?: string }>
): Promise<void> {
  return withLibraryWriter('maintenance', () => migrateFromOldConfigUnderWriter(oldFolders, sessionMeta))
}

async function migrateFromOldConfigUnderWriter(
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
      const sessionDir = uniqueSessionDir(sessionId)
      if (!sessionDir) continue
      moveSessionToFolder(sessionId, folderPath)
    }
  }

  // Update custom titles in meta
  for (const [sessionId, meta] of Object.entries(sessionMeta)) {
    const dirPath = writableSessionDirOrNull(sessionId)
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
      files: f.files,
      createdAt: ''
    })
    for (const s of f.sessions) {
      if (s.meta.customTitle || s.meta.notes || (s.meta.highlights && s.meta.highlights.length > 0) ||
        (s.meta.tags && s.meta.tags.length > 0) || s.meta.topic || s.meta.topicConfidence !== undefined) {
        sessionMeta[s.sessionId] = {
          customTitle: s.meta.customTitle,
          notes: s.meta.notes,
          highlights: s.meta.highlights,
          tags: s.meta.tags,
          topic: s.meta.topic,
          topicConfidence: s.meta.topicConfidence
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
    if (s.meta.customTitle || s.meta.notes || (s.meta.highlights && s.meta.highlights.length > 0) ||
      (s.meta.tags && s.meta.tags.length > 0) || s.meta.topic || s.meta.topicConfidence !== undefined) {
      sessionMeta[s.sessionId] = {
        customTitle: s.meta.customTitle,
        notes: s.meta.notes,
        highlights: s.meta.highlights,
        tags: s.meta.tags,
        topic: s.meta.topic,
        topicConfidence: s.meta.topicConfidence
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
    rootFiles: tree.rootFiles,
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
  return withLibraryWriterSync('config', () => reorderFolderUnderWriter(folderId, targetId, position))
}

function reorderFolderUnderWriter(folderId: string, targetId: string, position: 'before' | 'after'): void {
  resolveFolderPath(folderId)
  resolveFolderPath(targetId)
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
  return resolvePathWithinRoot(_root, folderId, {
    allowRoot: false,
    allowAbsolute: false
  })
}

// --- Branch folder management (stored in config, not file system) ---

export function addBranchToFolder(branchId: string, folderId: string): void {
  return withLibraryWriterSync('config', () => addBranchToFolderUnderWriter(branchId, folderId))
}

function addBranchToFolderUnderWriter(branchId: string, folderId: string): void {
  resolveFolderPath(folderId)
  const config = loadLibraryConfig()
  const map = config.branchFolders || {}
  const folders = map[branchId] || []
  if (!folders.includes(folderId)) folders.push(folderId)
  map[branchId] = folders
  config.branchFolders = map
  saveLibraryConfig(config)
}

export function removeBranchFromFolder(branchId: string, folderId: string): void {
  return withLibraryWriterSync('config', () => removeBranchFromFolderUnderWriter(branchId, folderId))
}

function removeBranchFromFolderUnderWriter(branchId: string, folderId: string): void {
  resolveFolderPath(folderId)
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
  return withLibraryWriterSync('metadata', () => setBranchMetaUnderWriter(branchId, meta))
}

function setBranchMetaUnderWriter(
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
  meta: {
    customTitle?: string
    notes?: string
    highlights?: SessionMeta['highlights']
    tags?: string[]
    topic?: string
    topicConfidence?: number
  }
): void {
  return withLibraryWriterSync('metadata', () => setSessionMetaInLibraryUnderWriter(sessionId, meta))
}

function setSessionMetaInLibraryUnderWriter(
  sessionId: string,
  meta: {
    customTitle?: string
    notes?: string
    highlights?: SessionMeta['highlights']
    tags?: string[]
    topic?: string
    topicConfidence?: number
  }
): void {
  const dirPath = writableSessionDirOrNull(sessionId)
  if (!dirPath) return

  const existing = readSessionMeta(dirPath)
  if (!existing) return

  let directMetaChanged = false
  if (meta.notes !== undefined) existing.notes = meta.notes
  if (meta.highlights !== undefined) existing.highlights = meta.highlights
  if (meta.notes !== undefined || meta.highlights !== undefined) directMetaChanged = true
  if (directMetaChanged) writeSessionMeta(dirPath, existing)

  const classificationPatch = {
    ...(meta.customTitle !== undefined ? { customTitle: meta.customTitle } : {}),
    ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    ...(meta.topic !== undefined ? { topic: meta.topic } : {}),
    ...(meta.topicConfidence !== undefined ? { topicConfidence: meta.topicConfidence } : {})
  }
  if (Object.keys(classificationPatch).length > 0) {
    const result = executeAuthorizedOrganization('manual', [{
      sessionId,
      sourceDir: dirPath,
      targetRelativeFolder: path.relative(_root, path.dirname(dirPath)) || '.',
      targetBaseName: meta.customTitle?.trim() ? meta.customTitle : path.basename(dirPath),
      metaPatch: classificationPatch
    }])
    const move = result.moves[0]
    if (move && move.from !== move.to) updateSymlinksRecursive(_root, move.from, move.to)
    refreshSessionRegistryFromDisk()
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
  const dirPath = uniqueSessionDir(sessionId)
  if (!dirPath) return false
  // Check if session meta file is a cloud placeholder
  const metaFile = path.join(dirPath, SESSION_META_FILE)
  if (isICloudPlaceholder(metaFile) || !fs.existsSync(metaFile)) return true
  const backupState = backupStateForDir(dirPath)
  if (backupState === 'icloud-placeholder') return true
  if (backupState !== 'missing') return false
  const meta = readSessionMeta(dirPath)
  return !!meta && resolveLibrarySessionRemoteState(meta).isRemote
}

/**
 * Trigger iCloud download for a session directory.
 * Uses `brctl download` command (macOS iCloud daemon).
 * Returns true if download was triggered successfully.
 */
export function triggerICloudDownload(sessionId: string): Promise<boolean> {
  const dirPath = uniqueSessionDir(sessionId)
  if (!dirPath || !fs.existsSync(dirPath)) return Promise.resolve(false)
  const safeDirPath = resolvePathWithinRoot(_root, dirPath, { allowRoot: false, mustExist: true })
  return new Promise((resolve) => {
    execFile('/usr/bin/brctl', ['download', safeDirPath], { timeout: 5000 }, (error) => {
      resolve(!error)
    })
  })
}

// ============ SSH Config ============

function normalizeSshTarget(target: SshTargetConfig): SshTargetConfig | null {
  const host = typeof target.host === 'string' ? target.host.trim() : ''
  const user = typeof target.user === 'string' ? target.user.trim() : ''
  if (!host || !user) return null
  const deviceId = typeof target.deviceId === 'string' && target.deviceId.trim()
    ? target.deviceId.trim()
    : undefined
  const hostname = typeof target.hostname === 'string' && target.hostname.trim()
    ? target.hostname.trim()
    : undefined
  const remotePath = typeof target.remotePath === 'string' && target.remotePath.trim()
    ? target.remotePath.trim()
    : undefined
  return {
    host,
    user,
    ...(remotePath ? { remotePath } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(hostname ? { hostname } : {}),
    ...(target.isDefault === true ? { isDefault: true } : {})
  }
}

function toLegacySshConfig(target: SshTargetConfig): SshConfig {
  return {
    host: target.host,
    user: target.user,
    ...(target.remotePath ? { remotePath: target.remotePath } : {})
  }
}

/**
 * Read per-device routes. A historical single sshConfig is migrated once to a
 * default route so old settings keep working without pretending to know a device ID.
 */
export function getSshTargets(): SshTargetConfig[] {
  const config = loadLibraryConfig()
  const configured = Array.isArray(config.preferences?.sshTargets)
    ? config.preferences.sshTargets.map(normalizeSshTarget).filter((target): target is SshTargetConfig => !!target)
    : []
  if (configured.length > 0) return configured.map((target) => ({ ...target }))

  const legacy = config.preferences?.sshConfig
    ? normalizeSshTarget({ ...config.preferences.sshConfig, isDefault: true })
    : null
  if (!legacy) return []

  config.preferences.sshTargets = [legacy]
  saveLibraryConfig(config)
  return [{ ...legacy }]
}

export function setSshTargets(targets: SshTargetConfig[]): void {
  const normalized = targets.map(normalizeSshTarget)
  if (normalized.some((target) => !target)) throw new Error('Invalid SSH target configuration')

  const next = normalized as SshTargetConfig[]
  if (next.some((target) => !target.deviceId && !target.hostname && !target.isDefault)) {
    throw new Error('SSH target requires a deviceId, hostname, or default marker')
  }
  const defaultIndexes = next.flatMap((target, index) => target.isDefault ? [index] : [])
  if (defaultIndexes.length > 1) throw new Error('Only one SSH target can be the default')
  const deviceIds = new Set<string>()
  const hostnames = new Set<string>()
  for (const target of next) {
    if (target.deviceId) {
      if (deviceIds.has(target.deviceId)) throw new Error('Duplicate SSH target deviceId')
      deviceIds.add(target.deviceId)
    }
    if (target.hostname) {
      const hostname = target.hostname.toLocaleLowerCase()
      if (hostnames.has(hostname)) throw new Error('Duplicate SSH target hostname')
      hostnames.add(hostname)
    }
  }

  const config = loadLibraryConfig()
  if (next.length === 0) {
    delete config.preferences.sshTargets
    delete config.preferences.sshConfig
  } else {
    config.preferences.sshTargets = next.map((target) => ({ ...target }))
    const fallback = next.find((target) => target.isDefault) || next[0]
    config.preferences.sshConfig = toLegacySshConfig(fallback)
  }
  saveLibraryConfig(config)
}

export function getSshConfig(): SshConfig | undefined {
  const targets = getSshTargets()
  const target = targets.find((candidate) => candidate.isDefault) || targets[0]
  return target ? toLegacySshConfig(target) : undefined
}

export function setSshConfig(sshConfig: SshConfig | null): void {
  if (sshConfig === null) {
    // Preserve the historical single-config contract: clearing it clears all
    // routes. Future per-device UI uses setSshTargets for selective removal.
    setSshTargets([])
    return
  }

  const defaultTarget = normalizeSshTarget({ ...sshConfig, isDefault: true })
  if (!defaultTarget) throw new Error('Invalid SSH configuration')
  const targets = getSshTargets()
  const existingDefault = targets.findIndex((target) => target.isDefault)
  if (existingDefault >= 0) targets.splice(existingDefault, 1, defaultTarget)
  else targets.unshift(defaultTarget)
  setSshTargets(targets)
}

export function resolveSshTargetForOrigin(
  origin: Pick<SessionOrigin, 'deviceId' | 'hostname'>,
  targets: SshTargetConfig[] = getSshTargets()
): SshTargetConfig | null {
  const byDeviceId = targets.find((target) => target.deviceId === origin.deviceId)
  if (byDeviceId) return { ...byDeviceId }

  const hostname = origin.hostname.trim().toLocaleLowerCase()
  const byHostname = targets.find((target) => target.hostname?.trim().toLocaleLowerCase() === hostname)
  if (byHostname) return { ...byHostname }

  const fallback = targets.find((target) => target.isDefault)
  return fallback ? { ...fallback } : null
}

export function getSshConfigForSession(sessionId: string): SshTargetConfig | null {
  const dirPath = uniqueSessionDir(sessionId)
  if (!dirPath) return null
  const meta = readSessionMeta(dirPath)
  if (!meta?.origin || !resolveLibrarySessionRemoteState(meta).isRemote) return null
  return resolveSshTargetForOrigin(meta.origin)
}

export function getSessionSshResumeAvailability(sessionId: string): SessionSshResumeAvailability {
  const dirPath = uniqueSessionDir(sessionId)
  if (!dirPath) return { canResume: false, reason: SSH_RESUME_UNAVAILABLE_REASON }
  const meta = readSessionMeta(dirPath)
  if (!meta?.origin || !resolveLibrarySessionRemoteState(meta).isRemote) {
    return { canResume: false, reason: SSH_RESUME_UNAVAILABLE_REASON }
  }
  const target = resolveSshTargetForOrigin(meta.origin)
  if (!target) return { canResume: false, reason: SSH_RESUME_UNAVAILABLE_REASON }
  return {
    canResume: true,
    target,
    ...(meta.resumeCwd ? {} : { warning: SSH_RESUME_CWD_WARNING })
  }
}

/**
 * Build SSH resume command for a session.
 * ssh user@host "cd /path && claude --resume sessionId"
 */
export function isRemoteProjectPath(projectPath: string): boolean {
  return isRemoteProjectPathForUser(projectPath, os.userInfo().username)
}

/**
 * Look up the exact remote working directory captured in Library metadata.
 * Legacy storage-directory names are deliberately not decoded: that transform
 * is lossy for hyphens, spaces, dots and other normalized characters.
 */
export function getRemoteCwdForSession(sessionId: string): string | null {
  const dirPath = uniqueSessionDir(sessionId)
  if (!dirPath) return null
  const meta = readSessionMeta(dirPath)
  return meta?.resumeCwd || null
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
