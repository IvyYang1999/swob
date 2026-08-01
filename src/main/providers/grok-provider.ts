import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { SourceRef } from '../../shared/provider-schema.generated'
import type {
  CanonicalEvent,
  CapabilityDeclaration,
  CapabilityEvidence,
  Diagnostic,
  Fingerprint,
  JsonValue,
  ParseChunk,
  ProviderManifest,
  SessionIdentity,
  UsageRecord
} from '../../shared/provider-schema-v2.generated'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'

const PROVIDER_ID = 'swob/grok'
const PARSER_DATA_VERSION = '2'
const FORMAT_V0 = 'grok-build-composite-v0'
const FORMAT_V1 = 'grok-build-composite-v1'
const FORMAT_MIXED = 'grok-build-composite-mixed-v0-v1'
const USD_TICKS_PER_USD = 10_000_000_000
const MEMBER_NAMES = ['summary.json', 'chat_history.jsonl', 'updates.jsonl'] as const
const FIXTURE = 'testdata/grok/compacted-session'
const CONFORMANCE_TEST = 'grok-provider-v2-conformance'
const UPSTREAM_COMMIT = '7cfcb20d2b50b0d18801a6c0af2e401c0e060894'

export type GrokCapabilityAccuracy = 'exact' | 'derived' | 'estimated' | 'unavailable'

export const GROK_EIGHT_LAYER_CAPABILITY_MATRIX = {
  discovery: { accuracy: 'exact', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'Composite session directories and their three named members are discovered without content inference.' },
  metadata: { accuracy: 'exact', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'Session id, cwd, title, timestamps, model and parent id come from summary.json.' },
  messages: { accuracy: 'derived', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'Cleartext history and append-only updates are normalized and merged; compacted history is reconstructed at the prompt-index cutoff.' },
  tools: { accuracy: 'derived', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'Calls and results may be paired across chat_history.jsonl and updates.jsonl.' },
  context: { accuracy: 'derived', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'Compaction membership is reconstructed from compaction_meta plus surviving prompt indexes.' },
  usage: { accuracy: 'exact', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'Reported per-turn/per-model counters preserve cache-read and reasoning subset semantics; missing counters remain null.' },
  relationships: { accuracy: 'exact', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'parent_session_id is preserved as a fork relationship when present.' },
  resume: { accuracy: 'unavailable', fixture: FIXTURE, conformanceTestId: CONFORMANCE_TEST, reason: 'The current build machine has no grok binary, so binary/help/source/post-launch anchor checks cannot be completed.' }
} as const satisfies Record<string, {
  accuracy: GrokCapabilityAccuracy
  fixture: string
  conformanceTestId: string
  reason: string
}>

interface GrokProviderOptions {
  homeDir: string
  roots?: string[]
}

interface LoadedMember {
  name: typeof MEMBER_NAMES[number]
  filePath: string
  bytes: Buffer
  fingerprint: string
}

interface SummaryRecord {
  info?: { id?: unknown; cwd?: unknown }
  session_summary?: unknown
  generated_title?: unknown
  created_at?: unknown
  updated_at?: unknown
  current_model_id?: unknown
  session_kind?: unknown
  parent_session_id?: unknown
  chat_format_version?: unknown
}

interface JsonlRecord {
  line: number
  raw: string
  value: Record<string, unknown>
}

interface ToolState {
  callId: string
  rawName: string
  input: JsonValue
  output: JsonValue | null
  status: string | null
  timestamp: string | null
  sourceLine: number
  resultTimestamp: string | null
  resultSourceLine: number | null
  resultRaw: string | null
}

interface UsageFact {
  promptIndex: number | null
  promptId: string | null
  modelId: string | null
  timestamp: string | null
  input: number | null
  output: number | null
  cacheRead: number | null
  reasoning: number | null
  providerTotal: number | null
  costTicks: number | null
  costTrusted: boolean
  sourceLine: number
  raw: string
}

interface UpdateContent {
  kind: 'user' | 'reasoning' | 'assistant' | 'tool'
  promptIndex: number | null
  text?: string
  callId?: string
  timestamp: string | null
  sourceLine: number
  raw: string
}

interface DraftEvent {
  phase: 'pre' | 'post'
  actor: CanonicalEvent['actor']
  kind: CanonicalEvent['kind']
  payload: JsonValue
  timestamp: string | null
  messageId: string | null
  messageBlockIndex: number | null
  visibility: CanonicalEvent['visibility']
  classification: CanonicalEvent['classification']
  sourceRecordId: string
  raw: string | null
}

function evidence(kind: CapabilityEvidence['kind'], locator: string, note?: string): CapabilityEvidence {
  return {
    kind,
    fixture: FIXTURE,
    conformanceTestId: CONFORMANCE_TEST,
    locator,
    ...(note ? { note } : {})
  }
}

const providerFixture = evidence('test', 'src/main/providers/grok-provider.test.ts')
const upstream = evidence(
  'upstream-source',
  `https://github.com/xai-org/grok-build/tree/${UPSTREAM_COMMIT}`,
  'Pinned Apache-2.0 upstream source; NOTICE records the exact reference and independent synthetic fixture.'
)
const missingResume = evidence(
  'missing',
  'testdata/grok/NOTICE',
  'No grok executable was present on the build machine; post-launch anchor verification was therefore not possible.'
)

function capability(
  status: CapabilityDeclaration['status'],
  reason: string | null,
  ...items: CapabilityEvidence[]
): CapabilityDeclaration {
  return { status, reason, evidence: items }
}

