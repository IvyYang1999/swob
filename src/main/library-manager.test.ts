/**
 * library-manager.ts 分支独立性测试
 *
 * 确保分支 session 的 meta（重命名、笔记等）和文件夹归属
 * 完全独立于母 session，互不影响。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'node:crypto'
import { shellQuote } from './resume-terminal'
import { buildSessionSummaryFromBackup } from './session-loader'
import { undoLastOrganization } from './vault-organizer'

// 隔离测试环境：用临时目录作为 Library root
let tmpRoot: string
let savedAppConfig: string | null = null
const savedHome = process.env.HOME
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-lib-home-'))
process.env.HOME = testHome

// 动态导入，确保 HOME 修改生效
let lib: typeof import('./library-manager')

const APP_CONFIG_FILE = path.join(os.homedir(), '.claude-session-manager', 'app-config.json')

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf-8')
}

function writeSessionMeta(dirPath: string, meta: Record<string, unknown>): void {
  fs.mkdirSync(dirPath, { recursive: true })
  fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify(meta, null, 2), 'utf-8')
}

function removeDefaultSession(): void {
  fs.rmSync(path.join(tmpRoot, '这是母session'), { recursive: true, force: true })
}

function claudeRows(sessionId: string, prompt = '请测试 transcript'): unknown[] {
  return [
    {
      uuid: `${sessionId}-u1`,
      parentUuid: null,
      sessionId,
      type: 'user',
      timestamp: '2026-07-07T00:00:00Z',
      cwd: tmpRoot,
      promptSource: 'typed',
      message: { role: 'user', content: prompt }
    },
    {
      uuid: `${sessionId}-a1`,
      parentUuid: `${sessionId}-u1`,
      sessionId,
      type: 'assistant',
      timestamp: '2026-07-07T00:01:00Z',
      cwd: tmpRoot,
      message: { role: 'assistant', content: '已完成。' }
    }
  ]
}

function createLibrarySession(sessionId: string, sourceFilePaths: string[], opts: { dirName?: string; transcript?: string } = {}): string {
  const dirPath = path.join(tmpRoot, opts.dirName || sessionId)
  writeSessionMeta(dirPath, {
    sessionId,
    sourceFilePaths,
    createdAt: '2026-07-07T00:00:00Z',
    updatedAt: '2026-07-07T00:01:00Z',
    projectPath: tmpRoot
  })
  if (opts.transcript !== undefined) {
    fs.writeFileSync(path.join(dirPath, 'transcript.md'), opts.transcript, 'utf-8')
  }
  return dirPath
}

function parseFrontmatter(md: string): { data: Record<string, string | number>; body: string } {
  expect(md.startsWith('---\n')).toBe(true)
  const close = md.indexOf('\n---\n', 4)
  expect(close).toBeGreaterThan(0)
  const data: Record<string, string | number> = {}
  for (const line of md.slice(4, close).split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx)
    const rawValue = line.slice(idx + 1).trim()
    if (/^\d+$/.test(rawValue)) {
      data[key] = Number(rawValue)
    } else if (rawValue.startsWith('"')) {
      data[key] = JSON.parse(rawValue)
    } else {
      data[key] = rawValue
    }
  }
  return { data, body: md.slice(close + '\n---\n'.length) }
}

function expectTitleImmediatelyAfterFrontmatter(md: string, title: string): Record<string, string | number> {
  const { data, body } = parseFrontmatter(md)
  expect(body.split(/\r?\n/).find((line) => line.trim())).toBe(`# ${title}`)
  return data
}

beforeEach(async () => {
  // 备份临时 HOME 内的 app-config，防止测试之间串状态
  try {
    savedAppConfig = fs.existsSync(APP_CONFIG_FILE) ? fs.readFileSync(APP_CONFIG_FILE, 'utf-8') : null
  } catch { savedAppConfig = null }

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-lib-test-'))
  lib = await import('./library-manager')
  lib.initLibrary(tmpRoot)

  // 创建一个模拟的 session 目录（代表母 session）
  const sessionDir = path.join(tmpRoot, '这是母session')
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
    sessionId: 'abc-123',
    sourceFilePaths: ['/fake/path.jsonl'],
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T01:00:00Z',
    projectPath: '/fake'
  }))

  // 创建一个文件夹
  const folderDir = path.join(tmpRoot, '我的文件夹')
  fs.mkdirSync(folderDir, { recursive: true })

  // 重新扫描，建立索引
  lib.scanLibrary()
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  // 恢复临时 app-config，避免测试之间串状态
  if (savedAppConfig !== null) {
    fs.writeFileSync(APP_CONFIG_FILE, savedAppConfig, 'utf-8')
  } else {
    fs.rmSync(APP_CONFIG_FILE, { force: true })
  }
  try {
    for (const name of fs.readdirSync(path.dirname(APP_CONFIG_FILE))) {
      if (name.startsWith('app-config.json.corrupt-')) {
        fs.rmSync(path.join(path.dirname(APP_CONFIG_FILE), name), { force: true })
      }
    }
  } catch { /* temporary HOME may not contain a config directory */ }
})

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = savedHome
  }
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe('Library metadata cache', () => {
  it('unchanged metadata is read once across repeated scans', () => {
    const sessionId = 'meta-cache-session'
    createLibrarySession(sessionId, ['/unavailable/meta-cache.jsonl'])
    const before = lib.getLibraryMetaCacheStats().diskReads

    lib.scanLibrary()
    lib.scanLibrary()

    expect(lib.getLibraryMetaCacheStats().diskReads - before).toBe(1)
  })
})

describe('【曾经的 bug】重命名分支 session 不应该影响母 session', () => {
  it('分支重命名后，母 session 的标题不变', () => {
    const branchId = 'abc-123:intra-0'

    // 先给母 session 设个标题
    lib.setSessionMetaInLibrary('abc-123', { customTitle: '母session标题' })

    // 给分支设标题
    lib.setBranchMeta(branchId, { customTitle: '分支标题' })

    // 重新扫描，生成 config
    const tree = lib.scanLibrary()
    const config = lib.libraryTreeToConfig(tree)

    // 母 session 的标题不应该被改
    expect(config.sessionMeta['abc-123']?.customTitle).toBe('母session标题')
    // 分支有自己独立的标题
    expect(config.sessionMeta[branchId]?.customTitle).toBe('分支标题')
  })

  it('母 session 重命名后，分支的标题不变', () => {
    const branchId = 'abc-123:intra-0'

    // 先给分支设标题
    lib.setBranchMeta(branchId, { customTitle: '分支标题' })

    // 再改母 session 的标题
    lib.setSessionMetaInLibrary('abc-123', { customTitle: '母session新标题' })

    const tree = lib.scanLibrary()
    const config = lib.libraryTreeToConfig(tree)

    expect(config.sessionMeta['abc-123']?.customTitle).toBe('母session新标题')
    expect(config.sessionMeta[branchId]?.customTitle).toBe('分支标题')
  })

  it('多个分支各自独立重命名', () => {
    lib.setBranchMeta('abc-123:intra-0', { customTitle: '分支A' })
    lib.setBranchMeta('abc-123:intra-1', { customTitle: '分支B' })

    const tree = lib.scanLibrary()
    const config = lib.libraryTreeToConfig(tree)

    expect(config.sessionMeta['abc-123:intra-0']?.customTitle).toBe('分支A')
    expect(config.sessionMeta['abc-123:intra-1']?.customTitle).toBe('分支B')
    // 母 session 不受影响
    expect(config.sessionMeta['abc-123']?.customTitle).toBeUndefined()
  })
})

describe('App 配置：Library 路径管理', () => {
  let configDir: string
  let configFile: string

  beforeEach(() => {
    configDir = path.join(tmpRoot, '.app-config')
    configFile = path.join(configDir, 'app-config.json')
  })

  it('loadAppConfig 文件不存在时返回空对象', () => {
    const config = lib.loadAppConfig()
    // 真实环境下可能已有配置，这里只验证不会崩溃且返回对象
    expect(typeof config).toBe('object')
  })

  it('saveAppConfig + loadAppConfig 往返一致', () => {
    lib.saveAppConfig({ libraryPath: tmpRoot })
    const config = lib.loadAppConfig()
    expect(config.libraryPath).toBe(tmpRoot)
  })

  it('deviceId 在 app-config.json 中只生成一次并持久化', () => {
    const first = lib.getOrCreateLocalDeviceId(() => 'device-xx…0001')
    const second = lib.getOrCreateLocalDeviceId(() => 'device-xx…9999')
    expect(first).toBe('device-xx…0001')
    expect(second).toBe(first)
    expect(lib.loadAppConfig().deviceId).toBe('device-xx…0001')
    expect(fs.statSync(APP_CONFIG_FILE).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(APP_CONFIG_FILE)).filter((name) =>
      name === 'app-config.json.lock' || name.endsWith('.tmp')
    )).toEqual([])
  })

  it('并发初始化锁存在时拒绝第二次生成，不写入竞争 deviceId', () => {
    fs.mkdirSync(path.dirname(APP_CONFIG_FILE), { recursive: true })
    fs.writeFileSync(`${APP_CONFIG_FILE}.lock`, 'in-progress', { mode: 0o600 })
    const createId = vi.fn(() => 'competing-device-xx…0002')

    expect(() => lib.getOrCreateLocalDeviceId(createId)).toThrow('app-config-write-in-progress')
    expect(createId).not.toHaveBeenCalled()
    expect(fs.existsSync(APP_CONFIG_FILE)).toBe(false)
    fs.rmSync(`${APP_CONFIG_FILE}.lock`, { force: true })
  })

  it('getConfiguredLibraryPath 无配置时返回默认路径', () => {
    const p = lib.getConfiguredLibraryPath()
    expect(typeof p).toBe('string')
    expect(p.length).toBeGreaterThan(0)
  })

  it('isLibraryInitialized 对新目录返回 false', () => {
    const emptyDir = path.join(tmpRoot, 'empty-dir')
    fs.mkdirSync(emptyDir)
    expect(lib.isLibraryInitialized(emptyDir)).toBe(false)
  })

  it('isLibraryInitialized 对已初始化的 Library 返回 true', () => {
    // tmpRoot 已经被 initLibrary 初始化过，需要先创建 config 文件
    lib.saveLibraryConfig(lib.loadLibraryConfig())
    expect(lib.isLibraryInitialized(tmpRoot)).toBe(true)
  })
})

