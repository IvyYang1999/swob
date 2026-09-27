import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import schema from './contract/kernel-checkup-report-v1.schema.json'
import { resolveTypeScriptImport, runtimeRelativeImports } from '../main/__test-support__/typescript-runtime-closure'
import { buildIsolatedHome, cleanupIsolatedHome } from './isolated-home'
import { CHECKUP_WORKER_EXIT, isolatedWorkerEnv } from './run-guard'
import { scanForPrivacy } from './privacy'
import { CANARY, assertInsideTestSandbox, buildSampleHome } from './__test-support__/sample-home'
import { bundleCheckupWorker, repositoryNodeModules } from './__fixtures__/worker-bundle'

// The sample HOME is the Vitest sandbox home; the worker gets an isolated HOME inside a stateDir.
const HOME = process.env.HOME!
assertInsideTestSandbox(HOME)
const ROOT = process.cwd()

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

/** Strict snapshot: lstat identity + content hash of every entry under `root`. */
function snapshot(root: string): Map<string, string> {
  const entries = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const stat = fs.lstatSync(full)
      let signature = `${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`
      if (stat.isFile()) signature += `:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
      entries.set(full, signature)
      if (stat.isDirectory()) walk(full)
    }
  }
  walk(root)
  return entries
}

let workerPath = ''
beforeAll(async () => {
  buildSampleHome(HOME)
  workerPath = await bundleCheckupWorker(tempDir('checkup-worker-bundle-'))
}, 60_000)
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function runWorker(args: string[], env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [workerPath, ...args], { env, encoding: 'utf8', timeout: 120_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('checkup worker (isolated child process of swob doctor checkup)', () => {
  it('runs against an isolated HOME and writes one clean, schema-valid report into the stateDir', () => {
    const stateDir = tempDir('checkup-worker-state-')
    const isolated = buildIsolatedHome({ realHome: HOME, stateDir })
    const out = path.join(stateDir, 'report.json')
    try {
      const env = isolatedWorkerEnv(process.env, isolated.env, { NODE_PATH: repositoryNodeModules() })
      expect(env.HOME).toBe(isolated.home)
      for (const dropped of ['VITEST', 'NODE_ENV', 'SWOB_E2E_SANDBOX_ROOT', 'SWOB_TEST_HOME', 'SWOB_LIBRARY_ROOT', 'SWOB_USER_DATA_ROOT']) {
        expect(env[dropped], dropped).toBeUndefined()
      }
      const result = runWorker(['--home', HOME, '--state', stateDir, '--out', out, '--kernel-version', '1.4.0'], env)
      expect(result.status, result.stderr.slice(0, 200)).toBe(CHECKUP_WORKER_EXIT.ok)
      const text = fs.readFileSync(out, 'utf8')
      const report = JSON.parse(text)
      const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema)
      expect(validate(report), JSON.stringify(validate.errors)).toBe(true)
      expect(report.readout).toEqual({ status: 'ok' })
      expect(report.kernel).toMatchObject({ version: '1.4.0', commit: null, readOnly: true, selfTest: { passed: 7, total: 7 } })
      expect(report.saltFingerprint).toMatch(/^[0-9a-f]{8}$/)
      expect(scanForPrivacy(report)).toEqual({ ok: true, hits: [] })
      for (const canary of Object.values(CANARY)) {
        expect(text.includes(canary), canary).toBe(false)
        expect(`${result.stdout}${result.stderr}`.includes(canary), canary).toBe(false)
      }
    } finally {
      cleanupIsolatedHome(isolated)
    }
    // Only the report file is left for the parent to read back.
    expect(fs.readdirSync(stateDir)).toEqual(['report.json'])
  }, 120_000)

  it('honours --sources (the others are marked not selected)', () => {
    const stateDir = tempDir('checkup-worker-state-')
    const isolated = buildIsolatedHome({ realHome: HOME, stateDir })
    const out = path.join(stateDir, 'report.json')
    try {
      const env = isolatedWorkerEnv(process.env, isolated.env, { NODE_PATH: repositoryNodeModules() })
      const result = runWorker(['--home', HOME, '--state', stateDir, '--out', out, '--sources', 'claude-code'], env)
      expect(result.status).toBe(CHECKUP_WORKER_EXIT.ok)
      const report = JSON.parse(fs.readFileSync(out, 'utf8'))
      expect(report.checks[0].bySource.codex.swob.status.reason).toBe('source.not-selected')
      expect(report.checks[0].bySource['claude-code'].verdict).not.toBe('not-applicable')
    } finally {
      cleanupIsolatedHome(isolated)
    }
  }, 120_000)

  it('fails closed without isolation: exit 5, no report, and nothing under HOME changes', () => {
    const stateDir = tempDir('checkup-worker-state-')
    const out = path.join(stateDir, 'report.json')
    const before = snapshot(HOME)
    // HOME is the sample home itself: the kernel would read its real ~/.claude-session-manager.
    const env = isolatedWorkerEnv(process.env, { HOME, TMPDIR: stateDir }, { NODE_PATH: repositoryNodeModules() })
    const result = runWorker(['--home', HOME, '--state', stateDir, '--out', out], env)
    expect(result.status).toBe(CHECKUP_WORKER_EXIT.notIsolated)
    expect(fs.existsSync(out)).toBe(false)
    expect(fs.readdirSync(stateDir)).toEqual([])
    expect(snapshot(HOME)).toEqual(before)
  }, 120_000)

  it('refuses malformed arguments with the usage code and writes nothing', () => {
    const stateDir = tempDir('checkup-worker-state-')
    const elsewhere = tempDir('checkup-worker-elsewhere-')
    const out = path.join(stateDir, 'report.json')
    const env = isolatedWorkerEnv(process.env, { HOME: path.join(stateDir, 'home'), TMPDIR: stateDir }, { NODE_PATH: repositoryNodeModules() })
    const cases: string[][] = [
      [],
      ['--home', HOME, '--state', stateDir],
      ['--home', HOME, '--state', stateDir, '--out', path.join(elsewhere, 'report.json')],
      ['--home', HOME, '--state', stateDir, '--out', out, '--sources', 'claude-code,not-a-source'],
      ['--home', HOME, '--state', stateDir, '--out', out, '--kernel-version', 'secret build'],
      ['--home', HOME, '--state', stateDir, '--out', out, '--day', '2026-09-26'],
      ['--home', 'relative/home', '--state', stateDir, '--out', out]
    ]
    for (const args of cases) expect(runWorker(args, env).status, args.join(' ')).toBe(CHECKUP_WORKER_EXIT.usage)
    expect(fs.readdirSync(stateDir)).toEqual([])
    expect(fs.readdirSync(elsewhere)).toEqual([])
  }, 120_000)
})

/** Runtime closure over relative imports; ESM-style `./x.js` specifiers (packages/core) resolve to their `.ts` sources. */
function runtimeClosure(entry: string): string[] {
  const seen = new Set<string>()
  const pending = [entry]
  while (pending.length > 0) {
    const fileName = pending.pop()!
    if (seen.has(fileName)) continue
    seen.add(fileName)
    if (!/\.(?:ts|tsx|mts|cts)$/.test(fileName)) continue
    for (const specifier of runtimeRelativeImports(fs.readFileSync(fileName, 'utf8'), fileName)) {
      let resolved: string
      try {
        resolved = resolveTypeScriptImport(fileName, specifier)
      } catch (error) {
        if (!specifier.endsWith('.js')) throw error
        resolved = resolveTypeScriptImport(fileName, specifier.slice(0, -3))
      }
      pending.push(resolved)
    }
  }
  return [...seen]
}

describe('checkup worker: module boundary and packaging', () => {
  const rel = (fileName: string): string => path.relative(ROOT, fileName).split(path.sep).join('/')

  it('never imports the CLI (src/cli/index.ts runs the CLI when it loads)', () => {
    const closure = runtimeClosure(path.join(ROOT, 'src', 'checkup', 'cli-worker.ts')).map(rel)
    expect(closure.filter((fileName) => fileName.startsWith('src/cli/'))).toEqual([])
    expect(closure).toContain('src/checkup/run.ts')
  })

  it('is a main build entry, shipped next to the CLI and allowed by the package policy', () => {
    expect(fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8'))
      .toContain("'checkup-worker': resolve(__dirname, 'src/checkup/cli-worker.ts')")
    expect(fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8'))
      .toMatch(/- from: out\/main\/checkup-worker\.js\n\s+to: cli\/checkup-worker\.js\n/)
    expect(fs.readFileSync(path.join(ROOT, 'scripts', 'check-package.mjs'), 'utf8')).toContain("'cli/checkup-worker.js',")
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'cli-packaged.yml'), 'utf8')
    expect(workflow.match(/- 'src\/checkup\/\*\*'/g)).toHaveLength(2)
  })
})
