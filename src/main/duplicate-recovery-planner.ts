import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  buildLogicalSessionIdentityFromMeta,
  isValidLogicalSessionIdentity,
  logicalSessionKey,
  type LogicalSessionIdentity
} from './library-session-identity'
import {
  candidateFromManifest,
  LibrarySessionRegistry,
  type LibrarySessionCandidate
} from './library-session-registry'

const MARKER_FILE = '.swob-session.json'
const BACKUP_FILE = 'backup.jsonl'
const REPORT_SCHEMA_VERSION = 1 as const

export type RecoveryClassification =
  | 'canonical-candidate'
  | 'merge-required'
  | 'manual-review'
  | 'missing-source'
  | 'corrupt'

export type InventoryFileRole =
  | 'manifest'
  | 'backup'
  | 'transcript'
  | 'branch-transcript'
  | 'derived'
  | 'user-file'
  | 'icloud-placeholder'
  | 'symlink'

export interface InventoryFile {
  relativePath: string
  role: InventoryFileRole
  kind: 'file' | 'symlink' | 'other'
  size: number
  mtime: string
  sha256?: string
  symlinkTargetHash?: string
}

export interface SourceEvidence {
  sourcePathId: string
  state: 'not-requested' | 'missing' | 'file' | 'symlink' | 'icloud-placeholder' | 'unreadable'
  size?: number
  mtime?: string
  sha256?: string
}

export interface SafeManifestInventory {
  state: 'valid' | 'corrupt' | 'icloud-placeholder'
  schemaVersion?: number
  packageId?: string
  packageIdHash?: string
  packageState: 'package-id' | 'legacy' | 'unreadable'
  sessionIdHash?: string
  logicalIdentity?: {
    schemaVersion: number
    sourceFamily: string
    sourceInstanceKind: string
    sourceInstanceId: string
  }
  createdAt?: string
  updatedAt?: string
  turnCount?: number
  sourcePathCount: number
  customTitle?: { present: true; sha256: string; codePoints: number }
  notes?: { present: true; sha256: string; bytes: number }
  highlights?: { count: number; sha256: string }
  tags?: { count: number; sha256: string }
  topic?: { present: true; sha256: string }
  backupSha256?: string
  backupSha256State?: 'valid' | 'invalid'
  backupSize?: number
}

export interface PackageInventory {
  pathId: string
  packageTreeHash: string
  isSymlink: boolean
  symlinkTargetHash?: string
  cloudState: 'local' | 'icloud-placeholder'
  inventoryState: 'complete' | 'unreadable'
  manifest: SafeManifestInventory
  files: InventoryFile[]
  sources: SourceEvidence[]
  backupSourceRelationship:
    | 'not-requested'
    | 'identical'
    | 'different'
    | 'missing-source'
    | 'no-source-declared'
    | 'missing-backup'
    | 'unverifiable'
  uniqueEvidence: {
    userFiles: string[]
    branchTranscripts: string[]
    notes: boolean
    highlights: boolean
    backup: boolean
  }
  role: 'canonical' | 'quarantine-candidate' | 'preserve' | 'unresolved'
}

export interface RecoveryMovePlan {
  action: 'future-quarantine'
  fromPathId: string
  quarantinePathId: string
  expectedPackageTreeHash: string
}

export interface ReverseRecoveryPlan {
  action: 'restore-from-quarantine'
  quarantinePathId: string
  originalPathId: string
  expectedPackageTreeHash: string
}

export interface ConflictRecoveryPlan {
  action: 'quarantine-equivalent-duplicates' | 'manual-merge' | 'preserve-all'
  canonicalPathId?: string
  moves: RecoveryMovePlan[]
  reverse: ReverseRecoveryPlan[]
  preconditions: string[]
}

export interface ConflictInventory {
  conflictId: string
  logicalSessionKeyHashes: string[]
  registryReason: 'duplicate-packages' | 'package-id-collision' | 'symlink-only' | 'unresolved-manifest'
  classification: RecoveryClassification
  reasons: string[]
  packages: PackageInventory[]
  recovery: ConflictRecoveryPlan
}

export interface DuplicateRecoveryReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION
  mode: 'dry-run'
  snapshotFingerprint: string
  planId: string
  contentPolicy: {
    bodiesIncluded: false
    titlesIncluded: false
    fullSourcePathsIncluded: false
    filesystemPathsIncluded: false
  }
  sourceHashing: 'enabled' | 'disabled'
  validity: {
    rule: 'rebuild-and-match-snapshot-fingerprint'
    snapshotFingerprint: string
  }
  quarantine: {
    outsideLibraryRequired: true
    verifiedOutsideLibrary: true
    rootId: string
    layout: '<external-quarantine-root>/<planId>/<packagePathId>'
  }
  summary: {
    packageCount: number
    validPackageCount: number
    conflictCount: number
    unresolvedCount: number
    classificationCounts: Record<RecoveryClassification, number>
  }
  conflicts: ConflictInventory[]
}

