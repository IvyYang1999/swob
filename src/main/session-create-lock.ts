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

function hashFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function commandOutput(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: 'utf-8', windowsHide: true })
  if (result.error || result.status !== 0) return null
  const output = result.stdout.trim()
  return output || null
}

export function getLocalBootIdentity(platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === 'linux') {
      return hashFingerprint(fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim())
    }
    if (platform === 'darwin') {
      const output = commandOutput('/usr/sbin/sysctl', ['-n', 'kern.boottime'])
      return output ? hashFingerprint(output) : null
    }
    if (platform === 'win32') {
      const output = commandOutput('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks'
      ])
      return output ? hashFingerprint(output) : null
    }
  } catch {
    return null
  }
  return null
}

export function getProcessStartFingerprint(
  pid: number,
  platform: NodeJS.Platform = process.platform
): string | 'missing' | null {
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
      return startTicks ? hashFingerprint(startTicks) : null
    }
    if (platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' })
      if (result.error) return null
      const output = result.stdout.trim()
      if (result.status !== 0 || !output) return 'missing'
      return hashFingerprint(output)
    }
    if (platform === 'win32') {
      const output = commandOutput('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){$p.StartTime.ToUniversalTime().Ticks}else{'MISSING'}`
      ])
      if (output === 'MISSING') return 'missing'
      return output ? hashFingerprint(output) : null
    }
  } catch {
    return null
  }
  return null
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
  const platform = options.platform || process.platform
  const pid = options.pid ?? process.pid
  const readBootIdentity = options.bootIdentity || (() => getLocalBootIdentity(platform))
  const readProcessStart = options.processStartFingerprint || ((ownerPid) => getProcessStartFingerprint(ownerPid, platform))
  const bootIdentity = readBootIdentity()
  const processStartFingerprint = readProcessStart(pid)
  if (!bootIdentity || !processStartFingerprint || processStartFingerprint === 'missing') {
    throw new SessionCreateBusyError('', 'unverifiable-owner')
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
      lastReason = 'unverifiable-owner'
    } else {
      const decision = staleRecoveryDecision(existing, deviceId, bootIdentity, readProcessStart, now())
      if (decision === 'recover') {
        const recoveryClaim = path.join(lockPath, 'recovery.claim')
        try {
          writeSafeLibraryFileSync(libraryRoot, recoveryClaim, existing.ownerNonce, { exclusive: true })
          const current = readDirectoryOwner(lockPath)
          if (current?.owner.ownerNonce === existing.ownerNonce && current.ownerPath === existingRecord?.ownerPath &&
            staleRecoveryDecision(current.owner, deviceId, bootIdentity, readProcessStart, now()) === 'recover') {
            fs.unlinkSync(current.ownerPath)
            fs.unlinkSync(recoveryClaim)
            fs.rmdirSync(lockPath)
            fsyncDirectorySync(lockDir)
          } else {
            fs.unlinkSync(recoveryClaim)
          }
        } catch { /* another writer owns recovery, or evidence changed */ }
        continue
      }
      lastReason = decision
    }
    await wait(Math.min(pollMs, Math.max(1, timeoutMs - (now() - startedAt))))
  }

  throw new SessionCreateBusyError(lockPath, lastReason)
}
