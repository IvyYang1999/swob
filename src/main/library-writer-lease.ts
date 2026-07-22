import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { getLocalBootIdentity, getProcessStartFingerprint } from './session-create-lock'
import {
  assertSafeLibraryWritePath,
  canonicalLibraryRootForWrite,
  ensureSafeLibraryDirectory,
  fsyncDirectorySync,
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
  schemaVersion: 1
  ownerNonce: string
  deviceId: string
  pid: number
  bootIdentity: string
  processStartFingerprint: string
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
  eventSink?: (event: LibraryWriterEvent) => void
}

/** Structured in-process telemetry; never contaminates CLI stdout/stderr. */
export function emitLibraryWriterEvent(event: LibraryWriterEvent): void {
  process.emit('swob:library-writer-event', event)
}

export class LibraryWriterBusyError extends Error {
  readonly code = 'LIBRARY_WRITER_BUSY'

  constructor(readonly reason: LibraryWriterBusyReason) {
    super(`Library 正由另一个 Swob 写入（${reason}）；等待超时，请稍后重试`)
    this.name = 'LibraryWriterBusyError'
  }
}

const OWNER_SUFFIX = '.owner.json'
const RECOVERY_CLAIM = 'recovery.claim'
const WRITER_MODES = new Set<LibraryWriterMode>([
  'maintenance', 'package-create', 'transcript', 'metadata', 'move', 'config'
])

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
    if (value.schemaVersion !== 1 || typeof value.ownerNonce !== 'string' || !value.ownerNonce ||
      typeof value.deviceId !== 'string' || !value.deviceId ||
      !Number.isSafeInteger(value.pid) || value.pid! <= 0 ||
      typeof value.bootIdentity !== 'string' || !value.bootIdentity ||
      typeof value.processStartFingerprint !== 'string' || !value.processStartFingerprint ||
      typeof value.mode !== 'string' || !WRITER_MODES.has(value.mode as LibraryWriterMode) ||
      typeof value.acquiredAt !== 'string' || !Number.isFinite(Date.parse(value.acquiredAt)) ||
      typeof value.heartbeatAt !== 'string' || !Number.isFinite(Date.parse(value.heartbeatAt)) ||
      typeof value.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(value.leaseExpiresAt))) return null
    return value as LibraryWriterOwner
  } catch {
    return null
  }
}

function writeOwner(
  libraryRoot: string,
  ownerPath: string,
  owner: LibraryWriterOwner,
  exclusive = false
): void {
  writeSafeLibraryFileSync(libraryRoot, ownerPath, JSON.stringify(owner), { exclusive, mode: 0o600 })
  fsyncDirectorySync(path.dirname(ownerPath))
}

interface ExistingDirectoryOwner {
  ownerPath: string
  owner: LibraryWriterOwner
}

function readDirectoryOwner(lockDir: string): ExistingDirectoryOwner | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(lockDir).filter((name) => name.endsWith(OWNER_SUFFIX))
  } catch {
    return null
  }
  if (entries.length !== 1) return null
  const ownerPath = path.join(lockDir, entries[0])
  try {
    const owner = parseOwner(fs.readFileSync(ownerPath, 'utf-8'))
    return owner ? { ownerPath, owner } : null
  } catch {
    return null
  }
}

function staleDecision(
  owner: LibraryWriterOwner,
  deviceId: string,
  bootIdentity: string,
  nowMs: number,
  readProcessStart: (pid: number) => string | 'missing' | null
): 'recover' | Exclude<LibraryWriterBusyReason, 'timeout'> {
  if (owner.deviceId !== deviceId) return 'remote-owner'
  const leaseExpiresAt = Date.parse(owner.leaseExpiresAt)
  if (!Number.isFinite(leaseExpiresAt)) return 'unverifiable-owner'
  if (owner.bootIdentity !== bootIdentity) return 'recover'
  const currentStart = readProcessStart(owner.pid)
  if (currentStart === 'missing') return 'recover'
  if (!currentStart) return 'unverifiable-owner'
  // Matching boot + PID start proves a live owner regardless of lease or wall
  // clock. Conversely, proven process death is recoverable immediately; making
  // crash recovery wait for lease expiry only extends an outage without adding
  // safety.
  void nowMs
  return currentStart === owner.processStartFingerprint ? 'active-owner' : 'recover'
}

