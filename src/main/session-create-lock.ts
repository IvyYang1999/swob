import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { LogicalSessionKey } from './library-session-identity'
import {
  assertSafeLibraryWritePath,
  ensureSafeLibraryDirectory,
  fsyncDirectorySync,
  writeSafeLibraryFileSync
} from './library-path-safety'

export interface SessionCreateLockOwner {
  schemaVersion: 1
  ownerNonce: string
  deviceId: string
  pid: number
  bootIdentity: string
  processStartFingerprint: string
  acquiredAt: string
  leaseExpiresAt: string
}

export interface SessionCreateLockHandle {
  lockPath: string
  owner: SessionCreateLockOwner
  release(): void
}

export interface SessionCreateLockOptions {
  timeoutMs?: number
  pollMs?: number
  leaseMs?: number
  emptyLockGraceMs?: number
  now?: () => number
  nonce?: () => string
  platform?: NodeJS.Platform
  pid?: number
  bootIdentity?: () => string | null
  processStartFingerprint?: (pid: number) => string | 'missing' | null
}

export class SessionCreateBusyError extends Error {
  readonly code = 'SESSION_CREATE_BUSY'

  constructor(readonly lockPath: string, readonly reason: 'active-owner' | 'remote-owner' | 'unverifiable-owner' | 'timeout') {
    super(`Session creation is busy: ${reason}`)
    this.name = 'SessionCreateBusyError'
  }
}

export class SessionCreateIdentityUnavailableError extends Error {
  readonly code = 'WRITER_IDENTITY_UNAVAILABLE'

  constructor(readonly reason: 'boot-identity' | 'process-start') {
    super(`Session writer identity is unavailable (${reason}); no lock was created`)
    this.name = 'SessionCreateIdentityUnavailableError'
  }
}

function hashFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function commandOutput(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf-8', windowsHide: true })
  if (result.error || result.status !== 0) return null
  const output = result.stdout.trim()
  return output || null
}

function isolatedTestIdentitySeed(): string | null {
  return process.env.NODE_ENV === 'test' && process.env.SWOB_TEST_HOME
    ? path.resolve(process.env.SWOB_TEST_HOME)
    : null
}

const bootIdentityCache = new Map<string, string | null>()
const currentProcessStartCache = new Map<string, string | null>()

export function getLocalBootIdentity(platform: NodeJS.Platform = process.platform): string | null {
  const testSeed = isolatedTestIdentitySeed()
  const cacheKey = `${platform}:${testSeed || 'host'}`
  if (bootIdentityCache.has(cacheKey)) return bootIdentityCache.get(cacheKey) || null
  if (testSeed) {
    const result = hashFingerprint(`test-boot:${testSeed}`)
    bootIdentityCache.set(cacheKey, result)
    return result
  }
  let result: string | null = null
  try {
    if (platform === 'linux') {
      result = hashFingerprint(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim())
    }
    if (platform === 'darwin') {
      const output = commandOutput('/usr/sbin/sysctl', ['-n', 'kern.boottime'])
      result = output ? hashFingerprint(output) : null
    }
    if (platform === 'win32') {
      const output = commandOutput('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks'
      ])
      result = output ? hashFingerprint(output) : null
    }
  } catch {
    result = null
  }
  bootIdentityCache.set(cacheKey, result)
  return result
}

