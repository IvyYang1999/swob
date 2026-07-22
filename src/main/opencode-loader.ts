import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import type {
  RawJsonlMessage,
  ParsedMessage,
  SessionSummary,
  SessionDetail,
  ToolCallInfo,
  TokenUsage,
  ContentPart,
  SessionSource
} from './types'
import { accountingFromMutuallyExclusiveUsage, tokenUsageFromAccounting } from './token-accounting'
import { runtimeHome } from './runtime-home'
import { activityDaysFromTimestamps } from './activity-time'

const SESSION_ID_RE = /^sess?_[A-Za-z0-9_-]+$/
const SQLITE_TIMEOUT_MS = 5000
const AGENT_DB_SOURCES = {
  opencode: {
    relativePath: ['.local', 'share', 'opencode', 'opencode.db'],
    summaryPrefix: 'opencode'
  },
  zcode: {
    relativePath: ['.zcode', 'cli', 'db', 'db.sqlite'],
    summaryPrefix: 'zcode'
  }
} as const
export type SqliteAgentSource = keyof typeof AGENT_DB_SOURCES
const SESSION_SELECT_COLUMNS = [
  'id',
  'slug',
  'directory',
  'title',
  'model',
  'tokens',
  'time_created',
  'timeCreated',
  'created_at',
  'createdAt',
  'time_updated',
  'timeUpdated',
  'updated_at',
  'updatedAt',
  'parent_id',
  'parentId',
  'parentID'
]
const MESSAGE_SELECT_COLUMNS = ['id', 'data', 'role', 'time_created', 'timeCreated']
const PART_SELECT_COLUMNS = [
  'id',
  'messageID',
  'messageId',
  'message_id',
  'type',
  'idx',
  'index',
  'order',
  'sequence',
  'data',
  'name',
  'text',
  'content'
]

type SqliteRow = Record<string, unknown>

interface OpencodeSchema {
  session: Set<string>
  message: Set<string>
  part: Set<string>
  sessionMessage: Set<string>
}

interface LoadedOpencodeSession {
  dbPath: string
  sourceRef: string
  sessionId: string
  sessionRow: SqliteRow
  rawMessages: RawJsonlMessage[]
}

const schemaCache = new Map<string, Promise<OpencodeSchema | null>>()

export function getOpencodeDbPath(): string {
  return getSqliteAgentDbPath('opencode')
}

export function getSqliteAgentDbPath(source: SqliteAgentSource): string {
  return path.join(runtimeHome(), ...AGENT_DB_SOURCES[source].relativePath)
}

export function isValidOpencodeSessionId(sessionId?: string): boolean {
  return !!sessionId && SESSION_ID_RE.test(sessionId)
}

export function makeOpencodeSessionRef(sessionId: string, dbPath = getOpencodeDbPath()): string {
  return makeSqliteAgentSessionRef('opencode', sessionId, dbPath)
}

export function makeSqliteAgentSessionRef(
  source: SqliteAgentSource,
  sessionId: string,
  dbPath = getSqliteAgentDbPath(source)
): string {
  return `${dbPath}#${sessionId}`
}

export function parseOpencodeSessionRef(
  sourceRef: string,
  sessionIdOverride?: string
): { dbPath: string; sessionId: string | null } {
  return parseSqliteAgentSessionRef('opencode', sourceRef, sessionIdOverride)
}

export function parseSqliteAgentSessionRef(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): { dbPath: string; sessionId: string | null } {
  if (sessionIdOverride) {
    return {
      dbPath: stripSqliteAgentSessionRef(sourceRef),
      sessionId: isValidOpencodeSessionId(sessionIdOverride) ? sessionIdOverride : null
    }
  }

  if (isValidOpencodeSessionId(sourceRef)) {
    return { dbPath: getSqliteAgentDbPath(source), sessionId: sourceRef }
  }

  const hashIdx = sourceRef.lastIndexOf('#')
  if (hashIdx >= 0) {
    const sessionId = sourceRef.slice(hashIdx + 1)
    return {
      dbPath: sourceRef.slice(0, hashIdx),
      sessionId: isValidOpencodeSessionId(sessionId) ? sessionId : null
    }
  }

  return { dbPath: sourceRef, sessionId: null }
}

