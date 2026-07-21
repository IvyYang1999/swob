import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { friendlyProjectName } from '../shared/vault-lens'

const SESSION_MARKER = '.swob-session.json'
const OPERATIONS_DIR = path.join('.swob', 'operations')

export type OrganizationKind = 'manual' | 'project' | 'smart' | 'archive'

export interface SessionClassificationPatch {
  tags?: string[]
  topic?: string
  topicConfidence?: number
}

export interface OrganizationInput {
  sessionId: string
  sourceDir: string
  targetRelativeFolder: string
  metaPatch?: SessionClassificationPatch
}

export interface OrganizationMove {
  sessionId: string
  from: string
  to: string
  metaBefore: {
    tags: string[] | null
    topic: string | null
    topicConfidence: number | null
  }
  metaAfter?: SessionClassificationPatch
}

interface OrganizationLog {
  id: string
  kind: OrganizationKind
  status: 'planned' | 'partial' | 'applied' | 'undone'
  createdAt: string
  updatedAt: string
  appliedCount: number
  moves: OrganizationMove[]
  /** Directories created solely for this operation; empty ones are pruned on undo. */
  createdDirectories: string[]
}

export interface OrganizationResult {
  operationId: string | null
  logPath: string | null
  moves: OrganizationMove[]
}

export interface ProjectPreviewSession {
  id: string
  sessionId?: string
  cwds?: string[]
  projectPath?: string
  firstUserMessage?: string
  libraryDirPath?: string
}

export interface ProjectOrganizationPreviewItem extends OrganizationInput {
  title: string
  fromRelative: string
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function sanitizeSegment(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

export function sanitizeRelativeFolder(value: string): string {
  if (!value.trim() || path.isAbsolute(value)) throw new Error('目标文件夹必须是 Vault 内的相对路径')
  // '.' targets the vault root itself (loose sessions live there by default).
  if (value.trim() === '.') return ''
  const rawSegments = value.split(/[\\/]+/)
  if (rawSegments.some((segment) => segment.trim() === '..' || segment.trim() === '.')) {
    throw new Error('目标文件夹不能包含路径穿越')
  }
  const segments = rawSegments.map(sanitizeSegment).filter(Boolean)
  if (segments.length === 0) throw new Error('目标文件夹名称无效')
  return path.join(...segments)
}

function readMarker(dirPath: string, expectedSessionId?: string): Record<string, unknown> {
  const markerPath = path.join(dirPath, SESSION_MARKER)
  if (!fs.existsSync(markerPath)) throw new Error(`拒绝移动：${dirPath} 没有会话包标记`)
  let meta: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid marker')
    meta = parsed as Record<string, unknown>
  } catch {
    throw new Error(`拒绝移动：${dirPath} 的会话包标记损坏`)
  }
  if (typeof meta.sessionId !== 'string' || !meta.sessionId) {
    throw new Error(`拒绝移动：${dirPath} 的会话包标记缺少 sessionId`)
  }
  if (expectedSessionId && meta.sessionId !== expectedSessionId) {
    throw new Error(`拒绝移动：会话 ID 与 ${dirPath} 的标记不一致`)
  }
  return meta
}

function classificationSnapshot(meta: Record<string, unknown>): OrganizationMove['metaBefore'] {
  return {
    tags: Array.isArray(meta.tags) && meta.tags.every((tag) => typeof tag === 'string') ? [...meta.tags] as string[] : null,
    topic: typeof meta.topic === 'string' ? meta.topic : null,
    topicConfidence: typeof meta.topicConfidence === 'number' ? meta.topicConfidence : null
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const fd = fs.openSync(tempPath, 'w', 0o600)
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf-8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tempPath, filePath)
}

function writeMarker(dirPath: string, meta: Record<string, unknown>): void {
  writeJsonAtomically(path.join(dirPath, SESSION_MARKER), meta)
}

function applyMetaPatch(dirPath: string, patch: SessionClassificationPatch): void {
  const meta = readMarker(dirPath)
  if (patch.tags !== undefined) {
    meta.tags = [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))]
  }
  if (patch.topic !== undefined) meta.topic = patch.topic.trim()
  if (patch.topicConfidence !== undefined) {
    meta.topicConfidence = Math.max(0, Math.min(1, patch.topicConfidence))
  }
  writeMarker(dirPath, meta)
}

