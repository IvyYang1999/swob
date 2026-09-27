import * as fs from 'fs'
import * as path from 'path'
import { runtimeHome } from './runtime-home'
import {
  findClaudeSessionFiles,
  loadCachedClaudeLineageMetadata,
  parseSessionFile,
  resolvePhysicalSessionId,
  SUMMARY_CACHE_VERSION,
  type CachedClaudeLineageFile
} from './session-loader'
import type { RawJsonlMessage } from './session-types'

export const SESSION_LINEAGE_FILE = '.session-lineage.json'

type LineageEvidenceType = 'uuid-parent-chain'

export interface LineageEvidence {
  type: LineageEvidenceType
  overlapCount: number
  parentCoverage: number
  childCoverage: number
  parentUuid: string
  childFirstNewUuid: string
  childFirstNewAt: string
  parentUpdatedAt: string
  childUpdatedAt: string
  cwdMatched: boolean
}

/** A usable edge in the physical-session lineage forest. */
export interface LineageRelation {
  child: string
  parent: string
  type: 'fork' | 'continuation'
  pointUuid: string
  pointTs: string
  /** Auto-detected for legacy edges; explicit on new manual decisions. */
  provenance?: 'detected' | 'manual'
  resolutionId?: string
}

export interface BrokenLineageRelation {
  child: string
  parentSessionRef?: string
  type: 'fork' | 'continuation'
  pointUuid: string
  pointTs: string
}

interface LegacyLineageRelation {
  from: string
  to: string
  evidence: LineageEvidence
}

export interface LineageSessionEntry {
  sessionId: string
  rootSessionId: string
  latestResumeId: string
  isAlias: boolean
  source: 'claude-code'
  createdAt: string
  updatedAt: string
}

export interface LineageAmbiguity {
  sessionId: string
  reason: string
  candidates: Array<{
    sessionId: string
    updatedAt: string
    overlapCount: number
    parentCoverage: number
  }>
}

export interface LineageResolutionInput {
  ambiguitySessionId: string
  parentSessionId: string
  childSessionId: string
  type: 'fork' | 'continuation'
  decidedAt: string
  note?: string
}

export interface LineageResolution extends LineageResolutionInput {
  resolutionId: string
  ambiguityReason: string
  status: 'applied' | 'stale'
}

export interface SessionLineageRegistry {
  version: 1
  generatedAt: string
  libraryRoot: string
  /** old session id -> latest resume id; aliases are not necessarily stepwise. */
  aliases: Record<string, string>
  latestByRoot: Record<string, string>
  sessions: Record<string, LineageSessionEntry>
  relations: LineageRelation[]
  /** Absent only in legacy registries read from disk; newly written registries always include it. */
  broken?: BrokenLineageRelation[]
  ambiguous: LineageAmbiguity[]
  /** Optional only while reading a legacy v1 registry; every new build writes it. */
  resolutions?: LineageResolution[]
  /**
   * The summary-cache version whose lineage fields this registry was rebuilt
   * from (F1d). The desktop rebuilds a registry of another version, or of
   * none, once after its first writable load. Readers ignore it.
   */
  derivedFrom?: { summaryCacheVersion: number }
}

/**
 * Resolve only the continuation alias surface. Fork relations and display
 * metadata are deliberately excluded, so a similar title can never create a
 * logical-thread jump.
 */
export function resolveSessionSuccessor(
  registry: SessionLineageRegistry | null | undefined,
  sessionId: string
): string | null {
  if (!registry || !sessionId) return null
  const successor = registry.aliases[sessionId] || registry.sessions[sessionId]?.latestResumeId
  return successor && successor !== sessionId ? successor : null
}

interface LineageRow extends RawJsonlMessage {
  __filePath: string
  __lineIndex: number
  __fileIndex: number
}

interface LineageRecord {
  sessionId: string
  rows: LineageRow[]
  uuidRows: LineageRow[]
  uuidSet: Set<string>
  createdAt: string
  updatedAt: string
  cwds: Set<string>
}

interface CandidateRelation extends LegacyLineageRelation {
  fromRecord: LineageRecord
  toRecord: LineageRecord
}

interface BlockedLineageCandidate {
  reason: 'missing-cwd-cannot-confirm-lineage'
  candidate: CandidateRelation
}

interface BuildOptions {
  libraryRoot?: string
  generatedAt?: string
}

const MIN_PARENT_COVERAGE = 0.7

export function getSessionLineagePath(libraryRoot: string): string {
  return path.join(libraryRoot, SESSION_LINEAGE_FILE)
}

export async function rebuildSessionLineageRegistry(
  libraryRoot: string,
  options: Omit<BuildOptions, 'libraryRoot'> = {}
): Promise<SessionLineageRegistry> {
  const cached = await loadCachedClaudeLineageMetadata(findClaudeSessionFiles())
  const registry = buildSessionLineageRegistryFromRecords(loadLineageRecordsFromCache(cached.files), {
    ...options,
    libraryRoot
  })
  return {
    ...preserveExistingAliases(registry, getSessionLineagePath(libraryRoot)),
    derivedFrom: { summaryCacheVersion: SUMMARY_CACHE_VERSION }
  }
}

/**
 * The registry file as a replacement must see it (F1d). Only a missing file
 * (ENOENT) is "no registry". One that exists but cannot be read, is not a
 * regular file (a symlink is never followed), is not UTF-8 JSON holding an
 * object, or whose aliases, resolutions or relations have another shape is
 * unreadable: nothing may replace it.
 */
export type LineageRegistrySnapshot =
  | { readonly state: 'missing' }
  | { readonly state: 'unreadable'; readonly code: string }
  | {
      readonly state: 'readable'
      /** The file as read: what a replacement backs up and compares against. */
      readonly bytes: Buffer
      readonly mode: number
      readonly registry: Readonly<Record<string, unknown>>
    }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readLineageRegistrySnapshot(filePath: string): LineageRegistrySnapshot {
  let descriptor: number | undefined
  let bytes: Buffer
  let mode: number
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const stat = fs.fstatSync(descriptor)
    if (!stat.isFile()) return { state: 'unreadable', code: 'not-a-regular-file' }
    mode = stat.mode & 0o777
    bytes = fs.readFileSync(descriptor)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'missing' }
    return { state: 'unreadable', code: code === 'ELOOP' ? 'not-a-regular-file' : code || 'read-failed' }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    return { state: 'unreadable', code: 'invalid-json' }
  }
  if (!isPlainObject(parsed)) return { state: 'unreadable', code: 'not-an-object' }
  if (parsed.aliases !== undefined && !isPlainObject(parsed.aliases)) {
    return { state: 'unreadable', code: 'invalid-aliases' }
  }
  for (const field of ['resolutions', 'relations'] as const) {
    if (parsed[field] !== undefined && !Array.isArray(parsed[field])) {
      return { state: 'unreadable', code: `invalid-${field}` }
    }
  }
  return { state: 'readable', bytes, mode, registry: parsed }
}