export function stripOpencodeSessionRef(sourceRef: string): string {
  return stripSqliteAgentSessionRef(sourceRef)
}

export function stripSqliteAgentSessionRef(sourceRef: string): string {
  const hashIdx = sourceRef.lastIndexOf('#')
  return hashIdx >= 0 ? sourceRef.slice(0, hashIdx) : sourceRef
}

export async function findOpencodeSessionFiles(dbPath = getOpencodeDbPath()): Promise<string[]> {
  return findSqliteAgentSessionFiles('opencode', dbPath)
}

export async function findSqliteAgentSessionFiles(
  source: SqliteAgentSource,
  dbPath = getSqliteAgentDbPath(source)
): Promise<string[]> {
  if (!fs.existsSync(dbPath)) return []
  const schema = await getSchema(dbPath)
  if (!schema || !schema.session.has('id')) return []

  const rows = await runSqliteJson<SqliteRow>(
    dbPath,
    'SELECT "id" FROM "session"'
  )

  return rows
    .map((row) => asString(row.id))
    .filter(isValidOpencodeSessionId)
    .map((sessionId) => makeSqliteAgentSessionRef(source, sessionId, dbPath))
}

/** Verify that a DB-backed resume reference still points at a real session row. */
export async function hasSqliteAgentSessionRecord(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<boolean> {
  const { dbPath, sessionId } = parseSqliteAgentSessionRef(source, sourceRef, sessionIdOverride)
  if (!sessionId || !fs.existsSync(dbPath)) return false

  const schema = await getSchema(dbPath)
  if (!schema?.session.has('id')) return false
  const rows = await runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT "id" FROM "session" WHERE "id" = ${sqlString(sessionId)} LIMIT 1`
  )
  return rows.length === 1
}

export async function loadOpencodeRawMessages(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<RawJsonlMessage[]> {
  return loadSqliteAgentRawMessages('opencode', sourceRef, sessionIdOverride)
}

export async function buildOpencodeSessionSummary(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return buildSqliteAgentSessionSummary('opencode', sourceRef, sessionIdOverride)
}

export async function buildOpencodeSessionDetail(
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionDetail | null> {
  return buildSqliteAgentSessionDetail('opencode', sourceRef, sessionIdOverride)
}

export async function loadSqliteAgentRawMessages(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<RawJsonlMessage[]> {
  const loaded = await loadSqliteAgentSession(source, sourceRef, sessionIdOverride)
  return loaded?.rawMessages || []
}

export async function buildSqliteAgentSessionSummary(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionSummary | null> {
  const loaded = await loadSqliteAgentSession(source, sourceRef, sessionIdOverride)
  if (!loaded || loaded.rawMessages.length === 0) return null
  return summarizeLoadedSqliteAgentSession(source, loaded)
}

export async function buildSqliteAgentSessionDetail(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<SessionDetail | null> {
  const loaded = await loadSqliteAgentSession(source, sourceRef, sessionIdOverride)
  if (!loaded || loaded.rawMessages.length === 0) return null

  const summary = summarizeLoadedSqliteAgentSession(source, loaded)
  if (!summary) return null

  const messages = rawToParsedMessages(loaded.rawMessages)
  attachToolResults(loaded.rawMessages, messages)

  return { ...summary, messages }
}

export async function buildOpencodeSessionSummaryFromBackup(
  _filePath: string,
  _sessionIdOverride?: string
): Promise<SessionSummary | null> {
  return null
}

async function loadSqliteAgentSession(
  source: SqliteAgentSource,
  sourceRef: string,
  sessionIdOverride?: string
): Promise<LoadedOpencodeSession | null> {
  const { dbPath, sessionId } = parseSqliteAgentSessionRef(source, sourceRef, sessionIdOverride)
  if (!sessionId || !fs.existsSync(dbPath)) return null

  const schema = await getSchema(dbPath)
  if (!schema || !hasMinimumSchema(schema)) return null

  const sessionSelect = selectExistingColumns(schema.session, SESSION_SELECT_COLUMNS)
  const sessionRows = await runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT ${sessionSelect} FROM "session" WHERE "id" = ${sqlString(sessionId)} LIMIT 1`
  )
  const sessionRow = sessionRows[0]
  if (!sessionRow) return null

  const messageRows = await queryMessages(dbPath, schema, sessionId)
  if (messageRows.length === 0) return null

  const partRows = await queryParts(dbPath, schema, sessionId, messageRows)
  const rawMessages = opencodeToRawMessages(sessionId, sessionRow, messageRows, partRows)

  return {
    dbPath,
    sourceRef: makeSqliteAgentSessionRef(source, sessionId, dbPath),
    sessionId,
    sessionRow,
    rawMessages
  }
}

