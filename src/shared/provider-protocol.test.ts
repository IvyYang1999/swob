import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import claudeEnvelope from '../../schema/fixtures/claude-provider-envelope.json'
import codexEnvelope from '../../schema/fixtures/codex-provider-envelope.json'
import thirdPartyEnvelope from '../../schema/fixtures/third-party-provider-envelope.json'
import schemaDocument from '../../schema/provider-protocol-v1.schema.json'
import {
  PROVIDER_CAPABILITY_NAMES,
  PROVIDER_PROTOCOL_SCHEMA_ID,
  PROVIDER_PROTOCOL_VERSION,
  type CapabilityDeclaration,
  type ProviderCapabilities,
  type ProviderEnvelope,
  type ProviderManifest
} from './provider-schema.generated'
import {
  ProviderProtocolValidationError,
  assertProviderEnvelope,
  decodeProviderEnvelope,
  helloForProvider,
  providerFingerprint,
  runProviderConformance,
  stableCanonicalRecordId,
  validateProviderEnvelope,
  validateProviderManifest
} from './provider-protocol'

function syntheticManifest(): ProviderManifest {
  const unavailable: CapabilityDeclaration = {
    status: 'unavailable',
    reason: 'Synthetic provider does not implement this capability.',
    evidence: []
  }
  const capabilities = Object.fromEntries(
    PROVIDER_CAPABILITY_NAMES.map((name) => [name, { ...unavailable }])
  ) as ProviderCapabilities
  capabilities.discover = {
    status: 'available',
    reason: null,
    evidence: [{ kind: 'test', locator: 'schema/fixtures/third-party-provider-envelope.json' }]
  }
  capabilities.summary = capabilities.discover
  capabilities.transcript = capabilities.discover
  return {
    schemaVersion: 1,
    providerId: 'example/sqlite-agent',
    displayName: 'Synthetic SQLite Agent',
    implementationVersion: 'fixture-1',
    parserDataVersion: 'fixture-1',
    formatVersions: ['sqlite-fixture-v1'],
    capabilities
  }
}

function queryFrameEnvelope(): ProviderEnvelope {
  return {
    protocolVersion: '1.0',
    messageId: 'query-frame-2',
    kind: 'query-frame',
    payload: {
      schemaVersion: 2,
      projectionId: 'usage/by-source',
      lossy: true,
      status: 'complete',
      provenance: {
        providerId: 'example/sqlite-agent',
        parserDataVersion: 'fixture-1',
        formatVersion: null,
        sourceRecordTypes: ['usage'],
        sourceFingerprint: { algorithm: 'sha256', value: 'synthetic-query-source' }
      },
      rows: [{
        rowId: 'row:1',
        cells: {
          source: { type: 'string', nullable: false, value: 'claude-code' },
          tokens: { type: 'number', nullable: false, value: 42 }
        }
      }],
      errors: [],
      unavailableReason: null
    }
  }
}

function deeplyNestedToolInput(depth: number): unknown {
  const invalid = structuredClone(claudeEnvelope) as any
  const tool = invalid.payload.sessions[0].records.find((record: any) => record.recordType === 'tool-call')
  let value: Record<string, unknown> = {}
  tool.input = value
  for (let index = 0; index < depth; index++) {
    const child: Record<string, unknown> = {}
    value.child = child
    value = child
  }
  return invalid
}

