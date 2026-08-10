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
    expect(TRUTH_KERNEL_GOLDEN_FIXTURE.scenarioIds).toHaveLength(11)
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
