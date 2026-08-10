import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { CatalogSessionRecord, PackageLocation, StorageRoot, StorageRootObservation } from '../../shared/contracts/truth-kernel'

export interface CatalogProjectionMetadata {
  providerIds: string[]
  projectIds: string[]
  paths: string[]
  timestamps: string[]
  searchableText: string
}

export interface ManifestCheckpoint {
  relativePath: string
  mtimeMs: number
  size: number
  digest: string
  packageId: string
  logicalSessionId: string
  metadata: CatalogProjectionMetadata
  estimatedArchiveBytes: number
}

export interface ScannedCatalogEntry {
  session: CatalogSessionRecord
  location: PackageLocation
  metadata: CatalogProjectionMetadata
  checkpoint: ManifestCheckpoint
  estimatedArchiveBytes: number
}

export interface ReadOnlyRootScanResult {
  observation: StorageRootObservation
  packageManifestPaths: string[]
  entries: ScannedCatalogEntry[]
  checkpoints: ManifestCheckpoint[]
  diagnostics: string[]
  scannedEntries: number
  reusedManifests: number
  complete: boolean
}

export interface ReadOnlyRootScanOptions {
  maxEntries?: number
  maxManifests?: number
  maxDepth?: number
  maxManifestBytes?: number
  signal?: AbortSignal
  previousCheckpoints?: ManifestCheckpoint[]
}

interface PackageManifest {
  schemaVersion: 3 | 4
  packageId: string
  sessionId?: string
  logicalIdentity: { providerId?: string; sourceFamily?: string; sourceInstance?: { kind: string; id: string }; schemaVersion?: number; sessionId: string }
  sourceBindings?: Array<{ sourceBindingId: string; providerId: string }>
  projectPath?: string
  customTitle?: string
  createdAt?: string
  updatedAt?: string
  backupSize?: number
  content?: { backupSize?: number }
}

const normalize = (value: string): string => value.split(path.sep).join('/')
const matchesRule = (relativePath: string, rule: string): boolean => {
  const normalizedRule = normalize(rule).replace(/^\.\//, '').replace(/\*\*?/g, '')
  return normalizedRule.length === 0 || relativePath === normalizedRule || relativePath.startsWith(`${normalizedRule}/`)
}
const isIncluded = (relativePath: string, root: StorageRoot): boolean =>
  (root.includeRules.length === 0 || root.includeRules.some((rule) => matchesRule(relativePath, rule))) &&
  !root.excludeRules.some((rule) => matchesRule(relativePath, rule))

function parseManifest(text: string): PackageManifest | undefined {
  try {
    const value = JSON.parse(text) as Partial<PackageManifest>
    if ((value.schemaVersion !== 3 && value.schemaVersion !== 4) || typeof value.packageId !== 'string' || !value.packageId) return undefined
    if (!value.logicalIdentity || typeof value.logicalIdentity.sessionId !== 'string' || !value.logicalIdentity.sessionId) return undefined
    const identityProvider = value.logicalIdentity.providerId ?? value.logicalIdentity.sourceFamily
    if (typeof identityProvider !== 'string' || !identityProvider) return undefined
    if (value.logicalIdentity.sourceFamily && (value.logicalIdentity.schemaVersion !== 1 || !value.logicalIdentity.sourceInstance || typeof value.logicalIdentity.sourceInstance.kind !== 'string' || typeof value.logicalIdentity.sourceInstance.id !== 'string')) return undefined
    if (value.sessionId !== undefined && value.sessionId !== value.logicalIdentity.sessionId) return undefined
    if (value.sourceBindings !== undefined && (!Array.isArray(value.sourceBindings) || value.sourceBindings.some((binding) => typeof binding.sourceBindingId !== 'string' || typeof binding.providerId !== 'string'))) return undefined
    const backupSize = value.backupSize ?? value.content?.backupSize
    if (backupSize !== undefined && (!Number.isSafeInteger(backupSize) || backupSize < 0)) return undefined
    return value as PackageManifest
  } catch {
    return undefined
  }
}

function validateRootMarker(root: StorageRoot, localPath: string): string | undefined {
  const markerPath = path.join(localPath, '.swob', 'root.json')
  if (!fs.existsSync(markerPath)) return root.layoutPolicy === 'managed-containers' ? 'root-marker-missing' : undefined
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>
    if (marker.schemaVersion !== 1 || marker.rootId !== root.rootId || marker.kind !== root.kind || marker.layoutPolicy !== root.layoutPolicy) return 'root-marker-mismatch'
    return undefined
  } catch {
    return 'root-marker-invalid'
  }
}