export const GROK_PROVIDER_MANIFEST_V2: ProviderManifest = {
  schemaVersion: 2,
  providerId: PROVIDER_ID,
  displayName: 'Grok Build',
  implementationVersion: 'builtin-v2',
  parserDataVersion: PARSER_DATA_VERSION,
  formatVersions: [FORMAT_V0, FORMAT_V1, FORMAT_MIXED],
  capabilities: {
    discover: capability('available', null, providerFixture, upstream),
    summary: capability('available', null, providerFixture, upstream),
    transcript: capability('available', null, providerFixture, upstream),
    tools: capability('available', null, providerFixture, upstream),
    thinking: capability(
      'available',
      null,
      evidence('observed-format', 'chat_history.jsonl reasoning.summary / legacy reasoning_content', 'Only persisted cleartext reasoning summaries are emitted; encrypted chain-of-thought is not decoded.'),
      providerFixture
    ),
    usage: capability('available', null, providerFixture, upstream),
    relationships: capability('available', null, providerFixture, upstream),
    subagents: capability('unavailable', 'Parent/fork identity is parsed, but no verified child-agent event stream is available.', providerFixture),
    interactions: capability('unavailable', 'No verified persisted interaction request/response fixture is available.', providerFixture),
    permissions: capability('unavailable', 'No verified persisted permission request/response fixture is available.', providerFixture),
    'context-timeline': capability('available', null, providerFixture, upstream),
    identity: capability('available', null, providerFixture, upstream),
    'chunked-transport': capability('available', null, providerFixture),
    'terminal-resume': capability(
      'unavailable',
      'Upstream documents grok --resume, but this environment cannot complete binary/help/source/post-launch anchor verification.',
      upstream,
      missingResume
    ),
    'native-resume': capability('not-applicable', 'Grok Build exposes a CLI surface, not a verified native desktop deep link.', upstream),
    'format-provenance': capability('available', null, providerFixture, upstream)
  },
  resumeContract: null
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function positiveInteger(value: unknown): number | null {
  const integer = optionalInteger(value)
  return integer !== null && integer > 0 ? integer : null
}

function promptIndex(value: unknown): number | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  return optionalInteger(value)
}

function timestampFromSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const date = new Date(value * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

function stripUserQuery(value: string): string {
  const trimmed = value.trim()
  const match = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>$/.exec(trimmed)
  return (match?.[1] ?? trimmed).trim()
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return stripUserQuery(value)
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  const imagePaths: string[] = []
  for (const child of value) {
    const block = asObject(child)
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    if (!block.text.trimStart().startsWith('<image_files>')) continue
    for (const line of block.text.split(/\r?\n/)) {
      const match = /^\s*\d+\.\s+(\/\S.*?)\s*$/.exec(line)
      if (match) imagePaths.push(match[1])
    }
  }
  let imageIndex = 0
  for (const child of value) {
    const block = asObject(child)
    if (!block) continue
    if (block.type === 'text' && typeof block.text === 'string') {
      if (block.text.trimStart().startsWith('<image_files>')) continue
      const text = stripUserQuery(block.text)
      if (text) parts.push(text)
    } else if (block.type === 'image') {
      parts.push(imagePaths[imageIndex] ? `[Image: source: ${imagePaths[imageIndex++]}]` : '[Image]')
    }
  }
  return parts.join('\n')
}

function parseJsonString(value: unknown): JsonValue {
  if (typeof value !== 'string') return jsonValue(value ?? {})
  try { return jsonValue(JSON.parse(value)) } catch { return value }
}

function nested(object: Record<string, unknown> | null, ...keys: string[]): unknown {
  let current: unknown = object
  for (const key of keys) {
    current = asObject(current)?.[key]
  }
  return current
}

function containsEncryptedReasoning(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsEncryptedReasoning)
  const object = asObject(value)
  if (!object) return false
  const reasoningContainer = ['reasoning', 'thought'].includes(String(object.type || object.role).toLowerCase())
  return Object.entries(object).some(([key, child]) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    if (normalized.includes('encrypted') && (normalized.includes('reason') || normalized.includes('thought'))) return true
    if (reasoningContainer && normalized.includes('encrypted')) return true
    return containsEncryptedReasoning(child)
  })
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function compositeRoot(source: SourceRef): string {
  if (source.kind !== 'composite-directory') throw new Error('grok-provider-requires-composite-directory')
  const root = fileURLToPath(source.rootUri)
  if (!path.isAbsolute(root)) throw new Error('grok-provider-root-must-be-absolute')
  return path.resolve(root)
}

function memberPaths(source: SourceRef): Array<{ name: typeof MEMBER_NAMES[number]; filePath: string }> {
  const root = compositeRoot(source)
  const allowed = new Set<string>(MEMBER_NAMES)
  const members = source.kind === 'composite-directory' ? source.memberUris : []
  const result = members.map((uri) => {
    const filePath = path.resolve(fileURLToPath(uri))
    const name = path.basename(filePath)
    if (!allowed.has(name) || path.dirname(filePath) !== root) throw new Error('grok-provider-member-outside-session-root')
    return { name: name as typeof MEMBER_NAMES[number], filePath }
  })
  result.sort((left, right) => left.name.localeCompare(right.name))
  if (new Set(result.map((entry) => entry.name)).size !== result.length) {
    throw new Error('grok-provider-duplicate-member')
  }
  return result
}

async function loadMembers(source: SourceRef, signal: AbortSignal): Promise<LoadedMember[]> {
  const loaded: LoadedMember[] = []
  for (const member of memberPaths(source)) {
    if (signal.aborted) throw new Error('cancelled')
    const stat = await fs.promises.lstat(member.filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('grok-provider-member-must-be-regular-file')
    const bytes = await fs.promises.readFile(member.filePath, { signal })
    loaded.push({ ...member, bytes, fingerprint: sha256(bytes) })
  }
  return loaded
}

function compositeFingerprint(members: LoadedMember[]): Fingerprint {
  const inputs = members.map((member) => `${member.name}:${member.fingerprint}`)
  return {
    algorithm: 'composite-sha256',
    value: sha256(inputs.join('\n')),
    inputs
  }
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value &&
    JSON.stringify(left.inputs || []) === JSON.stringify(right.inputs || [])
}

async function discoverSessionDirectories(root: string, signal: AbortSignal): Promise<string[]> {
  const directories: string[] = []
  const visited = new Set<string>()
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (signal.aborted) throw new Error('cancelled')
    if (depth > 8) return
    const lexicalDirectory = path.resolve(directory)
    let realDirectory: string
    try { realDirectory = await fs.promises.realpath(lexicalDirectory) } catch (error) {
      if (isMissingPathError(error)) return
      throw error
    }
    if (visited.has(realDirectory)) return
    visited.add(realDirectory)
    const entries = await fs.promises.readdir(lexicalDirectory, { withFileTypes: true })
    if (entries.some((entry) => entry.isFile() && entry.name === 'chat_history.jsonl')) {
      directories.push(lexicalDirectory)
      return
    }
    for (const entry of entries) {
      // A source symlink can escape the IPC capability root. Skip it instead
      // of discovering a card that the detail route must later reject.
      if (entry.name.startsWith('.') || !entry.isDirectory()) continue
      await walk(path.join(lexicalDirectory, entry.name), depth + 1)
    }
  }
  await walk(root, 0)
  return directories
}

