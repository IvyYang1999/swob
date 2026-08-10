import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { MulticaDoctorReport, MulticaPlatform, MulticaRootCandidate, MulticaTranscriptSource } from './types'

export interface MulticaDiscoveryOptions {
  platform: MulticaPlatform
  homeDir: string
  env?: Record<string, string | undefined>
  customRoots?: string[]
  profileRoots?: Array<{ profile: string; path: string; desktop?: boolean }>
  exists?: (candidate: string) => boolean
  readable?: (candidate: string) => boolean
  physicalIdentity?: (candidate: string) => string | undefined
  schemaVersion?: string
}

const pathApi = (platform: MulticaPlatform): typeof path.posix => platform === 'win32' ? path.win32 : path.posix

function userHome(options: MulticaDiscoveryOptions): string {
  if (options.platform === 'win32') return options.env?.USERPROFILE || options.homeDir
  return options.homeDir
}

/** Windows keys are case-insensitive; POSIX keys intentionally are not. */
export function multicaPathKey(value: string, platform: MulticaPlatform): string {
  const api = pathApi(platform)
  const normalized = api.normalize(value).replace(/[\\/]+$/, '')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function uniqueCandidates(candidates: MulticaRootCandidate[], platform: MulticaPlatform): MulticaRootCandidate[] {
  const seenPhysical = new Set<string>()
  const seenPaths = new Set<string>()
  return candidates.filter((candidate) => {
    const physical = candidate.physicalIdentity
    const key = multicaPathKey(candidate.path, platform)
    if ((physical && seenPhysical.has(physical)) || seenPaths.has(key)) return false
    if (physical) seenPhysical.add(physical)
    seenPaths.add(key)
    return true
  })
}

/** Computes safe candidates without reading ~/.multica/config.json (which may contain a PAT). */
export function discoverMulticaRoots(options: MulticaDiscoveryOptions): MulticaRootCandidate[] {
  const api = pathApi(options.platform)
  const exists = options.exists || fs.existsSync
  const readable = options.readable || ((candidate: string) => {
    try { fs.accessSync(candidate, fs.constants.R_OK); return true } catch { return false }
  })
  const identity = options.physicalIdentity || ((candidate: string) => {
    try {
      const stat = fs.statSync(candidate)
      return `${stat.dev}:${stat.ino}:${fs.realpathSync.native(candidate)}`
    } catch { return undefined }
  })
  const home = userHome(options)
  const defaultWorkspace = api.join(home, 'multica_workspaces')
  const environmentWorkspace = options.env?.MULTICA_WORKSPACES_ROOT
  const legacy = api.join(home, '.codex', 'multica-sessions')
  const candidates: Array<Omit<MulticaRootCandidate, 'exists' | 'readable' | 'physicalIdentity'>> = [
    { kind: 'workspace', path: environmentWorkspace || defaultWorkspace, source: environmentWorkspace ? 'environment' : 'default' },
    ...(options.profileRoots || []).map((entry) => ({ kind: 'workspace' as const, path: entry.path, source: entry.desktop ? 'desktop-profile' as const : 'profile' as const, profile: entry.profile })),
    { kind: 'session-container', path: legacy, source: 'default' },
    ...(options.customRoots || []).map((candidate) => ({ kind: 'custom' as const, path: candidate, source: 'custom' as const }))
  ]
  return uniqueCandidates(candidates.map((candidate) => {
    const present = exists(candidate.path)
    return { ...candidate, exists: present, readable: present && readable(candidate.path), physicalIdentity: present ? identity(candidate.path) : undefined }
  }), options.platform)
}

export interface TranscriptIdentityInput {
  locator: string
  realPath?: string
  device?: string | number
  fileId?: string | number
  logicalSessionId?: string
  bytes: Uint8Array
}

/** Session UUID + bytes distinguish divergent copies; physical id catches hard links; digest catches cross-volume copies. */
export function identifyTranscriptSource(input: TranscriptIdentityInput): MulticaTranscriptSource {
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const physicalIdentity = input.device !== undefined && input.fileId !== undefined
    ? `file:${input.device}:${input.fileId}`
    : `content:${sha256}`
  return {
    locator: input.locator,
    realPath: input.realPath || input.locator,
    physicalIdentity,
    logicalSessionId: input.logicalSessionId,
    sha256,
    byteLength: input.bytes.byteLength,
    aliases: [input.locator]
  }
}

export function deduplicateTranscriptSources(inputs: MulticaTranscriptSource[]): MulticaTranscriptSource[] {
  const canonical = new Map<string, MulticaTranscriptSource>()
  const physical = new Map<string, string>()
  for (const source of inputs) {
    const logicalKey = source.logicalSessionId ? `session:${source.logicalSessionId}:${source.sha256}` : undefined
    const key = logicalKey || physical.get(source.physicalIdentity) || `content:${source.sha256}`
    const existing = canonical.get(key)
    if (existing) {
      existing.aliases = [...new Set([...existing.aliases, source.locator])]
      physical.set(source.physicalIdentity, key)
      continue
    }
    canonical.set(key, { ...source, aliases: [...source.aliases] })
    physical.set(source.physicalIdentity, key)
  }
  return [...canonical.values()]
}

export function multicaDoctor(options: MulticaDiscoveryOptions): MulticaDoctorReport {
  const roots = discoverMulticaRoots(options)
  const available = roots.filter((root) => root.exists && root.readable)
  const failures = roots.filter((root) => root.exists && !root.readable).map((root) => `Multica root is not readable: ${root.path}`)
  if (available.length === 0) failures.push('No readable Multica workspace or session root was found; no data was imported.')
  return {
    adapterId: 'multica-readonly-overlay',
    mode: 'read-only',
    schemaVersion: options.schemaVersion
      ? { status: 'available', value: options.schemaVersion }
      : { status: 'unknown', reason: 'No supported workspace schema marker was observed.' },
    roots,
    capabilities: {
      discovery: available.length === 0 ? 'unavailable' : failures.length === 0 ? 'available' : 'partial',
      entities: options.schemaVersion ? 'available' : available.length ? 'partial' : 'unavailable',
      usage: options.schemaVersion ? 'partial' : 'unavailable',
      nativeResume: 'unavailable'
    },
    failures
  }
}
