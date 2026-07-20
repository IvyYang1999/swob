import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { validateBackupJsonl, type BackupValidationOptions } from './backup-validator'
import { materializeICloudBackup } from './icloud-materializer'
import {
  classifyRecoverySourcePath,
  planSessionRecovery,
  type RecoveryPlanFailureReason,
  type RecoveryTargetInstance
} from './resume-recovery-planner'
import { verifyClaudeResumeTarget } from './resume-verifier'
import type { SessionMeta } from './library-manager'

export type ClaudeResumeRecoveryFailureReason =
  | RecoveryPlanFailureReason
  | 'source-not-claude'
  | 'missing-backup'
  | 'unverified-backup'
  | 'materialization-failed'
  | 'recovery-locked'
  | 'target-instance-untrusted'
  | 'target-conflict'
  | 'post-publish-verification-failed'
  | 'io-error'

export type ClaudeResumeRecoveryResult =
  | { ok: true; state: 'source-present' | 'already-present' | 'restored'; sourcePath: string }
  | {
      ok: false
      reason: ClaudeResumeRecoveryFailureReason
      diagnostic?: string
      sourcePath?: string
      published?: boolean
    }

export interface EnsureClaudeResumeTargetOptions {
  sessionId: string
  libraryMeta: SessionMeta
  backupPath: string
  homeDir: string
  localDeviceId?: string
  localUsername: string
  /** Physical Claude session selected by the action; differs from Library logical ID after /resume. */
  physicalSessionId?: string
  preferredTargetInstanceId?: string
  /** Must only be enabled after a user explicitly accepts legacy, unverifiable bytes. */
  allowUnverifiedBackup?: boolean
  lockTimeoutMs?: number
  lockPollMs?: number
}

interface DirectoryIdentity {
  dev: number
  ino: number
  realPath: string
}

