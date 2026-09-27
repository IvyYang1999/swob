import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The kernel HOME is forced to the *real* account home: the guard must refuse
// before any kernel entry runs. Every kernel entry is a spy so a single call
// would be visible (and none of them can touch real data).
vi.mock('../main/runtime-home', () => ({ runtimeHome: vi.fn(() => os.userInfo().homedir) }))
vi.mock('../main/session-loader', () => ({
  loadAllSessions: vi.fn(async () => []),
  parseSessionFile: vi.fn(async () => []),
  findClaudeSessionFiles: vi.fn(() => [])
}))
vi.mock('../main/codex-loader', () => ({ findCodexSessionFiles: vi.fn(() => []) }))

import * as sessionLoader from '../main/session-loader'
import * as codexLoader from '../main/codex-loader'
import { checkKernelIsolation, readSwobReadout, realpathOfPossiblyMissing } from './readout'
import { runKernelCheckup } from './run'
import { claude, jsonl, syntheticTime, syntheticUuid, writeSample } from './self-test/samples'

const dirs: string[] = []
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return fs.realpathSync(dir)
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function expectNoKernelCall(): void {
  expect(sessionLoader.loadAllSessions).not.toHaveBeenCalled()
  expect(sessionLoader.parseSessionFile).not.toHaveBeenCalled()
  expect(sessionLoader.findClaudeSessionFiles).not.toHaveBeenCalled()
  expect(codexLoader.findCodexSessionFiles).not.toHaveBeenCalled()
}

describe('readout isolation guard (fail-closed)', () => {
  it('refuses when the kernel would read the real ~/.claude-session-manager, calling no kernel entry', async () => {
    const stateDir = tempDir('checkup-guard-state-')
    const readout = await readSwobReadout({ stateDir, claudeMainFiles: [path.join(stateDir, 'x.jsonl')] })
    expect(readout).toMatchObject({ status: 'undetermined', reason: 'readout.not-isolated', sessions: [] })
    expectNoKernelCall()
  })

  it('a full checkup still runs the census and self-test but leaves the Swob side undetermined', async () => {
    const stateDir = tempDir('checkup-guard-state-')
    const sampleHome = tempDir('checkup-guard-home-')
    const sid = syntheticUuid(7)
    writeSample(sampleHome, path.join('.claude', 'projects', '-p', `${sid}.jsonl`), jsonl([
      claude.user({ uuid: syntheticUuid(70), parentUuid: null, sessionId: sid, timestamp: syntheticTime(1), cwd: '/p', text: 'q' })
    ]))
    const report = await runKernelCheckup({ homeDir: sampleHome, stateDir, privacySalt: 'guard' })
    expectNoKernelCall()
    expect(report.readout).toEqual({ status: 'undetermined', reason: 'readout.not-isolated' })
    expect(report.kernel.selfTest).toEqual({ passed: 7, total: 7 })
    expect(report.checks.slice(0, 3).map((check) => [check.id, check.verdict, check.reason])).toEqual([
      ['inclusion', 'undetermined', 'readout.not-isolated'],
      ['content', 'undetermined', 'readout.not-isolated'],
      ['compaction', 'undetermined', 'readout.not-isolated']
    ])
    expect(report.verdict).toBe('undetermined')
    expect(report.units?.every((unit) => unit.bucket === null)).toBe(true)
    expect(fs.readdirSync(stateDir)).toEqual([])
  })
})

describe('checkKernelIsolation (pure)', () => {
  const realUserHome = os.userInfo().homedir

  it('accepts a cache directory strictly inside stateDir and an unchanged HOME', () => {
    const stateDir = tempDir('checkup-guard-pure-')
    const kernelHome = path.join(stateDir, 'home')
    fs.mkdirSync(path.join(kernelHome, '.claude-session-manager'), { recursive: true })
    expect(checkKernelIsolation({ kernelHome, kernelHomeAtLoad: kernelHome, stateDir, env: {}, realUserHome })).toEqual({ isolated: true })
    // Missing cache directory is resolved through its nearest existing ancestor.
    fs.rmSync(path.join(kernelHome, '.claude-session-manager'), { recursive: true })
    expect(checkKernelIsolation({ kernelHome, kernelHomeAtLoad: kernelHome, stateDir, env: {}, realUserHome }).isolated).toBe(true)
  })

  it('refuses when HOME changed after the kernel loaded', () => {
    const stateDir = tempDir('checkup-guard-pure-')
    const kernelHome = path.join(stateDir, 'home')
    expect(checkKernelIsolation({ kernelHome, kernelHomeAtLoad: realUserHome, stateDir, env: {}, realUserHome }))
      .toEqual({ isolated: false, reason: 'readout.not-isolated' })
  })

  it('refuses the real cache directory and paths outside stateDir / the sandbox', () => {
    const stateDir = tempDir('checkup-guard-pure-')
    const outside = tempDir('checkup-guard-outside-')
    expect(checkKernelIsolation({ kernelHome: realUserHome, kernelHomeAtLoad: realUserHome, stateDir, env: {}, realUserHome }).isolated).toBe(false)
    expect(checkKernelIsolation({ kernelHome: outside, kernelHomeAtLoad: outside, stateDir, env: {}, realUserHome }).isolated).toBe(false)
  })

  it('allows the Vitest sandbox only under VITEST + NODE_ENV=test + SWOB_E2E_SANDBOX_ROOT', () => {
    const stateDir = tempDir('checkup-guard-pure-')
    const sandbox = tempDir('checkup-guard-sandbox-')
    const kernelHome = path.join(sandbox, 'home')
    const env = { VITEST: 'true', NODE_ENV: 'test', SWOB_E2E_SANDBOX_ROOT: sandbox }
    expect(checkKernelIsolation({ kernelHome, kernelHomeAtLoad: kernelHome, stateDir, env, realUserHome }).isolated).toBe(true)
    expect(checkKernelIsolation({ kernelHome, kernelHomeAtLoad: kernelHome, stateDir, env: { ...env, VITEST: undefined }, realUserHome }).isolated).toBe(false)
    expect(checkKernelIsolation({ kernelHome, kernelHomeAtLoad: kernelHome, stateDir, env: { ...env, NODE_ENV: 'production' }, realUserHome }).isolated).toBe(false)
  })

  it('resolves possibly-missing paths through their nearest existing ancestor', () => {
    const dir = tempDir('checkup-guard-real-')
    expect(realpathOfPossiblyMissing(path.join(dir, 'a', 'b'))).toBe(path.join(dir, 'a', 'b'))
  })
})
