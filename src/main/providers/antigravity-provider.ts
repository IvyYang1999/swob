import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import type {
  Fingerprint,
  JsonValue,
  SourceRef
} from '../../shared/provider-schema.generated'
import type {
  CanonicalEvent,
  Diagnostic,
  ParseChunk,
  ProviderManifest as ProviderManifestV2,
  UsageRecord as UsageRecordV2
} from '../../shared/provider-schema-v2.generated'
import {
  providerFingerprint,
} from '../../shared/provider-protocol'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'
export {
  antigravityCliSupportsConversation,
  buildAntigravityResumeArgs
} from './antigravity-resume'

const PROVIDER_ID = 'swob/antigravity'
const PARSER_DATA_VERSION = '2'
const JSONL_FORMAT = 'antigravity-step-jsonl-v1'
const SQLITE_FORMAT = 'antigravity-sqlite-1.0.7-1.0.10'
const ARTIFACT_FORMAT = 'antigravity-brain-markdown-v1'
const ENCRYPTED_PROTO_FORMAT = 'antigravity-encrypted-protobuf-unknown'
const KNOWN_SQLITE_SCHEMA_SHA256 = '1ca98426f561fe73223c8620a238405030fdb3014444d970e1300a6009f72f43'
const MAX_HISTORY_BYTES = 16 * 1024 * 1024
const MAX_MARKDOWN_BYTES = 4 * 1024 * 1024
const MAX_BRAIN_FILES = 64
const MAX_PROTO_FIELDS = 50_000
const MAX_PROTO_DEPTH = 12
const MAX_PLAUSIBLE_TOKENS = 2_000_000

const KNOWN_TOOL_NAMES = new Set([
  'ask_permission', 'ask_question', 'define_subagent', 'generate_image',
  'grep_search', 'invoke_subagent', 'list_directory', 'list_dir', 'manage_subagents',
  'manage_task', 'multi_replace_file_content', 'read_file', 'read_url_content',
  'replace_file_content', 'run_command', 'run_shell_command', 'schedule',
  'search_files', 'search_web', 'send_message', 'view_file', 'write_file', 'write_to_file'
])

const TOOL_RESULT_STEP_TYPES = new Set([
  'ASK_PERMISSION', 'ASK_QUESTION', 'GENERATE_IMAGE', 'GREP_SEARCH', 'INVOKE_SUBAGENT',
  'LIST_DIRECTORY', 'MANAGE_SUBAGENTS', 'MANAGE_TASK', 'READ_URL_CONTENT', 'REPLACE_FILE_CONTENT',
  'RUN_COMMAND', 'SEARCH_WEB', 'SEND_MESSAGE', 'VIEW_FILE', 'WRITE_TO_FILE'
])

export type AntigravityEvidenceStatus = 'exact' | 'derived' | 'estimated' | 'unavailable'

export interface AntigravityCapabilityLayer {
  layer: 'discovery' | 'metadata' | 'messages' | 'tools' | 'system-compact' | 'tokens' | 'relationships' | 'resume'
  status: AntigravityEvidenceStatus
  evidence: string
  limit: string
  fixture: string
  conformanceTestId: string
}

/** Eight-layer truth table. `estimated` is deliberately absent: chars/4 is never emitted. */
export const ANTIGRAVITY_CAPABILITY_MATRIX: readonly AntigravityCapabilityLayer[] = [
  {
    layer: 'discovery', status: 'exact',
    evidence: 'Official transcriptPath roots plus pinned SQLite/legacy format references.',
    limit: 'Encrypted .pb sources are detected but not decrypted.',
    fixture: 'testdata/antigravity/transcript.jsonl',
    conformanceTestId: 'antigravity-v2.discovery.composite-root'
  },
  {
    layer: 'metadata', status: 'derived',
    evidence: 'Conversation id comes from the upstream directory/file name; workspace comes from the matching history.jsonl row.',
    limit: 'No published Antigravity database metadata schema exists.',
    fixture: 'testdata/antigravity/history.jsonl',
    conformanceTestId: 'antigravity-v2.metadata.matching-history-row'
  },
  {
    layer: 'messages', status: 'derived',
    evidence: 'USER_INPUT, PLANNER_RESPONSE and Markdown bytes are preserved; known-schema SQLite protobuf fields are mapped by pinned reverse-engineered evidence.',
    limit: 'The Antigravity SQLite protobuf schema is not officially published.',
    fixture: 'testdata/antigravity/transcript.jsonl',
    conformanceTestId: 'antigravity-v2.messages.ordered-source-blocks'
  },
  {
    layer: 'tools', status: 'derived',
    evidence: 'JSONL tool_calls are exact; result pairing falls back to source order only when no call id exists.',
    limit: 'Unknown SQLite tool encodings remain unknown events.',
    fixture: 'testdata/antigravity/transcript.jsonl',
    conformanceTestId: 'antigravity-v2.tools.call-result-pairing'
  },
  {
    layer: 'system-compact', status: 'derived',
    evidence: 'CHECKPOINT and other system stages are preserved as lifecycle/unknown events.',
    limit: 'A checkpoint is not relabelled as compaction because no archived-through boundary is stored.',
    fixture: 'testdata/antigravity/transcript.jsonl',
    conformanceTestId: 'antigravity-v2.system-compact.checkpoint-not-compaction'
  },
  {
    layer: 'tokens', status: 'derived',
    evidence: 'Known-schema gen_metadata counters are provider-produced; field semantics are pinned reverse-engineered evidence.',
    limit: 'No exact reasoning split or reported USD cost; JSONL/Markdown/.pb usage is unavailable; chars/4 is not used.',
    fixture: 'testdata/antigravity/known-sqlite-usage.json',
    conformanceTestId: 'antigravity-v2.tokens.known-schema-counters'
  },
  {
    layer: 'relationships', status: 'derived',
    evidence: 'Structured conversationId values in subagent results establish parent/child links.',
    limit: 'Free-form UUID text is never treated as lineage.',
    fixture: 'testdata/antigravity/transcript.jsonl',
    conformanceTestId: 'antigravity-v2.relationships.structured-conversation-id'
  },
  {
    layer: 'resume', status: 'unavailable',
    evidence: 'Google documents agy --conversation=<conv_id>; the runtime requires exact --conversation help output plus binary/source preflight before launch.',
    limit: 'Swob does not yet observe a post-launch source/message anchor, so a successful launch is not verified as a successful Resume.',
    fixture: 'testdata/antigravity/agy-help.txt',
    conformanceTestId: 'antigravity-v2.resume.help-preflight'
  }
] as const

