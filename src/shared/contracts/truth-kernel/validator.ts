import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import type {
  Availability,
  EvidenceRef,
  FileScope,
  TruthKernelGoldenFixture,
  UserModelAlias
} from './types'
import {
  truthKernelBundleManifestDigest,
  truthKernelCanonicalSha256,
  truthKernelCanonicalUtf8Bytes,
  truthKernelRawSha256,
  truthKernelRollingChainHash
} from './canonical-json'

// The distributable JSON Schema lives beside this validator. This compact
// runtime copy avoids making renderer builds depend on importing JSON modules.
const fixtureSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://swob.dev/schema/truth-kernel/fixture/v1',
  type: 'object',
  additionalProperties: false,
  required: [
    'fixtureVersion', 'scenarioIds', 'timelineEvents', 'contextArtifacts', 'contextInjections',
    'contextSnapshots', 'contextTransitions', 'mcpExposures', 'deferredToolsDeltas',
    'toolSearchReceipts', 'interactions', 'fileActions', 'artifactVersions', 'usageAttributions', 'branchUsageRollups', 'forkBoundaries',
    'storageRoots', 'storageRootObservations', 'packageLocations', 'collections', 'collectionMemberships', 'workspaceTabs', 'archiveCoverage',
    'catalogConfiguration', 'catalogSessions',
    'writableBindings', 'externalEvidenceProviders', 'externalEvidenceAttachments',
    'sourceIngestReceipts', 'canonicalEventChains', 'verifyBundles', 'verificationResults',
    'providerRegistrationDescriptors', 'orchestrationRegistrationDescriptors', 'orchestrationEntities', 'orchestrationEntityLinks',
    'orchestrationRuns', 'orchestrationLinks', 'usageAggregates', 'translationDescriptors',
    'pricingPolicies', 'pricingPolicyCommands', 'pricingPolicyResponses', 'modelAliases', 'valuations', 'derivedRecords', 'trajectoryProvider'
  ],
  properties: {
    fixtureVersion: { const: '1.0.0' },
    scenarioIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    pricingPolicyCommands: { type: 'array', items: { type: 'object', required: ['contractVersion'], properties: { contractVersion: { const: '1.0.0' } } } },
    pricingPolicyResponses: { type: 'array', items: { type: 'object', required: ['contractVersion'], properties: { contractVersion: { const: '1.0.0' } } } }
  },
  patternProperties: {
    '^(timelineEvents|contextArtifacts|contextInjections|contextSnapshots|contextTransitions|mcpExposures|deferredToolsDeltas|toolSearchReceipts|interactions|fileActions|artifactVersions|usageAttributions|branchUsageRollups|forkBoundaries|storageRoots|storageRootObservations|packageLocations|collections|collectionMemberships|workspaceTabs|catalogSessions|writableBindings|externalEvidenceProviders|externalEvidenceAttachments|sourceIngestReceipts|canonicalEventChains|verifyBundles|verificationResults|providerRegistrationDescriptors|orchestrationRegistrationDescriptors|orchestrationEntities|orchestrationEntityLinks|orchestrationRuns|orchestrationLinks|usageAggregates|translationDescriptors|pricingPolicies|modelAliases|valuations|derivedRecords)$': {
      type: 'array',
      items: { type: 'object', required: ['schemaVersion'], properties: { schemaVersion: { const: 1 } } }
    },
    '^(archiveCoverage|catalogConfiguration|trajectoryProvider)$': {
      type: 'object',
      required: ['schemaVersion'],
      properties: { schemaVersion: { const: 1 } }
    }
  }
} as const

export interface TruthKernelValidationIssue {
  path: string
  code: string
  message: string
}

export interface TruthKernelValidationResult<T> {
  ok: boolean
  value?: T
  issues: TruthKernelValidationIssue[]
}

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true })
const validateFixtureSchema = ajv.compile<TruthKernelGoldenFixture>(fixtureSchema)

function schemaIssues(errors: ErrorObject[] | null | undefined): TruthKernelValidationIssue[] {
  return (errors || []).map((entry) => ({
    path: `$${entry.instancePath}`,
    code: `schema:${entry.keyword}`,
    message: entry.message || 'schema validation failed'
  }))
}

function issue(
  issues: TruthKernelValidationIssue[],
  path: string,
  code: string,
  message: string
): void {
  issues.push({ path, code, message })
}

function isAvailable<T>(value: Availability<T>): value is { status: 'available'; value: T } {
  return value.status === 'available'
}

function evidenceSupportsClaim(evidence: EvidenceRef): boolean {
  if (evidence.grade === 'A') return evidence.claim === 'wire-exact'
  if (evidence.grade === 'B') return evidence.claim === 'provider-confirmed'
  if (evidence.grade === 'C') return evidence.claim === 'deterministically-reconstructed'
  if (evidence.grade === 'D') return evidence.claim === 'heuristically-inferred'
  return evidence.claim === 'current-snapshot'
}

function directEvidence(evidence: EvidenceRef[]): boolean {
  return evidence.some((entry) => entry.grade === 'A' || entry.grade === 'B')
}

function availabilityInvariant(value: unknown, path: string, issues: TruthKernelValidationIssue[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const isAvailability = ['available', 'unknown', 'unavailable'].includes(String(record.status)) &&
    keys.every((key) => key === 'status' || key === 'value' || key === 'reason')
  if (!isAvailability) return
  if (record.status === 'available' && !Object.prototype.hasOwnProperty.call(record, 'value')) {
    issue(issues, path, 'availability-value-missing', 'available values must contain value')
  }
  if ((record.status === 'unknown' || record.status === 'unavailable') &&
    (typeof record.reason !== 'string' || record.reason.length === 0)) {
    issue(issues, path, 'availability-reason-missing', 'unknown/unavailable values require a reason')
  }
  if ((record.status === 'unknown' || record.status === 'unavailable') &&
    Object.prototype.hasOwnProperty.call(record, 'value')) {
    issue(issues, path, 'availability-value-forbidden', 'unknown/unavailable values cannot contain a value')
  }
}

function walkAvailability(value: unknown, path: string, issues: TruthKernelValidationIssue[]): void {
  availabilityInvariant(value, path, issues)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkAvailability(entry, `${path}/${index}`, issues))
    return
  }
  if (!value || typeof value !== 'object') return
  Object.entries(value as Record<string, unknown>).forEach(([key, child]) =>
    walkAvailability(child, `${path}/${key}`, issues))
}

function scopeKey(scope: FileScope): string {
  return JSON.stringify(scope)
}

