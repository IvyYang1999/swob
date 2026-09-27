import type { UsageFactSyncFailure } from './analysis-contract'

/**
 * The background usage sync's failure streak, for the Insights page and the
 * lifecycle log. Main-process memory only: the ledger's single meta row has
 * no place for it (no table or column is added for this), a failing
 * database is no place to record its own failure, and the first sync after
 * a restart brings a persistent failure back; lifecycle.log keeps the
 * history across restarts.
 */
export interface UsageFactSyncLifecycleEntry {
  event: 'usage-facts-sync-failed' | 'usage-facts-sync-recovered'
  /** Error name, code and count only: an error message can name a session or a path. */
  fields: { errorName: string; errorCode: string | null; consecutiveFailures: number }
}

export function describeUsageFactSyncError(error: unknown): { errorName: string; errorCode: string | null } {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: code === undefined || code === null ? null : String(code)
  }
}

export class UsageFactSyncFailureTracker {
  private failure: UsageFactSyncFailure | null = null

  /** The current failure streak; null once a sync has committed since. */
  current(): UsageFactSyncFailure | null {
    return this.failure ? { ...this.failure } : null
  }

  /**
   * Count one failed sync. Returns the lifecycle entry to write for the
   * first failure of a streak and for a changed error; null while the same
   * error repeats.
   */
  recordFailure(error: unknown, at: Date = new Date()): UsageFactSyncLifecycleEntry | null {
    const { errorName, errorCode } = describeUsageFactSyncError(error)
    const previous = this.failure
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1
    this.failure = { at: at.toISOString(), errorName, errorCode, consecutiveFailures }
    if (previous && previous.errorName === errorName && previous.errorCode === errorCode) return null
    return { event: 'usage-facts-sync-failed', fields: { errorName, errorCode, consecutiveFailures } }
  }

  /** A committed sync ends the streak; returns the recovery entry when there was one. */
  recordSuccess(): UsageFactSyncLifecycleEntry | null {
    const previous = this.failure
    this.failure = null
    if (!previous) return null
    return {
      event: 'usage-facts-sync-recovered',
      fields: {
        errorName: previous.errorName,
        errorCode: previous.errorCode,
        consecutiveFailures: previous.consecutiveFailures
      }
    }
  }
}