interface AntigravityProviderOptions {
  homeDir: string
  roots?: string[]
}

interface HistoryRow {
  conversationId: string
  workspace: string | null
  display: string | null
  timestamp: string | null
  raw: string
}

interface SourceDescriptor {
  root: string
  surface: 'cli' | 'ide' | 'ide-legacy'
  conversationId: string
  primaryPath: string
  transcriptPath: string | null
  databasePath: string | null
  encryptedProtoPath: string | null
  brainFiles: string[]
  historyPath: string | null
}

interface NormalizedFact {
  sourceRecordId: string
  rawFingerprint: Fingerprint | null
  timestamp: string | null
  actor: CanonicalEvent['actor']
  kind: CanonicalEvent['kind']
  payload: JsonValue
  visibility: CanonicalEvent['visibility']
  classification: CanonicalEvent['classification']
  messageId: string | null
  messageBlockIndex: number | null
  usage?: UsageRecordV2
}

interface ParsedBundle {
  source: SourceRef
  descriptor: SourceDescriptor
  fingerprint: Fingerprint
  formatVersion: string
  title: string | null
  projectPath: string | null
  createdAt: string | null
  updatedAt: string | null
  facts: NormalizedFact[]
  diagnostics: Diagnostic[]
  partial: boolean
}

interface ProtoField {
  number: number
  wire: number
  varint: number | null
  bytes: Buffer | null
  nested: ProtoField[] | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(jsonValue)
  if (!isObject(value)) return String(value)
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonValue(child)]))
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 10_000_000_000 ? value : value * 1000
    const date = new Date(milliseconds)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function isSafeConversationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)
}

function surfaceForRoot(root: string): SourceDescriptor['surface'] {
  const name = path.basename(root).toLowerCase()
  if (name === 'antigravity-cli') return 'cli'
  if (name === 'antigravity-ide') return 'ide-legacy'
  return 'ide'
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function regularFile(candidate: string): boolean {
  try { return fs.lstatSync(candidate).isFile() } catch { return false }
}

function directory(candidate: string): boolean {
  try { return fs.lstatSync(candidate).isDirectory() } catch { return false }
}

function listBrainFiles(root: string, conversationId: string): string[] {
  const brain = path.join(root, 'brain', conversationId)
  if (!directory(brain)) return []
  return fs.readdirSync(brain, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.md.metadata.json')))
    .map((entry) => path.join(brain, entry.name))
    .sort()
    .slice(0, MAX_BRAIN_FILES)
}

function readHistoryRows(historyPath: string | null, conversationId: string): HistoryRow[] {
  if (!historyPath || !regularFile(historyPath)) return []
  const stat = fs.statSync(historyPath)
  if (stat.size > MAX_HISTORY_BYTES) return []
  return fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).flatMap((raw): HistoryRow[] => {
    if (!raw.trim()) return []
    let row: unknown
    try { row = JSON.parse(raw) } catch { return [] }
    if (!isObject(row) || row.conversationId !== conversationId) return []
    return [{
      conversationId,
      workspace: optionalString(row.workspace),
      display: optionalString(row.display),
      timestamp: isoTimestamp(row.timestamp),
      raw
    }]
  })
}

function descriptorMembers(descriptor: SourceDescriptor): string[] {
  return [
    descriptor.databasePath,
    descriptor.databasePath && regularFile(`${descriptor.databasePath}-wal`) ? `${descriptor.databasePath}-wal` : null,
    descriptor.transcriptPath,
    descriptor.encryptedProtoPath,
    ...descriptor.brainFiles
  ].filter((candidate): candidate is string => Boolean(candidate) && regularFile(candidate!))
}

function sourceFingerprint(descriptor: SourceDescriptor): Fingerprint {
  const hash = createHash('sha256')
  const inputs: string[] = []
  for (const member of descriptorMembers(descriptor).sort()) {
    const relative = path.relative(descriptor.root, member).split(path.sep).join('/')
    const bytes = fs.readFileSync(member)
    hash.update(relative).update('\0').update(String(bytes.length)).update('\0').update(bytes)
    inputs.push(relative)
  }
  for (const row of readHistoryRows(descriptor.historyPath, descriptor.conversationId)) {
    hash.update('history-row\0').update(row.raw).update('\0')
    inputs.push(`history:${providerFingerprint(row.raw)}`)
  }
  return { algorithm: 'composite-sha256', value: hash.digest('hex'), inputs }
}

function sourceInputBytes(descriptor: SourceDescriptor): number {
  const fileBytes = descriptorMembers(descriptor).reduce((sum, member) => sum + fs.statSync(member).size, 0)
  return fileBytes + readHistoryRows(descriptor.historyPath, descriptor.conversationId)
    .reduce((sum, row) => sum + Buffer.byteLength(row.raw, 'utf8'), 0)
}

function descriptorFromSource(source: SourceRef): SourceDescriptor {
  if (source.kind !== 'composite-directory') throw new Error('antigravity-source-must-be-composite')
  const root = fileURLToPath(source.rootUri)
  const prefix = 'antigravity:'
  if (!source.stableId.startsWith(prefix)) throw new Error('antigravity-source-id-invalid')
  const [, surface, ...idParts] = source.stableId.split(':')
  const conversationId = idParts.join(':')
  if (!['cli', 'ide', 'ide-legacy'].includes(surface) || !isSafeConversationId(conversationId)) {
    throw new Error('antigravity-source-id-invalid')
  }
  const members = source.memberUris.map((uri) => fileURLToPath(uri))
  if (members.some((member) => !pathInside(root, member))) throw new Error('antigravity-source-member-outside-root')
  const transcriptPath = members.find((member) => path.basename(member) === 'transcript.jsonl') || null
  const databasePath = members.find((member) => member.endsWith('.db')) || null
  const encryptedProtoPath = members.find((member) => member.endsWith('.pb')) || null
  return {
    root,
    surface: surface as SourceDescriptor['surface'],
    conversationId,
    primaryPath: source.displayLocator,
    transcriptPath,
    databasePath,
    encryptedProtoPath,
    brainFiles: members.filter((member) => member.endsWith('.md') || member.endsWith('.md.metadata.json')),
    historyPath: regularFile(path.join(root, 'history.jsonl')) ? path.join(root, 'history.jsonl') : null
  }
}

function discoverDescriptors(root: string): SourceDescriptor[] {
  if (!directory(root)) return []
  const surface = surfaceForRoot(root)
  const ids = new Set<string>()
  for (const container of ['brain', 'conversations', 'implicit']) {
    const target = path.join(root, container)
    if (!directory(target)) continue
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (container === 'brain' && entry.isDirectory() && isSafeConversationId(entry.name)) ids.add(entry.name)
      if (container !== 'brain' && entry.isFile()) {
        const extension = path.extname(entry.name)
        const id = path.basename(entry.name, extension)
        if (['.db', '.pb'].includes(extension) && isSafeConversationId(id)) ids.add(id)
      }
    }
  }
  const historyPath = regularFile(path.join(root, 'history.jsonl')) ? path.join(root, 'history.jsonl') : null
  return [...ids].sort().flatMap((conversationId): SourceDescriptor[] => {
    const brain = path.join(root, 'brain', conversationId)
    const transcript = path.join(brain, '.system_generated', 'logs', 'transcript.jsonl')
    const db = path.join(root, 'conversations', `${conversationId}.db`)
    const pb = path.join(root, 'conversations', `${conversationId}.pb`)
    const implicitPb = path.join(root, 'implicit', `${conversationId}.pb`)
    const databasePath = regularFile(db) ? db : null
    const transcriptPath = regularFile(transcript) ? transcript : null
    const encryptedProtoPath = regularFile(pb) ? pb : regularFile(implicitPb) ? implicitPb : null
    const brainFiles = listBrainFiles(root, conversationId)
    const primaryPath = transcriptPath || databasePath || encryptedProtoPath || brainFiles.find((file) => file.endsWith('.md'))
    if (!primaryPath) return []
    return [{
      root, surface, conversationId, primaryPath, transcriptPath, databasePath,
      encryptedProtoPath, brainFiles, historyPath
    }]
  })
}

