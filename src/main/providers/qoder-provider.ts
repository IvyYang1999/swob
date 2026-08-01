import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type {
  Fingerprint,
  SourceRef
} from '../../shared/provider-schema.generated'
import {
  PROVIDER_RESOURCE_LIMITS,
  type CanonicalEvent,
  type CapabilityDeclaration,
  type Diagnostic,
  type EventProvenance,
  type JsonValue,
  type ParseChunk,
  type ProviderManifest,
  type SessionIdentity,
  type UsageRecord
} from '../../shared/provider-schema-v2.generated'
import { createBuiltinToolRegistryV2 } from '../../shared/tool-registry-v2'
import { builtinProviderForSource } from '../../shared/provider-capabilities'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'
import {
  buildCanonicalLogicalSessionIdentity,
  logicalSessionKey
} from '../library-session-identity'

export const QODER_PROVIDER_ID = 'swob/qoder'
export const QODER_FORMAT_VERSION = 'qoder-project-jsonl-compound-reference-v1'
export const QODER_PARSER_DATA_VERSION = '1'
export const QODER_CHUNK_EVENT_LIMIT = 1_000
export const QODER_CHUNK_BYTE_LIMIT = PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes - 128 * 1024
export const QODER_SESSION_INPUT_LIMIT_BYTES = 50 * 1024 * 1024
const QODER_JSON_BYTE_LIMIT = 192 * 1024
const QODER_JSON_MAX_DEPTH = 24
const QODER_JSON_MAX_NODES = 4_096
const QODER_JSON_MAX_ARRAY_ITEMS = 256
const QODER_JSON_MAX_OBJECT_PROPERTIES = 128
const QODER_JSON_MAX_STRING_BYTES = 64 * 1024
const QODER_TEXT_FRAGMENT_MAX_BYTES = 192 * 1024
const QODER_DIAGNOSTIC_LIMIT = 128

const QODER_FIXTURE = 'testdata/qoder/-workspace-synthetic-qoder/11111111-1111-4111-8111-111111111111.jsonl'
const QODER_CONFORMANCE_PREFIX = 'PPV2-QODER'
const AGENTSVIEW_QODER_SOURCE =
  'https://github.com/kenn-io/agentsview/tree/1cd581fe34e87e134160c6668deffb674b7eaa4e/internal/parser'
const QODER_CLI_RESUME_DOC = 'https://docs.qoder.com/zh/cli/using-cli'
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/

export interface QoderProviderOptions {
  homeDir: string
  roots?: string[]
}

/**
 * Discovery still uses the protocol-v1 SourceRef wire type because Provider
 * Protocol v2 deliberately starts at the canonical event stream. The runtime
 * itself emits v2 manifests and ParseChunk values directly; no v1 canonical
 * records or v1-to-v2 migration participate in Qoder parsing.
 */
interface QoderSidecar {
  title?: string
  working_dir?: string
  fork_from?: string
  parent_session_id?: string
}

interface SourceMembers {
  transcriptPath: string
  sidecarPath: string | null
}

interface ParsedLine {
  value: Record<string, unknown>
  raw: string
  offset: number
  length: number
  lineNumber: number
}

function evidence(
  kind: 'test' | 'observed-format' | 'upstream-source' | 'compatibility-contract' | 'missing',
  conformanceTestId: string,
  locator: string,
  note?: string
) {
  return {
    kind,
    fixture: QODER_FIXTURE,
    conformanceTestId,
    locator,
    ...(note ? { note } : {})
  } as const
}

function capability(
  status: CapabilityDeclaration['status'],
  reason: string | null,
  conformanceSuffix: string,
  kind: Parameters<typeof evidence>[0] = status === 'unavailable' ? 'missing' : 'test',
  locator = 'src/main/providers/qoder-provider.test.ts',
  note?: string
): CapabilityDeclaration {
  return {
    status,
    reason,
    evidence: [evidence(kind, `${QODER_CONFORMANCE_PREFIX}-${conformanceSuffix}`, locator, note)]
  }
}

