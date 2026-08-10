export function duplicateRecoveryErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return 'DUPLICATE_RECOVERY_ANALYSIS_FAILED'
  const typed = error as { code?: unknown; message?: unknown }
  if (typeof typed.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(typed.code)) return typed.code
  if (typeof typed.message === 'string' &&
    /^duplicate-recovery-[a-z0-9-]{1,96}$/.test(typed.message)) return typed.message
  return 'DUPLICATE_RECOVERY_ANALYSIS_FAILED'
}
