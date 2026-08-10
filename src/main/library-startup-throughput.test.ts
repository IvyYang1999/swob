import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { LIBRARY_STARTUP_BATCH_SIZE } from './library-startup-sync'
import type { SessionSummary } from './types'

const savedHome = process.env.HOME
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-throughput-home-'))
const roots: string[] = []
let lib: typeof import('./library-manager')

function summary(index: number, filePath: string): SessionSummary {
  const sessionId = `throughput-${String(index).padStart(4, '0')}`
  return {
    id: sessionId,
    sessionId,
    slug: '',
    filePath,
    fileSizeBytes: fs.statSync(filePath).size,
    allFilePaths: [filePath],
    source: 'claude-code',
    firstUserMessage: `throughput ${index}`,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:01.000Z',
    messageCount: 2,
    turnCount: 1,
    compactCount: 0,
    cwds: ['/fixture/project'],
    version: '',
    toolUsage: {},
    skillInvocations: [],
    userImages: [],
    pastedImageCount: 0,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    referencedFiles: [],
    configFiles: [],
    projectPath: '/fixture/project',
    resumeCwd: '/fixture/project'
  }
}

function writeSource(root: string, index: number): string {
  const sessionId = `throughput-${String(index).padStart(4, '0')}`
  const filePath = path.join(root, '.claude', 'projects', 'fixture', `${sessionId}.jsonl`)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, [
    {
      uuid: `${sessionId}-user`, parentUuid: null, sessionId, type: 'user',
      timestamp: '2026-08-08T00:00:00.000Z', cwd: '/fixture/project',
      message: { role: 'user', content: `throughput ${index}` }
    },
    {
      uuid: `${sessionId}-assistant`, parentUuid: `${sessionId}-user`, sessionId, type: 'assistant',
      timestamp: '2026-08-08T00:00:01.000Z', cwd: '/fixture/project',
      message: { role: 'assistant', content: 'done' }
    }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n')
  return filePath
}

beforeAll(async () => {
  process.env.HOME = testHome
  lib = await import('./library-manager')
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  fs.rmSync(testHome, { recursive: true, force: true })
})

describe('Library startup production throughput', () => {
  it('reuses one exact legacy package when its persisted source path proves the binding', async () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-legacy-library-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-legacy-source-'))
    roots.push(libraryRoot, sourceRoot)
    const sourcePath = writeSource(sourceRoot, 0)
    const session = summary(0, sourcePath)
    const legacyDir = path.join(libraryRoot, 'legacy-package')
    fs.mkdirSync(legacyDir)
    fs.writeFileSync(path.join(legacyDir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      logicalIdentity: {
        schemaVersion: 1,
        sourceFamily: 'legacy-ambiguous',
        sourceInstance: { kind: 'legacy-ambiguous', id: 'legacy-ambiguous' },
        sessionId: session.sessionId
      },
      sessionId: session.sessionId,
      sourceFilePaths: [sourcePath],
      createdAt: session.createdAt,
      updatedAt: '2026-08-07T00:00:00.000Z',
      projectPath: session.projectPath,
      turnCount: 0
    }))
    fs.writeFileSync(path.join(legacyDir, 'backup.jsonl'), fs.readFileSync(sourcePath))
    fs.writeFileSync(path.join(legacyDir, 'transcript.md'), 'legacy transcript\n')
    lib.initLibrary(libraryRoot)

    const plan = await lib.planLibraryStartupSync([session], 1, {})
    const result = await lib.syncLibraryStartupBatch(
      [session],
      {},
      { snapshotDigest: plan.snapshotDigest, schemaGeneration: plan.schemaGeneration }
    )

    expect(result.outcome).toMatchObject({ completed: 1, skipped: [] })
    expect(fs.readdirSync(libraryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)).toEqual(['legacy-package'])
    const persisted = JSON.parse(fs.readFileSync(path.join(legacyDir, '.swob-session.json'), 'utf-8'))
    expect(persisted.logicalIdentity.sourceFamily).toBe('legacy-ambiguous')
    expect(persisted.turnCount).toBe(session.turnCount)
  })

  it('does not alias a legacy package when the source evidence differs', async () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-legacy-mismatch-library-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-legacy-mismatch-source-'))
    roots.push(libraryRoot, sourceRoot)
    const sourcePath = writeSource(sourceRoot, 0)
    const session = summary(0, sourcePath)
    const legacyDir = path.join(libraryRoot, 'legacy-package')
    fs.mkdirSync(legacyDir)
    fs.writeFileSync(path.join(legacyDir, '.swob-session.json'), JSON.stringify({
      schemaVersion: 2,
      logicalIdentity: {
        schemaVersion: 1,
        sourceFamily: 'legacy-ambiguous',
        sourceInstance: { kind: 'legacy-ambiguous', id: 'legacy-ambiguous' },
        sessionId: session.sessionId
      },
      sessionId: session.sessionId,
      sourceFilePaths: ['/different/source.jsonl'],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      projectPath: session.projectPath,
      turnCount: session.turnCount
    }))
    lib.initLibrary(libraryRoot)

    const plan = await lib.planLibraryStartupSync([session], 1, {})
    const result = await lib.syncLibraryStartupBatch(
      [session],
      {},
      { snapshotDigest: plan.snapshotDigest, schemaGeneration: plan.schemaGeneration }
    )
    expect(result.outcome.skipped[0]).toMatchObject({
      code: 'SESSION_IDENTITY_AMBIGUOUS',
      recovery: { state: 'attention-required', attempt: 0 }
    })
    expect(fs.readdirSync(libraryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))).toHaveLength(1)
  })

  it('refreshes both identity indexes after an intervening writer commit', async () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-generation-library-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-generation-source-'))
    roots.push(libraryRoot, sourceRoot)
    const session = summary(0, writeSource(sourceRoot, 0))
    lib.initLibrary(libraryRoot)

    const plan = await lib.planLibraryStartupSync([session], 1, {})
    lib.saveLibraryConfig(lib.loadLibraryConfig())
    const result = await lib.syncLibraryStartupBatch(
      [session],
      {},
      { snapshotDigest: plan.snapshotDigest, schemaGeneration: plan.schemaGeneration }
    )

    expect(result.outcome).toMatchObject({ completed: 1, skipped: [] })
    expect(result.counters).toMatchObject({ registryFullScans: 2, packageIdentityFullScans: 2 })
  })

  it('checkpoints a vanished loader source as handled and retries only after the source returns', async () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-missing-library-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-missing-source-'))
    roots.push(libraryRoot, sourceRoot)
    const sourcePath = writeSource(sourceRoot, 0)
    const session = summary(0, sourcePath)
    fs.unlinkSync(sourcePath)
    lib.initLibrary(libraryRoot)

    const cold = await lib.planLibraryStartupSync([session], 1, {})
    const handled = await lib.syncLibraryStartupBatch(
      [session],
      {},
      { snapshotDigest: cold.snapshotDigest, schemaGeneration: cold.schemaGeneration }
    )
    expect(handled.outcome).toEqual({
      total: 1,
      completed: 1,
      skipped: [{
        sessionId: session.sessionId,
        code: 'SESSION_SOURCE_MISSING',
        disposition: 'handled',
        retryable: false
      }]
    })
    expect(fs.readdirSync(libraryRoot).filter((name) => !name.startsWith('.'))).toEqual([])

    const unchanged = await lib.planLibraryStartupSync([session], 1, {})
    expect(unchanged.dirtyIndexes).toEqual([])

    writeSource(sourceRoot, 0)
    const restored = await lib.planLibraryStartupSync([session], 1, {})
    expect(restored.dirtyIndexes).toEqual([0])
    const archived = await lib.syncLibraryStartupBatch(
      [session],
      {},
      { snapshotDigest: restored.snapshotDigest, schemaGeneration: restored.schemaGeneration }
    )
    expect(archived.outcome).toMatchObject({ completed: 1, skipped: [] })
    const [sessionDir] = fs.readdirSync(libraryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(libraryRoot, entry.name))
    expect(fs.existsSync(path.join(sessionDir, '.swob-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, 'transcript.md'))).toBe(true)
    expect(fs.readFileSync(path.join(sessionDir, 'backup.jsonl'))).toEqual(fs.readFileSync(sourcePath))
    expect(fs.existsSync(path.join(sessionDir, '.swob-incomplete.json'))).toBe(false)
  })

  it.each(['missing', 'icloud-placeholder'] as const)(
    'does not requeue an existing package whose source and backup are %s',
    async (backupState) => {
      const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-existing-library-'))
      const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-existing-source-'))
      roots.push(libraryRoot, sourceRoot)
      const sourcePath = writeSource(sourceRoot, 0)
      const session = summary(0, sourcePath)
      lib.initLibrary(libraryRoot)
      const sessionDir = await lib.ensureSessionInLibrary(session)
      if (backupState === 'icloud-placeholder') {
        fs.writeFileSync(path.join(sessionDir, '.backup.jsonl.icloud'), '')
      }
      fs.unlinkSync(sourcePath)

      const cold = await lib.planLibraryStartupSync([session], 1, {})
      expect(cold.dirtyIndexes).toEqual([0])
      const handled = await lib.syncLibraryStartupBatch(
        [session],
        {},
        { snapshotDigest: cold.snapshotDigest, schemaGeneration: cold.schemaGeneration }
      )
      expect(handled.outcome.skipped).toEqual([{
        sessionId: session.sessionId,
        code: 'SESSION_SOURCE_MISSING',
        disposition: 'handled',
        retryable: false
      }])
      expect(fs.existsSync(path.join(sessionDir, 'backup.jsonl'))).toBe(false)

      const unchanged = await lib.planLibraryStartupSync([session], 1, {})
      expect(unchanged.dirtyIndexes).toEqual([])
    }
  )

  it('archives 500 real source fixtures through the production planner and writer within two minutes', async () => {
    const libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-throughput-library-'))
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-startup-throughput-source-'))
    roots.push(libraryRoot, sourceRoot)
    const sessionCount = 500
    const sessions = Array.from({ length: sessionCount }, (_, index) => summary(index, writeSource(sourceRoot, index)))
    lib.initLibrary(libraryRoot)

    const startedAt = performance.now()
    const plan = await lib.planLibraryStartupSync(sessions, 1, {})
    expect(plan.dirtyIndexes).toHaveLength(sessions.length)
    let counters = plan.counters
    let completed = 0
    for (let offset = 0; offset < sessions.length; offset += LIBRARY_STARTUP_BATCH_SIZE) {
      const result = await lib.syncLibraryStartupBatch(
        sessions.slice(offset, offset + LIBRARY_STARTUP_BATCH_SIZE),
        {},
        { snapshotDigest: plan.snapshotDigest, schemaGeneration: plan.schemaGeneration }
      )
      completed += result.outcome.completed
      counters = result.counters
    }
    const elapsedMs = performance.now() - startedAt

    expect(completed).toBe(sessions.length)
    expect(counters).toEqual({
      writerAcquires: 1 + Math.ceil(sessions.length / LIBRARY_STARTUP_BATCH_SIZE),
      registryFullScans: 1,
      packageIdentityFullScans: 1,
      registryIncrementalUpdates: sessions.length
    })
    expect(fs.readdirSync(libraryRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))).toHaveLength(sessions.length)
    expect(elapsedMs).toBeLessThan(120_000)
    console.info('[startup-throughput]', JSON.stringify({ sessions: sessions.length, elapsedMs: Math.round(elapsedMs), counters }))
  }, 150_000)
})
