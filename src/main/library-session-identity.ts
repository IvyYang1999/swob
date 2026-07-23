import { createHash } from 'node:crypto'
import { detectSessionSourceFromPath } from './session-source'
import type { SessionSource, SessionSummary } from './types'

export const LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION = 1 as const

export type LogicalSourceFamily = SessionSource | 'legacy-ambiguous' | `${string}/${string}`

export type LogicalSourceInstance =
  | { kind: 'default'; id: 'default' }
  | { kind: 'named'; id: string }
  | { kind: 'legacy-ambiguous'; id: 'legacy-ambiguous' }

export interface LogicalSessionIdentity {
  schemaVersion: typeof LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION
  sourceFamily: LogicalSourceFamily
  sourceInstance: LogicalSourceInstance
  sessionId: string
}

export type LogicalSessionKey = string & { readonly __logicalSessionKey: unique symbol }

interface LegacyIdentityMeta {
  sessionId: string
  sourceFilePaths?: string[]
  logicalIdentity?: LogicalSessionIdentity
  sourceInstance?: {
    kind: 'claude-default' | 'claude-window' | 'other'
    configDir?: string
  }
}

const SOURCE_FAMILIES = new Set<LogicalSourceFamily>([
  'claude-code',
  'codex',
  'cursor',
  'opencode',
  'zcode',
  'cc-mirror',
  'antigravity',
  'grok',
  'pi',
  'kimi',
  'hermes',
  'legacy-ambiguous'
])

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/

function stableNamedInstance(namespace: string, semanticName: string): LogicalSourceInstance {
  const digest = createHash('sha256')
    .update(`${namespace}\0${semanticName.normalize('NFC')}`)
    .digest('hex')
    .slice(0, 24)
  return { kind: 'named', id: `${namespace}:${digest}` }
}

function normalizedSegments(filePath: string): string[] {
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(filePath) || /^[\\/]{2}[^\\/]/.test(filePath) || filePath.includes('\\')
  const normalized = filePath.replace(/\\/g, '/').normalize('NFC')
  return normalized.split('/').filter(Boolean).map((segment) =>
    windowsPath ? segment.toLocaleLowerCase('en-US') : segment
  )
}

function configuredRootInstance(
  sourceFamily: SessionSource,
  segments: string[],
  anchor: string,
  defaultRootNames: string[]
): LogicalSourceInstance | null {
  const anchorIndex = segments.lastIndexOf(anchor)
  if (anchorIndex <= 0) return null
  const rootName = segments[anchorIndex - 1]
  if (defaultRootNames.includes(rootName)) return { kind: 'default', id: 'default' }
  return stableNamedInstance(`${sourceFamily}-config`, rootName)
}

