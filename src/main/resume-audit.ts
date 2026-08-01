import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import { spawn } from 'child_process'
import { runtimeHome } from './runtime-home'
import {
  findLibraryOnlySessions,
  getSessionResumeAvailability
} from './library-manager'
import {
  buildSessionSummaryFromBackup,
  findClaudeProjectRoots,
  findSessionFilesInProjectRoots,
  getClaudeConfigDirForSessionFile,
  loadAllSessions,
  loadSessionDetail,
  parseSessionFile
} from './session-loader'
import { findCodexSessionFiles, loadCodexRawMessages } from './codex-loader'
import { findCursorResumeStores } from './cursor-loader'
import {
  getSqliteAgentDbPath,
  hasSqliteAgentSessionRecord,
  isValidOpencodeSessionId,
  loadSqliteAgentRawMessages,
  stripSqliteAgentSessionRef,
  type SqliteAgentSource
} from './opencode-loader'
import {
  buildResumeCommand,
  resolveSessionActionContext
} from './session-actions'
import {
  anchorsFromMessages,
  classifyResumeL3,
  parsedAnchorMessages,
  rawAnchorMessages,
  selectClaudeDefaultChain,
  type ResumeAnchorMessage,
  type ResumeAnchors,
  type ResumeL3MismatchKind,
  type ResumeL3TargetData
} from './resume-verifier'
import type { RawJsonlMessage, SessionSource, SessionSummary } from './types'

export { normalizeResumeAuditText } from './resume-verifier'

export const RESUME_AUDIT_SOURCES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'zcode'
] as const satisfies readonly SessionSource[]

export type ResumeAuditSource = (typeof RESUME_AUDIT_SOURCES)[number]

export type ResumeAuditFailureCode =
  | 'resume-unavailable'
  | 'intra-file-branch'
  | 'command-build-failed'
  | 'invalid-session-id'
  | 'source-missing'
  | 'db-record-missing'

export interface ResumeAuditReasonStat {
  level: 'L1' | 'L2'
  code: ResumeAuditFailureCode
  message: string
  count: number
  exampleSessionId: string
}

export interface ResumeAuditEnvironmentStat {
  binary: string
  count: number
  exampleSessionId: string
}

export interface ResumeAuditLevelStats {
  l1: { ok: number; fail: number }
  l2: { ok: number; fail: number; envMissing: number }
  l3: ResumeAuditL3Stats
}

export type ResumeAuditMismatchKind = ResumeL3MismatchKind

export interface ResumeAuditAnchorExample {
  sessionId: string
  userAnchor: string
  assistantAnchor: string
  classification?: ResumeAuditMismatchKind
}

export interface ResumeAuditL3Stats {
  match: number
  mismatch: {
    total: number
    wrongBranch: number
    stale: number
    empty: number
  }
  would404: number
  skipped: number
  skippedReasons: {
    expectedAnchorEmpty: number
  }
  mismatchExamples: ResumeAuditAnchorExample[]
  would404Examples: ResumeAuditAnchorExample[]
}

export interface ResumeAuditStats extends ResumeAuditLevelStats {
  total: number
  ok: number
  fail: number
  envMissing: number
  /** Fully verified among sessions whose harness CLI is available. */
  successRate: number | null
  /** Fully verified among every discovered session, including environment gaps. */
  verifiedRate: number | null
  failureReasons: ResumeAuditReasonStat[]
  environmentMissing: ResumeAuditEnvironmentStat[]
}

export interface ResumeAuditReport extends ResumeAuditStats {
  generatedAt: string
  readOnly: true
  perSource: Record<ResumeAuditSource, ResumeAuditStats>
}

export interface ResumeAuditOptions {
  sessions?: SessionSummary[]
  pathEnv?: string
  home?: string
  now?: () => Date
  binaryAvailable?: (binary: string, pathEnv: string) => boolean
  /** Canonical harness targets; tests may override discovery without changing HOME. */
  resumeTargets?: Partial<Record<ResumeAuditSource, string[]>>
  dbRecordExists?: (
    source: SqliteAgentSource,
    sourceRef: string,
    sessionId: string
  ) => Promise<boolean>
}

interface AuditOutcome {
  source: ResumeAuditSource
  sessionId: string
  status: 'ok' | 'fail' | 'env-missing' | 'skipped'
  level: 'L1' | 'L2' | 'L3'
  failureCode?: ResumeAuditFailureCode
  binary?: string
  l3Status?: 'match' | 'mismatch' | 'would-404' | 'skipped'
  l3SkipReason?: 'expected-anchor-empty'
  mismatchKind?: ResumeAuditMismatchKind
  expectedAnchors?: ResumeAuditAnchors
}

type ResumeAuditAnchors = ResumeAnchors
type AnchorMessage = ResumeAnchorMessage
type ResumeTargetData = ResumeL3TargetData

interface ResumeAuditRuntime {
  options: ResumeAuditOptions
  targets: Record<ResumeAuditSource, string[]>
  rawFileCache: Map<string, Promise<RawJsonlMessage[]>>
  sqliteSnapshots: Map<string, string>
  snapshotDirs: string[]
}

