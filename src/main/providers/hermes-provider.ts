import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import {
  PROVIDER_CAPABILITY_NAMES,
  type CanonicalEvent,
  type Diagnostic,
  type JsonValue,
  type ParseChunk,
  type ProviderCapabilities,
  type ProviderManifest,
  type SessionIdentity,
  type UsageRecord
} from '../../shared/provider-schema-v2.generated'
import type { Fingerprint, SourceRef } from '../../shared/provider-schema.generated'
import { stableCanonicalRecordId } from '../../shared/provider-protocol'
import { createBuiltinToolRegistryV2 } from '../../shared/tool-registry-v2'
import {
  buildCanonicalLogicalSessionIdentity,
  logicalSessionKey
} from '../library-session-identity'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'

export const HERMES_PROVIDER_ID = 'swob/hermes'
export const HERMES_JSON_FORMAT = 'hermes-json-snapshot-v1'
export const HERMES_DB_FORMAT = 'hermes-state-db-v1-plus'
export const HERMES_PARSER_DATA_VERSION = '1'

const OFFICIAL_HERMES_COMMIT = '84952e89f922415f47b6e483105e1fcae95ace7f'
const AGENT_SESSIONS_COMMIT = 'e881b78a102942455eb178426cbf51008d732c96'

export type HermesTruthState = 'exact' | 'derived' | 'estimated' | 'unavailable'

export interface HermesTruthCell {
  status: HermesTruthState
  fixture: string
  conformanceTestId: string
  note: string
}

export interface HermesEightLayerTruth {
  discovery: HermesTruthCell
  metadata: HermesTruthCell
  messages: HermesTruthCell
  tools: HermesTruthCell
  systemContext: HermesTruthCell
  usage: HermesTruthCell
  relationships: HermesTruthCell
  resume: HermesTruthCell
}

function truthCell(
  format: 'state-db-current' | 'state-db-legacy' | 'json-snapshot',
  layer: keyof HermesEightLayerTruth,
  status: HermesTruthState,
  fixture: string,
  note: string
): HermesTruthCell {
  return {
    status,
    fixture,
    conformanceTestId: `hermes-${format}-${layer}`,
    note
  }
}

/** Format-scoped truth. Provider-wide UI declarations below are deliberately
 * experimental wherever the two source families differ. */
export const HERMES_EIGHT_LAYER_TRUTH: Readonly<Record<'stateDbCurrent' | 'stateDbLegacy' | 'jsonSnapshot', HermesEightLayerTruth>> = {
  stateDbCurrent: {
    discovery: truthCell('state-db-current', 'discovery', 'exact', 'testdata/hermes/state-db.sql',
      'Each sessions.id row is discovered from the WAL-consistent read snapshot.'),
    metadata: truthCell('state-db-current', 'metadata', 'exact', 'testdata/hermes/state-db.sql',
      'Title, model, cwd and timestamps come from named session columns.'),
    messages: truthCell('state-db-current', 'messages', 'exact', 'testdata/hermes/state-db.sql',
      'Message rows are ordered by timestamp and id inside the same SQLite snapshot.'),
    tools: truthCell('state-db-current', 'tools', 'exact', 'testdata/hermes/state-db.sql',
      'Function calls and linked tool results retain native IDs, arguments and output.'),
    systemContext: truthCell('state-db-current', 'systemContext', 'exact', 'testdata/hermes/state-db.sql',
      'system_prompt and active/compacted flags map to classified preamble and context boundary events.'),
    usage: truthCell('state-db-current', 'usage', 'exact', 'testdata/hermes/state-db.sql',
      'Authoritative session counters and actual_cost_usd are reported; estimates are excluded.'),
    relationships: truthCell('state-db-current', 'relationships', 'exact', 'testdata/hermes/state-db.sql',
      'parent_session_id maps to an exact continuation relationship.'),
    resume: truthCell('state-db-current', 'resume', 'exact', 'testdata/hermes/state-db.sql',
      'A present state.db row binds the native hermes --resume session ID and anchor verification contract.')
  },
  stateDbLegacy: {
    discovery: truthCell('state-db-legacy', 'discovery', 'exact', 'testdata/hermes/state-db-legacy.sql',
      'Legacy sessions.id rows remain discoverable without schema migration.'),
    metadata: truthCell('state-db-legacy', 'metadata', 'exact', 'testdata/hermes/state-db-legacy.sql',
      'Only metadata columns physically present in the legacy schema are emitted.'),
    messages: truthCell('state-db-legacy', 'messages', 'exact', 'testdata/hermes/state-db-legacy.sql',
      'Legacy message text and roles are preserved in deterministic row order.'),
    tools: truthCell('state-db-legacy', 'tools', 'exact', 'testdata/hermes/state-db-legacy.sql',
      'Available legacy function data is parsed; malformed native data is preserved as unknown.'),
    systemContext: truthCell('state-db-legacy', 'systemContext', 'unavailable', 'testdata/hermes/state-db-legacy.sql',
      'The fixture has no system_prompt or active/compacted columns, so no state is inferred.'),
    usage: truthCell('state-db-legacy', 'usage', 'unavailable', 'testdata/hermes/state-db-legacy.sql',
      'The fixture has no authoritative token or cost counters; all usage fields remain null.'),
    relationships: truthCell('state-db-legacy', 'relationships', 'unavailable', 'testdata/hermes/state-db-legacy.sql',
      'The fixture has no parent_session_id and no lineage is guessed.'),
    resume: truthCell('state-db-legacy', 'resume', 'exact', 'testdata/hermes/state-db-legacy.sql',
      'The source remains a real state.db row addressable by hermes --resume.')
  },
  jsonSnapshot: {
    discovery: truthCell('json-snapshot', 'discovery', 'exact', 'testdata/hermes/session_legacy-only.json',
      'session_*.json files and their session_id are discovered exactly.'),
    metadata: truthCell('json-snapshot', 'metadata', 'exact', 'testdata/hermes/session_legacy-only.json',
      'Session ID, model and source timestamps come from explicit JSON fields.'),
    messages: truthCell('json-snapshot', 'messages', 'exact', 'testdata/hermes/session_legacy-only.json',
      'Ordered JSON message roles and content are preserved.'),
    tools: truthCell('json-snapshot', 'tools', 'exact', 'testdata/hermes/session_legacy-only.json',
      'Function calls and results retain native call IDs, arguments and output.'),
    systemContext: truthCell('json-snapshot', 'systemContext', 'derived', 'testdata/hermes/session_legacy-only.json',
      'system_prompt is exact, while its provider-preamble presentation classification is derived.'),
    usage: truthCell('json-snapshot', 'usage', 'unavailable', 'testdata/hermes/session_legacy-only.json',
      'Legacy JSON has no authoritative usage or cost fields; no counters are fabricated.'),
    relationships: truthCell('json-snapshot', 'relationships', 'unavailable', 'testdata/hermes/session_legacy-only.json',
      'Legacy JSON has no parent lineage field and no relationship is guessed.'),
    resume: truthCell('json-snapshot', 'resume', 'unavailable', 'testdata/hermes/session_legacy-only.json',
      'Current Hermes resumes state.db sessions; legacy JSON is a read-only snapshot.')
  }
}

