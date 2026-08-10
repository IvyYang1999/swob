import type { CanonicalEvent, JsonValue } from '../../provider-schema-v2.generated'

export const TRUTH_KERNEL_SCHEMA_VERSION = 1 as const
export const TRUTH_KERNEL_SERIALIZATION_VERSION = 'truth-kernel-canonical-json/1' as const

export type TruthKernelSchemaVersion = typeof TRUTH_KERNEL_SCHEMA_VERSION
export type IsoTimestamp = string
export type Sha256 = string
export type EvidenceGrade = 'A' | 'B' | 'C' | 'D' | 'E'
export type DerivationKind =
  | 'observed'
  | 'reported'
  | 'derived'
  | 'estimated'
  | 'inferred'
  | 'user-corrected'

export type Availability<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable' | 'unknown'; reason: string }

export interface SourceLocator {
  kind: 'provider-raw-ref' | 'source-record' | 'artifact' | 'external-attachment' | 'user-assertion'
  locatorHash: string
  offset?: number
  length?: number
}

export interface EvidenceRef {
  evidenceId: string
  sourceId: string
  sourceKind: 'provider' | 'transcript' | 'runtime-capture' | 'artifact' | 'catalog' | 'user'
  providerId?: string
  logicalSessionId?: string
  sourceEventId?: string
  sourceRecordId?: string
  interactionId?: string
  eventTime?: IsoTimestamp
  capturedAt: IsoTimestamp
  effectiveAt?: IsoTimestamp
  grade: EvidenceGrade
  claim:
    | 'wire-exact'
    | 'provider-confirmed'
    | 'deterministically-reconstructed'
    | 'heuristically-inferred'
    | 'current-snapshot'
    | 'user-asserted'
  locator?: SourceLocator
  digest?: Sha256
}

export interface DerivedRecord<T> {
  id: string
  schemaVersion: TruthKernelSchemaVersion
  value: T
  derivation: DerivationKind
  evidence: EvidenceRef[]
  algorithmId?: string
  algorithmVersion?: string
  createdAt: IsoTimestamp
  supersedes?: string
}

export interface AllowedRootCapability {
  rootId: string
  access: 'read' | 'export'
  granted: boolean
}

export interface ArtifactRef {
  artifactId: string
  sourceLocator: SourceLocator
  digest: Availability<Sha256>
  sizeBytes: Availability<number>
  mimeType: Availability<string>
  provenance: EvidenceRef[]
  allowedRoots: AllowedRootCapability[]
  contentState: 'available' | 'missing' | 'outside-allowed-root' | 'hash-mismatch' | 'unavailable'
}

export interface PersistedOutputRef extends ArtifactRef {
  outputKind: 'image' | 'pdf' | 'document' | 'structured-media' | 'tool-output' | 'unknown'
  activeContentAllowed: false
}

export interface ContextAttachmentRef extends ArtifactRef {
  attachmentKind: 'file' | 'image'
  activeContentAllowed: false
}

/** Lossless read contract. Consumers render providerEvent directly and must preserve unknown payloads. */
export interface AgentTimelineEvent {
  schemaVersion: TruthKernelSchemaVersion
  timelineEventId: string
  sourceEventId: string
  sequence: number
  parentTimelineEventIds: string[]
  providerEvent: CanonicalEvent
  evidence: EvidenceRef[]
  persistedOutputs: PersistedOutputRef[]
}

export type ContextArtifactKind =
  | 'system-prompt'
  | 'instruction-file'
  | 'rule'
  | 'memory-index'
  | 'memory-topic'
  | 'skill-description'
  | 'skill-body'
  | 'skill-reference'
  | 'mcp-server-instructions'
  | 'mcp-tool-name'
  | 'mcp-tool-schema'
  | 'mcp-prompt'
  | 'mcp-resource'
  | 'hook-context'
  | 'file-read'
  | 'tool-output'
  | 'compact-summary'
  | 'output-style'
  | 'environment'
  | 'subagent-result'
  | 'conversation-history'
  | 'attached-file'
  | 'attached-image'
  | 'unknown'

export interface ContextArtifact {
  schemaVersion: TruthKernelSchemaVersion
  contextArtifactId: string
  kind: ContextArtifactKind
  providerId: string
  sourceUri: Availability<string>
  scope: 'managed' | 'user' | 'project' | 'local' | 'nested' | 'runtime' | 'unknown'
  capturedAt: IsoTimestamp
  effectiveAt: Availability<IsoTimestamp>
  contentDigest: Availability<Sha256>
  content: Availability<string>
  attachmentRef: Availability<ContextAttachmentRef>
  redaction: 'none' | 'automatic' | 'manual' | 'content-withheld'
  tokenCount: Availability<number>
  tokenMeasurement: 'reported' | 'derived' | 'estimated' | 'unavailable'
  evidence: EvidenceRef[]
}