export const QODER_PROVIDER_MANIFEST: ProviderManifest = {
  schemaVersion: 2,
  providerId: QODER_PROVIDER_ID,
  displayName: 'Qoder',
  implementationVersion: 'builtin-v2',
  parserDataVersion: QODER_PARSER_DATA_VERSION,
  formatVersions: [QODER_FORMAT_VERSION],
  capabilities: {
    discover: capability('available', null, 'DISCOVER'),
    summary: capability(
      'available',
      null,
      'SUMMARY',
      'upstream-source',
      AGENTSVIEW_QODER_SOURCE,
      'Compound `-session.json` title and working_dir reference; fixture is synthetic.'
    ),
    transcript: capability('available', null, 'TRANSCRIPT'),
    tools: capability('available', null, 'TOOLS'),
    thinking: capability(
      'experimental',
      'Thinking blocks are decoded when persisted, but no public Qoder producer schema proves every product surface writes them.',
      'THINKING',
      'upstream-source',
      AGENTSVIEW_QODER_SOURCE
    ),
    usage: capability(
      'experimental',
      'Persisted message.usage counters are preserved in v2 without estimation; no producer schema proves cache relations, so the compatible product aggregate fails closed as unavailable.',
      'USAGE-IF-PRESENT',
      'upstream-source',
      AGENTSVIEW_QODER_SOURCE
    ),
    relationships: capability(
      'available',
      null,
      'RELATIONSHIPS',
      'upstream-source',
      AGENTSVIEW_QODER_SOURCE,
      'Sidecar fork_from/parent_session_id and nested subagent layout.'
    ),
    subagents: capability(
      'available',
      null,
      'SUBAGENTS',
      'upstream-source',
      AGENTSVIEW_QODER_SOURCE
    ),
    interactions: capability(
      'unavailable',
      'No reproducible Qoder source proves persisted interaction request/response semantics.',
      'INTERACTIONS-UNAVAILABLE'
    ),
    permissions: capability(
      'unavailable',
      'No reproducible Qoder source proves persisted permission request/response semantics.',
      'PERMISSIONS-UNAVAILABLE'
    ),
    'context-timeline': capability(
      'unavailable',
      'No source-level compact boundary or model-context membership was found; archived events retain an explicit unknown context state.',
      'CONTEXT-UNAVAILABLE'
    ),
    identity: capability('available', null, 'IDENTITY'),
    'chunked-transport': capability('available', null, 'CHUNKED'),
    'terminal-resume': capability(
      'experimental',
      'Official qodercli documents -r <session-id>, but this machine has no qodercli binary and post-resume source/anchor verification remains untested.',
      'RESUME-UNVERIFIED',
      'upstream-source',
      QODER_CLI_RESUME_DOC
    ),
    'native-resume': capability(
      'unavailable',
      'Opening the Qoder IDE or a task view is not evidence that a specific transcript resumes correctly.',
      'NATIVE-RESUME-UNAVAILABLE'
    ),
    'format-provenance': capability(
      'experimental',
      'The compound layout is pinned to an independent MIT implementation; no public first-party producer schema or local authenticated sample was available.',
      'FORMAT-REFERENCE',
      'upstream-source',
      AGENTSVIEW_QODER_SOURCE
    )
  },
  resumeContract: {
    mode: 'native-cli',
    supportedSurfaces: ['terminal'],
    supportsSubagent: false,
    idTransform: null,
    preflight: ['binary', 'version', 'help-capability', 'source-exists'],
    commandTemplate: 'qodercli -r {sessionId}',
    expectedSideEffects: ['observe-source-after-launch', 'verify-content-anchor-after-resume'],
    postcondition: 'anchor-match'
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false }
  const marker = '…'
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  let low = 0
  let high = Math.min(value.length, contentBudget)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= contentBudget) low = middle
    else high = middle - 1
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low--
  return { value: `${value.slice(0, low)}${marker}`, truncated: true }
}

function splitUtf8(value: string, maxBytes: number): string[] {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return [value]
  const fragments: string[] = []
  let start = 0
  while (start < value.length) {
    let low = start + 1
    let high = Math.min(value.length, start + maxBytes)
    let end = start
    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      if (Buffer.byteLength(value.slice(start, middle), 'utf8') <= maxBytes) {
        end = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }
    if (end < value.length && end > start &&
      /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) {
      end--
    }
    if (end <= start) end = start + 1
    fragments.push(value.slice(start, end))
    start = end
  }
  return fragments
}

function boundedText(value: string, maxBytes: number, onTruncated: () => void): string {
  const result = truncateUtf8(value, maxBytes)
  if (result.truncated) onTruncated()
  return result.value
}

function boundedIdentifier(value: string, onTruncated: () => void): string {
  if (Buffer.byteLength(value, 'utf8') <= 1_024) return value
  onTruncated()
  const prefix = truncateUtf8(value, 960).value
  return `${prefix}:${sha256(value).slice(0, 32)}`
}

function asJsonValue(value: unknown, onTruncated: () => void = () => {}): JsonValue {
  const state = { nodes: 0, stringBytes: 0, truncated: false }
  const markTruncated = (): void => { state.truncated = true }

  const visit = (input: unknown, depth: number): JsonValue => {
    state.nodes++
    if (state.nodes > QODER_JSON_MAX_NODES || depth > QODER_JSON_MAX_DEPTH) {
      markTruncated()
      return '[truncated:resource-limit]'
    }
    if (input === null || typeof input === 'boolean') return input
    if (typeof input === 'number') return Number.isFinite(input) ? input : null
    if (typeof input === 'string') {
      const remaining = Math.max(0, QODER_JSON_BYTE_LIMIT - state.stringBytes)
      const result = truncateUtf8(input, Math.min(QODER_JSON_MAX_STRING_BYTES, remaining))
      state.stringBytes += Buffer.byteLength(result.value, 'utf8')
      if (result.truncated) markTruncated()
      return result.value
    }
    if (Array.isArray(input)) {
      if (input.length > QODER_JSON_MAX_ARRAY_ITEMS) markTruncated()
      return input.slice(0, QODER_JSON_MAX_ARRAY_ITEMS).map((child) => visit(child, depth + 1))
    }
    if (!isObject(input)) return visit(String(input), depth)

    const entries = Object.entries(input)
    if (entries.length > QODER_JSON_MAX_OBJECT_PROPERTIES) markTruncated()
    const output = Object.create(null) as Record<string, JsonValue>
    for (const [index, [rawKey, child]] of entries.slice(0, QODER_JSON_MAX_OBJECT_PROPERTIES).entries()) {
      const keyResult = truncateUtf8(rawKey, 128)
      if (keyResult.truncated) markTruncated()
      let key = keyResult.value || `field-${index}`
      if (Object.prototype.hasOwnProperty.call(output, key)) key = `field-${index}-${sha256(rawKey).slice(0, 12)}`
      output[key] = visit(child, depth + 1)
    }
    return output
  }

  const normalized = visit(value, 0)
  const encoded = JSON.stringify(normalized)
  if (Buffer.byteLength(encoded, 'utf8') > QODER_JSON_BYTE_LIMIT) {
    markTruncated()
    const preview = truncateUtf8(encoded, 64 * 1024).value
    if (state.truncated) onTruncated()
    return {
      _swobTruncated: true,
      sha256: sha256(encoded),
      preview
    }
  }
  if (state.truncated) onTruncated()
  return normalized
}

function addDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
  if (diagnostics.length < QODER_DIAGNOSTIC_LIMIT - 1) {
    diagnostics.push(diagnostic)
    return
  }
  if (!diagnostics.some((entry) => entry.code === 'qoder-diagnostics-truncated')) {
    diagnostics.push({
      level: 'warning',
      code: 'qoder-diagnostics-truncated',
      message: 'Additional parser diagnostics were suppressed to stay within protocol resource limits.',
      eventId: null
    })
  }
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableEventId(sourceId: string, sourceRecordId: string, kind: string, blockIndex: number | null): string {
  return `qoder-event:${sha256(`${sourceId}\0${sourceRecordId}\0${kind}\0${blockIndex ?? ''}`).slice(0, 32)}`
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function optionalCounter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function validSessionId(value: string): boolean {
  return SAFE_SESSION_ID.test(value) && value !== '.' && value !== '..'
}

function sourceMembers(source: SourceRef): SourceMembers {
  if (source.kind !== 'composite-directory' || source.providerId !== QODER_PROVIDER_ID) {
    throw new Error('qoder-source-kind-invalid')
  }
  const paths = source.memberUris.map((uri) => fileURLToPath(uri))
  if (paths.some((memberPath) => !path.isAbsolute(memberPath))) throw new Error('qoder-source-path-not-absolute')
  const transcriptPath = paths.find((memberPath) => memberPath.endsWith('.jsonl'))
  if (!transcriptPath) throw new Error('qoder-source-transcript-missing')
  return {
    transcriptPath,
    sidecarPath: paths.find((memberPath) => memberPath.endsWith('-session.json')) || null
  }
}

function qoderIds(transcriptPath: string): {
  logicalSessionId: string
  parentSessionId: string | null
  isSubagent: boolean
} {
  const stem = path.basename(transcriptPath, '.jsonl')
  const parentDirectory = path.basename(path.dirname(transcriptPath))
  if (parentDirectory === 'subagents') {
    const parentSessionId = path.basename(path.dirname(path.dirname(transcriptPath)))
    if (!validSessionId(parentSessionId) || !stem.startsWith('agent-') || !validSessionId(stem)) {
      throw new Error('qoder-subagent-path-invalid')
    }
    return {
      logicalSessionId: `${parentSessionId}:subagent:${stem}`,
      parentSessionId,
      isSubagent: true
    }
  }
  if (!validSessionId(stem) || stem.startsWith('agent-')) throw new Error('qoder-session-path-invalid')
  return { logicalSessionId: stem, parentSessionId: null, isSubagent: false }
}

async function isDirectoryOrSymlink(directory: string): Promise<boolean> {
  try { return (await fs.promises.stat(directory)).isDirectory() } catch { return false }
}

async function discoverRoot(root: string, signal: AbortSignal): Promise<string[]> {
  if (signal.aborted) throw new Error('cancelled')
  let projects: fs.Dirent[]
  try { projects = await fs.promises.readdir(root, { withFileTypes: true }) } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const transcripts: string[] = []
  for (const project of projects.sort((left, right) => left.name.localeCompare(right.name))) {
    if (signal.aborted) throw new Error('cancelled')
    if (project.name.startsWith('.')) continue
    const projectDir = path.join(root, project.name)
    if (!await isDirectoryOrSymlink(projectDir)) continue
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(projectDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (signal.aborted) throw new Error('cancelled')
      const entryPath = path.join(projectDir, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const stem = entry.name.slice(0, -'.jsonl'.length)
        if (validSessionId(stem) && !stem.startsWith('agent-')) transcripts.push(entryPath)
        continue
      }
      if (!validSessionId(entry.name) || !await isDirectoryOrSymlink(entryPath)) continue
      const subagentsDir = path.join(entryPath, 'subagents')
      let subagents: fs.Dirent[]
      try { subagents = await fs.promises.readdir(subagentsDir, { withFileTypes: true }) } catch { continue }
      for (const subagent of subagents.sort((left, right) => left.name.localeCompare(right.name))) {
        const stem = subagent.name.endsWith('.jsonl')
          ? subagent.name.slice(0, -'.jsonl'.length)
          : ''
        if (subagent.isFile() && stem.startsWith('agent-') && validSessionId(stem)) {
          transcripts.push(path.join(subagentsDir, subagent.name))
        }
      }
    }
  }
  return transcripts
}

function sidecarFor(transcriptPath: string, isSubagent: boolean): string | null {
  if (isSubagent) return null
  return `${transcriptPath.slice(0, -'.jsonl'.length)}-session.json`
}

async function sourceForTranscript(transcriptPath: string): Promise<SourceRef> {
  const ids = qoderIds(transcriptPath)
  const sidecarPath = sidecarFor(transcriptPath, ids.isSubagent)
  const members = [transcriptPath]
  if (sidecarPath) {
    try {
      if ((await fs.promises.stat(sidecarPath)).isFile()) members.push(sidecarPath)
    } catch { /* Optional companion metadata. */ }
  }
  const stableId = `qoder:${ids.logicalSessionId}`
  return {
    kind: 'composite-directory',
    stableId,
    providerId: QODER_PROVIDER_ID,
    rootUri: pathToFileURL(path.dirname(transcriptPath)).href,
    memberUris: members.map((memberPath) => pathToFileURL(memberPath).href),
    displayLocator: transcriptPath,
    fingerprint: { algorithm: 'composite-sha256', value: 'pending' }
  }
}

async function memberInputBytes(source: SourceRef, signal: AbortSignal): Promise<number> {
  if (signal.aborted) throw new Error('cancelled')
  const members = sourceMembers(source)
  const sizes = await Promise.all([
    fs.promises.stat(members.transcriptPath).then((stat) => stat.size),
    members.sidecarPath
      ? fs.promises.stat(members.sidecarPath).then((stat) => stat.size)
      : Promise.resolve(0)
  ])
  const total = sizes[0] + sizes[1]
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error(`qoder-session-input-size-invalid:${total}`)
  }
  return total
}

