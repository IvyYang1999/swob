import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { LibraryPathUnsafeError, writeSafeLibraryFileSync } from './library-path-safety'

const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Library path safety', () => {
  it('detects an ancestor swap after validation and writes no content outside the Library', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-path-root-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-path-outside-'))
    cleanup.push(root, outside)
    const parent = path.join(root, 'package')
    const parked = path.join(root, 'package-parked')
    const target = path.join(parent, 'transcript.md')
    fs.mkdirSync(parent)

    expect(() => writeSafeLibraryFileSync(root, target, 'must-not-escape', {
      beforeOpen: () => {
        fs.renameSync(parent, parked)
        fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
      }
    })).toThrow(LibraryPathUnsafeError)

    expect(fs.existsSync(path.join(outside, 'transcript.md'))).toBe(false)
    expect(fs.existsSync(path.join(parked, 'transcript.md'))).toBe(false)
  })
})
