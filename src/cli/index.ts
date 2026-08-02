#!/usr/bin/env node

import * as fs from 'node:fs'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { format as formatLog } from 'node:util'
import {
  findAllSessionFiles,
  loadAllSessions,
  loadSessionDetail
} from '../main/session-loader'
import {
  initLibrary,
  scanLibrary,
  libraryTreeToConfig,
  loadLibraryConfig,
  saveLibraryConfig,
  createLibraryFolder,
  renameLibraryFolder,
  deleteLibraryFolder,
  moveSessionsToFolders,
  renameSessionsInLibrary,
  undoLastLibraryOrganization,
  resolveFolderPath,
  getLibraryRoot,
  rebuildAllTranscripts,
  redactLibraryTranscripts,
  findLibrarySessionsWithMissingSources
} from '../main/library-manager'
import { spotlightSearch } from '../main/spotlight-search'
import { buildInsights } from '../main/insights'
import { cliInstallOptionsForEnvironment, installSwobCli } from '../main/cli-install'
import { runtimeHome } from '../main/runtime-home'
import { formatResumeAuditReport, runResumeAudit } from '../main/resume-audit'
import { buildCliResumeResponse } from './resume-command'
import { formatResolveCliOutput, resolveSessionId } from './resolve-command'
import {
  getSessionLineagePath,
  rebuildSessionLineageRegistry,
  writeSessionLineageRegistry
} from '../main/session-lineage'
import { detectSessionSourceForJsonl } from '../main/session-source'
import { providerUsesCanonicalRuntime } from '../shared/provider-capabilities'
import { refreshCanonicalProviders } from '../main/provider-runtime'
import { grepTranscriptsReadOnly, type SearchIndexSource } from '../main/search-index'
import {
  closeSearchIndexWriteCoordinator,
  getSearchIndexWriteCoordinator
} from '../main/search-index-writer'
import { filterVisibleSearchSources } from '../main/session-search'
import { findCodexSessionFiles, loadCodexRawMessages } from '../main/codex-loader'
import { findCursorSessionFiles, loadCursorRawMessages } from '../main/cursor-loader'
import {
  findOpencodeSessionFiles,
  loadOpencodeRawMessages,
  stripOpencodeSessionRef
} from '../main/opencode-loader'
import { findZcodeSessionFiles, loadZcodeRawMessages, stripZcodeSessionRef } from '../main/zcode-loader'
import type { ParsedMessage, SessionDetail } from '../main/types'
import {
  CLI_VERSION,
  cliHelpData,
  generateSkillContent,
  renderCliHelp
} from './command-registry'

export interface CliIo {
  stdout: (value: string) => void
  stderr: (value: string) => void
  readStdin: () => Promise<string>
}

const processIo: CliIo = {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
  readStdin: async () => {
    let value = ''
    process.stdin.setEncoding('utf-8')
    for await (const chunk of process.stdin) value += chunk
    return value
  }
}

let activeIo = processIo

class CliFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
    readonly details?: { code: string; hint: string; retryable: boolean }
  ) {
    super(message)
  }
}

function out(data: unknown): void {
  activeIo.stdout(JSON.stringify(data, null, 2) + '\n')
}

function outJsonl(data: unknown): void {
  activeIo.stdout(JSON.stringify(data) + '\n')
}

function fail(message: string, exitCode = 1): never {
  throw new CliFailure(message, exitCode)
}

const booleanFlags = new Set([
  'all', 'dry-run', 'full', 'help', 'json', 'missing-only', 'skip-permissions',
  'stdin', 'summary', 'version'
])

export function parseArgs(argv: string[]): { cmd: string[]; flags: Record<string, string | true> } {
  const cmd: string[] = []
  const flags: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      cmd.push(arg)
      continue
    }
    const equalAt = arg.indexOf('=')
    if (equalAt > 2) {
      flags[arg.slice(2, equalAt)] = arg.slice(equalAt + 1)
      continue
    }
    const key = arg.slice(2)
    if (booleanFlags.has(key)) {
      flags[key] = true
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      index++
    } else {
      flags[key] = true
    }
  }
  return { cmd, flags }
}

function positiveInteger(value: string | true | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`必须是正整数: ${String(value)}`)
  return parsed
}

