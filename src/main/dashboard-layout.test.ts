import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDefaultDashboardLayout,
  getDashboardLayoutPath,
  readDashboardLayout,
  writeDashboardLayout
} from './dashboard-layout'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-dashboard-layout-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('dashboard layout persistence', () => {
  it('文件不存在时返回独立的默认布局副本', () => {
    const root = makeRoot()
    const first = readDashboardLayout(root)
    const second = readDashboardLayout(root)
    expect(first).toEqual(createDefaultDashboardLayout())
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
  })

  it('合法布局可原子写入并完整往返', () => {
    const root = makeRoot()
    const layout = createDefaultDashboardLayout()
    layout.pages.overview.sections.find((section) => section.id === 'breakdowns')!.widgetIds.reverse()

    const saved = writeDashboardLayout(root, layout)
    expect(saved).toEqual(layout)
    expect(readDashboardLayout(root)).toEqual(layout)
    expect(fs.statSync(getDashboardLayoutPath(root)).mode & 0o777).toBe(0o600)
  })

  it('JSON 损坏或结构非法时回退完整默认布局', () => {
    const root = makeRoot()
    const filePath = getDashboardLayoutPath(root)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '{partial')
    expect(readDashboardLayout(root)).toEqual(createDefaultDashboardLayout())

    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, pages: { overview: 'broken' } }))
    expect(readDashboardLayout(root)).toEqual(createDefaultDashboardLayout())
  })

  it('拒绝写入未知 widget，避免拼写错误静默清空仪表盘', () => {
    const root = makeRoot()
    const layout = createDefaultDashboardLayout()
    layout.pages.overview.sections[0].widgetIds.push('unknown.widget')
    expect(() => writeDashboardLayout(root, layout)).toThrow(/invalid dashboard layout/i)
  })

  it('拒绝跟随 .swob 或 dashboard.json 符号链接写出 Library 边界', () => {
    const root = makeRoot()
    const outside = makeRoot()
    fs.symlinkSync(outside, path.join(root, '.swob'))
    expect(() => writeDashboardLayout(root, createDefaultDashboardLayout())).toThrow(/symbolic link/i)

    const secondRoot = makeRoot()
    const swobDir = path.join(secondRoot, '.swob')
    fs.mkdirSync(swobDir)
    const outsideFile = path.join(outside, 'outside.json')
    fs.writeFileSync(outsideFile, 'unchanged')
    fs.symlinkSync(outsideFile, getDashboardLayoutPath(secondRoot))
    expect(() => writeDashboardLayout(secondRoot, createDefaultDashboardLayout())).toThrow(/symbolic link/i)
    expect(fs.readFileSync(outsideFile, 'utf8')).toBe('unchanged')
  })
})
