import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const codexLoaderCalls = vi.hoisted(() => ({
  combined: vi.fn(),
  legacyRaw: vi.fn()
}))

vi.mock('./codex-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codex-loader')>()
  return {
    ...actual,
    loadCodexSessionRecordWithRaw: codexLoaderCalls.combined
      .mockImplementation(actual.loadCodexSessionRecordWithRaw),
    loadCodexRawMessages: codexLoaderCalls.legacyRaw
      .mockImplementation(actual.loadCodexRawMessages)
  }
})

import { runLibraryWorkerRequest } from './library-worker'
import { closeSearchIndex } from './search-index'
import { closeUsageFactStore } from './usage-fact-store'

const tempRoots: string[] = []

afterEach(() => {
  codexLoaderCalls.combined.mockClear()
  codexLoaderCalls.legacyRaw.mockClear()
  closeSearchIndex()
  closeUsageFactStore()
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('Library worker Codex live sync', () => {
  it('同一源只调用一次组合解析，transcript 不再调用第二次 raw loader', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-worker-codex-library-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-worker-codex-source-'))
    tempRoots.push(root, sourceRoot)
    const sessionId = '18400000-0000-4000-8000-000000000099'
    const sourcePath = path.join(
      sourceRoot,
      '.codex',
      'sessions',
      '2026',
      '08',
      '02',
      `rollout-2026-08-02T00-00-00-${sessionId}.jsonl`
    )
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, [
      {
        timestamp: '2026-08-02T00:00:00Z',
        type: 'session_meta',
        payload: {
          id: sessionId,
          timestamp: '2026-08-02T00:00:00Z',
          cwd: '/fixture/codex',
          cli_version: 'test'
        }
      },
      {
        timestamp: '2026-08-02T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'synthetic Codex live sync' }]
        }
      },
      {
        timestamp: '2026-08-02T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'synthetic response' }]
        }
      }
    ].map((row) => JSON.stringify(row)).join('\n') + '\n')

    const result = await runLibraryWorkerRequest({
      type: 'session-sync',
      root,
      filePath: sourcePath,
      sessionId,
      source: 'codex'
    })

    expect(result.kind).toBe('session-sync')
    if (result.kind !== 'session-sync' || !result.value.dirPath) {
      throw new Error('expected maintained Codex session')
    }
    expect(result.value.summary).toMatchObject({ sessionId, source: 'codex', turnCount: 1 })
    expect(codexLoaderCalls.combined).toHaveBeenCalledTimes(1)
    expect(codexLoaderCalls.legacyRaw).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(result.value.dirPath, 'transcript.md'), 'utf8'))
      .toContain('synthetic Codex live sync')
  })
})