interface SqliteJsonRow {
  kind: 'meta' | 'blob'
  id: string
  data: string
}

interface WireField {
  number: number
  wireType: number
  bytes?: Buffer
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BINARY_BY_SOURCE: Record<ResumeAuditSource, string> = {
  'claude-code': 'claude',
  codex: 'codex',
  cursor: 'cursor',
  opencode: 'opencode',
  zcode: 'zcode'
}

const FAILURE_MESSAGES: Record<ResumeAuditFailureCode, string> = {
  'resume-unavailable': '会话已明确标记为不可恢复',
  'intra-file-branch': '文件内分支不能独立恢复',
  'command-build-failed': 'resume 命令构建失败',
  'invalid-session-id': 'session id 格式不合法',
  'source-missing': '源文件或数据库不存在',
  'db-record-missing': '数据库中不存在对应 session 记录'
}

const MISMATCH_FIXES: Record<ResumeAuditMismatchKind, string> = {
  'wrong-branch': '修正 resume id 或默认 leaf 选择，使恢复链指向 transcript 的尾部锚点',
  stale: '重算 lineage/resumeSessionId，确保真实目标包含 transcript 的最新锚点',
  empty: '检查目标会话的消息落盘与 DB 关联，恢复内容前不要改写用户数据'
}

const SQLITE_TIMEOUT_MS = 10_000

function sourceOf(session: SessionSummary): ResumeAuditSource {
  return (session.source || 'claude-code') as ResumeAuditSource
}

function emptyTarget(status: ResumeTargetData['status']): ResumeTargetData {
  return { status, defaultMessages: [], allMessages: [] }
}

async function loadExpectedAnchors(
  session: SessionSummary,
  runtime: ResumeAuditRuntime
): Promise<ResumeAuditAnchors> {
  try {
    const source = sourceOf(session)
    if (source === 'opencode' || source === 'zcode') {
      const dbPath = stripSqliteAgentSessionRef(session.filePath)
      const snapshotPath = getRuntimeSqliteSnapshot(runtime, dbPath)
      if (!snapshotPath) return { user: '', assistant: '' }
      const raw = await loadSqliteAgentRawMessages(
        source,
        `${snapshotPath}#${session.sessionId}`,
        session.sessionId
      )
      return anchorsFromMessages(rawAnchorMessages(raw))
    }
    const detail = await loadSessionDetail(
      session.filePath,
      session.allFilePaths,
      session.branchParentFilePaths,
      session.branchPointUuid,
      session.branchLeafUuid
    )
    return anchorsFromMessages(parsedAnchorMessages(detail?.messages || []))
  } catch {
    return { user: '', assistant: '' }
  }
}

function maskSecretLike(value: string): string {
  const patterns = [
    /\b(?:sk(?:-proj)?|ghp|github_pat|glpat|xox[baprs]|AKIA)[-_]?[A-Za-z0-9._-]{8,}\b/g,
    /\beyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{6,}){1,2}\b/g,
    /\b[A-Za-z0-9+/=_-]{32,}\b/g
  ]
  let masked = value
  for (const pattern of patterns) {
    masked = masked.replace(pattern, (secret) => `xx……${secret.slice(-4)}`)
  }
  return masked
}

function anchorExcerpt(value: string): string {
  return Array.from(maskSecretLike(value)).slice(0, 30).join('')
}

function exampleFor(outcome: AuditOutcome): ResumeAuditAnchorExample {
  return {
    sessionId: outcome.sessionId,
    userAnchor: anchorExcerpt(outcome.expectedAnchors?.user || ''),
    assistantAnchor: anchorExcerpt(outcome.expectedAnchors?.assistant || ''),
    ...(outcome.mismatchKind ? { classification: outcome.mismatchKind } : {})
  }
}

function buildTargetLists(options: ResumeAuditOptions): Record<ResumeAuditSource, string[]> {
  const overrides = options.resumeTargets || {}
  const home = options.home || runtimeHome()
  return {
    'claude-code': overrides['claude-code'] ||
      findSessionFilesInProjectRoots(findClaudeProjectRoots(home)),
    codex: overrides.codex || findCodexSessionFiles(),
    cursor: overrides.cursor || findCursorResumeStores(home),
    opencode: overrides.opencode || [getSqliteAgentDbPath('opencode')],
    zcode: overrides.zcode || [getSqliteAgentDbPath('zcode')]
  }
}

function cachedRawFile(runtime: ResumeAuditRuntime, filePath: string): Promise<RawJsonlMessage[]> {
  let cached = runtime.rawFileCache.get(filePath)
  if (!cached) {
    cached = parseSessionFile(filePath)
    runtime.rawFileCache.set(filePath, cached)
  }
  return cached
}

function fileHasData(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0
  } catch {
    return false
  }
}