function isSafeBundleRelativePath(value: string): boolean {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return false
  const segments = value.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function timestampsOverlap(left: UserModelAlias, right: UserModelAlias): boolean {
  const leftStart = Date.parse(left.effectiveFrom)
  const rightStart = Date.parse(right.effectiveFrom)
  const leftEnd = isAvailable(left.effectiveUntil) ? Date.parse(left.effectiveUntil.value) : Number.POSITIVE_INFINITY
  const rightEnd = isAvailable(right.effectiveUntil) ? Date.parse(right.effectiveUntil.value) : Number.POSITIVE_INFINITY
  return leftStart < rightEnd && rightStart < leftEnd
}

const requiredRecordFields: Partial<Record<keyof TruthKernelGoldenFixture, readonly string[]>> = {
  timelineEvents: ['schemaVersion', 'timelineEventId', 'sourceEventId', 'sequence', 'providerEvent', 'evidence', 'persistedOutputs'],
  contextArtifacts: ['schemaVersion', 'contextArtifactId', 'kind', 'content', 'attachmentRef', 'tokenCount', 'tokenMeasurement', 'evidence'],
  contextInjections: ['schemaVersion', 'contextInjectionId', 'contextArtifactId', 'contextRevision', 'evidence'],
  contextSnapshots: ['schemaVersion', 'contextSnapshotId', 'contextRevision', 'activeInjectionIds', 'evidence'],
  contextTransitions: ['schemaVersion', 'contextTransitionId', 'kind', 'deltas', 'evidence'],
  mcpExposures: ['schemaVersion', 'exposureId', 'configured', 'serverInstructionsVisible', 'toolNameVisible', 'schemaState', 'schemaEvidence', 'called', 'resultVisible'],
  deferredToolsDeltas: ['schemaVersion', 'deltaId', 'addedToolNames', 'removedToolNames', 'deferredSchemaToolNames', 'evidence'],
  toolSearchReceipts: ['schemaVersion', 'receiptId', 'visibleToolNames', 'loadedSchemaToolNames', 'evidence'],
  interactions: ['schemaVersion', 'interactionId', 'sourceEventIds', 'modelCalls', 'toolEventIds', 'toolCount', 'timing', 'usageAttributionIds', 'fileActionIds', 'consumedArtifactVersionIds', 'producedArtifactVersionIds', 'contextSnapshotIds', 'evidence'],
  fileActions: ['schemaVersion', 'fileActionId', 'operation', 'result', 'target', 'beforeRevision', 'afterRevision', 'renameChain', 'producedArtifactVersions', 'evidence'],
  artifactVersions: ['schemaVersion', 'artifactVersionId', 'artifactId', 'contentDigest', 'sourceVersion', 'evidence'],
  usageAttributions: ['schemaVersion', 'usageAttributionId', 'billingFactIds', 'quantityKind', 'measurement', 'quantity', 'residual', 'sourceGranularity', 'lineageScope', 'evidence'],
  branchUsageRollups: ['schemaVersion', 'rollupId', 'logicalSessionId', 'quantityKind', 'bases', 'sourceTotal', 'attributedTotal', 'anomalyRefs', 'evidence'],
  forkBoundaries: ['schemaVersion', 'forkBoundaryId', 'sharedAncestorInteractionId', 'firstIndependentInteractionId', 'sharedEventKeys', 'detection', 'evidence'],
  storageRoots: ['schemaVersion', 'rootId', 'capability', 'layoutPolicy'],
  storageRootObservations: ['schemaVersion', 'observationId', 'rootId', 'deviceId', 'permissionState', 'availabilityState', 'scanState', 'lastSeenAt', 'lastSuccessfulScanAt', 'failureCode'],
  packageLocations: ['schemaVersion', 'locationId', 'packageId', 'rootId', 'state', 'observationState', 'absenceMeansDeletion'],
  collections: ['schemaVersion', 'collectionId', 'kind', 'scope'],
  collectionMemberships: ['schemaVersion', 'membershipId', 'collectionId', 'logicalSessionId', 'provenance', 'evidence'],
  workspaceTabs: ['schemaVersion', 'tabId', 'scope', 'view', 'sidebarMode', 'scrollState', 'layoutState'],
  catalogSessions: ['schemaVersion', 'logicalSessionId', 'sourceBindingIds', 'packageIds', 'state'],
  writableBindings: ['schemaVersion', 'logicalSessionId', 'packageId', 'locationId', 'candidateLocationIds', 'state', 'automaticWriteAllowed'],
  externalEvidenceProviders: ['schemaVersion', 'providerId', 'formatVersions', 'captureKind'],
  externalEvidenceAttachments: ['schemaVersion', 'logicalAttachmentId', 'revisionId', 'revision', 'supersedesRevisionId', 'sourceIngestReceiptId', 'sourceVersion', 'matchMethod', 'confirmation', 'state', 'mappedLogicalSessionId', 'privacyState', 'contentRetention', 'sourceDeletionAuthorized', 'evidence', 'assurance'],
  sourceIngestReceipts: ['schemaVersion', 'receiptId', 'sourceSha256', 'parserVersion', 'captureMethod', 'assuranceLevel'],
  canonicalEventChains: ['schemaVersion', 'chainId', 'sourceIngestReceiptId', 'parserId', 'parserVersion', 'serializationVersion', 'expectedEventCount', 'entries', 'headHash'],
  verifyBundles: ['schemaVersion', 'bundleId', 'sourceReceipts', 'chainHeads', 'parserVersions', 'serializationVersion', 'artifacts', 'verifier', 'digestAlgorithm', 'bundleDigest', 'claimBoundary'],
  verificationResults: ['schemaVersion', 'verificationId', 'target', 'verifierId', 'verifierKind', 'verifierVersion', 'status', 'failures'],
  providerRegistrationDescriptors: ['schemaVersion', 'featureId', 'providerId', 'descriptorVersion', 'registrationExport'],
  orchestrationRegistrationDescriptors: ['schemaVersion', 'featureId', 'orchestratorId', 'descriptorVersion', 'registrationExport'],
  orchestrationEntities: ['schemaVersion', 'orchestrationEntityId', 'orchestratorId', 'nativeKind', 'nativeId', 'rawPayload', 'evidence'],
  orchestrationEntityLinks: ['schemaVersion', 'edgeId', 'orchestratorId', 'fromEntityId', 'toEntityId', 'relation', 'nativeRelation', 'evidence'],
  orchestrationRuns: ['schemaVersion', 'orchestrationRunId', 'orchestratorId', 'nativeEntityIds', 'status', 'evidence'],
  orchestrationLinks: ['schemaVersion', 'linkId', 'orchestrationRunId', 'logicalSessionId', 'relation', 'evidence'],
  usageAggregates: ['schemaVersion', 'aggregateId', 'scope', 'usageFactIds', 'providerId', 'modelId', 'metric', 'reportedTotal', 'coveredTotal', 'residual', 'authoritative', 'billingDisposition', 'coverage', 'evidence'],
  translationDescriptors: ['schemaVersion', 'featureId', 'namespace', 'locales', 'fallbackLocale', 'ownedKeys'],
  pricingPolicies: ['schemaVersion', 'policyId', 'revisionId', 'revision', 'policyVersion', 'purpose', 'providerId', 'modelId', 'modelPattern', 'rates', 'sourceNote', 'lifecycle', 'supersedesRevisionId', 'effectiveFrom', 'effectiveUntil', 'createdAt', 'updatedAt', 'provenance'],
  modelAliases: ['schemaVersion', 'aliasId', 'providerId', 'rawModelId', 'canonicalModelId', 'effectiveFrom', 'effectiveUntil', 'aliasVersion', 'provenance'],
  valuations: ['schemaVersion', 'usageFactId', 'rawModelId', 'officialPriceSnapshot', 'publicEquivalent', 'actualContract', 'resolution', 'evidence'],
  derivedRecords: ['schemaVersion', 'id', 'value', 'derivation', 'evidence', 'createdAt']
}

function validateFixtureShapes(fixture: TruthKernelGoldenFixture): TruthKernelValidationIssue[] {
  const issues: TruthKernelValidationIssue[] = []
  for (const [collectionName, fields] of Object.entries(requiredRecordFields)) {
    const records = fixture[collectionName as keyof TruthKernelGoldenFixture]
    if (!Array.isArray(records)) continue
    records.forEach((record, index) => {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        issue(issues, `$/${collectionName}/${index}`, 'record-object-required', 'fixture record must be an object')
        return
      }
      for (const field of fields) {
        if (!Object.prototype.hasOwnProperty.call(record, field)) {
          issue(issues, `$/${collectionName}/${index}/${field}`, 'required-field-missing', `required contract field is missing: ${field}`)
        }
      }
    })
  }
  return issues
}

