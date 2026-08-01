import { describe, expect, it } from 'vitest'
import { builtinProviderForSource } from '../shared/provider-capabilities'
import type {
  Fingerprint,
  ParseOutcome,
  ProviderManifest,
  SourceRef
} from '../shared/provider-schema.generated'
import {
  ProviderHost,
  type BuiltinProviderRuntime
} from './provider-host'
import { PROVIDER_RESOURCE_LIMITS as PROVIDER_V2_LIMITS } from '../shared/provider-schema-v2.generated'

const pendingFingerprint: Fingerprint = { algorithm: 'sha256', value: 'pending' }
const parsedFingerprint: Fingerprint = { algorithm: 'sha256', value: 'parsed' }

function manifest(source: 'pi' | 'hermes'): ProviderManifest {
  return structuredClone(builtinProviderForSource(source)!.manifest)
}

function source(providerId: string, stableId: string): SourceRef {
  return {
    kind: 'file',
    providerId,
    stableId,
    uri: `file:///synthetic/${stableId}.jsonl`,
    displayLocator: `/synthetic/${stableId}.jsonl`,
    fingerprint: pendingFingerprint
  }
}

function noData(providerId: string, parserDataVersion: string, sourceRefId: string): ParseOutcome {
  return {
    providerId,
    parserDataVersion,
    formatVersion: null,
    fingerprint: parsedFingerprint,
    status: 'no-data',
    sessions: [{
      sourceRefId,
      sessionRecordId: null,
      status: 'no-data',
      records: [],
      errors: [],
      replaceSessionRecordId: null,
      noDataReason: 'empty-source'
    }],
    errors: [],
    tombstones: []
  }
}

function partialPiOutcome(sourceRef: SourceRef): ParseOutcome {
  const provenance = {
    providerId: 'swob/pi',
    sourceRefId: sourceRef.stableId,
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    observedAt: '2026-07-23T00:00:00.000Z'
  }
  const parseError = {
    code: 'partial-data' as const,
    message: 'one synthetic row was malformed',
    retryable: false,
    providerId: 'swob/pi',
    sourceRefId: sourceRef.stableId,
    recordId: null,
    details: null
  }
  return {
    providerId: 'swob/pi',
    parserDataVersion: '1',
    formatVersion: 'pi-jsonl-v3',
    fingerprint: parsedFingerprint,
    status: 'partial',
    sessions: [{
      sourceRefId: sourceRef.stableId,
      sessionRecordId: 'partial-session-record',
      status: 'partial',
      records: [{
        id: 'partial-session-record',
        recordType: 'session',
        sourceRef: { ...sourceRef, fingerprint: parsedFingerprint } as SourceRef,
        sourceSessionId: 'partial-session',
        createdAt: null,
        updatedAt: null,
        cwd: [],
        projectPath: null,
        providerTitle: null,
        provenance
      }],
      errors: [parseError],
      replaceSessionRecordId: null,
      noDataReason: null
    }],
    errors: [parseError],
    tombstones: []
  }
}

function runtime(
  sourceId: 'pi' | 'hermes',
  overrides: Partial<BuiltinProviderRuntime> = {}
): BuiltinProviderRuntime {
  const providerManifest = manifest(sourceId)
  const providerSource = source(providerManifest.providerId, sourceId)
  return {
    manifest: providerManifest,
    discover: async () => [providerSource],
    fingerprint: async () => parsedFingerprint,
    inputBytes: async () => 128,
    parse: async () => noData(providerManifest.providerId, providerManifest.parserDataVersion, sourceId),
    ...overrides
  }
}