function hasMinimumSchema(schema: OpencodeSchema): boolean {
  return schema.session.has('id') &&
    schema.message.has('id') &&
    schema.message.has('data') &&
    schema.part.has('data')
}

async function getSchema(dbPath: string): Promise<OpencodeSchema | null> {
  let cached = schemaCache.get(dbPath)
  if (!cached) {
    cached = loadSchema(dbPath)
    schemaCache.set(dbPath, cached)
  }
  return cached
}

async function loadSchema(dbPath: string): Promise<OpencodeSchema | null> {
  const [session, message, part, sessionMessage] = await Promise.all([
    tableColumns(dbPath, 'session'),
    tableColumns(dbPath, 'message'),
    tableColumns(dbPath, 'part'),
    tableColumns(dbPath, 'session_message')
  ])

  if (!session || !message || !part || !sessionMessage) return null
  return { session, message, part, sessionMessage }
}

async function tableColumns(dbPath: string, tableName: string): Promise<Set<string> | null> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) return null
  const rows = await runSqliteJson<SqliteRow>(
    dbPath,
    `PRAGMA table_info("${tableName}")`
  )
  return new Set(rows.map((row) => asString(row.name)).filter(Boolean))
}

async function runSqliteJson<T extends SqliteRow>(dbPath: string, sql: string): Promise<T[]> {
  if (!fs.existsSync(dbPath)) return []

  return new Promise((resolve) => {
    let settled = false
    let stdout = ''

    function finish(rows: T[]): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(rows)
    }

    const child = spawn('sqlite3', ['-readonly', '-json', dbPath], {
      stdio: ['pipe', 'pipe', 'ignore']
    })

    const timer = setTimeout(() => {
      child.kill()
      finish([])
    }, SQLITE_TIMEOUT_MS)

    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })

    child.on('error', () => finish([]))
    child.on('close', (code) => {
      if (code !== 0) {
        finish([])
        return
      }
      try {
        const trimmed = stdout.trim()
        finish(trimmed ? JSON.parse(trimmed) as T[] : [])
      } catch {
        finish([])
      }
    })

    child.stdin.end(`PRAGMA query_only=ON;\n${sql.trim()};\n`)
  })
}

async function queryMessages(
  dbPath: string,
  schema: OpencodeSchema,
  sessionId: string
): Promise<SqliteRow[]> {
  const messageSelect = selectExistingColumns(schema.message, MESSAGE_SELECT_COLUMNS)
  const messageSessionCol = pickColumn(schema.message, ['sessionID', 'sessionId', 'session_id'])
  if (messageSessionCol) {
    return runSqliteJson<SqliteRow>(
      dbPath,
      `SELECT ${messageSelect} FROM "message" WHERE ${quotedIdent(messageSessionCol)} = ${sqlString(sessionId)}`
    )
  }

  const smSessionCol = pickColumn(schema.sessionMessage, ['sessionID', 'sessionId', 'session_id'])
  const smMessageCol = pickColumn(schema.sessionMessage, ['messageID', 'messageId', 'message_id'])
  if (smSessionCol && smMessageCol) {
    const aliasedMessageSelect = selectExistingColumns(schema.message, MESSAGE_SELECT_COLUMNS, 'm')
    return runSqliteJson<SqliteRow>(
      dbPath,
      `SELECT ${aliasedMessageSelect} FROM "message" m ` +
      `JOIN "session_message" sm ON sm.${quotedIdent(smMessageCol)} = m."id" ` +
      `WHERE sm.${quotedIdent(smSessionCol)} = ${sqlString(sessionId)}`
    )
  }

  return []
}

