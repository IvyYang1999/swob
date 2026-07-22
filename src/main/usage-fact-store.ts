import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Folder, SessionSummary } from './types'
import { accountingForSession, totalCacheWriteTokens, type UsageEvent } from './token-accounting'
import { valueUsageEvent } from './token-valuation'
import { searchDatabasePath } from './search-index'
import { providerCanParseTranscript } from '../shared/provider-capabilities'
import {
  USAGE_FACT_SCHEMA_VERSION,
  type AnalysisDimension,
  type AnalysisScope,
  type CoverageMetric,
  type InsightsDrilldownSession,
  type InsightsQueryResult,
  type MetricBasis,
  type PreviousPeriodComparison,
  type ResolvedAnalysisRange,
  type UsageAggregate,
  type UsageFact,
  type UsageFactSyncResult
} from './analysis-contract'

const UNKNOWN_TIME = 'unknown-time'
const UNKNOWN_MODEL = 'unknown-model'
const UNKNOWN_PROJECT = '(unknown project)'

let database: Database.Database | null = null
let databasePath = ''

interface UsageRollupRow {
  key: string
  billing_non_cached_input: number
  billing_cache_read: number
  billing_cache_write: number
  billing_output: number
  billing_reasoning: number
  conversation_non_cached_input: number
  conversation_cache_read: number
  conversation_cache_write: number
  conversation_output: number
  conversation_reasoning: number
  calls: number
  conversation_calls: number
  modeled_calls: number
  conversation_modeled_calls: number
  billing_priced_tokens: number
  billing_billable_tokens: number
  billing_cost_usd: number
  conversation_priced_tokens: number
  conversation_billable_tokens: number
  conversation_cost_usd: number
  session_count: number
  detected_session_count: number
  parsed_session_count: number
  usage_available_session_count: number
  usage_unavailable_session_count: number
  unknown_time_events: number
}

interface UsageFactRow {
  event_id: string
  occurred_at: string | null
  occurred_day: string
  occurred_hour: number
  source_client: string
  session_id: string
  root_session_id: string
  agent_scope: UsageFact['agentScope']
  project_path: string
  model_key: string
  model_raw: string
  model_provenance: string
  non_cached_input: number
  cache_read: number
  cache_write: number
  output_tokens: number
  reasoning_tokens: number
  usage_provenance: string
  call_count: number
  turn_count: number
  cost_usd: number | null
  pricing_provenance: string | null
  priced_tokens: number
  billable_tokens: number
}

function usageDatabasePath(): string {
  return process.env.SWOB_USAGE_INDEX_PATH || searchDatabasePath()
}

function ensureSchema(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('busy_timeout = 2500')
  db.pragma('foreign_keys = ON')
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_schema_meta (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      schema_version INTEGER NOT NULL,
      last_indexed_at TEXT
    );
  `)
  const version = db.prepare(
    'SELECT schema_version FROM usage_schema_meta WHERE singleton = 1'
  ).get() as { schema_version: number } | undefined
  if (version && version.schema_version !== USAGE_FACT_SCHEMA_VERSION) {
    db.exec(`
      DROP TABLE IF EXISTS usage_rollups;
      DROP TABLE IF EXISTS usage_session_folders;
      DROP TABLE IF EXISTS usage_folders;
      DROP TABLE IF EXISTS usage_facts;
      DROP TABLE IF EXISTS usage_sessions;
      DELETE FROM usage_schema_meta;
    `)
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_sessions (
      session_id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      source_client TEXT NOT NULL,
      project_path TEXT NOT NULL,
      turn_count INTEGER NOT NULL,
      usage_available INTEGER NOT NULL,
      fact_signature TEXT NOT NULL,
      folder_signature TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_sessions_source_idx ON usage_sessions(source_client);
    CREATE INDEX IF NOT EXISTS usage_sessions_project_idx ON usage_sessions(project_path);

    CREATE TABLE IF NOT EXISTS usage_facts (
      event_id TEXT PRIMARY KEY,
      occurred_at TEXT,
      occurred_day TEXT NOT NULL,
      occurred_hour INTEGER NOT NULL,
      source_client TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES usage_sessions(session_id) ON DELETE CASCADE,
      root_session_id TEXT NOT NULL,
      agent_scope TEXT NOT NULL,
      project_path TEXT NOT NULL,
      model_key TEXT NOT NULL,
      model_raw TEXT NOT NULL,
      model_provenance TEXT NOT NULL,
      non_cached_input INTEGER NOT NULL,
      cache_read INTEGER NOT NULL,
      cache_write INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_tokens INTEGER NOT NULL,
      usage_provenance TEXT NOT NULL,
      call_count INTEGER NOT NULL,
      turn_count INTEGER NOT NULL,
      cost_usd REAL,
      pricing_provenance TEXT,
      priced_tokens INTEGER NOT NULL,
      billable_tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_facts_time_idx ON usage_facts(occurred_day, occurred_hour);
    CREATE INDEX IF NOT EXISTS usage_facts_source_idx ON usage_facts(source_client);
    CREATE INDEX IF NOT EXISTS usage_facts_model_idx ON usage_facts(model_key);
    CREATE INDEX IF NOT EXISTS usage_facts_project_idx ON usage_facts(project_path);
    CREATE INDEX IF NOT EXISTS usage_facts_session_idx ON usage_facts(session_id);

    CREATE TABLE IF NOT EXISTS usage_session_folders (
      session_id TEXT NOT NULL REFERENCES usage_sessions(session_id) ON DELETE CASCADE,
      folder_id TEXT NOT NULL,
      PRIMARY KEY(session_id, folder_id)
    );
    CREATE INDEX IF NOT EXISTS usage_session_folders_folder_idx ON usage_session_folders(folder_id);

    CREATE TABLE IF NOT EXISTS usage_folders (
      folder_id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_rollups (
      occurred_day TEXT NOT NULL,
      occurred_hour INTEGER NOT NULL,
      source_client TEXT NOT NULL,
      model_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES usage_sessions(session_id) ON DELETE CASCADE,
      billing_non_cached_input INTEGER NOT NULL,
      billing_cache_read INTEGER NOT NULL,
      billing_cache_write INTEGER NOT NULL,
      billing_output INTEGER NOT NULL,
      billing_reasoning INTEGER NOT NULL,
      conversation_non_cached_input INTEGER NOT NULL,
      conversation_cache_read INTEGER NOT NULL,
      conversation_cache_write INTEGER NOT NULL,
      conversation_output INTEGER NOT NULL,
      conversation_reasoning INTEGER NOT NULL,
      billing_priced_tokens INTEGER NOT NULL,
      billing_billable_tokens INTEGER NOT NULL,
      billing_cost_usd REAL NOT NULL,
      conversation_priced_tokens INTEGER NOT NULL,
      conversation_billable_tokens INTEGER NOT NULL,
      conversation_cost_usd REAL NOT NULL,
      calls INTEGER NOT NULL,
      conversation_calls INTEGER NOT NULL,
      modeled_calls INTEGER NOT NULL,
      conversation_modeled_calls INTEGER NOT NULL,
      first_occurred_at TEXT,
      last_occurred_at TEXT,
      PRIMARY KEY(occurred_day, occurred_hour, source_client, model_key, project_path, session_id)
    );
    CREATE INDEX IF NOT EXISTS usage_rollups_day_idx ON usage_rollups(occurred_day);
    CREATE INDEX IF NOT EXISTS usage_rollups_source_idx ON usage_rollups(source_client);
    CREATE INDEX IF NOT EXISTS usage_rollups_model_idx ON usage_rollups(model_key);
    CREATE INDEX IF NOT EXISTS usage_rollups_project_idx ON usage_rollups(project_path);
    CREATE INDEX IF NOT EXISTS usage_rollups_session_idx ON usage_rollups(session_id);

    INSERT INTO usage_schema_meta(singleton, schema_version, last_indexed_at)
    VALUES (1, ${USAGE_FACT_SCHEMA_VERSION}, NULL)
    ON CONFLICT(singleton) DO UPDATE SET schema_version = excluded.schema_version;
  `)
}

