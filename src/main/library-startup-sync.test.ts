import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LIBRARY_STARTUP_BATCH_SIZE,
  LibraryStartupBatchTransportError,
  runLibraryStartupTransaction,
  buildLibraryStartupPlan,
  completeLibraryStartupCheckpoint,
  describeLibraryStartupSession,
  parseLibraryStartupCheckpoint,
  summarizeLibraryStartupRecovery,
  selectCurrentProjectionReconciliationIndexes,
  syncLibraryStartupIncrementally,
  updateLibraryStartupCheckpointAfterBatch,
  type LibraryStartupCheckpoint,
  type LibraryStartupPlan
} from './library-startup-sync'
import { SessionSyncCoordinator } from './session-sync-coordinator'
import type { SessionSummary } from './types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function summary(sessionId: string, filePath: string, updatedAt: string): SessionSummary {
  return {
    id: sessionId,
    sessionId,
    slug: '',
    filePath,
    fileSizeBytes: 0,
    allFilePaths: [filePath],
    source: 'codex',
    firstUserMessage: sessionId,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    turnCount: 1,
    compactCount: 0,
    cwds: ['/fixture/project'],
    version: '',
    toolUsage: {},
    skillInvocations: [],
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    projectPath: '/fixture/project',
    resumeCwd: '/fixture/project'
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function completePlan(
  plan: LibraryStartupPlan,
  sessions: readonly SessionSummary[]
): LibraryStartupCheckpoint {
  let checkpoint = plan.checkpoint
  for (let offset = 0; offset < plan.dirtyIndexes.length; offset += LIBRARY_STARTUP_BATCH_SIZE) {
    checkpoint = completeLibraryStartupCheckpoint(
      checkpoint,
      plan.dirtyIndexes.slice(offset, offset + LIBRARY_STARTUP_BATCH_SIZE)
        .map((index) => sessions[index])
    )
  }
  return checkpoint
}

describe('incremental Library startup synchronization', () => {
  it('keeps projections gated through a no-op live drain until the first startup chunk completes', async () => {
    const events: string[] = []
    await syncLibraryStartupIncrementally({
      sessions: [summary('cold', '/fixture/cold.jsonl', '2026-08-02T09:00:00.000Z')],
      probeWriter: async () => { events.push('probe') },
      onWriterProven: () => { events.push('writer-proven') },
      drainLive: async () => {
        events.push('no-live-commit')
        return false
      },
      resolveLatest: (session) => session,
      syncChunk: async () => {
        events.push('startup-chunk')
        return { total: 1, completed: 1, skipped: [] }
      },
      onFirstDurableBoundary: () => { events.push('projection-open') }
    })

    expect(events.indexOf('projection-open')).toBeGreaterThan(events.indexOf('startup-chunk'))
    expect(events.slice(0, 3)).toEqual(['probe', 'writer-proven', 'no-live-commit'])
  })

  it('opens an empty Library after writer proof because no session commit can exist', async () => {
    const boundary = vi.fn()
    await syncLibraryStartupIncrementally({
      sessions: [],
      probeWriter: async () => {},
      onWriterProven: () => {},
      drainLive: async () => false,
      resolveLatest: (session) => session,
      syncChunk: async () => ({ total: 0, completed: 0, skipped: [] }),
      onFirstDurableBoundary: boundary
    })
    expect(boundary).toHaveBeenCalledTimes(1)
  })

  it('does not treat a read-only identity skip as the first durable startup boundary', async () => {
    const events: string[] = []
    await syncLibraryStartupIncrementally({
      sessions: [
        summary('conflict', '/fixture/conflict.jsonl', '2026-08-02T09:00:00.000Z'),
        summary('writable', '/fixture/writable.jsonl', '2026-08-02T09:00:01.000Z')
      ],
      probeWriter: async () => {},
      onWriterProven: () => {},
      drainLive: async () => false,
      resolveLatest: (session) => session,
      syncChunk: async (session) => {
        events.push(`chunk:${session.sessionId}`)
        return session.sessionId === 'conflict'
          ? {
              total: 1,
              completed: 1,
              skipped: [{
                sessionId: session.sessionId,
                code: 'SESSION_IDENTITY_CONFLICT',
                disposition: 'handled',
                retryable: false
              }]
            }
          : { total: 1, completed: 1, skipped: [] }
      },
      onFirstDurableBoundary: () => { events.push('projection-open') }
    })

    expect(events).toEqual([
      'chunk:conflict',
      'chunk:writable',
      'projection-open'
    ])
  })

  it('reports handled, failed, and remaining as disjoint progress states', async () => {
    const sessions = [
      summary('missing', '/fixture/missing.jsonl', '2026-08-02T09:00:00.000Z'),
      summary('busy', '/fixture/busy.jsonl', '2026-08-02T09:00:01.000Z'),
      summary('written', '/fixture/written.jsonl', '2026-08-02T09:00:02.000Z')
    ]
    const progress: Array<{ completed: number; failed: number; remaining: number }> = []
    const outcome = await syncLibraryStartupIncrementally({
      sessions,
      batchSize: 3,
      probeWriter: async () => {},
      onWriterProven: () => {},
      drainLive: async () => false,
      resolveLatest: (session) => session,
      syncBatch: async () => ({
        total: 3,
        completed: 2,
        skipped: [
          {
            sessionId: 'missing',
            code: 'SESSION_SOURCE_MISSING',
            disposition: 'handled',
            retryable: false
          },
          {
            sessionId: 'busy',
            code: 'SESSION_CREATE_BUSY',
            disposition: 'failed',
            retryable: true
          }
        ]
      }),
      onProgress: (value) => progress.push(value)
    })

    expect(outcome).toMatchObject({ total: 3, completed: 2 })
    expect(progress).toHaveLength(3)
    expect(progress.at(-1)).toMatchObject({ completed: 2, failed: 1, remaining: 0 })
  })

  it('completes startup while multi-key live events continue below the quiet window', async () => {
    vi.useFakeTimers()
    let sourceGeneration = 1
    let backupGeneration = 0
    let transcriptGeneration = 0
    let completedStartupChunks = 0
    let active = 0
    let peak = 0
    const served: string[] = []
    const coordinator = new SessionSyncCoordinator({
      quietWindowMs: 2_000,
      concurrency: 1,
      sync: async (request) => {
        active++
        peak = Math.max(peak, active)
        served.push(request.sessionId || '')
        backupGeneration = sourceGeneration
        transcriptGeneration = sourceGeneration
        active--
      }
    })
    const sessions = Array.from({ length: 6 }, (_, index) =>
      summary(`startup-${index}`, `/fixture/startup-${index}.jsonl`, `2026-08-02T09:00:0${index}.000Z`))

    try {
      const outcome = await syncLibraryStartupIncrementally({
        sessions,
        probeWriter: async () => {},
        onWriterProven: () => {
          coordinator.schedule({ sessionId: 'b', filePath: '/tmp/b.jsonl' })
          coordinator.schedule({ sessionId: 'c', filePath: '/tmp/c.jsonl' })
          coordinator.schedule({ sessionId: 'a', filePath: '/tmp/a.jsonl' })
        },
        resolveLatest: (session) => session,
        drainLive: () => coordinator.flushPendingSnapshot({ maxEntries: 2 }).then(() => undefined),
        syncChunk: async () => {
          completedStartupChunks++
          sourceGeneration++
          coordinator.schedule({ sessionId: 'a', filePath: '/tmp/a.jsonl' })
          await vi.advanceTimersByTimeAsync(50)
          return { total: 1, completed: 1, skipped: [] }
        }
      })

      expect(outcome.completed).toBe(6)
      expect(completedStartupChunks).toBe(6)
      expect(backupGeneration).toBe(sourceGeneration)
      expect(transcriptGeneration).toBe(sourceGeneration)
      expect(served).toContain('a')
      expect(served).toContain('b')
      expect(served).toContain('c')
      expect(peak).toBe(1)
      expect(active).toBe(0)
    } finally {
      coordinator.stop()
      vi.useRealTimers()
    }
  })

  it('does not publish writer proof or run live/chunk work when the probe fails', async () => {
    const onWriterProven = vi.fn()
    const drainLive = vi.fn(async () => {})
    const syncChunk = vi.fn(async () => ({ total: 1, completed: 1, skipped: [] }))
    await expect(syncLibraryStartupIncrementally({
      sessions: [summary('blocked', '/fixture/blocked.jsonl', '2026-08-02T09:00:00.000Z')],
      probeWriter: async () => { throw new Error('writer blocked') },
      onWriterProven,
      drainLive,
      syncChunk,
      resolveLatest: (session) => session
    })).rejects.toThrow('writer blocked')
    expect(onWriterProven).not.toHaveBeenCalled()
    expect(drainLive).not.toHaveBeenCalled()
    expect(syncChunk).not.toHaveBeenCalled()
  })

  it('wraps a whole production batch writer failure without fabricating item outcomes', async () => {
    const progress = vi.fn()
    const error = Object.assign(new Error('writer identity unavailable'), {
      code: 'WRITER_IDENTITY_UNAVAILABLE',
      name: 'SessionCreateIdentityUnavailableError'
    })
    const failure = await syncLibraryStartupIncrementally({
      sessions: [
        summary('first', '/fixture/first.jsonl', '2026-08-02T09:00:00.000Z'),
        summary('second', '/fixture/second.jsonl', '2026-08-02T09:00:01.000Z')
      ],
      probeWriter: async () => {},
      onWriterProven: () => {},
      drainLive: async () => false,
      resolveLatest: (session) => session,
      syncBatch: async () => { throw error },
      onProgress: progress
    }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(LibraryStartupBatchTransportError)
    expect((failure as Error).cause).toBe(error)
    expect(progress).not.toHaveBeenCalled()
  })

  it('propagates a production batch transport failure without fabricating unpersisted skips', async () => {
    const error = new Error('library-worker-invalid-reply')
    const syncBatch = vi.fn(async () => { throw error })
    const progress = vi.fn()
    const failure = await syncLibraryStartupIncrementally({
      sessions: [
        summary('first', '/fixture/first.jsonl', '2026-08-02T09:00:00.000Z'),
        summary('second', '/fixture/second.jsonl', '2026-08-02T09:00:01.000Z')
      ],
      batchSize: 2,
      probeWriter: async () => {},
      onWriterProven: () => {},
      drainLive: async () => false,
      resolveLatest: (session) => session,
      syncBatch,
      onProgress: progress
    }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(LibraryStartupBatchTransportError)
    expect((failure as Error).cause).toBe(error)
    expect(syncBatch).toHaveBeenCalledTimes(1)
    expect(progress).not.toHaveBeenCalled()
  })

  it('wraps plan and barrier rejection at the whole startup transaction boundary', async () => {
    const planFailure = new Error('worker-plan-invalid-reply')
    const failure = await runLibraryStartupTransaction(async () => { throw planFailure })
      .catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(LibraryStartupBatchTransportError)
    expect((failure as Error).cause).toBe(planFailure)

    const lifecycle = Object.assign(new Error('root changed'), { name: 'AbortError' })
    await expect(runLibraryStartupTransaction(async () => { throw lifecycle })).rejects.toBe(lifecycle)
  })

  it('publishes a follow-up source write before startup finishes and never replays the old summary', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-live-'))
    roots.push(root)
    const sourcePath = path.join(root, 'active.jsonl')
    const backupPath = path.join(root, 'backup.jsonl')
    const transcriptPath = path.join(root, 'transcript.md')
    fs.writeFileSync(sourcePath, '{"turn":1}\n')
    fs.writeFileSync(backupPath, fs.readFileSync(sourcePath))
    fs.writeFileSync(transcriptPath, 'turn 1\n')

    const slowChunk = deferred()
    const finishStartup = deferred()
    const initialActive = summary('active', sourcePath, '2026-08-02T09:00:00.000Z')
    let latestActive = initialActive
    let livePending = false
    let startupFinished = false
    const chunks: SessionSummary[] = []

    const startup = syncLibraryStartupIncrementally({
      sessions: [
        summary('slow', path.join(root, 'slow.jsonl'), '2026-08-02T08:00:00.000Z'),
        initialActive,
        summary('tail', path.join(root, 'tail.jsonl'), '2026-08-02T07:00:00.000Z')
      ],
      probeWriter: async () => {},
      onWriterProven: () => {},
      resolveLatest: (initial) => initial.sessionId === 'active' ? latestActive : initial,
      syncChunk: async (session) => {
        chunks.push(session)
        if (session.sessionId === 'slow') await slowChunk.promise
        if (session.sessionId === 'tail') await finishStartup.promise
        return { total: 1, completed: 1, skipped: [] }
      },
      drainLive: async () => {
        if (!livePending) return
        livePending = false
        const bytes = fs.readFileSync(sourcePath)
        fs.writeFileSync(backupPath, bytes)
        fs.writeFileSync(transcriptPath, 'turn 1\nturn 2\n')
        latestActive = summary('active', sourcePath, '2026-08-02T09:01:00.000Z')
      }
    }).finally(() => { startupFinished = true })

    await vi.waitFor(() => expect(chunks.map((entry) => entry.sessionId)).toEqual(['slow']))
    fs.appendFileSync(sourcePath, '{"turn":2}\n')
    livePending = true
    slowChunk.resolve()

    await vi.waitFor(() => {
      expect(fs.readFileSync(backupPath)).toEqual(fs.readFileSync(sourcePath))
      expect(fs.readFileSync(transcriptPath, 'utf8')).toContain('turn 2')
    })
    expect(startupFinished).toBe(false)
    await vi.waitFor(() => expect(chunks.map((entry) => entry.sessionId)).toEqual(['slow', 'active', 'tail']))
    expect(chunks[1].updatedAt).toBe('2026-08-02T09:01:00.000Z')

    finishStartup.resolve()
    await startup
    expect(startupFinished).toBe(true)
  })
})

describe('Library startup dirty-set checkpoint', () => {
  it('migrates v1 checkpoints without inventing recovery work', () => {
    const parsed = parseLibraryStartupCheckpoint({
      version: 1,
      snapshotDigest: 'digest',
      schemaGeneration: 1,
      completedKeys: ['done'],
      dirtyKeys: ['dirty'],
      completedFingerprints: { done: 'fingerprint' }
    })
    expect(parsed).toMatchObject({ version: 2, recovery: {} })
  })

  it('persists bounded transient retries and resets them only when source evidence changes', () => {
    const session = summary('retry', '/fixture/retry.jsonl', '2026-08-02T09:00:00.000Z')
    let checkpoint = buildLibraryStartupPlan([session], 1, null).checkpoint
    for (let attempt = 1; attempt <= 5; attempt++) {
      checkpoint = updateLibraryStartupCheckpointAfterBatch(checkpoint, [session], {
        total: 1,
        completed: 0,
        skipped: [{
          sessionId: session.sessionId,
          code: 'SESSION_SYNC_FAILED',
          disposition: 'failed',
          retryable: true
        }]
      }, {}, Date.parse(`2026-08-02T09:00:0${attempt}.000Z`)).checkpoint
    }
    expect(summarizeLibraryStartupRecovery(checkpoint.recovery)).toMatchObject({
      retryScheduled: 0,
      exhausted: 1,
      maxAttempts: 5,
      nextRetryAt: null
    })
    expect(Object.values(checkpoint.recovery)[0]).toMatchObject({ state: 'exhausted', attempt: 5 })

    const changed = { ...session, updatedAt: '2026-08-02T10:00:00.000Z', fileSizeBytes: 12 }
    const replanned = buildLibraryStartupPlan([changed], 1, checkpoint)
    expect(replanned.recoveryItems).toEqual([])
    expect(replanned.dirtyIndexes).toEqual([0])
  })

  it('waits for Provider completion while terminal identity diagnostics stay out of recovery', () => {
    const provider = summary('provider', '/fixture/provider.jsonl', '2026-08-02T09:00:00.000Z')
    const identity = summary('identity', '/fixture/identity.jsonl', '2026-08-02T09:00:00.000Z')
    let checkpoint = buildLibraryStartupPlan([provider, identity], 1, null).checkpoint
    checkpoint = updateLibraryStartupCheckpointAfterBatch(checkpoint, [provider, identity], {
      total: 2,
      completed: 1,
      skipped: [
        { sessionId: provider.sessionId, code: 'PROVIDER_SESSION_PENDING', disposition: 'failed', retryable: false },
        { sessionId: identity.sessionId, code: 'SESSION_IDENTITY_MISSING', disposition: 'handled', retryable: false }
      ]
    }, {}, Date.parse('2026-08-02T09:00:00.000Z')).checkpoint

    expect(summarizeLibraryStartupRecovery(checkpoint.recovery)).toMatchObject({
      waitingProvider: 1,
      attentionRequired: 0,
      retryScheduled: 0
    })
    expect(Object.values(checkpoint.recovery).map((entry) => [entry.state, entry.attempt]).sort())
      .toEqual([['waiting-provider', 0]])
  })

  it.each([
    'SESSION_IDENTITY_CONFLICT',
    'SESSION_IDENTITY_AMBIGUOUS',
    'SESSION_IDENTITY_MISSING'
  ])('retires legacy %s attention entries into identity diagnostics on replan', (reasonCode) => {
    const session = summary('identity-terminal', '/fixture/identity-terminal.jsonl', '2026-08-02T09:00:00.000Z')
    const cold = buildLibraryStartupPlan([session], 1, null)
    const descriptor = cold.descriptors[0]
    const legacy: LibraryStartupCheckpoint = {
      ...cold.checkpoint,
      recovery: {
        [descriptor.key]: {
          fingerprint: descriptor.fingerprint,
          state: 'attention-required',
          reasonCode,
          attempt: 0,
          firstFailedAt: '2026-08-02T09:00:00.000Z',
          lastAttemptAt: '2026-08-02T09:00:00.000Z',
          nextAttemptAt: null
        }
      }
    }

    const replanned = buildLibraryStartupPlan([session], 1, legacy)
    expect(replanned.recoveryItems).toEqual([])
    expect(replanned.dirtyIndexes).toEqual([])
    expect(replanned.checkpoint.completedKeys).toContain(descriptor.key)
    expect(replanned.checkpoint.completedFingerprints[descriptor.key]).toBe(descriptor.fingerprint)
  })

  it('invalidates a Provider checkpoint when only its authoritative canonical fingerprint changes', () => {
    const first = {
      ...summary('provider-fingerprint', 'ssh://fixture/provider#row', '2026-08-02T09:00:00.000Z'),
      source: 'pi' as const,
      canonicalProjectionFingerprint: 'canonical-f1'
    }
    const completed = completeLibraryStartupCheckpoint(
      buildLibraryStartupPlan([first], 1, null).checkpoint,
      [first]
    )
    const updated = { ...first, canonicalProjectionFingerprint: 'canonical-f2' }
    const replanned = buildLibraryStartupPlan([updated], 1, completed)

    expect(describeLibraryStartupSession(updated, 1).key)
      .toBe(describeLibraryStartupSession(first, 1).key)
    expect(describeLibraryStartupSession(updated, 1).fingerprint)
      .not.toBe(describeLibraryStartupSession(first, 1).fingerprint)
    expect(replanned.dirtyIndexes).toEqual([0])
  })

  it('preserves Provider retry attempts across a cold phase-one inventory without Provider rows', () => {
    const provider = {
      ...summary('provider-restart', 'ssh://fixture/provider#restart', '2026-08-02T09:00:00.000Z'),
      source: 'pi' as const,
      canonicalProjectionFingerprint: 'canonical-restart-f1'
    }
    let checkpoint = buildLibraryStartupPlan([provider], 1, null).checkpoint
    for (let attempt = 1; attempt <= 4; attempt++) {
      checkpoint = updateLibraryStartupCheckpointAfterBatch(checkpoint, [provider], {
        total: 1,
        completed: 0,
        skipped: [{
          sessionId: provider.sessionId,
          code: 'EBUSY',
          disposition: 'failed',
          retryable: true
        }]
      }, {}, Date.parse(`2026-08-02T09:00:0${attempt}.000Z`)).checkpoint
    }
    const providerKey = describeLibraryStartupSession(provider, 1).key
    expect(checkpoint.recovery[providerKey]).toMatchObject({ attempt: 4, state: 'retry-scheduled' })

    const physical = summary('physical-phase-one', '/fixture/physical.jsonl', '2026-08-02T09:00:00.000Z')
    const phaseOne = buildLibraryStartupPlan(
      [physical],
      1,
      checkpoint,
      {},
      { preserveUnseen: true }
    )
    expect(phaseOne.checkpoint.recovery[providerKey]).toMatchObject({ attempt: 4 })
    expect(phaseOne.recoveryItems).toEqual([])

    // A degraded Provider snapshot is partial and therefore cannot prune an
    // unseen key. Only a later complete inventory is authoritative.
    const degraded = buildLibraryStartupPlan(
      [physical],
      1,
      phaseOne.checkpoint,
      {},
      { preserveUnseen: true }
    )
    expect(degraded.checkpoint.recovery[providerKey]).toMatchObject({ attempt: 4 })

    const authoritative = buildLibraryStartupPlan([physical, provider], 1, degraded.checkpoint)
    expect(authoritative.recoveryItems).toMatchObject([{
      index: 1,
      entry: { attempt: 4, state: 'retry-scheduled' }
    }])
  })

  it('terminally handles proven identity conflicts outside the background recovery queue', () => {
    const identity = summary('identity', '/fixture/identity.jsonl', '2026-08-02T09:00:00.000Z')
    const plan = buildLibraryStartupPlan([identity], 1, null)
    const workKey = describeLibraryStartupSession(identity, 1).key
    const updated = updateLibraryStartupCheckpointAfterBatch(plan.checkpoint, [identity], {
      total: 1,
      completed: 1,
      skipped: [{
        sessionId: identity.sessionId,
        workKey,
        code: 'SESSION_IDENTITY_CONFLICT',
        disposition: 'handled',
        retryable: false
      }]
    }, {}, Date.parse('2026-08-02T09:00:00.000Z')).checkpoint

    expect(updated.recovery).toEqual({})
    expect(updated.completedKeys).toContain(workKey)
    expect(buildLibraryStartupPlan([identity], 1, updated)).toMatchObject({
      dirtyIndexes: [],
      recoveryItems: []
    })
  })

  it.each(['EAGAIN', 'EBUSY'])(
    'retries transient filesystem code %s with bounded backoff before exhaustion',
    (code) => {
      const session = summary(code.toLowerCase(), `/fixture/${code.toLowerCase()}.jsonl`, '2026-08-02T09:00:00.000Z')
      const workKey = describeLibraryStartupSession(session, 1).key
      let checkpoint = buildLibraryStartupPlan([session], 1, null).checkpoint
      for (let attempt = 1; attempt <= 5; attempt++) {
        checkpoint = updateLibraryStartupCheckpointAfterBatch(checkpoint, [session], {
          total: 1,
          completed: 0,
          skipped: [{
            sessionId: session.sessionId,
            workKey,
            code,
            disposition: 'failed',
            retryable: true
          }]
        }, {}, Date.parse(`2026-08-02T09:00:0${attempt}.000Z`)).checkpoint
        expect(checkpoint.recovery[workKey].attempt).toBe(attempt)
        expect(checkpoint.recovery[workKey].state).toBe(attempt < 5 ? 'retry-scheduled' : 'exhausted')
      }
      expect(summarizeLibraryStartupRecovery(checkpoint.recovery)).toMatchObject({
        retryScheduled: 0,
        exhausted: 1,
        nextRetryAt: null
      })
    }
  )

  it('admits no cold local projection probes and only the exact recovery key after failure', () => {
    const cold = {
      dirtyIndexes: Array.from({ length: 440 }, (_, index) => index),
      recoveryItems: []
    }
    expect(selectCurrentProjectionReconciliationIndexes(cold)).toEqual([])
    expect(selectCurrentProjectionReconciliationIndexes({
      ...cold,
      recoveryItems: [{
        index: 217,
        entry: {
          fingerprint: 'retry-fingerprint',
          state: 'retry-scheduled',
          reasonCode: 'EAGAIN',
          attempt: 1,
          firstFailedAt: '2026-08-10T00:00:00.000Z',
          lastAttemptAt: '2026-08-10T00:00:00.000Z',
          nextAttemptAt: '2026-08-10T00:00:01.000Z'
        }
      }]
    })).toEqual([217])
  })

  it('attributes a failure to its exact logical work key when sessionIds collide', () => {
    const codex = summary('shared', '/fixture/codex/shared.jsonl', '2026-08-02T09:00:00.000Z')
    const provider: SessionSummary = {
      ...summary('shared', '/fixture/claude/shared.jsonl', '2026-08-02T09:00:00.000Z'),
      source: 'claude-code'
    }
    const sessions = [codex, provider]
    const checkpoint = buildLibraryStartupPlan(sessions, 1, null).checkpoint
    const codexKey = describeLibraryStartupSession(codex, 1).key
    const providerKey = describeLibraryStartupSession(provider, 1).key

    const updated = updateLibraryStartupCheckpointAfterBatch(checkpoint, sessions, {
      total: 2,
      completed: 1,
      skipped: [{
        sessionId: provider.sessionId,
        workKey: providerKey,
        code: 'PROVIDER_SESSION_PENDING',
        disposition: 'failed',
        retryable: false
      }]
    }, {}, Date.parse('2026-08-02T09:00:00.000Z')).checkpoint

    expect(updated.completedKeys).toContain(codexKey)
    expect(updated.completedKeys).not.toContain(providerKey)
    expect(Object.keys(updated.recovery)).toEqual([providerKey])
    expect(updated.recovery[providerKey].state).toBe('waiting-provider')
  })

  it('bounds degraded Provider retries and terminally preserves complete-snapshot absences', () => {
    const provider: SessionSummary = {
      ...summary('provider', '/fixture/provider.jsonl', '2026-08-02T09:00:00.000Z'),
      source: 'claude-code'
    }
    const workKey = describeLibraryStartupSession(provider, 1).key
    const checkpoint = buildLibraryStartupPlan([provider], 1, null).checkpoint
    const degraded = updateLibraryStartupCheckpointAfterBatch(checkpoint, [provider], {
      total: 1,
      completed: 0,
      skipped: [{
        sessionId: provider.sessionId,
        workKey,
        code: 'PROVIDER_SESSION_DEGRADED',
        disposition: 'failed',
        retryable: true
      }]
    }, {}, Date.parse('2026-08-02T09:00:00.000Z')).checkpoint
    expect(degraded.recovery[workKey]).toMatchObject({ state: 'retry-scheduled', attempt: 1 })

    const complete = updateLibraryStartupCheckpointAfterBatch(checkpoint, [provider], {
      total: 1,
      completed: 1,
      skipped: [{
        sessionId: provider.sessionId,
        workKey,
        code: 'PROVIDER_SESSION_UNAVAILABLE',
        disposition: 'handled',
        retryable: false
      }]
    }).checkpoint
    expect(complete.recovery).toEqual({})
    expect(complete.completedKeys).toContain(workKey)
  })

  it('fails closed when an ambiguous legacy outcome omits its work key', () => {
    const first = summary('shared', '/fixture/one/shared.jsonl', '2026-08-02T09:00:00.000Z')
    const second: SessionSummary = {
      ...summary('shared', '/fixture/two/shared.jsonl', '2026-08-02T09:00:00.000Z'),
      source: 'claude-code'
    }
    const checkpoint = buildLibraryStartupPlan([first, second], 1, null).checkpoint
    expect(() => updateLibraryStartupCheckpointAfterBatch(checkpoint, [first, second], {
      total: 2,
      completed: 1,
      skipped: [{
        sessionId: 'shared',
        code: 'SESSION_SYNC_FAILED',
        disposition: 'failed',
        retryable: true
      }]
    })).toThrow('omitted workKey')
  })

  it('fails closed when an outcome supplies an unknown or mismatched work key', () => {
    const session = summary('known', '/fixture/known.jsonl', '2026-08-02T09:00:00.000Z')
    const checkpoint = buildLibraryStartupPlan([session], 1, null).checkpoint
    const failure = {
      total: 1,
      completed: 0,
      skipped: [{
        sessionId: session.sessionId,
        workKey: 'bogus',
        code: 'SESSION_SYNC_FAILED',
        disposition: 'failed' as const,
        retryable: true
      }]
    }
    expect(() => updateLibraryStartupCheckpointAfterBatch(checkpoint, [session], failure))
      .toThrow('workKey does not match')

    const realKey = describeLibraryStartupSession(session, 1).key
    expect(() => updateLibraryStartupCheckpointAfterBatch(checkpoint, [session], {
      ...failure,
      skipped: [{ ...failure.skipped[0], sessionId: 'different', workKey: realKey }]
    })).toThrow('workKey does not match')
  })

  it('fails closed when outcome accounting cannot cover the batch', () => {
    const session = summary('known', '/fixture/known.jsonl', '2026-08-02T09:00:00.000Z')
    const checkpoint = buildLibraryStartupPlan([session], 1, null).checkpoint
    expect(() => updateLibraryStartupCheckpointAfterBatch(checkpoint, [session], {
      total: 1,
      completed: 0,
      skipped: []
    })).toThrow('does not account')
  })

  it('invalidates and replans when the source collection or schema generation changes', () => {
    const sessions = Array.from({ length: 8 }, (_, index) =>
      summary(`session-${index}`, `/fixture/session-${index}.jsonl`, `2026-08-02T09:00:${String(index).padStart(2, '0')}.000Z`))
    const cold = buildLibraryStartupPlan(sessions, 1, null)
    const completed = completePlan(cold, sessions)

    const replacement = summary('replacement', '/fixture/replacement.jsonl', '2026-08-02T10:00:00.000Z')
    const changedSources = [...sessions.slice(0, -1), replacement]
    const sourcePlan = buildLibraryStartupPlan(changedSources, 1, completed)
    expect(sourcePlan.invalidation).toBe('snapshot-changed')
    expect(sourcePlan.dirtyIndexes).toEqual([changedSources.length - 1])

    const titlePlan = buildLibraryStartupPlan(sessions, 1, completed, {
      [sessions[3].sessionId]: { customTitle: 'Changed title' }
    })
    expect(titlePlan.invalidation).toBe('snapshot-changed')
    expect(titlePlan.dirtyIndexes).toEqual([3])

    const schemaPlan = buildLibraryStartupPlan(changedSources, 2, sourcePlan.checkpoint)
    expect(schemaPlan.invalidation).toBe('schema-changed')
    expect(schemaPlan.dirtyIndexes).toHaveLength(changedSources.length)
  })

  it('resumes only unfinished dirty keys after an interrupted batch boundary', () => {
    const sessions = Array.from({ length: 65 }, (_, index) =>
      summary(`resume-${index}`, `/fixture/resume-${index}.jsonl`, '2026-08-02T09:00:00.000Z'))
    const cold = buildLibraryStartupPlan(sessions, 1, null)
    const firstBatch = cold.dirtyIndexes.slice(0, LIBRARY_STARTUP_BATCH_SIZE).map((index) => sessions[index])
    const partial = completeLibraryStartupCheckpoint(cold.checkpoint, firstBatch)

    const resumed = buildLibraryStartupPlan(sessions, 1, partial)
    expect(resumed.invalidation).toBe('none')
    expect(resumed.dirtyIndexes).toHaveLength(sessions.length - LIBRARY_STARTUP_BATCH_SIZE)
    expect(resumed.dirtyIndexes[0]).toBe(LIBRARY_STARTUP_BATCH_SIZE)
  })

  it('keeps dirty=0/1/N linear at N=2000 with bounded writer and projection counters', async () => {
    const count = 2_000
    const sessions = Array.from({ length: count }, (_, index) =>
      summary(`scale-${String(index).padStart(4, '0')}`, `/fixture/scale-${index}.jsonl`, '2026-08-02T09:00:00.000Z'))
    const cold = buildLibraryStartupPlan(sessions, 1, null)
    const baseline = completePlan(cold, sessions)

    const changed = sessions.map((session, index) => index === 1_337
      ? { ...session, updatedAt: '2026-08-02T10:00:00.000Z', fileSizeBytes: 1 }
      : session)
    const scenarios = [
      { name: 'dirty0', plan: buildLibraryStartupPlan(sessions, 1, baseline), source: sessions, dirty: 0 },
      { name: 'dirty1', plan: buildLibraryStartupPlan(changed, 1, baseline), source: changed, dirty: 1 },
      { name: 'dirtyN', plan: buildLibraryStartupPlan(sessions, 2, baseline), source: sessions, dirty: count }
    ] as const

    for (const scenario of scenarios) {
      expect(scenario.plan.dirtyIndexes).toHaveLength(scenario.dirty)
      const dirtySessions = scenario.plan.dirtyIndexes.map((index) => scenario.source[index])
      let checkpoint = scenario.plan.checkpoint
      let batchRuns = 0
      let projectionFullRuns = 0
      const outcome = await syncLibraryStartupIncrementally({
        sessions: dirtySessions,
        probeWriter: async () => { throw new Error('planner already proved writer') },
        writerAlreadyProven: true,
        onWriterProven: () => {},
        resolveLatest: (session) => session,
        drainLive: async () => false,
        syncBatch: async (batch) => {
          batchRuns++
          checkpoint = completeLibraryStartupCheckpoint(checkpoint, batch)
          return { total: batch.length, completed: batch.length, skipped: [] }
        },
        onFirstDurableBoundary: () => { projectionFullRuns++ }
      })

      const writerAcquires = 1 + batchRuns // one planner transaction plus bounded batch transactions
      const registryFullScans = 1 // the production planner's single authoritative scan
      expect(outcome.total, scenario.name).toBe(scenario.dirty)
      expect(batchRuns, scenario.name).toBe(Math.ceil(scenario.dirty / LIBRARY_STARTUP_BATCH_SIZE))
      expect(writerAcquires, scenario.name).toBe(1 + Math.ceil(scenario.dirty / LIBRARY_STARTUP_BATCH_SIZE))
      expect(registryFullScans, scenario.name).toBe(1)
      expect(projectionFullRuns, scenario.name).toBeLessThanOrEqual(1)
      const completed = new Set(checkpoint.completedKeys)
      expect(checkpoint.dirtyKeys.filter((key) => !completed.has(key)), scenario.name).toHaveLength(0)
    }
  })
})