const inFlightRecoveries = new Map<string, Promise<ClaudeResumeRecoveryResult>>()

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function existingRegularFile(filePath: string): boolean {
  try {
    const stat = fs.lstatSync(filePath)
    return stat.isFile() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function captureTrustedDirectory(dirPath: string): DirectoryIdentity | null {
  try {
    const lexical = path.resolve(dirPath)
    const stat = fs.lstatSync(lexical)
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    const realPath = fs.realpathSync(lexical)
    // macOS exposes /var through the system /private/var symlink. Trust an
    // ancestor's resolved location, but never a symlink at the directory being
    // authorized itself (the lstat check above owns that boundary).
    const expectedRealPath = path.join(fs.realpathSync(path.dirname(lexical)), path.basename(lexical))
    if (path.normalize(realPath) !== path.normalize(expectedRealPath)) return null
    return { dev: stat.dev, ino: stat.ino, realPath }
  } catch {
    return null
  }
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity | null): boolean {
  return !!right && left.dev === right.dev && left.ino === right.ino && left.realPath === right.realPath
}

function physicalIdFromPath(filePath: string): string | undefined {
  const basename = path.basename(filePath)
  return basename.endsWith('.jsonl') ? basename.slice(0, -'.jsonl'.length) : undefined
}

function sourcePhysicalId(meta: SessionMeta, preferred?: string): string | undefined {
  if (preferred) return preferred
  const ids = meta.sourceFilePaths.map(physicalIdFromPath).filter((value): value is string => !!value)
  return ids[ids.length - 1]
}

function validationOptionsFor(meta: SessionMeta, preferredPhysicalSessionId?: string): BackupValidationOptions {
  return {
    expectedLogicalSessionId: meta.sessionId,
    expectedPhysicalSessionId: sourcePhysicalId(meta, preferredPhysicalSessionId) || meta.sessionId
  }
}

function inventoryInstance(
  id: string,
  kind: RecoveryTargetInstance['kind'],
  projectsRoot: string,
  configDir: string
): RecoveryTargetInstance {
  const rootIdentity = captureTrustedDirectory(projectsRoot)
  const configIdentity = captureTrustedDirectory(configDir)
  if (!rootIdentity || !configIdentity) {
    return { id, kind, projectsRoot, configDir, available: false, trusted: false, existingFiles: [] }
  }

  const existingFiles: RecoveryTargetInstance['existingFiles'] = []
  let trusted = true
  try {
    for (const projectEntry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (projectEntry.name === '.swob-recovery-locks') continue
      const projectPath = path.join(projectsRoot, projectEntry.name)
      const projectStat = fs.lstatSync(projectPath)
      if (projectStat.isSymbolicLink()) {
        trusted = false
        continue
      }
      if (!projectStat.isDirectory()) continue
      if (!captureTrustedDirectory(projectPath)) {
        trusted = false
        continue
      }
      for (const fileEntry of fs.readdirSync(projectPath, { withFileTypes: true })) {
        if (!fileEntry.name.endsWith('.jsonl')) continue
        const filePath = path.join(projectPath, fileEntry.name)
        const fileStat = fs.lstatSync(filePath)
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          trusted = false
          continue
        }
        existingFiles.push({ path: filePath, physicalSessionId: physicalIdFromPath(filePath) })
      }
    }
  } catch {
    trusted = false
  }

  return { id, kind, projectsRoot, configDir, available: true, trusted, existingFiles }
}

/** Build a complete, fail-closed inventory of standard and Claude Window instances. */
export function buildClaudeRecoveryInventory(homeDir: string): RecoveryTargetInstance[] {
  const standardConfig = path.join(homeDir, '.claude')
  const instances: RecoveryTargetInstance[] = [inventoryInstance(
    'claude-default', 'standard', path.join(standardConfig, 'projects'), standardConfig
  )]

  const windowRoot = path.join(homeDir, '.claude-window')
  try {
    const rootStat = fs.lstatSync(windowRoot)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return instances
    for (const entry of fs.readdirSync(windowRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const configDir = path.join(windowRoot, entry.name)
      instances.push(inventoryInstance(
        entry.name, 'claude-window', path.join(configDir, 'projects'), configDir
      ))
    }
  } catch { /* no Claude Window installation */ }
  return instances
}

/** Stable lock key: physical target instance + physical Claude session ID. */
export function recoveryLockPath(projectsRoot: string, instanceId: string, physicalSessionId: string): string {
  const digest = createHash('sha256')
    .update(instanceId)
    .update('\u0000')
    .update(physicalSessionId)
    .digest('hex')
  return path.join(projectsRoot, '.swob-recovery-locks', `${digest}.lock`)
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errno(error) === 'EPERM'
  }
}

async function reapDeadOwnerLock(lockPath: string): Promise<void> {
  const reaperPath = `${lockPath}.reaper`
  let reaper: fsp.FileHandle
  try {
    reaper = await fsp.open(reaperPath, 'wx', 0o600)
  } catch {
    return
  }
  try {
    let ownerPid: number | undefined
    let malformedAndOld = false
    try {
      const raw = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as { pid?: unknown }
      if (typeof raw.pid === 'number') ownerPid = raw.pid
    } catch {
      try {
        malformedAndOld = Date.now() - (await fsp.stat(lockPath)).mtimeMs > 30_000
      } catch { /* another process already released it */ }
    }
    if ((ownerPid !== undefined && !processIsAlive(ownerPid)) || malformedAndOld) {
      try { await fsp.unlink(lockPath) } catch { /* already released */ }
    }
  } finally {
    await reaper.close()
    try { await fsp.unlink(reaperPath) } catch { /* already absent */ }
  }
}

async function acquireRecoveryLock(
  lockPath: string,
  timeoutMs: number,
  pollMs: number
): Promise<(() => Promise<void>) | null> {
  const lockDir = path.dirname(lockPath)
  try {
    await fsp.mkdir(lockDir, { mode: 0o700 })
  } catch (error) {
    if (errno(error) !== 'EEXIST') throw error
  }
  if (!captureTrustedDirectory(lockDir)) throw new Error('untrusted recovery lock directory')

  const ownerNonce = randomUUID()
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ ownerNonce, pid: process.pid, createdAt: Date.now() }))
        await handle.sync()
      } finally {
        await handle.close()
      }
      return async () => {
        try {
          const current = JSON.parse(await fsp.readFile(lockPath, 'utf8')) as { ownerNonce?: unknown }
          if (current.ownerNonce === ownerNonce) await fsp.unlink(lockPath)
        } catch { /* never unlink another owner's lock */ }
      }
    } catch (error) {
      if (errno(error) !== 'EEXIST') throw error
      await reapDeadOwnerLock(lockPath)
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }
}