function detectActiveSessionsFromProcesses(): Set<string> {
  try {
    const stdout = execSync('ps -eo command', { encoding: 'utf-8', timeout: 3000 })
    const active = new Set<string>()
    for (const line of stdout.split('\n')) {
      if (!line.includes('claude')) continue
      const match = line.match(/--resume\s+(\S+)/)
      if (match) active.add(match[1])
    }
    return active
  } catch {
    return new Set()
  }
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatTime(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function currentLibraryConfig() {
  return libraryTreeToConfig(scanLibrary())
}

function folderSessionIds(folderValue: string): string[] {
  const normalized = folderValue.toLowerCase()
  const folder = currentLibraryConfig().folders.find((candidate) =>
    candidate.id.toLowerCase() === normalized || candidate.name.toLowerCase() === normalized
  )
  if (!folder) fail(`文件夹 "${folderValue}" 不存在`, 3)
  return folder.sessionIds
}

async function cmdSearch(query: string, flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions({ quiet: true })
  const config = currentLibraryConfig()
  const folderMap = new Map<string, string>()
  for (const folder of config.folders) {
    for (const sessionId of folder.sessionIds) folderMap.set(sessionId, folder.name)
  }
  const results = spotlightSearch(query, sessions, {
    sessionMeta: config.sessionMeta || {},
    folderMap
  }, positiveInteger(flags.limit, 20))
  out(results.map((result) => ({
    sessionId: result.session.sessionId,
    title: result.customTitle || result.session.firstUserMessage?.slice(0, 80),
    folder: result.folderName || null,
    source: result.session.source || 'claude-code',
    updatedAt: result.session.updatedAt,
    turnCount: result.session.turnCount,
    tokens: result.session.tokenUsage.inputTokens + result.session.tokenUsage.outputTokens,
    tokenMetric: 'input_plus_output',
    score: Math.round(result.score),
    matchedFields: result.matchedFields
  })))
}

async function cmdList(flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions({ quiet: true })
  const config = currentLibraryConfig()
  let filtered = sessions
  if (typeof flags.folder === 'string') {
    const ids = new Set(folderSessionIds(flags.folder))
    filtered = filtered.filter((session) => ids.has(session.sessionId))
  }
  if (typeof flags.source === 'string') {
    const source = flags.source.toLowerCase()
    filtered = filtered.filter((session) => (session.source || 'claude-code') === source)
  }
  if (typeof flags.project === 'string') {
    const project = flags.project.toLowerCase()
    filtered = filtered.filter((session) =>
      session.cwds.some((cwd) => cwd.toLowerCase().includes(project)) ||
      session.projectPath.toLowerCase().includes(project)
    )
  }
  filtered = filtered.slice(0, positiveInteger(flags.limit, 50))
  const sessionMeta = config.sessionMeta || {}
  const folderMap = new Map<string, string>()
  for (const folder of config.folders) {
    for (const sessionId of folder.sessionIds) folderMap.set(sessionId, folder.name)
  }
  out(filtered.map((session) => ({
    sessionId: session.sessionId,
    title: sessionMeta[session.sessionId]?.customTitle || session.firstUserMessage?.slice(0, 80),
    folder: folderMap.get(session.sessionId) || null,
    source: session.source || 'claude-code',
    project: session.cwds[0]?.split('/').pop() || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turnCount: session.turnCount,
    tokens: session.tokenUsage.inputTokens + session.tokenUsage.outputTokens,
    tokenMetric: 'input_plus_output',
    isActive: false
  })))
}

function thinkingParts(message: ParsedMessage): string[] {
  const content = message.raw.message?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    if (part.type !== 'thinking') return []
    const record = part as unknown as Record<string, unknown>
    const thinking = record.thinking ?? record.text
    return typeof thinking === 'string' ? [thinking] : []
  })
}

function showMessage(message: ParsedMessage, full: boolean): Record<string, unknown> {
  return {
    uuid: message.uuid,
    type: message.type,
    timestamp: message.timestamp,
    text: full ? message.textContent : message.textContent.slice(0, 500),
    toolCalls: full
      ? message.toolCalls.map((tool) => ({
          id: tool.id || null,
          name: tool.name,
          input: tool.input,
          result: tool.result ?? null
        }))
      : message.toolCalls.map((tool) => tool.name),
    ...(full ? { thinking: thinkingParts(message) } : {}),
    isPreCompact: message.isPreCompact,
    isSidechain: message.isSidechain
  }
}