export type ContextInjectionOperation = 'add' | 'replace' | 'remove' | 'reinject' | 'truncate'
export type ContextInjectionTrigger =
  | 'session-start'
  | 'user-prompt'
  | 'file-read'
  | 'nested-traversal'
  | 'path-glob-match'
  | 'include'
  | 'skill-invocation'
  | 'tool-search'
  | 'hook'
  | 'compact'
  | 'resume'
  | 'fork'
  | 'unknown'

export interface ContextInjection {
  schemaVersion: TruthKernelSchemaVersion
  contextInjectionId: string
  logicalSessionId: string
  requestId: Availability<string>
  interactionId: Availability<string>
  contextRevision: number
  contextArtifactId: string
  operation: ContextInjectionOperation
  trigger: ContextInjectionTrigger
  visibleToModel: true | false | 'unknown'
  effectiveAt: Availability<IsoTimestamp>
  evidence: EvidenceRef[]
}

export interface ContextSnapshot {
  schemaVersion: TruthKernelSchemaVersion
  contextSnapshotId: string
  logicalSessionId: string
  requestId: Availability<string>
  interactionId: Availability<string>
  modelId: Availability<string>
  contextLimit: Availability<number>
  contextRevision: number
  activeInjectionIds: string[]
  reportedInputTokens: Availability<number>
  accountedInputTokens: Availability<number>
  unknownInputTokens: Availability<number>
  coveragePercent: Availability<number>
  evidence: EvidenceRef[]
}

export type ContextDeltaDisposition = 'introduced' | 'preserved' | 'summarized' | 'dropped' | 'unknown'

export interface ContextDelta {
  contextArtifactId: string
  disposition: ContextDeltaDisposition
  fromInjectionIds: string[]
  toInjectionIds: string[]
  evidence: EvidenceRef[]
}

export interface ContextTransition {
  schemaVersion: TruthKernelSchemaVersion
  contextTransitionId: string
  kind: 'compact' | 'fork' | 'resume' | 'request' | 'unknown'
  fromSnapshotId: Availability<string>
  toSnapshotId: string
  interactionId: Availability<string>
  effectiveAt: Availability<IsoTimestamp>
  deltas: ContextDelta[]
  derivation: DerivationKind
  algorithmId: string
  algorithmVersion: string
  evidence: EvidenceRef[]
}

export interface EpistemicBoolean {
  state: 'observed-true' | 'observed-false' | 'unknown'
  observedAt: Availability<IsoTimestamp>
  evidence: EvidenceRef[]
}

export interface McpContextExposure {
  schemaVersion: TruthKernelSchemaVersion
  exposureId: string
  logicalSessionId: string
  interactionId: Availability<string>
  serverId: string
  toolId: Availability<string>
  configured: EpistemicBoolean
  serverInstructionsVisible: EpistemicBoolean
  toolNameVisible: EpistemicBoolean
  schemaState: 'deferred' | 'loaded' | 'unavailable' | 'unknown'
  schemaEvidence: EvidenceRef[]
  called: EpistemicBoolean
  resultVisible: EpistemicBoolean
}

export interface DeferredToolsDelta {
  schemaVersion: TruthKernelSchemaVersion
  deltaId: string
  contextRevision: number
  addedToolNames: string[]
  removedToolNames: string[]
  deferredSchemaToolNames: string[]
  evidence: EvidenceRef[]
}

export interface ToolSearchReceipt {
  schemaVersion: TruthKernelSchemaVersion
  receiptId: string
  interactionId: string
  query: string
  visibleToolNames: string[]
  loadedSchemaToolNames: string[]
  effectiveAt: IsoTimestamp
  evidence: EvidenceRef[]
}

export interface MeasuredDuration {
  milliseconds: Availability<number>
  measurement: 'exact' | 'derived' | 'estimated' | 'unavailable'
  evidence: EvidenceRef[]
}

export interface TimingFacts {
  wall: MeasuredDuration
  agentActive: MeasuredDuration
  wait: MeasuredDuration
}

export interface InteractionModelCallFact {
  providerId: string
  observedModelId: string
  canonicalModelId: Availability<string>
  mode: Availability<string>
  evidence: EvidenceRef[]
}

