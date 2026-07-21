import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { migrateVault, validateMigrationTarget } from './vault-migrator'

let workDir: string
let source: string

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-migrate-test-'))
  source = path.join(workDir, 'old-vault')
  fs.mkdirSync(path.join(source, '💬 会话甲'), { recursive: true })
  fs.writeFileSync(path.join(source, '💬 会话甲', '.swob-session.json'), JSON.stringify({ sessionId: 'a1' }))
  fs.writeFileSync(path.join(source, '💬 会话甲', 'backup.jsonl'), '{"row":1}\n')
  fs.mkdirSync(path.join(source, '项目', '子层'), { recursive: true })
  fs.writeFileSync(path.join(source, '项目', '子层', '笔记.md'), '# 笔记\n')
  fs.writeFileSync(path.join(source, '.swob-config.json'), JSON.stringify({ libraryRoot: source }))
})

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('迁移目标校验', () => {
  it('拒绝迁移到库内部、上级目录、同一位置和非空目录', () => {
    expect(validateMigrationTarget(source, source)).toBeTruthy()
    expect(validateMigrationTarget(source, path.join(source, 'sub'))).toBeTruthy()
    expect(validateMigrationTarget(source, workDir)).toBeTruthy()
    const occupied = path.join(workDir, 'occupied')
    fs.mkdirSync(occupied)
    fs.writeFileSync(path.join(occupied, 'x.txt'), 'x')
    expect(validateMigrationTarget(source, occupied)).toBeTruthy()
    expect(validateMigrationTarget(source, path.join(workDir, 'new-vault'))).toBeNull()
  })
})

describe('vault 完整迁移', () => {
  it('复制全部文件、通过校验、留 MOVED.md、不动源库', () => {
    const target = path.join(workDir, 'new-vault')
    const progressPhases: string[] = []
    const result = migrateVault(source, target, (p) => progressPhases.push(p.phase))

    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(target, '💬 会话甲', 'backup.jsonl'), 'utf-8')).toBe('{"row":1}\n')
    expect(fs.existsSync(path.join(target, '项目', '子层', '笔记.md'))).toBe(true)
    expect(fs.existsSync(path.join(source, '💬 会话甲', 'backup.jsonl'))).toBe(true)
    expect(fs.readFileSync(path.join(source, 'MOVED.md'), 'utf-8')).toContain(target)
    expect(progressPhases).toContain('copying')
    expect(progressPhases).toContain('verifying')
    expect(progressPhases.at(-1)).toBe('done')
  })

  it('vault 内部符号链接跟随迁移指向新家', () => {
    fs.symlinkSync(path.join(source, '💬 会话甲'), path.join(source, '项目', '快捷方式'))
    const target = path.join(workDir, 'new-vault')
    const result = migrateVault(source, target)
    expect(result.ok).toBe(true)
    const migratedLink = fs.readlinkSync(path.join(target, '项目', '快捷方式'))
    expect(migratedLink).toBe(path.join(target, '💬 会话甲'))
  })

  it('目标已存在文件时拒绝并不动源库', () => {
    const occupied = path.join(workDir, 'occupied')
    fs.mkdirSync(occupied)
    fs.writeFileSync(path.join(occupied, 'existing.txt'), 'keep')
    const result = migrateVault(source, occupied)
    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(source, 'MOVED.md'))).toBe(false)
    expect(fs.readFileSync(path.join(occupied, 'existing.txt'), 'utf-8')).toBe('keep')
  })
})