async function loadClaudeTarget(
  sessionId: string,
  claudeConfigDir: string | undefined,
  runtime: ResumeAuditRuntime
): Promise<ResumeTargetData> {
  const home = runtime.options.home || runtimeHome()
  const exactName = `${sessionId}.jsonl`
  const candidates = runtime.targets['claude-code'].filter((candidate) => {
    if (path.basename(candidate) !== exactName) return false
    const candidateConfig = getClaudeConfigDirForSessionFile(candidate, home)
    if (claudeConfigDir) {
      return !!candidateConfig && path.resolve(candidateConfig) === path.resolve(claudeConfigDir)
    }
    return !candidateConfig
  })
  if (candidates.length === 0) return emptyTarget('missing')

  const raw: RawJsonlMessage[] = []
  for (const candidate of candidates.sort()) raw.push(...await cachedRawFile(runtime, candidate))
  if (raw.length === 0) {
    return emptyTarget(candidates.some(fileHasData) ? 'unparseable' : 'empty')
  }
  const allMessages = rawAnchorMessages(raw)
  return {
    status: allMessages.length > 0 ? 'found' : 'empty',
    defaultMessages: rawAnchorMessages(selectClaudeDefaultChain(raw)),
    allMessages
  }
}

function isCodexTargetFile(filePath: string, sessionId: string): boolean {
  const basename = path.basename(filePath)
  return basename === `${sessionId}.jsonl` || basename.endsWith(`-${sessionId}.jsonl`)
}

async function loadCodexTarget(sessionId: string, runtime: ResumeAuditRuntime): Promise<ResumeTargetData> {
  const candidates = runtime.targets.codex.filter((candidate) => isCodexTargetFile(candidate, sessionId)).sort()
  if (candidates.length === 0) return emptyTarget('missing')
  const target = candidates[candidates.length - 1]
  let raw: RawJsonlMessage[]
  try {
    raw = await loadCodexRawMessages(target)
  } catch {
    return emptyTarget('unparseable')
  }
  if (raw.length === 0) return emptyTarget(fileHasData(target) ? 'unparseable' : 'empty')
  const messages = rawAnchorMessages(raw)
  return { status: messages.length > 0 ? 'found' : 'empty', defaultMessages: messages, allMessages: messages }
}

async function withReadOnlySqliteSnapshot<T>(dbPath: string, fn: (snapshotPath: string) => Promise<T>): Promise<T> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-resume-audit-db-'))
  const snapshotPath = path.join(tempDir, path.basename(dbPath) || 'store.db')
  try {
    fs.copyFileSync(dbPath, snapshotPath)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${dbPath}${suffix}`
      if (fs.existsSync(source)) fs.copyFileSync(source, `${snapshotPath}${suffix}`)
    }
    return await fn(snapshotPath)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

function getRuntimeSqliteSnapshot(runtime: ResumeAuditRuntime, dbPath: string): string | null {
  const resolved = path.resolve(dbPath)
  const cached = runtime.sqliteSnapshots.get(resolved)
  if (cached) return cached
  if (!fs.existsSync(resolved)) return null
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-resume-audit-db-'))
  const snapshotPath = path.join(tempDir, path.basename(resolved) || 'store.db')
  try {
    fs.copyFileSync(resolved, snapshotPath)
    for (const suffix of ['-wal', '-shm']) {
      const source = `${resolved}${suffix}`
      if (fs.existsSync(source)) fs.copyFileSync(source, `${snapshotPath}${suffix}`)
    }
    runtime.sqliteSnapshots.set(resolved, snapshotPath)
    runtime.snapshotDirs.push(tempDir)
    return snapshotPath
  } catch {
    fs.rmSync(tempDir, { recursive: true, force: true })
    return null
  }
}

function cleanupRuntimeSnapshots(runtime: ResumeAuditRuntime): void {
  for (const tempDir of runtime.snapshotDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
  runtime.snapshotDirs.length = 0
  runtime.sqliteSnapshots.clear()
}

async function runtimeSqliteRecordExists(
  runtime: ResumeAuditRuntime,
  source: SqliteAgentSource,
  sourceRef: string,
  sessionId: string
): Promise<boolean> {
  const dbPath = stripSqliteAgentSessionRef(sourceRef)
  const snapshotPath = getRuntimeSqliteSnapshot(runtime, dbPath)
  if (!snapshotPath) return false
  try {
    return await hasSqliteAgentSessionRecord(source, `${snapshotPath}#${sessionId}`, sessionId)
  } catch {
    return false
  }
}

async function runSqliteJson(dbPath: string, sql: string): Promise<SqliteJsonRow[]> {
  return new Promise((resolve) => {
    let settled = false
    let stdout = ''
    // dbPath is always a private temp snapshot. A writable connection is required
    // to recover copied WAL state; the original user database is never opened here.
    const child = spawn('sqlite3', ['-json', dbPath], {
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const finish = (rows: SqliteJsonRow[]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(rows)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish([])
    }, SQLITE_TIMEOUT_MS)
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', () => finish([]))
    child.on('close', (code) => {
      if (code !== 0) return finish([])
      try {
        finish(stdout.trim() ? JSON.parse(stdout) as SqliteJsonRow[] : [])
      } catch {
        finish([])
      }
    })
    child.stdin.end(`PRAGMA query_only=ON;\n${sql.trim()};\n`)
  })
}

function decodeVarint(buffer: Buffer, state: { offset: number }): number | null {
  let value = 0
  let shift = 0
  while (state.offset < buffer.length && shift <= 49) {
    const byte = buffer[state.offset++]
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) return value
    shift += 7
  }
  return null
}

