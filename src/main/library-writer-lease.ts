import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { getLocalBootIdentity, getProcessStartFingerprint } from './session-create-lock'
import {
  deriveHostBootIdentity,
  deriveLibraryHostProof,
  getOrCreateHostIdentity
} from './host-identity'
import {
  assertSafeLibraryWritePath,
  canonicalLibraryRootForWrite,
  ensureSafeLibraryDirectory,
  fsyncDirectorySync,
  replaceSafeLibraryFileSync,
  writeSafeLibraryFileSync
} from './library-path-safety'

export type LibraryWriterMode =
  | 'maintenance'
  | 'package-create'
  | 'transcript'
  | 'metadata'
  | 'move'
  | 'config'

export interface LibraryWriterOwner {
  schemaVersion: 1 | 2
  ownerNonce: string
  /** Profile/install identity is diagnostic metadata, never liveness evidence. */
  deviceId: string
  pid: number
  bootIdentity: string
  processStartFingerprint: string
  /** v2: challenge-scoped HMAC proof; the raw host identity never enters the Library. */
  hostProof?: string
  /** v2 random challenge makes hostProof unlinkable across leases/Libraries. */
  hostProofSalt?: string
  mode: LibraryWriterMode
  acquiredAt: string
  heartbeatAt: string
  leaseExpiresAt: string
}

export interface LibraryWriterLeaseHandle {
  owner: LibraryWriterOwner
  release(): void
}

export interface LibraryWriterEvent {
  component: 'library-writer'
  event: 'acquire' | 'release' | 'contention' | 'stale-recovered' | 'stale-scan-rejected'
  libraryHash: string
  mode: LibraryWriterMode
  reason?: LibraryWriterBusyReason
  waitMs?: number
}

export type LibraryWriterBusyReason =
  | 'active-owner'
  | 'remote-owner'
  | 'unverifiable-owner'
  | 'corrupt-owner'
  | 'recovery-in-progress'
  | 'timeout'

export interface LibraryWriterLeaseOptions {
  timeoutMs?: number
  pollMs?: number
  leaseMs?: number
  heartbeatMs?: number
  now?: () => number
  /** Monotonic clock used only for bounded waits; wall-clock jumps cannot hang acquisition. */
  monotonicNow?: () => number
  nonce?: () => string
  platform?: NodeJS.Platform
  pid?: number
  bootIdentity?: () => string | null
  processStartFingerprint?: (pid: number) => string | 'missing' | null
  /** Test/embedding seam. The returned raw value is never persisted in the Library. */
  hostIdentity?: () => string
  /** Test-only crash seam after a durable heartbeat temp exists but before atomic publish. */
  heartbeatBeforePublish?: (tempPath: string) => void
  /** Test-only concurrency seam after the recovery claim is durable. */
  recoveryClaimCreated?: (claimPath: string) => void
  /** Test-only proof that a competing process observed an existing claim. */
  recoveryClaimObserved?: (claimPath: string) => void
  eventSink?: (event: LibraryWriterEvent) => void
}

export interface LibraryWriterLeaseInspection {
  state: 'unlocked' | 'blocked'
  reason?: Exclude<LibraryWriterBusyReason, 'timeout'>
  evidenceHash?: string
  manualRecoveryAvailable: boolean
  message: string
}

export const LIBRARY_WRITER_MANUAL_RECOVERY_CONFIRMATION = 'RECOVER_LIBRARY_WRITER_LOCK'

export interface LibraryWriterManualRecoveryRequest {
  expectedEvidenceHash: string
  confirmation: string
}

export interface LibraryWriterManualRecoveryResult {
  recovered: boolean
  reason: 'recovered' | 'unlocked' | Exclude<LibraryWriterBusyReason, 'timeout'> | 'evidence-changed' | 'confirmation-required'
  quarantinePath?: string
}

/** Structured in-process telemetry; never contaminates CLI stdout/stderr. */
export function emitLibraryWriterEvent(event: LibraryWriterEvent): void {
  process.emit('swob:library-writer-event', event)
}

const BUSY_MESSAGES: Record<LibraryWriterBusyReason, string> = {
  'active-owner': 'Library 正由本机存活的 Swob 进程写入；不会抢锁',
  'remote-owner': 'Library 写锁属于无法证明为本机的 owner；已安全拒绝自动恢复',
  'unverifiable-owner': 'Library 写锁缺少可验证的本机存活证据；已安全拒绝自动恢复',
  'corrupt-owner': 'Library 写锁 owner 格式损坏；证据已保留，不会自动删除',
  'recovery-in-progress': 'Library 写锁正由另一个本机进程恢复；不会并发抢占',
  timeout: 'Library 写入锁等待超时'
}

