import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

export type EvidenceStatus = 'observed' | 'unknown'
export type NonoDimension = 'platform' | 'profile' | 'network' | 'integrity' | 'attestation' | 'filesystem' | 'rollback'

export interface NonoEvidenceSummary {
  kind: 'nono'
  schemaId: 'nono.audit-session'
  sourceVersion: '1'
  sessionId: string
  eventCount: number
  dimensions: Record<NonoDimension, EvidenceStatus>
}

export interface ClaudeTapEvidenceSummary {
  kind: 'claude-tap'
  schemaId: 'claude-tap.capture'
  sourceVersion: '1'
  hasSystemPrompt: boolean
  hasTools: boolean
  hasRequestDiff: boolean
  hasTokenEvidence: boolean
  hasTrace: boolean
  traceEventCount: number
}

export interface NonoDiscovery {
  sessionPath: string
  eventsPath: string
}

export interface OfficialVerifierPreview {
  providerId: 'nono'
  executable: 'nono'
  args: readonly ['verify', '--audit', string]
  reads: readonly [string]
  writes: readonly []
  network: 'provider-defined-unknown'
  requested: false
}

function object(value: unknown, code = 'external-evidence:invalid-object'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  return value as Record<string, unknown>
}

function requiredString(root: Record<string, unknown>, key: string): string {
  if (typeof root[key] !== 'string' || root[key] === '') throw new Error(`external-evidence:missing-${key}`)
  return root[key] as string
}

function exactVersion(root: Record<string, unknown>, expected: string): void {
  if (root.schema_version !== expected) throw new Error('external-evidence:unsupported-source-version')
}

/** Parse only the documented metadata surface; sensitive values never leave this adapter. */
export function parseNonoAuditSession(value: unknown, ndjsonText: string): NonoEvidenceSummary {
  const root = object(value)
  exactVersion(root, '1')
  if (root.schema !== 'nono.audit-session') throw new Error('external-evidence:schema-mismatch')
  const sessionId = requiredString(root, 'session_id')
  const dimensions = object(root.dimensions, 'external-evidence:nono-dimensions-required')
  const names: NonoDimension[] = ['platform', 'profile', 'network', 'integrity', 'attestation', 'filesystem', 'rollback']
  const parsedEvents = ndjsonText.length === 0 ? [] : ndjsonText.split('\n').filter(Boolean).map((line, index) => {
    try { return object(JSON.parse(line)) } catch { throw new Error(`external-evidence:nono-ndjson-truncated:${index + 1}`) }
  })
  for (const event of parsedEvents) {
    if (event.schema_version !== '1' || event.schema !== 'nono.audit-event') throw new Error('external-evidence:unsupported-source-version')
    if (event.session_id !== sessionId) throw new Error('external-evidence:nono-session-mismatch')
  }
  return {
    kind: 'nono', schemaId: 'nono.audit-session', sourceVersion: '1', sessionId, eventCount: parsedEvents.length,
    dimensions: Object.fromEntries(names.map((name) => [name, dimensions[name] === undefined ? 'unknown' : 'observed'])) as Record<NonoDimension, EvidenceStatus>
  }
}

/** Parse presence/counts only. Prompt, tool arguments and trace bodies remain private source bytes. */
export function parseClaudeTapCapture(value: unknown): ClaudeTapEvidenceSummary {
  const root = object(value)
  exactVersion(root, '1')
  if (root.schema !== 'claude-tap.capture') throw new Error('external-evidence:schema-mismatch')
  const trace = root.trace
  if (trace !== undefined && !Array.isArray(trace)) throw new Error('external-evidence:ctap-trace-invalid')
  return {
    kind: 'claude-tap', schemaId: 'claude-tap.capture', sourceVersion: '1',
    hasSystemPrompt: typeof root.system_prompt === 'string', hasTools: Array.isArray(root.tools),
    hasRequestDiff: root.request_diff !== undefined, hasTokenEvidence: root.usage !== undefined,
    hasTrace: Array.isArray(trace), traceEventCount: Array.isArray(trace) ? trace.length : 0
  }
}

/** Legacy display helpers remain metadata-only and intentionally make no validity claim. */
export function summarizeNonoEvidence(value: unknown): Omit<NonoEvidenceSummary, 'schemaId' | 'sourceVersion' | 'sessionId' | 'eventCount'> {
  const root = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const present = (key: string): EvidenceStatus => root[key] === undefined ? 'unknown' : 'observed'
  return { kind: 'nono', dimensions: { platform: present('platform'), profile: present('profile'), network: present('network'), integrity: present('integrity'), attestation: present('attestation'), filesystem: present('filesystem'), rollback: present('rollback') } }
}

export function summarizeClaudeTapEvidence(value: unknown): Omit<ClaudeTapEvidenceSummary, 'schemaId' | 'sourceVersion' | 'traceEventCount'> {
  const root = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return { kind: 'claude-tap', hasSystemPrompt: root.system_prompt !== undefined, hasTools: root.tools !== undefined, hasRequestDiff: root.request_diff !== undefined, hasTokenEvidence: root.usage !== undefined, hasTrace: root.trace !== undefined }
}

async function assertSafeRegularFile(rootPath: string, candidate: string): Promise<string> {
  const root = await realpath(rootPath)
  const lexical = resolve(root, candidate)
  if (lexical !== root && !lexical.startsWith(`${root}${sep}`)) throw new Error('external-evidence:unsafe-source-path')
  const stat = await lstat(lexical)
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('external-evidence:unsafe-source-file')
  const physical = await realpath(lexical)
  if (!physical.startsWith(`${root}${sep}`)) throw new Error('external-evidence:unsafe-source-path')
  return physical
}

export async function discoverNonoAuditSessions(rootPath: string): Promise<NonoDiscovery[]> {
  const names = await readdir(rootPath)
  const result: NonoDiscovery[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.session.json')) continue
    const sessionPath = await assertSafeRegularFile(rootPath, name)
    const eventsPath = await assertSafeRegularFile(rootPath, `${name.slice(0, -'.session.json'.length)}.events.ndjson`)
    result.push({ sessionPath, eventsPath })
  }
  return result
}

export async function readExternalEvidenceFile(rootPath: string, relativePath: string, maxBytes: number): Promise<Uint8Array> {
  const physical = await assertSafeRegularFile(rootPath, relativePath)
  const handle = await open(physical, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (stat.size > maxBytes) throw new Error('external-evidence:size-limit-exceeded')
    return new Uint8Array(await handle.readFile())
  } finally { await handle.close() }
}

export function previewNonoOfficialVerifier(auditPath: string): OfficialVerifierPreview {
  return { providerId: 'nono', executable: 'nono', args: ['verify', '--audit', auditPath], reads: [auditPath], writes: [], network: 'provider-defined-unknown', requested: false }
}
