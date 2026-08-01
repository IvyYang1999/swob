import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { builtinProviderForSource } from '../../shared/provider-capabilities'
import type {
  Fingerprint,
  SourceRef
} from '../../shared/provider-schema.generated'
import {
  PROVIDER_CAPABILITY_NAMES,
  PROVIDER_RESOURCE_LIMITS,
  type CanonicalEvent,
  type CapabilityDeclaration,
  type CapabilityEvidence,
  type CapabilityName,
  type Diagnostic,
  type JsonValue,
  type ParseChunk,
  type ProviderCapabilities,
  type ProviderManifest,
  type SessionIdentity
} from '../../shared/provider-schema-v2.generated'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'

const TRAE_PROVIDER_ID = 'swob/trae'
const TRAE_STORAGE_KEY = 'memento/icube-ai-agent-storage'
const TRAE_FORMAT_LEGACY = 'trae-state-vscdb-legacy-v1'
const TRAE_FIXTURE = 'testdata/trae/legacy-state-vscdb.json'
const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'utf8')
// Leave room for the envelope, identity, diagnostics, and JSON escaping.
const TRAE_CHUNK_EVENT_BYTES = Math.floor(PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes / 2)

export const TRAE_CAPABILITY_MATRIX = [
  { layer: 'discover', measurement: 'exact', capability: 'experimental' },
  { layer: 'metadata', measurement: 'exact', capability: 'experimental' },
  { layer: 'messages', measurement: 'exact', capability: 'experimental' },
  { layer: 'tools', measurement: 'unavailable', capability: 'unavailable' },
  { layer: 'system+compact', measurement: 'unavailable', capability: 'unavailable' },
  { layer: 'token', measurement: 'unavailable', capability: 'unavailable' },
  { layer: 'relationships', measurement: 'unavailable', capability: 'unavailable' },
  { layer: 'resume', measurement: 'unavailable', capability: 'unavailable' }
] as const

interface TraeProviderOptions {
  homeDir: string
  roots?: string[]
}

interface TraeStoredMessage {
  id?: unknown
  role?: unknown
  content?: unknown
  agentTaskContent?: unknown
  timestamp?: unknown
  model?: unknown
  turnIndex?: unknown
}

interface TraeStoredSession {
  sessionId?: unknown
  title?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  model?: unknown
  messages?: unknown
}

interface TraeSessionRecord {
  databasePath: string
  sessionId: string
  session: TraeStoredSession
  raw: string
  updatedAtMs: number
}

interface TraeWorkspaceMetadata {
  title: string | null
  cwd: string[]
  projectPath: string | null
  raw: string
}

interface TraeSourceSnapshot {
  record: TraeSessionRecord
  workspace: TraeWorkspaceMetadata
  fingerprint: Fingerprint
}

type TraeSqliteSource = Extract<SourceRef, { kind: 'sqlite-row' }>

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function opaqueHash(value: unknown): string {
  return sha256(JSON.stringify(value) ?? String(value))
}

function jsonValue(value: unknown, depth = 0): JsonValue {
  if (depth >= 24) {
    return { omitted: true, reason: 'provider-json-depth-limit', sha256: opaqueHash(value) }
  }
  if (typeof value === 'string' && value.length > 128 * 1024) {
    return {
      omitted: true,
      reason: 'provider-json-string-limit',
      codeUnits: value.length,
      sha256: sha256(value)
    }
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) {
    if (value.length > 512) {
      return {
        omitted: true,
        reason: 'provider-json-array-limit',
        itemCount: value.length,
        sha256: opaqueHash(value)
      }
    }
    return value.map((entry) => jsonValue(entry, depth + 1))
  }
  const object = asObject(value)
  if (!object) return String(value)
  const serialized = JSON.stringify(object)
  if (serialized.length > 128 * 1024 || Object.keys(object).length > 128) {
    return {
      omitted: true,
      reason: 'provider-json-object-limit',
      bytes: Buffer.byteLength(serialized, 'utf8'),
      sha256: sha256(serialized)
    }
  }
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, jsonValue(child, depth + 1)]))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) {
    const milliseconds = Math.abs(value) < 1e11 ? value * 1_000 : value
    const date = new Date(milliseconds)
    return Number.isFinite(date.getTime()) ? date.toISOString() : null
  }
  if (typeof value === 'string' && value && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString()
  }
  return null
}