export class LibraryWriterBusyError extends Error {
  readonly code = 'LIBRARY_WRITER_BUSY'

  constructor(readonly reason: LibraryWriterBusyReason) {
    super(`${BUSY_MESSAGES[reason]}；请稍后重试或使用显式锁恢复入口`)
    this.name = 'LibraryWriterBusyError'
  }
}

const OWNER_SUFFIX = '.owner.json'
const RECOVERY_CLAIM = 'recovery.claim'
const RECOVERY_QUARANTINE = 'writer-recovery-evidence'
const WRITER_MODES = new Set<LibraryWriterMode>([
  'maintenance', 'package-create', 'transcript', 'metadata', 'move', 'config'
])

interface RecoveryClaim {
  schemaVersion: 1
  claimNonce: string
  ownerNonce?: string
  ownerEvidenceHash: string
  claimantPid: number
  claimantBootIdentity: string
  claimantProcessStartFingerprint: string
  claimantHostProof: string
  claimantHostProofSalt: string
  createdAt: string
  kind: 'automatic' | 'manual'
}

export function hashLibraryRoot(libraryRoot: string): string {
  return createHash('sha256').update(path.resolve(libraryRoot)).digest('hex').slice(0, 20)
}

function emit(
  root: string,
  mode: LibraryWriterMode,
  event: LibraryWriterEvent['event'],
  options: LibraryWriterLeaseOptions,
  details: Pick<LibraryWriterEvent, 'reason' | 'waitMs'> = {}
): void {
  const value: LibraryWriterEvent = {
    component: 'library-writer',
    event,
    libraryHash: hashLibraryRoot(root),
    mode,
    ...details
  }
  if (options.eventSink) options.eventSink(value)
  else emitLibraryWriterEvent(value)
}

function parseOwner(content: string): LibraryWriterOwner | null {
  try {
    const value = JSON.parse(content) as Partial<LibraryWriterOwner>
    if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
      typeof value.ownerNonce !== 'string' || !value.ownerNonce ||
      typeof value.deviceId !== 'string' || !value.deviceId ||
      !Number.isSafeInteger(value.pid) || value.pid! <= 0 ||
      typeof value.bootIdentity !== 'string' || !value.bootIdentity ||
      typeof value.processStartFingerprint !== 'string' || !value.processStartFingerprint ||
      (value.schemaVersion === 2 && (typeof value.hostProof !== 'string' || !/^[0-9a-f]{64}$/.test(value.hostProof) ||
        typeof value.hostProofSalt !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.hostProofSalt))) ||
      typeof value.mode !== 'string' || !WRITER_MODES.has(value.mode as LibraryWriterMode) ||
      typeof value.acquiredAt !== 'string' || !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.heartbeatAt !== 'string' || !Number.isFinite(Date.parse(value.heartbeatAt)) ||
      typeof value.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.leaseExpiresAt))) return null
    return value as LibraryWriterOwner
  } catch {
    return null
  }
}

function parseClaim(content: string): RecoveryClaim | null {
  try {
    const value = JSON.parse(content) as Partial<RecoveryClaim>
    if (value.schemaVersion !== 1 || typeof value.claimNonce !== 'string' || !value.claimNonce ||
      (value.ownerNonce !== undefined && (typeof value.ownerNonce !== 'string' || !value.ownerNonce)) ||
      typeof value.ownerEvidenceHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.ownerEvidenceHash) ||
      !Number.isSafeInteger(value.claimantPid) || value.claimantPid! <= 0 ||
      typeof value.claimantBootIdentity !== 'string' || !value.claimantBootIdentity ||
      typeof value.claimantProcessStartFingerprint !== 'string' || !value.claimantProcessStartFingerprint ||
      typeof value.claimantHostProof !== 'string' || !/^[0-9a-f]{64}$/.test(value.claimantHostProof) ||
      typeof value.claimantHostProofSalt !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.claimantHostProofSalt) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
      (value.kind !== 'automatic' && value.kind !== 'manual')) return null
    return value as RecoveryClaim
  } catch {
    return null
  }
}

