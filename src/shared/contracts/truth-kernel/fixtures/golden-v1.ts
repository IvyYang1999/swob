import type { CanonicalEvent, CanonicalEventKind, JsonValue } from '../../../provider-schema-v2.generated'
import type {
  Availability,
  CanonicalEventChain,
  ContextArtifact,
  EpistemicBoolean,
  EvidenceGrade,
  EvidenceRef,
  FileEntityRef,
  FileRevisionRef,
  McpContextExposure,
  SourceIngestReceipt,
  TruthKernelGoldenFixture
} from '../types'
import {
  truthKernelBundleManifestDigest,
  truthKernelCanonicalSha256,
  truthKernelCanonicalUtf8Bytes,
  truthKernelRawSha256,
  truthKernelRollingChainHash
} from '../canonical-json'

const at = '2026-08-10T00:00:00.000Z'
const shaA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const shaB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function available<T>(value: T): Availability<T> {
  return { status: 'available', value }
}

function unknown<T>(reason: string): Availability<T> {
  return { status: 'unknown', reason }
}

function unavailable<T>(reason: string): Availability<T> {
  return { status: 'unavailable', reason }
}

const claimByGrade: Record<EvidenceGrade, EvidenceRef['claim']> = {
  A: 'wire-exact',
  B: 'provider-confirmed',
  C: 'deterministically-reconstructed',
  D: 'heuristically-inferred',
  E: 'current-snapshot'
}

function evidence(grade: EvidenceGrade, suffix: string): EvidenceRef {
  return {
    evidenceId: `evidence-${grade}-${suffix}`,
    sourceId: `source-${suffix}`,
    sourceKind: grade === 'A' ? 'runtime-capture' : grade === 'E' ? 'artifact' : 'provider',
    providerId: 'swob/test',
    logicalSessionId: 'session-main',
    sourceEventId: `event-${suffix}`,
    eventTime: at,
    capturedAt: at,
    effectiveAt: at,
    grade,
    claim: claimByGrade[grade],
    locator: { kind: 'source-record', locatorHash: shaA },
    digest: shaA
  }
}

function userEvidence(suffix: string): EvidenceRef {
  return {
    evidenceId: `evidence-user-${suffix}`,
    sourceId: `user-${suffix}`,
    sourceKind: 'user',
    logicalSessionId: 'session-main',
    capturedAt: at,
    effectiveAt: at,
    grade: 'C',
    claim: 'user-asserted'
  }
}

function event(
  sequence: number,
  kind: CanonicalEventKind,
  actor: CanonicalEvent['actor'],
  payload: JsonValue
): CanonicalEvent {
  const id = `provider-event-${sequence}`
  return {
    id,
    identity: {
      physicalSourceId: 'source-main',
      logicalSessionKey: 'swob/test\0instance\0session-main',
      logicalSessionId: 'session-main',
      branchViewId: 'branch-main',
      parentBranchViewId: null
    },
    sharedEventKey: `shared-${sequence}`,
    messageId: `message-${sequence}`,
    sequence,
    messageBlockIndex: 0,
    timestamp: at,
    actor,
    kind,
    payload,
    visibility: 'primary',
    classification: kind.startsWith('interaction.') || kind.startsWith('permission.')
      ? 'interaction'
      : actor === 'user'
        ? 'user-content'
        : 'lifecycle',
    timeline: {
      archived: true,
      modelContext: [{ contextRevision: 1, state: 'visible-to-model', fromSequence: sequence, untilSequence: null }]
    },
    provenance: {
      providerId: 'swob/test',
      sourceRefId: 'source-main',
      parserDataVersion: 'fixture-1',
      formatVersion: 'fixture-1',
      observedAt: at,
      sourceRecordId: `record-${sequence}`,
      rawRecordFingerprint: { algorithm: 'sha256', value: shaA }
    },
    rawRef: { locatorHash: shaA, offset: sequence * 10, length: 10 }
  }
}

const providerEvents = [
  event(0, 'message.thinking', 'assistant', { text: 'reasoning' }),
  event(1, 'tool.call', 'assistant', { callId: 'call-1', rawName: 'Read', semanticToolId: 'fs.read', input: { path: 'src/a.ts' } }),
  event(2, 'tool.progress', 'tool', { callId: 'call-1', state: 'running', output: { progress: 0.5 } }),
  event(3, 'tool.result', 'tool', { callId: 'call-1', output: { ok: true }, isError: false, state: 'complete' }),
  event(4, 'interaction.request', 'assistant', { requestId: 'question-1', prompt: 'Choose', options: [], multiSelect: false, state: { state: 'historical', answered: true }, toolCallId: null, rawInput: {} }),
  event(5, 'interaction.response', 'user', { requestId: 'question-1', outcome: 'answered', answers: ['A'], toolCallId: null }),
  event(6, 'permission.request', 'assistant', { requestId: 'permission-1', permission: 'read', resource: { path: 'src/a.ts' }, state: { state: 'historical', answered: true }, toolCallId: 'call-1', rawInput: {} }),
  event(7, 'permission.response', 'user', { requestId: 'permission-1', decision: 'allow', toolCallId: 'call-1' }),
  event(8, 'context.compaction', 'system', { contextRevision: 2, archivedThroughSequence: 3, summaryEventId: 'provider-event-9' }),
  event(9, 'context.summary', 'system', { text: 'compact summary', contextRevision: 2 }),
  event(10, 'message.text', 'assistant', { text: 'answer' }),
  event(11, 'unknown', 'unknown', { rawType: 'future.quantum-event', rawPayload: { bytes: [0, 1, 255], nested: { preserved: true } } })
]

function contextArtifact(grade: EvidenceGrade, kind: ContextArtifact['kind'], suffix: string): ContextArtifact {
  const direct = grade === 'A' || grade === 'B'
  return {
    schemaVersion: 1,
    contextArtifactId: `context-${suffix}`,
    kind,
    providerId: 'swob/test',
    sourceUri: grade === 'E' ? available('file:///current/AGENTS.md') : available(`swob://context/${suffix}`),
    scope: grade === 'E' ? 'local' : 'runtime',
    capturedAt: at,
    effectiveAt: grade === 'E' ? unknown('current snapshot is not historical effective time') : available(at),
    contentDigest: available(shaA),
    content: grade === 'D' ? unavailable('content was not persisted') : available(`content-${suffix}`),
    attachmentRef: unavailable('not an attachment'),
    redaction: grade === 'D' ? 'content-withheld' : 'none',
    tokenCount: direct ? available(10) : grade === 'D' ? available(12) : unknown('not measured'),
    tokenMeasurement: direct ? 'reported' : grade === 'D' ? 'estimated' : 'unavailable',
    evidence: [evidence(grade, `context-${suffix}`)]
  }
}

function epistemic(state: EpistemicBoolean['state'], suffix: string, grade: EvidenceGrade = 'B'): EpistemicBoolean {
  return {
    state,
    observedAt: state === 'unknown' ? unknown('provider did not expose this state') : available(at),
    evidence: state === 'unknown' ? [] : [evidence(grade, suffix)]
  }
}