export interface FileScope {
  rootId: Availability<string>
  repositoryId: Availability<string>
  worktreeId: Availability<string>
  logicalPath: string
  originalPath: Availability<string>
  displayPath: string
}

export interface FileEntityRef {
  fileEntityId: string
  entityKind: 'file' | 'directory' | 'unknown'
  scope: FileScope
}

export interface FileRevisionRef {
  fileRevisionId: string
  fileEntityId: string
  contentDigest: Availability<Sha256>
  observedAt: Availability<IsoTimestamp>
}

export interface ArtifactVersionRef {
  schemaVersion: TruthKernelSchemaVersion
  artifactVersionId: string
  artifactId: string
  contentDigest: Availability<Sha256>
  sourceVersion: Availability<string>
  evidence: EvidenceRef[]
}

export interface RenameStep {
  from: FileEntityRef
  to: FileEntityRef
  evidence: EvidenceRef[]
}

export interface FileAction {
  schemaVersion: TruthKernelSchemaVersion
  fileActionId: string
  interactionId: string
  sourceEventId: string
  operation: 'read' | 'create' | 'update' | 'delete' | 'rename' | 'search' | 'execute-produced' | 'unknown'
  result: 'succeeded' | 'failed' | 'partial' | 'unknown'
  target: FileEntityRef
  beforeRevision: Availability<FileRevisionRef>
  afterRevision: Availability<FileRevisionRef>
  renameChain: RenameStep[]
  producedArtifactVersions: ArtifactVersionRef[]
  derivation: Exclude<DerivationKind, 'reported' | 'user-corrected'>
  evidence: EvidenceRef[]
}

export interface UsageAttribution {
  schemaVersion: TruthKernelSchemaVersion
  usageAttributionId: string
  interactionId: string
  usageFactIds: string[]
  billingFactIds: string[]
  quantityKind:
    | 'input-token'
    | 'output-token'
    | 'cache-read-token'
    | 'cache-write-token'
    | 'reasoning-token'
    | 'tool-token'
    | 'non-token'
  quantityUnit: 'token' | 'request' | 'image' | 'second' | 'byte' | 'provider-unit' | 'unknown'
  quantity: Availability<number>
  measurement: 'exact' | 'derived' | 'estimated' | 'unavailable'
  residual: Availability<number>
  sourceGranularity: 'per-call' | 'cumulative-snapshot' | 'session-total'
  lineageScope: 'physical-session' | 'current-branch-incremental' | 'lineage-unique'
  evidence: EvidenceRef[]
}

export interface UsageRollupBasis {
  basis: 'physical-session-usage' | 'current-branch-incremental-usage' | 'lineage-unique-usage'
  total: Availability<number>
  residual: Availability<number>
  billingFactIds: string[]
}

export interface BranchUsageRollup {
  schemaVersion: TruthKernelSchemaVersion
  rollupId: string
  logicalSessionId: string
  quantityKind: UsageAttribution['quantityKind']
  quantityUnit: UsageAttribution['quantityUnit']
  bases: [UsageRollupBasis, UsageRollupBasis, UsageRollupBasis]
  sourceTotal: Availability<number>
  attributedTotal: Availability<number>
  anomalyRefs: Array<{
    code: 'counter-reset' | 'negative-delta' | 'overlap' | 'unknown'
    usageFactIds: string[]
    evidence: EvidenceRef[]
  }>
  evidence: EvidenceRef[]
}

export interface ForkBoundary {
  schemaVersion: TruthKernelSchemaVersion
  forkBoundaryId: string
  parentLogicalSessionId: Availability<string>
  childLogicalSessionId: string
  forkEventId: Availability<string>
  firstIndependentEventId: Availability<string>
  sharedAncestorInteractionId: Availability<string>
  firstIndependentInteractionId: Availability<string>
  sharedEventKeys: string[]
  detection: 'harness-metadata' | 'message-dag' | 'shared-event-key' | 'content-hash-inference' | 'unknown'
  evidence: EvidenceRef[]
}

export interface Interaction {
  schemaVersion: TruthKernelSchemaVersion
  interactionId: string
  logicalSessionId: string
  ordinal: number
  trigger: 'user' | 'system' | 'resume' | 'followup'
  startEventId: string
  endEventId: string
  sourceEventIds: string[]
  startedAt: Availability<IsoTimestamp>
  endedAt: Availability<IsoTimestamp>
  modelCalls: InteractionModelCallFact[]
  toolEventIds: string[]
  toolCount: number
  timing: TimingFacts
  usageAttributionIds: string[]
  fileActionIds: string[]
  consumedArtifactVersionIds: string[]
  producedArtifactVersionIds: string[]
  contextSnapshotIds: string[]
  lineagePhase: 'shared-prefix' | 'independent' | 'unknown'
  evidence: EvidenceRef[]
}