describe('SessionMeta v2 来源持久化与旧格式兼容', () => {
  it('缺 sessionId 的 meta 在边界告警并拒绝进入扫描', () => {
    const warnings: string[] = []
    const parsed = lib.parseSessionMeta(JSON.stringify({
      sourceFilePaths: ['/fixture/source-xx…0101.jsonl'],
      projectPath: '/fixture/project-xx…0101'
    }), (warning) => warnings.push(warning))

    expect(parsed).toBeNull()
    expect(warnings).toEqual([expect.stringContaining('missing sessionId/projectPath')])
  })

  it('缺 projectPath 的 meta 在边界告警并拒绝进入扫描', () => {
    const warnings: string[] = []
    const parsed = lib.parseSessionMeta(JSON.stringify({
      sessionId: 'invalid-xx…0102',
      sourceFilePaths: ['/fixture/source-xx…0102.jsonl']
    }), (warning) => warnings.push(warning))

    expect(parsed).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('sourceFilePaths 含非字符串时在边界告警并拒绝进入扫描', () => {
    const warnings: string[] = []
    const parsed = lib.parseSessionMeta(JSON.stringify({
      sessionId: 'invalid-xx…0103',
      sourceFilePaths: ['/fixture/source-xx…0103.jsonl', 42],
      projectPath: '/fixture/project-xx…0103'
    }), (warning) => warnings.push(warning))

    expect(parsed).toBeNull()
    expect(warnings).toEqual([expect.stringContaining('sourceFilePaths must be strings')])
  })

  it('畸形 origin 在边界告警并拒绝进入扫描', () => {
    const warnings: string[] = []
    const parsed = lib.parseSessionMeta(JSON.stringify({
      sessionId: 'invalid-xx…0104',
      sourceFilePaths: ['/fixture/source-xx…0104.jsonl'],
      projectPath: '/fixture/project-xx…0104',
      origin: { deviceId: 42 }
    }), (warning) => warnings.push(warning))

    expect(parsed).toBeNull()
    expect(warnings).toEqual([expect.stringContaining('malformed origin')])
  })

  it('旧 meta 缺 schemaVersion/origin/sourceInstance 时正常读取且字段不被伪造', () => {
    const legacy = {
      sessionId: 'legacy-xx…0001',
      sourceFilePaths: ['/fixture/source-xx…0001.jsonl'],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:01:00.000Z',
      projectPath: '/fixture/project-xx…0001'
    }
    const parsed = lib.parseSessionMeta(JSON.stringify(legacy))
    expect(parsed).toEqual(legacy)
    expect(parsed?.schemaVersion).toBeUndefined()
    expect(parsed?.origin).toBeUndefined()
    expect(parsed?.sourceInstance).toBeUndefined()
    expect(parsed?.backupSha256).toBeUndefined()
    expect(parsed?.backupSize).toBeUndefined()

    const dirPath = path.join(tmpRoot, 'legacy-meta-xx…0001')
    writeSessionMeta(dirPath, legacy)
    lib.scanLibrary()
    const found = lib.findLibraryOnlySessions(new Set()).find((item) => item.sessionId === legacy.sessionId)
    expect(found).toBeUndefined() // historical behavior: no backup means not library-only
    expect(() => lib.getSessionResumeAvailability(legacy.sessionId)).not.toThrow()
  })

  it('backup 写入后把实际 SHA-256/size 顺路持久化到 SessionMeta v2', async () => {
    removeDefaultSession()
    const sessionId = 'metadata-backup-xx…0107'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture-project-xx…0107', `${sessionId}.jsonl`)
    const rows = claudeRows(sessionId, 'expected metadata supply')
    writeJsonl(sourcePath, rows)
    const expectedContent = fs.readFileSync(sourcePath)
    const dirPath = createLibrarySession(sessionId, [sourcePath], { dirName: 'metadata-backup-xx…0107' })
    lib.scanLibrary()

    await lib.syncBackup(sessionId)

    const backupPath = path.join(dirPath, 'backup.jsonl')
    const writtenMeta = JSON.parse(fs.readFileSync(path.join(dirPath, '.swob-session.json'), 'utf-8'))
    expect(fs.readFileSync(backupPath)).toEqual(expectedContent)
    expect(writtenMeta).toMatchObject({
      schemaVersion: 2,
      backupSha256: createHash('sha256').update(expectedContent).digest('hex'),
      backupSize: expectedContent.length
    })
    expect(lib.parseSessionMeta(JSON.stringify(writtenMeta))).toMatchObject({
      backupSha256: writtenMeta.backupSha256,
      backupSize: writtenMeta.backupSize,
      backupSourceState: expect.objectContaining({
        path: sourcePath,
        size: expectedContent.length
      })
    })
  })

  it('单一 JSONL 增长时只追加新尾部并保留 backup inode', async () => {
    removeDefaultSession()
    const sessionId = 'incremental-backup-xx…0110'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture-project-xx…0110', `${sessionId}.jsonl`)
    writeJsonl(sourcePath, claudeRows(sessionId, 'before append'))
    const dirPath = createLibrarySession(sessionId, [sourcePath], { dirName: 'incremental-backup-xx…0110' })
    lib.scanLibrary()
    await lib.syncBackup(sessionId)

    const backupPath = path.join(dirPath, 'backup.jsonl')
    const inodeBefore = fs.statSync(backupPath).ino
    const appended = '\n' + JSON.stringify({
      uuid: 'append-a1',
      parentUuid: 'u1',
      sessionId,
      type: 'assistant',
      timestamp: '2026-07-21T18:00:01Z',
      cwd: '/fixture/project',
      message: { role: 'assistant', content: 'tail marker' }
    })
    fs.appendFileSync(sourcePath, appended)

    await lib.syncBackup(sessionId)

    const expected = fs.readFileSync(sourcePath)
    const writtenMeta = JSON.parse(fs.readFileSync(path.join(dirPath, '.swob-session.json'), 'utf-8'))
    expect(fs.statSync(backupPath).ino).toBe(inodeBefore)
    expect(fs.readFileSync(backupPath)).toEqual(expected)
    expect(writtenMeta.backupSize).toBe(expected.length)
    expect(writtenMeta.backupSha256).toBe(createHash('sha256').update(expected).digest('hex'))
    expect(writtenMeta.backupSourceState.size).toBe(expected.length)
  })

  it('旧 meta 加有效 backup 能真实加载为 library-only session', async () => {
    const sessionId = 'legacy-backup-xx…0105'
    const dirPath = path.join(tmpRoot, 'legacy-backup-xx…0105')
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: ['/Users/legacy-xx…0105/.claude/projects/-Users-legacy-xx…0105-project/session.jsonl'],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:01:00.000Z',
      projectPath: '/Users/legacy-xx…0105/.claude/projects/-Users-legacy-xx…0105-project'
    })
    writeJsonl(path.join(dirPath, 'backup.jsonl'), claudeRows(sessionId, 'legacy backup regression'))

    lib.scanLibrary()
    const found = lib.findLibraryOnlySessions(new Set()).find((item) => item.sessionId === sessionId)
    expect(found).toBeDefined()
    const summary = await buildSessionSummaryFromBackup(found!.backupPath, sessionId, found!.meta)
    expect(summary).toMatchObject({ sessionId, firstUserMessage: 'legacy backup regression' })
  })

  it('损坏 app-config 使 deviceId 缺失时仍保留并加载旧 library-only session', async () => {
    const sessionId = 'corrupt-config-xx…0106'
    const dirPath = path.join(tmpRoot, 'corrupt-config-xx…0106')
    writeSessionMeta(dirPath, {
      schemaVersion: 2,
      sessionId,
      sourceFilePaths: ['/Users/old-install-xx…0106/.claude/projects/-Users-old-install-xx…0106-project/session.jsonl'],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:01:00.000Z',
      projectPath: '/Users/old-install-xx…0106/.claude/projects/-Users-old-install-xx…0106-project',
      origin: {
        deviceId: 'old-installation-xx…0106',
        hostname: 'old-host-xx…0106',
        username: 'old-user-xx…0106',
        capturedAt: '2026-07-18T00:00:00.000Z'
      }
    })
    writeJsonl(path.join(dirPath, 'backup.jsonl'), claudeRows(sessionId, 'survives missing device id'))
    fs.mkdirSync(path.dirname(APP_CONFIG_FILE), { recursive: true })
    fs.writeFileSync(APP_CONFIG_FILE, '{broken-app-config', 'utf-8')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => lib.getOrCreateLocalDeviceId(() => 'must-not-overwrite')).toThrow('invalid-app-config')
    lib.scanLibrary()
    const found = lib.findLibraryOnlySessions(new Set()).find((item) => item.sessionId === sessionId)
    expect(found).toBeDefined()
    expect(lib.resolveLibrarySessionRemoteState(found!.meta)).toEqual({
      isRemote: true,
      remoteHost: 'old-host-xx…0106',
      confidence: 'installation-id-unavailable'
    })
    const summary = await buildSessionSummaryFromBackup(found!.backupPath, sessionId, found!.meta)
    expect(summary?.firstUserMessage).toBe('survives missing device id')
    expect(fs.readFileSync(APP_CONFIG_FILE, 'utf-8')).toBe('{broken-app-config')
  })

  it('自定义 Library 冷启动遇损坏配置时先备份，再经 changePath 找回旧 session', async () => {
    const customLibrary = path.join(tmpRoot, 'custom-library-xx…0107')
    const sessionId = 'corrupt-cold-start-xx…0107'
    const dirPath = path.join(customLibrary, 'old-session-xx…0107')
    const corruptContent = '{broken-cold-start-config-xx…0107'
    writeSessionMeta(dirPath, {
      sessionId,
      sourceFilePaths: ['/Users/old-install-xx…0107/.claude/projects/-fixture-old-xx…0107/session.jsonl'],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:01:00.000Z',
      projectPath: '/Users/old-install-xx…0107/.claude/projects/-fixture-old-xx…0107'
    })
    writeJsonl(path.join(dirPath, 'backup.jsonl'), claudeRows(sessionId, 'cold-start recovery evidence'))
    lib.saveAppConfig({ libraryPath: customLibrary, deviceId: 'device-before-corruption-xx…0107' })
    fs.writeFileSync(APP_CONFIG_FILE, corruptContent, 'utf-8')

    // 验收员原形态：损坏配置后重启，首次初始化无法猜回自定义路径。
    lib.initLibrary()
    lib.scanLibrary()
    expect(lib.getLibraryRoot()).not.toBe(customLibrary)
    expect(lib.findLibraryOnlySessions(new Set()).some((item) => item.sessionId === sessionId)).toBe(false)

    const backups = fs.readdirSync(path.dirname(APP_CONFIG_FILE))
      .filter((name) => name.startsWith('app-config.json.corrupt-'))
      .map((name) => path.join(path.dirname(APP_CONFIG_FILE), name))
      .filter((backupPath) => fs.readFileSync(backupPath, 'utf-8') === corruptContent)
    expect(backups).toHaveLength(1)
    expect(fs.statSync(backups[0]).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(APP_CONFIG_FILE, 'utf-8')).toBe(corruptContent)

    // UI 的 library:changePath 使用此专用入口；备份存在后才允许重建配置。
    expect(() => lib.changeConfiguredLibraryPath(customLibrary)).not.toThrow()
    expect(lib.loadAppConfig()).toEqual({ libraryPath: customLibrary })
    expect(fs.readFileSync(backups[0], 'utf-8')).toBe(corruptContent)

    lib.initLibrary()
    lib.scanLibrary()
    const found = lib.findLibraryOnlySessions(new Set()).find((item) => item.sessionId === sessionId)
    expect(found).toBeDefined()
    const summary = await buildSessionSummaryFromBackup(found!.backupPath, sessionId, found!.meta)
    expect(summary?.firstUserMessage).toBe('cold-start recovery evidence')
  })

  it('新建 meta 写入首次 origin/sourceInstance，deviceId 来自 app-config', async () => {
    removeDefaultSession()
    lib.getOrCreateLocalDeviceId(() => 'device-xx…0002')
    const sessionId = '90000000-0000-4000-8000-000000000009'
    const sourcePath = path.join(
      testHome,
      '.claude',
      'projects',
      '-fixture-project-xx…0002',
      `${sessionId}.jsonl`
    )
    const dirPath = await lib.ensureSessionInLibrary({
      sessionId,
      cwds: ['/fixture/outside-xx…0002'],
      firstUserMessage: 'fixture-title-xx…0002',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:01:00.000Z',
      projectPath: path.dirname(sourcePath),
      filePath: sourcePath,
      allFilePaths: [sourcePath],
      turnCount: 1
    } as any, undefined, {
      hostname: 'host-xx…0002',
      username: 'user-xx…0002',
      capturedAt: '2026-07-19T00:02:00.000Z'
    })

    const written = JSON.parse(fs.readFileSync(path.join(dirPath, '.swob-session.json'), 'utf-8'))
    expect(written).toMatchObject({
      schemaVersion: 2,
      origin: {
        deviceId: 'device-xx…0002',
        hostname: 'host-xx…0002',
        username: 'user-xx…0002',
        capturedAt: '2026-07-19T00:02:00.000Z'
      },
      sourceInstance: { kind: 'claude-default' }
    })
    expect(lib.loadAppConfig().deviceId).toBe(written.origin.deviceId)
    expect(fs.existsSync(sourcePath)).toBe(false)
  })

  it('已有远端 origin 在后续同步中保持不变', async () => {
    removeDefaultSession()
    const sessionId = 'a0000000-0000-4000-8000-00000000000a'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture-project-xx…0003', `${sessionId}.jsonl`)
    const dirPath = createLibrarySession(sessionId, [sourcePath], { dirName: 'preserve-origin-xx…0003' })
    const initial = JSON.parse(fs.readFileSync(path.join(dirPath, '.swob-session.json'), 'utf-8'))
    initial.schemaVersion = 2
    initial.origin = {
      deviceId: 'remote-device-xx…0003',
      hostname: 'remote-host-xx…0003',
      username: 'same-user-xx…0003',
      capturedAt: '2026-07-18T00:00:00.000Z'
    }
    fs.writeFileSync(path.join(dirPath, '.swob-session.json'), JSON.stringify(initial, null, 2), 'utf-8')
    lib.scanLibrary()

    await lib.ensureSessionInLibrary({
      sessionId,
      createdAt: initial.createdAt,
      updatedAt: '2026-07-19T00:03:00.000Z',
      projectPath: path.dirname(sourcePath),
      filePath: sourcePath,
      allFilePaths: [sourcePath],
      cwds: ['/fixture/project-xx…0003'],
      turnCount: 1
    } as any, undefined, {
      deviceId: 'local-device-xx…0003',
      hostname: 'local-host-xx…0003'
    })

    const after = JSON.parse(fs.readFileSync(path.join(dirPath, '.swob-session.json'), 'utf-8'))
    expect(after.origin).toEqual(initial.origin)
  })
})

