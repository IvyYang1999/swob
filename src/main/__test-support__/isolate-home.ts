import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll } from 'vitest'
import { assertTestLaunchContract } from '../e2e-library-isolation'
import {
  assertProtectedRealStateUnchanged,
  snapshotProtectedRealState
} from './protected-state-audit'
import {
  assertProviderHomeEnvironmentIsolated,
  isolateProviderHomeEnvironment
} from './provider-home-isolation'

if (process.env.SWOB_REAL_LIBRARY_SMOKE === '1') {
  throw new Error(
    'SWOB_REAL_LIBRARY_SMOKE is forbidden under NODE_ENV=test; use an isolated copied fixture instead'
  )
}

const protectedStateBefore = snapshotProtectedRealState()
const systemTemporaryRoot = os.tmpdir()
const sandboxRoot = fs.mkdtempSync(path.join(systemTemporaryRoot, 'swob-vitest-'))
const isolatedHome = path.join(sandboxRoot, 'home')
const isolatedLibrary = path.join(sandboxRoot, 'Library')
const isolatedUserData = path.join(sandboxRoot, 'user-data')
for (const directory of [isolatedHome, isolatedLibrary, isolatedUserData]) {
  fs.mkdirSync(directory, { recursive: true })
}

process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome
process.env.NODE_ENV = 'test'
process.env.SWOB_TEST_HOME = isolatedHome
process.env.SWOB_E2E_SANDBOX_ROOT = sandboxRoot
process.env.SWOB_TEST_SYSTEM_TEMP_ROOT = systemTemporaryRoot
process.env.SWOB_LIBRARY_ROOT = isolatedLibrary
process.env.SWOB_USER_DATA_ROOT = isolatedUserData
process.env.TMPDIR = path.join(sandboxRoot, 'tmp')
fs.mkdirSync(process.env.TMPDIR, { recursive: true })
isolateProviderHomeEnvironment(process.env, sandboxRoot)

assertTestLaunchContract(process.env, isolatedUserData, { systemTemporaryRoot })
assertProviderHomeEnvironmentIsolated(process.env, sandboxRoot)

afterAll(() => {
  try {
    assertProtectedRealStateUnchanged(protectedStateBefore)
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
    if (fs.existsSync(sandboxRoot)) {
      throw new Error('Test isolation violation: temporary Vitest root was not removed')
    }
  }
})
