import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  buildLogicalSessionIdentityFromMeta,
  logicalSessionKey,
  type LogicalSessionIdentity,
  type LogicalSessionKey
} from './library-session-identity'
import type { IdentityExceptionEvidence, IdentityExceptionsState } from '../shared/library-health-contract'

type AuthorizedIdentityException = IdentityExceptionEvidence & {
  /** v2 excludes mutable timestamps; the original evidenceHash remains the signed audit artifact. */
  matchingEvidenceHashV2?: string
}

export interface LibraryIdentityHealthSummary {
  state: IdentityExceptionsState
  authorizedGroupCount: number
  authorizedPackageCount: number
  unknownGroupCount: number
  unknownPackageCount: number
  evidenceMismatchGroupCount: number
  records: IdentityExceptionEvidence[]
}

/**
 * Immutable, privacy-preserving evidence for the three t189 recovery groups.
 * Neither logical session IDs nor paths are stored. Matching requires the
 * logical key, the exact physical package count, and a fingerprint of every
 * read-only package observed in the authorized recovery state.
 */
const AUTHORIZED_IDENTITY_EXCEPTIONS: readonly AuthorizedIdentityException[] = [
  {
    schemaVersion: 1,
    exceptionId: 't189-89fdb99eb0159be7',
    logicalKeyHash: '89fdb99eb0159be7f1465e63f83e79f76101241f53757cbe256a72e72ba466de',
    evidenceHash: '0ba576e611c2c4288aa77087a49f0323a32a71cbcda637cb4a6de658360f6773',
    matchingEvidenceHashV2: 'f5a839c50546527d34759883ee8e06a903759d4f53a03c9a5db258e05aff8f56',
    physicalPackageCount: 11,
    access: 'read-only',
    authorizationSource: 'docs/reports/t189-recovery/README.md',
    authorizationDecision: 't189-user-authorized-historical-identity-preservation',
    authorizedAt: '2026-08-02T00:00:00.000+08:00'
  },
  {
    schemaVersion: 1,
    exceptionId: 't189-1f227fe559cb3369',
    logicalKeyHash: '1f227fe559cb3369e65590eebb1a946b600dc32a0085614bbbcd7a8c18928579',
    evidenceHash: '801a705d6b224325095cd3953cb29e7c041e26a058839ab5bf67000ce0dd8add',
    matchingEvidenceHashV2: '21b0ff0c9231cf2bcb0815b6e85ff4ea7882a854e6fec2b3a80aefe02ae2715b',
    physicalPackageCount: 11,
    access: 'read-only',
    authorizationSource: 'docs/reports/t189-recovery/README.md',
    authorizationDecision: 't189-user-authorized-historical-identity-preservation',
    authorizedAt: '2026-08-02T00:00:00.000+08:00'
  },
  {
    schemaVersion: 1,
    exceptionId: 't189-df6e4ff3586fd5c7',
    logicalKeyHash: 'df6e4ff3586fd5c72a8f7713cd7397ed61d143fe1b5c8118e7d60a4b9615613f',
    evidenceHash: 'f71feff79e7df027eb163abbfdfd27063216bbd014147e80be5508a72c195247',
    physicalPackageCount: 12,
    access: 'read-only',
    authorizationSource: 'docs/reports/t189-recovery/README.md',
    authorizationDecision: 't189-user-authorized-historical-identity-preservation',
    authorizedAt: '2026-08-02T00:00:00.000+08:00'
  }
] as const

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function legacyPhysicalEvidenceHash(candidates: readonly LibrarySessionCandidate[]): string {
  const tokens = candidates.map((candidate) => sha256(JSON.stringify({
    directoryName: path.basename(candidate.dirPath).normalize('NFC'),
    packageId: candidate.packageId ?? null,
    schemaVersion: candidate.schemaVersion ?? null,
    updatedAt: candidate.updatedAt
  }))).sort()
  return sha256(tokens.join('\0'))
}

/** Fingerprint immutable package identity, not mutable synchronization metadata. */
export function physicalIdentityEvidenceHash(candidates: readonly LibrarySessionCandidate[]): string {
  const tokens = candidates.map((candidate) => sha256(JSON.stringify({
    directoryName: path.basename(candidate.dirPath).normalize('NFC'),
    packageId: candidate.packageId ?? null,
    schemaVersion: candidate.schemaVersion ?? null
  }))).sort()
  return sha256(tokens.join('\0'))
}

