import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  getLibraryHealthState,
  getLibraryHealth,
  getLibraryHealthRevision,
  transitionLibraryHealth,
  healthAfterSuccessfulLibraryWrite,
  resetLibraryHealth,
  recordLibraryDiagnostic,
  classifyLibraryError,
  onLibraryHealthChanged,
  onLibraryDiagnostic,
  computeSessionFreshness,
  findStaleSessions,
  freshnessDiagnosticFingerprint,
  getCompensationProgress,
  isCompensationRunning,
  cancelCompensation,
  closeCompensation,
  waitForCompensationIdle,
  configureLibraryHealthPersistence,
  clearLibraryHealthPersistence,
  updateLibraryWriterRecovery,
  resetCompensation,
  onCompensationUpdate,
  runCompensation,
  retryCompensation,
  enqueueCompensation,
  beginLibraryBackgroundSync,
  updateLibraryBackgroundProgress,
  updateLibraryBackgroundRecovery,
  finishLibraryBackgroundSync
} from './library-health'

describe('LibraryHealthStateMachine', () => {
  beforeEach(() => {
    clearLibraryHealthPersistence()
    resetLibraryHealth()
  })

  it('starts in initializing state', () => {
    expect(getLibraryHealthState()).toBe('initializing')
  })

  it('transitions to ready and records diagnostic', () => {
    const beforeRevision = getLibraryHealthRevision()
    transitionLibraryHealth('ready', 'INIT_COMPLETE', 'Library ready')
    expect(getLibraryHealthRevision()).toBe(beforeRevision + 1)
    expect(getLibraryHealthState()).toBe('ready')
    const snapshot = getLibraryHealth()
    expect(snapshot.state).toBe('ready')
    expect(snapshot.diagnostics.length).toBeGreaterThan(0)
    const last = snapshot.diagnostics[snapshot.diagnostics.length - 1]
    expect(last.errorCode).toBe('INIT_COMPLETE')
    expect(last.state).toBe('ready')
    expect(last.message).toBe('Library ready')
    expect(last.timestamp).toBeTruthy()
  })

  it('persists a new diagnostic even when the state is unchanged', () => {
    transitionLibraryHealth('ready', 'INIT_COMPLETE', 'done')
    const diagnosticsBefore = getLibraryHealth().diagnostics.length
    transitionLibraryHealth('ready', 'FOLLOW_UP', 'same state, new evidence')
    expect(getLibraryHealth().diagnostics.length).toBe(diagnosticsBefore + 1)
    expect(getLibraryHealth().reasonCode).toBe('FOLLOW_UP')
  })

  it('offers writer recovery even when an empty Library has no compensation entries', () => {
    transitionLibraryHealth('writer-blocked', 'WRITER_BUSY', 'busy')
    expect(getLibraryHealth().compensation.pending).toBe(0)
    expect(getLibraryHealth().availableActions).toContain('retry-compensation')
  })

  it('exposes writer recovery attempt, deadline, and last reason in the health snapshot', () => {
    const nextRetryAt = new Date(Date.now() + 30_000).toISOString()
    updateLibraryWriterRecovery({ attempt: 5, nextRetryAt, lastReason: 'timeout' })
    expect(getLibraryHealth().writerRecovery).toEqual({
      attempt: 5,
      nextRetryAt,
      lastReason: 'timeout'
    })
  })

  it('emits stateChanged events', () => {
    const handler = vi.fn()
    const unsubscribe = onLibraryHealthChanged(handler)
    transitionLibraryHealth('ready', 'INIT_COMPLETE', 'done')
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      schemaVersion: 1,
      state: 'ready',
      writeCapability: 'full'
    }))
    unsubscribe()
    transitionLibraryHealth('writer-blocked', 'WRITER_BUSY', 'busy')
    expect(handler).toHaveBeenCalledTimes(1) // no second call after unsubscribe
  })

  it('emits diagnostic events', () => {
    const handler = vi.fn()
    const unsubscribe = onLibraryDiagnostic(handler)
    recordLibraryDiagnostic('TEST_CODE', 'test message')
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].errorCode).toBe('TEST_CODE')
    unsubscribe()
  })

  it('caps diagnostics at 50 entries', () => {
    transitionLibraryHealth('ready', 'INIT', 'start')
    for (let i = 0; i < 60; i++) {
      recordLibraryDiagnostic(`EVENT_${i}`, `event ${i}`)
    }
    const snapshot = getLibraryHealth()
    expect(snapshot.diagnostics.length).toBe(50)
    // The oldest events should have been dropped
    expect(snapshot.diagnostics[0].errorCode).not.toBe('INIT')
  })

  it('reset returns to initializing', () => {
    transitionLibraryHealth('ready', 'INIT', 'done')
    expect(getLibraryHealthState()).toBe('ready')
    resetLibraryHealth()
    expect(getLibraryHealthState()).toBe('initializing')
  })

  it('keeps exact background failure counts while bounding renderer samples', () => {
    beginLibraryBackgroundSync(25)
    for (let index = 0; index < 25; index++) {
      updateLibraryBackgroundProgress({
        total: 25,
        completed: 0,
        failed: index + 1,
        remaining: 24 - index,
        failure: {
          sessionId: `failed-${index}`,
          reasonCode: index % 2 === 0 ? 'SESSION_CREATE_BUSY' : 'SESSION_SYNC_FAILED'
        }
      })
    }
    finishLibraryBackgroundSync()

    const backlog = getLibraryHealth().dimensions.backgroundBacklog
    expect(backlog.state).toBe('completed-with-errors')
    expect(backlog).toMatchObject({ total: 25, completed: 0, failed: 25, remaining: 0 })
    expect(backlog.failures).toHaveLength(20)
    expect(backlog.failureCounts).toEqual({ SESSION_CREATE_BUSY: 13, SESSION_SYNC_FAILED: 12 })
  })

  it('reports automatic backlog recovery without exposing writer-compensation controls', () => {
    transitionLibraryHealth('ready', 'READY', 'ready')
    updateLibraryBackgroundRecovery({
      state: 'scheduled',
      retryScheduled: 3,
      waitingProvider: 2,
      attentionRequired: 1,
      exhausted: 0,
      maxAttempts: 5,
      nextRetryAt: '2026-08-10T00:00:00.000Z'
    })
    expect(getLibraryHealth().dimensions.backgroundBacklog.recovery).toMatchObject({
      state: 'scheduled',
      retryScheduled: 3,
      waitingProvider: 2
    })
    expect(getLibraryHealth().availableActions).not.toContain('retry-compensation')
  })

  it('persists append-only redacted diagnostics outside the Library and reloads valid lines', () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-library-'))
    const diagnosticsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-diagnostics-'))
    try {
      configureLibraryHealthPersistence(libraryRoot, diagnosticsRoot)
      recordLibraryDiagnostic(
        'FIRST',
        'Failed /Users/private/Documents/secret.jsonl for 11111111-1111-4111-8111-111111111111',
        'timeout',
        {
          attempt: 5,
          nextRetryAt: '2026-08-08T00:00:30.000Z',
          lastReason: 'timeout'
        }
      )
      recordLibraryDiagnostic('SECOND', 'second event')
      const filePath = path.join(diagnosticsRoot, fs.readdirSync(diagnosticsRoot)[0])
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).not.toContain('/Users/private')
      expect(lines[0]).not.toContain('11111111-1111-4111-8111-111111111111')
      expect(JSON.parse(lines[0])).toMatchObject({
        reason: 'timeout',
        attempt: 5,
        nextRetryAt: '2026-08-08T00:00:30.000Z',
        lastReason: 'timeout'
      })

      fs.appendFileSync(filePath, '{torn')
      recordLibraryDiagnostic('AFTER_TORN', 'must remain parseable')
      clearLibraryHealthPersistence()
      configureLibraryHealthPersistence(libraryRoot, diagnosticsRoot)
      expect(getLibraryHealth().diagnostics.map((event) => event.errorCode))
        .toEqual(['FIRST', 'SECOND', 'AFTER_TORN'])
    } finally {
      clearLibraryHealthPersistence()
      fs.rmSync(libraryRoot, { recursive: true, force: true })
      fs.rmSync(diagnosticsRoot, { recursive: true, force: true })
    }
  })

  it('refuses to follow a symlink diagnostics directory', () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-library-'))
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-link-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-outside-'))
    const diagnosticsRoot = path.join(parent, 'diagnostics')
    try {
      fs.symlinkSync(outside, diagnosticsRoot)
      configureLibraryHealthPersistence(libraryRoot, diagnosticsRoot)
      recordLibraryDiagnostic('NO_ESCAPE', 'must not escape')
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      clearLibraryHealthPersistence()
      fs.rmSync(libraryRoot, { recursive: true, force: true })
      fs.rmSync(parent, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('classifyLibraryError', () => {
  it('classifies LibraryWriterBusyError as writer-blocked', () => {
    const error = Object.assign(new Error('busy'), {
      name: 'LibraryWriterBusyError',
      code: 'LIBRARY_WRITER_BUSY',
      reason: 'active-owner'
    })
    const result = classifyLibraryError(error)
    expect(result.state).toBe('writer-blocked')
    expect(result.errorCode).toBe('WRITER_BUSY_ACTIVE_OWNER')
    expect(result.message).toContain('another process')
  })

  it('assigns every writer reason an independent honest error code and message', () => {
    const expected = {
      'active-owner': 'WRITER_BUSY_ACTIVE_OWNER',
      'remote-owner': 'WRITER_BUSY_REMOTE_OWNER',
      'unverifiable-owner': 'WRITER_BUSY_UNVERIFIABLE_OWNER',
      'corrupt-owner': 'WRITER_BUSY_CORRUPT_OWNER',
      'recovery-in-progress': 'WRITER_BUSY_RECOVERY_IN_PROGRESS',
      timeout: 'WRITER_BUSY_TIMEOUT'
    } as const
    const codes = new Set<string>()
    for (const [reason, errorCode] of Object.entries(expected)) {
      const result = classifyLibraryError(Object.assign(new Error(reason), {
        name: 'LibraryWriterBusyError',
        code: 'LIBRARY_WRITER_BUSY',
        reason
      }))
      expect(result).toMatchObject({ errorCode, writerReason: reason })
      if (reason === 'active-owner') expect(result.message).toContain('another process')
      else expect(result.message).not.toContain('another process')
      codes.add(result.errorCode)
    }
    expect(codes.size).toBe(Object.keys(expected).length)
  })

  it('classifies writer identity failure without calling it busy', () => {
    const result = classifyLibraryError(Object.assign(new Error('identity unavailable'), {
      name: 'LibraryWriterIdentityUnavailableError',
      code: 'WRITER_IDENTITY_UNAVAILABLE'
    }))
    expect(result).toMatchObject({
      state: 'writer-blocked',
      errorCode: 'WRITER_IDENTITY_UNAVAILABLE',
      writerReason: 'identity-unavailable'
    })
    expect(result.message).not.toContain('another process')
  })

  it('classifies SessionIdentityConflictError as identity-conflict', () => {
    const error = Object.assign(new Error('conflict'), {
      name: 'SessionIdentityConflictError',
      code: 'SESSION_IDENTITY_CONFLICT'
    })
    const result = classifyLibraryError(error)
    expect(result.state).toBe('identity-conflict')
    expect(result.errorCode).toBe('IDENTITY_CONFLICT')
  })

  it('classifies EACCES as read-only', () => {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const result = classifyLibraryError(error)
    expect(result.state).toBe('read-only')
    expect(result.errorCode).toBe('PERMISSION_DENIED')
  })

  it('classifies ENOSPC as writer-blocked', () => {
    const error = Object.assign(new Error('no space'), { code: 'ENOSPC' })
    const result = classifyLibraryError(error)
    expect(result.state).toBe('writer-blocked')
    expect(result.errorCode).toBe('DISK_FULL')
  })

  it('classifies unknown errors as corrupt', () => {
    const result = classifyLibraryError(new Error('something weird'))
    expect(result.state).toBe('corrupt')
    expect(result.errorCode).toBe('INIT_FAILED')
  })

  it('redacts absolute paths from error messages', () => {
    const error = new Error('Failed to write /Users/secret/Documents/Swob/session/meta.json')
    const result = classifyLibraryError(error)
    expect(result.message).not.toContain('/Users/secret')
    expect(result.message).toContain('...')
  })

  it('handles null/undefined errors', () => {
    expect(classifyLibraryError(null).state).toBe('corrupt')
    expect(classifyLibraryError(undefined).state).toBe('corrupt')
  })
})

describe('writer recovery health decision', () => {
  it('never clears writer-blocked after a parse-only success', () => {
    expect(healthAfterSuccessfulLibraryWrite('writer-blocked', false, 0)).toBeNull()
  })

  it('preserves partial identity-conflict after a proven writer success', () => {
    expect(healthAfterSuccessfulLibraryWrite('writer-blocked', true, 2)).toBe('identity-conflict')
    expect(healthAfterSuccessfulLibraryWrite('writer-blocked', true, 0)).toBe('ready')
  })
})

describe('computeSessionFreshness', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns unverifiable rather than a false zero when no source files exist', () => {
    const freshness = computeSessionFreshness('test-session', tmpDir, [])
    expect(freshness.sessionId).toBe('test-session')
    expect(freshness.sourceUpdatedAt).toBeNull()
    expect(freshness.transcriptUpdatedAt).toBeNull()
    expect(freshness.backupUpdatedAt).toBeNull()
    expect(freshness.lagMs).toBeNull()
    expect(freshness.status).toBe('unverifiable')
    expect(freshness.stale).toBe(false)
  })

  it('detects transcript mtime', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    fs.writeFileSync(transcriptPath, '# test')
    const freshness = computeSessionFreshness('test-session', tmpDir, [])
    expect(freshness.transcriptUpdatedAt).toBeTruthy()
  })

  it('detects backup mtime', () => {
    const backupPath = path.join(tmpDir, 'backup.jsonl')
    fs.writeFileSync(backupPath, '{}')
    const freshness = computeSessionFreshness('test-session', tmpDir, [])
    expect(freshness.backupUpdatedAt).toBeTruthy()
  })

  it('computes positive lag for old source files', () => {
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    fs.writeFileSync(sourcePath, '{}')
    // Set mtime to 2 minutes ago
    const twoMinutesAgo = new Date(Date.now() - 120_000)
    fs.utimesSync(sourcePath, twoMinutesAgo, twoMinutesAgo)
    const freshness = computeSessionFreshness('test-session', tmpDir, [sourcePath])
    expect(freshness.sourceUpdatedAt).toBeTruthy()
    expect(freshness.lagMs).toBeGreaterThan(100_000)
  })

  it('reports zero lag for an old session whose source, transcript, and backup agree', () => {
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    const backupPath = path.join(tmpDir, 'backup.jsonl')
    for (const filePath of [sourcePath, transcriptPath, backupPath]) fs.writeFileSync(filePath, '{}')
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000)
    for (const filePath of [sourcePath, transcriptPath, backupPath]) {
      fs.utimesSync(filePath, oneWeekAgo, oneWeekAgo)
    }

    expect(computeSessionFreshness('old-but-synced', tmpDir, [sourcePath]).lagMs).toBeLessThan(10)
  })

  it('uses the slower of transcript and backup replicas', () => {
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    const backupPath = path.join(tmpDir, 'backup.jsonl')
    for (const filePath of [sourcePath, transcriptPath, backupPath]) fs.writeFileSync(filePath, '{}')
    const twoMinutesAgo = new Date(Date.now() - 120_000)
    fs.utimesSync(backupPath, twoMinutesAgo, twoMinutesAgo)

    const freshness = computeSessionFreshness('backup-behind', tmpDir, [sourcePath])
    expect(freshness.lagMs).toBeGreaterThan(100_000)
  })

  it('does not infer stale state when a remote source is unavailable', () => {
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    const backupPath = path.join(tmpDir, 'backup.jsonl')
    fs.writeFileSync(transcriptPath, '# remote')
    fs.writeFileSync(backupPath, '{}')
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000)
    fs.utimesSync(transcriptPath, oneWeekAgo, oneWeekAgo)
    fs.utimesSync(backupPath, oneWeekAgo, oneWeekAgo)

    const freshness = computeSessionFreshness('remote', tmpDir, ['/missing/remote/source.jsonl'])
    expect(freshness.lagMs).toBeNull()
    expect(freshness.status).toBe('unverifiable')
    expect(freshness.stale).toBe(false)
  })

  it('treats canonical records plus transcript as complete without backup.jsonl', () => {
    const recordsPath = path.join(tmpDir, 'canonical-records.json')
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    fs.writeFileSync(recordsPath, '{}')
    fs.writeFileSync(transcriptPath, '# canonical')
    const freshness = computeSessionFreshness('canonical', tmpDir, [], {
      canonicalRecordsFile: 'canonical-records.json'
    })
    expect(freshness.basis).toBe('canonical-records')
    expect(freshness.requiredArtifacts).toEqual(['canonical-records', 'transcript'])
    expect(freshness.backupUpdatedAt).toBeNull()
    expect(freshness.stale).toBe(false)
  })

  it('uses strict 60 second stale and 5 minute error boundaries for a missing replica', () => {
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    fs.writeFileSync(sourcePath, '{}')
    const now = Date.now()

    fs.utimesSync(sourcePath, new Date(now - 59_999), new Date(now - 59_999))
    const syncing = computeSessionFreshness('boundary', tmpDir, [sourcePath], { now: () => now })
    expect(syncing.status).toBe('syncing')
    expect(syncing.stale).toBe(false)

    fs.utimesSync(sourcePath, new Date(now - 60_001), new Date(now - 60_001))
    const stale = computeSessionFreshness('boundary', tmpDir, [sourcePath], { now: () => now })
    expect(stale.status).toBe('stale')
    expect(stale.severity).toBe('warning')

    fs.utimesSync(sourcePath, new Date(now - 300_001), new Date(now - 300_001))
    expect(computeSessionFreshness('boundary', tmpDir, [sourcePath], { now: () => now }).severity)
      .toBe('error')
  })

  it('marks future authoritative timestamps unverifiable instead of fresh', () => {
    const sourcePath = path.join(tmpDir, 'future.jsonl')
    fs.writeFileSync(sourcePath, '{}')
    const now = Date.now()
    fs.utimesSync(sourcePath, new Date(now + 60_000), new Date(now + 60_000))
    const freshness = computeSessionFreshness('future', tmpDir, [sourcePath], { now: () => now })
    expect(freshness.status).toBe('unverifiable')
    expect(freshness.reasons).toContain('CLOCK_SKEW')
    expect(freshness.lagMs).toBeNull()
  })

  it('stats a physical database behind a provider virtual # locator', () => {
    const databasePath = path.join(tmpDir, 'state.db')
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    const backupPath = path.join(tmpDir, 'backup.jsonl')
    fs.writeFileSync(databasePath, 'db')
    fs.writeFileSync(transcriptPath, '# transcript')
    fs.writeFileSync(backupPath, '{}')
    const freshness = computeSessionFreshness('virtual', tmpDir, [`${databasePath}#row-1`])
    expect(freshness.basis).toBe('local-source')
    expect(freshness.status).toBe('fresh')
    expect(freshness.lagMs).not.toBeNull()
  })

  it('picks the most recent source file mtime', () => {
    const oldSource = path.join(tmpDir, 'old.jsonl')
    const newSource = path.join(tmpDir, 'new.jsonl')
    fs.writeFileSync(oldSource, '{}')
    fs.writeFileSync(newSource, '{}')
    const tenMinutesAgo = new Date(Date.now() - 600_000)
    fs.utimesSync(oldSource, tenMinutesAgo, tenMinutesAgo)
    const freshness = computeSessionFreshness('test-session', tmpDir, [oldSource, newSource])
    // The lag should be based on the newer source, not the older one
    expect(freshness.lagMs).toBeLessThan(60_000)
  })
})

