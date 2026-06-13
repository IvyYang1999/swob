/**
 * 会话落点决策测试。
 * 核心不变量：会话永不落在库根本身；vault 内按启动目录归档，vault 外进中央桶。
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import {
  resolveSessionParent,
  isIgnoredPath,
  DEFAULT_IGNORE_DIRS,
  SESSION_FOLDER
} from './session-placement'

const VAULT = '/Users/me/Documents/main'
// 用户在 .swob-config.json 里配的忽略名单（DEFAULT 只含通用垃圾目录，不含 vault 专属名）
const ignore = new Set(['wiki', 'clipii', '附件', 'node_modules'])
const central = path.join(VAULT, SESSION_FOLDER)

describe('DEFAULT_IGNORE_DIRS（开源默认值，不得含 vault 专属目录名）', () => {
  it('只含通用垃圾目录，不硬编码 wiki/clipii 等', () => {
    expect(DEFAULT_IGNORE_DIRS).not.toContain('wiki')
    expect(DEFAULT_IGNORE_DIRS).not.toContain('clipii')
    expect(DEFAULT_IGNORE_DIRS).toContain('node_modules')
  })
})

describe('resolveSessionParent', () => {
  it('vault 内项目目录启动 → <cwd>/AI会话', () => {
    const cwd = path.join(VAULT, '项目', '飞搜')
    expect(resolveSessionParent([cwd], VAULT, ignore)).toBe(path.join(cwd, SESSION_FOLDER))
  })

  it('vault 内更深的目录启动 → 仍在该目录下的 AI会话', () => {
    const cwd = path.join(VAULT, '项目', '飞搜', '子模块')
    expect(resolveSessionParent([cwd], VAULT, ignore)).toBe(path.join(cwd, SESSION_FOLDER))
  })

  it('vault 外启动 → 中央桶 <root>/AI会话', () => {
    expect(resolveSessionParent(['/Users/me/projects/飞搜'], VAULT, ignore)).toBe(central)
  })

  it('就是 vault 根启动 → 中央桶（不落在根本身）', () => {
    expect(resolveSessionParent([VAULT], VAULT, ignore)).toBe(central)
  })

  it('忽略目录里启动（如 wiki）→ 中央桶，避免落进 swob 扫不到的地方', () => {
    const cwd = path.join(VAULT, 'wiki', '某概念')
    expect(resolveSessionParent([cwd], VAULT, ignore)).toBe(central)
  })

  it('无 cwd → 中央桶', () => {
    expect(resolveSessionParent([], VAULT, ignore)).toBe(central)
    expect(resolveSessionParent(undefined, VAULT, ignore)).toBe(central)
  })

  it('取第一个有效 cwd 作为启动目录', () => {
    const first = path.join(VAULT, '项目', '飞搜')
    const second = path.join(VAULT, '项目', '别的')
    expect(resolveSessionParent(['', '  ', first, second], VAULT, ignore)).toBe(
      path.join(first, SESSION_FOLDER)
    )
  })

  it('库根本身就是 AI会话 目录（迁移前旧配置）→ 中央桶 = 库根，不嵌套', () => {
    const oldRoot = path.join(VAULT, SESSION_FOLDER)  // .../main/AI会话
    expect(resolveSessionParent(['/outside'], oldRoot, ignore)).toBe(oldRoot)
    expect(resolveSessionParent([], oldRoot, ignore)).toBe(oldRoot)
  })

  it('无论如何都不会把会话落在库根本身', () => {
    const cases = [[VAULT], ['/outside'], [], [path.join(VAULT, 'clipii')]]
    for (const c of cases) {
      expect(resolveSessionParent(c, VAULT, ignore)).not.toBe(VAULT)
    }
  })
})

describe('isIgnoredPath', () => {
  it('命中任一段忽略名 → true', () => {
    expect(isIgnoredPath(path.join(VAULT, 'clipii', 'x'), VAULT, ignore)).toBe(true)
    expect(isIgnoredPath(path.join(VAULT, '附件'), VAULT, ignore)).toBe(true)
  })
  it('项目目录不在忽略名单 → false', () => {
    expect(isIgnoredPath(path.join(VAULT, '项目', '飞搜'), VAULT, ignore)).toBe(false)
  })
  it('root 外的路径 → false', () => {
    expect(isIgnoredPath('/elsewhere/wiki', VAULT, ignore)).toBe(false)
  })
})
