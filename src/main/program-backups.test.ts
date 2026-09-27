/**
 * F1d-3: the one place Swob deletes its own backups. Only regular files with
 * the names Swob gives them, only in search-backups/ and lineage-backups/:
 * the newest whole moved search index (N = 1), the newest 3 lineage registry
 * copies, and 1 GiB for both, never the newest of a kind. Anything else is
 * never touched, a hand-made state-*-predeploy copy least of all. Every file
 * here is synthetic, under the test's own HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defaultLineageBackupDirectory } from './session-lineage'
import {
  assertProgramBackupFile,
  LINEAGE_REGISTRY_BACKUP_FILE_NAME,
  PROGRAM_BACKUP_LIMITS,
  pruneProgramBackups,
  SEARCH_INDEX_BACKUP_FILE_NAME,
  searchIndexBackupDirectory,
  searchIndexBackupName
} from './program-backups'

const searchDirectory = (): string => searchIndexBackupDirectory()
const lineageDirectory = (): string => defaultLineageBackupDirectory()
const stateDirectory = (): string => path.dirname(searchIndexBackupDirectory())
let outside = ''
const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
const log = (event: string, fields: Record<string, unknown>): void => { logs.push({ event, fields }) }

beforeEach(() => {
  for (const directory of [searchDirectory(), lineageDirectory()]) fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(searchDirectory(), { recursive: true })
  fs.mkdirSync(lineageDirectory(), { recursive: true })
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-program-backups-outside-'))
  logs.length = 0
})

afterEach(() => {
  for (const directory of [searchDirectory(), lineageDirectory()]) fs.rmSync(directory, { recursive: true, force: true })
  fs.rmSync(path.join(stateDirectory(), 'state-2026-09-27T12-00-00-predeploy'), { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

function write(directory: string, name: string, bytes: number): string {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, Buffer.alloc(Math.min(bytes, 4096), 0x61))
  if (bytes > 4096) fs.truncateSync(filePath, bytes)
  return filePath
}

/** A moved index as a repair leaves it: the .db.corrupt file and the companions given. */
function searchSet(iso: string, companions: string[] = [], bytes = 300, main = true): string {
  const name = searchIndexBackupName(new Date(iso), 4242, 0)
  if (main) write(searchDirectory(), name, bytes)
  for (const suffix of companions) write(searchDirectory(), `${name}${suffix}`, 32)
  return name
}

/** A lineage registry copy named as F1d-2's createBackupFile names it. */
function lineageCopy(iso: string, bytes = 100): string {
  const name = `session-lineage-${new Date(iso).toISOString().replace(/[:.]/g, '-')}-4343.json`
  write(lineageDirectory(), name, bytes)
  return name
}

const listing = (directory: string): string[] => fs.readdirSync(directory).sort()

function fingerprint(filePath: string): { ino: number; size: number; mtimeMs: number; bytes: string } {
  const stat = fs.lstatSync(filePath)
  return {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    bytes: stat.isFile() ? fs.readFileSync(filePath).toString('base64') : stat.isSymbolicLink() ? fs.readlinkSync(filePath) : 'dir'
  }
}