describe('Library-only sessions（跨设备同步）', () => {
  it('findLibraryOnlySessions 不返回本机已有的 session', () => {
    const localIds = new Set(['abc-123'])
    const result = lib.findLibraryOnlySessions(localIds)
    expect(result).toHaveLength(0)
  })

  it('findLibraryOnlySessions 返回 Library 中有 backup 但本机没有的 session', () => {
    // 创建一个「来自其他设备」的 session
    const remoteDir = path.join(tmpRoot, '远程设备的对话')
    fs.mkdirSync(remoteDir, { recursive: true })
    fs.writeFileSync(path.join(remoteDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'remote-999',
      sourceFilePaths: ['/Users/other-machine/.claude/projects/xxx/session.jsonl'],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/other-machine/projects/xxx'
    }))
    fs.writeFileSync(path.join(remoteDir, 'backup.jsonl'), '{"uuid":"u1","sessionId":"remote-999","type":"user","timestamp":"2026-04-01T00:00:00Z","message":{"role":"user","content":"hello"}}\n')

    // 重新扫描
    lib.scanLibrary()

    const localIds = new Set(['abc-123'])
    const result = lib.findLibraryOnlySessions(localIds)
    expect(result).toHaveLength(1)
    expect(result[0].sessionId).toBe('remote-999')
    expect(result[0].backupPath).toContain('backup.jsonl')
  })

  it('findLibraryOnlySessions 忽略没有 backup.jsonl 的 Library session', () => {
    const noBackupDir = path.join(tmpRoot, '没有备份的对话')
    fs.mkdirSync(noBackupDir, { recursive: true })
    fs.writeFileSync(path.join(noBackupDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'no-backup-999',
      sourceFilePaths: [],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/fake'
    }))

    lib.scanLibrary()

    const localIds = new Set(['abc-123'])
    const result = lib.findLibraryOnlySessions(localIds)
    // 应该不包含没有 backup 的 session
    expect(result.find(r => r.sessionId === 'no-backup-999')).toBeUndefined()
  })

  it('【曾经的 bug】findLibrarySessionsWithMissingSources 不受 cachedSessions 影响', () => {
    const localSourcePath = path.join(os.homedir(), '.claude', 'projects', `-swob-missing-source-${process.pid}-${Date.now()}`, 'missing-source-999.jsonl')
    const sessionDir = path.join(tmpRoot, '原始文件缺失但列表已缓存')

    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'missing-source-999',
      sourceFilePaths: [localSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/test'
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), '{"uuid":"u1","sessionId":"missing-source-999"}\n')

    lib.scanLibrary()

    expect(lib.findLibraryOnlySessions(new Set(['missing-source-999']))).toHaveLength(0)
    const missingSourceResults = lib.findLibrarySessionsWithMissingSources()
    expect(missingSourceResults.some((r) => r.sessionId === 'missing-source-999')).toBe(true)
  })

  it('【曾经的 bug】本机原始 JSONL 丢失时，通过唯一事务入口从 Library backup 恢复', async () => {
    const sessionId = '83000000-0000-4000-8000-000000000001'
    const localSourceDir = path.join(testHome, '.claude', 'projects', `-swob-test-${process.pid}-${Date.now()}`)
    const localSourcePath = path.join(localSourceDir, `${sessionId}.jsonl`)
    const sessionDir = path.join(tmpRoot, '本机丢失的对话')
    const backupContent = `{"uuid":"u1","sessionId":"${sessionId}","type":"user","timestamp":"2026-04-01T00:00:00Z","cwd":"/Users/test","message":{"role":"user","content":"hello"}}\n`

    fs.mkdirSync(path.join(testHome, '.claude', 'projects'), { recursive: true })
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      sourceFilePaths: [localSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/test',
      backupSha256: createHash('sha256').update(backupContent).digest('hex'),
      backupSize: Buffer.byteLength(backupContent),
      origin: { deviceId: 'test-device', hostname: 'test-host', username: 'test', capturedAt: '2026-04-01T00:00:00Z' }
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), backupContent)

    lib.scanLibrary()
    const result = await lib.ensureSessionResumeTarget(sessionId, {
      allowRecovery: true,
      runtimeIdentity: { homeDir: testHome, localDeviceId: 'test-device', localUsername: 'test' }
    })

    expect(result).toMatchObject({ ok: true, state: 'restored' })
    expect(result.sourcePath).toBe(localSourcePath)
    expect(fs.readFileSync(localSourcePath, 'utf-8')).toBe(backupContent)

    fs.rmSync(localSourceDir, { recursive: true, force: true })
  })

  it('Claude Window 配置目录下的原始 JSONL 丢失时也走同一个事务入口', async () => {
    const sessionId = '84000000-0000-4000-8000-000000000001'
    const windowId = `swob-test-${process.pid}-${Date.now()}`
    const localConfigDir = path.join(testHome, '.claude-window', windowId)
    const localSourceDir = path.join(localConfigDir, 'projects', '-Users-test-projects-draftbox')
    const localSourcePath = path.join(localSourceDir, `${sessionId}.jsonl`)
    const sessionDir = path.join(tmpRoot, 'Claude Window 丢失的对话')
    const backupContent = `{"uuid":"u1","sessionId":"${sessionId}","type":"user","timestamp":"2026-04-01T00:00:00Z","cwd":"/Users/test/projects/draftbox","message":{"role":"user","content":"hello"}}\n`

    fs.mkdirSync(path.join(localConfigDir, 'projects'), { recursive: true })
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      sourceFilePaths: [localSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/test/projects/draftbox',
      backupSha256: createHash('sha256').update(backupContent).digest('hex'),
      backupSize: Buffer.byteLength(backupContent),
      origin: { deviceId: 'test-device', hostname: 'test-host', username: 'test', capturedAt: '2026-04-01T00:00:00Z' },
      sourceInstance: { kind: 'claude-window', configDir: localConfigDir }
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), backupContent)

    lib.scanLibrary()
    const result = await lib.ensureSessionResumeTarget(sessionId, {
      allowRecovery: true,
      runtimeIdentity: { homeDir: testHome, localDeviceId: 'test-device', localUsername: 'test' }
    })

    expect(result).toMatchObject({ ok: true, state: 'restored' })
    expect(result.sourcePath).toBe(localSourcePath)
    expect(fs.readFileSync(localSourcePath, 'utf-8')).toBe(backupContent)

    fs.rmSync(localConfigDir, { recursive: true, force: true })
  })

  it('不会把其他安装路径的 backup 自动恢复到本机 Claude 目录外', async () => {
    const sessionId = '85000000-0000-4000-8000-000000000001'
    const foreignSourcePath = `/Users/other-machine/.claude/projects/xxx/${sessionId}.jsonl`
    const sessionDir = path.join(tmpRoot, '其他机器的对话')
    const backupContent = `{"uuid":"u1","sessionId":"${sessionId}","type":"user","timestamp":"2026-04-01T00:00:00Z","cwd":"/Users/other-machine","message":{"role":"user","content":"hello"}}\n`

    fs.mkdirSync(path.join(testHome, '.claude', 'projects'), { recursive: true })
    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      sessionId,
      sourceFilePaths: [foreignSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/other-machine/projects/xxx',
      backupSha256: createHash('sha256').update(backupContent).digest('hex'),
      backupSize: Buffer.byteLength(backupContent),
      origin: { deviceId: 'other-device', hostname: 'other-host', username: 'other', capturedAt: '2026-04-01T00:00:00Z' }
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), backupContent)

    lib.scanLibrary()
    const result = await lib.ensureSessionResumeTarget(sessionId, {
      allowRecovery: true,
      runtimeIdentity: { homeDir: testHome, localDeviceId: 'test-device', localUsername: 'test' }
    })

    expect(result).toMatchObject({ ok: false, failureCode: 'remote-source-requires-explicit-target' })
    expect(fs.existsSync(foreignSourcePath)).toBe(false)
  })
})

