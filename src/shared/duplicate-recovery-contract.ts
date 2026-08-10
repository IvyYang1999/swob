export type DuplicateRecoveryAnalysisPhase = 'discovering' | 'analyzing-conflicts' | 'complete'

export interface DuplicateRecoveryProgress {
  phase: DuplicateRecoveryAnalysisPhase
  discoveredPackages: number
  conflictPackages: number
  analyzedConflictPackages: number
}

export interface DuplicateRecoverySummary {
  schemaVersion: 1
  planId: string
  completedAt: string
  canApply: boolean
  packageCount: number
  conflictCount: number
  autoRepairableGroupCount: number
  autoRepairablePackageCount: number
  manualMergeGroupCount: number
  preservedGroupCount: number
}

export const DUPLICATE_RECOVERY_PLANNER_REVISION = 1 as const

export interface DuplicateRecoveryAppliedResult {
  schemaVersion: 1
  status: 'applied'
  planId: string
  appliedPackageCount: number
  restartRequired: boolean
}

export interface DuplicateRecoveryStaleResult {
  schemaVersion: 1
  status: 'stale'
  planId: string
  appliedPackageCount: 0
  restartRequired: false
}

export type DuplicateRecoveryApplyResult =
  | DuplicateRecoveryAppliedResult
  | DuplicateRecoveryStaleResult