function sameLineageRegistrySnapshot(left: LineageRegistrySnapshot, right: LineageRegistrySnapshot): boolean {
  if (left.state === 'readable' || right.state === 'readable') {
    return left.state === 'readable' && right.state === 'readable' && left.bytes.equals(right.bytes)
  }
  return left.state === right.state
}

export interface LineageRegistryCounts {
  readonly aliases: number
  readonly resolutions: number
  readonly manualRelations: number
}

export interface LineageRegistryReplacementCheck {
  readonly previous: LineageRegistryCounts
  readonly next: LineageRegistryCounts
  /** Old alias keys left out because the continuation resolution behind them went stale: allowed, each reported. */
  readonly staleAliasDrops: ReadonlyArray<{ sessionId: string; successorId: string; resolutionId: string }>
  /** Resolutions applied before and stale now (kept, marked stale): each reported. */
  readonly newlyStaleResolutions: readonly string[]
  /** Old alias keys the new registry loses for any other reason. */
  readonly lostAliases: readonly string[]
  /** Old resolutions the new registry loses: by id (a duplicate counts), `#<index>` for one that does not parse. */
  readonly lostResolutions: readonly string[]
  /** Old manual relations (`type:parent->child`) the new registry loses while their resolution is not stale. */
  readonly lostManualRelations: readonly string[]
}

export function lineageRegistryCounts(registry: SessionLineageRegistry): LineageRegistryCounts {
  return {
    aliases: Object.keys(registry.aliases).length,
    resolutions: (registry.resolutions || []).length,
    manualRelations: registry.relations.filter((relation) => relation.provenance === 'manual').length
  }
}

/**
 * What replacing `previous` (a registry as read from disk) by `next` would
 * lose. Any lost alias key, resolution or manual relation refuses the
 * replacement; an alias dropped because its resolution went stale is not a
 * loss, and is reported with every resolution that went stale.
 */
export function checkLineageRegistryReplacement(
  previous: Readonly<Record<string, unknown>>,
  next: SessionLineageRegistry
): LineageRegistryReplacementCheck {
  const previousAliases = isPlainObject(previous.aliases)
    ? Object.entries(previous.aliases).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    : []
  const previousResolutions: unknown[] = Array.isArray(previous.resolutions) ? previous.resolutions : []
  const previousManual = (Array.isArray(previous.relations) ? previous.relations : [])
    .filter((relation): relation is Record<string, unknown> =>
      isPlainObject(relation) && relation.provenance === 'manual')
  const nextResolutions = next.resolutions || []
  const nextStatus = new Map(nextResolutions.map((resolution) => [resolution.resolutionId, resolution.status]))
  const staleContinuations = new Map(nextResolutions
    .filter((resolution) => resolution.status === 'stale' && resolution.type === 'continuation')
    .map((resolution) => [resolution.parentSessionId, resolution.resolutionId]))

  const staleAliasDrops: Array<{ sessionId: string; successorId: string; resolutionId: string }> = []
  const lostAliases: string[] = []
  for (const [sessionId, successorId] of previousAliases) {
    if (Object.prototype.hasOwnProperty.call(next.aliases, sessionId)) continue
    const resolutionId = staleContinuations.get(sessionId)
    if (resolutionId) staleAliasDrops.push({ sessionId, successorId, resolutionId })
    else lostAliases.push(sessionId)
  }

  const lostResolutions: string[] = []
  const newlyStaleResolutions: string[] = []
  const previousTimes = new Map<string, number>()
  previousResolutions.forEach((entry, index) => {
    const resolution = parseResolution(entry)
    if (!resolution) {
      lostResolutions.push(`#${index}`)
      return
    }
    previousTimes.set(resolution.resolutionId, (previousTimes.get(resolution.resolutionId) || 0) + 1)
    if (resolution.status === 'applied' && nextStatus.get(resolution.resolutionId) === 'stale' &&
      !newlyStaleResolutions.includes(resolution.resolutionId)) {
      newlyStaleResolutions.push(resolution.resolutionId)
    }
  })
  for (const [resolutionId, times] of previousTimes) {
    const kept = nextResolutions.filter((resolution) => resolution.resolutionId === resolutionId).length
    if (kept < times) lostResolutions.push(resolutionId)
  }

  const lostManualRelations: string[] = []
  for (const relation of previousManual) {
    const kept = next.relations.some((candidate) => candidate.provenance === 'manual' &&
      candidate.parent === relation.parent && candidate.child === relation.child && candidate.type === relation.type)
    if (kept) continue
    if (typeof relation.resolutionId === 'string' && nextStatus.get(relation.resolutionId) === 'stale') continue
    lostManualRelations.push(`${String(relation.type)}:${String(relation.parent)}->${String(relation.child)}`)
  }

  return {
    previous: {
      aliases: previousAliases.length,
      resolutions: previousResolutions.length,
      manualRelations: previousManual.length
    },
    next: lineageRegistryCounts(next),
    staleAliasDrops,
    newlyStaleResolutions,
    lostAliases,
    lostResolutions,
    lostManualRelations
  }
}

export type LineageRegistryRefusalCode =
  | 'LINEAGE_REGISTRY_UNREADABLE'
  | 'LINEAGE_REGISTRY_CHANGED'
  | 'LINEAGE_REGISTRY_ENTRIES_LOST'
  | 'LINEAGE_REGISTRY_BACKUP_FAILED'

/** writeSessionLineageRegistry refused before replacing anything. */
export class LineageRegistryWriteRefusedError extends Error {
  readonly code: LineageRegistryRefusalCode
  /** Why the file could not be read or backed up (an errno code or a shape code). */
  readonly readCode?: string
  readonly check?: LineageRegistryReplacementCheck

  constructor(
    code: LineageRegistryRefusalCode,
    message: string,
    detail: { readCode?: string; check?: LineageRegistryReplacementCheck } = {}
  ) {
    super(message)
    this.name = 'LineageRegistryWriteRefusedError'
    this.code = code
    this.readCode = detail.readCode
    this.check = detail.check
  }
}

export interface LineageRegistryWriteOptions {
  /** The file as the rebuild found it: a file changed since is not replaced. */
  readonly expected?: LineageRegistrySnapshot
  /** Where a replaced file is copied first. Default: <state>/lineage-backups, never the Library. */
  readonly backupDirectory?: string
}

export interface LineageRegistryWriteResult {
  /** null when there was no registry file to replace. */
  readonly check: LineageRegistryReplacementCheck | null
  /**
   * The byte-for-byte copy of the replaced file in the backup directory:
   * written by this call, or the newest backup when it already held exactly
   * these bytes (a replacement retried after failing past its backup).
   */
  readonly backupFileName: string | null
}

