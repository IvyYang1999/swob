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

function parsedError(invocation: Invocation): any {
  const lines = invocation.stderr.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function libraryFileEvidence(root: string): Array<{ name: string; size: number; mtimeMs: number; bytes: string }> {
  const result: Array<{ name: string; size: number; mtimeMs: number; bytes: string }> = []
  const visit = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) visit(filePath)
      else if (entry.isFile()) {
        const stat = fs.statSync(filePath)
        result.push({
          name: path.relative(root, filePath),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          bytes: fs.readFileSync(filePath).toString('base64')
        })
      }
    }
  }
  visit(root)
  return result
}

function createControlPackage(
  title: string,
  sessionId: string,
  sourceFilePaths: string[] = [sourcePath]
): string {
  const dirPath = path.join(libraryRoot, title)
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify({
    sessionId,
    sourceFilePaths,
    customTitle: title,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:02:00.000Z',
    projectPath: '/repo/alpha'
  }))
  return dirPath
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
      { args: ['where', 'contract-session', '--json'], assert: (value) => expect(value).toHaveProperty('packagePath') },
      { args: ['transcript', 'status', 'contract-session', '--json'], assert: (value) => expect(value).toHaveProperty('manifestUpdatedAt') },
      { args: ['transcript', 'rebuild', 'contract-session', '--dry-run', '--json'], assert: (value) => expect(value).toMatchObject({ sessionId: 'contract-session', dryRun: true }) },
      { args: ['transcript', 'rebuild', '--all', '--dry-run', '--json'], assert: (value) => expect(typeof value).toBe('object') },
      { args: ['doctor', 'locks', '--json'], assert: (value) => expect(value).toHaveProperty('state') },
      { args: ['doctor', 'library', '--json'], assert: (value) => expect(value).toHaveProperty('staleCount') },
      { args: ['redact', '--dry-run', '--json'], assert: (value) => expect(value).toMatchObject({ files: expect.any(Number), hits: expect.any(Number) }) }
    ]
    for (const contract of cases) {
      const invocation = await invoke(contract.args)
      const value = parsed(invocation)
      contract.assert(value)
    }
  })

  it('doctor locks/library 对 Library 与 machine identity 零写', async () => {
    const machineDir = path.join(tempHome, '.swob-machine')
    const before = libraryFileEvidence(libraryRoot)

    expect((await invoke(['doctor', 'locks', '--json'])).code).toBe(0)
    expect((await invoke(['doctor', 'library', '--json'])).code).toBe(0)

    expect(libraryFileEvidence(libraryRoot)).toEqual(before)
    expect(fs.existsSync(machineDir)).toBe(false)
  })

  it('事故验收 1/2: manifest-only 完整 UUID 与唯一前缀可解析，lineage 损坏不否决', async () => {
    const sessionId = '94000000-0000-4000-8000-000000000193'
    const dirPath = createControlPackage('Manifest Only', sessionId)
    const lineagePath = path.join(libraryRoot, '.session-lineage.json')
    fs.writeFileSync(lineagePath, '{broken-json')
    try {
      const startedAt = performance.now()
      const exact = parsed(await invoke(['resolve', sessionId, '--json'])) as any
      expect(performance.now() - startedAt).toBeLessThan(1_000)
      expect(exact).toMatchObject({ matched: true, resolved: sessionId, errorCode: null })
      expect(parsed(await invoke(['where', sessionId, '--json']))).toMatchObject({
        input: sessionId,
        resolved: exact.resolved,
        sessionId: exact.resolved
      })

      const prefix = parsed(await invoke(['resolve', sessionId.slice(0, 12), '--json'])) as any
      expect(prefix).toMatchObject({ matched: true, resolved: sessionId })

      fs.writeFileSync(lineagePath, JSON.stringify({
        version: 1,
        generatedAt: '2026-08-02T00:00:00.000Z',
        aliases: { 'legacy-manifest-only': sessionId }
      }))
      const alias = parsed(await invoke(['resolve', 'legacy-manifest-only', '--json'])) as any
      const aliasWhere = parsed(await invoke(['where', 'legacy-manifest-only', '--json'])) as any
      expect(alias).toMatchObject({ matched: true, resolved: sessionId })
      expect(aliasWhere).toMatchObject({ resolved: alias.resolved, sessionId: alias.resolved })
    } finally {
      fs.rmSync(dirPath, { recursive: true, force: true })
      fs.rmSync(lineagePath, { force: true })
    }
  })

  it('事故验收 3: where/status 返回路径与四时间戳，并直接暴露 stale', async () => {
    const packagePath = path.join(libraryRoot, '原始标题')
    const manifestPath = path.join(packagePath, '.swob-session.json')
    const transcriptPath = path.join(packagePath, 'transcript.md')
    const backupPath = path.join(packagePath, 'backup.jsonl')
    fs.writeFileSync(transcriptPath, '# stale transcript')
    const old = new Date(Date.now() - 5 * 60_000)
    const fresh = new Date()
    fs.utimesSync(transcriptPath, old, old)
    fs.utimesSync(backupPath, old, old)
    fs.utimesSync(manifestPath, old, old)
    fs.utimesSync(sourcePath, fresh, fresh)

    const located = parsed(await invoke(['where', 'contract-sess', '--json'])) as any
    expect(located).toMatchObject({
      sessionId: 'contract-session',
      packagePath,
      manifest: { path: manifestPath, exists: true },
      transcript: { path: transcriptPath, exists: true },
      backup: { path: backupPath, exists: true },
      sources: [{ path: sourcePath, exists: true }],
      freshness: { stale: true }
    })
    const statusResult = parsed(await invoke(['transcript', 'status', 'contract-session', '--json'])) as any
    for (const field of ['sourceUpdatedAt', 'transcriptUpdatedAt', 'backupUpdatedAt', 'manifestUpdatedAt']) {
      expect(statusResult[field]).toEqual(expect.any(String))
    }
    expect(statusResult.lagMs).toBeGreaterThan(60_000)
    expect(statusResult).toMatchObject({ basis: 'local-source', status: 'stale', stale: true })
    expect(statusResult.blockingReasons).toEqual(expect.arrayContaining([
      'TRANSCRIPT_STALE', 'BACKUP_STALE'
    ]))
    expect(statusResult.blockingReasons).not.toContain('MANIFEST_STALE')

    const doctor = parsed(await invoke(['doctor', 'library', '--json'])) as any
    expect(doctor).toMatchObject({
      schemaVersion: 1,
      observation: 'instantaneous-filesystem',
      state: expect.any(String),
      staleCount: 1,
      unverifiableCount: 0
    })
  })

  it('事故验收 4: where/status 不依赖搜索数据库且不受 GUI 写锁影响', async () => {
    closeSearchIndex()
    fs.mkdirSync(path.dirname(searchDatabasePath()), { recursive: true })
    const blocker = new Database(searchDatabasePath())
    blocker.pragma('journal_mode = DELETE')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      const startedAt = performance.now()
      expect((await invoke(['where', 'contract-session', '--json'])).code).toBe(0)
      expect((await invoke(['transcript', 'status', 'contract-session', '--json'])).code).toBe(0)
      expect(performance.now() - startedAt).toBeLessThan(1_000)
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  })

  it('事故验收 5: transcript rebuild <id> 只改目标包', async () => {
    const peerDir = createControlPackage('Untouched Peer', 'peer-session', [])
    const peerManifest = path.join(peerDir, '.swob-session.json')
    fs.writeFileSync(path.join(peerDir, 'transcript.md'), '# untouched')
    const before = {
      manifest: fs.readFileSync(peerManifest, 'utf8'),
      transcript: fs.readFileSync(path.join(peerDir, 'transcript.md'), 'utf8'),
      entries: fs.readdirSync(peerDir).sort()
    }
    try {
      const rebuilt = parsed(await invoke(['transcript', 'rebuild', 'contract-session', '--json'])) as any
      expect(rebuilt).toMatchObject({
        sessionId: 'contract-session',
        dryRun: false,
        failed: 0,
        coreSnapshotFiles: ['transcript.md', 'backup.jsonl', '.swob-session.json'],
        coreWriteAtomic: true,
        branchTranscriptsBestEffort: true,
        branchFailed: expect.any(Number)
      })
      expect(rebuilt.written).toBeGreaterThan(0)
      expect(fs.readFileSync(peerManifest, 'utf8')).toBe(before.manifest)
      expect(fs.readFileSync(path.join(peerDir, 'transcript.md'), 'utf8')).toBe(before.transcript)
      expect(fs.readdirSync(peerDir).sort()).toEqual(before.entries)
    } finally {
      fs.rmSync(peerDir, { recursive: true, force: true })
    }
  })

  it('事故验收 6: 损坏 manifest、重复身份和 iCloud placeholder 有稳定机器码', async () => {
    const corruptDir = path.join(libraryRoot, 'Corrupt Manifest')
    fs.mkdirSync(corruptDir, { recursive: true })
    fs.writeFileSync(path.join(corruptDir, '.swob-session.json'), '{broken')
    const corrupt = await invoke(['where', 'not-provably-missing', '--json'])
    expect(corrupt.code).toBe(1)
    expect(parsedError(corrupt).error.code).toBe('LIBRARY_MANIFEST_CORRUPT')
    fs.rmSync(corruptDir, { recursive: true, force: true })

    const duplicateDir = createControlPackage('Duplicate Identity', 'contract-session')
    const duplicateResolve = await invoke(['resolve', 'contract-session', '--json'])
    expect(duplicateResolve.code).toBe(1)
    expect(parsedError(duplicateResolve).error.code).toBe('SESSION_IDENTITY_CONFLICT')
    const duplicate = await invoke(['where', 'contract-session', '--json'])
    expect(duplicate.code).toBe(1)
    expect(parsedError(duplicate).error.code).toBe('SESSION_IDENTITY_CONFLICT')
    fs.rmSync(duplicateDir, { recursive: true, force: true })

    const cloudId = '95000000-0000-4000-8000-000000000193'
    const cloudDir = createControlPackage('Cloud Placeholder', cloudId, [path.join(tempHome, 'missing-source.jsonl')])
    fs.writeFileSync(path.join(cloudDir, '.backup.jsonl.icloud'), '')
    try {
      const cloudStatus = parsed(await invoke(['transcript', 'status', cloudId, '--json'])) as any
      expect(cloudStatus.blockingReasons).toContain('ICLOUD_PLACEHOLDER')
      const rebuild = await invoke(['transcript', 'rebuild', cloudId, '--json'])
      expect(rebuild.code).toBe(1)
      expect(parsedError(rebuild).error.code).toBe('ICLOUD_PLACEHOLDER')
    } finally {
      fs.rmSync(cloudDir, { recursive: true, force: true })
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
    const latestOne = createControlPackage('Resolve latest one', 'latest-one', [])
    const latestTwo = createControlPackage('Resolve latest two', 'latest-two', [])
    fs.writeFileSync(path.join(libraryRoot, '.session-lineage.json'), JSON.stringify({
      version: 1,
      generatedAt: '2026-07-22T00:00:00.000Z',
      aliases: { 'ambiguous-one': 'latest-one', 'ambiguous-two': 'latest-two' }
    }))
    try {
      const ambiguous = await invoke(['resolve', 'ambiguous', '--json'])
      expect(ambiguous.code).toBe(2)
      expect(JSON.parse(ambiguous.stdout)).toMatchObject({ matched: false, ambiguous: true })

      const ambiguousWhere = await invoke(['where', 'ambiguous', '--json'])
      expect(ambiguousWhere.code).toBe(2)
      expect(parsedError(ambiguousWhere).error).toMatchObject({
        code: 'IDENTIFIER_AMBIGUOUS',
        candidates: ['ambiguous-one', 'ambiguous-two']
      })

      const missing = await invoke(['resolve', 'definitely-missing', '--json'])
      expect(missing.code).toBe(3)
      expect(JSON.parse(missing.stdout)).toMatchObject({ matched: false, ambiguous: false })
    } finally {
      fs.rmSync(latestOne, { recursive: true, force: true })
      fs.rmSync(latestTwo, { recursive: true, force: true })
      fs.rmSync(path.join(libraryRoot, '.session-lineage.json'), { force: true })
    }
  })

  it('Skill 完全由命令注册表生成并覆盖每个命令定义', () => {
    const skill = generateSkillContent()
    for (const command of CLI_COMMANDS) expect(skill).toContain(`swob ${command.usage}`)
    expect(skill).toContain('input_plus_output')
    expect(skill).toContain('退出码')
  })
})