export interface StorageRoot {
  schemaVersion: TruthKernelSchemaVersion
  rootId: string
  displayName: string
  kind: 'managed-library' | 'obsidian-vault' | 'project-folder' | 'external-folder'
  capability: 'read-write' | 'read-only' | 'manual-packages-only'
  layoutPolicy: 'loose-root' | 'managed-containers' | 'preserve-user-layout'
  includeRules: string[]
  excludeRules: string[]
  isDefaultArchiveTarget: boolean
}

export interface StorageRootObservation {
  schemaVersion: TruthKernelSchemaVersion
  observationId: string
  rootId: string
  deviceId: string
  permissionState: 'granted' | 'denied' | 'unknown'
  availabilityState: 'online' | 'offline' | 'unavailable' | 'unknown'
  scanState: 'never-scanned' | 'scanning' | 'fresh' | 'stale' | 'partial' | 'failed'
  lastSeenAt: Availability<IsoTimestamp>
  lastSuccessfulScanAt: Availability<IsoTimestamp>
  failureCode: Availability<string>
  observedAt: IsoTimestamp
}

export interface PackageLocation {
  schemaVersion: TruthKernelSchemaVersion
  locationId: string
  packageId: string
  rootId: Availability<string>
  deviceId: string
  relativePath: Availability<string>
  standaloneLocatorId: Availability<string>
  state: 'online' | 'placeholder' | 'pending-move' | 'missing' | 'replica' | 'conflict'
  lastSeenAt: Availability<IsoTimestamp>
  manifestDigest: Availability<Sha256>
  observationState: 'current' | 'last-known'
  absenceMeansDeletion: false
}

export interface CatalogScope {
  logicalSessionIds: string[]
  rootIds: string[]
  collectionIds: string[]
  providerIds: string[]
  projectIds: string[]
  pathPrefixes: string[]
  timeRange: Availability<{ from?: IsoTimestamp; to?: IsoTimestamp }>
  textQuery: Availability<string>
  emptyFilterSemantics: 'all-catalog'
}

export interface Collection {
  schemaVersion: TruthKernelSchemaVersion
  collectionId: string
  name: string
  kind: 'manual' | 'project' | 'smart-query' | 'favorite'
  scope: Availability<CatalogScope>
}

export interface CollectionMembership {
  schemaVersion: TruthKernelSchemaVersion
  membershipId: string
  collectionId: string
  logicalSessionId: string
  provenance: 'user' | 'rule'
  evidence: EvidenceRef[]
}

export interface WorkspaceTabScrollState {
  anchorObjectId: Availability<string>
  offsetPx: number
}

export interface WorkspaceTabLayoutState {
  density: 'comfortable' | 'compact'
  inspectorOpen: boolean
  splitRatio: Availability<number>
}

export interface WorkspaceTab {
  schemaVersion: TruthKernelSchemaVersion
  tabId: string
  title: string
  scope: CatalogScope
  view: 'sessions' | 'chat' | 'trajectory' | 'context' | 'insights' | 'graph'
  sidebarMode: 'collections' | 'locations' | 'sources'
  selectedObjectId: Availability<string>
  filters: Record<string, JsonValue>
  sort: Availability<string>
  navigationHistory: string[]
  scrollState: WorkspaceTabScrollState
  layoutState: WorkspaceTabLayoutState
  pinned: boolean
  persisted: boolean
}

export interface ArchiveCoverage {
  schemaVersion: TruthKernelSchemaVersion
  knownLogicalSessions: number
  archivedLogicalSessions: number
  sourceOnlyLogicalSessions: number
  offlineLogicalSessions: number
  conflictedLogicalSessions: number
  unavailableLogicalSessions: number
  logicalSessionIds: string[]
  packageIds: string[]
  offlineRootIds: string[]
  unavailableRootIds: string[]
  scope: CatalogScope
  scopeFingerprint: Sha256
  responseGeneration: string
  computedAt: IsoTimestamp
}

export interface CatalogConfiguration {
  schemaVersion: TruthKernelSchemaVersion
  rootIds: string[]
  defaultArchiveRootId: Availability<string>
  discoveryMode: 'read-only'
  automaticWriteSelection: 'unique-bound-location-or-fail-closed'
}