function showHeader(detail: SessionDetail, title: string): Record<string, unknown> {
  return {
    sessionId: detail.sessionId,
    title,
    source: detail.source || 'claude-code',
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
    turnCount: detail.turnCount,
    compactCount: detail.compactCount,
    cwds: detail.cwds,
    version: detail.version,
    permissionMode: detail.permissionMode,
    tokens: {
      input: detail.tokenUsage.inputTokens,
      output: detail.tokenUsage.outputTokens,
      cacheCreation: detail.tokenUsage.cacheCreationTokens,
      cacheRead: detail.tokenUsage.cacheReadTokens,
      totalMetric: 'input_plus_output'
    },
    tokenAccounting: detail.tokenAccounting,
    models: detail.models,
    toolUsage: detail.toolUsage
  }
}

async function cmdShow(sessionId: string, flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions({ quiet: true })
  const session = sessions.find((candidate) => candidate.sessionId === sessionId || candidate.id === sessionId)
  if (!session) fail(`Session "${sessionId}" 不存在`, 3)
  const detail = await loadSessionDetail(
    session.filePath,
    session.allFilePaths,
    session.branchParentFilePaths,
    session.branchPointUuid,
    session.branchLeafUuid
  )
  if (!detail) fail(`Session "${sessionId}" 不存在`, 3)
  const meta = currentLibraryConfig().sessionMeta?.[session.sessionId]
  const header = showHeader(detail, meta?.customTitle || detail.firstUserMessage?.slice(0, 80))
  const full = flags.full === true
  const output = { ...header, messages: detail.messages.map((message) => showMessage(message, full)) }
  if (flags.format === undefined) {
    out(output)
    return
  }
  if (flags.format !== 'jsonl') fail(`不支持的格式: ${String(flags.format)}`)
  outJsonl({ event: 'session', ...header })
  for (const message of detail.messages) {
    outJsonl({ event: 'message', sessionId: detail.sessionId, ...showMessage(message, full) })
  }
}

function dateBoundary(value: string | true | undefined, endOfDay: boolean): string | undefined {
  if (value === undefined) return undefined
  if (value === true) fail('日期选项缺少值')
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value
  const date = new Date(normalized)
  if (Number.isNaN(date.getTime())) fail(`无效日期: ${value}`)
  return date.toISOString()
}