describe('ProviderHost isolation and resource boundaries', () => {
  it('times out one provider without delaying or corrupting another provider report', async () => {
    const slowPi = runtime('pi', {
      parse: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40))
        return noData('swob/pi', manifest('pi').parserDataVersion, 'pi')
      }
    })
    const fastHermes = runtime('hermes')
    const host = new ProviderHost({ runtimes: [slowPi, fastHermes], timeoutMs: 10 })

    const reports = await host.runAll()
    const piReport = reports.find((report) => report.providerId === 'swob/pi')!
    const hermesReport = reports.find((report) => report.providerId === 'swob/hermes')!
    expect(piReport.errors).toMatchObject([{ code: 'timeout' }])
    expect(piReport.outcomes).toHaveLength(0)
    expect(hermesReport.errors).toHaveLength(0)
    expect(hermesReport.outcomes).toHaveLength(1)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(piReport.outcomes).toHaveLength(0)
  })

  it('rejects a manifest that differs from the registry without affecting app startup or peers', async () => {
    const invalidPi = runtime('pi')
    invalidPi.manifest.displayName = 'Unregistered manifest mutation'
    const host = new ProviderHost({ runtimes: [invalidPi, runtime('hermes')] })

    const reports = await host.runAll()
    expect(reports.find((report) => report.providerId === 'swob/pi')?.errors)
      .toMatchObject([{ code: 'schema-validation-failed' }])
    expect(reports.find((report) => report.providerId === 'swob/hermes')?.outcomes).toHaveLength(1)
  })

  it('returns typed resource and cancellation errors', async () => {
    const oversized = new ProviderHost({
      runtimes: [runtime('pi', { inputBytes: async () => 51 })],
      maxSessionInputBytes: 50
    })
    const oversizedReport = (await oversized.runAll())[0]
    expect(oversizedReport.errors).toMatchObject([{ code: 'resource-limit-exceeded' }])
    expect(oversizedReport.outcomes).toHaveLength(0)

    const waiting = runtime('pi', {
      discover: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    })
    const cancellable = new ProviderHost({ runtimes: [waiting] })
    const run = cancellable.runAll()
    await new Promise((resolve) => setImmediate(resolve))
    cancellable.cancelAll()
    expect((await run)[0].errors).toMatchObject([{ code: 'cancelled' }])
  })

  it('isolates source failures and keeps partial re-parses protocol-valid', async () => {
    const providerManifest = manifest('pi')
    const failedSource = source(providerManifest.providerId, 'failed')
    const healthySource = source(providerManifest.providerId, 'healthy')
    const isolated = runtime('pi', {
      discover: async () => [failedSource, healthySource],
      fingerprint: async (candidate) => {
        if (candidate.stableId === 'failed') throw new Error('synthetic fingerprint failure')
        return parsedFingerprint
      },
      parse: async (candidate) => noData(
        providerManifest.providerId,
        providerManifest.parserDataVersion,
        candidate.stableId
      )
    })
    const isolatedReport = (await new ProviderHost({ runtimes: [isolated] }).runAll())[0]
    expect(isolatedReport.errors).toMatchObject([{ code: 'provider-failed' }])
    expect(isolatedReport.outcomes).toHaveLength(1)

    const partialSource = source(providerManifest.providerId, 'pi')
    const partial = runtime('pi', { parse: async () => partialPiOutcome(partialSource) })
    const previous = new Map([[providerManifest.providerId, [{
      sourceRef: { ...partialSource, fingerprint: { algorithm: 'sha256', value: 'old' } } as SourceRef,
      fingerprint: { algorithm: 'sha256', value: 'old' } as Fingerprint,
      sessionRecordIds: ['partial-session-record']
    }]]])
    const partialReport = (await new ProviderHost({ runtimes: [partial] }).runAll({
      previousSources: previous
    }))[0]
    expect(partialReport.errors).toHaveLength(0)
    expect(partialReport.outcomes).toMatchObject([{ status: 'partial' }])
    expect(partialReport.v2Manifest).toMatchObject({ schemaVersion: 2, providerId: 'swob/pi' })
    expect(partialReport.v2Envelopes.map((entry) => entry.kind)).toEqual([
      'hello', 'manifest', 'parse-chunk'
    ])
    expect(partialReport.v2Envelopes.every((entry) =>
      Buffer.byteLength(JSON.stringify(entry), 'utf8') <= PROVIDER_V2_LIMITS.maxEnvelopeBytes)).toBe(true)
    expect(Object.values(partialReport.v2Manifest!.capabilities).every((declaration) =>
      declaration.evidence.every((entry) => entry.fixture && entry.conformanceTestId))).toBe(true)
  })

  it('keeps the last valid snapshot when discovery sees the stable id with invalid metadata', async () => {
    const providerManifest = manifest('pi')
    const previousSource = source(providerManifest.providerId, 'preserved')
    const invalidSource = {
      ...previousSource,
      providerId: 'not-namespaced',
      uri: 'not-a-file-uri'
    } as SourceRef
    const host = new ProviderHost({
      runtimes: [runtime('pi', { discover: async () => [invalidSource] })]
    })
    const report = (await host.runAll({
      previousSources: new Map([[providerManifest.providerId, [{
        sourceRef: { ...previousSource, fingerprint: parsedFingerprint } as SourceRef,
        fingerprint: parsedFingerprint,
        sessionRecordIds: ['existing-session-record']
      }]]])
    }))[0]

    expect(report.errors).toMatchObject([{ code: 'schema-validation-failed' }])
    expect(report.outcomes).toHaveLength(0)
  })

  it('forces a same-fingerprint reparse when the v2 projection needs crash repair', async () => {
    const providerManifest = manifest('pi')
    const providerSource = source(providerManifest.providerId, 'repair')
    let parseCalls = 0
    const repairing = runtime('pi', {
      discover: async () => [providerSource],
      fingerprint: async () => parsedFingerprint,
      parse: async () => {
        parseCalls++
        return noData(providerManifest.providerId, providerManifest.parserDataVersion, providerSource.stableId)
      }
    })
    const report = (await new ProviderHost({ runtimes: [repairing] }).runAll({
      previousSources: new Map([[providerManifest.providerId, [{
        sourceRef: { ...providerSource, fingerprint: parsedFingerprint } as SourceRef,
        fingerprint: parsedFingerprint,
        sessionRecordIds: ['v1-only-session'],
        forceReparse: true
      }]]])
    }))[0]

    expect(parseCalls).toBe(1)
    expect(report.unchangedSources).toHaveLength(0)
    expect(report.outcomes).toHaveLength(1)
  })
})