export interface DuplicateRecoveryPlannerOptions {
  quarantineRoot?: string
  hashSources?: boolean
}

interface RawManifest extends Record<string, unknown> {
  sessionId: string
  sourceFilePaths?: string[]
  logicalIdentity?: LogicalSessionIdentity
  sourceInstance?: {
    kind: 'claude-default' | 'claude-window' | 'other'
    configDir?: string
  }
  schemaVersion?: number
  packageId?: string
  createdAt?: string
  updatedAt: string
  turnCount?: number
  customTitle?: string
  notes?: string
  highlights?: unknown[]
  tags?: string[]
  topic?: string
  backupSha256?: string
  backupSize?: number
}

interface ScannedPackage {
  absolutePath: string
  relativePath: string
  realPath: string
  pathId: string
  isSymlink: boolean
  symlinkTargetHash?: string
  cloudState: 'local' | 'icloud-placeholder'
  inventoryState: 'complete' | 'unreadable'
  manifestState: 'valid' | 'corrupt' | 'icloud-placeholder'
  manifestRawHash?: string
  manifest?: RawManifest
  identity?: LogicalSessionIdentity
  logicalKey?: string
  candidate?: LibrarySessionCandidate
  files: InventoryFile[]
  sources: SourceEvidence[]
  backupSourceRelationship: PackageInventory['backupSourceRelationship']
  packageTreeHash: string
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableJson(child)]))
}

/** Package identity may differ; every other known or future manifest field is evidence. */
function comparableManifestHash(scanned: ScannedPackage): string {
  if (!scanned.manifest) return 'missing'
  const { packageId: _packageId, ...semanticManifest } = scanned.manifest
  return sha256(JSON.stringify(stableJson(semanticManifest)))
}

async function hashFile(filePath: string): Promise<string> {
  const before = fs.statSync(filePath)
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk as Buffer)
  const after = fs.statSync(filePath)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs) throw new Error('inventory-file-changed-during-read')
  return hash.digest('hex')
}

function normalizedRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/') || '.'
}

function pathId(relativePath: string): string {
  return `path:${sha256(relativePath.normalize('NFC')).slice(0, 24)}`
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function resolveThroughExistingAncestor(candidatePath: string): string {
  let ancestor = path.resolve(candidatePath)
  const missingSegments: string[] = []
  for (;;) {
    try {
      fs.lstatSync(ancestor)
      return path.resolve(fs.realpathSync(ancestor), ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw new Error('path-has-no-readable-existing-ancestor')
      missingSegments.unshift(path.basename(ancestor))
      ancestor = parent
    }
  }
}

function safeIso(mtimeMs: number): string {
  return new Date(mtimeMs).toISOString()
}

function fileRole(relativePath: string, kind: 'file' | 'symlink' | 'other'): InventoryFileRole {
  if (kind === 'symlink') return 'symlink'
  if (kind === 'other') return 'user-file'
  const name = path.posix.basename(relativePath)
  if (name.endsWith('.icloud')) return 'icloud-placeholder'
  if (relativePath === MARKER_FILE) return 'manifest'
  if (relativePath === BACKUP_FILE) return 'backup'
  if (relativePath === 'transcript.md') return 'transcript'
  if (/^transcript-(?:intra|branch)-.+\.md$/.test(name)) return 'branch-transcript'
  if (['summary.md', 'tool-calls.md', 'files.md', 'session-summary.json'].includes(name)) return 'derived'
  return 'user-file'
}

async function listPackageFiles(packagePath: string): Promise<InventoryFile[]> {
  const files: InventoryFile[] = []
  async function walk(dirPath: string): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      const relativePath = normalizedRelative(packagePath, fullPath)
      const stat = fs.lstatSync(fullPath)
      if (stat.isSymbolicLink()) {
        let targetHash = 'unreadable'
        try { targetHash = sha256(fs.readlinkSync(fullPath)) } catch { /* state remains unreadable */ }
        files.push({
          relativePath,
          role: fileRole(relativePath, 'symlink'),
          kind: 'symlink',
          size: stat.size,
          mtime: safeIso(stat.mtimeMs),
          symlinkTargetHash: targetHash
        })
      } else if (stat.isDirectory()) {
        await walk(fullPath)
      } else if (stat.isFile()) {
        files.push({
          relativePath,
          role: fileRole(relativePath, 'file'),
          kind: 'file',
          size: stat.size,
          mtime: safeIso(stat.mtimeMs),
          sha256: await hashFile(fullPath)
        })
      } else {
        files.push({
          relativePath,
          role: fileRole(relativePath, 'other'),
          kind: 'other',
          size: stat.size,
          mtime: safeIso(stat.mtimeMs)
        })
      }
    }
  }
  await walk(packagePath)
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function parseManifest(text: string): RawManifest | null {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = parsed as Record<string, unknown>
    if (typeof value.sessionId !== 'string' || !value.sessionId || typeof value.updatedAt !== 'string') return null
    if (value.sourceFilePaths !== undefined &&
      (!Array.isArray(value.sourceFilePaths) || !value.sourceFilePaths.every((item) => typeof item === 'string'))) return null
    return value as RawManifest
  } catch {
    return null
  }
}