function decodeWireFields(buffer: Buffer): WireField[] | null {
  const fields: WireField[] = []
  const state = { offset: 0 }
  while (state.offset < buffer.length) {
    const key = decodeVarint(buffer, state)
    if (key === null) return null
    const number = Math.floor(key / 8)
    const wireType = key & 7
    if (number <= 0) return null
    if (wireType === 0) {
      if (decodeVarint(buffer, state) === null) return null
    } else if (wireType === 1) {
      state.offset += 8
    } else if (wireType === 2) {
      const length = decodeVarint(buffer, state)
      if (length === null || length < 0 || state.offset + length > buffer.length) return null
      fields.push({ number, wireType, bytes: buffer.subarray(state.offset, state.offset + length) })
      state.offset += length
    } else if (wireType === 5) {
      state.offset += 4
    } else {
      return null
    }
    if (state.offset > buffer.length) return null
  }
  return fields
}

function bytesFields(fields: WireField[] | null, number: number): Buffer[] {
  if (!fields) return []
  return fields
    .filter((field) => field.number === number && field.wireType === 2 && field.bytes)
    .map((field) => field.bytes!)
}

function blobId(bytes: Buffer): string | null {
  return bytes.length === 32 ? bytes.toString('hex') : null
}

function blobText(blobs: Map<string, Buffer>, idBytes: Buffer): string {
  const id = blobId(idBytes)
  if (!id) return ''
  const blob = blobs.get(id)
  if (!blob) return ''
  const fields = decodeWireFields(blob)
  const text = bytesFields(fields, 1)[0]
  return text ? text.toString('utf-8') : ''
}

function cursorStoreMessages(blobs: Map<string, Buffer>, rootId: string): AnchorMessage[] | null {
  const root = blobs.get(rootId.toLowerCase())
  if (!root) return null
  const rootFields = decodeWireFields(root)
  if (!rootFields) return null
  const turnRefs = bytesFields(rootFields, 8)
  const messages: AnchorMessage[] = []

  for (const turnRef of turnRefs) {
    const turnId = blobId(turnRef)
    const turn = turnId ? blobs.get(turnId) : undefined
    if (!turn) return null
    const turnFields = decodeWireFields(turn)
    if (!turnFields) return null
    const agentTurn = bytesFields(turnFields, 1)[0]
    if (!agentTurn) continue
    const agentFields = decodeWireFields(agentTurn)
    if (!agentFields) return null

    const userRef = bytesFields(agentFields, 1)[0]
    if (userRef) {
      const userId = blobId(userRef)
      const userBlob = userId ? blobs.get(userId) : undefined
      if (!userBlob) return null
      const userFields = decodeWireFields(userBlob)
      if (!userFields) return null
      let userText = bytesFields(userFields, 1)[0]?.toString('utf-8') || ''
      if (!userText) {
        const externalTextRef = bytesFields(userFields, 18)[0]
        if (externalTextRef) userText = blobText(blobs, externalTextRef)
      }
      if (userText) messages.push({ role: 'user', text: userText })
    }

    for (const stepRef of bytesFields(agentFields, 2)) {
      const stepId = blobId(stepRef)
      const step = stepId ? blobs.get(stepId) : undefined
      if (!step) return null
      const stepFields = decodeWireFields(step)
      if (!stepFields) return null
      const assistantMessage = bytesFields(stepFields, 1)[0]
      if (!assistantMessage) continue
      const assistantFields = decodeWireFields(assistantMessage)
      if (!assistantFields) return null
      const assistantText = bytesFields(assistantFields, 1)[0]?.toString('utf-8') || ''
      if (assistantText) messages.push({ role: 'assistant', text: assistantText })
    }
  }
  return messages
}

async function loadCursorStore(dbPath: string): Promise<ResumeTargetData> {
  if (!fs.existsSync(dbPath)) return emptyTarget('missing')
  try {
    return await withReadOnlySqliteSnapshot(dbPath, async (snapshotPath) => {
      const rows = await runSqliteJson(snapshotPath, `
        SELECT 'meta' AS kind, "key" AS id, "value" AS data FROM "meta"
        UNION ALL
        SELECT 'blob' AS kind, "id" AS id, hex("data") AS data FROM "blobs"
      `)
      if (rows.length === 0) return emptyTarget('unparseable')
      const metadataRow = rows.find((row) => row.kind === 'meta' && row.id === '0')
      if (!metadataRow?.data) return emptyTarget('unparseable')
      let metadata: { latestRootBlobId?: unknown }
      try {
        metadata = JSON.parse(Buffer.from(metadataRow.data, 'hex').toString('utf-8'))
      } catch {
        return emptyTarget('unparseable')
      }
      if (typeof metadata.latestRootBlobId !== 'string' || !metadata.latestRootBlobId) {
        return emptyTarget('empty')
      }
      const blobs = new Map<string, Buffer>()
      for (const row of rows) {
        if (row.kind !== 'blob' || !row.id || !row.data) continue
        blobs.set(row.id.toLowerCase(), Buffer.from(row.data, 'hex'))
      }
      const messages = cursorStoreMessages(blobs, metadata.latestRootBlobId)
      if (!messages) return emptyTarget('unparseable')
      return {
        status: messages.length > 0 ? 'found' : 'empty',
        defaultMessages: messages,
        allMessages: messages
      }
    })
  } catch {
    return emptyTarget('unparseable')
  }
}