function semanticInstanceFromPath(
  sourceFamily: SessionSource,
  filePath: string
): LogicalSourceInstance | null {
  const segments = normalizedSegments(filePath)
  if (sourceFamily === 'claude-code') {
    const windowIndex = segments.lastIndexOf('.claude-window')
    if (windowIndex >= 0 && segments[windowIndex + 1]) {
      return stableNamedInstance('claude-window', segments[windowIndex + 1])
    }
    if (segments.includes('.claude') && segments.includes('projects')) {
      return { kind: 'default', id: 'default' }
    }
    return null
  }

  if (sourceFamily === 'cc-mirror') {
    const mirrorIndex = segments.lastIndexOf('.cc-mirror')
    if (mirrorIndex >= 0 && segments[mirrorIndex + 1]) {
      return stableNamedInstance('cc-mirror', segments[mirrorIndex + 1])
    }
    return null
  }

  if (sourceFamily === 'codex') {
    return configuredRootInstance(sourceFamily, segments, 'sessions', ['.codex'])
  }
  if (sourceFamily === 'cursor') {
    return configuredRootInstance(sourceFamily, segments, 'projects', ['.cursor'])
  }
  if (sourceFamily === 'zcode') {
    const defaultIndex = segments.lastIndexOf('.zcode')
    if (defaultIndex >= 0) return { kind: 'default', id: 'default' }
    const named = segments.find((segment) => segment.startsWith('.zcode-'))
    return named ? stableNamedInstance('zcode-config', named) : null
  }
  if (sourceFamily === 'opencode') {
    const dbIndex = segments.lastIndexOf('opencode.db')
    if (dbIndex > 0 && segments[dbIndex - 1] === 'opencode') return { kind: 'default', id: 'default' }
    return null
  }
  if (sourceFamily === 'antigravity') {
    return segments.includes('antigravity') ? { kind: 'default', id: 'default' } : null
  }
  if (sourceFamily === 'grok') {
    if (segments.includes('.grok')) return stableNamedInstance('grok-config', '.grok')
    if (segments.includes('.factory')) return stableNamedInstance('grok-config', '.factory')
    return null
  }
  if (sourceFamily === 'pi') {
    return segments.includes('.pi') ? { kind: 'default', id: 'default' } : null
  }
  if (sourceFamily === 'kimi') {
    return segments.includes('.kimi-code') ? { kind: 'default', id: 'default' } : null
  }
  if (sourceFamily === 'hermes') {
    return segments.includes('.hermes') ? { kind: 'default', id: 'default' } : null
  }
  return null
}

function identityFromEvidence(
  sessionId: string,
  explicitSource: SessionSource | undefined,
  sourceFilePaths: string[]
): LogicalSessionIdentity {
  const detectedSources = new Set<SessionSource>()
  for (const sourceFilePath of sourceFilePaths) {
    const detected = detectSessionSourceFromPath(sourceFilePath)
    if (detected) detectedSources.add(detected)
  }

  if (explicitSource) detectedSources.add(explicitSource)
  if (detectedSources.size !== 1) return legacyAmbiguousIdentity(sessionId)

  const sourceFamily = [...detectedSources][0]
  let sourceInstance: LogicalSourceInstance | null = null
  for (const sourceFilePath of sourceFilePaths) {
    const detected = detectSessionSourceFromPath(sourceFilePath)
    if (detected && detected !== sourceFamily) continue
    if (!detected && explicitSource !== sourceFamily) continue
    const candidate = semanticInstanceFromPath(sourceFamily, sourceFilePath)
    if (!candidate) continue
    if (sourceInstance && JSON.stringify(sourceInstance) !== JSON.stringify(candidate)) {
      return legacyAmbiguousIdentity(sessionId)
    }
    sourceInstance = candidate
  }

  // Provider names alone cannot prove which configurable installation produced
  // the session. Require path evidence instead of collapsing all roots to default.
  if (!sourceInstance) return legacyAmbiguousIdentity(sessionId)

  return {
    schemaVersion: LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION,
    sourceFamily,
    sourceInstance,
    sessionId
  }
}

export function legacyAmbiguousIdentity(sessionId: string): LogicalSessionIdentity {
  return {
    schemaVersion: LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION,
    sourceFamily: 'legacy-ambiguous',
    sourceInstance: { kind: 'legacy-ambiguous', id: 'legacy-ambiguous' },
    sessionId
  }
}

/**
 * Canonical providers identify a logical package without persisting an
 * absolute source path. The stable source ref is hashed into the semantic
 * instance while the namespaced provider id remains visible in the key.
 */
export function buildCanonicalLogicalSessionIdentity(
  providerId: string,
  sourceRefStableId: string,
  canonicalSessionId: string
): LogicalSessionIdentity {
  if (!PROVIDER_ID_RE.test(providerId) || !sourceRefStableId || !canonicalSessionId) {
    throw new Error('invalid-canonical-logical-session-identity')
  }
  return {
    schemaVersion: LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION,
    sourceFamily: providerId as `${string}/${string}`,
    sourceInstance: stableNamedInstance('provider-source', `${providerId}\0${sourceRefStableId}`),
    sessionId: canonicalSessionId
  }
}

