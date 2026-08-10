import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { buildLogicalSessionIdentityFromSummary, logicalSessionKey } from './library-session-identity'

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

function directoryEvidence(dirPath: string): Record<string, { sha256: string; mtimeMs: number }> {
  const result: Record<string, { sha256: string; mtimeMs: number }> = {}
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (entry.isFile()) {
        result[path.relative(dirPath, fullPath)] = {
          sha256: createHash('sha256').update(fs.readFileSync(fullPath)).digest('hex'),
          mtimeMs: fs.statSync(fullPath).mtimeMs
        }
      }
    }
  }
  visit(dirPath)
  return result
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

  it.each(['conflict-first', 'healthy-first'] as const)(
    'keeps a conflict group read-only while batch sync continues for unrelated sessions (%s)',
    async (order) => {
    const conflictId = '21000000-0000-4000-8000-000000000002'
    const healthyId = '22000000-0000-4000-8000-000000000002'
    const conflictSource = path.join(testHome, '.claude', 'projects', '-fixture', `${conflictId}.jsonl`)
    const healthySource = path.join(testHome, '.claude', 'projects', '-fixture', `${healthyId}.jsonl`)
    writeJsonl(conflictSource, 'conflicting source')
    writeJsonl(healthySource, 'healthy source')

    const conflictSummary = summary(conflictId, conflictSource)
    const firstConflictDir = await lib.ensureSessionInLibrary(conflictSummary)
    const secondConflictDir = path.join(root, 'authorized historical duplicate')
    fs.cpSync(firstConflictDir, secondConflictDir, { recursive: true })
    lib.scanLibrary()
    const firstBefore = directoryEvidence(firstConflictDir)
    const secondBefore = directoryEvidence(secondConflictDir)
    const progress: string[] = []
    const healthySummary = summary(healthyId, healthySource)
    const input = order === 'conflict-first'
      ? [conflictSummary, healthySummary]
      : [healthySummary, conflictSummary]

    const outcome = await lib.syncLibraryFromSessions(
      input,
      {},
      ({ sessionId }) => progress.push(sessionId)
    )

    const healthyDir = lib.getSessionDirPath(healthyId)
    expect(healthyDir).toBeTruthy()
    expect(fs.readFileSync(path.join(healthyDir!, 'transcript.md'), 'utf8')).toContain('healthy source')
    expect(fs.readFileSync(path.join(healthyDir!, 'backup.jsonl'), 'utf8')).toContain('healthy source')
    expect(directoryEvidence(firstConflictDir)).toEqual(firstBefore)
    expect(directoryEvidence(secondConflictDir)).toEqual(secondBefore)
    expect(progress).toEqual(input.map((session) => session.sessionId))
    expect(outcome).toEqual({
      total: 2,
      completed: 2,
      skipped: [{
        sessionId: conflictId,
        code: 'SESSION_IDENTITY_CONFLICT',
        disposition: 'handled',
        retryable: false
      }]
    })
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
      await expect(lib.ensureSessionInLibrary(session)).rejects.toBeInstanceOf(lib.SessionIdentityUnresolvedError)
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

  it('keeps a committed identity conservatively missing after its package disappears', async () => {
    // ensureSessionInLibrary commits a package-id reservation, so a vanished
    // package with a committed reservation stays fail-closed (true MISSING).
    const sessionId = '60000000-0000-4000-8000-000000000006'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const session = summary(sessionId, sourcePath)
    const originalDir = await lib.ensureSessionInLibrary(session)
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-temporarily-missing-'))
    const movedDir = path.join(outside, 'moved-package')
    try {
      fs.renameSync(originalDir, movedDir)
      lib.scanLibrary()
      await expect(lib.ensureSessionInLibrary(session)).rejects.toBeInstanceOf(lib.SessionIdentityMissingError)
      expect(packageDirs()).toHaveLength(0)
    } finally {
      if (fs.existsSync(movedDir)) fs.renameSync(movedDir, originalDir)
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('allows first-time recreation for a seen-only identity with no committed reservation', async () => {
    // Simulates the migration-stranded case: a past scan recorded seen
    // evidence, but no package-id reservation was ever committed and no
    // package entity survives anywhere. Blocking recreation forever would
    // make the session permanently un-archivable; recreation from the live
    // source is lossless.
    const sessionId = '61000000-0000-4000-8000-000000000061'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
    fs.writeFileSync(sourcePath, JSON.stringify({ type: 'user', sessionId }) + '\n')
    const session = summary(sessionId, sourcePath)
    const logicalIdentity = buildLogicalSessionIdentityFromSummary(session)
    const planted = createHash('sha256').update(logicalSessionKey(logicalIdentity)).digest('hex')
    // Plant seen-only evidence directly (no reservation, no package).
    const evidenceDir = path.join(root, '.swob', 'logical-sessions')
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, `${planted}.seen.json`), JSON.stringify({
      schemaVersion: 1,
      logicalKeyHash: planted,
      firstObservedAt: '2026-08-01T00:00:00.000Z'
    }))
    lib.scanLibrary()
    const created = await lib.ensureSessionInLibrary(session)
    expect(fs.existsSync(path.join(created, '.swob-session.json'))).toBe(true)
    // Idempotent replay: a second ensure must bind to the recreated package
    // instead of creating a duplicate.
    const replayed = await lib.ensureSessionInLibrary(session)
    expect(replayed).toBe(created)
    expect(packageDirs()).toEqual([created])
  })

  it('treats unreadable directories as typed scan blockers rather than empty collections', async () => {
    const blockedDir = path.join(root, 'permission-denied')
    fs.mkdirSync(blockedDir)
    fs.chmodSync(blockedDir, 0o000)
    try {
      const sessionId = '70000000-0000-4000-8000-000000000007'
      const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
      await expect(lib.ensureSessionInLibrary(summary(sessionId, sourcePath)))
        .rejects.toBeInstanceOf(lib.SessionIdentityUnresolvedError)
      expect(packageDirs()).toHaveLength(0)
    } finally {
      fs.chmodSync(blockedDir, 0o700)
    }
  })

  it('rejects a symlink Library root before creating lock or package evidence outside it', async () => {
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-root-target-'))
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-root-link-'))
    const linkedRoot = path.join(linkParent, 'library')
    fs.symlinkSync(externalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      expect(() => lib.initLibrary(linkedRoot)).toThrow(lib.LibraryPathUnsafeError)
      expect(fs.existsSync(path.join(externalRoot, '.swob'))).toBe(false)
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true })
      fs.rmSync(externalRoot, { recursive: true, force: true })
      lib.initLibrary(root)
      lib.scanLibrary()
    }
  })

  it('rejects a symlink storage container before the first external write', async () => {
    const externalContainer = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-container-target-'))
    const containerName = 'managed-container'
    fs.symlinkSync(externalContainer, path.join(root, containerName), process.platform === 'win32' ? 'junction' : 'dir')
    lib.saveLibraryConfig({
      libraryRoot: root,
      preferences: {
        defaultViewMode: 'compact',
        terminalApp: 'Terminal',
        ungrouping: { multiTurn: containerName, singleTurn: containerName }
      }
    })
    try {
      const sessionId = '80000000-0000-4000-8000-000000000008'
      const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
      await expect(lib.ensureSessionInLibrary(summary(sessionId, sourcePath)))
        .rejects.toBeInstanceOf(lib.LibraryPathUnsafeError)
      expect(fs.readdirSync(externalContainer)).toEqual([])
    } finally {
      fs.rmSync(externalContainer, { recursive: true, force: true })
    }
  })

  it('atomically reserves a publish directory without replacing a competitor empty target', async () => {
    const sessionId = '90000000-0000-4000-8000-000000000009'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const competitorDir = path.join(root, '💬 competitor target')

    const created = await lib.ensureSessionInLibrary(summary(sessionId, sourcePath, {
      firstUserMessage: 'competitor target'
    }), undefined, undefined, {
      onStage: (stage) => {
        if (stage === 'before-publish-reservation') fs.mkdirSync(competitorDir)
      }
    })
    expect(created).not.toBe(competitorDir)
    expect(fs.readdirSync(competitorDir)).toEqual([])
    expect(fs.existsSync(path.join(created, '.swob-session.json'))).toBe(true)
  })

  it('bounds packageId collision retries before any second visible package is written', async () => {
    const packageId = 'fixed-package-id-collision'
    const firstId = 'a0000000-0000-4000-8000-00000000000a'
    const secondId = 'b0000000-0000-4000-8000-00000000000b'
    await lib.ensureSessionInLibrary(summary(firstId, path.join(
      testHome, '.claude', 'projects', '-fixture', `${firstId}.jsonl`
    )), undefined, undefined, { packageIdFactory: () => packageId })

    await expect(lib.ensureSessionInLibrary(summary(secondId, path.join(
      testHome, '.claude', 'projects', '-fixture', `${secondId}.jsonl`
    )), undefined, undefined, { packageIdFactory: () => packageId }))
      .rejects.toBeInstanceOf(lib.SessionPackageIdCollisionError)
    expect(packageDirs()).toHaveLength(1)
  })

  it('releases an owned packageId reservation when publishing fails before directory reservation', async () => {
    const packageId = 'retryable-package-id'
    const sessionId = 'aa000000-0000-4000-8000-0000000000aa'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const session = summary(sessionId, sourcePath)

    await expect(lib.ensureSessionInLibrary(session, undefined, undefined, {
      packageIdFactory: () => packageId,
      onStage: (stage) => {
        if (stage === 'before-publish-reservation') throw new Error('injected-before-publish-failure')
      }
    })).rejects.toThrow('injected-before-publish-failure')

    const created = await lib.ensureSessionInLibrary(session, undefined, undefined, {
      packageIdFactory: () => packageId
    })
    expect(packageDirs()).toEqual([created])
    expect(JSON.parse(fs.readFileSync(path.join(created, '.swob-session.json'), 'utf-8')).packageId).toBe(packageId)
  })

  it('preflights conflict groups so redaction and rebuild perform zero writes', async () => {
    const sessionId = 'c0000000-0000-4000-8000-00000000000c'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    writeJsonl(sourcePath, `WK${'a'.repeat(34)}`)
    const firstDir = await lib.ensureSessionInLibrary(summary(sessionId, sourcePath))
    const secondDir = path.join(root, 'duplicate-conflict')
    fs.writeFileSync(path.join(firstDir, 'transcript.md'), `WK${'a'.repeat(34)}`)
    fs.cpSync(firstDir, secondDir, { recursive: true })
    const beforeFirst = fs.readFileSync(path.join(firstDir, 'transcript.md'), 'utf-8')
    const beforeSecond = fs.readFileSync(path.join(secondDir, 'transcript.md'), 'utf-8')
    lib.scanLibrary()

    expect(() => lib.redactLibraryTranscripts()).toThrow(lib.SessionIdentityConflictError)
    await expect(lib.rebuildAllTranscripts()).rejects.toBeInstanceOf(lib.SessionIdentityConflictError)
    expect(fs.readFileSync(path.join(firstDir, 'transcript.md'), 'utf-8')).toBe(beforeFirst)
    expect(fs.readFileSync(path.join(secondDir, 'transcript.md'), 'utf-8')).toBe(beforeSecond)
  })

  it('re-authorizes organizer apply and undo immediately before their first write', async () => {
    const sessionId = 'cd000000-0000-4000-8000-0000000000cd'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    const originalDir = await lib.ensureSessionInLibrary(summary(sessionId, sourcePath))
    const duplicateDir = path.join(root, 'organizer-conflict-copy')
    const operationsDir = path.join(root, '.swob', 'operations')
    const manifestBefore = fs.readFileSync(path.join(originalDir, '.swob-session.json'), 'utf-8')

    expect(() => lib.applyLibraryOrganization('project', [{
      sessionId,
      targetRelativeFolder: 'project-target'
    }], {
      beforeWriteAuthorization: () => fs.cpSync(originalDir, duplicateDir, { recursive: true })
    })).toThrow(lib.SessionIdentityConflictError)
    expect(fs.existsSync(operationsDir) ? fs.readdirSync(operationsDir) : []).toEqual([])
    expect(fs.readFileSync(path.join(originalDir, '.swob-session.json'), 'utf-8')).toBe(manifestBefore)
    expect(fs.readFileSync(path.join(duplicateDir, '.swob-session.json'), 'utf-8')).toBe(manifestBefore)

    fs.rmSync(duplicateDir, { recursive: true, force: true })
    lib.scanLibrary()
    const applied = lib.applyLibraryOrganization('project', [{ sessionId, targetRelativeFolder: 'project-target' }])
    const movedDir = applied.moves[0].to
    fs.cpSync(movedDir, duplicateDir, { recursive: true })
    const logBefore = fs.readFileSync(applied.logPath!, 'utf-8')

    expect(() => lib.undoLastLibraryOrganization()).toThrow(lib.SessionIdentityConflictError)
    expect(fs.existsSync(movedDir)).toBe(true)
    expect(fs.existsSync(originalDir)).toBe(false)
    expect(fs.readFileSync(applied.logPath!, 'utf-8')).toBe(logBefore)
  })

  it('rejects a symlink transcript target without changing its external file', async () => {
    const sessionId = 'd0000000-0000-4000-8000-00000000000d'
    const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
    writeJsonl(sourcePath, 'safe transcript source')
    const dirPath = await lib.ensureSessionInLibrary(summary(sessionId, sourcePath))
    const externalFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swob-transcript-target-')), 'outside.md')
    fs.writeFileSync(externalFile, 'outside unchanged')
    fs.symlinkSync(externalFile, path.join(dirPath, 'transcript.md'))
    try {
      await expect(lib.updateTranscript(sessionId, undefined, dirPath))
        .rejects.toBeInstanceOf(lib.LibraryPathUnsafeError)
      expect(fs.readFileSync(externalFile, 'utf-8')).toBe('outside unchanged')
    } finally {
      fs.rmSync(path.dirname(externalFile), { recursive: true, force: true })
    }
  })

  it('treats a manifest symlink outside the Library as unresolved evidence', async () => {
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-manifest-target-'))
    const packageDir = path.join(root, 'linked-manifest-package')
    const outsideManifest = path.join(externalDir, '.swob-session.json')
    fs.mkdirSync(packageDir)
    fs.writeFileSync(outsideManifest, JSON.stringify({
      schemaVersion: 3,
      packageId: randomUUID(),
      logicalIdentity: {
        schemaVersion: 1,
        sourceFamily: 'claude-code',
        sourceInstanceId: 'claude-default',
        sessionId: 'outside-manifest'
      },
      sessionId: 'outside-manifest',
      sourceFilePaths: [],
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
      projectPath: '/outside'
    }))
    fs.symlinkSync(outsideManifest, path.join(packageDir, '.swob-session.json'))
    try {
      const sessionId = 'ab000000-0000-4000-8000-0000000000ab'
      const sourcePath = path.join(testHome, '.claude', 'projects', '-fixture', `${sessionId}.jsonl`)
      await expect(lib.ensureSessionInLibrary(summary(sessionId, sourcePath)))
        .rejects.toBeInstanceOf(lib.SessionIdentityUnresolvedError)
      expect(fs.readFileSync(outsideManifest, 'utf-8')).toContain('outside-manifest')
      expect(packageDirs()).toEqual([packageDir])
      expect(fs.lstatSync(path.join(packageDir, '.swob-session.json')).isSymbolicLink()).toBe(true)
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true })
    }
  })
})
