import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { CLI_COMMANDS, CLI_VERSION, generateSkillContent } from './command-registry'
import type { CliIo } from './index'

let tempHome = ''
let libraryRoot = ''
let sourcePath = ''
let runCli: typeof import('./index').runCli
let closeSearchIndex: typeof import('../main/search-index').closeSearchIndex
let searchDatabasePath: typeof import('../main/search-index').searchDatabasePath
let closeCanonicalSessionStore: typeof import('../main/canonical-store').closeCanonicalSessionStore
let previousHome: string | undefined
let previousIndexDir: string | undefined

function writeSource(): void {
  const sourceDir = path.join(tempHome, '.claude', 'projects', '-repo-alpha')
  fs.mkdirSync(sourceDir, { recursive: true })
  sourcePath = path.join(sourceDir, 'contract-session.jsonl')
  const longText = `begin-${'x'.repeat(600)}-full-text-tail`
  const rows = [
    {
      uuid: 'u1', parentUuid: null, sessionId: 'contract-session', type: 'user',
      cwd: '/repo/alpha', timestamp: '2026-07-20T00:00:00.000Z',
      message: { role: 'user', content: '请检查 CLI 契约' }
    },
    {
      uuid: 'a1', parentUuid: 'u1', sessionId: 'contract-session', type: 'assistant',
      cwd: '/repo/alpha', timestamp: '2026-07-20T00:01:00.000Z',
      message: { role: 'assistant', model: 'test-model', content: [
        { type: 'thinking', thinking: 'contract-thinking-needle' },
        { type: 'text', text: longText },
        { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/repo/alpha/a.ts', content: 'contract-tool-input-needle' } }
      ], usage: { input_tokens: 10, output_tokens: 20 } }
    },
    {
      uuid: 'u2', parentUuid: 'a1', sessionId: 'contract-session', type: 'user',
      cwd: '/repo/alpha', timestamp: '2026-07-20T00:02:00.000Z',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'contract-tool-result-needle' }] }
    }
  ]
  fs.writeFileSync(sourcePath, rows.map((row) => JSON.stringify(row)).join('\n'))
}

function createLibraryPackage(): string {
  const dir = path.join(libraryRoot, '原始标题')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
    sessionId: 'contract-session',
    sourceFilePaths: [sourcePath],
    customTitle: '原始标题',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:02:00.000Z',
    projectPath: '/repo/alpha'
  }))
  fs.copyFileSync(sourcePath, path.join(dir, 'backup.jsonl'))
  return dir
}

interface Invocation {
  code: number
  stdout: string
  stderr: string
}

async function invoke(args: string[], stdin = ''): Promise<Invocation> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    stdout: (value) => { stdout += value },
    stderr: (value) => { stderr += value },
    readStdin: async () => stdin
  }
  const code = await runCli(args, io, { libraryRoot })
  return { code, stdout, stderr }
}

function parsed(invocation: Invocation): unknown {
  expect(invocation.code).toBe(0)
  return JSON.parse(invocation.stdout)
}

beforeAll(async () => {
  previousHome = process.env.HOME
  previousIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-cli-contract-'))
  libraryRoot = path.join(tempHome, 'Vault')
  process.env.HOME = tempHome
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(tempHome, 'search-index')
  fs.mkdirSync(libraryRoot, { recursive: true })
  writeSource()
  createLibraryPackage()
  ;({ runCli } = await import('./index'))
  ;({ closeSearchIndex, searchDatabasePath } = await import('../main/search-index'))
  ;({ closeCanonicalSessionStore } = await import('../main/canonical-store'))
})