export function defaultLineageBackupDirectory(): string {
  return path.join(runtimeHome(), '.claude-session-manager', 'lineage-backups')
}

/**
 * The only writer of the lineage registry, which is the only store of old
 * aliases and manual resolutions (F1d). It creates a missing registry, and
 * replaces an existing one only when it could read it, it is still what the
 * caller's rebuild saw (`expected`), the new registry loses no alias key, no
 * resolution and no manual relation (see checkLineageRegistryReplacement),
 * and a byte-for-byte copy is on disk outside the Library before anything
 * else is written: this call writes it, unless the newest backup already
 * holds exactly these bytes, so a replacement that keeps failing past its
 * backup (a read-only Library, a busy rename) leaves one copy, not one per
 * try. The replacement is atomic: a temporary file in the same directory,
 * fsync, rename. Anything else throws LineageRegistryWriteRefusedError with
 * the file as it was.
 */
export function writeSessionLineageRegistry(
  registry: SessionLineageRegistry,
  filePath: string,
  options: LineageRegistryWriteOptions = {}
): LineageRegistryWriteResult {
  const current = readLineageRegistrySnapshot(filePath)
  if (current.state === 'unreadable') {
    throw new LineageRegistryWriteRefusedError(
      'LINEAGE_REGISTRY_UNREADABLE',
      `The lineage registry exists but cannot be read (${current.code}); it was left unchanged`,
      { readCode: current.code }
    )
  }
  if (options.expected && !sameLineageRegistrySnapshot(options.expected, current)) {
    throw new LineageRegistryWriteRefusedError(
      'LINEAGE_REGISTRY_CHANGED',
      'The lineage registry changed while it was being rebuilt; it was left unchanged'
    )
  }
  let check: LineageRegistryReplacementCheck | null = null
  let backupFileName: string | null = null
  if (current.state === 'readable') {
    check = checkLineageRegistryReplacement(current.registry, registry)
    const lost = check.lostAliases.length + check.lostResolutions.length + check.lostManualRelations.length
    if (lost > 0) {
      throw new LineageRegistryWriteRefusedError(
        'LINEAGE_REGISTRY_ENTRIES_LOST',
        `The rebuilt lineage registry would lose ${check.lostAliases.length} alias(es), ` +
        `${check.lostResolutions.length} resolution(s) and ${check.lostManualRelations.length} manual relation(s); ` +
        'the registry was left unchanged',
        { check }
      )
    }
    const backupDirectory = options.backupDirectory || defaultLineageBackupDirectory()
    backupFileName = newestIdenticalBackup(backupDirectory, current.bytes) ??
      backupLineageRegistry(current.bytes, backupDirectory)
  }
  replaceLineageRegistryFile(filePath, JSON.stringify(registry, null, 2) + '\n', current)
  return { check, backupFileName }
}

const BACKUP_FILE_NAME = /^session-lineage-.+\.json$/

/**
 * The newest backup in `directory` (by modification time) when it already
 * holds exactly `bytes`; null when there is none, it differs, or the
 * directory cannot be read (the backup is then written, or fails, as usual).
 * Symbolic links are never followed.
 */
function newestIdenticalBackup(directory: string, bytes: Buffer): string | null {
  try {
    let newest: { name: string; mtimeMs: number } | null = null
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !BACKUP_FILE_NAME.test(entry.name)) continue
      const { mtimeMs } = fs.lstatSync(path.join(directory, entry.name))
      if (!newest || mtimeMs > newest.mtimeMs || (mtimeMs === newest.mtimeMs && entry.name > newest.name)) {
        newest = { name: entry.name, mtimeMs }
      }
    }
    return newest && fs.readFileSync(path.join(directory, newest.name)).equals(bytes) ? newest.name : null
  } catch {
    return null
  }
}

function createBackupFile(directory: string): { descriptor: number; filePath: string } {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (let attempt = 0; ; attempt++) {
    const filePath = path.join(directory, `session-lineage-${stamp}-${process.pid}${attempt ? `-${attempt}` : ''}.json`)
    try {
      return { descriptor: fs.openSync(filePath, 'wx', 0o600), filePath }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt >= 99) throw error
    }
  }
}

/** Copy the registry being replaced, byte for byte, and return the copy's file name. */
function backupLineageRegistry(bytes: Buffer, directory: string): string {
  let backup: { descriptor: number; filePath: string } | null = null
  let open = false
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    backup = createBackupFile(directory)
    open = true
    fs.writeFileSync(backup.descriptor, bytes)
    fs.fsyncSync(backup.descriptor)
    open = false
    fs.closeSync(backup.descriptor)
    return path.basename(backup.filePath)
  } catch (error) {
    if (backup) {
      if (open) fs.closeSync(backup.descriptor)
      try { fs.unlinkSync(backup.filePath) } catch { /* no partial copy to clean */ }
    }
    const code = (error as NodeJS.ErrnoException).code || 'backup-failed'
    throw new LineageRegistryWriteRefusedError(
      'LINEAGE_REGISTRY_BACKUP_FAILED',
      `The lineage registry could not be backed up (${code}); it was left unchanged`,
      { readCode: code }
    )
  }
}

