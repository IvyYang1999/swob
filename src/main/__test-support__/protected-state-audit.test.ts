import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertProtectedRealStateUnchanged,
  snapshotProtectedRealState
} from './protected-state-audit'

const temporaryRoots: string[] = []

function protectedFixture(): { environment: NodeJS.ProcessEnv; home: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-protected-audit-'))
  temporaryRoots.push(home)
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  return {
    home,
    environment: { SWOB_ISOLATION_PROTECTED_HOME: home }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('protected real-state audit', () => {
  it('fails when the test changes protected user configuration', () => {
    const { environment, home } = protectedFixture()
    const before = snapshotProtectedRealState(environment)

    fs.writeFileSync(path.join(home, '.claude-session-manager', 'test-owned-write.json'), '{}')

    expect(() => assertProtectedRealStateUnchanged(before, environment))
      .toThrow(/protected user-config-3 changed/)
  })

  it('fails when a test-owned write is removed before the final snapshot', () => {
    const { environment, home } = protectedFixture()
    const before = snapshotProtectedRealState(environment)
    const transient = path.join(home, '.claude-session-manager', 'transient-test-write.json')

    fs.writeFileSync(transient, '{}')
    fs.rmSync(transient)

    expect(() => assertProtectedRealStateUnchanged(before, environment))
      .toThrow(/protected user-config-3 changed/)
  })

  it('reports but excludes a concurrent production summary-cache replacement', () => {
    const { environment, home } = protectedFixture()
    const cache = path.join(home, '.claude-session-manager', 'summary-cache.json')
    fs.writeFileSync(cache, '{"version":1}')
    const before = snapshotProtectedRealState(environment)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const temporary = `${cache}.external.tmp`
    fs.writeFileSync(temporary, '{"version":2}')
    fs.renameSync(temporary, cache)

    expect(() => assertProtectedRealStateUnchanged(before, environment)).not.toThrow()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('concurrent production summary-cache'))
  })
})