function getDatabase(): Database.Database {
  const requestedPath = usageDatabasePath()
  if (database && databasePath === requestedPath) return database
  if (database) database.close()
  fs.mkdirSync(path.dirname(requestedPath), { recursive: true, mode: 0o700 })
  database = new Database(requestedPath)
  databasePath = requestedPath
  ensureSchema(database)
  try { fs.chmodSync(requestedPath, 0o600) } catch { /* best effort */ }
  return database
}

export function closeUsageFactStore(): void {
  if (database) database.close()
  database = null
  databasePath = ''
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function localDay(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

function normalizedTimestamp(value?: string): { occurredAt: string | null; day: string; hour: number } {
  if (!value) return { occurredAt: null, day: UNKNOWN_TIME, hour: -1 }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return { occurredAt: null, day: UNKNOWN_TIME, hour: -1 }
  return { occurredAt: value, day: localDay(date), hour: date.getHours() }
}

function projectPath(session: SessionSummary): string {
  return session.cwds.find((cwd) => cwd.trim()) || session.projectPath?.trim() || UNKNOWN_PROJECT
}

function rootSessionId(session: SessionSummary): string {
  return session.branchParentId || session.sessionId
}

function resolveRootSessionId(
  session: SessionSummary,
  sessionsByIdentity: Map<string, SessionSummary>
): string {
  let current = session
  const visited = new Set<string>()
  while (current.branchParentId && !visited.has(current.branchParentId)) {
    visited.add(current.branchParentId)
    const parent = sessionsByIdentity.get(current.branchParentId)
    if (!parent) return current.branchParentId
    current = parent
  }
  return current.sessionId
}

function agentScope(scope: UsageEvent['scope']): UsageFact['agentScope'] {
  if (scope === 'main') return 'main'
  if (scope === 'sidechain' || scope === 'subagent') return 'subagent'
  return 'unknown'
}

export function usageFactsForSession(
  session: SessionSummary,
  options: { rootSessionId?: string } = {}
): UsageFact[] {
  const accounting = accountingForSession(session)
  const source = session.source || accounting.provider || 'claude-code'
  const project = projectPath(session)
  const rootId = options.rootSessionId || rootSessionId(session)
  return accounting.usageEvents.map((event) => {
    const time = normalizedTimestamp(event.timestamp)
    const rawModel = event.modelRaw || event.model || null
    const canonicalModel = event.modelCanonical || event.model || null
    const eventId = stableHash([source, session.sessionId, event.dedupKey])
    const valuation = valueUsageEvent(event)
    return {
      eventId,
      occurredAt: time.occurredAt,
      occurredDay: time.day,
      occurredHour: time.hour < 0 ? null : time.hour,
      sourceClient: source,
      sessionId: session.sessionId,
      rootSessionId: rootId,
      agentScope: agentScope(event.scope),
      projectPath: project,
      model: canonicalModel,
      modelRaw: rawModel,
      modelProvenance: event.modelProvenance || (event.model ? 'response' : 'unknown'),
      nonCachedInputTokens: event.components.nonCachedInputTokens,
      cacheReadTokens: event.components.cacheReadTokens,
      cacheWriteTokens: totalCacheWriteTokens(event.components),
      outputTokens: event.components.outputTokens,
      reasoningTokens: event.components.reasoningTokens || 0,
      usageProvenance: event.provenance,
      callCount: 1,
      turnCount: event.scope === 'main' ? 1 : 0,
      costUsd: valuation.usd ?? null,
      pricingProvenance: valuation.mode,
      pricedTokens: valuation.coveredTokens,
      billableTokens: valuation.totalBillableTokens
    }
  })
}

function foldersBySession(folders: Folder[]): Map<string, string[]> {
  const result = new Map<string, string[]>()
  for (const folder of folders) {
    for (const sessionId of folder.sessionIds) {
      const values = result.get(sessionId) || []
      if (!values.includes(folder.id)) values.push(folder.id)
      result.set(sessionId, values)
    }
  }
  for (const values of result.values()) values.sort()
  return result
}

function insertFact(db: Database.Database, fact: UsageFact): void {
  db.prepare(`
    INSERT INTO usage_facts(
      event_id, occurred_at, occurred_day, occurred_hour, source_client,
      session_id, root_session_id, agent_scope, project_path, model_key,
      model_raw, model_provenance, non_cached_input, cache_read, cache_write,
      output_tokens, reasoning_tokens, usage_provenance, call_count, turn_count,
      cost_usd, pricing_provenance, priced_tokens, billable_tokens
    ) VALUES (
      @eventId, @occurredAt, @occurredDay, @occurredHour, @sourceClient,
      @sessionId, @rootSessionId, @agentScope, @projectPath, @model,
      @modelRaw, @modelProvenance, @nonCachedInputTokens, @cacheReadTokens,
      @cacheWriteTokens, @outputTokens, @reasoningTokens, @usageProvenance,
      @callCount, @turnCount, @costUsd, @pricingProvenance,
      @pricedTokens, @billableTokens
    )
  `).run({
    ...fact,
    occurredHour: fact.occurredHour ?? -1,
    model: fact.model || UNKNOWN_MODEL,
    modelRaw: fact.modelRaw || '',
    costUsd: fact.costUsd ?? null,
    pricingProvenance: fact.pricingProvenance ?? null
  })
}

function rebuildSessionRollup(db: Database.Database, sessionId: string): void {
  db.prepare('DELETE FROM usage_rollups WHERE session_id = ?').run(sessionId)
  db.prepare(`
    INSERT INTO usage_rollups(
      occurred_day, occurred_hour, source_client, model_key, project_path, session_id,
      billing_non_cached_input, billing_cache_read, billing_cache_write,
      billing_output, billing_reasoning,
      conversation_non_cached_input, conversation_cache_read, conversation_cache_write,
      conversation_output, conversation_reasoning,
      billing_priced_tokens, billing_billable_tokens, billing_cost_usd,
      conversation_priced_tokens, conversation_billable_tokens, conversation_cost_usd,
      calls, conversation_calls, modeled_calls, conversation_modeled_calls,
      first_occurred_at, last_occurred_at
    )
    SELECT
      occurred_day, occurred_hour, source_client, model_key, project_path, session_id,
      SUM(non_cached_input), SUM(cache_read), SUM(cache_write), SUM(output_tokens), SUM(reasoning_tokens),
      SUM(CASE WHEN agent_scope = 'main' THEN non_cached_input ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' THEN cache_read ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' THEN cache_write ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' THEN output_tokens ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' THEN reasoning_tokens ELSE 0 END),
      SUM(priced_tokens), SUM(billable_tokens), SUM(COALESCE(cost_usd, 0)),
      SUM(CASE WHEN agent_scope = 'main' THEN priced_tokens ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' THEN billable_tokens ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' THEN COALESCE(cost_usd, 0) ELSE 0 END),
      SUM(call_count),
      SUM(CASE WHEN agent_scope = 'main' THEN turn_count ELSE 0 END),
      SUM(CASE WHEN model_key <> '${UNKNOWN_MODEL}' THEN call_count ELSE 0 END),
      SUM(CASE WHEN agent_scope = 'main' AND model_key <> '${UNKNOWN_MODEL}' THEN call_count ELSE 0 END),
      MIN(occurred_at), MAX(occurred_at)
    FROM usage_facts
    WHERE session_id = ?
    GROUP BY occurred_day, occurred_hour, source_client, model_key, project_path, session_id
  `).run(sessionId)
}

export function synchronizeUsageFacts(
  sessions: SessionSummary[],
  folders: Folder[],
  options: { rebuild?: boolean } = {}
): UsageFactSyncResult {
  const db = getDatabase()
  const rollupSessions = sessions.filter((session) =>
    !session.branchLeafUuid && session.tokenAccounting?.excludedFromRollups !== true
  )
  const uniqueSessions = new Map(rollupSessions.map((session) => [session.sessionId, session]))
  const sessionsByIdentity = new Map<string, SessionSummary>()
  for (const session of rollupSessions) {
    sessionsByIdentity.set(session.id, session)
    sessionsByIdentity.set(session.sessionId, session)
  }
  const folderMap = foldersBySession(folders)
  let changedSessions = 0
  let unchangedSessions = 0
  let removedSessions = 0

  const sync = db.transaction(() => {
    db.prepare('DELETE FROM usage_folders').run()
    const insertFolderName = db.prepare('INSERT INTO usage_folders(folder_id, name) VALUES (?, ?)')
    for (const folder of folders) insertFolderName.run(folder.id, folder.name)

    if (options.rebuild) {
      db.exec('DELETE FROM usage_rollups; DELETE FROM usage_session_folders; DELETE FROM usage_facts; DELETE FROM usage_sessions;')
    }
    const existingRows = db.prepare(
      'SELECT session_id, fact_signature, folder_signature FROM usage_sessions'
    ).all() as Array<{ session_id: string; fact_signature: string; folder_signature: string }>
    const existing = new Map(existingRows.map((row) => [row.session_id, row]))

    for (const [sessionId, session] of uniqueSessions) {
      const accounting = accountingForSession(session)
      const parsed = providerCanParseTranscript(session.source || 'claude-code')
      const usageAvailable = parsed && accounting.billingTotal !== null
      const resolvedRoot = resolveRootSessionId(session, sessionsByIdentity)
      const facts = parsed ? usageFactsForSession(session, { rootSessionId: resolvedRoot }) : []
      const folderIds = folderMap.get(sessionId) || []
      const factSignature = stableHash({
        source: session.source || 'claude-code',
        project: projectPath(session),
        root: resolvedRoot,
        turns: session.turnCount,
        parsed,
        available: usageAvailable,
        facts
      })
      const folderSignature = stableHash(folderIds)
      const prior = existing.get(sessionId)
      const factChanged = !prior || prior.fact_signature !== factSignature
      const folderChanged = !prior || prior.folder_signature !== folderSignature
      if (factChanged) changedSessions++
      else unchangedSessions++

      db.prepare(`
        INSERT INTO usage_sessions(
          session_id, root_session_id, source_client, project_path, turn_count,
          usage_available, fact_signature, folder_signature, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          root_session_id = excluded.root_session_id,
          source_client = excluded.source_client,
          project_path = excluded.project_path,
          turn_count = excluded.turn_count,
          usage_available = excluded.usage_available,
          fact_signature = excluded.fact_signature,
          folder_signature = excluded.folder_signature,
          updated_at = excluded.updated_at
      `).run(
        sessionId,
        resolvedRoot,
        session.source || 'claude-code',
        projectPath(session),
        session.turnCount,
        usageAvailable ? 1 : 0,
        factSignature,
        folderSignature,
        session.updatedAt || ''
      )

      if (factChanged) {
        db.prepare('DELETE FROM usage_facts WHERE session_id = ?').run(sessionId)
        for (const fact of facts) insertFact(db, fact)
        rebuildSessionRollup(db, sessionId)
      }
      if (folderChanged) {
        db.prepare('DELETE FROM usage_session_folders WHERE session_id = ?').run(sessionId)
        const insertFolder = db.prepare(
          'INSERT INTO usage_session_folders(session_id, folder_id) VALUES (?, ?)'
        )
        for (const folderId of folderIds) insertFolder.run(sessionId, folderId)
      }
    }

    for (const row of existingRows) {
      if (uniqueSessions.has(row.session_id)) continue
      db.prepare('DELETE FROM usage_sessions WHERE session_id = ?').run(row.session_id)
      removedSessions++
    }
    db.prepare(`
      UPDATE usage_schema_meta SET last_indexed_at = ? WHERE singleton = 1
    `).run(new Date().toISOString())
  })
  sync()

  const factCount = (db.prepare('SELECT count(*) AS count FROM usage_facts').get() as { count: number }).count
  return { changedSessions, unchangedSessions, removedSessions, factCount, rebuilt: options.rebuild === true }
}

function isAnalysisPreset(value: unknown): value is AnalysisScope['range'] {
  return value === 'today' || value === '7d' || value === '30d' || value === '90d' || value === 'all'
}

export function normalizeAnalysisScope(scope: AnalysisScope): AnalysisScope {
  if (!scope || typeof scope !== 'object') throw new Error('AnalysisScope 必须是对象')
  if (!isAnalysisPreset(scope.range) && (!scope.range || typeof scope.range !== 'object')) {
    throw new Error('AnalysisScope.range 无效')
  }
  if (scope.metricBasis !== 'billing' && scope.metricBasis !== 'conversation') {
    throw new Error('AnalysisScope.metricBasis 必须是 billing 或 conversation')
  }
  if (scope.sources && !Array.isArray(scope.sources)) throw new Error('AnalysisScope.sources 必须是数组')
  if (scope.models && !Array.isArray(scope.models)) throw new Error('AnalysisScope.models 必须是数组')
  if (scope.projectOrFolder &&
    (scope.projectOrFolder.kind !== 'project' && scope.projectOrFolder.kind !== 'folder')) {
    throw new Error('AnalysisScope.projectOrFolder.kind 无效')
  }
  return {
    range: typeof scope.range === 'string'
      ? scope.range
      : { from: scope.range.from, to: scope.range.to },
    ...(scope.sources?.length ? { sources: [...new Set(scope.sources)] } : {}),
    ...(scope.models?.length ? { models: [...new Set(scope.models)] } : {}),
    ...(scope.projectOrFolder ? { projectOrFolder: { ...scope.projectOrFolder } } : {}),
    metricBasis: scope.metricBasis
  }
}

function dayFromInput(value: string, field: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error(`${field} 不是有效日期`)
  return localDay(date)
}

function shiftDay(day: string, offset: number): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  const fromMs = new Date(`${from}T00:00:00Z`).getTime()
  const toMs = new Date(`${to}T00:00:00Z`).getTime()
  return Math.floor((toMs - fromMs) / 86_400_000) + 1
}

export function resolveAnalysisRange(scope: AnalysisScope, now = new Date()): ResolvedAnalysisRange {
  if (scope.range === 'all') return { fromDay: null, toDay: null, label: 'All time' }
  const today = localDay(now)
  if (scope.range === 'today') return { fromDay: today, toDay: today, label: today }
  if (scope.range === '7d' || scope.range === '30d' || scope.range === '90d') {
    const days = Number(scope.range.slice(0, -1))
    return { fromDay: shiftDay(today, -(days - 1)), toDay: today, label: scope.range }
  }
  const fromDay = scope.range.from ? dayFromInput(scope.range.from, 'range.from') : null
  const toDay = scope.range.to ? dayFromInput(scope.range.to, 'range.to') : null
  if (fromDay && toDay && fromDay > toDay) throw new Error('range.from 不能晚于 range.to')
  return {
    fromDay,
    toDay,
    label: fromDay || toDay ? `${fromDay || '…'} – ${toDay || '…'}` : 'All time'
  }
}

function previousRange(range: ResolvedAnalysisRange): ResolvedAnalysisRange | null {
  if (!range.fromDay || !range.toDay) return null
  const duration = daysBetween(range.fromDay, range.toDay)
  const toDay = shiftDay(range.fromDay, -1)
  const fromDay = shiftDay(toDay, -(duration - 1))
  return { fromDay, toDay, label: `${fromDay} – ${toDay}` }
}

interface SqlFilter {
  joins: string[]
  where: string[]
  params: Array<string | number>
}

function rollupFilter(scope: AnalysisScope, range: ResolvedAnalysisRange, dimension: AnalysisDimension): SqlFilter {
  const joins: string[] = []
  const where = ['1 = 1']
  const params: Array<string | number> = []
  const needsFolder = dimension === 'folder' || scope.projectOrFolder?.kind === 'folder'
  if (needsFolder) joins.push('JOIN usage_session_folders folders ON folders.session_id = r.session_id')
  if (range.fromDay) { where.push("r.occurred_day <> 'unknown-time' AND r.occurred_day >= ?"); params.push(range.fromDay) }
  if (range.toDay) { where.push("r.occurred_day <> 'unknown-time' AND r.occurred_day <= ?"); params.push(range.toDay) }
  if (scope.sources?.length) {
    where.push(`r.source_client IN (${scope.sources.map(() => '?').join(', ')})`)
    params.push(...scope.sources)
  }
  if (scope.models?.length) {
    where.push(`r.model_key IN (${scope.models.map(() => '?').join(', ')})`)
    params.push(...scope.models)
  }
  if (scope.projectOrFolder?.kind === 'project') {
    where.push('r.project_path = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (scope.projectOrFolder?.kind === 'folder') {
    where.push('folders.folder_id = ?')
    params.push(scope.projectOrFolder.key)
  }
  return { joins, where, params }
}

function dimensionKey(dimension: AnalysisDimension): string {
  switch (dimension) {
    case 'global': return "'global'"
    case 'time': return 'r.occurred_day'
    case 'hour': return "CASE WHEN r.occurred_hour < 0 THEN 'unknown-time' ELSE printf('%02d:00', r.occurred_hour) END"
    case 'source': return 'r.source_client'
    case 'model': return 'r.model_key'
    case 'project': return 'r.project_path'
    case 'folder': return 'folders.folder_id'
    case 'session': return 'r.session_id'
  }
}

function coverage(covered: number, total: number): CoverageMetric {
  return { covered, total, percent: total > 0 ? (covered / total) * 100 : null }
}

interface SessionInventoryRow {
  source_client: string
  usage_available: number
}

function sessionInventory(rows: SessionInventoryRow[]): {
  detected: number
  parsed: number
  usageAvailable: number
  usageUnavailable: number
} {
  let parsed = 0
  let usageAvailable = 0
  for (const row of rows) {
    const canParse = providerCanParseTranscript(row.source_client)
    if (canParse) parsed++
    if (canParse && row.usage_available === 1) usageAvailable++
  }
  return {
    detected: rows.length,
    parsed,
    usageAvailable,
    usageUnavailable: rows.length - usageAvailable
  }
}

function rowToAggregate(row: UsageRollupRow, basis: MetricBasis): UsageAggregate {
  const billingTokens = row.billing_non_cached_input + row.billing_cache_read +
    row.billing_cache_write + row.billing_output
  const conversationTokens = row.conversation_non_cached_input + row.conversation_cache_read +
    row.conversation_cache_write + row.conversation_output
  const selectedConversation = basis === 'conversation'
  const eventCount = selectedConversation ? row.conversation_calls : row.calls
  const pricedTokens = selectedConversation ? row.conversation_priced_tokens : row.billing_priced_tokens
  const billableTokens = selectedConversation ? row.conversation_billable_tokens : row.billing_billable_tokens
  const costUsd = selectedConversation ? row.conversation_cost_usd : row.billing_cost_usd
  const modeledCalls = selectedConversation ? row.conversation_modeled_calls : row.modeled_calls
  return {
    key: row.key,
    label: row.key,
    nonCachedInputTokens: selectedConversation ? row.conversation_non_cached_input : row.billing_non_cached_input,
    cacheReadTokens: selectedConversation ? row.conversation_cache_read : row.billing_cache_read,
    cacheWriteTokens: selectedConversation ? row.conversation_cache_write : row.billing_cache_write,
    outputTokens: selectedConversation ? row.conversation_output : row.billing_output,
    reasoningTokens: selectedConversation ? row.conversation_reasoning : row.billing_reasoning,
    processedTokens: selectedConversation ? conversationTokens : billingTokens,
    billingTokens,
    conversationTokens,
    calls: row.calls,
    turns: row.conversation_calls,
    eventCount,
    sessionCount: row.session_count,
    detectedSessionCount: row.detected_session_count,
    parsedSessionCount: row.parsed_session_count,
    usageAvailableSessionCount: row.usage_available_session_count,
    usageUnavailableSessionCount: row.usage_unavailable_session_count,
    usageCoverage: coverage(row.session_count, row.session_count),
    modelCoverage: coverage(modeledCalls, selectedConversation ? row.conversation_calls : row.calls),
    pricingCoverage: { ...coverage(pricedTokens, billableTokens), status: 'available' },
    costUsd: pricedTokens > 0 || costUsd !== 0 ? costUsd : null,
    unknownTimeEvents: row.unknown_time_events
  }
}

function aggregateRows(
  db: Database.Database,
  scope: AnalysisScope,
  range: ResolvedAnalysisRange,
  dimension: AnalysisDimension
): UsageAggregate[] {
  const filter = rollupFilter(scope, range, dimension)
  const key = dimensionKey(dimension)
  const rows = db.prepare(`
    SELECT
      ${key} AS key,
      COALESCE(SUM(r.billing_non_cached_input), 0) AS billing_non_cached_input,
      COALESCE(SUM(r.billing_cache_read), 0) AS billing_cache_read,
      COALESCE(SUM(r.billing_cache_write), 0) AS billing_cache_write,
      COALESCE(SUM(r.billing_output), 0) AS billing_output,
      COALESCE(SUM(r.billing_reasoning), 0) AS billing_reasoning,
      COALESCE(SUM(r.conversation_non_cached_input), 0) AS conversation_non_cached_input,
      COALESCE(SUM(r.conversation_cache_read), 0) AS conversation_cache_read,
      COALESCE(SUM(r.conversation_cache_write), 0) AS conversation_cache_write,
      COALESCE(SUM(r.conversation_output), 0) AS conversation_output,
      COALESCE(SUM(r.conversation_reasoning), 0) AS conversation_reasoning,
      COALESCE(SUM(r.billing_priced_tokens), 0) AS billing_priced_tokens,
      COALESCE(SUM(r.billing_billable_tokens), 0) AS billing_billable_tokens,
      COALESCE(SUM(r.billing_cost_usd), 0) AS billing_cost_usd,
      COALESCE(SUM(r.conversation_priced_tokens), 0) AS conversation_priced_tokens,
      COALESCE(SUM(r.conversation_billable_tokens), 0) AS conversation_billable_tokens,
      COALESCE(SUM(r.conversation_cost_usd), 0) AS conversation_cost_usd,
      COALESCE(SUM(r.calls), 0) AS calls,
      COALESCE(SUM(r.conversation_calls), 0) AS conversation_calls,
      COALESCE(SUM(r.modeled_calls), 0) AS modeled_calls,
      COALESCE(SUM(r.conversation_modeled_calls), 0) AS conversation_modeled_calls,
      COUNT(DISTINCT r.session_id) AS session_count,
      COUNT(DISTINCT r.session_id) AS detected_session_count,
      COUNT(DISTINCT r.session_id) AS parsed_session_count,
      COUNT(DISTINCT r.session_id) AS usage_available_session_count,
      0 AS usage_unavailable_session_count,
      COALESCE(SUM(CASE WHEN r.occurred_day = '${UNKNOWN_TIME}' THEN r.calls ELSE 0 END), 0) AS unknown_time_events
    FROM usage_rollups r
    ${filter.joins.join('\n')}
    WHERE ${filter.where.join(' AND ')}
    GROUP BY ${key}
  `).all(...filter.params) as UsageRollupRow[]
  const result = rows.map((row) => rowToAggregate(row, scope.metricBasis))
  if (dimension === 'folder' && result.length > 0) {
    const labels = new Map((db.prepare(
      'SELECT folder_id, name FROM usage_folders'
    ).all() as Array<{ folder_id: string; name: string }>).map((row) => [row.folder_id, row.name]))
    for (const item of result) item.label = labels.get(item.key) || item.key
  }
  if (dimension === 'time' || dimension === 'hour') {
    result.sort((left, right) => {
      if (left.key === UNKNOWN_TIME) return 1
      if (right.key === UNKNOWN_TIME) return -1
      return left.key.localeCompare(right.key)
    })
  } else result.sort((left, right) => right.processedTokens - left.processedTokens)
  return result
}

function emptyAggregate(basis: MetricBasis): UsageAggregate {
  return rowToAggregate({
    key: 'global',
    billing_non_cached_input: 0,
    billing_cache_read: 0,
    billing_cache_write: 0,
    billing_output: 0,
    billing_reasoning: 0,
    conversation_non_cached_input: 0,
    conversation_cache_read: 0,
    conversation_cache_write: 0,
    conversation_output: 0,
    conversation_reasoning: 0,
    billing_priced_tokens: 0,
    billing_billable_tokens: 0,
    billing_cost_usd: 0,
    conversation_priced_tokens: 0,
    conversation_billable_tokens: 0,
    conversation_cost_usd: 0,
    calls: 0,
    conversation_calls: 0,
    modeled_calls: 0,
    conversation_modeled_calls: 0,
    session_count: 0,
    detected_session_count: 0,
    parsed_session_count: 0,
    usage_available_session_count: 0,
    usage_unavailable_session_count: 0,
    unknown_time_events: 0
  }, basis)
}

function unknownTimeEvents(db: Database.Database, scope: AnalysisScope): number {
  const allRange = { fromDay: null, toDay: null, label: 'All time' }
  const filter = rollupFilter(scope, allRange, 'global')
  filter.where.push(`r.occurred_day = '${UNKNOWN_TIME}'`)
  return (db.prepare(`
    SELECT COALESCE(SUM(r.calls), 0) AS count
    FROM usage_rollups r ${filter.joins.join('\n')}
    WHERE ${filter.where.join(' AND ')}
  `).get(...filter.params) as { count: number }).count
}

function applyGlobalUsageCoverage(
  db: Database.Database,
  scope: AnalysisScope,
  range: ResolvedAnalysisRange,
  total: UsageAggregate
): void {
  if (range.fromDay || range.toDay || scope.models?.length) return
  const joins: string[] = []
  const where = ['1 = 1']
  const params: string[] = []
  if (scope.projectOrFolder?.kind === 'folder') {
    joins.push('JOIN usage_session_folders folders ON folders.session_id = sessions.session_id')
    where.push('folders.folder_id = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (scope.projectOrFolder?.kind === 'project') {
    where.push('sessions.project_path = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (scope.sources?.length) {
    where.push(`sessions.source_client IN (${scope.sources.map(() => '?').join(', ')})`)
    params.push(...scope.sources)
  }
  const inventory = sessionInventory(db.prepare(`
    SELECT DISTINCT sessions.session_id, sessions.source_client, sessions.usage_available
    FROM usage_sessions sessions ${joins.join('\n')}
    WHERE ${where.join(' AND ')}
  `).all(...params) as SessionInventoryRow[])
  total.sessionCount = inventory.detected
  total.detectedSessionCount = inventory.detected
  total.parsedSessionCount = inventory.parsed
  total.usageAvailableSessionCount = inventory.usageAvailable
  total.usageUnavailableSessionCount = inventory.usageUnavailable
  total.usageCoverage = coverage(inventory.usageAvailable, inventory.detected)
}

function applyItemUsageCoverage(
  db: Database.Database,
  scope: AnalysisScope,
  range: ResolvedAnalysisRange,
  dimension: AnalysisDimension,
  items: UsageAggregate[]
): void {
  // Sessions without facts cannot be placed on a time/model axis. On an
  // all-time categorical axis, their source/project/folder is still known and
  // must remain in the denominator so a partial source is not shown as 100%.
  if (range.fromDay || range.toDay || scope.models?.length) return
  const keySql: Partial<Record<AnalysisDimension, string>> = {
    global: "'global'",
    source: 'sessions.source_client',
    project: 'sessions.project_path',
    folder: 'folders.folder_id',
    session: 'sessions.session_id'
  }
  const key = keySql[dimension]
  if (!key) return
  const joins: string[] = []
  const where = ['1 = 1']
  const params: string[] = []
  const needsFolder = dimension === 'folder' || scope.projectOrFolder?.kind === 'folder'
  if (needsFolder) joins.push('JOIN usage_session_folders folders ON folders.session_id = sessions.session_id')
  if (scope.projectOrFolder?.kind === 'folder') {
    where.push('folders.folder_id = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (scope.projectOrFolder?.kind === 'project') {
    where.push('sessions.project_path = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (scope.sources?.length) {
    where.push(`sessions.source_client IN (${scope.sources.map(() => '?').join(', ')})`)
    params.push(...scope.sources)
  }
  const rows = db.prepare(`
    SELECT
      ${key} AS key,
      sessions.session_id,
      sessions.source_client,
      sessions.usage_available
    FROM usage_sessions sessions ${joins.join('\n')}
    WHERE ${where.join(' AND ')}
  `).all(...params) as Array<{
    key: string
    session_id: string
    source_client: string
    usage_available: number
  }>
  const rowsByKey = new Map<string, Map<string, SessionInventoryRow>>()
  for (const row of rows) {
    const values = rowsByKey.get(row.key) || new Map<string, SessionInventoryRow>()
    values.set(row.session_id, {
      source_client: row.source_client,
      usage_available: row.usage_available
    })
    rowsByKey.set(row.key, values)
  }
  const byKey = new Map([...rowsByKey].map(([keyValue, values]) => [
    keyValue,
    sessionInventory([...values.values()])
  ]))
  const folderLabels = dimension === 'folder'
    ? new Map((db.prepare('SELECT folder_id, name FROM usage_folders').all() as Array<{
        folder_id: string
        name: string
      }>).map((row) => [row.folder_id, row.name]))
    : new Map<string, string>()
  const existingKeys = new Set(items.map((item) => item.key))
  for (const row of byKey.keys()) {
    if (existingKeys.has(row)) continue
    const item = emptyAggregate(scope.metricBasis)
    item.key = row
    item.label = folderLabels.get(row) || row
    items.push(item)
  }
  for (const item of items) {
    const value = byKey.get(item.key)
    if (!value) continue
    item.sessionCount = value.detected
    item.detectedSessionCount = value.detected
    item.parsedSessionCount = value.parsed
    item.usageAvailableSessionCount = value.usageAvailable
    item.usageUnavailableSessionCount = value.usageUnavailable
    item.usageCoverage = coverage(value.usageAvailable, value.detected)
  }
}

function queryWithoutPrevious(
  db: Database.Database,
  scope: AnalysisScope,
  dimension: AnalysisDimension,
  range: ResolvedAnalysisRange
): { items: UsageAggregate[]; total: UsageAggregate } {
  const items = aggregateRows(db, scope, range, dimension)
  const total = aggregateRows(db, scope, range, 'global')[0] || emptyAggregate(scope.metricBasis)
  total.label = 'All'
  applyGlobalUsageCoverage(db, scope, range, total)
  applyItemUsageCoverage(db, scope, range, dimension, items)
  return { items, total }
}

export function queryInsights(
  rawScope: AnalysisScope,
  dimension: AnalysisDimension,
  options: { now?: Date } = {}
): InsightsQueryResult {
  const allowed: AnalysisDimension[] = ['global', 'time', 'hour', 'source', 'model', 'project', 'folder', 'session']
  if (!allowed.includes(dimension)) throw new Error(`不支持的洞察维度: ${dimension}`)
  const scope = normalizeAnalysisScope(rawScope)
  const range = resolveAnalysisRange(scope, options.now)
  const db = getDatabase()
  const { items, total } = queryWithoutPrevious(db, scope, dimension, range)
  const priorRange = previousRange(range)
  let previousPeriod: PreviousPeriodComparison | null = null
  if (priorRange) {
    const previousTotal = queryWithoutPrevious(db, scope, 'global', priorRange).total
    const absoluteChange = total.processedTokens - previousTotal.processedTokens
    previousPeriod = {
      range: priorRange,
      processedTokens: previousTotal.processedTokens,
      absoluteChange,
      percentChange: previousTotal.processedTokens > 0
        ? (absoluteChange / previousTotal.processedTokens) * 100
        : null
    }
  }
  const meta = db.prepare(
    'SELECT last_indexed_at FROM usage_schema_meta WHERE singleton = 1'
  ).get() as { last_indexed_at: string | null }
  return {
    schemaVersion: USAGE_FACT_SCHEMA_VERSION,
    scope,
    dimension,
    range,
    items,
    total,
    previousPeriod,
    quality: { unknownTimeEvents: unknownTimeEvents(db, scope), lastIndexedAt: meta.last_indexed_at }
  }
}

function dimensionConstraint(dimension: AnalysisDimension, key: string): { sql: string; value?: string | number } {
  switch (dimension) {
    case 'global': return { sql: '1 = 1' }
    case 'time': return { sql: 'r.occurred_day = ?', value: key }
    case 'hour': return key === UNKNOWN_TIME
      ? { sql: 'r.occurred_hour < 0' }
      : { sql: 'r.occurred_hour = ?', value: Number(key.slice(0, 2)) }
    case 'source': return { sql: 'r.source_client = ?', value: key }
    case 'model': return { sql: 'r.model_key = ?', value: key }
    case 'project': return { sql: 'r.project_path = ?', value: key }
    case 'folder': return { sql: 'folders.folder_id = ?', value: key }
    case 'session': return { sql: 'r.session_id = ?', value: key }
  }
}

export function drilldownInsights(
  rawScope: AnalysisScope,
  dimension: AnalysisDimension,
  key: string,
  options: { now?: Date } = {}
): InsightsDrilldownSession[] {
  const scope = normalizeAnalysisScope(rawScope)
  const range = resolveAnalysisRange(scope, options.now)
  const db = getDatabase()
  const filter = rollupFilter(scope, range, dimension)
  const constraint = dimensionConstraint(dimension, key)
  filter.where.push(constraint.sql)
  if (constraint.value !== undefined) filter.params.push(constraint.value)
  const selectedPrefix = scope.metricBasis === 'conversation' ? 'conversation' : 'billing'
  const rows = db.prepare(`
    SELECT
      r.session_id,
      sessions.root_session_id,
      sessions.source_client,
      sessions.project_path,
      GROUP_CONCAT(DISTINCT CASE WHEN r.model_key <> '${UNKNOWN_MODEL}' THEN r.model_key END) AS models,
      SUM(r.billing_non_cached_input + r.billing_cache_read + r.billing_cache_write + r.billing_output) AS billing_tokens,
      SUM(r.conversation_non_cached_input + r.conversation_cache_read + r.conversation_cache_write + r.conversation_output) AS conversation_tokens,
      SUM(r.${selectedPrefix}_non_cached_input + r.${selectedPrefix}_cache_read + r.${selectedPrefix}_cache_write + r.${selectedPrefix}_output) AS processed_tokens,
      SUM(r.calls) AS calls,
      SUM(r.conversation_calls) AS turns,
      MIN(r.first_occurred_at) AS first_occurred_at,
      MAX(r.last_occurred_at) AS last_occurred_at
    FROM usage_rollups r
    JOIN usage_sessions sessions ON sessions.session_id = r.session_id
    ${filter.joins.join('\n')}
    WHERE ${filter.where.join(' AND ')}
    GROUP BY r.session_id
    ORDER BY processed_tokens DESC
  `).all(...filter.params) as Array<{
    session_id: string
    root_session_id: string
    source_client: string
    project_path: string
    models: string | null
    billing_tokens: number
    conversation_tokens: number
    processed_tokens: number
    calls: number
    turns: number
    first_occurred_at: string | null
    last_occurred_at: string | null
  }>
  const provenance = db.prepare(
    'SELECT DISTINCT usage_provenance FROM usage_facts WHERE session_id = ?'
  )
  return rows.map((row) => ({
    sessionId: row.session_id,
    rootSessionId: row.root_session_id,
    sourceClient: row.source_client,
    projectPath: row.project_path,
    models: row.models ? row.models.split(',').filter(Boolean) : [],
    processedTokens: row.processed_tokens,
    billingTokens: row.billing_tokens,
    conversationTokens: row.conversation_tokens,
    calls: row.calls,
    turns: row.turns,
    firstOccurredAt: row.first_occurred_at,
    lastOccurredAt: row.last_occurred_at,
    usageProvenance: (provenance.all(row.session_id) as Array<{ usage_provenance: string }>)
      .map((item) => item.usage_provenance)
  }))
}

function factFilter(scope: AnalysisScope, range: ResolvedAnalysisRange, sessionId: string): SqlFilter {
  const joins: string[] = []
  const where = ['facts.session_id = ?']
  const params: Array<string | number> = [sessionId]
  if (scope.projectOrFolder?.kind === 'folder') {
    joins.push('JOIN usage_session_folders folders ON folders.session_id = facts.session_id')
    where.push('folders.folder_id = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (scope.projectOrFolder?.kind === 'project') {
    where.push('facts.project_path = ?')
    params.push(scope.projectOrFolder.key)
  }
  if (range.fromDay) { where.push("facts.occurred_day <> 'unknown-time' AND facts.occurred_day >= ?"); params.push(range.fromDay) }
  if (range.toDay) { where.push("facts.occurred_day <> 'unknown-time' AND facts.occurred_day <= ?"); params.push(range.toDay) }
  if (scope.sources?.length) {
    where.push(`facts.source_client IN (${scope.sources.map(() => '?').join(', ')})`)
    params.push(...scope.sources)
  }
  if (scope.models?.length) {
    where.push(`facts.model_key IN (${scope.models.map(() => '?').join(', ')})`)
    params.push(...scope.models)
  }
  if (scope.metricBasis === 'conversation') where.push("facts.agent_scope = 'main'")
  return { joins, where, params }
}

export function sessionUsageEvents(
  sessionId: string,
  rawScope: AnalysisScope,
  options: { now?: Date } = {}
): UsageFact[] {
  const scope = normalizeAnalysisScope(rawScope)
  const range = resolveAnalysisRange(scope, options.now)
  const db = getDatabase()
  const filter = factFilter(scope, range, sessionId)
  const rows = db.prepare(`
    SELECT facts.* FROM usage_facts facts
    ${filter.joins.join('\n')}
    WHERE ${filter.where.join(' AND ')}
    ORDER BY CASE WHEN occurred_at IS NULL THEN 1 ELSE 0 END, occurred_at, event_id
  `).all(...filter.params) as UsageFactRow[]
  return rows.map((row) => ({
    eventId: row.event_id,
    occurredAt: row.occurred_at,
    occurredDay: row.occurred_day,
    occurredHour: row.occurred_hour < 0 ? null : row.occurred_hour,
    sourceClient: row.source_client,
    sessionId: row.session_id,
    rootSessionId: row.root_session_id,
    agentScope: row.agent_scope,
    projectPath: row.project_path,
    model: row.model_key === UNKNOWN_MODEL ? null : row.model_key,
    modelRaw: row.model_raw || null,
    modelProvenance: row.model_provenance,
    nonCachedInputTokens: row.non_cached_input,
    cacheReadTokens: row.cache_read,
    cacheWriteTokens: row.cache_write,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    usageProvenance: row.usage_provenance,
    callCount: row.call_count,
    turnCount: row.turn_count,
    costUsd: row.cost_usd,
    pricingProvenance: row.pricing_provenance,
    pricedTokens: row.priced_tokens,
    billableTokens: row.billable_tokens
  }))
}

export function usageFactStoreStats(): {
  schemaVersion: number
  sessions: number
  facts: number
  rollups: number
  databasePath: string
  lastIndexedAt: string | null
} {
  const db = getDatabase()
  const count = (table: string): number =>
    (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
  const meta = db.prepare(
    'SELECT schema_version, last_indexed_at FROM usage_schema_meta WHERE singleton = 1'
  ).get() as { schema_version: number; last_indexed_at: string | null }
  return {
    schemaVersion: meta.schema_version,
    sessions: count('usage_sessions'),
    facts: count('usage_facts'),
    rollups: count('usage_rollups'),
    databasePath: usageDatabasePath(),
    lastIndexedAt: meta.last_indexed_at
  }
}