function cursorTargetPath(session: SessionSummary, sessionId: string, runtime: ResumeAuditRuntime): string | null {
  const candidates = runtime.targets.cursor.filter((candidate) =>
    path.basename(candidate) === 'store.db' &&
    path.basename(path.dirname(candidate)) === sessionId
  )
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  // Prefer the current workspace copy when one session id exists in multiple workspaces.
  if (session.resumeCwd) {
    const workspaceHash = crypto.createHash('md5').update(path.resolve(session.resumeCwd)).digest('hex')
    const sameWorkspace = candidates.find((candidate) =>
      path.basename(path.dirname(path.dirname(candidate))) === workspaceHash
    )
    if (sameWorkspace) return sameWorkspace
  }
  return candidates.sort((left, right) => {
    const mtime = (filePath: string): number => {
      try { return fs.statSync(filePath).mtimeMs } catch { return 0 }
    }
    return mtime(right) - mtime(left) || left.localeCompare(right)
  })[0]
}

async function loadSqliteAgentTarget(
  source: SqliteAgentSource,
  sessionId: string,
  runtime: ResumeAuditRuntime
): Promise<ResumeTargetData> {
  const candidate = runtime.targets[source][0]
  if (!candidate) return emptyTarget('missing')
  const dbPath = stripSqliteAgentSessionRef(candidate)
  const snapshotPath = getRuntimeSqliteSnapshot(runtime, dbPath)
  if (!snapshotPath) return emptyTarget('missing')
  try {
    const sourceRef = `${snapshotPath}#${sessionId}`
    const exists = await hasSqliteAgentSessionRecord(source, sourceRef, sessionId)
    if (!exists) return emptyTarget('missing')
    const raw = await loadSqliteAgentRawMessages(source, sourceRef, sessionId)
    if (raw.length === 0) return emptyTarget('empty')
    const messages = rawAnchorMessages(raw)
    return {
      status: messages.length > 0 ? 'found' : 'empty',
      defaultMessages: messages,
      allMessages: messages
    }
  } catch {
    return emptyTarget('unparseable')
  }
}

async function loadResumeTarget(
  session: SessionSummary,
  commandSessionId: string,
  claudeConfigDir: string | undefined,
  runtime: ResumeAuditRuntime
): Promise<ResumeTargetData> {
  const source = sourceOf(session)
  if (source === 'claude-code') return loadClaudeTarget(commandSessionId, claudeConfigDir, runtime)
  if (source === 'codex') return loadCodexTarget(commandSessionId, runtime)
  if (source === 'cursor') {
    const targetPath = cursorTargetPath(session, commandSessionId, runtime)
    return targetPath ? loadCursorStore(targetPath) : emptyTarget('missing')
  }
  return loadSqliteAgentTarget(source, commandSessionId, runtime)
}

function classifyL3(
  source: ResumeAuditSource,
  sessionId: string,
  expected: ResumeAuditAnchors,
  target: ResumeTargetData
): AuditOutcome {
  const decision = classifyResumeL3(expected, target)
  if (decision.status === 'would-404') {
    return {
      source,
      sessionId,
      status: 'fail',
      level: 'L3',
      l3Status: 'would-404',
      expectedAnchors: expected
    }
  }
  if (decision.status === 'match') {
    return { source, sessionId, status: 'ok', level: 'L3', l3Status: 'match', expectedAnchors: expected }
  }
  if (decision.status === 'skipped') {
    return {
      source,
      sessionId,
      status: 'skipped',
      level: 'L3',
      l3Status: 'skipped',
      l3SkipReason: 'expected-anchor-empty',
      expectedAnchors: expected
    }
  }
  return {
    source,
    sessionId,
    status: 'fail',
    level: 'L3',
    l3Status: 'mismatch',
    mismatchKind: decision.mismatchKind,
    expectedAnchors: expected
  }
}

function auditSessionId(session: SessionSummary): string {
  return session.id || session.sessionId
}

function addCoverage(ids: Set<string>, session: SessionSummary): void {
  ids.add(session.id)
  ids.add(session.sessionId)
  if (session.resumeSessionId) ids.add(session.resumeSessionId)
  for (const id of session.continuationSessionIds || []) ids.add(id)
}