async function queryParts(
  dbPath: string,
  schema: OpencodeSchema,
  sessionId: string,
  messages: SqliteRow[]
): Promise<SqliteRow[]> {
  const partSelect = selectExistingColumns(schema.part, PART_SELECT_COLUMNS)
  const partSessionCol = pickColumn(schema.part, ['sessionID', 'sessionId', 'session_id'])
  if (partSessionCol) {
    return runSqliteJson<SqliteRow>(
      dbPath,
      `SELECT ${partSelect} FROM "part" WHERE ${quotedIdent(partSessionCol)} = ${sqlString(sessionId)}`
    )
  }

  const partMessageCol = pickColumn(schema.part, ['messageID', 'messageId', 'message_id'])
  if (!partMessageCol) return []

  const ids = messages.map(messageId).filter(Boolean).map(sqlString)
  if (ids.length === 0) return []

  return runSqliteJson<SqliteRow>(
    dbPath,
    `SELECT ${partSelect} FROM "part" WHERE ${quotedIdent(partMessageCol)} IN (${ids.join(',')})`
  )
}

function opencodeToRawMessages(
  sessionId: string,
  sessionRow: SqliteRow,
  messageRows: SqliteRow[],
  partRows: SqliteRow[]
): RawJsonlMessage[] {
  const partsByMessage = new Map<string, SqliteRow[]>()
  for (const part of partRows) {
    const id = partMessageId(part)
    if (!id) continue
    if (!partsByMessage.has(id)) partsByMessage.set(id, [])
    partsByMessage.get(id)!.push(part)
  }

  const rows = [...messageRows].sort((a, b) => {
    const at = timestampSortValue(messageTimestamp(a))
    const bt = timestampSortValue(messageTimestamp(b))
    if (at !== bt) return at - bt
    return messageId(a).localeCompare(messageId(b))
  })

  const messages: RawJsonlMessage[] = []
  for (const row of rows) {
    const data = parseObject(row.data)
    const role = asString(data.role) || asString(row.role)
    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue

    const uuid = asString(row.id) || asString(data.id)
    if (!uuid) continue

    const parts = (partsByMessage.get(uuid) || [])
      .filter((part) => !isIgnoredPartType(partType(part)))
      .sort(sortParts)

    const content = buildMessageContent(role, data, parts)
    if (isEmptyContent(content)) continue

    const timestamp = normalizeTimestamp(
      data.time && typeof data.time === 'object'
        ? (data.time as Record<string, unknown>).created
        : undefined
    ) || normalizeTimestamp(row.time_created) || normalizeTimestamp(row.timeCreated) || ''

    const cwd = asString(parseObject(data.path).cwd) ||
      asString(data.cwd) ||
      asString(sessionRow.directory)
    const model = asString(data.model) || asString(sessionRow.model)

    messages.push({
      uuid,
      parentUuid: asString(data.parentID) || asString(data.parentId) || null,
      sessionId,
      type: role,
      timestamp,
      cwd,
      slug: asString(sessionRow.slug) || undefined,
      version: model || undefined,
      message: {
        role,
        model: model || undefined,
        content,
        usage: extractUsage(data.tokens)
      }
    })
  }

  return messages
}

function buildMessageContent(
  role: string,
  messageData: Record<string, unknown>,
  parts: SqliteRow[]
): string | ContentPart[] {
  const contentParts: ContentPart[] = []

  for (const part of parts) {
    const type = partType(part)
    const data = parseObject(part.data)

    if (type === 'text') {
      const text = extractPartText(part, data)
      if (text) contentParts.push({ type: 'text', text })
      continue
    }

    if (type === 'tool' && role === 'assistant') {
      const tool = buildToolUsePart(part, data)
      if (tool) contentParts.push(tool)
    }
  }

  if (contentParts.length === 0) {
    const fallbackText = extractMessageFallbackText(messageData)
    return fallbackText
  }

  const textOnly = contentParts.every((part) => part.type === 'text')
  if (textOnly) {
    return contentParts.map((part) => part.text || '').filter(Boolean).join('\n')
  }

  return contentParts
}

