import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  CanonicalEvent,
  Diagnostic,
  Fingerprint as FingerprintV2,
  JsonValue,
  ParseChunk,
  ProviderManifest,
  SessionIdentity,
  UsageRecord
} from '../../shared/provider-schema-v2.generated'
import type { Fingerprint, SourceRef } from '../../shared/provider-schema.generated'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'

const KIMI_PROVIDER_ID = 'swob/kimi'
const KIMI_PARSER_DATA_VERSION = '2'
const KIMI_NATIVE_FORMAT = 'kimi-code-wire-native-v1.5'
const KIMI_MIGRATED_FORMAT = 'kimi-code-wire-migrated-v1.0'
const KIMI_FIXTURE = 'testdata/kimi/home/.kimi-code/sessions/wd_synthetic/session_synthetic_native/agents/main/wire.jsonl'
const KIMI_MIGRATED_FIXTURE = 'testdata/kimi/home/.kimi-code/sessions/wd_synthetic/session_synthetic_migrated/agents/main/wire.jsonl'

export type KimiEvidenceGrade = 'exact' | 'derived' | 'estimated' | 'unavailable'

export interface KimiEvidenceCell {
  grade: KimiEvidenceGrade
  fixture: string
  conformanceTestId: string
  note: string
}

/** Every user-facing claim has a fixture and a stable test id; unavailable is evidence, not failure. */
export const KIMI_EIGHT_LAYER_EVIDENCE = {
  discovery: {
    grade: 'exact', fixture: KIMI_FIXTURE, conformanceTestId: 'KIMI-DISCOVERY-001',
    note: 'Discovers each agents/<agent>/wire.jsonl as a stable physical source.'
  },
  metadata: {
    grade: 'exact', fixture: KIMI_FIXTURE, conformanceTestId: 'KIMI-METADATA-001',
    note: 'Session index, state metadata, model updates and wire protocol version are observed fields.'
  },
  messages: {
    grade: 'exact', fixture: KIMI_FIXTURE, conformanceTestId: 'KIMI-MESSAGES-001',
    note: 'Native loop events and migrated context messages are normalized without text synthesis.'
  },
  tools: {
    grade: 'exact', fixture: KIMI_MIGRATED_FIXTURE, conformanceTestId: 'KIMI-TOOLS-001',
    note: 'Native tool events and migrated function calls preserve raw name, input and result.'
  },
  systemCompact: {
    grade: 'exact', fixture: KIMI_FIXTURE, conformanceTestId: 'KIMI-SYSTEM-COMPACT-001',
    note: 'Plan, goal, permission, cancel, steer and compaction boundaries are observed records.'
  },
  token: {
    grade: 'exact', fixture: KIMI_FIXTURE, conformanceTestId: 'KIMI-USAGE-001',
    note: 'usage.record wins per turn; step.end is a high-confidence derived fallback and is deduplicated.'
  },
  relationships: {
    grade: 'exact', fixture: 'testdata/kimi/home/.kimi-code/sessions/wd_synthetic/session_synthetic_native/state.json',
    conformanceTestId: 'KIMI-RELATIONSHIPS-001',
    note: 'state.agents parentAgentId and task.started provide the parent/subagent identity.'
  },
  resume: {
    grade: 'exact', fixture: KIMI_FIXTURE, conformanceTestId: 'KIMI-RESUME-001',
    note: 'The audited CLI contract is kimi --session <parent session id>; child ids transform to the parent.'
  }
} as const satisfies Record<string, KimiEvidenceCell>

function evidence(cell: KimiEvidenceCell, kind: 'test' | 'observed-format' | 'upstream-source' = 'test') {
  return [{
    kind,
    fixture: cell.fixture,
    conformanceTestId: cell.conformanceTestId,
    locator: 'src/main/providers/kimi-provider.test.ts',
    note: `${cell.grade}: ${cell.note}`
  }] as const
}

const available = (cell: KimiEvidenceCell) => ({ status: 'available' as const, reason: null, evidence: [...evidence(cell)] })
const unavailable = (reason: string, cell: KimiEvidenceCell) => ({
  status: 'unavailable' as const,
  reason,
  evidence: [...evidence(cell, 'observed-format')]
})