afterAll(() => {
  closeSearchIndex()
  closeCanonicalSessionStore()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = previousIndexDir
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe.sequential('Swob CLI machine contract', () => {
  it('--help/--version 的 JSON 只写 stdout，版本与 package.json 一致', async () => {
    const version = await invoke(['--version', '--json'])
    expect(parsed(version)).toEqual({ name: 'swob', version: CLI_VERSION })
    expect(version.stderr).toBe('')
    expect(CLI_VERSION).toBe(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8')).version)

    const help = await invoke(['--help', '--json'])
    expect(parsed(help)).toMatchObject({ name: 'swob', version: CLI_VERSION, exitCodes: [{ code: 0 }, { code: 1 }, { code: 2 }, { code: 3 }] })
    expect(help.stderr).toBe('')
  })

  it('read-only JSON commands all emit parseable JSON with stable top-level fields', async () => {
    const cases: Array<{ args: string[]; assert: (value: any) => void }> = [
      { args: ['search', 'CLI', '--json'], assert: (value) => expect(Array.isArray(value)).toBe(true) },
      { args: ['list', '--json'], assert: (value) => expect(value[0]).toMatchObject({ sessionId: 'contract-session', tokenMetric: 'input_plus_output' }) },
      { args: ['folders', '--json'], assert: (value) => expect(Array.isArray(value)).toBe(true) },
      { args: ['insights', '--json'], assert: (value) => expect(value.totalTokensMetric).toBe('input_plus_output') },
      { args: ['config', 'get', '--json'], assert: (value) => expect(value).toHaveProperty('libraryRoot', libraryRoot) },
      { args: ['active', '--json'], assert: (value) => expect(value).toHaveProperty('activeSessionIds') },
      { args: ['lineage', '--dry-run', '--json'], assert: (value) => expect(value).toHaveProperty('aliases') },
      { args: ['resume-audit', '--json'], assert: (value) => expect(typeof value).toBe('object') },
      { args: ['transcript', 'rebuild', '--all', '--dry-run', '--json'], assert: (value) => expect(typeof value).toBe('object') },
      { args: ['redact', '--dry-run', '--json'], assert: (value) => expect(value).toMatchObject({ files: expect.any(Number), hits: expect.any(Number) }) }
    ]
    for (const contract of cases) {
      const invocation = await invoke(contract.args)
      const value = parsed(invocation)
      contract.assert(value)
    }
  })

  it('show 默认保持截断；--full 保留全文、thinking、工具参数和结果', async () => {
    const compact = parsed(await invoke(['show', 'contract-session', '--json'])) as any
    const compactAssistant = compact.messages.find((message: any) => message.uuid === 'a1')
    expect(compactAssistant.text.length).toBe(500)
    expect(compactAssistant.toolCalls).toEqual(['Write'])

    const full = parsed(await invoke(['show', 'contract-session', '--full', '--json'])) as any
    const assistant = full.messages.find((message: any) => message.uuid === 'a1')
    expect(assistant.text).toContain('full-text-tail')
    expect(assistant.thinking).toEqual(['contract-thinking-needle'])
    expect(assistant.toolCalls[0]).toMatchObject({
      name: 'Write',
      input: { file_path: '/repo/alpha/a.ts', content: 'contract-tool-input-needle' },
      result: 'contract-tool-result-needle'
    })

    const jsonl = await invoke(['show', 'contract-session', '--full', '--format=jsonl'])
    expect(jsonl.code).toBe(0)
    const events = jsonl.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(events[0]).toMatchObject({ event: 'session', sessionId: 'contract-session' })
    expect(events.filter((event) => event.event === 'message')).toHaveLength(3)
  })

  it('grep 返回完整 transcript、过滤字段与命中上下文', async () => {
    const result = parsed(await invoke([
      'grep', 'contract-tool-input-needle', '--source', 'claude-code', '--project', 'alpha',
      '--after', '2026-07-20', '--before', '2026-07-20', '--json'
    ])) as any
    expect(result).toMatchObject({ query: 'contract-tool-input-needle', sessionCount: 1, matchCount: 1 })
    expect(result.sessions[0].matches[0].context).toHaveLength(3)
    expect(result.sessions[0].matches[0].text).toContain('contract-tool-input-needle')

    const codexDir = path.join(tempHome, '.codex', 'sessions', '2026', '07', '20')
    fs.mkdirSync(codexDir, { recursive: true })
    const codexPath = path.join(codexDir, 'rollout-2026-07-20T00-00-00-019d2f83-912b-7933-8860-00156f6f333e.jsonl')
    fs.writeFileSync(codexPath, [
      { timestamp: '2026-07-20T00:00:00Z', type: 'session_meta', payload: { id: '019d2f83-912b-7933-8860-00156f6f333e', timestamp: '2026-07-20T00:00:00Z', cwd: '/repo/codex-project', cli_version: 'test' } },
      { timestamp: '2026-07-20T00:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex-source-needle' }] } }
    ].map((row) => JSON.stringify(row)).join('\n'))
    const codex = parsed(await invoke(['grep', 'codex-source-needle', '--source', 'codex', '--json'])) as any
    expect(codex).toMatchObject({ sessionCount: 1, sessions: [{ source: 'codex', projectPath: '/repo/codex-project' }] })

    const piPath = path.join(tempHome, '.pi', 'agent', 'sessions', 'contract', 'session.jsonl')
    fs.mkdirSync(path.dirname(piPath), { recursive: true })
    fs.copyFileSync(path.resolve(__dirname, '../../testdata/pi/session.jsonl'), piPath)
    const pi = parsed(await invoke([
      'grep', 'synthetic-search-needle', '--source', 'pi', '--json'
    ])) as any
    expect(pi).toMatchObject({
      sessionCount: 1,
      sessions: [{ source: 'pi' }]
    })
  })

  it('grep 遇写锁会等待并返回可重试的结构化错误', async () => {
    closeSearchIndex()
    const blocker = new Database(searchDatabasePath())
    blocker.pragma('journal_mode = DELETE')
    blocker.exec('BEGIN EXCLUSIVE')
    const startedAt = performance.now()
    try {
      const invocation = await invoke(['grep', 'contract-tool-input-needle', '--json'])
      const elapsedMs = performance.now() - startedAt
      expect(invocation.code).toBe(1)
      expect(invocation.stdout).toBe('')
      expect(JSON.parse(invocation.stderr)).toEqual({
        error: {
          message: '搜索索引暂时被占用',
          code: 'SEARCH_INDEX_BUSY',
          hint: 'GUI 正在建索引，稍后再试',
          retryable: true
        }
      })
      expect(elapsedMs).toBeGreaterThanOrEqual(2_500)
      // SQLite owns the 3s busy timeout. A loaded CI runner can deschedule this
      // process after SQLite returns, so the upper bound is a deadlock guard,
      // not a second assertion about scheduler latency.
      expect(elapsedMs).toBeLessThan(9_000)
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  }, 12_000)

  it('批量 move/rename 是单事务，undo 可完整恢复', async () => {
    parsed(await invoke(['folder', 'create', '目标', '--json']))
    const moved = parsed(await invoke(['move', '--stdin', '--json'], JSON.stringify([
      { sessionId: 'contract-session', folderId: '目标' }
    ]))) as any
    expect(moved).toMatchObject({ success: true, count: 1, moved: 1 })
    expect(moved.operationId).toEqual(expect.any(String))
    expect(fs.existsSync(path.join(libraryRoot, '目标', '原始标题'))).toBe(true)
    const folderFiltered = parsed(await invoke([
      'grep', 'contract-tool-input-needle', '--folder', '目标', '--json'
    ])) as any
    expect(folderFiltered.sessionCount).toBe(1)
    parsed(await invoke(['undo', '--json']))
    expect(fs.existsSync(path.join(libraryRoot, '原始标题'))).toBe(true)

    const renamed = parsed(await invoke(['rename', '--stdin', '--json'], [
      JSON.stringify({ sessionId: 'contract-session', title: '新标题' })
    ].join('\n'))) as any
    expect(renamed).toMatchObject({ success: true, count: 1, renamed: 1 })
    expect(fs.existsSync(path.join(libraryRoot, '新标题'))).toBe(true)
    parsed(await invoke(['undo', '--json']))
    expect(fs.existsSync(path.join(libraryRoot, '原始标题'))).toBe(true)
    const restoredMeta = JSON.parse(fs.readFileSync(path.join(libraryRoot, '原始标题', '.swob-session.json'), 'utf-8'))
    expect(restoredMeta.customTitle).toBe('原始标题')
  })

  it('批量输入先全量校验；无效 ID 返回 3 且不产生部分移动', async () => {
    const invocation = await invoke(['move', '--stdin', '--json'], [
      JSON.stringify({ sessionId: 'contract-session', folderId: '目标' }),
      JSON.stringify({ sessionId: 'missing-session', folderId: '目标' })
    ].join('\n'))
    expect(invocation.code).toBe(3)
    expect(JSON.parse(invocation.stderr)).toHaveProperty('error')
    expect(invocation.stdout).toBe('')
    expect(fs.existsSync(path.join(libraryRoot, '原始标题'))).toBe(true)

    expect((await invoke(['move', 'missing-session', '目标', '--json'])).code).toBe(3)
    expect((await invoke(['rename', 'missing-session', '标题', '--json'])).code).toBe(3)
  })

  it('resolve 用 2 表示歧义、3 表示不存在，JSON 仍可解析', async () => {
    fs.writeFileSync(path.join(libraryRoot, '.session-lineage.json'), JSON.stringify({
      version: 1,
      generatedAt: '2026-07-22T00:00:00.000Z',
      aliases: { 'ambiguous-one': 'latest-one', 'ambiguous-two': 'latest-two' }
    }))
    const ambiguous = await invoke(['resolve', 'ambiguous', '--json'])
    expect(ambiguous.code).toBe(2)
    expect(JSON.parse(ambiguous.stdout)).toMatchObject({ matched: false, ambiguous: true })

    const missing = await invoke(['resolve', 'definitely-missing', '--json'])
    expect(missing.code).toBe(3)
    expect(JSON.parse(missing.stdout)).toMatchObject({ matched: false, ambiguous: false })
  })

  it('Skill 完全由命令注册表生成并覆盖每个命令定义', () => {
    const skill = generateSkillContent()
    for (const command of CLI_COMMANDS) expect(skill).toContain(`swob ${command.usage}`)
    expect(skill).toContain('input_plus_output')
    expect(skill).toContain('退出码')
  })
})