async function summaryForDirectory(directory: string, signal: AbortSignal): Promise<SummaryRecord | null> {
  try {
    const bytes = await fs.promises.readFile(path.join(directory, 'summary.json'), { signal })
    return asObject(JSON.parse(bytes.toString('utf8'))) as SummaryRecord | null
  } catch (error) {
    if (isMissingPathError(error) || error instanceof SyntaxError) return null
    throw error
  }
}

async function sourceForDirectory(directory: string, signal: AbortSignal): Promise<{ source: SourceRef; mtimeMs: number }> {
  const summary = await summaryForDirectory(directory, signal)
  const sessionId = nonEmptyString(summary?.info?.id) || path.basename(directory)
  const memberUris: string[] = []
  let mtimeMs = 0
  for (const name of MEMBER_NAMES) {
    const filePath = path.join(directory, name)
    try {
      const stat = await fs.promises.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink()) continue
      memberUris.push(pathToFileURL(filePath).href)
      mtimeMs = Math.max(mtimeMs, stat.mtimeMs)
    } catch (error) {
      if (!isMissingPathError(error)) throw error
    }
  }
  return {
    source: {
      kind: 'composite-directory',
      stableId: `grok:${sessionId.normalize('NFC')}`,
      providerId: PROVIDER_ID,
      rootUri: pathToFileURL(directory).href,
      memberUris,
      displayLocator: directory,
      fingerprint: { algorithm: 'composite-sha256', value: 'pending', inputs: ['pending'] }
    },
    mtimeMs
  }
}

function parseJsonl(bytes: Buffer, member: string, diagnostics: Diagnostic[]): JsonlRecord[] {
  const records: JsonlRecord[] = []
  for (const [index, rawLine] of bytes.toString('utf8').split(/\r?\n/).entries()) {
    const raw = rawLine.trim()
    if (!raw) continue
    try {
      const value = asObject(JSON.parse(raw))
      if (!value) throw new Error('not-object')
      records.push({ line: index + 1, raw, value })
    } catch {
      diagnostics.push({
        level: 'warning',
        code: 'grok-malformed-jsonl-line',
        message: `${member} line ${index + 1} is malformed and was skipped.`,
        eventId: null
      })
    }
  }
  return records
}

function toolOutput(update: Record<string, unknown>): JsonValue | null {
  const blocks = Array.isArray(update.content) ? update.content : []
  const display = blocks.flatMap((candidate) => {
    const block = asObject(candidate)
    const text = nested(block, 'content', 'text')
    return typeof text === 'string' && text ? [text] : []
  }).join('\n')
  if (display) return display
  const raw = update.rawOutput
  const rawObject = asObject(raw)
  const content = nested(rawObject, 'Content', 'content')
  if (typeof content === 'string') return content
  const fileContent = asObject(rawObject?.FileContent)
  if (fileContent) {
    return jsonValue(fileContent.content ?? fileContent.content_concise ?? fileContent.raw_output ?? fileContent)
  }
  const todos = nested(rawObject, 'TodosUpdated', 'summary_for_prompt')
  if (typeof todos === 'string') return todos
  if (rawObject?.Result !== undefined) return jsonValue(rawObject.Result)
  if (rawObject?.MultiResult !== undefined) return jsonValue(rawObject.MultiResult)
  return raw === undefined ? null : jsonValue(raw)
}

class UserRunTracker {
  private seenPromptIndex = false
  private inUserRun = false
  private currentPromptIndex: number | null = null

  onUserChunk(index: number | null): boolean {
    if (index !== null) this.seenPromptIndex = true
    const countsAsPrompt = this.seenPromptIndex ? index !== null : true
    const startsNewRun = !this.inUserRun ||
      ((this.seenPromptIndex || index !== null) && index !== this.currentPromptIndex)

    if (startsNewRun) {
      this.currentPromptIndex = index
      this.inUserRun = true
      return countsAsPrompt
    }

    this.inUserRun = true
    return false
  }

  onNonUser(): void {
    this.inUserRun = false
    this.currentPromptIndex = null
  }
}

function filterRewoundUpdates(records: JsonlRecord[]): JsonlRecord[] {
  const retained: JsonlRecord[] = []
  const promptStarts: number[] = []
  const tracker = new UserRunTracker()

  for (const record of records) {
    const update = asObject(nested(record.value, 'params', 'update'))
    const kind = nonEmptyString(update?.sessionUpdate)
    const target = promptIndex(update?.target_prompt_index)
    if (record.value.method === '_x.ai/session/update' && kind === 'rewind_marker' && target !== null) {
      retained.length = promptStarts[target] ?? retained.length
      promptStarts.length = Math.min(promptStarts.length, target)
      tracker.onNonUser()
      continue
    }

    if (kind === 'user_message_chunk') {
      const index = promptIndex(nested(update, '_meta', 'promptIndex'))
      if (tracker.onUserChunk(index)) promptStarts.push(retained.length)
    } else {
      tracker.onNonUser()
    }
    retained.push(record)
  }

  return retained
}

