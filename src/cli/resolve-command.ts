import * as fs from 'fs'
import { getSessionLineagePath, type SessionLineageRegistry } from '../main/session-lineage'

export interface ResolveSessionResult {
  input: string
  resolved: string
  matched: boolean
  ambiguous?: boolean
  exact?: boolean
  candidates?: string[]
  lineageInvalid?: boolean
  diagnostic?: string
}

interface ResolveCandidate {
  matchedId: string
  resolved: string
  kind: 'alias' | 'manifest'
}

function fallback(input: string): ResolveSessionResult {
  return { input, resolved: input, matched: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readSessionLineageRegistry(libraryRoot: string): SessionLineageRegistry | null {
  const registryPath = getSessionLineagePath(libraryRoot)
  try {
    if (!fs.existsSync(registryPath)) return null
    const parsed: unknown = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
    if (!isRecord(parsed) || !isRecord(parsed.aliases)) return null
    return parsed as unknown as SessionLineageRegistry
  } catch {
    return null
  }
}

function aliasEntries(registry: SessionLineageRegistry): Array<[string, string]> {
  return Object.entries(registry.aliases || {})
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
}

function finalAliasTarget(registry: SessionLineageRegistry, aliasId: string): string | null {
  const seen = new Set<string>()
  let current = aliasId
  while (typeof registry.aliases?.[current] === 'string') {
    if (seen.has(current)) return null
    seen.add(current)
    const next = registry.aliases[current]
    if (!next || next === current) return null
    current = next
  }
  return current === aliasId ? null : current
}

function findCandidates(
  input: string,
  registry: SessionLineageRegistry,
  manifestSessionIds: readonly string[],
  exact: boolean
): ResolveCandidate[] {
  const matches = (id: string): boolean => exact ? id === input : id.startsWith(input)
  const candidates: ResolveCandidate[] = []

  for (const sessionId of manifestSessionIds) {
    if (matches(sessionId)) {
      candidates.push({ matchedId: sessionId, resolved: sessionId, kind: 'manifest' })
    }
  }

  const manifestIds = new Set(manifestSessionIds)
  for (const [oldId] of aliasEntries(registry)) {
    // A physical package wins over an alias with the same ID for both exact
    // and prefix lookup; otherwise one manifest could manufacture ambiguity
    // with its own historical lineage edge.
    if (!matches(oldId) || manifestIds.has(oldId)) continue
    const target = finalAliasTarget(registry, oldId)
    if (target && manifestIds.has(target)) {
      candidates.push({ matchedId: oldId, resolved: target, kind: 'alias' })
    }
  }

  return candidates
}

function hasInvalidAliasMatch(
  input: string,
  registry: SessionLineageRegistry,
  manifestSessionIds: readonly string[],
  exact: boolean
): boolean {
  const manifests = new Set(manifestSessionIds)
  const matches = (id: string): boolean => exact ? id === input : id.startsWith(input)
  return aliasEntries(registry).some(([aliasId]) => {
    if (!matches(aliasId) || manifests.has(aliasId)) return false
    const target = finalAliasTarget(registry, aliasId)
    return !target || !manifests.has(target)
  })
}

export function resolveSessionIdFromRegistry(
  input: string,
  registry: SessionLineageRegistry,
  manifestSessionIds: readonly string[] = []
): ResolveSessionResult {
  if (!input) return fallback(input)

  // A complete physical manifest ID is authoritative by itself. Lineage is an
  // optional redirect surface and cannot veto or redirect this exact match.
  if (manifestSessionIds.includes(input)) {
    return { input, resolved: input, matched: true, exact: true }
  }

  const candidates = findCandidates(input, registry, manifestSessionIds, true)
  const exactInvalidAlias = hasInvalidAliasMatch(input, registry, manifestSessionIds, true)
  if (exactInvalidAlias) {
    return {
      ...fallback(input),
      exact: true,
      lineageInvalid: true,
      diagnostic: `swob resolve: lineage alias "${input}" 的最终目标不存在于 Library`
    }
  }
  const useExact = candidates.length > 0
  const prefixCandidates = useExact ? candidates : findCandidates(input, registry, manifestSessionIds, false)
  if (!useExact && hasInvalidAliasMatch(input, registry, manifestSessionIds, false)) {
    return {
      ...fallback(input),
      lineageInvalid: true,
      diagnostic: `swob resolve: 前缀 "${input}" 包含无法验证最终目标的 lineage alias`
    }
  }
  if (prefixCandidates.length === 0) return fallback(input)

  const resolvedIds = [...new Set(prefixCandidates.map((candidate) => candidate.resolved))]
  if (resolvedIds.length > 1) {
    const matchedIds = prefixCandidates
      .map((candidate) => candidate.matchedId)
      .sort()
      .join(', ')
    return {
      input,
      resolved: input,
      matched: false,
      ambiguous: true,
      exact: candidates.length > 0,
      candidates: [...new Set(prefixCandidates.map((candidate) => candidate.matchedId))].sort(),
      diagnostic: `swob resolve: 短 id 前缀 "${input}" 歧义，匹配到多个会话: ${matchedIds}`
    }
  }

  return { input, resolved: resolvedIds[0], matched: true, exact: useExact }
}

export function resolveSessionId(
  input: string,
  libraryRoot: string,
  manifestSessionIds: readonly string[] = []
): ResolveSessionResult {
  const registry = readSessionLineageRegistry(libraryRoot)
  if (!registry) {
    return resolveSessionIdFromRegistry(input, {
      version: 1,
      generatedAt: new Date(0).toISOString(),
      libraryRoot,
      aliases: {},
      latestByRoot: {},
      sessions: {},
      relations: [],
      ambiguous: []
    }, manifestSessionIds)
  }
  return resolveSessionIdFromRegistry(input, registry, manifestSessionIds)
}

export function formatResolveCliOutput(
  result: ResolveSessionResult,
  json = false
): { stdout: string; stderr: string } {
  const stdout = json
    ? JSON.stringify({ input: result.input, resolved: result.resolved, matched: result.matched }, null, 2) + '\n'
    : result.resolved + '\n'
  const stderr = result.diagnostic ? result.diagnostic + '\n' : ''
  return { stdout, stderr }
}
