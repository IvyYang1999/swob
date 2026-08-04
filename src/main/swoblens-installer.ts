import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import {
  SWOBLENS_LIMITS,
  type InstalledSwobLensPackage,
  type SwobLensDeclaration,
  type SwobLensManifest,
  type SwobLensPackageList,
  type SwobLensPackagePreview,
  type SwobLensPackageType
} from '../shared/swoblens-manifest'
import {
  SwobLensValidationError,
  compareSwobLensVersions,
  isSafeSwobLensRelativePath,
  validateSwobLensDeclaration,
  validateSwobLensManifest
} from '../shared/swoblens-validator'
import { resolvePathWithinRoot } from './path-containment'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const STATE_FILE = '.state.json'
const EXECUTABLE_EXTENSION = /\.(?:cjs|js|jsx|mjs|ts|tsx|wasm|node|html?|svg|sh|command|bat|cmd|ps1|py|rb|pl|jar|exe|dll|dylib)$/i

interface ParsedZipEntry {
  readonly name: string
  readonly data: Buffer
  readonly compressedSize: number
}

interface StoredPackageState {
  readonly schemaVersion: 1
  readonly digest: string
  readonly enabled: boolean
  readonly installedAt: string
}

export class SwobLensPackageError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SwobLensPackageError'
  }
}

function packageError(code: string, message: string): never {
  throw new SwobLensPackageError(code, message)
}

function asPackageError(error: unknown): never {
  if (error instanceof SwobLensPackageError) throw error
  if (error instanceof SwobLensValidationError) throw new SwobLensPackageError(error.code, error.message)
  throw error
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < CRC_TABLE.length; index++) {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  CRC_TABLE[index] = value >>> 0
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function decodeEntryName(bytes: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    packageError('INVALID_ZIP_NAME', 'ZIP entry name is not valid UTF-8')
  }
}

function rejectUnixLinkExtra(extra: Buffer): void {
  let cursor = 0
  while (cursor < extra.length) {
    if (cursor + 4 > extra.length) packageError('MALFORMED_ZIP', 'ZIP extra field is truncated')
    const id = extra.readUInt16LE(cursor)
    const size = extra.readUInt16LE(cursor + 2)
    cursor += 4
    if (cursor + size > extra.length) packageError('MALFORMED_ZIP', 'ZIP extra field length is invalid')
    // PKWARE Unix metadata can carry link semantics. Declarative packages do
    // not need it, so rejecting it is safer than platform-dependent extraction.
    if (id === 0x000d) packageError('LINK_ENTRY', 'ZIP link metadata is not allowed')
    cursor += size
  }
}

function findEocd(archive: Buffer): number {
  const earliest = Math.max(0, archive.length - 65_557)
  for (let cursor = archive.length - 22; cursor >= earliest; cursor--) {
    if (archive.readUInt32LE(cursor) !== EOCD_SIGNATURE) continue
    const commentLength = archive.readUInt16LE(cursor + 20)
    if (cursor + 22 + commentLength === archive.length) return cursor
  }
  packageError('MALFORMED_ZIP', 'ZIP end-of-central-directory record was not found')
}

function inflateEntry(method: number, compressed: Buffer, expectedBytes: number): Buffer {
  if (method === 0) return Buffer.from(compressed)
  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: expectedBytes + 1 })
  } catch {
    packageError('MALFORMED_ZIP', 'ZIP entry could not be decompressed within its declared limit')
  }
}