function safeTextEvidence(value: unknown): { present: true; sha256: string; bytes: number } | undefined {
  if (typeof value !== 'string') return undefined
  return { present: true, sha256: sha256(value), bytes: Buffer.byteLength(value) }
}

function validTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined
}

function safeManifestInventory(scanned: ScannedPackage): SafeManifestInventory {
  const manifest = scanned.manifest
  if (!manifest) {
    return {
      state: scanned.manifestState,
      packageState: 'unreadable',
      sourcePathCount: 0
    }
  }
  const explicitIdentity = manifest.logicalIdentity
  const rawPackageId = typeof manifest.packageId === 'string' ? manifest.packageId : undefined
  const validPackageId = rawPackageId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawPackageId)
    ? rawPackageId
    : undefined
  const legacy = manifest.schemaVersion !== 3 || !validPackageId ||
    !explicitIdentity || !isValidLogicalSessionIdentity(explicitIdentity)
  const title = typeof manifest.customTitle === 'string'
    ? { present: true as const, sha256: sha256(manifest.customTitle), codePoints: Array.from(manifest.customTitle).length }
    : undefined
  const notes = safeTextEvidence(manifest.notes)
  const highlights = Array.isArray(manifest.highlights)
    ? { count: manifest.highlights.length, sha256: sha256(JSON.stringify(manifest.highlights)) }
    : undefined
  const tags = Array.isArray(manifest.tags) && manifest.tags.every((tag) => typeof tag === 'string')
    ? { count: manifest.tags.length, sha256: sha256(JSON.stringify(manifest.tags)) }
    : undefined
  const topic = typeof manifest.topic === 'string'
    ? { present: true as const, sha256: sha256(manifest.topic) }
    : undefined
  const backupSha256 = typeof manifest.backupSha256 === 'string' && /^[0-9a-f]{64}$/i.test(manifest.backupSha256)
    ? manifest.backupSha256.toLowerCase()
    : undefined
  return {
    state: 'valid',
    ...(Number.isInteger(manifest.schemaVersion) && Number(manifest.schemaVersion) > 0
      ? { schemaVersion: manifest.schemaVersion } : {}),
    ...(validPackageId ? { packageId: validPackageId } : {}),
    ...(!validPackageId && rawPackageId ? { packageIdHash: sha256(rawPackageId) } : {}),
    packageState: legacy ? 'legacy' : 'package-id',
    sessionIdHash: sha256(manifest.sessionId),
    logicalIdentity: scanned.identity ? {
      schemaVersion: scanned.identity.schemaVersion,
      sourceFamily: scanned.identity.sourceFamily,
      sourceInstanceKind: scanned.identity.sourceInstance.kind,
      sourceInstanceId: scanned.identity.sourceInstance.id
    } : undefined,
    ...(validTimestamp(manifest.createdAt) ? { createdAt: validTimestamp(manifest.createdAt) } : {}),
    ...(validTimestamp(manifest.updatedAt) ? { updatedAt: validTimestamp(manifest.updatedAt) } : {}),
    ...(Number.isInteger(manifest.turnCount) && Number(manifest.turnCount) >= 0
      ? { turnCount: manifest.turnCount } : {}),
    sourcePathCount: manifest.sourceFilePaths?.length || 0,
    ...(title ? { customTitle: title } : {}),
    ...(notes ? { notes } : {}),
    ...(highlights ? { highlights } : {}),
    ...(tags ? { tags } : {}),
    ...(topic ? { topic } : {}),
    ...(backupSha256 ? { backupSha256, backupSha256State: 'valid' as const } :
      typeof manifest.backupSha256 === 'string' ? { backupSha256State: 'invalid' as const } : {}),
    ...(Number.isFinite(manifest.backupSize) && Number(manifest.backupSize) >= 0
      ? { backupSize: manifest.backupSize } : {})
  }
}

