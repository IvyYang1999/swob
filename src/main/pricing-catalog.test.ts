import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PRICE_SNAPSHOT,
  PRICE_SNAPSHOT_REGISTRY,
  assertPriceSnapshotIntegrity,
  calculatePriceSnapshotHash,
  type PriceSnapshot
} from './pricing-catalog'

describe('approved price snapshots', () => {
  it('active snapshot is immutable, approved and content-addressed', () => {
    expect(() => assertPriceSnapshotIntegrity(ACTIVE_PRICE_SNAPSHOT)).not.toThrow()
    expect(ACTIVE_PRICE_SNAPSHOT.status).toBe('approved')
    expect(ACTIVE_PRICE_SNAPSHOT.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.isFrozen(ACTIVE_PRICE_SNAPSHOT)).toBe(true)
    expect(Object.isFrozen(ACTIVE_PRICE_SNAPSHOT.rules)).toBe(true)
  })

  it('pins the required source pipeline in review order', () => {
    expect(ACTIVE_PRICE_SNAPSHOT.sourcePipeline.map((source) => source.role)).toEqual([
      'history-formula',
      'coverage-diff',
      'model-identity',
      'official-review-override'
    ])
    expect(ACTIVE_PRICE_SNAPSHOT.sourcePipeline.every((source) => source.revision.length > 0)).toBe(true)
  })

  it('keeps the replaced snapshot available for reproducible history and explicit what-if', () => {
    expect(ACTIVE_PRICE_SNAPSHOT.replaces).toBe('official-snapshot-2026-07-22.v1')
    expect(PRICE_SNAPSHOT_REGISTRY.has(ACTIVE_PRICE_SNAPSHOT.replaces!)).toBe(true)
  })

  it('allows parallel effective intervals only when modifier dimensions differ', () => {
    const source = ACTIVE_PRICE_SNAPSHOT.rules[0]
    const fixture: PriceSnapshot = {
      revision: 'fixture-dimensions', status: 'approved', generatedAt: '2026-08-02T00:00:00Z',
      reviewedAt: '2026-08-02T00:00:00Z', contentHash: '',
      sourcePipeline: ACTIVE_PRICE_SNAPSHOT.sourcePipeline,
      rules: [
        { ...source, id: 'fixture-standard', catalogVersion: 'fixture-dimensions' },
        {
          ...source, id: 'fixture-batch', catalogVersion: 'fixture-dimensions',
          dimensions: { batchMode: 'batch' }
        }
      ]
    }
    fixture.contentHash = calculatePriceSnapshotHash(fixture)
    expect(() => assertPriceSnapshotIntegrity(fixture)).not.toThrow()

    fixture.rules = [...fixture.rules, { ...fixture.rules[0], id: 'fixture-overlap' }]
    fixture.contentHash = calculatePriceSnapshotHash(fixture)
    expect(() => assertPriceSnapshotIntegrity(fixture)).toThrow(/overlapping rules/)
  })

  it('runtime registry never contains a pending-review candidate', () => {
    expect([...PRICE_SNAPSHOT_REGISTRY.values()].every((snapshot) => snapshot.status === 'approved')).toBe(true)
    expect(PRICE_SNAPSHOT_REGISTRY.has('candidate-2026-08-02.v1')).toBe(false)
  })
})
