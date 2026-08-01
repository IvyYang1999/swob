import { describe, expect, it } from 'vitest'
import {
  ACTIVE_PRICE_SNAPSHOT,
  PRICE_SNAPSHOT_REGISTRY,
  assertPriceSnapshotIntegrity
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
})
