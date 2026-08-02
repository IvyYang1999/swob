import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  getLibraryHealthState,
  getLibraryHealth,
  transitionLibraryHealth,
  resetLibraryHealth,
  recordLibraryDiagnostic,
  classifyLibraryError,
  onLibraryHealthChanged,
  onLibraryDiagnostic,
  computeSessionFreshness,
  findStaleSessions,
  getCompensationProgress,
  isCompensationRunning,
  cancelCompensation,
  resetCompensation,
  onCompensationUpdate,
  runCompensation,
  enqueueCompensation
} from './library-health'

describe('LibraryHealthStateMachine', () => {
  beforeEach(() => {
    resetLibraryHealth()
  })

  it('starts in initializing state', () => {
    expect(getLibraryHealthState()).toBe('initializing')
  })

  it('transitions to ready and records diagnostic', () => {
    transitionLibraryHealth('ready', 'INIT_COMPLETE', 'Library ready')
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

  it('ignores noop transitions (same state)', () => {
    transitionLibraryHealth('ready', 'INIT_COMPLETE', 'done')
    const diagnosticsBefore = getLibraryHealth().diagnostics.length
    transitionLibraryHealth('ready', 'DUPLICATE', 'should not appear')
    expect(getLibraryHealth().diagnostics.length).toBe(diagnosticsBefore)
  })

  it('emits stateChanged events', () => {
    const handler = vi.fn()
    const unsubscribe = onLibraryHealthChanged(handler)
    transitionLibraryHealth('ready', 'INIT_COMPLETE', 'done')
    expect(handler).toHaveBeenCalledWith({
      previous: 'initializing',
      current: 'ready'
    })
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
})

describe('classifyLibraryError', () => {
  it('classifies LibraryWriterBusyError as writer-blocked', () => {
    const error = Object.assign(new Error('busy'), { name: 'LibraryWriterBusyError' })
    const result = classifyLibraryError(error)
    expect(result.state).toBe('writer-blocked')
    expect(result.errorCode).toBe('WRITER_BUSY')
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

describe('computeSessionFreshness', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-health-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns zero lag when no source files exist', () => {
    const freshness = computeSessionFreshness('test-session', tmpDir, [])
    expect(freshness.sessionId).toBe('test-session')
    expect(freshness.sourceUpdatedAt).toBeNull()
    expect(freshness.transcriptUpdatedAt).toBeNull()
    expect(freshness.backupUpdatedAt).toBeNull()
    expect(freshness.lagMs).toBe(0)
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
})

describe('CompensationQueue', () => {
  beforeEach(() => {
    resetCompensation()
  })

  it('starts with empty progress', () => {
    const progress = getCompensationProgress()
    expect(progress).toEqual({ total: 0, completed: 0, failed: 0 })
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
    // Should have processed the first batch (concurrency=2) then stopped
    expect(processed.length).toBeLessThanOrEqual(2)
    expect(result.total).toBe(3)
  })
})