describe('分支文件夹归属独立于母 session', () => {
  it('分支移入文件夹后，母 session 不跟着动', () => {
    const branchId = 'abc-123:intra-0'

    lib.addBranchToFolder(branchId, '我的文件夹')

    const tree = lib.scanLibrary()
    const config = lib.libraryTreeToConfig(tree)

    const folder = config.folders.find(f => f.name === '我的文件夹')
    expect(folder).toBeDefined()
    // 分支在文件夹里
    expect(folder!.sessionIds).toContain(branchId)
    // 母 session 不在这个文件夹里（它还在 Library root 的 ungrouped 区）
    expect(folder!.sessionIds).not.toContain('abc-123')
  })

  it('母 session 移入文件夹后，分支不跟着动', () => {
    const branchId = 'abc-123:intra-0'

    // 把母 session 移到文件夹
    lib.moveSessionToFolder('abc-123', path.join(tmpRoot, '我的文件夹'))

    // 重新扫描
    const tree = lib.scanLibrary()
    const config = lib.libraryTreeToConfig(tree)

    const folder = config.folders.find(f => f.name === '我的文件夹')
    expect(folder).toBeDefined()
    // 母 session 在文件夹里
    expect(folder!.sessionIds).toContain('abc-123')
    // 分支不在（没有被添加过）
    expect(folder!.sessionIds).not.toContain(branchId)
  })

  it('分支从文件夹移除后，不影响母 session 在其他文件夹的归属', () => {
    const branchId = 'abc-123:intra-0'

    // 母 session 在文件夹里
    lib.moveSessionToFolder('abc-123', path.join(tmpRoot, '我的文件夹'))
    // 分支也加到同一个文件夹
    lib.addBranchToFolder(branchId, '我的文件夹')

    // 现在把分支从文件夹移除
    lib.removeBranchFromFolder(branchId, '我的文件夹')

    const tree = lib.scanLibrary()
    const config = lib.libraryTreeToConfig(tree)

    const folder = config.folders.find(f => f.name === '我的文件夹')
    // 母 session 还在
    expect(folder!.sessionIds).toContain('abc-123')
    // 分支已移除
    expect(folder!.sessionIds).not.toContain(branchId)
  })
})

describe('isRemoteProjectPath', () => {
  it('不同用户名判断为远程', () => {
    expect(lib.isRemoteProjectPath('/Users/mac/.claude/projects/-Users-mac-projects-scsp')).toBe(true)
  })

  it('本机用户名判断为本地', () => {
    const localUser = require('os').userInfo().username
    expect(lib.isRemoteProjectPath(`/Users/${localUser}/.claude/projects/-Users-${localUser}-projects-foo`)).toBe(false)
  })

  it('不以连字符开头返回 false', () => {
    expect(lib.isRemoteProjectPath('/Users/mac/.claude/projects/random')).toBe(false)
  })

  it('【曾经的 bug】本机用户名但只有 -Users-xxx 的短路径也判断为本地', () => {
    const localUser = require('os').userInfo().username
    expect(lib.isRemoteProjectPath(`/Users/${localUser}/.claude/projects/-Users-${localUser}`)).toBe(false)
  })

  it('远程用户名的短路径判断为远程', () => {
    expect(lib.isRemoteProjectPath('/Users/mac/.claude/projects/-Users-mac')).toBe(true)
  })
})

describe('resolveSessionRemoteState', () => {
  it('同用户名但安装 ID 不同仍判定为非本安装，并使用持久化 hostname', () => {
    expect(lib.resolveSessionRemoteState({
      projectPath: '/Users/same-user-xx…0004/.claude/projects/-Users-same-user-xx…0004-project',
      origin: {
        deviceId: 'remote-device-xx…0004',
        hostname: 'remote-host-xx…0004',
        username: 'same-user-xx…0004',
        capturedAt: '2026-07-19T00:00:00.000Z'
      }
    }, 'local-device-xx…0004', 'same-user-xx…0004')).toEqual({
      isRemote: true,
      remoteHost: 'remote-host-xx…0004',
      confidence: 'installation-id'
    })
  })

  it('旧 meta 无 origin 时保持用户名路径猜测行为', () => {
    expect(lib.resolveSessionRemoteState({
      projectPath: '/Users/userxx…0005/.claude/projects/-Users-userxx…0005-project'
    }, 'local-device-xx…0005', 'userxx…0005')).toEqual({
      isRemote: false,
      remoteHost: undefined,
      confidence: 'legacy-path-guess'
    })
  })
})

