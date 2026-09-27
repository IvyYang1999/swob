import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CANARY, buildSampleHome } from './__test-support__/sample-home'

const SCRIPT = path.join(process.cwd(), 'scripts', 'checkup-dev.mjs')
const dirs: string[] = []
let sampleHome: string

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 120_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

beforeAll(() => {
  sampleHome = tempDir('checkup-dev-home-')
  buildSampleHome(sampleHome)
})
afterAll(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('scripts/checkup-dev.mjs', () => {
  it('runs isolated, writes a clean report under --home (outside source roots) and leaves --state empty', () => {
    const stateDir = tempDir('checkup-dev-state-')
    const json = path.join(sampleHome, 'reports', 'baseline.json')
    fs.mkdirSync(path.dirname(json))
    const result = run(['--home', sampleHome, '--state', stateDir, '--json', json])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(fs.readdirSync(stateDir)).toEqual([])
    const report = JSON.parse(fs.readFileSync(json, 'utf8'))
    expect(report.readout).toEqual({ status: 'ok' })
    expect(report.kernel.selfTest).toEqual({ passed: 7, total: 7 })
    const output = `${result.stdout}${fs.readFileSync(json, 'utf8')}`
    for (const canary of Object.values(CANARY)) expect(output.includes(canary), canary).toBe(false)
    const audit = JSON.parse(result.stdout.trim().split('\n').at(-1)!).readonlyAudit
    expect(audit).toMatchObject({ stateDirUnchanged: true, appSupportUnchanged: true, libraryDotSwobUnchanged: true, sourceMainDbUnchanged: true, sidecarsTouched: [] })
  }, 120_000)

  it('refuses --json inside a source root and a non-empty --state, writing nothing', () => {
    const stateDir = tempDir('checkup-dev-state-')
    const inSource = path.join(sampleHome, '.claude', 'report.json')
    const refused = run(['--home', sampleHome, '--state', stateDir, '--json', inSource])
    expect(refused.status).toBe(2)
    expect(fs.existsSync(inSource)).toBe(false)
    fs.writeFileSync(path.join(stateDir, 'occupied'), '')
    const busy = run(['--home', sampleHome, '--state', stateDir, '--json', path.join(stateDir, '..', 'x.json')])
    expect(busy.status).toBe(2)
    expect(busy.stderr).toContain('state-dir-not-empty')
    expect(fs.readdirSync(stateDir)).toEqual(['occupied'])
  }, 120_000)

  /** The owner's layout: the configured library root is a whole vault with Swob state and packages inside. */
  function configureVault(): { vault: string; pkg: string } {
    const vault = tempDir('checkup-dev-vault-')
    fs.mkdirSync(path.join(vault, '.swob'), { recursive: true })
    fs.mkdirSync(path.join(vault, '项目', '体检'), { recursive: true })
    const pkg = path.join(vault, 'Swob', 'sessions', 'pkg-1')
    fs.mkdirSync(pkg, { recursive: true })
    fs.writeFileSync(path.join(pkg, '.swob-session.json'), '{}')
    fs.mkdirSync(path.join(sampleHome, '.claude-session-manager'), { recursive: true })
    fs.writeFileSync(path.join(sampleHome, '.claude-session-manager', 'app-config.json'), JSON.stringify({ libraryPath: vault }))
    return { vault, pkg }
  }

  it('writes --json into an ordinary directory of the configured library root (the vault)', () => {
    const { vault } = configureVault()
    const stateDir = tempDir('checkup-dev-state-')
    const json = path.join(vault, '项目', '体检', 'baseline.json')
    const result = run(['--home', sampleHome, '--state', stateDir, '--json', json])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(JSON.parse(fs.readFileSync(json, 'utf8')).schemaVersion).toBe(1)
    expect(fs.readdirSync(stateDir)).toEqual([])
    const audit = JSON.parse(result.stdout.trim().split('\n').at(-1)!).readonlyAudit
    expect(audit).toMatchObject({ stateDirUnchanged: true, libraryDotSwobUnchanged: true, sourceMainDbUnchanged: true })
  }, 120_000)

  it('refuses --json in <library>/.swob, a session package, a source root, Swob state, App Support/Swob and --state (exit 2)', () => {
    const { vault, pkg } = configureVault()
    const stateDir = tempDir('checkup-dev-state-')
    fs.mkdirSync(path.join(sampleHome, 'Library', 'Application Support', 'Swob'), { recursive: true })
    const cases: Array<[string, string]> = [
      [path.join(vault, '.swob', 'x.json'), 'report-target-in-library-state'],
      [path.join(pkg, 'x.json'), 'report-target-in-session-package'],
      [path.join(sampleHome, '.codex', 'x.json'), 'report-target-in-source-root'],
      [path.join(sampleHome, '.claude-session-manager', 'x.json'), 'report-target-in-swob-state'],
      [path.join(sampleHome, 'Library', 'Application Support', 'Swob', 'x.json'), 'report-target-in-app-support'],
      [path.join(stateDir, 'x.json'), 'report-target-in-state-dir']
    ]
    for (const [json, reason] of cases) {
      const refused = run(['--home', sampleHome, '--state', stateDir, '--json', json])
      expect(refused.status, reason).toBe(2)
      expect(refused.stderr, reason).toContain(reason)
      expect(fs.existsSync(json), reason).toBe(false)
    }
    expect(fs.readdirSync(stateDir)).toEqual([])
  }, 120_000)
})
