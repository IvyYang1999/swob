import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  createSessionFolderReference,
  sanitizeLibraryEntryName
} from './library-manager'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
})

describe.skipIf(process.platform !== 'win32')('Windows native filesystem integration', () => {
  it('creates a real directory junction without Developer Mode', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-native-junction-'))
    roots.push(root)
    const target = path.join(root, '💬 Native Session')
    const folder = path.join(root, 'Folder')
    const link = path.join(folder, '💬 Native Session')
    fs.mkdirSync(target, { recursive: true })
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(target, 'marker.txt'), 'junction-target', 'utf8')

    createSessionFolderReference(target, link)

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(path.join(link, 'marker.txt'), 'utf8')).toBe('junction-target')
    expect(path.win32.normalize(fs.realpathSync(link)).toLowerCase())
      .toBe(path.win32.normalize(fs.realpathSync(target)).toLowerCase())
  })

  it('materializes sanitized reserved names and emoji on the Windows filesystem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-native-names-'))
    roots.push(root)

    const names = ['CON', 'PRN.txt', 'report...   ', '💬 中文会话'].map(sanitizeLibraryEntryName)
    for (const name of names) fs.mkdirSync(path.join(root, name))

    expect(names).toEqual(['_CON', '_PRN.txt', 'report', '💬 中文会话'])
    expect(fs.readdirSync(root).sort()).toEqual([...names].sort())
  })

  it('flushes copied backup candidates through a writable handle', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-native-backup-sync-'))
    roots.push(root)
    const source = path.join(root, 'source.jsonl')
    const candidate = path.join(root, 'backup.jsonl.tmp')
    fs.writeFileSync(source, '{"type":"user"}\n', 'utf8')
    await fs.promises.copyFile(source, candidate, fs.constants.COPYFILE_EXCL)

    const handle = await fs.promises.open(candidate, 'r+')
    try {
      await expect(handle.sync()).resolves.toBeUndefined()
    } finally {
      await handle.close()
    }
    expect(fs.readFileSync(candidate, 'utf8')).toBe('{"type":"user"}\n')
  })
})