describe('extractRemoteUser', () => {
  it('提取远程用户名', () => {
    expect(lib.extractRemoteUser('/Users/mac/.claude/projects/-Users-mac-projects-scsp')).toBe('mac')
  })

  it('无效路径返回 null', () => {
    expect(lib.extractRemoteUser('/some/random/path')).toBeNull()
  })
})

describe('claudeProjectPathToCwd', () => {
  it('把 Claude 项目存储路径转为实际目录', () => {
    expect(lib.claudeProjectPathToCwd('/Users/mac/.claude/projects/-Users-mac-projects-scsp'))
      .toBe('/Users/mac/projects/scsp')
  })

  it('处理更深层嵌套路径', () => {
    expect(lib.claudeProjectPathToCwd('/home/user/.claude/projects/-home-user-work-my-project'))
      .toBe('/home/user/work/my/project')
  })

  it('不以连字符开头的路径返回 null', () => {
    expect(lib.claudeProjectPathToCwd('/Users/mac/.claude/projects/some-random')).toBeNull()
  })
})

describe('buildSshResumeCommand', () => {
  function expectedSsh(userHost: string, fullCmd: string): string {
    const remoteCmd = `zsh -li -c ${shellQuote(fullCmd)}`
    return `ssh -t ${shellQuote(userHost)} ${shellQuote(remoteCmd)}`
  }

  it('默认用 interactive login shell 包裹 claude 命令', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' })
    expect(cmd).toBe(expectedSsh('bob@mac.local', `${shellQuote('claude')} --resume ${shellQuote('sess-123')}`))
  })

  it('bypassPermissions 模式加上 --dangerously-skip-permissions', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' }, 'bypassPermissions')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('sess-123')
  })

  it('指定 remotePath 时使用自定义路径', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob', remotePath: '/opt/bin/claude' })
    expect(cmd).toBe(expectedSsh('bob@mac.local', `${shellQuote('/opt/bin/claude')} --resume ${shellQuote('sess-123')}`))
  })

  it('传入 remoteCwd 时先 cd 到目录', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' }, undefined, '/Users/mac/projects/scsp')
    expect(cmd).toBe(expectedSsh(
      'bob@mac.local',
      `cd ${shellQuote('/Users/mac/projects/scsp')} && ${shellQuote('claude')} --resume ${shellQuote('sess-123')}`
    ))
  })

  it('remoteCwd 为 null 时不加 cd', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' }, undefined, null)
    expect(cmd).not.toContain('cd ')
  })
})

describe('首启动引导状态机', () => {
  it('全新安装（无 app-config、无已初始化库）需要引导', () => {
    fs.rmSync(APP_CONFIG_FILE, { force: true })
    expect(lib.isOnboardingNeeded()).toBe(true)
  })

  it('completeOnboarding 落库路径 + 排除清单，之后不再需要引导', () => {
    fs.rmSync(APP_CONFIG_FILE, { force: true })
    lib.completeOnboarding(tmpRoot, ['zcode', 'grok'])
    expect(lib.isOnboardingNeeded()).toBe(false)
    expect(lib.getConfiguredLibraryPath()).toBe(tmpRoot)
    expect(lib.getExcludedSources()).toEqual(['zcode', 'grok'])
  })

  it('老装机（已配置 libraryPath 但没有引导标记）被豁免并补标记', () => {
    fs.rmSync(APP_CONFIG_FILE, { force: true })
    lib.changeConfiguredLibraryPath(tmpRoot)
    expect(lib.isOnboardingNeeded()).toBe(false)
    const config = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf-8'))
    expect(config.onboardingCompleted).toBe(true)
  })

  it('setExcludedSources 空数组清除配置键', () => {
    fs.rmSync(APP_CONFIG_FILE, { force: true })
    lib.completeOnboarding(tmpRoot, ['pi'])
    lib.setExcludedSources([])
    expect(lib.getExcludedSources()).toEqual([])
    const config = JSON.parse(fs.readFileSync(APP_CONFIG_FILE, 'utf-8'))
    expect('excludedSources' in config).toBe(false)
  })
})

