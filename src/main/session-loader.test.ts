/**
 * session-loader.ts 核心解析逻辑测试
 *
 * 这些函数虽然不是 UI，但出 bug 时你看到的全是 UI 怪象：
 * - 列表里 session 标题是 "[Request interrupted..."
 * - 点击 session 看到空白
 * - 工具统计数字不对
 * - 分支检测误判
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  buildSessionSummary,
  buildSessionSummaryFromBackup,
  buildSessionDetail,
  loadSessionDetail,
  loadSessionDetailWithFallback,
  detectIntraFileBranches,
  filterMessagesByBranch,
  findClaudeProjectRoots,
  findSessionFilesInProjectRoots,
  decodeClaudeProjectDirectoryName,
  getClaudeConfigDirForSessionFile,
  isRealUserMessage,
  projectCanonicalProviderSessions,
  restoreOmittedUsageEvents,
  parseSessionFile,
  parseSessionFileWithStats,
  SUMMARY_CACHE_VERSION
} from './session-loader'
import { compactPerFileJson } from './summary-cache-compact.cjs'
import { Worker } from 'node:worker_threads'
import { buildResumeCommand, resolveSessionActionContext } from './session-actions'
import { buildExecutionTree } from './execution-tree'
import { shellQuote } from './resume-terminal'
import { accountingFromMutuallyExclusiveUsage } from './token-accounting'
import { installFakeSqlite3, realSqlite3Path, type FakeSqlite3 } from './__test-support__/fake-sqlite3'
import {
  codexClock,
  codexJsonl,
  codexRow,
  codexTime,
  copiedPrefix,
  type CodexFixtureRow,
  type CodexRowBase
} from './__fixtures__/codex-rollout-synthetic'
import { isSessionSourceSupported } from './platform-support'
import type { SessionLoadEvidence } from './session-loader'
import type { RawJsonlMessage } from './types'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'

// --- 造假 JSONL 消息的工具函数 ---
function rawMsg(overrides: Partial<RawJsonlMessage> & { type: RawJsonlMessage['type'] }): RawJsonlMessage {
  const message: RawJsonlMessage = {
    uuid: overrides.uuid || Math.random().toString(36).slice(2),
    parentUuid: overrides.parentUuid ?? null,
    sessionId: overrides.sessionId || 'test-session-id',
    type: overrides.type,
    subtype: overrides.subtype,
    timestamp: overrides.timestamp || '2026-03-01T00:00:00Z',
    cwd: overrides.cwd || '/Users/test',
    version: overrides.version || '2.1.63',
    slug: overrides.slug,
    isSidechain: overrides.isSidechain,
    requestId: overrides.requestId,
    promptSource: overrides.promptSource ?? (overrides.type === 'user' ? 'typed' : undefined),
    message: overrides.message,
    permissionMode: overrides.permissionMode
  }
  if (overrides.forkedFrom !== undefined) message.forkedFrom = overrides.forkedFrom
  if (overrides.origin !== undefined) message.origin = overrides.origin
  if (overrides.isMeta !== undefined) message.isMeta = overrides.isMeta
  if (overrides.sourceToolAssistantUUID !== undefined) {
    message.sourceToolAssistantUUID = overrides.sourceToolAssistantUUID
  }
  if (overrides.toolUseResult !== undefined) message.toolUseResult = overrides.toolUseResult
  return message
}

// 写一个临时 JSONL 文件（测试 parseSessionFile 用）
function writeTempJsonl(messages: RawJsonlMessage[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-test-'))
  const fp = path.join(dir, 'test-session-id.jsonl')
  const content = messages.map((m) => JSON.stringify(m)).join('\n')
  fs.writeFileSync(fp, content)
  return fp
}

function writeJsonlAt(filePath: string, messages: RawJsonlMessage[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, messages.map((m) => JSON.stringify(m)).join('\n'))
  return filePath
}

function summaryCacheDbPath(home: string): string {
  return path.join(home, '.claude-session-manager', 'summary-cache.sqlite')
}

function readSummaryCache(home: string): { version: number; entries: Record<string, any> } {
  const database = new Database(summaryCacheDbPath(home), { readonly: true, fileMustExist: true })
  try {
    const entries: Record<string, any> = {}
    const rows = database.prepare(`
      SELECT file_path, sig, per_file_json FROM summary_cache_entries ORDER BY file_path
    `).all() as Array<{ file_path: string; sig: string; per_file_json: string }>
    for (const row of rows) {
      entries[row.file_path] = { sig: row.sig, perFile: JSON.parse(row.per_file_json) }
    }
    return { version: Number(database.pragma('user_version', { simple: true })), entries }
  } finally {
    database.close()
  }
}

function removeSummaryCache(home: string): void {
  const directory = path.join(home, '.claude-session-manager')
  for (const name of [
    'summary-cache.json',
    'summary-cache.sqlite',
    'summary-cache.sqlite-journal',
    'summary-cache.sqlite-wal',
    'summary-cache.sqlite-shm'
  ]) {
    fs.rmSync(path.join(directory, name), { force: true })
  }
}

function writeLegacySummaryCache(home: string, cache: unknown): string {
  removeSummaryCache(home)
  const cachePath = path.join(home, '.claude-session-manager', 'summary-cache.json')
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  fs.writeFileSync(cachePath, JSON.stringify(cache))
  return cachePath
}

function writeObjectJsonl(fileName: string, rows: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-backup-test-'))
  const fp = path.join(dir, fileName)
  fs.writeFileSync(fp, rows.map((row) => JSON.stringify(row)).join('\n'))
  return fp
}

function codexBackupRows(sessionId: string): unknown[] {
  return [
    {
      timestamp: '2026-07-07T00:00:00Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2026-07-07T00:00:00Z',
        cwd: '/Users/test/projects/codex-app',
        cli_version: 'codex-test'
      }
    },
    {
      timestamp: '2026-07-07T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '从 Codex backup 建 summary' }]
      }
    },
    {
      timestamp: '2026-07-07T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Codex backup summary 已恢复。' }]
      }
    }
  ]
}

function codexRoleRows(params: {
  sessionId: string
  userText: string
  inputTokens: number
  outputTokens: number
  turnId: string
  source?: unknown
  parentThreadId?: string
}): unknown[] {
  return [
    {
      timestamp: '2026-07-22T00:00:00Z',
      type: 'session_meta',
      payload: {
        id: params.sessionId,
        timestamp: '2026-07-22T00:00:00Z',
        cwd: '/Users/test/projects/swob',
        cli_version: 'codex-test',
        model_provider: 'openai',
        source: params.source || 'vscode',
        ...(params.parentThreadId
          ? { thread_source: 'subagent', parent_thread_id: params.parentThreadId }
          : {})
      }
    },
    {
      timestamp: '2026-07-22T00:00:01Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: params.userText }]
      }
    },
    {
      timestamp: '2026-07-22T00:00:02Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '完成' }]
      }
    },
    {
      timestamp: '2026-07-22T00:00:02Z',
      type: 'turn_context',
      payload: { turn_id: params.turnId, model: 'gpt-5.4', model_provider: 'openai' }
    },
    {
      timestamp: '2026-07-22T00:00:03Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          turn_id: params.turnId,
          last_token_usage: {
            input_tokens: params.inputTokens,
            output_tokens: params.outputTokens,
            cached_input_tokens: 0
          }
        }
      }
    },
    {
      timestamp: '2026-07-22T00:00:04Z',
      type: 'event_msg',
      payload: { type: 'task_complete' }
    }
  ]
}

function cursorBackupRows(prompt = '从 Cursor backup 建 detail'): unknown[] {
  return [
    { role: 'user', message: { content: `<user_query>${prompt}</user_query>` } },
    { role: 'assistant', message: { content: [{ type: 'text', text: 'Cursor backup 已恢复。' }] } }
  ]
}

function createSqliteAgentCacheFixture(
  home: string,
  source: 'opencode' | 'zcode',
  sessionId: string
): string {
  const dbPath = source === 'opencode'
    ? path.join(home, '.local', 'share', 'opencode', 'opencode.db')
    : path.join(home, '.zcode', 'cli', 'db', 'db.sqlite')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        slug TEXT,
        directory TEXT,
        title TEXT,
        model TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        data TEXT,
        time_created INTEGER
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        message_id TEXT,
        type TEXT,
        idx INTEGER,
        data TEXT
      );
      CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, message_id TEXT);
    `)
    if (source === 'zcode') {
      db.exec(`
        CREATE TABLE model_usage (
          id TEXT PRIMARY KEY,
          logical_request_id TEXT,
          attempt_index INTEGER,
          session_id TEXT,
          provider_id TEXT,
          model_id TEXT,
          status TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_tokens INTEGER,
          cache_creation_input_tokens INTEGER,
          cache_read_input_tokens INTEGER,
          provider_total_tokens INTEGER,
          computed_total_tokens INTEGER
        );
      `)
    } else {
      db.exec('CREATE TABLE model_usage (id TEXT PRIMARY KEY, session_id TEXT);')
    }
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      sessionId,
      `${source}-slug`,
      `/fixture/${source}`,
      `${source} title`,
      `${source}-model`
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      `${source}-user`,
      sessionId,
      JSON.stringify({ role: 'user', time: { created: '2026-08-02T00:00:00Z' } }),
      1785628800
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
      `${source}-assistant`,
      sessionId,
      JSON.stringify({
        role: 'assistant',
        parentID: `${source}-user`,
        time: { created: '2026-08-02T00:00:01Z' },
        ...(source === 'opencode'
          ? {
              providerID: 'openai',
              modelID: 'gpt-5.1',
              tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 4 }, total: 27 }
            }
          : {})
      }),
      1785628801
    )
    if (source === 'zcode') {
      db.prepare('INSERT INTO model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        `${source}-usage`,
        `${source}-request`,
        0,
        sessionId,
        'zhipu',
        'glm-4.5',
        'completed',
        1785628801,
        1785628802,
        13,
        5,
        0,
        2,
        3,
        18,
        18
      )
    }
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
    insertPart.run(
      `${source}-part-user`,
      sessionId,
      `${source}-user`,
      'text',
      0,
      JSON.stringify({ text: `${source} source value` })
    )
    insertPart.run(
      `${source}-part-assistant`,
      sessionId,
      `${source}-assistant`,
      'text',
      0,
      JSON.stringify({ text: `${source} response` })
    )
  } finally {
    db.close()
  }
  return `${dbPath}#${sessionId}`
}

function sharedCrossSessionPrefix(sessionId: string): RawJsonlMessage[] {
  return [
    rawMsg({ uuid: 'shared-u1', sessionId, parentUuid: null, type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: '共享开始' } }),
    rawMsg({ uuid: 'shared-a1', sessionId, parentUuid: 'shared-u1', type: 'assistant', timestamp: '2026-06-10T10:01:00Z', message: { role: 'assistant', content: '收到' } }),
    rawMsg({ uuid: 'shared-u2', sessionId, parentUuid: 'shared-a1', type: 'user', timestamp: '2026-06-10T10:02:00Z', message: { role: 'user', content: '继续共享上下文' } }),
    rawMsg({ uuid: 'shared-a2', sessionId, parentUuid: 'shared-u2', type: 'assistant', timestamp: '2026-06-10T10:03:00Z', message: { role: 'assistant', content: '继续' } })
  ]
}

async function loadAllSessionsFromTempHome(
  home: string,
  options: {
    readOnly?: boolean
    migrateLegacyCache?: boolean
    quiet?: boolean
    omitCachedUsageEvents?: boolean
  } = {}
) {
  const oldHome = process.env.HOME
  process.env.HOME = home
  vi.resetModules()
  try {
    const mod = await import('./session-loader')
    return await mod.loadAllSessions(options)
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    vi.resetModules()
  }
}

/**
 * Import session-loader and the opencode-loader instance it uses, once, under
 * `home`. Several loads inside `run` share one module instance (a long-lived
 * desktop process); a later call starts cold.
 */
async function withSessionLoaderModules<T>(
  home: string,
  run: (modules: {
    sessionLoader: typeof import('./session-loader')
    sqliteAgent: typeof import('./opencode-loader')
  }) => Promise<T>
): Promise<T> {
  const oldHome = process.env.HOME
  process.env.HOME = home
  vi.resetModules()
  try {
    const sessionLoader = await import('./session-loader')
    const sqliteAgent = await import('./opencode-loader')
    return await run({ sessionLoader, sqliteAgent })
  } finally {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    vi.resetModules()
  }
}

/**
 * Add one more session (same layout as createSqliteAgentCacheFixture) to an
 * existing DB. `withUsage` gives its assistant message OpenCode token usage.
 */
function addSqliteAgentSession(
  dbPath: string,
  sessionId: string,
  prompt: string,
  options: { withUsage?: boolean } = {}
): string {
  const db = new Database(dbPath)
  try {
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?)').run(
      sessionId, `${sessionId}-slug`, '/fixture/opencode', `${sessionId} title`, 'opencode-model'
    )
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`${sessionId}-user`, sessionId,
      JSON.stringify({ role: 'user', time: { created: '2026-08-03T00:00:00Z' } }), 1785715200)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(`${sessionId}-assistant`, sessionId,
      JSON.stringify({
        role: 'assistant',
        parentID: `${sessionId}-user`,
        time: { created: '2026-08-03T00:00:01Z' },
        ...(options.withUsage
          ? {
              providerID: 'openai',
              modelID: 'gpt-5.1',
              tokens: { input: 13, output: 5, reasoning: 1, cache: { read: 2, write: 3 }, total: 24 }
            }
          : {})
      }), 1785715201)
    const insertPart = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
    insertPart.run(`${sessionId}-part-user`, sessionId, `${sessionId}-user`, 'text', 0, JSON.stringify({ text: prompt }))
    insertPart.run(`${sessionId}-part-assistant`, sessionId, `${sessionId}-assistant`, 'text', 0,
      JSON.stringify({ text: `${prompt} answer` }))
  } finally {
    db.close()
  }
  return `${dbPath}#${sessionId}`
}

/** Change a SQLite-agent DB file (and so its cache signature) without touching any session. */
function touchSqliteAgentDb(dbPath: string): void {
  const db = new Database(dbPath)
  try {
    db.exec('CREATE TABLE IF NOT EXISTS f1e_touch (id INTEGER PRIMARY KEY); INSERT INTO f1e_touch DEFAULT VALUES;')
  } finally {
    db.close()
  }
}

function readSummaryCacheRow(
  home: string,
  filePath: string
): { sig: string; per_file_json: string; compact_json: string | null } | undefined {
  const database = new Database(summaryCacheDbPath(home), { readonly: true, fileMustExist: true })
  try {
    return database.prepare(
      'SELECT sig, per_file_json, compact_json FROM summary_cache_entries WHERE file_path = ?'
    ).get(filePath) as { sig: string; per_file_json: string; compact_json: string | null } | undefined
  } finally {
    database.close()
  }
}

/** Stamp the summary cache with another version, as a CACHE_VERSION bump (F1d) would leave it. */
function setSummaryCacheVersion(home: string, version: number): void {
  const database = new Database(summaryCacheDbPath(home))
  try {
    database.pragma(`user_version = ${version}`)
  } finally {
    database.close()
  }
}

function incrementalCacheLog(spy: ReturnType<typeof vi.spyOn>): string {
  const call = [...spy.mock.calls].reverse().find(([message]) =>
    typeof message === 'string' && message.includes('[session-loader] incremental cache:')
  )
  return String(call?.[0] || '')
}