function sourceForDescriptor(descriptor: SourceDescriptor): SourceRef {
  const fingerprint = sourceFingerprint(descriptor)
  return {
    kind: 'composite-directory',
    providerId: PROVIDER_ID,
    stableId: `antigravity:${descriptor.surface}:${descriptor.conversationId}`,
    rootUri: pathToFileURL(descriptor.root).href,
    memberUris: descriptorMembers(descriptor).map((member) => pathToFileURL(member).href),
    displayLocator: descriptor.primaryPath,
    fingerprint
  }
}

function rawFingerprint(value: string | Buffer): Fingerprint {
  return { algorithm: 'sha256', value: createHash('sha256').update(value).digest('hex') }
}

function cleanUserContent(content: string): string {
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)
  if (match) return match[1].trim()
  return content
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?(?:<\/ADDITIONAL_METADATA>|$)/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?(?:<\/USER_SETTINGS_CHANGE>|$)/g, '')
    .trim()
}

function modelChange(content: string): string | null {
  const block = content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/)?.[1]
  const match = block?.match(/Model Selection`?\s+from\s+.+?\s+to\s+([^\n`]+?)(?:\.\s*$|$)/i)
  return match?.[1]?.trim() || null
}

function semanticToolId(rawName: string): string {
  if (/subagent|send_message|manage_subagents/.test(rawName)) return 'agent'
  if (/command|shell/.test(rawName)) return 'shell'
  if (/read|view|list/.test(rawName)) return 'read'
  if (/write|replace|edit/.test(rawName)) return 'edit'
  if (/search|grep/.test(rawName)) return 'search'
  if (/ask_question/.test(rawName)) return 'question'
  if (/permission/.test(rawName)) return 'permission'
  return 'unknown'
}

function extractJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') { inString = true; continue }
    if (character === '{') {
      if (depth === 0) start = index
      depth++
    } else if (character === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1))
          if (isObject(value)) objects.push(value)
        } catch { /* malformed blocks remain in the tool-result text */ }
        start = -1
      }
    }
    if (objects.length >= 64) break
  }
  return objects
}

function subagentIds(content: string): string[] {
  return [...new Set(extractJsonObjects(content).flatMap((object) => {
    const direct = optionalString(object.conversationId)
    const nested = isObject(object.result) ? optionalString(object.result.conversationId) : null
    return [direct, nested].filter((value): value is string => Boolean(value) && isSafeConversationId(value!))
  }))]
}

function factBase(options: Pick<NormalizedFact, 'sourceRecordId' | 'timestamp' | 'actor' | 'kind' | 'payload'> &
  Partial<Pick<NormalizedFact, 'rawFingerprint' | 'visibility' | 'classification' | 'messageId' | 'messageBlockIndex'>>
): NormalizedFact {
  return {
    rawFingerprint: null,
    visibility: 'primary',
    classification: 'user-content',
    messageId: null,
    messageBlockIndex: null,
    ...options
  }
}