async function cmdGrep(query: string, flags: Record<string, string | true>): Promise<void> {
  const sourceFiles = findAllSessionFiles().filter((filePath) =>
    !providerUsesCanonicalRuntime(detectSessionSourceForJsonl(filePath))
  )
  const sources: SearchIndexSource[] = sourceFiles.map((filePath) => ({
    filePath,
    source: detectSessionSourceForJsonl(filePath)
  }))
  for (const filePath of findCodexSessionFiles()) {
    sources.push({ filePath, source: 'codex', loadRaw: () => loadCodexRawMessages(filePath) })
  }
  for (const filePath of findCursorSessionFiles()) {
    sources.push({ filePath, source: 'cursor', loadRaw: () => loadCursorRawMessages(filePath) })
  }
  for (const filePath of await findOpencodeSessionFiles()) {
    sources.push({
      filePath,
      source: 'opencode',
      stateFilePath: stripOpencodeSessionRef(filePath),
      loadRaw: () => loadOpencodeRawMessages(filePath)
    })
  }
  for (const filePath of await findZcodeSessionFiles()) {
    sources.push({
      filePath,
      source: 'zcode',
      stateFilePath: stripZcodeSessionRef(filePath),
      loadRaw: () => loadZcodeRawMessages(filePath)
    })
  }
  for (const backup of findLibrarySessionsWithMissingSources()) {
    sources.push({ filePath: backup.backupPath, source: 'library-backup' })
  }
  // t117: guardian/内部会话不进搜索;t124: 只读查询+busy 语义。两者都保留。
  const visibleSources = filterVisibleSearchSources(
    sources,
    await loadAllSessions({ readOnly: true, quiet: true })
  )
  let results: ReturnType<typeof grepTranscriptsReadOnly>
  const canonicalWarnings: string[] = []
  const startedAt = performance.now()
  try {
    // `grep` already refreshes the shared FTS index. Refresh canonical
    // providers in the same write phase so a cold CLI invocation can search Pi
    // without requiring the GUI to have run first.
    try {
      const canonical = await refreshCanonicalProviders()
      for (const report of canonical.reports) {
        for (const error of report.errors) {
          canonicalWarnings.push(`${report.providerId}:${error.code}`)
        }
      }
    } catch (error) {
      // Canonical search is additive; legacy grep must remain available.
      const message = error instanceof Error ? error.message : String(error)
      const code = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : ''
      if (code === 'SQLITE_BUSY' || /database is locked/i.test(message)) throw error
      canonicalWarnings.push(
        `canonical-refresh:${message}`
      )
    }
    await getSearchIndexWriteCoordinator().scheduleLegacySnapshot(visibleSources)
    results = grepTranscriptsReadOnly(query, {
      source: typeof flags.source === 'string' ? flags.source : undefined,
      sessionIds: typeof flags.folder === 'string' ? folderSessionIds(flags.folder) : undefined,
      after: dateBoundary(flags.after, false),
      before: dateBoundary(flags.before, true),
      project: typeof flags.project === 'string' ? flags.project : undefined,
      limit: positiveInteger(flags.limit, 100)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : ''
    if (code === 'SQLITE_BUSY' || /database is locked/i.test(message)) {
      throw new CliFailure('搜索索引暂时被占用', 1, {
        code: 'SEARCH_INDEX_BUSY',
        hint: 'GUI 正在建索引，稍后再试',
        retryable: true
      })
    }
    throw error
  } finally {
    // CLI uses the in-process form of the same single-writer coordinator. It
    // must release the connection/queue before Node decides whether to exit.
    await closeSearchIndexWriteCoordinator(new Error('CLI search completed'))
  }
  out({
    query,
    filters: {
      source: typeof flags.source === 'string' ? flags.source : null,
      folder: typeof flags.folder === 'string' ? flags.folder : null,
      after: typeof flags.after === 'string' ? flags.after : null,
      before: typeof flags.before === 'string' ? flags.before : null,
      project: typeof flags.project === 'string' ? flags.project : null
    },
    elapsedMs: Number((performance.now() - startedAt).toFixed(3)),
    warnings: canonicalWarnings,
    sessionCount: results.length,
    matchCount: results.reduce((sum, result) => sum + result.matches.length, 0),
    sessions: results
  })
}

async function cmdResume(sessionId: string, flags: Record<string, string | true>): Promise<void> {
  const result = await buildCliResumeResponse(sessionId, flags)
  if (result.error || !result.command) {
    const message = result.error || '此会话无法直接恢复'
    fail(message, /不存在|not found/i.test(message) ? 3 : 1)
  }
  out({ command: result.command })
}

async function cmdResumeAudit(flags: Record<string, string | true>): Promise<void> {
  const report = await runResumeAudit()
  if (flags.json === true) out(report)
  else activeIo.stdout(formatResumeAuditReport(report))
}

function cmdResolve(sessionId: string, flags: Record<string, string | true>): number {
  const result = resolveSessionId(sessionId, getLibraryRoot())
  if (flags.json === true) {
    out({
      input: result.input,
      resolved: result.resolved,
      matched: result.matched,
      ambiguous: result.ambiguous === true
    })
  } else {
    const output = formatResolveCliOutput(result, false)
    activeIo.stdout(output.stdout)
  }
  if (result.diagnostic) activeIo.stderr(result.diagnostic + '\n')
  if (result.ambiguous) return 2
  if (!result.matched) return 3
  return 0
}

async function cmdLineage(flags: Record<string, string | true>): Promise<void> {
  const libraryRoot = getLibraryRoot()
  const registry = await rebuildSessionLineageRegistry(libraryRoot)
  if (flags['dry-run'] !== true) writeSessionLineageRegistry(registry, getSessionLineagePath(libraryRoot))
  out(registry)
}

function cmdFolders(): void {
  const config = currentLibraryConfig()
  interface FolderNode { id: string; name: string; parentId: string | null; sessionCount: number; children?: FolderNode[] }
  const folderMap = new Map<string, FolderNode>()
  for (const folder of config.folders) {
    folderMap.set(folder.id, {
      id: folder.id,
      name: folder.name,
      parentId: folder.parentId || null,
      sessionCount: folder.sessionIds.length
    })
  }
  const roots: FolderNode[] = []
  for (const node of folderMap.values()) {
    if (node.parentId && folderMap.has(node.parentId)) {
      const parent = folderMap.get(node.parentId)!
      if (!parent.children) parent.children = []
      parent.children.push(node)
    } else roots.push(node)
  }
  out(roots)
}

function cmdFolderCreate(name: string, flags: Record<string, string | true>): void {
  const parentPath = typeof flags.parent === 'string' ? resolveFolderPath(flags.parent) : undefined
  const createdPath = createLibraryFolder(name, parentPath)
  scanLibrary()
  out({ success: true, folder: { id: path.relative(getLibraryRoot(), createdPath), name: path.basename(createdPath) } })
}

function cmdFolderRename(folderId: string, newName: string): void {
  const renamedPath = renameLibraryFolder(resolveFolderPath(folderId), newName)
  scanLibrary()
  out({ success: true, folderId: path.relative(getLibraryRoot(), renamedPath) })
}

function cmdFolderDelete(folderId: string): void {
  deleteLibraryFolder(resolveFolderPath(folderId))
  scanLibrary()
  out({ success: true, folderId })
}

interface MoveInput { sessionId: string; folderId: string }
interface RenameInput { sessionId: string; title: string }

function parseBatchInput<T>(raw: string, validate: (value: unknown, index: number) => T): T[] {
  const trimmed = raw.trim()
  if (!trimmed) fail('stdin 为空')
  let values: unknown[]
  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) }
    catch (error) { fail(`stdin JSON 无效: ${error instanceof Error ? error.message : String(error)}`) }
    if (!Array.isArray(parsed)) fail('stdin JSON 必须是数组或 JSONL')
    values = parsed
  } else {
    values = trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try { return JSON.parse(line) }
      catch (error) { fail(`stdin 第 ${index + 1} 行 JSON 无效: ${error instanceof Error ? error.message : String(error)}`) }
    })
  }
  if (values.length === 0) fail('stdin 没有记录')
  return values.map(validate)
}