function scanUpdates(
  records: JsonlRecord[],
  compacted: boolean,
  cutoff: number,
  diagnostics: Diagnostic[]
): {
  contents: UpdateContent[]
  tools: Map<string, ToolState>
  usages: UsageFact[]
  promptTimestamps: Map<number, string>
  promptModels: Map<number, string>
} {
  const contents: UpdateContent[] = []
  const tools = new Map<string, ToolState>()
  const usageByKey = new Map<string, UsageFact>()
  const promptTimestamps = new Map<number, string>()
  const promptModels = new Map<number, string>()
  let currentPrompt: number | null = null
  let encryptedDiagnosticEmitted = false
  const knownBookkeeping = new Set([
    'available_commands_update', 'current_mode_update', 'hook_execution',
    'auto_compact_started', 'auto_compact_completed', 'compaction_checkpoint',
    'retry_state', 'task_backgrounded', 'task_completed', 'subagent_spawned',
    'subagent_finished', 'plan', 'goal_updated', 'session_recap', 'image_compressed'
  ])

  for (const record of filterRewoundUpdates(records)) {
    const update = asObject(nested(record.value, 'params', 'update'))
    const kind = nonEmptyString(update?.sessionUpdate)
    if (!update || !kind) continue
    if (!encryptedDiagnosticEmitted && containsEncryptedReasoning(update)) {
      diagnostics.push({
        level: 'info',
        code: 'grok-encrypted-reasoning-unavailable',
        message: 'Encrypted reasoning bytes were observed and deliberately not decoded or emitted.',
        eventId: null
      })
      encryptedDiagnosticEmitted = true
    }
    const timestamp = timestampFromSeconds(record.value.timestamp)
    if (kind === 'user_message_chunk') {
      const index = promptIndex(nested(update, '_meta', 'promptIndex'))
      currentPrompt = index
      if (index !== null) {
        if (timestamp && !promptTimestamps.has(index)) promptTimestamps.set(index, timestamp)
        const model = nonEmptyString(nested(update, '_meta', 'modelId'))
        if (model) promptModels.set(index, model)
      }
      const text = nonEmptyString(nested(update, 'content', 'text'))
      if (text && compacted && (index === null || index < cutoff)) {
        contents.push({ kind: 'user', promptIndex: index, text, timestamp, sourceLine: record.line, raw: record.raw })
      }
      continue
    }
    if (kind === 'agent_thought_chunk' || kind === 'agent_message_chunk') {
      const text = nonEmptyString(nested(update, 'content', 'text'))
      if (text && compacted && (currentPrompt === null || currentPrompt < cutoff)) {
        contents.push({
          kind: kind === 'agent_thought_chunk' ? 'reasoning' : 'assistant',
          promptIndex: currentPrompt,
          text,
          timestamp,
          sourceLine: record.line,
          raw: record.raw
        })
      }
      continue
    }
    if (kind === 'tool_call') {
      const callId = nonEmptyString(update.toolCallId)
      if (!callId) continue
      const toolMeta = asObject(asObject(update._meta)?.['x.ai/tool'])
      const rawName = nonEmptyString(toolMeta?.name) || nonEmptyString(update.title) || 'unknown'
      const state: ToolState = {
        callId,
        rawName,
        input: jsonValue(update.rawInput ?? {}),
        output: null,
        status: nonEmptyString(update.status),
        timestamp,
        sourceLine: record.line,
        resultTimestamp: null,
        resultSourceLine: null,
        resultRaw: null
      }
      tools.set(callId, state)
      if (compacted && (currentPrompt === null || currentPrompt < cutoff)) {
        contents.push({ kind: 'tool', promptIndex: currentPrompt, callId, timestamp, sourceLine: record.line, raw: record.raw })
      }
      continue
    }
    if (kind === 'tool_call_update') {
      const callId = nonEmptyString(update.toolCallId)
      if (!callId) continue
      const previous = tools.get(callId) || {
        callId,
        rawName: nonEmptyString(update.title) || 'unknown',
        input: {},
        output: null,
        status: null,
        timestamp,
        sourceLine: record.line,
        resultTimestamp: null,
        resultSourceLine: null,
        resultRaw: null
      }
      previous.status = nonEmptyString(update.status) || previous.status
      previous.output = toolOutput(update) ?? previous.output
      previous.resultTimestamp = timestamp || previous.resultTimestamp
      previous.resultSourceLine = record.line
      previous.resultRaw = record.raw
      tools.set(callId, previous)
      continue
    }
    if (kind === 'turn_completed') {
      const usage = asObject(update.usage)
      if (!usage) continue
      const promptId = nonEmptyString(update.prompt_id)
      const modelUsage = asObject(usage.modelUsage)
      const usageIncomplete = usage.usageIsIncomplete === true
      const topPartial = usage.costIsPartial === true
      const rows = modelUsage && Object.keys(modelUsage).length > 0
        ? Object.entries(modelUsage)
        : [[currentPrompt === null ? 'unknown' : (promptModels.get(currentPrompt) || 'unknown'), usage] as const]
      for (const [modelKey, candidate] of rows) {
        const row = asObject(candidate) || {}
        const modelId = modelKey === 'unknown' ? null : modelKey
        const singleModel = rows.length === 1
        const costTicks = positiveInteger(row.costUsdTicks) ?? (singleModel ? positiveInteger(usage.costUsdTicks) : null)
        const fact: UsageFact = {
          promptIndex: currentPrompt,
          promptId,
          modelId,
          timestamp,
          input: optionalInteger(row.inputTokens),
          output: optionalInteger(row.outputTokens),
          cacheRead: optionalInteger(row.cachedReadTokens),
          reasoning: optionalInteger(row.reasoningTokens),
          providerTotal: optionalInteger(row.totalTokens),
          costTicks,
          costTrusted: !usageIncomplete && !topPartial && row.costIsPartial !== true,
          sourceLine: record.line,
          raw: record.raw
        }
        const key = `${currentPrompt ?? 'none'}\0${promptId || ''}\0${modelId || ''}`
        usageByKey.set(key, fact)
      }
      continue
    }
    if (!knownBookkeeping.has(kind)) {
      diagnostics.push({
        level: 'info',
        code: 'grok-unknown-update-kind',
        message: `updates.jsonl line ${record.line} has unsupported sessionUpdate ${kind}; the row was retained only as a diagnostic.`,
        eventId: null
      })
    }
  }
  return { contents, tools, usages: [...usageByKey.values()], promptTimestamps, promptModels }
}

function draftMessage(
  phase: DraftEvent['phase'],
  actor: DraftEvent['actor'],
  kind: 'message.text' | 'message.reasoning',
  text: string,
  sourceRecordId: string,
  raw: string,
  timestamp: string | null,
  messageId: string,
  visibility: DraftEvent['visibility'] = 'primary',
  classification: DraftEvent['classification'] = actor === 'system' ? 'promoted-system' : 'user-content'
): DraftEvent {
  return {
    phase,
    actor,
    kind,
    payload: { text },
    timestamp,
    messageId,
    messageBlockIndex: 0,
    visibility,
    classification,
    sourceRecordId,
    raw
  }
}

function toolCallDraft(
  phase: DraftEvent['phase'],
  state: ToolState,
  sourceRecordId: string,
  raw: string,
  messageId: string | null,
  blockIndex: number | null
): DraftEvent {
  return {
    phase,
    actor: 'assistant',
    kind: 'tool.call',
    payload: {
      callId: state.callId,
      rawName: state.rawName,
      semanticToolId: state.rawName,
      input: state.input
    },
    timestamp: state.timestamp,
    messageId,
    messageBlockIndex: blockIndex,
    visibility: 'primary',
    classification: 'user-content',
    sourceRecordId,
    raw
  }
}