async function assertMemberInputLimit(source: SourceRef, signal: AbortSignal): Promise<void> {
  const total = await memberInputBytes(source, signal)
  if (total > QODER_SESSION_INPUT_LIMIT_BYTES) {
    throw new Error(`qoder-session-input-limit-exceeded:${total}:${QODER_SESSION_INPUT_LIMIT_BYTES}`)
  }
}

async function readMembers(source: SourceRef, signal: AbortSignal): Promise<{
  transcript: Buffer
  sidecar: Buffer | null
  members: SourceMembers
}> {
  if (signal.aborted) throw new Error('cancelled')
  await assertMemberInputLimit(source, signal)
  const members = sourceMembers(source)
  const transcript = await fs.promises.readFile(members.transcriptPath, { signal })
  const sidecar = members.sidecarPath
    ? await fs.promises.readFile(members.sidecarPath, { signal })
    : null
  const actualBytes = transcript.length + (sidecar?.length || 0)
  if (actualBytes > QODER_SESSION_INPUT_LIMIT_BYTES) {
    throw new Error(`qoder-session-input-limit-exceeded:${actualBytes}:${QODER_SESSION_INPUT_LIMIT_BYTES}`)
  }
  return { transcript, sidecar, members }
}

function memberFingerprint(transcript: Buffer, sidecar: Buffer | null): Fingerprint {
  const transcriptHash = sha256(transcript)
  const sidecarHash = sidecar ? sha256(sidecar) : null
  const inputs = [`transcript:${transcriptHash}`, ...(sidecarHash ? [`sidecar:${sidecarHash}`] : [])]
  return {
    algorithm: 'composite-sha256',
    value: sha256(inputs.join('\0')),
    inputs
  }
}

function fingerprintEqual(left: Fingerprint, right: Fingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value &&
    JSON.stringify(left.inputs || []) === JSON.stringify(right.inputs || [])
}

function parseLines(bytes: Buffer, diagnostics: Diagnostic[]): ParsedLine[] {
  const lines: ParsedLine[] = []
  let start = 0
  let lineNumber = 0
  for (let cursor = 0; cursor <= bytes.length; cursor++) {
    if (cursor < bytes.length && bytes[cursor] !== 0x0a) continue
    lineNumber++
    const end = cursor > start && bytes[cursor - 1] === 0x0d ? cursor - 1 : cursor
    const raw = bytes.subarray(start, end).toString('utf8')
    const trimmed = raw.trim()
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed)
        if (isObject(parsed)) lines.push({ value: parsed, raw: trimmed, offset: start, length: end - start, lineNumber })
        else addDiagnostic(diagnostics, {
          level: 'warning',
          code: 'qoder-jsonl-non-object',
          message: `Ignored non-object JSONL record at line ${lineNumber}.`,
          eventId: null
        })
      } catch {
        addDiagnostic(diagnostics, {
          level: 'warning',
          code: 'qoder-jsonl-malformed',
          message: `Ignored malformed JSONL record at line ${lineNumber}.`,
          eventId: null
        })
      }
    }
    start = cursor + 1
  }
  return lines
}

