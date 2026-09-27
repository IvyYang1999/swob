import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { resolveRuntimeHome } from './runtime-home'

interface HostIdentityRecord {
  schemaVersion: 1
  identity: string
  createdAt: string
}

interface HostIdentityBackupRecord extends HostIdentityRecord {
  /** HMAC-SHA256 of identity + createdAt, keyed by this machine's platform identifier. */
  mac: string
}

/** Why a missing primary could not be restored from the backup. */
export type HostIdentityBackupState =
  | 'disabled'
  | 'missing'
  | 'corrupt'
  | 'mismatch'
  | 'unverified'
  | 'unsafe-path'
  | 'unreadable'

export type HostIdentityEvent =
  | { component: 'host-identity'; event: 'host-identity-restored'; source: 'backup' }
  | { component: 'host-identity'; event: 'host-identity-regenerated'; backup: HostIdentityBackupState }
  | { component: 'host-identity'; event: 'host-identity-backup-written'; previous: 'missing' | 'stale' | 'corrupt' }

export interface HostIdentityOptions {
  platform?: NodeJS.Platform
  storagePath?: string
  /**
   * Machine-local second copy of the record, in a different directory from the
   * primary. Only getOrCreateHostIdentity writes it (after reading or publishing
   * the primary) and only a missing primary is restored from it; an explicit
   * storagePath without a backupPath disables it.
   */
  backupPath?: string
  /** The backup's HMAC key material; defaults to the platform machine identifier. */
  machineBinding?: () => string | null
  randomId?: () => string
  now?: () => number
  /** Defaults to process.emit('swob:host-identity-event'); the desktop app logs it to lifecycle.log. */
  eventSink?: (event: HostIdentityEvent) => void
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
 * The primary can still vanish as a whole directory (a cleanup tool, a
 * reinstall): that is how every lock of one machine turned "remote" on
 * 2026-09-26. A second copy therefore lives in the machine-local state
 * directory next to app-config.json (defaultHostIdentityBackupPath), outside
 * the primary's directory and never in Electron userData or the Library. It is
 * only consulted when the primary is missing, and only restores the same
 * record when its HMAC, keyed by the platform machine identifier, verifies: a
 * home directory copied to another computer must not clone this machine's
 * identity, or that computer could take this machine's live locks. The
 * machine identifier is HMAC key material only and is never persisted.
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

/**
 * The backup copy: the machine-local Swob state directory (the one holding
 * app-config.json and the installation deviceId), never Electron userData.
 */
export function defaultHostIdentityBackupPath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const home = resolveRuntimeHome({ platform, nodeEnv: environment.NODE_ENV, env: environment, osHome: os.homedir() })
  return path.join(home, '.claude-session-manager', 'host-identity-v1.json')
}

function storagePathForRuntime(options: HostIdentityOptions): string {
  if (options.storagePath) return path.resolve(options.storagePath)
  // This is a test-only machine boundary supplied by the repository harness;
  // the primary never consults HOME or Electron userData in production.
  if (process.env.SWOB_TEST_HOME) {
    return path.join(path.resolve(process.env.SWOB_TEST_HOME), '.swob-machine', 'host-identity-v1.json')
  }
  return defaultHostIdentityPath(options.platform)
}