// ========================================================
// Claude session discovery 测试
// ========================================================
describe('Claude session discovery', () => {
  it('Claude 项目目录名支持 Windows 盘符 dash 编码', () => {
    expect(decodeClaudeProjectDirectoryName('C--Users-Alice-project', 'win32'))
      .toBe('C:\\Users\\Alice\\project')
    expect(decodeClaudeProjectDirectoryName('-Users-alice-project', 'darwin'))
      .toBe('/Users/alice/project')
    expect(decodeClaudeProjectDirectoryName('relative-project', 'win32')).toBeUndefined()
  })

  it('应该同时扫描 ~/.claude/projects 和 ~/.claude-window/*/projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-home-'))
    const standardRoot = path.join(home, '.claude', 'projects')
    const windowRoot = path.join(home, '.claude-window', 'aec2c37b389f', 'projects')
    const standardFile = writeJsonlAt(
      path.join(standardRoot, '-Users-test-projects-swob', 'standard-session.jsonl'),
      [rawMsg({ type: 'user', sessionId: 'standard-session', message: { role: 'user', content: '标准 Claude session' } })]
    )
    const windowFile = writeJsonlAt(
      path.join(windowRoot, '-Users-test-projects-draftbox', 'window-session.jsonl'),
      [rawMsg({ type: 'user', sessionId: 'window-session', message: { role: 'user', content: 'Claude Window session' } })]
    )
    const subagentFile = writeJsonlAt(
      path.join(windowRoot, '-Users-test-projects-draftbox', 'subagents', 'agent-session.jsonl'),
      [rawMsg({ type: 'user', sessionId: 'subagent-session', message: { role: 'user', content: 'subagent' } })]
    )

    const roots = findClaudeProjectRoots(home)
    expect(roots).toContain(standardRoot)
    expect(roots).toContain(windowRoot)

    const files = findSessionFilesInProjectRoots(roots)
    expect(files).toContain(standardFile)
    expect(files).toContain(windowFile)
    expect(files).not.toContain(subagentFile)
  })

  it('Claude Window session 应该记录对应的 CLAUDE_CONFIG_DIR', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-home-'))
    const configDir = path.join(home, '.claude-window', 'aec2c37b389f')
    const sessionFile = writeJsonlAt(
      path.join(configDir, 'projects', '-Users-test-projects-draftbox', 'window-session.jsonl'),
      [
        rawMsg({
          type: 'user',
          sessionId: 'window-session',
          cwd: '/Users/test/projects/draftbox',
          message: { role: 'user', content: 'DraftBox 开发 session' }
        })
      ]
    )
    const standardFile = path.join(home, '.claude', 'projects', '-Users-test-projects-swob', 'standard-session.jsonl')

    expect(getClaudeConfigDirForSessionFile(sessionFile, home)).toBe(configDir)
    expect(getClaudeConfigDirForSessionFile(standardFile, home)).toBeUndefined()

    const oldHome = process.env.HOME
    process.env.HOME = home
    try {
      const summary = buildSessionSummary(sessionFile, [
        rawMsg({
          type: 'user',
          sessionId: 'window-session',
          cwd: '/Users/test/projects/draftbox',
          message: { role: 'user', content: 'DraftBox 开发 session' }
        })
      ], true)
      expect(summary?.claudeConfigDir).toBe(configDir)
      expect(summary?.resumeCwd).toBe('/Users/test/projects/draftbox')
    } finally {
      if (oldHome === undefined) delete process.env.HOME
      else process.env.HOME = oldHome
    }
  })

  it('【回归】新增 harness 保留真实 source；未验证格式不得套用 Claude token parser', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-new-sources-home-'))
    const ccRows = [
      rawMsg({ type: 'user', sessionId: 'cc-session', message: { role: 'user', content: 'CC Mirror 真实消息' } }),
      rawMsg({
        type: 'assistant', sessionId: 'cc-session',
        message: { id: 'cc-msg', role: 'assistant', content: '完成', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }
      })
    ]
    writeJsonlAt(path.join(home, '.cc-mirror', 'default', 'projects', '-Users-test-cc', 'cc-session.jsonl'), ccRows)
    writeJsonlAt(path.join(home, '.gemini', 'antigravity-cli', 'brain', 'agy-session', 'transcript.jsonl'), [] as RawJsonlMessage[])
    writeJsonlAt(path.join(home, '.grok', 'sessions', 'grok-session.jsonl'), [] as RawJsonlMessage[])
    writeJsonlAt(path.join(home, '.pi', 'agent', 'sessions', 'pi-session.jsonl'), [] as RawJsonlMessage[])
    writeJsonlAt(path.join(home, '.kimi-code', 'sessions', 'kimi-session', 'wire.jsonl'), [] as RawJsonlMessage[])
    const hermesPath = path.join(home, '.hermes', 'sessions', 'hermes-session.json')
    fs.mkdirSync(path.dirname(hermesPath), { recursive: true })
    fs.writeFileSync(hermesPath, '{}')

    const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
    const cc = sessions.find((session) => session.source === 'cc-mirror')
    expect(cc?.firstUserMessage).toBe('CC Mirror 真实消息')
    expect(cc?.tokenAccounting?.billingTotal).toBe(15)

    // Native canonical providers are excluded from this physical readOnly scan.
    // Invalid legacy singleton files must not fall back to synthetic placeholders.
    expect(sessions.filter((session) => session.source === 'pi')).toHaveLength(0)
    // Kimi is also native canonical. readOnly intentionally never opens the
    // canonical SQLite store, and this path is not a valid Kimi agent source.
    expect(sessions.filter((session) => session.source === 'kimi')).toHaveLength(0)
    expect(sessions.filter((session) => session.source === 'grok')).toHaveLength(0)
    expect(sessions.filter((session) => session.source === 'antigravity')).toHaveLength(0)
    expect(sessions.filter((session) => session.source === 'hermes')).toHaveLength(0)
    expect(sessions.filter((session) => session.source === 'claude-code')).toHaveLength(0)
  })

  it('【回归】Canonical store 故障不能让健康的旧来源首屏变空', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-canonical-failure-home-'))
    try {
      const sessionPath = path.join(
        home,
        '.claude',
        'projects',
        '-Users-test-projects-legacy',
        'legacy-session.jsonl'
      )
      writeJsonlAt(sessionPath, [
        rawMsg({
          type: 'user',
          sessionId: 'legacy-survives-canonical-failure',
          cwd: '/Users/test/projects/legacy',
          message: { role: 'user', content: 'legacy source remains visible' }
        }),
        rawMsg({
          type: 'assistant',
          sessionId: 'legacy-survives-canonical-failure',
          cwd: '/Users/test/projects/legacy',
          message: { role: 'assistant', content: 'still here' }
        })
      ])
      const canonicalDir = path.join(home, '.claude-session-manager')
      fs.mkdirSync(canonicalDir, { recursive: true })
      const broken = new Database(path.join(canonicalDir, 'canonical.db'))
      broken.pragma('user_version = 999')
      broken.close()

      const sessions = await loadAllSessionsFromTempHome(home, { quiet: true })
      expect(sessions).toContainEqual(expect.objectContaining({
        sessionId: 'legacy-survives-canonical-failure',
        source: 'claude-code',
        firstUserMessage: 'legacy source remains visible'
      }))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('Canonical 单会话投影失败时保留健康结果并将 Provider 标为 degraded', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const projection = projectCanonicalProviderSessions([], {
        status: 'complete',
        sessions: [{
          sessionRecord: {
            id: 'invalid-canonical-session',
            provenance: { providerId: 'swob/pi' },
            sourceRef: { displayLocator: '/synthetic/invalid.jsonl' }
          },
          records: []
        } as any]
      })

      expect(projection.summaries).toEqual([])
      expect(projection.providerStatus).toBe('degraded')
      expect(warnSpy).toHaveBeenCalledOnce()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('初始物理源扫描失败会拒绝 IPC 上游，而不是伪造空的成功快照', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-source-failure-home-'))
    const previous = process.env.SWOB_TEST_SESSION_LOAD_FAILURE
    process.env.SWOB_TEST_SESSION_LOAD_FAILURE = '1'
    try {
      await expect(loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true }))
        .rejects.toThrow('synthetic-session-load-failure')
    } finally {
      if (previous === undefined) delete process.env.SWOB_TEST_SESSION_LOAD_FAILURE
      else process.env.SWOB_TEST_SESSION_LOAD_FAILURE = previous
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('【回归】Claude 主文件与 subagent 共用去重表，同时保留 billing/conversation 两种 scope', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-subagent-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-project')
    const mainRows = [
      rawMsg({ type: 'user', sessionId: 'main-session', message: { role: 'user', content: '让 subagent 调研' } }),
      rawMsg({
        type: 'assistant', sessionId: 'main-session', uuid: 'main-call', requestId: 'shared-request',
        message: { id: 'shared-message', role: 'assistant', content: '主线程', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      })
    ]
    const subagentRows = [
      rawMsg({
        type: 'assistant', sessionId: 'main-session', uuid: 'shared-copy', requestId: 'shared-request', isSidechain: true,
        message: { id: 'shared-message', role: 'assistant', content: '重复副本', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      }),
      rawMsg({
        type: 'assistant', sessionId: 'main-session', uuid: 'subagent-call', requestId: 'subagent-request', isSidechain: true,
        message: { id: 'subagent-message', role: 'assistant', content: '子代理独立调用', stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } }
      })
    ]
    writeJsonlAt(path.join(projectDir, 'main-session.jsonl'), mainRows)
    writeJsonlAt(path.join(projectDir, 'subagents', 'agent-research.jsonl'), subagentRows)

    const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
    const summary = sessions.find((session) => session.sessionId === 'main-session')

    expect(summary?.tokenAccounting?.usageEvents).toHaveLength(2)
    expect(summary?.tokenAccounting?.billingTotal).toBe(180)
    expect(summary?.tokenAccounting?.conversationOnly).toBe(120)
    expect(summary?.tokenAccounting?.usageEvents.map((event) => event.scope).sort()).toEqual(['main', 'subagent'])
  })

  it('t184: archived + custom CODEX_HOME + replay 三重 fixture 的 lineage 与总账闭环', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-lifecycle-home-'))
    const customHome = path.join(home, 'codex-work')
    const parentId = '18400000-0000-4000-8000-000000000001'
    const replayId = '18400000-0000-4000-8000-000000000002'
    const archivedId = '18400000-0000-4000-8000-000000000003'
    const project = path.join(home, 'project')
    const meta = (id: string, extra: Record<string, unknown> = {}) => ({
      timestamp: '2026-08-02T10:00:00.000Z',
      type: 'session_meta',
      payload: {
        id, timestamp: '2026-08-02T10:00:00.000Z', cwd: project,
        cli_version: 'codex-test', model_provider: 'openai', ...extra
      }
    })
    const conversation = (prompt: string, offset: number) => [
      {
        timestamp: `2026-08-02T10:00:0${offset}.000Z`, type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }
      },
      {
        timestamp: `2026-08-02T10:00:0${offset + 1}.000Z`, type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '完成' }] }
      }
    ]
    const usage = (
      timestamp: string,
      turnId: string,
      inputTokens: number,
      outputTokens: number,
      totalInput: number,
      totalOutput: number
    ) => ({
      timestamp, type: 'event_msg', payload: {
        type: 'token_count', info: {
          turn_id: turnId,
          last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens, cached_input_tokens: 0 },
          total_token_usage: { input_tokens: totalInput, output_tokens: totalOutput, cached_input_tokens: 0 }
        }
      }
    })
    const sharedUsage = usage('2026-08-02T10:00:03.000Z', 'shared-turn', 100, 20, 100, 20)

    writeJsonlAt(path.join(
      customHome, 'sessions', '2026', '08', '02', `rollout-parent-${parentId}.jsonl`
    ), [
      meta(parentId),
      { timestamp: '2026-08-02T10:00:00.500Z', type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
      ...conversation('原会话', 1),
      sharedUsage
    ] as unknown as RawJsonlMessage[])
    writeJsonlAt(path.join(
      customHome, 'sessions', '2026', '08', '02', `rollout-replay-${replayId}.jsonl`
    ), [
      meta(replayId, { forked_from_id: parentId }),
      { timestamp: '2026-08-02T10:00:00.500Z', type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
      ...conversation('原会话的复制前缀', 1),
      sharedUsage,
      { timestamp: '2026-08-02T10:00:04.000Z', type: 'event_msg', payload: { type: 'thread_rolled_back', num_turns: 1 } },
      ...conversation('rollback 后的 replay 新问题', 5),
      usage('2026-08-02T10:00:07.000Z', 'replay-only', 50, 10, 150, 30)
    ] as unknown as RawJsonlMessage[])
    writeJsonlAt(path.join(
      home, '.codex', 'archived_sessions', `rollout-archived-${archivedId}.jsonl`
    ), [
      meta(archivedId),
      { timestamp: '2026-08-02T10:00:00.500Z', type: 'turn_context', payload: { model: 'gpt-5.6-terra' } },
      ...conversation('已归档会话', 1),
      usage('2026-08-02T10:00:03.500Z', 'archived-only', 30, 5, 30, 5)
    ] as unknown as RawJsonlMessage[])
    fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude-session-manager', 'codex-homes.json'), JSON.stringify({
      version: 1,
      homes: [customHome]
    }))

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
      const parent = sessions.find((session) => session.sessionId === parentId)
      const replay = sessions.find((session) => session.sessionId === replayId)
      const archived = sessions.find((session) => session.sessionId === archivedId)

      expect(parent).toMatchObject({ lifecycleState: 'active', branchChildIds: [`codex:${replayId}`] })
      expect(replay).toMatchObject({ lifecycleState: 'replayed', branchParentId: `codex:${parentId}` })
      expect(replay?.branchParentFilePaths).toEqual(parent?.allFilePaths || [parent?.filePath])
      expect(archived).toMatchObject({ lifecycleState: 'archived' })

      const uniqueBillingFacts = new Map<string, number>()
      for (const session of [parent, replay, archived]) {
        for (const event of session?.tokenAccounting?.usageEvents || []) {
          const components = event.components
          uniqueBillingFacts.set(event.billingFactKey || `${session?.id}:${event.dedupKey}`,
            components.nonCachedInputTokens + components.cacheReadTokens + components.cacheWriteTokens +
            components.cacheWrite5mTokens + components.cacheWrite1hTokens + components.outputTokens)
        }
      }
      expect([...uniqueBillingFacts.values()].reduce((sum, value) => sum + value, 0)).toBe(215)
      expect(uniqueBillingFacts.size).toBe(3)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('【回归】同一 provider/session id 的跨文件副本只保留最完整 token 快照', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-cross-file-home-'))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '22')
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const codexRows = (inputTokens: number, outputTokens: number, suffix: string) => [
      {
        timestamp: `2026-07-22T00:00:0${suffix}Z`, type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-07-22T00:00:00Z', cwd: '/Users/test/codex', cli_version: 'test' }
      },
      {
        timestamp: `2026-07-22T00:00:1${suffix}Z`, type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '跨文件去重' }] }
      },
      {
        timestamp: `2026-07-22T00:00:2${suffix}Z`, type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } } }
      }
    ]
    fs.mkdirSync(codexDir, { recursive: true })
    fs.writeFileSync(path.join(codexDir, 'rollout-copy-a.jsonl'), codexRows(500, 200, '1').map((row) => JSON.stringify(row)).join('\n'))
    fs.writeFileSync(path.join(codexDir, 'rollout-copy-b.jsonl'), codexRows(650, 250, '2').map((row) => JSON.stringify(row)).join('\n'))

    const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
    const codexSessions = sessions.filter((session) => session.source === 'codex')

    expect(codexSessions).toHaveLength(1)
    expect(codexSessions[0].tokenAccounting?.billingTotal).toBe(900)
    expect(codexSessions[0].allFilePaths).toHaveLength(2)
    expect(codexSessions[0].tokenAccounting?.warnings.join(' ')).toContain('deduplicated 2 files')
  })
})

// ========================================================
// buildSessionSummary 测试
// ========================================================
describe('buildSessionSummary', () => {
  it('基本解析：提取 sessionId、时间、轮次', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '你好！' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    expect(summary!.sessionId).toBe('test-session-id')
    expect(summary!.turnCount).toBe(1)
    expect(summary!.messageCount).toBe(2)
    expect(summary!.createdAt).toBe('2026-03-01T10:00:00Z')
    expect(summary!.activityDays).toEqual(['2026-03-01'])
    expect(summary!.firstUserMessage).toBe('你好')
  })

  it('仅 detection/system timestamp 不构成 bounded activity evidence', () => {
    const msgs = [rawMsg({
      type: 'system',
      timestamp: '2026-03-01T10:00:00Z',
      message: { role: 'system', content: 'detected placeholder' }
    })]
    const summary = buildSessionSummary(writeTempJsonl(msgs), msgs)
    expect(summary).not.toBeNull()
    expect(summary?.turnCount).toBe(0)
    expect(summary?.activityDays).toEqual([])
  })

  it('Windows 绝对路径的写入动作不能被丢弃', () => {
    const windowsFile = 'C:\\Users\\Alice\\project\\src\\main.ts'
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '修改 Windows 项目' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'write-win-file', name: 'Write', input: { file_path: windowsFile } }]
        }
      })
    ]
    const summary = buildSessionSummary(writeTempJsonl(msgs), msgs)

    expect(summary?.referencedFiles).toContainEqual({
      path: windowsFile,
      actions: ['write'],
      exists: false
    })
  })


  it('【真实 bug】firstUserMessage 应该跳过 "[Request interrupted..."', () => {
    // 之前这种消息会作为 session 标题显示，用户看到一堆 "[Request interrupted..."
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '[Request interrupted by user for tool_use]' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '...' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '帮我写一个排序函数' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('帮我写一个排序函数')
  })

  it('firstUserMessage 应该跳过 compact 续写开头', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '继续帮我改那个 bug' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '改好了' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('继续帮我改那个 bug')
  })

  it('firstUserMessage 应该跳过 local-command 和命令输出', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '<local-command-caveat>Caveat: generated while running local commands</local-command-caveat>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '现在文件夹里有大量的单轮会话' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '开始处理' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('现在文件夹里有大量的单轮会话')
    expect(summary!.turnCount).toBe(1)
  })

  it('compact 次数统计', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '第一轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
      rawMsg({ type: 'system', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '第二轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } }),
      rawMsg({ type: 'system', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '第三轮' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.compactCount).toBe(2)
  })

  it('工具调用统计', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '读一下文件' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看' },
            { type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/a.ts' } },
            { type: 'tool_use', name: 'Read', id: 't2', input: { file_path: '/b.ts' } },
            { type: 'tool_use', name: 'Bash', id: 't3', input: { command: 'ls' } }
          ]
        }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.toolUsage['Read']).toBe(2)
    expect(summary!.toolUsage['Bash']).toBe(1)
  })

  it('【回归】Claude streaming 快照与 fork 继承 usage 不得重复计入 summary', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '统计 token' } }),
      rawMsg({
        type: 'assistant', uuid: 'snap-1', requestId: 'req-1',
        message: { id: 'msg-1', role: 'assistant', content: 'partial', stop_reason: null, usage: { input_tokens: 100, output_tokens: 10 } }
      }),
      rawMsg({
        type: 'assistant', uuid: 'snap-2', requestId: 'req-1',
        message: { id: 'msg-1', role: 'assistant', content: 'done', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 } }
      }),
      rawMsg({
        type: 'assistant', uuid: 'fork-copy',
        forkedFrom: { sessionId: 'parent', messageUuid: 'parent-message' },
        message: { id: 'forked', role: 'assistant', content: 'inherited', stop_reason: 'end_turn', usage: { input_tokens: 5_000, output_tokens: 5_000 } }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)!

    expect(summary.tokenAccounting?.billingTotal).toBe(120)
    expect(summary.tokenUsage).toEqual({ inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 })
  })

  it('subagent 文件路径应该返回 null', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } })
    ]
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-test-'))
    const subDir = path.join(dir, 'subagents')
    fs.mkdirSync(subDir, { recursive: true })
    const fp = path.join(subDir, 'agent-abc.jsonl')
    fs.writeFileSync(fp, msgs.map((m) => JSON.stringify(m)).join('\n'))

    const summary = buildSessionSummary(fp, msgs)
    expect(summary).toBeNull()
  })

  it('空消息列表应该返回 null', () => {
    const fp = writeTempJsonl([])
    const summary = buildSessionSummary(fp, [])
    expect(summary).toBeNull()
  })

  it('多个 cwd 都应该被收集', () => {
    const msgs = [
      rawMsg({ type: 'user', cwd: '/Users/test/project-a', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', cwd: '/Users/test/project-a', message: { role: 'assistant', content: '好' } }),
      rawMsg({ type: 'user', cwd: '/Users/test/project-b', message: { role: 'user', content: '切目录了' } }),
      rawMsg({ type: 'assistant', cwd: '/Users/test/project-b', message: { role: 'assistant', content: '好' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.cwds).toContain('/Users/test/project-a')
    expect(summary!.cwds).toContain('/Users/test/project-b')
  })

  it('resume 应该使用会话最初创建时的 cwd，而不是后来 cd 进去的目录', () => {
    const msgs = [
      rawMsg({
        type: 'user',
        cwd: '/Users/test/project-a',
        permissionMode: 'bypassPermissions',
        version: '2.1.71',
        message: { role: 'user', content: '第一轮' }
      }),
      rawMsg({
        type: 'assistant',
        cwd: '/Users/test/project-a',
        permissionMode: 'bypassPermissions',
        version: '2.1.71',
        message: { role: 'assistant', content: '收到' }
      }),
      rawMsg({
        type: 'user',
        cwd: '/Users/test/project-b',
        permissionMode: 'default',
        version: '2.1.85',
        message: { role: 'user', content: '后来切到另一个目录继续' }
      }),
      rawMsg({
        type: 'assistant',
        cwd: '/Users/test/project-b',
        permissionMode: 'default',
        version: '2.1.85',
        message: { role: 'assistant', content: '继续完成' }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.cwds).toEqual(['/Users/test/project-a', '/Users/test/project-b'])
    expect(summary!.resumeCwd).toBe('/Users/test/project-a')
    expect(summary!.permissionMode).toBe('default')
    expect(summary!.version).toBe('2.1.85')
  })

  it('content 是数组格式（含图片等）也能正确提取文本', () => {
    const msgs = [
      rawMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            { type: 'image', source: { type: 'base64', data: '...' } }
          ] as any
        }
      }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '我看到了' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary!.firstUserMessage).toBe('看看这张图')
  })
})

describe('buildSessionSummaryFromBackup', () => {
  it('【曾经的 bug】codex backup.jsonl 无本机源时应该建出非 null summary', async () => {
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const fp = writeObjectJsonl('backup.jsonl', codexBackupRows(sessionId))

    const summary = await buildSessionSummaryFromBackup(fp, sessionId, {
      sourceFilePaths: ['/missing/unknown-source.jsonl']
    })

    expect(summary).not.toBeNull()
    expect(summary!.source).toBe('codex')
    expect(summary!.id).toBe(`codex:${sessionId}`)
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.firstUserMessage).toBe('从 Codex backup 建 summary')
  })

  it('【曾经的 bug】claude backup.jsonl 仍然走 Claude parser', async () => {
    const sessionId = 'claude-backup-123'
    const fp = writeObjectJsonl('backup.jsonl', [
      rawMsg({
        type: 'user',
        sessionId,
        timestamp: '2026-07-07T00:00:00Z',
        message: { role: 'user', content: 'Claude backup 不能回归' }
      }),
      rawMsg({
        type: 'assistant',
        sessionId,
        timestamp: '2026-07-07T00:00:01Z',
        message: { role: 'assistant', content: '收到' }
      })
    ])

    const summary = await buildSessionSummaryFromBackup(fp, sessionId, {
      sourceFilePaths: ['/missing/unknown-source.jsonl']
    })

    expect(summary).not.toBeNull()
    expect(summary!.source).toBe('claude-code')
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.firstUserMessage).toBe('Claude backup 不能回归')
  })

  it('backup source path 与内容冲突时 summary 优先使用 backup 内容来源', async () => {
    const sessionId = 'cursor-backup-conflict'
    const fp = writeObjectJsonl('backup.jsonl', cursorBackupRows('Cursor 内容优先'))

    const summary = await buildSessionSummaryFromBackup(fp, sessionId, {
      sourceFilePaths: [
        '/Users/test/.codex/sessions/2026/07/07/rollout-2026-07-07T00-00-00-00000000-0000-4000-8000-000000000000.jsonl'
      ]
    })

    expect(summary).not.toBeNull()
    expect(summary!.source).toBe('cursor')
    expect(summary!.id).toBe(`cursor:${sessionId}`)
    expect(summary!.sessionId).toBe(sessionId)
    expect(summary!.firstUserMessage).toBe('Cursor 内容优先')
  })
})

