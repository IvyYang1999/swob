import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runLibraryWorkerRequest } from './library-worker'
import { closeSearchIndex } from './search-index'

const roots: string[] = []

afterEach(() => {
  closeSearchIndex()
  delete process.env.SWOB_SEARCH_INDEX_DIR
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Library worker request', () => {
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

  it('parses, backs up and indexes a changed session off the main-process path', async () => {
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
    expect(fs.existsSync(path.join(root, 'search-index', 'search.db'))).toBe(true)
  })
})