describe('ProviderProtocol v1.1 conformance contract', () => {
  it('compiles Draft 2020 with Ajv strict:true and accepts all three golden fixtures', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true })
    const validate = ajv.compile(schemaDocument)
    for (const fixture of [claudeEnvelope, codexEnvelope, thirdPartyEnvelope]) {
      expect(validate(fixture), JSON.stringify(validate.errors)).toBe(true)
      const roundTrip = JSON.parse(JSON.stringify(fixture))
      expect(validateProviderEnvelope(roundTrip)).toEqual({ ok: true, value: roundTrip, issues: [] })
      expect(assertProviderEnvelope(roundTrip)).toEqual(roundTrip)
    }
  })

  it('fails closed for the 14 independent rejection cases from the audit', () => {
    const futureMinor = { ...claudeEnvelope, protocolVersion: '1.1' }
    const futureMajor = { ...claudeEnvelope, protocolVersion: '2.0' }
    const unknownField = { ...claudeEnvelope, unexpected: true }
    const missingRequired = structuredClone(claudeEnvelope) as any
    delete missingRequired.messageId

    const invalidCapability = syntheticManifest() as any
    invalidCapability.capabilities.search.status = 'stable'

    const partialWithoutError = structuredClone(codexEnvelope) as any
    partialWithoutError.payload.sessions[0].errors = []

    const completePlaceholder = structuredClone(claudeEnvelope) as any
    completePlaceholder.payload.sessions[0].sessionRecordId = null
    completePlaceholder.payload.sessions[0].records = []

    const absoluteStableId = structuredClone(claudeEnvelope) as any
    absoluteStableId.payload.sessions[0].records[0].sourceRef.stableId = '/Users/synthetic/session.jsonl'

    const unavailableUsageWithZeros = structuredClone(claudeEnvelope) as any
    const usage = unavailableUsageWithZeros.payload.sessions[0].records.find((record: any) => record.recordType === 'usage')
    usage.usageProvenance = 'unavailable'
    for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'costUsd']) {
      usage[field] = 0
    }

    const tooManyRows = queryFrameEnvelope() as any
    tooManyRows.payload.rows = Array.from({ length: 100_000 }, (_, index) => ({ rowId: `row:${index}`, cells: {} }))

    const wrongCellType = queryFrameEnvelope() as any
    wrongCellType.payload.rows[0].cells.tokens.value = '42'

    const nonNullableNull = queryFrameEnvelope() as any
    nonNullableNull.payload.rows[0].cells.tokens.value = null

    const cases: Array<[string, () => boolean]> = [
      ['future minor', () => validateProviderEnvelope(futureMinor).ok],
      ['future major', () => validateProviderEnvelope(futureMajor).ok],
      ['unknown field', () => validateProviderEnvelope(unknownField).ok],
      ['missing required field', () => validateProviderEnvelope(missingRequired).ok],
      ['invalid capability', () => validateProviderManifest(invalidCapability).ok],
      ['partial without typed error', () => validateProviderEnvelope(partialWithoutError).ok],
      ['complete empty placeholder', () => validateProviderEnvelope(completePlaceholder).ok],
      ['absolute stable id', () => validateProviderEnvelope(absoluteStableId).ok],
      ['unavailable usage with zeros', () => validateProviderEnvelope(unavailableUsageWithZeros).ok],
      ['128-level JSON', () => validateProviderEnvelope(deeplyNestedToolInput(128)).ok],
      ['2 MiB text', () => decodeProviderEnvelope(JSON.stringify({ ...claudeEnvelope, messageId: 'x'.repeat(2 * 1024 * 1024) })).ok],
      ['100k query rows', () => validateProviderEnvelope(tooManyRows).ok],
      ['query cell type mismatch', () => validateProviderEnvelope(wrongCellType).ok],
      ['nonnullable query cell null', () => validateProviderEnvelope(nonNullableNull).ok]
    ]

    expect(cases.map(([name, validate]) => [name, validate()])).toEqual(
      cases.map(([name]) => [name, false])
    )
  })

  it('returns a typed resource error before JSON decode or recursive schema validation', () => {
    const tooLarge = decodeProviderEnvelope(JSON.stringify({
      protocolVersion: '1.0',
      messageId: 'x'.repeat(2 * 1024 * 1024),
      kind: 'error',
      payload: null
    }))
    expect(tooLarge).toMatchObject({
      ok: false,
      error: { code: 'resource-limit-exceeded' },
      issues: [expect.objectContaining({ keyword: 'resource-limit' })]
    })

    const deep = validateProviderEnvelope(deeplyNestedToolInput(128))
    expect(deep).toMatchObject({ ok: false, error: { code: 'resource-limit-exceeded' } })
    expect(() => assertProviderEnvelope(deeplyNestedToolInput(128))).toThrow(ProviderProtocolValidationError)
  })

  it('uses QueryFrame schema v2 typed cells and verifiable projection states', () => {
    const envelope = queryFrameEnvelope()
    expect(validateProviderEnvelope(envelope).ok).toBe(true)

    const legacy = {
      protocolVersion: '1.0',
      messageId: 'legacy-query-frame',
      kind: 'query-frame',
      payload: {
        schemaVersion: 1,
        projectionId: 'usage/by-source',
        lossy: true,
        sourceRecordTypes: ['usage'],
        fields: [{ name: 'tokens', type: 'number', nullable: false }],
        rows: [['not-a-number']]
      }
    }
    expect(validateProviderEnvelope(legacy).ok).toBe(false)

    const unavailable = structuredClone(envelope) as any
    unavailable.payload.status = 'unavailable'
    unavailable.payload.rows = []
    unavailable.payload.errors = [{
      code: 'format-unsupported',
      message: 'Synthetic projection is unavailable',
      retryable: false,
      providerId: 'example/sqlite-agent',
      sourceRefId: null,
      recordId: null,
      details: null
    }]
    unavailable.payload.unavailableReason = 'Synthetic projection is unavailable'
    expect(validateProviderEnvelope(unavailable).ok).toBe(true)
  })

  it('a synthetic provider passes conformance without entering a built-in switch', () => {
    const manifest = syntheticManifest()
    const hello: ProviderEnvelope = {
      protocolVersion: PROVIDER_PROTOCOL_VERSION,
      messageId: 'fixture-hello',
      kind: 'hello',
      payload: helloForProvider(manifest)
    }
    expect(hello.payload.schemaId).toBe(PROVIDER_PROTOCOL_SCHEMA_ID)
    expect(runProviderConformance({ manifest, envelopes: [hello, thirdPartyEnvelope] })).toEqual({
      ok: true,
      providerId: 'example/sqlite-agent',
      issues: [],
      checkedEnvelopes: 2
    })
  })

  it('manifest fingerprint and canonical record IDs are stable across object key order', () => {
    const manifest = syntheticManifest()
    const reordered = Object.fromEntries(Object.entries(manifest).reverse())
    expect(providerFingerprint(reordered)).toBe(providerFingerprint(manifest))
    const input = {
      providerId: 'example/sqlite-agent',
      sourceRefStableId: 'source:42',
      recordType: 'message',
      sourceRecordId: 'message:7'
    }
    expect(stableCanonicalRecordId(input)).toBe(stableCanonicalRecordId({ ...input }))
    expect(stableCanonicalRecordId({ ...input, sourceRecordId: 'message:8' }))
      .not.toBe(stableCanonicalRecordId(input))
  })
})