describe('freshnessDiagnosticFingerprint', () => {
  it('does not create a new incident merely because lag keeps growing', () => {
    const base = {
      schemaVersion: 1 as const,
      sessionId: 'session-a',
      basis: 'local-source' as const,
      status: 'stale' as const,
      severity: 'error' as const,
      stale: true,
      sourceUpdatedAt: '2026-08-02T00:00:00.000Z',
      canonicalUpdatedAt: null,
      transcriptUpdatedAt: null,
      backupUpdatedAt: null,
      requiredArtifacts: ['transcript', 'backup'] as const,
      thresholdMs: 60_000,
      reasons: ['TRANSCRIPT_MISSING', 'BACKUP_MISSING']
    }
    expect(freshnessDiagnosticFingerprint([{ ...base, lagMs: 300_001 }]))
      .toBe(freshnessDiagnosticFingerprint([{ ...base, lagMs: 330_001 }]))
  })
})

describe('findStaleSessions', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-stale-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns empty for fresh sessions', () => {
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    fs.writeFileSync(sourcePath, '{}')
    const result = findStaleSessions([{
      sessionId: 'fresh',
      dirPath: tmpDir,
      sourceFilePaths: [sourcePath]
    }], 60_000)
    expect(result).toHaveLength(0)
  })

  it('returns sessions exceeding the threshold', () => {
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    fs.writeFileSync(sourcePath, '{}')
    const fiveMinutesAgo = new Date(Date.now() - 300_000)
    fs.utimesSync(sourcePath, fiveMinutesAgo, fiveMinutesAgo)
    const result = findStaleSessions([{
      sessionId: 'stale',
      dirPath: tmpDir,
      sourceFilePaths: [sourcePath]
    }], 60_000)
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('stale')
  })

  it('returns a DTO consistent with a caller-supplied threshold', () => {
    const sourcePath = path.join(tmpDir, 'source-45s.jsonl')
    fs.writeFileSync(sourcePath, '{}')
    const sourceTime = new Date(Date.now() - 45_000)
    fs.utimesSync(sourcePath, sourceTime, sourceTime)
    const [freshness] = findStaleSessions([{
      sessionId: 'custom-threshold',
      dirPath: tmpDir,
      sourceFilePaths: [sourcePath]
    }], 30_000)
    expect(freshness).toMatchObject({
      status: 'stale',
      stale: true,
      thresholdMs: 30_000
    })
    expect(freshness.lagMs).toBeGreaterThan(40_000)
  })

  it('normalizes an invalid custom threshold before filtering and building the DTO', () => {
    const sourcePath = path.join(tmpDir, 'source-invalid-threshold.jsonl')
    const transcriptPath = path.join(tmpDir, 'transcript.md')
    const backupPath = path.join(tmpDir, 'backup.jsonl')
    for (const filePath of [sourcePath, transcriptPath, backupPath]) fs.writeFileSync(filePath, '{}')
    const old = new Date(Date.now() - 45_000)
    fs.utimesSync(transcriptPath, old, old)
    fs.utimesSync(backupPath, old, old)
    expect(findStaleSessions([{
      sessionId: 'invalid-threshold',
      dirPath: tmpDir,
      sourceFilePaths: [sourcePath]
    }], -1)).toEqual([])
  })
})

