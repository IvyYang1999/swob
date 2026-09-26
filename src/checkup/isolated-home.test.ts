import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SOURCE_LINKS,
  buildIsolatedHome,
  cleanupIsolatedHome,
  configuredLibraryRoot,
  protectedLocations,
  validateStateDir
} from './isolated-home'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function write(root: string, relative: string, content: string): string {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

/** Strict snapshot: lstat identity + content hash of every entry. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const stat = fs.lstatSync(full)
      let signature = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      if (stat.isFile()) signature += `:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
      if (stat.isSymbolicLink()) signature += `:${fs.readlinkSync(full)}`
      out[path.relative(root, full)] = signature
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out
}

function fakeRealHome(): string {
  const home = tempDir('checkup-real-home-')
  write(home, '.claude/projects/-p/a.jsonl', '{"type":"user"}\n')
  write(home, '.codex/sessions/2026/09/20/rollout-x.jsonl', '{"type":"session_meta"}\n')
  write(home, '.local/share/opencode/opencode.db', 'db')
  write(home, 'Library/Application Support/Trae/User/globalStorage/state.vscdb', 'db')
  write(home, 'Library/Application Support/Swob/.swob-config.json', '{}')
  write(home, '.qoderwork/projects/q.jsonl', '{}\n')
  write(home, '.claude-session-manager/summary-cache.sqlite', 'SENTINEL-CACHE')
  write(home, '.claude-session-manager/codex-homes.json', JSON.stringify({ version: 1, homes: [] }))
  write(home, '.claude-session-manager/app-config.json', JSON.stringify({ libraryPath: path.join(home, 'Vault') }))
  fs.mkdirSync(path.join(home, 'Vault', '.swob'), { recursive: true })
  return home
}

describe('symlink-HOME isolation', () => {
  it('links only top-level source roots, keeps an empty real cache dir and copies only codex-homes.json', () => {
    const realHome = fakeRealHome()
    const stateDir = tempDir('checkup-state-')
    const isolated = buildIsolatedHome({ realHome, stateDir })
    expect(isolated.linked).toEqual(['.claude', '.codex', '.local/share/opencode', 'Library/Application Support/Trae', '.qoderwork'])
    expect(isolated.missing).toEqual(SOURCE_LINKS.filter((relative) => !isolated.linked.includes(relative)))
    for (const relative of isolated.linked) {
      const link = path.join(isolated.home, relative)
      expect(fs.lstatSync(link).isSymbolicLink(), relative).toBe(true)
      expect(fs.readlinkSync(link)).toBe(path.join(realHome, relative))
    }
    const cache = path.join(isolated.home, '.claude-session-manager')
    expect(fs.lstatSync(cache).isDirectory()).toBe(true)
    expect(fs.readdirSync(cache)).toEqual(['codex-homes.json'])
    expect(fs.lstatSync(path.join(cache, 'codex-homes.json')).isSymbolicLink()).toBe(false)
    expect(isolated.copiedCodexHomes).toBe(true)
    expect(fs.existsSync(path.join(isolated.home, 'Library', 'Application Support', 'Swob'))).toBe(false)
    for (const value of Object.values(isolated.env)) expect(value.startsWith(stateDir + path.sep)).toBe(true)
    expect(isolated.env.SWOB_USAGE_INDEX_PATH.endsWith(path.join('usage', 'usage-facts.db'))).toBe(true)
  })

  it('cleanup removes the farm without following links: the sentinel sources stay byte-identical', () => {
    const realHome = fakeRealHome()
    const before = snapshot(realHome)
    const stateDir = tempDir('checkup-state-')
    const isolated = buildIsolatedHome({ realHome, stateDir })
    // Touch the farm the way a kernel run would: files under the (real) state dirs only.
    fs.writeFileSync(path.join(isolated.tmp, 'snapshot.db'), 'tmp')
    cleanupIsolatedHome(isolated)
    expect(fs.readdirSync(stateDir)).toEqual([])
    expect(fs.existsSync(stateDir)).toBe(true)
    expect(snapshot(realHome)).toEqual(before)
    expect(fs.readFileSync(path.join(realHome, '.claude-session-manager', 'summary-cache.sqlite'), 'utf8')).toBe('SENTINEL-CACHE')
  })

  it('pins fs.rmSync semantics on a hand-made link farm with nested links', () => {
    const sentinel = tempDir('checkup-sentinel-')
    const nestedSentinel = tempDir('checkup-sentinel-nested-')
    write(sentinel, 'keep/me.txt', 'sentinel')
    write(nestedSentinel, 'keep.txt', 'nested')
    const farm = tempDir('checkup-farm-')
    fs.symlinkSync(sentinel, path.join(farm, '.claude'))
    fs.mkdirSync(path.join(farm, '.local', 'share'), { recursive: true })
    fs.symlinkSync(nestedSentinel, path.join(farm, '.local', 'share', 'opencode'))
    const before = { a: snapshot(sentinel), b: snapshot(nestedSentinel) }
    fs.rmSync(farm, { recursive: true, force: true })
    expect(fs.existsSync(farm)).toBe(false)
    expect({ a: snapshot(sentinel), b: snapshot(nestedSentinel) }).toEqual(before)
  })

  it('refuses a stateDir that already holds reserved entries', () => {
    const realHome = fakeRealHome()
    const stateDir = tempDir('checkup-state-')
    fs.mkdirSync(path.join(stateDir, 'home'))
    expect(() => buildIsolatedHome({ realHome, stateDir })).toThrow(/reserved entry/)
  })
})

describe('--state validation (fail closed)', () => {
  it('accepts only an empty directory under a temp root that overlaps no protected location', () => {
    const realHome = fakeRealHome()
    const tempRoot = tempDir('checkup-temp-root-')
    const ok = path.join(tempRoot, 'state')
    fs.mkdirSync(ok)
    const guard = { realHome, allowedRoots: [tempRoot] }
    expect(validateStateDir({ ...guard, stateDir: ok })).toEqual({ ok: true, stateDir: ok })
    expect(validateStateDir({ ...guard, stateDir: path.join(tempRoot, 'missing') })).toEqual({ ok: false, reason: 'state-dir-missing' })
    write(tempRoot, 'full/x', 'x')
    expect(validateStateDir({ ...guard, stateDir: path.join(tempRoot, 'full') })).toEqual({ ok: false, reason: 'state-dir-not-empty' })
    const outside = tempDir('checkup-outside-')
    expect(validateStateDir({ ...guard, stateDir: outside })).toEqual({ ok: false, reason: 'state-dir-outside-temp' })
    fs.symlinkSync(ok, path.join(tempRoot, 'link'))
    expect(validateStateDir({ ...guard, stateDir: path.join(tempRoot, 'link') })).toEqual({ ok: false, reason: 'state-dir-not-directory' })
    const inCache = path.join(realHome, '.claude-session-manager', 'empty')
    fs.mkdirSync(inCache)
    expect(validateStateDir({ realHome, stateDir: inCache, allowedRoots: [realHome] })).toEqual({ ok: false, reason: 'state-dir-overlaps-protected' })
    const library = path.join(realHome, 'Vault', 'empty')
    fs.mkdirSync(library)
    expect(validateStateDir({ realHome, stateDir: library, allowedRoots: [path.join(realHome, 'Vault')] })).toEqual({ ok: false, reason: 'state-dir-overlaps-protected' })
  })

  it('lists the real cache, app support, library root and source roots as protected', () => {
    const realHome = fakeRealHome()
    expect(configuredLibraryRoot(realHome)).toBe(path.join(realHome, 'Vault'))
    const locations = protectedLocations(realHome)
    for (const expected of ['.claude-session-manager', path.join('Library', 'Application Support', 'Swob'), 'Vault', '.claude', '.codex', '.qoderwork']) {
      expect(locations).toContain(path.join(realHome, expected))
    }
  })
})
