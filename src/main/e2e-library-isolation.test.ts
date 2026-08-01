import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertE2ELibraryPath,
  assertTestDefaultLibraryPath,
  E2ELibraryIsolationError
} from './e2e-library-isolation'

const temporaryRoots: string[] = []

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `swob-${label}-`))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('E2E Library isolation', () => {
  it('rejects an environment-selected real Library outside an isolated test HOME', () => {
    const sandbox = temporaryRoot('e2e-sandbox')
    const home = path.join(sandbox, 'home')
    const outside = temporaryRoot('real-library-sentinel')
    fs.mkdirSync(home, { recursive: true })

    expect(() => assertTestDefaultLibraryPath(outside, {
      SWOB_TEST_HOME: home,
      SWOB_LIBRARY_ROOT: outside
    })).toThrow(E2ELibraryIsolationError)
  })

  it('rejects configured Libraries outside the explicit E2E sandbox', () => {
    const sandbox = temporaryRoot('e2e-sandbox')
    const home = path.join(sandbox, 'home')
    const outside = temporaryRoot('real-library-sentinel')
    fs.mkdirSync(home, { recursive: true })

    expect(() => assertE2ELibraryPath(outside, {
      NODE_ENV: 'test',
      SWOB_TEST_HOME: home,
      SWOB_E2E_SANDBOX_ROOT: sandbox
    })).toThrowError(/outside-sandbox/)
  })

  it('rejects a sandbox-local symlink that escapes to an external Library', () => {
    const sandbox = temporaryRoot('e2e-sandbox')
    const home = path.join(sandbox, 'home')
    const outside = temporaryRoot('real-library-sentinel')
    const linkedLibrary = path.join(sandbox, 'Library')
    fs.mkdirSync(home, { recursive: true })
    fs.symlinkSync(outside, linkedLibrary)

    expect(() => assertE2ELibraryPath(linkedLibrary, {
      NODE_ENV: 'test',
      SWOB_TEST_HOME: home,
      SWOB_E2E_SANDBOX_ROOT: sandbox
    })).toThrowError(/canonical-outside-sandbox/)
  })

  it('accepts an OS-canonical alias of the same sandbox path', () => {
    const sandbox = temporaryRoot('e2e-sandbox')
    const aliasParent = temporaryRoot('e2e-alias')
    const sandboxAlias = path.join(aliasParent, 'sandbox')
    const home = path.join(sandbox, 'home')
    const library = path.join(sandbox, 'Library')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(library, { recursive: true })
    fs.symlinkSync(sandbox, sandboxAlias)

    expect(assertE2ELibraryPath(library, {
      NODE_ENV: 'test',
      SWOB_TEST_HOME: path.join(sandboxAlias, 'home'),
      SWOB_E2E_SANDBOX_ROOT: sandboxAlias
    })).toBe(library)
  })

  it('allows a canonical Library inside the sandbox and stays inert in production', () => {
    const sandbox = temporaryRoot('e2e-sandbox')
    const home = path.join(sandbox, 'home')
    const library = path.join(sandbox, 'Library')
    const productionLibrary = '/Users/example/Documents/Swob'
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(library, { recursive: true })

    expect(assertE2ELibraryPath(library, {
      NODE_ENV: 'test',
      SWOB_TEST_HOME: home,
      SWOB_E2E_SANDBOX_ROOT: sandbox
    })).toBe(library)
    expect(assertE2ELibraryPath(productionLibrary, {})).toBe(productionLibrary)
  })
})
