import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Fingerprint, SourceRef } from '../../shared/provider-schema.generated'
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
import { builtinProviderForSource } from '../../shared/provider-capabilities'
import { createBuiltinToolRegistryV2 } from '../../shared/tool-registry-v2'
import type { BuiltinProviderRuntimeV2 } from '../provider-host'
import {
  buildCanonicalLogicalSessionIdentity,
  logicalSessionKey
} from '../library-session-identity'

export const GEMINI_PROVIDER_ID = 'swob/gemini'
export const GEMINI_JSON_FORMAT = 'gemini-cli-conversation-json-v1'
export const GEMINI_JSONL_FORMAT = 'gemini-cli-conversation-jsonl-v2'
export const GEMINI_PARSER_DATA_VERSION = '1'
export const GEMINI_SESSION_INPUT_LIMIT_BYTES = 50 * 1024 * 1024
const GEMINI_FIXTURE = 'testdata/gemini/home/.gemini/tmp/synthetic-project/chats/session-2026-08-02-11111111.jsonl'
const GEMINI_CONFORMANCE_PREFIX = 'PPV2-GEMINI'
const GEMINI_CHUNK_BYTE_LIMIT = PROVIDER_RESOURCE_LIMITS.maxEnvelopeBytes - 128 * 1024
const GEMINI_TEXT_FRAGMENT_BYTES = 192 * 1024
const GEMINI_JSON_BYTES = 192 * 1024
const GEMINI_DIAGNOSTIC_LIMIT = 128
const GEMINI_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/
const OFFICIAL_SOURCE =
  'https://github.com/google-gemini/gemini-cli/tree/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/packages/core/src/services'
const OFFICIAL_RESUME_DOC = 'https://github.com/google-gemini/gemini-cli/blob/f47d6c6f7a1308d81f9f57acf7d279f0928c5249/docs/reference/configuration.md'
const AGENTSVIEW_SOURCE =
  'https://github.com/kenn-io/agentsview/tree/1cd581fe34e87e134160c6668deffb674b7eaa4e/internal/parser'

export type GeminiLayerGrade = 'exact' | 'derived' | 'estimated' | 'unavailable'

export interface GeminiEvidenceCell {
  layer: 'discovery' | 'metadata' | 'messages' | 'tools' | 'system+compact' | 'token' | 'relationships' | 'resume'
  grade: GeminiLayerGrade
  evidence: string
  limitation: string | null
  fixture: string
  conformanceTestId: string
}