function parseZipArchive(archive: Buffer): Map<string, ParsedZipEntry> {
  if (archive.length < 22) packageError('MALFORMED_ZIP', 'Archive is too short to be a ZIP file')
  const eocd = findEocd(archive)
  const disk = archive.readUInt16LE(eocd + 4)
  const centralDisk = archive.readUInt16LE(eocd + 6)
  const entriesOnDisk = archive.readUInt16LE(eocd + 8)
  const entryCount = archive.readUInt16LE(eocd + 10)
  const centralSize = archive.readUInt32LE(eocd + 12)
  const centralOffset = archive.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    packageError('MULTI_DISK_ZIP', 'Multi-disk ZIP archives are not supported')
  }
  if (entryCount === 0 || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    packageError('ZIP64_NOT_ALLOWED', 'Empty and ZIP64 archives are not allowed')
  }
  if (entryCount > SWOBLENS_LIMITS.entries) packageError('TOO_MANY_ENTRIES', 'Archive contains too many files')
  if (centralOffset + centralSize !== eocd || centralOffset < 0 || centralOffset >= archive.length) {
    packageError('MALFORMED_CENTRAL_DIRECTORY', 'ZIP central directory bounds are invalid')
  }

  const entries = new Map<string, ParsedZipEntry>()
  const dataRanges: Array<{ start: number; end: number }> = []
  let totalUncompressed = 0
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocd || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      packageError('MALFORMED_CENTRAL_DIRECTORY', 'ZIP central directory entry is malformed')
    }
    const madeBy = archive.readUInt16LE(cursor + 4)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const expectedCrc = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const extraLength = archive.readUInt16LE(cursor + 30)
    const commentLength = archive.readUInt16LE(cursor + 32)
    const diskStart = archive.readUInt16LE(cursor + 34)
    const externalAttributes = archive.readUInt32LE(cursor + 38)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (centralEnd > eocd || nameLength === 0) packageError('MALFORMED_CENTRAL_DIRECTORY', 'ZIP entry length is invalid')
    if (diskStart !== 0) packageError('MULTI_DISK_ZIP', 'ZIP entry points to another disk')
    if ((flags & ~0x0800) !== 0) packageError('UNSUPPORTED_ZIP_FLAGS', 'Encrypted or streaming ZIP entries are not allowed')
    if (method !== 0 && method !== 8) packageError('UNSUPPORTED_COMPRESSION', 'ZIP entry compression method is unsupported')
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      packageError('ZIP64_NOT_ALLOWED', 'ZIP64 entries are not allowed')
    }
    const nameBytes = archive.subarray(cursor + 46, cursor + 46 + nameLength)
    const name = decodeEntryName(nameBytes)
    const centralExtra = archive.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)
    rejectUnixLinkExtra(centralExtra)
    if (!isSafeSwobLensRelativePath(name) || name.endsWith('/')) packageError('INVALID_PATH', `Unsafe ZIP entry path: ${name}`)
    if (EXECUTABLE_EXTENSION.test(name)) packageError('EXECUTABLE_NOT_ALLOWED', `Executable content is not allowed: ${name}`)
    if (entries.has(name)) packageError('DUPLICATE_ENTRY', `Duplicate ZIP entry: ${name}`)

    const hostSystem = madeBy >>> 8
    const unixMode = externalAttributes >>> 16
    const fileType = unixMode & 0xf000
    if ((hostSystem === 3 || hostSystem === 19) && fileType !== 0 && fileType !== 0x8000) {
      packageError('LINK_ENTRY', `Non-regular ZIP entry is not allowed: ${name}`)
    }
    if (uncompressedSize > SWOBLENS_LIMITS.entryBytes) packageError('ENTRY_TOO_LARGE', `ZIP entry is too large: ${name}`)
    totalUncompressed += uncompressedSize
    if (totalUncompressed > SWOBLENS_LIMITS.totalUncompressedBytes) packageError('ARCHIVE_TOO_LARGE', 'Archive expands beyond the allowed size')
    if (uncompressedSize > 0 && (compressedSize === 0 || uncompressedSize / compressedSize > SWOBLENS_LIMITS.compressionRatio)) {
      packageError('COMPRESSION_BOMB', `ZIP entry compression ratio is too high: ${name}`)
    }

    if (localOffset + 30 > centralOffset || archive.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      packageError('MALFORMED_LOCAL_HEADER', `ZIP local header is invalid: ${name}`)
    }
    const localFlags = archive.readUInt16LE(localOffset + 6)
    const localMethod = archive.readUInt16LE(localOffset + 8)
    const localCrc = archive.readUInt32LE(localOffset + 14)
    const localCompressedSize = archive.readUInt32LE(localOffset + 18)
    const localUncompressedSize = archive.readUInt32LE(localOffset + 22)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const localNameStart = localOffset + 30
    const dataStart = localNameStart + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > centralOffset || localFlags !== flags || localMethod !== method || localCrc !== expectedCrc ||
        localCompressedSize !== compressedSize || localUncompressedSize !== uncompressedSize) {
      packageError('MALFORMED_LOCAL_HEADER', `ZIP local and central headers disagree: ${name}`)
    }
    const localName = decodeEntryName(archive.subarray(localNameStart, localNameStart + localNameLength))
    if (localName !== name) packageError('MALFORMED_LOCAL_HEADER', `ZIP local entry name disagrees: ${name}`)
    rejectUnixLinkExtra(archive.subarray(localNameStart + localNameLength, dataStart))
    if (dataRanges.some((range) => localOffset < range.end && dataEnd > range.start)) {
      packageError('OVERLAPPING_ENTRIES', 'ZIP entries overlap')
    }
    dataRanges.push({ start: localOffset, end: dataEnd })
    const data = inflateEntry(method, archive.subarray(dataStart, dataEnd), uncompressedSize)
    if (data.length !== uncompressedSize || crc32(data) !== expectedCrc) {
      packageError('CHECKSUM_MISMATCH', `ZIP entry checksum or size is invalid: ${name}`)
    }
    entries.set(name, { name, data, compressedSize })
    cursor = centralEnd
  }
  if (cursor !== eocd) packageError('MALFORMED_CENTRAL_DIRECTORY', 'ZIP central directory contains trailing data')
  return entries
}