function timestampMs(value: unknown): number {
  const timestamp = normalizeTimestamp(value)
  return timestamp ? Date.parse(timestamp) : 0
}

function signalCheckpoint(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('cancelled')
}

function evidence(
  capability: CapabilityName,
  kind: CapabilityEvidence['kind'],
  note: string
): CapabilityEvidence {
  return {
    kind,
    fixture: TRAE_FIXTURE,
    conformanceTestId: `PPV2-TRAE-${capability.toUpperCase()}-001`,
    locator: kind === 'upstream-source'
      ? 'https://github.com/kenn-io/agentsview/tree/1cd581fe34e87e134160c6668deffb674b7eaa4e/internal/parser'
      : 'src/main/providers/trae-provider.test.ts',
    note
  }
}

function capability(
  name: CapabilityName,
  status: CapabilityDeclaration['status'],
  reason: string | null,
  note: string
): CapabilityDeclaration {
  return {
    status,
    reason,
    evidence: [evidence(name, status === 'unavailable' || status === 'not-applicable' ? 'missing' : 'test', note)]
  }
}

function traeCapabilitiesV2(): ProviderCapabilities {
  const declarations: Record<CapabilityName, CapabilityDeclaration> = {
    discover: capability('discover', 'experimental', 'Legacy plaintext state.vscdb is supported; modern ModularData is encrypted.', 'Legacy DB discovery and encrypted-layout negative space.'),
    summary: capability('summary', 'experimental', 'Summary is exact only for the evidenced legacy layout.', 'Legacy session metadata projection.'),
    transcript: capability('transcript', 'experimental', 'Current encrypted ModularData cannot be parsed.', 'Ordered legacy message fixture.'),
    tools: capability('tools', 'unavailable', 'No verified Trae plaintext field exposes tool calls or results.', 'No tool fixture or producer schema.'),
    thinking: capability('thinking', 'unavailable', 'No verified Trae plaintext field distinguishes model thinking.', 'No thinking fixture or producer schema.'),
    usage: capability('usage', 'unavailable', 'Trae exposes no authoritative usage counters in the evidenced layout.', 'No zero or character estimate is emitted.'),
    relationships: capability('relationships', 'unavailable', 'No verified parent, fork, or continuation field exists.', 'No relationship fixture.'),
    subagents: capability('subagents', 'unavailable', 'No verified subagent identity field exists.', 'No subagent fixture.'),
    interactions: capability('interactions', 'unavailable', 'No verified historical interaction request schema exists.', 'No interaction fixture.'),
    permissions: capability('permissions', 'unavailable', 'No verified permission request/response schema exists.', 'No permission fixture.'),
    'context-timeline': capability('context-timeline', 'experimental', 'Archived events are exact; model-context membership is unknown.', 'Unknown context membership is explicit.'),
    identity: capability('identity', 'available', null, 'Virtual session IDs are independent of the SQLite container path.'),
    'chunked-transport': capability('chunked-transport', 'available', null, 'Streams are split at the Provider Protocol v2 event limit.'),
    'terminal-resume': capability('terminal-resume', 'unavailable', 'No verified Trae per-session CLI resume command exists.', 'Opening the IDE is not session resume.'),
    'native-resume': capability('native-resume', 'unavailable', 'No verified per-session deep link with a source postcondition exists.', 'Workspace opening is not session resume.'),
    'format-provenance': capability('format-provenance', 'available', null, 'Every event names the legacy state.vscdb format and raw-record hash.')
  }
  return Object.fromEntries(PROVIDER_CAPABILITY_NAMES.map((name) => [name, declarations[name]]))
}

function traeManifestV2(displayName: string, parserDataVersion: string, formatVersions: string[]): ProviderManifest {
  return {
    schemaVersion: 2,
    providerId: TRAE_PROVIDER_ID,
    displayName,
    implementationVersion: 'builtin-native-v2',
    parserDataVersion,
    formatVersions,
    capabilities: traeCapabilitiesV2(),
    resumeContract: null
  }
}

function defaultRoots(homeDir: string): string[] {
  return ['Trae', 'Trae CN', 'TRAE SOLO CN']
    .map((product) => path.join(homeDir, 'Library', 'Application Support', product, 'User'))
}

