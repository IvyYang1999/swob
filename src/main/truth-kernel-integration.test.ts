import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanonicalEvent } from '../shared/provider-schema-v2.generated'
import type { UserPricingPolicy } from '../shared/contracts/truth-kernel'
import { TRUTH_KERNEL_GOLDEN_FIXTURE } from '../shared/contracts/truth-kernel'
import { createPricingPolicyRepository } from './fact-ledger/pricing-policy-repository'
import { enumerateTruthKernelMigrations, projectTruthKernelInteractionReadModels, projectTruthKernelTimeline, projectTruthKernelTimelineWithOutputs } from './truth-kernel-integration'

const temporaryRoots: string[] = []
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function event(overrides: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    id: 'event', identity: { physicalSourceId: 'source', logicalSessionKey: 'key', logicalSessionId: 'session', branchViewId: 'branch', parentBranchViewId: null },
    sharedEventKey: 'shared', messageId: null, sequence: 0, messageBlockIndex: null,
    timestamp: '2026-08-11T00:00:00.000Z', actor: 'user', kind: 'message.text', payload: { text: 'go' },
    visibility: 'primary', classification: 'user-content', timeline: { archived: true, modelContext: [] },
    provenance: { providerId: 'codex', sourceRefId: 'source', parserDataVersion: '1', formatVersion: '1', observedAt: '2026-08-11T00:00:00.000Z', sourceRecordId: 'record', rawRecordFingerprint: null },
    rawRef: null, ...overrides
  }
}

describe('t211I truth-kernel root integration', () => {
  it('enumerates the frozen read-only migration once', () => {
    const manifest = enumerateTruthKernelMigrations()
    expect(manifest.steps.map((step) => step.id)).toEqual(['truth-kernel/0001-create-rebuildable-projections'])
    expect(manifest.steps.every((step) => step.sourceWritesAllowed === false)).toBe(true)
  })

  it('retains every provider event and unknown payload', () => {
    const providerEvents = TRUTH_KERNEL_GOLDEN_FIXTURE.timelineEvents.map((entry) => entry.providerEvent)
    const timeline = projectTruthKernelTimeline(providerEvents)
    expect(timeline.map((entry) => entry.providerEvent)).toEqual(providerEvents)
    expect(timeline.find((entry) => entry.providerEvent.kind === 'unknown')?.providerEvent.payload)
      .toEqual(providerEvents.find((entry) => entry.kind === 'unknown')?.payload)
  })

  it('resolves canonical artifact output only through a main-owned allowed root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'swob-t211i-output-'))
    temporaryRoots.push(root)
    const outputPath = path.join(root, 'result.json')
    const bytes = Buffer.from('{"ok":true}')
    await writeFile(outputPath, bytes)
    const artifact = event({
      id: 'artifact', kind: 'artifact', actor: 'tool',
      payload: {
        uri: outputPath, artifactId: 'artifact-1', mimeType: 'application/json', sizeBytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex')
      }
    })
    const accepted = await projectTruthKernelTimelineWithOutputs([artifact], [{ rootId: 'library', absolutePath: root }])
    expect(accepted[0].persistedOutputs[0]).toMatchObject({ contentState: 'available', activeContentAllowed: false })
    const rejected = await projectTruthKernelTimelineWithOutputs([artifact], [{ rootId: 'other', absolutePath: root }])
    expect(rejected[0].persistedOutputs[0]).toMatchObject({ contentState: 'available' })
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'swob-t211i-other-'))
    temporaryRoots.push(outsideRoot)
    const outside = await projectTruthKernelTimelineWithOutputs([artifact], [{ rootId: 'library', absolutePath: outsideRoot }])
    expect(outside[0].persistedOutputs[0]).toMatchObject({ contentState: 'outside-allowed-root' })
  })

  it('adds one dated valuation per canonical usage event and keeps missing model/time unvalued', () => {
    const pricing = createPricingPolicyRepository()
    const policy: UserPricingPolicy = {
      schemaVersion: 1, policyId: 'public-codex-model', revisionId: 'public-codex-model:r1', revision: 1,
      policyVersion: '1', purpose: 'public-price-correction', providerId: 'codex', modelId: 'model', modelPattern: 'model',
      currency: 'USD', rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000, price: 1 }],
      sourceNote: 'focused production-entrypoint test', lifecycle: 'active', supersedesRevisionId: { status: 'unavailable', reason: 'initial' },
      effectiveFrom: '2026-08-01T00:00:00.000Z', effectiveUntil: { status: 'unavailable', reason: 'open-ended' },
      createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z', provenance: []
    }
    expect(pricing.apply({ contractVersion: '1.0.0', commandId: 'create', kind: 'create', expectedHeadRevision: null, policy }).status).toBe('applied')
    const usagePayload = {
      eventId: 'usage', turnId: null, modelId: 'model',
      input: { total: 10, uncached: 10, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
      output: { total: 2, visible: 2, reasoning: 0 }, providerTotal: 12, aggregation: 'cumulative',
      relations: { cacheRead: 'subset-of-input', cacheWrite: 'provider-defined', reasoning: 'subset-of-output' },
      dedupKey: 'd', billingFactKey: 'b', measurement: { source: 'reported', confidence: 'exact', sourceField: 'usage' },
      cost: null, priceRevision: null, toolTokens: 0, nonToken: { unit: 'request', quantity: 0 }
    }
    const interactions = projectTruthKernelInteractionReadModels([
      event({ id: 'user', sequence: 0 }),
      event({ id: 'usage', sequence: 1, actor: 'assistant', kind: 'usage', payload: usagePayload })
    ], pricing)
    expect(interactions[0].valuations).toHaveLength(1)
    expect(interactions[0].valuations[0]).toMatchObject({ usageFactId: 'usage', publicEquivalent: { status: 'available' } })
    const noModel = projectTruthKernelInteractionReadModels([
      event({ id: 'user', sequence: 0 }),
      event({ id: 'usage', sequence: 1, actor: 'assistant', kind: 'usage', payload: { ...usagePayload, modelId: null } })
    ], pricing)
    expect(noModel[0].valuations).toEqual([])
    pricing.close()
  })
})
