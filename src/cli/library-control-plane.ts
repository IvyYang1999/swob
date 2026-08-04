import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { classifyUnverifiableReason, computeSessionFreshness } from '../main/library-freshness'
import { inspectLibraryWriterLease } from '../main/library-writer-lease'
import type {
  LibraryHealthSnapshot,
  SessionFreshness,
  UnverifiableReason
} from '../shared/library-health-contract'
import {
  getLibrarySessionRegistryDiagnostics,
  getLibraryRoot,
  resolveSessionBinding,
  resolveLibrarySessionRemoteState,
  scanLibrary,
  type LibraryFolder,
  type LibraryIdentityScanIssue,
  type LibrarySession,
  type LibraryTree
} from '../main/library-manager'
import { summarizeLibraryIdentityHealth } from '../main/library-session-registry'
import { resolveSessionId, type ResolveSessionResult } from './resolve-command'

const SESSION_MANIFEST = '.swob-session.json'
const TRANSCRIPT_FILE = 'transcript.md'
const BACKUP_FILE = 'backup.jsonl'

export type ControlPlaneErrorCode =
  | 'IDENTIFIER_AMBIGUOUS'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_IDENTITY_CONFLICT'
  | 'LIBRARY_MANIFEST_CORRUPT'
  | 'LIBRARY_SCAN_INCOMPLETE'
  | 'ICLOUD_PLACEHOLDER'

export class ControlPlaneError extends Error {
  constructor(
    readonly code: ControlPlaneErrorCode,
    message: string,
    readonly exitCode: 1 | 2 | 3,
    readonly hint: string,
    readonly retryable = false,
    readonly candidates?: string[]
  ) {
    super(message)
    this.name = 'ControlPlaneError'
  }
}

export interface LibraryControlSnapshot {
  tree: LibraryTree
  sessions: LibrarySession[]
  sessionIds: string[]
}

export interface ControlPathState {
  path: string
  exists: boolean
  placeholder: boolean
  placeholderPath: string | null
  updatedAt: string | null
}

export interface SessionControlFreshness extends SessionFreshness {
  manifestUpdatedAt: string | null
  blockingReason: string | null
  blockingReasons: readonly string[]
}

export interface SessionLocation {
  sessionId: string
  packagePath: string
  manifest: ControlPathState
  transcript: ControlPathState
  backup: ControlPathState
  canonicalRecords: ControlPathState | null
  sources: ControlPathState[]
  freshness: SessionControlFreshness
}

export interface WriterLockStatus {
  state: 'unlocked' | 'blocked'
  ownerPid: number | null
  ownerAlive: boolean | null
  mode: string | null
  reason: string | null
  heartbeatAt: string | null
  leaseExpiresAt: string | null
  leaseExpired: boolean | null
  evidenceHash: string | null
  manualRecoveryAvailable: boolean
  whyNotRecoverable: string | null
}

/**
 * A one-shot, stat-only view. This is deliberately not the Electron runtime's
 * LibraryHealthSnapshot: CLI cannot observe its compensation queue or event
 * history and therefore must not fabricate them.
 */
export interface LibraryDoctorSnapshot {
  schemaVersion: 1
  observation: 'instantaneous-filesystem'
  observedAt: string
  state: LibraryHealthSnapshot['state']
  writeCapability: LibraryHealthSnapshot['writeCapability']
  writable: boolean
  manifestCount: number
  staleCount: number
  unverifiableCount: number
  identityConflictCount: number
  identityExceptionCount: number
  identityExceptionPackageCount: number
  unknownIdentityConflictCount: number
  unknownIdentityConflictPackageCount: number
  identityEvidenceMismatchCount: number
  scanComplete: boolean
  issueCounts: Record<string, number>
  unverifiableBuckets: Record<UnverifiableReason, number>
  unverifiableSessions: Array<{
    sessionId: string
    reason: UnverifiableReason
    reasonCodes: readonly string[]
  }>
  identityConflicts: Array<{
    logicalKeyHash: string
    status: 'authorized' | 'unknown' | 'evidence-mismatch'
    packageCount: number
    reason: string
    exceptionId: string | null
  }>
  dimensions: {
    writerCapability: { state: 'available' | 'blocked' | 'read-only' | 'corrupt' }
    activeSourceFreshness: { state: 'durable' | 'stale' | 'unverifiable' }
    backgroundBacklog: { state: 'unobserved' }
    identityExceptions: ReturnType<typeof summarizeLibraryIdentityHealth>
  }
  writer: WriterLockStatus
}