export interface CatalogSessionRecord {
  schemaVersion: TruthKernelSchemaVersion
  logicalSessionId: string
  sourceBindingIds: string[]
  packageIds: string[]
  state: 'known-source-only' | 'known-archived' | 'source-and-archive' | 'offline' | 'conflict'
}

export interface WritablePackageBinding {
  schemaVersion: TruthKernelSchemaVersion
  logicalSessionId: string
  packageId: Availability<string>
  locationId: Availability<string>
  candidateLocationIds: string[]
  state: 'bound' | 'source-only' | 'missing-previously-seen' | 'ambiguous' | 'read-only'
  automaticWriteAllowed: boolean
  reason: string
}

export interface ExternalEvidenceProvider {
  schemaVersion: TruthKernelSchemaVersion
  providerId: string
  displayName: string
  formatVersions: string[]
  captureKind: 'runtime-trace' | 'signed-event' | 'test-receipt' | 'other'
  descriptorVersion: string
}

export type CoreAssuranceDimension =
  | 'attachment-identity'
  | 'runtime-platform'
  | 'profile-policy'
  | 'network'
  | 'event-source-integrity'
  | 'attestation-external-commitment'
  | 'filesystem-outcome'
  | 'rollback'
  | 'completeness'

export interface AssuranceDimension {
  dimension: CoreAssuranceDimension | `x-${string}/${string}`
  assessment: 'observed' | 'verified' | 'claimed' | 'unknown' | 'unsupported'
  evidenceRefs: string[]
  verificationResultIds: string[]
  canProve: string[]
  cannotProve: string[]
}

export interface ExternalEvidenceAttachment {
  schemaVersion: TruthKernelSchemaVersion
  logicalAttachmentId: string
  revisionId: string
  revision: number
  supersedesRevisionId: Availability<string>
  externalProviderId: string
  sourceDigest: Sha256
  sourceIngestReceiptId: string
  schemaId: string
  sourceVersion: string
  mappedLogicalSessionId: Availability<string>
  matchMethod: 'exact-id' | 'heuristic-time' | 'heuristic-cwd' | 'user-selected' | 'other'
  confirmation: 'user-confirmed' | 'unconfirmed'
  state: 'candidate' | 'active' | 'detached' | 'target-unavailable' | 'target-merged' | 'superseded'
  reason: Availability<string>
  privacyState: 'private-local' | 'user-approved-local' | 'redacted'
  contentRetention: 'local-copy' | 'reference-only' | 'redacted-metadata-only'
  sourceDeletionAuthorized: false
  attachedAt: IsoTimestamp
  evidence: EvidenceRef[]
  assurance: AssuranceDimension[]
}

export type VerificationFailureCode =
  | 'source-digest-mismatch'
  | 'event-digest-mismatch'
  | 'chain-link-invalid'
  | 'event-missing'
  | 'event-duplicate'
  | 'event-reordered'
  | 'parser-version-mismatch'
  | 'serialization-version-unsupported'
  | 'bundle-artifact-missing'
  | 'bundle-artifact-digest-mismatch'
  | 'bundle-truncated'
  | 'bundle-path-unsafe'
  | `x-${string}/${string}`

export interface VerificationFailure {
  code: VerificationFailureCode
  artifactPath: Availability<string>
  message: string
  expectedDigest: Availability<Sha256>
  actualDigest: Availability<Sha256>
}

export interface VerificationResult {
  schemaVersion: TruthKernelSchemaVersion
  verificationId: string
  target: { kind: 'source-receipt' | 'event-chain' | 'bundle' | 'artifact'; id: string }
  checkedAt: IsoTimestamp
  verifierId: string
  verifierKind: 'built-in-offline' | 'provider-official' | 'external'
  verifierVersion: string
  status: 'not-requested' | 'valid' | 'invalid' | 'unavailable' | 'error'
  failures: VerificationFailure[]
}

export interface SourceIngestReceipt {
  schemaVersion: TruthKernelSchemaVersion
  receiptId: string
  sourceId: string
  sourceLocatorHash: string
  sourceSha256: Sha256
  sourceSizeBytes: number
  sourceMtime: Availability<IsoTimestamp>
  parserId: string
  parserVersion: string
  capturedAt: IsoTimestamp
  captureMethod: 'passive-file' | 'provider-event' | 'trusted-capture' | 'external-import'
  assuranceLevel: 'observed' | 'integrity-after-ingest' | 'externally-committed' | 'trusted-capture'
}

export interface CanonicalEventChainEntry {
  eventId: string
  sequence: number
  eventDigest: Sha256
  previousChainHash: Availability<Sha256>
  chainHash: Sha256
}

