import type { JsonValue } from '../../../shared/provider-schema-v2.generated'
import type {
  Availability,
  CoverageState,
  ObservedUsageAggregate,
  OrchestrationEntity,
  OrchestrationEntityLink,
  OrchestrationRegistrationDescriptor,
  OrchestrationRun,
  SessionOrchestrationLink
} from '../../../shared/contracts/truth-kernel'

/** Read-only surface exposed by the Multica overlay. It is deliberately not a Provider. */
export const MULTICA_ORCHESTRATION_DESCRIPTOR: OrchestrationRegistrationDescriptor = {
  schemaVersion: 1,
  featureId: 'multica-orchestration-overlay',
  orchestratorId: 'multica',
  descriptorVersion: '1.1.0',
  registrationExport: 'MULTICA_ORCHESTRATION_DESCRIPTOR'
}

export type MulticaPlatform = 'darwin' | 'linux' | 'win32'
export type MulticaRootKind = 'workspace' | 'task-codex-home' | 'session-container' | 'custom'

export interface MulticaRootCandidate {
  kind: MulticaRootKind
  path: string
  exists: boolean
  readable: boolean
  source: 'default' | 'environment' | 'profile' | 'desktop-profile' | 'custom'
  profile?: string
  physicalIdentity?: string
}

export interface MulticaDoctorReport {
  adapterId: 'multica-readonly-overlay'
  mode: 'read-only'
  schemaVersion: Availability<string>
  roots: MulticaRootCandidate[]
  capabilities: {
    discovery: 'available' | 'partial' | 'unavailable'
    entities: 'available' | 'partial' | 'unavailable'
    usage: 'available' | 'partial' | 'unavailable'
    nativeResume: 'unavailable'
  }
  failures: string[]
}

/** Native JSON response/export or privacy-safe fixture. It is never a transcript Provider. */
export interface MulticaWorkspaceSnapshot {
  schemaVersion?: unknown
  workspaces?: unknown
  projects?: unknown
  issues?: unknown
  tasks?: unknown
  attempts?: unknown
  stages?: unknown
  agents?: unknown
  verifiers?: unknown
  evidences?: unknown
  artifacts?: unknown
  comments?: unknown
  usages?: unknown
}

export interface MulticaSourceEvidence {
  locator: string
  sha256: string
  capturedAt: string
  byteLength: number
}

export interface MulticaNativeUsageFact {
  factId: string
  metric: ObservedUsageAggregate['metric']
  unit: string
  total: number
  providerId?: string
  modelId?: string
  authoritative: boolean
}

export interface MulticaUsageInput {
  id: string
  scopeKind: 'task' | 'issue' | 'attempt'
  scopeId: string
  metric: ObservedUsageAggregate['metric']
  unit: string
  total?: number
  providerId?: string
  modelId?: string
  nativeCoverage?: 'complete' | 'partial' | 'unknown'
  nativeUsageFacts?: MulticaNativeUsageFact[]
  source?: MulticaSourceEvidence
}

export interface MulticaEntityInput {
  id: string
  kind: string
  status?: string
  outcome?: string
  sessionIds?: string[]
  parentId?: string
  parentKind?: 'workspace' | 'project' | 'issue' | 'task' | 'attempt'
  dependencyIds?: string[]
  taskId?: string
  taskIds?: string[]
  attemptId?: string
  attemptIds?: string[]
  subjectId?: string
  evidenceIds?: string[]
  verifierIds?: string[]
  producerAttemptId?: string
  duplicateOf?: string
  agentId?: string
  nativeRoute?: string
  raw: JsonValue
  source?: MulticaSourceEvidence
}

export interface MulticaAttemptAssessment {
  attemptId: string
  taskId?: string
  status: OrchestrationRun['status']
  duplicateOf?: string
  isDuplicate: boolean
  successful: boolean
}

export interface MulticaVerifierAssessment {
  verifierId: string
  outcome: 'accepted' | 'rejected' | 'cancelled' | 'unknown'
  successful: boolean
}

export interface MulticaStageBarrierAssessment {
  stageId: string
  taskIds: string[]
  verifierIds: string[]
  satisfied: boolean
  reason: string
}

export interface MulticaReconciledUsage extends ObservedUsageAggregate {
  reconciliation: {
    authority: 'native' | 'multica-task-fallback' | 'issue-observation' | 'unknown'
    allocation: 'fully-covered' | 'residual-unallocated' | 'overcoverage-anomaly' | 'not-allocatable' | 'unknown'
    doubleCountPrevented: true
    anomaly?: {
      code: 'native-covered-total-exceeds-multica-reported-total'
      nativeObservedTotal: number
      multicaReportedTotal: number
      overcoverage: number
    }
  }
}

export interface MulticaOverlayProjection {
  descriptor: OrchestrationRegistrationDescriptor
  entities: OrchestrationEntity[]
  entityLinks: OrchestrationEntityLink[]
  runs: OrchestrationRun[]
  sessionLinks: SessionOrchestrationLink[]
  usageAggregates: MulticaReconciledUsage[]
  coverage: CoverageState
  doctor: MulticaDoctorReport
  semantics: {
    attempts: MulticaAttemptAssessment[]
    verifiers: MulticaVerifierAssessment[]
    stageBarriers: MulticaStageBarrierAssessment[]
  }
}

export interface MulticaTranscriptSource {
  locator: string
  realPath: string
  physicalIdentity: string
  logicalSessionId?: string
  sha256: string
  byteLength: number
  aliases: string[]
}

export interface MulticaMetadataSnapshot {
  sourcePath: string
  kind: 'daemon-task-context' | 'managed-env' | 'gc-meta' | 'orchestration-export'
  sha256: string
  capturedAt: string
  byteLength: number
  value: JsonValue
}

/** Persistable feature-local handoff. Missing current files do not erase last-known GC metadata. */
export interface MulticaMetadataCheckpoint {
  schemaVersion: 1
  capturedAt: string
  snapshots: MulticaMetadataSnapshot[]
}

export interface MulticaReadResult {
  roots: MulticaRootCandidate[]
  taskRoots: string[]
  transcriptSources: MulticaTranscriptSource[]
  metadataSnapshots: MulticaMetadataSnapshot[]
  parsed: {
    schemaVersion?: string
    entities: MulticaEntityInput[]
    usages: MulticaUsageInput[]
    diagnostics: string[]
  }
  diagnostics: string[]
}
