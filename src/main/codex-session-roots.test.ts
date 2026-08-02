import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configuredCodexRoots,
  loadAdditionalCodexHomes,
  matchConfiguredCodexSessionPath,
  normalizeAdditionalCodexHomes,
  saveAdditionalCodexHomes
} from './codex-session-roots'

const temporaryDirectories: string[] = []

function temporaryHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-codex-roots-'))
  temporaryDirectories.push(home)
  return home
}

afterEach(() => {
  delete process.env.CODEX_HOME
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex machine-local roots', () => {
  it('persists multiple absolute CODEX_HOME paths and deduplicates canonical aliases', () => {
    const home = temporaryHome()
    const work = path.join(home, 'codex-work')
    const personal = path.join(home, 'codex-personal')
    fs.mkdirSync(work)
    fs.mkdirSync(personal)

    expect(saveAdditionalCodexHomes([work, work, personal], home)).toEqual([work, personal])
    expect(loadAdditionalCodexHomes(home)).toEqual([work, personal])
    expect(configuredCodexRoots(home).map((root) => root.home)).toEqual([
      path.join(home, '.codex'), work, personal
    ])

    fs.rmSync(personal, { recursive: true })
    expect(loadAdditionalCodexHomes(home)).toEqual([work, personal])
  })

  it('rejects relative paths, missing directories, and session subdirectories', () => {
    const home = temporaryHome()
    const codexHome = path.join(home, 'custom')
    fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true })

    expect(() => normalizeAdditionalCodexHomes(['relative'])).toThrow(/absolute/)
    expect(() => normalizeAdditionalCodexHomes([path.join(home, 'missing')])).toThrow(/existing/)
    expect(() => normalizeAdditionalCodexHomes([path.join(codexHome, 'sessions')])).toThrow(/CODEX_HOME/)
  })

  it('combines the default, environment, and additional CODEX_HOME roots once', () => {
    const home = temporaryHome()
    const environmentHome = path.join(home, 'codex-environment')
    const additionalHome = path.join(home, 'codex-additional')
    fs.mkdirSync(environmentHome)
    fs.mkdirSync(additionalHome)
    process.env.CODEX_HOME = environmentHome
    saveAdditionalCodexHomes([environmentHome, additionalHome], home)

    expect(configuredCodexRoots(home).map((root) => [root.home, root.origin])).toEqual([
      [path.join(home, '.codex'), 'default'],
      [environmentHome, 'environment'],
      [additionalHome, 'additional']
    ])
  })

  it('matches active and archived rollouts but rejects a symlink escape', () => {
    const home = temporaryHome()
    const codexHome = path.join(home, 'custom')
    const active = path.join(codexHome, 'sessions', '2026', '08', '02', 'rollout-active.jsonl')
    const archived = path.join(codexHome, 'archived_sessions', 'rollout-archived.jsonl')
    const outside = path.join(home, 'outside.jsonl')
    fs.mkdirSync(path.dirname(active), { recursive: true })
    fs.mkdirSync(path.dirname(archived), { recursive: true })
    fs.writeFileSync(active, '{}\n')
    fs.writeFileSync(archived, '{}\n')
    fs.writeFileSync(outside, '{}\n')
    saveAdditionalCodexHomes([codexHome], home)

    expect(matchConfiguredCodexSessionPath(active, home)?.lifecycleState).toBe('active')
    expect(matchConfiguredCodexSessionPath(archived, home)?.lifecycleState).toBe('archived')

    const escaped = path.join(codexHome, 'sessions', 'rollout-escaped.jsonl')
    fs.symlinkSync(outside, escaped)
    expect(matchConfiguredCodexSessionPath(escaped, home)).toBeNull()
  })
})
