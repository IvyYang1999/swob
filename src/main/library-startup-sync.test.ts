import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncLibraryStartupIncrementally } from './library-startup-sync'
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

describe('incremental Library startup synchronization', () => {
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
