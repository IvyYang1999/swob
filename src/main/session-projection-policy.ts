import { builtinProviderForId, isLegacySessionSource } from '../shared/provider-capabilities'
import { detectSessionSourceFromPath } from './session-source'
import type { SessionSource } from './types'

export interface SessionProjectionEvidence {
  canonicalProviderId?: string
  logicalSourceFamily?: string
  sourceFilePaths?: readonly string[]
}

/** Resolve only evidenced source identity. Unknown Library-only data stays visible. */
export function resolveSessionProjectionSource(
  evidence: SessionProjectionEvidence
): SessionSource | null {
  if (evidence.canonicalProviderId) {
    const canonical = builtinProviderForId(evidence.canonicalProviderId)?.sourceId
    if (canonical) return canonical
  }
  for (const sourcePath of evidence.sourceFilePaths || []) {
    const source = detectSessionSourceFromPath(sourcePath)
    if (source) return source
  }
  return evidence.logicalSourceFamily && isLegacySessionSource(evidence.logicalSourceFamily)
    ? evidence.logicalSourceFamily
    : null
}

export function isSessionSourceProjected(
  source: SessionSource | null | undefined,
  excludedSources: readonly string[]
): boolean {
  // No evidence means Library-only/remote data, not an implicit Claude row.
  return source == null || !excludedSources.includes(source)
}

export function filterProjectedPhysicalSourcePaths(
  sourcePaths: readonly string[],
  excludedSources: readonly string[]
): string[] {
  return sourcePaths.filter((sourcePath) => {
    // This helper is only for physical discovery. Its historical unknown
    // fallback is Claude JSONL, unlike unknown Library-only package evidence.
    const source = detectSessionSourceFromPath(sourcePath) || 'claude-code'
    return isSessionSourceProjected(source, excludedSources)
  })
}