function objectRecord(value: unknown, index: number): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`stdin 第 ${index + 1} 条必须是对象`)
  return value as Record<string, unknown>
}

async function moveInputs(cmd: string[], flags: Record<string, string | true>): Promise<MoveInput[]> {
  if (flags.stdin === true) {
    return parseBatchInput(await activeIo.readStdin(), (value, index) => {
      const record = objectRecord(value, index)
      if (typeof record.sessionId !== 'string' || typeof record.folderId !== 'string') {
        fail(`stdin 第 ${index + 1} 条必须包含字符串 sessionId 和 folderId`)
      }
      return { sessionId: record.sessionId, folderId: record.folderId }
    })
  }
  if (!cmd[1] || !cmd[2]) fail('用法: swob move <sessionId> <folderId>，或 swob move --stdin')
  return [{ sessionId: cmd[1], folderId: cmd[2] }]
}

async function renameInputs(cmd: string[], flags: Record<string, string | true>): Promise<RenameInput[]> {
  if (flags.stdin === true) {
    return parseBatchInput(await activeIo.readStdin(), (value, index) => {
      const record = objectRecord(value, index)
      if (typeof record.sessionId !== 'string' || typeof record.title !== 'string') {
        fail(`stdin 第 ${index + 1} 条必须包含字符串 sessionId 和 title`)
      }
      return { sessionId: record.sessionId, title: record.title }
    })
  }
  if (!cmd[1] || !cmd[2]) fail('用法: swob rename <sessionId> <title>，或 swob rename --stdin')
  return [{ sessionId: cmd[1], title: cmd.slice(2).join(' ') }]
}

async function cmdMove(cmd: string[], flags: Record<string, string | true>): Promise<void> {
  const inputs = await moveInputs(cmd, flags)
  const result = moveSessionsToFolders(inputs)
  scanLibrary()
  out({ success: true, operationId: result.operationId, count: inputs.length, moved: result.moves.length })
}

async function cmdRename(cmd: string[], flags: Record<string, string | true>): Promise<void> {
  const inputs = await renameInputs(cmd, flags)
  const result = renameSessionsInLibrary(inputs)
  scanLibrary()
  out({ success: true, operationId: result.operationId, count: inputs.length, renamed: result.moves.length })
}

function cmdUndo(): void {
  const result = undoLastLibraryOrganization()
  if (!result.operationId) fail('没有可撤销的组织事务', 3)
  scanLibrary()
  out({ success: true, operationId: result.operationId, restored: result.moves.length })
}

