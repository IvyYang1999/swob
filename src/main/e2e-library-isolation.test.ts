import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertE2ELibraryPath,
  assertTestLaunchContract,
  E2ELibraryIsolationError,
  runtimeSafetyState,
  type IsolationEnvironment
} from './e2e-library-isolation'

const temporaryRoots: string[] = []

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-${label}-`))
  temporaryRoots.push(root)
  return root
}

function isolatedEnvironment(sandbox: string): IsolationEnvironment {
  const home = path.join(sandbox, 'home')
  const library = path.join(sandbox, 'Library')
  const userData = path.join(sandbox, 'user-data')
  for (const directory of [home, library, userData]) fs.mkdirSync(directory, { recursive: true })
  return {
    HOME: home,
    NODE_ENV: 'test',
    SWOB_TEST_HOME: home,
    SWOB_E2E_SANDBOX_ROOT: sandbox,
    SWOB_TEST_SYSTEM_TEMP_ROOT: os.tmpdir(),
    SWOB_LIBRARY_ROOT: library,
    SWOB_USER_DATA_ROOT: userData
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('test runtime launch contract', () => {
  it('treats the Playwright runner marker as fail-closed even when NODE_ENV is absent', () => {
    expect(() => assertE2ELibraryPath('/tmp/Library', { SWOB_E2E_RUNNER: '1' }))
      .toThrowError('Runtime isolation failed: missing-HOME')
  })

  it.each([
    'HOME',
    'SWOB_TEST_HOME',
    'SWOB_E2E_SANDBOX_ROOT',
    'SWOB_TEST_SYSTEM_TEMP_ROOT',
    'SWOB_LIBRARY_ROOT',
    'SWOB_USER_DATA_ROOT'
  ] as const)('fails before launch when %s is missing', (name) => {
    const sandbox = temporaryRoot('missing-variable')
    const environment = isolatedEnvironment(sandbox)
    delete environment[name]

    expect(() => assertE2ELibraryPath(path.join(sandbox, 'Library'), environment))
      .toThrowError(`Runtime isolation failed: missing-${name}`)
  })

  it('rejects an actual Electron userData path that differs from the declared path', () => {
    const sandbox = temporaryRoot('user-data-mismatch')
    const environment = isolatedEnvironment(sandbox)

    expect(() => assertTestLaunchContract(
      environment,
      path.join(sandbox, 'other-user-data')
    )).toThrowError(/actual-userData-does-not-match-SWOB_USER_DATA_ROOT/)
  })

  it('rejects configured Libraries outside the explicit sandbox', () => {
    const sandbox = temporaryRoot('outside-library')
    const outside = temporaryRoot('outside-sentinel')
    const environment = isolatedEnvironment(sandbox)
    environment.SWOB_LIBRARY_ROOT = outside

    expect(() => assertE2ELibraryPath(outside, environment))
      .toThrowError(/SWOB_LIBRARY_ROOT-outside-sandbox/)
  })

  it('rejects a sandbox-local symlink that escapes to an external Library', () => {
    const sandbox = temporaryRoot('symlink-sandbox')
    const outside = temporaryRoot('symlink-target')
    const environment = isolatedEnvironment(sandbox)
    const linkedLibrary = path.join(sandbox, 'linked-Library')
    fs.symlinkSync(outside, linkedLibrary)
    environment.SWOB_LIBRARY_ROOT = linkedLibrary

    expect(() => assertE2ELibraryPath(linkedLibrary, environment))
      .toThrowError(/SWOB_LIBRARY_ROOT-canonical-outside-sandbox/)
  })

  it('accepts a complete explicit contract contained by the temporary sandbox', () => {
    const sandbox = temporaryRoot('safe-sandbox')
    const environment = isolatedEnvironment(sandbox)

    expect(assertE2ELibraryPath(environment.SWOB_LIBRARY_ROOT!, environment))
      .toBe(environment.SWOB_LIBRARY_ROOT)
    expect(() => assertTestLaunchContract(environment, environment.SWOB_USER_DATA_ROOT!, {
      systemTemporaryRoot: os.tmpdir()
    })).not.toThrow()
  })
})

describe('real Library protection and development override', () => {
  function protectedFixture(): { protectedHome: string; realLibrary: string } {
    const protectedHome = temporaryRoot('protected-home')
    const realLibrary = path.join(protectedHome, 'Vault', 'Swob')
    fs.mkdirSync(path.join(protectedHome, '.claude-session-manager'), { recursive: true })
    fs.mkdirSync(realLibrary, { recursive: true })
    fs.writeFileSync(
      path.join(protectedHome, '.claude-session-manager', 'app-config.json'),
      JSON.stringify({ libraryPath: realLibrary })
    )
    return { protectedHome, realLibrary }
  }

  it.each(['exact', 'parent', 'descendant'] as const)(
    'CI counterexample: a test process pointing at the %s real Library relation fails',
    (relation) => {
      const sandbox = temporaryRoot(`real-counterexample-${relation}`)
      const environment = isolatedEnvironment(sandbox)
      const { protectedHome, realLibrary } = protectedFixture()
      const candidate = relation === 'exact'
        ? realLibrary
        : relation === 'parent'
          ? path.dirname(realLibrary)
          : path.join(realLibrary, 'child')
      environment.SWOB_LIBRARY_ROOT = candidate
      environment.SWOB_ISOLATION_PROTECTED_HOME = protectedHome

      expect(() => assertE2ELibraryPath(candidate, environment))
        .toThrowError(/overlaps-protected-real-state/)
    }
  )

  it('blocks development against a real Library without the explicit dangerous switch', () => {
    const { protectedHome, realLibrary } = protectedFixture()
    const environment: IsolationEnvironment = {
      HOME: protectedHome,
      NODE_ENV: 'development',
      SWOB_LIBRARY_ROOT: realLibrary,
      SWOB_ISOLATION_PROTECTED_HOME: protectedHome
    }

    expect(() => runtimeSafetyState(realLibrary, environment))
      .toThrowError(/development-real-library-requires-SWOB_DEV_USE_REAL_LIBRARY=1/)
  })

  it('labels development against a real Library only with the explicit dangerous switch', () => {
    const { protectedHome, realLibrary } = protectedFixture()
    const environment: IsolationEnvironment = {
      HOME: protectedHome,
      NODE_ENV: 'development',
      SWOB_LIBRARY_ROOT: realLibrary,
      SWOB_ISOLATION_PROTECTED_HOME: protectedHome,
      SWOB_DEV_USE_REAL_LIBRARY: '1'
    }

    expect(runtimeSafetyState(realLibrary, environment)).toEqual({
      mode: 'dangerous-real-library-development',
      dangerousRealLibrary: true,
      marker: 'DEV · REAL LIBRARY'
    })
  })

  it('stays inert for a production runtime without test markers', () => {
    const productionLibrary = '/Users/example/Documents/Swob'
    expect(runtimeSafetyState(productionLibrary, { NODE_ENV: 'production' })).toEqual({
      mode: 'production',
      dangerousRealLibrary: false,
      marker: null
    })
  })
})

it('keeps the readable typed error contract', () => {
  const error = new E2ELibraryIsolationError('<unset>', '<unset>', 'missing-HOME')
  expect(error.message).toBe('Runtime isolation failed: missing-HOME')
  expect(error.reason).toBe('missing-HOME')
})
