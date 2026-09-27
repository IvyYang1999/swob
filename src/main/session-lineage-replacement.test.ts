import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as lineage from './session-lineage'
import type { SessionLineageRegistry } from './session-lineage'

/**
 * F1d-2: the lineage registry is the only store of old aliases and manual
 * resolutions, so a rebuild may replace it only when it read it, only after a
 * byte-for-byte copy outside the Library, only atomically, and never when the
 * rebuild would lose an alias key or a resolution (an alias dropped because
 * its continuation resolution went stale is the one allowed, listed loss).
 * Fixtures are synthetic; every path is a temporary directory.
 */

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function tempRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-f1d2-${label}-`))
  roots.push(root)
  return root
}

function registry(overrides: Partial<SessionLineageRegistry> = {}): SessionLineageRegistry {
  return {
    version: 1,
    generatedAt: '2026-08-01T00:00:00.000Z',
    libraryRoot: '/fixtures/f1d2-library',
    aliases: {},
    latestByRoot: {},
    sessions: {},
    relations: [],
    broken: [],
    ambiguous: [],
    resolutions: [],
    ...overrides
  }
}

interface Fixture {
  library: string
  registryPath: string
  backups: string
}

function fixture(label: string): Fixture {
  const root = tempRoot(label)
  const library = path.join(root, 'Library')
  fs.mkdirSync(library, { recursive: true })
  return {
    library,
    registryPath: path.join(library, '.session-lineage.json'),
    backups: path.join(root, 'state', 'lineage-backups')
  }
}

function writeRaw(filePath: string, content: string | object): Buffer {
  const bytes = Buffer.from(typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  fs.writeFileSync(filePath, bytes)
  return bytes
}

function refusal(run: () => unknown): { code?: string; reason?: string; check?: any } {
  try {
    run()
  } catch (error) {
    return error as { code?: string; reason?: string; check?: any }
  }
  throw new Error('expected the replacement to be refused')
}

function leftovers(directory: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.tmp'))
}

function listing(directory: string): string[] {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : []
}

function writeJsonl(directory: string, sessionId: string, rows: unknown[]): string {
  fs.mkdirSync(directory, { recursive: true })
  const filePath = path.join(directory, `${sessionId}.jsonl`)
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
  return filePath
}

function message(sessionId: string, uuid: string, timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp, sessionId,
    userType: 'external', cwd: '/fixtures/f1d2-project', version: 'test',
    message: { role: 'user', content: `synthetic prompt ${uuid}` },
    ...extra
  }
}

describe('F1d-2 lineage registry replacement guard', () => {
  it('refuses a rebuild that would drop an alias key and leaves the old file byte for byte', () => {
    const { registryPath, backups, library } = fixture('alias-loss')
    const before = writeRaw(registryPath, registry({
      aliases: { 'f1d2-old-a': 'f1d2-latest', 'f1d2-legacy-only': 'f1d2-latest' }
    }))
    const next = registry({ aliases: { 'f1d2-old-a': 'f1d2-latest' } })

    const error = refusal(() => lineage.writeSessionLineageRegistry(next, registryPath, { backupDirectory: backups }))
    expect(error.code).toBe('LINEAGE_REGISTRY_ENTRIES_LOST')
    expect(error.check).toMatchObject({ lostAliases: ['f1d2-legacy-only'], lostResolutions: [] })
    expect(fs.readFileSync(registryPath).equals(before)).toBe(true)
    expect(listing(backups)).toEqual([])
    expect(leftovers(library)).toEqual([])
  })

  it('refuses a rebuild that would lose a resolution, or one of two copies of it', () => {
    const { registryPath, backups } = fixture('resolution-loss')
    const decided = {
      ambiguitySessionId: 'f1d2-child', parentSessionId: 'f1d2-parent', childSessionId: 'f1d2-child',
      type: 'fork' as const, decidedAt: '2026-08-01T01:00:00.000Z',
      resolutionId: 'manual:f1d2-child:f1d2-parent:f1d2-child:fork',
      ambiguityReason: 'multiple-exact-lineage-parents', status: 'applied' as const
    }
    const before = writeRaw(registryPath, registry({ resolutions: [decided, { ...decided }] }))

    const lost = refusal(() => lineage.writeSessionLineageRegistry(registry(), registryPath, { backupDirectory: backups }))
    expect(lost.code).toBe('LINEAGE_REGISTRY_ENTRIES_LOST')
    expect(lost.check.lostResolutions).toEqual([decided.resolutionId])
    const collapsed = refusal(() => lineage.writeSessionLineageRegistry(
      registry({ resolutions: [decided] }), registryPath, { backupDirectory: backups }
    ))
    expect(collapsed.code).toBe('LINEAGE_REGISTRY_ENTRIES_LOST')
    expect(fs.readFileSync(registryPath).equals(before)).toBe(true)
    expect(listing(backups)).toEqual([])
  })

  it('refuses to replace a registry it cannot read: broken JSON, a non-object, a symlink', () => {
    const { registryPath, backups, library } = fixture('unreadable')
    const broken = writeRaw(registryPath, '{broken-json')
    const unreadable = refusal(() => lineage.writeSessionLineageRegistry(registry(), registryPath, { backupDirectory: backups }))
    expect(unreadable.code).toBe('LINEAGE_REGISTRY_UNREADABLE')
    expect(fs.readFileSync(registryPath).equals(broken)).toBe(true)

    const array = writeRaw(registryPath, '[]\n')
    expect(refusal(() => lineage.writeSessionLineageRegistry(registry(), registryPath, { backupDirectory: backups })).code)
      .toBe('LINEAGE_REGISTRY_UNREADABLE')
    expect(fs.readFileSync(registryPath).equals(array)).toBe(true)

    fs.rmSync(registryPath)
    const target = path.join(library, 'elsewhere.json')
    const targetBytes = writeRaw(target, registry({ aliases: { 'f1d2-linked': 'f1d2-latest' } }))
    fs.symlinkSync(target, registryPath)
    expect(refusal(() => lineage.writeSessionLineageRegistry(registry(), registryPath, { backupDirectory: backups })).code)
      .toBe('LINEAGE_REGISTRY_UNREADABLE')
    expect(fs.lstatSync(registryPath).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target).equals(targetBytes)).toBe(true)
    expect(listing(backups)).toEqual([])
    expect(leftovers(library)).toEqual([])
  })

  it('backs the old file up byte for byte outside the Library, then replaces it atomically', () => {
    const { registryPath, backups, library } = fixture('replace')
    const before = writeRaw(registryPath, registry({ aliases: { 'f1d2-old-a': 'f1d2-latest' } }))
    fs.chmodSync(registryPath, 0o640)
    const inode = fs.statSync(registryPath).ino
    const next = registry({
      generatedAt: '2026-08-02T00:00:00.000Z',
      aliases: { 'f1d2-old-a': 'f1d2-latest', 'f1d2-old-b': 'f1d2-latest' }
    })

    const result = lineage.writeSessionLineageRegistry(next, registryPath, { backupDirectory: backups })
    expect(result.check).toMatchObject({
      previous: { aliases: 1, resolutions: 0, manualRelations: 0 },
      next: { aliases: 2, resolutions: 0, manualRelations: 0 },
      lostAliases: [],
      lostResolutions: [],
      lostManualRelations: [],
      staleAliasDrops: [],
      newlyStaleResolutions: []
    })
    expect(result.backupFileName).toMatch(/^session-lineage-.+\.json$/)
    expect(listing(backups)).toEqual([result.backupFileName])
    expect(fs.readFileSync(path.join(backups, result.backupFileName!)).equals(before)).toBe(true)
    expect(path.relative(library, backups).startsWith('..')).toBe(true)
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8'))).toEqual(next)
    expect(fs.statSync(registryPath).mode & 0o777).toBe(0o640)
    // Replaced by a rename, never rewritten in place.
    expect(fs.statSync(registryPath).ino).not.toBe(inode)
    expect(leftovers(library)).toEqual([])
  })

  it('creates a missing registry without a backup, and keeps its default backups in the state directory', () => {
    const { registryPath, library } = fixture('create')
    const created = lineage.writeSessionLineageRegistry(registry({ aliases: { 'f1d2-a': 'f1d2-b' } }), registryPath)
    expect(created).toEqual({ check: null, backupFileName: null })
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).aliases).toEqual({ 'f1d2-a': 'f1d2-b' })

    const home = tempRoot('home')
    const previousHome = process.env.HOME
    process.env.HOME = home
    try {
      const replaced = lineage.writeSessionLineageRegistry(
        registry({ aliases: { 'f1d2-a': 'f1d2-b', 'f1d2-c': 'f1d2-b' } }), registryPath
      )
      expect(listing(path.join(home, '.claude-session-manager', 'lineage-backups')))
        .toEqual([replaced.backupFileName])
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
    }
    expect(leftovers(library)).toEqual([])
  })

  it('refuses when the file changed after the rebuild read it', () => {
    const { registryPath, backups } = fixture('changed')
    writeRaw(registryPath, registry({ aliases: { 'f1d2-old-a': 'f1d2-latest' } }))
    const seen = lineage.readLineageRegistrySnapshot(registryPath)
    expect(seen.state).toBe('readable')
    const concurrent = writeRaw(registryPath, registry({ aliases: { 'f1d2-old-a': 'f1d2-other' } }))

    const error = refusal(() => lineage.writeSessionLineageRegistry(
      registry({ aliases: { 'f1d2-old-a': 'f1d2-latest' } }), registryPath, { expected: seen, backupDirectory: backups }
    ))
    expect(error.code).toBe('LINEAGE_REGISTRY_CHANGED')
    expect(fs.readFileSync(registryPath).equals(concurrent)).toBe(true)
    expect(lineage.readLineageRegistrySnapshot(path.join(path.dirname(registryPath), 'absent.json')))
      .toEqual({ state: 'missing' })
  })

  it('refuses a rebuild that drops a manual relation whose resolution is still applied or absent', () => {
    const { registryPath, backups } = fixture('manual')
    const before = writeRaw(registryPath, registry({
      relations: [{
        parent: 'f1d2-parent', child: 'f1d2-child', type: 'continuation', pointUuid: 'manual:f1d2-child',
        pointTs: '2026-08-01T01:00:00.000Z', provenance: 'manual', resolutionId: 'manual:f1d2-orphan'
      }]
    }))
    const error = refusal(() => lineage.writeSessionLineageRegistry(registry(), registryPath, { backupDirectory: backups }))
    expect(error.code).toBe('LINEAGE_REGISTRY_ENTRIES_LOST')
    expect(error.check.lostManualRelations).toEqual(['continuation:f1d2-parent->f1d2-child'])
    expect(fs.readFileSync(registryPath).equals(before)).toBe(true)
  })

  it('stamps a rebuild with its summary-cache version, and lets a stale resolution drop only its own alias', async () => {
    const home = tempRoot('rebuild-home')
    const project = path.join(home, '.claude', 'projects', '-fixtures-f1d2-project')
    const library = path.join(home, 'Library')
    fs.mkdirSync(library, { recursive: true })
    const parentA = 'f1d20000-0000-4000-8000-00000000000a'
    const parentB = 'f1d20000-0000-4000-8000-00000000000b'
    const child = 'f1d20000-0000-4000-8000-00000000000c'
    writeJsonl(project, parentA, [message(parentA, 'point-a', '2026-08-01T10:00:00.000Z')])
    writeJsonl(project, parentB, [message(parentB, 'point-b', '2026-08-01T10:00:00.000Z')])
    const childFile = writeJsonl(project, child, [
      message(child, 'child-1', '2026-08-01T10:01:00.000Z', { forkedFrom: { sessionId: parentA, messageUuid: 'point-a' } }),
      message(child, 'child-2', '2026-08-01T10:02:00.000Z', {
        parentUuid: 'child-1', forkedFrom: { sessionId: parentB, messageUuid: 'point-b' }
      })
    ])
    const previousHome = process.env.HOME
    process.env.HOME = home
    vi.resetModules()
    try {
      const fresh = await import('./session-lineage')
      const { SUMMARY_CACHE_VERSION } = await import('./session-loader')
      const registryPath = fresh.getSessionLineagePath(library)
      const built = await fresh.rebuildSessionLineageRegistry(library)
      expect(built.derivedFrom).toEqual({ summaryCacheVersion: SUMMARY_CACHE_VERSION })
      const decision = {
        ambiguitySessionId: child, parentSessionId: parentA, childSessionId: child,
        type: 'continuation' as const, decidedAt: '2026-08-01T11:00:00.000Z'
      }
      const decided = fresh.applyLineageResolution(built, decision)
      expect(decided.aliases).toMatchObject({ [parentA]: child })
      fresh.writeSessionLineageRegistry({ ...decided, aliases: { ...decided.aliases, 'f1d2-legacy': parentA } }, registryPath)
      const before = fs.readFileSync(registryPath)

      // The child is gone: its decision can no longer apply.
      fs.rmSync(childFile)
      const rebuilt = await fresh.rebuildSessionLineageRegistry(library)
      expect(rebuilt.resolutions).toEqual([expect.objectContaining({ status: 'stale' })])
      const result = fresh.writeSessionLineageRegistry(rebuilt, registryPath)
      expect(result.check).toMatchObject({
        staleAliasDrops: [{ sessionId: parentA, successorId: child, resolutionId: decided.resolutions![0].resolutionId }],
        newlyStaleResolutions: [decided.resolutions![0].resolutionId],
        lostAliases: [],
        lostResolutions: [],
        lostManualRelations: []
      })
      const disk = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
      expect(disk.aliases).toHaveProperty('f1d2-legacy')
      expect(disk.aliases).not.toHaveProperty(parentA)
      expect(disk.resolutions).toHaveLength(1)
      expect(disk.derivedFrom).toEqual({ summaryCacheVersion: SUMMARY_CACHE_VERSION })
      const backups = path.join(home, '.claude-session-manager', 'lineage-backups')
      expect(listing(backups)).toEqual([result.backupFileName])
      expect(fs.readFileSync(path.join(backups, result.backupFileName!)).equals(before)).toBe(true)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      vi.resetModules()
    }
  })
})