async function cmdInsights(flags: Record<string, string | true>): Promise<void> {
  const sessions = await loadAllSessions({ quiet: true })
  const config = currentLibraryConfig()
  const sessionTimes = new Map<string, number>()
  for (const session of sessions) if (session.estimatedTime) sessionTimes.set(session.sessionId, session.estimatedTime)
  const insights = buildInsights(sessions, config.folders, sessionTimes)
  if (flags.summary === true || !flags.json) {
    out({
      totalSessions: insights.totalSessions,
      totalTurns: insights.totalTurns,
      totalTokens: insights.totalTokens,
      totalTokensMetric: 'input_plus_output',
      valuation: insights.valuation,
      totalTime: insights.totalTime,
      totalTimeFormatted: formatTime(insights.totalTime),
      activeDays: insights.activeDays,
      bySource: insights.bySource.filter((source) => source.sessionCount > 0).map((source) => ({
        source: source.source,
        label: source.label,
        sessions: source.sessionCount,
        tokens: source.totalTokens,
        tokenMetric: 'input_plus_output',
        tokensFormatted: formatTokens(source.totalTokens)
      })),
      byModel: insights.byModel.slice(0, 10).map((model) => ({
        model: model.model,
        tokens: model.totalTokens,
        tokenMetric: 'input_plus_output',
        tokensFormatted: formatTokens(model.totalTokens),
        sessions: model.sessionCount
      })),
      topProjects: insights.byProject.slice(0, 10).map((project) => ({
        project: project.project,
        path: project.fullPath,
        sessions: project.sessionCount,
        tokens: project.totalTokens,
        tokenMetric: 'input_plus_output',
        tokensFormatted: formatTokens(project.totalTokens)
      }))
    })
    return
  }
  out({ ...insights, totalTokensMetric: 'input_plus_output' })
}

function cmdConfigGet(key?: string): void {
  const config = loadLibraryConfig()
  if (!key) {
    out({ libraryRoot: getLibraryRoot(), preferences: config.preferences })
    return
  }
  const preferences = config.preferences as Record<string, unknown>
  if (key === 'libraryRoot') out({ libraryRoot: getLibraryRoot() })
  else if (key in preferences) out({ [key]: preferences[key] })
  else fail(`未知的配置项: ${key}`)
}

function cmdConfigSet(key: string, value: string): void {
  const config = loadLibraryConfig()
  const preferences = config.preferences as Record<string, unknown>
  if (value === 'true') preferences[key] = true
  else if (value === 'false') preferences[key] = false
  else preferences[key] = value
  saveLibraryConfig(config)
  out({ success: true, [key]: preferences[key] })
}

async function cmdTranscript(args: string[], flags: Record<string, string | true>): Promise<void> {
  if (args[0] !== 'rebuild' || flags.all !== true) {
    fail('用法: swob transcript rebuild --all [--dry-run] [--missing-only]')
  }
  out(await rebuildAllTranscripts({
    dryRun: flags['dry-run'] === true,
    missingOnly: flags['missing-only'] === true
  }))
}

async function cmdInstall(): Promise<void> {
  const home = runtimeHome()
  const environmentOptions = cliInstallOptionsForEnvironment(home)
  const cliInstall = installSwobCli({
    ...environmentOptions,
    allowShellRcUpdate: environmentOptions.testHomeDir ? false : true,
    allowAuthorization: environmentOptions.testHomeDir ? false : true
  })
  const skillDir = path.join(home, '.claude', 'skills', 'swob')
  fs.mkdirSync(skillDir, { recursive: true })
  const skillPath = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillPath, generateSkillContent(), 'utf-8')
  out({
    cliInstalled: cliInstall.cliInstalled,
    cliPath: cliInstall.cliPath,
    cliManualInstall: cliInstall.cliManualInstall,
    cliWrapperPath: cliInstall.wrapperPath,
    cliFallbackUsed: cliInstall.fallbackUsed,
    cliAttemptedPaths: cliInstall.attemptedCliPaths,
    cliVerified: cliInstall.cliVerified,
    shellRcUpdated: cliInstall.shellRcUpdated,
    error: cliInstall.error,
    skillInstalled: true,
    skillPath
  })
}

