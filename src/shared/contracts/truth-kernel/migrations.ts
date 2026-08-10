import type { TruthKernelSchemaVersion } from './types'

export const TRUTH_KERNEL_MIGRATION_NAMESPACE = 'truth-kernel' as const

export type TruthKernelMigrationMode = 'forward' | 'rebuild'

export interface TruthKernelMigrationStep {
  id: string
  fromVersion: 0 | TruthKernelSchemaVersion
  toVersion: TruthKernelSchemaVersion
  mode: TruthKernelMigrationMode
  sourceWritesAllowed: false
  transactionBoundary: 'single-transaction'
  rebuildInputs: readonly string[]
  rollback: 'drop-projection-and-rebuild'
}

export interface TruthKernelMigrationManifest {
  namespace: typeof TRUTH_KERNEL_MIGRATION_NAMESPACE
  targetVersion: TruthKernelSchemaVersion
  ownership: 't211A-contract-owner'
  integrationOwner: 't211I'
  steps: readonly TruthKernelMigrationStep[]
}

export const TRUTH_KERNEL_MIGRATION_MANIFEST: TruthKernelMigrationManifest = {
  namespace: TRUTH_KERNEL_MIGRATION_NAMESPACE,
  targetVersion: 1,
  ownership: 't211A-contract-owner',
  integrationOwner: 't211I',
  steps: [{
    id: 'truth-kernel/0001-create-rebuildable-projections',
    fromVersion: 0,
    toVersion: 1,
    mode: 'forward',
    sourceWritesAllowed: false,
    transactionBoundary: 'single-transaction',
    rebuildInputs: [
      'canonical_v2_sessions',
      'canonical_v2_events',
      'session-meta-v3-read-model',
      'usage-fact-ledger',
      'registered-storage-root-inventory',
      'external-evidence-attachments'
    ],
    rollback: 'drop-projection-and-rebuild'
  }]
}

export interface TruthKernelMigrationPlan {
  migrationIds: string[]
  emptyDatabase: boolean
  rebuildRequired: boolean
  destructiveSourceWrites: false
  reason: string
}

/**
 * Feature-local planning skeleton only. t211I owns physical DDL aggregation.
 * Existing source files, Session Meta and Provider v2 rows are never rewritten.
 */
export function planTruthKernelMigration(currentVersion: number | null): TruthKernelMigrationPlan {
  if (currentVersion === null || currentVersion === 0) {
    return {
      migrationIds: TRUTH_KERNEL_MIGRATION_MANIFEST.steps.map((step) => step.id),
      emptyDatabase: currentVersion === null,
      rebuildRequired: false,
      destructiveSourceWrites: false,
      reason: 'initialize truth-kernel rebuildable projection schema'
    }
  }
  if (currentVersion === TRUTH_KERNEL_MIGRATION_MANIFEST.targetVersion) {
    return {
      migrationIds: [],
      emptyDatabase: false,
      rebuildRequired: false,
      destructiveSourceWrites: false,
      reason: 'truth-kernel schema is current'
    }
  }
  return {
    migrationIds: TRUTH_KERNEL_MIGRATION_MANIFEST.steps.map((step) => step.id),
    emptyDatabase: false,
    rebuildRequired: true,
    destructiveSourceWrites: false,
    reason: 'unsupported projection version must be dropped and deterministically rebuilt'
  }
}
