import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SELF_TEST_CASES } from '../contract'
import { CASE_SWOB_SIDE, runSelfTest } from './run-self-test'

const roots: string[] = []
function workDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkup-self-test-unit-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('checkup self-test (referee fault classes 1-6)', () => {
  it('passes all six classes with stand-in readouts', async () => {
    const result = await runSelfTest({ workDir: workDir(), salt: 'unit-salt' })
    expect(result.cases.map((entry) => entry.id)).toEqual([...SELF_TEST_CASES])
    expect(result.cases.filter((entry) => !entry.passed)).toEqual([])
    expect(result).toMatchObject({ passed: 6, total: 6 })
  })

  it('never calls the kernel: every class uses an injected Swob readout', async () => {
    const sessionLoader = await import('../../main/session-loader')
    const spy = vi.spyOn(sessionLoader, 'parseSessionFile')
    const result = await runSelfTest({ workDir: workDir(), salt: 'unit-salt' })
    expect(result.passed).toBe(6)
    expect(spy).not.toHaveBeenCalled()
    expect(Object.values(CASE_SWOB_SIDE).every((side) => side.startsWith('injected-') || side === 'census-only')).toBe(true)
    spy.mockRestore()
  })

  it('writes samples only below the given work directory', async () => {
    const dir = workDir()
    await runSelfTest({ workDir: dir, salt: 'unit-salt' })
    expect(fs.readdirSync(dir).sort()).toEqual([...SELF_TEST_CASES].sort())
  })
})