function parseJson(data: Buffer, label: string): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
    return JSON.parse(text)
  } catch {
    packageError('INVALID_JSON', `${label} is not valid UTF-8 JSON`)
  }
}

async function readStableArchive(sourcePath: string): Promise<Buffer> {
  let handle: fs.promises.FileHandle | null = null
  try {
    const selected = await fs.promises.lstat(sourcePath)
    if (selected.isSymbolicLink()) packageError('LINK_SOURCE', 'Symbolic-link package sources are not allowed')
    handle = await fs.promises.open(sourcePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) packageError('NOT_A_FILE', 'Selected package is not a regular file')
    if (before.size > BigInt(SWOBLENS_LIMITS.archiveBytes)) packageError('ARCHIVE_TOO_LARGE', 'Archive exceeds the compressed size limit')
    const archive = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      packageError('PACKAGE_CHANGED', 'Package changed while it was being validated')
    }
    return archive
  } catch (error) {
    if (error instanceof SwobLensPackageError) throw error
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ELOOP') throw new SwobLensPackageError('LINK_SOURCE', 'Symbolic-link package sources are not allowed')
    throw new SwobLensPackageError('PACKAGE_READ_FAILED', 'Package could not be read')
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function validateArchive(archive: Buffer, sourcePath: string, appVersion: string): SwobLensPackagePreview {
  try {
    const entries = parseZipArchive(archive)
    const manifestEntry = entries.get('manifest.json')
    if (!manifestEntry) packageError('MANIFEST_MISSING', 'Package does not contain manifest.json')
    if (manifestEntry.data.length > SWOBLENS_LIMITS.manifestBytes) packageError('MANIFEST_TOO_LARGE', 'manifest.json is too large')
    const manifest = validateSwobLensManifest(parseJson(manifestEntry.data, 'manifest.json'))
    const expectedNames = new Set(['manifest.json', ...manifest.files.map((file) => file.path)])
    const unexpected = [...entries.keys()].find((name) => !expectedNames.has(name))
    if (unexpected || entries.size !== expectedNames.size) {
      packageError('UNDECLARED_FILE', `Archive contains an undeclared file: ${unexpected || 'unknown'}`)
    }
    for (const file of manifest.files) {
      const entry = entries.get(file.path)
      if (!entry || entry.data.length !== file.bytes || sha256(entry.data) !== file.sha256) {
        packageError('FILE_DIGEST_MISMATCH', `Declared file does not match its digest: ${file.path}`)
      }
    }
    if (compareSwobLensVersions(appVersion, manifest.minSwobVersion) < 0) {
      packageError('APP_VERSION_TOO_OLD', `Package requires Swob ${manifest.minSwobVersion} or newer`)
    }
    const declarationEntry = entries.get(manifest.declaration)
    if (!declarationEntry) packageError('DECLARATION_MISSING', 'Manifest declaration file is missing')
    const declaration = validateSwobLensDeclaration(manifest.type, parseJson(declarationEntry.data, manifest.declaration))
    return {
      sourcePath,
      digest: sha256(archive),
      compressedBytes: archive.length,
      uncompressedBytes: [...entries.values()].reduce((total, entry) => total + entry.data.length, 0),
      manifest,
      declaration
    }
  } catch (error) {
    asPackageError(error)
  }
}

export async function previewSwobLensPackage(sourcePath: string, appVersion: string): Promise<SwobLensPackagePreview> {
  const archive = await readStableArchive(sourcePath)
  return validateArchive(archive, sourcePath, appVersion)
}

function packageRoot(libraryRoot: string): string {
  return resolvePathWithinRoot(libraryRoot, path.join('.swob', 'packages'), { allowRoot: false, allowAbsolute: false })
}

function packageDirectory(libraryRoot: string, id: string): string {
  return resolvePathWithinRoot(packageRoot(libraryRoot), id, { allowRoot: false, allowAbsolute: false })
}

async function writeDurableFile(filePath: string, data: Buffer | string): Promise<void> {
  const handle = await fs.promises.open(filePath, 'wx', 0o600)
  try {
    await handle.writeFile(data)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath)
  const temporary = resolvePathWithinRoot(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`, {
    allowRoot: false,
    allowAbsolute: false
  })
  const backup = resolvePathWithinRoot(directory, `.${path.basename(filePath)}.${crypto.randomUUID()}.bak`, {
    allowRoot: false,
    allowAbsolute: false
  })
  let movedExisting = false
  let preserveBackup = false
  try {
    await writeDurableFile(temporary, `${JSON.stringify(value, null, 2)}\n`)
    if (fs.existsSync(filePath)) {
      await fs.promises.rename(filePath, backup)
      movedExisting = true
    }
    await fs.promises.rename(temporary, filePath)
    if (movedExisting) await fs.promises.rm(backup, { force: true }).catch(() => undefined)
  } catch (error) {
    if (movedExisting && !fs.existsSync(filePath) && fs.existsSync(backup)) {
      try {
        await fs.promises.rename(backup, filePath)
      } catch {
        preserveBackup = true
      }
    }
    throw error
  } finally {
    await fs.promises.rm(temporary, { force: true }).catch(() => undefined)
    if (!preserveBackup) await fs.promises.rm(backup, { force: true }).catch(() => undefined)
  }
}

function validateState(value: unknown): StoredPackageState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) packageError('INVALID_INSTALLED_STATE', 'Installed package state is invalid')
  const state = value as Record<string, unknown>
  const keys = Object.keys(state)
  if (keys.length !== 4 || !['schemaVersion', 'digest', 'enabled', 'installedAt'].every((key) => keys.includes(key))) {
    packageError('INVALID_INSTALLED_STATE', 'Installed package state has unknown or missing fields')
  }
  if (state.schemaVersion !== 1 || typeof state.digest !== 'string' || !/^[a-f0-9]{64}$/.test(state.digest) ||
      typeof state.enabled !== 'boolean' || typeof state.installedAt !== 'string' || Number.isNaN(Date.parse(state.installedAt))) {
    packageError('INVALID_INSTALLED_STATE', 'Installed package state has invalid values')
  }
  return state as unknown as StoredPackageState
}

async function readInstalledDirectory(directory: string): Promise<InstalledSwobLensPackage> {
  const stat = await fs.promises.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) packageError('INVALID_INSTALLED_PACKAGE', 'Installed package is not a regular directory')
  const names = await fs.promises.readdir(directory)
  if (!names.includes('manifest.json') || !names.includes(STATE_FILE)) packageError('INVALID_INSTALLED_PACKAGE', 'Installed package is incomplete')
  const manifestPath = resolvePathWithinRoot(directory, 'manifest.json', { allowRoot: false, allowAbsolute: false, mustExist: true })
  const manifest = validateSwobLensManifest(parseJson(await fs.promises.readFile(manifestPath), 'installed manifest.json'))
  const expectedNames = new Set(['manifest.json', STATE_FILE, manifest.declaration])
  if (names.some((name) => !expectedNames.has(name)) || names.length !== expectedNames.size) {
    packageError('INVALID_INSTALLED_PACKAGE', 'Installed package contains undeclared files')
  }
  const declarationPath = resolvePathWithinRoot(directory, manifest.declaration, { allowRoot: false, allowAbsolute: false, mustExist: true })
  const declarationBuffer = await fs.promises.readFile(declarationPath)
  const declared = manifest.files[0]
  if (declarationBuffer.length !== declared.bytes || sha256(declarationBuffer) !== declared.sha256) {
    packageError('FILE_DIGEST_MISMATCH', 'Installed declaration digest is invalid')
  }
  const declaration = validateSwobLensDeclaration(manifest.type, parseJson(declarationBuffer, manifest.declaration))
  const statePath = resolvePathWithinRoot(directory, STATE_FILE, { allowRoot: false, allowAbsolute: false, mustExist: true })
  const state = validateState(parseJson(await fs.promises.readFile(statePath), STATE_FILE))
  return { manifest, declaration, ...state }
}

async function ensurePackageRoot(libraryRoot: string): Promise<string> {
  const root = packageRoot(libraryRoot)
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 })
  return resolvePathWithinRoot(libraryRoot, root, { allowRoot: false, mustExist: true })
}

/** Recover same-volume transaction remnants before accepting new writes. */
export async function recoverSwobLensTransactions(libraryRoot: string): Promise<void> {
  const root = packageRoot(libraryRoot)
  if (!fs.existsSync(root)) return
  const safeRoot = resolvePathWithinRoot(libraryRoot, root, { allowRoot: false, mustExist: true })
  const names = (await fs.promises.readdir(safeRoot)).filter((name) => name.startsWith('.'))
  for (const name of names) {
    const candidate = resolvePathWithinRoot(safeRoot, name, { allowRoot: false, allowAbsolute: false, mustExist: true })
    const stat = await fs.promises.lstat(candidate)
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue
    if (name.startsWith('.install-')) {
      await fs.promises.rm(candidate, { recursive: true })
      continue
    }
    if (!name.startsWith('.backup-') && !name.startsWith('.remove-')) continue
    let installed: InstalledSwobLensPackage
    try {
      installed = await readInstalledDirectory(candidate)
    } catch {
      // Preserve incomplete evidence for manual inspection; never guess which
      // package an invalid remnant belongs to.
      continue
    }
    const destination = packageDirectory(libraryRoot, installed.manifest.id)
    if (fs.existsSync(destination)) await fs.promises.rm(candidate, { recursive: true })
    else await fs.promises.rename(candidate, destination)
  }
}

export async function installSwobLensPackage(
  sourcePath: string,
  expectedDigest: string,
  libraryRoot: string,
  appVersion: string
): Promise<InstalledSwobLensPackage> {
  const archive = await readStableArchive(sourcePath)
  const preview = validateArchive(archive, sourcePath, appVersion)
  if (preview.digest !== expectedDigest) packageError('PACKAGE_CHANGED', 'Package changed after preview; preview it again')
  const entries = parseZipArchive(archive)
  const root = await ensurePackageRoot(libraryRoot)
  const destination = packageDirectory(libraryRoot, preview.manifest.id)
  const staging = resolvePathWithinRoot(root, `.install-${preview.manifest.id}-${crypto.randomUUID()}`, {
    allowRoot: false,
    allowAbsolute: false
  })
  const backup = resolvePathWithinRoot(root, `.backup-${preview.manifest.id}-${crypto.randomUUID()}`, {
    allowRoot: false,
    allowAbsolute: false
  })
  let movedExisting = false
  try {
    let enabled = true
    if (fs.existsSync(destination)) {
      const existing = await readInstalledDirectory(destination)
      const comparison = compareSwobLensVersions(preview.manifest.version, existing.manifest.version)
      if (comparison === 0) packageError('VERSION_CONFLICT', 'This package version is already installed')
      if (comparison < 0) packageError('DOWNGRADE_NOT_ALLOWED', 'Package downgrade is not allowed')
      enabled = existing.enabled
    }
    await fs.promises.mkdir(staging, { mode: 0o700 })
    await writeDurableFile(path.join(staging, 'manifest.json'), entries.get('manifest.json')!.data)
    await writeDurableFile(path.join(staging, preview.manifest.declaration), entries.get(preview.manifest.declaration)!.data)
    const state: StoredPackageState = {
      schemaVersion: 1,
      digest: preview.digest,
      enabled,
      installedAt: new Date().toISOString()
    }
    await writeDurableFile(path.join(staging, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`)
    if (fs.existsSync(destination)) {
      await fs.promises.rename(destination, backup)
      movedExisting = true
    }
    await fs.promises.rename(staging, destination)
    if (movedExisting) await fs.promises.rm(backup, { recursive: true, force: true })
    return { manifest: preview.manifest, declaration: preview.declaration, ...state }
  } catch (error) {
    if (movedExisting && !fs.existsSync(destination) && fs.existsSync(backup)) {
      await fs.promises.rename(backup, destination).catch(() => undefined)
    }
    if (error instanceof SwobLensPackageError || error instanceof SwobLensValidationError) asPackageError(error)
    packageError('INSTALL_FAILED', 'Package installation failed and was rolled back')
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => undefined)
    await fs.promises.rm(backup, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function listInstalledSwobLensPackages(libraryRoot: string): Promise<SwobLensPackageList> {
  const root = packageRoot(libraryRoot)
  if (!fs.existsSync(root)) return { packages: [], errors: [] }
  const safeRoot = resolvePathWithinRoot(libraryRoot, root, { allowRoot: false, mustExist: true })
  const names = (await fs.promises.readdir(safeRoot)).filter((name) => !name.startsWith('.')).sort()
  const packages: InstalledSwobLensPackage[] = []
  const errors: Array<{ id: string; code: string; message: string }> = []
  for (const name of names) {
    try {
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name)) packageError('INVALID_PACKAGE_ID', 'Installed package directory name is invalid')
      const installed = await readInstalledDirectory(packageDirectory(libraryRoot, name))
      if (installed.manifest.id !== name) packageError('INVALID_PACKAGE_ID', 'Installed package id does not match its directory')
      packages.push(installed)
    } catch (error) {
      const failure = error instanceof SwobLensPackageError || error instanceof SwobLensValidationError
        ? error
        : new SwobLensPackageError('PACKAGE_READ_FAILED', 'Installed package could not be read')
      errors.push({ id: name, code: failure.code, message: failure.message })
    }
  }
  return { packages, errors }
}

