import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { builtinProviderForSource } from '../../shared/provider-capabilities'
import {
  type CanonicalRecord,
  type Fingerprint,
  type JsonValue,
  type MessageContent,
  type ParseOutcome,
  type ProviderError,
  type RecordProvenance,
  type SourceRef
} from '../../shared/provider-schema.generated'
import {
  providerFingerprint,
  stableCanonicalRecordId
} from '../../shared/provider-protocol'
import type { BuiltinProviderRuntime } from '../provider-host'

const PI_PROVIDER_ID = 'swob/pi'
const PI_FORMAT_V1 = 'pi-jsonl-v1'
const PI_FORMAT_V3 = 'pi-jsonl-v3'

interface PiProviderOptions {
  homeDir: string
  roots?: string[]
}

interface PiHeader {
  type: 'session'
  version?: number
  id?: string
  timestamp?: string
  cwd?: string
  title?: string
  branchedFrom?: string
}

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  name?: string
  modelId?: string
  summary?: string
  message?: {
    role?: string
    content?: unknown
    model?: string
    timestamp?: number
    toolCallId?: string
    toolName?: string
    isError?: boolean
    usage?: Record<string, unknown>
  }
}

function providerError(
  code: ProviderError['code'],
  message: string,
  sourceRefId: string | null,
  recordId: string | null = null,
  details: ProviderError['details'] = null
): ProviderError {
  return {
    code,
    message,
    retryable: false,
    providerId: PI_PROVIDER_ID,
    sourceRefId,
    recordId,
    details
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
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

function timestampFor(entry: PiEntry): string | null {
  if (typeof entry.timestamp === 'string' && Number.isFinite(Date.parse(entry.timestamp))) {
    return new Date(entry.timestamp).toISOString()
  }
  const milliseconds = entry.message?.timestamp
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : null
}

function textAndThinking(content: unknown): MessageContent[] {
  if (typeof content === 'string') return [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((part): MessageContent[] => {
    const item = asObject(part)
    if (!item) return []
    if (item.type === 'text' && typeof item.text === 'string') {
      return [{ kind: 'text', text: item.text }]
    }
    if (item.type === 'thinking' && typeof item.thinking === 'string') {
      return [{ kind: 'thinking', text: item.thinking }]
    }
    return []
  })
}

function toolCalls(content: unknown): Array<{ id: string; name: string; input: JsonValue }> {
  if (!Array.isArray(content)) return []
  return content.flatMap((part, index) => {
    const item = asObject(part)
    if (!item || item.type !== 'toolCall' || typeof item.name !== 'string' || !item.name) return []
    return [{
      id: typeof item.id === 'string' && item.id ? item.id : `tool-${index}`,
      name: item.name,
      input: jsonValue(item.arguments ?? {})
    }]
  })
}

function contentJson(content: unknown): JsonValue {
  return jsonValue(content ?? '')
}

function optionalInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function usageValue(usage: Record<string, unknown>, direct: string, nested?: string): number | null {
  const directValue = optionalInteger(usage[direct])
  if (directValue !== null || !nested) return directValue
  const cache = asObject(usage.cache)
  return optionalInteger(cache?.[nested])
}

function costValue(usage: Record<string, unknown>): number | null {
  const cost = asObject(usage.cost)
  const value = cost?.total
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sourcePath(source: SourceRef): string {
  if (source.kind !== 'file') throw new Error('Pi provider accepts file sources only.')
  const resolved = fileURLToPath(source.uri)
  if (!path.isAbsolute(resolved)) throw new Error('Pi provider source URI must be absolute.')
  return resolved
}

async function readHeader(filePath: string, signal?: AbortSignal): Promise<PiHeader | null> {
  const handle = await fs.promises.open(filePath, 'r')
  try {
    if (signal?.aborted) throw new Error('cancelled')
    const buffer = Buffer.alloc(128 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const lines = buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { return null }
      const candidate = asObject(value)
      if (candidate?.type === 'title') continue
      return candidate?.type === 'session' ? candidate as unknown as PiHeader : null
    }
    return null
  } finally {
    await handle.close()
  }
}

async function discoverFiles(root: string, signal: AbortSignal): Promise<string[]> {
  const files: string[] = []
  const visited = new Set<string>()
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (signal.aborted) throw new Error('cancelled')
    if (depth > 6) return
    let realDirectory: string
    try { realDirectory = await fs.promises.realpath(directory) } catch { return }
    if (visited.has(realDirectory)) return
    visited.add(realDirectory)
    let entries: fs.Dirent[]
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (signal.aborted) throw new Error('cancelled')
      if (entry.name.startsWith('.')) continue
      const child = path.join(directory, entry.name)
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(child)
      else if (entry.isDirectory() || entry.isSymbolicLink()) await walk(child, depth + 1)
    }
  }
  await walk(root, 0)
  return files
}

function stableSourceId(header: PiHeader, filePath: string): string {
  const sessionId = header.id?.trim() || path.basename(filePath, path.extname(filePath))
  return `pi:${sessionId.normalize('NFC')}`
}

function recordId(source: SourceRef, recordType: string, sourceRecordId: string): string {
  return stableCanonicalRecordId({
    providerId: PI_PROVIDER_ID,
    sourceRefStableId: source.stableId,
    recordType,
    sourceRecordId
  })
}

function provenance(
  source: SourceRef,
  formatVersion: string,
  observedAt: string | null,
  rawLine?: string
): RecordProvenance {
  return {
    providerId: PI_PROVIDER_ID,
    sourceRefId: source.stableId,
    parserDataVersion: '1',
    formatVersion,
    observedAt,
    ...(rawLine ? {
      rawRecordFingerprint: { algorithm: 'sha256', value: providerFingerprint(rawLine) }
    } : {})
  }
}

async function parsePiSource(source: SourceRef, fingerprint: Fingerprint, signal: AbortSignal): Promise<ParseOutcome> {
  const filePath = sourcePath(source)
  const text = await fs.promises.readFile(filePath, { encoding: 'utf8', signal })
  const lines = text.split(/\r?\n/)
  let header: PiHeader | null = null
  let headerLine = ''
  let headerIndex = -1
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { break }
    const item = asObject(parsed)
    if (item?.type === 'title') continue
    if (item?.type === 'session') {
      header = item as unknown as PiHeader
      headerLine = line
      headerIndex = index
    }
    break
  }
  if (!header) {
    const error = providerError('format-unsupported', 'Pi JSONL is missing its session header.', source.stableId)
    return {
      providerId: PI_PROVIDER_ID,
      parserDataVersion: '1',
      formatVersion: null,
      fingerprint,
      status: 'error',
      sessions: [],
      errors: [error],
      tombstones: []
    }
  }

  const sourceSessionId = header.id?.trim() || path.basename(filePath, path.extname(filePath))
  const formatVersion = typeof header.version === 'number' && header.version >= 3 ? PI_FORMAT_V3 : PI_FORMAT_V1
  const sessionRecordId = recordId(source, 'session', `session:${sourceSessionId}`)
  const observedAt = new Date().toISOString()
  const records: CanonicalRecord[] = []
  const errors: ProviderError[] = []
  let currentModel: string | null = null
  let providerTitle = header.title?.trim() || null
  let lastTimestamp = typeof header.timestamp === 'string' && Number.isFinite(Date.parse(header.timestamp))
    ? new Date(header.timestamp).toISOString()
    : null
  let ordinal = 0

  records.push({
    id: sessionRecordId,
    recordType: 'session',
    sourceRef: { ...source, fingerprint } as SourceRef,
    sourceSessionId,
    createdAt: lastTimestamp,
    updatedAt: lastTimestamp,
    cwd: header.cwd ? [header.cwd] : [],
    projectPath: header.cwd || null,
    providerTitle,
    provenance: provenance(source, formatVersion, observedAt, headerLine)
  })

  for (let index = headerIndex + 1; index < lines.length; index++) {
    if (signal.aborted) throw new Error('cancelled')
    const line = lines[index].trim()
    if (!line) continue
    let entry: PiEntry
    try {
      entry = JSON.parse(line) as PiEntry
    } catch {
      errors.push(providerError(
        'partial-data',
        `Pi JSONL line ${index + 1} is malformed and was not imported.`,
        source.stableId,
        null,
        { line: index + 1 }
      ))
      continue
    }
    const timestamp = timestampFor(entry)
    if (timestamp && (!lastTimestamp || timestamp > lastTimestamp)) lastTimestamp = timestamp
    const entryId = entry.id || `line:${index + 1}`

    if (entry.type === 'model_change') {
      if (entry.modelId) currentModel = entry.modelId
      continue
    }
    if (entry.type === 'session_info') {
      if (typeof entry.name === 'string' && entry.name.trim()) providerTitle = entry.name.trim()
      continue
    }
    if (entry.type === 'compaction') {
      const messageId = recordId(source, 'message', entryId)
      records.push({
        id: messageId,
        recordType: 'message',
        sessionRecordId,
        ordinal: ordinal++,
        role: 'system',
        timestamp,
        content: typeof entry.summary === 'string' ? [{ kind: 'text', text: entry.summary }] : [],
        provenance: provenance(source, formatVersion, observedAt, line)
      })
      continue
    }
    if (entry.type !== 'message' || !entry.message?.role) continue

    const role = entry.message.role
    if (role === 'user' || role === 'assistant') {
      const messageId = recordId(source, 'message', entryId)
      records.push({
        id: messageId,
        recordType: 'message',
        sessionRecordId,
        ordinal: ordinal++,
        role,
        timestamp,
        content: textAndThinking(entry.message.content),
        provenance: provenance(source, formatVersion, observedAt, line)
      })
      if (role === 'assistant') {
        const model: string | null = typeof entry.message.model === 'string'
          ? entry.message.model
          : currentModel
        if (model) currentModel = model
        for (const call of toolCalls(entry.message.content)) {
          records.push({
            id: recordId(source, 'tool-call', call.id),
            recordType: 'tool-call',
            sessionRecordId,
            messageRecordId: messageId,
            ordinal: ordinal++,
            name: call.name,
            input: call.input,
            provenance: provenance(source, formatVersion, observedAt, line)
          })
        }
        const usage = entry.message.usage
        if (usage || model) {
          const inputTokens = usage ? usageValue(usage, 'input') : null
          const outputTokens = usage ? usageValue(usage, 'output') : null
          const cacheReadTokens = usage ? usageValue(usage, 'cacheRead', 'read') : null
          const cacheWriteTokens = usage ? usageValue(usage, 'cacheCreation', 'write') : null
          const reported = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
            .some((value) => value !== null)
          records.push({
            id: recordId(source, 'usage', entryId),
            recordType: 'usage',
            sessionRecordId,
            messageRecordId: messageId,
            timestamp,
            model: model || null,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens: null,
            costUsd: usage ? costValue(usage) : null,
            usageProvenance: reported ? 'reported' : 'unavailable',
            provenance: provenance(source, formatVersion, observedAt, line)
          })
        }
      }
      continue
    }

    if (role === 'toolResult') {
      const toolCallId = entry.message.toolCallId || `missing:${entryId}`
      records.push({
        id: recordId(source, 'tool-result', entryId),
        recordType: 'tool-result',
        sessionRecordId,
        toolCallRecordId: recordId(source, 'tool-call', toolCallId),
        timestamp,
        content: contentJson(entry.message.content),
        isError: typeof entry.message.isError === 'boolean' ? entry.message.isError : null,
        provenance: provenance(source, formatVersion, observedAt, line)
      })
    }
  }

  const sessionRecord = records[0]
  if (sessionRecord.recordType === 'session') {
    sessionRecord.updatedAt = lastTimestamp
    sessionRecord.providerTitle = providerTitle
  }

  if (header.branchedFrom) {
    const parentSessionId = path.basename(header.branchedFrom, path.extname(header.branchedFrom))
    const parentSourceRefId = `pi:${parentSessionId.normalize('NFC')}`
    const parentSessionRecordId = stableCanonicalRecordId({
      providerId: PI_PROVIDER_ID,
      sourceRefStableId: parentSourceRefId,
      recordType: 'session',
      sourceRecordId: `session:${parentSessionId}`
    })
    records.push({
      id: recordId(source, 'relationship', `parent:${parentSessionId}`),
      recordType: 'relationship',
      fromSessionRecordId: parentSessionRecordId,
      toSessionRecordId: sessionRecordId,
      relationshipType: 'parent-child',
      provenance: provenance(source, formatVersion, observedAt)
    })
  }

  const sessionStatus = errors.length > 0 ? 'partial' : 'complete'
  return {
    providerId: PI_PROVIDER_ID,
    parserDataVersion: '1',
    formatVersion,
    fingerprint,
    status: sessionStatus,
    sessions: [{
      sourceRefId: source.stableId,
      sessionRecordId,
      status: sessionStatus,
      records,
      errors,
      replaceSessionRecordId: null,
      noDataReason: null
    }],
    errors,
    tombstones: []
  }
}

export function createPiProvider(options: PiProviderOptions): BuiltinProviderRuntime {
  const definition = builtinProviderForSource('pi')
  if (!definition) throw new Error('Pi provider manifest is not registered.')
  const roots = options.roots || [path.join(options.homeDir, '.pi', 'agent', 'sessions')]
  return {
    manifest: structuredClone(definition.manifest),
    async discover(signal) {
      const candidates = (await Promise.all(roots.map((root) => discoverFiles(root, signal)))).flat()
      const byStableId = new Map<string, { source: SourceRef; mtimeMs: number }>()
      for (const filePath of candidates) {
        const header = await readHeader(filePath, signal)
        if (!header) continue
        const stableId = stableSourceId(header, filePath)
        const stat = await fs.promises.stat(filePath)
        const source: SourceRef = {
          kind: 'file',
          stableId,
          providerId: PI_PROVIDER_ID,
          uri: pathToFileURL(filePath).href,
          displayLocator: filePath,
          fingerprint: { algorithm: 'sha256', value: 'pending' }
        }
        const current = byStableId.get(stableId)
        if (!current || stat.mtimeMs > current.mtimeMs) byStableId.set(stableId, { source, mtimeMs: stat.mtimeMs })
      }
      return [...byStableId.values()].map((entry) => entry.source)
        .sort((left, right) => left.displayLocator.localeCompare(right.displayLocator))
    },
    async fingerprint(source, signal) {
      const hash = createHash('sha256')
      const stream = fs.createReadStream(sourcePath(source))
      try {
        for await (const chunk of stream) {
          if (signal.aborted) throw new Error('cancelled')
          hash.update(chunk as Buffer)
        }
      } finally {
        stream.destroy()
      }
      return { algorithm: 'sha256', value: hash.digest('hex') }
    },
    async inputBytes(source, signal) {
      if (signal.aborted) throw new Error('cancelled')
      return (await fs.promises.stat(sourcePath(source))).size
    },
    parse: parsePiSource
  }
}