export interface CanonicalEventChain {
  schemaVersion: TruthKernelSchemaVersion
  chainId: string
  sourceIngestReceiptId: string
  parserId: string
  parserVersion: string
  serializationVersion: typeof TRUTH_KERNEL_SERIALIZATION_VERSION
  expectedEventCount: number
  entries: CanonicalEventChainEntry[]
  headHash: Availability<Sha256>
}

export interface VerifyBundleArtifact {
  kind: 'canonical-event' | 'source-receipt' | 'event-chain' | 'offline-verifier' | 'other'
  objectId: string
  relativePath: string
  sha256: Sha256
  sizeBytes: number
}

export interface VerifyBundleManifest {
  schemaVersion: TruthKernelSchemaVersion
  bundleId: string
  generatedAt: IsoTimestamp
  sourceReceipts: Array<{ receiptId: string; sourceSha256: Sha256 }>
  chainHeads: Array<{ chainId: string; headHash: Sha256 }>
  parserVersions: Array<{ parserId: string; parserVersion: string }>
  serializationVersion: typeof TRUTH_KERNEL_SERIALIZATION_VERSION
  artifacts: VerifyBundleArtifact[]
  verifier: { verifierId: string; version: string; sha256: Sha256 }
  digestAlgorithm: 'sha256-canonical-json-excluding-bundleDigest'
  bundleDigest: Sha256
  claimBoundary: 'integrity-after-ingest'
}

export interface ProviderRegistrationDescriptor {
  schemaVersion: TruthKernelSchemaVersion
  featureId: string
  providerId: string
  descriptorVersion: string
  capabilityContractVersion: string
  registrationExport: string
}

export interface OrchestrationRegistrationDescriptor {
  schemaVersion: TruthKernelSchemaVersion
  featureId: string
  orchestratorId: string
  descriptorVersion: string
  registrationExport: string
}

export interface OrchestrationEntity {
  schemaVersion: TruthKernelSchemaVersion
  orchestrationEntityId: string
  orchestratorId: string
  nativeKind: string
  nativeId: string
  rawPayload: JsonValue
  evidence: EvidenceRef[]
}

export interface OrchestrationEntityLink {
  schemaVersion: TruthKernelSchemaVersion
  edgeId: string
  orchestratorId: string
  fromEntityId: string
  toEntityId: string
  relation:
    | 'contains'
    | 'executes'
    | 'verifies'
    | 'uses-evidence'
    | 'produced-by'
    | 'parent-of'
    | 'depends-on'
    | 'unknown'
  nativeRelation: Availability<string>
  evidence: EvidenceRef[]
}

export interface OrchestrationRun {
  schemaVersion: TruthKernelSchemaVersion
  orchestrationRunId: string
  orchestratorId: string
  nativeEntityIds: string[]
  startedAt: Availability<IsoTimestamp>
  endedAt: Availability<IsoTimestamp>
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
  evidence: EvidenceRef[]
}

export interface SessionOrchestrationLink {
  schemaVersion: TruthKernelSchemaVersion
  linkId: string
  orchestrationRunId: string
  logicalSessionId: string
  relation: 'executes' | 'attempt' | 'verifies' | 'observes' | 'unknown'
  evidence: EvidenceRef[]
}

export interface CoverageState {
  state: 'complete' | 'partial' | 'unavailable' | 'unknown'
  coveredFactIds: string[]
  missingDimensions: string[]
  evidence: EvidenceRef[]
}

export interface ObservedUsageAggregate {
  schemaVersion: TruthKernelSchemaVersion
  aggregateId: string
  scope:
    | { kind: 'run'; orchestrationRunId: string }
    | { kind: 'entity'; orchestrationEntityId: string }
  usageFactIds: string[]
  providerId: Availability<string>
  modelId: Availability<string>
  metric: 'input-token' | 'output-token' | 'cache-read-token' | 'cache-write-token' | 'cost' | 'other'
  quantityUnit: string
  reportedTotal: Availability<number>
  coveredTotal: Availability<number>
  residual: Availability<number>
  authoritative: Availability<boolean>
  billingDisposition: 'observation-only'
  coverage: CoverageState
  evidence: EvidenceRef[]
}

export interface TranslationContributionDescriptor {
  schemaVersion: TruthKernelSchemaVersion
  featureId: string
  namespace: string
  locales: {
    zh: Record<string, string>
    en: Record<string, string>
  }
  fallbackLocale: 'zh' | 'en'
  ownedKeys: string[]
}

