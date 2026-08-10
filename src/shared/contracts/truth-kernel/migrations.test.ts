import { describe, expect, it } from 'vitest'
import {
  TRUTH_KERNEL_MIGRATION_MANIFEST,
  planTruthKernelMigration
} from './migrations'

describe('Truth Kernel migration skeleton', () => {
  it('starts an empty database without changing source data', () => {
    expect(planTruthKernelMigration(null)).toEqual({
      migrationIds: ['truth-kernel/0001-create-rebuildable-projections'],
      emptyDatabase: true,
      rebuildRequired: false,
      destructiveSourceWrites: false,
      reason: 'initialize truth-kernel rebuildable projection schema'
    })
  })

  it('is a no-op for the current schema', () => {
    expect(planTruthKernelMigration(1)).toEqual({
      migrationIds: [],
      emptyDatabase: false,
      rebuildRequired: false,
      destructiveSourceWrites: false,
      reason: 'truth-kernel schema is current'
    })
  })

  it('rebuilds unknown projection versions rather than fabricating source history', () => {
    expect(planTruthKernelMigration(99)).toEqual(expect.objectContaining({
      rebuildRequired: true,
      destructiveSourceWrites: false
    }))
  })

  it('freezes unique migration ids and a drop-and-rebuild rollback boundary', () => {
    const ids = TRUTH_KERNEL_MIGRATION_MANIFEST.steps.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(TRUTH_KERNEL_MIGRATION_MANIFEST.steps).toEqual([
      expect.objectContaining({
        sourceWritesAllowed: false,
        transactionBoundary: 'single-transaction',
        rollback: 'drop-projection-and-rebuild'
      })
    ])
  })
})