export const GEMINI_EIGHT_LAYER_EVIDENCE: readonly GeminiEvidenceCell[] = [
  { layer: 'discovery', grade: 'exact', evidence: 'Official Storage places session JSON/JSONL below ~/.gemini/tmp/<project>/chats.', limitation: null, fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-DISCOVER` },
  { layer: 'metadata', grade: 'exact', evidence: 'sessionId, projectHash, timestamps, summary, directories and kind are persisted fields.', limitation: null, fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-METADATA` },
  { layer: 'messages', grade: 'exact', evidence: 'Official MessageRecord content and thoughts are preserved as separate ordered canonical blocks.', limitation: null, fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-MESSAGES` },
  { layer: 'tools', grade: 'exact', evidence: 'ToolCallRecord id/name/args/status and inline functionResponse results are persisted.', limitation: null, fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-TOOLS` },
  { layer: 'system+compact', grade: 'derived', evidence: 'info/error/warning records and JSONL rewind/checkpoint operations are preserved.', limitation: 'No producer field proves model-context membership or a semantic compaction boundary.', fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-SYSTEM-CONTEXT` },
  { layer: 'token', grade: 'exact', evidence: 'prompt/candidate/cache/thought/tool/total counters are copied from persisted response UsageMetadata; tool-use prompt tokens are included in normalized input; repeated JSONL message snapshots are last-write-wins.', limitation: 'Gemini CLI persists one final per-request snapshot, not raw SSE chunks.', fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-USAGE` },
  { layer: 'relationships', grade: 'derived', evidence: 'Current official subagent files are nested below chats/<parent-session-id> and carry kind=subagent.', limitation: 'The child record does not persist an explicit parentSessionId field.', fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-RELATIONSHIPS` },
  { layer: 'resume', grade: 'derived', evidence: 'Official docs and local gemini 0.38.2 help expose -r/--resume; Swob probes binary, version, help and source before launch.', limitation: 'No authenticated post-launch anchor observation was available, so the product capability remains experimental.', fixture: GEMINI_FIXTURE, conformanceTestId: `${GEMINI_CONFORMANCE_PREFIX}-RESUME` }
]

function manifestEvidence(
  conformanceTestId: string,
  locator = 'src/main/providers/gemini-provider.test.ts',
  kind: 'test' | 'observed-format' | 'upstream-source' | 'compatibility-contract' | 'missing' = 'test',
  note?: string
) {
  return [{ kind, fixture: GEMINI_FIXTURE, conformanceTestId, locator, ...(note ? { note } : {}) }]
}

function capability(
  status: CapabilityDeclaration['status'],
  reason: string | null,
  cell: GeminiEvidenceCell,
  locator?: string,
  kind?: Parameters<typeof manifestEvidence>[2],
  note?: string
): CapabilityDeclaration {
  return { status, reason, evidence: manifestEvidence(cell.conformanceTestId, locator, kind, note) }
}

function layer(name: GeminiEvidenceCell['layer']): GeminiEvidenceCell {
  return GEMINI_EIGHT_LAYER_EVIDENCE.find((entry) => entry.layer === name)!
}

export const GEMINI_PROVIDER_MANIFEST: ProviderManifest = {
  schemaVersion: 2,
  providerId: GEMINI_PROVIDER_ID,
  displayName: 'Gemini CLI',
  implementationVersion: 'builtin-v2',
  parserDataVersion: GEMINI_PARSER_DATA_VERSION,
  formatVersions: [GEMINI_JSONL_FORMAT, GEMINI_JSON_FORMAT],
  capabilities: {
    discover: capability('available', null, layer('discovery'), OFFICIAL_SOURCE, 'upstream-source'),
    summary: capability('available', null, layer('metadata'), OFFICIAL_SOURCE, 'upstream-source'),
    transcript: capability('available', null, layer('messages'), OFFICIAL_SOURCE, 'upstream-source'),
    tools: capability('available', null, layer('tools'), OFFICIAL_SOURCE, 'upstream-source'),
    thinking: capability('available', null, layer('messages'), OFFICIAL_SOURCE, 'upstream-source'),
    usage: capability('available', null, layer('token'), OFFICIAL_SOURCE, 'upstream-source'),
    relationships: capability('experimental', layer('relationships').limitation, layer('relationships'), OFFICIAL_SOURCE, 'upstream-source'),
    subagents: capability('experimental', layer('relationships').limitation, layer('relationships'), OFFICIAL_SOURCE, 'upstream-source'),
    interactions: capability('unavailable', 'No persisted Gemini CLI record proves interactive question request/response semantics.', layer('system+compact'), OFFICIAL_SOURCE, 'missing'),
    permissions: capability('unavailable', 'Tool status is persisted, but permission prompts and decisions are not.', layer('system+compact'), OFFICIAL_SOURCE, 'missing'),
    'context-timeline': capability('unavailable', layer('system+compact').limitation, layer('system+compact'), OFFICIAL_SOURCE, 'missing'),
    identity: capability('available', null, layer('metadata'), OFFICIAL_SOURCE, 'upstream-source'),
    'chunked-transport': capability('available', null, layer('discovery')),
    'terminal-resume': capability('experimental', layer('resume').limitation, layer('resume'), OFFICIAL_RESUME_DOC, 'upstream-source'),
    'native-resume': capability('not-applicable', 'Gemini CLI exposes a terminal resume surface, not a desktop deep link.', layer('resume'), OFFICIAL_RESUME_DOC, 'upstream-source'),
    'format-provenance': capability('available', null, layer('metadata'), OFFICIAL_SOURCE, 'upstream-source', 'First-party Apache-2.0 producer source plus pinned MIT comparison implementation.')
  },
  resumeContract: {
    mode: 'native-cli',
    supportedSurfaces: ['terminal'],
    supportsSubagent: false,
    idTransform: null,
    preflight: ['binary', 'version', 'help-capability', 'source-exists'],
    commandTemplate: 'gemini --resume {sessionId}',
    expectedSideEffects: ['open-existing-gemini-session', 'observe-source-after-launch', 'verify-content-anchor-after-resume'],
    postcondition: 'anchor-match'
  }
}

export interface GeminiProviderOptions {
  homeDir: string
  roots?: string[]
}

interface StoredRecord {
  value: Record<string, unknown>
  raw: string
  offset: number
  length: number
  lineNumber: number
}

interface ParsedConversation {
  formatVersion: typeof GEMINI_JSON_FORMAT | typeof GEMINI_JSONL_FORMAT
  metadata: Record<string, unknown>
  messages: StoredRecord[]
  operations: StoredRecord[]
  diagnostics: Diagnostic[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function counter(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function validSessionId(value: unknown): value is string {
  return typeof value === 'string' && GEMINI_SESSION_ID.test(value) && value !== '.' && value !== '..'
}

function boundedText(value: string, maxBytes = GEMINI_TEXT_FRAGMENT_BYTES): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let end = Math.min(value.length, maxBytes)
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes - 3) end--
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
  return `${value.slice(0, end)}…`
}

function splitText(value: string): string[] {
  const fragments: string[] = []
  let remaining = value
  while (Buffer.byteLength(remaining, 'utf8') > GEMINI_TEXT_FRAGMENT_BYTES) {
    const fragment = boundedText(remaining, GEMINI_TEXT_FRAGMENT_BYTES)
    const content = fragment.endsWith('…') ? fragment.slice(0, -1) : fragment
    fragments.push(content)
    remaining = remaining.slice(content.length)
  }
  fragments.push(remaining)
  return fragments
}

function jsonValue(value: unknown, depth = 0, budget = { nodes: 0 }): JsonValue {
  budget.nodes++
  if (depth > 24 || budget.nodes > 4_096) return '[truncated:resource-limit]'
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return boundedText(value, 64 * 1024)
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => jsonValue(entry, depth + 1, budget))
  if (!isObject(value)) return boundedText(String(value), 64 * 1024)
  const result: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value).slice(0, 128)) {
    result[boundedText(key, 256)] = jsonValue(child, depth + 1, budget)
  }
  const encoded = JSON.stringify(result)
  return Buffer.byteLength(encoded, 'utf8') <= GEMINI_JSON_BYTES
    ? result
    : { _swobTruncated: true, sha256: sha256(encoded), preview: boundedText(encoded, 64 * 1024) }
}

function addDiagnostic(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
  if (diagnostics.length < GEMINI_DIAGNOSTIC_LIMIT) diagnostics.push(diagnostic)
}

function filePathFor(source: SourceRef): string {
  if (source.kind !== 'file' || source.providerId !== GEMINI_PROVIDER_ID) throw new Error('gemini-source-kind-invalid')
  const filePath = fileURLToPath(source.uri)
  if (!path.isAbsolute(filePath)) throw new Error('gemini-source-path-not-absolute')
  return filePath
}

interface GeminiSourceBoundary {
  configuredRoots: readonly string[]
}

interface ContainedPath {
  filePath: string
  anchorRoot: string
}

interface ContainedFileSnapshot extends ContainedPath {
  stat: fs.Stats
  bytes?: Buffer
}

interface GeminiDiscoveryCandidate {
  filePath: string
  chatsRoot: string
}

interface GeminiSessionScope {
  filePath: string
  chatsRoot: string
  sourceRoot: string
}

interface IssuedGeminiSource extends GeminiSessionScope {
  stableId: string
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

async function canonicalConfiguredRoot(configuredRoot: string): Promise<string> {
  const root = await fs.promises.realpath(path.resolve(configuredRoot))
  const rootStat = await fs.promises.stat(root)
  if (!rootStat.isDirectory()) throw new Error('gemini-configured-root-not-directory')
  return root
}

async function canonicalTmpRoot(configuredRoot: string): Promise<string> {
  const root = await canonicalConfiguredRoot(configuredRoot)
  const tmpRoot = await fs.promises.realpath(path.join(root, 'tmp'))
  if (!isPathWithin(root, tmpRoot)) throw new Error('gemini-configured-tmp-root-outside-root')
  const stat = await fs.promises.stat(tmpRoot)
  if (!stat.isDirectory()) throw new Error('gemini-configured-tmp-root-not-directory')
  return tmpRoot
}

async function currentConfiguredRoots(boundary: GeminiSourceBoundary): Promise<string[]> {
  const roots: string[] = []
  for (const configuredRoot of boundary.configuredRoots) {
    try {
      roots.push(await canonicalConfiguredRoot(configuredRoot))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return [...new Set(roots)]
}

async function currentTmpRoots(boundary: GeminiSourceBoundary): Promise<string[]> {
  const roots: string[] = []
  for (const configuredRoot of boundary.configuredRoots) {
    try {
      roots.push(await canonicalTmpRoot(configuredRoot))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return [...new Set(roots)]
}

async function currentConfiguredRootScopes(boundary: GeminiSourceBoundary): Promise<Array<{
  lexicalTmpRoot: string
  canonicalTmpRoot: string
}>> {
  const scopes: Array<{ lexicalTmpRoot: string; canonicalTmpRoot: string }> = []
  for (const configuredRoot of boundary.configuredRoots) {
    try {
      scopes.push({
        lexicalTmpRoot: path.join(configuredRoot, 'tmp'),
        canonicalTmpRoot: await canonicalTmpRoot(configuredRoot)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return scopes
}

async function resolveContainedPath(candidate: string, tmpRoots: readonly string[]): Promise<ContainedPath> {
  if (!path.isAbsolute(candidate)) throw new Error('gemini-source-path-not-absolute')
  const filePath = await fs.promises.realpath(candidate)
  const anchorRoot = tmpRoots.find((root) => isPathWithin(root, filePath))
  if (!anchorRoot) throw new Error('gemini-source-outside-configured-root')
  return { filePath, anchorRoot }
}

async function resolveCurrentContainedPath(
  boundary: GeminiSourceBoundary,
  candidate: string,
  scope: 'tmp' | 'configured-root' = 'tmp'
): Promise<ContainedPath> {
  const roots = scope === 'tmp' ? await currentTmpRoots(boundary) : await currentConfiguredRoots(boundary)
  return resolveContainedPath(candidate, roots)
}

async function configuredRootForTmp(boundary: GeminiSourceBoundary, tmpRoot: string): Promise<string> {
  const roots = (await currentConfiguredRoots(boundary))
    .filter((root) => isPathWithin(root, tmpRoot))
    .sort((left, right) => right.length - left.length)
  if (!roots[0]) throw new Error('gemini-tmp-root-detached-from-configured-root')
  return roots[0]
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function redactedProviderError(error: unknown): Error {
  const message = error instanceof Error ? error.message : ''
  if (message === 'cancelled' || /^gemini-[a-z0-9-]+(?::[0-9]+)*$/.test(message)) return new Error(message)
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return new Error('gemini-source-unavailable')
  if (code === 'EACCES' || code === 'EPERM') return new Error('gemini-source-access-denied')
  if (code === 'ELOOP') return new Error('gemini-source-symlink-loop')
  return new Error('gemini-provider-operation-failed')
}

function isMissingDirectoryRace(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function readDirectory(directory: string): Promise<fs.Dirent[] | null> {
  try {
    return await fs.promises.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissingDirectoryRace(error)) return null
    throw error
  }
}

async function resolveGeminiSessionScope(
  boundary: GeminiSourceBoundary,
  candidate: string
): Promise<GeminiSessionScope> {
  if (!path.isAbsolute(candidate)) throw new Error('gemini-source-path-not-absolute')
  const filePath = path.resolve(candidate)
  const roots = await currentConfiguredRootScopes(boundary)
  const anchors = roots.flatMap((scope) => [
    { lexicalRoot: path.resolve(scope.lexicalTmpRoot), canonicalRoot: scope.canonicalTmpRoot },
    { lexicalRoot: scope.canonicalTmpRoot, canonicalRoot: scope.canonicalTmpRoot }
  ])
    .filter((entry, index, entries) => entries.findIndex((candidateEntry) =>
      candidateEntry.lexicalRoot === entry.lexicalRoot && candidateEntry.canonicalRoot === entry.canonicalRoot) === index)
    .filter((entry) => isPathWithin(entry.lexicalRoot, filePath))
    .sort((left, right) => right.lexicalRoot.length - left.lexicalRoot.length)
  const anchor = anchors[0]
  if (!anchor) throw new Error('gemini-source-outside-configured-root')

  const relative = path.relative(anchor.lexicalRoot, filePath)
  const segments = relative.split(path.sep)
  if ((segments.length !== 3 && segments.length !== 4) ||
    !segments[0] || segments[1] !== 'chats' || !segments.at(-1) ||
    (segments.length === 3 && !/^session-.*\.jsonl?$/.test(segments[2])) ||
    (segments.length === 4 && !/\.jsonl?$/.test(segments[3]))) {
    throw new Error('gemini-source-shape-invalid')
  }

  const projectCandidate = path.join(anchor.lexicalRoot, segments[0])
  const projectLstat = await fs.promises.lstat(projectCandidate)
  if (projectLstat.isSymbolicLink()) throw new Error('gemini-project-directory-alias-not-allowed')
  const projectRoot = await fs.promises.realpath(projectCandidate)
  if (projectRoot !== path.join(anchor.canonicalRoot, segments[0])) {
    throw new Error('gemini-project-directory-alias-not-allowed')
  }
  const projectStat = await fs.promises.stat(projectRoot)
  if (!projectStat.isDirectory()) throw new Error('gemini-project-directory-not-directory')

  const chatsCandidate = path.join(projectCandidate, 'chats')
  const chatsLstat = await fs.promises.lstat(chatsCandidate)
  if (chatsLstat.isSymbolicLink()) throw new Error('gemini-chats-alias-not-allowed')
  const chats = await resolveContainedPath(chatsCandidate, [projectRoot])
  const chatsStat = await fs.promises.stat(chats.filePath)
  if (!chatsStat.isDirectory()) throw new Error('gemini-chats-not-directory')
  let sourceRoot = chats.filePath
  if (segments.length === 4) {
    const nestedCandidate = path.join(chatsCandidate, segments[2])
    const nestedLstat = await fs.promises.lstat(nestedCandidate)
    if (nestedLstat.isSymbolicLink()) throw new Error('gemini-nested-source-alias-not-allowed')
    const nested = await resolveContainedPath(nestedCandidate, [chats.filePath])
    const nestedStat = await fs.promises.stat(nested.filePath)
    if (!nestedStat.isDirectory()) throw new Error('gemini-nested-source-not-directory')
    sourceRoot = nested.filePath
  }
  const sourceLstat = await fs.promises.lstat(filePath)
  if (sourceLstat.isSymbolicLink()) throw new Error('gemini-source-file-alias-not-allowed')
  const resolvedSource = await resolveContainedPath(filePath, [sourceRoot])
  return { filePath, chatsRoot: chats.filePath, sourceRoot: resolvedSource.anchorRoot }
}

async function providerBoundary<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw redactedProviderError(error)
  }
}

async function containedFileSnapshot(
  boundary: GeminiSourceBoundary,
  candidate: string,
  signal: AbortSignal,
  includeBytes: boolean,
  scope: 'tmp' | 'configured-root' = 'tmp',
  requiredRoot?: string
): Promise<ContainedFileSnapshot> {
  if (signal.aborted) throw new Error('cancelled')
  const before = await resolveCurrentContainedPath(boundary, candidate, scope)
  if (requiredRoot && !isPathWithin(requiredRoot, before.filePath)) {
    throw new Error('gemini-source-outside-logical-scope')
  }
  const handle = await fs.promises.open(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error('gemini-source-not-regular-file')
    if (opened.size > GEMINI_SESSION_INPUT_LIMIT_BYTES) {
      throw new Error(`gemini-session-input-limit-exceeded:${opened.size}:${GEMINI_SESSION_INPUT_LIMIT_BYTES}`)
    }

    const afterOpen = await resolveCurrentContainedPath(boundary, candidate, scope)
    const afterOpenStat = await fs.promises.stat(afterOpen.filePath)
    if (before.filePath !== afterOpen.filePath || before.anchorRoot !== afterOpen.anchorRoot ||
      !sameFile(opened, afterOpenStat) ||
      (requiredRoot && !isPathWithin(requiredRoot, afterOpen.filePath))) {
      throw new Error('gemini-source-replaced-during-open')
    }

    const bytes = includeBytes ? await handle.readFile() : undefined
    if (signal.aborted) throw new Error('cancelled')
    const afterReadHandle = await handle.stat()
    if (!sameFile(opened, afterReadHandle)) throw new Error('gemini-source-replaced-during-read')
    if (afterReadHandle.size > GEMINI_SESSION_INPUT_LIMIT_BYTES ||
      (bytes && bytes.length > GEMINI_SESSION_INPUT_LIMIT_BYTES)) {
      throw new Error(`gemini-session-input-limit-exceeded:${Math.max(afterReadHandle.size, bytes?.length || 0)}:${GEMINI_SESSION_INPUT_LIMIT_BYTES}`)
    }

    const afterRead = await resolveCurrentContainedPath(boundary, candidate, scope)
    const afterReadStat = await fs.promises.stat(afterRead.filePath)
    if (before.filePath !== afterRead.filePath || before.anchorRoot !== afterRead.anchorRoot ||
      !sameFile(afterReadHandle, afterReadStat) ||
      (requiredRoot && !isPathWithin(requiredRoot, afterRead.filePath))) {
      throw new Error('gemini-source-replaced-during-read')
    }
    return { ...afterRead, stat: afterReadHandle, ...(bytes ? { bytes } : {}) }
  } finally {
    await handle.close()
  }
}

async function issuedSourceSnapshot(
  boundary: GeminiSourceBoundary,
  source: SourceRef,
  issued: IssuedGeminiSource,
  signal: AbortSignal,
  includeBytes: boolean
): Promise<ContainedFileSnapshot> {
  const filePath = filePathFor(source)
  const scope = await resolveGeminiSessionScope(boundary, filePath)
  if (source.stableId !== issued.stableId || scope.filePath !== issued.filePath) {
    throw new Error('gemini-source-not-issued')
  }
  if (scope.chatsRoot !== issued.chatsRoot || scope.sourceRoot !== issued.sourceRoot) {
    throw new Error('gemini-source-scope-changed')
  }
  return containedFileSnapshot(boundary, filePath, signal, includeBytes, 'tmp', scope.sourceRoot)
}

async function readSource(
  boundary: GeminiSourceBoundary,
  source: SourceRef,
  issued: IssuedGeminiSource,
  signal: AbortSignal
): Promise<ContainedFileSnapshot & { bytes: Buffer }> {
  const snapshot = await issuedSourceSnapshot(boundary, source, issued, signal, true)
  if (!snapshot.bytes) throw new Error('gemini-source-read-empty')
  return snapshot as ContainedFileSnapshot & { bytes: Buffer }
}

function fingerprint(bytes: Buffer): Fingerprint {
  return { algorithm: 'sha256', value: sha256(bytes), inputs: [`bytes:${bytes.length}`] }
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
  return left.algorithm === right.algorithm && left.value === right.value &&
    JSON.stringify(left.inputs || []) === JSON.stringify(right.inputs || [])
}

function record(value: Record<string, unknown>, raw: string, offset: number, length: number, lineNumber: number): StoredRecord {
  return { value, raw, offset, length, lineNumber }
}

function parseLegacy(bytes: Buffer): ParsedConversation {
  const value = JSON.parse(bytes.toString('utf8'))
  if (!isObject(value) || !validSessionId(value.sessionId)) throw new Error('gemini-legacy-session-invalid')
  const messages = Array.isArray(value.messages)
    ? value.messages.flatMap((message, index): StoredRecord[] => isObject(message)
      ? [record(message, JSON.stringify(message), 0, bytes.length, index + 1)]
      : [])
    : []
  return {
    formatVersion: GEMINI_JSON_FORMAT,
    metadata: value,
    messages,
    operations: [],
    diagnostics: []
  }
}

function parseJsonl(bytes: Buffer): ParsedConversation {
  const diagnostics: Diagnostic[] = []
  let metadata: Record<string, unknown> = {}
  const messages = new Map<string, StoredRecord>()
  const order: string[] = []
  const operations: StoredRecord[] = []
  let start = 0
  let lineNumber = 0

  for (let cursor = 0; cursor <= bytes.length; cursor++) {
    if (cursor < bytes.length && bytes[cursor] !== 0x0a) continue
    lineNumber++
    const end = cursor > start && bytes[cursor - 1] === 0x0d ? cursor - 1 : cursor
    const raw = bytes.subarray(start, end).toString('utf8').trim()
    if (raw) {
      let value: unknown
      try { value = JSON.parse(raw) } catch {
        addDiagnostic(diagnostics, { level: 'warning', code: 'gemini-jsonl-malformed', message: `Ignored malformed or partial JSONL record at line ${lineNumber}.`, eventId: null })
        start = cursor + 1
        continue
      }
      if (!isObject(value)) {
        addDiagnostic(diagnostics, { level: 'warning', code: 'gemini-jsonl-non-object', message: `Ignored non-object JSONL record at line ${lineNumber}.`, eventId: null })
      } else {
        const current = record(value, raw, start, end - start, lineNumber)
        if (validSessionId(value.id)) {
          if (!messages.has(value.id)) order.push(value.id)
          messages.set(value.id, current)
        } else if (validSessionId(value.$rewindTo)) {
          const index = order.indexOf(value.$rewindTo)
          const removed = index >= 0 ? order.splice(index) : order.splice(0)
          for (const id of removed) messages.delete(id)
          operations.push(current)
        } else if (isObject(value.$set)) {
          const update = value.$set
          if (Array.isArray(update.messages)) {
            messages.clear()
            order.splice(0)
            update.messages.forEach((message, index) => {
              if (!isObject(message) || !validSessionId(message.id)) return
              order.push(message.id)
              messages.set(message.id, record(message, raw, start, end - start, lineNumber + index / 1_000))
            })
          }
          metadata = { ...metadata, ...update }
          operations.push(current)
        } else if (validSessionId(value.sessionId) && typeof value.projectHash === 'string') {
          metadata = { ...metadata, ...value }
        } else {
          operations.push(current)
        }
      }
    }
    start = cursor + 1
  }
  if (!validSessionId(metadata.sessionId)) throw new Error('gemini-jsonl-session-id-missing')
  return {
    formatVersion: GEMINI_JSONL_FORMAT,
    metadata,
    messages: order.map((id) => messages.get(id)!).filter(Boolean),
    operations,
    diagnostics
  }
}

function parseConversation(bytes: Buffer, filePath: string): ParsedConversation {
  if (filePath.endsWith('.jsonl')) return parseJsonl(bytes)
  try { return parseLegacy(bytes) } catch (legacyError) {
    if (bytes.includes(0x0a)) return parseJsonl(bytes)
    throw legacyError
  }
}

async function projectPathFor(
  boundary: GeminiSourceBoundary,
  tmpRoot: string,
  projectDirectory: string,
  signal: AbortSignal
): Promise<string | null> {
  const projectCandidate = path.join(tmpRoot, projectDirectory)
  try {
    const beforeProject = await resolveCurrentContainedPath(boundary, projectCandidate)
    const marker = await containedFileSnapshot(
      boundary,
      path.join(beforeProject.filePath, '.project_root'),
      signal,
      true
    )
    const afterProject = await resolveCurrentContainedPath(boundary, projectCandidate)
    if (beforeProject.filePath !== afterProject.filePath ||
      !isPathWithin(afterProject.filePath, marker.filePath)) {
      throw new Error('gemini-project-marker-outside-project')
    }
    const markerText = marker.bytes!.toString('utf8').trim()
    if (markerText) return markerText
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const configuredRoot = await configuredRootForTmp(boundary, tmpRoot)
  let registryBytes: Buffer
  try {
    const registry = await containedFileSnapshot(
      boundary,
      path.join(configuredRoot, 'projects.json'),
      signal,
      true,
      'configured-root'
    )
    if (registry.anchorRoot !== configuredRoot) throw new Error('gemini-project-registry-crossed-configured-root')
    registryBytes = registry.bytes!
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let registry: unknown
  try {
    registry = JSON.parse(registryBytes.toString('utf8'))
  } catch {
    throw new Error('gemini-project-registry-invalid')
  }
  if (!isObject(registry) || !isObject(registry.projects) ||
    Object.entries(registry.projects).some(([projectPath, slug]) => !projectPath || typeof slug !== 'string' || !slug)) {
    throw new Error('gemini-project-registry-invalid')
  }
  const match = Object.entries(registry.projects).find(([, slug]) => slug === projectDirectory)
  if (match) return match[0]
  return null
}

async function discoverRoot(
  geminiRoot: string,
  signal: AbortSignal
): Promise<GeminiDiscoveryCandidate[]> {
  let tmpRoot: string
  try { tmpRoot = await canonicalTmpRoot(geminiRoot) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const projects = await readDirectory(tmpRoot)
  if (!projects) return []
  const files: GeminiDiscoveryCandidate[] = []
  for (const project of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    if (signal.aborted) throw new Error('cancelled')
    if (project.isSymbolicLink()) throw new Error('gemini-project-directory-alias-not-allowed')
    if (!project.isDirectory()) continue
    const projectCandidate = path.join(tmpRoot, project.name)
    const projectPath = await resolveContainedPath(projectCandidate, [tmpRoot])
    if (projectPath.filePath !== path.resolve(projectCandidate)) {
      throw new Error('gemini-project-directory-alias-not-allowed')
    }
    const projectStat = await fs.promises.stat(projectPath.filePath)
    if (!projectStat.isDirectory()) continue
    const chatsCandidate = path.join(projectPath.filePath, 'chats')
    let chats: ContainedPath
    try { chats = await resolveContainedPath(chatsCandidate, [projectPath.filePath]) } catch (error) {
      if (isMissingDirectoryRace(error)) continue
      throw error
    }
    const entries = await readDirectory(chats.filePath)
    if (!entries) continue
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = path.join(chats.filePath, entry.name)
      const lexicalEntryPath = path.join(chatsCandidate, entry.name)
      if (entry.isFile() && /^session-.*\.jsonl?$/.test(entry.name)) {
        await resolveContainedPath(entryPath, [chats.filePath])
        files.push({
          filePath: lexicalEntryPath,
          chatsRoot: chats.filePath
        })
      }
      if (!entry.isDirectory()) continue
      const nested = await resolveContainedPath(entryPath, [chats.filePath])
      const nestedStat = await fs.promises.stat(nested.filePath)
      if (!nestedStat.isDirectory()) continue
      const children = await readDirectory(nested.filePath)
      if (!children) continue
      for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
        if (child.isFile() && /\.jsonl?$/.test(child.name)) {
          await resolveContainedPath(path.join(nested.filePath, child.name), [nested.filePath])
          files.push({
            filePath: path.join(chatsCandidate, entry.name, child.name),
            chatsRoot: chats.filePath
          })
        }
      }
    }
  }
  return files
}

async function sourceForFile(
  boundary: GeminiSourceBoundary,
  candidate: GeminiDiscoveryCandidate,
  signal: AbortSignal
): Promise<{ source: SourceRef; mtime: number; issued: IssuedGeminiSource }> {
  const scope = await resolveGeminiSessionScope(boundary, candidate.filePath)
  if (scope.chatsRoot !== candidate.chatsRoot) throw new Error('gemini-source-scope-changed')
  const snapshot = await containedFileSnapshot(
    boundary,
    candidate.filePath,
    signal,
    true,
    'tmp',
    scope.sourceRoot
  )
  const parsed = parseConversation(snapshot.bytes!, snapshot.filePath)
  const sessionId = parsed.metadata.sessionId
  if (!validSessionId(sessionId)) throw new Error('gemini-session-id-invalid')
  return {
    source: {
      kind: 'file',
      stableId: `gemini:${sessionId}`,
      providerId: GEMINI_PROVIDER_ID,
      uri: pathToFileURL(scope.filePath).href,
      displayLocator: scope.filePath,
      fingerprint: { algorithm: 'sha256', value: 'pending' }
    },
    mtime: snapshot.stat.mtimeMs,
    issued: {
      stableId: `gemini:${sessionId}`,
      filePath: scope.filePath,
      chatsRoot: scope.chatsRoot,
      sourceRoot: scope.sourceRoot
    }
  }
}

function parentSessionIdFor(filePath: string, metadata: Record<string, unknown>): string | null {
  if (metadata.kind !== 'subagent') return null
  const parent = path.basename(path.dirname(filePath))
  return validSessionId(parent) ? parent : null
}

function identityFor(source: SourceRef, sessionId: string, parentSessionId: string | null): SessionIdentity {
  const logical = buildCanonicalLogicalSessionIdentity(GEMINI_PROVIDER_ID, source.stableId, sessionId)
  return {
    physicalSourceId: source.stableId,
    logicalSessionKey: logicalSessionKey(logical),
    logicalSessionId: sessionId,
    branchViewId: `gemini:${sessionId}:default`,
    parentBranchViewId: parentSessionId ? `gemini:${parentSessionId}:default` : null
  }
}

function eventId(sourceId: string, recordId: string, kind: string, blockIndex: number | null): string {
  return `gemini-event:${sha256(`${sourceId}\0${recordId}\0${kind}\0${blockIndex ?? ''}`).slice(0, 32)}`
}

function contextUnknown(sequence: number): CanonicalEvent['timeline'] {
  return { archived: true, modelContext: [{ contextRevision: 0, state: 'unknown', fromSequence: sequence, untilSequence: null }] }
}

function provenance(source: SourceRef, formatVersion: string, recordId: string, observedAt: string | null, raw: string): EventProvenance {
  return {
    providerId: GEMINI_PROVIDER_ID,
    sourceRefId: source.stableId,
    parserDataVersion: GEMINI_PARSER_DATA_VERSION,
    formatVersion,
    observedAt,
    sourceRecordId: recordId,
    rawRecordFingerprint: { algorithm: 'sha256', value: sha256(raw) }
  }
}

function usageFrom(tokens: unknown, event: { id: string; messageId: string; recordId: string; model: string | null }): UsageRecord | null {
  if (!isObject(tokens)) return null
  const prompt = counter(tokens.input)
  const candidate = counter(tokens.output)
  const cached = counter(tokens.cached)
  const thoughts = counter(tokens.thoughts)
  const tool = counter(tokens.tool)
  const providerTotal = counter(tokens.total)
  if ([prompt, candidate, cached, thoughts, tool, providerTotal].every((value) => value === null)) return null
  const inputTotal = prompt !== null || tool !== null ? (prompt || 0) + (tool || 0) : null
  const outputTotal = candidate !== null || thoughts !== null ? (candidate || 0) + (thoughts || 0) : null
  const uncached = prompt !== null && cached !== null && cached <= prompt
    ? prompt - cached + (tool || 0)
    : null
  return {
    eventId: event.id,
    turnId: event.messageId,
    modelId: event.model,
    input: { total: inputTotal, uncached, cacheRead: cached, cacheWrite5m: null, cacheWrite1h: null },
    output: { total: outputTotal, visible: candidate, reasoning: thoughts },
    providerTotal,
    aggregation: 'per-message',
    relations: {
      cacheRead: prompt !== null && cached !== null && cached <= prompt ? 'subset-of-input' : 'provider-defined',
      cacheWrite: 'provider-defined',
      reasoning: 'subset-of-output'
    },
    dedupKey: `gemini:usage:${event.recordId}`,
    billingFactKey: `gemini:billing:${event.recordId}`,
    measurement: { source: 'reported', confidence: 'exact', sourceField: 'message.tokens (GenerateContentResponseUsageMetadata)' },
    cost: null,
    priceRevision: null
  }
}

function pages(events: CanonicalEvent[]): CanonicalEvent[][] {
  const output: CanonicalEvent[][] = []
  let current: CanonicalEvent[] = []
  let bytes = 0
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8')
    if (current.length > 0 && (current.length >= 1_000 || bytes + size > GEMINI_CHUNK_BYTE_LIMIT)) {
      output.push(current)
      current = []
      bytes = 0
    }
    current.push(event)
    bytes += size
  }
  if (current.length > 0 || output.length === 0) output.push(current)
  return output
}

async function parseGeminiSourceV2(
  boundary: GeminiSourceBoundary,
  source: SourceRef,
  issued: IssuedGeminiSource,
  expectedFingerprint: Fingerprint,
  signal: AbortSignal,
  mode: ParseChunk['mode'] = 'initial'
): Promise<ParseChunk[]> {
  const snapshot = await readSource(boundary, source, issued, signal)
  const filePath = snapshot.filePath
  const bytes = snapshot.bytes
  const actualFingerprint = fingerprint(bytes)
  if (!sameFingerprint(expectedFingerprint, actualFingerprint)) throw new Error('gemini-source-changed-during-parse')
  const parsed = parseConversation(bytes, filePath)
  const sessionId = parsed.metadata.sessionId
  if (!validSessionId(sessionId)) throw new Error('gemini-session-id-invalid')
  if (source.stableId !== `gemini:${sessionId}`) throw new Error('gemini-source-identity-mismatch')
  const parentSessionId = parentSessionIdFor(filePath, parsed.metadata)
  const identity = identityFor(source, sessionId, parentSessionId)
  const locatorHash = sha256(pathToFileURL(filePath).href)
  const tmpRoot = snapshot.anchorRoot
  const projectDirectory = path.relative(tmpRoot, filePath).split(path.sep)[0]
  const registeredProjectPath = await projectPathFor(boundary, tmpRoot, projectDirectory, signal)
  const persistedDirectories = Array.isArray(parsed.metadata.directories)
    ? parsed.metadata.directories
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .map((entry) => boundedText(entry, 16 * 1024))
    : []
  const projectPath = registeredProjectPath || persistedDirectories[0] || null
  const cwds = persistedDirectories.length > 0
    ? persistedDirectories
    : projectPath ? [boundedText(projectPath, 16 * 1024)] : []
  const events: CanonicalEvent[] = []
  const diagnostics = [...parsed.diagnostics, {
    level: 'info' as const,
    code: 'gemini-format-evidence',
    message: `First-party Apache-2.0 producer source pinned at f47d6c6; AgentsView MIT comparison pinned at 1cd581fe.`,
    eventId: null
  }]
  const registry = createBuiltinToolRegistryV2()
  let sequence = 0

  const emit = (input: {
    stored: StoredRecord | null
    recordId: string
    messageId: string | null
    blockIndex: number | null
    timestamp: string | null
    actor: CanonicalEvent['actor']
    kind: CanonicalEvent['kind']
    payload: JsonValue
    visibility?: CanonicalEvent['visibility']
    classification?: CanonicalEvent['classification']
  }): CanonicalEvent => {
    const raw = input.stored?.raw || JSON.stringify(parsed.metadata)
    const event: CanonicalEvent = {
      id: eventId(source.stableId, input.recordId, input.kind, input.blockIndex),
      identity,
      sharedEventKey: `gemini:shared:${input.recordId}:${input.blockIndex ?? 'event'}:${input.kind}`,
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
      provenance: provenance(source, parsed.formatVersion, input.recordId, input.timestamp, raw),
      rawRef: input.stored
        ? { locatorHash, offset: input.stored.offset, length: input.stored.length }
        : { locatorHash, offset: 0, length: bytes.length }
    }
    events.push(event)
    sequence++
    return event
  }

  const metadataTimestamp = timestamp(parsed.metadata.startTime)
  emit({
    stored: null,
    recordId: 'metadata',
    messageId: null,
    blockIndex: null,
    timestamp: metadataTimestamp,
    actor: 'system',
    kind: 'session.metadata',
    payload: {
      title: typeof parsed.metadata.summary === 'string' ? boundedText(parsed.metadata.summary, 16 * 1024) : null,
      cwd: cwds,
      projectPath: projectPath ? boundedText(projectPath, 16 * 1024) : null
    },
    visibility: 'collapsed',
    classification: 'lifecycle'
  })

  if (parentSessionId) {
    emit({
      stored: null,
      recordId: `relationship:${parentSessionId}`,
      messageId: null,
      blockIndex: null,
      timestamp: metadataTimestamp,
      actor: 'system',
      kind: 'session.lifecycle',
      payload: { relationshipType: 'subagent', parentBranchViewId: `gemini:${parentSessionId}:default` },
      visibility: 'collapsed',
      classification: 'lifecycle'
    })
  }

  for (const operation of parsed.operations) {
    emit({
      stored: operation,
      recordId: `operation:${operation.lineNumber}`,
      messageId: null,
      blockIndex: null,
      timestamp: timestamp((operation.value.$set as Record<string, unknown> | undefined)?.lastUpdated),
      actor: 'system',
      kind: 'unknown',
      payload: { rawType: validSessionId(operation.value.$rewindTo) ? 'gemini.rewind' : 'gemini.metadata-update', rawPayload: jsonValue(operation.value) },
      visibility: 'collapsed',
      classification: 'lifecycle'
    })
  }

  for (const stored of parsed.messages) {
    if (signal.aborted) throw new Error('cancelled')
    const message = stored.value
    const rawId = validSessionId(message.id) ? message.id : `line-${stored.lineNumber}`
    const messageId = boundedText(rawId, 1_024)
    const messageTimestamp = timestamp(message.timestamp)
    const messageType = typeof message.type === 'string' ? message.type : 'unknown'
    const actor: CanonicalEvent['actor'] = messageType === 'user'
      ? 'user'
      : messageType === 'gemini'
        ? 'assistant'
        : ['info', 'error', 'warning'].includes(messageType) ? 'system' : 'unknown'
    let blockIndex = 0
    const callKeys = new Set<string>()
    const resultKeys = new Set<string>()

    const emitText = (kind: 'message.text' | 'message.thinking', text: string, textActor: 'user' | 'assistant' | 'system'): void => {
      for (const fragment of splitText(text)) {
        emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor: textActor, kind, payload: { text: fragment }, visibility: kind === 'message.thinking' ? 'collapsed' : 'primary', classification: actor === 'system' ? 'lifecycle' : 'user-content' })
      }
    }

    const emitToolCall = (nameValue: unknown, argsValue: unknown, idValue: unknown): string => {
      const rawName = typeof nameValue === 'string' && nameValue ? boundedText(nameValue, 1_024) : 'unknown'
      const callId = validSessionId(idValue) ? boundedText(idValue, 1_024) : `gemini-call:${rawId}:${blockIndex}`
      const key = `${callId}\0${rawName}`
      if (callKeys.has(key)) return callId
      callKeys.add(key)
      const input = jsonValue(argsValue ?? {})
      const resolved = registry.resolve({ providerId: GEMINI_PROVIDER_ID, formatVersion: parsed.formatVersion, rawName, callId, input })
      emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor: 'assistant', kind: 'tool.call', payload: { callId, rawName, semanticToolId: resolved.semanticToolId, input: jsonValue(resolved.normalizedInput) }, classification: 'user-content' })
      return callId
    }

    const emitToolResult = (callIdValue: unknown, output: unknown, isError: boolean | null = null): void => {
      const callId = validSessionId(callIdValue) ? boundedText(callIdValue, 1_024) : `gemini-orphan:${rawId}:${blockIndex}`
      const key = `${callId}\0${sha256(JSON.stringify(jsonValue(output)))}`
      if (resultKeys.has(key)) return
      resultKeys.add(key)
      emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor: 'tool', kind: 'tool.result', payload: { callId, output: jsonValue(output), isError, state: isError === true ? 'error' : 'complete' }, classification: 'user-content' })
    }

    const parsePart = (part: unknown): void => {
      if (typeof part === 'string') { emitText('message.text', part, actor === 'assistant' ? 'assistant' : actor === 'system' ? 'system' : 'user'); return }
      if (!isObject(part)) {
        emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor, kind: 'unknown', payload: { rawType: 'gemini.content.unknown', rawPayload: jsonValue(part) }, visibility: 'collapsed' })
        return
      }
      if (typeof part.text === 'string') {
        emitText(part.thought === true ? 'message.thinking' : 'message.text', part.text, part.thought === true ? 'assistant' : actor === 'assistant' ? 'assistant' : actor === 'system' ? 'system' : 'user')
        const extras = Object.fromEntries(Object.entries(part).filter(([key]) => !['text', 'thought'].includes(key)))
        if (Object.keys(extras).length > 0) emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor, kind: 'unknown', payload: { rawType: 'gemini.content.text-metadata', rawPayload: jsonValue(extras) }, visibility: 'collapsed' })
        return
      }
      if (isObject(part.functionCall)) {
        emitToolCall(part.functionCall.name, part.functionCall.args, part.functionCall.id)
        return
      }
      if (isObject(part.functionResponse)) {
        emitToolResult(part.functionResponse.id, part.functionResponse.response)
        return
      }
      if (isObject(part.fileData) && typeof part.fileData.fileUri === 'string') {
        emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor, kind: 'artifact', payload: { uri: boundedText(part.fileData.fileUri, 16 * 1024), mimeType: typeof part.fileData.mimeType === 'string' ? boundedText(part.fileData.mimeType, 1_024) : null }, classification: 'user-content' })
        return
      }
      emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor, kind: 'unknown', payload: { rawType: 'gemini.content.part', rawPayload: jsonValue(part) }, visibility: 'collapsed' })
    }

    if (Array.isArray(message.thoughts)) {
      for (const thought of message.thoughts) {
        if (!isObject(thought) || typeof thought.description !== 'string') continue
        const text = typeof thought.subject === 'string' && thought.subject
          ? `${thought.subject}\n${thought.description}`
          : thought.description
        emitText('message.thinking', text, 'assistant')
      }
    }

    const content = message.content
    if (Array.isArray(content)) content.forEach(parsePart)
    else if (content !== undefined && content !== '') parsePart(content)
    if (message.displayContent !== undefined &&
      JSON.stringify(message.displayContent) !== JSON.stringify(message.content)) {
      emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor, kind: 'unknown', payload: { rawType: 'gemini.displayContent', rawPayload: jsonValue(message.displayContent) }, visibility: 'collapsed', classification: actor === 'system' ? 'lifecycle' : 'user-content' })
    }

    if (Array.isArray(message.toolCalls)) {
      for (const entry of message.toolCalls) {
        if (!isObject(entry)) continue
        const callId = emitToolCall(entry.name, entry.args, entry.id)
        if (Array.isArray(entry.result)) {
          for (const result of entry.result) {
            if (!isObject(result) || !isObject(result.functionResponse)) {
              emitToolResult(callId, result, entry.status === 'error')
              continue
            }
            const response = result.functionResponse
            emitToolResult(response.id ?? callId, response.response, entry.status === 'error')
          }
        } else if (entry.result !== undefined && entry.result !== null) {
          emitToolResult(callId, entry.result, entry.status === 'error')
        }
      }
    }

    for (const field of ['groundingMetadata', 'citationMetadata', 'urlContextMetadata']) {
      if (message[field] === undefined) continue
      emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor: 'assistant', kind: 'unknown', payload: { rawType: `gemini.${field}`, rawPayload: jsonValue(message[field]) }, visibility: 'collapsed', classification: 'user-content' })
    }

    const known = new Set(['id', 'timestamp', 'type', 'content', 'displayContent', 'thoughts', 'tokens', 'model', 'toolCalls', 'groundingMetadata', 'citationMetadata', 'urlContextMetadata'])
    const extras = Object.fromEntries(Object.entries(message).filter(([key]) => !known.has(key)))
    if (Object.keys(extras).length > 0 || blockIndex === 0) {
      emit({ stored, recordId: rawId, messageId, blockIndex: blockIndex++, timestamp: messageTimestamp, actor, kind: 'unknown', payload: { rawType: `gemini.message.${messageType}`, rawPayload: jsonValue(Object.keys(extras).length > 0 ? extras : message) }, visibility: 'collapsed', classification: actor === 'system' ? 'lifecycle' : 'unknown' })
    }

    const usageId = eventId(source.stableId, rawId, 'usage', null)
    const usage = usageFrom(message.tokens, { id: usageId, messageId, recordId: rawId, model: typeof message.model === 'string' ? boundedText(message.model, 1_024) : null })
    if (usage) {
      emit({ stored, recordId: rawId, messageId, blockIndex: null, timestamp: messageTimestamp, actor: 'assistant', kind: 'usage', payload: usage as unknown as JsonValue, visibility: 'collapsed', classification: 'lifecycle' })
      emit({ stored, recordId: `${rawId}:raw-usage`, messageId, blockIndex: null, timestamp: messageTimestamp, actor: 'system', kind: 'unknown', payload: { rawType: 'gemini.usage.rawBuckets', rawPayload: jsonValue(message.tokens) }, visibility: 'collapsed', classification: 'lifecycle' })
    }
  }

  const eventPages = pages(events)
  return eventPages.map((eventPage, chunkIndex): ParseChunk => {
    const done = chunkIndex === eventPages.length - 1
    return {
      providerId: GEMINI_PROVIDER_ID,
      parserDataVersion: GEMINI_PARSER_DATA_VERSION,
      formatVersion: parsed.formatVersion,
      fingerprint: actualFingerprint,
      identity,
      mode,
      chunkIndex,
      previousCursor: chunkIndex === 0 ? null : `gemini:${source.stableId}:${chunkIndex - 1}`,
      cursor: done ? null : `gemini:${source.stableId}:${chunkIndex}`,
      done,
      events: eventPage,
      diagnostics: chunkIndex === 0 ? diagnostics.slice(0, GEMINI_DIAGNOSTIC_LIMIT) : []
    }
  })
}

export function createGeminiProvider(options: GeminiProviderOptions): BuiltinProviderRuntimeV2 {
  const roots = options.roots || [path.join(options.homeDir, '.gemini')]
  const boundary: GeminiSourceBoundary = { configuredRoots: roots.map((root) => path.resolve(root)) }
  let issuedSources = new Map<string, IssuedGeminiSource>()
  const issuedSourceFor = (source: SourceRef): IssuedGeminiSource => {
    const issued = issuedSources.get(source.stableId)
    if (!issued) throw new Error('gemini-source-not-issued')
    return issued
  }
  if (!builtinProviderForSource('gemini')) throw new Error('Gemini provider manifest is not registered.')
  return {
    manifest: structuredClone(GEMINI_PROVIDER_MANIFEST),
    async discover(signal) {
      return providerBoundary(async () => {
        const candidates = (await Promise.all(roots.map((root) => discoverRoot(root, signal)))).flat()
        const byId = new Map<string, { source: SourceRef; mtime: number; issued: IssuedGeminiSource }>()
        for (const candidate of candidates) {
          try {
            const discovered = await sourceForFile(boundary, candidate, signal)
            const existing = byId.get(discovered.source.stableId)
            if (!existing || discovered.mtime > existing.mtime) byId.set(discovered.source.stableId, discovered)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
        const selected = [...byId.values()]
        const sources = selected.map((entry) => entry.source)
          .sort((left, right) => left.displayLocator.localeCompare(right.displayLocator))
        issuedSources = new Map(selected.map((entry) => [entry.source.stableId, entry.issued]))
        return sources
      })
    },
    async fingerprint(source, signal) {
      return providerBoundary(async () => {
        const issued = issuedSourceFor(source)
        return fingerprint((await readSource(boundary, source, issued, signal)).bytes)
      })
    },
    async inputBytes(source, signal) {
      return providerBoundary(async () => {
        const issued = issuedSourceFor(source)
        return (await issuedSourceSnapshot(boundary, source, issued, signal, false)).stat.size
      })
    },
    parse(source, expected, signal) {
      return providerBoundary(() => parseGeminiSourceV2(
        boundary,
        source,
        issuedSourceFor(source),
        expected,
        signal
      ))
    }
  }
}

export const GEMINI_REFERENCE_SOURCES = { official: OFFICIAL_SOURCE, agentsView: AGENTSVIEW_SOURCE } as const