function restoreMeta(dirPath: string, snapshot: OrganizationMove['metaBefore']): void {
  const meta = readMarker(dirPath)
  if (snapshot.tags === null) delete meta.tags
  else meta.tags = snapshot.tags
  if (snapshot.topic === null) delete meta.topic
  else meta.topic = snapshot.topic
  if (snapshot.topicConfidence === null) delete meta.topicConfidence
  else meta.topicConfidence = snapshot.topicConfidence
  writeMarker(dirPath, meta)
}

function uniqueDestination(targetFolder: string, baseName: string, reserved: Set<string>): string {
  let candidate = path.join(targetFolder, baseName)
  let suffix = 2
  while (fs.existsSync(candidate) || reserved.has(candidate)) {
    candidate = path.join(targetFolder, `${baseName} (${suffix})`)
    suffix++
  }
  reserved.add(candidate)
  return candidate
}

function buildMoves(root: string, inputs: readonly OrganizationInput[]): OrganizationMove[] {
  const rootPath = path.resolve(root)
  const seenSessionIds = new Set<string>()
  const reserved = new Set<string>()

  return inputs.flatMap((input) => {
    if (!input.sessionId || seenSessionIds.has(input.sessionId)) {
      throw new Error(`整理清单含有重复或无效 sessionId：${input.sessionId}`)
    }
    seenSessionIds.add(input.sessionId)
    const sourceDir = path.resolve(input.sourceDir)
    if (!isInside(rootPath, sourceDir)) throw new Error('只能移动当前 Vault 内的会话包')
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
      throw new Error(`会话包不存在：${input.sessionId}`)
    }
    const meta = readMarker(sourceDir, input.sessionId)
    const relativeFolder = sanitizeRelativeFolder(input.targetRelativeFolder)
    const targetFolder = path.resolve(rootPath, relativeFolder)
    if (!isInside(rootPath, targetFolder)) throw new Error('目标文件夹超出 Vault')
    if (path.dirname(sourceDir) === targetFolder) return []

    const targetPath = uniqueDestination(targetFolder, path.basename(sourceDir), reserved)
    return [{
      sessionId: input.sessionId,
      from: sourceDir,
      to: targetPath,
      metaBefore: classificationSnapshot(meta),
      metaAfter: input.metaPatch
    }]
  })
}

function logFilePath(root: string, operationId: string, timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, '-')
  return path.join(root, OPERATIONS_DIR, `${safeTimestamp}-${operationId}.json`)
}

function plannedCreatedDirectories(root: string, moves: readonly OrganizationMove[]): string[] {
  const rootPath = path.resolve(root)
  const directories = new Set<string>()
  for (const move of moves) {
    let cursor = path.dirname(move.to)
    while (cursor !== rootPath && isInside(rootPath, cursor)) {
      if (fs.existsSync(cursor)) break
      directories.add(cursor)
      cursor = path.dirname(cursor)
    }
  }
  return [...directories].sort((a, b) => b.length - a.length)
}

export function executeOrganization(
  root: string,
  kind: OrganizationKind,
  inputs: readonly OrganizationInput[],
  options: { now?: Date; beforeFirstMove?: (logPath: string) => void } = {}
): OrganizationResult {
  const moves = buildMoves(root, inputs)
  if (moves.length === 0) return { operationId: null, logPath: null, moves: [] }

  const now = options.now || new Date()
  const operationId = randomUUID()
  const logPath = logFilePath(root, operationId, now.toISOString())
  const log: OrganizationLog = {
    id: operationId,
    kind,
    status: 'planned',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    appliedCount: 0,
    moves,
    createdDirectories: plannedCreatedDirectories(root, moves)
  }

  // Durability boundary: the complete reverse plan exists before the first rename.
  writeJsonAtomically(logPath, log)
  options.beforeFirstMove?.(logPath)

  try {
    for (const move of moves) {
      fs.mkdirSync(path.dirname(move.to), { recursive: true })
      readMarker(move.from, move.sessionId)
      fs.renameSync(move.from, move.to)
      if (move.metaAfter) applyMetaPatch(move.to, move.metaAfter)
      log.appliedCount++
      log.status = 'partial'
      log.updatedAt = new Date().toISOString()
      writeJsonAtomically(logPath, log)
    }
    log.status = 'applied'
    log.updatedAt = new Date().toISOString()
    writeJsonAtomically(logPath, log)
  } catch (error) {
    log.status = 'partial'
    log.updatedAt = new Date().toISOString()
    try { writeJsonAtomically(logPath, log) } catch { /* preserve original move error */ }
    throw error
  }

  return { operationId, logPath, moves }
}

