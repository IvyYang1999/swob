import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { CliIo } from './index'

/**
 * F1d-2: `swob lineage` is the explicit manual rebuild. It writes through the
 * same guard as the desktop: an unreadable registry is never replaced, a
 * replaced one is first copied to <state>/lineage-backups. Synthetic HOME.
 */

let home = ''
let libraryRoot = ''
let registryPath = ''
let backups = ''
let runCli: typeof import('./index').runCli
let summaryCacheVersion = 0
let previousHome: string | undefined
let previousIndexDir: string | undefined

const OLD_ID = 'f1d20000-0000-4000-8000-0000000000c1'
const NEW_ID = 'f1d20000-0000-4000-8000-0000000000c2'

function writeSession(sessionId: string, rows: unknown[]): void {
  const directory = path.join(home, '.claude', 'projects', '-fixtures-f1d2-cli')
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, `${sessionId}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function row(sessionId: string, uuid: string, timestamp: string, extra: Record<string, unknown> = {}) {
  return {
    parentUuid: null, isSidechain: false, type: 'user', uuid, timestamp, sessionId,
    cwd: '/fixtures/f1d2-cli', message: { role: 'user', content: `synthetic ${uuid}` }, ...extra
  }
}

async function invoke(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const io: CliIo = {
    stdout: (value) => { stdout += value },
    stderr: (value) => { stderr += value },
    readStdin: async () => ''
  }
  const code = await runCli(args, io, { libraryRoot })
  return { code, stdout, stderr }
}

function lastErrorLine(stderr: string): any {
  const lines = stderr.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function backupFiles(): string[] {
  return fs.existsSync(backups) ? fs.readdirSync(backups).sort() : []
}

beforeAll(async () => {
  previousHome = process.env.HOME
  previousIndexDir = process.env.SWOB_SEARCH_INDEX_DIR
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-f1d2-cli-'))
  libraryRoot = path.join(home, 'Vault')
  registryPath = path.join(libraryRoot, '.session-lineage.json')
  backups = path.join(home, '.claude-session-manager', 'lineage-backups')
  process.env.HOME = home
  process.env.SWOB_SEARCH_INDEX_DIR = path.join(home, 'search-index')
  fs.mkdirSync(libraryRoot, { recursive: true })
  writeSession(OLD_ID, [row(OLD_ID, 'old-point', '2026-08-01T10:00:00.000Z')])
  writeSession(NEW_ID, [
    { type: 'summary', sessionId: NEW_ID, leafUuid: 'old-point', timestamp: '2026-08-01T10:01:00.000Z' },
    row(NEW_ID, 'new-point', '2026-08-01T10:01:01.000Z')
  ])
  ;({ runCli } = await import('./index'))
  ;({ SUMMARY_CACHE_VERSION: summaryCacheVersion } = await import('../main/session-loader'))
})

afterAll(async () => {
  const { closeSearchIndex } = await import('../main/search-index')
  closeSearchIndex()
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousIndexDir === undefined) delete process.env.SWOB_SEARCH_INDEX_DIR
  else process.env.SWOB_SEARCH_INDEX_DIR = previousIndexDir
  fs.rmSync(home, { recursive: true, force: true })
})

describe.sequential('swob lineage writes through the F1d-2 guard', () => {
  it('refuses to replace an unreadable registry: exit 1, a stable code, the file untouched', async () => {
    fs.writeFileSync(registryPath, '{broken-json')
    const invocation = await invoke(['lineage', '--json'])
    expect(invocation.code).toBe(1)
    expect(invocation.stdout).toBe('')
    expect(lastErrorLine(invocation.stderr).error).toMatchObject({ code: 'LINEAGE_REGISTRY_UNREADABLE', retryable: false })
    expect(fs.readFileSync(registryPath, 'utf8')).toBe('{broken-json')
    expect(backupFiles()).toEqual([])
  })

  it('--dry-run still prints the rebuilt registry and writes nothing', async () => {
    const before = JSON.stringify({
      version: 1, generatedAt: '2026-08-01T00:00:00.000Z', aliases: { 'f1d2-legacy-cli': OLD_ID }
    })
    fs.writeFileSync(registryPath, before)
    const invocation = await invoke(['lineage', '--dry-run', '--json'])
    expect(invocation.code).toBe(0)
    const printed = JSON.parse(invocation.stdout)
    expect(printed.aliases).toMatchObject({ [OLD_ID]: NEW_ID, 'f1d2-legacy-cli': NEW_ID })
    expect(printed.derivedFrom).toEqual({ summaryCacheVersion })
    expect(fs.readFileSync(registryPath, 'utf8')).toBe(before)
    expect(backupFiles()).toEqual([])
  })

  it('replaces a readable registry only after a byte-for-byte backup in the state directory', async () => {
    const before = fs.readFileSync(registryPath)
    const invocation = await invoke(['lineage', '--json'])
    expect(invocation.code).toBe(0)
    const written = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
    expect(written).toEqual(JSON.parse(invocation.stdout))
    expect(written.aliases).toMatchObject({ [OLD_ID]: NEW_ID, 'f1d2-legacy-cli': NEW_ID })
    expect(written.derivedFrom).toEqual({ summaryCacheVersion })
    const files = backupFiles()
    expect(files).toHaveLength(1)
    expect(fs.readFileSync(path.join(backups, files[0])).equals(before)).toBe(true)
  })
})
