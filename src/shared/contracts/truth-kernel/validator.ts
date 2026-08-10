import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js'
import type {
  Availability,
  EvidenceRef,
  FileScope,
  TruthKernelGoldenFixture,
  UserModelAlias
} from './types'

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
    'toolSearchReceipts', 'interactions', 'fileActions', 'artifactVersions', 'usageAttributions', 'forkBoundaries',
    'storageRoots', 'packageLocations', 'collections', 'workspaceTabs', 'archiveCoverage',
    'catalogConfiguration', 'catalogSessions',
    'writableBindings', 'externalEvidenceProviders', 'externalEvidenceAttachments',
    'sourceIngestReceipts', 'canonicalEventChains', 'verifyBundles', 'verificationResults',
    'providerRegistrationDescriptors', 'orchestrationRegistrationDescriptors', 'orchestrationEntities',
    'orchestrationRuns', 'orchestrationLinks', 'usageAggregates', 'translationDescriptors',
    'pricingPolicies', 'modelAliases', 'valuations', 'derivedRecords', 'trajectoryProvider'
  ],
  properties: {
    fixtureVersion: { const: '1.0.0' },
    scenarioIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } }
  },
  patternProperties: {
    '^(timelineEvents|contextArtifacts|contextInjections|contextSnapshots|contextTransitions|mcpExposures|deferredToolsDeltas|toolSearchReceipts|interactions|fileActions|artifactVersions|usageAttributions|forkBoundaries|storageRoots|packageLocations|collections|workspaceTabs|catalogSessions|writableBindings|externalEvidenceProviders|externalEvidenceAttachments|sourceIngestReceipts|canonicalEventChains|verifyBundles|verificationResults|providerRegistrationDescriptors|orchestrationRegistrationDescriptors|orchestrationEntities|orchestrationRuns|orchestrationLinks|usageAggregates|translationDescriptors|pricingPolicies|modelAliases|valuations|derivedRecords)$': {
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

function timestampsOverlap(left: UserModelAlias, right: UserModelAlias): boolean {
  const leftStart = Date.parse(left.effectiveFrom)
  const rightStart = Date.parse(right.effectiveFrom)
  const leftEnd = isAvailable(left.effectiveUntil) ? Date.parse(left.effectiveUntil.value) : Number.POSITIVE_INFINITY
  const rightEnd = isAvailable(right.effectiveUntil) ? Date.parse(right.effectiveUntil.value) : Number.POSITIVE_INFINITY
  return leftStart < rightEnd && rightStart < leftEnd
}

const requiredRecordFields: Partial<Record<keyof TruthKernelGoldenFixture, readonly string[]>> = {
  timelineEvents: ['schemaVersion', 'timelineEventId', 'sourceEventId', 'sequence', 'providerEvent', 'evidence', 'persistedOutputs'],
  contextArtifacts: ['schemaVersion', 'contextArtifactId', 'kind', 'tokenCount', 'tokenMeasurement', 'evidence'],
  contextInjections: ['schemaVersion', 'contextInjectionId', 'contextArtifactId', 'contextRevision', 'evidence'],
  contextSnapshots: ['schemaVersion', 'contextSnapshotId', 'contextRevision', 'activeInjectionIds', 'evidence'],
  contextTransitions: ['schemaVersion', 'contextTransitionId', 'kind', 'deltas', 'evidence'],
  mcpExposures: ['schemaVersion', 'exposureId', 'configured', 'serverInstructionsVisible', 'toolNameVisible', 'schemaState', 'schemaEvidence', 'called', 'resultVisible'],
  deferredToolsDeltas: ['schemaVersion', 'deltaId', 'addedToolNames', 'removedToolNames', 'deferredSchemaToolNames', 'evidence'],
  toolSearchReceipts: ['schemaVersion', 'receiptId', 'visibleToolNames', 'loadedSchemaToolNames', 'evidence'],
  interactions: ['schemaVersion', 'interactionId', 'sourceEventIds', 'timing', 'usageAttributionIds', 'fileActionIds', 'consumedArtifactVersionIds', 'producedArtifactVersionIds', 'contextSnapshotIds', 'evidence'],
  fileActions: ['schemaVersion', 'fileActionId', 'operation', 'target', 'beforeRevision', 'afterRevision', 'renameChain', 'evidence'],
  artifactVersions: ['schemaVersion', 'artifactVersionId', 'artifactId', 'contentDigest'],
  usageAttributions: ['schemaVersion', 'usageAttributionId', 'measurement', 'quantity', 'residual', 'evidence'],
  forkBoundaries: ['schemaVersion', 'forkBoundaryId', 'sharedEventKeys', 'detection', 'evidence'],
  storageRoots: ['schemaVersion', 'rootId', 'capability', 'layoutPolicy'],
  packageLocations: ['schemaVersion', 'locationId', 'packageId', 'rootId', 'state'],
  collections: ['schemaVersion', 'collectionId', 'kind', 'scope'],
  workspaceTabs: ['schemaVersion', 'tabId', 'scope', 'view', 'sidebarMode'],
  catalogSessions: ['schemaVersion', 'logicalSessionId', 'sourceBindingIds', 'packageIds', 'state'],
  writableBindings: ['schemaVersion', 'logicalSessionId', 'packageId', 'locationId', 'candidateLocationIds', 'state', 'automaticWriteAllowed'],
  externalEvidenceProviders: ['schemaVersion', 'providerId', 'formatVersions', 'captureKind'],
  externalEvidenceAttachments: ['schemaVersion', 'attachmentId', 'mapping', 'mappedLogicalSessionId', 'assurance'],
  sourceIngestReceipts: ['schemaVersion', 'receiptId', 'sourceSha256', 'parserVersion', 'captureMethod', 'assuranceLevel'],
  canonicalEventChains: ['schemaVersion', 'chainId', 'serializationVersion', 'entries', 'headHash'],
  verifyBundles: ['schemaVersion', 'bundleId', 'sourceReceiptIds', 'chainIds', 'claimBoundary'],
  verificationResults: ['schemaVersion', 'verificationId', 'targetId', 'result', 'failures'],
  providerRegistrationDescriptors: ['schemaVersion', 'featureId', 'providerId', 'descriptorVersion', 'registrationExport'],
  orchestrationRegistrationDescriptors: ['schemaVersion', 'featureId', 'orchestratorId', 'descriptorVersion', 'registrationExport'],
  orchestrationEntities: ['schemaVersion', 'orchestrationEntityId', 'orchestratorId', 'nativeKind', 'nativeId', 'rawPayload', 'evidence'],
  orchestrationRuns: ['schemaVersion', 'orchestrationRunId', 'orchestratorId', 'nativeEntityIds', 'status', 'evidence'],
  orchestrationLinks: ['schemaVersion', 'linkId', 'orchestrationRunId', 'logicalSessionId', 'relation', 'evidence'],
  usageAggregates: ['schemaVersion', 'aggregateId', 'usageFactIds', 'reportedTotal', 'coveredTotal', 'residual', 'authoritative', 'coverage', 'evidence'],
  translationDescriptors: ['schemaVersion', 'featureId', 'namespace', 'locales', 'fallbackLocale', 'ownedKeys'],
  pricingPolicies: ['schemaVersion', 'policyId', 'purpose', 'providerId', 'modelId', 'effectiveFrom', 'effectiveUntil', 'provenance'],
  modelAliases: ['schemaVersion', 'aliasId', 'providerId', 'rawModelId', 'canonicalModelId', 'effectiveFrom', 'effectiveUntil', 'aliasVersion', 'provenance'],
  valuations: ['schemaVersion', 'usageFactId', 'rawModelId', 'officialPriceSnapshotId', 'publicEquivalent', 'actualContract', 'resolution', 'evidence'],
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

  fixture.externalEvidenceAttachments.forEach((attachment, index) => {
    if (attachment.mapping === 'unconfirmed-candidate' && isAvailable(attachment.mappedLogicalSessionId)) {
      issue(issues, `$/externalEvidenceAttachments/${index}`, 'unconfirmed-mapping-bound', 'fuzzy candidates cannot bind a logical session before confirmation')
    }
  })

  fixture.canonicalEventChains.forEach((chain, chainIndex) => {
    chain.entries.forEach((entry, entryIndex) => {
      if (entry.sequence !== entryIndex) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/sequence`, 'chain-sequence-gap', 'event chain sequence must be contiguous from zero')
      }
      if (entryIndex === 0 && isAvailable(entry.previousHash)) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/0/previousHash`, 'chain-genesis-previous-hash', 'genesis entry cannot have a previous hash')
      }
      if (entryIndex > 0 && (!isAvailable(entry.previousHash) || entry.previousHash.value !== chain.entries[entryIndex - 1].eventHash)) {
        issue(issues, `$/canonicalEventChains/${chainIndex}/entries/${entryIndex}/previousHash`, 'chain-link-invalid', 'event chain must link to the preceding event hash')
      }
    })
    const expectedHead = chain.entries.at(-1)?.eventHash
    if (expectedHead && (!isAvailable(chain.headHash) || chain.headHash.value !== expectedHead)) {
      issue(issues, `$/canonicalEventChains/${chainIndex}/headHash`, 'chain-head-invalid', 'headHash must equal the last event hash')
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
    if (isAvailable(publicEquivalent) && publicEquivalent.value.policyId) {
      const policy = fixture.pricingPolicies.find((candidate) => candidate.policyId === publicEquivalent.value.policyId)
      if (policy?.purpose !== 'public-price-correction') {
        issue(issues, `$/valuations/${index}/publicEquivalent`, 'public-valuation-policy-mismatch', 'public equivalent can only use public-price-correction')
      }
    }
    const actualContract = valuation.actualContract
    if (isAvailable(actualContract)) {
      const policy = fixture.pricingPolicies.find((candidate) => candidate.policyId === actualContract.value.policyId)
      if (policy?.purpose !== 'contract-price') {
        issue(issues, `$/valuations/${index}/actualContract`, 'contract-valuation-policy-mismatch', 'actual contract value can only use contract-price')
      }
    }
  })

  fixture.usageAggregates.forEach((aggregate, index) => {
    if (aggregate.coverage.state !== 'complete' && aggregate.authoritative && !isAvailable(aggregate.residual)) {
      issue(issues, `$/usageAggregates/${index}/residual`, 'partial-authoritative-residual-missing', 'authoritative partial aggregates require an explicit residual')
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
