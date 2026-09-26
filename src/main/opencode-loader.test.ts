import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import {
  buildOpencodeSessionDetail,
  buildOpencodeSessionSummary,
  discoverSqliteAgentSessions,
  findOpencodeSessionFiles,
  getSqliteAgentSourceStatus,
  loadOpencodeRawMessages,
  makeOpencodeSessionRef,
  recordSqliteAgentLoad
} from './opencode-loader'
import { loadSessionDetail } from './session-loader'
import {
  installFakeSqlite3,
  realSqlite3Path,
  type FakeSqlite3,
  type FakeSqlite3Behavior
} from './__test-support__/fake-sqlite3'

const SESSION_ID = 'ses_Abc123'

function sqlite3Available(): boolean {
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const fixtureIt = sqlite3Available() ? it : it.skip

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function createOpencodeDb(
  options: { sessionMessageTable?: boolean } = {}
): { dir: string; dbPath: string; sourceRef: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-opencode-test-'))
  const dbPath = path.join(dir, '.local', 'share', 'opencode', 'opencode.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  const userData = JSON.stringify({
    role: 'user',
    time: { created: '2026-07-08T10:00:00Z' },
    path: { cwd: '/Users/test/projects/opencode-app' },
    model: 'glm-4.5'
  })
  const assistantData = JSON.stringify({
    role: 'assistant',
    parentID: 'msg_user',
    time: { created: '2026-07-08T10:00:05Z' },
    tokens: { input: 11, output: 7, reasoning: 2, cache: { read: 3, write: 4 }, total: 27 },
    providerID: 'openai',
    modelID: 'gpt-5.1'
  })
  const sessionTokens = JSON.stringify({ input: 100, output: 50 })
  const userText = JSON.stringify({ text: '请读取 src/index.ts' })
  const assistantText = JSON.stringify({ text: '我来读取文件。' })
  const toolData = JSON.stringify({ id: 'tool_read_1', name: 'read', input: { file_path: '/Users/test/projects/opencode-app/src/index.ts' } })
  const ignoredStep = JSON.stringify({ text: 'hidden step marker' })
  const ignoredReasoning = JSON.stringify({ text: 'hidden reasoning' })

  const sql = `
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      slug TEXT,
      directory TEXT,
      title TEXT,
      model TEXT,
      tokens TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      sessionID TEXT,
      data TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      sessionID TEXT,
      messageID TEXT,
      type TEXT,
      idx INTEGER,
      data TEXT
    );
    ${options.sessionMessageTable === false ? '' : `CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      sessionID TEXT,
      messageID TEXT,
      type TEXT
    );`}
    CREATE TABLE account (id TEXT, data TEXT);
    CREATE TABLE credential (id TEXT, data TEXT);

    INSERT INTO session VALUES (
      ${sqlString(SESSION_ID)},
      'opencode-slug',
      '/Users/test/projects/opencode-app',
      'Opencode title',
      'glm-4.5',
      ${sqlString(sessionTokens)}
    );
    INSERT INTO message VALUES (
      'msg_user',
      ${sqlString(SESSION_ID)},
      ${sqlString(userData)},
      1783504800
    );
    INSERT INTO message VALUES (
      'msg_assistant',
      ${sqlString(SESSION_ID)},
      ${sqlString(assistantData)},
      1783504805
    );
    INSERT INTO part VALUES ('part_user_text', ${sqlString(SESSION_ID)}, 'msg_user', 'text', 0, ${sqlString(userText)});
    INSERT INTO part VALUES ('part_assistant_text', ${sqlString(SESSION_ID)}, 'msg_assistant', 'text', 0, ${sqlString(assistantText)});
    INSERT INTO part VALUES ('part_tool', ${sqlString(SESSION_ID)}, 'msg_assistant', 'tool', 1, ${sqlString(toolData)});
    INSERT INTO part VALUES ('part_step', ${sqlString(SESSION_ID)}, 'msg_assistant', 'step-start', 2, ${sqlString(ignoredStep)});
    INSERT INTO part VALUES ('part_reasoning', ${sqlString(SESSION_ID)}, 'msg_assistant', 'reasoning', 3, ${sqlString(ignoredReasoning)});
    ${options.sessionMessageTable === false ? '' : `INSERT INTO session_message VALUES ('switch_1', ${sqlString(SESSION_ID)}, 'msg_assistant', 'agent-switched');`}
  `

  execFileSync('sqlite3', [dbPath], { input: sql })
  return { dir, dbPath, sourceRef: makeOpencodeSessionRef(SESSION_ID, dbPath) }
}

