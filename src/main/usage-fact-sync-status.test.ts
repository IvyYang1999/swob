import { describe, expect, it } from 'vitest'
import { describeUsageFactSyncError, UsageFactSyncFailureTracker } from './usage-fact-sync-status'

function codedError(name: string, code?: string, message = 'failed for session ses_secret in /Users/someone'): Error {
  const error = new Error(message) as Error & { code?: string }
  error.name = name
  if (code) error.code = code
  return error
}

describe('usage sync failure status (F1k)', () => {
  it('describes an error by its name and code only', () => {
    expect(describeUsageFactSyncError(codedError('SqliteError', 'SQLITE_CONSTRAINT_PRIMARYKEY')))
      .toEqual({ errorName: 'SqliteError', errorCode: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
    expect(describeUsageFactSyncError(new Error('plain'))).toEqual({ errorName: 'Error', errorCode: null })
    expect(describeUsageFactSyncError({ code: 5 })).toEqual({ errorName: 'object', errorCode: '5' })
    expect(describeUsageFactSyncError('boom')).toEqual({ errorName: 'string', errorCode: null })
  })

  it('counts a failure streak and asks for one lifecycle line per new error and one on recovery', () => {
    const tracker = new UsageFactSyncFailureTracker()
    expect(tracker.current()).toBeNull()
    expect(tracker.recordSuccess()).toBeNull()

    const primaryKey = codedError('SqliteError', 'SQLITE_CONSTRAINT_PRIMARYKEY')
    expect(tracker.recordFailure(primaryKey, new Date('2026-09-27T01:00:00.000Z'))).toEqual({
      event: 'usage-facts-sync-failed',
      fields: { errorName: 'SqliteError', errorCode: 'SQLITE_CONSTRAINT_PRIMARYKEY', consecutiveFailures: 1 }
    })
    // The same error again is counted, not written again.
    expect(tracker.recordFailure(primaryKey, new Date('2026-09-27T01:05:00.000Z'))).toBeNull()
    expect(tracker.current()).toEqual({
      at: '2026-09-27T01:05:00.000Z',
      errorName: 'SqliteError',
      errorCode: 'SQLITE_CONSTRAINT_PRIMARYKEY',
      consecutiveFailures: 2
    })
    // Another code is written; the streak goes on.
    expect(tracker.recordFailure(codedError('SqliteError', 'SQLITE_BUSY'), new Date('2026-09-27T01:10:00.000Z')))
      .toEqual({
        event: 'usage-facts-sync-failed',
        fields: { errorName: 'SqliteError', errorCode: 'SQLITE_BUSY', consecutiveFailures: 3 }
      })

    // A committed sync ends the streak once.
    expect(tracker.recordSuccess()).toEqual({
      event: 'usage-facts-sync-recovered',
      fields: { errorName: 'SqliteError', errorCode: 'SQLITE_BUSY', consecutiveFailures: 3 }
    })
    expect(tracker.current()).toBeNull()
    expect(tracker.recordSuccess()).toBeNull()

    // The next failure starts a new streak and is written again.
    expect(tracker.recordFailure(primaryKey)).toMatchObject({
      event: 'usage-facts-sync-failed',
      fields: { consecutiveFailures: 1 }
    })
  })

  it('never keeps the error message, which can name a session or a path', () => {
    const tracker = new UsageFactSyncFailureTracker()
    const entry = tracker.recordFailure(codedError(
      'UsageEventsHydrationRequiredError',
      'USAGE_EVENTS_HYDRATION_REQUIRED',
      'Usage events must be materialized for session ses_secret'
    ))
    expect(entry?.fields).toEqual({
      errorName: 'UsageEventsHydrationRequiredError',
      errorCode: 'USAGE_EVENTS_HYDRATION_REQUIRED',
      consecutiveFailures: 1
    })
    expect(JSON.stringify([entry, tracker.current()])).not.toMatch(/ses_secret|materialized|\/Users/)
  })

  it('hands out a copy of the current failure', () => {
    const tracker = new UsageFactSyncFailureTracker()
    tracker.recordFailure(codedError('SqliteError', 'SQLITE_BUSY'))
    const snapshot = tracker.current()!
    snapshot.consecutiveFailures = 99
    expect(tracker.current()?.consecutiveFailures).toBe(1)
  })
})