function writeOwner(
  libraryRoot: string,
  ownerPath: string,
  owner: LibraryWriterOwner,
  exclusive = false,
  beforePublish?: (tempPath: string) => void
): void {
  if (exclusive) {
    writeSafeLibraryFileSync(libraryRoot, ownerPath, JSON.stringify(owner), { exclusive: true, mode: 0o600 })
  } else {
    // Heartbeats must never truncate the only valid owner record in place. A
    // crash can leave a fully flushed, recognizable temp beside the old owner;
    // readers ignore that temp and can still prove the old process dead.
    replaceSafeLibraryFileSync(libraryRoot, ownerPath, JSON.stringify(owner), {
      mode: 0o600,
      beforePublish
    })
  }
  fsyncDirectorySync(path.dirname(ownerPath))
}

interface ExistingDirectoryOwner {
  kind: 'valid'
  ownerPath: string
  owner: LibraryWriterOwner
  evidenceHash: string
}

interface CorruptDirectoryOwner {
  kind: 'corrupt'
  evidenceHash: string
}

interface MissingDirectoryOwner {
  kind: 'missing'
}

type DirectoryOwnerEvidence = ExistingDirectoryOwner | CorruptDirectoryOwner | MissingDirectoryOwner

function hashLockEvidence(lockDir: string): string {
  const hash = createHash('sha256')
  const entries = fs.readdirSync(lockDir).filter((name) => name !== RECOVERY_CLAIM).sort()
  for (const name of entries) {
    const filePath = path.join(lockDir, name)
    const stat = fs.lstatSync(filePath)
    hash.update(name).update('\0')
    if (stat.isSymbolicLink()) hash.update('symlink')
    else if (stat.isFile()) hash.update('file').update('\0').update(fs.readFileSync(filePath))
    else if (stat.isDirectory()) hash.update('directory')
    else hash.update('other')
    hash.update('\0')
  }
  return hash.digest('hex')
}

function readDirectoryOwner(lockDir: string): DirectoryOwnerEvidence {
  let allEntries: string[]
  let evidenceHash: string
  try {
    allEntries = fs.readdirSync(lockDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', evidenceHash: createHash('sha256').update('unreadable-lock').digest('hex') }
  }
  try {
    evidenceHash = hashLockEvidence(lockDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' }
    return { kind: 'corrupt', evidenceHash: createHash('sha256').update('unreadable-lock').digest('hex') }
  }
  const ownerEntries = allEntries.filter((name) => name.endsWith(OWNER_SUFFIX))
  const heartbeatTempPrefix = ownerEntries.length === 1 ? `.${ownerEntries[0]}.` : ''
  const heartbeatTemps = heartbeatTempPrefix
    ? allEntries.filter((name) => name.startsWith(heartbeatTempPrefix) &&
      /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i
        .test(name.slice(heartbeatTempPrefix.length)))
    : []
  const unexpected = allEntries.filter((name) =>
    name !== RECOVERY_CLAIM && !name.endsWith(OWNER_SUFFIX) && !heartbeatTemps.includes(name))
  if (unexpected.length > 0 || ownerEntries.length !== 1) return { kind: 'corrupt', evidenceHash }
  try {
    for (const name of heartbeatTemps) {
      const stat = fs.lstatSync(path.join(lockDir, name))
      if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'corrupt', evidenceHash }
    }
  } catch {
    return { kind: 'corrupt', evidenceHash }
  }
  const ownerPath = path.join(lockDir, ownerEntries[0])
  try {
    const stat = fs.lstatSync(ownerPath)
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'corrupt', evidenceHash }
    const owner = parseOwner(fs.readFileSync(ownerPath, 'utf8'))
    return owner ? { kind: 'valid', ownerPath, owner, evidenceHash } : { kind: 'corrupt', evidenceHash }
  } catch {
    return { kind: 'corrupt', evidenceHash }
  }
}

interface AcquisitionContext {
  libraryRoot: string
  lockParent: string
  lockDir: string
  rawBootIdentity: string
  hostIdentity: string
  pid: number
  processStartFingerprint: string
  readProcessStart: (pid: number) => string | 'missing' | null
  recoveryClaimCreated?: (claimPath: string) => void
  recoveryClaimObserved?: (claimPath: string) => void
  startedMonotonic: number
}