function toolResultDraft(
  phase: DraftEvent['phase'],
  state: ToolState,
  sourceRecordId: string,
  raw: string
): DraftEvent | null {
  if (state.output === null && state.status === null) return null
  const failed = state.status === 'failed' || state.status === 'error'
  return {
    phase,
    actor: 'tool',
    kind: 'tool.result',
    payload: {
      callId: state.callId,
      output: state.output,
      isError: failed,
      state: failed ? 'error' : state.status === 'cancelled' ? 'cancelled' : 'complete'
    },
    timestamp: state.resultTimestamp || state.timestamp,
    messageId: null,
    messageBlockIndex: null,
    visibility: 'primary',
    classification: 'user-content',
    sourceRecordId: state.resultSourceLine === null ? sourceRecordId : `updates.jsonl:${state.resultSourceLine}:result`,
    raw: state.resultRaw || raw
  }
}

function preCompactionDrafts(
  sessionId: string,
  contents: UpdateContent[],
  tools: Map<string, ToolState>
): { drafts: DraftEvent[]; userTexts: Set<string> } {
  const drafts: DraftEvent[] = []
  const userTexts = new Set<string>()
  for (const content of contents) {
    const sourceRecordId = `updates.jsonl:${content.sourceLine}`
    const messageId = `grok:${sessionId}:updates:${content.sourceLine}`
    if (content.kind === 'user' && content.text) {
      const text = stripUserQuery(content.text)
      if (!text) continue
      userTexts.add(normalizeText(text))
      drafts.push(draftMessage('pre', 'user', 'message.text', text, sourceRecordId, content.raw, content.timestamp, messageId))
    } else if (content.kind === 'reasoning' && content.text) {
      drafts.push(draftMessage('pre', 'assistant', 'message.reasoning', content.text, sourceRecordId, content.raw, content.timestamp, messageId, 'collapsed'))
    } else if (content.kind === 'assistant' && content.text) {
      drafts.push(draftMessage('pre', 'assistant', 'message.text', content.text, sourceRecordId, content.raw, content.timestamp, messageId))
    } else if (content.kind === 'tool' && content.callId) {
      const state = tools.get(content.callId)
      if (!state) continue
      drafts.push(toolCallDraft('pre', state, sourceRecordId, content.raw, null, null))
      const result = toolResultDraft('pre', state, `updates.jsonl:${state.sourceLine}:result`, content.raw)
      if (result) drafts.push(result)
    }
  }
  return { drafts, userTexts }
}

function inspectChat(records: JsonlRecord[]): {
  compacted: boolean
  cutoff: number
  summaryText: string | null
  compactionRecord: JsonlRecord | null
  hasV0: boolean
  hasV1: boolean
} {
  let compacted = false
  let cutoff = Number.MAX_SAFE_INTEGER
  let summaryText: string | null = null
  let compactionRecord: JsonlRecord | null = null
  let hasV0 = false
  let hasV1 = false
  for (const record of records) {
    const type = nonEmptyString(record.value.type)
    const role = nonEmptyString(record.value.role)
    if (type) hasV1 = true
    if (role) hasV0 = true
    if (type !== 'user') continue
    const index = promptIndex(record.value.prompt_index)
    if (index !== null) cutoff = Math.min(cutoff, index)
    if (record.value.synthetic_reason !== 'compaction_meta') continue
    compacted = true
    compactionRecord ??= record
    const text = contentText(record.value.content)
    const marker = /(?:^|\b)Summary:\s*([\s\S]+)$/i.exec(text)
    if (marker?.[1]?.trim()) {
      summaryText = marker[1].trim()
      compactionRecord = record
    }
  }
  return { compacted, cutoff, summaryText, compactionRecord, hasV0, hasV1 }
}

