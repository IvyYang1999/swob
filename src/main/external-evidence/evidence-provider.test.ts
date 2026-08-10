import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverNonoAuditSessions, parseClaudeTapCapture, parseNonoAuditSession, previewNonoOfficialVerifier, readExternalEvidenceFile } from './adapters'
import { CLAUDE_TAP_EVIDENCE_PROVIDER, ExternalEvidenceAttachmentRepository, importJsonEvidence, type SessionTruthSnapshot } from './evidence-provider'

const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'claude-tap.capture', schema_version: '1', system_prompt: 'private', tools: [], trace: [{ private: 'body' }] }))
const imported = () => importJsonEvidence(CLAUDE_TAP_EVIDENCE_PROVIDER, bytes, 'locator-hash', null, '2026-08-11T00:00:00.000Z', 'claude-tap-parser/1')
const request = () => ({ logicalAttachmentId: 'attachment-1', revisionId: 'revision-1', sourceVersion: '1', schemaId: 'claude-tap.capture', mappedLogicalSessionId: 'session-1', privacyState: 'private-local' as const, contentRetention: 'reference-only' as const, attachedAt: '2026-08-11T00:00:00.000Z', evidence: [{ evidenceId: 'e1', sourceId: 'claude-tap', sourceKind: 'runtime-capture' as const, capturedAt: '2026-08-11T00:00:00.000Z', grade: 'B' as const, claim: 'provider-confirmed' as const }], assurance: [{ dimension: 'attachment-identity' as const, assessment: 'observed' as const, evidenceRefs: ['e1'], verificationResultIds: [], canProve: ['selected'], cannotProve: ['causality'] }] })

describe('external evidence adapters', () => {
  it('validates versions and returns privacy-minimized summaries', () => {
    const ctap = parseClaudeTapCapture(JSON.parse(new TextDecoder().decode(bytes)))
    expect(ctap).toEqual(expect.objectContaining({ sourceVersion: '1', hasSystemPrompt: true, traceEventCount: 1 }))
    expect(JSON.stringify(ctap)).not.toContain('private')
    expect(() => parseClaudeTapCapture({ schema: 'claude-tap.capture', schema_version: '2' })).toThrow('unsupported-source-version')
    expect(() => importJsonEvidence(CLAUDE_TAP_EVIDENCE_PROVIDER, bytes, 'locator-hash', null, '2026-08-11T00:00:00.000Z', 'caller-chosen/9')).toThrow('unsupported-parser-version')
    const nono = parseNonoAuditSession({ schema: 'nono.audit-session', schema_version: '1', session_id: 'n1', dimensions: { platform: {} } }, '{"schema":"nono.audit-event","schema_version":"1","session_id":"n1"}')
    expect(nono.dimensions).toMatchObject({ platform: 'observed', network: 'unknown' })
    expect(() => parseNonoAuditSession({ schema: 'nono.audit-session', schema_version: '1', session_id: 'n1', dimensions: {} }, '{')).toThrow('nono-ndjson-truncated:1')
    expect(previewNonoOfficialVerifier('/audit').requested).toBe(false)
  })

  it('discovers deterministic nono pairs and rejects symlink sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swob-t211g-'))
    await writeFile(join(root, 'a.session.json'), '{}')
    await writeFile(join(root, 'a.events.ndjson'), '')
    expect(await discoverNonoAuditSessions(root)).toHaveLength(1)
    const outside = await mkdtemp(join(tmpdir(), 'swob-t211g-outside-'))
    await writeFile(join(outside, 'secret'), 'secret')
    await symlink(join(outside, 'secret'), join(root, 'linked'))
    await expect(readExternalEvidenceFile(root, 'linked', 1024)).rejects.toThrow('unsafe-source-file')
    await mkdir(join(root, 'nested'))
    await expect(readExternalEvidenceFile(root, '../outside', 1024)).rejects.toThrow('unsafe-source-path')
  })
})

describe('manual attachment lifecycle', () => {
  it('rejects cross-id duplicates and incorrect/missing sessions', () => {
    const repository = new ExternalEvidenceAttachmentRepository({ resolveSession: (id) => ({ status: id === 'session-1' ? 'active' : 'missing' }), readTruth: () => ({ transcriptHash: 'h', turnCount: 2, usageTotalTokens: 3 }) })
    repository.attach(imported(), request())
    expect(() => repository.attach(imported(), { ...request(), logicalAttachmentId: 'different', revisionId: 'r2' })).toThrow('duplicate-attachment')
    const fresh = new ExternalEvidenceAttachmentRepository({ resolveSession: () => ({ status: 'missing' }), readTruth: () => ({ transcriptHash: 'h', turnCount: 2, usageTotalTokens: 3 }) })
    expect(() => fresh.attach(imported(), { ...request(), mappedLogicalSessionId: 'wrong' })).toThrow('session-not-found')
  })

  it('keeps revision history across merged targets without changing canonical truth', () => {
    const truth: SessionTruthSnapshot = { transcriptHash: 'transcript', turnCount: 7, usageTotalTokens: 42 }
    const repository = new ExternalEvidenceAttachmentRepository({ resolveSession: (id) => id === 'old' ? { status: 'merged', canonicalLogicalSessionId: 'new' } : { status: 'active' }, readTruth: () => ({ ...truth }) })
    repository.attach(imported(), request())
    const revised = repository.reviseTarget('attachment-1', 'revision-2', 'old', '2026-08-11T00:01:00.000Z')
    expect(revised).toMatchObject({ revision: 2, state: 'target-merged', mappedLogicalSessionId: { status: 'available', value: 'new' } })
    expect(repository.history('attachment-1').map((item) => item.revisionId)).toEqual(['revision-1', 'revision-2'])
    expect(truth).toEqual({ transcriptHash: 'transcript', turnCount: 7, usageTotalTokens: 42 })
    const unavailable = repository.markTargetUnavailable('attachment-1', 'revision-3', '2026-08-11T00:02:00.000Z')
    expect(unavailable.state).toBe('target-unavailable')
    expect(unavailable.sourceDeletionAuthorized).toBe(false)
  })
})