export interface UserPricingPolicy {
  schemaVersion: TruthKernelSchemaVersion
  policyId: string
  revisionId: string
  revision: number
  policyVersion: string
  purpose: 'public-price-correction' | 'contract-price'
  providerId: string
  modelId: string
  modelPattern: string
  currency: string
  rates: Array<{
    quantityKind: UsageAttribution['quantityKind']
    unit: UsageAttribution['quantityUnit']
    unitSize: number
    price: number
  }>
  sourceNote: string
  lifecycle: 'active' | 'superseded' | 'undone' | 'deleted'
  supersedesRevisionId: Availability<string>
  effectiveFrom: IsoTimestamp
  effectiveUntil: Availability<IsoTimestamp>
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
  provenance: EvidenceRef[]
}

export type PricingPolicyMutationCommand =
  | { contractVersion: '1.0.0'; commandId: string; kind: 'create'; expectedHeadRevision: null; policy: UserPricingPolicy }
  | { contractVersion: '1.0.0'; commandId: string; kind: 'supersede'; policyId: string; expectedHeadRevision: number; policy: UserPricingPolicy }
  | { contractVersion: '1.0.0'; commandId: string; kind: 'undo' | 'delete'; policyId: string; expectedHeadRevision: number; reason: string; occurredAt: IsoTimestamp }

export interface PricingPolicyMutationResponse {
  contractVersion: '1.0.0'
  commandId: string
  status: 'applied' | 'conflict' | 'invalid' | 'unavailable'
  appendedRevisionId: Availability<string>
  headRevision: Availability<number>
  errorCode: Availability<string>
}

export interface UserModelAlias {
  schemaVersion: TruthKernelSchemaVersion
  aliasId: string
  providerId: string
  rawModelId: string
  canonicalModelId: string
  effectiveFrom: IsoTimestamp
  effectiveUntil: Availability<IsoTimestamp>
  aliasVersion: string
  provenance: EvidenceRef[]
}

export interface ValuationView {
  schemaVersion: TruthKernelSchemaVersion
  usageFactId: string
  rawModelId: string
  officialPriceSnapshot: Availability<{ snapshotId: string; revision: string; digest: Sha256 }>
  publicEquivalent: Availability<{
    amount: number
    currency: string
    source: 'official-snapshot' | 'user-policy'
    policyRevisionId: Availability<string>
  }>
  actualContract: Availability<{ amount: number; currency: string; policyRevisionId: string }>
  resolution: 'exact' | 'ambiguous' | 'unavailable'
  evidence: EvidenceRef[]
}

export interface InteractionTrajectoryReadModel {
  schemaVersion: TruthKernelSchemaVersion
  interactionId: string
  logicalSessionId: string
  ordinal: number
  modelCalls: InteractionModelCallFact[]
  toolCount: number
  timing: TimingFacts
  usageAttributions: UsageAttribution[]
  branchUsageRollups: BranchUsageRollup[]
  valuations: ValuationView[]
  fileActions: FileAction[]
  toolEventIds: string[]
  contextPhase: 'introduced' | 'preserved' | 'summarized' | 'dropped' | 'unknown'
  lineagePhase: 'inherited' | 'independent' | 'unknown'
  forkBoundary: Availability<ForkBoundary>
}

export interface InteractionTrajectoryMockProvider {
  schemaVersion: TruthKernelSchemaVersion
  providerId: 'truth-kernel/mock-trajectory-v1'
  contractVersion: '1.0.0'
  interactions: InteractionTrajectoryReadModel[]
}

export interface ExternalEvidenceListItem {
  logicalAttachmentId: string
  latestRevisionId: string
  state: ExternalEvidenceAttachment['state']
  mappedLogicalSessionId: Availability<string>
  confirmation: ExternalEvidenceAttachment['confirmation']
}

export interface ExternalEvidenceDetailReadModel {
  logicalAttachmentId: string
  revisions: ExternalEvidenceAttachment[]
  activeRevision: Availability<ExternalEvidenceAttachment>
}

export interface AssuranceExplainReadModel {
  logicalAttachmentId: string
  dimensions: AssuranceDimension[]
  verificationResults: VerificationResult[]
  claimBoundary: 'integrity-after-ingest'
}

