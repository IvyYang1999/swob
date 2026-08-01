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
    expect(librarySurface).toContain("fs.promises.open(tempPath, 'r+')")
    expect(librarySurface).not.toContain("fs.promises.open(tempPath, 'r')")

    expect(source).toContain('function requireWritableSessionDir(')
    expect(source).toContain('assertCurrentSessionWriteAuthorized(dirPath, meta)')
    expect(source).toContain('writeSafeLibraryFileSync(_root, mdPath')
  })

  it('keeps worker and CLI writes behind manager APIs', () => {
    const worker = fs.readFileSync(path.join(__dirname, 'library-worker.ts'), 'utf-8')
    const cli = fs.readFileSync(path.join(__dirname, '..', 'cli', 'index.ts'), 'utf-8')
    for (const source of [worker, cli]) expect(source).not.toContain('.swob-session.json')
    expect(worker).not.toMatch(/\bfs\.(?:writeFile|writeFileSync|createWriteStream)\s*\(/)
    expect(worker).toMatch(/ensureSessionInLibrary\s*\(/)
    expect(worker).toMatch(/syncBackup\s*\(/)
    expect(cli).toContain('rebuildAllTranscripts')
    expect(cli).toContain('redactLibraryTranscripts')
  })

  it('keeps organizer IPC and raw filesystem transactions behind an explicit manager gate', () => {
    const index = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf-8')
    const organizer = fs.readFileSync(path.join(__dirname, 'vault-organizer.ts'), 'utf-8')
    expect(index).not.toMatch(/\b(?:executeOrganization|undoLastOrganization)\s*\(/)
    expect(index).toContain('applyLibraryOrganization(')
    expect(index).toContain('undoLastLibraryOrganization()')
    expect(organizer).toContain('gate.authorizeMoves(moves)')
    expect(organizer).toContain('gate.authorizeMoves(appliedMoves)')
  })
})