async function regularFile(filePath: string): Promise<boolean> {
  try { return (await fs.promises.stat(filePath)).isFile() } catch { return false }
}

async function discoverDatabases(root: string, signal: AbortSignal): Promise<string[]> {
  signalCheckpoint(signal)
  const databases: string[] = []
  const workspaceRoot = path.join(root, 'workspaceStorage')
  let entries: fs.Dirent[] = []
  try { entries = await fs.promises.readdir(workspaceRoot, { withFileTypes: true }) } catch { /* missing root */ }
  for (const entry of entries) {
    signalCheckpoint(signal)
    if (!entry.isDirectory()) continue
    const candidate = path.join(workspaceRoot, entry.name, 'state.vscdb')
    if (await regularFile(candidate)) databases.push(candidate)
  }
  const global = path.join(root, 'globalStorage', 'state.vscdb')
  if (await regularFile(global)) databases.push(global)
  return databases.sort()
}

function readTraeStore(databasePath: string): unknown {
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 5_000
  })
  try {
    database.pragma('query_only = ON')
    const read = database.transaction(() => database.prepare(
      'SELECT value FROM ItemTable WHERE key = ? LIMIT 1'
    ).get(TRAE_STORAGE_KEY) as { value?: unknown } | undefined)
    const row = read()
    if (!row || row.value === null || row.value === undefined) return null
    const value = Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value)
    if (Buffer.byteLength(value, 'utf8') > 50 * 1024 * 1024) {
      throw new Error(`trae-storage-row-resource-limit:${databasePath}`)
    }
    try { return JSON.parse(value) } catch {
      throw new Error(`trae-storage-json-malformed:${databasePath}`)
    }
  } finally {
    database.close()
  }
}

function sessionRecords(databasePath: string): TraeSessionRecord[] {
  const store = asObject(readTraeStore(databasePath))
  if (!store) return []
  if (!Array.isArray(store.list)) throw new Error(`trae-storage-list-missing:${databasePath}`)
  return store.list.flatMap((value): TraeSessionRecord[] => {
    const session = asObject(value) as TraeStoredSession | null
    const sessionId = typeof session?.sessionId === 'string' ? session.sessionId.trim() : ''
    if (!session || !sessionId) return []
    return [{
      databasePath,
      sessionId,
      session,
      raw: JSON.stringify(value),
      updatedAtMs: timestampMs(session.updatedAt)
    }]
  })
}

function workspaceMetadata(databasePath: string, session: TraeStoredSession): TraeWorkspaceMetadata {
  const manifestPath = path.join(path.dirname(databasePath), 'workspace.json')
  let raw = ''
  let projectPath: string | null = null
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
    const manifest = asObject(JSON.parse(raw))
    const uri = typeof manifest?.folder === 'string'
      ? manifest.folder
      : typeof manifest?.workspace === 'string'
        ? manifest.workspace
        : null
    if (uri?.startsWith('file:')) projectPath = fileURLToPath(uri)
    else if (uri && path.isAbsolute(uri)) projectPath = uri
  } catch { /* optional workspace metadata */ }
  return {
    title: typeof session.title === 'string' && session.title.trim() ? session.title.trim() : null,
    cwd: projectPath ? [projectPath] : [],
    projectPath,
    raw
  }
}

function fingerprintFor(record: TraeSessionRecord, workspace: TraeWorkspaceMetadata): Fingerprint {
  const hash = createHash('sha256')
  hash.update(TRAE_STORAGE_KEY)
  hash.update('\0')
  hash.update(record.raw)
  const inputs = ['state.vscdb:ItemTable/session']
  if (workspace.raw) {
    hash.update('\0')
    hash.update(workspace.raw)
    inputs.push('workspace.json')
  }
  return {
    algorithm: inputs.length > 1 ? 'composite-sha256' : 'sha256',
    value: hash.digest('hex'),
    ...(inputs.length > 1 ? { inputs } : {})
  }
}

function databasePathFor(source: SourceRef): string {
  if (source.kind !== 'sqlite-row') throw new Error('trae-provider-requires-sqlite-row-source')
  const databasePath = fileURLToPath(source.databaseUri)
  if (!path.isAbsolute(databasePath)) throw new Error('trae-provider-database-path-must-be-absolute')
  return databasePath
}

