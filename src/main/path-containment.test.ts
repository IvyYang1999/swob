import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPathWithinAllowedRoots,
  PathContainmentError,
  resolvePathWithinRoot
} from './path-containment'

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('path containment', () => {
  it('accepts descendants but rejects traversal, absolute escape, root, and prefix collisions', () => {
    const parent = tempDir('swob-containment-')
    const root = path.join(parent, 'Library')
    fs.mkdirSync(path.join(root, 'folder'), { recursive: true })

    expect(resolvePathWithinRoot(root, 'folder')).toBe(path.join(root, 'folder'))
    expect(() => resolvePathWithinRoot(root, '../outside')).toThrow(PathContainmentError)
    expect(() => resolvePathWithinRoot(root, path.join(parent, 'outside'))).toThrow(PathContainmentError)
    expect(() => resolvePathWithinRoot(root, '', { allowRoot: false })).toThrow(PathContainmentError)
    expect(() => resolvePathWithinRoot(root, root, { allowRoot: false })).toThrow(PathContainmentError)
    expect(() => resolvePathWithinRoot(root, `${root}-evil/file`)).toThrow(PathContainmentError)
  })

  it('rejects an existing symlink and a not-yet-created child that escape the root', () => {
    const parent = tempDir('swob-containment-symlink-')
    const root = path.join(parent, 'Library')
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(root)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(root, 'escape'))

    expect(() => resolvePathWithinRoot(root, 'escape')).toThrow(/symlink/)
    expect(() => resolvePathWithinRoot(root, 'escape/new-file.md')).toThrow(/symlink/)
  })

  it('does not let an internally constructed cache fallback follow a symlink outside its root', () => {
    const parent = tempDir('swob-containment-cache-')
    const cache = path.join(parent, 'image-cache')
    const outside = path.join(parent, 'outside')
    fs.mkdirSync(path.join(cache, 'safe'), { recursive: true })
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(cache, 'redirect'))

    expect(resolvePathWithinRoot(cache, path.join('safe', 'image.png'), {
      allowRoot: false,
      allowAbsolute: false
    })).toBe(path.join(cache, 'safe', 'image.png'))
    expect(() => resolvePathWithinRoot(cache, path.join('redirect', 'image.png'), {
      allowRoot: false,
      allowAbsolute: false
    })).toThrow(/symlink/)
  })

  it('requires absolute IPC paths and accepts any explicitly allowed root', () => {
    const parent = tempDir('swob-containment-roots-')
    const library = path.join(parent, 'Library')
    const project = path.join(parent, 'project')
    fs.mkdirSync(library)
    fs.mkdirSync(project)

    expect(assertPathWithinAllowedRoots(path.join(project, 'a.ts'), [library, project]))
      .toBe(path.join(project, 'a.ts'))
    expect(() => assertPathWithinAllowedRoots('../a.ts', [library, project])).toThrow(/absolute/)
  })
})