function sameBoot(owner: LibraryWriterOwner, context: AcquisitionContext): boolean {
  // v1 owners predate host-scoped boot markers. Comparing their raw boot value
  // is required to recover the incident lock after upgrading. New v2 owners
  // use a host-scoped marker, so equal timestamps on two machines cannot collide.
  return owner.schemaVersion === 1
    ? owner.bootIdentity === context.rawBootIdentity
    : owner.bootIdentity === deriveHostBootIdentity(
      context.hostIdentity,
      context.rawBootIdentity,
      owner.hostProofSalt!
    )
}

function staleDecision(
  owner: LibraryWriterOwner,
  context: AcquisitionContext
): 'recover' | Exclude<LibraryWriterBusyReason, 'timeout' | 'corrupt-owner' | 'recovery-in-progress'> {
  if (sameBoot(owner, context)) {
    // schemaVersion 1 is a deliberately time-bounded migration exception. It
    // has no stable host proof, so raw same-boot evidence is accepted only to
    // recover pre-v1.4 incident locks. Every successful/new acquisition below
    // writes v2; remove this compatibility branch with the v1.5 lock-schema
    // cleanup instead of extending it to any future owner schema.
    const currentStart = context.readProcessStart(owner.pid)
    if (currentStart === 'missing') return 'recover'
    if (!currentStart) return 'unverifiable-owner'
    return currentStart === owner.processStartFingerprint ? 'active-owner' : 'recover'
  }
  if (owner.schemaVersion === 2 &&
    owner.hostProof === deriveLibraryHostProof(context.hostIdentity, owner.hostProofSalt!)) return 'recover'
  if (owner.schemaVersion === 2) return 'remote-owner'
  // A legacy owner from a different boot has no stable host proof. deviceId is
  // intentionally not accepted as machine evidence because profiles/reinstalls
  // rotate it and synced Libraries copy it to other machines.
  return 'unverifiable-owner'
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function prepareAcquisition(
  libraryRoot: string,
  options: LibraryWriterLeaseOptions
): AcquisitionContext {
  const platform = options.platform || process.platform
  const pid = options.pid ?? process.pid
  const readProcessStart = options.processStartFingerprint ||
    ((ownerPid) => getProcessStartFingerprint(ownerPid, platform))
  const rawBootIdentity = (options.bootIdentity || (() => getLocalBootIdentity(platform)))()
  const processStartFingerprint = readProcessStart(pid)
  if (!rawBootIdentity || !processStartFingerprint || processStartFingerprint === 'missing') {
    throw new LibraryWriterBusyError('unverifiable-owner')
  }
  const canonicalRoot = canonicalLibraryRootForWrite(libraryRoot)
  const hostIdentity = (options.hostIdentity || (() => getOrCreateHostIdentity({ platform })))()
  if (!hostIdentity) throw new LibraryWriterBusyError('unverifiable-owner')
  const lockParent = path.join(canonicalRoot, '.swob', 'locks')
  ensureSafeLibraryDirectory(canonicalRoot, lockParent)
  const lockDir = path.join(lockParent, 'library-writer')
  assertSafeLibraryWritePath(canonicalRoot, lockDir)
  return {
    libraryRoot: canonicalRoot,
    lockParent,
    lockDir,
    rawBootIdentity,
    hostIdentity,
    pid,
    processStartFingerprint,
    readProcessStart,
    recoveryClaimCreated: options.recoveryClaimCreated,
    recoveryClaimObserved: options.recoveryClaimObserved,
    startedMonotonic: (options.monotonicNow || (() => performance.now()))()
  }
}

function readClaim(lockDir: string): { content: string; claim: RecoveryClaim | null } | null {
  try {
    const content = fs.readFileSync(path.join(lockDir, RECOVERY_CLAIM), 'utf8')
    return { content, claim: parseClaim(content) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { content: '', claim: null }
  }
}

function removeUnchangedClaim(lockDir: string, expectedContent: string): boolean {
  const claimPath = path.join(lockDir, RECOVERY_CLAIM)
  try {
    if (fs.readFileSync(claimPath, 'utf8') !== expectedContent) return false
    fs.unlinkSync(claimPath)
    fsyncDirectorySync(lockDir)
    return true
  } catch {
    return false
  }
}

function claimContentMatches(claimPath: string, expectedContent: string): boolean {
  try {
    return fs.readFileSync(claimPath, 'utf8') === expectedContent
  } catch {
    return false
  }
}

function existingClaimDecision(
  existing: ExistingDirectoryOwner,
  context: AcquisitionContext,
  rawClaim: { content: string; claim: RecoveryClaim | null }
): 'retry' | 'recovery-in-progress' | 'unverifiable-owner' {
  context.recoveryClaimObserved?.(path.join(context.lockDir, RECOVERY_CLAIM))
  if (!rawClaim.claim) {
    // Pre-v2 claims contained only ownerNonce. They have no claimant liveness
    // evidence; once the owner is still proven stale, removing the exact
    // unchanged legacy claim is the only liveness-preserving safe action.
    if (rawClaim.content === existing.owner.ownerNonce && removeUnchangedClaim(context.lockDir, rawClaim.content)) {
      return 'retry'
    }
    return 'unverifiable-owner'
  }
  const claim = rawClaim.claim
  if (claim.ownerEvidenceHash !== existing.evidenceHash ||
    (claim.ownerNonce !== undefined && claim.ownerNonce !== existing.owner.ownerNonce)) {
    return 'unverifiable-owner'
  }
  const localClaimHostProof = deriveLibraryHostProof(context.hostIdentity, claim.claimantHostProofSalt)
  const localClaimBootIdentity = deriveHostBootIdentity(
    context.hostIdentity,
    context.rawBootIdentity,
    claim.claimantHostProofSalt
  )
  if (claim.claimantBootIdentity === localClaimBootIdentity) {
    const currentStart = context.readProcessStart(claim.claimantPid)
    if (currentStart === 'missing' || (currentStart && currentStart !== claim.claimantProcessStartFingerprint)) {
      return removeUnchangedClaim(context.lockDir, rawClaim.content) ? 'retry' : 'recovery-in-progress'
    }
    return currentStart === claim.claimantProcessStartFingerprint
      ? 'recovery-in-progress'
      : 'unverifiable-owner'
  }
  if (claim.claimantHostProof === localClaimHostProof) {
    return removeUnchangedClaim(context.lockDir, rawClaim.content) ? 'retry' : 'recovery-in-progress'
  }
  return 'recovery-in-progress'
}

function createRecoveryClaim(
  existing: ExistingDirectoryOwner,
  context: AcquisitionContext,
  kind: RecoveryClaim['kind'],
  nowMs: number
): { path: string; content: string } | null {
  const claimPath = path.join(context.lockDir, RECOVERY_CLAIM)
  const claimantHostProofSalt = randomUUID()
  const claim: RecoveryClaim = {
    schemaVersion: 1,
    claimNonce: randomUUID(),
    ownerNonce: existing.owner.ownerNonce,
    ownerEvidenceHash: existing.evidenceHash,
    claimantPid: context.pid,
    claimantBootIdentity: deriveHostBootIdentity(
      context.hostIdentity,
      context.rawBootIdentity,
      claimantHostProofSalt
    ),
    claimantProcessStartFingerprint: context.processStartFingerprint,
    claimantHostProof: deriveLibraryHostProof(context.hostIdentity, claimantHostProofSalt),
    claimantHostProofSalt,
    createdAt: new Date(nowMs).toISOString(),
    kind
  }
  const content = JSON.stringify(claim)
  try {
    writeSafeLibraryFileSync(context.libraryRoot, claimPath, content, { exclusive: true, mode: 0o600 })
    fsyncDirectorySync(context.lockDir)
    context.recoveryClaimCreated?.(claimPath)
    return { path: claimPath, content }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Another claimant may atomically quarantine the whole lock directory
    // between our stale read and exclusive claim create. That is a normal race,
    // not corruption; retry against the winner's replacement owner.
    if (code === 'EEXIST' || code === 'ENOENT') return null
    throw error
  }
}

function quarantineClaimedLock(
  context: AcquisitionContext,
  existing: ExistingDirectoryOwner,
  claim: { path: string; content: string },
  requireAutomaticProof: boolean
): string | null {
  const current = readDirectoryOwner(context.lockDir)
  if (current.kind !== 'valid' || current.owner.ownerNonce !== existing.owner.ownerNonce ||
    current.ownerPath !== existing.ownerPath || current.evidenceHash !== existing.evidenceHash ||
    !claimContentMatches(claim.path, claim.content) ||
    (requireAutomaticProof && staleDecision(current.owner, context) !== 'recover')) {
    removeUnchangedClaim(context.lockDir, claim.content)
    return null
  }
  const quarantineDir = path.join(context.lockParent, RECOVERY_QUARANTINE)
  ensureSafeLibraryDirectory(context.libraryRoot, quarantineDir)
  const destination = path.join(
    quarantineDir,
    `library-writer-${Date.now()}-${existing.evidenceHash.slice(0, 12)}-${randomUUID()}`
  )
  assertSafeLibraryWritePath(context.libraryRoot, destination)
  try {
    // Atomic directory rename is the single-winner commit. Evidence is retained
    // instead of deleted, and a losing claimant cannot remove a replacement.
    fs.renameSync(context.lockDir, destination)
    fsyncDirectorySync(context.lockParent)
    fsyncDirectorySync(quarantineDir)
    return destination
  } catch {
    return null
  }
}

function recoverProvenStaleLock(
  context: AcquisitionContext,
  existing: ExistingDirectoryOwner,
  nowMs: number
): 'recovered' | 'retry' | 'recovery-in-progress' | 'unverifiable-owner' {
  const activeClaim = readClaim(context.lockDir)
  if (activeClaim) return existingClaimDecision(existing, context, activeClaim)
  const claim = createRecoveryClaim(existing, context, 'automatic', nowMs)
  if (!claim) return 'retry'
  return quarantineClaimedLock(context, existing, claim, true) ? 'recovered' : 'retry'
}

function tryAcquire(
  libraryRoot: string,
  deviceId: string,
  mode: LibraryWriterMode,
  options: LibraryWriterLeaseOptions,
  context: AcquisitionContext
): LibraryWriterLeaseHandle | Exclude<LibraryWriterBusyReason, 'timeout'> | 'retry' | 'recovered' {
  const now = options.now || Date.now
  const leaseMs = options.leaseMs ?? 15_000
  const heartbeatMs = options.heartbeatMs ?? Math.max(250, Math.floor(leaseMs / 3))
  const acquiredAtMs = now()
  const hostProofSalt = randomUUID()
  const owner: LibraryWriterOwner = {
    schemaVersion: 2,
    ownerNonce: (options.nonce || randomUUID)(),
    deviceId,
    pid: context.pid,
    bootIdentity: deriveHostBootIdentity(context.hostIdentity, context.rawBootIdentity, hostProofSalt),
    processStartFingerprint: context.processStartFingerprint,
    hostProof: deriveLibraryHostProof(context.hostIdentity, hostProofSalt),
    hostProofSalt,
    mode,
    acquiredAt: new Date(acquiredAtMs).toISOString(),
    heartbeatAt: new Date(acquiredAtMs).toISOString(),
    leaseExpiresAt: new Date(acquiredAtMs + leaseMs).toISOString()
  }

  try {
    fs.mkdirSync(context.lockDir, { mode: 0o700 })
    const ownerPath = path.join(context.lockDir, `${owner.ownerNonce}${OWNER_SUFFIX}`)
    try {
      writeOwner(context.libraryRoot, ownerPath, owner, true)
      fsyncDirectorySync(context.lockParent)
    } catch (error) {
      try { fs.rmdirSync(context.lockDir) } catch { /* malformed lock remains fail-closed */ }
      throw error
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = readDirectoryOwner(context.lockDir)
    if (existing.kind === 'missing') return 'retry'
    if (existing.kind === 'corrupt') {
      return 'corrupt-owner'
    }
    const decision = staleDecision(existing.owner, context)
    if (decision !== 'recover') return decision
    const recovery = recoverProvenStaleLock(context, existing, now())
    if (recovery !== 'recovered') return recovery
    emit(libraryRoot, mode, 'stale-recovered', options)
    return 'recovered'
  }

  const ownerPath = path.join(context.lockDir, `${owner.ownerNonce}${OWNER_SUFFIX}`)
  let released = false
  const heartbeat = setInterval(() => {
    if (released || fs.existsSync(path.join(context.lockDir, RECOVERY_CLAIM))) return
    const current = readDirectoryOwner(context.lockDir)
    if (current.kind !== 'valid' || current.owner.ownerNonce !== owner.ownerNonce || current.ownerPath !== ownerPath) return
    const heartbeatAtMs = now()
    owner.heartbeatAt = new Date(heartbeatAtMs).toISOString()
    owner.leaseExpiresAt = new Date(heartbeatAtMs + leaseMs).toISOString()
    try {
      writeOwner(context.libraryRoot, ownerPath, owner, false, options.heartbeatBeforePublish)
    } catch { /* ownership loss remains fail-closed */ }
  }, heartbeatMs)
  heartbeat.unref?.()
  const monotonicNow = options.monotonicNow || (() => performance.now())
  emit(libraryRoot, mode, 'acquire', options, { waitMs: monotonicNow() - context.startedMonotonic })

  return {
    owner,
    release(): void {
      if (released) return
      released = true
      clearInterval(heartbeat)
      try {
        const current = readDirectoryOwner(context.lockDir)
        if (current.kind !== 'valid' || current.owner.ownerNonce !== owner.ownerNonce || current.ownerPath !== ownerPath) return
        fs.unlinkSync(ownerPath)
        fs.rmdirSync(context.lockDir)
        fsyncDirectorySync(context.lockParent)
      } catch { /* already recovered, replaced, or non-empty: fail closed */ }
      emit(libraryRoot, mode, 'release', options)
    }
  }
}

export async function acquireLibraryWriterLease(
  libraryRoot: string,
  deviceId: string,
  mode: LibraryWriterMode,
  options: LibraryWriterLeaseOptions = {}
): Promise<LibraryWriterLeaseHandle> {
  const monotonicNow = options.monotonicNow || (() => performance.now())
  // Multi-process startup legitimately serializes discovery/package checks.
  // Five seconds remains bounded while avoiding false busy failures under the
  // supported 12-process contention contract.
  const timeoutMs = options.timeoutMs ?? 5_000
  const pollMs = options.pollMs ?? 40
  const context = prepareAcquisition(libraryRoot, options)
  let lastReason: LibraryWriterBusyReason = 'timeout'
  let recovered = false
  while (recovered || monotonicNow() - context.startedMonotonic <= timeoutMs) {
    recovered = false
    const result = tryAcquire(libraryRoot, deviceId, mode, options, context)
    if (typeof result !== 'string') return result
    if (result === 'recovered') {
      recovered = true
      continue
    }
    if (result !== 'retry') lastReason = result
    await wait(Math.min(pollMs, Math.max(1, timeoutMs - (monotonicNow() - context.startedMonotonic))))
  }
  emit(libraryRoot, mode, 'contention', options, {
    reason: lastReason,
    waitMs: monotonicNow() - context.startedMonotonic
  })
  throw new LibraryWriterBusyError(lastReason)
}

export function acquireLibraryWriterLeaseSync(
  libraryRoot: string,
  deviceId: string,
  mode: LibraryWriterMode,
  options: LibraryWriterLeaseOptions = {}
): LibraryWriterLeaseHandle {
  const monotonicNow = options.monotonicNow || (() => performance.now())
  const timeoutMs = options.timeoutMs ?? 150
  const pollMs = options.pollMs ?? 15
  const context = prepareAcquisition(libraryRoot, options)
  let lastReason: LibraryWriterBusyReason = 'timeout'
  let recovered = false
  while (recovered || monotonicNow() - context.startedMonotonic <= timeoutMs) {
    recovered = false
    const result = tryAcquire(libraryRoot, deviceId, mode, options, context)
    if (typeof result !== 'string') return result
    if (result === 'recovered') {
      recovered = true
      continue
    }
    if (result !== 'retry') lastReason = result
    sleepSync(Math.min(pollMs, Math.max(1, timeoutMs - (monotonicNow() - context.startedMonotonic))))
  }
  emit(libraryRoot, mode, 'contention', options, {
    reason: lastReason,
    waitMs: monotonicNow() - context.startedMonotonic
  })
  throw new LibraryWriterBusyError(lastReason)
}

export function inspectLibraryWriterLease(
  libraryRoot: string,
  options: LibraryWriterLeaseOptions = {}
): LibraryWriterLeaseInspection {
  const context = prepareAcquisition(libraryRoot, options)
  if (!fs.existsSync(context.lockDir)) {
    return { state: 'unlocked', manualRecoveryAvailable: false, message: 'Library 写锁未占用' }
  }
  const existing = readDirectoryOwner(context.lockDir)
  if (existing.kind === 'missing') {
    return { state: 'unlocked', manualRecoveryAvailable: false, message: 'Library 写锁未占用' }
  }
  if (existing.kind === 'corrupt') {
    return {
      state: 'blocked',
      reason: 'corrupt-owner',
      evidenceHash: existing.evidenceHash,
      manualRecoveryAvailable: true,
      message: BUSY_MESSAGES['corrupt-owner']
    }
  }
  const activeClaim = readClaim(context.lockDir)
  let reason: Exclude<LibraryWriterBusyReason, 'timeout'>
  if (activeClaim) {
    // Inspection is deliberately read-only. Acquisition owns stale-claim
    // cleanup after claimant liveness is checked a second time.
    reason = activeClaim.claim ? 'recovery-in-progress' : 'unverifiable-owner'
  } else {
    const decision = staleDecision(existing.owner, context)
    reason = decision === 'recover' ? 'unverifiable-owner' : decision
  }
  return {
    state: 'blocked',
    reason,
    evidenceHash: existing.evidenceHash,
    manualRecoveryAvailable: reason !== 'active-owner',
    message: BUSY_MESSAGES[reason]
  }
}

export function recoverLibraryWriterLeaseManually(
  libraryRoot: string,
  request: LibraryWriterManualRecoveryRequest,
  options: LibraryWriterLeaseOptions = {}
): LibraryWriterManualRecoveryResult {
  if (request.confirmation !== LIBRARY_WRITER_MANUAL_RECOVERY_CONFIRMATION) {
    return { recovered: false, reason: 'confirmation-required' }
  }
  const context = prepareAcquisition(libraryRoot, options)
  if (!fs.existsSync(context.lockDir)) return { recovered: false, reason: 'unlocked' }
  const first = readDirectoryOwner(context.lockDir)
  if (first.kind === 'missing') return { recovered: false, reason: 'unlocked' }
  if (first.evidenceHash !== request.expectedEvidenceHash) return { recovered: false, reason: 'evidence-changed' }
  if (first.kind === 'valid') {
    const decision = staleDecision(first.owner, context)
    if (decision === 'active-owner') return { recovered: false, reason: decision }
  }
  // A corrupt owner has no trustworthy nonce. Use a synthetic valid envelope
  // only for the claim/quarantine protocol; the corrupt bytes remain untouched.
  const corruptProofSalt = randomUUID()
  const existing: ExistingDirectoryOwner = first.kind === 'valid' ? first : {
    kind: 'valid',
    ownerPath: '',
    evidenceHash: first.evidenceHash,
    owner: {
      schemaVersion: 2,
      ownerNonce: `corrupt-${first.evidenceHash.slice(0, 16)}`,
      deviceId: 'unknown',
      pid: context.pid,
      bootIdentity: deriveHostBootIdentity(context.hostIdentity, context.rawBootIdentity, corruptProofSalt),
      processStartFingerprint: context.processStartFingerprint,
      hostProof: deriveLibraryHostProof(context.hostIdentity, corruptProofSalt),
      hostProofSalt: corruptProofSalt,
      mode: 'maintenance',
      acquiredAt: new Date(0).toISOString(),
      heartbeatAt: new Date(0).toISOString(),
      leaseExpiresAt: new Date(0).toISOString()
    }
  }
  const activeClaim = readClaim(context.lockDir)
  const claim = activeClaim
    ? { path: path.join(context.lockDir, RECOVERY_CLAIM), content: activeClaim.content }
    : createRecoveryClaim(existing, context, 'manual', (options.now || Date.now)())
  if (!claim) return { recovered: false, reason: 'recovery-in-progress' }

  if (first.kind === 'corrupt') {
    const current = readDirectoryOwner(context.lockDir)
    if (current.kind !== 'corrupt' || current.evidenceHash !== request.expectedEvidenceHash ||
      !claimContentMatches(claim.path, claim.content)) {
      removeUnchangedClaim(context.lockDir, claim.content)
      return { recovered: false, reason: 'evidence-changed' }
    }
    const quarantineDir = path.join(context.lockParent, RECOVERY_QUARANTINE)
    ensureSafeLibraryDirectory(context.libraryRoot, quarantineDir)
    const destination = path.join(quarantineDir, `library-writer-${Date.now()}-${first.evidenceHash.slice(0, 12)}-${randomUUID()}`)
    try {
      fs.renameSync(context.lockDir, destination)
      fsyncDirectorySync(context.lockParent)
      return { recovered: true, reason: 'recovered', quarantinePath: destination }
    } catch {
      return { recovered: false, reason: 'evidence-changed' }
    }
  }

  const quarantinePath = quarantineClaimedLock(context, existing, claim, false)
  return quarantinePath
    ? { recovered: true, reason: 'recovered', quarantinePath }
    : { recovered: false, reason: 'evidence-changed' }
}
