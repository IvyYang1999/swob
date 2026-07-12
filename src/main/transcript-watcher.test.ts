import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  TranscriptWatcher,
  selectActiveTranscriptSources,
  TRANSCRIPT_ACTIVE_WINDOW_MS
} from './transcript-watcher'
import { initLibrary, scanLibrary, updateTranscript } from './library-manager'

describe('transcript watcher active-set selection', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-transcript-watcher-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('only selects recent existing JSONL sources and deduplicates file watches', () => {
    const now = Date.now()
    const active = path.join(tmpDir, 'active.jsonl')
    const stale = path.join(tmpDir, 'stale.jsonl')
    const notJsonl = path.join(tmpDir, 'active.txt')
    fs.writeFileSync(active, '{}\n')
    fs.writeFileSync(stale, '{}\n')
    fs.writeFileSync(notJsonl, '{}\n')
    fs.utimesSync(active, new Date(now), new Date(now))
    fs.utimesSync(stale, new Date(now - TRANSCRIPT_ACTIVE_WINDOW_MS - 1_000), new Date(now - TRANSCRIPT_ACTIVE_WINDOW_MS - 1_000))

    const selected = selectActiveTranscriptSources([
      { sessionId: 'session-a', sourcePath: active },
      { sessionId: 'session-a', sourcePath: active },
      { sessionId: 'session-b', sourcePath: active },
      { sessionId: 'session-stale', sourcePath: stale },
      { sessionId: 'session-text', sourcePath: notJsonl },
      { sessionId: 'session-missing', sourcePath: path.join(tmpDir, 'missing.jsonl') }
    ], now)

    expect(selected).toEqual([{
      sourcePath: path.resolve(active),
      sessionIds: ['session-a', 'session-b']
    }])
  })
})