function readSidecar(bytes: Buffer | null, diagnostics: Diagnostic[]): QoderSidecar | null {
  if (!bytes) return null
  try {
    const value = JSON.parse(bytes.toString('utf8'))
    return isObject(value) ? value as QoderSidecar : null
  } catch {
    addDiagnostic(diagnostics, {
      level: 'warning',
      code: 'qoder-sidecar-malformed',
      message: 'Ignored malformed Qoder session sidecar metadata.',
      eventId: null
    })
    return null
  }
}

function parentFrom(sidecar: QoderSidecar | null, pathParent: string | null): string | null {
  if (pathParent) return pathParent
  if (typeof sidecar?.fork_from === 'string' && validSessionId(sidecar.fork_from)) return sidecar.fork_from
  if (typeof sidecar?.parent_session_id === 'string' && validSessionId(sidecar.parent_session_id)) {
    return sidecar.parent_session_id
  }
  return null
}

function identityFor(source: SourceRef, logicalSessionId: string, parentSessionId: string | null): SessionIdentity {
  const logicalIdentity = buildCanonicalLogicalSessionIdentity(
    QODER_PROVIDER_ID,
    source.stableId,
    logicalSessionId
  )
  return {
    physicalSourceId: source.stableId,
    logicalSessionKey: logicalSessionKey(logicalIdentity),
    logicalSessionId,
    branchViewId: `qoder:${logicalSessionId}:default`,
    parentBranchViewId: parentSessionId ? `qoder:${parentSessionId}:default` : null
  }
}

function contextUnknown(sequence: number): CanonicalEvent['timeline'] {
  return {
    archived: true,
    modelContext: [{
      contextRevision: 0,
      state: 'unknown',
      fromSequence: sequence,
      untilSequence: null
    }]
  }
}

function provenance(
  source: SourceRef,
  sourceRecordId: string,
  observedAt: string | null,
  raw: string
): EventProvenance {
  return {
    providerId: QODER_PROVIDER_ID,
    sourceRefId: source.stableId,
    parserDataVersion: QODER_PARSER_DATA_VERSION,
    formatVersion: QODER_FORMAT_VERSION,
    observedAt,
    sourceRecordId,
    rawRecordFingerprint: { algorithm: 'sha256', value: sha256(raw) }
  }
}

function usageFrom(
  value: unknown,
  sourceRecordId: string,
  eventId: string,
  messageId: string | null,
  modelId: string | null
): UsageRecord | null {
  if (!isObject(value)) return null
  const input = optionalCounter(value.input_tokens)
  const cacheRead = optionalCounter(value.cache_read_input_tokens)
  const cacheWrite = optionalCounter(value.cache_creation_input_tokens)
  const output = optionalCounter(value.output_tokens)
  if ([input, cacheRead, cacheWrite, output].every((counter) => counter === null)) return null
  return {
    eventId,
    turnId: messageId,
    modelId,
    input: {
      // `input_tokens` is persisted as a provider total. No producer schema
      // proves that cache fields are subsets or additive, so uncached input is
      // not derived and compatibility projections must fail closed.
      total: input,
      uncached: null,
      cacheRead,
      cacheWrite5m: cacheWrite,
      cacheWrite1h: null
    },
    output: {
      total: output,
      visible: output,
      reasoning: null
    },
    providerTotal: null,
    aggregation: 'per-message',
    relations: {
      cacheRead: 'provider-defined',
      cacheWrite: 'provider-defined',
      reasoning: 'provider-defined'
    },
    dedupKey: `qoder:usage:${sourceRecordId}`,
    billingFactKey: `qoder:billing:${sourceRecordId}`,
    measurement: {
      source: 'reported',
      confidence: 'exact',
      sourceField: 'message.usage'
    },
    cost: null,
    priceRevision: null
  }
}

function eventPages(events: CanonicalEvent[]): CanonicalEvent[][] {
  const pages: CanonicalEvent[][] = []
  let page: CanonicalEvent[] = []
  let pageBytes = 0
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (page.length > 0 &&
      (page.length >= QODER_CHUNK_EVENT_LIMIT || pageBytes + eventBytes > QODER_CHUNK_BYTE_LIMIT)) {
      pages.push(page)
      page = []
      pageBytes = 0
    }
    page.push(event)
    pageBytes += eventBytes
  }
  if (page.length > 0 || pages.length === 0) pages.push(page)
  return pages
}