function exceptionForConflict(
  logicalKey: LogicalSessionKey,
  candidates: readonly LibrarySessionCandidate[]
): { status: 'authorized' | 'unknown' | 'evidence-mismatch'; record: IdentityExceptionEvidence | null } {
  const logicalKeyHash = sha256(logicalKey)
  const expected = AUTHORIZED_IDENTITY_EXCEPTIONS.find((record) => record.logicalKeyHash === logicalKeyHash)
  if (!expected) return { status: 'unknown', record: null }
  const evidenceMatches = candidates.length === expected.physicalPackageCount && (
    expected.matchingEvidenceHashV2
      ? physicalIdentityEvidenceHash(candidates) === expected.matchingEvidenceHashV2
      : legacyPhysicalEvidenceHash(candidates) === expected.evidenceHash
  )
  if (!evidenceMatches) return { status: 'evidence-mismatch', record: null }
  const { matchingEvidenceHashV2: _matchingEvidenceHashV2, ...publicRecord } = expected
  return { status: 'authorized', record: structuredClone(publicRecord) }
}

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
      exceptionStatus: 'authorized' | 'unknown' | 'evidence-mismatch'
      exception: IdentityExceptionEvidence | null
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
  | {
      state: 'conflict'
      sessionId: string
      logicalKey: LogicalSessionKey
      candidates: LibrarySessionCandidate[]
      exceptionStatus: 'authorized' | 'unknown' | 'evidence-mismatch'
      exception: IdentityExceptionEvidence | null
    }

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
        const exception = exceptionForConflict(key, packageCollision)
        binding = {
          state: 'conflict',
          logicalKey: key,
          reason: 'package-id-collision',
          candidates: packageCollision,
          exceptionStatus: exception.status,
          exception: exception.record
        }
      } else if (physical.length === 1) {
        binding = { state: 'bound', logicalKey: key, candidate: physical[0], candidates: [physical[0]] }
      } else if (physical.length > 1) {
        const exception = exceptionForConflict(key, physical)
        binding = {
          state: 'conflict',
          logicalKey: key,
          reason: 'duplicate-packages',
          candidates: physical,
          exceptionStatus: exception.status,
          exception: exception.record
        }
      } else {
        const exception = exceptionForConflict(key, deduplicated)
        binding = {
          state: 'conflict',
          logicalKey: key,
          reason: 'symlink-only',
          candidates: deduplicated,
          exceptionStatus: exception.status,
          exception: exception.record
        }
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
    return {
      state: 'conflict',
      sessionId,
      logicalKey: keys[0],
      candidates: binding.candidates,
      exceptionStatus: binding.exceptionStatus,
      exception: binding.exception
    }
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

export function summarizeLibraryIdentityHealth(
  bindings: readonly LibrarySessionBinding[]
): LibraryIdentityHealthSummary {
  const conflicts = bindings.filter(
    (binding): binding is Extract<LibrarySessionBinding, { state: 'conflict' }> => binding.state === 'conflict'
  )
  const authorized = conflicts.filter((binding) => binding.exceptionStatus === 'authorized')
  const mismatches = conflicts.filter((binding) => binding.exceptionStatus === 'evidence-mismatch')
  const unknown = conflicts.filter((binding) => binding.exceptionStatus === 'unknown')
  return {
    state: mismatches.length > 0
      ? 'evidence-mismatch'
      : unknown.length > 0
        ? 'unknown-conflicts'
        : authorized.length > 0
          ? 'authorized-read-only'
          : 'none',
    authorizedGroupCount: authorized.length,
    authorizedPackageCount: authorized.reduce((total, binding) => total + binding.candidates.length, 0),
    unknownGroupCount: unknown.length,
    unknownPackageCount: unknown.reduce((total, binding) => total + binding.candidates.length, 0),
    evidenceMismatchGroupCount: mismatches.length,
    records: authorized.flatMap((binding) => binding.exception ? [structuredClone(binding.exception)] : [])
  }
}