function sessionIdFor(source: SourceRef): string {
  if (source.kind !== 'sqlite-row') throw new Error('trae-provider-requires-sqlite-row-source')
  const sessionId = source.primaryKey.sessionId
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('trae-provider-session-id-missing')
  return sessionId.trim()
}

function snapshotFor(source: SourceRef): TraeSourceSnapshot {
  const databasePath = databasePathFor(source)
  const sessionId = sessionIdFor(source)
  const record = sessionRecords(databasePath).find((entry) => entry.sessionId === sessionId)
  if (!record) throw new Error(`trae-session-missing:${sessionId}`)
  const workspace = workspaceMetadata(databasePath, record.session)
  return { record, workspace, fingerprint: fingerprintFor(record, workspace) }
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value &&
    JSON.stringify(left.inputs || []) === JSON.stringify(right.inputs || [])
}

function textFragments(value: unknown, depth = 0): string[] {
  if (depth > 16 || value === null || value === undefined) return []
  if (typeof value === 'string') return value.trim() ? [value] : []
  if (Array.isArray(value)) return value.flatMap((entry) => textFragments(entry, depth + 1))
  const object = asObject(value)
  if (!object) return []
  const fragments: string[] = []
  for (const key of ['text', 'content', 'markdown', 'value', 'proposal', 'summary']) {
    if (key in object) fragments.push(...textFragments(object[key], depth + 1))
  }
  for (const key of ['parts', 'bubbles', 'segments', 'items']) {
    if (key in object) fragments.push(...textFragments(object[key], depth + 1))
  }
  return [...new Set(fragments.filter((entry) => entry.trim()))]
}

function agentTaskFragments(value: unknown): string[] {
  const direct = textFragments(value)
  if (direct.length > 0) return direct
  const object = asObject(value)
  const guideline = asObject(object?.guideline)
  return textFragments(guideline?.planItems)
}

function splitText(value: string): string[] {
  const limit = PROVIDER_RESOURCE_LIMITS.maxStringCodeUnits
  if (value.length <= limit) return [value]
  const result: string[] = []
  for (let offset = 0; offset < value.length; offset += limit) result.push(value.slice(offset, offset + limit))
  return result
}

function identityFor(source: SourceRef, sessionId: string): SessionIdentity {
  return {
    physicalSourceId: source.stableId,
    logicalSessionKey: `${TRAE_PROVIDER_ID}\0${sessionId.normalize('NFC')}`,
    logicalSessionId: sessionId,
    branchViewId: `${TRAE_PROVIDER_ID}:${sessionId}:main`,
    parentBranchViewId: null
  }
}