export function getProcessStartFingerprint(
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | 'missing' | null {
  const testSeed = isolatedTestIdentitySeed()
  const cacheKey = `${platform}:${testSeed || 'host'}:${pid}`
  if (pid === process.pid && currentProcessStartCache.has(cacheKey)) {
    return currentProcessStartCache.get(cacheKey) || null
  }
  let result: string | 'missing' | null = null
  if (testSeed) {
    try {
      process.kill(pid, 0)
      result = hashFingerprint(`test-process:${testSeed}:${pid}`)
    } catch (error) {
      result = (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'missing' : null
    }
    if (pid === process.pid && result !== 'missing') currentProcessStartCache.set(cacheKey, result)
    return result
  }
  try {
    if (platform === 'linux') {
      const statPath = `/proc/${pid}/stat`
      let content: string
      try {
        content = fs.readFileSync(statPath, 'utf-8')
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : null
      }
      const closeParen = content.lastIndexOf(')')
      if (closeParen < 0) return null
      const fieldsAfterCommand = content.slice(closeParen + 2).trim().split(/\s+/)
      const startTicks = fieldsAfterCommand[19]
      result = startTicks ? hashFingerprint(startTicks) : null
    }
    if (platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' })
      if (result.error) return null
      const output = result.stdout.trim()
      if (result.status !== 0 || !output) return 'missing'
      const fingerprint = hashFingerprint(output)
      if (pid === process.pid) currentProcessStartCache.set(cacheKey, fingerprint)
      return fingerprint
    }
    if (platform === 'win32') {
      const output = commandOutput('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){$p.StartTime.ToUniversalTime().Ticks}else{'MISSING'}`
      ])
      if (output === 'MISSING') return 'missing'
      result = output ? hashFingerprint(output) : null
    }
  } catch {
    return null
  }
  if (pid === process.pid && result !== 'missing') currentProcessStartCache.set(cacheKey, result)
  return result
}

function parseOwner(content: string): SessionCreateLockOwner | null {
  try {
    const value = JSON.parse(content) as Partial<SessionCreateLockOwner>
    if (value.schemaVersion !== 1 || typeof value.ownerNonce !== 'string' ||
      typeof value.deviceId !== 'string' || typeof value.pid !== 'number' ||
      typeof value.bootIdentity !== 'string' || typeof value.processStartFingerprint !== 'string' ||
      typeof value.acquiredAt !== 'string' || typeof value.leaseExpiresAt !== 'string') return null
    return value as SessionCreateLockOwner
  } catch {
    return null
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function staleRecoveryDecision(
  owner: SessionCreateLockOwner,
  deviceId: string,
  localBootIdentity: string,
  readProcessStart: (pid: number) => string | 'missing' | null,
  nowMs: number
): 'recover' | 'active-owner' | 'remote-owner' | 'unverifiable-owner' {
  if (owner.deviceId !== deviceId) return 'remote-owner'
  const leaseExpiresAt = Date.parse(owner.leaseExpiresAt)
  if (!Number.isFinite(leaseExpiresAt)) return 'unverifiable-owner'
  if (owner.bootIdentity !== localBootIdentity) return 'recover'
  const currentStart = readProcessStart(owner.pid)
  if (currentStart === 'missing') return 'recover'
  if (!currentStart) return 'unverifiable-owner'
  if (currentStart !== owner.processStartFingerprint) return 'recover'
  // A matching boot + PID start fingerprint is stronger evidence than a wall
  // clock lease. Forward/backward clock jumps must never evict a live owner.
  void nowMs
  return 'active-owner'
}

interface ExistingDirectoryOwner {
  ownerPath: string
  owner: SessionCreateLockOwner
}

function readDirectoryOwner(lockPath: string): ExistingDirectoryOwner | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(lockPath).filter((name) => name.endsWith('.owner.json'))
  } catch {
    return null
  }
  if (entries.length !== 1) return null
  const ownerPath = path.join(lockPath, entries[0])
  let owner: SessionCreateLockOwner | null = null
  try { owner = parseOwner(fs.readFileSync(ownerPath, 'utf-8')) } catch { /* fail closed */ }
  return owner ? { ownerPath, owner } : null
}

function removeStaleEmptyLockDirectory(
  lockPath: string,
  lockDir: string,
  nowMs: number,
  graceMs: number
): boolean {
  try {
    // A freshly-created empty directory may be between mkdir and owner-file
    // publication. The grace period keeps recovery out of that protocol window;
    // rmdir then atomically proves that no owner file appeared before cleanup.
    const stat = fs.lstatSync(lockPath)
    if (!stat.isDirectory() || stat.isSymbolicLink() || nowMs - stat.mtimeMs < graceMs) return false
    fs.rmdirSync(lockPath)
    fsyncDirectorySync(lockDir)
    return true
  } catch {
    return false
  }
}

function recoverDeadOwner(
  libraryRoot: string,
  lockDir: string,
  lockPath: string,
  existingRecord: ExistingDirectoryOwner,
  deviceId: string,
  bootIdentity: string,
  readProcessStart: (pid: number) => string | 'missing' | null,
  nowMs: number
): boolean {
  const recoveryClaim = path.join(lockPath, 'recovery.claim')
  try {
    writeSafeLibraryFileSync(libraryRoot, recoveryClaim, existingRecord.owner.ownerNonce, { exclusive: true })
    const current = readDirectoryOwner(lockPath)
    if (current?.owner.ownerNonce !== existingRecord.owner.ownerNonce ||
      current.ownerPath !== existingRecord.ownerPath ||
      staleRecoveryDecision(current.owner, deviceId, bootIdentity, readProcessStart, nowMs) !== 'recover') {
      fs.unlinkSync(recoveryClaim)
      return false
    }
    fs.unlinkSync(current.ownerPath)
    fs.unlinkSync(recoveryClaim)
    fs.rmdirSync(lockPath)
    fsyncDirectorySync(lockDir)
    return true
  } catch {
    return false
  }
}

export interface SessionCreateLockRecoveryResult {
  examined: number
  recovered: number
  preserved: number
}

/**
 * Bounded, protocol-aware startup cleanup. Empty directories are removable by
 * atomic rmdir; populated locks are reclaimed only with the same owner proof as
 * normal acquisition. Remote, live, malformed, linked, and unreadable evidence
 * is preserved fail-closed.
 */
export function recoverStaleSessionCreateLocks(
  libraryRoot: string,
  deviceId: string,
  options: Pick<
    SessionCreateLockOptions,
    'now' | 'platform' | 'bootIdentity' | 'processStartFingerprint' | 'emptyLockGraceMs'
  > = {}
): SessionCreateLockRecoveryResult {
  const result: SessionCreateLockRecoveryResult = { examined: 0, recovered: 0, preserved: 0 }
  const platform = options.platform || process.platform
  const bootIdentity = (options.bootIdentity || (() => getLocalBootIdentity(platform)))()
  const now = options.now || Date.now
  const emptyLockGraceMs = options.emptyLockGraceMs ?? 30_000
  if (!bootIdentity) return result
  const uncachedReadProcessStart = options.processStartFingerprint ||
    ((ownerPid: number) => getProcessStartFingerprint(ownerPid, platform))
  const processStarts = new Map<number, string | 'missing' | null>()
  const readProcessStart = (ownerPid: number): string | 'missing' | null => {
    if (!processStarts.has(ownerPid)) processStarts.set(ownerPid, uncachedReadProcessStart(ownerPid))
    return processStarts.get(ownerPid) ?? null
  }
  const lockDir = path.join(libraryRoot, '.swob', 'locks', 'session-create')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(lockDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.preserved++
    return result
  }
  for (const entry of entries) {
    if (!/^[0-9a-f]{64}\.lock$/.test(entry.name)) continue
    result.examined++
    const lockPath = path.join(lockDir, entry.name)
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      result.preserved++
      continue
    }
    let names: string[]
    try { names = fs.readdirSync(lockPath) } catch {
      result.preserved++
      continue
    }
    if (names.length === 0) {
      if (removeStaleEmptyLockDirectory(lockPath, lockDir, now(), emptyLockGraceMs)) result.recovered++
      else result.preserved++
      continue
    }
    const existing = readDirectoryOwner(lockPath)
    if (!existing || staleRecoveryDecision(
      existing.owner,
      deviceId,
      bootIdentity,
      readProcessStart,
      now()
    ) !== 'recover') {
      result.preserved++
      continue
    }
    if (recoverDeadOwner(
      libraryRoot,
      lockDir,
      lockPath,
      existing,
      deviceId,
      bootIdentity,
      readProcessStart,
      now()
    )) result.recovered++
    else result.preserved++
  }
  return result
}

