import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { runLibraryWorkerRequest } from './library-worker'
import { syncLibraryStartupIncrementally } from './library-startup-sync'
import { closeSearchIndex } from './search-index'
import { closeUsageFactStore } from './usage-fact-store'

const roots: string[] = []
const largeLiveSyncIt = process.env.SWOB_LARGE_LIVE_SYNC_TEST === '1' ? it : it.skip

function writeLargeJsonlFixture(filePath: string, sessionId: string): void {
  const userLine = JSON.stringify({
    uuid: 'user-large', parentUuid: null, sessionId, type: 'user',
    timestamp: '2026-08-02T09:00:00.000Z', cwd: '/fixture/project',
    message: { role: 'user', content: 'large baseline' }
  })
  const assistantTemplate = JSON.stringify({
    uuid: 'assistant-large', parentUuid: 'user-large', sessionId, type: 'assistant',
    timestamp: '2026-08-02T09:00:01.000Z', cwd: '/fixture/project',
    message: { role: 'assistant', content: '__SWOB_LARGE_PAYLOAD__' }
  })
  const marker = '__SWOB_LARGE_PAYLOAD__'
  const markerAt = assistantTemplate.indexOf(marker)
  const fd = fs.openSync(filePath, 'w')
  try {
    fs.writeSync(fd, userLine + '\n')
    fs.writeSync(fd, assistantTemplate.slice(0, markerAt))
    const chunk = Buffer.alloc(1024 * 1024, 0x78)
    for (let index = 0; index < 100; index++) fs.writeSync(fd, chunk)
    fs.writeSync(fd, assistantTemplate.slice(markerAt + marker.length) + '\n')
  } finally {
    fs.closeSync(fd)
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('hex')
}

afterEach(() => {
  closeSearchIndex()
  closeUsageFactStore()
  delete process.env.SWOB_SEARCH_INDEX_DIR
  delete process.env.SWOB_USAGE_INDEX_PATH
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Library worker request', () => {
  largeLiveSyncIt('keeps a 100MB active source follow-up below the 60 second live gate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-100mb-root-'))
    roots.push(root)
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search-index')
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-100mb-source-'))
    roots.push(sourceRoot)
    const sessionId = 'worker-100mb-follow-up'
    const sourcePath = path.join(sourceRoot, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    // Keep the test harness itself bounded: never construct or retain the
    // 100MB payload as one parent-process string.
    writeLargeJsonlFixture(sourcePath, sessionId)

    const initial = await runLibraryWorkerRequest({
      type: 'session-sync', root, filePath: sourcePath, sessionId, source: 'claude-code'
    })
    if (initial.kind !== 'session-sync' || !initial.value.dirPath) throw new Error('initial large sync failed')
    fs.appendFileSync(sourcePath, [
      JSON.stringify({
        uuid: 'user-follow-up', parentUuid: 'assistant-large', sessionId, type: 'user',
        timestamp: '2026-08-02T09:01:00.000Z', cwd: '/fixture/project',
        message: { role: 'user', content: 'large source follow-up' }
      }),
      JSON.stringify({
        uuid: 'assistant-follow-up', parentUuid: 'user-follow-up', sessionId, type: 'assistant',
        timestamp: '2026-08-02T09:01:01.000Z', cwd: '/fixture/project',
        message: { role: 'assistant', content: 'done' }
      })
    ].join('\n') + '\n')

    const startedAt = Date.now()
    const followUp = await runLibraryWorkerRequest({
      type: 'session-sync', root, filePath: sourcePath, sessionId, source: 'claude-code'
    })
    const elapsedMs = Date.now() - startedAt
    if (followUp.kind !== 'session-sync' || !followUp.value.dirPath) throw new Error('large follow-up sync failed')
    expect(elapsedMs).toBeLessThan(60_000)
    expect(await sha256File(path.join(followUp.value.dirPath, 'backup.jsonl')))
      .toBe(await sha256File(sourcePath))
    expect(fs.readFileSync(path.join(followUp.value.dirPath, 'transcript.md'), 'utf8'))
      .toContain('large source follow-up')
    console.info('[100mb-live-sync]', JSON.stringify({ elapsedMs, bytes: fs.statSync(sourcePath).size }))
  }, 120_000)

  it('lets a real live follow-up reach backup and transcript before incremental startup completes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-live-root-'))
    roots.push(root)
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search-index')
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-live-source-'))
    roots.push(sourceRoot)
    const sessionId = 'worker-live-follow-up'
    const sourcePath = path.join(sourceRoot, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    const rows = [
      {
        uuid: 'user-1', parentUuid: null, sessionId, type: 'user',
        timestamp: '2026-08-02T09:00:00.000Z', cwd: '/fixture/project',
        message: { role: 'user', content: 'startup baseline' }
      },
      {
        uuid: 'assistant-1', parentUuid: 'user-1', sessionId, type: 'assistant',
        timestamp: '2026-08-02T09:00:01.000Z', cwd: '/fixture/project',
        message: { role: 'assistant', content: 'baseline complete' }
      }
    ]
    fs.writeFileSync(sourcePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

    const parsed = await runLibraryWorkerRequest({
      type: 'session-sync',
      root,
      filePath: sourcePath,
      sessionId,
      source: 'claude-code',
      maintainLibrary: false
    })
    if (parsed.kind !== 'session-sync') throw new Error('expected parsed session')
    let latest = parsed.value.summary
    let livePending = false
    let liveDir = ''
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => { releaseTail = resolve })
    let tailStarted = false
    let startupFinished = false
    const startup = syncLibraryStartupIncrementally({
      sessions: [latest, { ...latest, id: 'tail', sessionId: 'tail' }],
      probeWriter: async () => {
        const result = await runLibraryWorkerRequest({ type: 'writer-probe', root })
        expect(result.kind).toBe('writer-probe')
      },
      onWriterProven: () => {
        fs.appendFileSync(sourcePath, [
          {
            uuid: 'user-2', parentUuid: 'assistant-1', sessionId, type: 'user',
            timestamp: '2026-08-02T09:01:00.000Z', cwd: '/fixture/project',
            message: { role: 'user', content: 'follow-up must be visible before startup completes' }
          },
          {
            uuid: 'assistant-2', parentUuid: 'user-2', sessionId, type: 'assistant',
            timestamp: '2026-08-02T09:01:01.000Z', cwd: '/fixture/project',
            message: { role: 'assistant', content: 'follow-up complete' }
          }
        ].map((row) => JSON.stringify(row)).join('\n') + '\n')
        livePending = true
      },
      drainLive: async () => {
        if (!livePending) return
        livePending = false
        const result = await runLibraryWorkerRequest({
          type: 'session-sync', root, filePath: sourcePath, sessionId, source: 'claude-code'
        })
        if (result.kind !== 'session-sync' || !result.value.dirPath) throw new Error('live sync failed')
        latest = result.value.summary
        liveDir = result.value.dirPath
      },
      resolveLatest: (initial) => initial.sessionId === sessionId ? latest : initial,
      syncChunk: async (session) => {
        if (session.sessionId === 'tail') {
          tailStarted = true
          await tailGate
          return { total: 1, completed: 1, skipped: [] }
        }
        const result = await runLibraryWorkerRequest({
          type: 'sync-chunk', root, sessions: [session], sessionMeta: {}
        })
        if (result.kind !== 'sync-outcome') throw new Error('startup chunk failed')
        return result.outcome
      }
    }).finally(() => { startupFinished = true })

    try {
      await vi.waitFor(() => expect(tailStarted).toBe(true), { timeout: 20_000 })
      expect(startupFinished).toBe(false)
      expect(liveDir).not.toBe('')
      expect(fs.readFileSync(path.join(liveDir, 'backup.jsonl'))).toEqual(fs.readFileSync(sourcePath))
      expect(fs.readFileSync(path.join(liveDir, 'transcript.md'), 'utf8'))
        .toContain('follow-up must be visible before startup completes')
      expect(latest.updatedAt).toBe('2026-08-02T09:01:01.000Z')
    } finally {
      releaseTail()
      await startup
    }
    expect(startupFinished).toBe(true)
  })

  it('syncs usage facts without initializing or scanning the Library root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-usage-worker-'))
    roots.push(root)
    process.env.SWOB_USAGE_INDEX_PATH = path.join(root, 'usage.db')

    const result = await runLibraryWorkerRequest({
      type: 'usage-facts-sync',
      root: path.join(root, 'intentionally-missing-library'),
      sessions: [],
      folders: []
    })

    expect(result).toEqual({
      kind: 'usage-facts-sync',
      value: {
        changedSessions: 0,
        unchangedSessions: 0,
        removedSessions: 0,
        factCount: 0,
        rebuilt: false
      }
    })
    expect(fs.existsSync(process.env.SWOB_USAGE_INDEX_PATH)).toBe(true)
  })

  it('scans Library metadata without relying on the main-process index', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-'))
    roots.push(root)
    const sessionId = 'worker-session-1'
    const sessionDir = path.join(root, 'project', sessionId)
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      sessionId,
      sourceFilePaths: ['/unavailable/source.jsonl'],
      createdAt: '2026-07-21T00:00:00.000Z',
      updatedAt: '2026-07-21T00:01:00.000Z',
      projectPath: '/fixture/project'
    }))

    const result = await runLibraryWorkerRequest({ type: 'scan', root })

    expect(result.kind).toBe('tree')
    if (result.kind !== 'tree') throw new Error('expected tree result')
    const tree = result.tree
    expect(tree.root).toBe(root)
    expect(tree.folders).toHaveLength(1)
    expect(tree.folders[0].sessions.map((session) => session.sessionId)).toEqual([sessionId])
  })

  it('commits Library before the independently queued search projection', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-sync-'))
    roots.push(root)
    process.env.SWOB_SEARCH_INDEX_DIR = path.join(root, 'search-index')
    const sessionId = 'worker-sync-session'
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-library-worker-source-'))
    roots.push(sourceRoot)
    const sourcePath = path.join(sourceRoot, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, [
      {
        uuid: 'user-1', parentUuid: null, sessionId, type: 'user',
        timestamp: '2026-07-21T00:00:00.000Z', cwd: '/fixture/project',
        message: { role: 'user', content: 'worker synchronization needle' }
      },
      {
        uuid: 'assistant-1', parentUuid: 'user-1', sessionId, type: 'assistant',
        timestamp: '2026-07-21T00:00:01.000Z', cwd: '/fixture/project',
        message: { role: 'assistant', content: 'done' }
      }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')

    const result = await runLibraryWorkerRequest({
      type: 'session-sync', root, filePath: sourcePath, sessionId, source: 'claude-code'
    })

    expect(result.kind).toBe('session-sync')
    if (result.kind !== 'session-sync') throw new Error('expected session sync result')
    expect(result.value.summary.sessionId).toBe(sessionId)
    expect(result.value.dirPath).toBeTruthy()
    expect(fs.existsSync(path.join(result.value.dirPath!, 'backup.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'search-index', 'search.db'))).toBe(false)

    const indexed = await runLibraryWorkerRequest({
      type: 'search-sources-sync',
      sources: [{ filePath: sourcePath, sessionId, source: 'claude-code' }],
      prune: false
    })
    expect(indexed.kind).toBe('search-write')
    expect(fs.existsSync(path.join(root, 'search-index', 'search.db'))).toBe(true)
  })
})