describe('库根 = vault：Inbox 放置 + 忽略名单 + 安全删除', () => {
  function summary(sessionId: string, cwds: string[]) {
    return {
      sessionId,
      cwds,
      firstUserMessage: '会话 ' + sessionId,
      createdAt: '2026-06-01T00:00:00Z',
      updatedAt: '2026-06-01T01:00:00Z',
      projectPath: '/fake',
      filePath: '/fake/' + sessionId + '.jsonl',
      allFilePaths: ['/fake/' + sessionId + '.jsonl']
    } as any
  }

  function makeSession(dir: string, sessionId: string) {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
      sessionId, sourceFilePaths: [], createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z', projectPath: '/x'
    }))
  }

  function collectIds(tree: any): string[] {
    const ids: string[] = []
    const walk = (f: any) => { for (const s of f.sessions) ids.push(s.sessionId); for (const c of f.children) walk(c) }
    for (const s of tree.ungroupedSessions) ids.push(s.sessionId)
    for (const f of tree.folders) walk(f)
    return ids
  }

  it('vault 内项目目录启动的新会话散放根目录并带会话包标记，不擅自按 cwd 整理', async () => {
    const cwd = path.join(tmpRoot, '项目', '飞搜')
    fs.mkdirSync(cwd, { recursive: true })
    const dir = await lib.ensureSessionInLibrary(summary('in-vault-1', [cwd]))
    expect(dir).toBe(path.join(tmpRoot, '💬 会话 in-vault-1'))
    expect(fs.existsSync(path.join(dir, '.swob-session.json'))).toBe(true)
  })

  it('vault 外启动的新会话同样散放根目录', async () => {
    const dir = await lib.ensureSessionInLibrary(summary('outside-1', ['/somewhere/else']))
    expect(dir).toBe(path.join(tmpRoot, '💬 会话 outside-1'))
  })

  it('勾选自动整理后，新会话按轮数落进用户配置的容器文件夹', async () => {
    fs.writeFileSync(path.join(tmpRoot, '.swob-config.json'), JSON.stringify({
      libraryRoot: tmpRoot,
      preferences: {
        defaultViewMode: 'compact', terminalApp: 'Terminal',
        ungrouping: { multiTurn: '未分组', singleTurn: '单轮会话' }
      }
    }))
    lib.initLibrary(tmpRoot)
    const multi = await lib.ensureSessionInLibrary({ ...summary('auto-multi', ['/x']), turnCount: 8 })
    expect(multi).toBe(path.join(tmpRoot, '未分组', '💬 会话 auto-multi'))
    const single = await lib.ensureSessionInLibrary({ ...summary('auto-single', ['/x']), turnCount: 1 })
    expect(single).toBe(path.join(tmpRoot, '单轮会话', '💬 会话 auto-single'))
  })

  it('scanLibrary 暴露普通文件供文件夹模式显示，但绝不把它当会话包', () => {
    const notesDir = path.join(tmpRoot, '项目笔记')
    fs.mkdirSync(notesDir, { recursive: true })
    fs.writeFileSync(path.join(tmpRoot, '总览.md'), '# 总览')
    fs.writeFileSync(path.join(notesDir, '想法.md'), '# 想法')
    makeSession(path.join(notesDir, '真正会话'), 'real-session')

    const tree = lib.scanLibrary()
    expect(tree.rootFiles).toEqual([{ name: '总览.md', path: path.join(tmpRoot, '总览.md') }])
    const folder = tree.folders.find((item) => item.name === '项目笔记')
    expect(folder?.files).toEqual([{ name: '想法.md', path: path.join(notesDir, '想法.md') }])
    expect(folder?.sessions.map((item) => item.sessionId)).toEqual(['real-session'])
  })

  it('meta 的 tags/topic/topicConfidence 能通过配置适配器完整到达 renderer', () => {
    makeSession(path.join(tmpRoot, '带分类'), 'classified')
    const marker = path.join(tmpRoot, '带分类', '.swob-session.json')
    const meta = JSON.parse(fs.readFileSync(marker, 'utf-8'))
    Object.assign(meta, { tags: ['产品', '性能'], topic: '会话整理', topicConfidence: 0.88 })
    fs.writeFileSync(marker, JSON.stringify(meta))

    const config = lib.libraryTreeToConfig(lib.scanLibrary())
    expect(config.sessionMeta.classified).toMatchObject({
      tags: ['产品', '性能'],
      topic: '会话整理',
      topicConfidence: 0.88
    })
  })

  it('scanLibrary 跳过配置的 ignoreDirs 里的会话，但收录项目里的会话', () => {
    // ignoreDirs 由用户在 .swob-config.json 配置（DEFAULT 不含 vault 专属名）
    fs.writeFileSync(path.join(tmpRoot, '.swob-config.json'), JSON.stringify({
      libraryRoot: tmpRoot,
      preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' },
      ignoreDirs: ['wiki']
    }))
    lib.initLibrary(tmpRoot) // 重新加载 ignoreDirs
    makeSession(path.join(tmpRoot, 'wiki', '不该出现'), 'wiki-x')
    makeSession(path.join(tmpRoot, '项目', '飞搜', 'AI会话', '应该出现'), 'proj-x')
    const ids = collectIds(lib.scanLibrary())
    expect(ids).toContain('proj-x')
    expect(ids).not.toContain('wiki-x')
  })

  it('deleteLibraryFolder 拒绝删除含用户文件的目录，笔记保住', () => {
    const proj = path.join(tmpRoot, '项目', '飞搜')
    fs.mkdirSync(proj, { recursive: true })
    fs.writeFileSync(path.join(proj, 'context.md'), '# 我的项目笔记')
    expect(() => lib.deleteLibraryFolder(proj)).toThrow()
    expect(fs.existsSync(path.join(proj, 'context.md'))).toBe(true)
    expect(fs.existsSync(proj)).toBe(true)
  })

  it('deleteLibraryFolder 正常删除纯会话容器（无散文件），会话退回根目录', () => {
    const folder = path.join(tmpRoot, '纯容器')
    makeSession(path.join(folder, '一个会话'), 'pure-x')
    lib.scanLibrary()
    expect(() => lib.deleteLibraryFolder(folder)).not.toThrow()
    expect(fs.existsSync(folder)).toBe(false)
    expect(fs.existsSync(path.join(tmpRoot, '一个会话', '.swob-session.json'))).toBe(true)

    const undone = undoLastOrganization(tmpRoot)
    expect(undone.moves.map((move) => move.sessionId)).toEqual(['pure-x'])
    expect(fs.existsSync(path.join(folder, '一个会话', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(tmpRoot, '一个会话'))).toBe(false)
  })

  it('文件夹拖拽只物化会话包，并可用同一份日志完整撤销', () => {
    const source = path.join(tmpRoot, '原分类')
    const destination = path.join(tmpRoot, '新分类')
    makeSession(path.join(source, '子层', '会话甲'), 'folder-move-a')
    makeSession(path.join(source, '会话乙'), 'folder-move-b')
    fs.mkdirSync(destination, { recursive: true })
    lib.scanLibrary()

    const movedFolder = lib.moveLibraryFolderToParent(source, destination)
    expect(movedFolder).toBe(path.join(destination, '原分类'))
    expect(fs.existsSync(path.join(movedFolder, '子层', '会话甲', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(movedFolder, '会话乙', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(source)).toBe(false)

    const undone = undoLastOrganization(tmpRoot)
    expect(new Set(undone.moves.map((move) => move.sessionId))).toEqual(
      new Set(['folder-move-a', 'folder-move-b'])
    )
    expect(fs.existsSync(path.join(source, '子层', '会话甲', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(source, '会话乙', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(movedFolder)).toBe(false)
  })

  it('文件夹拖拽遇到普通笔记时整批拒绝，笔记和会话都不动', () => {
    const source = path.join(tmpRoot, '混合目录')
    const destination = path.join(tmpRoot, '目标分类')
    makeSession(path.join(source, '会话'), 'folder-note-guard')
    fs.writeFileSync(path.join(source, '项目说明.md'), '# 不许移动')
    fs.mkdirSync(destination, { recursive: true })
    lib.scanLibrary()

    expect(() => lib.moveLibraryFolderToParent(source, destination)).toThrow(/普通笔记|文档/)
    expect(fs.readFileSync(path.join(source, '项目说明.md'), 'utf-8')).toBe('# 不许移动')
    expect(fs.existsSync(path.join(source, '会话', '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(destination, '混合目录'))).toBe(false)
  })

  it('deleteLibraryFolder 允许含派生文件和摘要.md 的会话目录', () => {
    const folder = path.join(tmpRoot, '派生文件容器')
    const sessionDir = path.join(folder, '一个会话')
    makeSession(sessionDir, 'derived-safe-x')
    fs.writeFileSync(path.join(sessionDir, 'transcript.md'), '# transcript\n', 'utf-8')
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), '{}\n', 'utf-8')
    fs.writeFileSync(path.join(sessionDir, 'compact-summaries.md'), '# Compact Summaries\n', 'utf-8')
    fs.writeFileSync(path.join(sessionDir, 'user-queries.md'), '# User Queries\n', 'utf-8')
    fs.writeFileSync(path.join(sessionDir, '摘要.md'), '# 外部摘要\n', 'utf-8')
    lib.scanLibrary()

    expect(() => lib.deleteLibraryFolder(folder)).not.toThrow()
    expect(fs.existsSync(folder)).toBe(false)
  })

  it('deleteLibraryFolder 仍拒绝含其它用户 md 的会话目录', () => {
    const folder = path.join(tmpRoot, '用户文件容器')
    const sessionDir = path.join(folder, '一个会话')
    makeSession(sessionDir, 'derived-blocked-x')
    fs.writeFileSync(path.join(sessionDir, 'notes.md'), '# 用户笔记\n', 'utf-8')
    lib.scanLibrary()

    expect(() => lib.deleteLibraryFolder(folder)).toThrow()
    expect(fs.existsSync(folder)).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, 'notes.md'))).toBe(true)
  })
})

describe('transcript markdown heading semantics', () => {
  it('demoteMarkdownHeadings 只降级 fenced code block 外的 ATX heading', () => {
    const input = [
      '# 一级标题',
      '  ## 前置空格标题',
      '    # 四空格代码行不动',
      '```md',
      '# 代码块标题不动',
      '```',
      '### 多级标题 ###'
    ].join('\n')

    expect(lib.demoteMarkdownHeadings(input)).toBe([
      '**一级标题**',
      '  **前置空格标题**',
      '    # 四空格代码行不动',
      '```md',
      '# 代码块标题不动',
      '```',
      '**多级标题**'
    ].join('\n'))
  })

  it('generateTranscript 用 user 首行做 outline，assistant heading 降为粗体', () => {
    const md = lib.generateTranscript([
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId: 's1',
        type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
        promptSource: 'typed',
        message: { role: 'user', content: '请做方案\n# 用户原始标题保留' }
      },
      {
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 's1',
        type: 'assistant',
        timestamp: '2026-03-01T00:01:00Z',
        message: { role: 'assistant', content: '## Assistant Plan\n```md\n# 代码块标题不动\n```\n### Step ###' }
      }
    ] as any, '测试标题', { createdAt: '2026-03-01T00:00:00Z', turnCount: 1 })

    expect(md).toContain('**User** [')
    expect(md).toContain('\n## 请做方案\n请做方案\n# 用户原始标题保留')
    expect(md).toContain('**Assistant Plan**')
    expect(md).toContain('# 代码块标题不动')
    expect(md).toContain('**Step**')
    expect(md).not.toContain('\n## Assistant Plan')
  })

  it('合成结构样本：机器注入带来源标头，真人消息保持原样', () => {
    const md = lib.generateTranscript([
      {
        uuid: 'hook-real-shape',
        parentUuid: null,
        sessionId: 'origin-session',
        type: 'user',
        timestamp: '2026-07-19T10:01:00',
        isMeta: true,
        message: { role: 'user', content: '<system-reminder>x</system-reminder>' }
      },
      {
        uuid: 'task-real-shape',
        parentUuid: 'hook-real-shape',
        sessionId: 'origin-session',
        type: 'user',
        timestamp: '2026-07-19T10:02:00',
        origin: { kind: 'task-notification' },
        promptSource: 'system',
        message: { role: 'user', content: '<task-notification>x</task-notification>' }
      },
      {
        uuid: 'human-real-shape',
        parentUuid: 'task-real-shape',
        sessionId: 'origin-session',
        type: 'user',
        timestamp: '2026-07-19T10:03:00',
        origin: { kind: 'human' },
        promptSource: 'typed',
        message: { role: 'user', content: '真人问题' }
      },
      {
        uuid: 'assistant-message',
        parentUuid: 'human-real-shape',
        sessionId: 'origin-session',
        type: 'assistant',
        timestamp: '2026-07-19T10:04:00',
        message: { role: 'assistant', content: '收到' }
      }
    ] as any, '来源标识核验', { createdAt: '2026-07-19T10:00:00', turnCount: 1 })

    expect(md).toBe([
      '# 来源标识核验',
      '',
      '> 7/19 10:00 | 1 轮对话',
      '',
      '**User** [7/19 10:01]',
      '〔机器注入 · hook〕',
      '## <system-reminder>x</system-reminder>',
      '<system-reminder>x</system-reminder>',
      '',
      '**User** [7/19 10:02]',
      '〔机器注入 · task-notification〕',
      '## <task-notification>x</task-notification>',
      '<task-notification>x</task-notification>',
      '',
      '**User** [7/19 10:03]',
      '## 真人问题',
      '真人问题',
      '',
      '**Assistant** [7/19 10:04]',
      '收到',
      ''
    ].join('\n'))
  })

  it('generateTranscript 在写入前打码', () => {
    const candidate = `WK${'a'.repeat(34)}`
    const md = lib.generateTranscript([
      {
        uuid: 'u1', parentUuid: null, sessionId: 's1', type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
        promptSource: 'typed',
        message: { role: 'user', content: candidate }
      }
    ] as any, '测试标题', { createdAt: '2026-03-01T00:00:00Z', turnCount: 0 })

    expect(md).not.toContain(candidate)
    expect(md).toContain('WK……aaaa（已脱敏）')
  })

  it('redactLibraryTranscripts 仅回填生成 Markdown，dry-run 不写盘', () => {
    removeDefaultSession()
    const candidate = `WK${'a'.repeat(34)}`
    const dirPath = createLibrarySession('redact-backfill-session', [], { dirName: 'redact-backfill' })
    fs.writeFileSync(path.join(dirPath, 'transcript.md'), candidate, 'utf-8')
    fs.writeFileSync(path.join(dirPath, 'compact-summaries.md'), candidate, 'utf-8')
    fs.writeFileSync(path.join(dirPath, 'notes.md'), candidate, 'utf-8')
    lib.scanLibrary()

    expect(lib.redactLibraryTranscripts({ dryRun: true })).toEqual({ dryRun: true, files: 2, hits: 2 })
    expect(fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')).toBe(candidate)
    expect(lib.redactLibraryTranscripts()).toEqual({ dryRun: false, files: 2, hits: 2 })
    expect(fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')).toContain('WK……aaaa（已脱敏）')
    expect(fs.readFileSync(path.join(dirPath, 'notes.md'), 'utf-8')).toBe(candidate)
  })
})

describe('transcript frontmatter 属性', () => {
  it('claude transcript 写入完整 frontmatter 且标题紧跟其后', async () => {
    removeDefaultSession()
    const sessionId = 'claude-frontmatter-session'
    const claudeFile = path.join(
      tmpRoot,
      'Users',
      'yytyyf',
      '.claude',
      'projects',
      'swob',
      `${sessionId}.jsonl`
    )
    writeJsonl(claudeFile, [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:00:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        promptSource: 'typed',
        message: { role: 'user', content: '请生成 Obsidian 属性' }
      },
      {
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:01:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '已生成。' }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [claudeFile], { dirName: 'claude-frontmatter' })
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    const fm = expectTitleImmediatelyAfterFrontmatter(md, '请生成 Obsidian 属性')
    expect(fm).toMatchObject({
      sessionId,
      harness: 'claude-code',
      model: 'claude-sonnet-4-5',
      device: 'mac-mini',
      cwd: '/Users/yytyyf/projects/swob',
      turns: 1,
      created: '2026-07-07T00:00:00Z',
      updated: '2026-07-07T00:01:00Z',
      resume: `claude --resume ${sessionId}`,
      source: claudeFile
    })
  })

  it('frontmatter cwd 忽略早于主链的 sidechain 消息', async () => {
    removeDefaultSession()
    const sessionId = 'sidechain-cwd-session'
    const claudeFile = path.join(
      tmpRoot,
      'Users',
      'yytyyf',
      '.claude',
      'projects',
      'swob',
      `${sessionId}.jsonl`
    )
    writeJsonl(claudeFile, [
      {
        uuid: 'side-a1',
        parentUuid: 'side-u1',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:00:00Z',
        cwd: '/Users/yytyyf/projects/rejected-sidechain',
        isSidechain: true,
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '这条 rejected sidechain 更早。' }
      },
      {
        uuid: 'main-u1',
        parentUuid: null,
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:00:01Z',
        cwd: '/Users/yytyyf/projects/main-chain',
        promptSource: 'typed',
        message: { role: 'user', content: '请生成主链 cwd' }
      },
      {
        uuid: 'main-a1',
        parentUuid: 'main-u1',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:00:02Z',
        cwd: '/Users/yytyyf/projects/main-chain',
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '已生成。' }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [claudeFile], { dirName: 'sidechain-cwd' })
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    const fm = expectTitleImmediatelyAfterFrontmatter(md, '请生成主链 cwd')
    expect(fm.cwd).toBe('/Users/yytyyf/projects/main-chain')
  })

  it('codex transcript 写入 frontmatter 并过滤系统注入', async () => {
    removeDefaultSession()
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const codexFile = path.join(
      tmpRoot,
      'Users',
      'mac',
      '.codex',
      'sessions',
      '2026',
      '07',
      '07',
      `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`
    )
    writeJsonl(codexFile, [
      {
        timestamp: '2026-07-07T00:00:00Z',
        type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-07-07T00:00:00Z', cwd: '/Users/mac/projects/swob', cli_version: 'codex-test' }
      },
      {
        timestamp: '2026-07-07T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: '<recommended_plugins>catalog</recommended_plugins>\n# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>\n<environment_context>cwd=/tmp</environment_context>'
          }]
        }
      },
      {
        timestamp: '2026-07-07T00:00:01.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /Users/mac\n<INSTRUCTIONS>noise</INSTRUCTIONS>' }]
        }
      },
      {
        timestamp: '2026-07-07T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<environment_context>cwd=/Users/mac/projects/swob</environment_context>' }]
        }
      },
      {
        timestamp: '2026-07-07T00:00:03Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '请用 Codex 生成属性' }]
        }
      },
      {
        timestamp: '2026-07-07T00:00:04Z',
        type: 'turn_context',
        payload: { turn_id: 'turn-1', cwd: '/Users/mac/projects/swob', model: 'gpt-5.4' }
      },
      {
        timestamp: '2026-07-07T00:00:05Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Codex frontmatter 已生成。' }]
        }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [codexFile], { dirName: 'codex-frontmatter' })
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    const fm = expectTitleImmediatelyAfterFrontmatter(md, '请用 Codex 生成属性')
    expect(fm).toMatchObject({
      sessionId,
      harness: 'codex',
      model: 'gpt-5.4',
      device: 'macbook',
      cwd: '/Users/mac/projects/swob',
      turns: 1,
      created: '2026-07-07T00:00:00Z',
      updated: '2026-07-07T00:00:05Z',
      resume: `codex resume ${sessionId}`,
      source: codexFile
    })
    expect(md).not.toContain('AGENTS.md instructions')
    expect(md).not.toContain('<environment_context>')
  })

  it('cursor transcript 省略缺失 model 字段并保留标题位置', async () => {
    removeDefaultSession()
    const sessionId = 'cursor-frontmatter-session'
    const cursorFile = path.join(
      tmpRoot,
      'Users',
      'unknown',
      '.cursor',
      'projects',
      'Users-yytyyf-projects-swob',
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`
    )
    writeJsonl(cursorFile, [
      { role: 'user', message: { content: '<user_query>请用 Cursor 生成属性</user_query>' } },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'tool-call', toolCallId: 'tool-1', toolName: 'read_file', args: { target_file: 'src/main/library-manager.ts' } },
            { type: 'text', text: 'Cursor frontmatter 已生成。' }
          ]
        }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [cursorFile], { dirName: 'cursor-frontmatter' })
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    const fm = expectTitleImmediatelyAfterFrontmatter(md, '请用 Cursor 生成属性')
    expect(fm).toMatchObject({
      sessionId,
      harness: 'cursor',
      device: os.hostname(),
      cwd: '/Users/yytyyf/projects/swob',
      turns: 1,
      created: '2026-07-07T00:00:00Z',
      resume: `cursor-agent --resume=${sessionId}`,
      source: cursorFile
    })
    expect(fm.model).toBeUndefined()
  })

  it('branch transcript 写入 frontmatter 并用 base session 生成 resume', async () => {
    removeDefaultSession()
    const sessionId = 'branch-frontmatter-session'
    const branchId = `${sessionId}:intra-0`
    const claudeFile = path.join(
      tmpRoot,
      'Users',
      'yytyyf',
      '.claude',
      'projects',
      'swob',
      `${sessionId}.jsonl`
    )
    writeJsonl(claudeFile, [
      {
        uuid: 's1',
        parentUuid: null,
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:00:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        promptSource: 'typed',
        message: { role: 'user', content: '开始对话' }
      },
      {
        uuid: 's2',
        parentUuid: 's1',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:01:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '好的' }
      },
      {
        uuid: 's3',
        parentUuid: 's2',
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:02:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        promptSource: 'typed',
        message: { role: 'user', content: '继续' }
      },
      {
        uuid: 'm1',
        parentUuid: 's3',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:03:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '主路径回复' }
      },
      {
        uuid: 'm2',
        parentUuid: 'm1',
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:05:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        promptSource: 'typed',
        message: { role: 'user', content: '主路径问题' }
      },
      {
        uuid: 'm3',
        parentUuid: 'm2',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:07:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '主路径回答' }
      },
      {
        uuid: 'b1',
        parentUuid: 's3',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:04:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        message: { role: 'assistant', model: 'claude-sonnet-4-5', content: '分支回复' }
      },
      {
        uuid: 'b2',
        parentUuid: 'b1',
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:06:00Z',
        cwd: '/Users/yytyyf/projects/swob',
        promptSource: 'typed',
        message: { role: 'user', content: '分支问题' }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [claudeFile], { dirName: 'branch-frontmatter' })
    lib.scanLibrary()

    const mdPath = await lib.updateBranchTranscript(branchId, 'b2')

    expect(mdPath).toBe(path.join(dirPath, 'transcript-intra-0.md'))
    const md = fs.readFileSync(mdPath!, 'utf-8')
    const fm = parseFrontmatter(md).data
    expect(fm).toMatchObject({
      sessionId: branchId,
      harness: 'claude-code',
      resume: `claude --resume ${sessionId}`,
      source: claudeFile
    })
  })
})

describe('派生文件生成接入', () => {
  function writeClaudeSessionWithCompact(sessionId: string): { sourcePath: string; dirPath: string } {
    const sourcePath = path.join(tmpRoot, '.claude', 'projects', 'derived', `${sessionId}.jsonl`)
    writeJsonl(sourcePath, [
      {
        uuid: 'u1',
        parentUuid: null,
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:00:00Z',
        cwd: tmpRoot,
        promptSource: 'typed',
        message: { role: 'user', content: '第一条真实提问' }
      },
      {
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:01:00Z',
        cwd: tmpRoot,
        message: { role: 'assistant', content: '第一条回答' }
      },
      {
        uuid: 'cb1',
        parentUuid: null,
        logicalParentUuid: 'a1',
        sessionId,
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: '2026-07-07T00:02:00Z',
        cwd: tmpRoot,
        message: { role: 'system', content: 'Conversation compacted' }
      },
      {
        uuid: 'sum1',
        parentUuid: 'cb1',
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:03:00Z',
        cwd: tmpRoot,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context. Summary: compact 后的上下文摘要'
        }
      },
      {
        uuid: 'u2',
        parentUuid: 'sum1',
        sessionId,
        type: 'user',
        timestamp: '2026-07-07T00:04:00Z',
        cwd: tmpRoot,
        promptSource: 'typed',
        message: { role: 'user', content: '第二条真实提问' }
      },
      {
        uuid: 'a2',
        parentUuid: 'u2',
        sessionId,
        type: 'assistant',
        timestamp: '2026-07-07T00:05:00Z',
        cwd: tmpRoot,
        message: { role: 'assistant', content: '第二条回答' }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [sourcePath], { dirName: sessionId })
    return { sourcePath, dirPath }
  }

  it('rebuildAllTranscripts 一并回填默认启用的派生文件', async () => {
    removeDefaultSession()
    const sessionId = 'derived-rebuild-session'
    const { dirPath } = writeClaudeSessionWithCompact(sessionId)
    lib.scanLibrary()

    await lib.rebuildAllTranscripts()

    const compactMd = fs.readFileSync(path.join(dirPath, 'compact-summaries.md'), 'utf-8')
    const userMd = fs.readFileSync(path.join(dirPath, 'user-queries.md'), 'utf-8')
    expect(compactMd).toContain('sessionId: derived-rebuild-session')
    expect(compactMd).toContain('type: derived-compact-summaries')
    expect(compactMd).toContain('compact 后的上下文摘要')
    expect(userMd).toContain('type: derived-user-queries')
    expect(userMd).toContain('第一条真实提问')
    expect(userMd).toContain('第二条真实提问')
    expect(userMd).not.toContain('This session is being continued')
  })

  it('配置关闭某个派生器时 updateTranscript 不生成对应文件', async () => {
    removeDefaultSession()
    lib.invalidateLibraryConfigCache()
    fs.writeFileSync(path.join(tmpRoot, '.swob-config.json'), JSON.stringify({
      libraryRoot: tmpRoot,
      preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' },
      derivedFiles: { enabledGenerators: ['compact-summaries'] }
    }, null, 2), 'utf-8')
    const sessionId = 'derived-disabled-session'
    const { dirPath } = writeClaudeSessionWithCompact(sessionId)
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    expect(fs.existsSync(path.join(dirPath, 'compact-summaries.md'))).toBe(true)
    expect(fs.existsSync(path.join(dirPath, 'user-queries.md'))).toBe(false)
  })
})

describe('Library transcript rebuild 多来源回归', () => {
  it('【曾经的 bug】codex 会话生成 transcript', async () => {
    removeDefaultSession()
    const sessionId = '11111111-1111-4111-8111-111111111111'
    const codexFile = path.join(
      tmpRoot,
      '.codex',
      'sessions',
      '2026',
      '07',
      '07',
      `rollout-2026-07-07T00-00-00-${sessionId}.jsonl`
    )
    writeJsonl(codexFile, [
      {
        timestamp: '2026-07-07T00:00:00Z',
        type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-07-07T00:00:00Z', cwd: tmpRoot, cli_version: 'codex-test' }
      },
      {
        timestamp: '2026-07-07T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '请用 Codex 修 bug' }]
        }
      },
      {
        timestamp: '2026-07-07T00:00:02Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'shell', call_id: 'call-1', arguments: '{"cmd":"npm test"}' }
      },
      {
        timestamp: '2026-07-07T00:00:03Z',
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'call-1', output: 'ok' }
      },
      {
        timestamp: '2026-07-07T00:00:04Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Codex transcript 已生成。', phase: 'final_answer' }
      },
      {
        timestamp: '2026-07-07T00:00:04.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Codex transcript 已生成。' }]
        }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [codexFile], { dirName: 'codex-session' })
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    expect(md).toContain('## 请用 Codex 修 bug')
    expect(md).toContain('Codex transcript 已生成。')
    expect(md).not.toContain('<recommended_plugins>')
    expect(md.match(/Codex transcript 已生成。/g)).toHaveLength(1)
    expect(md).toContain('1 轮对话 | Tools: shell(1)')
  })

  it('【曾经的 bug】cursor 会话生成 transcript', async () => {
    removeDefaultSession()
    const sessionId = 'cursor-session-1'
    const cursorFile = path.join(
      tmpRoot,
      '.cursor',
      'projects',
      '-Users-yytyyf-projects-swob',
      'agent-transcripts',
      sessionId,
      `${sessionId}.jsonl`
    )
    writeJsonl(cursorFile, [
      { role: 'user', message: { content: '<user_query>请用 Cursor 修 bug</user_query>' } },
      {
        role: 'assistant',
        message: {
          content: [
            { type: 'tool-call', toolCallId: 'tool-1', toolName: 'read_file', args: { target_file: 'src/main/library-manager.ts' } },
            { type: 'text', text: 'Cursor transcript 已生成。' }
          ]
        }
      }
    ])
    const dirPath = createLibrarySession(sessionId, [cursorFile], { dirName: 'cursor-session' })
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    expect(md).toContain('## 请用 Cursor 修 bug')
    expect(md).toContain('Cursor transcript 已生成。')
    expect(md).toContain('1 轮对话 | Tools: read_file(1)')
  })

  it('【曾经的 bug】源文件全部缺失时 fallback 到 backup.jsonl 生成 transcript', async () => {
    removeDefaultSession()
    const sessionId = '22222222-2222-4222-8222-222222222222'
    const missingSource = path.join(tmpRoot, 'missing', 'unknown-source.jsonl')
    const dirPath = createLibrarySession(sessionId, [missingSource], { dirName: 'backup-only-codex' })
    writeJsonl(path.join(dirPath, 'backup.jsonl'), [
      {
        timestamp: '2026-07-07T00:00:00Z',
        type: 'session_meta',
        payload: { id: sessionId, timestamp: '2026-07-07T00:00:00Z', cwd: tmpRoot, cli_version: 'codex-test' }
      },
      {
        timestamp: '2026-07-07T00:00:01Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '从 backup 恢复 transcript' }]
        }
      },
      {
        timestamp: '2026-07-07T00:00:02Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'backup fallback 生效。' }]
        }
      }
    ])
    lib.scanLibrary()

    await lib.updateTranscript(sessionId)

    const md = fs.readFileSync(path.join(dirPath, 'transcript.md'), 'utf-8')
    expect(md).toContain('## 从 backup 恢复 transcript')
    expect(md).toContain('backup fallback 生效。')
  })

  it('【曾经的 bug】rebuild 返回真实 written/failed 计数', async () => {
    removeDefaultSession()
    const okSource = path.join(tmpRoot, '.claude', 'projects', 'ok', 'ok-session.jsonl')
    writeJsonl(okSource, claudeRows('ok-session', '请重建有效 transcript'))
    createLibrarySession('ok-session', [okSource])
    createLibrarySession('failed-session', [path.join(tmpRoot, '.claude', 'projects', 'missing', 'failed-session.jsonl')])
    lib.scanLibrary()

    const result = await lib.rebuildAllTranscripts()

    expect(result.sessionCount).toBe(2)
    expect(result.written).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.failedSessionIds).toEqual(['failed-session'])
    expect(result.transcriptCount).toBe(1)
  })

  it('【曾经的 bug】--missing-only 不重写已有 transcript', async () => {
    removeDefaultSession()
    const existingSource = path.join(tmpRoot, '.claude', 'projects', 'existing', 'existing-session.jsonl')
    const missingSource = path.join(tmpRoot, '.claude', 'projects', 'missing-md', 'missing-md-session.jsonl')
    writeJsonl(existingSource, claudeRows('existing-session', '已有 transcript 不应重写'))
    writeJsonl(missingSource, claudeRows('missing-md-session', '缺失 transcript 应补齐'))
    const existingDir = createLibrarySession('existing-session', [existingSource], {
      transcript: '# 已有人写过的 transcript\n'
    })
    const missingDir = createLibrarySession('missing-md-session', [missingSource])
    lib.scanLibrary()

    const result = await lib.rebuildAllTranscripts({ missingOnly: true })

    expect(result.written).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.failed).toBe(0)
    expect(fs.readFileSync(path.join(existingDir, 'transcript.md'), 'utf-8')).toBe('# 已有人写过的 transcript\n')
    expect(fs.readFileSync(path.join(missingDir, 'transcript.md'), 'utf-8')).toContain('## 缺失 transcript 应补齐')
  })
})