export interface HermesProviderOptions {
  homeDir: string
  sessionRoots?: string[]
  stateDbPath?: string
}

type DbRow = Record<string, unknown>

interface HermesDbSnapshot {
  schemaVersion: number | null
  session: DbRow
  messages: DbRow[]
}

interface HermesJsonSnapshot extends DbRow {
  session_id?: unknown
  messages?: unknown
}

function isObject(value: unknown): value is DbRow {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonValue)
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') }
  if (!isObject(value)) return String(value)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (Buffer.isBuffer(value)) return { encoding: 'base64', data: value.toString('base64') }
  if (!isObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableSessionComponent(sessionId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,430}$/.test(sessionId)
    ? sessionId
    : `sha256-${sha256(sessionId)}`
}

function pendingFingerprint(): Fingerprint {
  return { algorithm: 'sha256', value: 'pending' }
}

function canonicalSessionRecordId(sourceRefStableId: string, sessionId: string): string {
  return stableCanonicalRecordId({
    providerId: HERMES_PROVIDER_ID,
    sourceRefStableId,
    recordType: 'session',
    sourceRecordId: sessionId
  })
}

function signalCheck(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('cancelled')
}

function sqlitePath(source: SourceRef): string {
  if (source.kind !== 'sqlite-row') throw new Error('hermes-db-source-required')
  return fileURLToPath(source.databaseUri)
}

function jsonPath(source: SourceRef): string {
  if (source.kind !== 'file') throw new Error('hermes-json-source-required')
  return fileURLToPath(source.uri)
}

function sourceSessionId(source: SourceRef): string {
  if (source.kind === 'sqlite-row') {
    const id = source.primaryKey.id
    if (typeof id !== 'string' || !id) throw new Error('hermes-db-session-id-missing')
    return id
  }
  throw new Error('hermes-db-source-required')
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
  ).get(table))
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  if (!tableExists(db, table)) return new Set()
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name))
}

function schemaVersion(db: Database.Database): number | null {
  if (!tableExists(db, 'schema_version')) return null
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version?: unknown } | undefined
  return typeof row?.version === 'number' && Number.isSafeInteger(row.version) ? row.version : null
}

/** better-sqlite3 opens the database read-only, and BEGIN pins one SQLite read
 * snapshot across the main database plus committed WAL frames. Copying only
 * state.db would violate that guarantee. */
