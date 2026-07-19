import * as path from 'path'
import type { SessionMeta } from './library-manager'
import { resolveSessionRemoteState } from './session-remote-state'

export type RecoveryInstanceKind = 'standard' | 'claude-window' | 'non-standard'

export interface RecoveryExistingFile {
  path: string
  physicalSessionId?: string
}

/**
 * A caller-produced, read-only inventory. The planner never discovers instances
 * itself: filesystem inspection belongs to a separate adapter/validation layer.
 */
export interface RecoveryTargetInstance {
  id: string
  kind: RecoveryInstanceKind
  projectsRoot: string
  configDir?: string
  available: boolean
  /** Explicit result of trusted-root/symlink validation by the inventory adapter. */
  trusted: boolean
  /** Explicit, complete file inventory. An empty array means inventoried and empty. */
  existingFiles: RecoveryExistingFile[]
}

export type RecoveryBackupState = 'ready' | 'icloud-placeholder' | 'invalid' | 'missing'

export interface RecoveryBackupDescriptor {
  path: string
  state: RecoveryBackupState
  /** Result of a separate strict validator. Defaults to the source filename stem. */
  physicalSessionId?: string
  diagnostic?: string
}

export interface RecoveryPlannerInput {
  sessionId: string
  libraryMeta: SessionMeta
  backup: RecoveryBackupDescriptor
  targetInstances: RecoveryTargetInstance[]
  /** Required to authorize an import from a known different device or non-standard source. */
  preferredTargetInstanceId?: string
  /** Installation identity used to distinguish this installation from another one. */
  localDeviceId?: string
  /** Required for the legacy path fallback when origin.deviceId is absent. */
  localUsername?: string
}

export interface ClassifiedRecoverySource {
  kind: RecoveryInstanceKind
  path: string
  projectDirName?: string
  fileName?: string
  instanceId?: string
  configDir?: string
}

export type RecoveryConflictCode = 'target-path-exists' | 'physical-id-exists'

export interface RecoveryConflict {
  code: RecoveryConflictCode
  path: string
  physicalSessionId?: string
}

export type RecoveryRoute =
  | 'original-instance'
  | 'import-to-standard'
  | 'import-to-window'
  | 'selected-import'

export interface RecoveryPlanTarget {
  instanceId: string
  instanceKind: Exclude<RecoveryInstanceKind, 'non-standard'>
  projectsRoot: string
  configDir?: string
  path: string
  route: RecoveryRoute
}

export type RecoveryPlanFailureReason =
  | 'session-id-mismatch'
  | 'missing-source-path'
  | 'invalid-source-path'
  | 'missing-backup'
  | 'invalid-backup'
  | 'remote-source-requires-explicit-target'
  | 'non-standard-source-requires-explicit-target'
  | 'target-instance-not-found'
  | 'target-instance-unavailable'
  | 'target-instance-untrusted'
  | 'missing-target-inventory'
  | 'target-inventory-incomplete'
  | 'target-instance-missing-config-dir'
  | 'missing-local-device-id'
  | 'missing-local-username'
  | 'non-standard-target-refused'
  | 'target-conflict'

interface RecoveryPlanBase {
  sessionId: string
  logicalSessionId: string
  physicalSessionId?: string
  source?: ClassifiedRecoverySource
  target?: RecoveryPlanTarget
  conflicts: RecoveryConflict[]
  materializeFiles: string[]
}

export interface RecoveryPlanSuccess extends RecoveryPlanBase {
  ok: true
  state: 'ready' | 'needs-materialization'
  physicalSessionId: string
  source: ClassifiedRecoverySource
  target: RecoveryPlanTarget
}

export interface RecoveryPlanFailure extends RecoveryPlanBase {
  ok: false
  reason: RecoveryPlanFailureReason
  diagnostic?: string
}

export type RecoveryPlan = RecoveryPlanSuccess | RecoveryPlanFailure

function failure(
  input: RecoveryPlannerInput,
  reason: RecoveryPlanFailureReason,
  extra: Partial<RecoveryPlanFailure> = {}
): RecoveryPlanFailure {
  return {
    ok: false,
    reason,
    sessionId: input.sessionId,
    logicalSessionId: input.libraryMeta.sessionId,
    conflicts: [],
    materializeFiles: input.backup.state === 'icloud-placeholder' ? [input.backup.path] : [],
    ...extra
  }
}

