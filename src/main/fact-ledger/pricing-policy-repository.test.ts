import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPricingPolicyRepository, openPricingPolicyRepository, valueUsageAttributions } from './pricing-policy-repository'
import type { UsageAttribution, UserPricingPolicy } from '../../shared/contracts/truth-kernel'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const policy = (revision = 1, purpose: UserPricingPolicy['purpose'] = 'contract-price', policyId = 'policy'): UserPricingPolicy => ({
  schemaVersion: 1, policyId, revisionId: `${policyId}:r${revision}`, revision, policyVersion: '1', purpose,
  providerId: 'openai', modelId: 'gpt', modelPattern: 'gpt', currency: 'USD',
  rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: purpose === 'contract-price' ? 1 : 2 }],
  sourceNote: purpose, lifecycle: 'active',
  supersedesRevisionId: revision === 1 ? { status: 'unavailable', reason: 'initial' } : { status: 'available', value: `${policyId}:r${revision - 1}` },
  effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: { status: 'unavailable', reason: 'open-ended' },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: `2026-0${revision}-01T00:00:00.000Z`, provenance: []
})

describe('pricing policy repository', () => {
  it('persists validated create/supersede/undo history and rejects broken chains', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swob-pricing-'))
    dirs.push(dir)
    const databasePath = join(dir, 'pricing.db')
    const repo = openPricingPolicyRepository(databasePath)
    expect(repo.apply({ contractVersion: '1.0.0', commandId: 'create', kind: 'create', expectedHeadRevision: null, policy: policy() }).status).toBe('applied')
    expect(repo.apply({ contractVersion: '1.0.0', commandId: 'broken', kind: 'supersede', policyId: 'policy', expectedHeadRevision: 1, policy: { ...policy(2), supersedesRevisionId: { status: 'available', value: 'wrong' } } }).status).toBe('invalid')
    expect(repo.apply({ contractVersion: '1.0.0', commandId: 'supersede', kind: 'supersede', policyId: 'policy', expectedHeadRevision: 1, policy: { ...policy(2), rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: 4 }] } }).status).toBe('applied')
    expect(repo.apply({ contractVersion: '1.0.0', commandId: 'undo', kind: 'undo', policyId: 'policy', expectedHeadRevision: 2, reason: 'user-request', occurredAt: '2026-03-01T00:00:00.000Z' }).status).toBe('applied')
    repo.close()
    const reopened = openPricingPolicyRepository(databasePath)
    expect(reopened.list().map((entry) => entry.lifecycle)).toEqual(['active', 'active', 'undone'])
    expect(reopened.resolve('openai', 'gpt', 'contract-price', '2026-03-02T00:00:00.000Z')).toMatchObject({ revisionId: 'policy:r1' })
    const revertedValuation = valueUsageAttributions({ repository: reopened, usageFactId: 'fact', providerId: 'openai', rawModelId: 'gpt', at: '2026-03-02T00:00:00.000Z', usage: [{ schemaVersion: 1, usageAttributionId: 'u', interactionId: 'i', usageFactIds: ['fact'], billingFactIds: ['bill'], quantityKind: 'input-token', quantityUnit: 'token', quantity: { status: 'available', value: 1_000_000 }, measurement: 'exact', residual: { status: 'available', value: 0 }, sourceGranularity: 'per-call', lineageScope: 'physical-session', evidence: [] }] })
    expect(revertedValuation.actualContract).toMatchObject({ status: 'available', value: { amount: 1, policyRevisionId: 'policy:r1' } })
    reopened.close()
  })

  it('rejects delete with an empty reason or invalid occurredAt without persisting a revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'swob-pricing-invalid-delete-'))
    dirs.push(dir)
    const databasePath = join(dir, 'pricing.db')
    const repo = openPricingPolicyRepository(databasePath, [policy()])
    expect(repo.apply({ contractVersion: '1.0.0', commandId: 'empty-reason', kind: 'delete', policyId: 'policy', expectedHeadRevision: 1, reason: '', occurredAt: '2026-03-01T00:00:00.000Z' })).toMatchObject({ status: 'invalid', errorCode: { status: 'available', value: 'reason-required' } })
    expect(repo.apply({ contractVersion: '1.0.0', commandId: 'bad-time', kind: 'delete', policyId: 'policy', expectedHeadRevision: 1, reason: 'user-request', occurredAt: 'not-a-timestamp' })).toMatchObject({ status: 'invalid', errorCode: { status: 'available', value: 'invalid-occurred-at' } })
    expect(repo.list()).toHaveLength(1)
    expect(repo.list()[0]).toMatchObject({ revisionId: 'policy:r1', lifecycle: 'active' })
    repo.close()
    const reopened = openPricingPolicyRepository(databasePath)
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.list()[0]).toMatchObject({ revisionId: 'policy:r1', lifecycle: 'active' })
    reopened.close()
  })

  it('does not fuzzy-match aliases and rejects overlaps at insertion', () => {
    const repo = createPricingPolicyRepository([], [{ schemaVersion: 1, aliasId: 'a', providerId: 'openai', rawModelId: 'gpt-4', canonicalModelId: 'gpt', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: { status: 'unavailable', reason: 'open' }, aliasVersion: '1', provenance: [] }])
    expect(repo.resolveAlias('openai', 'gpt-4-mini', '2026-02-01T00:00:00.000Z')).toMatchObject({ status: 'unavailable' })
    expect(repo.addAlias({ schemaVersion: 1, aliasId: 'b', providerId: 'openai', rawModelId: 'gpt-4', canonicalModelId: 'other', effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveUntil: { status: 'unavailable', reason: 'open' }, aliasVersion: '1', provenance: [] })).toEqual({ status: 'conflict', reason: 'overlapping-exact-model-aliases' })
    expect(repo.resolveAlias('openai', 'gpt-4', '2026-02-01T00:00:00.000Z')).toMatchObject({ canonicalModelId: 'gpt' })
    repo.close()
  })

  it('keeps public-equivalent and actual-contract valuations separate and immutable', () => {
    const repo = createPricingPolicyRepository([policy(1, 'public-price-correction', 'public'), policy(1, 'contract-price', 'contract')])
    const usage: UsageAttribution = {
      schemaVersion: 1, usageAttributionId: 'u', interactionId: 'i', usageFactIds: ['fact'], billingFactIds: ['bill'],
      quantityKind: 'input-token', quantityUnit: 'token', quantity: { status: 'available', value: 1_000_000 },
      measurement: 'exact', residual: { status: 'available', value: 0 }, sourceGranularity: 'per-call', lineageScope: 'physical-session', evidence: []
    }
    const valuation = valueUsageAttributions({
      repository: repo, usageFactId: 'fact', providerId: 'openai', rawModelId: 'gpt', at: '2026-02-01T00:00:00.000Z', usage: [usage],
      officialSnapshot: { snapshotId: 'official', revision: '2026-01', digest: 'a'.repeat(64), providerId: 'openai', modelId: 'gpt', currency: 'USD', rates: [{ quantityKind: 'input-token', unit: 'token', unitSize: 1_000_000, price: 3 }] }
    })
    expect(valuation.publicEquivalent).toMatchObject({ status: 'available', value: { amount: 2, source: 'user-policy', policyRevisionId: { status: 'available', value: 'public:r1' } } })
    expect(valuation.actualContract).toMatchObject({ status: 'available', value: { amount: 1, policyRevisionId: 'contract:r1' } })
    expect(valuation.officialPriceSnapshot).toMatchObject({ status: 'available', value: { snapshotId: 'official', digest: 'a'.repeat(64) } })
    repo.close()
  })
})
