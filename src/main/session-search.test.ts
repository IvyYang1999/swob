import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { searchIndexedSessions, searchSessionFiles } from './session-search'
import { parseSessionFile } from './session-loader'
import {
  closeSearchIndex,
  grepTranscripts,
  searchDatabasePath,
  searchIndexStats,
  synchronizeSearchSources
} from './search-index'

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

let indexDir = ''
let priorIndexDir: string | undefined

beforeEach(() => {
  closeSearchIndex()
  indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-index-'))
  priorIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  process.env.SWOB_SEARCH_INDEX_DIR = indexDir
})

afterEach(() => {
  closeSearchIndex()
  if (priorIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = priorIndexDir
  fs.rmSync(indexDir, { recursive: true, force: true })
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
    expect(searchIndexStats().libraryBackups).toBe(1)
  })

  it('FTS 搜索保持旧实现的会话、首条消息和匹配数量语义', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-compat-test-'))
    const filePath = writeJsonl(dir, 'compat.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'compat', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: '第一条 needle.* 请求' } },
      { uuid: 'a1', parentUuid: 'u1', sessionId: 'compat', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'needle.* 回复' }, { type: 'tool_use', input: { command: 'needle.* command' } }] } },
      { uuid: 'a2', parentUuid: 'a1', sessionId: 'compat', type: 'assistant', timestamp: '2026-03-01T00:02:00Z', message: { role: 'assistant', content: '另一条 needle.* 回复' } }
    ])
    const sources = [{ filePath }, { filePath }]

    const indexed = await searchSessionFiles('needle.*', sources)
    const legacy = await legacySearchSessionFiles('needle.*', sources)

    expect(indexed.map((result) => result.sessionId)).toEqual(legacy.map((result) => result.sessionId))
    expect(indexed[0].firstUserMessage).toBe(legacy[0].firstUserMessage)
    expect(indexed[0].matches).toHaveLength(legacy[0].matches.length)
    expect(indexed[0].matches.every((match) => match.text.includes('needle'))).toBe(true)
  })

  it('append-only 文件只追加新的 FTS 消息，不重写或复制旧条目', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-incremental-test-'))
    const filePath = writeJsonl(dir, 'incremental.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'incremental', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: 'initial-content' } }
    ])
    await searchSessionFiles('initial-content', [{ filePath }])
    expect(searchIndexStats().messages).toBe(1)
    fs.appendFileSync(filePath, '\n' + JSON.stringify({ uuid: 'a1', parentUuid: 'u1', sessionId: 'incremental', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: 'incremental-cache-new-content' } }))

    const results = await searchSessionFiles('incremental-cache-new-content', [{ filePath }])
    expect(results).toHaveLength(1)
    expect(results[0].matches[0].text).toContain('incremental-cache-new-content')
    expect(searchIndexStats().messages).toBe(2)
    expect(searchIndexedSessions('initial-content')).toHaveLength(1)
  })

  it('grep 索引完整工具参数、结果和 thinking，并返回命中上下文 ±1', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-grep-full-test-'))
    const filePath = writeJsonl(dir, 'grep.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'grep-full', type: 'user', cwd: '/repo/alpha', timestamp: '2026-07-20T00:00:00Z', message: { role: 'user', content: '前一条消息' } },
      { uuid: 'a1', parentUuid: 'u1', sessionId: 'grep-full', type: 'assistant', cwd: '/repo/alpha', timestamp: '2026-07-20T00:01:00Z', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private-reasoning-needle' },
        { type: 'tool_use', name: 'Write', input: { content: `${'x'.repeat(700)} full-tool-input-needle`, file_path: '/repo/alpha/a.ts' } }
      ] } },
      { uuid: 'u2', parentUuid: 'a1', sessionId: 'grep-full', type: 'user', cwd: '/repo/alpha', timestamp: '2026-07-20T00:02:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'full-tool-result-needle' }] } }
    ])
    await searchSessionFiles('full-tool-input-needle', [{ filePath, source: 'codex' }])

    const results = grepTranscripts('full-tool-input-needle', {
      source: 'codex',
      project: 'alpha',
      sessionIds: ['grep-full'],
      after: '2026-07-20T00:00:30Z',
      before: '2026-07-20T00:01:30Z'
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ sessionId: 'grep-full', source: 'codex', projectPath: '/repo/alpha' })
    expect(results[0].matches[0].text).toContain('full-tool-input-needle')
    expect(results[0].matches[0].context.map((line) => line.text)).toEqual(expect.arrayContaining([
      '前一条消息',
      'full-tool-result-needle'
    ]))
    expect(grepTranscripts('private-reasoning-needle')).toHaveLength(1)
    expect(grepTranscripts('full-tool-result-needle')).toHaveLength(1)
    expect(grepTranscripts('full-tool-input-needle', { source: 'claude-code' })).toHaveLength(0)
  })

  it('支持 DB 虚拟会话引用和来源专用 normalizer，热同步不重复解析', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-grep-virtual-source-'))
    const stateFilePath = path.join(dir, 'opencode.db')
    fs.writeFileSync(stateFilePath, 'database-state')
    const filePath = `${stateFilePath}#session-opencode`
    const loadRaw = vi.fn(async () => [{
      uuid: 'u1',
      parentUuid: null,
      sessionId: 'session-opencode',
      type: 'user' as const,
      cwd: '/repo/opencode-project',
      timestamp: '2026-07-20T00:00:00Z',
      message: { role: 'user', content: 'virtual-source-needle' }
    }])
    const source = { filePath, stateFilePath, source: 'opencode', loadRaw }

    await synchronizeSearchSources([source])
    await synchronizeSearchSources([source])

    expect(loadRaw).toHaveBeenCalledTimes(1)
    expect(grepTranscripts('virtual-source-needle', { source: 'opencode' })).toMatchObject([{
      sessionId: 'session-opencode',
      filePath,
      source: 'opencode',
      projectPath: '/repo/opencode-project'
    }])
  })

  it('数据库缺失时自动重建，且完全不读取旧 search-cache.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-rebuild-test-'))
    const filePath = writeJsonl(dir, 'rebuild.jsonl', [
      { uuid: 'u1', parentUuid: null, sessionId: 'rebuild', type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: 'recoverable search cache' } }
    ])
    const legacyCacheFile = path.join(indexDir, 'search-cache.json')
    fs.writeFileSync(legacyCacheFile, '{intentionally invalid legacy cache')

    await searchSessionFiles('recoverable', [{ filePath }])
    expect(searchIndexStats()).toMatchObject({ sessions: 1, messages: 1 })
    expect(fs.readFileSync(legacyCacheFile, 'utf-8')).toBe('{intentionally invalid legacy cache')

    closeSearchIndex()
    for (const suffix of ['', '-wal', '-shm']) {
      const dbFile = `${searchDatabasePath()}${suffix}`
      if (fs.existsSync(dbFile)) fs.rmSync(dbFile)
    }
    await expect(searchSessionFiles('recoverable', [{ filePath }])).resolves.toHaveLength(1)
    expect(fs.existsSync(searchDatabasePath())).toBe(true)
  })

  it('100 个会话的热搜索低于 50ms 且快于旧实现', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-search-performance-test-'))
    const filler = 'x'.repeat(16_000)
    const sources = Array.from({ length: 100 }, (_, index) => ({
      filePath: writeJsonl(dir, `session-${index}.jsonl`, [
        { uuid: `u-${index}`, parentUuid: null, sessionId: `session-${index}`, type: 'user', timestamp: '2026-03-01T00:00:00Z', message: { role: 'user', content: `performance-needle ${filler}` } },
        { uuid: `a-${index}`, parentUuid: `u-${index}`, sessionId: `session-${index}`, type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: filler } }
      ])
    }))

    await searchSessionFiles('performance-needle', sources) // cold index build
    const hotStartedAt = performance.now()
    // Measure the same SQL-only path used by sessions:search. Index maintenance
    // is deliberately background work and must not be charged to keypress latency.
    const hot = searchIndexedSessions('performance-needle')
    const hotMs = performance.now() - hotStartedAt
    const legacyStartedAt = performance.now()
    const legacy = await legacySearchSessionFiles('performance-needle', sources)
    const legacyMs = performance.now() - legacyStartedAt

    const legacyIds = new Set(legacy.map((result) => result.sessionId))
    expect(hot).toHaveLength(50)
    expect(hot.every((result) => legacyIds.has(result.sessionId))).toBe(true)
    console.info(`search performance: legacy ${legacyMs.toFixed(1)}ms, hot ${hotMs.toFixed(1)}ms`)
    expect(hotMs).toBeLessThan(50)
    expect(hotMs).toBeLessThan(legacyMs)

    closeSearchIndex()
    const coldOpenStartedAt = performance.now()
    expect(searchIndexedSessions('performance-needle')).toHaveLength(50)
    const coldOpenMs = performance.now() - coldOpenStartedAt
    const querySamples = Array.from({ length: 100 }, () => {
      const startedAt = performance.now()
      searchIndexedSessions('performance-needle')
      return performance.now() - startedAt
    }).sort((a, b) => a - b)
    const queryP95Ms = querySamples[Math.floor(querySamples.length * 0.95)]
    console.info(`FTS acceptance: cold open ${coldOpenMs.toFixed(1)}ms, query p95 ${queryP95Ms.toFixed(1)}ms`)
    expect(coldOpenMs).toBeLessThan(200)
    // Under the full parallel suite this represents the ordinary p95 budget;
    // the uncontended hot-path assertion above remains the <50ms requirement.
    expect(queryP95Ms).toBeLessThan(100)
  })

  it('1700 个会话的 grep 热查询低于 500ms', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-grep-scale-test-'))
    const sources = Array.from({ length: 1700 }, (_, index) => ({
      filePath: writeJsonl(dir, `session-${index}.jsonl`, [{
        uuid: `u-${index}`,
        parentUuid: null,
        sessionId: `scale-${index}`,
        type: 'user',
        cwd: `/repo/project-${index % 20}`,
        timestamp: '2026-07-20T00:00:00Z',
        message: { role: 'user', content: index === 1699 ? 'scale-grep-needle' : `ordinary transcript ${index}` }
      }])
    }))
    await searchSessionFiles('scale-grep-needle', sources)

    const startedAt = performance.now()
    await synchronizeSearchSources(sources)
    const results = grepTranscripts('scale-grep-needle')
    const elapsedMs = performance.now() - startedAt

    expect(results).toHaveLength(1)
    expect(results[0].sessionId).toBe('scale-1699')
    console.info(`grep acceptance: 1700 sessions, hot refresh + query ${elapsedMs.toFixed(1)}ms`)
    expect(elapsedMs).toBeLessThan(500)
  }, 30_000)
})