function latestUndoableLog(root: string): { logPath: string; log: OrganizationLog } | null {
  const dir = path.join(root, OPERATIONS_DIR)
  if (!fs.existsSync(dir)) return null
  const candidates = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse()
  for (const name of candidates) {
    const logPath = path.join(dir, name)
    try {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as OrganizationLog
      if (log.status === 'applied' || log.status === 'partial') return { logPath, log }
    } catch { /* skip corrupt log; never guess a reverse plan */ }
  }
  return null
}

export function undoLastOrganization(root: string): OrganizationResult {
  const found = latestUndoableLog(root)
  if (!found) return { operationId: null, logPath: null, moves: [] }
  const { log, logPath } = found
  const appliedMoves = log.moves.slice(0, log.appliedCount)

  // Preflight the entire reverse operation before changing the filesystem.
  for (const move of appliedMoves) {
    if (fs.existsSync(move.to)) {
      readMarker(move.to, move.sessionId)
      if (fs.existsSync(move.from)) throw new Error(`无法撤销：原位置已被占用 ${move.from}`)
    } else if (!fs.existsSync(move.from)) {
      throw new Error(`无法撤销：会话包不在记录的任一位置 ${move.sessionId}`)
    }
  }

  const reversed: OrganizationMove[] = []
  for (const move of [...appliedMoves].reverse()) {
    if (!fs.existsSync(move.to)) continue
    fs.mkdirSync(path.dirname(move.from), { recursive: true })
    fs.renameSync(move.to, move.from)
    restoreMeta(move.from, move.metaBefore)
    reversed.push({ ...move, from: move.to, to: move.from })
  }

  // Only remove directories that did not exist before this operation, and only
  // while they are still empty. New user content is therefore never touched.
  for (const dirPath of log.createdDirectories || []) {
    try { fs.rmdirSync(dirPath) } catch { /* non-empty, absent, or externally changed: keep it */ }
  }

  log.status = 'undone'
  log.updatedAt = new Date().toISOString()
  writeJsonAtomically(logPath, log)
  return { operationId: log.id, logPath, moves: reversed }
}

function projectIdentity(session: ProjectPreviewSession): string {
  return session.cwds?.find((cwd) => cwd.trim()) || session.projectPath?.trim() || `unknown:${session.id}`
}

function basename(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function buildProjectOrganizationPreview(
  root: string,
  sessions: readonly ProjectPreviewSession[]
): ProjectOrganizationPreviewItem[] {
  const identities = new Map<string, { baseLabel: string; parentLabel: string }>()
  const baseCounts = new Map<string, number>()
  for (const session of sessions) {
    const identity = projectIdentity(session)
    const baseLabel = friendlyProjectName({
      id: session.id,
      updatedAt: '',
      turnCount: 0,
      cwds: session.cwds,
      projectPath: session.projectPath
    })
    if (!identities.has(identity)) {
      identities.set(identity, {
        baseLabel,
        parentLabel: basename(identity.slice(0, identity.replace(/\\/g, '/').lastIndexOf('/')))
      })
      baseCounts.set(baseLabel, (baseCounts.get(baseLabel) || 0) + 1)
    }
  }

  return sessions.flatMap((session) => {
    if (!session.libraryDirPath) return []
    const identity = projectIdentity(session)
    const labels = identities.get(identity)!
    const targetLabel = (baseCounts.get(labels.baseLabel) || 0) > 1 && labels.parentLabel
      ? `${labels.baseLabel} · ${labels.parentLabel}`
      : labels.baseLabel
    const targetRelativeFolder = sanitizeRelativeFolder(targetLabel)
    if (path.resolve(path.dirname(session.libraryDirPath)) === path.resolve(root, targetRelativeFolder)) return []
    return [{
      sessionId: session.sessionId || session.id,
      sourceDir: session.libraryDirPath,
      targetRelativeFolder,
      title: session.firstUserMessage?.trim() || session.id,
      fromRelative: path.relative(root, session.libraryDirPath)
    }]
  })
}