export const KIMI_PROVIDER_MANIFEST_V2: ProviderManifest = {
  schemaVersion: 2,
  providerId: KIMI_PROVIDER_ID,
  displayName: 'Kimi Code',
  implementationVersion: 'builtin-v2',
  parserDataVersion: KIMI_PARSER_DATA_VERSION,
  formatVersions: [KIMI_NATIVE_FORMAT, KIMI_MIGRATED_FORMAT],
  capabilities: {
    discover: available(KIMI_EIGHT_LAYER_EVIDENCE.discovery),
    summary: available(KIMI_EIGHT_LAYER_EVIDENCE.metadata),
    transcript: available(KIMI_EIGHT_LAYER_EVIDENCE.messages),
    tools: available(KIMI_EIGHT_LAYER_EVIDENCE.tools),
    thinking: available(KIMI_EIGHT_LAYER_EVIDENCE.messages),
    usage: available(KIMI_EIGHT_LAYER_EVIDENCE.token),
    relationships: available(KIMI_EIGHT_LAYER_EVIDENCE.relationships),
    subagents: available(KIMI_EIGHT_LAYER_EVIDENCE.relationships),
    interactions: available(KIMI_EIGHT_LAYER_EVIDENCE.systemCompact),
    permissions: available(KIMI_EIGHT_LAYER_EVIDENCE.systemCompact),
    'context-timeline': available(KIMI_EIGHT_LAYER_EVIDENCE.systemCompact),
    identity: available(KIMI_EIGHT_LAYER_EVIDENCE.relationships),
    'chunked-transport': available(KIMI_EIGHT_LAYER_EVIDENCE.discovery),
    'terminal-resume': available(KIMI_EIGHT_LAYER_EVIDENCE.resume),
    'native-resume': unavailable('Kimi Code exposes a CLI session entry point, not a desktop deep link.', KIMI_EIGHT_LAYER_EVIDENCE.resume),
    'format-provenance': available(KIMI_EIGHT_LAYER_EVIDENCE.metadata)
  },
  resumeContract: {
    mode: 'native-cli',
    supportedSurfaces: ['terminal'],
    supportsSubagent: false,
    idTransform: 'kimi-child-to-parent-session-id',
    preflight: ['binary', 'version', 'help-capability', 'source-exists'],
    commandTemplate: 'kimi --session {logicalSessionId}',
    expectedSideEffects: ['opens-existing-kimi-session', 'subagent-resume-targets-parent-session'],
    postcondition: 'anchor-match'
  }
}

interface KimiProviderOptions {
  homeDir: string
  roots?: string[]
}

interface AgentState {
  type?: string
  parentAgentId?: string | null
  swarmItem?: string
}

interface SessionState {
  title?: string
  createdAt?: string
  updatedAt?: string
  agents?: Record<string, AgentState>
}

interface ParsedLine {
  lineNumber: number
  offset: number
  length: number
  raw: string
  value: Record<string, unknown>
}

interface KimiSourceInfo {
  wirePath: string
  statePath: string
  indexPath: string | null
  sessionDir: string
  sessionId: string
  agentId: string
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonValue)
  const object = asObject(value)
  if (!object) return String(value)
  return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, jsonValue(child)]))
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString()
  return null
}

function optionalCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function textParts(value: unknown): Array<{ kind: 'text' | 'thinking'; text: string }> {
  if (typeof value === 'string') return [{ kind: 'text', text: value }]
  if (!Array.isArray(value)) return []
  return value.flatMap((part): Array<{ kind: 'text' | 'thinking'; text: string }> => {
    const item = asObject(part)
    if (!item) return []
    if (item.type === 'text' && typeof item.text === 'string') return [{ kind: 'text' as const, text: item.text }]
    if ((item.type === 'think' || item.type === 'thinking') && typeof (item.think ?? item.thinking) === 'string') {
      return [{ kind: 'thinking' as const, text: String(item.think ?? item.thinking) }]
    }
    return []
  })
}

function inputText(value: unknown): string {
  return textParts(value).map((part) => part.text).join('\n')
}

async function existingFiles(root: string, name: string, maxDepth: number, signal: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visited = new Set<string>()
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (signal.aborted) throw new Error('cancelled')
    if (depth > maxDepth) return
    let real: string
    try { real = await fs.promises.realpath(directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (visited.has(real)) return
    visited.add(real)
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (signal.aborted) throw new Error('cancelled')
      const child = path.join(directory, entry.name)
      if (entry.isFile() && entry.name === name) files.push(child)
      else if (entry.isDirectory() || entry.isSymbolicLink()) await walk(child, depth + 1)
    }
  }
  await walk(root, 0)
  return files.sort()
}

function sourceInfo(source: SourceRef): KimiSourceInfo {
  if (source.kind !== 'composite-directory') throw new Error('kimi-source-kind-invalid')
  const members = source.memberUris.map((uri) => fileURLToPath(uri))
  const wirePath = members.find((member) => path.basename(member) === 'wire.jsonl')
  const statePath = members.find((member) => path.basename(member) === 'state.json')
  if (!wirePath || !statePath) throw new Error('kimi-composite-source-incomplete')
  const agentId = path.basename(path.dirname(wirePath))
  const sessionDir = path.dirname(path.dirname(path.dirname(wirePath)))
  return {
    wirePath,
    statePath,
    indexPath: members.find((member) => path.basename(member) === 'session_index.jsonl') || null,
    sessionDir,
    sessionId: path.basename(sessionDir),
    agentId
  }
}