function parseJsonl(descriptor: SourceDescriptor, facts: NormalizedFact[], diagnostics: Diagnostic[]): boolean {
  if (!descriptor.transcriptPath) return false
  const text = fs.readFileSync(descriptor.transcriptPath, 'utf8')
  const lines = text.split(/\r?\n/)
  const pendingCalls: Array<{ callId: string; sourceRecordId: string }> = []
  let claimed = 0
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const raw = lines[lineIndex]
    if (!raw.trim()) continue
    let value: unknown
    try { value = JSON.parse(raw) } catch {
      diagnostics.push({ level: 'warning', code: 'antigravity-jsonl-malformed', message: `Skipped malformed JSONL row ${lineIndex + 1}.`, eventId: null })
      continue
    }
    if (!isObject(value) || optionalInteger(value.step_index) === null || !optionalString(value.type)) {
      diagnostics.push({ level: 'warning', code: 'antigravity-jsonl-foreign-row', message: `Row ${lineIndex + 1} lacks step_index/type and was not claimed.`, eventId: null })
      continue
    }
    claimed++
    const type = String(value.type)
    const stepIndex = value.step_index as number
    const record = `jsonl:${stepIndex}:${lineIndex}`
    const timestamp = isoTimestamp(value.created_at)
    const fingerprint = rawFingerprint(raw)
    const content = typeof value.content === 'string' ? value.content : ''
    const messageId = `agy-message:${stepIndex}`
    if (type === 'USER_INPUT') {
      const textContent = cleanUserContent(content)
      if (textContent) facts.push({
        ...factBase({ sourceRecordId: record, timestamp, actor: 'user', kind: 'message.text', payload: { text: textContent }, rawFingerprint: fingerprint, messageId })
      })
      const toModel = modelChange(content)
      if (toModel) facts.push(factBase({
        sourceRecordId: `${record}:model`, timestamp, actor: 'system', kind: 'model.changed',
        payload: { fromModelId: null, toModelId: toModel }, rawFingerprint: fingerprint,
        visibility: 'collapsed', classification: 'lifecycle'
      }))
    } else if (type === 'PLANNER_RESPONSE') {
      let blockIndex = 0
      if (typeof value.thinking === 'string' && value.thinking.trim()) {
        const thinking = value.thinking.trim()
        facts.push({
          ...factBase({ sourceRecordId: `${record}:thinking`, timestamp, actor: 'assistant', kind: 'message.thinking', payload: { text: thinking }, rawFingerprint: fingerprint, messageId, messageBlockIndex: blockIndex++ })
        })
      }
      if (content.trim()) {
        facts.push({
          ...factBase({ sourceRecordId: `${record}:text`, timestamp, actor: 'assistant', kind: 'message.text', payload: { text: content.trim() }, rawFingerprint: fingerprint, messageId, messageBlockIndex: blockIndex++ })
        })
      }
      if (Array.isArray(value.tool_calls)) {
        value.tool_calls.forEach((rawCall, callIndex) => {
          if (!isObject(rawCall)) return
          const rawName = optionalString(rawCall.name)
          if (!rawName) return
          const callId = optionalString(rawCall.id) || `agy:${descriptor.conversationId}:${stepIndex}:tool:${callIndex}`
          const input = jsonValue(rawCall.args ?? {})
          const sourceRecordId = `${record}:tool:${callIndex}`
          facts.push({
            ...factBase({
              sourceRecordId, timestamp, actor: 'assistant', kind: 'tool.call', rawFingerprint: fingerprint,
              payload: { callId, rawName, semanticToolId: semanticToolId(rawName), input },
              messageId, messageBlockIndex: blockIndex++
            })
          })
          pendingCalls.push({ callId, sourceRecordId })
        })
      }
    } else if (type === 'CHECKPOINT') {
      facts.push({
        ...factBase({
          sourceRecordId: record, timestamp, actor: 'system', kind: 'session.lifecycle',
          payload: { phase: content.trim() ? `checkpoint: ${content.trim()}` : 'checkpoint' },
          rawFingerprint: fingerprint, visibility: 'collapsed', classification: 'lifecycle'
        })
      })
    } else if (type === 'CONVERSATION_HISTORY') {
      facts.push(factBase({
        sourceRecordId: record, timestamp, actor: 'system', kind: 'unknown',
        payload: { rawType: type, rawPayload: jsonValue(value) }, rawFingerprint: fingerprint,
        visibility: 'hidden-noise', classification: 'noise'
      }))
    } else if (TOOL_RESULT_STEP_TYPES.has(type) || optionalString(value.tool_call_id)) {
      const explicitCallId = optionalString(value.tool_call_id) || optionalString(value.execution_id)
      const pendingIndex = explicitCallId ? pendingCalls.findIndex((entry) => entry.callId === explicitCallId) : 0
      const pending = pendingIndex >= 0 ? pendingCalls.splice(pendingIndex, 1)[0] : null
      const callId = explicitCallId || pending?.callId || `agy:${descriptor.conversationId}:${stepIndex}:orphan`
      if (!explicitCallId && pending) diagnostics.push({
        level: 'info', code: 'antigravity-tool-result-fifo-derived',
        message: `Step ${stepIndex} has no call id; paired with the oldest pending tool call.`, eventId: null
      })
      const isError = String(value.status || '').toUpperCase() === 'ERROR'
      facts.push({
        ...factBase({
          sourceRecordId: record, timestamp, actor: 'tool', kind: 'tool.result', rawFingerprint: fingerprint,
          payload: { callId, output: content, isError, state: pending || explicitCallId ? (isError ? 'error' : 'complete') : 'orphan' },
          classification: 'unknown'
        })
      })
      if (type === 'INVOKE_SUBAGENT') {
        for (const childConversationId of subagentIds(content)) {
          facts.push({
            ...factBase({
              sourceRecordId: `${record}:child:${childConversationId}`, timestamp, actor: 'subagent', kind: 'subagent.spawn',
              payload: { agentId: childConversationId, parentAgentId: descriptor.conversationId },
              rawFingerprint: fingerprint, classification: 'lifecycle'
            })
          })
        }
      }
    } else {
      facts.push(factBase({
        sourceRecordId: record, timestamp, actor: String(value.source).toUpperCase() === 'SYSTEM' ? 'system' : 'unknown',
        kind: 'unknown', payload: { rawType: type, rawPayload: jsonValue(value) }, rawFingerprint: fingerprint,
        visibility: 'collapsed', classification: String(value.source).toUpperCase() === 'SYSTEM' ? 'promoted-system' : 'unknown'
      }))
    }
  }
  if (claimed === 0) throw new Error('antigravity-transcript-has-no-step-records')
  return true
}

function readVarint(bytes: Buffer, start: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  for (let index = start; index < bytes.length && index < start + 10; index++) {
    const byte = bytes[index]
    value += (byte & 0x7f) * (2 ** shift)
    if (!Number.isSafeInteger(value)) return null
    if ((byte & 0x80) === 0) return { value, next: index + 1 }
    shift += 7
  }
  return null
}

