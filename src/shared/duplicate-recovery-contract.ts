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
  packageCount: number
  conflictCount: number
  autoRepairableGroupCount: number
  autoRepairablePackageCount: number
  manualMergeGroupCount: number
  preservedGroupCount: number
}

export interface DuplicateRecoveryApplyResult {
  schemaVersion: 1
  planId: string
  appliedPackageCount: number
  restartRequired: boolean
}