describe('loadSessionDetail source-aware backup', () => {
  it('backup 缺失时回退到同包 transcript，二者都缺失时返回 typed error', async () => {
    const dirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-transcript-fallback-'))
    const backupPath = path.join(dirPath, 'backup.jsonl')
    const transcriptPath = path.join(dirPath, 'transcript.md')
    fs.writeFileSync(transcriptPath, '# OpenCode transcript\n\n可读正文', 'utf-8')

    await expect(loadSessionDetailWithFallback(
      backupPath, undefined, undefined, undefined, undefined, [transcriptPath]
    )).resolves.toEqual({
      fallback: 'transcript',
      transcriptMarkdown: '# OpenCode transcript\n\n可读正文'
    })

    fs.rmSync(transcriptPath)
    await expect(loadSessionDetailWithFallback(
      backupPath, undefined, undefined, undefined, undefined, [transcriptPath]
    )).resolves.toEqual({
      fallback: null,
      error: 'DETAIL_UNAVAILABLE'
    })
  })

  it('【曾经的 bug】loadSessionDetail 喂 codex backup.jsonl 应返回非 null detail', async () => {
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const fp = writeObjectJsonl('backup.jsonl', codexBackupRows(sessionId))

    const detail = await loadSessionDetail(fp)

    expect(detail).not.toBeNull()
    expect(detail!.source).toBe('codex')
    expect(detail!.sessionId).toBe(sessionId)
    expect(detail!.messages.length).toBeGreaterThan(0)
  })

  it('cursor backup.jsonl 缺 .swob-session.json 时不使用父目录名生成错误 id', async () => {
    const fp = writeObjectJsonl('backup.jsonl', cursorBackupRows())

    const detail = await loadSessionDetail(fp)

    expect(detail).toBeNull()
  })

  it('cursor backup.jsonl 的 .swob-session.json 缺 sessionId 时不使用父目录名生成错误 id', async () => {
    const fp = writeObjectJsonl('backup.jsonl', cursorBackupRows())
    fs.writeFileSync(path.join(path.dirname(fp), '.swob-session.json'), JSON.stringify({ sourceFilePaths: [] }))

    const detail = await loadSessionDetail(fp)

    expect(detail).toBeNull()
  })

  it('cursor 正常源目录 detail 仍然使用父目录名作为 sessionId', async () => {
    const sessionId = 'cursor-normal-session'
    const fp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cursor-normal-')),
      '.cursor',
      'projects',
      '-Users-test-project',
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`
    )
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    fs.writeFileSync(fp, cursorBackupRows('Cursor 正常源目录').map((row) => JSON.stringify(row)).join('\n'))

    const detail = await loadSessionDetail(fp)

    expect(detail).not.toBeNull()
    expect(detail!.source).toBe('cursor')
    expect(detail!.sessionId).toBe(sessionId)
    expect(detail!.id).toBe(`cursor:${sessionId}`)
  })
})

// ========================================================
// buildSessionDetail 测试
// ========================================================
describe('buildSessionDetail', () => {
  it('【真实 bug】task-notification 应该被标记为特殊 subtype', () => {
    // 这个 bug 导致 <task-notification> 显示为用户消息
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '帮我做个功能' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '<task-notification>Task 1 completed</task-notification>' } }),
      rawMsg({ type: 'user', message: { role: 'user', content: '继续' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '继续做' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    // 第三条消息（task-notification）应该有特殊 subtype
    const taskNotif = detail!.messages.find((m) => m.subtype === 'task-notification')
    expect(taskNotif).toBeDefined()
    expect(taskNotif!.origin).toBe('task-notification')
    expect(taskNotif!.textContent).toContain('task-notification')
  })

  it('tool_result 应该被关联到对应的 tool_use', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '读文件' } }),
      rawMsg({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '让我看看' },
            { type: 'tool_use', name: 'Read', id: 'tool-123', input: { file_path: '/tmp/test.ts' } }
          ]
        }
      }),
      rawMsg({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-123', content: '文件内容在这里...' }
          ]
        }
      })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const assistantMsg = detail!.messages.find((m) => m.type === 'assistant')
    expect(assistantMsg!.toolCalls[0].result).toBe('文件内容在这里...')
  })

  it('isPreCompact 标记：compact 之前的消息应该标为 true', () => {
    const msgs = [
      rawMsg({ type: 'user', uuid: 'u1', message: { role: 'user', content: '旧消息' } }),
      rawMsg({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: '旧回复' } }),
      rawMsg({ type: 'system', uuid: 's1', subtype: 'compact_boundary', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ type: 'user', uuid: 'u2', message: { role: 'user', content: '新消息' } }),
      rawMsg({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: '新回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const oldMsg = detail!.messages.find((m) => m.uuid === 'u1')
    const newMsg = detail!.messages.find((m) => m.uuid === 'u2')
    expect(oldMsg!.isPreCompact).toBe(true)
    expect(newMsg!.isPreCompact).toBe(false)
  })

  it('sidechain 消息应该标记 isSidechain', () => {
    const msgs = [
      rawMsg({ type: 'user', message: { role: 'user', content: '你好' } }),
      rawMsg({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: '这是被拒绝的回复' } }),
      rawMsg({ type: 'assistant', message: { role: 'assistant', content: '这是最终回复' } })
    ]
    const fp = writeTempJsonl(msgs)
    const detail = buildSessionDetail(fp, msgs)

    const sidechain = detail!.messages.filter((m) => m.isSidechain)
    expect(sidechain).toHaveLength(1)
    expect(sidechain[0].textContent).toBe('这是被拒绝的回复')
  })

  it('loadSessionDetail 应该把 compact continuation shard 拼回父会话并去重', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-continuation-'))
    const parentFile = path.join(tmp, 'parent.jsonl')
    const childFile = path.join(tmp, 'child.jsonl')
    const repeatedPrompt = '这是现在侧边栏的滚动截图。所有 session 都显示在未分组。'

    const parentMsgs = [
      rawMsg({ uuid: 'u1', sessionId: 'parent-session', type: 'user', timestamp: '2026-06-14T10:00:00Z', message: { role: 'user', content: '开始' } }),
      rawMsg({ uuid: 'a1', sessionId: 'parent-session', type: 'assistant', parentUuid: 'u1', timestamp: '2026-06-14T10:01:00Z', message: { role: 'assistant', content: '好的' } }),
      rawMsg({ uuid: 'cb', sessionId: 'parent-session', type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: 'a1', timestamp: '2026-06-14T10:02:00Z', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ uuid: 'sum', sessionId: 'parent-session', type: 'user', parentUuid: 'cb', timestamp: '2026-06-14T10:02:00Z', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ uuid: 'copied-a', sessionId: 'parent-session', type: 'assistant', parentUuid: 'sum', timestamp: '2026-06-14T10:03:00Z', message: { role: 'assistant', content: 'compact 后的共享回复' } }),
      rawMsg({ uuid: 'pending-parent', sessionId: 'parent-session', type: 'user', parentUuid: 'copied-a', timestamp: '2026-06-14T10:10:00Z', message: { role: 'user', content: repeatedPrompt } })
    ]
    const childMsgs = [
      rawMsg({ uuid: 'cb', sessionId: 'child-session', type: 'system', subtype: 'compact_boundary', parentUuid: null, logicalParentUuid: 'a1', timestamp: '2026-06-14T10:02:00Z', message: { role: 'system', content: 'Conversation compacted' } }),
      rawMsg({ uuid: 'sum', sessionId: 'child-session', type: 'user', parentUuid: 'cb', timestamp: '2026-06-14T10:02:00Z', message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: ...' } }),
      rawMsg({ uuid: 'copied-a', sessionId: 'child-session', type: 'assistant', parentUuid: 'sum', timestamp: '2026-06-14T10:03:00Z', message: { role: 'assistant', content: 'compact 后的共享回复' } }),
      rawMsg({ uuid: 'pending-child', sessionId: 'child-session', type: 'user', parentUuid: 'copied-a', timestamp: '2026-06-14T10:10:40Z', message: { role: 'user', content: repeatedPrompt } }),
      rawMsg({ uuid: 'child-answer', sessionId: 'child-session', type: 'assistant', parentUuid: 'pending-child', timestamp: '2026-06-14T10:11:00Z', message: { role: 'assistant', content: '这是子 continuation 的新回答' } })
    ]

    writeJsonlAt(parentFile, parentMsgs)
    writeJsonlAt(childFile, childMsgs)

    const detail = await loadSessionDetail(parentFile, [parentFile, childFile])

    expect(detail).not.toBeNull()
    expect(detail!.sessionId).toBe('parent-session')
    expect(detail!.messages.filter((m) => m.uuid === 'cb')).toHaveLength(1)
    expect(detail!.messages.filter((m) => m.type === 'user' && m.textContent === repeatedPrompt)).toHaveLength(1)
    expect(detail!.messages.some((m) => m.uuid === 'child-answer' && m.textContent === '这是子 continuation 的新回答')).toBe(true)
  })
})

// ========================================================
// cross-session branch inference 测试
// ========================================================
describe('loadAllSessions per-file incremental cache', () => {
  it('热缓存可只物化汇总，源文件变化后仍返回完整用量事件', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-compact-usage-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'usage.jsonl')
    const rows = [
      rawMsg({
        sessionId: 'compact-usage-session',
        type: 'user',
        message: { role: 'user', content: 'cache usage fixture' }
      }),
      rawMsg({
        sessionId: 'compact-usage-session',
        type: 'assistant',
        message: {
          id: 'usage-1', role: 'assistant', content: 'done', stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 20 }
        }
      })
    ]
    writeJsonlAt(file, rows)

    try {
      const cold = await loadAllSessionsFromTempHome(home, { quiet: true })
      expect(cold[0].tokenAccounting?.usageEvents).toHaveLength(1)
      const persisted = new Database(summaryCacheDbPath(home), { readonly: true })
      const cacheRow = persisted.prepare(`
        SELECT length(per_file_json) AS full_bytes,
          length(compact_json) AS compact_bytes,
          json_type(compact_json, '$.summary.tokenAccounting.usageEvents') AS compact_events
        FROM summary_cache_entries WHERE file_path = ?
      `).get(file) as { full_bytes: number; compact_bytes: number; compact_events: string | null }
      persisted.close()
      expect(cacheRow.compact_bytes).toBeLessThan(cacheRow.full_bytes)
      expect(cacheRow.compact_events).toBeNull()

      const compact = await loadAllSessionsFromTempHome(home, {
        readOnly: true,
        quiet: true,
        omitCachedUsageEvents: true
      })
      expect(compact[0].tokenAccounting).toMatchObject({
        billingTotal: 120,
        usageEvents: [],
        usageEventsOmitted: true
      })
      expect(compact[0].tokenAccounting?.usageEventRollups?.[0]?.[0])
        .toBe('claude:message:usage-1')
      expect(readSummaryCache(home).entries[file].perFile.summary.tokenAccounting.usageEvents)
        .toHaveLength(1)
      const restored = restoreOmittedUsageEvents(compact, cold)
      expect(restored[0].tokenAccounting?.usageEvents).toHaveLength(1)
      expect(restored[0].tokenAccounting).not.toHaveProperty('usageEventsOmitted')

      writeJsonlAt(file, [...rows, rawMsg({
        sessionId: 'compact-usage-session',
        type: 'assistant',
        message: {
          id: 'usage-2', role: 'assistant', content: 'updated', stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 10 }
        }
      })])
      const changed = await loadAllSessionsFromTempHome(home, {
        readOnly: true,
        quiet: true,
        omitCachedUsageEvents: true
      })
      expect(changed[0].tokenAccounting?.usageEvents).toHaveLength(2)
      expect(changed[0].tokenAccounting).not.toHaveProperty('usageEventsOmitted')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('v28 SQLite 缓存在当前版本下不迁移：只读加载冷重建且库原样不动，可写加载清表重写（F1d）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-v28-compact-migration-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'v28.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'v28-compact-session',
        type: 'user',
        message: { role: 'user', content: 'v28 migration' }
      }),
      rawMsg({
        sessionId: 'v28-compact-session',
        type: 'assistant',
        message: {
          id: 'v28-usage', role: 'assistant', content: 'done', stop_reason: 'end_turn',
          usage: { input_tokens: 80, output_tokens: 20 }
        }
      })
    ])
    const columnNames = (database: Database.Database): string[] =>
      (database.prepare('PRAGMA table_info(summary_cache_entries)').all() as Array<{ name: string }>)
        .map((column) => column.name)

    try {
      await loadAllSessionsFromTempHome(home, { quiet: true })
      const legacy = new Database(summaryCacheDbPath(home))
      const row = legacy.prepare('SELECT per_file_json FROM summary_cache_entries WHERE file_path = ?')
        .get(file) as { per_file_json: string }
      const perFile = JSON.parse(row.per_file_json)
      perFile.summary.firstUserMessage = 'v28 cached value'
      legacy.prepare('UPDATE summary_cache_entries SET per_file_json = ? WHERE file_path = ?')
        .run(JSON.stringify(perFile), file)
      legacy.exec('ALTER TABLE summary_cache_entries DROP COLUMN compact_json')
      legacy.pragma('user_version = 28')
      legacy.close()
      const v28Bytes = fs.readFileSync(summaryCacheDbPath(home))

      // The worker's 28 -> 29 step does not apply to this version: nothing is
      // migrated, the read-only scan re-reads the file, the v28 DB is untouched.
      const sessions = await loadAllSessionsFromTempHome(home, {
        readOnly: true,
        migrateLegacyCache: true,
        quiet: true,
        omitCachedUsageEvents: true
      })
      expect(sessions[0].firstUserMessage).toBe('v28 migration')
      expect(sessions[0].tokenAccounting).toMatchObject({ billingTotal: 100 })
      expect(sessions[0].tokenAccounting?.usageEvents).toHaveLength(1)
      expect(sessions[0].tokenAccounting).not.toHaveProperty('usageEventsOmitted')
      expect(fs.readFileSync(summaryCacheDbPath(home)).equals(v28Bytes)).toBe(true)

      // The first writable load empties the v28 table and writes this version.
      const writable = await loadAllSessionsFromTempHome(home, { quiet: true })
      expect(writable[0].firstUserMessage).toBe('v28 migration')
      const rebuilt = new Database(summaryCacheDbPath(home), { readonly: true })
      expect(Number(rebuilt.pragma('user_version', { simple: true }))).toBe(SUMMARY_CACHE_VERSION)
      expect(columnNames(rebuilt)).toContain('compact_json')
      expect(rebuilt.prepare(`
        SELECT json_array_length(compact_json, '$.summary.tokenAccounting.usageEventRollups') AS count,
          json_extract(compact_json, '$.summary.tokenAccounting.usageEventRollups[0][0]') AS ledger_key,
          json_extract(per_file_json, '$.summary.firstUserMessage') AS first_user_message
        FROM summary_cache_entries WHERE file_path = ?
      `).get(file)).toEqual({ count: 1, ledger_key: 'claude:message:v28-usage', first_user_message: 'v28 migration' })
      rebuilt.close()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('v28 只读取当前 key，并且不重写未变化行', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-bounded-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'active.jsonl')
    writeJsonlAt(file, [rawMsg({
      sessionId: 'bounded-cache-session',
      type: 'user',
      message: { role: 'user', content: 'bounded cache fixture' }
    })])
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      const database = new Database(summaryCacheDbPath(home))
      database.exec(`
        CREATE TABLE cache_write_audit(kind TEXT NOT NULL);
        CREATE TRIGGER audit_cache_update AFTER UPDATE ON summary_cache_entries
        BEGIN INSERT INTO cache_write_audit(kind) VALUES ('update'); END;
      `)
      database.prepare(`
        INSERT INTO summary_cache_entries(file_path, sig, per_file_json)
        VALUES (?, ?, ?)
      `).run('/stale/huge.jsonl', 'stale', '{not-valid-json')
      database.close()

      infoSpy.mockClear()
      const sessions = await loadAllSessionsFromTempHome(home)
      expect(sessions.some((session) => session.sessionId === 'bounded-cache-session')).toBe(true)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 0, reused 1, files 1')

      const verified = new Database(summaryCacheDbPath(home), { readonly: true })
      expect(verified.prepare('SELECT COUNT(*) AS count FROM cache_write_audit').get())
        .toEqual({ count: 0 })
      expect(verified.prepare('SELECT COUNT(*) AS count FROM summary_cache_entries WHERE file_path = ?')
        .get('/stale/huge.jsonl')).toEqual({ count: 0 })
      verified.close()
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
  it('模块在 sandbox 外初始化时拒绝写 summary cache', async () => {
    const systemTemporaryRoot = process.env.SWOB_TEST_SYSTEM_TEMP_ROOT!
    const home = fs.mkdtempSync(path.join(systemTemporaryRoot, 'swob-outside-sandbox-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'outside-cache.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'outside-cache-session',
        type: 'user',
        message: { role: 'user', content: 'outside sandbox cache fixture' }
      })
    ])
    const previousHome = process.env.HOME

    try {
      process.env.HOME = home
      vi.resetModules()
      const mod = await import('./session-loader')

      await expect(mod.loadAllSessions({ quiet: true }))
        .rejects.toThrow('Test isolation violation: summary-cache write outside sandbox')
      expect(fs.existsSync(summaryCacheDbPath(home))).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      vi.resetModules()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('single-flight 跨 readOnly/写模式复用纯解析，但隔离写副作用与 quiet 日志', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-single-flight-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'single-flight.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'single-flight-session',
        type: 'user',
        message: { role: 'user', content: 'single flight fixture' }
      })
    ])
    const previousHome = process.env.HOME
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      process.env.HOME = home
      vi.resetModules()
      const mod = await import('./session-loader')

      const quiet = mod.loadAllSessions({ quiet: true })
      const visible = mod.loadAllSessions()
      const [quietSessions, visibleSessions] = await Promise.all([quiet, visible])

      expect(quietSessions).toBe(visibleSessions)
      expect(infoSpy).toHaveBeenCalledTimes(1)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 1, reused 0, files 1')

      writeJsonlAt(file, [
        rawMsg({
          sessionId: 'single-flight-session',
          type: 'user',
          message: { role: 'user', content: 'single flight fixture updated' }
        })
      ])
      const [readOnlySessions, writableSessions] = await Promise.all([
        mod.loadAllSessions({ readOnly: true, quiet: true }),
        mod.loadAllSessions({ quiet: true })
      ])
      // The read-only caller joins the same pure parse snapshot, while only
      // the writable continuation performs cache/provider side effects.
      expect(readOnlySessions).toBe(writableSessions)
    } finally {
      infoSpy.mockRestore()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      vi.resetModules()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('轻量与完整物化使用不同 single-flight，回退不会误接轻量快照', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-materialization-flight-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'flight.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'materialization-flight', type: 'user',
        message: { role: 'user', content: 'flight fixture' }
      }),
      rawMsg({
        sessionId: 'materialization-flight', type: 'assistant',
        message: {
          id: 'flight-usage', role: 'assistant', content: 'done', stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 2 }
        }
      })
    ])
    const previousHome = process.env.HOME

    try {
      process.env.HOME = home
      vi.resetModules()
      const mod = await import('./session-loader')
      await mod.loadAllSessions({ quiet: true })
      const [compact, full] = await Promise.all([
        mod.loadAllSessions({ readOnly: true, quiet: true, omitCachedUsageEvents: true }),
        mod.loadAllSessions({ readOnly: true, quiet: true })
      ])

      expect(compact).not.toBe(full)
      expect(compact[0].tokenAccounting).toMatchObject({
        usageEvents: [],
        usageEventsOmitted: true
      })
      expect(full[0].tokenAccounting?.usageEvents).toHaveLength(1)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      vi.resetModules()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('readOnly 模式读取会话但不创建 summary cache', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-readonly-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'readonly.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'readonly-session',
        type: 'user',
        message: { role: 'user', content: '只读审计' }
      })
    ])

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })

      expect(sessions.some((session) => session.sessionId === 'readonly-session')).toBe(true)
      expect(fs.existsSync(summaryCacheDbPath(home))).toBe(false)
      expect(fs.existsSync(path.join(home, '.claude-session-manager', 'canonical.db'))).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('普通 readOnly 不复用既有 v27 缓存（F1d），也不迁移、不删除它', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-readonly-legacy-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'readonly-legacy.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'readonly-legacy-session',
        type: 'user',
        message: { role: 'user', content: 'source value' }
      })
    ])

    try {
      await loadAllSessionsFromTempHome(home, { quiet: true })
      const legacy = readSummaryCache(home)
      legacy.version = 27
      legacy.entries[file].perFile.summary.firstUserMessage = 'read-only cached value'
      const legacyPath = writeLegacySummaryCache(home, legacy)

      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })

      expect(sessions.find((session) => session.sessionId === 'readonly-legacy-session')?.firstUserMessage)
        .toBe('source value')
      expect(fs.existsSync(legacyPath)).toBe(true)
      expect(fs.existsSync(summaryCacheDbPath(home))).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('桌面显式迁移不再升级 v27 缓存（F1d）：readOnly 扫描冷读、JSON 原样保留，首次可写加载才删', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-explicit-migration-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'explicit-migration.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'explicit-migration-session',
        type: 'user',
        message: { role: 'user', content: 'source value' }
      })
    ])

    try {
      await loadAllSessionsFromTempHome(home, { quiet: true })
      const legacy = readSummaryCache(home)
      legacy.version = 27
      legacy.entries[file].perFile.summary.firstUserMessage = 'worker migrated value'
      const legacyPath = writeLegacySummaryCache(home, legacy)

      const sessions = await loadAllSessionsFromTempHome(home, {
        readOnly: true,
        migrateLegacyCache: true,
        quiet: true
      })

      expect(sessions.find((session) => session.sessionId === 'explicit-migration-session')?.firstUserMessage)
        .toBe('source value')
      expect(fs.existsSync(summaryCacheDbPath(home))).toBe(false)
      expect(fs.existsSync(legacyPath)).toBe(true)

      const writable = await loadAllSessionsFromTempHome(home, { quiet: true })
      expect(writable.find((session) => session.sessionId === 'explicit-migration-session')?.firstUserMessage)
        .toBe('source value')
      expect(readSummaryCache(home).version).toBe(SUMMARY_CACHE_VERSION)
      expect(fs.existsSync(legacyPath)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('显式迁移遇到损坏 v27 时保留原文件且 readOnly 不生成替代缓存', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-corrupt-legacy-migration-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'corrupt-migration.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'corrupt-migration-session',
        type: 'user',
        message: { role: 'user', content: 'source survives corrupt cache' }
      })
    ])
    const legacyPath = path.join(home, '.claude-session-manager', 'summary-cache.json')
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true })
    fs.writeFileSync(legacyPath, '{"version":27,"entries":{"unterminated":')

    try {
      const sessions = await loadAllSessionsFromTempHome(home, {
        readOnly: true,
        migrateLegacyCache: true,
        quiet: true
      })

      expect(sessions.some((session) => session.sessionId === 'corrupt-migration-session')).toBe(true)
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{"version":27,"entries":{"unterminated":')
      expect(fs.existsSync(summaryCacheDbPath(home))).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('损坏的 SQLite summary cache 只作为缓存失效，并在本轮安全重建', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-corrupt-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'repair.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'repair-session',
        type: 'user',
        message: { role: 'user', content: '重建损坏的 summary cache' }
      })
    ])
    fs.mkdirSync(path.dirname(summaryCacheDbPath(home)), { recursive: true })
    fs.writeFileSync(summaryCacheDbPath(home), 'not-a-sqlite-database')

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { quiet: true })
      const rebuilt = readSummaryCache(home)

      expect(sessions).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: 'repair-session' })
      ]))
      expect(rebuilt.version).toBe(SUMMARY_CACHE_VERSION)
      expect(rebuilt.entries[file]).toBeDefined()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('v27 大型 JSON 缓存不再逐条迁移（F1d）：可写加载读源文件、写当前版本并删除 JSON', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-streaming-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'stream-"quoted".jsonl')
    writeJsonlAt(file, [
      rawMsg({
        sessionId: 'streaming-cache-session',
        type: 'user',
        message: { role: 'user', content: 'streaming source value' }
      })
    ])

    try {
      await loadAllSessionsFromTempHome(home, { quiet: true })
      const legacy = readSummaryCache(home)
      legacy.version = 27
      const marker = `cached-{[\\"boundary\\"]}-${'x'.repeat(96 * 1024)}-tail`
      legacy.entries[file].perFile.summary.firstUserMessage = marker
      const legacyPath = writeLegacySummaryCache(home, legacy)

      const sessions = await loadAllSessionsFromTempHome(home, { quiet: true })

      expect(sessions.find((session) => session.sessionId === 'streaming-cache-session')?.firstUserMessage)
        .toBe('streaming source value')
      const rebuilt = readSummaryCache(home)
      expect(rebuilt.version).toBe(SUMMARY_CACHE_VERSION)
      expect(JSON.stringify(rebuilt.entries)).not.toContain('cached-{[')
      expect(fs.existsSync(legacyPath)).toBe(false)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('只重建变化文件，并使热启动 summaries/血统与删缓存全量重建一致', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cache-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const firstFile = path.join(projectDir, 'cache-a.jsonl')
    const secondFile = path.join(projectDir, 'cache-b.jsonl')
    const firstMessages = [
      rawMsg({ uuid: 'cache-a-u', sessionId: 'cache-a', type: 'user', message: { role: 'user', content: '缓存会话 A' } }),
      rawMsg({ uuid: 'cache-a-a', sessionId: 'cache-a', parentUuid: 'cache-a-u', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: 'A 回复' } })
    ]
    const secondMessages = [
      rawMsg({ uuid: 'cache-b-u', sessionId: 'cache-b', type: 'user', message: { role: 'user', content: '缓存会话 B' } }),
      rawMsg({ uuid: 'cache-b-a', sessionId: 'cache-b', parentUuid: 'cache-b-u', type: 'assistant', timestamp: '2026-03-01T00:01:00Z', message: { role: 'assistant', content: 'B 回复' } })
    ]
    writeJsonlAt(firstFile, firstMessages)
    writeJsonlAt(secondFile, secondMessages)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 2, reused 0, files 2')

      const diskCache = readSummaryCache(home)
      expect(diskCache.version).toBe(SUMMARY_CACHE_VERSION)
      expect(Object.keys(diskCache.entries).sort()).toEqual([firstFile, secondFile].sort())
      expect(diskCache.entries[firstFile]).toMatchObject({
        sig: expect.any(String),
        perFile: {
          summary: { sessionId: 'cache-a' },
          lineageMeta: {
            uuids: ['cache-a-u', 'cache-a-a'],
            leafUuidRefs: expect.any(Array),
            startTime: expect.any(String),
            endTime: expect.any(String),
            cwd: '/Users/test',
            sessionId: 'cache-a'
          }
        }
      })

      writeJsonlAt(firstFile, [
        ...firstMessages,
        rawMsg({ uuid: 'cache-a-u2', sessionId: 'cache-a', parentUuid: 'cache-a-a', type: 'user', timestamp: '2026-03-01T00:02:00Z', message: { role: 'user', content: '只修改 A' } }),
        rawMsg({ uuid: 'cache-a-a2', sessionId: 'cache-a', parentUuid: 'cache-a-u2', type: 'assistant', timestamp: '2026-03-01T00:03:00Z', message: { role: 'assistant', content: 'A 新回复' } })
      ])
      infoSpy.mockClear()
      const incremental = await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 1, reused 1, files 2')

      removeSummaryCache(home)
      infoSpy.mockClear()
      const fullRebuild = await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 2, reused 0, files 2')
      expect(incremental).toEqual(fullRebuild)
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('P1-3：压缩缓存保留来源证据，多文件 summary 重建不丢判定字段', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-origin-cache-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const firstFile = path.join(projectDir, 'origin-cache-a.jsonl')
    const secondFile = path.join(projectDir, 'origin-cache-b.jsonl')
    writeJsonlAt(firstFile, [
      rawMsg({
        uuid: 'origin-human',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
        promptSource: 'typed',
        message: { role: 'user', content: '缓存中的真人问题' }
      }),
      rawMsg({
        uuid: 'origin-assistant-a',
        sessionId: 'origin-cache-session',
        parentUuid: 'origin-human',
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: { role: 'assistant', content: '第一段回复' }
      })
    ])
    writeJsonlAt(secondFile, [
      rawMsg({
        uuid: 'origin-task',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:02:00Z',
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
        message: { role: 'user', content: '无标签的任务通知正文' }
      }),
      rawMsg({
        uuid: 'origin-meta',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:02:10Z',
        promptSource: 'typed',
        isMeta: true,
        message: { role: 'user', content: '无标签的元消息正文' }
      }),
      rawMsg({
        uuid: 'origin-tool',
        sessionId: 'origin-cache-session',
        type: 'user',
        timestamp: '2026-03-01T00:02:20Z',
        promptSource: 'typed',
        sourceToolAssistantUUID: 'tool-source-uuid',
        toolUseResult: { detail: '不应写入压缩缓存' },
        message: { role: 'user', content: '规整后的工具结果' }
      }),
      rawMsg({
        uuid: 'origin-assistant-b',
        sessionId: 'origin-cache-session',
        parentUuid: 'origin-tool',
        type: 'assistant',
        timestamp: '2026-03-01T00:03:00Z',
        message: { role: 'assistant', content: '第二段回复' }
      })
    ])

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { quiet: true })
      const summary = sessions.find((session) => session.sessionId === 'origin-cache-session')
      const diskCache = readSummaryCache(home)
      const refs = [
        ...diskCache.entries[firstFile].perFile.lineageMeta.leafUuidRefs,
        ...diskCache.entries[secondFile].perFile.lineageMeta.leafUuidRefs
      ]

      expect(summary).toMatchObject({ firstUserMessage: '缓存中的真人问题', turnCount: 1 })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-human')).toMatchObject({
        promptSource: 'typed'
      })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-task')).toMatchObject({
        origin: { kind: 'task-notification' },
        promptSource: 'sdk'
      })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-meta')).toMatchObject({
        promptSource: 'typed',
        isMeta: true
      })
      expect(refs.find((message: RawJsonlMessage) => message.uuid === 'origin-tool')).toMatchObject({
        promptSource: 'typed',
        sourceToolAssistantUUID: 'tool-source-uuid',
        toolUseResult: true
      })
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('P1-3：版本 19 的旧缓存强制失效，不污染来源判定', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-old-origin-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'old-cache-session.jsonl')
    writeJsonlAt(file, [
      rawMsg({
        uuid: 'old-cache-task',
        sessionId: 'old-cache-session',
        type: 'user',
        origin: { kind: 'task-notification' },
        promptSource: 'sdk',
        message: { role: 'user', content: '无标签的机器通知' }
      }),
      rawMsg({
        uuid: 'old-cache-assistant',
        sessionId: 'old-cache-session',
        parentUuid: 'old-cache-task',
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: { role: 'assistant', content: '收到' }
      })
    ])
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      const oldCache = readSummaryCache(home)
      oldCache.version = 19
      oldCache.entries[file].perFile.summary.firstUserMessage = '旧缓存误判的真人内容'
      oldCache.entries[file].perFile.summary.turnCount = 1
      delete oldCache.entries[file].perFile.lineageMeta.leafUuidRefs[0].origin
      oldCache.entries[file].perFile.lineageMeta.leafUuidRefs[0].promptSource = 'typed'
      writeLegacySummaryCache(home, oldCache)

      infoSpy.mockClear()
      const sessions = await loadAllSessionsFromTempHome(home)
      const summary = sessions.find((session) => session.sessionId === 'old-cache-session')
      const refreshedCache = readSummaryCache(home)

      expect(incrementalCacheLog(infoSpy)).toContain('parsed 1, reused 0, files 1')
      expect(summary).toMatchObject({ firstUserMessage: 'old-cache-session', turnCount: 0 })
      expect(refreshedCache.version).toBe(SUMMARY_CACHE_VERSION)
      expect(refreshedCache.entries[file].perFile.lineageMeta.leafUuidRefs[0]).toMatchObject({
        origin: { kind: 'task-notification' },
        promptSource: 'sdk'
      })
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('v25 JSON 缓存在当前版本下全部重建（F1d）：Claude、Cursor 也不再热复用', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-v25-selective-cache-home-'))
    const claudeFile = path.join(home, '.claude', 'projects', '-Users-test-vault', 'v25-claude.jsonl')
    const cursorId = 'v25-cursor'
    const cursorFile = path.join(
      home,
      '.cursor',
      'projects',
      'Users-test-vault',
      'agent-transcripts',
      cursorId,
      `${cursorId}.jsonl`
    )
    const codexId = '18400000-0000-4000-8000-000000000025'
    const codexFile = path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '08',
      '02',
      `rollout-2026-08-02T00-00-00-${codexId}.jsonl`
    )
    const opencodeId = 'ses_v25opencode'
    const zcodeId = 'sess_v25zcode'
    writeJsonlAt(claudeFile, [
      rawMsg({
        sessionId: 'v25-claude',
        type: 'user',
        message: { role: 'user', content: 'Claude source value' }
      })
    ])
    writeJsonlAt(cursorFile, cursorBackupRows('Cursor source value') as RawJsonlMessage[])
    writeJsonlAt(codexFile, codexBackupRows(codexId) as RawJsonlMessage[])
    const opencodeRef = createSqliteAgentCacheFixture(home, 'opencode', opencodeId)
    const zcodeRef = createSqliteAgentCacheFixture(home, 'zcode', zcodeId)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      const oldCache = readSummaryCache(home)
      expect(Object.keys(oldCache.entries)).toEqual(expect.arrayContaining([
        claudeFile,
        cursorFile,
        codexFile,
        opencodeRef,
        zcodeRef
      ]))
      oldCache.version = 25
      oldCache.entries[claudeFile].perFile.summary.firstUserMessage = 'v25 Claude cache reused'
      oldCache.entries[cursorFile].perFile.summary.firstUserMessage = 'v25 Cursor cache reused'
      oldCache.entries[opencodeRef].perFile.summary.firstUserMessage = 'v25 OpenCode cache reused'
      oldCache.entries[zcodeRef].perFile.summary.firstUserMessage = 'v25 ZCode cache reused'
      oldCache.entries[opencodeRef].perFile.summary.tokenAccounting = accountingFromMutuallyExclusiveUsage(
        'opencode',
        { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }
      )
      oldCache.entries[zcodeRef].perFile.summary.tokenAccounting = accountingFromMutuallyExclusiveUsage(
        'zcode',
        { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }
      )
      oldCache.entries[codexFile].perFile.summary.firstUserMessage = 'stale v25 Codex cache'
      writeLegacySummaryCache(home, oldCache)

      infoSpy.mockClear()
      const sessions = await loadAllSessionsFromTempHome(home)
      const refreshed = readSummaryCache(home)

      expect(incrementalCacheLog(infoSpy)).toContain('parsed 5, reused 0, files 5')
      expect(sessions.find((session) => session.sessionId === 'v25-claude')?.firstUserMessage)
        .toBe('Claude source value')
      expect(sessions.find((session) => session.sessionId === cursorId)?.firstUserMessage)
        .toBe('Cursor source value')
      expect(sessions.find((session) => session.sessionId === opencodeId)?.firstUserMessage)
        .toBe('opencode source value')
      expect(sessions.find((session) => session.sessionId === zcodeId)?.firstUserMessage)
        .toBe('zcode source value')
      expect(sessions.find((session) => session.sessionId === opencodeId)?.tokenAccounting?.usageEvents)
        .toEqual([expect.objectContaining({ providerFormatVersion: 'opencode-message-usage-v2' })])
      expect(sessions.find((session) => session.sessionId === zcodeId)?.tokenAccounting?.usageEvents)
        .toEqual([expect.objectContaining({ providerFormatVersion: 'zcode-model-usage-v1' })])
      expect(sessions.find((session) => session.sessionId === codexId)?.firstUserMessage)
        .toBe('从 Codex backup 建 summary')
      expect(refreshed.version).toBe(SUMMARY_CACHE_VERSION)

      infoSpy.mockClear()
      await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 0, reused 5, files 5')
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('v26 JSON 缓存在当前版本下全部重建（F1d），下一次启动全量热复用', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-v26-sqlite-cache-home-'))
    const claudeFile = path.join(home, '.claude', 'projects', '-Users-test-vault', 'v26-claude.jsonl')
    const codexId = '18400000-0000-4000-8000-000000000026'
    const codexFile = path.join(
      home,
      '.codex',
      'sessions',
      '2026',
      '08',
      '02',
      `rollout-2026-08-02T00-00-00-${codexId}.jsonl`
    )
    const opencodeId = 'ses_v26opencode'
    const zcodeId = 'sess_v26zcode'
    writeJsonlAt(claudeFile, [
      rawMsg({
        sessionId: 'v26-claude',
        type: 'user',
        message: { role: 'user', content: 'Claude v26 source value' }
      })
    ])
    writeJsonlAt(codexFile, codexBackupRows(codexId) as RawJsonlMessage[])
    const opencodeRef = createSqliteAgentCacheFixture(home, 'opencode', opencodeId)
    const zcodeRef = createSqliteAgentCacheFixture(home, 'zcode', zcodeId)
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    try {
      await loadAllSessionsFromTempHome(home)
      const oldCache = readSummaryCache(home)
      oldCache.version = 26
      oldCache.entries[claudeFile].perFile.summary.firstUserMessage = 'v26 Claude cache reused'
      oldCache.entries[codexFile].perFile.summary.firstUserMessage = 'v26 Codex cache reused'
      for (const [source, ref] of [
        ['opencode', opencodeRef],
        ['zcode', zcodeRef]
      ] as const) {
        oldCache.entries[ref].perFile.summary.firstUserMessage = `stale v26 ${source}`
        oldCache.entries[ref].perFile.summary.tokenAccounting = accountingFromMutuallyExclusiveUsage(
          source,
          { inputTokens: 100, outputTokens: 20, cacheCreationTokens: 0, cacheReadTokens: 0 }
        )
      }
      writeLegacySummaryCache(home, oldCache)

      infoSpy.mockClear()
      const migrated = await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 4, reused 0, files 4')
      expect(migrated.find((session) => session.sessionId === 'v26-claude')?.firstUserMessage)
        .toBe('Claude v26 source value')
      expect(migrated.find((session) => session.sessionId === codexId)?.firstUserMessage)
        .toBe('从 Codex backup 建 summary')
      expect(migrated.find((session) => session.sessionId === opencodeId)?.tokenAccounting?.usageEvents)
        .toEqual([expect.objectContaining({ providerFormatVersion: 'opencode-message-usage-v2' })])
      expect(migrated.find((session) => session.sessionId === zcodeId)?.tokenAccounting?.usageEvents)
        .toEqual([expect.objectContaining({ providerFormatVersion: 'zcode-model-usage-v1' })])
      expect(readSummaryCache(home).version).toBe(SUMMARY_CACHE_VERSION)

      infoSpy.mockClear()
      await loadAllSessionsFromTempHome(home)
      expect(incrementalCacheLog(infoSpy)).toContain('parsed 0, reused 4, files 4')
    } finally {
      infoSpy.mockRestore()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('t117：guardian/thread_spawn 不作顶层，子用量归父且旧缓存不能复活 guardian', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-role-cache-home-'))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '22')
    const parentId = '019f8476-88d9-7b12-9b78-0e6d5ec8f640'
    const childId = '019f4a2a-d46a-7d63-93e8-3a542bfe1c1d'
    const guardianId = '019f8786-bfca-7b12-a541-fe89cc3b242a'
    const parentFile = path.join(codexDir, `rollout-parent-${parentId}.jsonl`)
    const childFile = path.join(codexDir, `rollout-child-${childId}.jsonl`)
    const guardianFile = path.join(codexDir, `rollout-guardian-${guardianId}.jsonl`)

    writeJsonlAt(parentFile, codexRoleRows({
      sessionId: parentId,
      userText: '正常父会话',
      inputTokens: 100,
      outputTokens: 20,
      turnId: 'shared-turn'
    }) as RawJsonlMessage[])
    const childRows = codexRoleRows({
      sessionId: childId,
      userText: '真实子 Agent',
      inputTokens: 100,
      outputTokens: 20,
      turnId: 'shared-turn',
      parentThreadId: parentId,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: 1,
            agent_path: '/root/review',
            agent_nickname: 'Reviewer'
          }
        }
      }
    }) as any[]
    childRows.splice(childRows.length - 1, 0, {
      timestamp: '2026-07-22T00:00:03.500Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          turn_id: 'child-only',
          last_token_usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 0 }
        }
      }
    })
    writeJsonlAt(childFile, childRows as RawJsonlMessage[])
    writeJsonlAt(guardianFile, codexRoleRows({
      sessionId: guardianId,
      userText: 'The following is the Codex agent history whose request action you are assessing.',
      inputTokens: 30,
      outputTokens: 3,
      turnId: 'guardian-only',
      parentThreadId: parentId,
      source: { subagent: { other: 'guardian' } }
    }) as RawJsonlMessage[])

    try {
      const cold = await loadAllSessionsFromTempHome(home)
      const parent = cold.find((session) => session.sessionId === parentId)
      const cache = readSummaryCache(home)

      expect(cold.map((session) => session.sessionId)).toEqual([parentId])
      expect(parent?.subagents).toEqual([
        expect.objectContaining({ sessionId: childId, role: 'thread-spawn', parentSessionId: parentId })
      ])
      expect(parent?.tokenAccounting?.billingTotal).toBe(208)
      expect(parent?.tokenAccounting?.conversationOnly).toBe(120)
      expect(parent?.tokenAccounting?.usageEvents).toHaveLength(4)
      expect(parent?.tokenAccounting?.usageEvents.filter((event) => event.scope === 'subagent')).toHaveLength(3)
      const copiedPrefix = parent?.tokenAccounting?.usageEvents
        .filter((event) => event.billingFactKey && event.billingFactKey === parent.tokenAccounting?.usageEvents[0]?.billingFactKey)
      expect(copiedPrefix).toHaveLength(2)
      expect(new Set(copiedPrefix?.map((event) => event.auditSourceId))).toEqual(new Set([parentId, childId]))
      expect(cache.version).toBe(SUMMARY_CACHE_VERSION)
      expect(cache.entries[parentFile].perFile.summary.tokenAccounting.usageEvents
        .every((event: { auditSourceId?: string }) => event.auditSourceId === parentId)).toBe(true)
      expect(cache.entries[childFile].perFile.codexSubagent.tokenAccounting.usageEvents
        .every((event: { auditSourceId?: string }) => event.auditSourceId === childId)).toBe(true)
      expect(cache.entries[guardianFile].perFile).toMatchObject({
        summary: null,
        codexSubagent: { role: 'guardian', parentSessionId: parentId }
      })

      const compactHot = await loadAllSessionsFromTempHome(home, {
        readOnly: true,
        quiet: true,
        omitCachedUsageEvents: true
      })
      expect(compactHot[0].tokenAccounting).toMatchObject({
        billingTotal: 208,
        conversationOnly: 120,
        usageEvents: [],
        usageEventsOmitted: true
      })
      expect(compactHot[0].tokenAccounting?.usageEventRollups).toHaveLength(4)

      cache.version = 23
      cache.entries[guardianFile].perFile.summary = {
        ...parent,
        id: `codex:${guardianId}`,
        sessionId: guardianId,
        firstUserMessage: '旧缓存中的 guardian'
      }
      writeLegacySummaryCache(home, cache)

      const hot = await loadAllSessionsFromTempHome(home)
      expect(hot.map((session) => session.sessionId)).toEqual([parentId])
      expect(readSummaryCache(home).version).toBe(SUMMARY_CACHE_VERSION)

      fs.rmSync(childFile)
      fs.rmSync(guardianFile)
      const afterChildrenRemoved = await loadAllSessionsFromTempHome(home)
      expect(afterChildrenRemoved[0].tokenAccounting?.billingTotal).toBe(120)
      expect(afterChildrenRemoved[0].tokenAccounting?.conversationOnly).toBe(120)
      expect(afterChildrenRemoved[0].subagents).toBeUndefined()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('t117：报告固定快照中的 44 个 guardian 全部退出顶层，正常 Codex 数量不变', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-44-guardian-home-'))
    const codexDir = path.join(home, '.codex', 'sessions', '2026', '07', '22')
    const normalIds = ['normal-codex-a', 'normal-codex-b']

    for (const [index, sessionId] of normalIds.entries()) {
      writeJsonlAt(path.join(codexDir, `rollout-normal-${index}.jsonl`), codexRoleRows({
        sessionId,
        userText: `正常会话 ${index}`,
        inputTokens: 10,
        outputTokens: 2,
        turnId: `normal-turn-${index}`
      }) as RawJsonlMessage[])
    }
    for (let index = 0; index < 44; index++) {
      writeJsonlAt(path.join(codexDir, `rollout-guardian-${index}.jsonl`), codexRoleRows({
        sessionId: `guardian-${index}`,
        userText: 'The following is the Codex agent history whose request action you are assessing.',
        inputTokens: 3,
        outputTokens: 1,
        turnId: `guardian-turn-${index}`,
        parentThreadId: normalIds[0],
        source: { subagent: { other: 'guardian' } }
      }) as RawJsonlMessage[])
    }

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      expect(46 - sessions.length).toBe(44)
      expect(sessions.map((session) => session.sessionId).sort()).toEqual(normalIds)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('当前不存在的文件会从新缓存删除', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cache-home-'))
    const file = path.join(home, '.claude', 'projects', '-Users-test-vault', 'removed.jsonl')
    writeJsonlAt(file, [rawMsg({ sessionId: 'removed', type: 'user', message: { role: 'user', content: '待删除' } })])

    try {
      await loadAllSessionsFromTempHome(home)
      fs.rmSync(file)
      const sessions = await loadAllSessionsFromTempHome(home)
      const diskCache = readSummaryCache(home)
      expect(sessions.some((session) => session.sessionId === 'removed')).toBe(false)
      expect(diskCache.entries[file]).toBeUndefined()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

})

describe('cross-session branch inference', () => {
  it('同一条用户 prompt 被不同 sessionId 重放且一边只是继续追加时，不应该判为 branch', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-branch-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const repeatedPrompt = '晚上，看电视剧，妈突然来了一句：宝宝，妈妈觉得那个人是骗子。'

    const longSession = [
      ...sharedCrossSessionPrefix('diary-long'),
      rawMsg({ uuid: 'long-repeat-user', sessionId: 'diary-long', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-13T13:11:21Z', message: { role: 'user', content: repeatedPrompt } }),
      rawMsg({ uuid: 'long-repeat-answer', sessionId: 'diary-long', parentUuid: 'long-repeat-user', type: 'assistant', timestamp: '2026-06-13T13:12:04Z', message: { role: 'assistant', content: '对同一条 prompt 的另一版回答' } }),
      rawMsg({ uuid: 'long-extra-user', sessionId: 'diary-long', parentUuid: 'long-repeat-answer', type: 'user', timestamp: '2026-06-14T02:24:58Z', message: { role: 'user', content: '2026.6.14sun 今日Todo' } }),
      rawMsg({ uuid: 'long-extra-answer', sessionId: 'diary-long', parentUuid: 'long-extra-user', type: 'assistant', timestamp: '2026-06-14T02:25:32Z', message: { role: 'assistant', content: '继续处理今日 Todo' } })
    ]
    const shortSession = [
      ...sharedCrossSessionPrefix('diary-short'),
      rawMsg({ uuid: 'short-repeat-user', sessionId: 'diary-short', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-13T13:07:37Z', message: { role: 'user', content: repeatedPrompt } }),
      rawMsg({ uuid: 'short-repeat-answer', sessionId: 'diary-short', parentUuid: 'short-repeat-user', type: 'assistant', timestamp: '2026-06-13T13:09:54Z', message: { role: 'assistant', content: '对同一条 prompt 的一版回答' } })
    ]

    writeJsonlAt(path.join(projectDir, 'diary-long.jsonl'), longSession)
    writeJsonlAt(path.join(projectDir, 'diary-short.jsonl'), shortSession)

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      const long = sessions.find((s) => s.sessionId === 'diary-long')
      const short = sessions.find((s) => s.sessionId === 'diary-short')

      expect(long).toBeDefined()
      expect(short).toBeDefined()
      expect(long!.branchParentId).toBeUndefined()
      expect(short!.branchParentId).toBeUndefined()
      expect(long!.branchChildIds || []).not.toContain(short!.id)
      expect(short!.branchChildIds || []).not.toContain(long!.id)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('共享前缀后双方都有不同用户意图时，仍然应该判为单向 branch', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-branch-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')

    const parentSession = [
      ...sharedCrossSessionPrefix('branch-a'),
      rawMsg({ uuid: 'branch-a-user', sessionId: 'branch-a', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-10T10:10:00Z', message: { role: 'user', content: '走 A 方案' } }),
      rawMsg({ uuid: 'branch-a-answer', sessionId: 'branch-a', parentUuid: 'branch-a-user', type: 'assistant', timestamp: '2026-06-10T10:11:00Z', message: { role: 'assistant', content: 'A 方案回复' } })
    ]
    const childSession = [
      ...sharedCrossSessionPrefix('branch-b'),
      rawMsg({ uuid: 'branch-b-user', sessionId: 'branch-b', parentUuid: 'shared-a2', type: 'user', timestamp: '2026-06-10T10:12:00Z', message: { role: 'user', content: '走 B 方案' } }),
      rawMsg({ uuid: 'branch-b-answer', sessionId: 'branch-b', parentUuid: 'branch-b-user', type: 'assistant', timestamp: '2026-06-10T10:13:00Z', message: { role: 'assistant', content: 'B 方案回复' } })
    ]

    writeJsonlAt(path.join(projectDir, 'branch-a.jsonl'), parentSession)
    writeJsonlAt(path.join(projectDir, 'branch-b.jsonl'), childSession)

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      const parent = sessions.find((s) => s.sessionId === 'branch-a')
      const child = sessions.find((s) => s.sessionId === 'branch-b')

      expect(parent).toBeDefined()
      expect(child).toBeDefined()
      expect(parent!.branchParentId).toBeUndefined()
      expect(parent!.branchChildIds).toContain(child!.id)
      expect(child!.branchParentId).toBe(parent!.id)
      expect(child!.branchChildIds || []).not.toContain(parent!.id)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('真实 fork 文件用 basename child id 独立显示并 resume child session', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-fork-home-'))
    const projectDir = path.join(home, '.claude', 'projects', '-Users-test-vault')
    const parentId = '11111111-1111-4111-8111-111111111111'
    const childId = '22222222-2222-4222-8222-222222222222'
    const parentFile = path.join(projectDir, `${parentId}.jsonl`)
    const childFile = path.join(projectDir, `${childId}.jsonl`)

    const shared = [
      rawMsg({ uuid: 'shared-u', sessionId: parentId, parentUuid: null, type: 'user', timestamp: '2026-06-10T10:00:00Z', message: { role: 'user', content: '共享上下文' } }),
      rawMsg({ uuid: 'shared-a', sessionId: parentId, parentUuid: 'shared-u', type: 'assistant', timestamp: '2026-06-10T10:01:00Z', message: { role: 'assistant', content: '共享回复' } }),
      rawMsg({ uuid: 'shared-u2', sessionId: parentId, parentUuid: 'shared-a', type: 'user', timestamp: '2026-06-10T10:01:30Z', message: { role: 'user', content: '继续共享' } })
    ]
    const parentMsgs = [
      ...shared,
      rawMsg({ uuid: 'parent-u', sessionId: parentId, parentUuid: 'shared-u2', type: 'user', timestamp: '2026-06-10T10:02:00Z', message: { role: 'user', content: '父会话继续' } }),
      rawMsg({ uuid: 'parent-a', sessionId: parentId, parentUuid: 'parent-u', type: 'assistant', timestamp: '2026-06-10T10:03:00Z', message: { role: 'assistant', content: '父会话回答' } })
    ]
    const childMsgs = [
      ...shared,
      rawMsg({ uuid: 'child-u', sessionId: childId, parentUuid: 'shared-u2', type: 'user', timestamp: '2026-06-10T10:04:00Z', message: { role: 'user', content: 'fork child 的新问题' } }),
      rawMsg({ uuid: 'child-a', sessionId: childId, parentUuid: 'child-u', type: 'assistant', timestamp: '2026-06-10T10:05:00Z', message: { role: 'assistant', content: 'fork child 的回答' } })
    ]

    writeJsonlAt(parentFile, parentMsgs)
    writeJsonlAt(childFile, childMsgs)

    try {
      const sessions = await loadAllSessionsFromTempHome(home)
      const parent = sessions.find((s) => s.sessionId === parentId)
      const child = sessions.find((s) => s.sessionId === childId)

      expect(parent).toBeDefined()
      expect(child).toBeDefined()
      expect(child!.id).toBe(childId)
      expect(child!.filePath).toBe(childFile)
      expect(child!.branchParentId).toBe(parent!.id)
      expect(parent!.branchChildIds).toContain(child!.id)

      const detail = await loadSessionDetail(
        child!.filePath,
        child!.allFilePaths,
        child!.branchParentFilePaths,
        child!.branchPointUuid,
        child!.branchLeafUuid
      )
      expect(detail).not.toBeNull()
      expect(detail!.sessionId).toBe(childId)
      expect(detail!.messages.filter((m) => m.uuid === 'shared-a')).toHaveLength(1)
      expect(detail!.messages.some((m) => m.uuid === 'parent-u')).toBe(false)
      expect(detail!.messages.some((m) => m.uuid === 'child-u')).toBe(true)

      const context = await resolveSessionActionContext(childId, sessions)
      expect(context.sessionId).toBe(childId)
      expect(buildResumeCommand(context.sessionId, context.permissionMode, undefined, context.source))
        .toBe(`claude --resume ${shellQuote(childId)}`)

      // The unchanged parent's UUID graph must survive the cache; otherwise the
      // one-file update loses the child -> parent relationship.
      writeJsonlAt(childFile, [
        ...childMsgs,
        rawMsg({ uuid: 'child-u2', sessionId: childId, parentUuid: 'child-a', type: 'user', timestamp: '2026-06-10T10:06:00Z', message: { role: 'user', content: '只更新 child' } }),
        rawMsg({ uuid: 'child-a2', sessionId: childId, parentUuid: 'child-u2', type: 'assistant', timestamp: '2026-06-10T10:07:00Z', message: { role: 'assistant', content: 'child 新回答' } })
      ])
      const incremental = await loadAllSessionsFromTempHome(home)
      removeSummaryCache(home)
      const rebuilt = await loadAllSessionsFromTempHome(home)
      expect(incremental).toEqual(rebuilt)
      expect(incremental.find((s) => s.sessionId === childId)?.branchParentId).toBe(parent!.id)
      expect(incremental.find((s) => s.sessionId === parentId)?.branchChildIds).toContain(child!.id)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// ========================================================
// detectIntraFileBranches 测试
// ========================================================

/**
 * 构造一个有真实分支的消息树：两个终端同时 resume 同一 session，
 * 消息时间交错（M↔B 切换 >= 3 次）。
 *
 * 树结构：
 *   shared1 → shared2 → shared3 (fork point)
 *                           ├→ main1 → main2 → main3 (主路径，更长)
 *                           └→ branch1 → branch2     (分支)
 * 时间交错：main1, branch1, main2, branch2, main3
 */
function buildBranchTree() {
  const shared1 = rawMsg({ uuid: 's1', parentUuid: null, type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '开始对话' } })
  const shared2 = rawMsg({ uuid: 's2', parentUuid: 's1', type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })
  const shared3 = rawMsg({ uuid: 's3', parentUuid: 's2', type: 'user', timestamp: '2026-03-01T10:02:00Z', message: { role: 'user', content: '继续' } })

  // Main path (longer)
  const main1 = rawMsg({ uuid: 'm1', parentUuid: 's3', type: 'assistant', timestamp: '2026-03-01T10:03:00Z', message: { role: 'assistant', content: '主路径回复1' } })
  const main2 = rawMsg({ uuid: 'm2', parentUuid: 'm1', type: 'user', timestamp: '2026-03-01T10:05:00Z', message: { role: 'user', content: '主路径问题2' } })
  const main3 = rawMsg({ uuid: 'm3', parentUuid: 'm2', type: 'assistant', timestamp: '2026-03-01T10:07:00Z', message: { role: 'assistant', content: '主路径回复2' } })

  // Branch path (shorter, timestamps interleave with main)
  const branch1 = rawMsg({ uuid: 'b1', parentUuid: 's3', type: 'assistant', timestamp: '2026-03-01T10:04:00Z', message: { role: 'assistant', content: '分支回复1' } })
  const branch2 = rawMsg({ uuid: 'b2', parentUuid: 'b1', type: 'user', timestamp: '2026-03-01T10:06:00Z', message: { role: 'user', content: '分支问题2' } })

  return [shared1, shared2, shared3, main1, main2, main3, branch1, branch2]
}

describe('【曾经的 bug】分支检测不能被 traceToRoot 的改动破坏', () => {
  it('能检测到时间交错的真实分支', () => {
    const msgs = buildBranchTree()
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
    expect(branches[0].firstUserMessage).toBe('分支问题2')
  })

  it('分支的 turnCount 包含共享上下文的轮数', () => {
    const msgs = buildBranchTree()
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
    // 共享上下文: 1轮 (s1→s2) + 分支独有: 1轮 (b1→b2 中 user=b2) = 至少 > 0
    // 完整路径: s1, s2, s3, b1, b2 → user: s1, s3, b2 (3) / assistant: s2, b1 (2) → min(3,2) = 2
    expect(branches[0].turnCount).toBeGreaterThanOrEqual(2)
  })

  it('有 compact 边界时分支仍能被检测到', () => {
    // compact_boundary 的 parentUuid=null 不应该影响分支检测
    const compact = rawMsg({
      uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary',
      timestamp: '2026-03-01T09:00:00Z'
    })
    compact.logicalParentUuid = 'pre-compact-msg'

    const preCompact = rawMsg({ uuid: 'pre-compact-msg', parentUuid: null, type: 'user', timestamp: '2026-03-01T08:00:00Z', message: { role: 'user', content: '远古消息' } })
    const afterCompact = rawMsg({ uuid: 'ac1', parentUuid: 'cb', type: 'user', timestamp: '2026-03-01T09:01:00Z', message: { role: 'user', content: 'compact 后的对话' } })

    // Fork after compact
    const main1 = rawMsg({ uuid: 'pm1', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:02:00Z', message: { role: 'assistant', content: '主1' } })
    const main2 = rawMsg({ uuid: 'pm2', parentUuid: 'pm1', type: 'user', timestamp: '2026-03-01T09:04:00Z', message: { role: 'user', content: '主2' } })
    const main3 = rawMsg({ uuid: 'pm3', parentUuid: 'pm2', type: 'assistant', timestamp: '2026-03-01T09:06:00Z', message: { role: 'assistant', content: '主3' } })

    const branch1 = rawMsg({ uuid: 'pb1', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:03:00Z', message: { role: 'assistant', content: '支1' } })
    const branch2 = rawMsg({ uuid: 'pb2', parentUuid: 'pb1', type: 'user', timestamp: '2026-03-01T09:05:00Z', message: { role: 'user', content: '支2' } })

    const msgs = [preCompact, compact, afterCompact, main1, main2, main3, branch1, branch2]
    const branches = detectIntraFileBranches(msgs)

    expect(branches.length).toBeGreaterThanOrEqual(1)
  })

  it('两边都 compact 后仍能检测到分支', () => {
    // 场景：fork 后两个终端各自聊了很久，各自触发了 compact
    // traceToRoot 需要穿越各自的 compact_boundary 才能找到共享前缀
    const shared1 = rawMsg({ uuid: 'sh1', parentUuid: null, type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: '开始对话' } })
    const shared2 = rawMsg({ uuid: 'sh2', parentUuid: 'sh1', type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: '好的' } })

    // Main path: fork → lots of messages → compact → continue
    const mainPre = rawMsg({ uuid: 'mp1', parentUuid: 'sh2', type: 'user', timestamp: '2026-03-01T10:02:00Z', message: { role: 'user', content: '主路径开始' } })
    const mainPre2 = rawMsg({ uuid: 'mp2', parentUuid: 'mp1', type: 'assistant', timestamp: '2026-03-01T10:04:00Z', message: { role: 'assistant', content: '主路径回复' } })
    const mainCompact = rawMsg({ uuid: 'mc', parentUuid: null, type: 'system', subtype: 'compact_boundary', timestamp: '2026-03-01T11:00:00Z' })
    mainCompact.logicalParentUuid = 'mp2'
    const mainPost1 = rawMsg({ uuid: 'mq1', parentUuid: 'mc', type: 'user', timestamp: '2026-03-01T11:01:00Z', message: { role: 'user', content: '主路径继续' } })
    const mainPost2 = rawMsg({ uuid: 'mq2', parentUuid: 'mq1', type: 'assistant', timestamp: '2026-03-01T11:02:00Z', message: { role: 'assistant', content: '主路径继续回复' } })

    // Branch path: fork → lots of messages → compact → continue (timestamps interleave with main)
    const brPre = rawMsg({ uuid: 'bp1', parentUuid: 'sh2', type: 'user', timestamp: '2026-03-01T10:03:00Z', message: { role: 'user', content: '分支路径开始' } })
    const brPre2 = rawMsg({ uuid: 'bp2', parentUuid: 'bp1', type: 'assistant', timestamp: '2026-03-01T10:05:00Z', message: { role: 'assistant', content: '分支回复' } })
    const brCompact = rawMsg({ uuid: 'bc', parentUuid: null, type: 'system', subtype: 'compact_boundary', timestamp: '2026-03-01T11:05:00Z' })
    brCompact.logicalParentUuid = 'bp2'
    const brPost1 = rawMsg({ uuid: 'bq1', parentUuid: 'bc', type: 'user', timestamp: '2026-03-01T11:06:00Z', message: { role: 'user', content: '分支继续' } })

    const msgs = [shared1, shared2, mainPre, mainPre2, mainCompact, mainPost1, mainPost2, brPre, brPre2, brCompact, brPost1]
    const branches = detectIntraFileBranches(msgs)

    // 关键：即使两边都 compact 了，分支也必须被检测到
    expect(branches.length).toBeGreaterThanOrEqual(1)
  })
})

describe('filterMessagesByBranch 穿越 compact 边界', () => {
  it('分支过滤结果包含 compact 之前的消息', () => {
    const preCompact = rawMsg({ uuid: 'old1', parentUuid: null, type: 'user', timestamp: '2026-03-01T08:00:00Z', message: { role: 'user', content: '远古消息' } })
    const preCompact2 = rawMsg({ uuid: 'old2', parentUuid: 'old1', type: 'assistant', timestamp: '2026-03-01T08:01:00Z', message: { role: 'assistant', content: '远古回复' } })
    const compact = rawMsg({
      uuid: 'cb', parentUuid: null, type: 'system', subtype: 'compact_boundary',
      timestamp: '2026-03-01T09:00:00Z'
    })
    compact.logicalParentUuid = 'old2'

    const afterCompact = rawMsg({ uuid: 'ac1', parentUuid: 'cb', type: 'user', timestamp: '2026-03-01T09:01:00Z', message: { role: 'user', content: '新消息' } })
    const afterCompact2 = rawMsg({ uuid: 'ac2', parentUuid: 'ac1', type: 'assistant', timestamp: '2026-03-01T09:02:00Z', message: { role: 'assistant', content: '新回复' } })

    const msgs = [preCompact, preCompact2, compact, afterCompact, afterCompact2]
    const filtered = filterMessagesByBranch(msgs, 'ac2')

    // 应该包含 compact 之前和之后的所有消息
    const uuids = filtered.map(m => m.uuid)
    expect(uuids).toContain('old1')
    expect(uuids).toContain('old2')
    expect(uuids).toContain('cb')
    expect(uuids).toContain('ac1')
    expect(uuids).toContain('ac2')
  })
})

// ========================================================
// isRealUserMessage + turnCount 测试
// ========================================================

describe('【曾经的 bug】turnCount 不能把工具结果算成用户轮次', () => {
  it('tool_result 不是真实用户消息', () => {
    const toolResult = rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'file written' }] }
    })
    expect(isRealUserMessage(toolResult)).toBe(false)
  })

  it('【曾经的 bug】tool_result + text 混合也不是真实用户消息（AskUserQuestion 的回答）', () => {
    const mixed = rawMsg({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'abc', content: 'Answer questions?' },
        { type: 'text', text: 'Answer questions?' }
      ] as any }
    })
    expect(isRealUserMessage(mixed)).toBe(false)
  })

  it('纯文本的用户消息是真实的', () => {
    const textMsg = rawMsg({
      type: 'user',
      message: { role: 'user', content: '你好' }
    })
    expect(isRealUserMessage(textMsg)).toBe(true)
  })

  it('task-notification 不是真实用户消息', () => {
    const taskMsg = rawMsg({
      type: 'user',
      message: { role: 'user', content: '<task-notification>task completed</task-notification>' }
    })
    expect(isRealUserMessage(taskMsg)).toBe(false)
  })

  it('local-command caveat 和命令输出不是真实用户消息', () => {
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: '<local-command-caveat>Caveat</local-command-caveat>' }
    }))).toBe(false)
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: '<command-name>/model</command-name>' }
    }))).toBe(false)
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Set model</local-command-stdout>' }
    }))).toBe(false)
  })

  it('【曾经的 bug】"Tool loaded." 不是真实用户消息', () => {
    expect(isRealUserMessage(rawMsg({ type: 'user', message: { role: 'user', content: 'Tool loaded.' } }))).toBe(false)
  })

  it('【曾经的 bug】"Continue from where you left off." 不是真实用户消息（字符串格式）', () => {
    expect(isRealUserMessage(rawMsg({ type: 'user', message: { role: 'user', content: 'Continue from where you left off.' } }))).toBe(false)
  })

  it('【曾经的 bug】"Continue from where you left off." 不是真实用户消息（array 格式）', () => {
    expect(isRealUserMessage(rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Continue from where you left off.' }] as any }
    }))).toBe(false)
  })

  it('含 text 部分的 array content 是真实用户消息', () => {
    const mixed = rawMsg({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '请帮我看看' }] as any }
    })
    expect(isRealUserMessage(mixed)).toBe(true)
  })

  it('1 个用户消息 + 8 个 tool_result = turnCount 应该是 1 而不是 9', () => {
    const msgs = [
      rawMsg({ type: 'user', timestamp: '2026-03-01T10:00:00Z', message: { role: 'user', content: 'https://example.com' } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:01:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'WebFetch', input: {} }] as any } }),
      rawMsg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'fetched' }] as any } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: '继续' }, { type: 'tool_use', name: 'Write', input: {} }] as any } }),
      rawMsg({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'written' }] as any } }),
      rawMsg({ type: 'assistant', timestamp: '2026-03-01T10:03:00Z', message: { role: 'assistant', content: '完成' } })
    ]
    const fp = writeTempJsonl(msgs)
    const summary = buildSessionSummary(fp, msgs)

    expect(summary).not.toBeNull()
    // 只有 1 个真实用户消息，turnCount 应该是 1
    expect(summary!.turnCount).toBe(1)
  })
})

// ========================================================
// F1a：parseSessionFile 只按 \n 分行
// ========================================================
describe('parseSessionFile 只按 \\n 分行（F1a）', () => {
  const RAW_LS = Buffer.from([0xe2, 0x80, 0xa8]) // U+2028
  const RAW_PS = Buffer.from([0xe2, 0x80, 0xa9]) // U+2029

  // 键序照本文件的 rawMsg。JSON.stringify 不转义 U+2028 / U+2029，文件里是原字节。
  // 依次是：user（含 U+2028）、assistant（含 U+2029）、一条真坏行、一条没写完的尾行（无结尾 \n）。
  function writeLineSeparatorFixture(): { fp: string; user: RawJsonlMessage; assistant: RawJsonlMessage } {
    const user = rawMsg({
      uuid: 'f1a-user', type: 'user', timestamp: '2026-09-26T10:00:00Z',
      message: { role: 'user', content: '第一行 第二行' }
    })
    const assistant = rawMsg({
      uuid: 'f1a-assistant', parentUuid: 'f1a-user', type: 'assistant', timestamp: '2026-09-26T10:00:05Z',
      requestId: 'req_f1a',
      message: { role: 'assistant', content: [{ type: 'text', text: '段一 段二' }] as any }
    })
    const broken = '{"uuid":"f1a-broken","parentUuid":"f1a-assistant","sessionId":"test-session-id","type":"user","message":'
    const tail = JSON.stringify(rawMsg({
      uuid: 'f1a-tail', parentUuid: 'f1a-assistant', type: 'assistant', timestamp: '2026-09-26T10:00:09Z',
      message: { role: 'assistant', content: '写到一半' }
    })).slice(0, 80)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-claude-'))
    const fp = path.join(dir, 'test-session-id.jsonl')
    fs.writeFileSync(fp, [JSON.stringify(user), JSON.stringify(assistant), broken, tail].join('\n'))
    return { fp, user, assistant }
  }

  it('含原样 U+2028 / U+2029 的 user、assistant 记录不再丢；坏行与截断尾行照旧跳过', async () => {
    const { fp, user, assistant } = writeLineSeparatorFixture()
    const bytes = fs.readFileSync(fp)
    expect(bytes.includes(RAW_LS)).toBe(true)
    expect(bytes.includes(RAW_PS)).toBe(true)

    expect(await parseSessionFile(fp)).toEqual([user, assistant])

    const detail = await loadSessionDetail(fp)
    expect(detail!.messages.find((m) => m.uuid === 'f1a-user')?.textContent).toBe('第一行 第二行')
    expect(detail!.messages.find((m) => m.uuid === 'f1a-assistant')?.textContent).toContain('段一 段二')
  })

  it('读流出错（文件不存在）时照旧 resolve 已读部分，不抛', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-claude-missing-'))
    await expect(parseSessionFile(path.join(dir, 'missing.jsonl'))).resolves.toEqual([])
  })

  it('parseSessionFileWithStats 按记录计数：两条记录读全，坏行与截断尾行各计一条丢失', async () => {
    const { fp, user, assistant } = writeLineSeparatorFixture()
    const result = await parseSessionFileWithStats(fp)
    expect(result).toEqual({
      messages: [user, assistant],
      nonBlankLines: 4,
      recordsRead: 2,
      badLines: 2,
      recordsLost: 2,
      partialTail: true,
      truncated: false
    })
    expect(await parseSessionFile(fp)).toEqual(result.messages)
  })

  it('parseSessionFileWithStats：30 s 超时照旧返回已读部分，并标 truncated（fake timer，不真等）', async () => {
    const { fp } = writeLineSeparatorFixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      let settled = false
      const pending = parseSessionFileWithStats(fp)
      void pending.then(() => { settled = true })
      // 没有让出事件循环，文件一个字节都还没读到；29.999 s 时不应截断。
      vi.advanceTimersByTime(29_999)
      for (let i = 0; i < 10; i++) await Promise.resolve()
      expect(settled).toBe(false)
      vi.advanceTimersByTime(1)
      expect(await pending).toEqual({
        messages: [],
        nonBlankLines: 0,
        recordsRead: 0,
        badLines: 0,
        recordsLost: 0,
        partialTail: false,
        truncated: true
      })
    } finally {
      vi.useRealTimers()
    }
    // 让被 destroy 的读流收尾、关掉文件句柄。
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
  })

  it('parseSessionFileWithStats：读流出错照旧 resolve，但标 truncated，不再静默', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1a-claude-missing-'))
    expect(await parseSessionFileWithStats(path.join(dir, 'missing.jsonl'))).toEqual({
      messages: [],
      nonBlankLines: 0,
      recordsRead: 0,
      badLines: 0,
      recordsLost: 0,
      partialTail: false,
      truncated: true
    })
  })
})

// F1e: SQLite-backed sources (OpenCode/ZCode) under sqlite3 failures
// ========================================================
const sqliteCliIt = process.platform !== 'win32' && realSqlite3Path() ? it : it.skip
const CORRUPT_STDERR = 'Runtime error near line 2: database disk image is malformed (11)'
const BUSY_STDERR = 'Parse error near line 2: database is locked (5)'


describe('SQLite-agent sources under sqlite3 failures (F1e)', () => {
  const fakes: FakeSqlite3[] = []
  const homes: string[] = []

  function tempHome(label: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1e-${label}-home-`))
    homes.push(home)
    return home
  }

  function install(behavior: Parameters<typeof installFakeSqlite3>[0]): FakeSqlite3 {
    const fake = installFakeSqlite3(behavior)
    fakes.push(fake)
    return fake
  }

  function restoreFakes(): void {
    for (const fake of fakes.splice(0)) fake.restore()
  }

  afterEach(() => {
    restoreFakes()
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  sqliteCliIt('a failed session read marks the source partial with fixed codes and counts', async () => {
    const home = tempHome('partial')
    const goodRef = createSqliteAgentCacheFixture(home, 'opencode', 'ses_F1eGood')
    const dbPath = goodRef.slice(0, goodRef.lastIndexOf('#'))
    addSqliteAgentSession(dbPath, 'ses_F1eBad', 'bad session prompt')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    install({ kind: 'fail-matching', match: ['FROM "message"', 'ses_F1eBad'], stderr: CORRUPT_STDERR })

    await withSessionLoaderModules(home, async ({ sessionLoader, sqliteAgent }) => {
      const sessions = await sessionLoader.loadAllSessions({ readOnly: true, quiet: true })
      expect(sessions.map((session) => session.sessionId)).toContain('ses_F1eGood')
      expect(sessions.map((session) => session.sessionId)).not.toContain('ses_F1eBad')
      expect(sqliteAgent.getSqliteAgentSourceStatus('opencode')).toMatchObject({
        state: 'partial', reason: 'corrupt', sessionsRead: 1, sessionsFailed: 1, sessionsCarriedOver: 0
      })
      expect(sqliteAgent.getSqliteAgentSourceStatus('zcode')).toMatchObject({ state: 'absent', reason: null })
    })
    const logged = JSON.stringify(warn.mock.calls)
    for (const secret of [home, 'ses_F1eBad', 'malformed']) expect(logged).not.toContain(secret)
  }, 30_000)

  sqliteCliIt('9 a failed discovery keeps the last good sessions in the list, the summary cache and the usage ledger (hot and cold)', async () => {
    const home = tempHome('carry')
    const sessionId = 'ses_F1eCarry'
    const ref = createSqliteAgentCacheFixture(home, 'opencode', sessionId)
    const dbPath = ref.slice(0, ref.lastIndexOf('#'))
    const previousUsageIndex = process.env.SWOB_USAGE_INDEX_PATH
    process.env.SWOB_USAGE_INDEX_PATH = path.join(home, 'usage-facts.db')
    const usage = await import('./usage-fact-store')
    usage.closeUsageFactStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ledgerEvents = () => usage.sessionUsageEvents(sessionId, { range: 'all', metricBasis: 'billing' }).events.length
    const snapshot = (value: unknown) => JSON.parse(JSON.stringify(value ?? null))
    try {
      let baseline: any
      let row: ReturnType<typeof readSummaryCacheRow>
      await withSessionLoaderModules(home, async ({ sessionLoader, sqliteAgent }) => {
        const first = await sessionLoader.loadAllSessions({ quiet: true })
        baseline = snapshot(first.find((session) => session.sessionId === sessionId))
        expect(baseline.providerOutcome).toEqual({ detected: 'detected', parse: 'parsed', usage: 'available' })
        usage.synchronizeUsageFacts(first, [])
        expect(ledgerEvents()).toBeGreaterThan(0)
        row = readSummaryCacheRow(home, ref)
        expect(JSON.parse(row!.per_file_json).summary).not.toBeNull()

        // The DB gets a new signature, then stops being readable.
        touchSqliteAgentDb(dbPath)
        install({ kind: 'fail', stderr: BUSY_STDERR })

        // Hot: this process's last successful discovery supplies the refs.
        const hot = await sessionLoader.loadAllSessions({ quiet: true })
        const carried = snapshot(hot.find((session) => session.sessionId === sessionId))
        expect(carried).toEqual(baseline)
        expect(carried.providerOutcome).toEqual(baseline.providerOutcome)
        expect(carried.tokenAccounting).toEqual(baseline.tokenAccounting)
        expect(sqliteAgent.getSqliteAgentSourceStatus('opencode')).toMatchObject({
          state: 'unavailable', reason: 'busy', sessionsRead: 0, sessionsFailed: 0, sessionsCarriedOver: 1
        })
        // Chain 1: the usage sync deletes every session missing from its input.
        usage.synchronizeUsageFacts(hot, [])
        expect(ledgerEvents()).toBeGreaterThan(0)
      })
      // Chains 2 and 3: the row is neither pruned nor rewritten.
      expect(readSummaryCacheRow(home, ref)).toEqual(row)

      // Cold: a fresh module instance takes the refs from the summary cache.
      await withSessionLoaderModules(home, async ({ sessionLoader, sqliteAgent }) => {
        const cold = await sessionLoader.loadAllSessions({ quiet: true })
        expect(snapshot(cold.find((session) => session.sessionId === sessionId))).toEqual(baseline)
        expect(sqliteAgent.getSqliteAgentSourceStatus('opencode')).toMatchObject({
          state: 'unavailable', reason: 'busy', sessionsRead: 0, sessionsCarriedOver: 1
        })
        usage.synchronizeUsageFacts(cold, [])
        expect(ledgerEvents()).toBeGreaterThan(0)
      })
      expect(readSummaryCacheRow(home, ref)).toEqual(row)

      const logged = JSON.stringify(warn.mock.calls)
      for (const secret of [home, sessionId, 'database is locked']) expect(logged).not.toContain(secret)
    } finally {
      usage.closeUsageFactStore()
      if (previousUsageIndex === undefined) delete process.env.SWOB_USAGE_INDEX_PATH
      else process.env.SWOB_USAGE_INDEX_PATH = previousUsageIndex
    }
  }, 60_000)

  sqliteCliIt('10 a failed session read is never cached as empty: skipped without a row, carried over with one', async () => {
    const home = tempHome('session-failure')
    const keepRef = createSqliteAgentCacheFixture(home, 'opencode', 'ses_F1eKeep')
    const dbPath = keepRef.slice(0, keepRef.lastIndexOf('#'))
    const flakyRef = addSqliteAgentSession(dbPath, 'ses_F1eFlaky', 'flaky session prompt')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failFlakyMessages = () => install({
      kind: 'fail-matching', match: ['FROM "message"', 'ses_F1eFlaky'], stderr: CORRUPT_STDERR
    })
    const ids = (sessions: Array<{ sessionId: string }>) => sessions.map((session) => session.sessionId)

    // No cached row yet: the session sits this load out and nothing is written for it.
    failFlakyMessages()
    await withSessionLoaderModules(home, async ({ sessionLoader, sqliteAgent }) => {
      const sessions = await sessionLoader.loadAllSessions({ quiet: true })
      expect(ids(sessions)).toContain('ses_F1eKeep')
      expect(ids(sessions)).not.toContain('ses_F1eFlaky')
      // Regression pin (chain 3): the failure used to be persisted as `summary: null`.
      expect(readSummaryCacheRow(home, flakyRef)).toBeUndefined()
      expect(sqliteAgent.getSqliteAgentSourceStatus('opencode')).toMatchObject({
        state: 'partial', reason: 'corrupt', sessionsRead: 1, sessionsFailed: 1, sessionsCarriedOver: 0
      })
    })
    restoreFakes()

    // That null row used to be reused under the unchanged DB signature, hiding
    // the session until the DB file changed; now it simply reads again.
    let recovered: unknown
    await withSessionLoaderModules(home, async ({ sessionLoader, sqliteAgent }) => {
      const sessions = await sessionLoader.loadAllSessions({ quiet: true })
      recovered = JSON.parse(JSON.stringify(sessions.find((session) => session.sessionId === 'ses_F1eFlaky') ?? null))
      expect(recovered).toMatchObject({ sessionId: 'ses_F1eFlaky', firstUserMessage: 'flaky session prompt' })
      expect(sqliteAgent.getSqliteAgentSourceStatus('opencode'))
        .toMatchObject({ state: 'ok', reason: null, sessionsRead: 2, sessionsFailed: 0 })
    })
    const row = readSummaryCacheRow(home, flakyRef)
    expect(JSON.parse(row!.per_file_json).summary).not.toBeNull()

    // With a good row cached, a later failure under a new signature keeps it as is.
    touchSqliteAgentDb(dbPath)
    failFlakyMessages()
    await withSessionLoaderModules(home, async ({ sessionLoader, sqliteAgent }) => {
      const sessions = await sessionLoader.loadAllSessions({ quiet: true })
      expect(JSON.parse(JSON.stringify(sessions.find((session) => session.sessionId === 'ses_F1eFlaky') ?? null)))
        .toEqual(recovered)
      expect(sqliteAgent.getSqliteAgentSourceStatus('opencode')).toMatchObject({
        state: 'partial', reason: 'corrupt', sessionsRead: 1, sessionsFailed: 1, sessionsCarriedOver: 1
      })
    })
    expect(readSummaryCacheRow(home, flakyRef)).toEqual(row)
  }, 60_000)
})

// 键序照《附录-Codex键序普查》，见 __fixtures__/codex-rollout-synthetic.ts；值全部是合成的。
describe('Codex 子 agent：压缩、分叉用量与孙级挂接（F1b）', () => {
  const CWD = '/synthetic/project'
  const MODEL = 'gpt-5.5-codex'
  const TOP_ID = '7f1b0000-0000-4000-8000-000000000011'
  const CHILD_ID = '7f1b0000-0000-4000-8000-000000000012'

  function codexHome(): { home: string; write: (id: string, rows: CodexFixtureRow[]) => string } {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-f1b-home-'))
    const directory = path.join(home, '.codex', 'sessions', '2026', '09', '20')
    fs.mkdirSync(directory, { recursive: true })
    return {
      home,
      write: (id, rows) => {
        const filePath = path.join(directory, `rollout-2026-09-20T08-00-00-${id}.jsonl`)
        fs.writeFileSync(filePath, codexJsonl(rows))
        return filePath
      }
    }
  }

  /**
   * A forked thread-spawn child: its session_meta, the parent's rows after the
   * parent's session_meta copied with rewritten timestamps, then `own` rows.
   */
  function forkedChildRows(params: {
    id: string
    parentId: string
    depth: number
    parentRows: CodexFixtureRow[]
    forkedAt: string
    own: (at: () => CodexRowBase) => CodexFixtureRow[]
  }): CodexFixtureRow[] {
    const inherited = copiedPrefix(params.parentRows.slice(1), {
      startIso: codexTime(params.forkedAt, 1),
      firstOrdinal: 1
    })
    const meta = codexRow.threadSpawnMeta({
      timestamp: params.forkedAt,
      ordinal: 0,
      id: params.id,
      parentId: params.parentId,
      cwd: CWD,
      depth: params.depth,
      historyStartOrdinal: 1 + inherited.length
    })
    const own = params.own(codexClock(codexTime(params.forkedAt, 60_000), 1 + inherited.length))
    return [meta, ...inherited, ...own]
  }

  /** Two parent turns before the fork: 1,100 + 1,650 billable tokens. */
  function parentPrefixRows(): CodexFixtureRow[] {
    const at = codexClock('2026-09-20T08:00:00.000Z')
    return [
      codexRow.topLevelMeta({ ...at(), id: TOP_ID, cwd: CWD }),
      codexRow.turnContext({ ...at(), turnId: 'parent-turn-1', cwd: CWD, model: MODEL }),
      codexRow.userMessage({ ...at(), text: '父会话的问题' }),
      codexRow.assistantMessage({ ...at(), text: '父会话的回答' }),
      codexRow.tokenCount({
        ...at(),
        total: { input: 1000, cached: 200, output: 100 },
        last: { input: 1000, cached: 200, output: 100 }
      }),
      codexRow.turnContext({ ...at(), turnId: 'parent-turn-2', cwd: CWD, model: MODEL }),
      codexRow.userMessage({ ...at(), text: '父会话的第二个问题' }),
      codexRow.tokenCount({
        ...at(),
        total: { input: 2500, cached: 700, output: 250 },
        last: { input: 1500, cached: 500, output: 150 }
      })
    ]
  }

  it('子 agent 文件里的 compacted（含抄自父会话的）不计入父会话 compactCount', async () => {
    const { home, write } = codexHome()
    const at = codexClock('2026-09-20T08:00:00.000Z')
    const parentRows = [
      codexRow.topLevelMeta({ ...at(), id: TOP_ID, cwd: CWD }),
      codexRow.turnContext({ ...at(), turnId: 'parent-turn-1', cwd: CWD, model: MODEL }),
      codexRow.userMessage({ ...at(), text: '父会话的问题' }),
      codexRow.assistantMessage({ ...at(), text: '父会话的回答' }),
      codexRow.compacted({ ...at(), message: '父会话的压缩', window: 1 }),
      codexRow.userMessage({ ...at(), text: '压缩后继续' }),
      codexRow.assistantMessage({ ...at(), text: '继续回答' })
    ]
    write(TOP_ID, parentRows)
    write(CHILD_ID, forkedChildRows({
      id: CHILD_ID,
      parentId: TOP_ID,
      depth: 1,
      parentRows,
      forkedAt: '2026-09-20T08:10:00.000Z',
      own: (next) => [
        codexRow.turnContext({ ...next(), turnId: 'child-turn-1', cwd: CWD, model: MODEL }),
        codexRow.userMessage({ ...next(), text: '子任务' }),
        codexRow.compacted({ ...next(), message: '子 agent 自己的压缩', window: 2 }),
        codexRow.assistantMessage({ ...next(), text: '子任务完成' })
      ]
    }))

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })

      expect(sessions.map((session) => session.sessionId)).toEqual([TOP_ID])
      expect(sessions[0].compactCount).toBe(1)
      expect(sessions[0].subagents).toEqual([
        expect.objectContaining({ sessionId: CHILD_ID, parentSessionId: TOP_ID, role: 'thread-spawn' })
      ])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('分叉子 agent 抄写父会话用量快照（时间戳改写）：父会话 billingTotal 只计一次，审计行两份都在', async () => {
    const { home, write } = codexHome()
    const prefix = parentPrefixRows()
    const after = codexClock('2026-09-20T08:20:00.000Z', prefix.length)
    write(TOP_ID, [
      ...prefix,
      codexRow.turnContext({ ...after(), turnId: 'parent-turn-3', cwd: CWD, model: MODEL }),
      codexRow.userMessage({ ...after(), text: '分叉之后父会话继续' }),
      codexRow.tokenCount({
        ...after(),
        total: { input: 3700, cached: 1000, output: 370 },
        last: { input: 1200, cached: 300, output: 120 }
      })
    ])
    write(CHILD_ID, forkedChildRows({
      id: CHILD_ID,
      parentId: TOP_ID,
      depth: 1,
      parentRows: prefix,
      forkedAt: '2026-09-20T08:10:00.000Z',
      own: (next) => [
        codexRow.turnContext({ ...next(), turnId: 'child-turn-1', cwd: CWD, model: MODEL }),
        codexRow.userMessage({ ...next(), text: '子任务' }),
        codexRow.assistantMessage({ ...next(), text: '子任务完成' }),
        codexRow.tokenCount({
          ...next(),
          total: { input: 3100, cached: 900, output: 300 },
          last: { input: 600, cached: 200, output: 50 }
        })
      ]
    }))

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
      const parent = sessions.find((session) => session.sessionId === TOP_ID)
      const events = parent?.tokenAccounting?.usageEvents ?? []

      expect(sessions.map((session) => session.sessionId)).toEqual([TOP_ID])
      // Parent 1,100 + 1,650 + 1,320 once; the child adds only its own 650.
      expect(parent?.tokenAccounting?.billingTotal).toBe(4_720)
      expect(parent?.tokenAccounting?.conversationOnly).toBe(4_070)
      expect(events).toHaveLength(6)
      const copiedFacts = new Map<string, typeof events>()
      for (const event of events) {
        const key = event.billingFactKey ?? event.dedupKey
        copiedFacts.set(key, [...(copiedFacts.get(key) ?? []), event])
      }
      const shared = [...copiedFacts.values()].filter((group) => group.length > 1)
      expect(shared).toHaveLength(2)
      for (const group of shared) {
        expect(new Set(group.map((event) => event.auditSourceId))).toEqual(new Set([TOP_ID, CHILD_ID]))
        expect(new Set(group.map((event) => event.timestamp)).size).toBe(2)
      }
      expect(parent?.tokenAccounting?.warnings).toContain('deduplicated 2 cross-session usage events')
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('顶层 → 子 → 孙（子下另挂 guardian）：全部挂到顶层，subagents 含子和孙且各自保留直接父，抄写前缀只计一次', async () => {
    const { home, write } = codexHome()
    const grandchildId = '7f1b0000-0000-4000-8000-000000000013'
    const guardianId = '7f1b0000-0000-4000-8000-000000000014'
    const prefix = parentPrefixRows()
    write(TOP_ID, prefix)
    const childRows = forkedChildRows({
      id: CHILD_ID,
      parentId: TOP_ID,
      depth: 1,
      parentRows: prefix,
      forkedAt: '2026-09-20T08:10:00.000Z',
      own: (next) => [
        codexRow.turnContext({ ...next(), turnId: 'child-turn-1', cwd: CWD, model: MODEL }),
        codexRow.userMessage({ ...next(), text: '子任务' }),
        codexRow.tokenCount({
          ...next(),
          total: { input: 3100, cached: 900, output: 300 },
          last: { input: 600, cached: 200, output: 50 }
        }),
        codexRow.assistantMessage({ ...next(), text: '子任务完成' })
      ]
    })
    write(CHILD_ID, childRows)
    write(grandchildId, forkedChildRows({
      id: grandchildId,
      parentId: CHILD_ID,
      depth: 2,
      parentRows: childRows,
      forkedAt: '2026-09-20T08:30:00.000Z',
      own: (next) => [
        codexRow.turnContext({ ...next(), turnId: 'grandchild-turn-1', cwd: CWD, model: MODEL }),
        codexRow.userMessage({ ...next(), text: '孙任务' }),
        codexRow.tokenCount({
          ...next(),
          total: { input: 3500, cached: 1000, output: 340 },
          last: { input: 400, cached: 100, output: 40 }
        }),
        codexRow.assistantMessage({ ...next(), text: '孙任务完成' })
      ]
    }))
    const guardian = codexClock('2026-09-20T08:40:00.000Z')
    write(guardianId, [
      codexRow.guardianMeta({ ...guardian(), id: guardianId, parentId: CHILD_ID, cwd: CWD }),
      codexRow.turnContext({ ...guardian(), turnId: 'guardian-turn-1', cwd: CWD, model: MODEL }),
      codexRow.userMessage({ ...guardian(), text: '审批请求' }),
      codexRow.tokenCount({
        ...guardian(),
        total: { input: 300, cached: 0, output: 30 },
        last: { input: 300, cached: 0, output: 30 }
      }),
      codexRow.assistantMessage({ ...guardian(), text: '批准' })
    ])

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
      const parent = sessions.find((session) => session.sessionId === TOP_ID)
      const events = parent?.tokenAccounting?.usageEvents ?? []

      expect(sessions.map((session) => session.sessionId)).toEqual([TOP_ID])
      expect(parent?.subagents?.map(({ sessionId, parentSessionId, role }) => ({ sessionId, parentSessionId, role }))).toEqual([
        { sessionId: CHILD_ID, parentSessionId: TOP_ID, role: 'thread-spawn' },
        { sessionId: grandchildId, parentSessionId: CHILD_ID, role: 'thread-spawn' }
      ])
      // Parent 1,100 + 1,650, child 650, grandchild 440, guardian 330: each fact once.
      expect(parent?.tokenAccounting?.billingTotal).toBe(4_170)
      expect(parent?.tokenAccounting?.conversationOnly).toBe(2_750)
      expect(new Set(events.map((event) => event.auditSourceId)))
        .toEqual(new Set([TOP_ID, CHILD_ID, grandchildId, guardianId]))
      expect(events).toHaveLength(10)
      expect(buildExecutionTree([], TOP_ID, parent?.subagents ?? []).turns.flatMap((turn) => turn.agentSpawns)
        .map((spawn) => spawn.id)).toEqual([CHILD_ID])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('中间父文件缺失：孙级挂不上就照旧丢弃，不报错，顶层不受影响', async () => {
    const { home, write } = codexHome()
    const prefix = parentPrefixRows()
    write(TOP_ID, prefix)
    write('7f1b0000-0000-4000-8000-000000000015', forkedChildRows({
      id: '7f1b0000-0000-4000-8000-000000000015',
      parentId: CHILD_ID,
      depth: 2,
      parentRows: prefix,
      forkedAt: '2026-09-20T08:30:00.000Z',
      own: (next) => [
        codexRow.turnContext({ ...next(), turnId: 'orphan-turn-1', cwd: CWD, model: MODEL }),
        codexRow.tokenCount({
          ...next(),
          total: { input: 2900, cached: 800, output: 290 },
          last: { input: 400, cached: 100, output: 40 }
        })
      ]
    }))

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })

      expect(sessions.map((session) => session.sessionId)).toEqual([TOP_ID])
      expect(sessions[0].subagents).toBeUndefined()
      expect(sessions[0].tokenAccounting?.billingTotal).toBe(2_750)
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('环与超深链：互为父或自为父的记录不挂接，链超过 16 层的部分不挂接，都不会死循环', async () => {
    const { home, write } = codexHome()
    write(TOP_ID, parentPrefixRows())
    const worker = (id: string, parentId: string, depth: number, minute: number): CodexFixtureRow[] => {
      const at = codexClock(codexTime('2026-09-20T09:00:00.000Z', minute * 60_000))
      return [
        codexRow.threadSpawnMeta({ ...at(), id, parentId, cwd: CWD, depth, historyStartOrdinal: 1 }),
        codexRow.turnContext({ ...at(), turnId: `${id}-turn`, cwd: CWD, model: MODEL }),
        codexRow.userMessage({ ...at(), text: '子任务' })
      ]
    }
    const loopA = '7f1b0000-0000-4000-8000-0000000000a1'
    const loopB = '7f1b0000-0000-4000-8000-0000000000a2'
    const selfParent = '7f1b0000-0000-4000-8000-0000000000a3'
    write(loopA, worker(loopA, loopB, 1, 1))
    write(loopB, worker(loopB, loopA, 1, 2))
    write(selfParent, worker(selfParent, selfParent, 1, 3))
    const chain = Array.from({ length: 17 }, (_, index) =>
      `7f1b0000-0000-4000-8000-0000000001${String(index + 1).padStart(2, '0')}`)
    chain.forEach((id, index) => write(id, worker(id, index === 0 ? TOP_ID : chain[index - 1], index + 1, 10 + index)))

    try {
      const sessions = await loadAllSessionsFromTempHome(home, { readOnly: true, quiet: true })
      const attached = sessions[0].subagents?.map((subagent) => subagent.sessionId) ?? []

      expect(sessions.map((session) => session.sessionId)).toEqual([TOP_ID])
      expect(attached).toEqual(chain.slice(0, 16))
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

// F1f: evidence of each physical load, for the usage ledger
// ========================================================
describe('physical-load evidence for the usage ledger (F1f)', () => {
  const fakes: FakeSqlite3[] = []
  const homes: string[] = []

  function tempHome(label: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1f-${label}-home-`))
    homes.push(home)
    return home
  }

  function install(behavior: Parameters<typeof installFakeSqlite3>[0]): FakeSqlite3 {
    const fake = installFakeSqlite3(behavior)
    fakes.push(fake)
    return fake
  }

  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.restore()
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const absentSqliteSources = () => Object.fromEntries((['opencode', 'zcode'] as const)
    .filter((source) => isSessionSourceSupported(source))
    .map((source) => [source, { discovery: 'absent', presentSessionIds: [] }]))

  it('one evidence per physical load, shared by every reader of its flight; cold until the summary cache is usable', async () => {
    const home = tempHome('evidence')
    writeJsonlAt(path.join(home, '.claude', 'projects', '-Users-test-evidence', 'evidence-session.jsonl'), [
      rawMsg({ sessionId: 'evidence-session', type: 'user', message: { role: 'user', content: 'evidence fixture' } })
    ])

    await withSessionLoaderModules(home, async ({ sessionLoader }) => {
      // The desktop's first paint (read-only), its writable completion and an
      // action reload that overlap all read one physical load.
      const [readOnly, writable, completion] = await Promise.all([
        sessionLoader.loadAllSessionsWithEvidence({ readOnly: true, quiet: true }),
        sessionLoader.loadAllSessionsWithEvidence({ quiet: true }),
        sessionLoader.loadAllSessionsWithProviderStatus()
      ])
      expect(readOnly.sessions.map((session) => session.sessionId)).toEqual(['evidence-session'])
      expect(writable.evidence).toBe(readOnly.evidence)
      expect(completion.evidence).toBe(readOnly.evidence)
      expect(readOnly.evidence).toEqual({
        loadId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        summaryCache: 'cold',
        sqliteSources: absentSqliteSources()
      })

      // The next load is independent, and the writable load above saved the cache.
      const warm = await sessionLoader.loadAllSessionsWithEvidence({ readOnly: true, quiet: true })
      expect(warm.evidence.loadId).not.toBe(readOnly.evidence.loadId)
      expect(warm.evidence.summaryCache).toBe('warm')
      expect(warm.sessions).toEqual(await sessionLoader.loadAllSessions({ readOnly: true, quiet: true }))

      // Another CACHE_VERSION (as after F1d) or no cache at all is cold again.
      setSummaryCacheVersion(home, 1)
      expect((await sessionLoader.loadAllSessionsWithEvidence({ readOnly: true, quiet: true })).evidence.summaryCache)
        .toBe('cold')
      removeSummaryCache(home)
      expect((await sessionLoader.loadAllSessionsWithEvidence({ readOnly: true, quiet: true })).evidence.summaryCache)
        .toBe('cold')
    })
  }, 30_000)

  sqliteCliIt('reports each SQLite source discovery and the session ids it lists, never a path', async () => {
    const home = tempHome('sqlite-evidence')
    const firstRef = createSqliteAgentCacheFixture(home, 'opencode', 'ses_F1fListedA')
    const dbPath = firstRef.slice(0, firstRef.lastIndexOf('#'))
    addSqliteAgentSession(dbPath, 'ses_F1fListedB', 'second evidence session')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const evidences: unknown[] = []

    await withSessionLoaderModules(home, async ({ sessionLoader }) => {
      const ok = await sessionLoader.loadAllSessionsWithEvidence({ quiet: true })
      evidences.push(ok.evidence)
      expect(ok.evidence.sqliteSources.opencode).toEqual({ discovery: 'ok', presentSessionIds: expect.any(Array) })
      expect([...ok.evidence.sqliteSources.opencode!.presentSessionIds].sort())
        .toEqual(['ses_F1fListedA', 'ses_F1fListedB'])
      expect(ok.evidence.sqliteSources.zcode).toEqual({ discovery: 'absent', presentSessionIds: [] })

      // A failed session read leaves the discovery 'ok': the DB still lists it.
      install({ kind: 'fail-matching', match: ['FROM "message"', 'ses_F1fListedB'], stderr: CORRUPT_STDERR })
      touchSqliteAgentDb(dbPath)
      const partial = await sessionLoader.loadAllSessionsWithEvidence({ quiet: true })
      evidences.push(partial.evidence)
      expect([...partial.evidence.sqliteSources.opencode!.presentSessionIds].sort())
        .toEqual(['ses_F1fListedA', 'ses_F1fListedB'])
      for (const fake of fakes.splice(0)) fake.restore()

      // A failed discovery lists nothing, even while the sessions are carried over.
      install({ kind: 'fail', stderr: BUSY_STDERR })
      touchSqliteAgentDb(dbPath)
      const unavailable = await sessionLoader.loadAllSessionsWithEvidence({ quiet: true })
      evidences.push(unavailable.evidence)
      expect(unavailable.sessions.map((session) => session.sessionId))
        .toEqual(expect.arrayContaining(['ses_F1fListedA', 'ses_F1fListedB']))
      expect(unavailable.evidence.sqliteSources.opencode).toEqual({ discovery: 'unavailable', presentSessionIds: [] })
    })

    const serialized = JSON.stringify(evidences)
    for (const secret of [home, dbPath, 'opencode.db', 'database is locked', 'malformed']) {
      expect(serialized).not.toContain(secret)
    }
  }, 60_000)
})

// F1f: the usage ledger keeps what a load did not see (pins 1-5, 10, 11, 14)
// ========================================================
describe('the usage ledger keeps what a load did not see (F1f)', () => {
  type SessionLoaderModule = typeof import('./session-loader')
  type UsageModule = typeof import('./usage-fact-store')
  type Loaded = { sessions: Awaited<ReturnType<SessionLoaderModule['loadAllSessions']>>; evidence?: SessionLoadEvidence }

  const fakes: FakeSqlite3[] = []
  const homes: string[] = []

  function tempHome(label: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1f-${label}-home-`))
    homes.push(home)
    return home
  }

  function install(behavior: Parameters<typeof installFakeSqlite3>[0]): FakeSqlite3 {
    const fake = installFakeSqlite3(behavior)
    fakes.push(fake)
    return fake
  }

  function restoreFakes(): void {
    for (const fake of fakes.splice(0)) fake.restore()
  }

  afterEach(() => {
    restoreFakes()
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /**
   * Load through the evidence-carrying export when there is one. The optional
   * call keeps these pins runnable on code without it: the sync then gets no
   * evidence, falls back to the legacy semantics and really deletes rows, so
   * the pins fail on the ledger counts rather than on a missing function.
   */
  async function load(sessionLoader: SessionLoaderModule): Promise<Loaded> {
    const withEvidence = (sessionLoader as Partial<SessionLoaderModule>).loadAllSessionsWithEvidence
    if (typeof withEvidence === 'function') return withEvidence({ quiet: true })
    return { sessions: await sessionLoader.loadAllSessions({ quiet: true }) }
  }

  function sync(usage: UsageModule, loaded: Loaded): ReturnType<UsageModule['synchronizeUsageFacts']> {
    return usage.synchronizeUsageFacts(loaded.sessions, [], loaded.evidence
      ? { absence: { physicalLoad: loaded.evidence, providerSettlement: 'complete', excludedSources: [] } }
      : {})
  }

  /** The ledger rows of `sessionIds`, through a separate read-only connection. */
  function ledgerCounts(home: string, sessionIds: readonly string[]): { sessions: number; facts: number; history: number } {
    const ledger = new Database(path.join(home, 'usage-facts.db'), { readonly: true, fileMustExist: true })
    try {
      const placeholders = sessionIds.map(() => '?').join(', ')
      const count = (table: string): number => (ledger.prepare(
        `SELECT count(*) AS count FROM ${table} WHERE session_id IN (${placeholders})`
      ).get(...sessionIds) as { count: number }).count
      return { sessions: count('usage_sessions'), facts: count('usage_facts'), history: count('usage_valuation_history') }
    } finally {
      ledger.close()
    }
  }

  async function withUsageLedger<T>(home: string, run: (usage: UsageModule) => Promise<T>): Promise<T> {
    const previousUsageIndex = process.env.SWOB_USAGE_INDEX_PATH
    process.env.SWOB_USAGE_INDEX_PATH = path.join(home, 'usage-facts.db')
    // One ledger module for the whole pin, like the one long-lived usage worker.
    const usage = await import('./usage-fact-store')
    usage.closeUsageFactStore()
    try {
      return await run(usage)
    } finally {
      usage.closeUsageFactStore()
      if (previousUsageIndex === undefined) delete process.env.SWOB_USAGE_INDEX_PATH
      else process.env.SWOB_USAGE_INDEX_PATH = previousUsageIndex
    }
  }

  /** Two OpenCode sessions, both with usage, loaded and synced once. */
  function openCodePair(home: string): { dbPath: string; keptId: string; flakyId: string; flakyRef: string; ids: string[] } {
    const keptId = 'ses_F1fKept'
    const flakyId = 'ses_F1fFlaky'
    const keptRef = createSqliteAgentCacheFixture(home, 'opencode', keptId)
    const dbPath = keptRef.slice(0, keptRef.lastIndexOf('#'))
    const flakyRef = addSqliteAgentSession(dbPath, flakyId, 'flaky pin prompt', { withUsage: true })
    return { dbPath, keptId, flakyId, flakyRef, ids: [keptId, flakyId] }
  }

  async function warmUp(
    sessionLoader: SessionLoaderModule,
    usage: UsageModule,
    home: string,
    ids: readonly string[]
  ): Promise<{ sessions: number; facts: number; history: number }> {
    const first = await load(sessionLoader)
    expect(first.sessions.map((session) => session.sessionId)).toEqual(expect.arrayContaining([...ids]))
    expect(sync(usage, first)).toMatchObject({ changedSessions: ids.length, removedSessions: 0 })
    const baseline = ledgerCounts(home, ids)
    expect(baseline).toMatchObject({ sessions: ids.length })
    expect(baseline.facts).toBeGreaterThanOrEqual(ids.length)
    expect(baseline.history).toBeGreaterThanOrEqual(ids.length)
    return baseline
  }

  const flakyMessages = (flakyId: string) =>
    ({ kind: 'fail-matching', match: ['FROM "message"', flakyId], stderr: CORRUPT_STDERR }) as const

  sqliteCliIt('1 hot, every read succeeds: nothing leaves the ledger', async () => {
    const home = tempHome('pin1')
    const { ids } = openCodePair(home)
    await withUsageLedger(home, async (usage) => {
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const baseline = await warmUp(sessionLoader, usage, home, ids)
        const hot = await load(sessionLoader)
        const result = sync(usage, hot)
        expect(ledgerCounts(home, ids)).toEqual(baseline)
        expect(result).toMatchObject({ changedSessions: 0, unchangedSessions: 2, removedSessions: 0 })
      })
    })
  }, 60_000)

  sqliteCliIt('2 hot, one session read fails: its last good row stands in, nothing leaves the ledger', async () => {
    const home = tempHome('pin2')
    const { dbPath, flakyId, ids } = openCodePair(home)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withUsageLedger(home, async (usage) => {
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const baseline = await warmUp(sessionLoader, usage, home, ids)
        touchSqliteAgentDb(dbPath)
        install(flakyMessages(flakyId))
        const hot = await load(sessionLoader)
        expect(hot.sessions.map((session) => session.sessionId)).toContain(flakyId)
        const result = sync(usage, hot)
        expect(ledgerCounts(home, ids)).toEqual(baseline)
        expect(result).toMatchObject({ removedSessions: 0 })
      })
    })
  }, 60_000)

  sqliteCliIt('3 cold (summary cache reset), one session read fails: the absent session keeps its facts and history', async () => {
    const home = tempHome('pin3')
    const { flakyId, ids } = openCodePair(home)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withUsageLedger(home, async (usage) => {
      let baseline!: ReturnType<typeof ledgerCounts>
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        baseline = await warmUp(sessionLoader, usage, home, ids)
      })
      setSummaryCacheVersion(home, 1)
      install(flakyMessages(flakyId))
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const cold = await load(sessionLoader)
        expect(cold.sessions.map((session) => session.sessionId)).not.toContain(flakyId)
        const result = sync(usage, cold)
        // The ledger first: this is what the legacy semantics destroys.
        expect(ledgerCounts(home, ids)).toEqual(baseline)
        expect(result).toMatchObject({
          removedSessions: 0,
          retainedSessions: 1,
          heldRemovals: 0,
          absences: [{ source: 'opencode', reason: 'cold-summary-cache', sessions: 1 }]
        })
      })
    })
  }, 60_000)

  sqliteCliIt('4 cold (summary cache reset), the whole source fails discovery: every session keeps its facts and history', async () => {
    const home = tempHome('pin4')
    const { ids } = openCodePair(home)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withUsageLedger(home, async (usage) => {
      let baseline!: ReturnType<typeof ledgerCounts>
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        baseline = await warmUp(sessionLoader, usage, home, ids)
      })
      setSummaryCacheVersion(home, 1)
      install({ kind: 'fail', stderr: BUSY_STDERR })
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const cold = await load(sessionLoader)
        expect(cold.sessions.filter((session) => session.source === 'opencode')).toEqual([])
        const result = sync(usage, cold)
        expect(ledgerCounts(home, ids)).toEqual(baseline)
        expect(result).toMatchObject({
          removedSessions: 0,
          retainedSessions: 2,
          absences: [{ source: 'opencode', reason: 'cold-summary-cache', sessions: 2 }]
        })
      })
      restoreFakes()

      // Once the source reads again, both sessions come back unchanged.
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const recovered = await load(sessionLoader)
        expect(sync(usage, recovered)).toMatchObject({ changedSessions: 0, unchangedSessions: 2, removedSessions: 0 })
        expect(ledgerCounts(home, ids)).toEqual(baseline)
      })
    })
  }, 60_000)

  sqliteCliIt('5 a session the DB no longer lists still leaves the ledger at once; its valuation history stays', async () => {
    const home = tempHome('pin5')
    const { dbPath, keptId, flakyId, ids } = openCodePair(home)
    await withUsageLedger(home, async (usage) => {
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const baseline = await warmUp(sessionLoader, usage, home, ids)
        const keptBefore = ledgerCounts(home, [keptId])
        const goneBefore = ledgerCounts(home, [flakyId])
        const db = new Database(dbPath)
        try {
          db.prepare('DELETE FROM session WHERE id = ?').run(flakyId)
        } finally {
          db.close()
        }
        const warm = await load(sessionLoader)
        expect(warm.sessions.map((session) => session.sessionId)).not.toContain(flakyId)
        expect(sync(usage, warm)).toMatchObject({ removedSessions: 1 })
        expect(ledgerCounts(home, [keptId])).toEqual(keptBefore)
        expect(ledgerCounts(home, [flakyId])).toEqual({ sessions: 0, facts: 0, history: goneBefore.history })
        expect(ledgerCounts(home, ids).history).toBe(baseline.history)
      })
    })
  }, 60_000)

  it('10 a cold round keeps a deleted file-backed session; the next warm round removes it, history intact', async () => {
    const home = tempHome('pin10')
    const writeClaudeSession = (sessionId: string): string => writeJsonlAt(
      path.join(home, '.claude', 'projects', '-Users-test-f1f', `${sessionId}.jsonl`),
      [
        rawMsg({
          sessionId, uuid: `${sessionId}-u1`, type: 'user', timestamp: '2026-08-04T00:00:00Z',
          message: { role: 'user', content: `${sessionId} prompt` }
        }),
        rawMsg({
          sessionId, uuid: `${sessionId}-a1`, parentUuid: `${sessionId}-u1`, type: 'assistant',
          requestId: `${sessionId}-request`, timestamp: '2026-08-04T00:00:01Z',
          message: {
            id: `${sessionId}-message`, role: 'assistant', model: 'claude-sonnet-4-5', content: 'answer',
            stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20 }
          }
        })
      ]
    )
    const deletedFile = writeClaudeSession('f1f-deleted')
    writeClaudeSession('f1f-remaining')
    const ids = ['f1f-deleted', 'f1f-remaining']
    await withUsageLedger(home, async (usage) => {
      let baseline!: ReturnType<typeof ledgerCounts>
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        baseline = await warmUp(sessionLoader, usage, home, ids)
      })
      const deletedBefore = ledgerCounts(home, ['f1f-deleted'])

      // The file really is gone, but this round cannot tell: the cache was reset.
      setSummaryCacheVersion(home, 1)
      fs.rmSync(deletedFile)
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const cold = await load(sessionLoader)
        expect(cold.sessions.map((session) => session.sessionId)).toEqual(['f1f-remaining'])
        const result = sync(usage, cold)
        expect(ledgerCounts(home, ids)).toEqual(baseline)
        expect(result).toMatchObject({
          removedSessions: 0,
          retainedSessions: 1,
          absences: [{ source: 'claude-code', reason: 'cold-summary-cache', sessions: 1 }]
        })
      })

      // The next warm round has the evidence: the deletion goes through.
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const warm = await load(sessionLoader)
        expect(sync(usage, warm)).toMatchObject({ removedSessions: 1, retainedSessions: 0, heldRemovals: 0 })
        expect(ledgerCounts(home, ['f1f-deleted']))
          .toEqual({ sessions: 0, facts: 0, history: deletedBefore.history })
        expect(ledgerCounts(home, ['f1f-remaining'])).toMatchObject({ sessions: 1 })
      })
    })
  }, 60_000)

  sqliteCliIt('11 warm cache without the row, read fails: the DB still lists the session, so it stays', async () => {
    const home = tempHome('pin11')
    const { flakyId, flakyRef, ids } = openCodePair(home)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withUsageLedger(home, async (usage) => {
      let baseline!: ReturnType<typeof ledgerCounts>
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        baseline = await warmUp(sessionLoader, usage, home, ids)
      })
      const cache = new Database(summaryCacheDbPath(home))
      try {
        cache.prepare('DELETE FROM summary_cache_entries WHERE file_path = ?').run(flakyRef)
      } finally {
        cache.close()
      }
      install(flakyMessages(flakyId))
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const warm = await load(sessionLoader)
        expect(warm.sessions.map((session) => session.sessionId)).not.toContain(flakyId)
        const result = sync(usage, warm)
        expect(ledgerCounts(home, ids)).toEqual(baseline)
        expect(result).toMatchObject({
          removedSessions: 0,
          retainedSessions: 1,
          absences: [{ source: 'opencode', reason: 'listed-by-source', sessions: 1 }]
        })
      })
    })
  }, 60_000)

  sqliteCliIt('14 an unusable cache but an earlier good discovery in this process: the known refs stay active', async () => {
    const home = tempHome('pin14')
    const ref = createSqliteAgentCacheFixture(home, 'opencode', 'ses_F1fMemory')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withUsageLedger(home, async (usage) => {
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const baseline = await warmUp(sessionLoader, usage, home, ['ses_F1fMemory'])
        expect(readSummaryCacheRow(home, ref)).toBeDefined()

        // The cache cannot list the source's refs (another version); only
        // this process's last successful discovery still knows them.
        setSummaryCacheVersion(home, 1)
        install({ kind: 'fail', stderr: BUSY_STDERR })
        const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
        const loaded = await sessionLoader.loadAllSessionsWithEvidence({})
        expect(loaded.sessions.map((session) => session.sessionId)).not.toContain('ses_F1fMemory')
        // The known ref stays active, sitting this load out with nothing to
        // reuse. F1d (write gate W2): the row itself was written under another
        // version, so the writable load does not carry it into this one.
        expect(incrementalCacheLog(infoSpy)).toContain('parsed 0, reused 0, files 1')
        expect(readSummaryCacheRow(home, ref)).toBeUndefined()
        expect(readSummaryCache(home).version).toBe(SUMMARY_CACHE_VERSION)
        sync(usage, loaded)
        expect(ledgerCounts(home, ['ses_F1fMemory'])).toEqual(baseline)
      })
    })
  }, 60_000)
})