function parseProto(bytes: Buffer, depth = 0, budget = { fields: MAX_PROTO_FIELDS }): ProtoField[] | null {
  if (depth > MAX_PROTO_DEPTH) return null
  const fields: ProtoField[] = []
  let position = 0
  while (position < bytes.length) {
    if (budget.fields-- <= 0) return null
    const tag = readVarint(bytes, position)
    if (!tag) return null
    position = tag.next
    const number = Math.floor(tag.value / 8)
    const wire = tag.value & 7
    if (number <= 0 || number > 100_000) return null
    if (wire === 0) {
      const decoded = readVarint(bytes, position)
      if (!decoded) return null
      position = decoded.next
      fields.push({ number, wire, varint: decoded.value, bytes: null, nested: null })
    } else if (wire === 1) {
      if (position + 8 > bytes.length) return null
      fields.push({ number, wire, varint: null, bytes: bytes.subarray(position, position + 8), nested: null })
      position += 8
    } else if (wire === 2) {
      const length = readVarint(bytes, position)
      if (!length || length.value > bytes.length - length.next) return null
      position = length.next
      const child = bytes.subarray(position, position + length.value)
      position += length.value
      const nested = child.length > 0 ? parseProto(child, depth + 1, budget) : null
      fields.push({ number, wire, varint: null, bytes: child, nested: nested?.length ? nested : null })
    } else if (wire === 5) {
      if (position + 4 > bytes.length) return null
      fields.push({ number, wire, varint: null, bytes: bytes.subarray(position, position + 4), nested: null })
      position += 4
    } else return null
  }
  return fields
}

function nestedFields(fields: ProtoField[]): ProtoField[][] {
  const result: ProtoField[][] = [fields]
  for (const field of fields) if (field.nested) result.push(...nestedFields(field.nested))
  return result
}