export async function parseQoderSourceV2(
  source: SourceRef,
  expectedFingerprint: Fingerprint,
  signal: AbortSignal,
  mode: ParseChunk['mode'] = 'initial'
): Promise<ParseChunk[]> {
  const { transcript, sidecar: sidecarBytes, members } = await readMembers(source, signal)
  const actualFingerprint = memberFingerprint(transcript, sidecarBytes)
  if (!fingerprintEqual(expectedFingerprint, actualFingerprint)) {
    throw new Error('qoder-source-changed-during-parse')
  }
  const ids = qoderIds(members.transcriptPath)
  const diagnostics: Diagnostic[] = [{
    level: 'info',
    code: 'qoder-reference-format',
    message: 'Parsed against a pinned independent reference layout; no public first-party producer schema was available.',
    eventId: null
  }]
  let resourceLimited = false
  const markResourceLimited = (): void => { resourceLimited = true }
  const safeJson = (value: unknown): JsonValue => asJsonValue(value, markResourceLimited)
  const safeText = (value: string, maxBytes: number): string =>
    boundedText(value, maxBytes, markResourceLimited)
  const safeIdentifier = (value: string): string => boundedIdentifier(value, markResourceLimited)
  const sidecar = readSidecar(sidecarBytes, diagnostics)
  const parsedLines = parseLines(transcript, diagnostics)
  const parentSessionId = parentFrom(sidecar, ids.parentSessionId)
  const identity = identityFor(source, ids.logicalSessionId, parentSessionId)
  const transcriptLocatorHash = sha256(pathToFileURL(members.transcriptPath).href)
  const sidecarLocatorHash = members.sidecarPath
    ? sha256(pathToFileURL(members.sidecarPath).href)
    : null
  const registry = createBuiltinToolRegistryV2()
  const events: CanonicalEvent[] = []
  let sequence = 0

  const emit = (input: {
    sourceRecordId: string
    raw: string
    offset: number
    length: number
    messageId: string | null
    blockIndex: number | null
    timestamp: string | null
    actor: CanonicalEvent['actor']
    kind: CanonicalEvent['kind']
    payload: JsonValue
    visibility?: CanonicalEvent['visibility']
    classification?: CanonicalEvent['classification']
    rawRef?: CanonicalEvent['rawRef']
  }): CanonicalEvent => {
    const event: CanonicalEvent = {
      id: stableEventId(source.stableId, input.sourceRecordId, input.kind, input.blockIndex),
      identity,
      sharedEventKey: `qoder:shared:${input.sourceRecordId}:${input.blockIndex ?? 'event'}:${input.kind}`,
      messageId: input.messageId,
      sequence,
      messageBlockIndex: input.blockIndex,
      timestamp: input.timestamp,
      actor: input.actor,
      kind: input.kind,
      payload: input.payload,
      visibility: input.visibility || 'primary',
      classification: input.classification || 'unknown',
      timeline: contextUnknown(sequence),
      provenance: provenance(source, input.sourceRecordId, input.timestamp, input.raw),
      rawRef: input.rawRef === undefined
        ? { locatorHash: transcriptLocatorHash, offset: input.offset, length: input.length }
        : input.rawRef
    }
    events.push(event)
    sequence++
    return event
  }

  const firstTranscriptCwd = parsedLines.find((line) =>
    typeof line.value.cwd === 'string' && line.value.cwd)?.value.cwd
  const workingDirectory = sidecar
    ? typeof sidecar.working_dir === 'string' && sidecar.working_dir
      ? sidecar.working_dir
      : null
    : typeof firstTranscriptCwd === 'string'
      ? firstTranscriptCwd
      : null
  const metadataRaw = sidecar
    ? sidecarBytes!.toString('utf8')
    : parsedLines[0]?.raw || members.transcriptPath
  emit({
    sourceRecordId: 'metadata',
    raw: metadataRaw,
    offset: sidecar ? 0 : parsedLines[0]?.offset || 0,
    length: sidecar ? sidecarBytes!.length : parsedLines[0]?.length || 0,
    messageId: null,
    blockIndex: null,
    timestamp: null,
    actor: 'system',
    kind: 'session.metadata',
    payload: {
      title: typeof sidecar?.title === 'string' && sidecar.title ? safeText(sidecar.title, 16 * 1024) : null,
      cwd: workingDirectory ? [safeText(workingDirectory, 16 * 1024)] : [],
      projectPath: workingDirectory ? safeText(workingDirectory, 16 * 1024) : null
    },
    visibility: 'collapsed',
    classification: 'lifecycle',
    rawRef: sidecar && sidecarLocatorHash
      ? { locatorHash: sidecarLocatorHash, offset: 0, length: sidecarBytes!.length }
      : parsedLines[0]
        ? {
            locatorHash: transcriptLocatorHash,
            offset: parsedLines[0].offset,
            length: parsedLines[0].length
          }
        : null
  })

  if (parentSessionId) {
    const relationshipType = ids.isSubagent
      ? 'subagent'
      : sidecar?.fork_from === parentSessionId
        ? 'fork'
        : 'parent-child'
    emit({
      sourceRecordId: `relationship:${parentSessionId}`,
      raw: sidecarBytes?.toString('utf8') || members.transcriptPath,
      offset: 0,
      length: sidecarBytes?.length || 0,
      messageId: null,
      blockIndex: null,
      timestamp: null,
      actor: 'system',
      kind: 'session.lifecycle',
      payload: {
        relationshipType,
        parentBranchViewId: `qoder:${parentSessionId}:default`
      },
      visibility: 'collapsed',
      classification: 'lifecycle',
      rawRef: sidecarBytes && sidecarLocatorHash
        ? { locatorHash: sidecarLocatorHash, offset: 0, length: sidecarBytes.length }
        : null
    })
  }

  for (const line of parsedLines) {
    if (signal.aborted) throw new Error('cancelled')
    const row = line.value
    const rowType = typeof row.type === 'string' ? safeText(row.type, 1_024) : 'unknown'
    const message = isObject(row.message) ? row.message : null
    const role = typeof message?.role === 'string' ? message.role : rowType
    const rawMessageId = typeof row.uuid === 'string' && row.uuid
      ? row.uuid
      : typeof message?.id === 'string' && message.id
        ? message.id
        : `line:${line.lineNumber}`
    const messageId = safeIdentifier(rawMessageId)
    const sourceRecordId = messageId
    const eventTimestamp = timestamp(row.timestamp)
    const content = message?.content
    let blockIndex = 0
    let emittedKnownBlock = false

    const emitUnknownBlock = (rawType: string, rawPayload: unknown): void => {
      emit({
        sourceRecordId,
        raw: line.raw,
        offset: line.offset,
        length: line.length,
        messageId,
        blockIndex: blockIndex++,
        timestamp: eventTimestamp,
        actor: role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'unknown',
        kind: 'unknown',
        payload: { rawType: safeText(rawType, 1_024), rawPayload: safeJson(rawPayload) },
        visibility: 'collapsed',
        classification: 'unknown'
      })
    }

    const emitKnownText = (
      kind: 'message.text' | 'message.thinking' | 'message.reasoning',
      actor: 'user' | 'assistant',
      text: string,
      visibility: CanonicalEvent['visibility'] = 'primary'
    ): void => {
      emittedKnownBlock = true
      for (const fragment of splitUtf8(text, QODER_TEXT_FRAGMENT_MAX_BYTES)) {
        emit({
          sourceRecordId,
          raw: line.raw,
          offset: line.offset,
          length: line.length,
          messageId,
          blockIndex: blockIndex++,
          timestamp: eventTimestamp,
          actor,
          kind,
          payload: { text: fragment },
          visibility,
          classification: 'user-content'
        })
      }
    }

    const parsePart = (part: unknown): void => {
      if (typeof part === 'string') {
        emitKnownText('message.text', role === 'assistant' ? 'assistant' : 'user', part)
        return
      }
      if (!isObject(part)) {
        emitUnknownBlock('qoder.content.unknown', part)
        return
      }
      const partType = typeof part.type === 'string' ? part.type : 'unknown'
      if (partType === 'text' && typeof part.text === 'string') {
        emitKnownText('message.text', role === 'assistant' ? 'assistant' : 'user', part.text)
        return
      }
      if ((partType === 'thinking' || partType === 'reasoning') &&
        (typeof part.thinking === 'string' || typeof part.text === 'string')) {
        emitKnownText(
          partType === 'thinking' ? 'message.thinking' : 'message.reasoning',
          'assistant',
          String(part.thinking ?? part.text),
          'collapsed'
        )
        return
      }
      if (partType === 'tool_use' || partType === 'toolUse' || partType === 'tool_call') {
        const rawName = typeof part.name === 'string' && part.name
          ? safeText(part.name, 1_024)
          : 'unknown'
        const callId = typeof part.id === 'string' && part.id
          ? safeIdentifier(part.id)
          : `qoder-call:${sourceRecordId}:${blockIndex}`
        const resolved = registry.resolve({
          providerId: QODER_PROVIDER_ID,
          formatVersion: QODER_FORMAT_VERSION,
          rawName,
          callId,
          input: safeJson(part.input ?? part.arguments ?? {})
        })
        emittedKnownBlock = true
        emit({
          sourceRecordId,
          raw: line.raw,
          offset: line.offset,
          length: line.length,
          messageId,
          blockIndex: blockIndex++,
          timestamp: eventTimestamp,
          actor: 'assistant',
          kind: 'tool.call',
          payload: {
            callId,
            rawName,
            semanticToolId: resolved.semanticToolId,
            input: safeJson(resolved.normalizedInput)
          },
          classification: 'user-content'
        })
        return
      }
      if (partType === 'tool_result' || partType === 'toolResult') {
        const callId = typeof part.tool_use_id === 'string' && part.tool_use_id
          ? safeIdentifier(part.tool_use_id)
          : typeof part.toolCallId === 'string' && part.toolCallId
            ? safeIdentifier(part.toolCallId)
            : `qoder-orphan:${sourceRecordId}:${blockIndex}`
        const errorFlag = typeof part.is_error === 'boolean' ? part.is_error : null
        emittedKnownBlock = true
        emit({
          sourceRecordId,
          raw: line.raw,
          offset: line.offset,
          length: line.length,
          messageId,
          blockIndex: blockIndex++,
          timestamp: eventTimestamp,
          actor: 'tool',
          kind: 'tool.result',
          payload: {
            callId,
            output: safeJson(part.content ?? part.output ?? null),
            isError: errorFlag,
            state: errorFlag === true ? 'error' : 'complete'
          },
          classification: 'user-content'
        })
        return
      }
      emitUnknownBlock(`qoder.content.${partType}`, part)
    }

    if (typeof content === 'string') parsePart(content)
    else if (Array.isArray(content)) for (const part of content) parsePart(part)
    else if (content !== undefined) parsePart(content)

    if (!message || (!emittedKnownBlock &&
      (content === undefined || (Array.isArray(content) && content.length === 0)))) {
      emit({
        sourceRecordId,
        raw: line.raw,
        offset: line.offset,
        length: line.length,
        messageId: null,
        blockIndex: null,
        timestamp: eventTimestamp,
        actor: rowType === 'agent-setting' ? 'system' : 'unknown',
        kind: 'unknown',
        payload: { rawType: safeText(`qoder.${rowType}`, 1_024), rawPayload: safeJson(row) },
        visibility: 'collapsed',
        classification: rowType === 'agent-setting' ? 'lifecycle' : 'unknown'
      })
    }

    const usageEventId = stableEventId(source.stableId, sourceRecordId, 'usage', null)
    const usage = usageFrom(
      message?.usage,
      sourceRecordId,
      usageEventId,
      messageId,
      typeof message?.model === 'string' ? safeText(message.model, 1_024) : null
    )
    if (usage) {
      emit({
        sourceRecordId,
        raw: line.raw,
        offset: line.offset,
        length: line.length,
        messageId,
        blockIndex: null,
        timestamp: eventTimestamp,
        actor: 'assistant',
        kind: 'usage',
        payload: usage as unknown as JsonValue,
        visibility: 'collapsed',
        classification: 'lifecycle'
      })
    }

    const toolUseResult = isObject(row.toolUseResult) ? row.toolUseResult : null
    if (toolUseResult && typeof toolUseResult.agentId === 'string' && toolUseResult.agentId) {
      emit({
        sourceRecordId: `${sourceRecordId}:subagent`,
        raw: line.raw,
        offset: line.offset,
        length: line.length,
        messageId,
        blockIndex: null,
        timestamp: eventTimestamp,
        actor: 'system',
        kind: 'subagent.spawn',
        payload: {
          agentId: safeIdentifier(`${ids.logicalSessionId}:subagent:agent-${toolUseResult.agentId}`),
          parentAgentId: ids.logicalSessionId
        },
        visibility: 'collapsed',
        classification: 'lifecycle'
      })
    }
  }

  if (resourceLimited && !diagnostics.some((entry) => entry.code === 'qoder-value-truncated')) {
    const diagnostic: Diagnostic = {
      level: 'warning',
      code: 'qoder-value-truncated',
      message: 'One or more persisted values were truncated to satisfy Provider Protocol v2 resource limits.',
      eventId: null
    }
    if (diagnostics.length >= QODER_DIAGNOSTIC_LIMIT) diagnostics[QODER_DIAGNOSTIC_LIMIT - 2] = diagnostic
    else diagnostics.push(diagnostic)
  }

  const pages = eventPages(events)
  return pages.map((page, chunkIndex): ParseChunk => {
    const done = chunkIndex === pages.length - 1
    return {
      providerId: QODER_PROVIDER_ID,
      parserDataVersion: QODER_PARSER_DATA_VERSION,
      formatVersion: QODER_FORMAT_VERSION,
      fingerprint: actualFingerprint,
      identity,
      mode,
      chunkIndex,
      previousCursor: chunkIndex === 0 ? null : `qoder:${source.stableId}:${chunkIndex - 1}`,
      cursor: done ? null : `qoder:${source.stableId}:${chunkIndex}`,
      done,
      events: page,
      diagnostics: chunkIndex === 0 ? diagnostics : []
    }
  })
}