async function compositeFingerprint(source: SourceRef, signal: AbortSignal): Promise<Fingerprint> {
  if (source.kind !== 'composite-directory') throw new Error('kimi-source-kind-invalid')
  const inputs: string[] = []
  const digest = createHash('sha256')
  for (const uri of [...source.memberUris].sort()) {
    if (signal.aborted) throw new Error('cancelled')
    const filePath = fileURLToPath(uri)
    const bytes = await fs.promises.readFile(filePath, { signal })
    const memberHash = sha256(bytes)
    const label = path.basename(filePath)
    inputs.push(`${label}:${memberHash}`)
    digest.update(label).update('\0').update(bytes).update('\0')
  }
  return { algorithm: 'composite-sha256', value: digest.digest('hex'), inputs }
}

function fingerprintsEqual(left: Fingerprint | FingerprintV2, right: Fingerprint | FingerprintV2): boolean {
  return left.algorithm === right.algorithm && left.value === right.value &&
    JSON.stringify(left.inputs || []) === JSON.stringify(right.inputs || [])
}

async function readState(filePath: string, signal: AbortSignal): Promise<SessionState> {
  return JSON.parse(await fs.promises.readFile(filePath, { encoding: 'utf8', signal })) as SessionState
}

async function workDirFromIndex(indexPath: string | null, sessionId: string, signal: AbortSignal): Promise<string | null> {
  if (!indexPath) return null
  const text = await fs.promises.readFile(indexPath, { encoding: 'utf8', signal })
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    try {
      const row = asObject(JSON.parse(raw))
      if (row?.sessionId === sessionId && typeof row.workDir === 'string') return row.workDir
    } catch { /* a corrupt index row cannot invalidate a readable wire */ }
  }
  return null
}

function parseLines(text: string): { lines: ParsedLine[]; diagnostics: Diagnostic[] } {
  const lines: ParsedLine[] = []
  const diagnostics: Diagnostic[] = []
  let offset = 0
  const rawLines = text.split(/\n/)
  for (let index = 0; index < rawLines.length; index++) {
    const rawWithCr = rawLines[index]
    const raw = rawWithCr.endsWith('\r') ? rawWithCr.slice(0, -1) : rawWithCr
    const length = Buffer.byteLength(rawWithCr, 'utf8')
    if (raw.trim()) {
      try {
        const value = asObject(JSON.parse(raw))
        if (!value) throw new Error('record-not-object')
        lines.push({ lineNumber: index + 1, offset, length, raw, value })
      } catch {
        diagnostics.push({
          level: 'warning',
          code: 'kimi-malformed-jsonl-record',
          message: `Skipped malformed Kimi wire record at line ${index + 1}; later records remain parseable.`,
          eventId: null
        })
      }
    }
    offset += length + (index < rawLines.length - 1 ? 1 : 0)
  }
  return { lines, diagnostics }
}

function interactionResolution(lines: ParsedLine[]): { ids: Set<string>; approvalByTool: Map<string, string> } {
  const ids = new Set<string>()
  const approvalByTool = new Map<string, string>()
  for (const line of lines) {
    if (line.value.type === 'interaction.resolved' && typeof line.value.id === 'string') ids.add(line.value.id)
    if (line.value.type === 'interaction.request' && line.value.kind === 'approval' &&
      typeof line.value.id === 'string' && typeof line.value.toolCallId === 'string') {
      approvalByTool.set(line.value.toolCallId, line.value.id)
    }
  }
  return { ids, approvalByTool }
}

function authoritativeUsageTurns(lines: ParsedLine[]): Map<number, boolean> {
  const result = new Map<number, boolean>()
  let turn = 1
  let sawTurnPrompt = false
  for (const line of lines) {
    if (line.value.type === 'turn.prompt') {
      if (sawTurnPrompt) turn++
      sawTurnPrompt = true
    }
    if (line.value.type === 'usage.record') result.set(turn, true)
  }
  return result
}