describe('TranscriptWatcher lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces repeated source changes and regenerates once after 3 seconds', async () => {
    const callbacks = new Map<string, () => void>()
    const generate = vi.fn(async () => true)
    const watcher = new TranscriptWatcher({
      scan: () => ({
        sources: [{ sourcePath: '/tmp/active.jsonl', sessionIds: ['active-session'] }],
        totalSessionCount: 12
      }),
      generate,
      watchSource: (sourcePath, onChange) => {
        callbacks.set(sourcePath, onChange)
        return { close: vi.fn() }
      },
      logger: { info: vi.fn(), error: vi.fn() }
    })

    expect(watcher.start()).toEqual({
      activeSourceCount: 1,
      activeSessionCount: 1,
      totalSessionCount: 12
    })
    callbacks.get('/tmp/active.jsonl')!()
    await vi.advanceTimersByTimeAsync(2_000)
    callbacks.get('/tmp/active.jsonl')!()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(generate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith('active-session')
    watcher.stop()
  })

  it('closes sources that leave the active set and cancels pending work', async () => {
    const callbacks = new Map<string, () => void>()
    const close = vi.fn()
    const generate = vi.fn(async () => true)
    let active = true
    const watcher = new TranscriptWatcher({
      scan: () => ({
        sources: active
          ? [{ sourcePath: '/tmp/leaving.jsonl', sessionIds: ['leaving-session'] }]
          : [],
        totalSessionCount: 20
      }),
      generate,
      watchSource: (sourcePath, onChange) => {
        callbacks.set(sourcePath, onChange)
        return { close }
      },
      logger: { info: vi.fn(), error: vi.fn() }
    })

    watcher.start()
    callbacks.get('/tmp/leaving.jsonl')!()
    active = false
    expect(watcher.refresh()).toEqual({
      activeSourceCount: 0,
      activeSessionCount: 0,
      totalSessionCount: 20
    })
    expect(close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(generate).not.toHaveBeenCalled()
    watcher.stop()
  })

  it('does not duplicate a watch across active-set refreshes and closes on stop', () => {
    const close = vi.fn()
    const watchSource = vi.fn(() => ({ close }))
    const watcher = new TranscriptWatcher({
      scan: () => ({
        sources: [{ sourcePath: '/tmp/stable.jsonl', sessionIds: ['stable-session'] }],
        totalSessionCount: 1
      }),
      watchSource,
      logger: { info: vi.fn(), error: vi.fn() }
    })

    watcher.start()
    watcher.refresh()
    expect(watchSource).toHaveBeenCalledTimes(1)
    watcher.stop()
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('TranscriptWatcher real-file integration', () => {
  it('updates transcript within 10 seconds after an active JSONL append', { timeout: 10_000 }, async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-transcript-integration-'))
    const sessionId = 'realtime-session'
    const sourcePath = path.join(tmpDir, 'source.jsonl')
    const sessionDir = path.join(tmpDir, 'library-session')
    const transcriptPath = path.join(sessionDir, 'transcript.md')
    const staleSourcePath = path.join(tmpDir, 'stale-source.jsonl')
    const staleSessionDir = path.join(tmpDir, 'stale-library-session')
    const row = (uuid: string, parentUuid: string | null, type: 'user' | 'assistant', content: string, timestamp: string) => ({
      uuid,
      parentUuid,
      sessionId,
      type,
      timestamp,
      cwd: tmpDir,
      message: { role: type, content }
    })

    fs.mkdirSync(sessionDir)
    fs.writeFileSync(sourcePath, JSON.stringify(row('u1', null, 'user', 'first prompt', '2026-07-12T10:00:00Z')) + '\n')
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: '2026-07-12T10:00:00Z',
      updatedAt: '2026-07-12T10:00:00Z',
      projectPath: tmpDir
    }))
    fs.mkdirSync(staleSessionDir)
    fs.writeFileSync(staleSourcePath, '{}\n')
    const staleTime = new Date(Date.now() - TRANSCRIPT_ACTIVE_WINDOW_MS - 60_000)
    fs.utimesSync(staleSourcePath, staleTime, staleTime)
    fs.writeFileSync(path.join(staleSessionDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'stale-session',
      sourceFilePaths: [staleSourcePath],
      createdAt: '2026-07-01T10:00:00Z',
      updatedAt: '2026-07-01T10:00:00Z',
      projectPath: tmpDir
    }))

    initLibrary(tmpDir)
    scanLibrary()
    expect(await updateTranscript(sessionId)).toBe(true)
    const beforeMtime = fs.statSync(transcriptPath).mtimeMs
    const generate = vi.fn(updateTranscript)
    const watcher = new TranscriptWatcher({ generate, logger: { info: vi.fn(), error: vi.fn() } })

    try {
      expect(watcher.start()).toEqual({
        activeSourceCount: 1,
        activeSessionCount: 1,
        totalSessionCount: 2
      })
      const idleCpuStart = process.cpuUsage()
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const idleCpu = process.cpuUsage(idleCpuStart)
      const idleCpuMs = (idleCpu.user + idleCpu.system) / 1_000
      console.info(
        `[transcript-watcher AC] active sessions=1 total library sessions=2; ` +
        `idle sample wall=1000ms cpu=${idleCpuMs.toFixed(2)}ms generateCalls=${generate.mock.calls.length}`
      )
      expect(generate).not.toHaveBeenCalled()
      const startedAt = Date.now()
      fs.appendFileSync(
        sourcePath,
        JSON.stringify(row('a1', 'u1', 'assistant', 'realtime marker', '2026-07-12T10:00:01Z')) + '\n'
      )

      let updated = false
      while (Date.now() - startedAt < 9_000) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        updated = fs.statSync(transcriptPath).mtimeMs > beforeMtime &&
          fs.readFileSync(transcriptPath, 'utf-8').includes('realtime marker')
        if (updated) break
      }
      const elapsedMs = Date.now() - startedAt
      console.info(
        `[transcript-watcher AC] append-to-transcript elapsed=${elapsedMs}ms ` +
        `generateCalls=${generate.mock.calls.length} updated=${updated}`
      )
      expect(updated).toBe(true)
      expect(elapsedMs).toBeLessThanOrEqual(10_000)
    } finally {
      watcher.stop()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