function replaceLineageRegistryFile(filePath: string, text: string, current: LineageRegistrySnapshot): void {
  const directory = path.dirname(filePath)
  fs.mkdirSync(directory, { recursive: true })
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`)
  let descriptor: number | undefined
  try {
    // A new registry gets the usual 0666 & ~umask; a replaced one keeps its mode.
    descriptor = fs.openSync(temporaryPath, 'wx', current.state === 'readable' ? 0o600 : 0o666)
    fs.writeFileSync(descriptor, text)
    if (current.state === 'readable') fs.fchmodSync(descriptor, current.mode)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    // A last look before the rename: what another writer put there since is kept.
    if (!sameLineageRegistrySnapshot(current, readLineageRegistrySnapshot(filePath))) {
      throw new LineageRegistryWriteRefusedError(
        'LINEAGE_REGISTRY_CHANGED',
        'The lineage registry changed while it was being written; it was left unchanged'
      )
    }
    fs.renameSync(temporaryPath, filePath)
    try {
      const directoryDescriptor = fs.openSync(directory, 'r')
      try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
    } catch { /* directory fsync is unavailable on some filesystems */ }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporaryPath) } catch { /* no temporary file to clean */ }
    throw error
  }
}

function resolutionId(input: LineageResolutionInput): string {
  return ['manual', input.ambiguitySessionId, input.parentSessionId, input.childSessionId, input.type].join(':')
}

function recordsFromRegistry(registry: SessionLineageRegistry): LineageRecord[] {
  return Object.values(registry.sessions).map((entry) => ({
    sessionId: entry.sessionId,
    rows: [],
    uuidRows: [],
    uuidSet: new Set<string>(),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    cwds: new Set<string>()
  }))
}

function relationWouldCycle(relations: LineageRelation[], parentId: string, childId: string): boolean {
  const childToParent = new Map(relations.map((relation) => [relation.child, relation.parent]))
  let current: string | undefined = parentId
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === childId) return true
    seen.add(current)
    current = childToParent.get(current)
  }
  return false
}

function ambiguityAcceptsResolution(
  ambiguity: LineageAmbiguity,
  input: LineageResolutionInput
): boolean {
  const candidateIds = new Set(ambiguity.candidates.map((candidate) => candidate.sessionId))
  const parentCandidateReasons = new Set([
    'multiple-exact-lineage-parents',
    'multiple-unrelated-lineage-parents',
    'multiple-lineage-parents',
    'lineage-cycle'
  ])
  const childCandidateReasons = new Set([
    'multiple-equally-plausible-lineage-targets',
    'missing-cwd-cannot-confirm-lineage'
  ])
  if (parentCandidateReasons.has(ambiguity.reason)) {
    return ambiguity.sessionId === input.childSessionId && candidateIds.has(input.parentSessionId)
  }
  if (childCandidateReasons.has(ambiguity.reason)) {
    return ambiguity.sessionId === input.parentSessionId && candidateIds.has(input.childSessionId)
  }
  return false
}

/** Apply a user-confirmed ambiguity decision without mutating the source registry. */
export function applyLineageResolution(
  registry: SessionLineageRegistry,
  input: LineageResolutionInput
): SessionLineageRegistry {
  const id = resolutionId(input)
  const previous = (registry.resolutions || []).find((resolution) => resolution.resolutionId === id)
  const matchingRelation = registry.relations.find((relation) =>
    relation.parent === input.parentSessionId &&
    relation.child === input.childSessionId &&
    relation.type === input.type)
  if (previous?.status === 'applied' && matchingRelation) return registry

  if (!registry.sessions[input.parentSessionId] || !registry.sessions[input.childSessionId]) {
    throw new Error('Lineage resolution candidate is not a session in the registry')
  }
  if (input.parentSessionId === input.childSessionId) {
    throw new Error('Lineage resolution parent and child must differ')
  }

  const ambiguity = registry.ambiguous.find((item) => item.sessionId === input.ambiguitySessionId)
  if (!ambiguity && !matchingRelation) {
    throw new Error('Lineage resolution candidate is no longer present in the ambiguity')
  }
  if (ambiguity && !ambiguityAcceptsResolution(ambiguity, input)) {
    throw new Error('Lineage resolution must select a candidate shown by the ambiguity')
  }

  const conflictingRelation = registry.relations.find((relation) =>
    relation.child === input.childSessionId && relation.parent !== input.parentSessionId)
  if (conflictingRelation) {
    throw new Error('Lineage resolution conflicts with an existing parent relation')
  }
  const remainingRelations = registry.relations.filter((relation) =>
    !(relation.child === input.childSessionId && relation.parent === input.parentSessionId))
  if (relationWouldCycle(remainingRelations, input.parentSessionId, input.childSessionId)) {
    throw new Error('Lineage resolution would create a cycle')
  }

  const resolution: LineageResolution = {
    ...input,
    resolutionId: id,
    ambiguityReason: ambiguity?.reason || previous?.ambiguityReason || 'already-detected',
    status: 'applied'
  }
  const manualRelation: LineageRelation = {
    parent: input.parentSessionId,
    child: input.childSessionId,
    type: input.type,
    pointUuid: `manual:${input.ambiguitySessionId}`,
    pointTs: input.decidedAt,
    provenance: 'manual',
    resolutionId: id
  }
  const rebuilt = buildRegistry(
    recordsFromRegistry(registry),
    [...remainingRelations, manualRelation],
    (registry.broken || []).filter((item) => item.child !== input.childSessionId),
    registry.ambiguous.filter((item) => item.sessionId !== input.ambiguitySessionId),
    { libraryRoot: registry.libraryRoot, generatedAt: registry.generatedAt }
  )
  return {
    ...rebuilt,
    resolutions: [
      ...(registry.resolutions || []).filter((item) => item.resolutionId !== id),
      resolution
    ].sort((left, right) => left.resolutionId.localeCompare(right.resolutionId))
  }
}

function parseResolution(value: unknown): LineageResolution | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Partial<LineageResolution>
  if (typeof candidate.ambiguitySessionId !== 'string' ||
      typeof candidate.parentSessionId !== 'string' ||
      typeof candidate.childSessionId !== 'string' ||
      (candidate.type !== 'fork' && candidate.type !== 'continuation') ||
      typeof candidate.decidedAt !== 'string') return null
  const input: LineageResolutionInput = {
    ambiguitySessionId: candidate.ambiguitySessionId,
    parentSessionId: candidate.parentSessionId,
    childSessionId: candidate.childSessionId,
    type: candidate.type,
    decidedAt: candidate.decidedAt,
    ...(typeof candidate.note === 'string' ? { note: candidate.note } : {})
  }
  return {
    ...input,
    resolutionId: resolutionId(input),
    ambiguityReason: typeof candidate.ambiguityReason === 'string' ? candidate.ambiguityReason : 'legacy',
    status: candidate.status === 'stale' ? 'stale' : 'applied'
  }
}

/** Read, validate, apply, and atomically replace a registry in its own directory. */
export function writeLineageResolution(
  registryPath: string,
  input: LineageResolutionInput
): SessionLineageRegistry {
  let sourceDescriptor: number | undefined
  let sourceText: string
  try {
    sourceDescriptor = fs.openSync(
      registryPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
    )
    if (!fs.fstatSync(sourceDescriptor).isFile()) {
      throw new Error('Lineage registry must be a regular file')
    }
    sourceText = fs.readFileSync(sourceDescriptor, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('Lineage registry must be a regular file')
    }
    throw error
  } finally {
    if (sourceDescriptor !== undefined) fs.closeSync(sourceDescriptor)
  }
  const parsed: unknown = JSON.parse(sourceText)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Lineage registry is invalid')
  }
  const resolved = applyLineageResolution(parsed as SessionLineageRegistry, input)
  const temporaryPath = path.join(
    path.dirname(registryPath),
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`
  )
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600)
    fs.writeSync(descriptor, JSON.stringify(resolved, null, 2) + '\n')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporaryPath, registryPath)
    try {
      const directory = fs.openSync(path.dirname(registryPath), 'r')
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    } catch { /* directory fsync is unavailable on some filesystems */ }
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporaryPath) } catch { /* no temporary file to clean */ }
    throw error
  }
  return resolved
}

export async function buildSessionLineageRegistryFromClaudeFiles(
  filePaths: string[],
  options: BuildOptions = {}
): Promise<SessionLineageRegistry> {
  const records = await loadLineageRecords(filePaths)
  return buildSessionLineageRegistryFromRecords(records, options)
}

