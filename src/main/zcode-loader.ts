import type { RawJsonlMessage, SessionDetail, SessionSummary } from './types'
import {
  buildSqliteAgentSessionDetail,
  buildSqliteAgentSessionSummary,
  findSqliteAgentSessionFiles,
  getSqliteAgentDbPath,
  loadSqliteAgentRawMessages,
  makeSqliteAgentSessionRef,
  stripSqliteAgentSessionRef
} from './opencode-loader'

export function getZcodeDbPath(): string {
  return getSqliteAgentDbPath('zcode')
}

export function makeZcodeSessionRef(sessionId: string, dbPath = getZcodeDbPath()): string {
  return makeSqliteAgentSessionRef('zcode', sessionId, dbPath)
}

export function stripZcodeSessionRef(sourceRef: string): string {
  return stripSqliteAgentSessionRef(sourceRef)
}

export async function findZcodeSessionFiles(dbPath = getZcodeDbPath()): Promise<string[]> {
  return findSqliteAgentSessionFiles('zcode', dbPath)
}

export async function loadZcodeRawMessages(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<RawJsonlMessage[]> {
  return loadSqliteAgentRawMessages('zcode', sourceRef, sessionIdOverride)
}

export async function buildZcodeSessionSummary(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return buildSqliteAgentSessionSummary('zcode', sourceRef, sessionIdOverride)
}

export async function buildZcodeSessionDetail(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionDetail | null> {
  return buildSqliteAgentSessionDetail('zcode', sourceRef, sessionIdOverride)
}

export async function buildZcodeSessionSummaryFromBackup(
  _filePath: string,
  _sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return null
}
