import { createHash } from 'node:crypto'
import type {
  AssuranceDimension,
  ExternalEvidenceAttachment,
  ExternalEvidenceProvider,
  SourceIngestReceipt,
  VerificationResult
} from '../../shared/contracts/truth-kernel'
import { parseClaudeTapCapture, parseNonoAuditSession } from './adapters'

export const EXTERNAL_EVIDENCE_MAX_BYTES = 16 * 1024 * 1024

export interface ImportedEvidence {
  provider: ExternalEvidenceProvider
  receipt: SourceIngestReceipt
  rawBytes: Uint8Array
  parsed: unknown
  schemaId: string
  sourceVersion: string
  privacySummary: Readonly<Record<string, boolean | number | string>>
}

export interface ManualAttachmentRequest {
  logicalAttachmentId: string
  revisionId: string
  sourceVersion: string
  schemaId: string
  mappedLogicalSessionId: string
  privacyState: ExternalEvidenceAttachment['privacyState']
  contentRetention: ExternalEvidenceAttachment['contentRetention']
  assurance: AssuranceDimension[]
  evidence: ExternalEvidenceAttachment['evidence']
  attachedAt: string
}

export interface SessionTruthSnapshot {
  transcriptHash: string
  turnCount: number
  usageTotalTokens: number
}

export interface SessionIdentityResolution {
  status: 'active' | 'merged' | 'missing'
  canonicalLogicalSessionId?: string
}

export interface AttachmentRepositoryOptions {
  resolveSession: (logicalSessionId: string) => SessionIdentityResolution
  readTruth: (logicalSessionId: string) => SessionTruthSnapshot
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Parses an explicitly user-selected evidence file.  This does not discover a
 * session or infer an attachment target: the caller must supply that choice
 * separately through ManualAttachmentRequest.
 */
export function importJsonEvidence(
  provider: ExternalEvidenceProvider,
  bytes: Uint8Array,
  locatorHash: string,
  mtime: string | null,
  capturedAt: string,
  parserVersion: string
): ImportedEvidence {
  if (bytes.byteLength > EXTERNAL_EVIDENCE_MAX_BYTES) throw new Error('external-evidence:size-limit-exceeded')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('external-evidence:invalid-json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('external-evidence:invalid-root')
  }
  let schemaId: string
  let sourceVersion: string
  let privacySummary: Readonly<Record<string, boolean | number | string>>
  const expectedParserVersion = provider.providerId === 'claude-tap' ? 'claude-tap-parser/1' : provider.providerId === 'nono' ? 'nono-parser/1' : null
  if (!expectedParserVersion || parserVersion !== expectedParserVersion) throw new Error('external-evidence:unsupported-parser-version')
  if (provider.providerId === 'claude-tap') {
    const summary = parseClaudeTapCapture(parsed)
    schemaId = summary.schemaId
    sourceVersion = summary.sourceVersion
    privacySummary = {
      hasSystemPrompt: summary.hasSystemPrompt, hasTools: summary.hasTools, hasRequestDiff: summary.hasRequestDiff,
      hasTokenEvidence: summary.hasTokenEvidence, hasTrace: summary.hasTrace, traceEventCount: summary.traceEventCount
    }
  } else {
    const summary = parseNonoAuditSession(parsed, '')
    schemaId = summary.schemaId
    sourceVersion = summary.sourceVersion
    privacySummary = { sessionMetadataOnly: true, eventCount: summary.eventCount }
  }
  const digest = sha256(bytes)
  return {
    provider,
    rawBytes: bytes,
    parsed,
    schemaId,
    sourceVersion,
    privacySummary,
    receipt: {
      schemaVersion: 1,
      receiptId: `receipt:${digest}`,
      sourceId: provider.providerId,
      sourceLocatorHash: locatorHash,
      sourceSha256: digest,
      sourceSizeBytes: bytes.byteLength,
      sourceMtime: mtime ? { status: 'available', value: mtime } : { status: 'unknown', reason: 'mtime-unavailable' },
      parserId: provider.providerId,
      parserVersion,
      capturedAt,
      captureMethod: 'external-import',
      assuranceLevel: 'observed'
    }
  }
}

/** Feature-local append-only repository. Persistence/IPC wiring remains an I-slot concern. */
export class ExternalEvidenceAttachmentRepository {
  private readonly attachments = new Map<string, ExternalEvidenceAttachment[]>()
  private readonly activeDigestOwners = new Map<string, string>()

  constructor(private readonly options: AttachmentRepositoryOptions = {
    resolveSession: (logicalSessionId) => ({ status: logicalSessionId ? 'active' : 'missing' }),
    readTruth: () => ({ transcriptHash: 'not-provided', turnCount: 0, usageTotalTokens: 0 })
  }) {}

  private assertTruthUnchanged(sessionId: string, before: SessionTruthSnapshot): void {
    const after = this.options.readTruth(sessionId)
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('external-evidence:canonical-truth-changed')
  }

  private append(logicalAttachmentId: string, attachment: ExternalEvidenceAttachment): ExternalEvidenceAttachment {
    const revisions = this.attachments.get(logicalAttachmentId) || []
    this.attachments.set(logicalAttachmentId, [...revisions, attachment])
    return attachment
  }