function usagePayload(value: unknown, model: unknown, turn: number, authority: 'reported' | 'derived', key: string): UsageRecord {
  const usage = asObject(value) || {}
  const inputOther = optionalCount(usage.inputOther)
  const cacheRead = optionalCount(usage.inputCacheRead)
  const cacheCreation = optionalCount(usage.inputCacheCreation)
  const output = optionalCount(usage.output)
  // Generic cache creation is still non-cache-read input. Folding it into the
  // normalized uncached bucket preserves the exact input total without lying
  // that Kimi reported a 5m or 1h cache TTL.
  const uncached = inputOther !== null && cacheCreation !== null ? inputOther + cacheCreation : null
  const inputComponents = [inputOther, cacheRead, cacheCreation]
  const total = inputComponents.every((entry) => entry !== null)
    ? inputComponents.reduce<number>((sum, entry) => sum + (entry || 0), 0)
    : null
  return {
    eventId: null,
    turnId: `turn-${turn}`,
    modelId: typeof model === 'string' && model ? model : null,
    input: {
      total,
      uncached,
      cacheRead,
      // Kimi reports generic cache creation, not a 5m/1h TTL. Keep the TTL slots null.
      cacheWrite5m: null,
      cacheWrite1h: null
    },
    output: { total: output, visible: null, reasoning: null },
    providerTotal: null,
    aggregation: 'per-turn',
    relations: { cacheRead: 'provider-defined', cacheWrite: 'provider-defined', reasoning: 'provider-defined' },
    dedupKey: `kimi:${key}:turn-${turn}`,
    billingFactKey: `kimi:${key}:turn-${turn}`,
    measurement: {
      source: authority,
      confidence: authority === 'reported' ? 'exact' : 'high',
      sourceField: authority === 'reported'
        ? 'usage.record.usage (uncached=inputOther+inputCacheCreation; cache TTL unavailable)'
        : 'context.append_loop_event.step.end.usage (fallback; uncached=inputOther+inputCacheCreation; cache TTL unavailable)'
    },
    cost: null,
    priceRevision: null
  }
}

function rawToolArguments(value: unknown): JsonValue {
  if (typeof value !== 'string') return jsonValue(value ?? {})
  try { return jsonValue(JSON.parse(value)) } catch { return value }
}

