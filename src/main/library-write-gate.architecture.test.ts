import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('Library session write architecture', () => {
  it('forbids raw file writes in the Library manager write surface', () => {
    const managerPath = path.join(__dirname, 'library-manager.ts')
    const source = fs.readFileSync(managerPath, 'utf-8')
    const librarySurface = source.slice(source.indexOf('// ============ Library Manager ============'))

    // Session create/update/backup/transcript/meta/redaction/rebuild must use
    // the containment + fsync primitive, never add a new raw write bypass.
    expect(librarySurface).not.toMatch(/\bfs\.writeFileSync\s*\(/)
    expect(librarySurface).not.toMatch(/\bfs\.promises\.writeFile\s*\(/)
    expect(librarySurface).not.toMatch(/copyFile\s*\(\s*sourcePath\s*,\s*backupPath/)
    expect(librarySurface).not.toMatch(/createWriteStream\s*\(\s*backupPath\s*,\s*\{\s*flags:/)

    expect(source).toContain('function requireWritableSessionDir(')
    expect(source).toContain('assertCurrentSessionWriteAuthorized(dirPath, meta)')
    expect(source).toContain('writeSafeLibraryFileSync(_root, mdPath')
  })

  it('keeps worker and CLI writes behind manager APIs', () => {
    const worker = fs.readFileSync(path.join(__dirname, 'library-worker.ts'), 'utf-8')
    const cli = fs.readFileSync(path.join(__dirname, '..', 'cli', 'index.ts'), 'utf-8')
    for (const source of [worker, cli]) expect(source).not.toContain('.swob-session.json')
    expect(worker).not.toMatch(/\bfs\.(?:writeFile|writeFileSync|createWriteStream)\s*\(/)
    expect(worker).toContain('ensureSessionInLibrary(summary)')
    expect(worker).toContain('syncBackup(summary.sessionId, dirPath)')
    expect(cli).toContain('rebuildAllTranscripts')
    expect(cli).toContain('redactLibraryTranscripts')
  })
})