function eventsFor(snapshot: TraeSourceSnapshot, source: SourceRef): {
  identity: SessionIdentity
  events: CanonicalEvent[]
  diagnostics: Diagnostic[]
} {
  const sessionId = snapshot.record.sessionId
  const identity = identityFor(source, sessionId)
  const events: CanonicalEvent[] = []
  const diagnostics: Diagnostic[] = []
  const rawFingerprint = { algorithm: 'sha256' as const, value: sha256(snapshot.record.raw) }
  const observedAt = new Date().toISOString()
  const emit = (input: {
    kind: CanonicalEvent['kind']
    payload: JsonValue
    actor: CanonicalEvent['actor']
    classification: CanonicalEvent['classification']
    messageId: string | null
    messageBlockIndex: number | null
    timestamp: string | null
    sourceRecordId: string
  }): void => {
    const sequence = events.length
    const id = `trae:event:${sha256(`${sessionId}\0${input.sourceRecordId}\0${input.kind}\0${sequence}`)}`
    events.push({
      id,
      identity,
      sharedEventKey: `shared:${id}`,
      messageId: input.messageId,
      sequence,
      messageBlockIndex: input.messageBlockIndex,
      timestamp: input.timestamp,
      actor: input.actor,
      kind: input.kind,
      payload: input.payload,
      visibility: 'primary',
      classification: input.classification,
      timeline: {
        archived: true,
        modelContext: [{
          contextRevision: 0,
          state: 'unknown',
          fromSequence: sequence,
          untilSequence: null
        }]
      },
      provenance: {
        providerId: TRAE_PROVIDER_ID,
        sourceRefId: source.stableId,
        parserDataVersion: '1',
        formatVersion: TRAE_FORMAT_LEGACY,
        observedAt,
        sourceRecordId: input.sourceRecordId,
        rawRecordFingerprint: rawFingerprint
      },
      rawRef: null
    })
  }

  emit({
    kind: 'session.metadata',
    payload: {
      title: snapshot.workspace.title,
      cwd: snapshot.workspace.cwd,
      projectPath: snapshot.workspace.projectPath
    },
    actor: 'system',
    classification: 'lifecycle',
    messageId: null,
    messageBlockIndex: null,
    timestamp: normalizeTimestamp(snapshot.record.session.createdAt),
    sourceRecordId: `session:${sessionId}`
  })

  const messages = Array.isArray(snapshot.record.session.messages)
    ? snapshot.record.session.messages as TraeStoredMessage[]
    : null
  if (!messages) throw new Error(`trae-session-messages-malformed:${sessionId}`)
  let currentModel = typeof snapshot.record.session.model === 'string'
    ? snapshot.record.session.model
    : null
  messages.forEach((messageValue, messageIndex) => {
    const message = asObject(messageValue) as TraeStoredMessage | null
    if (!message) {
      diagnostics.push({ level: 'warning', code: 'trae-message-malformed', message: `Message ${messageIndex} is not an object.`, eventId: null })
      return
    }
    const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : ''
    const actor: CanonicalEvent['actor'] = role === 'user' || role === 'assistant' || role === 'system' || role === 'tool'
      ? role
      : 'unknown'
    const messageId = typeof message.id === 'string' && message.id.trim()
      ? message.id.trim()
      : `turn:${typeof message.turnIndex === 'number' ? message.turnIndex : messageIndex}`
    const timestamp = normalizeTimestamp(message.timestamp) ||
      normalizeTimestamp(snapshot.record.session.createdAt) ||
      normalizeTimestamp(snapshot.record.session.updatedAt)
    const model = typeof message.model === 'string' && message.model.trim() ? message.model.trim() : null
    if (model && model !== currentModel) {
      emit({
        kind: 'model.changed',
        payload: { fromModelId: currentModel, toModelId: model },
        actor: 'system',
        classification: 'lifecycle',
        messageId,
        messageBlockIndex: null,
        timestamp,
        sourceRecordId: `messages/${messageIndex}/model`
      })
      currentModel = model
    }
    if (actor === 'unknown') {
      emit({
        kind: 'unknown',
        payload: {
          rawType: role || 'trae.message.unknown-role',
          rawPayload: jsonValue({
            role: message.role,
            content: message.content,
            agentTaskContent: message.agentTaskContent,
            timestamp: message.timestamp,
            model: message.model,
            turnIndex: message.turnIndex
          })
        },
        actor,
        classification: 'unknown',
        messageId,
        messageBlockIndex: null,
        timestamp,
        sourceRecordId: `messages/${messageIndex}`
      })
      return
    }
    let fragments = textFragments(message.content)
    if (fragments.length === 0 && role === 'assistant') fragments = agentTaskFragments(message.agentTaskContent)
    const split = fragments.flatMap(splitText)
    if (split.length === 0) {
      diagnostics.push({ level: 'warning', code: 'trae-message-empty', message: `Message ${messageIndex} has no evidenced text.`, eventId: null })
      return
    }
    split.forEach((text, blockIndex) => emit({
      kind: 'message.text',
      payload: { text },
      actor,
      classification: actor === 'system' ? 'promoted-system' : 'user-content',
      messageId,
      messageBlockIndex: blockIndex,
      timestamp,
      sourceRecordId: `messages/${messageIndex}/content/${blockIndex}`
    }))
  })
  return { identity, events, diagnostics }
}