// F1d: CACHE_VERSION bump — write gate W2, retired JSON cache, worker guard, probe
// ========================================================
describe('summary cache version bump: write gate, retired JSON cache, worker guard (F1d)', () => {
  /** An older version: neither this build's, nor 28 (a v28 DB is the one-time migration worker's to judge). */
  const STALE_VERSION = 1
  /** Planted in cache rows as an older build's projection; must never reach a load or survive a write. */
  const STALE = 'F1D-STALE'
  const fakes: FakeSqlite3[] = []
  const homes: string[] = []

  function tempHome(label: string): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1d-${label}-home-`))
    homes.push(home)
    return home
  }

  function install(behavior: Parameters<typeof installFakeSqlite3>[0]): FakeSqlite3 {
    const fake = installFakeSqlite3(behavior)
    fakes.push(fake)
    return fake
  }

  afterEach(() => {
    for (const fake of fakes.splice(0)) fake.restore()
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  /** One file of each file-backed source whose projection F1a-F1c-2 changed. */
  function writeFileSources(home: string): { claude: string; codex: string; cursor: string; ids: string[] } {
    const claude = writeJsonlAt(path.join(home, '.claude', 'projects', '-Users-test-f1d', 'f1d-claude.jsonl'), [
      rawMsg({ sessionId: 'f1d-claude', type: 'user', message: { role: 'user', content: 'Claude source value' } })
    ])
    const cursorId = 'f1d-cursor'
    const cursor = writeJsonlAt(
      path.join(home, '.cursor', 'projects', 'Users-test-f1d', 'agent-transcripts', cursorId, `${cursorId}.jsonl`),
      cursorBackupRows('Cursor source value') as RawJsonlMessage[]
    )
    const codexId = '18400000-0000-4000-8000-00000000f1d0'
    const codex = writeJsonlAt(
      path.join(home, '.codex', 'sessions', '2026', '09', '27', `rollout-2026-09-27T00-00-00-${codexId}.jsonl`),
      codexBackupRows(codexId) as RawJsonlMessage[]
    )
    return { claude, codex, cursor, ids: ['f1d-claude', cursorId, codexId] }
  }

  /** Rewrite every cache row (both JSON columns), optionally under another version, as an older build left it. */
  function rewriteCacheRows(
    home: string,
    rewrite: (filePath: string, perFile: any) => any,
    version?: number
  ): void {
    const database = new Database(summaryCacheDbPath(home))
    try {
      const rows = database.prepare('SELECT file_path, per_file_json FROM summary_cache_entries')
        .all() as Array<{ file_path: string; per_file_json: string }>
      const update = database.prepare(
        'UPDATE summary_cache_entries SET per_file_json = ?, compact_json = ? WHERE file_path = ?'
      )
      database.transaction(() => {
        for (const row of rows) {
          const perFile = rewrite(row.file_path, JSON.parse(row.per_file_json))
          update.run(JSON.stringify(perFile), compactPerFileJson(perFile), row.file_path)
        }
        if (version !== undefined) database.pragma(`user_version = ${version}`)
      })()
    } finally {
      database.close()
    }
  }

  const staleRow = (_filePath: string, perFile: any): any => perFile.summary
    ? { ...perFile, summary: { ...perFile.summary, firstUserMessage: `${STALE} ${perFile.source}` } }
    : perFile

  const staleValuesIn = (value: unknown): number => JSON.stringify(value).split(STALE).length - 1

  function runMigrationWorker(workerData: {
    legacyPath: string
    databasePath: string
    cacheVersion: number
  }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'summary-cache-migration-worker.cjs'), { workerData })
      let reported: unknown
      worker.once('message', (message) => { reported = message })
      worker.once('error', reject)
      worker.once('exit', (code) => code === 0 && reported !== undefined
        ? resolve(reported)
        : reject(new Error(`summary-cache migration worker exited ${code}`)))
    })
  }

  it('① an older-version cache: a focused (lineage) write first neither writes nor claims this version, and the writable load after it shows no stale Codex or Cursor value', async () => {
    const home = tempHome('lineage-first')
    const files = writeFileSources(home)
    await withSessionLoaderModules(home, ({ sessionLoader }) => sessionLoader.loadAllSessions({ quiet: true }))
    const current = readSummaryCache(home).version
    rewriteCacheRows(home, staleRow, STALE_VERSION)
    const planted = readSummaryCache(home)
    expect(staleValuesIn(planted.entries)).toBe(3)

    await withSessionLoaderModules(home, async ({ sessionLoader }) => {
      const lineage = await sessionLoader.loadCachedClaudeLineageMetadata()
      expect(lineage.files.map((file) => file.filePath)).toEqual([files.claude])
      // This focused write owns Claude rows only and cannot prune: on a cache
      // of another version it writes nothing and leaves the version alone.
      expect(readSummaryCache(home)).toEqual(planted)

      const loaded = await sessionLoader.loadAllSessionsWithEvidence({ quiet: true })
      expect(loaded.evidence.summaryCache).toBe('cold')
      expect(loaded.sessions.map((session) => session.sessionId).sort()).toEqual([...files.ids].sort())
      expect(staleValuesIn(loaded.sessions)).toBe(0)
    })
    const rebuilt = readSummaryCache(home)
    expect(rebuilt.version).toBe(current)
    expect(staleValuesIn(rebuilt.entries)).toBe(0)
  }, 30_000)

  sqliteCliIt('② an older-version cache holding an OpenCode `summary: null`: that session\'s cold read fails, and the writable load leaves no `summary: null` in this version', async () => {
    const home = tempHome('opencode-null')
    const sessionId = 'ses_F1dNullRow'
    const ref = createSqliteAgentCacheFixture(home, 'opencode', sessionId)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await withSessionLoaderModules(home, ({ sessionLoader }) => sessionLoader.loadAllSessions({ quiet: true }))
    const current = readSummaryCache(home).version
    // What a build before F1e left for a failed read: `summary: null` under the signature.
    rewriteCacheRows(home, (filePath, perFile) => filePath === ref ? { ...perFile, summary: null } : perFile, STALE_VERSION)
    expect(readSummaryCache(home).entries[ref].perFile.summary).toBeNull()

    install({ kind: 'fail-matching', match: ['FROM "message"', sessionId], stderr: CORRUPT_STDERR })
    await withSessionLoaderModules(home, async ({ sessionLoader }) => {
      const cold = await sessionLoader.loadAllSessionsWithEvidence({ quiet: true })
      expect(cold.evidence.summaryCache).toBe('cold')
      expect(cold.sessions.map((session) => session.sessionId)).not.toContain(sessionId)
    })
    const cache = readSummaryCache(home)
    expect(cache.version).toBe(current)
    expect(Object.values(cache.entries)
      .filter((entry) => entry.perFile.source === 'opencode' && entry.perFile.summary === null)).toEqual([])

    // The next load reads the session again.
    for (const fake of fakes.splice(0)) fake.restore()
    await withSessionLoaderModules(home, async ({ sessionLoader }) => {
      const warm = await sessionLoader.loadAllSessions({ quiet: true })
      expect(warm.map((session) => session.sessionId)).toContain(sessionId)
    })
  }, 60_000)

  it('③ a v27 JSON cache is reused on no path (beside an older-version DB or alone, by the scan or the migration worker); a writable load deletes it, a read-only one keeps it', async () => {
    for (const besideStaleDb of [false, true]) {
      const home = tempHome(besideStaleDb ? 'json-beside-db' : 'json-alone')
      writeFileSources(home)
      await withSessionLoaderModules(home, ({ sessionLoader }) => sessionLoader.loadAllSessions({ quiet: true }))
      const current = readSummaryCache(home).version
      const dbBytes = fs.readFileSync(summaryCacheDbPath(home))
      const legacy = readSummaryCache(home)
      legacy.version = 27
      for (const [filePath, entry] of Object.entries(legacy.entries)) {
        legacy.entries[filePath] = { ...entry, perFile: staleRow(filePath, entry.perFile) }
      }
      const legacyPath = writeLegacySummaryCache(home, legacy)
      if (besideStaleDb) {
        fs.writeFileSync(summaryCacheDbPath(home), dbBytes)
        rewriteCacheRows(home, staleRow, STALE_VERSION)
      }
      const dbBefore = besideStaleDb ? fs.readFileSync(summaryCacheDbPath(home)) : null

      // Read-only, with the desktop's one-time migration first: neither cache is used.
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const readOnly = await sessionLoader.loadAllSessionsWithEvidence({
          readOnly: true,
          migrateLegacyCache: true,
          quiet: true
        })
        expect(readOnly.evidence.summaryCache).toBe('cold')
        expect(readOnly.sessions).toHaveLength(3)
        expect(staleValuesIn(readOnly.sessions)).toBe(0)
      })
      expect(fs.existsSync(legacyPath)).toBe(true)
      if (dbBefore) expect(fs.readFileSync(summaryCacheDbPath(home)).equals(dbBefore)).toBe(true)
      else expect(fs.existsSync(summaryCacheDbPath(home))).toBe(false)

      // The first writable load writes this version and deletes the JSON.
      await withSessionLoaderModules(home, async ({ sessionLoader }) => {
        const writable = await sessionLoader.loadAllSessionsWithEvidence({ quiet: true })
        expect(writable.evidence.summaryCache).toBe('cold')
        expect(staleValuesIn(writable.sessions)).toBe(0)
      })
      expect(fs.existsSync(legacyPath)).toBe(false)
      const rebuilt = readSummaryCache(home)
      expect(rebuilt.version).toBe(current)
      expect(staleValuesIn(rebuilt.entries)).toBe(0)
    }
  }, 60_000)

  it('④ the migration worker leaves a v28 or a v29 cache alone under this version: its 28 -> 29 step is a guard, never "previous -> current"', async () => {
    for (const oldVersion of [28, 29]) {
      const home = tempHome(`worker-v${oldVersion}`)
      writeJsonlAt(path.join(home, '.claude', 'projects', '-Users-test-f1d', 'worker.jsonl'), [
        rawMsg({ sessionId: 'f1d-worker', type: 'user', message: { role: 'user', content: 'worker guard' } })
      ])
      await withSessionLoaderModules(home, ({ sessionLoader }) => sessionLoader.loadAllSessions({ quiet: true }))
      const databasePath = summaryCacheDbPath(home)
      const database = new Database(databasePath)
      try {
        if (oldVersion === 28) database.exec('ALTER TABLE summary_cache_entries DROP COLUMN compact_json')
        database.pragma(`user_version = ${oldVersion}`)
      } finally {
        database.close()
      }
      const before = fs.readFileSync(databasePath)
      await expect(runMigrationWorker({
        legacyPath: path.join(home, '.claude-session-manager', 'summary-cache.json'),
        databasePath,
        cacheVersion: SUMMARY_CACHE_VERSION
      })).resolves.toEqual({ migrated: false })
      expect(fs.readFileSync(databasePath).equals(before)).toBe(true)
    }
  }, 30_000)

  it('probeSummaryCache reports the version and row count read-only, never creating or changing the cache', async () => {
    const home = tempHome('probe')
    writeJsonlAt(path.join(home, '.claude', 'projects', '-Users-test-f1d', 'probe.jsonl'), [
      rawMsg({ sessionId: 'f1d-probe', type: 'user', message: { role: 'user', content: 'probe fixture' } })
    ])
    const databasePath = summaryCacheDbPath(home)
    const legacyPath = path.join(home, '.claude-session-manager', 'summary-cache.json')
    await withSessionLoaderModules(home, async ({ sessionLoader }) => {
      expect(sessionLoader.probeSummaryCache()).toEqual({ state: 'missing', version: null, rows: null, legacyJson: false })
      expect(fs.existsSync(databasePath)).toBe(false)

      await sessionLoader.loadAllSessions({ quiet: true })
      expect(sessionLoader.probeSummaryCache())
        .toEqual({ state: 'current', version: SUMMARY_CACHE_VERSION, rows: 1, legacyJson: false })

      setSummaryCacheVersion(home, STALE_VERSION)
      fs.writeFileSync(legacyPath, '{"version":27,"entries":{}}')
      const before = fs.readFileSync(databasePath)
      expect(sessionLoader.probeSummaryCache())
        .toEqual({ state: 'stale', version: STALE_VERSION, rows: 1, legacyJson: true })
      expect(fs.readFileSync(databasePath).equals(before)).toBe(true)
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe('{"version":27,"entries":{}}')

      fs.writeFileSync(databasePath, 'not-a-sqlite-database')
      expect(sessionLoader.probeSummaryCache())
        .toEqual({ state: 'unreadable', version: null, rows: null, legacyJson: true })
      expect(fs.readFileSync(databasePath, 'utf8')).toBe('not-a-sqlite-database')
    })
  })
})
