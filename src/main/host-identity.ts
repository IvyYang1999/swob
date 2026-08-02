import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHmac, randomUUID } from 'node:crypto'

interface HostIdentityRecord {
  schemaVersion: 1
  identity: string
  createdAt: string
}

export interface HostIdentityOptions {
  platform?: NodeJS.Platform
  storagePath?: string
  randomId?: () => string
  now?: () => number
}

export class HostIdentityError extends Error {
  readonly code = 'HOST_IDENTITY_UNAVAILABLE'

  constructor(readonly reason: 'corrupt' | 'unsafe-path' | 'unreadable', cause?: unknown) {
    super(`Swob 无法安全读取本机身份（${reason}）；为避免误抢远端写锁，Library 保持只读`)
    this.name = 'HostIdentityError'
    if (cause !== undefined) this.cause = cause
  }
}

/**
 * Host identity is deliberately outside Electron userData and the Library:
 * changing an app profile, HOME, or reinstalling the app must not rotate it,
 * and a synced Library must never upload it. The value is random, not derived
 * from hardware. v1 uses an OS-shared application-support location. A future
 * migration must first copy a valid old record with exclusive create + fsync;
 * it must never generate a replacement while old evidence exists but is
 * unreadable/corrupt, because rotation would turn a local stale lock into an
 * apparently remote lock.
 *
 * Tests use an explicit storagePath (or SWOB_TEST_HOME through the internal
 * resolver) so they never touch machine state. defaultHostIdentityPath itself
 * intentionally ignores HOME and test HOME.
 */
export function defaultHostIdentityPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin') return '/Users/Shared/Swob/host-identity-v1.json'
  if (platform === 'win32') {
    const drive = process.env.SystemDrive && /^[A-Za-z]:$/.test(process.env.SystemDrive)
      ? process.env.SystemDrive
      : 'C:'
    return path.win32.join(`${drive}\\`, 'ProgramData', 'Swob', 'host-identity-v1.json')
  }
  return path.join('/var/tmp', 'swob', 'host-identity-v1.json')
}

function storagePathForRuntime(options: HostIdentityOptions): string {
  if (options.storagePath) return path.resolve(options.storagePath)
  // This is a test-only machine boundary supplied by the repository harness;
  // production never consults HOME or Electron userData.
  if (process.env.SWOB_TEST_HOME) {
    return path.join(path.resolve(process.env.SWOB_TEST_HOME), '.swob-machine', 'host-identity-v1.json')
  }
  return defaultHostIdentityPath(options.platform)
}

function parseRecord(content: string): HostIdentityRecord | null {
  try {
    const value = JSON.parse(content) as Partial<HostIdentityRecord>
    if (value.schemaVersion !== 1 || typeof value.identity !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.identity) ||
      typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) return null
    return value as HostIdentityRecord
  } catch {
    return null
  }
}

function readExisting(filePath: string): HostIdentityRecord {
  try {
    const stat = fs.lstatSync(filePath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new HostIdentityError('unsafe-path')
    const record = parseRecord(fs.readFileSync(filePath, 'utf8'))
    if (!record) throw new HostIdentityError('corrupt')
    return record
  } catch (error) {
    if (error instanceof HostIdentityError) throw error
    throw new HostIdentityError('unreadable', error)
  }
}

function ensureStorageDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  const stat = fs.lstatSync(dirPath)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new HostIdentityError('unsafe-path')
}

export function getOrCreateHostIdentity(options: HostIdentityOptions = {}): string {
  const filePath = storagePathForRuntime(options)
  try {
    if (fs.existsSync(filePath)) return readExisting(filePath).identity
    const dirPath = path.dirname(filePath)
    ensureStorageDirectory(dirPath)
    const record: HostIdentityRecord = {
      schemaVersion: 1,
      identity: (options.randomId || randomUUID)(),
      createdAt: new Date((options.now || Date.now)()).toISOString()
    }
    if (!parseRecord(JSON.stringify(record))) throw new HostIdentityError('corrupt')
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(filePath, 'wx', 0o600)
      fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8')
      fs.fsyncSync(descriptor)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
    }
    try {
      const dirDescriptor = fs.openSync(dirPath, fs.constants.O_RDONLY)
      try { fs.fsyncSync(dirDescriptor) } finally { fs.closeSync(dirDescriptor) }
    } catch { /* best effort on platforms that cannot fsync directories */ }
    return readExisting(filePath).identity
  } catch (error) {
    if (error instanceof HostIdentityError) throw error
    throw new HostIdentityError('unreadable', error)
  }
}

/**
 * Only a challenge-scoped, non-reversible proof may enter the synced Library.
 * The random challenge changes for every lease, so it cannot become a stable
 * cross-Library machine identifier and remains valid if the Library is moved.
 */
export function deriveLibraryHostProof(hostIdentity: string, challengeSalt: string): string {
  return createHmac('sha256', hostIdentity)
    .update(`swob-library-writer-host-proof-v2\0${challengeSalt}`)
    .digest('hex')
}

/** Scope the OS boot marker to this host so equal boot timestamps on two hosts cannot collide. */
export function deriveHostBootIdentity(hostIdentity: string, rawBootIdentity: string, challengeSalt: string): string {
  return createHmac('sha256', hostIdentity)
    .update(`swob-library-writer-boot-v2\0${challengeSalt}\0${rawBootIdentity}`)
    .digest('hex')
}
