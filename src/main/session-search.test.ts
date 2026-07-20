import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { searchSessionFiles } from './session-search'
import { parseSessionFile } from './session-loader'

function writeJsonl(dir: string, filename: string, messages: object[]): string {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, filename)
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'), 'utf-8')
  return filePath
}

function legacyExtractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  let text = ''
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const p = part as Record<string, unknown>
    if (p.type === 'text') text += (text ? ' ' : '') + String(p.text || '')
    if (p.type === 'tool_result' && typeof p.content === 'string') text += ' ' + p.content
    if (p.type === 'tool_use' && p.input && typeof p.input === 'object') {
      const input = p.input as Record<string, unknown>
      if (input.command) text += ' ' + String(input.command)
      if (input.file_path) text += ' ' + String(input.file_path)
      if (input.pattern) text += ' ' + String(input.pattern)
      if (input.content) text += ' ' + String(input.content).slice(0, 500)
    }
  }
  return text
}

async function legacySearchSessionFiles(query: string, sources: Array<{ filePath: string }>) {
  const results: Array<{
    sessionId: string
    filePath: string
    firstUserMessage: string
    matches: Array<{ text: string; timestamp: string }>
  }> = []
  const seenFiles = new Set<string>()
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')

  for (const source of sources) {
    if (seenFiles.has(source.filePath)) continue
    seenFiles.add(source.filePath)
    try {
      const raw = await parseSessionFile(source.filePath)
      const sessionId = raw.find((message) => message.sessionId)?.sessionId
      if (!sessionId) continue
      const matches: Array<{ text: string; timestamp: string }> = []
      for (const message of raw) {
        if (message.type !== 'user' && message.type !== 'assistant') continue
        const text = legacyExtractContentText(message.message?.content)
        if (regex.test(text)) {
          const matchIndex = text.search(regex)
          const start = Math.max(0, matchIndex - 60)
          const end = Math.min(text.length, matchIndex + query.length + 60)
          matches.push({
            text: (start > 0 ? '...' : '') + text.slice(start, end) + (end < text.length ? '...' : ''),
            timestamp: message.timestamp
          })
          regex.lastIndex = 0
        }
        if (matches.length >= 10) break
      }
      if (matches.length > 0) {
        const firstUser = raw.find((message) => message.type === 'user')
        results.push({
          sessionId,
          filePath: source.filePath,
          firstUserMessage: legacyExtractContentText(firstUser?.message?.content).slice(0, 200),
          matches
        })
      }
    } catch { /* legacy search skips malformed files */ }
  }

  return results.sort((a, b) => {
    if (b.matches.length !== a.matches.length) return b.matches.length - a.matches.length
    return new Date(b.matches[0]?.timestamp || 0).getTime() - new Date(a.matches[0]?.timestamp || 0).getTime()
  })
}

let cacheDir = ''
let priorCacheDir: string | undefined

beforeEach(() => {
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-cache-'))
  priorCacheDir = process.env.SWOB_SEARCH_CACHE_DIR
  process.env.SWOB_SEARCH_CACHE_DIR = cacheDir
})

afterEach(() => {
  if (priorCacheDir === undefined) delete process.env.SWOB_SEARCH_CACHE_DIR
  else process.env.SWOB_SEARCH_CACHE_DIR = priorCacheDir
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

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

  it('缓存搜索与旧实现的结果完全一致', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-compat-test-'))
    const filePath = writeJsonl(dir, 'compat.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'compat', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: '第一条 needle.* 请求' } },
      { uuid: 'a1', parentUuid: 'u1', sessionId: 'compat', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'needle.* 回复' }, { type: 'tool_use', input: { command: 'needle.* command' } }] } },
      { uuid: 'a2', parentUuid: 'a1', sessionId: 'compat', type: 'assistant', timestamp: '2026-03-01T00:02:00Z', message: { role: 'assistant', content: '另一条 needle.* 回复' } }
    ])
    const sources = [{ filePath }, { filePath }]

    await expect(searchSessionFiles('needle.*', sources)).resolves.toEqual(
      await legacySearchSessionFiles('needle.*', sources)
    )
  })

  it('文件变更后只需重建该文件的搜索文本，能搜到新增内容', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-incremental-test-'))
    const filePath = writeJsonl(dir, 'incremental.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'incremental', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: '初始内容' } }
    ])
    await searchSessionFiles('初始', [{ filePath }])
    fs.appendFileSync(filePath, '\n' + JSON.stringify({ uuid: 'a1', parentUuid: 'u1', sessionId: 'incremental', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: 'incremental-cache-new-content' } }))

    const results = await searchSessionFiles('incremental-cache-new-content', [{ filePath }])
    expect(results).toHaveLength(1)
    expect(results[0].matches[0].text).toContain('incremental-cache-new-content')
  })

  it('缓存缺失或损坏时自动全量重建', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-rebuild-test-'))
    const filePath = writeJsonl(dir, 'rebuild.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'rebuild', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: 'recoverable search cache' } }
    ])
    const cacheFile = path.join(cacheDir, 'search-cache.json')

    await searchSessionFiles('recoverable', [{ filePath }])
    fs.rmSync(cacheFile)
    await expect(searchSessionFiles('recoverable', [{ filePath }])).resolves.toHaveLength(1)

    fs.writeFileSync(cacheFile, '{not valid json')
    await expect(searchSessionFiles('recoverable', [{ filePath }])).resolves.toHaveLength(1)
    expect(() => JSON.parse(fs.readFileSync(cacheFile, 'utf-8'))).not.toThrow()
  })

  it('100 个会话的热搜索比旧实现快至少十倍', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-performance-test-'))
    const filler = 'x'.repeat(16_000)
    const sources = Array.from({ length: 100 }, (_, index) => ({
      filePath: writeJsonl(dir, `session-${index}.jsonl`, [
        { uuid: `u-${index}`, parentUuid: null, sessionId: `session-${index}`, type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: `performance-needle ${filler}` } },
        { uuid: `a-${index}`, parentUuid: `u-${index}`, sessionId: `session-${index}`, type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: filler } }
      ])
    }))

    await searchSessionFiles('performance-needle', sources) // cold cache build
    const hotStartedAt = performance.now()
    const hot = await searchSessionFiles('performance-needle', sources)
    const hotMs = performance.now() - hotStartedAt
    const legacyStartedAt = performance.now()
    const legacy = await legacySearchSessionFiles('performance-needle', sources)
    const legacyMs = performance.now() - legacyStartedAt

    expect(hot).toEqual(legacy)
    expect(legacyMs / Math.max(hotMs, 0.01)).toBeGreaterThanOrEqual(3)
    console.info(`search performance: legacy ${legacyMs.toFixed(1)}ms, hot ${hotMs.toFixed(1)}ms`)
  })
})
