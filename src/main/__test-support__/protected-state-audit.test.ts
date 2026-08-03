import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assertProtectedRealStateUnchanged,
  snapshotProtectedRealState
} from './protected-state-audit'

const temporaryRoots: string[] = []

function protectedFixture(): {
  environment: NodeJS.ProcessEnv
  home: string
  options: { nativeHome: string }
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-protected-audit-'))
  temporaryRoots.push(home)
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  return {
    home,
    environment: { SWOB_ISOLATION_PROTECTED_HOME: home },
    options: { nativeHome: home }
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('protected real-state audit', () => {
  it('fails when the test changes protected user configuration', () => {
    const { environment, home, options } = protectedFixture()
    const before = snapshotProtectedRealState(environment, options)

    fs.writeFileSync(path.join(home, '.claude-session-manager', 'test-owned-write.json'), '{}')

    expect(() => assertProtectedRealStateUnchanged(before, environment, options))
      .toThrow(/protected user-config-1 changed/)
  })

  it('fails when the test modifies a stable protected configuration file', () => {
    const { environment, home, options } = protectedFixture()
    const config = path.join(home, '.claude-session-manager', 'app-config.json')
    fs.writeFileSync(config, '{"theme":"light"}')
    const before = snapshotProtectedRealState(environment, options)

    fs.writeFileSync(config, '{"theme":"dark"}')

    expect(() => assertProtectedRealStateUnchanged(before, environment, options))
      .toThrow(/protected user-config-1 changed/)
  })

  it('fails when the test deletes a stable protected configuration file', () => {
    const { environment, home, options } = protectedFixture()
    const config = path.join(home, '.claude-session-manager', 'app-config.json')
    fs.writeFileSync(config, '{"theme":"light"}')
    const before = snapshotProtectedRealState(environment, options)

    fs.rmSync(config)

    expect(() => assertProtectedRealStateUnchanged(before, environment, options))
      .toThrow(/protected user-config-1 changed/)
  })

  it('fails when a test-owned write is removed before the final snapshot', () => {
    const { environment, home, options } = protectedFixture()
    const before = snapshotProtectedRealState(environment, options)
    const transient = path.join(home, '.claude-session-manager', 'transient-test-write.json')

    fs.writeFileSync(transient, '{}')
    fs.rmSync(transient)

    expect(() => assertProtectedRealStateUnchanged(before, environment, options))
      .toThrow(/protected user-config-1 changed/)
  })

  it('reports but excludes a concurrent production summary-cache replacement', () => {
    const { environment, home, options } = protectedFixture()
    const cache = path.join(home, '.claude-session-manager', 'summary-cache.json')
    fs.writeFileSync(cache, '{"version":1}')
    const before = snapshotProtectedRealState(environment, options)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    fs.writeFileSync(cache, '{"version":2}')

    expect(() => assertProtectedRealStateUnchanged(before, environment, options)).not.toThrow()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('concurrent production summary-cache'))
  })

  it('excludes a production cache transaction interleaved across snapshot phases', () => {
    const { environment, home, options } = protectedFixture()
    const cache = path.join(home, '.claude-session-manager', 'summary-cache.json')
    fs.writeFileSync(cache, '{"version":1}')
    const temporary = `${cache}.123.1.tmp`
    const before = snapshotProtectedRealState(environment, options, {
      onPhase: ({ label, phase }) => {
        if (label !== 'user-config-1') return
        if (phase === 'after-leading-cache-scan') {
          fs.writeFileSync(temporary, '{"version":2}')
        }
        if (phase === 'after-stable-metadata-cache-scan') {
          fs.renameSync(temporary, cache)
        }
      }
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const completedTransaction = snapshotProtectedRealState(environment, options)
    const withoutTransactionEvidence = {
      entries: before.entries.map((entry, index) => ({
        ...entry,
        concurrentCacheDigest: completedTransaction.entries[index].concurrentCacheDigest,
        concurrentCacheDigests: completedTransaction.entries[index].concurrentCacheDigests
      }))
    }

    expect(fs.existsSync(temporary)).toBe(false)
    expect(fs.readFileSync(cache, 'utf8')).toBe('{"version":2}')
    expect(() => assertProtectedRealStateUnchanged(withoutTransactionEvidence, environment, options))
      .toThrow(/protected user-config-1 changed/)
    expect(() => assertProtectedRealStateUnchanged(before, environment, options)).not.toThrow()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('concurrent production summary-cache'))
  })

  it('excludes cleanup of a legal production cache temporary file during a snapshot', () => {
    const { environment, home, options } = protectedFixture()
    const cache = path.join(home, '.claude-session-manager', 'summary-cache.json')
    const temporary = `${cache}.123.2.tmp`
    fs.writeFileSync(cache, '{"version":1}')
    const before = snapshotProtectedRealState(environment, options, {
      onPhase: ({ label, phase }) => {
        if (label !== 'user-config-1') return
        if (phase === 'after-leading-cache-scan') {
          fs.writeFileSync(temporary, '{"incomplete":true}')
        }
        if (phase === 'after-stable-metadata-cache-scan') {
          fs.rmSync(temporary)
        }
      }
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(fs.existsSync(temporary)).toBe(false)
    expect(() => assertProtectedRealStateUnchanged(before, environment, options)).not.toThrow()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('concurrent production summary-cache'))
  })

  it('fails closed for an unrecognized summary-cache-shaped temporary write and cleanup', () => {
    const { environment, home, options } = protectedFixture()
    const before = snapshotProtectedRealState(environment, options)
    const temporary = path.join(
      home,
      '.claude-session-manager',
      'summary-cache.json.external.tmp'
    )

    fs.writeFileSync(temporary, '{"not":"a production transaction"}')
    fs.rmSync(temporary)

    expect(() => assertProtectedRealStateUnchanged(before, environment, options))
      .toThrow(/protected user-config-1 changed/)
  })

  it('fails closed for a stable config write even when a production cache changes', () => {
    const { environment, home, options } = protectedFixture()
    const configDirectory = path.join(home, '.claude-session-manager')
    const cache = path.join(configDirectory, 'summary-cache.json')
    fs.writeFileSync(cache, '{"version":1}')
    const before = snapshotProtectedRealState(environment, options)

    fs.writeFileSync(cache, '{"version":2}')
    fs.writeFileSync(path.join(configDirectory, 'test-owned-write.json'), '{}')

    expect(() => assertProtectedRealStateUnchanged(before, environment, options))
      .toThrow(/protected user-config-1 changed/)
  })
})