async function loadLineageRecords(filePaths: string[]): Promise<LineageRecord[]> {
  const grouped = new Map<string, LineageRow[]>()

  for (let fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
    const filePath = filePaths[fileIndex]
    let raw: RawJsonlMessage[]
    try {
      raw = await parseSessionFile(filePath)
    } catch {
      continue
    }

    const sessionId = resolvePhysicalSessionId(filePath, raw)
    if (!sessionId) continue

    const rows = raw.map((row, lineIndex) => ({
      ...row,
      __filePath: filePath,
      __lineIndex: lineIndex,
      __fileIndex: fileIndex
    }))

    const current = grouped.get(sessionId) || []
    current.push(...rows)
    grouped.set(sessionId, current)
  }

  const records: LineageRecord[] = []
  for (const [sessionId, rows] of grouped) {
    const sortedRows = sortRows(rows)
    const uuidRows = dedupeUuidRows(sortedRows)
    const timestamps = sortedRows.map((row) => row.timestamp).filter(Boolean).sort()
    if (uuidRows.length === 0 || timestamps.length === 0) continue

    records.push({
      sessionId,
      rows: sortedRows,
      uuidRows,
      uuidSet: new Set(uuidRows.map((row) => row.uuid)),
      createdAt: timestamps[0],
      updatedAt: timestamps[timestamps.length - 1],
      cwds: new Set(sortedRows.map((row) => row.cwd).filter((cwd): cwd is string => !!cwd))
    })
  }

  return records
}

/** Cold-path adapter for the incremental cache populated by session-loader. */
function loadLineageRecordsFromCache(files: CachedClaudeLineageFile[]): LineageRecord[] {
  const grouped = new Map<string, LineageRow[]>()

  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const { filePath, meta } = files[fileIndex]
    const rows = meta.leafUuidRefs.map((row, lineIndex) => ({
      ...row,
      __filePath: filePath,
      __lineIndex: lineIndex,
      __fileIndex: fileIndex
    }))
    const current = grouped.get(meta.sessionId) || []
    current.push(...rows)
    grouped.set(meta.sessionId, current)
  }

  return buildLineageRecords(grouped)
}

function buildLineageRecords(grouped: Map<string, LineageRow[]>): LineageRecord[] {
  const records: LineageRecord[] = []
  for (const [sessionId, rows] of grouped) {
    const sortedRows = sortRows(rows)
    const uuidRows = dedupeUuidRows(sortedRows)
    const timestamps = sortedRows.map((row) => row.timestamp).filter(Boolean).sort()
    if (uuidRows.length === 0 || timestamps.length === 0) continue

    records.push({
      sessionId,
      rows: sortedRows,
      uuidRows,
      uuidSet: new Set(uuidRows.map((row) => row.uuid)),
      createdAt: timestamps[0],
      updatedAt: timestamps[timestamps.length - 1],
      cwds: new Set(sortedRows.map((row) => row.cwd).filter((cwd): cwd is string => !!cwd))
    })
  }
  return records
}

interface IndexedUuid {
  sessionId: string
  timestamp: string
}

interface ExactPointer {
  child: string
  type: 'fork' | 'continuation'
  pointUuid: string
  parentSessionRef?: string
}

interface ExactSelection {
  relations: LineageRelation[]
  broken: BrokenLineageRelation[]
  ambiguous: LineageAmbiguity[]
  /** Children with a usable, broken, or ambiguous exact pointer never use fallback. */
  handledChildren: Set<string>
}

function buildUuidIndex(records: LineageRecord[]): Map<string, IndexedUuid[]> {
  const index = new Map<string, IndexedUuid[]>()
  for (const record of records) {
    for (const row of record.uuidRows) {
      if (!row.uuid) continue
      const entries = index.get(row.uuid) || []
      if (!entries.some((entry) => entry.sessionId === record.sessionId)) {
        entries.push({ sessionId: record.sessionId, timestamp: row.timestamp || '' })
        index.set(row.uuid, entries)
      }
    }
  }
  for (const entries of index.values()) {
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sessionId.localeCompare(b.sessionId))
  }
  return index
}

function exactPointersForRecord(record: LineageRecord, uuidIndex: Map<string, IndexedUuid[]>): ExactPointer[] {
  const pointers: ExactPointer[] = []
  for (const row of record.rows) {
    if (row.forkedFrom?.messageUuid) {
      pointers.push({
        child: record.sessionId,
        type: 'fork',
        pointUuid: row.forkedFrom.messageUuid,
        parentSessionRef: row.forkedFrom.sessionId
      })
    }
    // A continuation summary is emitted at the start of the new physical
    // session. `last-prompt.leafUuid` is mutable in-session state and must not
    // be treated as a parent pointer.
    const owners = row.leafUuid ? uuidIndex.get(row.leafUuid) || [] : []
    if (row.type === 'summary' && row.leafUuid &&
      (owners.length === 0 || owners.some((entry) => entry.sessionId !== record.sessionId))) {
      pointers.push({ child: record.sessionId, type: 'continuation', pointUuid: row.leafUuid })
    }
  }
  return pointers
}

function preserveExistingAliases(
  registry: SessionLineageRegistry,
  registryPath: string
): SessionLineageRegistry {
  let existingAliases: Record<string, string> = {}
  let existingResolutions: LineageResolution[] = []
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const aliases = (parsed as { aliases?: unknown }).aliases
      if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
        existingAliases = Object.fromEntries(
          Object.entries(aliases).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        )
      }
      const resolutions = (parsed as { resolutions?: unknown }).resolutions
      if (Array.isArray(resolutions)) {
        existingResolutions = resolutions
          .map(parseResolution)
          .filter((resolution): resolution is LineageResolution => resolution !== null)
      }
    }
  } catch { /* no prior registry is normal */ }

  let resolvedRegistry = registry
  const staleAliasKeys = new Set<string>()
  for (const resolution of existingResolutions) {
    try {
      resolvedRegistry = applyLineageResolution(resolvedRegistry, resolution)
    } catch {
      const stale: LineageResolution = { ...resolution, status: 'stale' }
      if (stale.type === 'continuation') staleAliasKeys.add(stale.parentSessionId)
      resolvedRegistry = {
        ...resolvedRegistry,
        resolutions: [
          ...(resolvedRegistry.resolutions || []).filter((item) => item.resolutionId !== stale.resolutionId),
          stale
        ].sort((left, right) => left.resolutionId.localeCompare(right.resolutionId))
      }
    }
  }

  const safeExistingAliases = Object.fromEntries(
    Object.entries(existingAliases).filter(([oldId]) => !staleAliasKeys.has(oldId))
  )
  const merged = { ...safeExistingAliases, ...resolvedRegistry.aliases }
  const aliases: Record<string, string> = {}
  for (const oldId of Object.keys(merged)) {
    let latestId = merged[oldId]
    const seen = new Set<string>([oldId])
    while (merged[latestId] && !seen.has(latestId)) {
      seen.add(latestId)
      latestId = merged[latestId]
    }
    if (latestId !== oldId) aliases[oldId] = latestId
  }

  return {
    ...resolvedRegistry,
    aliases: sortObject(aliases)
  }
}