function planMetaForPhysicalId(meta: SessionMeta, physicalSessionId: string): SessionMeta {
  const matching = meta.sourceFilePaths.filter((filePath) => physicalIdFromPath(filePath) === physicalSessionId)
  if (matching.length === 0) return meta
  return {
    ...meta,
    sourceFilePaths: [...matching, ...meta.sourceFilePaths.filter((filePath) => !matching.includes(filePath))]
  }
}

function planRecovery(
  options: EnsureClaudeResumeTargetOptions,
  content: Buffer,
  instances: RecoveryTargetInstance[]
) {
  const validationOptions = validationOptionsFor(options.libraryMeta, options.physicalSessionId)
  const validation = validateBackupJsonl(content, validationOptions)
  const physicalSessionId = validation.mainChain.physicalSessionId ||
    sourcePhysicalId(options.libraryMeta, options.physicalSessionId)
  if (!validation.ok || !physicalSessionId) {
    return {
      validation,
      plan: null,
      failure: {
        ok: false as const,
        reason: 'invalid-backup' as const,
        diagnostic: validation.errors.map((error) => error.diagnostic).join('; ')
      }
    }
  }
  const plan = planSessionRecovery({
    sessionId: options.sessionId,
    libraryMeta: planMetaForPhysicalId(options.libraryMeta, physicalSessionId),
    backup: { path: options.backupPath, state: 'ready', physicalSessionId },
    targetInstances: instances,
    preferredTargetInstanceId: options.preferredTargetInstanceId,
    localDeviceId: options.localDeviceId,
    localUsername: options.localUsername
  })
  return { validation, plan, failure: null }
}

async function inspectPhysicalIdConflicts(
  instances: RecoveryTargetInstance[],
  physicalSessionId: string,
  source: Buffer,
  validationOptions: BackupValidationOptions
): Promise<ClaudeResumeRecoveryResult | null> {
  const candidates = instances.flatMap((instance) => instance.existingFiles)
    .filter((existing) => existing.physicalSessionId?.toLowerCase() === physicalSessionId.toLowerCase())
  if (candidates.length === 0) return null

  const exact: string[] = []
  for (const candidate of candidates) {
    try {
      const target = await fsp.readFile(candidate.path)
      if (verifyClaudeResumeTarget(source, target, validationOptions).status === 'match') {
        exact.push(candidate.path)
      }
    } catch { /* unreadable is a conflict, never permission to overwrite */ }
  }
  if (candidates.length === 1 && exact.length === 1) {
    return { ok: true, state: 'already-present', sourcePath: exact[0] }
  }
  return {
    ok: false,
    reason: 'target-conflict',
    sourcePath: candidates[0].path,
    diagnostic: `physical session ID already exists at ${candidates.length} target path(s)`
  }
}

function ensureTrustedTargetParent(projectsRoot: string, targetPath: string): DirectoryIdentity | null {
  const rootIdentity = captureTrustedDirectory(projectsRoot)
  if (!rootIdentity) return null
  const parentPath = path.dirname(targetPath)
  const relative = path.relative(projectsRoot, parentPath)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    return null
  }
  try {
    fs.mkdirSync(parentPath, { mode: 0o700 })
  } catch (error) {
    if (errno(error) !== 'EEXIST') return null
  }
  const parentIdentity = captureTrustedDirectory(parentPath)
  if (!parentIdentity) return null
  const realRelative = path.relative(rootIdentity.realPath, parentIdentity.realPath)
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative) || realRelative.includes(path.sep)) {
    return null
  }
  return parentIdentity
}

async function fsyncDirectory(dirPath: string): Promise<void> {
  const handle = await fsp.open(dirPath, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function verifyExistingTarget(
  targetPath: string,
  source: Buffer,
  validationOptions: BackupValidationOptions
): Promise<ClaudeResumeRecoveryResult> {
  try {
    const stat = await fsp.lstat(targetPath)
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, reason: 'target-conflict', sourcePath: targetPath }
    }
    const target = await fsp.readFile(targetPath)
    return verifyClaudeResumeTarget(source, target, validationOptions).status === 'match'
      ? { ok: true, state: 'already-present', sourcePath: targetPath }
      : { ok: false, reason: 'target-conflict', sourcePath: targetPath }
  } catch (error) {
    if (errno(error) === 'ENOENT') {
      return { ok: false, reason: 'io-error', diagnostic: 'target disappeared during verification' }
    }
    return { ok: false, reason: 'io-error', diagnostic: String(error) }
  }
}