function collectSessions(tree: LibraryTree): LibrarySession[] {
  const sessions = [...tree.ungroupedSessions]
  const visit = (folder: LibraryFolder): void => {
    sessions.push(...folder.sessions)
    folder.children.forEach(visit)
  }
  tree.folders.forEach(visit)
  return sessions.filter((session) => !session.isSymlink)
}

export function readLibraryControlSnapshot(): LibraryControlSnapshot {
  const tree = scanLibrary()
  const sessions = collectSessions(tree)
  return {
    tree,
    sessions,
    sessionIds: [...new Set(sessions.map((session) => session.sessionId))].sort()
  }
}

function issueCode(issues: readonly LibraryIdentityScanIssue[]): ControlPlaneErrorCode {
  if (issues.some((issue) => issue.kind === 'corrupt-manifest')) return 'LIBRARY_MANIFEST_CORRUPT'
  if (issues.some((issue) => issue.kind === 'icloud-placeholder')) return 'ICLOUD_PLACEHOLDER'
  return 'LIBRARY_SCAN_INCOMPLETE'
}

function incompleteScanError(issues: readonly LibraryIdentityScanIssue[]): ControlPlaneError {
  const code = issueCode(issues)
  const message = code === 'LIBRARY_MANIFEST_CORRUPT'
    ? 'Library 中存在损坏的会话 manifest，无法证明目标不存在或前缀唯一'
    : code === 'ICLOUD_PLACEHOLDER'
      ? 'Library manifest 正在等待 iCloud 下载，无法证明目标不存在或前缀唯一'
      : 'Library 扫描不完整，无法证明目标不存在或前缀唯一'
  return new ControlPlaneError(code, message, 1, '运行 swob doctor library --json 查看只读诊断', true)
}

export function resolveFromSnapshot(
  input: string,
  snapshot: LibraryControlSnapshot,
  libraryRoot = getLibraryRoot()
): ResolveSessionResult {
  const result = resolveSessionId(input, libraryRoot, snapshot.sessionIds)
  const exactManifestMatch = snapshot.sessionIds.includes(input)
  if (!exactManifestMatch && snapshot.tree.identityIssues?.length && !result.exact) {
    throw incompleteScanError(snapshot.tree.identityIssues)
  }
  if (result.matched) assertBoundResolution(result.resolved)
  return result
}

function assertBoundResolution(sessionId: string): void {
  const binding = resolveSessionBinding(sessionId)
  if (binding.state === 'bound') return
  if (binding.state === 'conflict' || binding.state === 'ambiguous') {
    throw new ControlPlaneError(
      'SESSION_IDENTITY_CONFLICT',
      `会话 "${sessionId}" 的 Library 身份不唯一，已拒绝猜测`,
      1,
      '运行 swob doctor library --json，并先处理重复身份'
    )
  }
  throw new ControlPlaneError(
    'SESSION_NOT_FOUND',
    `会话 "${sessionId}" 在 lineage 中存在，但最终目标没有可验证的 Library 绑定`,
    3,
    '先运行 swob doctor library --json 核对目标 manifest'
  )
}

function resolutionError(result: ResolveSessionResult): ControlPlaneError {
  if (result.ambiguous) {
    return new ControlPlaneError(
      'IDENTIFIER_AMBIGUOUS',
      `会话前缀 "${result.input}" 匹配多个会话`,
      2,
      '使用 candidates 中更长的前缀或完整 session ID',
      false,
      result.candidates || []
    )
  }
  return new ControlPlaneError(
    'SESSION_NOT_FOUND',
    `会话 "${result.input}" 不存在`,
    3,
    '先运行 swob resolve <id-or-prefix> --json'
  )
}

export function locateSession(
  input: string,
  snapshot: LibraryControlSnapshot = readLibraryControlSnapshot()
): { result: ResolveSessionResult; session: LibrarySession } {
  const result = resolveFromSnapshot(input, snapshot)
  if (!result.matched) throw resolutionError(result)

  const binding = resolveSessionBinding(result.resolved)
  if (binding.state !== 'bound') throw resolutionError({ ...result, matched: false })
  const session = snapshot.sessions.find((candidate) =>
    path.resolve(candidate.dirPath) === path.resolve(binding.candidate.dirPath)
  )
  if (!session) throw resolutionError({ ...result, matched: false })
  return { result, session }
}

