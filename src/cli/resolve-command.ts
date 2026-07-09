import * as fs from 'fs'
import { getSessionLineagePath, type SessionLineageRegistry } from '../main/session-lineage'

export interface ResolveSessionResult {
  input: string
  resolved: string
  matched: boolean
  ambiguous?: boolean
  diagnostic?: string
}

interface ResolveCandidate {
  matchedId: string
  resolved: string
  kind: 'alias' | 'latest'
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

function uniqueLatestIds(registry: SessionLineageRegistry): string[] {
  return [...new Set(aliasEntries(registry).map(([, latestId]) => latestId))]
}

function findCandidates(input: string, registry: SessionLineageRegistry, exact: boolean): ResolveCandidate[] {
  const matches = (id: string): boolean => exact ? id === input : id.startsWith(input)
  const candidates: ResolveCandidate[] = []

  for (const [oldId, latestId] of aliasEntries(registry)) {
    if (matches(oldId)) candidates.push({ matchedId: oldId, resolved: latestId, kind: 'alias' })
  }

  for (const latestId of uniqueLatestIds(registry)) {
    if (matches(latestId)) candidates.push({ matchedId: latestId, resolved: latestId, kind: 'latest' })
  }

  return candidates
}

export function resolveSessionIdFromRegistry(input: string, registry: SessionLineageRegistry): ResolveSessionResult {
  if (!input) return fallback(input)

  const candidates = findCandidates(input, registry, true)
  const prefixCandidates = candidates.length > 0 ? candidates : findCandidates(input, registry, false)
  if (prefixCandidates.length === 0) return fallback(input)

  const resolvedIds = [...new Set(prefixCandidates.map((candidate) => candidate.resolved))]
  if (resolvedIds.length > 1) {
    const matchedIds = prefixCandidates
      .map((candidate) => `${candidate.matchedId}${candidate.kind === 'latest' ? ' (latest)' : ''}`)
      .sort()
      .join(', ')
    return {
      input,
      resolved: input,
      matched: false,
      ambiguous: true,
      diagnostic: `swob resolve: 短 id 前缀 "${input}" 歧义，匹配到多个会话: ${matchedIds}`
    }
  }

  return { input, resolved: resolvedIds[0], matched: true }
}

export function resolveSessionId(input: string, libraryRoot: string): ResolveSessionResult {
  const registry = readSessionLineageRegistry(libraryRoot)
  if (!registry) return fallback(input)
  return resolveSessionIdFromRegistry(input, registry)
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
