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

describe('checkup self-test (referee fault classes 1-7)', () => {
  it('passes all seven classes with stand-in readouts', async () => {
    const result = await runSelfTest({ workDir: workDir(), salt: 'unit-salt' })
    expect(result.cases.map((entry) => entry.id)).toEqual([...SELF_TEST_CASES])
    expect(result.cases.filter((entry) => !entry.passed)).toEqual([])
    expect(result).toMatchObject({ passed: 7, total: 7 })
  })

  it('never calls the kernel: every class uses an injected Swob readout', async () => {
    const sessionLoader = await import('../../main/session-loader')
    const spy = vi.spyOn(sessionLoader, 'parseSessionFile')
    const result = await runSelfTest({ workDir: workDir(), salt: 'unit-salt' })
    expect(result.passed).toBe(7)
    expect(spy).not.toHaveBeenCalled()
    expect(Object.values(CASE_SWOB_SIDE).every((side) => side.startsWith('injected-') || side === 'census-only')).toBe(true)
    spy.mockRestore()
  })

  it('writes samples only below the given work directory', async () => {
    const dir = workDir()
    await runSelfTest({ workDir: dir, salt: 'unit-salt' })
    expect(fs.readdirSync(dir).sort()).toEqual([...SELF_TEST_CASES].sort())
  })

  it('writes Codex compacted rows in the dominant real signature, every Codex row carrying an ordinal', async () => {
    const dir = workDir()
    await runSelfTest({ workDir: dir, salt: 'unit-salt' })
    const codexFiles: string[] = []
    const walk = (current: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) codexFiles.push(full)
      }
    }
    walk(dir)
    const rows = codexFiles.flatMap((file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    const compacted = rows.filter((row) => row.type === 'compacted')
    expect(compacted.length).toBeGreaterThanOrEqual(4)
    for (const row of compacted) {
      expect(Object.keys(row)).toEqual(['timestamp', 'ordinal', 'type', 'payload'])
      expect(Object.keys(row.payload)).toEqual([
        'message', 'replacement_history', 'window_number', 'first_window_id',
        'previous_window_id', 'window_id', 'compaction_response_id', 'latest_token_usage_record'
      ])
      expect(Array.isArray(row.payload.replacement_history) && row.payload.replacement_history.length > 0).toBe(true)
    }
    for (const row of rows) expect(typeof row.ordinal).toBe('number')
    const legacyCase = codexFiles.filter((file) => file.includes(`${path.sep}codex-legacy-compacted${path.sep}`))
    expect(legacyCase).toHaveLength(1)
  })
})