async function setStoredEnabled(directory: string, enabled: boolean): Promise<InstalledSwobLensPackage> {
  const installed = await readInstalledDirectory(directory)
  const state: StoredPackageState = {
    schemaVersion: 1,
    digest: installed.digest,
    enabled,
    installedAt: installed.installedAt
  }
  await writeAtomicJson(path.join(directory, STATE_FILE), state)
  return { ...installed, enabled }
}

export async function setSwobLensPackageEnabled(
  libraryRoot: string,
  id: string,
  enabled: boolean
): Promise<InstalledSwobLensPackage> {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) packageError('INVALID_PACKAGE_ID', 'Package id is invalid')
  const target = await readInstalledDirectory(packageDirectory(libraryRoot, id))
  if (enabled && (target.manifest.type === 'theme' || target.manifest.type === 'lens-preset')) {
    const current = await listInstalledSwobLensPackages(libraryRoot)
    for (const sibling of current.packages) {
      if (sibling.manifest.id !== id && sibling.enabled && sibling.manifest.type === target.manifest.type) {
        await setStoredEnabled(packageDirectory(libraryRoot, sibling.manifest.id), false)
      }
    }
  }
  return setStoredEnabled(packageDirectory(libraryRoot, id), enabled)
}

export async function uninstallSwobLensPackage(libraryRoot: string, id: string): Promise<void> {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) packageError('INVALID_PACKAGE_ID', 'Package id is invalid')
  const root = packageRoot(libraryRoot)
  const destination = packageDirectory(libraryRoot, id)
  await readInstalledDirectory(destination)
  const tombstone = resolvePathWithinRoot(root, `.remove-${id}-${crypto.randomUUID()}`, { allowRoot: false, allowAbsolute: false })
  await fs.promises.rename(destination, tombstone)
  try {
    await fs.promises.rm(tombstone, { recursive: true })
  } catch {
    await fs.promises.rename(tombstone, destination).catch(() => undefined)
    packageError('UNINSTALL_FAILED', 'Package uninstall failed and was rolled back')
  }
}

export function packageTypeLabel(type: SwobLensPackageType): string {
  if (type === 'theme') return 'Theme'
  if (type === 'lens-preset') return 'Lens preset'
  return 'Share template'
}