function buildToolUsePart(part: SqliteRow, data: Record<string, unknown>): ContentPart | null {
  const name = normalizeToolName(
    asString(data.name) ||
    asString(data.tool) ||
    asString(data.toolName) ||
    asString(part.name)
  )
  if (!name) return null

  return {
    type: 'tool_use',
    id: asString(data.id) || asString(data.callID) || asString(data.callId) || asString(part.id),
    name,
    input: extractToolInput(data)
  }
}

function extractToolInput(data: Record<string, unknown>): Record<string, unknown> {
  const candidate = data.input || data.args || data.arguments || data.params
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
    return candidate as Record<string, unknown>
  }
  if (typeof candidate === 'string') {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* ignore */ }
  }
  return {}
}

function extractPartText(part: SqliteRow, data: Record<string, unknown>): string {
  const direct = asString(data.text) ||
    asString(data.content) ||
    asString(data.value) ||
    asString(part.text) ||
    asString(part.content)
  return direct || ''
}

function partType(part: SqliteRow): string {
  return asString(part.type) || asString(parseObject(part.data).type)
}

function extractMessageFallbackText(messageData: Record<string, unknown>): string {
  return asString(messageData.text) ||
    asString(messageData.content) ||
    asString(messageData.message) ||
    ''
}

function summarizeLoadedSqliteAgentSession(source: SqliteAgentSource, loaded: LoadedOpencodeSession): SessionSummary | null {
  const { dbPath, sourceRef, sessionId, sessionRow, rawMessages } = loaded
  if (rawMessages.length === 0) return null

  const validMessages = rawMessages.filter((m) => (m.type === 'user' || m.type === 'assistant') && m.message)
  if (validMessages.length === 0) return null

  const userMessages = validMessages.filter((m) => m.type === 'user' && extractText(m.message?.content).trim())
  const assistantMessages = validMessages.filter((m) => {
    if (m.type !== 'assistant') return false
    const content = m.message?.content
    return extractText(content).trim().length > 0 || extractToolCalls(content).length > 0
  })
  const timestamps = rawMessages.map((m) => m.timestamp).filter(Boolean).sort()
  const activityDays = activityDaysFromTimestamps(timestamps)
  const cwds = [...new Set(rawMessages.map((m) => m.cwd).filter(Boolean) as string[])]
  const sessionTitle = source === 'zcode'
    ? asString(sessionRow.title) || asString(sessionRow.slug)
    : asString(sessionRow.slug) || asString(sessionRow.title)
  const firstUserMessage = userMessages[0]?.message
    ? extractText(userMessages[0].message.content).slice(0, 200)
    : (sessionTitle || sessionId).slice(0, 200)

  const allUserTexts: string[] = []
  let totalLen = 0
  const USER_TEXT_LIMIT = 2000
  for (const msg of userMessages) {
    const text = extractText(msg.message?.content).trim()
    if (!text || text === firstUserMessage) continue
    if (totalLen + text.length > USER_TEXT_LIMIT) {
      allUserTexts.push(text.slice(0, USER_TEXT_LIMIT - totalLen))
      break
    }
    allUserTexts.push(text)
    totalLen += text.length
  }

  const toolUsage: Record<string, number> = {}
  for (const msg of rawMessages) {
    if (msg.type !== 'assistant') continue
    for (const tool of extractToolCalls(msg.message?.content)) {
      toolUsage[tool.name] = (toolUsage[tool.name] || 0) + 1
    }
  }

  const tokenUsage = rawMessages.reduce<TokenUsage>((acc, msg) => {
    if (msg.type !== 'assistant' || !msg.message?.usage) return acc
    acc.inputTokens += msg.message.usage.input_tokens || 0
    acc.outputTokens += msg.message.usage.output_tokens || 0
    acc.cacheCreationTokens += msg.message.usage.cache_creation_input_tokens || 0
    acc.cacheReadTokens += msg.message.usage.cache_read_input_tokens || 0
    return acc
  }, { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 })

  const sessionTokenUsage = extractAggregateUsage(sessionRow.tokens)
  if (tokenUsage.inputTokens === 0 && tokenUsage.outputTokens === 0 && sessionTokenUsage) {
    Object.assign(tokenUsage, sessionTokenUsage)
  }
  const tokenAccounting = accountingFromMutuallyExclusiveUsage(
    source as SessionSource,
    tokenUsage,
    'reported'
  )
  const normalizedTokenUsage = tokenUsageFromAccounting(tokenAccounting)

  const stat = safeStat(dbPath)
  const models = [...new Set(rawMessages.map((m) => m.message?.model).filter(Boolean) as string[])]
  const sessionModel = asString(sessionRow.model)
  if (sessionModel && !models.includes(sessionModel)) models.push(sessionModel)

  return {
    id: `${AGENT_DB_SOURCES[source].summaryPrefix}:${sessionId}`,
    sessionId,
    resumeSessionId: sessionId,
    slug: sessionTitle,
    createdAt: timestamps[0] || '',
    updatedAt: timestamps[timestamps.length - 1] || '',
    activityDays,
    messageCount: validMessages.length,
    turnCount: Math.min(userMessages.length, assistantMessages.length),
    compactCount: 0,
    cwds,
    version: sessionModel || models[0] || '',
    firstUserMessage,
    toolUsage,
    skillInvocations: [],
    projectPath: asString(sessionRow.directory) || path.dirname(dbPath),
    filePath: sourceRef,
    fileSizeBytes: stat?.size || 0,
    allFilePaths: [sourceRef],
    resumeCwd: asString(sessionRow.directory) || cwds[0],
    branchParentId: asString(sessionRow.parent_id) || asString(sessionRow.parentId) || asString(sessionRow.parentID) || undefined,
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: normalizedTokenUsage,
    tokenAccounting,
    referencedFiles: [],
    configFiles: [],
    source: source as SessionSource,
    allUserMessages: allUserTexts.length > 0 ? allUserTexts.join(' ') : undefined,
    models
  }
}