async function parseKimiSource(
  source: SourceRef,
  fingerprint: Fingerprint,
  signal: AbortSignal
): Promise<ParseChunk[]> {
  const info = sourceInfo(source)
  const observed = await compositeFingerprint(source, signal)
  if (!fingerprintsEqual(observed, fingerprint)) throw new Error('kimi-source-changed-during-parse')
  const [wireText, state, workDir] = await Promise.all([
    fs.promises.readFile(info.wirePath, { encoding: 'utf8', signal }),
    readState(info.statePath, signal),
    workDirFromIndex(info.indexPath, info.sessionId, signal)
  ])
  const parsed = parseLines(wireText)
  const protocol = parsed.lines.find((line) => line.value.type === 'metadata')?.value.protocol_version
  const migrated = protocol === '1.0' || (protocol == null &&
    parsed.lines.some((line) => line.value.type === 'context.append_message') &&
    !parsed.lines.some((line) => line.value.type === 'context.append_loop_event'))
  const formatVersion = migrated ? KIMI_MIGRATED_FORMAT : KIMI_NATIVE_FORMAT
  const agentState = state.agents?.[info.agentId]
  const parentAgentId = agentState?.parentAgentId || null
  const branchViewId = `kimi:${info.sessionId}:${info.agentId}`
  const identity: SessionIdentity = {
    physicalSourceId: source.stableId,
    logicalSessionKey: `kimi:${info.sessionId}`,
    logicalSessionId: info.sessionId,
    branchViewId,
    parentBranchViewId: parentAgentId ? `kimi:${info.sessionId}:${parentAgentId}` : null
  }
  const locatorHash = sha256(pathToFileURL(info.wirePath).href)
  const events: CanonicalEvent[] = []
  const diagnostics = [...parsed.diagnostics]
  let contextRevision = 0
  let modelId: string | null = null
  let turn = 1
  let sawTurnPrompt = false
  let messageBlockIndex = 0
  let lastContentEventId: string | null = null
  const resolutions = interactionResolution(parsed.lines)
  const authoritativeTurns = authoritativeUsageTurns(parsed.lines)

  const emit = (
    line: ParsedLine | null,
    suffix: string,
    actor: CanonicalEvent['actor'],
    kind: CanonicalEvent['kind'],
    payload: JsonValue,
    options: Partial<Pick<CanonicalEvent, 'visibility' | 'classification' | 'messageBlockIndex'>> & {
      messageId?: string | null
      contextState?: 'visible-to-model' | 'archived' | 'unknown'
      timestamp?: string | null
      rawType?: string
    } = {}
  ): CanonicalEvent => {
    const sequence = events.length
    const sourceRecordId = line ? `line:${line.lineNumber}:${String(line.value.type || 'unknown')}` : `state:${suffix}`
    const id = `kimi-event:${sha256(`${source.stableId}\0${sourceRecordId}\0${suffix}`).slice(0, 32)}`
    const event: CanonicalEvent = {
      id,
      identity,
      sharedEventKey: `kimi:${sha256(`${info.sessionId}\0${sourceRecordId}\0${suffix}`).slice(0, 32)}`,
      messageId: options.messageId ?? null,
      sequence,
      messageBlockIndex: options.messageBlockIndex ?? null,
      timestamp: options.timestamp ?? timestamp(line?.value.time),
      actor,
      kind,
      payload,
      visibility: options.visibility || (kind.startsWith('message.') ? 'primary' : 'collapsed'),
      classification: options.classification || (actor === 'user' ? 'user-content' : kind.startsWith('message.') ? 'unknown' : 'lifecycle'),
      timeline: {
        archived: true,
        modelContext: [{
          contextRevision,
          state: options.contextState || (kind.startsWith('message.') || kind.startsWith('tool.') ? 'visible-to-model' : 'unknown'),
          fromSequence: sequence,
          untilSequence: null
        }]
      },
      provenance: {
        providerId: KIMI_PROVIDER_ID,
        sourceRefId: source.stableId,
        parserDataVersion: KIMI_PARSER_DATA_VERSION,
        formatVersion,
        observedAt: new Date().toISOString(),
        sourceRecordId,
        rawRecordFingerprint: line ? { algorithm: 'sha256', value: sha256(line.raw) } : null
      },
      rawRef: line ? { locatorHash, offset: line.offset, length: line.length } : null
    }
    events.push(event)
    if (kind === 'message.text' || kind === 'message.thinking' || kind.startsWith('tool.')) lastContentEventId = id
    return event
  }

  const emitText = (
    line: ParsedLine,
    actor: CanonicalEvent['actor'],
    parts: Array<{ kind: 'text' | 'thinking'; text: string }>,
    classification?: CanonicalEvent['classification'],
    messageId?: string
  ) => {
    const block = messageBlockIndex++
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      emit(line, `content:${block}:${index}`, actor, part.kind === 'thinking' ? 'message.thinking' : 'message.text',
        { text: part.text }, { messageId, messageBlockIndex: block, classification, contextState: 'visible-to-model' })
    }
  }

  if (state.title) emit(null, 'title', 'system', 'session.lifecycle', { phase: `metadata.title:${state.title}` }, {
    timestamp: timestamp(state.createdAt), contextState: 'unknown', visibility: 'hidden-noise'
  })
  if (workDir) emit(null, 'cwd', 'system', 'session.lifecycle', { phase: `metadata.cwd:${workDir}` }, {
    timestamp: timestamp(state.createdAt), contextState: 'unknown', visibility: 'hidden-noise'
  })
  if (parentAgentId) {
    emit(null, 'parent', 'system', 'session.lifecycle', {
      relationshipType: 'subagent',
      parentBranchViewId: `kimi:${info.sessionId}:${parentAgentId}`
    }, { timestamp: timestamp(state.createdAt), contextState: 'unknown' })
  }
  if (agentState?.swarmItem) emit(null, 'swarm-item', 'system', 'session.lifecycle', {
    phase: `subagent.task:${agentState.swarmItem}`
  }, { timestamp: timestamp(state.createdAt), contextState: 'unknown' })

  for (const line of parsed.lines) {
    if (signal.aborted) throw new Error('cancelled')
    const value = line.value
    const type = typeof value.type === 'string' ? value.type : 'unknown'
    if (type === 'metadata') continue

    if (type === 'config.update') {
      if (typeof value.modelAlias === 'string' && value.modelAlias) {
        emit(line, 'model', 'system', 'model.changed', { fromModelId: modelId, toModelId: value.modelAlias })
        modelId = value.modelAlias
      }
      if (typeof value.thinkingEffort === 'string') {
        emit(line, 'thinking-mode', 'system', 'mode.changed', { fromMode: null, toMode: `thinking:${value.thinkingEffort}` })
      }
      continue
    }

    if (type === 'turn.prompt') {
      if (sawTurnPrompt) turn++
      sawTurnPrompt = true
      // Native wires also persist the prompt as context.append_message. That record is the canonical text.
      continue
    }

    if (type === 'turn.steer') {
      const text = inputText(value.input)
      if (text) emitText(line, 'user', [{ kind: 'text', text }], 'user-content', `kimi:${info.sessionId}:turn-${turn}:steer`)
      emit(line, 'steer', 'system', 'session.lifecycle', { phase: 'turn.steer' })
      continue
    }

    if (type === 'context.append_message') {
      const message = asObject(value.message) || {}
      const role = typeof message.role === 'string' ? message.role : 'unknown'
      const parts = textParts(message.content)
      const messageId = typeof message.id === 'string' && message.id
        ? message.id
        : `kimi:${info.sessionId}:line-${line.lineNumber}:${role}`
      const actor: CanonicalEvent['actor'] = role === 'assistant'
        ? (info.agentId === 'main' ? 'assistant' : 'subagent')
        : role === 'user' ? 'user' : role === 'system' ? 'system' : role === 'tool' ? 'tool' : 'unknown'
      if (role === 'tool' && typeof message.toolCallId === 'string') {
        emit(line, 'tool-result', 'tool', 'tool.result', {
          callId: message.toolCallId,
          output: jsonValue(message.content ?? null),
          isError: typeof message.isError === 'boolean' ? message.isError : null,
          state: message.isError === true ? 'error' : 'complete'
        }, { contextState: 'visible-to-model' })
      } else {
        emitText(line, actor, parts, actor === 'user' ? 'user-content' : undefined, messageId)
      }
      const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : []
      for (let index = 0; index < toolCalls.length; index++) {
        const call = asObject(toolCalls[index])
        const fn = asObject(call?.function)
        if (!call || !fn || typeof fn.name !== 'string') continue
        const callId = typeof call.id === 'string' && call.id ? call.id : `line-${line.lineNumber}-tool-${index}`
        emit(line, `message-tool:${index}`, actor, 'tool.call', {
          callId,
          rawName: fn.name,
          semanticToolId: `kimi/${fn.name}`,
          input: rawToolArguments(fn.arguments)
        }, { messageId, contextState: 'visible-to-model' })
      }
      continue
    }

    if (type === 'context.append_loop_event') {
      const loop = asObject(value.event) || {}
      const loopMessageId = `kimi:${info.sessionId}:turn-${turn}:assistant`
      if (loop.type === 'content.part') {
        emitText(line, info.agentId === 'main' ? 'assistant' : 'subagent', textParts([loop.part]), undefined, loopMessageId)
      } else if (loop.type === 'tool.call') {
        const callId = typeof loop.toolCallId === 'string' && loop.toolCallId ? loop.toolCallId : `line-${line.lineNumber}`
        const name = typeof loop.name === 'string' && loop.name ? loop.name : 'unknown'
        emit(line, 'tool-call', info.agentId === 'main' ? 'assistant' : 'subagent', 'tool.call', {
          callId,
          rawName: name,
          semanticToolId: `kimi/${name}`,
          input: jsonValue(loop.args ?? {})
        }, { messageId: loopMessageId, contextState: 'visible-to-model' })
      } else if (loop.type === 'tool.result') {
        const result = asObject(loop.result) || {}
        emit(line, 'tool-result', 'tool', 'tool.result', {
          callId: typeof loop.toolCallId === 'string' && loop.toolCallId ? loop.toolCallId : `line-${line.lineNumber}`,
          output: jsonValue(result.output ?? loop.result ?? null),
          isError: typeof result.isError === 'boolean' ? result.isError : null,
          state: result.isError === true ? 'error' : 'complete'
        }, { contextState: 'visible-to-model' })
      } else if (loop.type === 'step.end') {
        if (authoritativeTurns.has(turn)) {
          diagnostics.push({
            level: 'info', code: 'kimi-step-usage-deduplicated',
            message: `Ignored step.end usage for turn ${turn} because usage.record is authoritative.`, eventId: null
          })
        } else {
          const payload = usagePayload(loop.usage, asObject(loop.usage)?.model ?? modelId, turn, 'derived', info.sessionId)
          const event = emit(line, 'usage-fallback', 'system', 'usage', jsonValue(payload))
          ;(event.payload as unknown as UsageRecord).eventId = event.id
        }
      } else {
        emit(line, 'unknown-loop', 'unknown', 'unknown', { rawType: String(loop.type || 'unknown-loop-event'), rawPayload: jsonValue(loop) })
      }
      continue
    }

    if (type === 'usage.record') {
      const payload = usagePayload(value.usage, value.model ?? modelId, turn, 'reported', info.sessionId)
      const event = emit(line, 'usage-authoritative', 'system', 'usage', jsonValue(payload))
      ;(event.payload as unknown as UsageRecord).eventId = event.id
      continue
    }

    if (type === 'interaction.request' && typeof value.id === 'string') {
      const request = asObject(value.request) || {}
      const answered = resolutions.ids.has(value.id)
      if (value.kind === 'approval') {
        emit(line, 'permission-request', 'system', 'permission.request', {
          requestId: value.id,
          permission: typeof request.permission === 'string' && request.permission ? request.permission : 'unknown',
          resource: jsonValue(request.resource ?? request),
          state: { state: 'historical', answered },
          toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : null,
          rawInput: jsonValue(request)
        }, { classification: 'interaction' })
      } else {
        const options = Array.isArray(request.options) ? request.options.flatMap((option) => {
          const item = asObject(option)
          return item && typeof item.label === 'string' ? [{
            id: typeof item.id === 'string' ? item.id : null,
            label: item.label,
            description: typeof item.description === 'string' ? item.description : null
          }] : []
        }) : []
        emit(line, 'interaction-request', 'system', 'interaction.request', {
          requestId: value.id,
          prompt: typeof request.question === 'string' ? request.question : '',
          options,
          multiSelect: request.multiSelect === true,
          state: { state: 'historical', answered },
          toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : null,
          rawInput: jsonValue(request)
        }, { classification: 'interaction' })
      }
      continue
    }

    if (type === 'interaction.resolved' && typeof value.id === 'string') {
      const response = asObject(value.response) || {}
      const permissionRequest = parsed.lines.find((candidate) =>
        candidate.value.type === 'interaction.request' && candidate.value.id === value.id && candidate.value.kind === 'approval')
      if (permissionRequest) {
        const decisionText = String(response.response ?? response.decision ?? 'cancelled')
        const decision = decisionText === 'approve' || decisionText === 'allow'
          ? 'allow' : decisionText === 'reject' || decisionText === 'deny' ? 'deny' : 'cancelled'
        emit(line, 'permission-response', 'system', 'permission.response', {
          requestId: value.id, decision,
          toolCallId: typeof permissionRequest.value.toolCallId === 'string' ? permissionRequest.value.toolCallId : null
        }, { classification: 'interaction' })
      } else {
        const answers = Array.isArray(response.answers) ? response.answers.map(String) : []
        const request = parsed.lines.find((candidate) =>
          candidate.value.type === 'interaction.request' && candidate.value.id === value.id)
        emit(line, 'interaction-response', 'user', 'interaction.response', {
          requestId: value.id,
          outcome: 'answered',
          answers,
          toolCallId: typeof request?.value.toolCallId === 'string' ? request.value.toolCallId : null
        }, { classification: 'interaction' })
      }
      continue
    }

    if (type === 'permission.record_approval_result') {
      const toolCallId = typeof value.toolCallId === 'string' ? value.toolCallId : null
      const requestId = toolCallId ? resolutions.approvalByTool.get(toolCallId) : null
      if (!requestId) {
        emit(line, 'orphan-permission-result', 'system', 'unknown', {
          rawType: type, rawPayload: jsonValue(value)
        }, { classification: 'interaction' })
      }
      // interaction.resolved is the authoritative response when both records exist.
      continue
    }

    if (type === 'permission.set_mode') {
      emit(line, 'permission-mode', 'system', 'mode.changed', {
        fromMode: null, toMode: `permission:${String(value.mode || 'unknown')}`
      })
      continue
    }

    if (type === 'plan_mode.enter') {
      emit(line, 'plan-mode', 'system', 'mode.changed', { fromMode: null, toMode: 'plan' })
      continue
    }

    if (type === 'plan.revision') {
      emit(line, 'plan-lifecycle', 'system', 'session.lifecycle', {
        phase: `plan.revision:${String(value.id || 'unknown')}:v${String(value.version ?? 'unknown')}`
      })
      if (typeof value.path === 'string' && value.path) {
        emit(line, 'plan-artifact', 'system', 'artifact', {
          uri: pathToFileURL(value.path).href,
          action: 'edit',
          exists: null,
          fingerprint: typeof value.sha256 === 'string' ? { algorithm: 'sha256', value: value.sha256 } : null
        })
      }
      continue
    }

    if (type.startsWith('goal.')) {
      emit(line, 'goal', 'system', 'session.lifecycle', {
        phase: `${type}:${String(value.goalId || 'unknown')}:${String(value.status || '')}:${String(value.objective || '')}`
      })
      continue
    }

    if (type === 'context.apply_compaction') {
      const boundary = events.length
      contextRevision++
      for (const event of events) {
        const active = event.timeline.modelContext.at(-1)
        if (!active || active.state !== 'visible-to-model' || active.untilSequence !== null) continue
        active.untilSequence = boundary
        event.timeline.modelContext.push({
          contextRevision,
          state: 'archived',
          fromSequence: boundary,
          untilSequence: null
        })
      }
      const summaryId = `kimi-event:${sha256(`${source.stableId}\0line:${line.lineNumber}:${type}\0compact-summary`).slice(0, 32)}`
      emit(line, 'compact', 'system', 'context.compaction', {
        contextRevision,
        archivedThroughSequence: Math.max(boundary - 1, 0),
        summaryEventId: summaryId
      })
      emit(line, 'compact-summary', 'system', 'context.summary', {
        text: typeof value.summary === 'string' ? value.summary : '',
        contextRevision
      }, { contextState: 'visible-to-model' })
      continue
    }

    if (type === 'context.undo') {
      emit(line, 'undo', 'system', 'rollback', {
        toEventId: lastContentEventId || events.at(-1)?.id || `kimi:${info.sessionId}:start`,
        reason: `context.undo:${String(value.count ?? 1)}`
      })
      continue
    }

    if (type === 'task.started') {
      const item = asObject(value.info) || {}
      if (item.kind === 'subagent' && typeof item.agentId === 'string') {
        emit(line, 'subagent-spawn', 'system', 'subagent.spawn', {
          agentId: item.agentId,
          parentAgentId: typeof item.parentAgentId === 'string' ? item.parentAgentId : info.agentId
        })
      } else {
        emit(line, 'task-started', 'system', 'session.lifecycle', { phase: 'task.started' })
      }
      continue
    }

    if (type.endsWith('_mode.enter')) {
      emit(line, 'mode-enter', 'system', 'mode.changed', { fromMode: null, toMode: type.slice(0, -'.enter'.length) })
      continue
    }

    if (type === 'turn.cancel') {
      emit(line, 'cancel-rollback', 'system', 'rollback', {
        toEventId: lastContentEventId || events.at(-1)?.id || `kimi:${info.sessionId}:start`,
        reason: typeof value.reason === 'string' ? value.reason : 'turn.cancel'
      })
      emit(line, 'cancel-lifecycle', 'system', 'session.lifecycle', { phase: 'turn.cancelled' })
      continue
    }

    if (type === 'turn.ended') {
      emit(line, 'turn-ended', 'system', 'session.lifecycle', {
        phase: `turn.ended:${String(value.reason || 'unknown')}`
      })
      continue
    }

    emit(line, 'unknown', 'unknown', 'unknown', { rawType: type, rawPayload: jsonValue(value) })
  }

  return [{
    providerId: KIMI_PROVIDER_ID,
    parserDataVersion: KIMI_PARSER_DATA_VERSION,
    formatVersion,
    fingerprint,
    identity,
    mode: 'initial',
    chunkIndex: 0,
    previousCursor: null,
    cursor: null,
    done: true,
    events,
    diagnostics
  }]
}

