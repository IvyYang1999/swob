import {
  buildLogicalSessionIdentityFromMeta,
  logicalSessionKey,
  type LogicalSessionIdentity,
  type LogicalSessionKey
} from './library-session-identity'

export interface LibrarySessionCandidate {
  logicalKey: LogicalSessionKey
  identity: LogicalSessionIdentity
  sessionId: string
  dirPath: string
  packageId?: string
  schemaVersion?: number
  updatedAt: string
  isSymlink: boolean
}

export type LibrarySessionBinding =
  | {
      state: 'missing'
      logicalKey: LogicalSessionKey
      candidates: []
      lastKnownCandidates: LibrarySessionCandidate[]
      reason: 'never-seen' | 'previously-seen' | 'scan-incomplete'
      creationAllowed: boolean
    }
  | { state: 'bound'; logicalKey: LogicalSessionKey; candidate: LibrarySessionCandidate; candidates: [LibrarySessionCandidate] }
  | {
      state: 'conflict'
      logicalKey: LogicalSessionKey
      reason: 'duplicate-packages' | 'package-id-collision' | 'symlink-only'
      candidates: LibrarySessionCandidate[]
    }

export type SessionIdResolution =
  | {
      state: 'missing'
      sessionId: string
      logicalKey?: LogicalSessionKey
      lastKnownCandidates?: LibrarySessionCandidate[]
      reason?: 'never-seen' | 'previously-seen' | 'scan-incomplete'
    }
  | { state: 'bound'; sessionId: string; logicalKey: LogicalSessionKey; candidate: LibrarySessionCandidate }
  | { state: 'ambiguous'; sessionId: string; logicalKeys: LogicalSessionKey[]; candidates: LibrarySessionCandidate[] }
  | { state: 'conflict'; sessionId: string; logicalKey: LogicalSessionKey; candidates: LibrarySessionCandidate[] }

function candidateSort(a: LibrarySessionCandidate, b: LibrarySessionCandidate): number {
  return a.dirPath.localeCompare(b.dirPath)
}

export function candidateFromManifest(
  dirPath: string,
  meta: {
    sessionId: string
    sourceFilePaths?: string[]
    logicalIdentity?: LogicalSessionIdentity
    sourceInstance?: {
      kind: 'claude-default' | 'claude-window' | 'other'
      configDir?: string
    }
    packageId?: string
    schemaVersion?: number
    updatedAt: string
  },
  isSymlink = false
): LibrarySessionCandidate {
  const identity = buildLogicalSessionIdentityFromMeta(meta)
  return {
    logicalKey: logicalSessionKey(identity),
    identity,
    sessionId: meta.sessionId,
    dirPath,
    packageId: meta.packageId,
    schemaVersion: meta.schemaVersion,
    updatedAt: meta.updatedAt,
    isSymlink
  }
}

export class LibrarySessionRegistry {
  private readonly bindings = new Map<LogicalSessionKey, LibrarySessionBinding>()
  private readonly logicalKeysBySessionId = new Map<string, Set<LogicalSessionKey>>()
  private lastScanAuthoritative = false

  clear(): void {
    this.bindings.clear()
    this.logicalKeysBySessionId.clear()
    this.lastScanAuthoritative = false
  }