export async function acquireSessionCreateLock(
  libraryRoot: string,
  logicalKey: LogicalSessionKey,
  deviceId: string,
  options: SessionCreateLockOptions = {}
): Promise<SessionCreateLockHandle> {
  const now = options.now || Date.now
  const timeoutMs = options.timeoutMs ?? 2_000
  const pollMs = options.pollMs ?? 40
  const leaseMs = options.leaseMs ?? 30_000
  const emptyLockGraceMs = options.emptyLockGraceMs ?? 30_000
  const platform = options.platform || process.platform
  const pid = options.pid ?? process.pid
  const readBootIdentity = options.bootIdentity || (() => getLocalBootIdentity(platform))
  const readProcessStart = options.processStartFingerprint || ((ownerPid) => getProcessStartFingerprint(ownerPid, platform))
  const bootIdentity = readBootIdentity()
  if (!bootIdentity) throw new SessionCreateIdentityUnavailableError('boot-identity')
  const processStartFingerprint = readProcessStart(pid)
  if (!processStartFingerprint || processStartFingerprint === 'missing') {
    throw new SessionCreateIdentityUnavailableError('process-start')
  }

  const lockDir = path.join(libraryRoot, '.swob', 'locks', 'session-create')
  ensureSafeLibraryDirectory(libraryRoot, lockDir)
  const lockName = `${createHash('sha256').update(logicalKey).digest('hex')}.lock`
  const lockPath = path.join(lockDir, lockName)
  assertSafeLibraryWritePath(libraryRoot, lockPath)
  const startedAt = now()
  let lastReason: SessionCreateBusyError['reason'] = 'timeout'

  while (now() - startedAt <= timeoutMs) {
    const acquiredAtMs = now()
    const owner: SessionCreateLockOwner = {
      schemaVersion: 1,
      ownerNonce: (options.nonce || randomUUID)(),
      deviceId,
      pid,
      bootIdentity,
      processStartFingerprint,
      acquiredAt: new Date(acquiredAtMs).toISOString(),
      leaseExpiresAt: new Date(acquiredAtMs + leaseMs).toISOString()
    }
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      const ownerPath = path.join(lockPath, `${owner.ownerNonce}.owner.json`)
      try {
        writeSafeLibraryFileSync(libraryRoot, ownerPath, JSON.stringify(owner), { exclusive: true })
        fsyncDirectorySync(lockPath)
        fsyncDirectorySync(lockDir)
      } catch (error) {
        try { fs.rmdirSync(lockPath) } catch { /* malformed lock remains fail-closed */ }
        throw error
      }
      return {
        lockPath,
        owner,
        release(): void {
          try {
            // The owner filename is nonce-specific. Removing it can never
            // remove a replacement owner, and rmdir refuses a non-empty lock.
            fs.unlinkSync(ownerPath)
            fs.rmdirSync(lockPath)
            fsyncDirectorySync(lockDir)
          } catch { /* already released, recovered, or replaced */ }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }

    const existingRecord = readDirectoryOwner(lockPath)
    const existing = existingRecord?.owner || null
    if (!existing) {
      if (removeStaleEmptyLockDirectory(lockPath, lockDir, now(), emptyLockGraceMs)) continue
      lastReason = 'unverifiable-owner'
    } else {
      const decision = staleRecoveryDecision(existing, deviceId, bootIdentity, readProcessStart, now())
      if (decision === 'recover') {
        if (existingRecord) recoverDeadOwner(
          libraryRoot,
          lockDir,
          lockPath,
          existingRecord,
          deviceId,
          bootIdentity,
          readProcessStart,
          now()
        )
        continue
      }
      lastReason = decision
    }
    await wait(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))))
  }

  throw new SessionCreateBusyError(lockPath, lastReason)
}