function removeProvenStaleLock(
  context: AcquisitionContext,
  existing: ExistingDirectoryOwner,
  deviceId: string,
  nowMs: number
): boolean {
  const recoveryClaim = path.join(context.lockDir, RECOVERY_CLAIM)
  try {
    writeSafeLibraryFileSync(context.libraryRoot, recoveryClaim, existing.owner.ownerNonce, { exclusive: true })
    fsyncDirectorySync(context.lockDir)
    const current = readDirectoryOwner(context.lockDir)
    if (current?.owner.ownerNonce !== existing.owner.ownerNonce || current.ownerPath !== existing.ownerPath ||
      staleDecision(current.owner, deviceId, context.bootIdentity, nowMs, context.readProcessStart) !== 'recover') {
      fs.unlinkSync(recoveryClaim)
      fsyncDirectorySync(context.lockDir)
      return false
    }
    // Delete only the nonce-specific owner we proved stale. rmdir refuses a
    // replacement/non-empty lock, so an old handle can never delete a new owner.
    fs.unlinkSync(current.ownerPath)
    fs.unlinkSync(recoveryClaim)
    fs.rmdirSync(context.lockDir)
    fsyncDirectorySync(context.lockParent)
    return true
  } catch {
    return false
  }
}

function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, milliseconds)
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

interface AcquisitionContext {
  libraryRoot: string
  lockParent: string
  lockDir: string
  bootIdentity: string
  processStartFingerprint: string
  readProcessStart: (pid: number) => string | 'missing' | null
  startedMonotonic: number
}

function prepareAcquisition(
  libraryRoot: string,
  options: LibraryWriterLeaseOptions
): AcquisitionContext {
  const platform = options.platform || process.platform
  const pid = options.pid ?? process.pid
  const readProcessStart = options.processStartFingerprint ||
    ((ownerPid) => getProcessStartFingerprint(ownerPid, platform))
  const bootIdentity = (options.bootIdentity || (() => getLocalBootIdentity(platform)))()
  const processStartFingerprint = readProcessStart(pid)
  if (!bootIdentity || !processStartFingerprint || processStartFingerprint === 'missing') {
    throw new LibraryWriterBusyError('unverifiable-owner')
  }
  const canonicalRoot = canonicalLibraryRootForWrite(libraryRoot)
  const lockParent = path.join(canonicalRoot, '.swob', 'locks')
  ensureSafeLibraryDirectory(canonicalRoot, lockParent)
  const lockDir = path.join(lockParent, 'library-writer')
  assertSafeLibraryWritePath(canonicalRoot, lockDir)
  return {
    libraryRoot: canonicalRoot,
    lockParent,
    lockDir,
    bootIdentity,
    processStartFingerprint,
    readProcessStart,
    startedMonotonic: (options.monotonicNow || (() => performance.now()))()
  }
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
  const pid = options.pid ?? process.pid
  const acquiredAtMs = now()
  const owner: LibraryWriterOwner = {
    schemaVersion: 1,
    ownerNonce: (options.nonce || randomUUID)(),
    deviceId,
    pid,
    bootIdentity: context.bootIdentity,
    processStartFingerprint: context.processStartFingerprint,
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
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error
    }
    const existing = readDirectoryOwner(context.lockDir)
    if (!existing) return 'unverifiable-owner'
    const decision = staleDecision(existing.owner, deviceId, context.bootIdentity, now(), context.readProcessStart)
    if (decision !== 'recover') return decision
    if (!removeProvenStaleLock(context, existing, deviceId, now())) return 'retry'
    emit(libraryRoot, mode, 'stale-recovered', options)
    return 'recovered'
  }

  const ownerPath = path.join(context.lockDir, `${owner.ownerNonce}${OWNER_SUFFIX}`)
  let released = false
  const heartbeat = setInterval(() => {
    if (released) return
    if (fs.existsSync(path.join(context.lockDir, RECOVERY_CLAIM))) return
    const current = readDirectoryOwner(context.lockDir)
    if (current?.owner.ownerNonce !== owner.ownerNonce || current.ownerPath !== ownerPath) return
    const heartbeatAtMs = now()
    owner.heartbeatAt = new Date(heartbeatAtMs).toISOString()
    owner.leaseExpiresAt = new Date(heartbeatAtMs + leaseMs).toISOString()
    try { writeOwner(context.libraryRoot, ownerPath, owner) } catch { /* ownership loss remains fail-closed */ }
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
  const timeoutMs = options.timeoutMs ?? 2_000
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