function printableString(bytes: Buffer | null): string | null {
  if (!bytes) return null
  const value = bytes.toString('utf8')
  if (!value || value.includes('\u0000') || value.includes('\ufffd') || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return null
  return value.trim() || null
}

function protoTimestamp(fields: ProtoField[]): string | null {
  for (const group of nestedFields(fields)) {
    if (group.some((field) => field.wire !== 0 || ![1, 2].includes(field.number))) continue
    const seconds = group.find((field) => field.number === 1)?.varint
    const nanos = group.find((field) => field.number === 2)?.varint || 0
    if (seconds !== null && seconds !== undefined && seconds > 946684800 && seconds < 4102444800 && nanos < 1_000_000_000) {
      return new Date(seconds * 1000 + Math.floor(nanos / 1_000_000)).toISOString()
    }
  }
  return null
}

function protoHumanText(fields: ProtoField[]): string | null {
  const topLevel = fields.filter((field) => field.number === 17).map((field) => printableString(field.bytes)).find(Boolean)
  if (topLevel) return topLevel
  return nestedFields(fields).flatMap((group) => group.map((field) => printableString(field.bytes)))
    .find((value) => Boolean(value) && value!.length >= 4 && !KNOWN_TOOL_NAMES.has(value!)) || null
}

function protoTools(fields: ProtoField[], stepIndex: number): Array<{ callId: string; rawName: string; input: JsonValue }> {
  const strings = nestedFields(fields).flatMap((group) => group.map((field) => printableString(field.bytes)).filter(Boolean)) as string[]
  return strings.flatMap((value, index) => {
    if (!KNOWN_TOOL_NAMES.has(value)) return []
    const nearby = strings.slice(Math.max(0, index - 2), index + 3)
    const callId = nearby.find((item) => /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(item)) || `agy-db:${stepIndex}:${index}`
    const rawInput = nearby.find((item) => item.trim().startsWith('{'))
    let input: JsonValue = {}
    if (rawInput) {
      try { input = jsonValue(JSON.parse(rawInput)) } catch { input = { raw: rawInput } }
    }
    return [{ callId, rawName: value, input }]
  }).filter((call, index, all) => all.findIndex((entry) => entry.callId === call.callId && entry.rawName === call.rawName) === index)
}

function protoUsage(bytes: Buffer): { uncachedInput: number; output: number; cacheRead: number; model: string | null } | null {
  const fields = parseProto(bytes)
  if (!fields) return null
  for (const group of nestedFields(fields)) {
    const one = group.find((field) => field.number === 1 && field.wire === 0)?.varint
    const two = group.find((field) => field.number === 2 && field.wire === 0)?.varint
    const three = group.find((field) => field.number === 3 && field.wire === 0)?.varint
    const five = group.find((field) => field.number === 5 && field.wire === 0)?.varint || 0
    if (one === null || one === undefined || two === null || two === undefined || three === null || three === undefined) continue
    if (one < 1000 || one >= 5000 || two > MAX_PLAUSIBLE_TOKENS || three > MAX_PLAUSIBLE_TOKENS ||
      two + three > MAX_PLAUSIBLE_TOKENS || five > MAX_PLAUSIBLE_TOKENS) continue
    const model = nestedFields(fields).flatMap((candidate) => candidate
      .filter((field) => [19, 21].includes(field.number))
      .map((field) => printableString(field.bytes))).find(Boolean) || null
    return { uncachedInput: two, output: three, cacheRead: five, model }
  }
  return null
}

function sqliteSchemaFingerprint(database: Database.Database): string {
  const hash = createHash('sha256')
  const rows = database.prepare(`
    SELECT sql FROM sqlite_master
    WHERE sql IS NOT NULL ORDER BY type, name
  `).all() as Array<{ sql: string }>
  for (const row of rows) hash.update(row.sql).update('\n')
  hash.update(String(database.pragma('user_version', { simple: true }) as number)).update('\n')
  return hash.digest('hex')
}

function parseSqlite(
  descriptor: SourceDescriptor,
  facts: NormalizedFact[],
  diagnostics: Diagnostic[],
  options: { includeMessagesAndTools?: boolean } = {}
): boolean {
  if (!descriptor.databasePath) return false
  const database = new Database(descriptor.databasePath, { readonly: true, fileMustExist: true, timeout: 3_000 })
  try {
    database.pragma('query_only = ON')
    const schemaFingerprint = sqliteSchemaFingerprint(database)
    if (schemaFingerprint !== KNOWN_SQLITE_SCHEMA_SHA256) {
      diagnostics.push({
        level: 'warning', code: 'antigravity-sqlite-schema-unrecognized',
        message: `SQLite schema ${schemaFingerprint.slice(0, 12)} is not the pinned 1.0.7-1.0.10 schema; protobuf rows were not guessed.`,
        eventId: null
      })
      return false
    }
    const usageRows = new Map<number, Buffer>()
    try {
      for (const row of database.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx').all() as Array<{ idx: number; data: Buffer }>) {
        if (Buffer.isBuffer(row.data)) usageRows.set(row.idx, row.data)
      }
    } catch { /* known schema should have it; empty/missing usage stays unavailable */ }
    const rows = database.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all() as Array<{
      idx: number; step_type: number; step_payload: Buffer
    }>
    for (const row of rows) {
      if (!Buffer.isBuffer(row.step_payload)) {
        diagnostics.push({ level: 'warning', code: 'antigravity-sqlite-step-invalid', message: `Step ${row.idx} has no protobuf payload.`, eventId: null })
        continue
      }
      const fields = parseProto(row.step_payload)
      if (!fields) {
        diagnostics.push({ level: 'warning', code: 'antigravity-sqlite-protobuf-invalid', message: `Step ${row.idx} protobuf could not be decoded.`, eventId: null })
        continue
      }
      const timestamp = protoTimestamp(fields)
      const text = protoHumanText(fields)
      const fingerprint = rawFingerprint(row.step_payload)
      const role = row.step_type === 14 ? 'user' : [15, 17].includes(row.step_type) ? 'assistant' : 'system'
      const messageSourceRecordId = `sqlite:${row.idx}:text`
      if (text && options.includeMessagesAndTools !== false) {
        facts.push({
          ...factBase({
            sourceRecordId: messageSourceRecordId, timestamp, actor: role, kind: 'message.text',
            payload: { text }, rawFingerprint: fingerprint, messageId: `agy-db-message:${row.idx}`
          })
        })
      }
      if (role === 'assistant' && options.includeMessagesAndTools !== false) {
        protoTools(fields, row.idx).forEach((tool, toolIndex) => facts.push({
          ...factBase({
            sourceRecordId: `sqlite:${row.idx}:tool:${toolIndex}`, timestamp, actor: 'assistant', kind: 'tool.call',
            payload: { callId: tool.callId, rawName: tool.rawName, semanticToolId: semanticToolId(tool.rawName), input: tool.input },
            rawFingerprint: fingerprint, messageId: `agy-db-message:${row.idx}`, messageBlockIndex: toolIndex + 1
          })
        }))
      }
      const usageBytes = usageRows.get(row.idx)
      const usage = usageBytes ? protoUsage(usageBytes) : null
      if (usage) {
        const usageRecord: UsageRecordV2 = {
          eventId: `agy-db-usage:${row.idx}`,
          turnId: `agy-db-turn:${row.idx}`,
          modelId: usage.model,
          input: {
            total: usage.uncachedInput + usage.cacheRead,
            uncached: usage.uncachedInput,
            cacheRead: usage.cacheRead,
            cacheWrite5m: null,
            cacheWrite1h: null
          },
          output: { total: usage.output, visible: null, reasoning: null },
          providerTotal: usage.uncachedInput + usage.cacheRead + usage.output,
          aggregation: 'per-turn',
          relations: { cacheRead: 'subset-of-input', cacheWrite: 'provider-defined', reasoning: 'provider-defined' },
          dedupKey: `antigravity:${descriptor.surface}:${descriptor.conversationId}:gen:${row.idx}`,
          billingFactKey: `antigravity:${descriptor.surface}:${descriptor.conversationId}:gen:${row.idx}`,
          measurement: {
            source: 'derived', confidence: 'high',
            sourceField: 'gen_metadata.data (pinned reverse-engineered mapping: f2 input, f3 output, f5 cache-read)'
          },
          cost: null,
          priceRevision: null
        }
        facts.push({
          ...factBase({
            sourceRecordId: `sqlite:${row.idx}:usage`, timestamp, actor: 'assistant', kind: 'usage',
            payload: jsonValue(usageRecord), rawFingerprint: rawFingerprint(usageBytes!)
          }),
          usage: usageRecord
        })
      } else if (usageBytes) {
        diagnostics.push({
          level: 'warning', code: 'antigravity-gen-metadata-undecodable',
          message: `gen_metadata row ${row.idx} exists but has no validated token block; usage remains unavailable.`, eventId: null
        })
      }
    }
    return rows.length > 0
  } finally {
    database.close()
  }
}

function parseMarkdown(descriptor: SourceDescriptor, facts: NormalizedFact[], diagnostics: Diagnostic[]): void {
  const historyTimestamp = readHistoryRows(descriptor.historyPath, descriptor.conversationId)
    .map((row) => row.timestamp)
    .find((timestamp): timestamp is string => Boolean(timestamp)) || null
  for (const markdownPath of descriptor.brainFiles.filter((candidate) => candidate.endsWith('.md'))) {
    const stat = fs.statSync(markdownPath)
    if (stat.size > MAX_MARKDOWN_BYTES) {
      diagnostics.push({ level: 'warning', code: 'antigravity-markdown-too-large', message: `Skipped oversized artifact ${path.basename(markdownPath)}.`, eventId: null })
      continue
    }
    const text = fs.readFileSync(markdownPath, 'utf8').trim()
    if (!text) continue
    const relative = path.relative(descriptor.root, markdownPath).split(path.sep).join('/')
    const uri = pathToFileURL(markdownPath).href
    const fingerprint = rawFingerprint(text)
    // mtime is neither provider-authored nor part of the content fingerprint.
    // The matching history row is provider-authored and fingerprinted, so it
    // is the only deterministic fallback available for generated artifacts.
    const timestamp = historyTimestamp
    facts.push({
      ...factBase({
        sourceRecordId: `markdown:${relative}`, timestamp, actor: 'assistant', kind: 'message.text',
        payload: { text: `[Antigravity artifact: ${path.basename(markdownPath)}]\n${text}` },
        rawFingerprint: fingerprint, visibility: 'collapsed', classification: 'promoted-system'
      })
    })
    facts.push({
      ...factBase({
        sourceRecordId: `markdown:${relative}:artifact`, timestamp, actor: 'assistant', kind: 'artifact',
        payload: { uri, action: 'reference', exists: true, fingerprint }, rawFingerprint: fingerprint,
        visibility: 'collapsed', classification: 'promoted-system'
      })
    })
  }
}

function parseBundle(source: SourceRef, fingerprint: Fingerprint): ParsedBundle {
  const descriptor = descriptorFromSource(source)
  const before = sourceFingerprint(descriptor)
  if (before.algorithm !== fingerprint.algorithm || before.value !== fingerprint.value ||
    JSON.stringify(before.inputs || []) !== JSON.stringify(fingerprint.inputs || [])) {
    throw new Error('antigravity-source-changed-before-parse')
  }
  const facts: NormalizedFact[] = []
  const diagnostics: Diagnostic[] = []
  let primaryParsed = false
  let formatVersion = ARTIFACT_FORMAT
  if (descriptor.transcriptPath) {
    primaryParsed = parseJsonl(descriptor, facts, diagnostics)
    formatVersion = JSONL_FORMAT
    if (descriptor.databasePath) {
      try {
        parseSqlite(descriptor, facts, diagnostics, { includeMessagesAndTools: false })
      } catch (error) {
        diagnostics.push({
          level: 'warning', code: 'antigravity-sqlite-auxiliary-read-failed',
          message: `The transcript was preserved, but auxiliary SQLite usage metadata could not be read: ${error instanceof Error ? error.message : String(error)}`,
          eventId: null
        })
      }
    }
  } else if (descriptor.databasePath) {
    primaryParsed = parseSqlite(descriptor, facts, diagnostics)
    formatVersion = SQLITE_FORMAT
  } else if (descriptor.encryptedProtoPath) {
    formatVersion = ENCRYPTED_PROTO_FORMAT
    diagnostics.push({
      level: 'warning', code: 'antigravity-encrypted-protobuf-unavailable',
      message: 'Encrypted legacy protobuf is detected but no published key/schema contract exists; Swob does not guess or request a secret.',
      eventId: null
    })
    facts.push(factBase({
      sourceRecordId: 'encrypted-protobuf:unavailable', timestamp: null, actor: 'system',
      kind: 'session.lifecycle', payload: { phase: 'unsupported-encrypted-protobuf' },
      visibility: 'collapsed', classification: 'lifecycle'
    }))
  }
  parseMarkdown(descriptor, facts, diagnostics)
  const history = readHistoryRows(descriptor.historyPath, descriptor.conversationId)
  if (!primaryParsed && !facts.some((fact) => fact.kind === 'message.text') && history.length > 0) {
    history.forEach((row, index) => {
      if (!row.display) return
      facts.push({
        ...factBase({
          sourceRecordId: `history:${index}:${providerFingerprint(row.raw)}`, timestamp: row.timestamp,
          actor: 'user', kind: 'message.text', payload: { text: row.display }, rawFingerprint: rawFingerprint(row.raw)
        })
      })
    })
  }
  const after = sourceFingerprint(descriptor)
  if (after.value !== before.value || JSON.stringify(after.inputs || []) !== JSON.stringify(before.inputs || [])) {
    throw new Error('antigravity-source-changed-during-parse')
  }
  const timestamps = facts.flatMap((fact) => fact.timestamp ? [fact.timestamp] : []).sort()
  const historyWorkspace = history.map((row) => row.workspace).find(Boolean) || null
  const title = facts.find((fact) => fact.actor === 'user' && fact.kind === 'message.text')
    ? String((facts.find((fact) => fact.actor === 'user' && fact.kind === 'message.text')!.payload as { text: string }).text).slice(0, 200)
    : history.map((row) => row.display).find(Boolean) || null
  return {
    source: { ...source, fingerprint: after } as SourceRef,
    descriptor,
    fingerprint: after,
    formatVersion,
    title,
    projectPath: historyWorkspace,
    createdAt: timestamps[0] || null,
    updatedAt: timestamps.at(-1) || null,
    facts,
    diagnostics,
    partial: diagnostics.some((diagnostic) => diagnostic.level === 'warning')
  }
}

function v2Identity(bundle: ParsedBundle): ParseChunk['identity'] {
  const key = `antigravity:${bundle.descriptor.surface}:${bundle.descriptor.conversationId}`
  return {
    physicalSourceId: bundle.source.stableId,
    logicalSessionKey: key,
    logicalSessionId: bundle.descriptor.conversationId,
    branchViewId: `${key}:main`,
    parentBranchViewId: null
  }
}

function v2Events(bundle: ParsedBundle): CanonicalEvent[] {
  const identity = v2Identity(bundle)
  const metadataFacts: NormalizedFact[] = [
    ...(bundle.title ? [factBase({
      sourceRecordId: 'metadata:title', timestamp: null, actor: 'system', kind: 'session.lifecycle',
      payload: { phase: `metadata.title:${bundle.title}` }, visibility: 'hidden-noise', classification: 'lifecycle'
    })] : []),
    ...(bundle.projectPath ? [factBase({
      sourceRecordId: 'metadata:cwd', timestamp: null, actor: 'system', kind: 'session.lifecycle',
      payload: { phase: `metadata.cwd:${bundle.projectPath}` }, visibility: 'hidden-noise', classification: 'lifecycle'
    })] : [])
  ]
  const unavailableFacts = bundle.facts.length === 0 ? [factBase({
    sourceRecordId: 'parse:unavailable', timestamp: null, actor: 'system', kind: 'session.lifecycle',
    payload: { phase: `unavailable:${bundle.diagnostics[0]?.code || 'no-parseable-session'}` },
    visibility: 'collapsed', classification: 'lifecycle'
  })] : []
  return [...metadataFacts, ...bundle.facts, ...unavailableFacts].map((fact, sequence): CanonicalEvent => ({
    id: `agy:${providerFingerprint(`${bundle.source.stableId}\0${fact.sourceRecordId}\0${fact.kind}`)}`,
    identity,
    sharedEventKey: `antigravity:${providerFingerprint(`${bundle.descriptor.conversationId}\0${fact.sourceRecordId}`)}`,
    messageId: fact.messageId,
    sequence,
    messageBlockIndex: fact.messageBlockIndex,
    timestamp: fact.timestamp,
    actor: fact.actor,
    kind: fact.kind,
    payload: fact.payload,
    visibility: fact.visibility,
    classification: fact.classification,
    timeline: {
      archived: true,
      modelContext: [{ contextRevision: 0, state: 'unknown', fromSequence: sequence, untilSequence: null }]
    },
    provenance: {
      providerId: PROVIDER_ID,
      sourceRefId: bundle.source.stableId,
      parserDataVersion: PARSER_DATA_VERSION,
      formatVersion: bundle.formatVersion,
      observedAt: fact.timestamp,
      sourceRecordId: fact.sourceRecordId,
      rawRecordFingerprint: fact.rawFingerprint
    },
    rawRef: null
  }))
}

export function antigravityV2Chunks(bundle: ParsedBundle, maxEvents = 1024): ParseChunk[] {
  const events = v2Events(bundle)
  if (events.length === 0) return []
  const chunks: ParseChunk[] = []
  for (let start = 0; start < events.length; start += maxEvents) {
    const chunkIndex = chunks.length
    const page = events.slice(start, start + maxEvents)
    const done = start + maxEvents >= events.length
    chunks.push({
      providerId: PROVIDER_ID,
      parserDataVersion: PARSER_DATA_VERSION,
      formatVersion: bundle.formatVersion,
      fingerprint: bundle.fingerprint,
      identity: v2Identity(bundle),
      mode: 'replace',
      chunkIndex,
      previousCursor: chunkIndex === 0 ? null : `antigravity:${chunkIndex - 1}`,
      cursor: done ? null : `antigravity:${chunkIndex}`,
      done,
      events: page,
      diagnostics: chunkIndex === 0 ? bundle.diagnostics : []
    })
  }
  return chunks
}

export const ANTIGRAVITY_MANIFEST_V2: ProviderManifestV2 = {
  schemaVersion: 2,
  providerId: PROVIDER_ID,
  displayName: 'Antigravity',
  implementationVersion: 'builtin-v2',
  parserDataVersion: PARSER_DATA_VERSION,
  formatVersions: [JSONL_FORMAT, SQLITE_FORMAT, ARTIFACT_FORMAT, ENCRYPTED_PROTO_FORMAT],
  capabilities: Object.fromEntries([
    ['discover', 'available', null, 'PPV2-ANTIGRAVITY-DISCOVERY'],
    ['summary', 'available', null, 'PPV2-ANTIGRAVITY-SUMMARY'],
    ['transcript', 'available', null, 'PPV2-ANTIGRAVITY-TRANSCRIPT'],
    ['tools', 'available', null, 'PPV2-ANTIGRAVITY-TOOLS'],
    ['thinking', 'available', null, 'PPV2-ANTIGRAVITY-THINKING'],
    ['usage', 'experimental', 'Only pinned known-schema gen_metadata is decoded; chars/4 is never used.', 'PPV2-ANTIGRAVITY-USAGE'],
    ['relationships', 'experimental', 'Only structured subagent conversationId relationships are linked.', 'PPV2-ANTIGRAVITY-RELATIONSHIPS'],
    ['subagents', 'experimental', 'Synthetic conformance is complete; a real installed-version sample is still required.', 'PPV2-ANTIGRAVITY-SUBAGENTS'],
    ['interactions', 'unavailable', 'No independently verified historical interaction response schema is available.', 'PPV2-ANTIGRAVITY-INTERACTIONS-UNAVAILABLE'],
    ['permissions', 'unavailable', 'Permission steps are preserved as tools/unknown facts; no verified request/response schema is available.', 'PPV2-ANTIGRAVITY-PERMISSIONS-UNAVAILABLE'],
    ['context-timeline', 'experimental', 'Checkpoint stages are preserved, but no archived-through compaction boundary is reported.', 'PPV2-ANTIGRAVITY-CONTEXT'],
    ['identity', 'available', null, 'PPV2-ANTIGRAVITY-IDENTITY'],
    ['chunked-transport', 'available', null, 'PPV2-ANTIGRAVITY-CHUNKS'],
    ['terminal-resume', 'experimental', 'Requires agy binary/help/source preflight and post-launch anchor verification.', 'PPV2-ANTIGRAVITY-RESUME'],
    ['native-resume', 'not-applicable', 'No verified per-session desktop deep link is published.', 'PPV2-ANTIGRAVITY-NATIVE-RESUME-NA'],
    ['format-provenance', 'available', null, 'PPV2-ANTIGRAVITY-PROVENANCE']
  ].map(([name, status, reason, conformanceTestId]) => [name, {
    status,
    reason,
    evidence: [{
      kind: status === 'unavailable' || status === 'not-applicable' ? 'missing' : 'test',
      fixture: 'testdata/antigravity/',
      conformanceTestId,
      locator: status === 'unavailable' || status === 'not-applicable'
        ? 'src/main/providers/antigravity-provider.ts#ANTIGRAVITY_CAPABILITY_MATRIX'
        : 'src/main/providers/antigravity-provider.test.ts'
    }]
  }])) as ProviderManifestV2['capabilities'],
  resumeContract: {
    mode: 'native-cli',
    supportedSurfaces: ['terminal', 'antigravity-cli'],
    supportsSubagent: false,
    idTransform: null,
    preflight: ['binary', 'version', 'help-capability', 'source-exists'],
    commandTemplate: 'agy --conversation {sessionId}',
    expectedSideEffects: ['append-source-after-launch'],
    postcondition: 'unverifiable'
  }
}

export function createAntigravityProvider(options: AntigravityProviderOptions): BuiltinProviderRuntimeV2 {
  const roots = options.roots || [
    path.join(options.homeDir, '.gemini', 'antigravity'),
    path.join(options.homeDir, '.gemini', 'antigravity-cli'),
    path.join(options.homeDir, '.gemini', 'antigravity-ide')
  ]
  return {
    manifest: structuredClone(ANTIGRAVITY_MANIFEST_V2),
    async discover(signal) {
      const sources: SourceRef[] = []
      const seen = new Set<string>()
      for (const root of roots) {
        if (signal.aborted) throw new Error('cancelled')
        for (const descriptor of discoverDescriptors(root)) {
          const source = sourceForDescriptor(descriptor)
          if (!seen.has(source.stableId)) {
            seen.add(source.stableId)
            sources.push(source)
          }
        }
      }
      return sources.sort((left, right) => left.stableId.localeCompare(right.stableId))
    },
    async fingerprint(source, signal) {
      if (signal.aborted) throw new Error('cancelled')
      return sourceFingerprint(descriptorFromSource(source))
    },
    async inputBytes(source, signal) {
      if (signal.aborted) throw new Error('cancelled')
      return sourceInputBytes(descriptorFromSource(source))
    },
    async parse(source, fingerprint, signal) {
      if (signal.aborted) throw new Error('cancelled')
      return antigravityV2Chunks(parseBundle(source, fingerprint))
    }
  }
}