async function dispatch(cmd: string[], flags: Record<string, string | true>): Promise<number> {
  const command = cmd[0]
  switch (command) {
    case 'search':
      if (!cmd[1]) fail('缺少搜索关键词。用法: swob search <query>')
      await cmdSearch(cmd.slice(1).join(' '), flags)
      return 0
    case 'list': await cmdList(flags); return 0
    case 'show':
      if (!cmd[1]) fail('缺少 sessionId。用法: swob show <sessionId>')
      await cmdShow(cmd[1], flags)
      return 0
    case 'grep':
      if (!cmd[1]) fail('缺少搜索关键词。用法: swob grep <query>')
      await cmdGrep(cmd.slice(1).join(' '), flags)
      return 0
    case 'resume':
      if (!cmd[1]) fail('缺少 sessionId。用法: swob resume <sessionId>')
      await cmdResume(cmd[1], flags)
      return 0
    case 'resume-audit': await cmdResumeAudit(flags); return 0
    case 'resolve':
      if (!cmd[1]) fail('缺少 sessionId。用法: swob resolve <sessionId> [--json]')
      return cmdResolve(cmd[1], flags)
    case 'lineage': await cmdLineage(flags); return 0
    case 'folders': cmdFolders(); return 0
    case 'folder':
      if (cmd[1] === 'create') {
        if (!cmd[2]) fail('缺少文件夹名。用法: swob folder create <name>')
        cmdFolderCreate(cmd.slice(2).join(' '), flags)
      } else if (cmd[1] === 'rename') {
        if (!cmd[2] || !cmd[3]) fail('用法: swob folder rename <id> <name>')
        cmdFolderRename(cmd[2], cmd.slice(3).join(' '))
      } else if (cmd[1] === 'delete') {
        if (!cmd[2]) fail('缺少文件夹 ID。用法: swob folder delete <id>')
        cmdFolderDelete(cmd[2])
      } else fail(`未知的 folder 子命令: ${cmd[1] || ''}`)
      return 0
    case 'move': await cmdMove(cmd, flags); return 0
    case 'rename': await cmdRename(cmd, flags); return 0
    case 'undo': cmdUndo(); return 0
    case 'insights': await cmdInsights(flags); return 0
    case 'config':
      if (cmd[1] === 'get') cmdConfigGet(cmd[2])
      else if (cmd[1] === 'set') {
        if (!cmd[2] || !cmd[3]) fail('用法: swob config set <key> <value>')
        cmdConfigSet(cmd[2], cmd.slice(3).join(' '))
      } else fail(`未知的 config 子命令: ${cmd[1] || ''}`)
      return 0
    case 'active': out({ activeSessionIds: [...detectActiveSessionsFromProcesses()] }); return 0
    case 'transcript': await cmdTranscript(cmd.slice(1), flags); return 0
    case 'redact': {
      const result = redactLibraryTranscripts({ dryRun: flags['dry-run'] === true })
      out({ files: result.files, hits: result.hits })
      return 0
    }
    case 'install': await cmdInstall(); return 0
    default: fail(`未知命令: ${command}。运行 swob --help 查看帮助。`)
  }
}

function errorExitCode(error: unknown): number {
  if (error instanceof CliFailure) return error.exitCode
  const message = error instanceof Error ? error.message : String(error)
  return /不存在|not found|ENOENT/i.test(message) ? 3 : 1
}

export async function runCli(
  argv: string[],
  io: CliIo = processIo,
  options: { libraryRoot?: string } = {}
): Promise<number> {
  activeIo = io
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  const diagnostic = (...values: unknown[]) => activeIo.stderr(formatLog(...values) + '\n')
  console.log = diagnostic
  console.info = diagnostic
  console.warn = diagnostic
  console.error = diagnostic
  try {
    const { cmd, flags } = parseArgs(argv)
    if (flags.version === true) {
      if (flags.json === true) out({ name: 'swob', version: CLI_VERSION })
      else activeIo.stdout(CLI_VERSION + '\n')
      return 0
    }
    if (cmd.length === 0 || flags.help === true) {
      if (flags.json === true) out(cliHelpData())
      else activeIo.stdout(renderCliHelp())
      return 0
    }
    initLibrary(options.libraryRoot, { readOnly: cmd[0] === 'resume-audit' })
    scanLibrary()
    return await dispatch(cmd, flags)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const details = error instanceof CliFailure ? error.details : undefined
    activeIo.stderr(JSON.stringify({
      error: details ? { message, ...details } : message
    }) + '\n')
    return errorExitCode(error)
  } finally {
    console.log = originalConsole.log
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    console.error = originalConsole.error
    activeIo = processIo
  }
}

if (process.env.SWOB_CLI_DISABLE_AUTO_RUN !== '1' && process.env.VITEST !== 'true') {
  void runCli(process.argv.slice(2)).then((exitCode) => { process.exitCode = exitCode })
}