/** Pure lexical classification; it does not resolve symlinks or touch the filesystem. */
export function classifyRecoverySourcePath(sourcePath: string): ClassifiedRecoverySource {
  const normalized = sourcePath.split(path.sep).join('/')
  const windowMatch = normalized.match(
    /^(.*\/\.claude-window\/([^/]+))\/projects\/([^/]+)\/([^/]+\.jsonl)$/
  )
  if (path.isAbsolute(sourcePath) && windowMatch) {
    return {
      kind: 'claude-window',
      path: path.normalize(sourcePath),
      configDir: windowMatch[1],
      instanceId: windowMatch[2],
      projectDirName: windowMatch[3],
      fileName: windowMatch[4]
    }
  }

  const standardMatch = normalized.match(
    /^(.*\/\.claude)\/projects\/([^/]+)\/([^/]+\.jsonl)$/
  )
  if (path.isAbsolute(sourcePath) && standardMatch) {
    return {
      kind: 'standard',
      path: path.normalize(sourcePath),
      configDir: standardMatch[1],
      projectDirName: standardMatch[2],
      fileName: standardMatch[3]
    }
  }

  if (path.isAbsolute(sourcePath) && path.basename(sourcePath).endsWith('.jsonl')) {
    return {
      kind: 'non-standard',
      path: path.normalize(sourcePath),
      projectDirName: path.basename(path.dirname(sourcePath)),
      fileName: path.basename(sourcePath)
    }
  }
  return { kind: 'non-standard', path: sourcePath }
}

function findPreferredTarget(
  input: RecoveryPlannerInput
): RecoveryTargetInstance | RecoveryPlanFailure | undefined {
  if (!input.preferredTargetInstanceId) return undefined
  const target = input.targetInstances.find((instance) => instance.id === input.preferredTargetInstanceId)
  if (!target) return failure(input, 'target-instance-not-found')
  return target
}

function findAutomaticTarget(
  input: RecoveryPlannerInput,
  source: ClassifiedRecoverySource
): RecoveryTargetInstance | undefined {
  if (source.kind === 'claude-window') {
    const originalWindow = input.targetInstances.find(
      (instance) => instance.kind === 'claude-window' && instance.id === source.instanceId && instance.available
    )
    if (originalWindow) return originalWindow
  }
  return input.targetInstances.find((instance) => instance.kind === 'standard')
}

function routeFor(
  source: ClassifiedRecoverySource,
  target: RecoveryTargetInstance,
  targetPath: string,
  explicitlySelected: boolean
): RecoveryRoute {
  if (explicitlySelected && path.normalize(targetPath) !== path.normalize(source.path)) return 'selected-import'
  if (path.normalize(targetPath) === path.normalize(source.path)) return 'original-instance'
  return target.kind === 'standard' ? 'import-to-standard' : 'import-to-window'
}

/**
 * Approximate the default case-insensitive APFS comparison used by supported
 * macOS installations. This is lexical only; the inventory adapter still owns
 * realpath, volume-format, and symlink validation.
 */
function caseFoldPath(value: string): string {
  return path.normalize(value).normalize('NFC').toLowerCase()
}

