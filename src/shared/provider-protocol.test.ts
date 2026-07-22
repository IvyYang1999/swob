import { describe, expect, it } from 'vitest'
import claudeEnvelope from '../../schema/fixtures/claude-provider-envelope.json'
import codexEnvelope from '../../schema/fixtures/codex-provider-envelope.json'
import thirdPartyEnvelope from '../../schema/fixtures/third-party-provider-envelope.json'
import {
  PROVIDER_CAPABILITY_NAMES,
  PROVIDER_PROTOCOL_VERSION,
  type CapabilityDeclaration,
  type ProviderCapabilities,
  type ProviderEnvelope,
  type ProviderManifest
} from './provider-schema.generated'
import {
  assertProviderEnvelope,
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

describe('ProviderProtocol v1 schema truth', () => {
  it.each([
    ['Claude', claudeEnvelope],
    ['Codex partial', codexEnvelope],
    ['third-party', thirdPartyEnvelope]
  ])('%s golden envelope round-trips through the schema', (_name, fixture) => {
    const roundTrip = JSON.parse(JSON.stringify(fixture))
    expect(validateProviderEnvelope(roundTrip)).toEqual({
      ok: true,
      value: roundTrip,
      issues: []
    })
    expect(assertProviderEnvelope(roundTrip)).toEqual(roundTrip)
  })

  it('unknown fields and protocol versions fail closed', () => {
    const unknownField = { ...claudeEnvelope, unexpected: true }
    const nestedUnknown = structuredClone(claudeEnvelope) as any
    nestedUnknown.payload.sessions[0].records[0].userFolder = 'must-not-enter-canonical-schema'
    const futureVersion = { ...claudeEnvelope, protocolVersion: '2.0' }
    expect(validateProviderEnvelope(unknownField).ok).toBe(false)
    expect(validateProviderEnvelope(nestedUnknown).ok).toBe(false)
    expect(validateProviderEnvelope(futureVersion).ok).toBe(false)
    expect(() => assertProviderEnvelope(futureVersion)).toThrow('ProviderProtocol v1 validation failed')
  })

  it('partial parse without a typed error fails closed', () => {
    const invalid = structuredClone(codexEnvelope) as any
    invalid.payload.sessions[0].errors = []
    expect(validateProviderEnvelope(invalid)).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ keyword: 'parse-errors' })
      ])
    })
  })

  it('invalid capability states and unsupported ProviderId shapes fail closed', () => {
    const manifest = syntheticManifest() as any
    manifest.capabilities.search.status = 'stable'
    manifest.providerId = 'not-namespaced'
    expect(validateProviderManifest(manifest)).toMatchObject({ ok: false })
  })

  it('QueryFrame stays explicitly lossy and rejects shape drift', () => {
    const envelope = {
      protocolVersion: '1.0',
      messageId: 'query-frame-1',
      kind: 'query-frame',
      payload: {
        schemaVersion: 1,
        projectionId: 'usage/by-source',
        lossy: true,
        sourceRecordTypes: ['usage'],
        fields: [{ name: 'source', type: 'string', nullable: false }],
        rows: [['claude-code']]
      }
    }
    expect(validateProviderEnvelope(envelope).ok).toBe(true)
    expect(validateProviderEnvelope({
      ...envelope,
      payload: { ...envelope.payload, lossy: false }
    }).ok).toBe(false)
    expect(validateProviderEnvelope({
      ...envelope,
      payload: { ...envelope.payload, rows: [['claude-code', 1]] }
    })).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ keyword: 'query-frame-width' })])
    })
  })

  it('a synthetic provider passes conformance without entering a built-in switch', () => {
    const manifest = syntheticManifest()
    const hello: ProviderEnvelope = {
      protocolVersion: PROVIDER_PROTOCOL_VERSION,
      messageId: 'fixture-hello',
      kind: 'hello',
      payload: helloForProvider(manifest)
    }
    const report = runProviderConformance({
      manifest,
      envelopes: [hello, thirdPartyEnvelope]
    })
    expect(report).toEqual({
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