export function createQoderProvider(options: QoderProviderOptions): BuiltinProviderRuntimeV2 {
  const roots = options.roots || [
    path.join(options.homeDir, '.qoder', 'projects'),
    path.join(options.homeDir, '.qoderwork', 'projects')
  ]
  const definition = builtinProviderForSource('qoder')
  if (!definition) throw new Error('Qoder provider manifest is not registered.')
  return {
    manifest: structuredClone(QODER_PROVIDER_MANIFEST),
    async discover(signal) {
      const candidates = (await Promise.all(roots.map((root) => discoverRoot(root, signal)))).flat()
      const byStableId = new Map<string, { source: SourceRef; mtimeMs: number }>()
      for (const transcriptPath of candidates) {
        const source = await sourceForTranscript(transcriptPath)
        const members = sourceMembers(source)
        const mtimes = await Promise.all([
          fs.promises.stat(members.transcriptPath).then((stat) => stat.mtimeMs),
          members.sidecarPath
            ? fs.promises.stat(members.sidecarPath).then((stat) => stat.mtimeMs)
            : Promise.resolve(0)
        ])
        const mtimeMs = Math.max(...mtimes)
        const current = byStableId.get(source.stableId)
        if (!current || mtimeMs > current.mtimeMs) byStableId.set(source.stableId, { source, mtimeMs })
      }
      return [...byStableId.values()]
        .map((entry) => entry.source)
        .sort((left, right) => left.displayLocator.localeCompare(right.displayLocator))
    },
    async fingerprint(source, signal) {
      const { transcript, sidecar } = await readMembers(source, signal)
      return memberFingerprint(transcript, sidecar)
    },
    async inputBytes(source, signal) {
      return memberInputBytes(source, signal)
    },
    parse(source, fingerprint, signal) {
      return parseQoderSourceV2(source, fingerprint, signal, 'initial')
    }
  }
}