async function publishNoOverwrite(
  targetPath: string,
  source: Buffer,
  validationOptions: BackupValidationOptions,
  projectsRoot: string
): Promise<ClaudeResumeRecoveryResult> {
  const rootBefore = captureTrustedDirectory(projectsRoot)
  const parentBefore = ensureTrustedTargetParent(projectsRoot, targetPath)
  if (!rootBefore || !parentBefore) {
    return { ok: false, reason: 'target-instance-untrusted', sourcePath: targetPath }
  }

  try {
    await fsp.lstat(targetPath)
    return verifyExistingTarget(targetPath, source, validationOptions)
  } catch (error) {
    if (errno(error) !== 'ENOENT') {
      return { ok: false, reason: 'target-conflict', sourcePath: targetPath }
    }
  }

  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.swob-${process.pid}-${randomUUID()}.tmp`
  )
  let published = false
  try {
    const handle = await fsp.open(tempPath, 'wx', 0o600)
    try {
      await handle.writeFile(source)
      await handle.sync()
    } finally {
      await handle.close()
    }

    if (!sameDirectoryIdentity(rootBefore, captureTrustedDirectory(projectsRoot)) ||
      !sameDirectoryIdentity(parentBefore, captureTrustedDirectory(path.dirname(targetPath)))) {
      return { ok: false, reason: 'target-instance-untrusted', sourcePath: targetPath }
    }

    try {
      await fsp.link(tempPath, targetPath)
      published = true
      await fsyncDirectory(path.dirname(targetPath))
    } catch (error) {
      if (errno(error) === 'EEXIST') return verifyExistingTarget(targetPath, source, validationOptions)
      throw error
    }

    const rootAfter = captureTrustedDirectory(projectsRoot)
    const parentAfter = captureTrustedDirectory(path.dirname(targetPath))
    const target = await fsp.readFile(targetPath)
    const verification = verifyClaudeResumeTarget(source, target, validationOptions)
    if (!sameDirectoryIdentity(rootBefore, rootAfter) ||
      !sameDirectoryIdentity(parentBefore, parentAfter) ||
      verification.status !== 'match') {
      return {
        ok: false,
        reason: 'post-publish-verification-failed',
        sourcePath: targetPath,
        published: true,
        diagnostic: 'published target retained for manual inspection; it was not unlinked after the race window'
      }
    }
    return { ok: true, state: 'restored', sourcePath: targetPath }
  } catch (error) {
    return {
      ok: false,
      reason: published ? 'post-publish-verification-failed' : 'io-error',
      sourcePath: targetPath,
      published,
      diagnostic: String(error)
    }
  } finally {
    try { await fsp.unlink(tempPath) } catch { /* temp may already be absent */ }
  }
}

async function runRecoveryTransaction(
  options: EnsureClaudeResumeTargetOptions,
  source: Buffer,
  physicalSessionId: string,
  targetInstanceId: string,
  targetProjectsRoot: string
): Promise<ClaudeResumeRecoveryResult> {
  const lockPath = recoveryLockPath(targetProjectsRoot, targetInstanceId, physicalSessionId)
  let release: (() => Promise<void>) | null
  try {
    release = await acquireRecoveryLock(
      lockPath,
      options.lockTimeoutMs ?? 5_000,
      options.lockPollMs ?? 50
    )
  } catch (error) {
    return { ok: false, reason: 'target-instance-untrusted', diagnostic: String(error) }
  }
  if (!release) return { ok: false, reason: 'recovery-locked', sourcePath: lockPath }

  try {
    const refreshedInventory = buildClaudeRecoveryInventory(options.homeDir)
    const planned = planRecovery(options, source, refreshedInventory)
    if (planned.failure) return planned.failure
    const physicalConflict = await inspectPhysicalIdConflicts(
      refreshedInventory,
      physicalSessionId,
      source,
      validationOptionsFor(options.libraryMeta, options.physicalSessionId)
    )
    if (physicalConflict) return physicalConflict
    if (!planned.plan?.ok) {
      return {
        ok: false,
        reason: planned.plan?.reason || 'io-error',
        diagnostic: planned.plan?.diagnostic,
        sourcePath: planned.plan?.target?.path
      }
    }
    return publishNoOverwrite(
      planned.plan.target.path,
      source,
      validationOptionsFor(options.libraryMeta, options.physicalSessionId),
      planned.plan.target.projectsRoot
    )
  } finally {
    await release()
  }
}

async function materializeRecoverySource(
  options: EnsureClaudeResumeTargetOptions
): Promise<
  | { ready: true; content: Buffer }
  | { ready: false; result: ClaudeResumeRecoveryResult }
> {
  const expected = options.libraryMeta.backupSha256 !== undefined || options.libraryMeta.backupSize !== undefined
    ? { sha256: options.libraryMeta.backupSha256, size: options.libraryMeta.backupSize }
    : undefined
  const materialized = await materializeICloudBackup(options.backupPath, {
    expected,
    allowUnverified: options.allowUnverifiedBackup === true,
    validation: validationOptionsFor(options.libraryMeta, options.physicalSessionId)
  })
  if (materialized.ok) return { ready: true, content: materialized.content }
  if ('state' in materialized && materialized.state === 'unverified') {
    if ('content' in materialized && materialized.content) {
      return { ready: true, content: materialized.content }
    }
    return {
      ready: false,
      result: {
        ok: false,
        reason: 'unverified-backup',
        diagnostic: 'backup has no SHA-256/size evidence; explicit legacy confirmation is required'
      }
    }
  }
  if ('lastValidation' in materialized && materialized.lastValidation && !materialized.lastValidation.ok) {
    return {
      ready: false,
      result: {
        ok: false,
        reason: 'invalid-backup',
        diagnostic: materialized.lastValidation.errors.map((error) => error.diagnostic).join('; ')
      }
    }
  }
  return {
    ready: false,
    result: {
      ok: false,
      reason: materialized.reason === 'not-found' ? 'missing-backup' : 'materialization-failed',
      diagnostic: materialized.diagnostic
    }
  }
}

/**
 * Ensure a missing Claude resume target exists using a locked, no-overwrite,
 * fsynced publication transaction. This function never edits Library bytes.
 */
export async function ensureClaudeResumeTarget(
  options: EnsureClaudeResumeTargetOptions
): Promise<ClaudeResumeRecoveryResult> {
  const requiredSources = options.physicalSessionId
    ? options.libraryMeta.sourceFilePaths.filter((sourcePath) =>
        physicalIdFromPath(sourcePath) === options.physicalSessionId)
    : options.libraryMeta.sourceFilePaths
  for (const sourcePath of requiredSources) {
    const source = classifyRecoverySourcePath(sourcePath)
    if (source.kind !== 'non-standard' && existingRegularFile(sourcePath)) {
      return { ok: true, state: 'source-present', sourcePath }
    }
  }
  if (!options.libraryMeta.sourceFilePaths.some((sourcePath) =>
    classifyRecoverySourcePath(sourcePath).kind !== 'non-standard')) {
    return { ok: false, reason: 'source-not-claude' }
  }

  const materialized = await materializeRecoverySource(options)
  if (!materialized.ready) return materialized.result

  const initialInventory = buildClaudeRecoveryInventory(options.homeDir)
  const planned = planRecovery(options, materialized.content, initialInventory)
  if (planned.failure) return planned.failure
  const physicalSessionId = planned.validation.mainChain.physicalSessionId ||
    sourcePhysicalId(options.libraryMeta, options.physicalSessionId)
  if (!physicalSessionId || !planned.plan) {
    return { ok: false, reason: 'invalid-backup', diagnostic: 'physical session ID is unavailable' }
  }

  const physicalConflict = await inspectPhysicalIdConflicts(
    initialInventory,
    physicalSessionId,
    materialized.content,
    validationOptionsFor(options.libraryMeta, options.physicalSessionId)
  )
  if (physicalConflict) return physicalConflict
  if (!planned.plan.ok) {
    return {
      ok: false,
      reason: planned.plan.reason,
      diagnostic: planned.plan.diagnostic,
      sourcePath: planned.plan.target?.path
    }
  }

  const inFlightKey = `${planned.plan.target.instanceId}\u0000${physicalSessionId}`
  const existing = inFlightRecoveries.get(inFlightKey)
  if (existing) return existing
  const recovery = runRecoveryTransaction(
    options,
    materialized.content,
    physicalSessionId,
    planned.plan.target.instanceId,
    planned.plan.target.projectsRoot
  )
  inFlightRecoveries.set(inFlightKey, recovery)
  try {
    return await recovery
  } finally {
    if (inFlightRecoveries.get(inFlightKey) === recovery) inFlightRecoveries.delete(inFlightKey)
  }
}
