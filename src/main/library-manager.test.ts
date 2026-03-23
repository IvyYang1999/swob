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

// 动态导入，确保 HOME 修改生效
let lib: typeof import('./library-manager')

beforeEach(async () => {
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
