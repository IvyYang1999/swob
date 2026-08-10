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

export interface TimingFacts {
  observedElapsedMs: Availability<number>
  modelLatencyMs: Availability<number>
  toolElapsedMs: Availability<number>
  agentActiveEstimateMs: Availability<number>
  userGapMs: Availability<number>
  approvalWaitMs: Availability<number>
}

export interface FileScope {
  rootId: Availability<string>
  repositoryId: Availability<string>
  worktreeId: Availability<string>
  logicalPath: string
}

export interface FileEntityRef {
  fileEntityId: string
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
  operation: 'read' | 'create' | 'edit' | 'delete' | 'rename' | 'execute' | 'reference' | 'unknown'
  target: FileEntityRef
  beforeRevision: Availability<FileRevisionRef>
  afterRevision: Availability<FileRevisionRef>
  renameChain: RenameStep[]
  derivation: Exclude<DerivationKind, 'reported' | 'user-corrected'>
  evidence: EvidenceRef[]
}

export interface UsageAttribution {
  schemaVersion: TruthKernelSchemaVersion
  usageAttributionId: string
  interactionId: string
  usageFactIds: string[]
  quantityUnit: 'token' | 'request' | 'image' | 'second' | 'byte' | 'provider-unit' | 'unknown'
  quantity: Availability<number>
  measurement: 'exact' | 'derived' | 'estimated' | 'unavailable'
  residual: Availability<number>
  evidence: EvidenceRef[]
}

export interface ForkBoundary {
  schemaVersion: TruthKernelSchemaVersion
  forkBoundaryId: string
  parentLogicalSessionId: Availability<string>
  childLogicalSessionId: string
  forkEventId: Availability<string>
  firstIndependentEventId: Availability<string>
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
}

export interface CatalogScope {
  logicalSessionIds: string[]
  rootIds: string[]
  collectionIds: string[]
  providerIds: string[]
  pathPrefixes: string[]
  timeRange: Availability<{ from?: IsoTimestamp; to?: IsoTimestamp }>
  textQuery: Availability<string>
}

export interface Collection {
  schemaVersion: TruthKernelSchemaVersion
  collectionId: string
  name: string
  kind: 'manual' | 'project' | 'smart-query' | 'favorite'
  scope: Availability<CatalogScope>
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

export interface AssuranceDimension {
  dimension: 'identity' | 'integrity-after-ingest' | 'external-commitment' | 'trusted-capture' | 'completeness'
  status: 'supported' | 'unsupported' | 'unknown'
  evidence: EvidenceRef[]
  note: string
}

export interface ExternalEvidenceAttachment {
  schemaVersion: TruthKernelSchemaVersion
  attachmentId: string
  externalProviderId: string
  sourceDigest: Sha256
  schemaId: string
  mappedLogicalSessionId: Availability<string>
  mapping: 'manual-confirmed' | 'exact-id' | 'unconfirmed-candidate'
  attachedAt: IsoTimestamp
  assurance: AssuranceDimension[]
}

export interface VerificationResult {
  schemaVersion: TruthKernelSchemaVersion
  verificationId: string
  targetId: string
  checkedAt: IsoTimestamp
  verifierVersion: string
  result: 'valid' | 'invalid' | 'unavailable'
  failures: string[]
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
  eventHash: Sha256
  previousHash: Availability<Sha256>
}

export interface CanonicalEventChain {
  schemaVersion: TruthKernelSchemaVersion
  chainId: string
  sourceIngestReceiptId: string
  serializationVersion: typeof TRUTH_KERNEL_SERIALIZATION_VERSION
  entries: CanonicalEventChainEntry[]
  headHash: Availability<Sha256>
}

export interface VerifyBundleManifest {
  schemaVersion: TruthKernelSchemaVersion
  bundleId: string
  generatedAt: IsoTimestamp
  sourceReceiptIds: string[]
  chainIds: string[]
  serializationVersion: typeof TRUTH_KERNEL_SERIALIZATION_VERSION
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
  orchestrationRunId: string
  usageFactIds: string[]
  quantityUnit: string
  reportedTotal: Availability<number>
  coveredTotal: Availability<number>
  residual: Availability<number>
  authoritative: boolean
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
  purpose: 'public-price-correction' | 'contract-price'
  providerId: string
  modelId: string
  currency: string
  effectiveFrom: IsoTimestamp
  effectiveUntil: Availability<IsoTimestamp>
  provenance: EvidenceRef[]
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
  officialPriceSnapshotId: Availability<string>
  publicEquivalent: Availability<{ amount: number; currency: string; policyId?: string }>
  actualContract: Availability<{ amount: number; currency: string; policyId: string }>
  resolution: 'exact' | 'ambiguous' | 'unavailable'
  evidence: EvidenceRef[]
}

export interface InteractionTrajectoryReadModel {
  schemaVersion: TruthKernelSchemaVersion
  interactionId: string
  ordinal: number
  timing: TimingFacts
  usage: Availability<{ quantity: number; unit: string; measurement: 'exact' | 'derived' | 'estimated' }>
  publicEquivalentValue: Availability<{ amount: number; currency: string }>
  actualContractValue: Availability<{ amount: number; currency: string }>
  fileActionIds: string[]
  toolEventIds: string[]
  contextPhase: 'introduced' | 'preserved' | 'summarized' | 'dropped' | 'unknown'
  lineagePhase: 'inherited' | 'independent' | 'unknown'
  evidenceJumpIds: string[]
}

export interface InteractionTrajectoryMockProvider {
  schemaVersion: TruthKernelSchemaVersion
  providerId: 'truth-kernel/mock-trajectory-v1'
  contractVersion: '1.0.0'
  interactions: InteractionTrajectoryReadModel[]
}

export interface TruthKernelQueryRequest {
  contractVersion: '1.0.0'
  query:
    | { kind: 'timeline'; logicalSessionId: string; afterSequence?: number; limit?: number }
    | { kind: 'context-snapshot'; contextSnapshotId: string }
    | { kind: 'trajectory'; logicalSessionId: string }
    | { kind: 'catalog'; scope: CatalogScope }
    | { kind: 'verify-bundle'; bundleId: string }
}

export interface TruthKernelQueryResponse<T = JsonValue> {
  contractVersion: '1.0.0'
  status: 'ok' | 'empty' | 'unavailable' | 'error'
  generation: string
  value?: T
  errorCode?: string
  coverage?: CoverageState
}

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
  forkBoundaries: ForkBoundary[]
  storageRoots: StorageRoot[]
  packageLocations: PackageLocation[]
  collections: Collection[]
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
  orchestrationRuns: OrchestrationRun[]
  orchestrationLinks: SessionOrchestrationLink[]
  usageAggregates: ObservedUsageAggregate[]
  translationDescriptors: TranslationContributionDescriptor[]
  pricingPolicies: UserPricingPolicy[]
  modelAliases: UserModelAlias[]
  valuations: ValuationView[]
  derivedRecords: Array<DerivedRecord<JsonValue>>
  trajectoryProvider: InteractionTrajectoryMockProvider
}
