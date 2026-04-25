import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { searchSessionFiles } from './session-search'

function writeJsonl(dir: string, filename: string, messages: object[]): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'), 'utf-8')
  return filePath
}

describe('searchSessionFiles', () => {
  it('搜索普通 JSONL 文件', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-test-'))
    const filePath = writeJsonl(dir, 'session.jsonl', [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'session-1',
        type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
        message: { role: 'user', content: '帮我分析 token 消耗' }
      }
    ])

    const results = await searchSessionFiles('token', [{ filePath }])

    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('session-1')
    expect(results[0].firstUserMessage).toBe('帮我分析 token 消耗')
  })

  it('【曾经的 bug】原始 JSONL 缺失但 Library backup 存在时，也能搜到', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-backup-test-'))
    const backupPath = writeJsonl(dir, 'backup.jsonl', [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'backup-only-session',
        type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
        message: { role: 'user', content: 'anthropic 审阅 swob 文档' }
      },
      {
        uuid: 'u2',
        parentUuid: 'u1',
        sessionId: 'backup-only-session',
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: { role: 'assistant', content: '可以，我来审阅。' }
      }
    ])

    const results = await searchSessionFiles('anthropic', [{ filePath: backupPath }])

    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('backup-only-session')
    expect(results[0].filePath).toBe(backupPath)
  })
})