function selectExactRelations(records: LineageRecord[]): ExactSelection {
  const uuidIndex = buildUuidIndex(records)
  const byId = new Map(records.map((record) => [record.sessionId, record]))
  const relations: LineageRelation[] = []
  const broken: BrokenLineageRelation[] = []
  const ambiguous: LineageAmbiguity[] = []
  const handledChildren = new Set<string>()

  for (const record of records) {
    const pointers = exactPointersForRecord(record, uuidIndex)
    if (pointers.length === 0) continue
    handledChildren.add(record.sessionId)

    const candidates = new Map<string, LineageRelation>()
    const unresolved: BrokenLineageRelation[] = []
    for (const pointer of pointers) {
      const owners = (uuidIndex.get(pointer.pointUuid) || []).filter((entry) => entry.sessionId !== record.sessionId)
      // forkedFrom carries an authoritative session reference when the UUID is
      // present in more than one imported physical file.
      const referenced = pointer.parentSessionRef
        ? owners.filter((entry) => entry.sessionId === pointer.parentSessionRef)
        : owners
      const usableOwners = referenced.length > 0 ? referenced : owners
      const parentIds = [...new Set(usableOwners.map((entry) => entry.sessionId))]
      if (parentIds.length !== 1) {
        unresolved.push({
          child: record.sessionId,
          parentSessionRef: pointer.parentSessionRef,
          type: pointer.type,
          pointUuid: pointer.pointUuid,
          pointTs: usableOwners[0]?.timestamp || ''
        })
        continue
      }
      const owner = usableOwners.find((entry) => entry.sessionId === parentIds[0])!
      const candidate: LineageRelation = {
        child: record.sessionId,
        parent: parentIds[0],
        type: pointer.type,
        pointUuid: pointer.pointUuid,
        pointTs: owner.timestamp
      }
      const existing = candidates.get(candidate.parent)
      // A fork is semantically more specific than a continuation if malformed
      // input happens to emit both pointers to the same physical parent.
      if (!existing || (candidate.type === 'fork' && existing.type !== 'fork')) {
        candidates.set(candidate.parent, candidate)
      }
    }

    const candidateRelations = [...candidates.values()]
    const unresolvedRefs = new Set(unresolved.map((item) => item.parentSessionRef).filter(Boolean))
    if (candidateRelations.length > 1 ||
      (candidateRelations.length === 1 && [...unresolvedRefs].some((ref) => ref !== candidateRelations[0].parent))) {
      const candidateIds = [...new Set([
        ...candidateRelations.map((item) => item.parent),
        ...[...unresolvedRefs].filter((ref): ref is string => !!ref)
      ])].sort()
      ambiguous.push({
        sessionId: record.sessionId,
        reason: 'multiple-exact-lineage-parents',
        candidates: candidateIds.map((sessionId) => ({
          sessionId,
          updatedAt: byId.get(sessionId)?.updatedAt || '',
          overlapCount: 0,
          parentCoverage: 0
        }))
      })
      broken.push(...unresolved)
      continue
    }
    if (candidateRelations.length === 1) relations.push(candidateRelations[0])
    broken.push(...unresolved)
  }

  return { relations, broken: dedupeBroken(broken), ambiguous, handledChildren }
}

