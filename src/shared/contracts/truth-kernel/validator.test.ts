import { readFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import {
  TRUTH_KERNEL_GOLDEN_FIXTURE,
  assertTruthKernelGoldenFixture,
  truthKernelCanonicalJson,
  truthKernelCanonicalSha256,
  truthKernelRoundTrip,
  validateTruthKernelGoldenFixture
} from './index'
import type { TruthKernelGoldenFixture } from './types'

function cloneFixture(): TruthKernelGoldenFixture {
  return structuredClone(TRUTH_KERNEL_GOLDEN_FIXTURE)
}

describe('Truth Kernel v1 contract', () => {
  it('validates every frozen golden scenario', () => {
    const result = validateTruthKernelGoldenFixture(TRUTH_KERNEL_GOLDEN_FIXTURE)
    expect(result).toEqual({ ok: true, value: TRUTH_KERNEL_GOLDEN_FIXTURE, issues: [] })
    expect(TRUTH_KERNEL_GOLDEN_FIXTURE.scenarioIds).toHaveLength(14)
  })

  it('ships a standalone JSON Schema that accepts the typed golden fixture', () => {
    const schema = JSON.parse(readFileSync(new URL('./truth-kernel-fixture.schema.json', import.meta.url), 'utf8'))
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema)
    expect(validate(TRUTH_KERNEL_GOLDEN_FIXTURE), JSON.stringify(validate.errors)).toBe(true)
  })

  it('round-trips unknown future events without losing canonical payload fields', () => {
    const unknown = TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents.find(
      (entry) => entry.providerEvent.kind === 'unknown'
    )
    expect(unknown).toBeDefined()
    const roundTripped = truthKernelRoundTrip(unknown)
    expect(truthKernelCanonicalJson(roundTripped)).toBe(truthKernelCanonicalJson(unknown))
    expect(truthKernelCanonicalSha256(roundTripped)).toBe(truthKernelCanonicalSha256(unknown))
    expect(roundTripped?.providerEvent.payload).toEqual({
      rawType: 'future.quantum-event',
      rawPayload: { bytes: [0, 1, 255], nested: { preserved: true } }
    })
  })

  it('uses locale-independent key order and rejects values outside the frozen JSON domain', () => {
    expect(truthKernelCanonicalJson({ '\uE000': 2, '😀': 1 })).toBe('{"😀":1,"":2}')
    expect(() => truthKernelCanonicalJson({ invalid: Number.NaN })).toThrow('non-finite-number')
    expect(() => truthKernelCanonicalJson({ invalid: undefined })).toThrow('unsupported-undefined')
  })

  it('rejects timeline projections that detach from the carried Provider v2 event', () => {
    const fixture = cloneFixture()
    fixture.timelineEvents[0].sourceEventId = 'fabricated-event-id'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'timeline-provider-event-mismatch'
    }))
  })

  it('does not permit compact absence to become an exact dropped claim', () => {
    const fixture = cloneFixture()
    fixture.contextTransitions[0].deltas[1].disposition = 'dropped'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'dropped-without-direct-evidence'
    }))
  })

  it('requires binary-safe attachment references and forbids attachment bytes as context text', () => {
    const fixture = cloneFixture()
    const attachment = fixture.contextArtifacts.find((entry) => entry.kind === 'attached-file')!
    attachment.attachmentRef = { status: 'unavailable', reason: 'missing reference' }
    attachment.content = { status: 'available', value: 'raw bytes' }
    expect(validateTruthKernelGoldenFixture(fixture).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'attachment-reference-required' })
    ]))
  })

  it('keeps wall, active and wait measurement state explicit', () => {
    const fixture = cloneFixture()
    fixture.interactions[0].timing.agentActive.measurement = 'exact'
    fixture.interactions[0].timing.agentActive.milliseconds = { status: 'unknown', reason: 'not measured' }
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'duration-value-missing'
    }))
  })

  it('keeps tool-name visibility separate from loaded MCP schema evidence', () => {
    const fixture = cloneFixture()
    const exposure = fixture.mcpExposures.find((entry) => entry.exposureId === 'mcp-name-deferred')!
    exposure.schemaState = 'loaded'
    exposure.schemaEvidence = []
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'loaded-schema-without-direct-evidence'
    }))
  })

  it('requires unknown and unavailable fields to carry a reason and never a hidden value', () => {
    const fixture = cloneFixture() as unknown as Record<string, unknown>
    const roots = fixture.packageLocations as Array<Record<string, unknown>>
    roots[0].rootId = { status: 'unknown', value: 'root-a' }
    const result = validateTruthKernelGoldenFixture(fixture)
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'availability-reason-missing' }),
      expect.objectContaining({ code: 'availability-value-forbidden' })
    ]))
  })

  it('fails closed when one logical session has multiple writable candidates', () => {
    const fixture = cloneFixture()
    fixture.writableBindings[0].automaticWriteAllowed = true
    expect(validateTruthKernelGoldenFixture(fixture).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'writable-binding-not-unique' }),
      expect.objectContaining({ code: 'writable-binding-must-fail-closed' })
    ]))
  })

  it('rejects cross-root path collisions when they reuse one file identity', () => {
    const fixture = cloneFixture()
    fixture.fileActions[3].target.fileEntityId = fixture.fileActions[0].target.fileEntityId
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'file-identity-scope-conflict'
    }))
  })

  it('requires consumed artifacts to name an immutable version digest', () => {
    const fixture = cloneFixture()
    fixture.artifactVersions[0].contentDigest = { status: 'unknown', reason: 'hash was not observed' }
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'artifact-consumption-version-unresolved'
    }))
  })

  it('requires execute-produced actions to name immutable outputs', () => {
    const fixture = cloneFixture()
    fixture.fileActions[0].operation = 'execute-produced'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'execute-produced-artifact-missing'
    }))
  })

  it('enforces branch usage conservation across the three frozen bases', () => {
    const fixture = cloneFixture()
    fixture.branchUsageRollups[0].attributedTotal = { status: 'available', value: 99 }
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'usage-rollup-conservation-failed'
    }))
  })

  it('does not accept content hash inference as an exact interaction fork boundary', () => {
    const fixture = cloneFixture()
    fixture.forkBoundaries[0].detection = 'content-hash-inference'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'content-hash-fork-cannot-be-exact'
    }))
  })

  it('preserves last-known package locations while a root is offline', () => {
    const fixture = cloneFixture()
    fixture.packageLocations[2].state = 'missing'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'offline-root-location-must-remain-last-known'
    }))
  })

  it('binds archive coverage to scope and deduplicated package identities', () => {
    const fixture = cloneFixture()
    fixture.archiveCoverage.packageIds.push('package-1')
    fixture.archiveCoverage.scope.projectIds.push('project-1')
    expect(validateTruthKernelGoldenFixture(fixture).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'archive-coverage-package-double-count' }),
      expect.objectContaining({ code: 'archive-coverage-scope-mismatch' })
    ]))
  })

  it('requires orchestration edge endpoints and aggregate conservation', () => {
    const fixture = cloneFixture()
    fixture.orchestrationEntityLinks[0].toEntityId = 'missing-entity'
    fixture.usageAggregates[0].residual = { status: 'available', value: 49 }
    expect(validateTruthKernelGoldenFixture(fixture).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'orchestration-edge-endpoint-missing' }),
      expect.objectContaining({ code: 'aggregate-conservation-failed' })
    ]))
  })

  it('never activates external evidence without explicit user confirmation', () => {
    const fixture = cloneFixture()
    fixture.externalEvidenceAttachments[0].state = 'active'
    fixture.externalEvidenceAttachments[0].mappedLogicalSessionId = { status: 'available', value: 'session-main' }
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'active-attachment-not-user-confirmed'
    }))
  })

  it('requires verified assurance to cite a valid attachment-scoped verification', () => {
    for (const status of ['invalid', 'not-requested'] as const) {
      const fixture = cloneFixture()
      fixture.verificationResults[0].status = status
      if (status === 'invalid') {
        fixture.verificationResults[0].failures = [{
          code: 'event-digest-mismatch',
          artifactPath: { status: 'available', value: 'events/provider-event-0.json' },
          message: 'fixture mismatch',
          expectedDigest: { status: 'available', value: 'a'.repeat(64) },
          actualDigest: { status: 'available', value: 'b'.repeat(64) }
        }]
      }
      expect(validateTruthKernelGoldenFixture(fixture).issues, status).toContainEqual(expect.objectContaining({
        code: 'assurance-valid-verification-required'
      }))
    }
  })

  it('requires observed and claimed assurance to cite attachment evidence while unknown may remain empty', () => {
    for (const assessment of ['observed', 'claimed'] as const) {
      const fixture = cloneFixture()
      const dimension = fixture.externalEvidenceAttachments[1].assurance[0]
      dimension.assessment = assessment
      dimension.evidenceRefs = []
      expect(validateTruthKernelGoldenFixture(fixture).issues, assessment).toContainEqual(expect.objectContaining({
        code: 'assurance-evidence-required'
      }))
    }
    const fixture = cloneFixture()
    expect(fixture.externalEvidenceAttachments[0].assurance[0]).toEqual(expect.objectContaining({
      assessment: 'unknown', evidenceRefs: []
    }))
    expect(validateTruthKernelGoldenFixture(fixture).ok).toBe(true)
  })

  it('detects event mutation, deletion, reorder and parser substitution in rolling chains', () => {
    const mutations: Array<[string, (fixture: TruthKernelGoldenFixture) => void]> = [
      ['chain-event-digest-mismatch', (fixture) => { (fixture.timelineEvents[0].providerEvent.payload as { text: string }).text = 'tampered' }],
      ['chain-event-count-mismatch', (fixture) => { fixture.canonicalEventChains[0].entries.pop() }],
      ['chain-event-reordered', (fixture) => { fixture.canonicalEventChains[0].entries.reverse(); fixture.canonicalEventChains[0].entries.forEach((entry, index) => { entry.sequence = index }) }],
      ['chain-parser-receipt-mismatch', (fixture) => { fixture.canonicalEventChains[0].parserVersion = '2.0.0' }],
      ['chain-serialization-version-unsupported', (fixture) => { (fixture.canonicalEventChains[0] as unknown as { serializationVersion: string }).serializationVersion = 'unknown/2' }]
    ]
    for (const [code, mutate] of mutations) {
      const fixture = cloneFixture()
      mutate(fixture)
      expect(validateTruthKernelGoldenFixture(fixture).issues, code).toContainEqual(expect.objectContaining({ code }))
    }
  })

  it('binds safe path-sorted bundle inventory with a self-excluding manifest digest', () => {
    const fixture = cloneFixture()
    fixture.verifyBundles[0].artifacts[0].relativePath = '../escape'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bundle-artifact-path-unsafe' }),
      expect.objectContaining({ code: 'bundle-manifest-digest-mismatch' })
    ]))
  })

  it('rejects Windows-drive, dot-segment and empty-segment bundle paths', () => {
    for (const relativePath of ['C:/escape', 'events/./event.json', 'events//event.json']) {
      const fixture = cloneFixture()
      fixture.verifyBundles[0].artifacts[0].relativePath = relativePath
      expect(validateTruthKernelGoldenFixture(fixture).issues, relativePath).toContainEqual(expect.objectContaining({
        code: 'bundle-artifact-path-unsafe'
      }))
    }
  })

  it('requires the sole frozen bundle digest algorithm at runtime', () => {
    const fixture = cloneFixture()
    ;(fixture.verifyBundles[0] as unknown as { digestAlgorithm: string }).digestAlgorithm = 'sha256-other'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'bundle-digest-algorithm-unsupported'
    }))
  })

  it('hashes exported receipt and chain JSON bytes instead of source digest or chain head', () => {
    const fixture = cloneFixture()
    const receiptArtifact = fixture.verifyBundles[0].artifacts.find((artifact) => artifact.kind === 'source-receipt')!
    const chainArtifact = fixture.verifyBundles[0].artifacts.find((artifact) => artifact.kind === 'event-chain')!
    receiptArtifact.sha256 = fixture.sourceIngestReceipts[0].sourceSha256
    chainArtifact.sha256 = fixture.canonicalEventChains[0].headHash.status === 'available'
      ? fixture.canonicalEventChains[0].headHash.value
      : '0'.repeat(64)
    expect(validateTruthKernelGoldenFixture(fixture).issues.filter(
      (entry) => entry.code === 'bundle-artifact-raw-bytes-mismatch'
    )).toHaveLength(2)
  })

  it('rejects truncated bundle inventories even when referenced IDs remain', () => {
    const fixture = cloneFixture()
    fixture.verifyBundles[0].artifacts = fixture.verifyBundles[0].artifacts.filter(
      (artifact) => artifact.objectId !== 'provider-event-1'
    )
    expect(validateTruthKernelGoldenFixture(fixture).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'bundle-event-artifact-missing' }),
      expect.objectContaining({ code: 'bundle-manifest-digest-mismatch' })
    ]))
  })

  it('rejects translation descriptors with missing locale and unused ownership keys', () => {
    const fixture = cloneFixture()
    fixture.translationDescriptors[0].locales.en = {}
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'translation-key-set-mismatch'
    }))
  })

  it('requires alias conflicts to resolve as unavailable instead of fuzzy pricing', () => {
    const fixture = cloneFixture()
    fixture.valuations[1].resolution = 'exact'
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'alias-conflict-must-fail-closed'
    }))
  })

  it('asserts the fixture and returns the same typed value', () => {
    expect(assertTruthKernelGoldenFixture(TRUTH_KERNEL_GOLDEN_FIXTURE)).toBe(TRUTH_KERNEL_GOLDEN_FIXTURE)
  })

  it('fails closed instead of throwing on structurally incomplete versioned records', () => {
    const fixture = cloneFixture() as unknown as Record<string, unknown>
    fixture.timelineEvents = [{ schemaVersion: 1 }]
    expect(() => validateTruthKernelGoldenFixture(fixture)).not.toThrow()
    expect(validateTruthKernelGoldenFixture(fixture).issues).toContainEqual(expect.objectContaining({
      code: 'required-field-missing'
    }))
  })
})