/** Load local and Library-only sessions without creating directories or updating caches. */
export async function loadResumeAuditSessions(): Promise<SessionSummary[]> {
  const sessions = await loadAllSessions({ readOnly: true, quiet: true })
  const coveredIds = new Set<string>()
  for (const session of sessions) addCoverage(coveredIds, session)

  for (const { sessionId, backupPath, meta } of findLibraryOnlySessions(coveredIds)) {
    try {
      const summary = await buildSessionSummaryFromBackup(backupPath, sessionId, meta)
      if (!summary || coveredIds.has(summary.id) || coveredIds.has(summary.sessionId)) continue
      summary.allFilePaths = [backupPath]
      sessions.push(summary)
      addCoverage(coveredIds, summary)
    } catch {
      // An unreadable Library backup is not a loaded session and cannot yield a resume command.
    }
  }

  for (const session of sessions) {
    const availability = getSessionResumeAvailability(session.sessionId, session)
    session.canResume = availability.canResume
    session.resumeUnavailableReason = availability.canResume ? undefined : availability.reason
  }

  return sessions
}

export function isValidResumeSessionId(sessionId: string, source: SessionSource): boolean {
  if (source === 'opencode' || source === 'zcode') return isValidOpencodeSessionId(sessionId)
  return UUID_RE.test(sessionId)
}

export function isBinaryAvailable(binary: string, pathEnv = process.env.PATH || ''): boolean {
  if (!binary || binary.includes(path.sep)) return false
  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue
    try {
      fs.accessSync(path.join(entry, binary), fs.constants.X_OK)
      return true
    } catch {
      // Continue searching PATH.
    }
  }
  return false
}

function sourceReferences(session: SessionSummary): string[] {
  const candidates = session.allFilePaths?.length ? session.allFilePaths : [session.filePath]
  return [...new Set(candidates.filter((value): value is string => !!value))]
}

function fail(
  source: ResumeAuditSource,
  sessionId: string,
  level: 'L1' | 'L2',
  failureCode: ResumeAuditFailureCode
): AuditOutcome {
  return { source, sessionId, status: 'fail', level, failureCode }
}

async function auditSession(
  session: SessionSummary,
  options: ResumeAuditOptions,
  runtime: ResumeAuditRuntime
): Promise<AuditOutcome> {
  const source = sourceOf(session)
  const exampleId = auditSessionId(session)

  if (session.canResume === false || session.resumeUnavailableReason) {
    return fail(source, exampleId, 'L1', 'resume-unavailable')
  }

  let commandSessionId: string
  let claudeConfigDir: string | undefined
  try {
    const context = await resolveSessionActionContext(exampleId, [session])
    commandSessionId = context.sessionId
    claudeConfigDir = context.claudeConfigDir || session.claudeConfigDir
    const command = buildResumeCommand(
      context.sessionId,
      context.permissionMode,
      context.cwd,
      context.source,
      claudeConfigDir
    )
    if (!command.trim()) return fail(source, exampleId, 'L1', 'command-build-failed')
  } catch {
    const code = exampleId.includes(':intra-') ? 'intra-file-branch' : 'command-build-failed'
    return fail(source, exampleId, 'L1', code)
  }

  if (!isValidResumeSessionId(commandSessionId, source)) {
    return fail(source, exampleId, 'L2', 'invalid-session-id')
  }

  const references = sourceReferences(session)
  if (source === 'opencode' || source === 'zcode') {
    const existingRefs = references.filter((reference) =>
      fs.existsSync(stripSqliteAgentSessionRef(reference))
    )
    if (existingRefs.length === 0) return fail(source, exampleId, 'L2', 'source-missing')

    const dbRecordExists = options.dbRecordExists || ((candidateSource, sourceRef, candidateSessionId) =>
      runtimeSqliteRecordExists(runtime, candidateSource, sourceRef, candidateSessionId)
    )
    let foundRecord = false
    for (const reference of existingRefs) {
      if (await dbRecordExists(source, reference, commandSessionId)) {
        foundRecord = true
        break
      }
    }
    if (!foundRecord) return fail(source, exampleId, 'L2', 'db-record-missing')
  } else if (!references.some((reference) => fs.existsSync(reference))) {
    return fail(source, exampleId, 'L2', 'source-missing')
  }

  const binary = BINARY_BY_SOURCE[source]
  const binaryAvailable = options.binaryAvailable || isBinaryAvailable
  if (!binaryAvailable(binary, options.pathEnv ?? process.env.PATH ?? '')) {
    return { source, sessionId: exampleId, status: 'env-missing', level: 'L2', binary }
  }

  const expected = await loadExpectedAnchors(session, runtime)
  if (!expected.user && !expected.assistant) {
    return {
      source,
      sessionId: exampleId,
      status: 'skipped',
      level: 'L3',
      l3Status: 'skipped',
      l3SkipReason: 'expected-anchor-empty',
      expectedAnchors: expected
    }
  }
  const target = await loadResumeTarget(session, commandSessionId, claudeConfigDir, runtime)
  return classifyL3(source, exampleId, expected, target)
}

function roundedPercent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 10000) / 100
}

