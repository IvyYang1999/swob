export interface OnboardingBackupSizeBySource {
  source: string
  sessions: number
  bytes: number
}

export interface OnboardingBackupSizeEstimate {
  perSource: OnboardingBackupSizeBySource[]
  totalBytes: number
  diskFreeBytes: number
  targetIsExistingLibrary: boolean
  estimatedNewBytes?: number
}