function chatDrafts(
  sessionId: string,
  records: JsonlRecord[],
  updateScan: ReturnType<typeof scanUpdates>,
  reconstructedUserTexts: Set<string>,
  diagnostics: Diagnostic[]
): DraftEvent[] {
  const drafts: DraftEvent[] = []
  let encryptedDiagnosticEmitted = diagnostics.some((entry) => entry.code === 'grok-encrypted-reasoning-unavailable')
  for (const record of records) {
    const value = record.value
    if (!encryptedDiagnosticEmitted && containsEncryptedReasoning(value)) {
      diagnostics.push({
        level: 'info',
        code: 'grok-encrypted-reasoning-unavailable',
        message: 'Encrypted reasoning bytes were observed and deliberately not decoded or emitted.',
        eventId: null
      })
      encryptedDiagnosticEmitted = true
    }
    const sourceRecordId = `chat_history.jsonl:${record.line}`
    const messageId = `grok:${sessionId}:chat:${record.line}`
    const type = nonEmptyString(value.type)
    const legacyRole = nonEmptyString(value.role)

    if (type === 'system' || legacyRole === 'system') {
      const text = contentText(value.content)
      if (text) drafts.push(draftMessage('post', 'system', 'message.text', text, sourceRecordId, record.raw, null, messageId, 'collapsed'))
      continue
    }

    if (type === 'user' || legacyRole === 'user') {
      if (value.synthetic_reason === 'compaction_meta') continue
      const text = contentText(value.content)
      if (!text) continue
      const index = promptIndex(value.prompt_index)
      if (index === null && reconstructedUserTexts.has(normalizeText(text))) continue
      drafts.push(draftMessage(
        'post',
        'user',
        'message.text',
        text,
        sourceRecordId,
        record.raw,
        index === null ? null : (updateScan.promptTimestamps.get(index) || null),
        messageId
      ))
      continue
    }

    if (type === 'reasoning') {
      const summaries = Array.isArray(value.summary) ? value.summary : []
      const text = summaries.flatMap((candidate) => {
        const summary = asObject(candidate)
        return typeof summary?.text === 'string' && summary.text.trim() ? [summary.text.trim()] : []
      }).join('\n')
      if (text) drafts.push(draftMessage('post', 'assistant', 'message.reasoning', text, sourceRecordId, record.raw, null, messageId, 'collapsed'))
      continue
    }

    if (type === 'assistant' || legacyRole === 'assistant') {
      let blockIndex = 0
      const legacyReasoning = nonEmptyString(value.reasoning_content)
      if (legacyReasoning) {
        const reasoning = draftMessage('post', 'assistant', 'message.reasoning', legacyReasoning, `${sourceRecordId}:reasoning`, record.raw, null, messageId, 'collapsed')
        reasoning.messageBlockIndex = blockIndex++
        drafts.push(reasoning)
      }
      const text = contentText(value.content)
      if (text) {
        const message = draftMessage('post', 'assistant', 'message.text', text, sourceRecordId, record.raw, null, messageId)
        message.messageBlockIndex = blockIndex++
        drafts.push(message)
      }
      const calls = Array.isArray(value.tool_calls) ? value.tool_calls : []
      for (const [callIndex, candidate] of calls.entries()) {
        const call = asObject(candidate)
        const fn = asObject(call?.function)
        const callId = nonEmptyString(call?.id) || `chat-${record.line}-tool-${callIndex}`
        const rawName = nonEmptyString(call?.name) || nonEmptyString(fn?.name) || 'unknown'
        const state: ToolState = {
          ...(updateScan.tools.get(callId) || {
            callId,
            output: null,
            status: null,
            timestamp: null,
            sourceLine: record.line,
            resultTimestamp: null,
            resultSourceLine: null,
            resultRaw: null
          }),
          callId,
          rawName,
          input: parseJsonString(call?.arguments ?? fn?.arguments ?? {})
        }
        drafts.push(toolCallDraft('post', state, `${sourceRecordId}:tool:${callIndex}`, record.raw, messageId, blockIndex++))
      }
      continue
    }

    if (type === 'tool_result' || legacyRole === 'tool') {
      const callId = nonEmptyString(value.tool_call_id) || `chat-${record.line}-orphan`
      const updateState = updateScan.tools.get(callId)
      const chatOutput = value.content === undefined ? null : jsonValue(value.content)
      const state: ToolState = {
        ...(updateState || {
          callId,
          rawName: 'unknown',
          input: {},
          status: null,
          timestamp: null,
          sourceLine: record.line,
          resultTimestamp: null,
          resultSourceLine: record.line,
          resultRaw: record.raw
        }),
        callId,
        output: chatOutput === null || chatOutput === '' ? (updateState?.output ?? null) : chatOutput,
        ...(chatOutput === null || chatOutput === '' ? {} : { resultSourceLine: record.line, resultRaw: record.raw })
      }
      const result = toolResultDraft('post', state, sourceRecordId, record.raw)
      if (result) drafts.push(result)
      continue
    }

    if (type === 'backend_tool_call') {
      const kind = asObject(value.kind) || {}
      const callId = nonEmptyString(kind.call_id) || nonEmptyString(kind.id) || `chat-${record.line}-backend`
      const updateState = updateScan.tools.get(callId)
      const state: ToolState = {
        ...(updateState || {
          callId,
          status: nonEmptyString(kind.status),
          timestamp: null,
          sourceLine: record.line,
          output: kind.action === undefined ? null : jsonValue(kind.action),
          resultTimestamp: null,
          resultSourceLine: kind.action === undefined ? null : record.line,
          resultRaw: kind.action === undefined ? null : record.raw
        }),
        callId,
        rawName: nonEmptyString(kind.name) || nonEmptyString(kind.tool_type) || updateState?.rawName || 'backend_tool',
        input: parseJsonString(kind.input ?? updateState?.input ?? {})
      }
      drafts.push(toolCallDraft('post', state, sourceRecordId, record.raw, null, null))
      const result = toolResultDraft('post', state, `${sourceRecordId}:result`, record.raw)
      if (result) drafts.push(result)
      continue
    }

    diagnostics.push({
      level: 'info',
      code: 'grok-unknown-chat-entry',
      message: `chat_history.jsonl line ${record.line} has an unsupported discriminator and was skipped.`,
      eventId: null
    })
  }
  return drafts
}

function usageDrafts(
  sessionId: string,
  facts: UsageFact[],
  compacted: boolean,
  cutoff: number,
  diagnostics: Diagnostic[]
): DraftEvent[] {
  return facts.map((fact) => {
    let cacheRead = fact.cacheRead
    let reasoning = fact.reasoning
    if (fact.input !== null && cacheRead !== null && cacheRead > fact.input) {
      diagnostics.push({
        level: 'warning',
        code: 'grok-invalid-cache-subset',
        message: `updates.jsonl line ${fact.sourceLine} reports cachedReadTokens greater than inputTokens; the invalid cache subset was withheld.`,
        eventId: null
      })
      cacheRead = null
    }
    if (fact.output !== null && reasoning !== null && reasoning > fact.output) {
      diagnostics.push({
        level: 'warning',
        code: 'grok-invalid-reasoning-subset',
        message: `updates.jsonl line ${fact.sourceLine} reports reasoningTokens greater than outputTokens; the invalid reasoning subset was withheld.`,
        eventId: null
      })
      reasoning = null
    }
    const hasCounter = [fact.input, fact.output, cacheRead, reasoning, fact.providerTotal]
      .some((value) => value !== null)
    const untrustedCost = fact.costTicks !== null && !fact.costTrusted
    if (untrustedCost) {
      diagnostics.push({
        level: 'warning',
        code: 'grok-untrusted-cost-withheld',
        message: `updates.jsonl line ${fact.sourceLine} marks usage/cost partial or incomplete; cost was withheld instead of reported as zero.`,
        eventId: null
      })
    }
    const turnKey = fact.promptId || (fact.promptIndex === null ? `line-${fact.sourceLine}` : `prompt-${fact.promptIndex}`)
    const modelKey = fact.modelId || 'unknown-model'
    const payload: UsageRecord = {
      eventId: null,
      turnId: turnKey,
      modelId: fact.modelId,
      input: {
        total: fact.input,
        uncached: fact.input !== null && cacheRead !== null ? Math.max(0, fact.input - cacheRead) : null,
        cacheRead,
        cacheWrite5m: null,
        cacheWrite1h: null
      },
      output: {
        total: fact.output,
        visible: fact.output !== null && reasoning !== null ? Math.max(0, fact.output - reasoning) : null,
        reasoning
      },
      providerTotal: fact.providerTotal,
      aggregation: 'per-turn',
      relations: {
        cacheRead: 'subset-of-input',
        cacheWrite: 'provider-defined',
        reasoning: 'subset-of-output'
      },
      dedupKey: `grok:${sessionId}:usage:${turnKey}:${modelKey}`,
      billingFactKey: `grok:${sessionId}:billing:${turnKey}:${modelKey}`,
      measurement: hasCounter || (fact.costTrusted && fact.costTicks !== null)
        ? { source: 'reported', confidence: 'exact', sourceField: 'updates.jsonl.params.update.usage.modelUsage' }
        : { source: 'unavailable', confidence: 'unavailable', sourceField: null },
      cost: fact.costTrusted && fact.costTicks !== null
        ? { amount: fact.costTicks / USD_TICKS_PER_USD, currency: 'USD', kind: 'reported' }
        : null,
      priceRevision: null
    }
    return {
      phase: compacted && (fact.promptIndex === null || fact.promptIndex < cutoff) ? 'pre' : 'post',
      actor: 'assistant',
      kind: 'usage',
      payload: payload as unknown as JsonValue,
      timestamp: fact.timestamp,
      messageId: null,
      messageBlockIndex: null,
      visibility: 'hidden-noise',
      classification: 'lifecycle',
      sourceRecordId: `updates.jsonl:${fact.sourceLine}:usage:${modelKey}`,
      raw: fact.raw
    } satisfies DraftEvent
  })
}