function mcp(
  suffix: string,
  configured: EpistemicBoolean['state'],
  instructions: EpistemicBoolean['state'],
  name: EpistemicBoolean['state'],
  schemaState: McpContextExposure['schemaState'],
  called: EpistemicBoolean['state'],
  result: EpistemicBoolean['state']
): McpContextExposure {
  return {
    schemaVersion: 1,
    exposureId: `mcp-${suffix}`,
    logicalSessionId: 'session-main',
    interactionId: available('interaction-1'),
    serverId: 'server-1',
    toolId: name === 'unknown' ? unknown('tool name not exposed') : available('server-1/tool-1'),
    configured: epistemic(configured, `${suffix}-configured`),
    serverInstructionsVisible: epistemic(instructions, `${suffix}-instructions`),
    toolNameVisible: epistemic(name, `${suffix}-name`),
    schemaState,
    schemaEvidence: schemaState === 'loaded' ? [evidence('B', `${suffix}-schema`)] : [],
    called: epistemic(called, `${suffix}-called`),
    resultVisible: epistemic(result, `${suffix}-result`)
  }
}

function fileEntity(id: string, rootId: string, worktreeId: string, logicalPath: string, repositoryId = 'repository-1'): FileEntityRef {
  return {
    fileEntityId: id,
    entityKind: 'file',
    scope: {
      rootId: available(rootId),
      repositoryId: available(repositoryId),
      worktreeId: available(worktreeId),
      logicalPath,
      originalPath: available(logicalPath),
      displayPath: logicalPath
    }
  }
}

function revision(id: string, entityId: string, digest: string): FileRevisionRef {
  return { fileRevisionId: id, fileEntityId: entityId, contentDigest: available(digest), observedAt: available(at) }
}

const fileA = fileEntity('file-root-a', 'root-a', 'worktree-a', 'src/a.ts')
const fileB = fileEntity('file-root-b', 'root-b', 'worktree-b', 'src/a.ts', 'repository-2')
const fileRenamed = fileEntity('file-root-a-renamed', 'root-a', 'worktree-a', 'src/b.ts')
const directoryA = { ...fileEntity('directory-root-a', 'root-a', 'worktree-a', 'src'), entityKind: 'directory' as const }

const attachmentRef = (kind: 'file' | 'image', suffix: string) => ({
  artifactId: `attachment-artifact-${suffix}`,
  sourceLocator: { kind: 'artifact' as const, locatorHash: shaA },
  digest: available(shaA),
  sizeBytes: available(kind === 'image' ? 1_024 : 64),
  mimeType: available(kind === 'image' ? 'image/png' : 'application/octet-stream'),
  provenance: [evidence('B', `attachment-${suffix}`)],
  allowedRoots: [{ rootId: 'root-a', access: 'read' as const, granted: true }],
  contentState: 'available' as const,
  attachmentKind: kind,
  activeContentAllowed: false as const
})

const catalogScope = {
  logicalSessionIds: ['session-main', 'session-source-only', 'session-offline'],
  rootIds: [],
  collectionIds: [],
  providerIds: [],
  projectIds: [],
  pathPrefixes: [],
  timeRange: unavailable<{ from?: string; to?: string }>('unbounded'),
  textQuery: unavailable<string>('no text filter'),
  emptyFilterSemantics: 'all-catalog' as const
}

const sourceIngestReceiptRecord = {
  schemaVersion: 1,
  receiptId: 'ingest-1',
  sourceId: 'source-main',
  sourceLocatorHash: shaA,
  sourceSha256: shaA,
  sourceSizeBytes: 100,
  sourceMtime: available(at),
  parserId: 'swob/test',
  parserVersion: '1.0.0',
  capturedAt: at,
  captureMethod: 'passive-file',
  assuranceLevel: 'integrity-after-ingest'
} satisfies SourceIngestReceipt

const chainEntry0Digest = truthKernelCanonicalSha256(providerEvents[0])
const chainEntry0Hash = truthKernelRollingChainHash({
  sourceIngestReceiptId: 'ingest-1', parserId: 'swob/test', parserVersion: '1.0.0',
  serializationVersion: 'truth-kernel-canonical-json/1', sequence: 0,
  previousChainHash: null, eventDigest: chainEntry0Digest
})
const chainEntry1Digest = truthKernelCanonicalSha256(providerEvents[1])
const chainEntry1Hash = truthKernelRollingChainHash({
  sourceIngestReceiptId: 'ingest-1', parserId: 'swob/test', parserVersion: '1.0.0',
  serializationVersion: 'truth-kernel-canonical-json/1', sequence: 1,
  previousChainHash: chainEntry0Hash, eventDigest: chainEntry1Digest
})

const canonicalEventChainRecord = {
  schemaVersion: 1,
  chainId: 'chain-1',
  sourceIngestReceiptId: 'ingest-1',
  parserId: 'swob/test',
  parserVersion: '1.0.0',
  serializationVersion: 'truth-kernel-canonical-json/1',
  expectedEventCount: 2,
  entries: [
    { eventId: 'provider-event-0', sequence: 0, eventDigest: chainEntry0Digest, previousChainHash: unavailable('genesis'), chainHash: chainEntry0Hash },
    { eventId: 'provider-event-1', sequence: 1, eventDigest: chainEntry1Digest, previousChainHash: available(chainEntry0Hash), chainHash: chainEntry1Hash }
  ],
  headHash: available(chainEntry1Hash)
} satisfies CanonicalEventChain

const receiptExportBytes = truthKernelCanonicalUtf8Bytes(sourceIngestReceiptRecord)
const chainExportBytes = truthKernelCanonicalUtf8Bytes(canonicalEventChainRecord)
const event0ExportBytes = truthKernelCanonicalUtf8Bytes(providerEvents[0])
const event1ExportBytes = truthKernelCanonicalUtf8Bytes(providerEvents[1])
const verifierExportBytes = new TextEncoder().encode('truth-kernel-fixture-offline-verifier-v1')

const bundleWithoutDigest = {
  schemaVersion: 1 as const,
  bundleId: 'bundle-1',
  generatedAt: at,
  sourceReceipts: [{ receiptId: 'ingest-1', sourceSha256: shaA }],
  chainHeads: [{ chainId: 'chain-1', headHash: chainEntry1Hash }],
  parserVersions: [{ parserId: 'swob/test', parserVersion: '1.0.0' }],
  serializationVersion: 'truth-kernel-canonical-json/1' as const,
  artifacts: [
    { kind: 'source-receipt' as const, objectId: 'ingest-1', relativePath: 'receipts/ingest-1.json', contentEncoding: 'utf8-canonical-json-no-extra-bytes' as const, sha256: truthKernelRawSha256(receiptExportBytes), sizeBytes: receiptExportBytes.byteLength },
    { kind: 'event-chain' as const, objectId: 'chain-1', relativePath: 'chains/chain-1.json', contentEncoding: 'utf8-canonical-json-no-extra-bytes' as const, sha256: truthKernelRawSha256(chainExportBytes), sizeBytes: chainExportBytes.byteLength },
    { kind: 'canonical-event' as const, objectId: 'provider-event-0', relativePath: 'events/provider-event-0.json', contentEncoding: 'utf8-canonical-json-no-extra-bytes' as const, sha256: truthKernelRawSha256(event0ExportBytes), sizeBytes: event0ExportBytes.byteLength },
    { kind: 'canonical-event' as const, objectId: 'provider-event-1', relativePath: 'events/provider-event-1.json', contentEncoding: 'utf8-canonical-json-no-extra-bytes' as const, sha256: truthKernelRawSha256(event1ExportBytes), sizeBytes: event1ExportBytes.byteLength },
    { kind: 'offline-verifier' as const, objectId: 'swob/offline-verifier', relativePath: 'verify/index.js', contentEncoding: 'raw-bytes' as const, sha256: truthKernelRawSha256(verifierExportBytes), sizeBytes: verifierExportBytes.byteLength }
  ].sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0),
  verifier: { verifierId: 'swob/offline-verifier', version: '1.0.0', sha256: truthKernelRawSha256(verifierExportBytes) },
  digestAlgorithm: 'sha256-canonical-json-excluding-bundleDigest' as const,
  claimBoundary: 'integrity-after-ingest' as const
}