export function kimiParentSessionId(chunk: ParseChunk): string {
  return chunk.identity.logicalSessionId
}

export function createKimiProvider(options: KimiProviderOptions): BuiltinProviderRuntimeV2 {
  const roots = options.roots || [path.join(options.homeDir, '.kimi-code', 'sessions')]
  const indexPath = path.join(options.homeDir, '.kimi-code', 'session_index.jsonl')
  return {
    manifest: KIMI_PROVIDER_MANIFEST_V2,
    async discover(signal) {
      const sources: SourceRef[] = []
      for (const root of roots) {
        for (const statePath of await existingFiles(root, 'state.json', 5, signal)) {
          const sessionDir = path.dirname(statePath)
          const sessionId = path.basename(sessionDir)
          const wires = await existingFiles(path.join(sessionDir, 'agents'), 'wire.jsonl', 3, signal)
          for (const wirePath of wires) {
            const agentId = path.basename(path.dirname(wirePath))
            const memberPaths = [wirePath, statePath]
            if (fs.existsSync(indexPath)) memberPaths.push(indexPath)
            sources.push({
              kind: 'composite-directory',
              stableId: `kimi:${sessionId}:${agentId}`,
              providerId: KIMI_PROVIDER_ID,
              rootUri: pathToFileURL(sessionDir).href,
              memberUris: memberPaths.sort().map((member) => pathToFileURL(member).href),
              // Legacy detail routing keys the consumer read model by a real,
              // source-detectable locator. Stable identity remains independent
              // of this movable physical path.
              displayLocator: wirePath,
              fingerprint: { algorithm: 'composite-sha256', value: 'pending-discovery', inputs: ['pending-discovery'] }
            })
          }
        }
      }
      return sources.sort((left, right) => left.stableId.localeCompare(right.stableId))
    },
    fingerprint: compositeFingerprint,
    async inputBytes(source, signal) {
      if (source.kind !== 'composite-directory') throw new Error('kimi-source-kind-invalid')
      let total = 0
      for (const uri of source.memberUris) {
        if (signal.aborted) throw new Error('cancelled')
        total += (await fs.promises.stat(fileURLToPath(uri))).size
      }
      return total
    },
    parse: parseKimiSource
  }
}