describe('program backup pruning (F1d-3)', () => {
  it('keeps the newest whole moved index and the newest 3 lineage copies, deletes only older copies Swob named, logs each before and after, and never touches anything else', () => {
    const s1 = searchSet('2026-09-01T00:00:00.000Z', ['-wal', '-shm'])
    const s2 = searchSet('2026-09-10T00:00:00.000Z', ['-wal'])
    const s3 = searchSet('2026-09-20T00:00:00.000Z', ['-shm'])
    const lineage = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05']
      .map((day) => lineageCopy(`${day}T00:00:00.000Z`))

    // What Swob did not name, mixed in: never listed, never touched.
    const foreign: string[] = [
      write(searchDirectory(), 'notes.txt', 10),
      write(searchDirectory(), 'search-manual.db.corrupt', 10),
      write(searchDirectory(), `${s1}.bak`, 10),
      write(lineageDirectory(), 'session-lineage-before-upgrade.json', 10),
      write(lineageDirectory(), 'README', 10)
    ]
    const namedDirectory = path.join(searchDirectory(), searchIndexBackupName(new Date('2026-08-01T00:00:00.000Z'), 1, 0))
    fs.mkdirSync(namedDirectory)
    write(namedDirectory, 'inside.db', 10)
    const outsideTarget = write(outside, 'outside.db', 10)
    const namedLink = path.join(searchDirectory(), searchIndexBackupName(new Date('2026-07-01T00:00:00.000Z'), 1, 0))
    fs.symlinkSync(outsideTarget, namedLink)
    const predeploy = path.join(stateDirectory(), 'state-2026-09-27T12-00-00-predeploy')
    fs.mkdirSync(predeploy, { recursive: true })
    write(predeploy, 'search.db', 10)
    write(predeploy, 'manifest.json', 10)
    const untouched = [...foreign, namedDirectory, path.join(namedDirectory, 'inside.db'), namedLink, outsideTarget,
      predeploy, path.join(predeploy, 'search.db'), path.join(predeploy, 'manifest.json')]
    const before = new Map(untouched.map((filePath) => [filePath, fingerprint(filePath)]))

    const report = pruneProgramBackups({ log })

    expect(listing(searchDirectory())).toEqual([
      path.basename(namedLink), path.basename(namedDirectory), 'notes.txt', 'search-manual.db.corrupt', `${s1}.bak`, s3, `${s3}-shm`
    ].sort())
    expect(listing(lineageDirectory())).toEqual(['README', 'session-lineage-before-upgrade.json', ...lineage.slice(2)].sort())
    for (const [filePath, print] of before) expect(fingerprint(filePath), filePath).toEqual(print)
    expect(report.deleted.slice().sort()).toEqual([s1, `${s1}-wal`, `${s1}-shm`, s2, `${s2}-wal`, lineage[0], lineage[1]].sort())
    expect(report.failed).toEqual([])
    expect(report.overCap).toBe(false)
    // Before and after each deletion, with what, how large and by which rule; names only.
    for (const fileName of report.deleted) {
      const lines = logs.filter((line) => line.fields.fileName === fileName)
      expect(lines.map((line) => line.event), fileName).toEqual(['program-backup-deleting', 'program-backup-deleted'])
      expect(lines[0].fields).toMatchObject({ rule: 'count', bytes: expect.any(Number), kind: fileName.startsWith('search-') ? 'search-index' : 'lineage-registry' })
    }
    expect(logs).toHaveLength(report.deleted.length * 2)
    expect(JSON.stringify(logs)).not.toContain(path.sep + 'home')
    expect(JSON.stringify(logs)).not.toContain(os.homedir())
  })

  it('deletes no moved index while none is whole, nor one newer than the newest whole one', () => {
    const partialOld = searchSet('2026-09-01T00:00:00.000Z', ['-wal', '-shm'], 300, false)
    let report = pruneProgramBackups({ log })
    expect(report.deleted).toEqual([])
    expect(listing(searchDirectory())).toEqual([`${partialOld}-shm`, `${partialOld}-wal`])

    const whole = searchSet('2026-09-10T00:00:00.000Z')
    const partialNew = searchSet('2026-09-20T00:00:00.000Z', ['-wal'], 300, false)
    report = pruneProgramBackups({ log })
    // The older partial one goes; the whole one stays, and so does the newer partial one (a repair still moving it).
    expect(report.deleted.slice().sort()).toEqual([`${partialOld}-shm`, `${partialOld}-wal`])
    expect(listing(searchDirectory())).toEqual([whole, `${partialNew}-wal`].sort())
  })

  it('a repair\'s new copy retires the older one only when it is the newest whole copy there', () => {
    const older = searchSet('2026-09-01T00:00:00.000Z', ['-wal'])
    const newer = searchSet('2026-09-02T00:00:00.000Z')
    expect(pruneProgramBackups({ log, verifiedSearchIndexBackup: older }).deleted).toEqual([])
    expect(pruneProgramBackups({ log, verifiedSearchIndexBackup: 'search-not-here.db.corrupt' }).deleted).toEqual([])
    expect(listing(searchDirectory())).toEqual([older, `${older}-wal`, newer].sort())
    expect(pruneProgramBackups({ log, verifiedSearchIndexBackup: newer }).deleted.slice().sort()).toEqual([older, `${older}-wal`].sort())
    expect(listing(searchDirectory())).toEqual([newer])
  })

  it('holds both kinds to the size cap, oldest first, but never deletes the newest of a kind for it', () => {
    const search = searchSet('2026-09-20T00:00:00.000Z', [], 600)
    const lineage = ['2026-08-03', '2026-08-04', '2026-08-05'].map((day) => lineageCopy(`${day}T00:00:00.000Z`, 200))
    let report = pruneProgramBackups({ log, limits: { totalBytes: 1_000 } })
    expect(report.deleted).toEqual([lineage[0]])
    expect(logs.find((line) => line.event === 'program-backup-deleting')?.fields).toMatchObject({ rule: 'size-cap', fileName: lineage[0] })
    expect(report).toMatchObject({ keptBytes: 1_000, overCap: false })

    logs.length = 0
    fs.truncateSync(path.join(searchDirectory(), search), 5_000)
    report = pruneProgramBackups({ log, limits: { totalBytes: 1_000 } })
    expect(report.deleted).toEqual([lineage[1]])
    expect(report).toMatchObject({ keptBytes: 5_200, overCap: true })
    expect(listing(searchDirectory())).toEqual([search])
    expect(listing(lineageDirectory())).toEqual([lineage[2]])
    expect(logs.at(-1)).toEqual({ event: 'program-backups-over-cap', fields: { keptBytes: 5_200, capBytes: 1_000 } })
  })

  it('at real sizes: two moved 700 MiB indexes leave one, under the 1 GiB cap', () => {
    expect(PROGRAM_BACKUP_LIMITS).toEqual({ searchIndexBackups: 1, lineageRegistryBackups: 3, totalBytes: 1024 ** 3 })
    const older = searchSet('2026-09-01T00:00:00.000Z', ['-wal'], 700 * 1024 ** 2)
    const newer = searchSet('2026-09-02T00:00:00.000Z', ['-shm'], 700 * 1024 ** 2)
    const lineage = lineageCopy('2026-09-03T00:00:00.000Z', 440_717)
    const report = pruneProgramBackups({ log })
    expect(report.deleted.slice().sort()).toEqual([older, `${older}-wal`].sort())
    expect(report.overCap).toBe(false)
    expect(listing(searchDirectory())).toEqual([newer, `${newer}-shm`].sort())
    expect(listing(lineageDirectory())).toEqual([lineage])
  })

  it('names: the patterns take only what Swob writes, and the last check refuses anything else', () => {
    const search = searchIndexBackupName(new Date('2026-09-28T01:02:03.456Z'), 77, 2)
    expect(search).toBe('search-2026-09-28T01-02-03-456Z-77-2.db.corrupt')
    for (const name of [search, `${search}-wal`, `${search}-shm`, `${search}-journal`]) expect(name).toMatch(SEARCH_INDEX_BACKUP_FILE_NAME)
    for (const name of ['search.db', 'search-manual.db.corrupt', `${search}.bak`, `${search}-wal2`, `state-2026-09-27-predeploy`]) {
      expect(name).not.toMatch(SEARCH_INDEX_BACKUP_FILE_NAME)
    }
    expect('session-lineage-2026-09-27T15-01-02-123Z-12345.json').toMatch(LINEAGE_REGISTRY_BACKUP_FILE_NAME)
    expect('session-lineage-2026-09-27T15-01-02-123Z-12345-3.json').toMatch(LINEAGE_REGISTRY_BACKUP_FILE_NAME)
    expect('session-lineage-before-upgrade.json').not.toMatch(LINEAGE_REGISTRY_BACKUP_FILE_NAME)

    expect(() => assertProgramBackupFile('search-index', path.join(searchDirectory(), search))).not.toThrow()
    expect(() => assertProgramBackupFile('search-index', path.join(searchDirectory(), 'notes.txt'))).toThrow(/did not name/)
    expect(() => assertProgramBackupFile('search-index', path.join(stateDirectory(), search))).toThrow(/did not name/)
    expect(() => assertProgramBackupFile('lineage-registry', path.join(searchDirectory(), 'session-lineage-2026-09-27T15-01-02-123Z-1.json'))).toThrow(/did not name/)
    expect(() => assertProgramBackupFile('lineage-registry', path.join(stateDirectory(), 'state-2026-09-27T12-00-00-predeploy', 'search.db'))).toThrow(/did not name/)
  })

  it('does nothing without its directories, or when one is not a directory', () => {
    fs.rmSync(searchDirectory(), { recursive: true, force: true })
    fs.rmSync(lineageDirectory(), { recursive: true, force: true })
    expect(pruneProgramBackups({ log })).toEqual({ deleted: [], failed: [], keptBytes: 0, overCap: false })
    fs.mkdirSync(outside, { recursive: true })
    const realDirectory = path.join(outside, 'elsewhere')
    fs.mkdirSync(realDirectory)
    const copy = searchIndexBackupName(new Date('2026-09-01T00:00:00.000Z'), 1, 0)
    write(realDirectory, copy, 10)
    write(realDirectory, searchIndexBackupName(new Date('2026-09-02T00:00:00.000Z'), 1, 0), 10)
    fs.symlinkSync(realDirectory, searchDirectory())
    expect(pruneProgramBackups({ log }).deleted).toEqual([])
    expect(fs.existsSync(path.join(realDirectory, copy))).toBe(true)
    fs.unlinkSync(searchDirectory())
    expect(logs).toEqual([])
  })
})