function backupPathForRuntime(options: HostIdentityOptions): string | null {
  if (options.backupPath) return path.resolve(options.backupPath)
  if (options.storagePath) return null
  if (process.env.SWOB_TEST_HOME) {
    return path.join(path.resolve(process.env.SWOB_TEST_HOME), '.claude-session-manager', 'host-identity-v1.json')
  }
  return defaultHostIdentityBackupPath(options.platform)
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

function fsyncDirectoryBestEffort(dirPath: string): void {
  try {
    const dirDescriptor = fs.openSync(dirPath, fs.constants.O_RDONLY)
    try { fs.fsyncSync(dirDescriptor) } finally { fs.closeSync(dirDescriptor) }
  } catch { /* best effort on platforms that cannot fsync directories */ }
}

function emitHostIdentityEvent(event: HostIdentityEvent, options: HostIdentityOptions): void {
  try {
    if (options.eventSink) options.eventSink(event)
    else process.emit('swob:host-identity-event', event)
  } catch { /* telemetry must never affect identity resolution */ }
}

// —— machine-local backup ——

const BACKUP_MAC_DOMAIN = 'swob-host-identity-backup-v1'
const machineBindingCache = new Map<string, string | null>()
/**
 * Backups this process verified or wrote, by expected content, with the file's
 * stat signature: later calls cost one lstat, and a backup deleted or replaced
 * while the app runs is written again on the next acquisition.
 */
const confirmedBackups = new Map<string, string>()

function statSignature(stat: fs.Stats): string {
  return `${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

function isolatedTestMachineSeed(): string | null {
  return process.env.NODE_ENV === 'test' && process.env.SWOB_TEST_HOME
    ? path.resolve(process.env.SWOB_TEST_HOME)
    : null
}

/**
 * The platform machine identifier (IOPlatformUUID, /etc/machine-id,
 * MachineGuid), used only as HMAC key material for the backup; null when it
 * cannot be read, which disables the backup. Under the repository test harness
 * it is a seed derived from SWOB_TEST_HOME, never the host's identifier.
 */
export function readHostMachineBinding(platform: NodeJS.Platform = process.platform): string | null {
  const testSeed = isolatedTestMachineSeed()
  const cacheKey = `${platform}:${testSeed || 'host'}`
  if (machineBindingCache.has(cacheKey)) return machineBindingCache.get(cacheKey) ?? null
  let binding: string | null = null
  try {
    if (testSeed) {
      binding = `test-machine:${testSeed}`
    } else if (platform === 'darwin') {
      const result = spawnSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true
      })
      const match = !result.error && result.status === 0
        ? /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"/.exec(result.stdout || '')
        : null
      binding = match ? `io-platform-uuid:${match[1].toUpperCase()}` : null
    } else if (platform === 'linux') {
      for (const file of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const value = fs.readFileSync(file, 'utf8').trim().toLowerCase()
          if (/^[0-9a-f]{32}$/.test(value)) {
            binding = `machine-id:${value}`
            break
          }
        } catch { /* try the next location */ }
      }
    } else if (platform === 'win32') {
      const result = spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true
      })
      const match = !result.error && result.status === 0
        ? /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})/i.exec(result.stdout || '')
        : null
      binding = match ? `machine-guid:${match[1].toLowerCase()}` : null
    }
  } catch {
    binding = null
  }
  machineBindingCache.set(cacheKey, binding)
  return binding
}

function machineBindingFor(options: HostIdentityOptions): string | null {
  try {
    return (options.machineBinding || (() => readHostMachineBinding(options.platform)))() || null
  } catch {
    return null
  }
}

function backupMac(binding: string, identity: string, createdAt: string): string {
  const key = createHash('sha256').update(`${BACKUP_MAC_DOMAIN}\0key\0${binding}`).digest()
  return createHmac('sha256', key).update(`${BACKUP_MAC_DOMAIN}\0${identity}\0${createdAt}`).digest('hex')
}

function backupContent(record: HostIdentityRecord, binding: string): string {
  const backup: HostIdentityBackupRecord = {
    schemaVersion: 1,
    identity: record.identity,
    createdAt: record.createdAt,
    mac: backupMac(binding, record.identity, record.createdAt)
  }
  return JSON.stringify(backup)
}

function parseBackup(content: string): HostIdentityBackupRecord | null {
  const record = parseRecord(content)
  if (!record) return null
  const mac = (record as Partial<HostIdentityBackupRecord>).mac
  return typeof mac === 'string' && /^[0-9a-f]{64}$/.test(mac) ? { ...record, mac } : null
}

type BackupRead =
  | { state: 'valid'; record: HostIdentityRecord }
  | { state: Exclude<HostIdentityBackupState, 'disabled'> }

function readVerifiedBackup(backupPath: string, options: HostIdentityOptions): BackupRead {
  let content: string
  try {
    const stat = fs.lstatSync(backupPath)
    if (stat.isSymbolicLink() || !stat.isFile()) return { state: 'unsafe-path' }
    content = fs.readFileSync(backupPath, 'utf8')
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable' }
  }
  const backup = parseBackup(content)
  if (!backup) return { state: 'corrupt' }
  const binding = machineBindingFor(options)
  if (!binding) return { state: 'unverified' }
  const expected = Buffer.from(backupMac(binding, backup.identity, backup.createdAt), 'hex')
  if (!timingSafeEqual(expected, Buffer.from(backup.mac, 'hex'))) return { state: 'mismatch' }
  return { state: 'valid', record: { schemaVersion: 1, identity: backup.identity, createdAt: backup.createdAt } }
}

function writeBackupAtomically(backupPath: string, content: string): void {
  const dirPath = path.dirname(backupPath)
  ensureStorageDirectory(dirPath)
  const tempPath = path.join(dirPath, `.${path.basename(backupPath)}.${process.pid}.${randomUUID()}.tmp`)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = null
    fs.renameSync(tempPath, backupPath)
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor)
    try { fs.unlinkSync(tempPath) } catch { /* renamed, or never created */ }
  }
  fsyncDirectoryBestEffort(dirPath)
}

/**
 * Keep the backup equal to the primary this process just read or published.
 * Best effort: a backup that cannot be written never blocks the Library writer.
 * A symlink or non-file at the backup path is left untouched.
 */
function syncBackup(record: HostIdentityRecord, backupPath: string, options: HostIdentityOptions): void {
  try {
    const binding = machineBindingFor(options)
    if (!binding) return
    const content = backupContent(record, binding)
    const cacheKey = `${backupPath}\0${content}`
    let previous: 'missing' | 'stale' | 'corrupt' = 'missing'
    try {
      const stat = fs.lstatSync(backupPath)
      if (stat.isSymbolicLink() || !stat.isFile()) return
      if (confirmedBackups.get(cacheKey) === statSignature(stat)) return
      const existing = fs.readFileSync(backupPath, 'utf8')
      if (existing === content) {
        confirmedBackups.set(cacheKey, statSignature(stat))
        return
      }
      previous = parseBackup(existing) ? 'stale' : 'corrupt'
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
    }
    writeBackupAtomically(backupPath, content)
    confirmedBackups.set(cacheKey, statSignature(fs.lstatSync(backupPath)))
    emitHostIdentityEvent({ component: 'host-identity', event: 'host-identity-backup-written', previous }, options)
  } catch { /* best effort */ }
}

export function getOrCreateHostIdentity(options: HostIdentityOptions = {}): string {
  const filePath = storagePathForRuntime(options)
  const backupPath = backupPathForRuntime(options)
  try {
    if (fs.existsSync(filePath)) {
      const existing = readExisting(filePath)
      if (backupPath) syncBackup(existing, backupPath, options)
      return existing.identity
    }
    const dirPath = path.dirname(filePath)
    ensureStorageDirectory(dirPath)
    // The primary is missing. A verified machine-local backup restores the
    // same record, so locks this machine wrote stay provably local; only
    // without one is a new random identity generated.
    const backup: BackupRead | { state: 'disabled' } = backupPath
      ? readVerifiedBackup(backupPath, options)
      : { state: 'disabled' }
    const record: HostIdentityRecord = backup.state === 'valid' ? backup.record : {
      schemaVersion: 1,
      identity: (options.randomId || randomUUID)(),
      createdAt: new Date((options.now || Date.now)()).toISOString()
    }
    if (!parseRecord(JSON.stringify(record))) throw new HostIdentityError('corrupt')
    // Never expose the final path while its JSON is only partially written.
    // A same-directory hard link is an atomic no-clobber publish: exactly one
    // process wins, every loser observes that winner's fully fsynced inode, and
    // existing corrupt/unsafe evidence is never replaced.
    const tempPath = path.join(
      dirPath,
      `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
    )
    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(tempPath, 'wx', 0o600)
      fs.writeFileSync(descriptor, JSON.stringify(record), 'utf8')
      fs.fsyncSync(descriptor)
      fs.closeSync(descriptor)
      descriptor = null
      try {
        fs.linkSync(tempPath, filePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } finally {
      if (descriptor !== null) fs.closeSync(descriptor)
      try { fs.unlinkSync(tempPath) } catch { /* best-effort private temp cleanup */ }
    }
    fsyncDirectoryBestEffort(dirPath)
    const published = readExisting(filePath)
    if (published.identity === record.identity && published.createdAt === record.createdAt) {
      // Only the process whose record won the no-clobber publish reports it.
      emitHostIdentityEvent(backup.state === 'valid'
        ? { component: 'host-identity', event: 'host-identity-restored', source: 'backup' }
        : { component: 'host-identity', event: 'host-identity-regenerated', backup: backup.state }, options)
    }
    if (backupPath) syncBackup(published, backupPath, options)
    return published.identity
  } catch (error) {
    if (error instanceof HostIdentityError) throw error
    throw new HostIdentityError('unreadable', error)
  }
}

/**
 * Read the already-established host identity without creating directories or
 * files. Read-only diagnostics must never mutate machine state merely to decide
 * whether a synced Library lock belongs to this host: this path neither reads
 * nor writes the backup copy.
 */
export function readHostIdentity(options: HostIdentityOptions = {}): string | null {
  const filePath = storagePathForRuntime(options)
  try {
    return readExisting(filePath).identity
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error instanceof HostIdentityError &&
        (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT')) return null
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