  replace(
    candidates: LibrarySessionCandidate[],
    evidence: { authoritative: boolean } = { authoritative: true }
  ): void {
    const previousBindings = new Map(this.bindings)
    const nextBindings = new Map<LogicalSessionKey, LibrarySessionBinding>()

    const grouped = new Map<LogicalSessionKey, LibrarySessionCandidate[]>()
    for (const candidate of candidates) {
      const list = grouped.get(candidate.logicalKey) || []
      list.push(candidate)
      grouped.set(candidate.logicalKey, list)
    }

    const packageOwners = new Map<string, LibrarySessionCandidate[]>()
    for (const candidate of candidates) {
      if (!candidate.packageId || candidate.isSymlink) continue
      const owners = packageOwners.get(candidate.packageId) || []
      if (!owners.some((owner) => owner.dirPath === candidate.dirPath)) owners.push(candidate)
      packageOwners.set(candidate.packageId, owners)
    }
    const packageCollisions = new Map<LogicalSessionKey, LibrarySessionCandidate[]>()
    for (const owners of packageOwners.values()) {
      if (owners.length < 2) continue
      for (const owner of owners) packageCollisions.set(owner.logicalKey, owners.slice().sort(candidateSort))
    }

    for (const [key, rawCandidates] of grouped) {
      const byPhysicalPath = new Map<string, LibrarySessionCandidate>()
      for (const candidate of rawCandidates.sort(candidateSort)) {
        const previous = byPhysicalPath.get(candidate.dirPath)
        if (!previous || (previous.isSymlink && !candidate.isSymlink)) {
          byPhysicalPath.set(candidate.dirPath, candidate)
        }
      }
      const deduplicated = [...byPhysicalPath.values()].sort(candidateSort)
      const physical = deduplicated.filter((candidate) => !candidate.isSymlink)
      let binding: LibrarySessionBinding
      const packageCollision = packageCollisions.get(key)
      if (packageCollision) {
        binding = {
          state: 'conflict',
          logicalKey: key,
          reason: 'package-id-collision',
          candidates: packageCollision
        }
      } else if (physical.length === 1) {
        binding = { state: 'bound', logicalKey: key, candidate: physical[0], candidates: [physical[0]] }
      } else if (physical.length > 1) {
        binding = { state: 'conflict', logicalKey: key, reason: 'duplicate-packages', candidates: physical }
      } else {
        binding = { state: 'conflict', logicalKey: key, reason: 'symlink-only', candidates: deduplicated }
      }
      nextBindings.set(key, binding)
    }

    // A scan may prove that a path is temporarily absent, but it can never
    // prove that a previously observed logical package is safe to recreate.
    // Keep that historical evidence as a real read-only registry state.
    for (const [key, previous] of previousBindings) {
      if (nextBindings.has(key)) continue
      const lastKnownCandidates = previous.state === 'missing'
        ? previous.lastKnownCandidates
        : previous.candidates
      nextBindings.set(key, {
        state: 'missing',
        logicalKey: key,
        candidates: [],
        lastKnownCandidates: structuredClone(lastKnownCandidates),
        reason: lastKnownCandidates.length > 0 ? 'previously-seen' : 'scan-incomplete',
        creationAllowed: false
      })
    }

    this.bindings.clear()
    this.logicalKeysBySessionId.clear()
    this.lastScanAuthoritative = evidence.authoritative
    for (const [key, binding] of nextBindings) {
      this.bindings.set(key, binding)
      const indexedCandidates = binding.state === 'missing' ? binding.lastKnownCandidates : binding.candidates
      for (const candidate of indexedCandidates) {
        const keys = this.logicalKeysBySessionId.get(candidate.sessionId) || new Set<LogicalSessionKey>()
        keys.add(key)
        this.logicalKeysBySessionId.set(candidate.sessionId, keys)
      }
    }
  }

  get(logicalKey: LogicalSessionKey): LibrarySessionBinding {
    return this.bindings.get(logicalKey) || {
      state: 'missing',
      logicalKey,
      candidates: [],
      lastKnownCandidates: [],
      reason: this.lastScanAuthoritative ? 'never-seen' : 'scan-incomplete',
      creationAllowed: this.lastScanAuthoritative
    }
  }

  resolveSessionId(sessionId: string): SessionIdResolution {
    const keys = [...(this.logicalKeysBySessionId.get(sessionId) || [])].sort()
    if (keys.length === 0) return { state: 'missing', sessionId }
    const candidates = keys.flatMap((key) => this.bindings.get(key)?.candidates || []).sort(candidateSort)
    if (keys.length > 1) return { state: 'ambiguous', sessionId, logicalKeys: keys, candidates }
    const binding = this.bindings.get(keys[0])!
    if (binding.state === 'bound') {
      return { state: 'bound', sessionId, logicalKey: keys[0], candidate: binding.candidate }
    }
    if (binding.state === 'missing') return {
      state: 'missing',
      sessionId,
      logicalKey: keys[0],
      lastKnownCandidates: binding.lastKnownCandidates,
      reason: binding.reason
    }
    return { state: 'conflict', sessionId, logicalKey: keys[0], candidates: binding.candidates }
  }

  hasPackageId(packageId: string): boolean {
    for (const binding of this.bindings.values()) {
      const candidates = binding.state === 'missing' ? binding.lastKnownCandidates : binding.candidates
      if (candidates.some((candidate) => candidate.packageId === packageId)) return true
    }
    return false
  }

  diagnostics(): LibrarySessionBinding[] {
    return [...this.bindings.values()]
      .filter((binding) => binding.state !== 'bound')
      .map((binding) => structuredClone(binding))
  }
}