describe('opencode-loader', () => {
  fixtureIt('【opencode】summary/detail/raw 保留 reasoning，但过滤 step marker', async () => {
    const fixture = createOpencodeDb()
    try {
      const refs = await findOpencodeSessionFiles(fixture.dbPath)
      expect(refs).toEqual([fixture.sourceRef])

      const raw = await loadOpencodeRawMessages(fixture.sourceRef)
      expect(raw).toHaveLength(2)
      expect(raw[0].uuid).toBe('msg_user')
      expect(raw[1].parentUuid).toBe('msg_user')
      expect(JSON.stringify(raw)).not.toContain('hidden step marker')
      expect(JSON.stringify(raw)).toContain('hidden reasoning')

      const summary = await buildOpencodeSessionSummary(fixture.sourceRef)
      expect(summary?.activityDays).toEqual(['2026-07-08'])
      expect(summary).not.toBeNull()
      expect(summary!.source).toBe('opencode')
      expect(summary!.id).toBe(`opencode:${SESSION_ID}`)
      expect(summary!.sessionId).toBe(SESSION_ID)
      expect(summary!.firstUserMessage).toBe('请读取 src/index.ts')
      expect(summary!.resumeCwd).toBe('/Users/test/projects/opencode-app')
      expect(summary!.toolUsage).toEqual({ Read: 1 })
      expect(summary!.tokenUsage.inputTokens).toBe(11)
      expect(summary!.tokenUsage.outputTokens).toBe(9)
      expect(summary!.tokenUsage.cacheReadTokens).toBe(3)
      expect(summary!.tokenUsage.cacheCreationTokens).toBe(4)
      expect(summary!.tokenAccounting?.usageEvents).toEqual([
        expect.objectContaining({
          dedupKey: 'opencode:message:msg_assistant',
          billingFactKey: 'opencode:message:msg_assistant',
          timestamp: '2026-07-08T10:00:05.000Z',
          providerRaw: 'openai',
          billingProvider: 'openai',
          modelRaw: 'gpt-5.1',
          rawOutputTokens: 7,
          rawReasoningTokens: 2,
          fieldRelations: {
            cacheRead: 'disjoint',
            cacheWrite: 'disjoint',
            reasoning: 'disjoint-from-visible-output'
          }
        })
      ])

      const detail = await buildOpencodeSessionDetail(fixture.sourceRef)
      expect(detail).not.toBeNull()
      expect(detail!.messages).toHaveLength(2)
      expect(detail!.messages[1].textContent).toBe('我来读取文件。')
      expect((detail!.messages[1].raw.message?.content as any[]))
        .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'reasoning', text: 'hidden reasoning' })]))
      expect(detail!.messages[1].toolCalls[0]).toMatchObject({
        id: 'tool_read_1',
        name: 'Read',
        input: { file_path: '/Users/test/projects/opencode-app/src/index.ts' }
      })
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  fixtureIt('【opencode】loadSessionDetail source-aware 分派到 opencode loader', async () => {
    const fixture = createOpencodeDb()
    try {
      const detail = await loadSessionDetail(fixture.sourceRef)

      expect(detail).not.toBeNull()
      expect(detail!.source).toBe('opencode')
      expect(detail!.sessionId).toBe(SESSION_ID)
      expect(detail!.messages[0].textContent).toBe('请读取 src/index.ts')
      expect(detail!.messages.some((message) => message.textContent.includes('[Reasoning]'))).toBe(true)
    } finally {
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  fixtureIt('【opencode】解析只读 snapshot，不修改源 DB 或留下临时 sidecar', async () => {
    const fixture = createOpencodeDb()
    const writer = new Database(fixture.dbPath)
    try {
      writer.pragma('journal_mode = WAL')
      writer.pragma('wal_autocheckpoint = 0')
      writer.prepare('UPDATE part SET data = ? WHERE id = ?').run(
        JSON.stringify({ text: 'reasoning committed only in WAL' }),
        'part_reasoning'
      )
      expect(fs.existsSync(`${fixture.dbPath}-wal`)).toBe(true)
      const beforeHash = (filePath: string) =>
        createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
      const beforeDbHash = beforeHash(fixture.dbPath)
      const beforeWalHash = beforeHash(`${fixture.dbPath}-wal`)
      const beforeFiles = fs.readdirSync(path.dirname(fixture.dbPath)).sort()
      const detail = await buildOpencodeSessionDetail(fixture.sourceRef)

      expect(JSON.stringify(detail?.messages)).toContain('reasoning committed only in WAL')
      expect(beforeHash(fixture.dbPath)).toBe(beforeDbHash)
      expect(beforeHash(`${fixture.dbPath}-wal`)).toBe(beforeWalHash)
      expect(fs.readdirSync(path.dirname(fixture.dbPath)).sort()).toEqual(beforeFiles)
    } finally {
      writer.close()
      fs.rmSync(fixture.dir, { recursive: true, force: true })
    }
  })

  it('【opencode】非法 sessionId 被拒绝且不崩溃', async () => {
    const raw = await loadOpencodeRawMessages('/tmp/.local/share/opencode/opencode.db#ses_bad-drop')
    const summary = await buildOpencodeSessionSummary('/tmp/.local/share/opencode/opencode.db#ses_bad;drop')

    expect(raw).toEqual([])
    expect(summary).toBeNull()
  })
})

// F1e: sqlite3 CLI failures must be explicit, never an empty success. The fake
// sqlite3 is found through PATH because the loader spawns the bare name.
const cliIt = process.platform !== 'win32' && realSqlite3Path() ? it : it.skip
const BUSY_STDERR = 'Parse error near line 2: database is locked (5)'

describe('opencode-loader sqlite3 CLI failures (F1e)', () => {
  const fakes: FakeSqlite3[] = []
  const fixtureDirs: string[] = []
  let warn: MockInstance<typeof console.warn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  function fixture(options?: { sessionMessageTable?: boolean }) {
    const created = createOpencodeDb(options)
    fixtureDirs.push(created.dir)
    return created
  }

  function install(behavior: FakeSqlite3Behavior): FakeSqlite3 {
    const fake = installFakeSqlite3(behavior)
    fakes.push(fake)
    return fake
  }

  afterEach(() => {
    warn.mockRestore()
    for (const fake of fakes.splice(0)) fake.restore()
    for (const dir of fixtureDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    delete process.env.SWOB_SQLITE_CLI_TIMEOUT_MS
  })

  cliIt('1 hung sqlite3: wall-clock timeout is unavailable/timeout with no in-statement retry', async () => {
    const db = fixture()
    process.env.SWOB_SQLITE_CLI_TIMEOUT_MS = '200'
    const fake = install({ kind: 'hang' })

    const started = Date.now()
    const discovery = await discoverSqliteAgentSessions('opencode', db.dbPath)

    expect(discovery).toMatchObject({ state: 'unavailable', reason: 'timeout', attempts: 1, refs: [] })
    expect(getSqliteAgentSourceStatus('opencode'))
      .toMatchObject({ state: 'unavailable', reason: 'timeout', attempts: 1 })
    expect(fake.invocations()).toBeLessThanOrEqual(5)
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 20_000)

  cliIt('2 busy once: one backoff retry, then the whole source is read', async () => {
    const db = fixture()
    const fake = install({ kind: 'fail', stderr: BUSY_STDERR, failures: 1 })

    const discovery = await discoverSqliteAgentSessions('opencode', db.dbPath)

    expect(discovery).toMatchObject({ state: 'ok', reason: null, attempts: 2, refs: [db.sourceRef] })
    expect(getSqliteAgentSourceStatus('opencode')).toMatchObject({ state: 'ok', reason: null, attempts: 2 })
    // Five schema probes, one retry of the probe that hit the lock, one SELECT.
    expect(fake.invocations()).toBe(7)
  }, 20_000)

  cliIt('3 other non-zero exits: cannot-open retries once; corrupt and generic errors do not', async () => {
    const db = fixture()
    const cannotOpen = install({ kind: 'fail', stderr: 'Error: unable to open database "x": unable to open database file' })
    expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
      .toMatchObject({ state: 'unavailable', reason: 'cannot-open', attempts: 2, refs: [] })
    expect(cannotOpen.invocations()).toBe(10)
    cannotOpen.restore()

    for (const stderr of [
      'Parse error near line 2: file is not a database (26)',
      'Runtime error near line 2: database disk image is malformed (11)'
    ]) {
      const corrupt = install({ kind: 'fail', stderr })
      expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
        .toMatchObject({ state: 'unavailable', reason: 'corrupt', attempts: 1, refs: [] })
      expect(corrupt.invocations()).toBe(5)
      corrupt.restore()
    }

    install({ kind: 'fail', stderr: 'Parse error near line 2: no such function: nope' })
    expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
      .toMatchObject({ state: 'unavailable', reason: 'sqlite-error', attempts: 1, refs: [] })
  }, 20_000)

  cliIt('4 garbage on stdout with exit 0 is unparseable-output, not an empty result', async () => {
    const db = fixture()
    install({ kind: 'stdout', stdout: 'not-json' })

    expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
      .toMatchObject({ state: 'unavailable', reason: 'unparseable-output', attempts: 1, refs: [] })
  })

  cliIt('5 no sqlite3 on PATH is sqlite3-missing, without a retry', async () => {
    const db = fixture()
    install({ kind: 'missing' })

    expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
      .toMatchObject({ state: 'unavailable', reason: 'sqlite3-missing', attempts: 1, refs: [] })
    expect(await findOpencodeSessionFiles(db.dbPath)).toEqual([])
    // The never-throw public discovery still records the failure.
    expect(getSqliteAgentSourceStatus('opencode'))
      .toMatchObject({ state: 'unavailable', reason: 'sqlite3-missing', attempts: 1 })
  })

  cliIt('6 absent optional tables are a legitimate empty result, not a failure', async () => {
    const db = fixture({ sessionMessageTable: false })

    expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
      .toMatchObject({ state: 'ok', reason: null, attempts: 1, refs: [db.sourceRef] })
    const summary = await buildOpencodeSessionSummary(db.sourceRef)
    expect(summary?.firstUserMessage).toBe('请读取 src/index.ts')
    expect(summary?.providerOutcome).toEqual({ detected: 'detected', parse: 'parsed', usage: 'available' })
  })

  cliIt('7 a failed discovery does not stick: the same module reads every session next time', async () => {
    const db = fixture()
    install({ kind: 'missing' })
    expect(await findOpencodeSessionFiles(db.dbPath)).toEqual([])
    for (const fake of fakes.splice(0)) fake.restore()
    expect(getSqliteAgentSourceStatus('opencode')).toMatchObject({ state: 'unavailable', reason: 'sqlite3-missing' })

    // Regression pin: the failed schema probe used to be cached for the whole
    // process, so this second discovery stayed at zero sessions.
    expect(await findOpencodeSessionFiles(db.dbPath)).toEqual([db.sourceRef])
    expect(await discoverSqliteAgentSessions('opencode', db.dbPath))
      .toMatchObject({ state: 'ok', reason: null, refs: [db.sourceRef] })
    expect(getSqliteAgentSourceStatus('opencode'))
      .toMatchObject({ state: 'ok', reason: null, lastSuccessAt: expect.any(String) })
  })

  cliIt('8 a writer lock is waited out, not reported as an empty source', async () => {
    const db = fixture()
    // DELETE journal mode (the fixture default): EXCLUSIVE blocks readers. The
    // hold outlasts the longest retry backoff, so only the busy timeout helps.
    const holder = new Database(db.dbPath)
    holder.exec('BEGIN EXCLUSIVE')
    const released = new Promise<void>((resolve) => setTimeout(() => {
      holder.exec('COMMIT')
      holder.close()
      resolve()
    }, 1_200))
    try {
      // Regression pin: without a busy timeout this returned [] at once.
      expect(await findOpencodeSessionFiles(db.dbPath)).toEqual([db.sourceRef])
      // The CLI busy timeout absorbed the wait: no statement needed a retry.
      expect(getSqliteAgentSourceStatus('opencode')).toMatchObject({ state: 'ok', reason: null, attempts: 1 })
    } finally {
      await released
    }
  }, 20_000)

  cliIt('source status moves through absent / unavailable / partial / ok and warns once per change without paths or stderr', async () => {
    const db = fixture()
    await discoverSqliteAgentSessions('opencode', path.join(db.dir, 'not-installed.db'))
    expect(getSqliteAgentSourceStatus('opencode'))
      .toMatchObject({ state: 'absent', reason: null, attempts: 0, sessionsRead: 0 })

    install({ kind: 'fail', stderr: 'Parse error near line 2: file is not a database (26)' })
    await discoverSqliteAgentSessions('opencode', db.dbPath)
    await discoverSqliteAgentSessions('opencode', db.dbPath)
    recordSqliteAgentLoad('opencode', { sessionsRead: 0, sessionsFailed: 0, sessionsCarriedOver: 3, reason: null })
    expect(getSqliteAgentSourceStatus('opencode'))
      .toMatchObject({ state: 'unavailable', reason: 'corrupt', sessionsCarriedOver: 3 })
    for (const fake of fakes.splice(0)) fake.restore()

    await discoverSqliteAgentSessions('opencode', db.dbPath)
    recordSqliteAgentLoad('opencode', { sessionsRead: 4, sessionsFailed: 1, sessionsCarriedOver: 1, reason: 'busy' })
    const partial = getSqliteAgentSourceStatus('opencode')
    expect(partial).toMatchObject({
      state: 'partial', reason: 'busy', attempts: 1, sessionsRead: 4, sessionsFailed: 1, sessionsCarriedOver: 1
    })
    expect(partial?.lastSuccessAt).toEqual(expect.any(String))

    await discoverSqliteAgentSessions('opencode', db.dbPath)
    recordSqliteAgentLoad('opencode', { sessionsRead: 5, sessionsFailed: 0, sessionsCarriedOver: 0, reason: null })
    expect(getSqliteAgentSourceStatus('opencode'))
      .toMatchObject({ state: 'ok', reason: null, sessionsRead: 5, sessionsFailed: 0 })

    const warnings = warn.mock.calls.map((args) => args.join(' '))
    expect(warnings).toEqual([
      '[sqlite-agent] opencode: discovery unavailable (corrupt, attempts 1)',
      '[sqlite-agent] opencode: 1 session read(s) failed (busy); 1 carried over'
    ])
    const surfaced = JSON.stringify([warnings, partial, getSqliteAgentSourceStatus('opencode')])
    for (const secret of [db.dir, db.dbPath, SESSION_ID, 'file is not a database', 'Parse error']) {
      expect(surfaced).not.toContain(secret)
    }
  })

  cliIt('a timer made late by a blocked event loop gets one grace window instead of a false timeout', async () => {
    const db = fixture()
    process.env.SWOB_SQLITE_CLI_TIMEOUT_MS = '200'

    // The schema probes are spawned synchronously inside this call; the busy
    // loop then keeps their 'close' events queued behind the expired timers.
    const pending = discoverSqliteAgentSessions('opencode', db.dbPath)
    const blockUntil = Date.now() + 600
    while (Date.now() < blockUntil) { /* synchronous work on the same event loop */ }

    expect(await pending).toMatchObject({ state: 'ok', reason: null, refs: [db.sourceRef] })
  }, 20_000)

  cliIt('a failed parts query fails the whole session instead of yielding a partial transcript', async () => {
    const db = fixture()
    install({
      kind: 'fail-matching',
      match: ['FROM "part"'],
      stderr: 'Runtime error near line 2: database disk image is malformed (11)'
    })

    const summaryError = await buildOpencodeSessionSummary(db.sourceRef).then(() => null, (error: unknown) => error)
    expect(summaryError).toMatchObject({ name: 'SqliteAgentReadError', code: 'corrupt', attempts: 1 })
    expect(String(summaryError)).not.toContain(db.dir)
    expect(String(summaryError)).not.toContain('malformed')
    await expect(loadOpencodeRawMessages(db.sourceRef)).rejects.toMatchObject({ code: 'corrupt' })
    await expect(buildOpencodeSessionDetail(db.sourceRef)).resolves.toBeNull()
  })
})