function summarize(outcomes: AuditOutcome[]): ResumeAuditStats {
  const ok = outcomes.filter((outcome) => outcome.l3Status === 'match').length
  const failures = outcomes.filter((outcome) => outcome.status === 'fail')
  const levelFailures = failures.filter(
    (outcome): outcome is AuditOutcome & {
      failureCode: ResumeAuditFailureCode
      level: 'L1' | 'L2'
    } => !!outcome.failureCode && outcome.level !== 'L3'
  )
  const envMissingOutcomes = outcomes.filter((outcome) => outcome.status === 'env-missing')
  const total = outcomes.length
  const failCount = failures.length

  const reasonMap = new Map<string, ResumeAuditReasonStat>()
  for (const outcome of levelFailures) {
    const code = outcome.failureCode!
    const key = `${outcome.level}:${code}`
    const current = reasonMap.get(key)
    if (current) {
      current.count++
    } else {
      reasonMap.set(key, {
        level: outcome.level,
        code,
        message: FAILURE_MESSAGES[code],
        count: 1,
        exampleSessionId: outcome.sessionId
      })
    }
  }

  const environmentMap = new Map<string, ResumeAuditEnvironmentStat>()
  for (const outcome of envMissingOutcomes) {
    const binary = outcome.binary!
    const current = environmentMap.get(binary)
    if (current) {
      current.count++
    } else {
      environmentMap.set(binary, { binary, count: 1, exampleSessionId: outcome.sessionId })
    }
  }

  const byCountThenName = <T extends { count: number }>(a: T, b: T): number =>
    b.count - a.count || JSON.stringify(a).localeCompare(JSON.stringify(b))
  const failureReasons = [...reasonMap.values()].sort(byCountThenName).slice(0, 3)
  const environmentMissing = [...environmentMap.values()].sort(byCountThenName)
  const l1Fail = levelFailures.filter((outcome) => outcome.level === 'L1').length
  const l2Fail = levelFailures.filter((outcome) => outcome.level === 'L2').length
  const mismatchOutcomes = outcomes.filter((outcome) => outcome.l3Status === 'mismatch')
  const would404Outcomes = outcomes.filter((outcome) => outcome.l3Status === 'would-404')
  const expectedAnchorEmptyOutcomes = outcomes.filter(
    (outcome) => outcome.l3SkipReason === 'expected-anchor-empty'
  )
  const l2Ok = outcomes.filter((outcome) => !!outcome.l3Status).length
  const mismatchExamples: ResumeAuditAnchorExample[] = []
  for (const kind of ['wrong-branch', 'stale', 'empty'] as const) {
    const outcome = mismatchOutcomes.find((candidate) => candidate.mismatchKind === kind)
    if (outcome) mismatchExamples.push(exampleFor(outcome))
  }
  for (const outcome of mismatchOutcomes) {
    if (mismatchExamples.length >= 3) break
    if (!mismatchExamples.some((example) => example.sessionId === outcome.sessionId)) {
      mismatchExamples.push(exampleFor(outcome))
    }
  }

  return {
    total,
    ok,
    fail: failCount,
    envMissing: envMissingOutcomes.length,
    successRate: roundedPercent(ok, ok + failCount),
    verifiedRate: roundedPercent(ok, total),
    l1: { ok: total - l1Fail, fail: l1Fail },
    l2: { ok: l2Ok, fail: l2Fail, envMissing: envMissingOutcomes.length },
    l3: {
      match: ok,
      mismatch: {
        total: mismatchOutcomes.length,
        wrongBranch: mismatchOutcomes.filter((outcome) => outcome.mismatchKind === 'wrong-branch').length,
        stale: mismatchOutcomes.filter((outcome) => outcome.mismatchKind === 'stale').length,
        empty: mismatchOutcomes.filter((outcome) => outcome.mismatchKind === 'empty').length
      },
      would404: would404Outcomes.length,
      skipped: total - ok - mismatchOutcomes.length - would404Outcomes.length,
      skippedReasons: {
        expectedAnchorEmpty: expectedAnchorEmptyOutcomes.length
      },
      mismatchExamples,
      would404Examples: would404Outcomes.slice(0, 3).map(exampleFor)
    },
    failureReasons,
    environmentMissing
  }
}

export async function runResumeAudit(options: ResumeAuditOptions = {}): Promise<ResumeAuditReport> {
  const sessions = options.sessions || await loadResumeAuditSessions()
  const runtime: ResumeAuditRuntime = {
    options,
    targets: buildTargetLists(options),
    rawFileCache: new Map(),
    sqliteSnapshots: new Map(),
    snapshotDirs: []
  }
  const outcomes: AuditOutcome[] = []
  try {
    for (const session of sessions) outcomes.push(await auditSession(session, options, runtime))

    const perSource = Object.fromEntries(
      RESUME_AUDIT_SOURCES.map((source) => [
        source,
        summarize(outcomes.filter((outcome) => outcome.source === source))
      ])
    ) as Record<ResumeAuditSource, ResumeAuditStats>

    return {
      generatedAt: (options.now || (() => new Date()))().toISOString(),
      readOnly: true,
      ...summarize(outcomes),
      perSource
    }
  } finally {
    cleanupRuntimeSnapshots(runtime)
  }
}