function rawToParsedMessages(rawMessages: RawJsonlMessage[]): ParsedMessage[] {
  return rawMessages
    .filter((m) => m.type === 'user' || m.type === 'assistant' || m.type === 'system')
    .map((m) => {
      const content = m.message?.content
      const isToolResult = Array.isArray(content) && content.some((part) => part.type === 'tool_result')
      return {
        uuid: m.uuid,
        type: m.type as ParsedMessage['type'],
        subtype: undefined,
        timestamp: m.timestamp,
        role: m.message?.role,
        origin: 'unknown',
        textContent: extractText(content),
        toolCalls: extractToolCalls(content),
        images: [],
        tokenUsage: m.type === 'assistant' ? extractParsedTokenUsage(m) : undefined,
        isPreCompact: false,
        isSidechain: false,
        isSharedContext: false,
        isSystemGenerated: isToolResult,
        raw: m
      }
    })
}

function attachToolResults(rawMessages: RawJsonlMessage[], parsedMessages: ParsedMessage[]): void {
  for (const raw of rawMessages) {
    const content = raw.message?.content
    if (raw.type !== 'user' || !Array.isArray(content)) continue
    for (const part of content) {
      if (part.type !== 'tool_result' || !part.tool_use_id || !part.content) continue
      const resultText = typeof part.content === 'string' ? part.content : extractText(part.content)
      if (!resultText) continue
      for (const msg of parsedMessages) {
        const toolCall = msg.toolCalls.find((tc) => tc.id === part.tool_use_id)
        if (toolCall) {
          toolCall.result = resultText
          break
        }
      }
    }
  }
}

function extractText(content: string | ContentPart[] | undefined): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .filter((part) => part.type === 'text' && part.text)
    .map((part) => part.text!)
    .join('\n')
}

function extractToolCalls(content: string | ContentPart[] | undefined): ToolCallInfo[] {
  if (!content || typeof content === 'string') return []
  return content
    .filter((part) => part.type === 'tool_use' && part.name)
    .map((part) => ({
      id: part.id,
      name: part.name!,
      input: (part.input as Record<string, unknown>) || {}
    }))
}

