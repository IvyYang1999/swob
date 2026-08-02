import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const roots: string[] = []

function developmentFixture(): { home: string; library: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swob-runtime-bootstrap-'))
  roots.push(home)
  const library = path.join(home, 'protected-Library')
  fs.mkdirSync(path.join(home, '.claude-session-manager'), { recursive: true })
  fs.mkdirSync(library, { recursive: true })
  fs.writeFileSync(path.join(home, '.claude-session-manager', 'app-config.json'), JSON.stringify({
    libraryPath: library,
    onboardingCompleted: true
  }))
  return { home, library }
}

const isolationKeys = [
  'HOME',
  'NODE_ENV',
  'SWOB_TEST_HOME',
  'SWOB_E2E_SANDBOX_ROOT',
  'SWOB_TEST_SYSTEM_TEMP_ROOT',
  'SWOB_LIBRARY_ROOT',
  'SWOB_USER_DATA_ROOT',
  'SWOB_ISOLATION_PROTECTED_HOME',
  'SWOB_DEV_USE_REAL_LIBRARY',
  'SWOB_RUNTIME_SAFETY_MODE'
] as const

async function withDevelopmentEnvironment<T>(
  allowRealLibrary: boolean,
  run: () => Promise<T>
): Promise<T> {
  const previous = Object.fromEntries(isolationKeys.map((key) => [key, process.env[key]]))
  const { home, library } = developmentFixture()
  for (const key of isolationKeys) delete process.env[key]
  process.env.HOME = home
  process.env.NODE_ENV = 'development'
  process.env.SWOB_LIBRARY_ROOT = library
  process.env.SWOB_USER_DATA_ROOT = path.join(home, 'user-data')
  process.env.SWOB_ISOLATION_PROTECTED_HOME = home
  if (allowRealLibrary) process.env.SWOB_DEV_USE_REAL_LIBRARY = '1'
  vi.resetModules()
  try {
    return await run()
  } finally {
    for (const key of isolationKeys) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    vi.resetModules()
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('runtime isolation bootstrap CI counterexample', () => {
  it('terminates a development process pointed at its protected Library before Electron starts', async () => {
    await withDevelopmentEnvironment(false, async () => {
      await expect(import('./runtime-isolation-bootstrap'))
        .rejects.toThrow(/development-real-library-requires-SWOB_DEV_USE_REAL_LIBRARY=1/)
    })
  })

  it('emits the explicit danger log when the development override is present', async () => {
    await withDevelopmentEnvironment(true, async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const loaded = await import('./runtime-isolation-bootstrap')
      expect(loaded.startupRuntimeSafety.dangerousRealLibrary).toBe(true)
      expect(log).toHaveBeenCalledWith(expect.stringContaining('DANGER: development build is using the real Library'))
      expect(process.env.SWOB_RUNTIME_SAFETY_MODE).toBe('dangerous-real-library-development')
    })
  })
})
