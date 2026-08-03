import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_SESSION_SOURCES } from '../../shared/provider-capabilities'
import {
  ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES,
  assertProviderHomeEnvironmentIsolated,
  isolateProviderHomeEnvironment,
  PLATFORM_HOME_ENVIRONMENT_VARIABLES,
  PROVIDER_HOME_ENVIRONMENT_VARIABLES
} from './provider-home-isolation'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-provider-home-isolation-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('provider home isolation', () => {
  it('enumerates every builtin provider instead of special-casing Codex', () => {
    expect(Object.keys(PROVIDER_HOME_ENVIRONMENT_VARIABLES)).toEqual([...LEGACY_SESSION_SOURCES])
  })

  it('clears polluted provider overrides and contains every platform home in the sandbox', () => {
    const sandboxRoot = temporaryRoot()
    const environment = Object.fromEntries([
      ...ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES,
      ...PLATFORM_HOME_ENVIRONMENT_VARIABLES
    ].map((name) => [name, `/outside/${name.toLowerCase()}`])) as NodeJS.ProcessEnv

    isolateProviderHomeEnvironment(environment, sandboxRoot)

    expect(() => assertProviderHomeEnvironmentIsolated(environment, sandboxRoot)).not.toThrow()
    for (const name of ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES) {
      expect(environment[name]).toBeUndefined()
    }
  })

  it('passes only isolated provider homes to child processes', () => {
    const names = [...ALL_PROVIDER_HOME_ENVIRONMENT_VARIABLES, ...PLATFORM_HOME_ENVIRONMENT_VARIABLES]
    const child = spawnSync(process.execPath, [
      '-e',
      `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((name) => [name, process.env[name]]))))`
    ], { env: process.env, encoding: 'utf8' })

    expect(child.status).toBe(0)
    const inherited = JSON.parse(child.stdout) as NodeJS.ProcessEnv
    expect(() => assertProviderHomeEnvironmentIsolated(
      inherited,
      process.env.SWOB_E2E_SANDBOX_ROOT!
    )).not.toThrow()
  })
})
