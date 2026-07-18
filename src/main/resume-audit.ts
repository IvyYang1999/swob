import * as fs from 'fs'
import * as path from 'path'
import {
  findLibraryOnlySessions,
  getSessionResumeAvailability
} from './library-manager'
import {
  buildSessionSummaryFromBackup,
  loadAllSessions
} from './session-loader'
import {
  hasSqliteAgentSessionRecord,
  isValidOpencodeSessionId,
  stripSqliteAgentSessionRef,
  type SqliteAgentSource
} from './opencode-loader'
import {
  buildResumeCommand,
  resolveSessionActionContext
} from './session-actions'
import type { SessionSource, SessionSummary } from './types'

export const RESUME_AUDIT_SOURCES = [
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'zcode'
] as const satisfies readonly SessionSource[]

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
  perSource: Record<SessionSource, ResumeAuditStats>
}

export interface ResumeAuditOptions {
  sessions?: SessionSummary[]
  pathEnv?: string
  now?: () => Date
  binaryAvailable?: (binary: string, pathEnv: string) => boolean
  dbRecordExists?: (
    source: SqliteAgentSource,
    sourceRef: string,
    sessionId: string
  ) => Promise<boolean>
}

interface AuditOutcome {
  source: SessionSource
  sessionId: string
  status: 'ok' | 'fail' | 'env-missing'
  level: 'L1' | 'L2'
  failureCode?: ResumeAuditFailureCode
  binary?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BINARY_BY_SOURCE: Record<SessionSource, string> = {
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

function sourceOf(session: SessionSummary): SessionSource {
  return session.source || 'claude-code'
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
  source: SessionSource,
  sessionId: string,
  level: 'L1' | 'L2',
  failureCode: ResumeAuditFailureCode
): AuditOutcome {
  return { source, sessionId, status: 'fail', level, failureCode }
}

async function auditSession(session: SessionSummary, options: ResumeAuditOptions): Promise<AuditOutcome> {
  const source = sourceOf(session)
  const exampleId = auditSessionId(session)

  if (session.canResume === false || session.resumeUnavailableReason) {
    return fail(source, exampleId, 'L1', 'resume-unavailable')
  }

  let commandSessionId: string
  try {
    const context = await resolveSessionActionContext(exampleId, [session])
    commandSessionId = context.sessionId
    const command = buildResumeCommand(
      context.sessionId,
      context.permissionMode,
      context.cwd,
      context.source,
      context.claudeConfigDir
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

    const dbRecordExists = options.dbRecordExists || hasSqliteAgentSessionRecord
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

  return { source, sessionId: exampleId, status: 'ok', level: 'L2' }
}

function roundedPercent(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  return Math.round((numerator / denominator) * 10000) / 100
}

function summarize(outcomes: AuditOutcome[]): ResumeAuditStats {
  const ok = outcomes.filter((outcome) => outcome.status === 'ok').length
  const failures = outcomes.filter((outcome) => outcome.status === 'fail')
  const envMissingOutcomes = outcomes.filter((outcome) => outcome.status === 'env-missing')
  const total = outcomes.length
  const failCount = failures.length

  const reasonMap = new Map<string, ResumeAuditReasonStat>()
  for (const outcome of failures) {
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
  const l1Fail = failures.filter((outcome) => outcome.level === 'L1').length
  const l2Fail = failCount - l1Fail

  return {
    total,
    ok,
    fail: failCount,
    envMissing: envMissingOutcomes.length,
    successRate: roundedPercent(ok, ok + failCount),
    verifiedRate: roundedPercent(ok, total),
    l1: { ok: total - l1Fail, fail: l1Fail },
    l2: { ok, fail: l2Fail, envMissing: envMissingOutcomes.length },
    failureReasons,
    environmentMissing
  }
}

export async function runResumeAudit(options: ResumeAuditOptions = {}): Promise<ResumeAuditReport> {
  const sessions = options.sessions || await loadResumeAuditSessions()
  const outcomes: AuditOutcome[] = []
  for (const session of sessions) outcomes.push(await auditSession(session, options))

  const perSource = Object.fromEntries(
    RESUME_AUDIT_SOURCES.map((source) => [
      source,
      summarize(outcomes.filter((outcome) => outcome.source === source))
    ])
  ) as Record<SessionSource, ResumeAuditStats>

  return {
    generatedAt: (options.now || (() => new Date()))().toISOString(),
    readOnly: true,
    ...summarize(outcomes),
    perSource
  }
}

function rate(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(2)}%`
}

export function formatResumeAuditReport(report: ResumeAuditReport): string {
  const headers = ['source', 'total', 'ok', 'fail', 'envMissing', 'success', 'verified']
  const rows = RESUME_AUDIT_SOURCES.map((source) => {
    const stats = report.perSource[source]
    return [
      source,
      String(stats.total),
      String(stats.ok),
      String(stats.fail),
      String(stats.envMissing),
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

  lines.push('', 'Per-source diagnostics:')
  for (const source of RESUME_AUDIT_SOURCES) {
    const stats = report.perSource[source]
    if (stats.failureReasons.length === 0 && stats.environmentMissing.length === 0) continue
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
  }

  return lines.join('\n') + '\n'
}