  attach(imported: ImportedEvidence, request: ManualAttachmentRequest): ExternalEvidenceAttachment {
    if (!request.mappedLogicalSessionId) throw new Error('external-evidence:manual-session-selection-required')
    if (request.schemaId !== imported.schemaId || request.sourceVersion !== imported.sourceVersion) throw new Error('external-evidence:attachment-format-mismatch')
    const resolution = this.options.resolveSession(request.mappedLogicalSessionId)
    if (resolution.status !== 'active') throw new Error(resolution.status === 'merged' ? 'external-evidence:session-merged-revision-required' : 'external-evidence:session-not-found')
    const truthBefore = this.options.readTruth(request.mappedLogicalSessionId)
    const revisions = this.attachments.get(request.logicalAttachmentId) || []
    const digestKey = `${imported.provider.providerId}\0${imported.receipt.sourceSha256}`
    if (this.activeDigestOwners.has(digestKey)) {
      throw new Error('external-evidence:duplicate-attachment')
    }
    const previous = revisions.at(-1)
    const attachment: ExternalEvidenceAttachment = {
      schemaVersion: 1,
      logicalAttachmentId: request.logicalAttachmentId,
      revisionId: request.revisionId,
      revision: revisions.length + 1,
      supersedesRevisionId: previous ? { status: 'available', value: previous.revisionId } : { status: 'unknown', reason: 'initial-revision' },
      externalProviderId: imported.provider.providerId,
      sourceDigest: imported.receipt.sourceSha256,
      sourceIngestReceiptId: imported.receipt.receiptId,
      schemaId: request.schemaId,
      sourceVersion: request.sourceVersion,
      mappedLogicalSessionId: { status: 'available', value: request.mappedLogicalSessionId },
      matchMethod: 'user-selected',
      confirmation: 'user-confirmed',
      state: 'active',
      reason: { status: 'unknown', reason: 'no-detachment-reason' },
      privacyState: request.privacyState,
      contentRetention: request.contentRetention,
      sourceDeletionAuthorized: false,
      attachedAt: request.attachedAt,
      evidence: request.evidence,
      assurance: request.assurance
    }
    this.activeDigestOwners.set(digestKey, request.logicalAttachmentId)
    this.assertTruthUnchanged(request.mappedLogicalSessionId, truthBefore)
    return this.append(request.logicalAttachmentId, attachment)
  }

  detach(logicalAttachmentId: string, reason: string): ExternalEvidenceAttachment {
    const revisions = this.attachments.get(logicalAttachmentId)
    const current = revisions?.at(-1)
    if (!current) throw new Error('external-evidence:attachment-not-found')
    const detached = { ...current, revisionId: `${current.revisionId}:detached`, revision: current.revision + 1,
      supersedesRevisionId: { status: 'available' as const, value: current.revisionId }, state: 'detached' as const,
      reason: { status: 'available' as const, value: reason } }
    this.activeDigestOwners.delete(`${current.externalProviderId}\0${current.sourceDigest}`)
    return this.append(logicalAttachmentId, detached)
  }

  reviseTarget(logicalAttachmentId: string, revisionId: string, mappedLogicalSessionId: string, attachedAt: string): ExternalEvidenceAttachment {
    const revisions = this.attachments.get(logicalAttachmentId) || []
    const current = revisions.at(-1)
    if (!current) throw new Error('external-evidence:attachment-not-found')
    const resolution = this.options.resolveSession(mappedLogicalSessionId)
    if (resolution.status === 'missing') throw new Error('external-evidence:session-not-found')
    const target = resolution.status === 'merged' ? resolution.canonicalLogicalSessionId : mappedLogicalSessionId
    if (!target) throw new Error('external-evidence:merged-session-target-missing')
    const truthBefore = this.options.readTruth(target)
    const revised: ExternalEvidenceAttachment = {
      ...current, revisionId, revision: current.revision + 1,
      supersedesRevisionId: { status: 'available', value: current.revisionId },
      mappedLogicalSessionId: { status: 'available', value: target },
      state: resolution.status === 'merged' ? 'target-merged' : 'active',
      reason: { status: 'available', value: resolution.status === 'merged' ? `identity-merged:${mappedLogicalSessionId}` : 'user-revised-target' },
      attachedAt
    }
    this.assertTruthUnchanged(target, truthBefore)
    return this.append(logicalAttachmentId, revised)
  }

  markTargetUnavailable(logicalAttachmentId: string, revisionId: string, attachedAt: string): ExternalEvidenceAttachment {
    const revisions = this.attachments.get(logicalAttachmentId) || []
    const current = revisions.at(-1)
    if (!current) throw new Error('external-evidence:attachment-not-found')
    return this.append(logicalAttachmentId, { ...current, revisionId, revision: current.revision + 1,
      supersedesRevisionId: { status: 'available', value: current.revisionId }, mappedLogicalSessionId: { status: 'unknown', reason: 'target-session-unavailable' },
      state: 'target-unavailable', reason: { status: 'available', value: 'target-session-unavailable' }, attachedAt })
  }

  history(logicalAttachmentId: string): readonly ExternalEvidenceAttachment[] { return this.attachments.get(logicalAttachmentId) || [] }

  explain(logicalAttachmentId: string, verificationResults: VerificationResult[]) {
    const revisions = this.attachments.get(logicalAttachmentId) || []
    const active = revisions.at(-1)
    return {
      logicalAttachmentId,
      dimensions: active?.assurance || [],
      verificationResults: verificationResults.filter((result) => result.target.id === active?.revisionId),
      claimBoundary: 'integrity-after-ingest' as const
    }
  }
}

export const NONO_EVIDENCE_PROVIDER: ExternalEvidenceProvider = {
  schemaVersion: 1,
  providerId: 'nono',
  displayName: 'nono',
  formatVersions: ['audit/session.json', 'audit-events.ndjson'],
  captureKind: 'runtime-trace',
  descriptorVersion: '1.0.0'
}

export const CLAUDE_TAP_EVIDENCE_PROVIDER: ExternalEvidenceProvider = {
  schemaVersion: 1,
  providerId: 'claude-tap',
  displayName: 'claude-tap',
  formatVersions: ['.ctap.json'],
  captureKind: 'runtime-trace',
  descriptorVersion: '1.0.0'
}
