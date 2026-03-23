/**
 * config-store.ts 测试
 *
 * 每个测试用例都对应一个你手动操作时发现过的 bug。
 * 测试名称用你会说的话来写，不用技术术语。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createFolder, moveFolder, deleteFolder, addSessionToFolder } from './config-store'
import type { UserConfig } from './types'

// 每个测试开始前创建一个干净的 config（不碰真实文件）
function freshConfig(): UserConfig {
  return {
    folders: [],
    sessionMeta: {},
    preferences: { defaultViewMode: 'compact', terminalApp: 'Terminal' }
  }
}

// 用环境变量指向临时目录，避免污染真实 config
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-config-test-'))
process.env.HOME = tmpDir

describe('创建子文件夹', () => {
  it('【曾经的 bug】创建子文件夹时 parentId 必须被保存', () => {
    // 这个 bug 之前导致所有子文件夹都变成了顶级文件夹
    // 因为 IPC 位置参数中 undefined 的 color 参数导致 parentId 位移
    let config = freshConfig()
    config = createFolder(config, { name: '父文件夹' })
    const parentId = config.folders[0].id

    config = createFolder(config, { name: '子文件夹', parentId })

    const child = config.folders.find(f => f.name === '子文件夹')
    expect(child).toBeDefined()
    // 关键断言：parentId 不能丢！
    expect(child!.parentId).toBe(parentId)
  })

  it('不传 color 也不能影响 parentId', () => {
    // 旧代码用位置参数 (name, color, parentId)
    // 不传 color 时 parentId 会变成第二个参数
    let config = freshConfig()
    config = createFolder(config, { name: '父' })
    const parentId = config.folders[0].id

    // 注意：没有传 color
    config = createFolder(config, { name: '子', parentId })

    expect(config.folders[1].parentId).toBe(parentId)
    expect(config.folders[1].color).toBeUndefined()
  })

  it('顶级文件夹的 parentId 应该是 null', () => {
    let config = freshConfig()
    config = createFolder(config, { name: '顶级文件夹' })

    expect(config.folders[0].parentId).toBeNull()
  })
})

describe('移动文件夹', () => {
  it('把文件夹移到另一个文件夹下面', () => {
    let config = freshConfig()
    config = createFolder(config, { name: 'A' })
    config = createFolder(config, { name: 'B' })
    const idA = config.folders[0].id
    const idB = config.folders[1].id

    config = moveFolder(config, idB, idA)

    expect(config.folders.find(f => f.id === idB)!.parentId).toBe(idA)
  })

  it('【防御】不能把文件夹移到自己的子文件夹下面（会死循环）', () => {
    let config = freshConfig()
    config = createFolder(config, { name: '爷爷' })
    const grandpaId = config.folders[0].id
    config = createFolder(config, { name: '爸爸', parentId: grandpaId })
    const parentId = config.folders[1].id
    config = createFolder(config, { name: '孙子', parentId })
    const childId = config.folders[2].id

    // 试图把爷爷移到孙子下面 → 应该被拒绝
    config = moveFolder(config, grandpaId, childId)

    // 爷爷的 parentId 不应该变
    expect(config.folders.find(f => f.id === grandpaId)!.parentId).toBeNull()
  })
})

describe('删除文件夹', () => {
  it('删除父文件夹时子文件夹也应该被删除', () => {
    let config = freshConfig()
    config = createFolder(config, { name: '父' })
    const parentId = config.folders[0].id
    config = createFolder(config, { name: '子', parentId })

    config = deleteFolder(config, parentId)

    expect(config.folders).toHaveLength(0)
  })

  it('删除父文件夹时，孙子文件夹也要被级联删除', () => {
    let config = freshConfig()
    config = createFolder(config, { name: 'A' })
    const idA = config.folders[0].id
    config = createFolder(config, { name: 'B', parentId: idA })
    const idB = config.folders[1].id
    config = createFolder(config, { name: 'C', parentId: idB })

    config = deleteFolder(config, idA)

    // A、B、C 全部被删除
    expect(config.folders).toHaveLength(0)
  })
})

describe('Session 移入文件夹', () => {
  it('把 session 从一个文件夹移到另一个', () => {
    let config = freshConfig()
    config = createFolder(config, { name: '文件夹A' })
    config = createFolder(config, { name: '文件夹B' })

    config = addSessionToFolder(config, config.folders[0].id, 'session-1')
    expect(config.folders[0].sessionIds).toContain('session-1')

    // 移到文件夹B
    config = addSessionToFolder(config, config.folders[1].id, 'session-1')

    // 应该从A中移除，出现在B中
    expect(config.folders[0].sessionIds).not.toContain('session-1')
    expect(config.folders[1].sessionIds).toContain('session-1')
  })

  it('同一个 session 不能在同一个文件夹里出现两次', () => {
    let config = freshConfig()
    config = createFolder(config, { name: '文件夹' })
    const folderId = config.folders[0].id

    config = addSessionToFolder(config, folderId, 'session-1')
    config = addSessionToFolder(config, folderId, 'session-1')

    expect(config.folders[0].sessionIds.filter(id => id === 'session-1')).toHaveLength(1)
  })
})