function dedupeBroken(broken: BrokenLineageRelation[]): BrokenLineageRelation[] {
  const seen = new Set<string>()
  return broken.filter((item) => {
    const key = [item.child, item.parentSessionRef || '', item.type, item.pointUuid].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildSessionLineageRegistryFromRecords(
  records: LineageRecord[],
  options: BuildOptions
): SessionLineageRegistry {
  const exact = selectExactRelations(records)
  const fallback = selectRelations(records, exact.handledChildren)
  const uuidIndex = buildUuidIndex(records)
  const fallbackRelations: LineageRelation[] = fallback.relations.map((relation) => ({
    child: relation.to,
    parent: relation.from,
    type: 'continuation',
    pointUuid: relation.evidence.parentUuid,
    pointTs: uuidIndex.get(relation.evidence.parentUuid)?.find((entry) => entry.sessionId === relation.from)?.timestamp || ''
  }))
  const ambiguous = [...exact.ambiguous, ...fallback.ambiguous]
  const relations = removeCycles([...exact.relations, ...fallbackRelations], ambiguous)
  return buildRegistry(records, relations, exact.broken, ambiguous, options)
}

function removeCycles(relations: LineageRelation[], ambiguous: LineageAmbiguity[]): LineageRelation[] {
  const childToParent = new Map<string, string>()
  const accepted: LineageRelation[] = []
  const sorted = [...relations].sort((a, b) =>
    a.child.localeCompare(b.child) || a.parent.localeCompare(b.parent) || a.type.localeCompare(b.type))
  for (const relation of sorted) {
    const existingParent = childToParent.get(relation.child)
    if (existingParent) {
      if (existingParent === relation.parent) continue
      if (hasParentPath(relation.parent, existingParent, childToParent)) {
        // The newly found parent is a descendant of the existing one, so it is
        // the direct continuation parent; replace the redundant ancestor edge.
        const index = accepted.findIndex((edge) => edge.child === relation.child)
        if (index >= 0) accepted[index] = relation
        childToParent.set(relation.child, relation.parent)
        continue
      }
      if (hasParentPath(existingParent, relation.parent, childToParent)) continue
      ambiguous.push({
        sessionId: relation.child,
        reason: 'multiple-lineage-parents',
        candidates: [existingParent, relation.parent].sort().map((sessionId) => ({
          sessionId,
          updatedAt: '',
          overlapCount: 0,
          parentCoverage: 0
        }))
      })
      continue
    }
    let current: string | undefined = relation.parent
    let cycle = false
    while (current) {
      if (current === relation.child) {
        cycle = true
        break
      }
      current = childToParent.get(current)
    }
    if (cycle) {
      ambiguous.push({
        sessionId: relation.child,
        reason: 'lineage-cycle',
        candidates: [{ sessionId: relation.parent, updatedAt: '', overlapCount: 0, parentCoverage: 0 }]
      })
      continue
    }
    childToParent.set(relation.child, relation.parent)
    accepted.push(relation)
  }
  return accepted
}

function hasParentPath(start: string, target: string, childToParent: Map<string, string>): boolean {
  let current: string | undefined = start
  const seen = new Set<string>()
  while (current && !seen.has(current)) {
    if (current === target) return true
    seen.add(current)
    current = childToParent.get(current)
  }
  return false
}

function sortRows(rows: LineageRow[]): LineageRow[] {
  return [...rows].sort((a, b) => {
    const ts = compareTimestamp(a.timestamp, b.timestamp)
    if (ts !== 0) return ts
    if (a.__fileIndex !== b.__fileIndex) return a.__fileIndex - b.__fileIndex
    return a.__lineIndex - b.__lineIndex
  })
}

function dedupeUuidRows(rows: LineageRow[]): LineageRow[] {
  const seen = new Set<string>()
  const out: LineageRow[] = []
  for (const row of rows) {
    if (!row.uuid || seen.has(row.uuid)) continue
    seen.add(row.uuid)
    out.push(row)
  }
  return out
}

function compareTimestamp(a?: string, b?: string): number {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  return a.localeCompare(b)
}

function selectRelations(records: LineageRecord[], excludedChildren = new Set<string>()): {
  relations: LegacyLineageRelation[]
  ambiguous: LineageAmbiguity[]
} {
  const candidatesByParent = new Map<string, CandidateRelation[]>()
  const blockedByParent = new Map<string, BlockedLineageCandidate[]>()
  const allConfirmedCandidates: CandidateRelation[] = []

  for (const parent of records) {
    for (const child of records) {
      if (parent.sessionId === child.sessionId) continue
      if (excludedChildren.has(child.sessionId)) continue
      const candidate = buildStructuralCandidateRelation(parent, child)
      if (!candidate) continue

      const cwdCompatibility = getCwdCompatibility(parent, child)
      if (cwdCompatibility === 'missing') {
        const list = blockedByParent.get(parent.sessionId) || []
        list.push({
          reason: 'missing-cwd-cannot-confirm-lineage',
          candidate
        })
        blockedByParent.set(parent.sessionId, list)
        continue
      }
      if (cwdCompatibility === 'mismatch') continue

      const list = candidatesByParent.get(parent.sessionId) || []
      list.push(candidate)
      candidatesByParent.set(parent.sessionId, list)
      allConfirmedCandidates.push(candidate)
    }
  }

  const selectedCandidates: CandidateRelation[] = []
  const ambiguous: LineageAmbiguity[] = []

  for (const [sessionId, candidates] of candidatesByParent) {
    candidates.sort(compareCandidates)
    const top = candidates[0]
    const second = candidates[1]

    if (second && isAmbiguousTopCandidate(top, second)) {
      ambiguous.push({
        sessionId,
        reason: 'multiple-equally-plausible-lineage-targets',
        candidates: candidates.slice(0, 3).map((candidate) => ({
          sessionId: candidate.to,
          updatedAt: candidate.toRecord.updatedAt,
          overlapCount: candidate.evidence.overlapCount,
          parentCoverage: candidate.evidence.parentCoverage
        }))
      })
      continue
    }

    selectedCandidates.push(top)
  }

  for (const [sessionId, blocked] of blockedByParent) {
    if (candidatesByParent.has(sessionId)) continue
    blocked.sort((a, b) => compareCandidates(a.candidate, b.candidate))
    ambiguous.push({
      sessionId,
      reason: 'missing-cwd-cannot-confirm-lineage',
      candidates: blocked.slice(0, 3).map(({ candidate }) => ({
        sessionId: candidate.to,
        updatedAt: candidate.toRecord.updatedAt,
        overlapCount: candidate.evidence.overlapCount,
        parentCoverage: candidate.evidence.parentCoverage
      }))
    })
  }

  const relations = removeChildAmbiguities(selectedCandidates, allConfirmedCandidates, ambiguous)
  return { relations, ambiguous }
}

function compareCandidates(a: CandidateRelation, b: CandidateRelation): number {
  // The nearest structural successor is the direct continuation edge. Later
  // resumed copies are reached through its transitive closure, not attached as
  // a second parent of the same child.
  const updated = a.toRecord.updatedAt.localeCompare(b.toRecord.updatedAt)
  if (updated !== 0) return updated
  if (b.evidence.parentCoverage !== a.evidence.parentCoverage) {
    return b.evidence.parentCoverage - a.evidence.parentCoverage
  }
  return b.evidence.overlapCount - a.evidence.overlapCount
}

function isAmbiguousTopCandidate(a: CandidateRelation, b: CandidateRelation): boolean {
  return a.toRecord.updatedAt === b.toRecord.updatedAt &&
    Math.abs(a.evidence.parentCoverage - b.evidence.parentCoverage) < 0.05 &&
    Math.abs(a.evidence.overlapCount - b.evidence.overlapCount) <= 2
}

function buildStructuralCandidateRelation(parent: LineageRecord, child: LineageRecord): CandidateRelation | null {
  if (!isLater(child.updatedAt, parent.updatedAt)) return null
  if (hasForkedFrom(child)) return null

  const overlapCount = countOverlap(parent.uuidSet, child.uuidSet)
  const requiredOverlap = requiredOverlapCount(parent.uuidSet.size)
  if (overlapCount < requiredOverlap) return null

  const parentCoverage = overlapCount / parent.uuidSet.size
  if (parentCoverage < MIN_PARENT_COVERAGE) return null

  const childCoverage = overlapCount / child.uuidSet.size
  const firstNew = child.uuidRows.find((row) => !parent.uuidSet.has(row.uuid))
  if (!firstNew?.parentUuid || !parent.uuidSet.has(firstNew.parentUuid)) return null

  const firstNewIdx = child.uuidRows.findIndex((row) => row.uuid === firstNew.uuid)
  const lastSharedBefore = findLastSharedBefore(child.uuidRows, parent.uuidSet, firstNewIdx)
  if (!lastSharedBefore || lastSharedBefore.uuid !== firstNew.parentUuid) return null

  return {
    from: parent.sessionId,
    to: child.sessionId,
    fromRecord: parent,
    toRecord: child,
    evidence: {
      type: 'uuid-parent-chain',
      overlapCount,
      parentCoverage: roundRatio(parentCoverage),
      childCoverage: roundRatio(childCoverage),
      parentUuid: firstNew.parentUuid,
      childFirstNewUuid: firstNew.uuid,
      childFirstNewAt: firstNew.timestamp || '',
      parentUpdatedAt: parent.updatedAt,
      childUpdatedAt: child.updatedAt,
      cwdMatched: true
    }
  }
}

function isLater(a: string, b: string): boolean {
  return !!a && !!b && a > b
}

function hasForkedFrom(record: LineageRecord): boolean {
  return record.rows.some((row) => !!row.forkedFrom)
}

function getCwdCompatibility(parent: LineageRecord, child: LineageRecord): 'matched' | 'missing' | 'mismatch' {
  if (parent.cwds.size === 0 || child.cwds.size === 0) return 'missing'
  for (const cwd of parent.cwds) {
    if (child.cwds.has(cwd)) return 'matched'
  }
  return 'mismatch'
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0
  for (const value of a) {
    if (b.has(value)) count++
  }
  return count
}

function requiredOverlapCount(parentUuidCount: number): number {
  return Math.min(8, Math.max(2, Math.ceil(parentUuidCount * 0.5)))
}

function findLastSharedBefore(
  rows: LineageRow[],
  parentUuids: Set<string>,
  beforeIndex: number
): LineageRow | null {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    if (parentUuids.has(rows[i].uuid)) return rows[i]
  }
  return null
}

function roundRatio(value: number): number {
  return Number(value.toFixed(3))
}

function removeChildAmbiguities(
  selectedCandidates: CandidateRelation[],
  allConfirmedCandidates: CandidateRelation[],
  ambiguous: LineageAmbiguity[]
): LegacyLineageRelation[] {
  const candidatesByChild = new Map<string, CandidateRelation[]>()
  for (const candidate of selectedCandidates) {
    const list = candidatesByChild.get(candidate.to) || []
    list.push(candidate)
    candidatesByChild.set(candidate.to, list)
  }

  const ambiguousChildren = new Set<string>()
  for (const [childId, candidates] of candidatesByChild) {
    const parentIds = [...new Set(candidates.map((candidate) => candidate.from))]
    if (parentIds.length < 2) continue
    if (areLineageParentsRelated(parentIds, childId, allConfirmedCandidates)) continue

    ambiguousChildren.add(childId)
    ambiguous.push({
      sessionId: childId,
      reason: 'multiple-unrelated-lineage-parents',
      candidates: candidates
        .sort((a, b) => a.from.localeCompare(b.from))
        .map((candidate) => ({
          sessionId: candidate.from,
          updatedAt: candidate.fromRecord.updatedAt,
          overlapCount: candidate.evidence.overlapCount,
          parentCoverage: candidate.evidence.parentCoverage
        }))
    })
  }

  return selectedCandidates
    .filter((candidate) => !ambiguousChildren.has(candidate.to))
    .map((candidate) => ({
      from: candidate.from,
      to: candidate.to,
      evidence: candidate.evidence
    }))
}

function areLineageParentsRelated(
  parentIds: string[],
  childId: string,
  candidates: CandidateRelation[]
): boolean {
  for (let i = 0; i < parentIds.length; i++) {
    for (let j = i + 1; j < parentIds.length; j++) {
      const a = parentIds[i]
      const b = parentIds[j]
      if (!hasCandidatePath(a, b, childId, candidates) && !hasCandidatePath(b, a, childId, candidates)) {
        return false
      }
    }
  }
  return true
}

function hasCandidatePath(
  from: string,
  to: string,
  excludedChildId: string,
  candidates: CandidateRelation[]
): boolean {
  const queue = [from]
  const seen = new Set<string>(queue)

  while (queue.length > 0) {
    const current = queue.shift()!
    for (const candidate of candidates) {
      if (candidate.from !== current) continue
      if (candidate.from === excludedChildId || candidate.to === excludedChildId) continue
      if (candidate.to === to) return true
      if (seen.has(candidate.to)) continue
      seen.add(candidate.to)
      queue.push(candidate.to)
    }
  }

  return false
}

function buildRegistry(
  records: LineageRecord[],
  relations: LineageRelation[],
  broken: BrokenLineageRelation[],
  ambiguous: LineageAmbiguity[],
  options: BuildOptions
): SessionLineageRegistry {
  // aliases are a resume/continuation compatibility surface. Fork edges belong
  // to the tree, but must never redirect a forked physical session on `resolve`.
  const continuationRelations = relations.filter((relation) => relation.type === 'continuation')
  const components = buildComponents(records, continuationRelations)
  const aliases: Record<string, string> = {}
  const latestByRoot: Record<string, string> = {}
  const sessions: Record<string, LineageSessionEntry> = {}
  const incoming = new Set(continuationRelations.map((relation) => relation.child))

  for (const component of components) {
    const sortedByCreated = [...component].sort((a, b) => {
      const created = a.createdAt.localeCompare(b.createdAt)
      if (created !== 0) return created
      return a.sessionId.localeCompare(b.sessionId)
    })
    const sortedByUpdated = [...component].sort((a, b) => {
      const updated = b.updatedAt.localeCompare(a.updatedAt)
      if (updated !== 0) return updated
      return b.sessionId.localeCompare(a.sessionId)
    })

    const rootCandidates = sortedByCreated.filter((record) => !incoming.has(record.sessionId))
    const root = rootCandidates[0] || sortedByCreated[0]
    const latest = sortedByUpdated[0]
    latestByRoot[root.sessionId] = latest.sessionId

    for (const record of component) {
      if (record.sessionId !== latest.sessionId) {
        aliases[record.sessionId] = latest.sessionId
      }
      sessions[record.sessionId] = {
        sessionId: record.sessionId,
        rootSessionId: root.sessionId,
        latestResumeId: latest.sessionId,
        isAlias: record.sessionId !== latest.sessionId,
        source: 'claude-code',
        createdAt: record.createdAt,
        updatedAt: record.updatedAt
      }
    }
  }

  return {
    version: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    libraryRoot: options.libraryRoot || '',
    aliases: sortObject(aliases),
    latestByRoot: sortObject(latestByRoot),
    sessions: sortObject(sessions),
    relations: [...relations].sort((a, b) =>
      a.child.localeCompare(b.child) || a.parent.localeCompare(b.parent) || a.type.localeCompare(b.type)),
    broken: [...broken].sort((a, b) =>
      a.child.localeCompare(b.child) || a.pointUuid.localeCompare(b.pointUuid) || a.type.localeCompare(b.type)),
    ambiguous: [...ambiguous].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    resolutions: []
  }
}

function buildComponents(records: LineageRecord[], relations: LineageRelation[]): LineageRecord[][] {
  const byId = new Map(records.map((record) => [record.sessionId, record]))
  const parent = new Map(records.map((record) => [record.sessionId, record.sessionId]))

  function find(id: string): string {
    const current = parent.get(id)
    if (!current || current === id) return id
    const root = find(current)
    parent.set(id, root)
    return root
  }

  function union(a: string, b: string): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootB, rootA)
  }

  for (const relation of relations) {
    if (!byId.has(relation.parent) || !byId.has(relation.child)) continue
    union(relation.parent, relation.child)
  }

  const grouped = new Map<string, LineageRecord[]>()
  for (const record of records) {
    const root = find(record.sessionId)
    const group = grouped.get(root) || []
    group.push(record)
    grouped.set(root, group)
  }

  return [...grouped.values()]
}

function sortObject<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b))
  ) as Record<string, T>
}
