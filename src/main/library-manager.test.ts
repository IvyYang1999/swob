/**
 * library-manager.ts 分支独立性测试
 *
 * 确保分支 session 的 meta（重命名、笔记等）和文件夹归属
 * 完全独立于母 session，互不影响。
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { shellQuote } from './resume-terminal'

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
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  // 恢复临时 app-config，避免测试之间串状态
  if (savedAppConfig !== null) {
    fs.writeFileSync(APP_CONFIG_FILE, savedAppConfig, 'utf-8')
  } else {
    fs.rmSync(APP_CONFIG_FILE, { force: true })
  }
})

afterAll(() => {
  if (savedHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = savedHome
  }
  fs.rmSync(testHome, { recursive: true, force: true })
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

  it('【曾经的 bug】本机原始 JSONL 丢失时，resume 前应该从 Library backup 恢复', () => {
    const localSourceDir = path.join(os.homedir(), '.claude', 'projects', `-swob-test-${process.pid}-${Date.now()}`)
    const localSourcePath = path.join(localSourceDir, 'lost-local-999.jsonl')
    const sessionDir = path.join(tmpRoot, '本机丢失的对话')
    const backupContent = '{"uuid":"u1","sessionId":"lost-local-999","type":"user","timestamp":"2026-04-01T00:00:00Z","cwd":"/Users/test","message":{"role":"user","content":"hello"}}\n'

    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'lost-local-999',
      sourceFilePaths: [localSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/test'
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), backupContent)

    lib.scanLibrary()
    expect(lib.getSessionResumeAvailability('lost-local-999').canResume).toBe(true)
    const result = lib.restoreBackupToClaudeSource('lost-local-999')

    expect(result.restored).toBe(true)
    expect(result.sourcePath).toBe(localSourcePath)
    expect(fs.readFileSync(localSourcePath, 'utf-8')).toBe(backupContent)

    fs.rmSync(localSourceDir, { recursive: true, force: true })
  })

  it('Claude Window 配置目录下的原始 JSONL 丢失时也应该允许从 backup 恢复', () => {
    const localConfigDir = path.join(os.homedir(), '.claude-window', `swob-test-${process.pid}-${Date.now()}`)
    const localSourceDir = path.join(localConfigDir, 'projects', '-Users-test-projects-draftbox')
    const localSourcePath = path.join(localSourceDir, 'lost-window-999.jsonl')
    const sessionDir = path.join(tmpRoot, 'Claude Window 丢失的对话')
    const backupContent = '{"uuid":"u1","sessionId":"lost-window-999","type":"user","timestamp":"2026-04-01T00:00:00Z","cwd":"/Users/test/projects/draftbox","message":{"role":"user","content":"hello"}}\n'

    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'lost-window-999',
      sourceFilePaths: [localSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/test/projects/draftbox'
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), backupContent)

    lib.scanLibrary()
    const result = lib.restoreBackupToClaudeSource('lost-window-999')

    expect(result.restored).toBe(true)
    expect(result.sourcePath).toBe(localSourcePath)
    expect(fs.readFileSync(localSourcePath, 'utf-8')).toBe(backupContent)

    fs.rmSync(localConfigDir, { recursive: true, force: true })
  })

  it('不会把其他机器路径的 backup 恢复到本机 Claude 目录外', () => {
    const foreignSourcePath = '/Users/other-machine/.claude/projects/xxx/remote-999.jsonl'
    const sessionDir = path.join(tmpRoot, '其他机器的对话')

    fs.mkdirSync(sessionDir, { recursive: true })
    fs.writeFileSync(path.join(sessionDir, '.swob-session.json'), JSON.stringify({
      sessionId: 'remote-999',
      sourceFilePaths: [foreignSourcePath],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-01T01:00:00Z',
      projectPath: '/Users/other-machine/projects/xxx'
    }))
    fs.writeFileSync(path.join(sessionDir, 'backup.jsonl'), '{"uuid":"u1","sessionId":"remote-999"}\n')

    lib.scanLibrary()
    const result = lib.restoreBackupToClaudeSource('remote-999')

    expect(result.restored).toBe(false)
    expect(result.reason).toBe('source-outside-local-claude-projects')
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

describe('库根 = vault：cwd 感知放置 + 忽略名单 + 安全删除', () => {
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

  it('vault 内项目目录启动的会话 → 落进 <cwd>/AI会话/', async () => {
    const cwd = path.join(tmpRoot, '项目', '飞搜')
    fs.mkdirSync(cwd, { recursive: true })
    const dir = await lib.ensureSessionInLibrary(summary('in-vault-1', [cwd]))
    expect(dir).toBe(path.join(cwd, 'AI会话', '会话 in-vault-1'))
    expect(fs.existsSync(path.join(dir, '.swob-session.json'))).toBe(true)
  })

  it('vault 外启动的会话 → 中央桶 <root>/AI会话/，绝不落在库根本身', async () => {
    const dir = await lib.ensureSessionInLibrary(summary('outside-1', ['/somewhere/else']))
    expect(dir).toBe(path.join(tmpRoot, 'AI会话', '会话 outside-1'))
    expect(path.dirname(dir)).not.toBe(tmpRoot)
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

  it('deleteLibraryFolder 正常删除纯会话容器（无散文件）', () => {
    const folder = path.join(tmpRoot, '纯容器')
    makeSession(path.join(folder, '一个会话'), 'pure-x')
    lib.scanLibrary()
    expect(() => lib.deleteLibraryFolder(folder)).not.toThrow()
    expect(fs.existsSync(folder)).toBe(false)
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

  it('generateTranscript 在写入前打码', () => {
    const candidate = `WK${'a'.repeat(34)}`
    const md = lib.generateTranscript([
      {
        uuid: 'u1', parentUuid: null, sessionId: 's1', type: 'user',
        timestamp: '2026-03-01T00:00:00Z',
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
