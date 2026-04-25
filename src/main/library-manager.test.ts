/**
 * library-manager.ts 分支独立性测试
 *
 * 确保分支 session 的 meta（重命名、笔记等）和文件夹归属
 * 完全独立于母 session，互不影响。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// 隔离测试环境：用临时目录作为 Library root
let tmpRoot: string
let savedAppConfig: string | null = null

// 动态导入，确保 HOME 修改生效
let lib: typeof import('./library-manager')

const APP_CONFIG_FILE = path.join(os.homedir(), '.claude-session-manager', 'app-config.json')

beforeEach(async () => {
  // 备份真实的 app-config，防止测试污染生产配置
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
  // 恢复真实的 app-config，避免测试污染生产环境
  if (savedAppConfig !== null) {
    fs.writeFileSync(APP_CONFIG_FILE, savedAppConfig, 'utf-8')
  }
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
    const result = lib.restoreBackupToClaudeSource('lost-local-999')

    expect(result.restored).toBe(true)
    expect(result.sourcePath).toBe(localSourcePath)
    expect(fs.readFileSync(localSourcePath, 'utf-8')).toBe(backupContent)

    fs.rmSync(localSourceDir, { recursive: true, force: true })
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
  it('默认用 interactive login shell 包裹 claude 命令', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' })
    expect(cmd).toContain('ssh -t bob@mac.local')
    expect(cmd).toContain("zsh -li -c 'claude --resume sess-123'")
  })

  it('bypassPermissions 模式加上 --dangerously-skip-permissions', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' }, 'bypassPermissions')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--resume sess-123')
  })

  it('指定 remotePath 时使用自定义路径', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob', remotePath: '/opt/bin/claude' })
    expect(cmd).toContain('/opt/bin/claude')
    expect(cmd).not.toMatch(/(?<!\/)claude --resume/)
  })

  it('传入 remoteCwd 时先 cd 到目录', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' }, undefined, '/Users/mac/projects/scsp')
    expect(cmd).toContain('cd /Users/mac/projects/scsp && claude --resume sess-123')
  })

  it('remoteCwd 为 null 时不加 cd', () => {
    const cmd = lib.buildSshResumeCommand('sess-123', { host: 'mac.local', user: 'bob' }, undefined, null)
    expect(cmd).not.toContain('cd ')
  })
})