describe('CompensationQueue', () => {
  beforeEach(() => {
    resetCompensation()
  })

  it('starts with empty progress', () => {
    const progress = getCompensationProgress()
    expect(progress).toEqual({
      total: 0, completed: 0, failed: 0, pending: 0, inProgress: false, cancelled: false
    })
    expect(isCompensationRunning()).toBe(false)
  })

  it('processes enqueued entries', async () => {
    const processed: string[] = []
    enqueueCompensation([
      { sessionId: 'a', dirPath: '/tmp/a' },
      { sessionId: 'b', dirPath: '/tmp/b' }
    ])
    const result = await runCompensation(async (sessionId) => {
      processed.push(sessionId)
    })
    expect(result.total).toBe(2)
    expect(result.completed).toBe(2)
    expect(result.failed).toBe(0)
    expect(processed).toEqual(['a', 'b'])
  })

  it('tracks failed entries', async () => {
    enqueueCompensation([
      { sessionId: 'ok', dirPath: '/tmp/ok' },
      { sessionId: 'fail', dirPath: '/tmp/fail' }
    ])
    const result = await runCompensation(async (sessionId) => {
      if (sessionId === 'fail') throw new Error('boom')
    })
    expect(result.completed).toBe(1)
    expect(result.failed).toBe(1)

    const retried: string[] = []
    const retry = await runCompensation(async (sessionId) => {
      retried.push(sessionId)
    })
    expect(retried).toEqual(['fail'])
    expect(retry).toEqual({
      total: 1, completed: 1, failed: 0, pending: 0, inProgress: false, cancelled: false
    })
  })

  it('emits progress updates', async () => {
    const updates: Array<{ total: number; completed: number; failed: number }> = []
    const unsubscribe = onCompensationUpdate((progress) => {
      updates.push({ ...progress })
    })
    enqueueCompensation([{ sessionId: 'x', dirPath: '/tmp/x' }])
    await runCompensation(async () => {})
    unsubscribe()
    expect(updates.length).toBeGreaterThanOrEqual(2) // enqueue + completion
    const last = updates[updates.length - 1]
    expect(last.completed).toBe(1)
  })

  it('deduplicates entries by sessionId', () => {
    enqueueCompensation([
      { sessionId: 'dup', dirPath: '/tmp/a' },
      { sessionId: 'dup', dirPath: '/tmp/b' }
    ])
    const progress = getCompensationProgress()
    expect(progress.total).toBe(1)
  })

  it('supports cancellation', async () => {
    enqueueCompensation([
      { sessionId: 'a', dirPath: '/tmp/a' },
      { sessionId: 'b', dirPath: '/tmp/b' },
      { sessionId: 'c', dirPath: '/tmp/c' }
    ])
    const processed: string[] = []
    // Cancel after first batch
    const result = await runCompensation(async (sessionId) => {
      processed.push(sessionId)
      cancelCompensation()
    })
    // The queue intentionally serializes Library writers to avoid lease self-contention.
    expect(processed).toHaveLength(1)
    expect(result.total).toBe(3)
    await expect(waitForCompensationIdle()).resolves.toBeUndefined()

    const remaining: string[] = []
    await runCompensation(async (sessionId) => { remaining.push(sessionId) })
    expect(remaining).toEqual([])
    await retryCompensation(async (sessionId) => { remaining.push(sessionId) })
    expect([...processed, ...remaining].sort()).toEqual(['a', 'b', 'c'])
  })

  it('cancel before run is terminal until an explicit retry', async () => {
    enqueueCompensation([{ sessionId: 'a', dirPath: '/tmp/a' }])
    cancelCompensation()
    const processor = vi.fn(async () => {})
    await runCompensation(processor)
    expect(processor).not.toHaveBeenCalled()
    expect(getCompensationProgress().cancelled).toBe(true)
    await retryCompensation(processor)
    expect(processor).toHaveBeenCalledTimes(1)
  })

  it('close rejects late enqueue and run during shutdown drain', async () => {
    enqueueCompensation([{ sessionId: 'before', dirPath: '/tmp/before' }])
    closeCompensation()
    enqueueCompensation([{ sessionId: 'late', dirPath: '/tmp/late' }])
    const processed: string[] = []
    await runCompensation(async (sessionId) => { processed.push(sessionId) })
    expect(processed).toEqual([])
    expect(getCompensationProgress()).toMatchObject({ pending: 1, cancelled: true })
  })

  it('close drains the active item without starting queued or late work', async () => {
    enqueueCompensation([
      { sessionId: 'active', dirPath: '/tmp/active' },
      { sessionId: 'queued', dirPath: '/tmp/queued' }
    ])
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const processed: string[] = []
    const running = runCompensation(async (sessionId) => {
      processed.push(sessionId)
      await blocked
    })
    await vi.waitFor(() => expect(processed).toEqual(['active']))
    closeCompensation()
    enqueueCompensation([{ sessionId: 'late', dirPath: '/tmp/late' }])
    release()
    await running
    await waitForCompensationIdle()
    expect(processed).toEqual(['active'])
    expect(getCompensationProgress()).toMatchObject({
      pending: 1,
      inProgress: false,
      cancelled: true
    })
  })
})