export const TRUTH_KERNEL_GOLDEN_FIXTURE = {
  fixtureVersion: '1.0.0',
  scenarioIds: [
    'thinking-tool-progress-result-compact-answer',
    'interaction-and-permission-request-response',
    'fork-shared-prefix-independent-tail',
    'exact-session-only-unavailable-and-non-token-usage',
    'official-public-correction-contract-valuation-and-alias-conflict',
    'same-package-multiple-locations-offline-root-windows-path',
    'same-path-different-root-repository-worktree-and-versioned-file-actions',
    'context-grades-a-through-e-and-compact-fork-resume-deltas',
    'mcp-configured-instructions-name-deferred-loaded-called-result-six-states',
    'multica-run-multiple-sessions-and-partial-usage-coverage',
    'binary-safe-attached-file-and-image',
    'catalog-offline-root-preserves-last-known-locations',
    'external-evidence-manual-revision-and-offline-verification',
    'unknown-future-event-canonical-round-trip'
  ],
  timelineEvents: providerEvents.map((providerEvent) => ({
    schemaVersion: 1,
    timelineEventId: `timeline-${providerEvent.id}`,
    sourceEventId: providerEvent.id,
    sequence: providerEvent.sequence,
    parentTimelineEventIds: providerEvent.sequence === 0 ? [] : [`timeline-provider-event-${providerEvent.sequence - 1}`],
    providerEvent,
    evidence: [evidence('B', `timeline-${providerEvent.sequence}`)],
    persistedOutputs: providerEvent.kind === 'tool.result' ? [{
      artifactId: 'persisted-output-1',
      sourceLocator: { kind: 'artifact', locatorHash: shaA },
      digest: available(shaA),
      sizeBytes: available(64),
      mimeType: available('application/json'),
      provenance: [evidence('B', 'persisted-output')],
      allowedRoots: [{ rootId: 'root-a', access: 'read', granted: true }],
      contentState: 'available',
      outputKind: 'tool-output',
      activeContentAllowed: false
    }] : []
  })),
  contextArtifacts: [
    contextArtifact('A', 'system-prompt', 'wire'),
    contextArtifact('B', 'instruction-file', 'provider'),
    contextArtifact('C', 'memory-index', 'reconstructed'),
    contextArtifact('D', 'skill-body', 'inferred'),
    contextArtifact('E', 'instruction-file', 'current'),
    {
      ...contextArtifact('B', 'attached-file', 'attached-file'),
      content: unavailable('binary attachment bytes are never stored as context text'),
      redaction: 'content-withheld',
      attachmentRef: available(attachmentRef('file', 'file'))
    },
    {
      ...contextArtifact('B', 'attached-image', 'attached-image'),
      content: unavailable('binary attachment bytes are never stored as context text'),
      redaction: 'content-withheld',
      attachmentRef: available(attachmentRef('image', 'image'))
    }
  ],
  contextInjections: [
    {
      schemaVersion: 1,
      contextInjectionId: 'injection-wire',
      logicalSessionId: 'session-main',
      requestId: available('request-1'),
      interactionId: available('interaction-1'),
      contextRevision: 1,
      contextArtifactId: 'context-wire',
      operation: 'add',
      trigger: 'session-start',
      visibleToModel: true,
      effectiveAt: available(at),
      evidence: [evidence('A', 'injection-wire')]
    },
    {
      schemaVersion: 1,
      contextInjectionId: 'injection-summary',
      logicalSessionId: 'session-main',
      requestId: available('request-2'),
      interactionId: available('interaction-2'),
      contextRevision: 2,
      contextArtifactId: 'context-provider',
      operation: 'replace',
      trigger: 'compact',
      visibleToModel: 'unknown',
      effectiveAt: available(at),
      evidence: [evidence('B', 'injection-summary')]
    }
  ],
  contextSnapshots: [
    {
      schemaVersion: 1,
      contextSnapshotId: 'snapshot-before',
      logicalSessionId: 'session-main',
      requestId: available('request-1'),
      interactionId: available('interaction-1'),
      modelId: available('model-1'),
      contextLimit: unknown('provider did not report the historical model limit'),
      contextRevision: 1,
      activeInjectionIds: ['injection-wire'],
      reportedInputTokens: available(20),
      accountedInputTokens: available(10),
      unknownInputTokens: available(10),
      coveragePercent: available(50),
      evidence: [evidence('A', 'snapshot-before')]
    },
    {
      schemaVersion: 1,
      contextSnapshotId: 'snapshot-after',
      logicalSessionId: 'session-main',
      requestId: available('request-2'),
      interactionId: available('interaction-2'),
      modelId: available('model-1'),
      contextLimit: unknown('provider did not report the historical model limit'),
      contextRevision: 2,
      activeInjectionIds: ['injection-summary'],
      reportedInputTokens: available(12),
      accountedInputTokens: available(10),
      unknownInputTokens: available(2),
      coveragePercent: available(83.33),
      evidence: [evidence('B', 'snapshot-after')]
    }
  ],
  contextTransitions: [
    {
      schemaVersion: 1,
      contextTransitionId: 'transition-compact',
      kind: 'compact',
      fromSnapshotId: available('snapshot-before'),
      toSnapshotId: 'snapshot-after',
      interactionId: available('interaction-2'),
      effectiveAt: available(at),
      deltas: [
        { contextArtifactId: 'context-wire', disposition: 'summarized', fromInjectionIds: ['injection-wire'], toInjectionIds: ['injection-summary'], evidence: [evidence('B', 'delta-summarized')] },
        { contextArtifactId: 'context-reconstructed', disposition: 'unknown', fromInjectionIds: [], toInjectionIds: [], evidence: [evidence('C', 'delta-unknown')] }
      ],
      derivation: 'derived',
      algorithmId: 'truth-kernel/context-transition',
      algorithmVersion: '1.0.0',
      evidence: [evidence('B', 'transition-compact')]
    },
    {
      schemaVersion: 1,
      contextTransitionId: 'transition-fork',
      kind: 'fork',
      fromSnapshotId: available('snapshot-before'),
      toSnapshotId: 'snapshot-after',
      interactionId: available('interaction-1'),
      effectiveAt: available(at),
      deltas: [{ contextArtifactId: 'context-wire', disposition: 'preserved', fromInjectionIds: ['injection-wire'], toInjectionIds: ['injection-wire'], evidence: [evidence('B', 'delta-fork-preserved')] }],
      derivation: 'derived',
      algorithmId: 'truth-kernel/context-transition',
      algorithmVersion: '1.0.0',
      evidence: [evidence('B', 'transition-fork')]
    },
    {
      schemaVersion: 1,
      contextTransitionId: 'transition-resume',
      kind: 'resume',
      fromSnapshotId: unavailable('resume target had no previous request snapshot'),
      toSnapshotId: 'snapshot-after',
      interactionId: available('interaction-1'),
      effectiveAt: available(at),
      deltas: [{ contextArtifactId: 'context-provider', disposition: 'introduced', fromInjectionIds: [], toInjectionIds: ['injection-summary'], evidence: [evidence('B', 'delta-resume-introduced')] }],
      derivation: 'reported',
      algorithmId: 'truth-kernel/context-transition',
      algorithmVersion: '1.0.0',
      evidence: [evidence('B', 'transition-resume')]
    }
  ],
  mcpExposures: [
    mcp('configured-hidden', 'observed-true', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'),
    mcp('instructions-only', 'observed-true', 'observed-true', 'unknown', 'unknown', 'unknown', 'unknown'),
    mcp('name-deferred', 'observed-true', 'observed-true', 'observed-true', 'deferred', 'observed-false', 'observed-false'),
    mcp('schema-loaded', 'observed-true', 'observed-true', 'observed-true', 'loaded', 'observed-false', 'observed-false'),
    mcp('called-no-result', 'observed-true', 'observed-true', 'observed-true', 'loaded', 'observed-true', 'observed-false'),
    mcp('result-visible', 'observed-true', 'observed-true', 'observed-true', 'loaded', 'observed-true', 'observed-true')
  ],
  deferredToolsDeltas: [{
    schemaVersion: 1,
    deltaId: 'deferred-tools-1',
    contextRevision: 1,
    addedToolNames: ['server-1/tool-1'],
    removedToolNames: [],
    deferredSchemaToolNames: ['server-1/tool-1'],
    evidence: [evidence('B', 'deferred-tools')]
  }],
  toolSearchReceipts: [{
    schemaVersion: 1,
    receiptId: 'tool-search-1',
    interactionId: 'interaction-1',
    query: 'tool-1',
    visibleToolNames: ['server-1/tool-1'],
    loadedSchemaToolNames: ['server-1/tool-1'],
    effectiveAt: at,
    evidence: [evidence('B', 'tool-search')]
  }],
  interactions: [{
    schemaVersion: 1,
    interactionId: 'interaction-1',
    logicalSessionId: 'session-main',
    ordinal: 0,
    trigger: 'user',
    startEventId: 'provider-event-0',
    endEventId: 'provider-event-10',
    sourceEventIds: providerEvents.slice(0, 11).map((entry) => entry.id),
    startedAt: available(at),
    endedAt: available(at),
    modelCalls: [{
      providerId: 'swob/test',
      observedModelId: 'model-raw',
      canonicalModelId: available('model-canonical'),
      mode: available('default'),
      evidence: [evidence('B', 'interaction-model')]
    }],
    toolEventIds: ['provider-event-1', 'provider-event-2', 'provider-event-3'],
    toolCount: 1,
    timing: {
      wall: { milliseconds: available(100), measurement: 'exact', evidence: [evidence('B', 'timing-wall')] },
      agentActive: { milliseconds: available(80), measurement: 'derived', evidence: [evidence('C', 'timing-active')] },
      wait: { milliseconds: available(20), measurement: 'derived', evidence: [evidence('C', 'timing-wait')] }
    },
    usageAttributionIds: ['usage-exact', 'usage-cache-delta'],
    fileActionIds: ['file-create', 'file-read', 'file-rename', 'file-edit-other-root', 'file-search-directory', 'file-execute-produced', 'file-delete-failed'],
    consumedArtifactVersionIds: ['artifact-version-input'],
    producedArtifactVersionIds: ['artifact-version-output'],
    contextSnapshotIds: ['snapshot-before', 'snapshot-after'],
    lineagePhase: 'independent',
    evidence: [evidence('B', 'interaction')]
  }],
  fileActions: [
    {
      schemaVersion: 1,
      fileActionId: 'file-create',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-1',
      operation: 'create',
      result: 'succeeded',
      target: fileA,
      beforeRevision: unknown('file did not exist before create'),
      afterRevision: available(revision('revision-a1', fileA.fileEntityId, shaA)),
      renameChain: [],
      producedArtifactVersions: [],
      derivation: 'observed',
      evidence: [evidence('B', 'file-create')]
    },
    {
      schemaVersion: 1,
      fileActionId: 'file-read',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-1',
      operation: 'read',
      result: 'succeeded',
      target: fileA,
      beforeRevision: available(revision('revision-a1', fileA.fileEntityId, shaA)),
      afterRevision: available(revision('revision-a1', fileA.fileEntityId, shaA)),
      renameChain: [],
      producedArtifactVersions: [],
      derivation: 'observed',
      evidence: [evidence('B', 'file-read')]
    },
    {
      schemaVersion: 1,
      fileActionId: 'file-rename',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-3',
      operation: 'rename',
      result: 'succeeded',
      target: fileRenamed,
      beforeRevision: available(revision('revision-a1', fileA.fileEntityId, shaA)),
      afterRevision: available(revision('revision-a2', fileRenamed.fileEntityId, shaA)),
      renameChain: [{ from: fileA, to: fileRenamed, evidence: [evidence('B', 'file-rename-chain')] }],
      producedArtifactVersions: [],
      derivation: 'derived',
      evidence: [evidence('B', 'file-rename')]
    },
    {
      schemaVersion: 1,
      fileActionId: 'file-edit-other-root',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-3',
      operation: 'update',
      result: 'partial',
      target: fileB,
      beforeRevision: unknown('only the path was reported; prior content hash is unavailable'),
      afterRevision: available(revision('revision-b1', fileB.fileEntityId, shaB)),
      renameChain: [],
      producedArtifactVersions: [],
      derivation: 'observed',
      evidence: [evidence('B', 'file-edit-other-root')]
    },
    {
      schemaVersion: 1,
      fileActionId: 'file-search-directory',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-1',
      operation: 'search',
      result: 'succeeded',
      target: directoryA,
      beforeRevision: unknown('directory search has no content revision'),
      afterRevision: unknown('directory search has no content revision'),
      renameChain: [],
      producedArtifactVersions: [],
      derivation: 'observed',
      evidence: [evidence('B', 'file-search')]
    },
    {
      schemaVersion: 1,
      fileActionId: 'file-execute-produced',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-3',
      operation: 'execute-produced',
      result: 'succeeded',
      target: fileRenamed,
      beforeRevision: unknown('command output did not exist before execution'),
      afterRevision: available(revision('revision-output', fileRenamed.fileEntityId, shaB)),
      renameChain: [],
      producedArtifactVersions: [{ schemaVersion: 1, artifactVersionId: 'artifact-version-output', artifactId: 'artifact-subject', contentDigest: available(shaB), sourceVersion: unknown('command output has no source version'), evidence: [evidence('B', 'execute-output')] }],
      derivation: 'observed',
      evidence: [evidence('B', 'file-execute')]
    },
    {
      schemaVersion: 1,
      fileActionId: 'file-delete-failed',
      interactionId: 'interaction-1',
      sourceEventId: 'provider-event-3',
      operation: 'delete',
      result: 'failed',
      target: fileB,
      beforeRevision: unknown('upstream did not expose the hash'),
      afterRevision: unknown('delete failed; current hash was not observed'),
      renameChain: [],
      producedArtifactVersions: [],
      derivation: 'observed',
      evidence: [evidence('B', 'file-delete-failed')]
    }
  ],
  artifactVersions: [
    { schemaVersion: 1, artifactVersionId: 'artifact-version-input', artifactId: 'artifact-taskbook', contentDigest: available(shaA), sourceVersion: available('taskbook-v1'), evidence: [evidence('B', 'artifact-input')] },
    { schemaVersion: 1, artifactVersionId: 'artifact-version-output', artifactId: 'artifact-subject', contentDigest: available(shaB), sourceVersion: unknown('source does not expose a version'), evidence: [evidence('B', 'artifact-output')] }
  ],
  usageAttributions: [
    { schemaVersion: 1, usageAttributionId: 'usage-exact', interactionId: 'interaction-1', usageFactIds: ['usage-fact-1'], billingFactIds: ['billing-fact-1'], quantityKind: 'input-token', quantityUnit: 'token', quantity: available(100), measurement: 'exact', residual: available(0), sourceGranularity: 'per-call', lineageScope: 'lineage-unique', evidence: [evidence('B', 'usage-exact')] },
    { schemaVersion: 1, usageAttributionId: 'usage-session-only', interactionId: 'interaction-1', usageFactIds: ['usage-session-total'], billingFactIds: ['billing-session-total'], quantityKind: 'output-token', quantityUnit: 'token', quantity: unavailable('session total cannot be assigned to one interaction'), measurement: 'unavailable', residual: available(100), sourceGranularity: 'session-total', lineageScope: 'physical-session', evidence: [evidence('B', 'usage-session-only')] },
    { schemaVersion: 1, usageAttributionId: 'usage-none', interactionId: 'interaction-1', usageFactIds: [], billingFactIds: [], quantityKind: 'non-token', quantityUnit: 'unknown', quantity: unavailable('provider exposed no usage'), measurement: 'unavailable', residual: unavailable('no total exists'), sourceGranularity: 'session-total', lineageScope: 'current-branch-incremental', evidence: [] },
    { schemaVersion: 1, usageAttributionId: 'usage-image', interactionId: 'interaction-1', usageFactIds: ['usage-image-1'], billingFactIds: ['billing-image-1'], quantityKind: 'non-token', quantityUnit: 'image', quantity: available(2), measurement: 'exact', residual: available(0), sourceGranularity: 'per-call', lineageScope: 'lineage-unique', evidence: [evidence('B', 'usage-image')] },
    { schemaVersion: 1, usageAttributionId: 'usage-cache-delta', interactionId: 'interaction-1', usageFactIds: ['usage-cache-snapshot-1', 'usage-cache-snapshot-2'], billingFactIds: ['billing-cache-delta-1'], quantityKind: 'cache-read-token', quantityUnit: 'token', quantity: available(40), measurement: 'derived', residual: available(0), sourceGranularity: 'cumulative-snapshot', lineageScope: 'current-branch-incremental', evidence: [evidence('C', 'usage-cache-delta')] }
  ],
  branchUsageRollups: [{
    schemaVersion: 1,
    rollupId: 'rollup-input-token',
    logicalSessionId: 'session-main',
    quantityKind: 'input-token',
    quantityUnit: 'token',
    bases: [
      { basis: 'physical-session-usage', total: available(150), residual: available(50), billingFactIds: ['billing-session-total'] },
      { basis: 'current-branch-incremental-usage', total: available(100), residual: available(0), billingFactIds: ['billing-fact-1'] },
      { basis: 'lineage-unique-usage', total: available(100), residual: available(0), billingFactIds: ['billing-fact-1'] }
    ],
    sourceTotal: available(150),
    attributedTotal: available(100),
    anomalyRefs: [
      { code: 'counter-reset', usageFactIds: ['usage-session-total'], evidence: [evidence('B', 'usage-reset')] },
      { code: 'negative-delta', usageFactIds: ['usage-cache-snapshot-1', 'usage-cache-snapshot-2'], evidence: [evidence('C', 'usage-negative-delta')] }
    ],
    evidence: [evidence('B', 'usage-rollup')]
  }],
  forkBoundaries: [{
    schemaVersion: 1,
    forkBoundaryId: 'fork-1',
    parentLogicalSessionId: available('session-parent'),
    childLogicalSessionId: 'session-main',
    forkEventId: available('provider-event-3'),
    firstIndependentEventId: available('provider-event-4'),
    sharedAncestorInteractionId: available('interaction-parent-0'),
    firstIndependentInteractionId: available('interaction-1'),
    sharedEventKeys: ['shared-0', 'shared-1', 'shared-2', 'shared-3'],
    detection: 'shared-event-key',
    evidence: [evidence('B', 'fork')]
  }],
  storageRoots: [
    { schemaVersion: 1, rootId: 'root-a', displayName: 'Default Library', kind: 'managed-library', capability: 'read-write', layoutPolicy: 'loose-root', includeRules: ['**/.swob-session.json'], excludeRules: [], isDefaultArchiveTarget: true },
    { schemaVersion: 1, rootId: 'root-b', displayName: 'Vault Replica', kind: 'obsidian-vault', capability: 'read-write', layoutPolicy: 'preserve-user-layout', includeRules: ['AI/**/.swob-session.json'], excludeRules: ['.obsidian/**'], isDefaultArchiveTarget: false },
    { schemaVersion: 1, rootId: 'root-c', displayName: 'Offline Root', kind: 'external-folder', capability: 'read-only', layoutPolicy: 'preserve-user-layout', includeRules: ['**/.swob-session.json'], excludeRules: [], isDefaultArchiveTarget: false }
  ],
  storageRootObservations: [
    { schemaVersion: 1, observationId: 'root-observation-a', rootId: 'root-a', deviceId: 'device-1', permissionState: 'granted', availabilityState: 'online', scanState: 'fresh', lastSeenAt: available(at), lastSuccessfulScanAt: available(at), failureCode: unavailable('scan succeeded'), observedAt: at },
    { schemaVersion: 1, observationId: 'root-observation-c', rootId: 'root-c', deviceId: 'device-1', permissionState: 'granted', availabilityState: 'offline', scanState: 'stale', lastSeenAt: available(at), lastSuccessfulScanAt: available(at), failureCode: available('ROOT_OFFLINE'), observedAt: at }
  ],
  packageLocations: [
    { schemaVersion: 1, locationId: 'location-a', packageId: 'package-1', rootId: available('root-a'), deviceId: 'device-1', relativePath: available('Session A'), standaloneLocatorId: unavailable('root-relative package'), state: 'online', lastSeenAt: available(at), manifestDigest: available(shaA), observationState: 'current', absenceMeansDeletion: false },
    { schemaVersion: 1, locationId: 'location-b', packageId: 'package-1', rootId: available('root-b'), deviceId: 'device-1', relativePath: available('AI\\Session A'), standaloneLocatorId: unavailable('root-relative package'), state: 'replica', lastSeenAt: available(at), manifestDigest: available(shaA), observationState: 'current', absenceMeansDeletion: false },
    { schemaVersion: 1, locationId: 'location-c', packageId: 'package-2', rootId: available('root-c'), deviceId: 'device-1', relativePath: available('C:\\Sessions\\Offline'), standaloneLocatorId: unavailable('root-relative package'), state: 'placeholder', lastSeenAt: available(at), manifestDigest: available(shaB), observationState: 'last-known', absenceMeansDeletion: false }
  ],
  collections: [{ schemaVersion: 1, collectionId: 'collection-1', name: 'Project', kind: 'manual', scope: unavailable('manual membership is stored separately') }],
  collectionMemberships: [{ schemaVersion: 1, membershipId: 'membership-1', collectionId: 'collection-1', logicalSessionId: 'session-main', provenance: 'user', evidence: [userEvidence('collection-membership')] }],
  workspaceTabs: [{
    schemaVersion: 1,
    tabId: 'tab-1',
    title: 'Default Library · trajectory',
    scope: { logicalSessionIds: ['session-main'], rootIds: ['root-a'], collectionIds: [], providerIds: ['swob/test'], projectIds: [], pathPrefixes: [], timeRange: unavailable('unbounded'), textQuery: unavailable('no text filter'), emptyFilterSemantics: 'all-catalog' },
    view: 'trajectory',
    sidebarMode: 'locations',
    selectedObjectId: available('session-main'),
    filters: {},
    sort: available('updated-desc'),
    navigationHistory: ['session-main'],
    scrollState: { anchorObjectId: available('session-main'), offsetPx: 24 },
    layoutState: { density: 'compact', inspectorOpen: true, splitRatio: available(0.35) },
    pinned: true,
    persisted: true
  }],
  archiveCoverage: { schemaVersion: 1, knownLogicalSessions: 3, archivedLogicalSessions: 1, sourceOnlyLogicalSessions: 1, offlineLogicalSessions: 1, conflictedLogicalSessions: 0, unavailableLogicalSessions: 0, logicalSessionIds: ['session-main', 'session-offline', 'session-source-only'], packageIds: ['package-1', 'package-2'], offlineRootIds: ['root-c'], unavailableRootIds: [], scope: catalogScope, scopeFingerprint: truthKernelCanonicalSha256(catalogScope), responseGeneration: 'catalog-generation-1', computedAt: at },
  catalogConfiguration: { schemaVersion: 1, rootIds: ['root-a', 'root-b', 'root-c'], defaultArchiveRootId: available('root-a'), discoveryMode: 'read-only', automaticWriteSelection: 'unique-bound-location-or-fail-closed' },
  catalogSessions: [
    { schemaVersion: 1, logicalSessionId: 'session-main', sourceBindingIds: ['source-main'], packageIds: ['package-1'], state: 'source-and-archive' },
    { schemaVersion: 1, logicalSessionId: 'session-source-only', sourceBindingIds: ['source-only'], packageIds: [], state: 'known-source-only' },
    { schemaVersion: 1, logicalSessionId: 'session-offline', sourceBindingIds: [], packageIds: ['package-2'], state: 'offline' }
  ],
  writableBindings: [{ schemaVersion: 1, logicalSessionId: 'session-main', packageId: unavailable('multiple candidate locations'), locationId: unavailable('multiple candidate locations'), candidateLocationIds: ['location-a', 'location-b'], state: 'ambiguous', automaticWriteAllowed: false, reason: 'overlapping writable candidates fail closed' }],
  externalEvidenceProviders: [{ schemaVersion: 1, providerId: 'claude-tap', displayName: 'claude-tap', formatVersions: ['ctap/1'], captureKind: 'runtime-trace', descriptorVersion: '1.0.0' }],
  externalEvidenceAttachments: [
    {
      schemaVersion: 1,
      logicalAttachmentId: 'attachment-1',
      revisionId: 'attachment-1-r1',
      revision: 1,
      supersedesRevisionId: unavailable('initial revision'),
      externalProviderId: 'claude-tap',
      sourceDigest: shaA,
      sourceIngestReceiptId: 'ingest-1',
      schemaId: 'ctap/1',
      sourceVersion: 'claude-tap/1.0.0',
      mappedLogicalSessionId: unknown('candidate requires manual confirmation'),
      matchMethod: 'exact-id',
      confirmation: 'unconfirmed',
      state: 'candidate',
      reason: available('awaiting explicit user confirmation'),
      privacyState: 'private-local',
      contentRetention: 'reference-only',
      sourceDeletionAuthorized: false,
      attachedAt: at,
      evidence: [evidence('B', 'attachment-candidate')],
      assurance: [{
        dimension: 'attachment-identity', assessment: 'unknown', evidenceRefs: [], verificationResultIds: [],
        canProve: [], cannotProve: ['target identity before user confirmation']
      }]
    },
    {
      schemaVersion: 1,
      logicalAttachmentId: 'attachment-1',
      revisionId: 'attachment-1-r2',
      revision: 2,
      supersedesRevisionId: available('attachment-1-r1'),
      externalProviderId: 'claude-tap',
      sourceDigest: shaA,
      sourceIngestReceiptId: 'ingest-1',
      schemaId: 'ctap/1',
      sourceVersion: 'claude-tap/1.0.0',
      mappedLogicalSessionId: available('session-main'),
      matchMethod: 'user-selected',
      confirmation: 'user-confirmed',
      state: 'active',
      reason: available('user selected and confirmed the target session'),
      privacyState: 'user-approved-local',
      contentRetention: 'reference-only',
      sourceDeletionAuthorized: false,
      attachedAt: at,
      evidence: [userEvidence('attachment-confirmation'), evidence('B', 'attachment-integrity')],
      assurance: [
        { dimension: 'attachment-identity', assessment: 'claimed', evidenceRefs: ['evidence-user-attachment-confirmation'], verificationResultIds: [], canProve: ['user-confirmed relation'], cannotProve: ['provider-native identity'] },
        { dimension: 'event-source-integrity', assessment: 'verified', evidenceRefs: ['evidence-B-attachment-integrity'], verificationResultIds: ['verify-1'], canProve: ['integrity after ingest'], cannotProve: ['pre-ingest integrity'] },
        { dimension: 'completeness', assessment: 'unknown', evidenceRefs: [], verificationResultIds: [], canProve: [], cannotProve: ['capture completeness'] }
      ]
    }
  ],
  sourceIngestReceipts: [sourceIngestReceiptRecord],
  canonicalEventChains: [canonicalEventChainRecord],
  verifyBundles: [{ ...bundleWithoutDigest, bundleDigest: truthKernelBundleManifestDigest(bundleWithoutDigest) }],
  verificationResults: [{ schemaVersion: 1, verificationId: 'verify-1', target: { kind: 'bundle', id: 'bundle-1' }, checkedAt: at, verifierId: 'swob/offline-verifier', verifierKind: 'built-in-offline', verifierVersion: '1.0.0', status: 'valid', failures: [] }],
  providerRegistrationDescriptors: [{ schemaVersion: 1, featureId: 'test-provider', providerId: 'swob/test', descriptorVersion: '1.0.0', capabilityContractVersion: '2.0', registrationExport: 'TEST_PROVIDER_DESCRIPTOR' }],
  orchestrationRegistrationDescriptors: [{ schemaVersion: 1, featureId: 'multica-overlay', orchestratorId: 'multica', descriptorVersion: '1.0.0', registrationExport: 'MULTICA_ORCHESTRATION_DESCRIPTOR' }],
  orchestrationEntities: [
    { schemaVersion: 1, orchestrationEntityId: 'multica-issue-1', orchestratorId: 'multica', nativeKind: 'issue', nativeId: 'issue-1', rawPayload: { title: 'Issue' } as JsonValue, evidence: [evidence('B', 'multica-issue')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-task-1', orchestratorId: 'multica', nativeKind: 'task', nativeId: 'task-1', rawPayload: {} as JsonValue, evidence: [evidence('B', 'multica-task')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-stage-1', orchestratorId: 'multica', nativeKind: 'stage', nativeId: 'stage-1', rawPayload: {} as JsonValue, evidence: [evidence('B', 'multica-stage')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-attempt-1', orchestratorId: 'multica', nativeKind: 'attempt', nativeId: 'attempt-1', rawPayload: { status: 'running' } as JsonValue, evidence: [evidence('B', 'multica-attempt')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-verifier-1', orchestratorId: 'multica', nativeKind: 'verifier', nativeId: 'verifier-1', rawPayload: {} as JsonValue, evidence: [evidence('B', 'multica-verifier')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-subject-1', orchestratorId: 'multica', nativeKind: 'subject', nativeId: 'subject-1', rawPayload: {} as JsonValue, evidence: [evidence('B', 'multica-subject')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-evidence-1', orchestratorId: 'multica', nativeKind: 'evidence', nativeId: 'evidence-1', rawPayload: {} as JsonValue, evidence: [evidence('B', 'multica-evidence')] },
    { schemaVersion: 1, orchestrationEntityId: 'multica-artifact-1', orchestratorId: 'multica', nativeKind: 'artifact', nativeId: 'artifact-1', rawPayload: {} as JsonValue, evidence: [evidence('B', 'multica-artifact')] }
  ],
  orchestrationEntityLinks: [
    { schemaVersion: 1, edgeId: 'edge-contains', orchestratorId: 'multica', fromEntityId: 'multica-stage-1', toEntityId: 'multica-task-1', relation: 'contains', nativeRelation: available('stage-task'), evidence: [evidence('B', 'edge-contains')] },
    { schemaVersion: 1, edgeId: 'edge-executes', orchestratorId: 'multica', fromEntityId: 'multica-task-1', toEntityId: 'multica-attempt-1', relation: 'executes', nativeRelation: available('task-attempt'), evidence: [evidence('B', 'edge-executes')] },
    { schemaVersion: 1, edgeId: 'edge-verifies', orchestratorId: 'multica', fromEntityId: 'multica-verifier-1', toEntityId: 'multica-subject-1', relation: 'verifies', nativeRelation: available('verifier-subject'), evidence: [evidence('B', 'edge-verifies')] },
    { schemaVersion: 1, edgeId: 'edge-evidence', orchestratorId: 'multica', fromEntityId: 'multica-verifier-1', toEntityId: 'multica-evidence-1', relation: 'uses-evidence', nativeRelation: available('verifier-evidence'), evidence: [evidence('B', 'edge-evidence')] },
    { schemaVersion: 1, edgeId: 'edge-produced', orchestratorId: 'multica', fromEntityId: 'multica-artifact-1', toEntityId: 'multica-attempt-1', relation: 'produced-by', nativeRelation: available('artifact-producer'), evidence: [evidence('B', 'edge-produced')] },
    { schemaVersion: 1, edgeId: 'edge-parent', orchestratorId: 'multica', fromEntityId: 'multica-issue-1', toEntityId: 'multica-task-1', relation: 'parent-of', nativeRelation: available('parent-child'), evidence: [evidence('B', 'edge-parent')] },
    { schemaVersion: 1, edgeId: 'edge-depends', orchestratorId: 'multica', fromEntityId: 'multica-task-1', toEntityId: 'multica-subject-1', relation: 'depends-on', nativeRelation: available('task-dependency'), evidence: [evidence('B', 'edge-depends')] }
  ],
  orchestrationRuns: [{ schemaVersion: 1, orchestrationRunId: 'run-1', orchestratorId: 'multica', nativeEntityIds: ['multica-issue-1', 'multica-task-1', 'multica-attempt-1'], startedAt: available(at), endedAt: unknown('run is still active'), status: 'running', evidence: [evidence('B', 'multica-run')] }],
  orchestrationLinks: [
    { schemaVersion: 1, linkId: 'run-session-codex', orchestrationRunId: 'run-1', logicalSessionId: 'codex-session', relation: 'attempt', evidence: [evidence('B', 'link-codex')] },
    { schemaVersion: 1, linkId: 'run-session-claude', orchestrationRunId: 'run-1', logicalSessionId: 'claude-session', relation: 'verifies', evidence: [evidence('B', 'link-claude')] }
  ],
  usageAggregates: [{ schemaVersion: 1, aggregateId: 'aggregate-1', scope: { kind: 'run', orchestrationRunId: 'run-1' }, usageFactIds: ['usage-codex'], providerId: available('swob/test'), modelId: available('model-raw'), metric: 'input-token', quantityUnit: 'token', reportedTotal: available(150), coveredTotal: available(100), residual: available(50), authoritative: unknown('orchestrator does not declare billing authority'), billingDisposition: 'observation-only', coverage: { state: 'partial', coveredFactIds: ['usage-codex'], missingDimensions: ['claude-session-usage'], evidence: [evidence('B', 'aggregate-coverage')] }, evidence: [evidence('B', 'aggregate')] }],
  translationDescriptors: [{ schemaVersion: 1, featureId: 'truth-kernel', namespace: 'truthKernel', locales: { zh: { 'truthKernel.unavailable': '不可用' }, en: { 'truthKernel.unavailable': 'Unavailable' } }, fallbackLocale: 'en', ownedKeys: ['truthKernel.unavailable'] }],
  pricingPolicies: [
    { schemaVersion: 1, policyId: 'policy-public', revisionId: 'policy-public-r1', revision: 1, policyVersion: '1.0.0', purpose: 'public-price-correction', providerId: 'swob/test', modelId: 'model-canonical', modelPattern: '^model-canonical$', currency: 'USD', rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: 10 }], sourceNote: 'user correction of public list price', lifecycle: 'active', supersedesRevisionId: unavailable('initial revision'), effectiveFrom: at, effectiveUntil: unavailable('open-ended'), createdAt: at, updatedAt: at, provenance: [evidence('B', 'policy-public')] },
    { schemaVersion: 1, policyId: 'policy-contract', revisionId: 'policy-contract-r1', revision: 1, policyVersion: '1.0.0', purpose: 'contract-price', providerId: 'swob/test', modelId: 'model-canonical', modelPattern: '^model-canonical$', currency: 'USD', rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: 5 }], sourceNote: 'private negotiated contract price', lifecycle: 'active', supersedesRevisionId: unavailable('initial revision'), effectiveFrom: at, effectiveUntil: unavailable('open-ended'), createdAt: at, updatedAt: at, provenance: [evidence('B', 'policy-contract')] }
  ],
  pricingPolicyCommands: [
    { contractVersion: '1.0.0', commandId: 'pricing-create-public', kind: 'create', expectedHeadRevision: null, policy: { schemaVersion: 1, policyId: 'policy-public', revisionId: 'policy-public-r1', revision: 1, policyVersion: '1.0.0', purpose: 'public-price-correction', providerId: 'swob/test', modelId: 'model-canonical', modelPattern: '^model-canonical$', currency: 'USD', rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: 10 }], sourceNote: 'user correction of public list price', lifecycle: 'active', supersedesRevisionId: unavailable('initial revision'), effectiveFrom: at, effectiveUntil: unavailable('open-ended'), createdAt: at, updatedAt: at, provenance: [evidence('B', 'policy-command')] } },
    { contractVersion: '1.0.0', commandId: 'pricing-supersede-public', kind: 'supersede', policyId: 'policy-public', expectedHeadRevision: 1, policy: { schemaVersion: 1, policyId: 'policy-public', revisionId: 'policy-public-r2', revision: 2, policyVersion: '1.0.0', purpose: 'public-price-correction', providerId: 'swob/test', modelId: 'model-canonical', modelPattern: '^model-canonical$', currency: 'USD', rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: 9 }], sourceNote: 'corrected rate', lifecycle: 'active', supersedesRevisionId: available('policy-public-r1'), effectiveFrom: at, effectiveUntil: unavailable('open-ended'), createdAt: at, updatedAt: at, provenance: [userEvidence('policy-supersede')] } },
    { contractVersion: '1.0.0', commandId: 'pricing-undo-public', kind: 'undo', policyId: 'policy-public', expectedHeadRevision: 2, reason: 'revert correction', occurredAt: at },
    { contractVersion: '1.0.0', commandId: 'pricing-delete-contract', kind: 'delete', policyId: 'policy-contract', expectedHeadRevision: 1, reason: 'retire contract', occurredAt: at }
  ],
  pricingPolicyResponses: [
    { contractVersion: '1.0.0', commandId: 'pricing-create-public', status: 'applied', appendedRevisionId: available('policy-public-r1'), headRevision: available(1), errorCode: unavailable('command applied') },
    { contractVersion: '1.0.0', commandId: 'pricing-supersede-public', status: 'applied', appendedRevisionId: available('policy-public-r2'), headRevision: available(2), errorCode: unavailable('command applied') },
    { contractVersion: '1.0.0', commandId: 'pricing-undo-public', status: 'applied', appendedRevisionId: available('policy-public-r3'), headRevision: available(3), errorCode: unavailable('command applied') },
    { contractVersion: '1.0.0', commandId: 'pricing-delete-contract', status: 'applied', appendedRevisionId: available('policy-contract-r2'), headRevision: available(2), errorCode: unavailable('command applied') }
  ],
  modelAliases: [
    { schemaVersion: 1, aliasId: 'alias-exact', providerId: 'swob/test', rawModelId: 'model-raw', canonicalModelId: 'model-canonical', effectiveFrom: at, effectiveUntil: unavailable('open-ended'), aliasVersion: '1', provenance: [evidence('B', 'alias-exact')] },
    { schemaVersion: 1, aliasId: 'alias-conflict-a', providerId: 'swob/test', rawModelId: 'model-conflict', canonicalModelId: 'model-a', effectiveFrom: at, effectiveUntil: unavailable('open-ended'), aliasVersion: '1', provenance: [evidence('B', 'alias-conflict-a')] },
    { schemaVersion: 1, aliasId: 'alias-conflict-b', providerId: 'swob/test', rawModelId: 'model-conflict', canonicalModelId: 'model-b', effectiveFrom: at, effectiveUntil: unavailable('open-ended'), aliasVersion: '2', provenance: [evidence('B', 'alias-conflict-b')] }
  ],
  valuations: [
    { schemaVersion: 1, usageFactId: 'usage-fact-1', rawModelId: 'model-raw', officialPriceSnapshot: available({ snapshotId: 'official-1', revision: '2026-08-10', digest: shaA }), publicEquivalent: available({ amount: 1, currency: 'USD', source: 'user-policy', policyRevisionId: available('policy-public-r1') }), actualContract: available({ amount: 0.5, currency: 'USD', policyRevisionId: 'policy-contract-r1' }), resolution: 'exact', evidence: [evidence('B', 'valuation-exact')] },
    { schemaVersion: 1, usageFactId: 'usage-fact-conflict', rawModelId: 'model-conflict', officialPriceSnapshot: unavailable('alias ambiguous'), publicEquivalent: unavailable('alias ambiguous'), actualContract: unavailable('alias ambiguous'), resolution: 'unavailable', evidence: [evidence('B', 'valuation-conflict')] }
  ],
  derivedRecords: [
    { id: 'derived-original', schemaVersion: 1, value: { state: 'generated' }, derivation: 'derived', evidence: [evidence('C', 'derived-original')], algorithmId: 'truth-kernel/fixture', algorithmVersion: '1.0.0', createdAt: at },
    { id: 'derived-correction', schemaVersion: 1, value: { state: 'corrected' }, derivation: 'user-corrected', evidence: [userEvidence('derived-correction')], createdAt: at, supersedes: 'derived-original' }
  ],
  trajectoryProvider: {
    schemaVersion: 1,
    providerId: 'truth-kernel/mock-trajectory-v1',
    contractVersion: '1.0.0',
    interactions: [{
      schemaVersion: 1,
      interactionId: 'interaction-1',
      logicalSessionId: 'session-main',
      ordinal: 0,
      modelCalls: [{ providerId: 'swob/test', observedModelId: 'model-raw', canonicalModelId: available('model-canonical'), mode: available('default'), evidence: [evidence('B', 'trajectory-model')] }],
      toolCount: 1,
      timing: { wall: { milliseconds: available(100), measurement: 'exact', evidence: [evidence('B', 'trajectory-wall')] }, agentActive: { milliseconds: available(80), measurement: 'derived', evidence: [evidence('C', 'trajectory-active')] }, wait: { milliseconds: available(20), measurement: 'derived', evidence: [evidence('C', 'trajectory-wait')] } },
      usageAttributions: [{ schemaVersion: 1, usageAttributionId: 'usage-exact', interactionId: 'interaction-1', usageFactIds: ['usage-fact-1'], billingFactIds: ['billing-fact-1'], quantityKind: 'input-token', quantityUnit: 'token', quantity: available(100), measurement: 'exact', residual: available(0), sourceGranularity: 'per-call', lineageScope: 'lineage-unique', evidence: [evidence('B', 'trajectory-usage')] }],
      branchUsageRollups: [{ schemaVersion: 1, rollupId: 'trajectory-rollup', logicalSessionId: 'session-main', quantityKind: 'input-token', quantityUnit: 'token', bases: [{ basis: 'physical-session-usage', total: available(150), residual: available(50), billingFactIds: ['billing-session-total'] }, { basis: 'current-branch-incremental-usage', total: available(100), residual: available(0), billingFactIds: ['billing-fact-1'] }, { basis: 'lineage-unique-usage', total: available(100), residual: available(0), billingFactIds: ['billing-fact-1'] }], sourceTotal: available(150), attributedTotal: available(100), anomalyRefs: [], evidence: [evidence('B', 'trajectory-rollup')] }],
      valuations: [{ schemaVersion: 1, usageFactId: 'usage-fact-1', rawModelId: 'model-raw', officialPriceSnapshot: available({ snapshotId: 'official-1', revision: '2026-08-10', digest: shaA }), publicEquivalent: available({ amount: 1, currency: 'USD', source: 'user-policy', policyRevisionId: available('policy-public-r1') }), actualContract: available({ amount: 0.5, currency: 'USD', policyRevisionId: 'policy-contract-r1' }), resolution: 'exact', evidence: [evidence('B', 'trajectory-valuation')] }],
      fileActions: [{ schemaVersion: 1, fileActionId: 'trajectory-file-read', interactionId: 'interaction-1', sourceEventId: 'provider-event-1', operation: 'read', result: 'succeeded', target: fileA, beforeRevision: available(revision('trajectory-revision-a1', fileA.fileEntityId, shaA)), afterRevision: available(revision('trajectory-revision-a1', fileA.fileEntityId, shaA)), renameChain: [], producedArtifactVersions: [], derivation: 'observed', evidence: [evidence('B', 'trajectory-file-read')] }],
      toolEventIds: ['provider-event-1', 'provider-event-2', 'provider-event-3'],
      contextPhase: 'summarized',
      lineagePhase: 'independent',
      forkBoundary: available({ schemaVersion: 1, forkBoundaryId: 'fork-1', parentLogicalSessionId: available('session-parent'), childLogicalSessionId: 'session-main', forkEventId: available('provider-event-3'), firstIndependentEventId: available('provider-event-4'), sharedAncestorInteractionId: available('interaction-parent-0'), firstIndependentInteractionId: available('interaction-1'), sharedEventKeys: ['shared-0'], detection: 'shared-event-key', evidence: [evidence('B', 'trajectory-fork')] })
    }]
  }
} satisfies TruthKernelGoldenFixture
