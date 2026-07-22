import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  buildProjectOrganizationPreview,
  executeOrganization,
  sanitizeRelativeFolder,
  undoLastOrganization,
  type OrganizationInput
} from './vault-organizer'

let root: string
const allowWrites = { authorizeMoves: (): void => {} }

function createSession(name: string, sessionId = name, meta: Record<string, unknown> = {}): string {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.swob-session.json'), JSON.stringify({
    sessionId,
    sourceFilePaths: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    projectPath: '/Users/yyt/projects/swob',
    ...meta
  }, null, 2))
  fs.writeFileSync(path.join(dir, 'transcript.md'), '# test')
  return dir
}

function operationFiles(): string[] {
  const dir = path.join(root, '.swob', 'operations')
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : []
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-organizer-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Vault 整理事务', () => {
  it('先持久化 undo 清单，再移动带 marker 的会话包', () => {
    const sourceDir = createSession('原位置', 'session-a')
    let observedPlannedLog = false

    const result = executeOrganization(root, 'project', [{
      sessionId: 'session-a',
      sourceDir,
      targetRelativeFolder: 'swob'
    }], allowWrites, {
      beforeFirstMove: (logPath) => {
        const log = JSON.parse(fs.readFileSync(logPath, 'utf-8'))
        observedPlannedLog = log.status === 'planned' && fs.existsSync(sourceDir)
      }
    })

    expect(observedPlannedLog).toBe(true)
    expect(result.moves).toHaveLength(1)
    expect(fs.existsSync(result.moves[0].to)).toBe(true)
    expect(fs.existsSync(sourceDir)).toBe(false)
    expect(operationFiles()).toHaveLength(1)
  })

  it('拒绝移动没有 .swob-session.json 的普通笔记目录', () => {
    const noteDir = path.join(root, '我的笔记')
    fs.mkdirSync(noteDir)
    fs.writeFileSync(path.join(noteDir, '想法.md'), '不能动')

    expect(() => executeOrganization(root, 'manual', [{
      sessionId: 'not-a-session',
      sourceDir: noteDir,
      targetRelativeFolder: '目标'
    }], allowWrites)).toThrow(/会话包标记/)

    expect(fs.readFileSync(path.join(noteDir, '想法.md'), 'utf-8')).toBe('不能动')
    expect(operationFiles()).toHaveLength(0)
  })

  it('智能整理写入 topic/tags/置信度，撤销同时恢复路径和原 meta', () => {
    const sourceDir = createSession('待整理', 'session-smart', { tags: ['旧标签'], topic: '旧话题' })
    const input: OrganizationInput = {
      sessionId: 'session-smart',
      sourceDir,
      targetRelativeFolder: '工程/性能',
      metaPatch: { tags: ['性能', 'Electron'], topic: '性能优化', topicConfidence: 0.93 }
    }

    const applied = executeOrganization(root, 'smart', [input], allowWrites)
    const movedMeta = JSON.parse(fs.readFileSync(path.join(applied.moves[0].to, '.swob-session.json'), 'utf-8'))
    expect(movedMeta).toMatchObject({ tags: ['性能', 'Electron'], topic: '性能优化', topicConfidence: 0.93 })

    const undone = undoLastOrganization(root, allowWrites)
    expect(undone.moves).toHaveLength(1)
    expect(fs.existsSync(sourceDir)).toBe(true)
    const restoredMeta = JSON.parse(fs.readFileSync(path.join(sourceDir, '.swob-session.json'), 'utf-8'))
    expect(restoredMeta).toMatchObject({ tags: ['旧标签'], topic: '旧话题' })
    expect(restoredMeta.topicConfidence).toBeUndefined()
  })

  it('批量重命名把目录名和 customTitle 放进同一个可撤销事务', () => {
    const first = createSession('旧标题一', 'rename-a', { customTitle: '旧标题一' })
    const second = createSession('旧标题二', 'rename-b')

    const applied = executeOrganization(root, 'manual', [
      {
        sessionId: 'rename-a',
        sourceDir: first,
        targetRelativeFolder: '.',
        targetBaseName: '新标题一',
        metaPatch: { customTitle: '新标题一' }
      },
      {
        sessionId: 'rename-b',
        sourceDir: second,
        targetRelativeFolder: '.',
        targetBaseName: '新标题二',
        metaPatch: { customTitle: '新标题二' }
      }
    ], allowWrites)

    expect(applied.moves).toHaveLength(2)
    expect(operationFiles()).toHaveLength(1)
    expect(applied.moves.map((move) => path.basename(move.to))).toEqual(['新标题一', '新标题二'])
    expect(JSON.parse(fs.readFileSync(path.join(applied.moves[1].to, '.swob-session.json'), 'utf-8')).customTitle).toBe('新标题二')

    const undone = undoLastOrganization(root, allowWrites)
    expect(undone.moves).toHaveLength(2)
    expect(fs.existsSync(first)).toBe(true)
    expect(fs.existsSync(second)).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(first, '.swob-session.json'), 'utf-8')).customTitle).toBe('旧标题一')
    expect(JSON.parse(fs.readFileSync(path.join(second, '.swob-session.json'), 'utf-8')).customTitle).toBeUndefined()
  })

  it('预检整批输入，任何非法项都不会造成部分移动', () => {
    const valid = createSession('合法会话', 'valid')
    const invalid = path.join(root, '普通目录')
    fs.mkdirSync(invalid)

    expect(() => executeOrganization(root, 'project', [
      { sessionId: 'valid', sourceDir: valid, targetRelativeFolder: '项目A' },
      { sessionId: 'invalid', sourceDir: invalid, targetRelativeFolder: '项目B' }
    ], allowWrites)).toThrow()

    expect(fs.existsSync(valid)).toBe(true)
    expect(operationFiles()).toHaveLength(0)
  })

  it('项目预览使用友好项目名且完全只读', () => {
    const sourceDir = createSession('未分类会话', 'preview')
    const before = fs.readdirSync(root)
    const preview = buildProjectOrganizationPreview(root, [{
      id: 'preview',
      sessionId: 'preview',
      cwds: ['/Users/yyt/projects/swob'],
      projectPath: '/Users/yyt/.claude/projects/-Users-yyt-projects-swob',
      firstUserMessage: '整理这个会话',
      libraryDirPath: sourceDir
    }])

    expect(preview).toMatchObject([{ sessionId: 'preview', targetRelativeFolder: 'swob' }])
    expect(fs.readdirSync(root)).toEqual(before)
  })

  it('目标文件夹拒绝绝对路径和路径穿越', () => {
    expect(() => sanitizeRelativeFolder('../逃逸')).toThrow()
    expect(() => sanitizeRelativeFolder('/tmp/逃逸')).toThrow()
    expect(sanitizeRelativeFolder('产品 / 性能')).toBe(path.join('产品', '性能'))
  })
})