function rate(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`
}

export function formatResumeAuditReport(report: ResumeAuditReport): string {
  const headers = ['source', 'total', 'ok', 'fail', 'envMissing', 'L3match', 'mismatch', 'would404', 'success', 'verified']
  const rows = RESUME_AUDIT_SOURCES.map((source) => {
    const stats = report.perSource[source]
    return [
      source,
      String(stats.total),
      String(stats.ok),
      String(stats.fail),
      String(stats.envMissing),
      String(stats.l3.match),
      String(stats.l3.mismatch.total),
      String(stats.l3.would404),
      rate(stats.successRate),
      rate(stats.verifiedRate)
    ]
  })
  rows.push([
    'TOTAL',
    String(report.total),
    String(report.ok),
    String(report.fail),
    String(report.envMissing),
    String(report.l3.match),
    String(report.l3.mismatch.total),
    String(report.l3.would404),
    rate(report.successRate),
    rate(report.verifiedRate)
  ])

  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column].length))
  )
  const formatRow = (row: string[]): string => row
    .map((cell, column) => cell.padEnd(widths[column]))
    .join('  ')

  const lines = [
    'Swob resume audit (read-only)',
    `Generated: ${report.generatedAt}`,
    '',
    formatRow(headers),
    formatRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(formatRow),
    '',
    `L1 command generation: ${report.l1.ok} ok / ${report.l1.fail} fail`,
    `L2 reference verification: ${report.l2.ok} ok / ${report.l2.fail} fail / ${report.l2.envMissing} env-missing`,
    `L3 content consistency: ${report.l3.match} match / ${report.l3.mismatch.total} mismatch / ${report.l3.would404} would-404 / ${report.l3.skipped} skipped`,
    `  mismatch: wrong-branch=${report.l3.mismatch.wrongBranch}, stale=${report.l3.mismatch.stale}, empty=${report.l3.mismatch.empty}`,
    `  skipped: expected-anchor-empty=${report.l3.skippedReasons.expectedAnchorEmpty}`,
    'success = ok / (ok + fail); env-missing is excluded. verified = ok / total.'
  ]

  lines.push('', 'Failure TOP 3:')
  if (report.failureReasons.length === 0) {
    lines.push('  none')
  } else {
    report.failureReasons.forEach((reason, index) => {
      lines.push(
        `  ${index + 1}. [${reason.level}] ${reason.code}: ${reason.count}; ` +
        `example=${reason.exampleSessionId}; ${reason.message}`
      )
    })
  }

  lines.push('', 'Environment missing:')
  if (report.environmentMissing.length === 0) {
    lines.push('  none')
  } else {
    for (const item of report.environmentMissing) {
      lines.push(`  ${item.binary}: ${item.count}; example=${item.exampleSessionId}`)
    }
  }

  lines.push('', 'L3 mismatch examples (max 3):')
  if (report.l3.mismatchExamples.length === 0) {
    lines.push('  none')
  } else {
    for (const example of report.l3.mismatchExamples) {
      const kind = example.classification!
      lines.push(
        `  ${kind}: session=${example.sessionId}; user="${example.userAnchor}"; ` +
        `assistant="${example.assistantAnchor}"; fix=${MISMATCH_FIXES[kind]}`
      )
    }
  }

  lines.push('', 'L3 would-404 examples (max 3):')
  if (report.l3.would404Examples.length === 0) {
    lines.push('  none')
  } else {
    for (const example of report.l3.would404Examples) {
      lines.push(
        `  session=${example.sessionId}; user="${example.userAnchor}"; ` +
        `assistant="${example.assistantAnchor}"; ` +
        'fix=修正 resumeSessionId 或恢复 harness 原始记录；不要用 Library 备份冒充可恢复目标'
      )
    }
  }

  lines.push('', 'Per-source diagnostics:')
  for (const source of RESUME_AUDIT_SOURCES) {
    const stats = report.perSource[source]
    if (stats.failureReasons.length === 0 && stats.environmentMissing.length === 0 &&
      stats.l3.mismatch.total === 0 && stats.l3.would404 === 0 &&
      stats.l3.skippedReasons.expectedAnchorEmpty === 0) continue
    lines.push(`  ${source}:`)
    for (const reason of stats.failureReasons) {
      lines.push(
        `    [${reason.level}] ${reason.code}: ${reason.count}; ` +
        `example=${reason.exampleSessionId}; ${reason.message}`
      )
    }
    for (const item of stats.environmentMissing) {
      lines.push(`    env-missing ${item.binary}: ${item.count}; example=${item.exampleSessionId}`)
    }
    if (stats.l3.skippedReasons.expectedAnchorEmpty > 0) {
      lines.push(`    L3 skipped expected-anchor-empty=${stats.l3.skippedReasons.expectedAnchorEmpty}`)
    }
    if (stats.l3.mismatch.total > 0 || stats.l3.would404 > 0) {
      lines.push(
        `    L3 match=${stats.l3.match}, mismatch=${stats.l3.mismatch.total} ` +
        `(wrong-branch=${stats.l3.mismatch.wrongBranch}, stale=${stats.l3.mismatch.stale}, ` +
        `empty=${stats.l3.mismatch.empty}), would-404=${stats.l3.would404}`
      )
    }
  }

  return lines.join('\n') + '\n'
}