function validateSemantics(fixture: TruthKernelGoldenFixture): TruthKernelValidationIssue[] {
  const issues: TruthKernelValidationIssue[] = []
  walkAvailability(fixture, '$', issues)

  const evidence = new Map<string, EvidenceRef>()
  const collectEvidence = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectEvidence)
      return
    }
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.evidenceId === 'string' && typeof record.grade === 'string' && typeof record.claim === 'string') {
      evidence.set(record.evidenceId, record as unknown as EvidenceRef)
    }
    Object.values(record).forEach(collectEvidence)
  }
  collectEvidence(fixture)
  for (const entry of evidence.values()) {
    if (!evidenceSupportsClaim(entry) && entry.claim !== 'user-asserted') {
      issue(issues, `evidence:${entry.evidenceId}`, 'evidence-grade-claim-mismatch', 'evidence grade and claim must agree')
    }
  }

  fixture.timelineEvents.forEach((event, index) => {
    if (event.sourceEventId !== event.providerEvent.id || event.sequence !== event.providerEvent.sequence) {
      issue(issues, `$/timelineEvents/${index}`, 'timeline-provider-event-mismatch', 'timeline identity must match the carried Provider v2 event')
    }
    if (event.providerEvent.kind === 'unknown') {
      const payload = event.providerEvent.payload as Record<string, unknown>
      if (typeof payload.rawType !== 'string' || !Object.prototype.hasOwnProperty.call(payload, 'rawPayload')) {
        issue(issues, `$/timelineEvents/${index}/providerEvent/payload`, 'unknown-payload-missing', 'unknown events require rawType and rawPayload')
      }
    }
  })

  fixture.contextArtifacts.forEach((artifact, index) => {
    if (artifact.tokenMeasurement === 'reported' && (!isAvailable(artifact.tokenCount) || !directEvidence(artifact.evidence))) {
      issue(issues, `$/contextArtifacts/${index}/tokenCount`, 'reported-without-direct-evidence', 'reported context tokens require an available count and A/B evidence')
    }
    if (artifact.tokenMeasurement === 'estimated' && artifact.evidence.some((entry) => entry.claim === 'wire-exact')) {
      issue(issues, `$/contextArtifacts/${index}/tokenMeasurement`, 'estimated-wire-conflict', 'estimated attribution cannot be labeled wire exact')
    }
    const isAttachment = artifact.kind === 'attached-file' || artifact.kind === 'attached-image'
    if (isAttachment && !isAvailable(artifact.attachmentRef)) {
      issue(issues, `$/contextArtifacts/${index}/attachmentRef`, 'attachment-reference-required', 'attached files and images require a binary-safe reference')
    }
    if (isAttachment && isAvailable(artifact.attachmentRef)) {
      const expectedKind = artifact.kind === 'attached-image' ? 'image' : 'file'
      if (artifact.attachmentRef.value.attachmentKind !== expectedKind || artifact.attachmentRef.value.activeContentAllowed !== false) {
        issue(issues, `$/contextArtifacts/${index}/attachmentRef`, 'attachment-reference-unsafe', 'attachment kind must match and active content must remain disabled')
      }
      if (isAvailable(artifact.content)) {
        issue(issues, `$/contextArtifacts/${index}/content`, 'binary-attachment-content-forbidden', 'binary attachment bytes cannot be stored as context text')
      }
    }
  })

  fixture.interactions.forEach((interaction, index) => {
    if (!Number.isInteger(interaction.toolCount) || interaction.toolCount < 0) {
      issue(issues, `$/interactions/${index}/toolCount`, 'tool-count-invalid', 'toolCount must be a non-negative integer')
    }
    for (const [name, duration] of Object.entries(interaction.timing)) {
      if (duration.measurement === 'unavailable' && isAvailable(duration.milliseconds)) {
        issue(issues, `$/interactions/${index}/timing/${name}`, 'duration-unavailable-with-value', 'unavailable duration cannot contain a measured value')
      }
      if (duration.measurement !== 'unavailable' && !isAvailable(duration.milliseconds)) {
        issue(issues, `$/interactions/${index}/timing/${name}`, 'duration-value-missing', 'measured duration requires a value')
      }
    }
    const { wall, agentActive, wait } = interaction.timing
    if (isAvailable(wall.milliseconds) && isAvailable(agentActive.milliseconds) && isAvailable(wait.milliseconds) &&
      wall.milliseconds.value !== agentActive.milliseconds.value + wait.milliseconds.value) {
      issue(issues, `$/interactions/${index}/timing`, 'timing-conservation-failed', 'wall time must equal agent-active plus wait time; user gaps cannot be counted as active')
    }
  })

  fixture.contextTransitions.forEach((transition, transitionIndex) => {
    transition.deltas.forEach((delta, deltaIndex) => {
      if (delta.disposition === 'dropped' && !directEvidence(delta.evidence)) {
        issue(
          issues,
          `$/contextTransitions/${transitionIndex}/deltas/${deltaIndex}`,
          'dropped-without-direct-evidence',
          'dropped requires direct removal evidence; absence after compact must remain unknown'
        )
      }
    })
  })

  fixture.mcpExposures.forEach((exposure, index) => {
    if (exposure.schemaState === 'loaded' && !directEvidence(exposure.schemaEvidence)) {
      issue(issues, `$/mcpExposures/${index}/schemaEvidence`, 'loaded-schema-without-direct-evidence', 'loaded MCP schema requires A/B evidence')
    }
    if (exposure.toolNameVisible.state === 'observed-true' && exposure.schemaState === 'loaded' && exposure.schemaEvidence.length === 0) {
      issue(issues, `$/mcpExposures/${index}`, 'name-does-not-prove-schema', 'tool-name visibility cannot prove schema loading')
    }
  })

  const fileScopes = new Map<string, string>()
  fixture.fileActions.forEach((action, index) => {
    const existing = fileScopes.get(action.target.fileEntityId)
    const current = scopeKey(action.target.scope)
    if (existing && existing !== current) {
      issue(issues, `$/fileActions/${index}/target`, 'file-identity-scope-conflict', 'one fileEntityId cannot name multiple root/repository/worktree/path scopes')
    }
    fileScopes.set(action.target.fileEntityId, current)
    if (action.operation === 'rename' && action.renameChain.length === 0) {
      issue(issues, `$/fileActions/${index}/renameChain`, 'rename-chain-missing', 'rename actions require an explicit chain')
    }
    if (action.operation === 'execute-produced' && action.producedArtifactVersions.length === 0) {
      issue(issues, `$/fileActions/${index}/producedArtifactVersions`, 'execute-produced-artifact-missing', 'execute-produced actions require an immutable produced artifact version')
    }
    if (action.target.scope.displayPath.length === 0) {
      issue(issues, `$/fileActions/${index}/target/scope/displayPath`, 'file-display-path-missing', 'file and directory actions require a display path')
    }
  })

  const artifactVersions = new Map(fixture.artifactVersions.map((version) => [version.artifactVersionId, version]))
  fixture.interactions.forEach((interaction, interactionIndex) => {
    interaction.consumedArtifactVersionIds.forEach((versionId) => {
      const version = artifactVersions.get(versionId)
      if (!version || !isAvailable(version.contentDigest)) {
        issue(issues, `$/interactions/${interactionIndex}/consumedArtifactVersionIds`, 'artifact-consumption-version-unresolved', 'consumption must reference an exact artifact version digest')
      }
    })
  })

  fixture.usageAttributions.forEach((attribution, index) => {
    if (attribution.measurement === 'exact' && !isAvailable(attribution.quantity)) {
      issue(issues, `$/usageAttributions/${index}/quantity`, 'exact-quantity-unavailable', 'exact attribution requires an available quantity')
    }
    if (isAvailable(attribution.quantity) && attribution.quantity.value < 0) {
      issue(issues, `$/usageAttributions/${index}/quantity`, 'usage-quantity-negative', 'usage quantities cannot be negative')
    }
  })

  const expectedRollupBases = new Set([
    'physical-session-usage',
    'current-branch-incremental-usage',
    'lineage-unique-usage'
  ])
  fixture.branchUsageRollups.forEach((rollup, index) => {
    const bases = new Set(rollup.bases.map((basis) => basis.basis))
    if (bases.size !== expectedRollupBases.size || [...expectedRollupBases].some((basis) => !bases.has(basis as never))) {
      issue(issues, `$/branchUsageRollups/${index}/bases`, 'usage-rollup-bases-incomplete', 'all three frozen branch usage bases are required exactly once')
    }
    if (isAvailable(rollup.sourceTotal) && isAvailable(rollup.attributedTotal)) {
      const physical = rollup.bases.find((basis) => basis.basis === 'physical-session-usage')
      if (physical && isAvailable(physical.total) && physical.total.value !== rollup.sourceTotal.value) {
        issue(issues, `$/branchUsageRollups/${index}`, 'usage-rollup-source-basis-mismatch', 'physical-session basis must equal source total')
      }
      if (physical && isAvailable(physical.residual) && rollup.sourceTotal.value !== rollup.attributedTotal.value + physical.residual.value) {
        issue(issues, `$/branchUsageRollups/${index}`, 'usage-rollup-conservation-failed', 'source total must equal attributed total plus residual')
      }
    }
  })

  fixture.forkBoundaries.forEach((boundary, index) => {
    if (boundary.detection === 'content-hash-inference' &&
      (isAvailable(boundary.sharedAncestorInteractionId) || isAvailable(boundary.firstIndependentInteractionId))) {
      issue(issues, `$/forkBoundaries/${index}`, 'content-hash-fork-cannot-be-exact', 'content hash inference alone cannot establish an exact interaction fork boundary')
    }
  })

  fixture.writableBindings.forEach((binding, index) => {
    if (binding.automaticWriteAllowed &&
      (binding.state !== 'bound' || !isAvailable(binding.packageId) || !isAvailable(binding.locationId) ||
        binding.candidateLocationIds.length !== 1)) {
      issue(issues, `$/writableBindings/${index}`, 'writable-binding-not-unique', 'automatic writes require exactly one bound package location')
    }
    if ((binding.state === 'ambiguous' || binding.state === 'missing-previously-seen') && binding.automaticWriteAllowed) {
      issue(issues, `$/writableBindings/${index}`, 'writable-binding-must-fail-closed', 'ambiguous or missing bindings must fail closed')
    }
  })

  const configuredDefault = fixture.catalogConfiguration.defaultArchiveRootId
  if (isAvailable(configuredDefault) && !fixture.storageRoots.some((root) => root.rootId === configuredDefault.value)) {
    issue(issues, '$/catalogConfiguration/defaultArchiveRootId', 'default-archive-root-missing', 'defaultArchiveRootId must reference a registered root')
  }
  if (fixture.storageRoots.filter((root) => root.isDefaultArchiveTarget).length > 1) {
    issue(issues, '$/storageRoots', 'multiple-default-archive-roots', 'at most one root can be the default archive target')
  }

  const rootObservations = new Map(fixture.storageRootObservations.map((observation) => [
    `${observation.rootId}\0${observation.deviceId}`,
    observation
  ]))
  fixture.packageLocations.forEach((location, index) => {
    if (!isAvailable(location.rootId)) return
    const observation = rootObservations.get(`${location.rootId.value}\0${location.deviceId}`)
    if (observation && (observation.availabilityState === 'offline' || observation.availabilityState === 'unavailable' || observation.permissionState === 'denied')) {
      if (location.observationState !== 'last-known' || location.state === 'missing' || location.absenceMeansDeletion !== false) {
        issue(issues, `$/packageLocations/${index}`, 'offline-root-location-must-remain-last-known', 'offline or permission-denied roots preserve last-known locations and never imply deletion')
      }
    }
  })

  const collectionIds = new Set(fixture.collections.map((collection) => collection.collectionId))
  fixture.collectionMemberships.forEach((membership, index) => {
    if (!collectionIds.has(membership.collectionId)) {
      issue(issues, `$/collectionMemberships/${index}/collectionId`, 'collection-membership-target-missing', 'membership must reference an existing collection')
    }
  })

  if (fixture.archiveCoverage.scopeFingerprint !== truthKernelCanonicalSha256(fixture.archiveCoverage.scope)) {
    issue(issues, '$/archiveCoverage/scopeFingerprint', 'archive-coverage-scope-mismatch', 'coverage fingerprint must bind the exact catalog scope')
  }
  if (new Set(fixture.archiveCoverage.logicalSessionIds).size !== fixture.archiveCoverage.knownLogicalSessions) {
    issue(issues, '$/archiveCoverage/logicalSessionIds', 'archive-coverage-session-count-mismatch', 'known session count must use unique logical session identities')
  }
  if (new Set(fixture.archiveCoverage.packageIds).size !== fixture.archiveCoverage.packageIds.length) {
    issue(issues, '$/archiveCoverage/packageIds', 'archive-coverage-package-double-count', 'one package with multiple locations must be counted once')
  }

  const sourceReceipts = new Map(fixture.sourceIngestReceipts.map((receipt) => [receipt.receiptId, receipt]))
  const chains = new Map(fixture.canonicalEventChains.map((chain) => [chain.chainId, chain]))
  const bundles = new Map(fixture.verifyBundles.map((bundle) => [bundle.bundleId, bundle]))
  const verificationById = new Map(fixture.verificationResults.map((result) => [result.verificationId, result]))
  const verificationTargetsAttachment = (
    verification: TruthKernelGoldenFixture['verificationResults'][number],
    attachment: TruthKernelGoldenFixture['externalEvidenceAttachments'][number]
  ): boolean => {
    if (verification.target.kind === 'source-receipt') {
      return verification.target.id === attachment.sourceIngestReceiptId
    }
    if (verification.target.kind === 'event-chain') {
      return chains.get(verification.target.id)?.sourceIngestReceiptId === attachment.sourceIngestReceiptId
    }
    if (verification.target.kind === 'bundle') {
      return bundles.get(verification.target.id)?.sourceReceipts.some(
        (receipt) => receipt.receiptId === attachment.sourceIngestReceiptId
      ) === true
    }
    return fixture.verifyBundles.some((bundle) =>
      bundle.sourceReceipts.some((receipt) => receipt.receiptId === attachment.sourceIngestReceiptId) &&
      bundle.artifacts.some((artifact) => artifact.objectId === verification.target.id)
    )
  }
  const attachmentRevisions = new Map<string, typeof fixture.externalEvidenceAttachments>()
  fixture.externalEvidenceAttachments.forEach((attachment, index) => {
    const revisions = attachmentRevisions.get(attachment.logicalAttachmentId) || []
    revisions.push(attachment)
    attachmentRevisions.set(attachment.logicalAttachmentId, revisions)
    const receipt = sourceReceipts.get(attachment.sourceIngestReceiptId)
    if (!receipt || receipt.sourceSha256 !== attachment.sourceDigest) {
      issue(issues, `$/externalEvidenceAttachments/${index}/sourceIngestReceiptId`, 'attachment-source-receipt-mismatch', 'attachment must bind an exact source receipt with the same digest')
    }
    if (attachment.state === 'active' &&
      (attachment.confirmation !== 'user-confirmed' || !isAvailable(attachment.mappedLogicalSessionId))) {
      issue(issues, `$/externalEvidenceAttachments/${index}`, 'active-attachment-not-user-confirmed', 'active attachments always require explicit user confirmation and a target session')
    }
    const attachmentEvidenceIds = new Set(attachment.evidence.map((entry) => entry.evidenceId))
    attachment.assurance.forEach((dimension, dimensionIndex) => {
      const core = new Set([
        'attachment-identity', 'runtime-platform', 'profile-policy', 'network',
        'event-source-integrity', 'attestation-external-commitment', 'filesystem-outcome',
        'rollback', 'completeness'
      ])
      if (!core.has(dimension.dimension) && !/^x-[^/]+\/.+/.test(dimension.dimension)) {
        issue(issues, `$/externalEvidenceAttachments/${index}/assurance/${dimensionIndex}/dimension`, 'assurance-dimension-invalid', 'assurance dimension must be frozen core or namespaced extension')
      }
      if (dimension.evidenceRefs.some((evidenceId) => !attachmentEvidenceIds.has(evidenceId))) {
        issue(issues, `$/externalEvidenceAttachments/${index}/assurance/${dimensionIndex}/evidenceRefs`, 'assurance-evidence-ref-missing', 'assurance evidence references must resolve inside the attachment revision')
      }
      if (dimension.verificationResultIds.some((verificationId) => !verificationById.has(verificationId))) {
        issue(issues, `$/externalEvidenceAttachments/${index}/assurance/${dimensionIndex}/verificationResultIds`, 'assurance-verification-ref-missing', 'assurance verification references must resolve')
      }
      if ((dimension.assessment === 'observed' || dimension.assessment === 'claimed') && dimension.evidenceRefs.length === 0) {
        issue(issues, `$/externalEvidenceAttachments/${index}/assurance/${dimensionIndex}/evidenceRefs`, 'assurance-evidence-required', 'observed and claimed assurance require at least one resolvable attachment evidence reference')
      }
      if (dimension.assessment === 'verified') {
        const validScopedVerification = dimension.verificationResultIds.some((verificationId) => {
          const verification = verificationById.get(verificationId)
          return verification?.status === 'valid' && verificationTargetsAttachment(verification, attachment)
        })
        if (!validScopedVerification) {
          issue(issues, `$/externalEvidenceAttachments/${index}/assurance/${dimensionIndex}/verificationResultIds`, 'assurance-valid-verification-required', 'verified assurance requires a status=valid verification scoped through this attachment revision')
        }
      }
    })
  })
  const currentActiveAttachmentKeys = new Set<string>()
  for (const [logicalAttachmentId, revisions] of attachmentRevisions) {
    const ordered = [...revisions].sort((left, right) => left.revision - right.revision)
    const revisionIds = new Set<string>()
    ordered.forEach((attachment, index) => {
      if (revisionIds.has(attachment.revisionId) || attachment.revision !== index + 1) {
        issue(issues, `attachment:${logicalAttachmentId}`, 'attachment-revision-invalid', 'attachment revisions must be unique and contiguous from one')
      }
      revisionIds.add(attachment.revisionId)
      if (index === 0 && isAvailable(attachment.supersedesRevisionId)) {
        issue(issues, `attachment:${logicalAttachmentId}`, 'attachment-genesis-supersedes', 'initial attachment revision cannot supersede another revision')
      }
      if (index > 0 && (!isAvailable(attachment.supersedesRevisionId) || attachment.supersedesRevisionId.value !== ordered[index - 1].revisionId)) {
        issue(issues, `attachment:${logicalAttachmentId}`, 'attachment-revision-chain-invalid', 'each attachment revision must supersede its immediate predecessor')
      }
    })
    const head = ordered.at(-1)
    if (head?.state === 'active' && isAvailable(head.mappedLogicalSessionId)) {
      const activeKey = `${head.externalProviderId}\0${head.sourceDigest}\0${head.mappedLogicalSessionId.value}`
      if (currentActiveAttachmentKeys.has(activeKey)) {
        issue(issues, `attachment:${logicalAttachmentId}`, 'duplicate-active-attachment', 'provider, source digest and target session can have only one current active attachment')
      }
      currentActiveAttachmentKeys.add(activeKey)
    }
  }

  const timelineEvents = new Map(fixture.timelineEvents.map((event) => [event.sourceEventId, event.providerEvent]))
  fixture.canonicalEventChains.forEach((chain, chainIndex) => {
    if (chain.serializationVersion !== 'truth-kernel-canonical-json/1') {
      issue(issues, `$/canonicalEventChains/${chainIndex}/serializationVersion`, 'chain-serialization-version-unsupported', 'unknown chain serialization versions fail closed')
    }
    const receipt = sourceReceipts.get(chain.sourceIngestReceiptId)
    if (!receipt || receipt.parserId !== chain.parserId || receipt.parserVersion !== chain.parserVersion) {
      issue(issues, `$/canonicalEventChains/${chainIndex}`, 'chain-parser-receipt-mismatch', 'chain parser identity and version must match its source receipt')
    }
    if (chain.entries.length !== chain.expectedEventCount) {
      issue(issues, `$/canonicalEventChains/${chainIndex}/entries`, 'chain-event-count-mismatch', 'chain entry count must match the frozen expected event count')
    }
    const seenEvents = new Set<string>()
    chain.entries.forEach((entry, entryIndex) => {
      if (entry.sequence !== entryIndex) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/sequence`, 'chain-sequence-gap', 'event chain sequence must be contiguous from zero')
      }
      if (seenEvents.has(entry.eventId)) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/eventId`, 'chain-event-duplicate', 'event chain cannot contain duplicate event identities')
      }
      seenEvents.add(entry.eventId)
      const event = timelineEvents.get(entry.eventId)
      if (!event) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/eventId`, 'chain-event-missing', 'event chain must reference a canonical event payload')
        return
      }
      if (entryIndex > 0) {
        const previousEvent = timelineEvents.get(chain.entries[entryIndex - 1].eventId)
        if (previousEvent && event.sequence <= previousEvent.sequence) {
          issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/eventId`, 'chain-event-reordered', 'canonical events must retain source sequence order')
        }
      }
      const expectedDigest = truthKernelCanonicalSha256(event)
      if (entry.eventDigest !== expectedDigest) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/eventDigest`, 'chain-event-digest-mismatch', 'event digest must bind the exact canonical event bytes')
      }
      const previousChainHash = entryIndex === 0 ? null : chain.entries[entryIndex - 1].chainHash
      if ((entryIndex === 0 && isAvailable(entry.previousChainHash)) ||
        (entryIndex > 0 && (!isAvailable(entry.previousChainHash) || entry.previousChainHash.value !== previousChainHash))) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/previousChainHash`, 'chain-link-invalid', 'event chain must link to the preceding rolling chain hash')
      }
      const expectedChainHash = truthKernelRollingChainHash({
        sourceIngestReceiptId: chain.sourceIngestReceiptId,
        parserId: chain.parserId,
        parserVersion: chain.parserVersion,
        serializationVersion: chain.serializationVersion,
        sequence: entry.sequence,
        previousChainHash,
        eventDigest: entry.eventDigest
      })
      if (entry.chainHash !== expectedChainHash) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/chainHash`, 'chain-rolling-hash-mismatch', 'rolling hash must bind receipt, parser, serialization, sequence, previous hash and event digest')
      }
    })
    const expectedHead = chain.entries.at(-1)?.chainHash
    if (expectedHead && (!isAvailable(chain.headHash) || chain.headHash.value !== expectedHead)) {
      issue(issues, `$/canonicalEventChains/${chainIndex}/headHash`, 'chain-head-invalid', 'headHash must equal the last rolling chain hash')
    }
  })

  fixture.verifyBundles.forEach((bundle, bundleIndex) => {
    const sortedPaths = [...bundle.artifacts].map((artifact) => artifact.relativePath).sort()
    if (JSON.stringify(sortedPaths) !== JSON.stringify(bundle.artifacts.map((artifact) => artifact.relativePath))) {
      issue(issues, `$/verifyBundles/${bundleIndex}/artifacts`, 'bundle-artifacts-not-path-sorted', 'bundle artifact inventory must be path sorted')
    }
    const artifactPaths = new Set<string>()
    bundle.artifacts.forEach((artifact, artifactIndex) => {
      if (!isSafeBundleRelativePath(artifact.relativePath)) {
        issue(issues, `$/verifyBundles/${bundleIndex}/artifacts/${artifactIndex}/relativePath`, 'bundle-artifact-path-unsafe', 'bundle paths must be normalized POSIX-relative paths without absolute, drive, URI, UNC, control, empty, dot or traversal segments')
      }
      if (artifactPaths.has(artifact.relativePath)) {
        issue(issues, `$/verifyBundles/${bundleIndex}/artifacts/${artifactIndex}/relativePath`, 'bundle-artifact-path-duplicate', 'bundle artifact paths must be unique')
      }
      artifactPaths.add(artifact.relativePath)
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
        issue(issues, `$/verifyBundles/${bundleIndex}/artifacts/${artifactIndex}`, 'bundle-artifact-metadata-invalid', 'bundle artifact digest and size must be valid')
      }
      const canonicalValue = artifact.kind === 'source-receipt'
        ? sourceReceipts.get(artifact.objectId)
        : artifact.kind === 'event-chain'
          ? chains.get(artifact.objectId)
          : artifact.kind === 'canonical-event'
            ? timelineEvents.get(artifact.objectId)
            : undefined
      if (canonicalValue) {
        const rawBytes = truthKernelCanonicalUtf8Bytes(canonicalValue)
        if (artifact.contentEncoding !== 'utf8-canonical-json-no-extra-bytes') {
          issue(issues, `$/verifyBundles/${bundleIndex}/artifacts/${artifactIndex}/contentEncoding`, 'bundle-canonical-artifact-encoding-invalid', 'canonical JSON exports must be exact UTF-8 with no BOM, newline or trailing byte')
        }
        if (artifact.sha256 !== truthKernelRawSha256(rawBytes) || artifact.sizeBytes !== rawBytes.byteLength) {
          issue(issues, `$/verifyBundles/${bundleIndex}/artifacts/${artifactIndex}`, 'bundle-artifact-raw-bytes-mismatch', 'artifact digest and size must match the exact raw exported file bytes')
        }
      } else if (artifact.kind === 'offline-verifier' && artifact.contentEncoding !== 'raw-bytes') {
        issue(issues, `$/verifyBundles/${bundleIndex}/artifacts/${artifactIndex}/contentEncoding`, 'bundle-binary-artifact-encoding-invalid', 'offline verifier artifacts use exact raw bytes')
      }
    })
    bundle.sourceReceipts.forEach((bundledReceipt) => {
      const receipt = sourceReceipts.get(bundledReceipt.receiptId)
      if (!receipt || receipt.sourceSha256 !== bundledReceipt.sourceSha256) {
        issue(issues, `$/verifyBundles/${bundleIndex}/sourceReceipts`, 'bundle-source-receipt-mismatch', 'bundle receipt IDs and source digests must resolve exactly')
      }
    })
    bundle.chainHeads.forEach((head) => {
      const chain = chains.get(head.chainId)
      if (!chain || !isAvailable(chain.headHash) || chain.headHash.value !== head.headHash) {
        issue(issues, `$/verifyBundles/${bundleIndex}/chainHeads`, 'bundle-chain-head-mismatch', 'bundle chain heads must bind exact chain heads')
      }
      if (!bundle.artifacts.some((artifact) => artifact.kind === 'event-chain' && artifact.objectId === head.chainId)) {
        issue(issues, `$/verifyBundles/${bundleIndex}/artifacts`, 'bundle-chain-artifact-missing', 'every referenced chain requires a content-addressed artifact')
      }
      chain?.entries.forEach((entry) => {
        if (!bundle.artifacts.some((artifact) => artifact.kind === 'canonical-event' && artifact.objectId === entry.eventId && artifact.sha256 === entry.eventDigest)) {
          issue(issues, `$/verifyBundles/${bundleIndex}/artifacts`, 'bundle-event-artifact-missing', 'every chained event requires a content-addressed canonical event artifact')
        }
      })
    })
    bundle.sourceReceipts.forEach((bundledReceipt) => {
      if (!bundle.artifacts.some((artifact) => artifact.kind === 'source-receipt' && artifact.objectId === bundledReceipt.receiptId)) {
        issue(issues, `$/verifyBundles/${bundleIndex}/artifacts`, 'bundle-receipt-artifact-missing', 'every source receipt requires a content-addressed artifact')
      }
    })
    if (!bundle.artifacts.some((artifact) => artifact.kind === 'offline-verifier' && artifact.objectId === bundle.verifier.verifierId && artifact.sha256 === bundle.verifier.sha256)) {
      issue(issues, `$/verifyBundles/${bundleIndex}/verifier`, 'bundle-verifier-artifact-mismatch', 'offline verifier identity and digest must resolve in the artifact inventory')
    }
    for (const head of bundle.chainHeads) {
      const chain = chains.get(head.chainId)
      if (chain && !bundle.parserVersions.some((parser) => parser.parserId === chain.parserId && parser.parserVersion === chain.parserVersion)) {
        issue(issues, `$/verifyBundles/${bundleIndex}/parserVersions`, 'bundle-parser-version-missing', 'bundle must bind every chain parser identity and version')
      }
    }
    if (bundle.serializationVersion !== 'truth-kernel-canonical-json/1') {
      issue(issues, `$/verifyBundles/${bundleIndex}/serializationVersion`, 'bundle-serialization-version-unsupported', 'unknown serialization versions fail closed')
    }
    if (bundle.digestAlgorithm !== 'sha256-canonical-json-excluding-bundleDigest') {
      issue(issues, `$/verifyBundles/${bundleIndex}/digestAlgorithm`, 'bundle-digest-algorithm-unsupported', 'bundle manifest digest algorithm must match the sole frozen v1 algorithm')
    }
    if (bundle.bundleDigest !== truthKernelBundleManifestDigest(bundle)) {
      issue(issues, `$/verifyBundles/${bundleIndex}/bundleDigest`, 'bundle-manifest-digest-mismatch', 'bundle digest must bind the canonical manifest excluding only its own digest field')
    }
  })

  fixture.verificationResults.forEach((result, index) => {
    if ((result.status === 'invalid' || result.status === 'error') && result.failures.length === 0) {
      issue(issues, `$/verificationResults/${index}/failures`, 'verification-failure-details-missing', 'invalid and error results require structured stable failure details')
    }
    if ((result.status === 'valid' || result.status === 'not-requested') && result.failures.length > 0) {
      issue(issues, `$/verificationResults/${index}/failures`, 'verification-failure-details-conflict', 'valid and not-requested results cannot carry failures')
    }
  })

  const translationKeys = new Set<string>()
  fixture.translationDescriptors.forEach((descriptor, index) => {
    const zhKeys = Object.keys(descriptor.locales.zh).sort()
    const enKeys = Object.keys(descriptor.locales.en).sort()
    const owned = [...descriptor.ownedKeys].sort()
    if (JSON.stringify(zhKeys) !== JSON.stringify(enKeys) || JSON.stringify(zhKeys) !== JSON.stringify(owned)) {
      issue(issues, `$/translationDescriptors/${index}`, 'translation-key-set-mismatch', 'zh, en and ownedKeys must contain exactly the same keys')
    }
    descriptor.ownedKeys.forEach((key) => {
      if (translationKeys.has(key)) issue(issues, `$/translationDescriptors/${index}/ownedKeys`, 'translation-key-duplicate', `duplicate translation key: ${key}`)
      translationKeys.add(key)
    })
  })

  const conflictingAliases = new Set<string>()
  fixture.modelAliases.forEach((left, leftIndex) => {
    fixture.modelAliases.slice(leftIndex + 1).forEach((right) => {
      if (left.providerId === right.providerId && left.rawModelId === right.rawModelId &&
        left.canonicalModelId !== right.canonicalModelId && timestampsOverlap(left, right)) {
        conflictingAliases.add(`${left.providerId}\0${left.rawModelId}`)
      }
    })
  })
  fixture.valuations.forEach((valuation, index) => {
    const providerIds = new Set(fixture.modelAliases.filter((alias) => alias.rawModelId === valuation.rawModelId).map((alias) => alias.providerId))
    if ([...providerIds].some((providerId) => conflictingAliases.has(`${providerId}\0${valuation.rawModelId}`)) && valuation.resolution !== 'unavailable') {
      issue(issues, `$/valuations/${index}/resolution`, 'alias-conflict-must-fail-closed', 'overlapping model aliases require unavailable valuation')
    }
    const publicEquivalent = valuation.publicEquivalent
    if (isAvailable(publicEquivalent) && publicEquivalent.value.source === 'user-policy') {
      const revisionId = publicEquivalent.value.policyRevisionId
      const policy = isAvailable(revisionId)
        ? fixture.pricingPolicies.find((candidate) => candidate.revisionId === revisionId.value)
        : undefined
      if (policy?.purpose !== 'public-price-correction') {
        issue(issues, `$/valuations/${index}/publicEquivalent`, 'public-valuation-policy-mismatch', 'user-policy public equivalent must reference an exact public correction revision')
      }
    }
    const actualContract = valuation.actualContract
    if (isAvailable(actualContract)) {
      const policy = fixture.pricingPolicies.find((candidate) => candidate.revisionId === actualContract.value.policyRevisionId)
      if (policy?.purpose !== 'contract-price') {
        issue(issues, `$/valuations/${index}/actualContract`, 'contract-valuation-policy-mismatch', 'actual contract value must reference an exact contract-price revision')
      }
    }
  })

  const orchestrationEntities = new Map(fixture.orchestrationEntities.map((entity) => [entity.orchestrationEntityId, entity]))
  const edgeIds = new Set<string>()
  fixture.orchestrationEntityLinks.forEach((edge, index) => {
    if (edgeIds.has(edge.edgeId)) issue(issues, `$/orchestrationEntityLinks/${index}/edgeId`, 'orchestration-edge-id-duplicate', 'orchestration edge IDs must be unique')
    edgeIds.add(edge.edgeId)
    const from = orchestrationEntities.get(edge.fromEntityId)
    const to = orchestrationEntities.get(edge.toEntityId)
    if (!from || !to) {
      issue(issues, `$/orchestrationEntityLinks/${index}`, 'orchestration-edge-endpoint-missing', 'both orchestration edge endpoints must exist')
    } else if (from.orchestratorId !== edge.orchestratorId || to.orchestratorId !== edge.orchestratorId) {
      issue(issues, `$/orchestrationEntityLinks/${index}/orchestratorId`, 'orchestration-edge-provider-mismatch', 'edge and endpoints must share one orchestrator identity')
    }
    if (edge.relation === 'unknown' && !isAvailable(edge.nativeRelation)) {
      issue(issues, `$/orchestrationEntityLinks/${index}/nativeRelation`, 'unknown-edge-native-relation-missing', 'unknown normalized relations must preserve the native relation')
    }
  })

  fixture.usageAggregates.forEach((aggregate, index) => {
    if (aggregate.billingDisposition !== 'observation-only') {
      issue(issues, `$/usageAggregates/${index}/billingDisposition`, 'aggregate-must-be-observation-only', 'orchestration aggregates cannot be billed directly')
    }
    if (aggregate.coverage.coveredFactIds.some((factId) => !aggregate.usageFactIds.includes(factId))) {
      issue(issues, `$/usageAggregates/${index}/coverage/coveredFactIds`, 'aggregate-covered-fact-outside-scope', 'covered fact IDs must be contained in usageFactIds')
    }
    const numeric = [aggregate.reportedTotal, aggregate.coveredTotal, aggregate.residual]
    if (numeric.some((value) => isAvailable(value) && value.value < 0)) {
      issue(issues, `$/usageAggregates/${index}`, 'aggregate-negative-total', 'observed aggregate totals cannot be negative')
    }
    if (isAvailable(aggregate.reportedTotal) && isAvailable(aggregate.coveredTotal) && isAvailable(aggregate.residual) &&
      aggregate.reportedTotal.value !== aggregate.coveredTotal.value + aggregate.residual.value) {
      issue(issues, `$/usageAggregates/${index}`, 'aggregate-conservation-failed', 'reported total must equal covered total plus residual')
    }
  })

  fixture.pricingPolicies.forEach((policy, index) => {
    if (policy.revision < 1 || policy.rates.some((rate) => rate.unitSize <= 0 || rate.price < 0)) {
      issue(issues, `$/pricingPolicies/${index}`, 'pricing-policy-rate-invalid', 'pricing revisions and typed rates must be non-negative with a positive unit size')
    }
  })
  const commandIds = new Set<string>()
  fixture.pricingPolicyCommands.forEach((command, index) => {
    if (commandIds.has(command.commandId)) issue(issues, `$/pricingPolicyCommands/${index}/commandId`, 'pricing-command-id-duplicate', 'pricing command IDs must be unique')
    commandIds.add(command.commandId)
    if (command.kind !== 'create' && command.expectedHeadRevision < 1) {
      issue(issues, `$/pricingPolicyCommands/${index}/expectedHeadRevision`, 'pricing-command-head-invalid', 'mutations require a positive expected head revision')
    }
    if (command.kind === 'create' && (command.policy.revision !== 1 || isAvailable(command.policy.supersedesRevisionId))) {
      issue(issues, `$/pricingPolicyCommands/${index}/policy`, 'pricing-create-revision-invalid', 'create must append revision one without a predecessor')
    }
    if (command.kind === 'supersede' &&
      (command.policy.policyId !== command.policyId || command.policy.revision !== command.expectedHeadRevision + 1 ||
        !isAvailable(command.policy.supersedesRevisionId))) {
      issue(issues, `$/pricingPolicyCommands/${index}/policy`, 'pricing-supersede-revision-invalid', 'supersede must append the next linked policy revision')
    }
  })
  fixture.pricingPolicyResponses.forEach((response, index) => {
    if (!commandIds.has(response.commandId)) issue(issues, `$/pricingPolicyResponses/${index}/commandId`, 'pricing-response-command-missing', 'pricing responses must reference a declared command')
    if (response.status === 'applied' && (!isAvailable(response.appendedRevisionId) || !isAvailable(response.headRevision))) {
      issue(issues, `$/pricingPolicyResponses/${index}`, 'pricing-applied-revision-missing', 'applied mutations append an auditable revision or tombstone')
    }
  })

  fixture.derivedRecords.forEach((record, index) => {
    if (record.derivation === 'user-corrected' && (!record.supersedes || !record.evidence.some((entry) => entry.claim === 'user-asserted'))) {
      issue(issues, `$/derivedRecords/${index}`, 'user-correction-must-revise', 'user corrections require user evidence and an explicit superseded revision')
    }
  })

  return issues
}

export function validateTruthKernelGoldenFixture(value: unknown): TruthKernelValidationResult<TruthKernelGoldenFixture> {
  if (!validateFixtureSchema(value)) return { ok: false, issues: schemaIssues(validateFixtureSchema.errors) }
  const shapeIssues = validateFixtureShapes(value)
  if (shapeIssues.length > 0) return { ok: false, issues: shapeIssues }
  try {
    const issues = validateSemantics(value)
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value, issues: [] }
  } catch (error) {
    return {
      ok: false,
      issues: [{
        path: '$',
        code: 'semantic-validation-failed-closed',
        message: error instanceof Error ? error.message : String(error)
      }]
    }
  }
}

export function assertTruthKernelGoldenFixture(value: unknown): TruthKernelGoldenFixture {
  const result = validateTruthKernelGoldenFixture(value)
  if (!result.ok) {
    throw new Error(`truth-kernel-fixture-invalid:${result.issues.map((entry) => `${entry.path}:${entry.code}`).join(',')}`)
  }
  return result.value!
}
