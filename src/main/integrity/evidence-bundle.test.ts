import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { TRUTH_KERNEL_SERIALIZATION_VERSION, truthKernelBundleManifestDigest, truthKernelCanonicalUtf8Bytes, truthKernelCanonicalSha256, truthKernelRollingChainHash, type CanonicalEventChain, type SourceIngestReceipt } from '../../shared/contracts/truth-kernel'
import { createEvidenceBundle, verifyEvidenceBundle, type EvidenceBundle } from './evidence-bundle'

const encoder = new TextEncoder()
const receipt: SourceIngestReceipt = { schemaVersion: 1, receiptId: 'receipt-1', sourceId: 'claude-tap', sourceLocatorHash: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), sourceSizeBytes: 10, sourceMtime: { status: 'unknown', reason: 'unavailable' }, parserId: 'claude-tap', parserVersion: '1', capturedAt: '2026-08-11T00:00:00.000Z', captureMethod: 'external-import', assuranceLevel: 'observed' }
const values = [{ eventId: 'e1', sequence: 1 }, { eventId: 'e2', sequence: 2 }]
const eventBytes = values.map((value) => truthKernelCanonicalUtf8Bytes(value))
const digest0 = truthKernelCanonicalSha256(values[0])
const hash0 = truthKernelRollingChainHash({ sourceIngestReceiptId: receipt.receiptId, parserId: receipt.parserId, parserVersion: receipt.parserVersion, serializationVersion: TRUTH_KERNEL_SERIALIZATION_VERSION, sequence: 0, previousChainHash: null, eventDigest: digest0 })
const digest1 = truthKernelCanonicalSha256(values[1])
const hash1 = truthKernelRollingChainHash({ sourceIngestReceiptId: receipt.receiptId, parserId: receipt.parserId, parserVersion: receipt.parserVersion, serializationVersion: TRUTH_KERNEL_SERIALIZATION_VERSION, sequence: 1, previousChainHash: hash0, eventDigest: digest1 })
const chain: CanonicalEventChain = { schemaVersion: 1, chainId: 'chain-1', sourceIngestReceiptId: receipt.receiptId, parserId: receipt.parserId, parserVersion: receipt.parserVersion, serializationVersion: TRUTH_KERNEL_SERIALIZATION_VERSION, expectedEventCount: 2, entries: [
  { eventId: 'e1', sequence: 0, eventDigest: digest0, previousChainHash: { status: 'unknown', reason: 'genesis' }, chainHash: hash0 },
  { eventId: 'e2', sequence: 1, eventDigest: digest1, previousChainHash: { status: 'available', value: hash0 }, chainHash: hash1 }
], headHash: { status: 'available', value: hash1 } }

function validBundle(): EvidenceBundle { return createEvidenceBundle({ bundleId: 'bundle-1', generatedAt: '2026-08-11T00:00:00.000Z', receipts: [receipt], chains: [chain], events: [{ eventId: 'e1', bytes: eventBytes[0] }, { eventId: 'e2', bytes: eventBytes[1] }] }) }
function rewriteManifest(bundle: EvidenceBundle): void { bundle.manifest.bundleDigest = truthKernelBundleManifestDigest(bundle.manifest); bundle.files.set('manifest.json', truthKernelCanonicalUtf8Bytes(bundle.manifest)) }
function rewriteArtifact(bundle: EvidenceBundle, path: string, value: unknown): void { const bytes = truthKernelCanonicalUtf8Bytes(value); bundle.files.set(path, bytes); const artifact = bundle.manifest.artifacts.find((item) => item.relativePath === path)!; artifact.sha256 = truthKernelCanonicalSha256(value); artifact.sizeBytes = bytes.byteLength; rewriteManifest(bundle) }

describe('offline evidence bundle', () => {
  it('passes an intact bundle and detects one-byte source modification', () => {
    const bundle = validBundle()
    expect(verifyEvidenceBundle(bundle, '2026-08-11T00:00:01.000Z').status).toBe('valid')
    rewriteArtifact(bundle, 'events/e1.json', { eventId: 'e1', sequence: 9 })
    expect(verifyEvidenceBundle(bundle, '2026-08-11T00:00:02.000Z').failures.some((item) => item.code === 'event-digest-mismatch')).toBe(true)
  })

  it('detects deletion and reordering even when artifact and manifest hashes are rewritten', () => {
    const deleted = validBundle()
    const changed = structuredClone(chain); changed.entries.pop()
    rewriteArtifact(deleted, 'chains/chain-1.json', changed)
    expect(verifyEvidenceBundle(deleted, '2026-08-11T00:00:02.000Z').failures.some((item) => item.code === 'event-missing')).toBe(true)
    const reordered = validBundle()
    const reorderedChain = structuredClone(chain); reorderedChain.entries.reverse()
    rewriteArtifact(reordered, 'chains/chain-1.json', reorderedChain)
    expect(verifyEvidenceBundle(reordered, '2026-08-11T00:00:02.000Z').failures.some((item) => item.code === 'event-reordered')).toBe(true)
  })

  it('fails closed on parser and serialization replacement', () => {
    const parser = validBundle(); const parserChain = structuredClone(chain); parserChain.parserVersion = '2'; rewriteArtifact(parser, 'chains/chain-1.json', parserChain)
    expect(verifyEvidenceBundle(parser, '2026-08-11T00:00:02.000Z').failures.some((item) => item.code === 'parser-version-mismatch')).toBe(true)
    const serialization = validBundle(); serialization.manifest.serializationVersion = 'changed' as typeof TRUTH_KERNEL_SERIALIZATION_VERSION; rewriteManifest(serialization)
    expect(verifyEvidenceBundle(serialization, '2026-08-11T00:00:02.000Z').failures.some((item) => item.code === 'serialization-version-unsupported')).toBe(true)
  })

  it('exports an independently executable no-cloud verifier', async () => {
    const bundle = validBundle()
    const root = await mkdtemp(join(tmpdir(), 'swob-verify-'))
    for (const [relativePath, bytes] of bundle.files) { const target = join(root, relativePath); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes) }
    const verifierPath = join(root, 'verify/swob-verify.mjs')
    const { stdout } = await promisify(execFile)(process.execPath, [verifierPath, root])
    expect(JSON.parse(stdout).status).toBe('valid')
    await writeFile(join(root, 'events/e1.json'), encoder.encode('{"eventId":"e1","sequence":9}'))
    await expect(promisify(execFile)(process.execPath, [verifierPath, root])).rejects.toMatchObject({ code: 1 })
  })
})