function chunksFor(
  snapshot: TraeSourceSnapshot,
  source: SourceRef,
  fingerprint: Fingerprint,
  mode: ParseChunk['mode']
): ParseChunk[] {
  const parsed = eventsFor(snapshot, source)
  const eventGroups: CanonicalEvent[][] = []
  let group: CanonicalEvent[] = []
  let groupBytes = 0
  for (const event of parsed.events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (group.length > 0 && (
      group.length >= PROVIDER_RESOURCE_LIMITS.maxEventsPerChunk ||
      groupBytes + eventBytes > TRAE_CHUNK_EVENT_BYTES
    )) {
      eventGroups.push(group)
      group = []
      groupBytes = 0
    }
    group.push(event)
    groupBytes += eventBytes
  }
  if (group.length > 0 || eventGroups.length === 0) eventGroups.push(group)
  return eventGroups.map((events, chunkIndex) => {
    const done = chunkIndex === eventGroups.length - 1
    return {
      providerId: TRAE_PROVIDER_ID,
      parserDataVersion: '1',
      formatVersion: TRAE_FORMAT_LEGACY,
      fingerprint,
      identity: parsed.identity,
      mode,
      chunkIndex,
      previousCursor: chunkIndex === 0 ? null : `trae:${snapshot.record.sessionId}:chunk:${chunkIndex - 1}`,
      cursor: done ? null : `trae:${snapshot.record.sessionId}:chunk:${chunkIndex}`,
      done,
      events,
      diagnostics: chunkIndex === 0 ? parsed.diagnostics : []
    }
  })
}

export function detectTraeModernEncryptedLayout(profileRoot: string): boolean {
  const databasePath = path.join(path.dirname(profileRoot), 'ModularData', 'ai-agent', 'database.db')
  let handle: number | null = null
  try {
    handle = fs.openSync(databasePath, 'r')
    const header = Buffer.alloc(SQLITE_HEADER.length)
    if (fs.readSync(handle, header, 0, header.length, 0) !== header.length) return false
    return !header.equals(SQLITE_HEADER)
  } catch {
    return false
  } finally {
    if (handle !== null) fs.closeSync(handle)
  }
}

export function createTraeProvider(options: TraeProviderOptions): BuiltinProviderRuntimeV2 {
  const definition = builtinProviderForSource('trae')
  if (!definition) throw new Error('Trae provider manifest is not registered.')
  const roots = options.roots || defaultRoots(options.homeDir)
  const manifestV2 = traeManifestV2(
    definition.manifest.displayName,
    definition.manifest.parserDataVersion,
    definition.manifest.formatVersions
  )
  return {
    manifest: manifestV2,
    async discover(signal) {
      const candidates = new Map<string, TraeSessionRecord>()
      for (const root of roots) {
        for (const databasePath of await discoverDatabases(root, signal)) {
          signalCheckpoint(signal)
          for (const record of sessionRecords(databasePath)) {
            const messages = record.session.messages
            if (Array.isArray(messages) && messages.length === 0) continue
            const stableId = `trae:${record.sessionId.normalize('NFC')}`
            const current = candidates.get(stableId)
            if (!current || record.updatedAtMs > current.updatedAtMs ||
              (record.updatedAtMs === current.updatedAtMs && record.databasePath < current.databasePath)) {
              candidates.set(stableId, record)
            }
          }
        }
      }
      return [...candidates.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([stableId, record]): TraeSqliteSource => ({
          kind: 'sqlite-row',
          stableId,
          providerId: TRAE_PROVIDER_ID,
          databaseUri: pathToFileURL(record.databasePath).href,
          table: 'ItemTable',
          primaryKey: { key: TRAE_STORAGE_KEY, sessionId: record.sessionId },
          displayLocator: `${record.databasePath}#${record.sessionId}`,
          fingerprint: { algorithm: 'sha256', value: 'pending' }
        }))
    },
    async fingerprint(source, signal) {
      signalCheckpoint(signal)
      return snapshotFor(source).fingerprint
    },
    async inputBytes(source, signal) {
      signalCheckpoint(signal)
      const snapshot = snapshotFor(source)
      return Buffer.byteLength(snapshot.record.raw, 'utf8') + Buffer.byteLength(snapshot.workspace.raw, 'utf8')
    },
    async parse(source, fingerprint, signal) {
      signalCheckpoint(signal)
      const snapshot = snapshotFor(source)
      if (!sameFingerprint(snapshot.fingerprint, fingerprint)) throw new Error('trae-source-changed-during-parse')
      return chunksFor(snapshot, source, fingerprint, 'initial')
    }
  }
}