/** Marker-first, budgeted, cancellable discovery. It never follows links or writes the Root. */
export function scanStorageRootReadOnly(root: StorageRoot, localPath: string, deviceId: string, now = new Date().toISOString(), options: ReadOnlyRootScanOptions = {}): ReadOnlyRootScanResult {
  const maxEntries = options.maxEntries ?? 20_000
  const maxManifests = options.maxManifests ?? 10_000
  const maxDepth = options.maxDepth ?? 32
  const maxManifestBytes = options.maxManifestBytes ?? 1024 * 1024
  const prior = new Map((options.previousCheckpoints ?? []).map((item) => [item.relativePath, item]))
  const diagnostics: string[] = []
  const manifests: string[] = []
  const entries: ScannedCatalogEntry[] = []
  let scannedEntries = 0
  let reusedManifests = 0
  let complete = true
  const base: StorageRootObservation = {
    schemaVersion: 1, observationId: `root-observation:${root.rootId}:${now}`, rootId: root.rootId, deviceId,
    permissionState: 'unknown', availabilityState: 'unknown', scanState: 'never-scanned',
    lastSeenAt: { status: 'unavailable', reason: 'not-scanned' }, lastSuccessfulScanAt: { status: 'unavailable', reason: 'not-scanned' },
    failureCode: { status: 'unavailable', reason: 'not-scanned' }, observedAt: now
  }
  const finish = (scanState: StorageRootObservation['scanState'], failure?: string): ReadOnlyRootScanResult => ({
    observation: { ...base, permissionState: 'granted', availabilityState: 'online', scanState,
      lastSeenAt: { status: 'available', value: now },
      lastSuccessfulScanAt: scanState === 'fresh' ? { status: 'available', value: now } : { status: 'unavailable', reason: 'partial-scan' },
      failureCode: failure ? { status: 'available', value: failure } : { status: 'unavailable', reason: 'none' } },
    packageManifestPaths: manifests.sort(), entries, checkpoints: entries.map((item) => item.checkpoint), diagnostics, scannedEntries, reusedManifests, complete
  })
  try {
    if (!fs.statSync(localPath).isDirectory()) throw Object.assign(new Error('not-directory'), { code: 'ENOTDIR' })
    const markerFailure = validateRootMarker(root, localPath)
    if (markerFailure) { diagnostics.push(markerFailure); complete = false; return finish('failed', markerFailure) }
    const queue: Array<{ directory: string; depth: number }> = [{ directory: localPath, depth: 0 }]
    while (queue.length) {
      if (options.signal?.aborted) { diagnostics.push('scan-cancelled'); complete = false; return finish('partial', 'scan-cancelled') }
      const current = queue.shift()!
      let directoryEntries: fs.Dirent[]
      try { directoryEntries = fs.readdirSync(current.directory, { withFileTypes: true }) }
      catch (error) { diagnostics.push(`unreadable-directory:${normalize(path.relative(localPath, current.directory)) || '.'}:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`); complete = false; continue }
      for (const dirent of directoryEntries) {
        scannedEntries += 1
        if (scannedEntries > maxEntries) { diagnostics.push('entry-budget-exceeded'); complete = false; return finish('partial', 'entry-budget-exceeded') }
        if (dirent.isSymbolicLink()) continue
        const candidate = path.join(current.directory, dirent.name)
        const relative = normalize(path.relative(localPath, candidate))
        if (!isIncluded(relative, root)) continue
        if (dirent.isDirectory()) {
          if (current.depth < maxDepth) queue.push({ directory: candidate, depth: current.depth + 1 })
          else { diagnostics.push(`depth-budget-exceeded:${relative}`); complete = false }
          continue
        }
        if (!dirent.isFile() || dirent.name !== '.swob-session.json') continue
        if (manifests.length >= maxManifests) { diagnostics.push('manifest-budget-exceeded'); complete = false; return finish('partial', 'manifest-budget-exceeded') }
        const stat = fs.statSync(candidate)
        if (stat.size > maxManifestBytes) { diagnostics.push(`manifest-too-large:${relative}`); complete = false; continue }
        const cached = prior.get(relative)
        let manifest: PackageManifest | undefined
        let digest: string
        let metadata: CatalogProjectionMetadata
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          digest = cached.digest; metadata = cached.metadata; reusedManifests += 1
          manifest = { schemaVersion: 3, packageId: cached.packageId, logicalIdentity: { providerId: metadata.providerIds[0] ?? 'unknown', sessionId: cached.logicalSessionId }, backupSize: cached.estimatedArchiveBytes }
        } else {
          const text = fs.readFileSync(candidate, 'utf8')
          manifest = parseManifest(text)
          if (!manifest) { diagnostics.push(`malformed-manifest:${relative}`); complete = false; continue }
          digest = createHash('sha256').update(text).digest('hex')
          metadata = {
            providerIds: [...new Set([manifest.logicalIdentity.providerId ?? manifest.logicalIdentity.sourceFamily!, ...(manifest.sourceBindings ?? []).map((item) => item.providerId)])].sort(),
            projectIds: manifest.projectPath ? [manifest.projectPath] : [],
            paths: [normalize(path.dirname(relative)), ...(manifest.projectPath ? [normalize(manifest.projectPath)] : [])],
            timestamps: [manifest.createdAt, manifest.updatedAt].filter((value): value is string => typeof value === 'string'),
            searchableText: [manifest.customTitle, manifest.logicalIdentity.sessionId, manifest.packageId, manifest.projectPath].filter(Boolean).join(' ').normalize('NFC').toLocaleLowerCase()
          }
        }
        manifests.push(candidate)
        const directoryRelative = normalize(path.dirname(relative))
        const estimatedArchiveBytes = manifest.backupSize ?? manifest.content?.backupSize ?? 0
        const checkpoint: ManifestCheckpoint = { relativePath: relative, mtimeMs: stat.mtimeMs, size: stat.size, digest, packageId: manifest.packageId, logicalSessionId: manifest.logicalIdentity.sessionId, metadata, estimatedArchiveBytes }
        entries.push({
          session: { schemaVersion: 1, logicalSessionId: manifest.logicalIdentity.sessionId, sourceBindingIds: (manifest.sourceBindings ?? []).map((item) => item.sourceBindingId), packageIds: [manifest.packageId], state: 'known-archived' },
          location: { schemaVersion: 1, locationId: `${root.rootId}:${manifest.packageId}:${directoryRelative}`, packageId: manifest.packageId, rootId: { status: 'available', value: root.rootId }, deviceId, relativePath: { status: 'available', value: directoryRelative }, standaloneLocatorId: { status: 'unavailable', reason: 'root-bound' }, state: 'online', lastSeenAt: { status: 'available', value: now }, manifestDigest: { status: 'available', value: digest }, observationState: 'current', absenceMeansDeletion: false },
          metadata, checkpoint, estimatedArchiveBytes
        })
      }
    }
    return finish(complete ? 'fresh' : 'partial', complete ? undefined : 'partial-scan')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code || 'scan-failed'
    const denied = code === 'EACCES' || code === 'EPERM'
    const offline = code === 'ENOENT' || code === 'ENODEV'
    return { observation: { ...base, permissionState: denied ? 'denied' : 'unknown', availabilityState: offline ? 'offline' : 'unavailable', scanState: 'failed', failureCode: { status: 'available', value: code } }, packageManifestPaths: [], entries: [], checkpoints: [], diagnostics: [code], scannedEntries, reusedManifests, complete: false }
  }
}