async function sourceEvidence(sourcePath: string, hashSources: boolean): Promise<SourceEvidence> {
  const physicalPath = sourcePath.split('#')[0]
  const result: SourceEvidence = { sourcePathId: `source:${sha256(sourcePath).slice(0, 24)}`, state: 'not-requested' }
  if (!hashSources) return result
  try {
    const stat = fs.lstatSync(physicalPath)
    if (stat.isSymbolicLink()) return { ...result, state: 'symlink', size: stat.size, mtime: safeIso(stat.mtimeMs) }
    if (!stat.isFile()) return { ...result, state: 'unreadable', size: stat.size, mtime: safeIso(stat.mtimeMs) }
    return {
      ...result,
      state: physicalPath.endsWith('.icloud') ? 'icloud-placeholder' : 'file',
      size: stat.size,
      mtime: safeIso(stat.mtimeMs),
      sha256: await hashFile(physicalPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const placeholder = path.join(path.dirname(physicalPath), `.${path.basename(physicalPath)}.icloud`)
      if (fs.existsSync(placeholder)) return { ...result, state: 'icloud-placeholder' }
      return { ...result, state: 'missing' }
    }
    return { ...result, state: 'unreadable' }
  }
}

function backupRelationship(
  files: InventoryFile[],
  sources: SourceEvidence[],
  hashSources: boolean
): PackageInventory['backupSourceRelationship'] {
  if (!hashSources) return 'not-requested'
  const backup = files.find((file) => file.relativePath === BACKUP_FILE && file.kind === 'file')
  if (!backup?.sha256) return 'missing-backup'
  if (sources.length === 0) return 'no-source-declared'
  if (sources.some((source) => source.state === 'file' && source.sha256 === backup.sha256)) return 'identical'
  if (sources.some((source) => source.state === 'file' && source.sha256 !== backup.sha256)) return 'different'
  if (sources.every((source) => source.state === 'missing')) return 'missing-source'
  return 'unverifiable'
}

async function scanPackage(
  libraryRoot: string,
  discoveredPath: string,
  isSymlink: boolean,
  hashSources: boolean
): Promise<ScannedPackage> {
  let realPath = discoveredPath
  let symlinkTargetHash: string | undefined
  if (isSymlink) {
    try {
      const target = fs.readlinkSync(discoveredPath)
      symlinkTargetHash = sha256(target)
      realPath = fs.realpathSync(discoveredPath)
    } catch {
      symlinkTargetHash = 'unreadable'
    }
  }
  const relativePath = normalizedRelative(libraryRoot, discoveredPath)
  const markerPath = path.join(realPath, MARKER_FILE)
  const markerPlaceholder = path.join(realPath, `.${MARKER_FILE}.icloud`)
  let manifestState: ScannedPackage['manifestState'] = 'corrupt'
  let manifest: RawManifest | undefined
  let manifestRawHash: string | undefined
  if (fs.existsSync(markerPlaceholder) && !fs.existsSync(markerPath)) {
    manifestState = 'icloud-placeholder'
  } else {
    try {
      const text = fs.readFileSync(markerPath, 'utf-8')
      manifestRawHash = sha256(text)
      manifest = parseManifest(text) || undefined
      manifestState = manifest ? 'valid' : 'corrupt'
    } catch {
      manifestState = 'corrupt'
    }
  }
  let identity: LogicalSessionIdentity | undefined
  let logicalKey: string | undefined
  let candidate: LibrarySessionCandidate | undefined
  if (manifest) {
    identity = buildLogicalSessionIdentityFromMeta(manifest)
    logicalKey = logicalSessionKey(identity)
    candidate = candidateFromManifest(realPath, manifest, isSymlink)
  }
  let files: InventoryFile[] = []
  let inventoryState: ScannedPackage['inventoryState'] = 'complete'
  try { files = await listPackageFiles(realPath) } catch { inventoryState = 'unreadable' }
  const sources = manifest
    ? await Promise.all((manifest.sourceFilePaths || []).map((sourcePath) => sourceEvidence(sourcePath, hashSources)))
    : []
  const cloudState = manifestState === 'icloud-placeholder' || files.some((file) => file.role === 'icloud-placeholder')
    ? 'icloud-placeholder'
    : 'local'
  const packageTreeHash = sha256(JSON.stringify({
    path: relativePath,
    isSymlink,
    symlinkTargetHash,
    manifestState,
    inventoryState,
    manifestRawHash,
    files
  }))
  return {
    absolutePath: discoveredPath,
    relativePath,
    realPath,
    pathId: pathId(relativePath),
    isSymlink,
    symlinkTargetHash,
    cloudState,
    inventoryState,
    manifestState,
    manifestRawHash,
    manifest,
    identity,
    logicalKey,
    candidate,
    files,
    sources,
    backupSourceRelationship: backupRelationship(files, sources, hashSources),
    packageTreeHash
  }
}

async function discoverPackages(libraryRoot: string, hashSources: boolean): Promise<ScannedPackage[]> {
  const packages: ScannedPackage[] = []
  async function walk(dirPath: string): Promise<void> {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.swob') continue
      const fullPath = path.join(dirPath, entry.name)
      const stat = fs.lstatSync(fullPath)
      const isSymlink = stat.isSymbolicLink()
      let packagePath = fullPath
      let isDirectory = stat.isDirectory()
      if (isSymlink) {
        try {
          packagePath = fs.realpathSync(fullPath)
          isDirectory = fs.statSync(packagePath).isDirectory()
        } catch {
          continue
        }
      }
      if (!isDirectory) continue
      const hasMarker = fs.existsSync(path.join(packagePath, MARKER_FILE))
      const hasCloudMarker = fs.existsSync(path.join(packagePath, `.${MARKER_FILE}.icloud`))
      if (hasMarker || hasCloudMarker) {
        packages.push(await scanPackage(libraryRoot, fullPath, isSymlink, hashSources))
      } else if (!isSymlink) {
        await walk(fullPath)
      }
    }
  }
  await walk(libraryRoot)
  return packages.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

function comparableContentHash(scanned: ScannedPackage): string {
  return sha256(JSON.stringify(scanned.files
    .filter((file) => file.relativePath !== MARKER_FILE)
    .map((file) => ({
      relativePath: file.relativePath,
      role: file.role,
      kind: file.kind,
      size: file.size,
      sha256: file.sha256,
      symlinkTargetHash: file.symlinkTargetHash
    }))))
}

function uniquePaths(packages: ScannedPackage[], role: InventoryFileRole): Map<string, Set<string>> {
  const signatures = new Map<string, Set<string>>()
  for (const candidate of packages) {
    const own = new Set(candidate.files.filter((file) => file.role === role)
      .map((file) => `${file.relativePath}\0${file.sha256 || file.symlinkTargetHash || ''}`))
    signatures.set(candidate.pathId, own)
  }
  return signatures
}

function hasUniqueEvidence(signatures: Map<string, Set<string>>, packageId: string): string[] {
  const own = signatures.get(packageId) || new Set<string>()
  const others = new Set([...signatures.entries()]
    .filter(([candidate]) => candidate !== packageId)
    .flatMap(([, values]) => [...values]))
  return [...own].filter((signature) => !others.has(signature))
    .map((signature) => signature.split('\0')[0]).sort()
}

function classificationFor(
  registryReason: ConflictInventory['registryReason'],
  packages: ScannedPackage[],
  hashSources: boolean
): { classification: RecoveryClassification; reasons: string[] } {
  const reasons: string[] = []
  if (packages.some((candidate) => candidate.manifestState === 'corrupt')) {
    return { classification: 'corrupt', reasons: ['manifest-corrupt-or-unreadable'] }
  }
  if (packages.some((candidate) => candidate.inventoryState === 'unreadable' ||
    candidate.files.some((file) => file.kind === 'other'))) {
    return { classification: 'manual-review', reasons: ['file-inventory-incomplete-or-special-file'] }
  }
  if (packages.some((candidate) => candidate.manifestState === 'icloud-placeholder' || candidate.cloudState === 'icloud-placeholder')) {
    return { classification: 'manual-review', reasons: ['icloud-placeholder-not-materialized'] }
  }
  if (registryReason === 'package-id-collision') {
    return { classification: 'manual-review', reasons: ['package-id-collision-across-logical-identities'] }
  }
  if (registryReason === 'symlink-only' || packages.every((candidate) => candidate.isSymlink)) {
    return { classification: 'manual-review', reasons: ['physical-package-not-proven'] }
  }
  if (packages.some((candidate) => candidate.isSymlink ||
    candidate.files.some((file) => file.kind === 'symlink'))) {
    return { classification: 'manual-review', reasons: ['symlink-evidence-requires-manual-review'] }
  }
  if (packages.some((candidate) => safeManifestInventory(candidate).packageState !== 'package-id')) {
    return { classification: 'manual-review', reasons: ['legacy-package-identity'] }
  }
  if (packages.some((candidate) => {
    const declared = candidate.manifest?.backupSha256
    const actual = candidate.files.find((file) => file.relativePath === BACKUP_FILE)?.sha256
    return typeof declared === 'string' && declared !== actual
  })) {
    return { classification: 'manual-review', reasons: ['manifest-backup-hash-mismatch'] }
  }

  const contentHashes = new Set(packages.map(comparableContentHash))
  const manifestHashes = new Set(packages.map(comparableManifestHash))
  const backupHashes = new Set(packages.map((candidate) =>
    candidate.files.find((file) => file.relativePath === BACKUP_FILE)?.sha256 || 'missing'))
  const noteHashes = new Set(packages.map((candidate) => safeManifestInventory(candidate).notes?.sha256 || 'missing'))
  const highlightHashes = new Set(packages.map((candidate) => safeManifestInventory(candidate).highlights?.sha256 || 'missing'))
  const titleHashes = new Set(packages.map((candidate) => safeManifestInventory(candidate).customTitle?.sha256 || 'missing'))
  const tagHashes = new Set(packages.map((candidate) => safeManifestInventory(candidate).tags?.sha256 || 'missing'))
  const topicHashes = new Set(packages.map((candidate) => safeManifestInventory(candidate).topic?.sha256 || 'missing'))
  const userSignatures = uniquePaths(packages, 'user-file')
  const branchSignatures = uniquePaths(packages, 'branch-transcript')
  const anyUniqueUserFile = packages.some((candidate) => hasUniqueEvidence(userSignatures, candidate.pathId).length > 0)
  const anyUniqueBranch = packages.some((candidate) => hasUniqueEvidence(branchSignatures, candidate.pathId).length > 0)
  if (backupHashes.size > 1) reasons.push('backup-content-diverges')
  if (manifestHashes.size > 1) reasons.push('manifest-fields-diverge')
  if (noteHashes.size > 1) reasons.push('notes-diverge')
  if (highlightHashes.size > 1) reasons.push('highlights-diverge')
  if (titleHashes.size > 1) reasons.push('custom-title-diverges')
  if (tagHashes.size > 1) reasons.push('tags-diverge')
  if (topicHashes.size > 1) reasons.push('topic-diverges')
  if (anyUniqueUserFile) reasons.push('unique-user-files')
  if (anyUniqueBranch) reasons.push('unique-branch-transcripts')
  if (contentHashes.size > 1 && reasons.length === 0) reasons.push('package-content-diverges')
  if (reasons.length > 0) return { classification: 'merge-required', reasons: reasons.sort() }

  const relationships = packages.map((candidate) => candidate.backupSourceRelationship)
  if (relationships.every((relationship) =>
    relationship === 'missing-source' || relationship === 'no-source-declared')) {
    return { classification: 'missing-source', reasons: ['all-declared-sources-missing'] }
  }
  if (!hashSources) {
    return { classification: 'manual-review', reasons: ['source-hashing-not-requested'] }
  }
  if (relationships.every((relationship) => relationship === 'identical')) {
    return { classification: 'canonical-candidate', reasons: ['packages-byte-equivalent-and-backup-matches-source'] }
  }
  return { classification: 'manual-review', reasons: ['backup-source-equivalence-not-proven'] }
}

function candidateOrder(a: ScannedPackage, b: ScannedPackage): number {
  const aPackageId = safeManifestInventory(a).packageId || ''
  const bPackageId = safeManifestInventory(b).packageId || ''
  return aPackageId.localeCompare(bPackageId) || a.pathId.localeCompare(b.pathId)
}

function buildConflict(
  registryReason: ConflictInventory['registryReason'],
  packages: ScannedPackage[],
  quarantineRoot: string,
  snapshotFingerprint: string,
  hashSources: boolean
): ConflictInventory {
  const sorted = [...packages].sort(candidateOrder)
  const logicalSessionKeyHashes = [...new Set(sorted.flatMap((candidate) =>
    candidate.logicalKey ? [sha256(candidate.logicalKey)] : []))].sort()
  const conflictId = `conflict:${sha256(JSON.stringify({
    registryReason,
    logicalSessionKeyHashes,
    pathIds: sorted.map((candidate) => candidate.pathId)
  })).slice(0, 24)}`
  const { classification, reasons } = classificationFor(registryReason, sorted, hashSources)
  const canonical = classification === 'canonical-candidate' ? sorted[0] : undefined
  const userSignatures = uniquePaths(sorted, 'user-file')
  const branchSignatures = uniquePaths(sorted, 'branch-transcript')
  const noteHashes = new Map(sorted.map((candidate) => [candidate.pathId, safeManifestInventory(candidate).notes?.sha256]))
  const highlightHashes = new Map(sorted.map((candidate) => [candidate.pathId, safeManifestInventory(candidate).highlights?.sha256]))
  const backupHashes = new Map(sorted.map((candidate) => [candidate.pathId,
    candidate.files.find((file) => file.relativePath === BACKUP_FILE)?.sha256]))
  const allNotes = new Set(noteHashes.values())
  const allHighlights = new Set(highlightHashes.values())
  const allBackups = new Set(backupHashes.values())
  const inventories: PackageInventory[] = sorted.map((candidate) => ({
    pathId: candidate.pathId,
    packageTreeHash: candidate.packageTreeHash,
    isSymlink: candidate.isSymlink,
    ...(candidate.symlinkTargetHash ? { symlinkTargetHash: candidate.symlinkTargetHash } : {}),
    cloudState: candidate.cloudState,
    inventoryState: candidate.inventoryState,
    manifest: safeManifestInventory(candidate),
    files: candidate.files,
    sources: candidate.sources,
    backupSourceRelationship: candidate.backupSourceRelationship,
    uniqueEvidence: {
      userFiles: hasUniqueEvidence(userSignatures, candidate.pathId),
      branchTranscripts: hasUniqueEvidence(branchSignatures, candidate.pathId),
      notes: allNotes.size > 1 && noteHashes.get(candidate.pathId) !== undefined,
      highlights: allHighlights.size > 1 && highlightHashes.get(candidate.pathId) !== undefined,
      backup: allBackups.size > 1 && backupHashes.get(candidate.pathId) !== undefined
    },
    role: candidate === canonical
      ? 'canonical'
      : canonical && !candidate.isSymlink ? 'quarantine-candidate'
        : candidate.manifest ? 'preserve' : 'unresolved'
  }))
  const moves: RecoveryMovePlan[] = inventories
    .filter((candidate) => candidate.role === 'quarantine-candidate')
    .map((candidate) => ({
      action: 'future-quarantine',
      fromPathId: candidate.pathId,
      quarantinePathId: `quarantine:${sha256(`${quarantineRoot}\0${snapshotFingerprint}\0${candidate.pathId}`).slice(0, 24)}`,
      expectedPackageTreeHash: candidate.packageTreeHash
    }))
  return {
    conflictId,
    logicalSessionKeyHashes,
    registryReason,
    classification,
    reasons,
    packages: inventories,
    recovery: {
      action: classification === 'canonical-candidate'
        ? 'quarantine-equivalent-duplicates'
        : classification === 'merge-required' ? 'manual-merge' : 'preserve-all',
      ...(canonical ? { canonicalPathId: canonical.pathId } : {}),
      moves,
      reverse: moves.map((move) => ({
        action: 'restore-from-quarantine',
        quarantinePathId: move.quarantinePathId,
        originalPathId: move.fromPathId,
        expectedPackageTreeHash: move.expectedPackageTreeHash
      })),
      preconditions: [
        `snapshot-fingerprint=${snapshotFingerprint}`,
        'all-package-tree-hashes-match',
        'quarantine-root-remains-outside-library',
        'no-target-path-exists'
      ]
    }
  }
}

function defaultQuarantineRoot(libraryRoot: string): string {
  return path.join(path.dirname(libraryRoot), `${path.basename(libraryRoot)}.swob-quarantine`)
}

export async function buildDuplicateRecoveryReport(
  libraryRootInput: string,
  options: DuplicateRecoveryPlannerOptions = {}
): Promise<DuplicateRecoveryReport> {
  if (!libraryRootInput || typeof libraryRootInput !== 'string') throw new Error('explicit-library-root-required')
  const libraryRoot = fs.realpathSync(path.resolve(libraryRootInput))
  const rootStat = fs.statSync(libraryRoot)
  if (!rootStat.isDirectory()) throw new Error('library-root-must-be-directory')
  const quarantineRoot = resolveThroughExistingAncestor(
    options.quarantineRoot || defaultQuarantineRoot(libraryRoot)
  )
  if (isInside(libraryRoot, quarantineRoot)) throw new Error('quarantine-root-must-be-outside-library')
  const hashSources = options.hashSources === true
  const scanned = await discoverPackages(libraryRoot, hashSources)
  const snapshotFingerprint = sha256(JSON.stringify(scanned.map((candidate) => ({
    pathId: candidate.pathId,
    packageTreeHash: candidate.packageTreeHash,
    sourceEvidence: candidate.sources
  }))))
  const planId = `plan:${snapshotFingerprint.slice(0, 24)}`

  const registry = new LibrarySessionRegistry()
  registry.replace(scanned.flatMap((candidate) => candidate.candidate ? [candidate.candidate] : []))
  const byRealPath = new Map<string, ScannedPackage[]>()
  for (const candidate of scanned) {
    const values = byRealPath.get(path.resolve(candidate.realPath)) || []
    values.push(candidate)
    byRealPath.set(path.resolve(candidate.realPath), values)
  }
  const seenGroups = new Set<string>()
  const conflictInputs: Array<{
    reason: ConflictInventory['registryReason']
    packages: ScannedPackage[]
  }> = []
  for (const diagnostic of registry.diagnostics()) {
    if (diagnostic.state !== 'conflict') continue
    const packages = diagnostic.candidates.flatMap((candidate) =>
      byRealPath.get(path.resolve(candidate.dirPath)) || [])
    const deduplicated = [...new Map(packages.map((candidate) => [candidate.pathId, candidate])).values()]
    const signature = `${diagnostic.reason}\0${deduplicated.map((candidate) => candidate.pathId).sort().join('\0')}`
    if (seenGroups.has(signature)) continue
    seenGroups.add(signature)
    conflictInputs.push({ reason: diagnostic.reason, packages: deduplicated })
  }
  for (const candidate of scanned.filter((item) => !item.manifest)) {
    conflictInputs.push({ reason: 'unresolved-manifest', packages: [candidate] })
  }
  const conflicts = conflictInputs
    .map((input) => buildConflict(input.reason, input.packages, quarantineRoot, snapshotFingerprint, hashSources))
    .sort((a, b) => a.conflictId.localeCompare(b.conflictId))
  const classificationCounts: Record<RecoveryClassification, number> = {
    'canonical-candidate': 0,
    'merge-required': 0,
    'manual-review': 0,
    'missing-source': 0,
    corrupt: 0
  }
  for (const conflict of conflicts) classificationCounts[conflict.classification]++
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    mode: 'dry-run',
    snapshotFingerprint,
    planId,
    contentPolicy: {
      bodiesIncluded: false,
      titlesIncluded: false,
      fullSourcePathsIncluded: false,
      filesystemPathsIncluded: false
    },
    sourceHashing: hashSources ? 'enabled' : 'disabled',
    validity: { rule: 'rebuild-and-match-snapshot-fingerprint', snapshotFingerprint },
    quarantine: {
      outsideLibraryRequired: true,
      verifiedOutsideLibrary: true,
      rootId: `quarantine-root:${sha256(quarantineRoot).slice(0, 24)}`,
      layout: '<external-quarantine-root>/<planId>/<packagePathId>'
    },
    summary: {
      packageCount: scanned.length,
      validPackageCount: scanned.filter((candidate) => Boolean(candidate.manifest)).length,
      conflictCount: conflicts.length,
      unresolvedCount: scanned.filter((candidate) => !candidate.manifest).length,
      classificationCounts
    },
    conflicts
  }
}