function caseFoldIdentity(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

function hasCompleteTargetInventory(target: RecoveryTargetInstance): boolean {
  return typeof target.trusted === 'boolean' &&
    Array.isArray(target.existingFiles) &&
    target.existingFiles.every((existing) =>
      existing !== null &&
      typeof existing === 'object' &&
      typeof existing.path === 'string' &&
      existing.path.length > 0 &&
      (existing.physicalSessionId === undefined || typeof existing.physicalSessionId === 'string')
    )
}

function predictConflicts(
  target: RecoveryTargetInstance,
  targetPath: string,
  physicalSessionId: string
): RecoveryConflict[] {
  const conflicts: RecoveryConflict[] = []
  const seen = new Set<string>()
  for (const existing of target.existingFiles) {
    const normalizedExisting = path.normalize(existing.path)
    if (caseFoldPath(normalizedExisting) === caseFoldPath(targetPath)) {
      const key = `target-path-exists:${caseFoldPath(normalizedExisting)}`
      if (!seen.has(key)) {
        seen.add(key)
        conflicts.push({
          code: 'target-path-exists',
          path: existing.path,
          physicalSessionId: existing.physicalSessionId
        })
      }
    }
    if (
      existing.physicalSessionId &&
      caseFoldIdentity(existing.physicalSessionId) === caseFoldIdentity(physicalSessionId)
    ) {
      const key = `physical-id-exists:${caseFoldPath(normalizedExisting)}`
      if (!seen.has(key)) {
        seen.add(key)
        conflicts.push({
          code: 'physical-id-exists',
          path: existing.path,
          physicalSessionId
        })
      }
    }
  }
  return conflicts
}

/**
 * Build a recovery plan from immutable metadata and a precomputed inventory.
 * No fs module is imported, no path is probed, and no directory/file is created.
 */
export function planSessionRecovery(input: RecoveryPlannerInput): RecoveryPlan {
  if (input.libraryMeta.sessionId !== input.sessionId) {
    return failure(input, 'session-id-mismatch')
  }
  if (input.backup.state === 'missing') return failure(input, 'missing-backup')
  if (input.backup.state === 'invalid') {
    return failure(input, 'invalid-backup', { diagnostic: input.backup.diagnostic })
  }
  if (!Array.isArray(input.targetInstances)) {
    return failure(input, 'missing-target-inventory')
  }

  const sourcePath = input.libraryMeta.sourceFilePaths?.[0]
  if (!sourcePath) return failure(input, 'missing-source-path')
  const source = classifyRecoverySourcePath(sourcePath)
  if (source.kind !== 'non-standard' && (!source.projectDirName || !source.fileName)) {
    return failure(input, 'invalid-source-path', { source })
  }

  const physicalSessionId = input.backup.physicalSessionId || (
    source.fileName ? path.basename(source.fileName, '.jsonl') : undefined
  )
  if (!physicalSessionId) {
    return failure(input, 'invalid-source-path', { source })
  }

  if (input.libraryMeta.origin?.deviceId && !input.localDeviceId) {
    return failure(input, 'missing-local-device-id', { source, physicalSessionId })
  }

  const preferred = findPreferredTarget(input)
  if (preferred && 'ok' in preferred) {
    return { ...preferred, source, physicalSessionId }
  }

  if (!input.libraryMeta.origin?.deviceId && !preferred && !input.localUsername) {
    return failure(input, 'missing-local-username', { source, physicalSessionId })
  }
  const isKnownRemote = resolveSessionRemoteState(
    input.libraryMeta,
    input.localDeviceId,
    input.localUsername
  ).isRemote
  if (isKnownRemote && !preferred) {
    return failure(input, 'remote-source-requires-explicit-target', { source, physicalSessionId })
  }
  if (source.kind === 'non-standard' && !preferred) {
    return failure(input, 'non-standard-source-requires-explicit-target', { source, physicalSessionId })
  }

  const target = preferred || findAutomaticTarget(input, source)
  if (!target) return failure(input, 'target-instance-not-found', { source, physicalSessionId })
  if (target.kind === 'non-standard') {
    return failure(input, 'non-standard-target-refused', { source, physicalSessionId })
  }
  if (!target.available) {
    return failure(input, 'target-instance-unavailable', { source, physicalSessionId })
  }
  if (!hasCompleteTargetInventory(target)) {
    return failure(input, 'target-inventory-incomplete', { source, physicalSessionId })
  }
  if (!target.trusted || !path.isAbsolute(target.projectsRoot)) {
    return failure(input, 'target-instance-untrusted', { source, physicalSessionId })
  }
  if (target.kind === 'claude-window') {
    const configDir = target.configDir
    if (!configDir) {
      return failure(input, 'target-instance-missing-config-dir', { source, physicalSessionId })
    }
    if (!path.isAbsolute(configDir)) {
      return failure(input, 'target-instance-untrusted', { source, physicalSessionId })
    }
  }

  const projectDirName = source.projectDirName || path.basename(input.libraryMeta.projectPath || '')
  if (!projectDirName || projectDirName === '.' || projectDirName === '..' || projectDirName.includes(path.sep)) {
    return failure(input, 'invalid-source-path', { source, physicalSessionId })
  }
  const fileName = source.fileName || `${physicalSessionId}.jsonl`
  const targetPath = path.join(target.projectsRoot, projectDirName, fileName)
  const planTarget: RecoveryPlanTarget = {
    instanceId: target.id,
    instanceKind: target.kind,
    projectsRoot: target.projectsRoot,
    configDir: target.configDir,
    path: targetPath,
    route: routeFor(source, target, targetPath, Boolean(preferred))
  }
  const conflicts = predictConflicts(target, targetPath, physicalSessionId)
  if (conflicts.length > 0) {
    return failure(input, 'target-conflict', {
      source,
      physicalSessionId,
      target: planTarget,
      conflicts
    })
  }

  return {
    ok: true,
    state: input.backup.state === 'icloud-placeholder' ? 'needs-materialization' : 'ready',
    sessionId: input.sessionId,
    logicalSessionId: input.libraryMeta.sessionId,
    physicalSessionId,
    source,
    target: planTarget,
    conflicts,
    materializeFiles: input.backup.state === 'icloud-placeholder' ? [input.backup.path] : []
  }
}
