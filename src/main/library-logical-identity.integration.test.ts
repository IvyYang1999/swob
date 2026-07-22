import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildLogicalSessionIdentityFromSummary } from './library-session-identity'

const savedHome = process.env.HOME
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-logical-home-'))
process.env.HOME = testHome

let root: string
let lib: typeof import('./library-manager')

function summary(
  sessionId: string,
  sourcePath: string,
  overrides: Record<string, unknown> = {}
): any {
  return {
    id: sessionId,
    sessionId,
    source: 'claude-code',
    filePath: sourcePath,
    allFilePaths: [sourcePath],
    firstUserMessage: 'logical identity fixture',
    createdAt: '2026-07-22T00:00:00.000Z',
    updatedAt: '2026-07-22T00:01:00.000Z',
    projectPath: '/fixture/project',
    cwds: ['/fixture/project'],
    turnCount: 1,
    ...overrides
  }
}

function writeJsonl(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, `${JSON.stringify({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: path.basename(filePath, '.jsonl'),
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: text }
  })}\n`)
}

function packageDirs(): string[] {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, '.swob-session.json')))
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-logical-library-'))
  lib = await import('./library-manager')
  lib.initLibrary(root)
  lib.scanLibrary()
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

afterAll(() => {
  process.env.HOME = savedHome
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe('Library logical identity integration', () => {
  it('rebinds an externally moved active package and never creates a (2) package', async () => {
    const sessionId = '10000000-0000-4000-8000-000000000001'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    writeJsonl(sourcePath, 'first')
    const firstDir = await lib.ensureSessionInLibrary(summary(sessionId, sourcePath))
    await lib.syncBackup(sessionId, firstDir)
    const beforeMeta = JSON.parse(fs.readFileSync(path.join(firstDir, '.swob-session.json'), 'utf-8'))

    const movedDir = path.join(root, 'Finder renamed package')
    fs.renameSync(firstDir, movedDir)
    writeJsonl(sourcePath, 'second')
    const rebound = await lib.ensureSessionInLibrary(summary(sessionId, sourcePath, {
      updatedAt: '2026-07-22T00:02:00.000Z',
      turnCount: 2
    }))
    await lib.syncBackup(sessionId, rebound)

    expect(rebound).toBe(movedDir)
    expect(packageDirs()).toEqual([movedDir])
    const afterMeta = JSON.parse(fs.readFileSync(path.join(movedDir, '.swob-session.json'), 'utf-8'))
    expect(afterMeta.packageId).toBe(beforeMeta.packageId)
    expect(afterMeta.logicalIdentity).toEqual(beforeMeta.logicalIdentity)
    expect(fs.readFileSync(path.join(movedDir, 'backup.jsonl'), 'utf-8')).toContain('second')
  })

  it('keeps all duplicate candidates read-only and does not create a third package', async () => {
    const sessionId = '20000000-0000-4000-8000-000000000002'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const session = summary(sessionId, sourcePath)
    const firstDir = await lib.ensureSessionInLibrary(session)
    const secondDir = path.join(root, 'duplicate copy')
    fs.cpSync(firstDir, secondDir, { recursive: true })
    const firstBefore = fs.readFileSync(path.join(firstDir, '.swob-session.json'), 'utf-8')
    const secondBefore = fs.readFileSync(path.join(secondDir, '.swob-session.json'), 'utf-8')
    lib.scanLibrary()

    await expect(lib.ensureSessionInLibrary({ ...session, updatedAt: '2026-07-22T00:03:00.000Z' }))
      .rejects.toBeInstanceOf(lib.SessionIdentityConflictError)
    await expect(lib.syncBackup(sessionId)).rejects.toBeInstanceOf(lib.SessionIdentityConflictError)
    expect(packageDirs()).toHaveLength(2)
    expect(fs.readFileSync(path.join(firstDir, '.swob-session.json'), 'utf-8')).toBe(firstBefore)
    expect(fs.readFileSync(path.join(secondDir, '.swob-session.json'), 'utf-8')).toBe(secondBefore)
    expect(lib.getLibrarySessionRegistryDiagnostics()[0].state).toBe('conflict')
  })

  it('allows the same source sessionId in distinct verified instances but makes legacy ID APIs ambiguous', async () => {
    const sessionId = '30000000-0000-4000-8000-000000000003'
    const alphaPath = path.join(testHome, '.claude-window', 'alpha', 'projects', '-fixture', `${sessionId}.jsonl`)
    const betaPath = path.join(testHome, '.claude-window', 'beta', 'projects', '-fixture', `${sessionId}.jsonl`)
    const alphaDir = await lib.ensureSessionInLibrary(summary(sessionId, alphaPath))
    const betaDir = await lib.ensureSessionInLibrary(summary(sessionId, betaPath))

    expect(betaDir).not.toBe(alphaDir)
    expect(packageDirs()).toHaveLength(2)
    expect(lib.resolveSessionBinding(sessionId).state).toBe('ambiguous')
    await expect(lib.updateTranscript(sessionId)).rejects.toBeInstanceOf(lib.SessionIdentityAmbiguousError)
  })

  it('does not backfill packageId or schema while scanning a legacy manifest', () => {
    const dirPath = path.join(root, 'legacy package')
    fs.mkdirSync(dirPath)
    const manifestPath = path.join(dirPath, '.swob-session.json')
    const content = JSON.stringify({
      sessionId: 'legacy-no-package-id',
      sourceFilePaths: ['/unknown/legacy-no-package-id.jsonl'],
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      projectPath: '/unknown'
    }, null, 2)
    fs.writeFileSync(manifestPath, content)
    lib.scanLibrary()
    expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(content)
  })

  it('fails closed for symlink-only, corrupt, and iCloud-placeholder package evidence', async () => {
    const sessionId = '40000000-0000-4000-8000-000000000004'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const session = summary(sessionId, sourcePath)
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-external-package-'))
    try {
      const logicalIdentity = buildLogicalSessionIdentityFromSummary(session)
      fs.writeFileSync(path.join(externalDir, '.swob-session.json'), JSON.stringify({
        schemaVersion: 3,
        packageId: randomUUID(),
        logicalIdentity,
        sessionId,
        sourceFilePaths: [sourcePath],
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        projectPath: session.projectPath
      }))
      fs.symlinkSync(externalDir, path.join(root, 'symlink-only'))
      lib.scanLibrary()
      await expect(lib.ensureSessionInLibrary(session)).rejects.toBeInstanceOf(lib.SessionIdentityConflictError)
      expect(packageDirs()).toHaveLength(0)
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true })
    }

    fs.rmSync(path.join(root, 'symlink-only'), { force: true })
    const corruptDir = path.join(root, 'corrupt')
    fs.mkdirSync(corruptDir)
    fs.writeFileSync(path.join(corruptDir, '.swob-session.json'), '{')
    await expect(lib.ensureSessionInLibrary(summary('corrupt-target', path.join(
      testHome, '.claude', 'projects', '-fixture', 'corrupt-target.jsonl'
    )))).rejects.toBeInstanceOf(lib.SessionIdentityUnresolvedError)

    fs.rmSync(corruptDir, { recursive: true, force: true })
    const cloudDir = path.join(root, 'cloud-placeholder')
    fs.mkdirSync(cloudDir)
    fs.writeFileSync(path.join(cloudDir, '.swob-session.json.icloud'), '')
    await expect(lib.ensureSessionInLibrary(summary('cloud-target', path.join(
      testHome, '.claude', 'projects', '-fixture', 'cloud-target.jsonl'
    )))).rejects.toBeInstanceOf(lib.SessionIdentityUnresolvedError)
  })
})