function readDbSnapshot(databasePath: string, sessionId: string, signal: AbortSignal): HermesDbSnapshot {
  signalCheck(signal)
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5_000 })
  let begun = false
  try {
    db.exec('BEGIN')
    begun = true
    const sessionColumns = tableColumns(db, 'sessions')
    const messageColumns = tableColumns(db, 'messages')
    if (!sessionColumns.has('id') || !messageColumns.has('session_id')) {
      throw new Error('hermes-state-db-schema-unsupported')
    }
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as DbRow | undefined
    if (!session) throw new Error('hermes-state-db-session-missing')
    const order = messageColumns.has('timestamp') && messageColumns.has('id')
      ? 'timestamp ASC, id ASC'
      : messageColumns.has('id') ? 'id ASC' : 'rowid ASC'
    const messages = db.prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY ${order}`).all(sessionId) as DbRow[]
    signalCheck(signal)
    return { schemaVersion: schemaVersion(db), session, messages }
  } finally {
    if (begun) {
      try { db.exec('ROLLBACK') } catch { /* read-only snapshot is already closing */ }
    }
    db.close()
  }
}

function snapshotFingerprint(snapshot: HermesDbSnapshot): Fingerprint {
  return { algorithm: 'sha256', value: sha256(canonicalJson(snapshot)) }
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1_000
    const date = new Date(milliseconds)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  if (typeof value === 'string' && value && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  return null
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value
  try { return JSON.parse(trimmed) } catch { return value }
}

function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) {
    const object = isObject(value) ? value : null
    return object && typeof object.text === 'string' ? object.text : null
  }
  const parts = value.flatMap((entry): string[] => {
    if (typeof entry === 'string') return [entry]
    if (!isObject(entry)) return []
    if (typeof entry.text === 'string') return [entry.text]
    if (typeof entry.content === 'string') return [entry.content]
    return []
  })
  return parts.length ? parts.join('\n') : null
}

function identity(source: SourceRef, sessionId: string, parentSessionId: string | null): SessionIdentity {
  const logical = buildCanonicalLogicalSessionIdentity(HERMES_PROVIDER_ID, source.stableId, sessionId)
  return {
    physicalSourceId: source.stableId,
    logicalSessionKey: logicalSessionKey(logical),
    logicalSessionId: sessionId,
    branchViewId: `${HERMES_PROVIDER_ID}:${sessionId}:default`,
    parentBranchViewId: parentSessionId ? `${HERMES_PROVIDER_ID}:${parentSessionId}:default` : null
  }
}

function timeline(sequence: number, row?: DbRow): CanonicalEvent['timeline'] {
  const active = row && typeof row.active === 'number' ? row.active !== 0 : null
  const compacted = row && typeof row.compacted === 'number' ? row.compacted !== 0 : null
  const state = compacted === true || active === false
    ? 'archived'
    : active === true ? 'visible-to-model' : 'unknown'
  return {
    archived: true,
    modelContext: [{ contextRevision: 0, state, fromSequence: sequence, untilSequence: null }]
  }
}

function eventId(source: SourceRef, sourceRecordId: string, suffix: string): string {
  return `hermes:${sha256(`${source.stableId}\0${sourceRecordId}\0${suffix}`).slice(0, 32)}`
}

function event(input: {
  source: SourceRef
  formatVersion: string
  identity: SessionIdentity
  sourceRecordId: string
  raw: unknown
  suffix: string
  sequence: number
  messageId: string | null
  blockIndex?: number | null
  timestamp: string | null
  actor: CanonicalEvent['actor']
  kind: CanonicalEvent['kind']
  payload: JsonValue
  visibility?: CanonicalEvent['visibility']
  classification?: CanonicalEvent['classification']
  timelineRow?: DbRow
}): CanonicalEvent {
  const id = eventId(input.source, input.sourceRecordId, input.suffix)
  return {
    id,
    identity: input.identity,
    sharedEventKey: `shared:${id}`,
    messageId: input.messageId,
    sequence: input.sequence,
    messageBlockIndex: input.blockIndex ?? null,
    timestamp: input.timestamp,
    actor: input.actor,
    kind: input.kind,
    payload: input.payload,
    visibility: input.visibility || 'primary',
    classification: input.classification || 'unknown',
    timeline: timeline(input.sequence, input.timelineRow),
    provenance: {
      providerId: HERMES_PROVIDER_ID,
      sourceRefId: input.source.stableId,
      parserDataVersion: HERMES_PARSER_DATA_VERSION,
      formatVersion: input.formatVersion,
      observedAt: new Date().toISOString(),
      sourceRecordId: input.sourceRecordId,
      rawRecordFingerprint: { algorithm: 'sha256', value: sha256(canonicalJson(input.raw)) }
    },
    rawRef: null
  }
}

function classification(role: string): CanonicalEvent['classification'] {
  if (role === 'user' || role === 'assistant' || role === 'tool') return 'user-content'
  if (role === 'system') return 'promoted-system'
  return 'unknown'
}

function actor(role: string): CanonicalEvent['actor'] {
  return ['user', 'assistant', 'system', 'tool'].includes(role)
    ? role as CanonicalEvent['actor']
    : 'unknown'
}

function unavailableUsage(sessionId: string, model: string | null, scope: string): UsageRecord {
  return {
    eventId: null,
    turnId: null,
    modelId: model,
    input: { total: null, uncached: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null },
    output: { total: null, visible: null, reasoning: null },
    providerTotal: null,
    aggregation: 'cumulative',
    relations: { cacheRead: 'provider-defined', cacheWrite: 'provider-defined', reasoning: 'provider-defined' },
    dedupKey: `hermes:${sessionId}:${scope}:unavailable`,
    billingFactKey: `hermes:${sessionId}:${scope}:unavailable`,
    measurement: { source: 'unavailable', confidence: 'unavailable', sourceField: null },
    cost: null,
    priceRevision: null
  }
}

function usageForSession(session: DbRow, sessionId: string): UsageRecord | null {
  const fields = [
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'reasoning_tokens', 'api_call_count'
  ]
  const model = nonEmpty(session.model)
  if (!fields.some((field) => Object.hasOwn(session, field))) {
    return model ? unavailableUsage(sessionId, model, 'state-db') : null
  }
  const input = nonNegativeInteger(session.input_tokens)
  const output = nonNegativeInteger(session.output_tokens)
  const cacheRead = nonNegativeInteger(session.cache_read_tokens)
  const cacheWrite = nonNegativeInteger(session.cache_write_tokens)
  const reasoning = nonNegativeInteger(session.reasoning_tokens)
  const apiCalls = nonNegativeInteger(session.api_call_count)
  const hasReportedTokens = [input, output, cacheRead, cacheWrite, reasoning].some((value) => (value || 0) > 0)
  const exactZero = !hasReportedTokens && apiCalls === 0 &&
    [input, output, cacheRead, cacheWrite, reasoning].every((value) => value === 0)
  const unavailable = !hasReportedTokens && !exactZero
  const actualCost = nonNegativeNumber(session.actual_cost_usd)
  return {
    eventId: null,
    turnId: null,
    modelId: model,
    input: {
      total: unavailable ? null : (input || 0) + (cacheRead || 0) + (cacheWrite || 0),
      uncached: unavailable ? null : input || 0,
      cacheRead: unavailable ? null : cacheRead || 0,
      cacheWrite5m: unavailable ? null : cacheWrite || 0,
      cacheWrite1h: null
    },
    output: {
      total: unavailable ? null : output || 0,
      visible: unavailable ? null : Math.max(0, (output || 0) - (reasoning || 0)),
      reasoning: unavailable ? null : reasoning || 0
    },
    providerTotal: unavailable
      ? null
      : (input || 0) + (cacheRead || 0) + (cacheWrite || 0) + (output || 0),
    aggregation: 'cumulative',
    relations: {
      cacheRead: 'independent',
      cacheWrite: 'independent',
      reasoning: 'subset-of-output'
    },
    dedupKey: `hermes:${sessionId}:session-aggregate`,
    billingFactKey: `hermes:${sessionId}:session-aggregate`,
    measurement: unavailable
      ? { source: 'unavailable', confidence: 'unavailable', sourceField: null }
      : {
          source: 'reported',
          confidence: 'exact',
          sourceField: 'sessions.input_tokens/output_tokens/cache_read_tokens/cache_write_tokens/reasoning_tokens'
        },
    cost: unavailable || actualCost === null ? null : { amount: actualCost, currency: 'USD', kind: 'reported' },
    priceRevision: null
  }
}

function emitMessages(input: {
  source: SourceRef
  formatVersion: string
  sessionIdentity: SessionIdentity
  rows: DbRow[]
  initialSequence: number
  diagnostics: Diagnostic[]
}): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  const registry = createBuiltinToolRegistryV2()
  const emit = (value: Omit<Parameters<typeof event>[0], 'sequence'>): void => {
    events.push(event({ ...value, sequence: input.initialSequence + events.length }))
  }

  input.rows.forEach((row, index) => {
    const sourceRecordId = nonEmpty(row.id) || String(row.id ?? `message:${index}`)
    const messageId = `hermes-message:${sourceRecordId}`
    const role = nonEmpty(row.role) || 'unknown'
    const at = timestamp(row.timestamp)
    const displayKind = nonEmpty(row.display_kind)
    const hidden = typeof row.active === 'number' && row.active === 0 && row.compacted !== 1
    const common = {
      source: input.source,
      formatVersion: input.formatVersion,
      identity: input.sessionIdentity,
      sourceRecordId,
      raw: row,
      messageId,
      timestamp: at,
      timelineRow: row
    }

    if (displayKind) {
      const metadata = parseJsonValue(row.display_metadata)
      const meta = isObject(metadata) ? metadata : {}
      const model = nonEmpty(meta.model) || nonEmpty(meta.to_model) || nonEmpty(meta.toModelId)
      if (displayKind === 'model_switch' && model) {
        emit({ ...common, suffix: 'model-switch', actor: 'system', kind: 'model.changed',
          payload: { fromModelId: null, toModelId: model }, visibility: 'collapsed', classification: 'lifecycle' })
      } else {
        emit({ ...common, suffix: 'display-kind', actor: 'system', kind: 'session.lifecycle',
          payload: { phase: `hermes:${displayKind}` }, visibility: 'hidden-noise', classification: 'lifecycle' })
      }
      return
    }

    const reasoning = nonEmpty(row.reasoning_content) || nonEmpty(row.reasoning)
    if (reasoning) {
      emit({ ...common, suffix: 'reasoning', actor: actor(role), kind: 'message.reasoning',
        payload: { text: reasoning }, visibility: hidden ? 'hidden-noise' : 'collapsed', classification: classification(role) })
    }

    const text = contentText(parseJsonValue(row.content))
    if (text !== null && role !== 'tool') {
      emit({ ...common, suffix: 'text', actor: actor(role), kind: 'message.text',
        payload: { text }, visibility: hidden ? 'hidden-noise' : role === 'system' ? 'collapsed' : 'primary',
        classification: classification(role) })
    }

    const rawCalls = parseJsonValue(row.tool_calls)
    if (rawCalls !== null && rawCalls !== undefined && rawCalls !== '') {
      if (!Array.isArray(rawCalls)) {
        const unknownId = eventId(input.source, sourceRecordId, 'malformed-tool-calls')
        input.diagnostics.push({
          level: 'warning', code: 'hermes-tool-calls-malformed',
          message: 'Hermes tool_calls was not an array and was preserved as unknown data.', eventId: unknownId
        })
        emit({ ...common, suffix: 'malformed-tool-calls', actor: actor(role), kind: 'unknown',
          payload: { rawType: 'hermes.tool_calls', rawPayload: jsonValue(rawCalls) }, visibility: 'collapsed' })
      } else {
        rawCalls.forEach((rawCall, callIndex) => {
          if (!isObject(rawCall)) return
          const fn = isObject(rawCall.function) ? rawCall.function : rawCall
          const rawName = nonEmpty(fn.name) || nonEmpty(row.tool_name) || 'unknown-tool'
          const callId = nonEmpty(rawCall.id) || `hermes-call:${sourceRecordId}:${callIndex}`
          const resolved = registry.resolve({
            providerId: HERMES_PROVIDER_ID,
            formatVersion: input.formatVersion,
            rawName,
            callId,
            input: jsonValue(parseJsonValue(fn.arguments ?? rawCall.arguments ?? {}))
          })
          emit({ ...common, suffix: `tool-call:${callIndex}`, actor: 'assistant', kind: 'tool.call',
            payload: { callId, rawName, semanticToolId: resolved.semanticToolId, input: resolved.normalizedInput },
            visibility: hidden ? 'hidden-noise' : 'primary', classification: 'user-content' })
        })
      }
    }

    if (role === 'tool') {
      const callId = nonEmpty(row.tool_call_id) || `hermes-orphan:${sourceRecordId}`
      emit({ ...common, suffix: 'tool-result', actor: 'tool', kind: 'tool.result',
        payload: {
          callId,
          output: jsonValue(parseJsonValue(row.content ?? '')),
          isError: row.effect_disposition === 'error' ? true : null,
          state: row.effect_disposition === 'error' ? 'error' : nonEmpty(row.tool_call_id) ? 'complete' : 'orphan'
        }, visibility: hidden ? 'hidden-noise' : 'primary', classification: 'user-content' })
    }

    const details = parseJsonValue(row.reasoning_details)
    if (details && !reasoning) {
      emit({ ...common, suffix: 'reasoning-details', actor: actor(role), kind: 'unknown',
        payload: { rawType: 'hermes.reasoning_details', rawPayload: jsonValue(details) }, visibility: 'collapsed' })
    }
  })
  return events
}

function chunks(source: SourceRef, formatVersion: string, sessionIdentity: SessionIdentity,
  fingerprint: Fingerprint, events: CanonicalEvent[], diagnostics: Diagnostic[]): ParseChunk[] {
  const result: ParseChunk[] = []
  const maxEvents = 2_000
  const count = Math.max(1, Math.ceil(events.length / maxEvents))
  for (let index = 0; index < count; index++) {
    const slice = events.slice(index * maxEvents, (index + 1) * maxEvents)
    const done = index === count - 1
    const cursor = done ? null : `${index}:${slice.at(-1)?.sequence ?? -1}`
    result.push({
      providerId: HERMES_PROVIDER_ID,
      parserDataVersion: HERMES_PARSER_DATA_VERSION,
      formatVersion,
      fingerprint,
      identity: sessionIdentity,
      mode: 'initial',
      chunkIndex: index,
      previousCursor: index === 0 ? null : result[index - 1].cursor,
      cursor,
      done,
      events: slice,
      diagnostics: index === 0 ? diagnostics.slice(0, 2_048) : []
    })
  }
  return result
}

function eventsForDb(source: SourceRef, snapshot: HermesDbSnapshot, fingerprint: Fingerprint): ParseChunk[] {
  const sessionId = String(snapshot.session.id)
  const parentId = nonEmpty(snapshot.session.parent_session_id)
  const sessionIdentity = identity(source, sessionId, parentId)
  const diagnostics: Diagnostic[] = [{
    level: 'info', code: 'hermes-state-db-schema-version',
    message: `Hermes state.db schema version: ${snapshot.schemaVersion ?? 'unknown'}.`, eventId: null
  }]
  if (nonNegativeNumber(snapshot.session.estimated_cost_usd) !== null &&
    nonNegativeNumber(snapshot.session.actual_cost_usd) === null) {
    diagnostics.push({
      level: 'info', code: 'hermes-estimated-cost-not-imported',
      message: 'Hermes estimated cost was not imported as an exact billing fact.', eventId: null
    })
  }
  const events: CanonicalEvent[] = []
  const title = nonEmpty(snapshot.session.title) || nonEmpty(snapshot.session.display_name)
  const cwd = nonEmpty(snapshot.session.cwd) || nonEmpty(snapshot.session.git_repo_root)
  for (const [suffix, phase] of [
    ['metadata-title', title ? `metadata.title:${title}` : null],
    ['metadata-cwd', cwd ? `metadata.cwd:${cwd}` : null]
  ] as const) {
    if (!phase) continue
    events.push(event({
      source, formatVersion: HERMES_DB_FORMAT, identity: sessionIdentity,
      sourceRecordId: `session:${sessionId}`, raw: snapshot.session, suffix, sequence: events.length,
      messageId: null, timestamp: timestamp(snapshot.session.started_at), actor: 'system',
      kind: 'session.lifecycle', payload: { phase }, visibility: 'hidden-noise', classification: 'lifecycle'
    }))
  }
  const systemPrompt = nonEmpty(snapshot.session.system_prompt)
  if (systemPrompt) {
    events.push(event({
      source, formatVersion: HERMES_DB_FORMAT, identity: sessionIdentity,
      sourceRecordId: `session:${sessionId}`, raw: snapshot.session, suffix: 'system-preamble', sequence: events.length,
      messageId: `hermes-system:${sessionId}`, timestamp: timestamp(snapshot.session.started_at), actor: 'system',
      kind: 'message.text', payload: { text: systemPrompt }, visibility: 'collapsed', classification: 'promoted-system'
    }))
  }
  if (parentId) {
    events.push(event({
      source, formatVersion: HERMES_DB_FORMAT, identity: sessionIdentity,
      sourceRecordId: `session:${sessionId}`, raw: snapshot.session, suffix: 'parent', sequence: events.length,
      messageId: null, timestamp: timestamp(snapshot.session.started_at), actor: 'system', kind: 'session.lifecycle',
      payload: {
        relationshipType: 'continuation',
        fromSessionRecordId: canonicalSessionRecordId(
          `hermes:db:${stableSessionComponent(parentId)}`,
          parentId
        ),
        toSessionRecordId: canonicalSessionRecordId(source.stableId, sessionId)
      }, visibility: 'collapsed', classification: 'lifecycle'
    }))
  }
  const messageEvents = emitMessages({
    source, formatVersion: HERMES_DB_FORMAT, sessionIdentity, rows: snapshot.messages,
    initialSequence: events.length, diagnostics
  })
  const compactedRecordIds = new Set(snapshot.messages
    .filter((row) => row.compacted === 1)
    .map((row, index) => nonEmpty(row.id) || String(row.id ?? `message:${index}`)))
  const archivedThroughSequence = messageEvents
    .filter((entry) => compactedRecordIds.has(entry.provenance.sourceRecordId))
    .reduce((maximum, entry) => Math.max(maximum, entry.sequence), -1)
  if (archivedThroughSequence >= 0) {
    const archivedEvents = messageEvents.filter((entry) => entry.sequence <= archivedThroughSequence)
    const activeEvents = messageEvents
      .filter((entry) => entry.sequence > archivedThroughSequence)
      .map((entry) => ({ ...entry, sequence: entry.sequence + 1 }))
    events.push(...archivedEvents)
    const compactedAt = snapshot.messages
      .filter((row) => row.compacted === 1)
      .flatMap((row) => timestamp(row.timestamp) ? [timestamp(row.timestamp)!] : [])
      .sort()
      .at(-1)
    events.push(event({
      source, formatVersion: HERMES_DB_FORMAT, identity: sessionIdentity,
      sourceRecordId: `session:${sessionId}`, raw: snapshot.session, suffix: 'context-compaction',
      sequence: events.length, messageId: null,
      timestamp: compactedAt || timestamp(snapshot.session.started_at),
      actor: 'system', kind: 'context.compaction', payload: {
        contextRevision: 0,
        archivedThroughSequence,
        summaryEventId: null
      }, visibility: 'collapsed', classification: 'lifecycle'
    }))
    events.push(...activeEvents)
  } else {
    events.push(...messageEvents)
  }
  const usage = usageForSession(snapshot.session, sessionId)
  if (usage) {
    events.push(event({
      source, formatVersion: HERMES_DB_FORMAT, identity: sessionIdentity,
      sourceRecordId: `session:${sessionId}`, raw: snapshot.session, suffix: 'usage', sequence: events.length,
      messageId: null, timestamp: timestamp(snapshot.session.ended_at) || timestamp(snapshot.session.started_at),
      actor: 'system', kind: 'usage', payload: usage as unknown as JsonValue,
      visibility: 'collapsed', classification: 'lifecycle'
    }))
  }
  return chunks(source, HERMES_DB_FORMAT, sessionIdentity, fingerprint, events, diagnostics)
}

function eventsForJson(source: SourceRef, snapshot: HermesJsonSnapshot, fingerprint: Fingerprint): ParseChunk[] {
  const sessionId = nonEmpty(snapshot.session_id) ||
    path.basename(jsonPath(source), path.extname(jsonPath(source))).replace(/^session_/, '')
  const sessionIdentity = identity(source, sessionId, null)
  const diagnostics: Diagnostic[] = [
    { level: 'info', code: 'hermes-json-usage-unavailable',
      message: 'Legacy Hermes JSON snapshots do not contain authoritative provider usage.', eventId: null },
    { level: 'info', code: 'hermes-json-resume-unavailable',
      message: 'Current Hermes resumes state.db sessions; legacy JSON snapshots are read-only imports.', eventId: null }
  ]
  const events: CanonicalEvent[] = []
  const systemPrompt = nonEmpty(snapshot.system_prompt)
  if (systemPrompt) {
    events.push(event({
      source, formatVersion: HERMES_JSON_FORMAT, identity: sessionIdentity,
      sourceRecordId: `session:${sessionId}`, raw: snapshot, suffix: 'system-preamble', sequence: 0,
      messageId: `hermes-system:${sessionId}`, timestamp: timestamp(snapshot.session_start), actor: 'system',
      kind: 'message.text', payload: { text: systemPrompt }, visibility: 'collapsed', classification: 'promoted-system'
    }))
  }
  const rows = Array.isArray(snapshot.messages)
    ? snapshot.messages.filter(isObject).map((row, index) => ({ ...row, id: row.id ?? `json:${index}` }))
    : []
  events.push(...emitMessages({
    source, formatVersion: HERMES_JSON_FORMAT, sessionIdentity, rows,
    initialSequence: events.length, diagnostics
  }))
  events.push(event({
    source, formatVersion: HERMES_JSON_FORMAT, identity: sessionIdentity,
    sourceRecordId: `session:${sessionId}`, raw: snapshot, suffix: 'usage-unavailable', sequence: events.length,
    messageId: null, timestamp: timestamp(snapshot.last_updated) || timestamp(snapshot.session_start),
    actor: 'system', kind: 'usage',
    payload: unavailableUsage(sessionId, nonEmpty(snapshot.model), 'json-snapshot') as unknown as JsonValue,
    visibility: 'collapsed', classification: 'lifecycle'
  }))
  return chunks(source, HERMES_JSON_FORMAT, sessionIdentity, fingerprint, events, diagnostics)
}

function capabilityEvidence(name: string) {
  return [{
    kind: 'test' as const,
    fixture: 'testdata/hermes',
    conformanceTestId: `hermes-${name}`,
    locator: 'src/main/providers/hermes-provider.test.ts',
    note: `Official Hermes ${OFFICIAL_HERMES_COMMIT}; Agent Sessions ${AGENT_SESSIONS_COMMIT}.`
  }]
}

function capabilities(): ProviderCapabilities {
  const available = new Set(['discover', 'summary', 'transcript', 'tools', 'thinking', 'identity', 'chunked-transport', 'format-provenance'])
  const experimental: Record<string, string> = {
    usage: 'Exact for authoritative state.db counters; unavailable for legacy JSON or sessions without upstream usage.',
    relationships: 'Exact parent_session_id in state.db; unavailable in legacy JSON snapshots.',
    'context-timeline': 'Exact active/compacted state in current DB schemas; unknown in older DB/JSON layouts.',
    'terminal-resume': 'Exact hermes --resume for state.db sessions; legacy JSON snapshots are not resumable.'
  }
  const reasons: Record<string, string> = {
    subagents: 'Hermes parent lineage is not sufficient proof of a spawned subagent.',
    interactions: 'No stable historical interaction request schema is present in both source formats.',
    permissions: 'No stable historical permission request schema is present in both source formats.',
    'native-resume': 'Hermes exposes a CLI resume surface, not a native application deep link.'
  }
  return Object.fromEntries(PROVIDER_CAPABILITY_NAMES.map((name) => [name, {
    status: available.has(name) ? 'available'
      : experimental[name] ? 'experimental'
        : name === 'native-resume' ? 'not-applicable' : 'unavailable',
    reason: available.has(name) ? null : experimental[name] || reasons[name] || 'Not represented by Hermes sources.',
    evidence: capabilityEvidence(name)
  }]))
}

export const HERMES_PROVIDER_MANIFEST: ProviderManifest = {
  schemaVersion: 2,
  providerId: HERMES_PROVIDER_ID,
  displayName: 'Hermes',
  implementationVersion: 'builtin-hermes-v1',
  parserDataVersion: HERMES_PARSER_DATA_VERSION,
  formatVersions: [HERMES_DB_FORMAT, HERMES_JSON_FORMAT],
  capabilities: capabilities(),
  resumeContract: {
    mode: 'native-cli',
    supportedSurfaces: ['terminal'],
    supportsSubagent: false,
    idTransform: null,
    preflight: ['binary', 'version', 'help-capability', 'source-exists'],
    commandTemplate: 'hermes --resume {sessionId}',
    expectedSideEffects: ['loads-state-db-session', 'may-append-to-source'],
    postcondition: 'anchor-match'
  }
}

function readJsonSnapshot(filePath: string, signal: AbortSignal): { bytes: Buffer; value: HermesJsonSnapshot } {
  signalCheck(signal)
  const bytes = fs.readFileSync(filePath)
  signalCheck(signal)
  const value = JSON.parse(bytes.toString('utf8')) as unknown
  if (!isObject(value)) throw new Error('hermes-json-snapshot-malformed')
  return { bytes, value }
}

function discoverJsonFiles(roots: string[], signal: AbortSignal): string[] {
  const files: string[] = []
  for (const root of roots) {
    signalCheck(signal)
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (entry.isFile() && /^session_.+\.json$/i.test(entry.name)) files.push(path.join(root, entry.name))
    }
  }
  return files.sort()
}

export function createHermesProvider(options: HermesProviderOptions): BuiltinProviderRuntimeV2 {
  const roots = options.sessionRoots || [path.join(options.homeDir, '.hermes', 'sessions')]
  const stateDbPath = options.stateDbPath || path.join(options.homeDir, '.hermes', 'state.db')
  return {
    manifest: structuredClone(HERMES_PROVIDER_MANIFEST),

    async discover(signal): Promise<SourceRef[]> {
      signalCheck(signal)
      const sources: SourceRef[] = []
      const dbSessionIds = new Set<string>()
      if (fs.existsSync(stateDbPath)) {
        const db = new Database(stateDbPath, { readonly: true, fileMustExist: true, timeout: 5_000 })
        let begun = false
        try {
          db.exec('BEGIN')
          begun = true
          if (tableColumns(db, 'sessions').has('id')) {
            for (const row of db.prepare('SELECT id FROM sessions ORDER BY id').all() as Array<{ id: unknown }>) {
              signalCheck(signal)
              if (typeof row.id !== 'string' || !row.id) continue
              dbSessionIds.add(row.id)
              sources.push({
                kind: 'sqlite-row', stableId: `hermes:db:${stableSessionComponent(row.id)}`, providerId: HERMES_PROVIDER_ID,
                databaseUri: pathToFileURL(stateDbPath).href, table: 'sessions', primaryKey: { id: row.id },
                displayLocator: `${stateDbPath}#${row.id}`, fingerprint: pendingFingerprint()
              })
            }
          }
        } finally {
          if (begun) { try { db.exec('ROLLBACK') } catch { /* closing */ } }
          db.close()
        }
      }
      const discoveredJsonIds = new Set<string>()
      for (const filePath of discoverJsonFiles(roots, signal)) {
        let sessionId = path.basename(filePath, path.extname(filePath)).replace(/^session_/, '')
        try {
          const parsed = readJsonSnapshot(filePath, signal).value
          sessionId = nonEmpty(parsed.session_id) || sessionId
        } catch { /* malformed snapshots remain discoverable and fail closed during parse */ }
        if (dbSessionIds.has(sessionId)) continue
        const stableId = `hermes:json:${stableSessionComponent(sessionId)}`
        if (discoveredJsonIds.has(stableId)) continue
        discoveredJsonIds.add(stableId)
        sources.push({
          kind: 'file', stableId, providerId: HERMES_PROVIDER_ID,
          uri: pathToFileURL(filePath).href, displayLocator: filePath, fingerprint: pendingFingerprint()
        })
      }
      return sources
    },

    async fingerprint(source, signal): Promise<Fingerprint> {
      if (source.kind === 'sqlite-row') {
        return snapshotFingerprint(readDbSnapshot(sqlitePath(source), sourceSessionId(source), signal))
      }
      const { bytes } = readJsonSnapshot(jsonPath(source), signal)
      return { algorithm: 'sha256', value: sha256(bytes) }
    },

    async inputBytes(source, signal): Promise<number> {
      if (source.kind === 'sqlite-row') {
        return Buffer.byteLength(canonicalJson(
          readDbSnapshot(sqlitePath(source), sourceSessionId(source), signal)
        ))
      }
      signalCheck(signal)
      return fs.statSync(jsonPath(source)).size
    },

    async parse(source, fingerprint, signal): Promise<ParseChunk[]> {
      if (fingerprint.algorithm !== 'sha256') throw new Error('hermes-fingerprint-algorithm-unsupported')
      if (source.kind === 'sqlite-row') {
        const snapshot = readDbSnapshot(sqlitePath(source), sourceSessionId(source), signal)
        if (snapshotFingerprint(snapshot).value !== fingerprint.value) {
          throw new Error('hermes-source-changed-during-parse')
        }
        return eventsForDb(source, snapshot, fingerprint)
      }
      const snapshot = readJsonSnapshot(jsonPath(source), signal)
      if (sha256(snapshot.bytes) !== fingerprint.value) throw new Error('hermes-source-changed-during-parse')
      return eventsForJson(source, snapshot.value, fingerprint)
    }
  }
}