function formatVersion(chat: ReturnType<typeof inspectChat>, summary: SummaryRecord | null): string {
  if (chat.hasV0 && chat.hasV1) return FORMAT_MIXED
  if (chat.hasV0) return FORMAT_V0
  if (chat.hasV1) return FORMAT_V1
  return summary?.chat_format_version === 0 ? FORMAT_V0 : FORMAT_V1
}

function eventFingerprint(raw: string | null): Fingerprint | null {
  return raw === null ? null : { algorithm: 'sha256', value: sha256(raw) }
}

function finalizeEvents(
  source: SourceRef,
  identity: SessionIdentity,
  format: string,
  preDrafts: DraftEvent[],
  postDrafts: DraftEvent[],
  compaction: { summaryText: string | null; record: JsonlRecord | null } | null
): CanonicalEvent[] {
  const ordered: DraftEvent[] = [...preDrafts]
  if (compaction) {
    const raw = compaction.record?.raw ?? null
    const sourceRecordId = compaction.record ? `chat_history.jsonl:${compaction.record.line}:compaction` : 'chat_history.jsonl:compaction'
    ordered.push({
      phase: 'post',
      actor: 'system',
      kind: 'context.compaction',
      payload: { contextRevision: 1, archivedThroughSequence: Math.max(0, preDrafts.length - 1), summaryEventId: null },
      timestamp: null,
      messageId: null,
      messageBlockIndex: null,
      visibility: 'collapsed',
      classification: 'lifecycle',
      sourceRecordId,
      raw
    })
    if (compaction.summaryText) {
      ordered.push({
        phase: 'post',
        actor: 'system',
        kind: 'context.summary',
        payload: { text: compaction.summaryText, contextRevision: 1 },
        timestamp: null,
        messageId: `grok:${identity.logicalSessionId}:compaction-summary`,
        messageBlockIndex: 0,
        visibility: 'primary',
        classification: 'promoted-system',
        sourceRecordId: `${sourceRecordId}:summary`,
        raw
      })
    }
  }
  ordered.push(...postDrafts)
  const compactionSequence = compaction ? preDrafts.length : null
  const occurrence = new Map<string, number>()
  const events = ordered.map((draft, sequence): CanonicalEvent => {
    const key = `${draft.sourceRecordId}\0${draft.kind}`
    const index = occurrence.get(key) || 0
    occurrence.set(key, index + 1)
    const id = `grok:event:${sha256(`${source.stableId}\0${key}\0${index}`).slice(0, 32)}`
    const modelContext = compactionSequence === null
      ? [{ contextRevision: 0, state: 'visible-to-model' as const, fromSequence: 0, untilSequence: null }]
      : draft.phase === 'pre'
        ? [
            { contextRevision: 0, state: 'visible-to-model' as const, fromSequence: 0, untilSequence: compactionSequence },
            { contextRevision: 1, state: 'archived' as const, fromSequence: compactionSequence, untilSequence: null }
          ]
        : [{ contextRevision: 1, state: 'visible-to-model' as const, fromSequence: compactionSequence, untilSequence: null }]
    return {
      id,
      identity,
      sharedEventKey: id,
      messageId: draft.messageId,
      sequence,
      messageBlockIndex: draft.messageBlockIndex,
      timestamp: draft.timestamp,
      actor: draft.actor,
      kind: draft.kind,
      payload: draft.payload,
      visibility: draft.visibility,
      classification: draft.classification,
      timeline: { archived: true, modelContext },
      provenance: {
        providerId: PROVIDER_ID,
        sourceRefId: source.stableId,
        parserDataVersion: PARSER_DATA_VERSION,
        formatVersion: format,
        observedAt: null,
        sourceRecordId: draft.sourceRecordId,
        rawRecordFingerprint: eventFingerprint(draft.raw)
      },
      rawRef: null
    }
  })
  const compactIndex = events.findIndex((event) => event.kind === 'context.compaction')
  const summaryEvent = events.find((event) => event.kind === 'context.summary')
  if (compactIndex >= 0 && summaryEvent) {
    ;(events[compactIndex].payload as Record<string, JsonValue>).summaryEventId = summaryEvent.id
  }
  return events
}

function parseSummary(member: LoadedMember | undefined, diagnostics: Diagnostic[]): SummaryRecord | null {
  if (!member) {
    diagnostics.push({
      level: 'warning',
      code: 'grok-summary-missing',
      message: 'summary.json is missing; identity falls back to the session directory name.',
      eventId: null
    })
    return null
  }
  try {
    const value = asObject(JSON.parse(member.bytes.toString('utf8')))
    if (!value) throw new Error('not-object')
    return value as SummaryRecord
  } catch {
    diagnostics.push({
      level: 'warning',
      code: 'grok-summary-malformed',
      message: 'summary.json is malformed; identity falls back to the session directory name.',
      eventId: null
    })
    return null
  }
}