function extractParsedTokenUsage(msg: RawJsonlMessage): TokenUsage | undefined {
  const usage = msg.message?.usage
  if (!usage) return undefined
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
    cacheReadTokens: usage.cache_read_input_tokens || 0
  }
}

function extractUsage(tokensValue: unknown): NonNullable<RawJsonlMessage['message']>['usage'] | undefined {
  const usage = extractAggregateUsage(tokensValue)
  if (!usage) return undefined
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_creation_input_tokens: usage.cacheCreationTokens,
    cache_read_input_tokens: usage.cacheReadTokens
  }
}

function extractAggregateUsage(tokensValue: unknown): TokenUsage | null {
  const tokens = parseObject(tokensValue)
  if (Object.keys(tokens).length === 0) return null

  const cache = parseObject(tokens.cache)
  return {
    inputTokens: asNumber(tokens.input) ||
      asNumber(tokens.inputTokens) ||
      asNumber(tokens.input_tokens) ||
      asNumber(tokens.prompt_tokens) ||
      0,
    outputTokens: asNumber(tokens.output) ||
      asNumber(tokens.outputTokens) ||
      asNumber(tokens.output_tokens) ||
      asNumber(tokens.completion_tokens) ||
      0,
    cacheCreationTokens: asNumber(tokens.cacheCreation) ||
      asNumber(tokens.cache_creation_input_tokens) ||
      asNumber(cache.creation) ||
      asNumber(cache.write) ||
      0,
    cacheReadTokens: asNumber(tokens.cacheRead) ||
      asNumber(tokens.cache_read_input_tokens) ||
      asNumber(tokens.cached_input_tokens) ||
      asNumber(cache.read) ||
      0
  }
}

function isIgnoredPartType(partType: string): boolean {
  return partType === 'step-start' ||
    partType === 'step-finish' ||
    partType === 'reasoning'
}

function normalizeToolName(name: string): string {
  const normalized = name.trim()
  const map: Record<string, string> = {
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Bash'
  }
  return map[normalized.toLowerCase()] || normalized
}

function sortParts(a: SqliteRow, b: SqliteRow): number {
  const ai = asNumber(a.idx) || asNumber(a.index) || asNumber(a.order) || asNumber(a.sequence)
  const bi = asNumber(b.idx) || asNumber(b.index) || asNumber(b.order) || asNumber(b.sequence)
  if (ai !== bi) return ai - bi
  return asString(a.id).localeCompare(asString(b.id))
}

function messageTimestamp(row: SqliteRow): unknown {
  const data = parseObject(row.data)
  const time = parseObject(data.time)
  return time.created || row.time_created || row.timeCreated
}

function timestampSortValue(value: unknown): number {
  const iso = normalizeTimestamp(value)
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeTimestamp(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000
    return new Date(millis).toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return ''
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const num = Number(trimmed)
      if (Number.isFinite(num)) return normalizeTimestamp(num)
    }
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed
  }
  return ''
}

function messageId(row: SqliteRow): string {
  const data = parseObject(row.data)
  return asString(row.id) || asString(data.id)
}

function partMessageId(row: SqliteRow): string {
  const data = parseObject(row.data)
  return asString(row.messageID) ||
    asString(row.messageId) ||
    asString(row.message_id) ||
    asString(data.messageID) ||
    asString(data.messageId) ||
    asString(data.message_id)
}

function parseObject(value: unknown): Record<string, unknown> {
  if (!value) return {}
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string') return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function isEmptyContent(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return content.trim().length === 0
  return content.every((part) => {
    if (part.type === 'tool_use') return false
    return !part.text?.trim()
  })
}

function pickColumn(columns: Set<string>, candidates: string[]): string | null {
  return candidates.find((candidate) => columns.has(candidate)) || null
}

function selectExistingColumns(columns: Set<string>, candidates: string[], alias?: string): string {
  const prefix = alias ? `${alias}.` : ''
  return candidates
    .filter((candidate) => columns.has(candidate))
    .map((candidate) => `${prefix}${quotedIdent(candidate)}`)
    .join(', ')
}

function quotedIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}