function mtime(filePath: string): string | null {
  try {
    return new Date(fs.statSync(filePath).mtimeMs).toISOString()
  } catch {
    return null
  }
}

function placeholderFor(filePath: string): string | null {
  const candidates = [
    `${filePath}.icloud`,
    path.join(path.dirname(filePath), `.${path.basename(filePath)}.icloud`)
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function pathState(filePath: string): ControlPathState {
  const exists = fs.existsSync(filePath)
  const placeholderPath = exists ? null : placeholderFor(filePath)
  return {
    path: filePath,
    exists,
    placeholder: placeholderPath !== null,
    placeholderPath,
    updatedAt: exists ? mtime(filePath) : null
  }
}

function freshnessReasons(
  freshness: SessionFreshness,
  transcript: ControlPathState,
  backup: ControlPathState,
  canonicalRecords: ControlPathState | null,
  sources: ControlPathState[],
  writer: WriterLockStatus
): string[] {
  const reasons: string[] = [...freshness.reasons]
  if (writer.state === 'blocked') reasons.push('LIBRARY_WRITER_BLOCKED')
  if ([transcript, backup, ...(canonicalRecords ? [canonicalRecords] : []), ...sources]
    .some((entry) => entry.placeholder)) reasons.push('ICLOUD_PLACEHOLDER')
  return [...new Set(reasons)]
}

export function inspectWriterLock(
  libraryRoot = getLibraryRoot(),
  options: Parameters<typeof inspectLibraryWriterLease>[1] = {}
): WriterLockStatus {
  const inspection = inspectLibraryWriterLease(libraryRoot, options)
  return {
    state: inspection.state,
    ownerPid: inspection.ownerPid ?? null,
    ownerAlive: inspection.ownerAlive ?? null,
    mode: inspection.mode ?? null,
    reason: inspection.reason ?? null,
    heartbeatAt: inspection.heartbeatAt ?? null,
    leaseExpiresAt: inspection.leaseExpiresAt ?? null,
    leaseExpired: inspection.leaseExpired ?? null,
    evidenceHash: inspection.evidenceHash ?? null,
    manualRecoveryAvailable: inspection.manualRecoveryAvailable,
    whyNotRecoverable: inspection.manualRecoveryAvailable ? null : inspection.state === 'blocked' ? inspection.message : null
  }
}

export function buildSessionLocation(
  session: LibrarySession,
  writer: WriterLockStatus = inspectWriterLock()
): SessionLocation {
  const manifest = pathState(path.join(session.dirPath, SESSION_MANIFEST))
  const transcript = pathState(path.join(session.dirPath, TRANSCRIPT_FILE))
  const backup = pathState(path.join(session.dirPath, BACKUP_FILE))
  const canonicalRecords = session.meta.canonicalProvider?.recordsFile
    ? pathState(path.join(session.dirPath, session.meta.canonicalProvider.recordsFile))
    : null
  const sourceStatPaths = session.meta.sourceFilePaths.map((sourcePath) => {
    const refSeparator = sourcePath.indexOf('#')
    return refSeparator > 0 ? sourcePath.slice(0, refSeparator) : sourcePath
  })
  const sources = session.meta.sourceFilePaths.map((sourcePath, index) => ({
    ...pathState(sourceStatPaths[index]),
    path: sourcePath
  }))
  const base = computeSessionFreshness(session.sessionId, session.dirPath, session.meta.sourceFilePaths, {
    canonicalRecordsFile: session.meta.canonicalProvider?.recordsFile,
    unverifiableReason: classifyUnverifiableReason(session.meta.sourceFilePaths, {
      remote: resolveLibrarySessionRemoteState(session.meta).isRemote
    })
  })
  const blockingReasons = freshnessReasons(base, transcript, backup, canonicalRecords, sources, writer)
  return {
    sessionId: session.sessionId,
    packagePath: session.dirPath,
    manifest,
    transcript,
    backup,
    canonicalRecords,
    sources,
    freshness: {
      ...base,
      manifestUpdatedAt: manifest.updatedAt,
      blockingReason: blockingReasons[0] || null,
      blockingReasons
    }
  }
}

function countIssueKinds(issues: readonly LibraryIdentityScanIssue[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const issue of issues) counts[issue.kind] = (counts[issue.kind] || 0) + 1
  return counts
}

function emptyUnverifiableBuckets(): Record<UnverifiableReason, number> {
  return {
    'missing-source': 0,
    'icloud-placeholder': 0,
    'remote-session': 0,
    'corrupt-manifest': 0,
    other: 0
  }
}

export function inspectLibrary(snapshot: LibraryControlSnapshot = readLibraryControlSnapshot()): LibraryDoctorSnapshot {
  const issues = snapshot.tree.identityIssues || []
  const conflictBindings = getLibrarySessionRegistryDiagnostics().filter(
    (binding) => binding.state === 'conflict'
  )
  const identityHealth = summarizeLibraryIdentityHealth(conflictBindings)
  const writer = inspectWriterLock()
  const freshness = snapshot.sessions.map((session) => buildSessionLocation(session, writer).freshness)
  const staleCount = freshness.filter((entry) => entry.stale).length
  const unverifiableCount = freshness.filter((entry) => entry.status === 'unverifiable').length
  const unverifiableBuckets = emptyUnverifiableBuckets()
  const unverifiableSessions = freshness.flatMap((entry) => {
    if (entry.status !== 'unverifiable') return []
    const reason = entry.unverifiableReason || 'other'
    unverifiableBuckets[reason]++
    return [{ sessionId: entry.sessionId, reason, reasonCodes: entry.reasons }]
  })
  unverifiableBuckets['corrupt-manifest'] += issues.filter((issue) => issue.kind === 'corrupt-manifest').length
  let writable = true
  try {
    fs.accessSync(getLibraryRoot(), fs.constants.R_OK | fs.constants.W_OK)
  } catch {
    writable = false
  }
  const writeState = issues.some((issue) => issue.kind === 'corrupt-manifest')
    ? 'corrupt'
    : issues.length > 0
      ? 'read-only'
      : conflictBindings.length > 0
        ? 'identity-conflict'
        : writer.state === 'blocked'
          ? 'writer-blocked'
          : writable
            ? 'ready'
            : 'read-only'
  const writeCapability: LibraryHealthSnapshot['writeCapability'] = writeState === 'ready'
    ? 'full'
    : writeState === 'identity-conflict'
      ? 'partial'
      : 'none'
  const writerDimension = writeState === 'corrupt'
    ? 'corrupt'
    : writeState === 'writer-blocked'
      ? 'blocked'
      : writeState === 'read-only'
        ? 'read-only'
        : 'available'
  const freshnessDimension = staleCount > 0
    ? 'stale'
    : unverifiableCount > 0
      ? 'unverifiable'
      : 'durable'
  return {
    schemaVersion: 1,
    observation: 'instantaneous-filesystem',
    observedAt: new Date().toISOString(),
    state: writeState,
    writeCapability,
    writable,
    manifestCount: snapshot.sessions.length,
    staleCount,
    unverifiableCount,
    // Compatibility field: its established unit is logical conflict groups.
    identityConflictCount: conflictBindings.length,
    identityExceptionCount: identityHealth.authorizedGroupCount,
    identityExceptionPackageCount: identityHealth.authorizedPackageCount,
    unknownIdentityConflictCount: identityHealth.unknownGroupCount,
    unknownIdentityConflictPackageCount: identityHealth.unknownPackageCount,
    identityEvidenceMismatchCount: identityHealth.evidenceMismatchGroupCount,
    scanComplete: snapshot.tree.identityScanStatus === 'authoritative-complete',
    issueCounts: countIssueKinds(issues),
    unverifiableBuckets,
    unverifiableSessions,
    identityConflicts: conflictBindings.map((binding) => ({
      logicalKeyHash: createHash('sha256').update(binding.logicalKey).digest('hex'),
      status: binding.exceptionStatus,
      packageCount: binding.candidates.length,
      reason: binding.reason,
      exceptionId: binding.exception?.exceptionId || null
    })),
    dimensions: {
      writerCapability: { state: writerDimension },
      activeSourceFreshness: { state: freshnessDimension },
      backgroundBacklog: { state: 'unobserved' },
      identityExceptions: identityHealth
    },
    writer
  }
}