function metadataDrafts(summary: SummaryRecord, raw: string): DraftEvent[] {
  const base = (phase: string, suffix: string): DraftEvent => ({
    phase: 'post',
    actor: 'system',
    kind: 'session.lifecycle',
    payload: { phase },
    timestamp: nonEmptyString(summary.updated_at),
    messageId: null,
    messageBlockIndex: null,
    visibility: 'hidden-noise',
    classification: 'lifecycle',
    sourceRecordId: `summary.json:${suffix}`,
    raw
  })
  const drafts: DraftEvent[] = []
  const title = nonEmptyString(summary.generated_title)
  const cwd = nonEmptyString(summary.info?.cwd)
  if (title) drafts.push(base(`metadata.title:${title}`, 'title'))
  if (cwd) drafts.push(base(`metadata.cwd:${cwd}`, 'cwd'))
  drafts.push({
    phase: 'post',
    actor: 'system',
    kind: 'unknown',
    payload: {
      rawType: 'grok.session.metadata',
      rawPayload: {
        cwd: nonEmptyString(summary.info?.cwd),
        title: nonEmptyString(summary.generated_title),
        sessionSummary: nonEmptyString(summary.session_summary),
        createdAt: nonEmptyString(summary.created_at),
        updatedAt: nonEmptyString(summary.updated_at),
        currentModelId: nonEmptyString(summary.current_model_id),
        sessionKind: nonEmptyString(summary.session_kind),
        parentSessionId: nonEmptyString(summary.parent_session_id)
      }
    },
    timestamp: nonEmptyString(summary.updated_at),
    messageId: null,
    messageBlockIndex: null,
    visibility: 'hidden-noise',
    classification: 'lifecycle',
    sourceRecordId: 'summary.json',
    raw
  })
  return drafts
}

function relationshipDraft(parentSessionId: string): DraftEvent {
  return {
    phase: 'post',
    actor: 'system',
    kind: 'session.lifecycle',
    payload: {
      relationshipType: 'fork',
      parentBranchViewId: `grok:branch:${parentSessionId}`
    },
    timestamp: null,
    messageId: null,
    messageBlockIndex: null,
    visibility: 'hidden-noise',
    classification: 'lifecycle',
    sourceRecordId: 'summary.json:parent_session_id',
    raw: null
  }
}

export async function parseGrokSource(
  source: SourceRef,
  fingerprint: Fingerprint,
  signal: AbortSignal
): Promise<ParseChunk[]> {
  const members = await loadMembers(source, signal)
  const observedFingerprint = compositeFingerprint(members)
  if (!sameFingerprint(observedFingerprint, fingerprint)) throw new Error('grok-source-changed-during-parse')
  const byName = new Map(members.map((member) => [member.name, member]))
  const chatMember = byName.get('chat_history.jsonl')
  if (!chatMember) throw new Error('grok-chat-history-missing')

  const diagnostics: Diagnostic[] = []
  const summaryMember = byName.get('summary.json')
  const summary = parseSummary(summaryMember, diagnostics)
  const chatRecords = parseJsonl(chatMember.bytes, 'chat_history.jsonl', diagnostics)
  const updatesMember = byName.get('updates.jsonl')
  const updateRecords = updatesMember ? parseJsonl(updatesMember.bytes, 'updates.jsonl', diagnostics) : []
  if (!updatesMember) {
    diagnostics.push({
      level: 'warning',
      code: 'grok-updates-missing',
      message: 'updates.jsonl is missing; timestamps, usage, tool enrichment and pre-compaction history may be unavailable.',
      eventId: null
    })
  }

  const root = compositeRoot(source)
  const sessionId = nonEmptyString(summary?.info?.id) || path.basename(root)
  const parentSessionId = nonEmptyString(summary?.parent_session_id)
  const identity: SessionIdentity = {
    physicalSourceId: source.stableId,
    logicalSessionKey: `grok:${sessionId}`,
    logicalSessionId: sessionId,
    branchViewId: `grok:branch:${sessionId}`,
    parentBranchViewId: parentSessionId ? `grok:branch:${parentSessionId}` : null
  }
  const chat = inspectChat(chatRecords)
  const updates = scanUpdates(updateRecords, chat.compacted, chat.cutoff, diagnostics)
  const reconstructed = preCompactionDrafts(sessionId, updates.contents, updates.tools)
  const currentDrafts = chatDrafts(sessionId, chatRecords, updates, reconstructed.userTexts, diagnostics)
  const usage = usageDrafts(sessionId, updates.usages, chat.compacted, chat.cutoff, diagnostics)
  const preDrafts = [...reconstructed.drafts, ...usage.filter((entry) => entry.phase === 'pre')]
  const postDrafts: DraftEvent[] = []
  if (summary && summaryMember) postDrafts.push(...metadataDrafts(summary, summaryMember.bytes.toString('utf8')))
  postDrafts.push(...currentDrafts, ...usage.filter((entry) => entry.phase === 'post'))
  if (parentSessionId) postDrafts.push(relationshipDraft(parentSessionId))
  const parsedFormat = formatVersion(chat, summary)
  const events = finalizeEvents(
    source,
    identity,
    parsedFormat,
    preDrafts,
    postDrafts,
    chat.compacted ? { summaryText: chat.summaryText, record: chat.compactionRecord } : null
  )

  return [{
    providerId: PROVIDER_ID,
    parserDataVersion: PARSER_DATA_VERSION,
    formatVersion: parsedFormat,
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

export function createGrokProvider(options: GrokProviderOptions): BuiltinProviderRuntimeV2 {
  const roots = options.roots || [path.join(options.homeDir, '.grok', 'sessions')]
  return {
    manifest: structuredClone(GROK_PROVIDER_MANIFEST_V2),
    async discover(signal) {
      const directories = (await Promise.all(roots.map((root) => discoverSessionDirectories(root, signal)))).flat()
      const byStableId = new Map<string, { source: SourceRef; mtimeMs: number }>()
      for (const directory of directories) {
        const candidate = await sourceForDirectory(directory, signal)
        const existing = byStableId.get(candidate.source.stableId)
        if (!existing || candidate.mtimeMs > existing.mtimeMs) byStableId.set(candidate.source.stableId, candidate)
      }
      return [...byStableId.values()]
        .map((entry) => entry.source)
        .sort((left, right) => left.displayLocator.localeCompare(right.displayLocator))
    },
    async fingerprint(source, signal) {
      return compositeFingerprint(await loadMembers(source, signal))
    },
    async inputBytes(source, signal) {
      return (await loadMembers(source, signal)).reduce((total, member) => total + member.bytes.byteLength, 0)
    },
    parse: parseGrokSource
  }
}