export async function verifyDuplicateRecoveryPlan(
  libraryRoot: string,
  previous: Pick<DuplicateRecoveryReport, 'snapshotFingerprint' | 'sourceHashing'>,
  options: DuplicateRecoveryPlannerOptions = {}
): Promise<{
  status: 'current' | 'expired'
  previousSnapshotFingerprint: string
  currentSnapshotFingerprint: string
}> {
  const current = await buildDuplicateRecoveryReport(libraryRoot, {
    ...options,
    hashSources: previous.sourceHashing === 'enabled'
  })
  return {
    status: current.snapshotFingerprint === previous.snapshotFingerprint ? 'current' : 'expired',
    previousSnapshotFingerprint: previous.snapshotFingerprint,
    currentSnapshotFingerprint: current.snapshotFingerprint
  }
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

export function renderDuplicateRecoveryMarkdown(report: DuplicateRecoveryReport): string {
  const lines = [
    '# Swob duplicate recovery inventory',
    '',
    `- Mode: \`${report.mode}\``,
    `- Plan: \`${report.planId}\``,
    `- Snapshot: \`${report.snapshotFingerprint}\``,
    `- Source hashing: \`${report.sourceHashing}\``,
    `- Conflicts: ${report.summary.conflictCount}; unresolved: ${report.summary.unresolvedCount}`,
    '- Privacy: no transcript bodies, titles, full source paths, or filesystem paths.',
    '- Validity: rebuild and require the same snapshot fingerprint before any future action.',
    '- Quarantine: must remain outside Library; this report contains no apply capability.',
    ''
  ]
  for (const conflict of report.conflicts) {
    lines.push(
      `## ${conflict.conflictId}`,
      '',
      `- Classification: \`${conflict.classification}\``,
      `- Registry reason: \`${conflict.registryReason}\``,
      `- Reasons: ${conflict.reasons.map((reason) => `\`${reason}\``).join(', ') || 'none'}`,
      `- Recovery: \`${conflict.recovery.action}\``,
      '',
      '| Path ID | Package | Cloud | Backup/source | Role | Files |',
      '|---|---|---|---|---|---:|'
    )
    for (const candidate of conflict.packages) {
      lines.push(`| ${markdownCell(candidate.pathId)} | ${candidate.manifest.packageState} | ${candidate.cloudState} | ${candidate.backupSourceRelationship} | ${candidate.role} | ${candidate.files.length} |`)
    }
    lines.push('')
    if (conflict.recovery.moves.length > 0) {
      lines.push('Future quarantine / reverse map:', '')
      for (const move of conflict.recovery.moves) {
        lines.push(`- \`${move.fromPathId}\` → \`${move.quarantinePathId}\`; reverse restores to \`${move.fromPathId}\`.`)
      }
      lines.push('')
    }
  }
  return `${lines.join('\n')}\n`
}
