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
    expect(report.kernel.selfTest).toEqual({ passed: 6, total: 6 })
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
})