export type TruthKernelQuery =
  | { kind: 'timeline'; logicalSessionId: string; afterSequence?: number; limit?: number }
    | { kind: 'context-snapshot'; contextSnapshotId: string }
    | { kind: 'trajectory'; logicalSessionId: string }
    | { kind: 'catalog'; scope: CatalogScope }
    | { kind: 'verify-bundle'; bundleId: string }
    | { kind: 'interaction'; interactionId: string }
    | { kind: 'file-action'; fileActionId: string }
    | { kind: 'usage-attribution'; usageAttributionId: string }
    | { kind: 'valuation'; usageFactId: string }
    | { kind: 'fork-boundary'; forkBoundaryId: string }
    | { kind: 'evidence'; evidenceId: string }
    | { kind: 'external-evidence-list'; logicalSessionId?: string }
    | { kind: 'external-evidence-detail'; logicalAttachmentId: string; revisionId?: string }
    | { kind: 'assurance-explain'; logicalAttachmentId: string; dimension?: string }

export interface TruthKernelQueryRequest {
  contractVersion: '1.0.0'
  query: TruthKernelQuery
}

export interface TruthKernelQueryResponse<T = JsonValue> {
  contractVersion: '1.0.0'
  status: 'ok' | 'empty' | 'unavailable' | 'error'
  generation: string
  value?: T
  errorCode?: string
  coverage?: CoverageState
}

export interface TruthKernelQueryResultByKind {
  timeline: AgentTimelineEvent[]
  'context-snapshot': ContextSnapshot
  trajectory: InteractionTrajectoryReadModel[]
  catalog: CatalogSessionRecord[]
  'verify-bundle': { manifest: VerifyBundleManifest; verification: VerificationResult }
  interaction: Interaction
  'file-action': FileAction
  'usage-attribution': UsageAttribution
  valuation: ValuationView
  'fork-boundary': ForkBoundary
  evidence: EvidenceRef
  'external-evidence-list': ExternalEvidenceListItem[]
  'external-evidence-detail': ExternalEvidenceDetailReadModel
  'assurance-explain': AssuranceExplainReadModel
}

export type TruthKernelTypedQueryResponse<Q extends TruthKernelQuery> =
  TruthKernelQueryResponse<TruthKernelQueryResultByKind[Q['kind']]>

export interface TruthKernelGoldenFixture {
  fixtureVersion: '1.0.0'
  scenarioIds: string[]
  timelineEvents: AgentTimelineEvent[]
  contextArtifacts: ContextArtifact[]
  contextInjections: ContextInjection[]
  contextSnapshots: ContextSnapshot[]
  contextTransitions: ContextTransition[]
  mcpExposures: McpContextExposure[]
  deferredToolsDeltas: DeferredToolsDelta[]
  toolSearchReceipts: ToolSearchReceipt[]
  interactions: Interaction[]
  fileActions: FileAction[]
  artifactVersions: ArtifactVersionRef[]
  usageAttributions: UsageAttribution[]
  branchUsageRollups: BranchUsageRollup[]
  forkBoundaries: ForkBoundary[]
  storageRoots: StorageRoot[]
  storageRootObservations: StorageRootObservation[]
  packageLocations: PackageLocation[]
  collections: Collection[]
  collectionMemberships: CollectionMembership[]
  workspaceTabs: WorkspaceTab[]
  archiveCoverage: ArchiveCoverage
  catalogConfiguration: CatalogConfiguration
  catalogSessions: CatalogSessionRecord[]
  writableBindings: WritablePackageBinding[]
  externalEvidenceProviders: ExternalEvidenceProvider[]
  externalEvidenceAttachments: ExternalEvidenceAttachment[]
  sourceIngestReceipts: SourceIngestReceipt[]
  canonicalEventChains: CanonicalEventChain[]
  verifyBundles: VerifyBundleManifest[]
  verificationResults: VerificationResult[]
  providerRegistrationDescriptors: ProviderRegistrationDescriptor[]
  orchestrationRegistrationDescriptors: OrchestrationRegistrationDescriptor[]
  orchestrationEntities: OrchestrationEntity[]
  orchestrationEntityLinks: OrchestrationEntityLink[]
  orchestrationRuns: OrchestrationRun[]
  orchestrationLinks: SessionOrchestrationLink[]
  usageAggregates: ObservedUsageAggregate[]
  translationDescriptors: TranslationContributionDescriptor[]
  pricingPolicies: UserPricingPolicy[]
  pricingPolicyCommands: PricingPolicyMutationCommand[]
  pricingPolicyResponses: PricingPolicyMutationResponse[]
  modelAliases: UserModelAlias[]
  valuations: ValuationView[]
  derivedRecords: Array<DerivedRecord<JsonValue>>
  trajectoryProvider: InteractionTrajectoryMockProvider
}