export function buildLogicalSessionIdentityFromSummary(
  session: Pick<SessionSummary, 'sessionId' | 'filePath' | 'allFilePaths' | 'source'>
): LogicalSessionIdentity {
  const sourceFilePaths = session.allFilePaths?.length ? session.allFilePaths : [session.filePath]
  return identityFromEvidence(session.sessionId, session.source, sourceFilePaths.filter(Boolean))
}

export function buildLogicalSessionIdentityFromMeta(meta: LegacyIdentityMeta): LogicalSessionIdentity {
  if (meta.logicalIdentity && isValidLogicalSessionIdentity(meta.logicalIdentity) &&
    meta.logicalIdentity.sessionId === meta.sessionId) {
    return structuredClone(meta.logicalIdentity)
  }
  const sourceFilePaths = meta.sourceFilePaths || []
  const fromPaths = identityFromEvidence(meta.sessionId, undefined, sourceFilePaths)
  if (fromPaths.sourceFamily !== 'legacy-ambiguous') return fromPaths

  // The old sourceInstance field is usable only for the Claude variants it
  // explicitly named. `other` cannot distinguish Codex/Cursor/etc. and remains
  // ambiguous. Only the semantic segment is hashed; configDir itself is discarded.
  if (!sourceFilePaths.some((sourceFilePath) => detectSessionSourceFromPath(sourceFilePath))) {
    if (meta.sourceInstance?.kind === 'claude-default') {
      return {
        schemaVersion: LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION,
        sourceFamily: 'claude-code',
        sourceInstance: { kind: 'default', id: 'default' },
        sessionId: meta.sessionId
      }
    }
    if (meta.sourceInstance?.kind === 'claude-window' && meta.sourceInstance.configDir) {
      const segments = normalizedSegments(meta.sourceInstance.configDir)
      const windowIndex = segments.lastIndexOf('.claude-window')
      if (windowIndex >= 0 && segments[windowIndex + 1]) {
        return {
          schemaVersion: LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION,
          sourceFamily: 'claude-code',
          sourceInstance: stableNamedInstance('claude-window', segments[windowIndex + 1]),
          sessionId: meta.sessionId
        }
      }
    }
  }
  return fromPaths
}

export function isValidLogicalSessionIdentity(value: unknown): value is LogicalSessionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const identity = value as Record<string, unknown>
  if (identity.schemaVersion !== LOGICAL_SESSION_IDENTITY_SCHEMA_VERSION ||
    typeof identity.sessionId !== 'string' || identity.sessionId.length === 0 ||
    typeof identity.sourceFamily !== 'string' ||
    (!SOURCE_FAMILIES.has(identity.sourceFamily as LogicalSourceFamily) && !PROVIDER_ID_RE.test(identity.sourceFamily)) ||
    !identity.sourceInstance || typeof identity.sourceInstance !== 'object' || Array.isArray(identity.sourceInstance)) {
    return false
  }
  const instance = identity.sourceInstance as Record<string, unknown>
  if (instance.kind === 'default') return instance.id === 'default' && identity.sourceFamily !== 'legacy-ambiguous'
  if (instance.kind === 'legacy-ambiguous') {
    return instance.id === 'legacy-ambiguous' && identity.sourceFamily === 'legacy-ambiguous'
  }
  return instance.kind === 'named' && typeof instance.id === 'string' &&
    /^[a-z0-9-]+:[0-9a-f]{24}$/.test(instance.id) && identity.sourceFamily !== 'legacy-ambiguous'
}

export function logicalSessionKey(identity: LogicalSessionIdentity): LogicalSessionKey {
  if (!isValidLogicalSessionIdentity(identity)) throw new Error('invalid-logical-session-identity')
  return [
    `v${identity.schemaVersion}`,
    identity.sourceFamily,
    identity.sourceInstance.kind,
    identity.sourceInstance.id,
    identity.sessionId
  ].join('\0') as LogicalSessionKey
}
