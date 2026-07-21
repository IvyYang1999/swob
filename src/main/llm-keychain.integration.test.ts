import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const runIntegration = process.platform === 'darwin' && process.env.SWOB_RUN_KEYCHAIN_INTEGRATION === '1'

describe.skipIf(!runIntegration)('macOS Keychain integration', () => {
  it('round-trips through a disposable keychain without touching the login keychain', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'swob-keychain-integration-'))
    const keychainPath = join(tempDir, 'fixture.keychain-db')
    const keychainPassword = 'swob-disposable-keychain'
    try {
      execFileSync('/usr/bin/security', ['create-keychain', '-p', keychainPassword, keychainPath])
      execFileSync('/usr/bin/security', ['unlock-keychain', '-p', keychainPassword, keychainPath])
      execFileSync('/usr/bin/security', [
        'add-generic-password', '-U',
        '-a', 'swob-integration-fixture',
        '-s', 'dev.swob.integration-fixture',
        '-w', 'fixture-credential-value',
        keychainPath
      ])
      const value = execFileSync('/usr/bin/security', [
        'find-generic-password',
        '-a', 'swob-integration-fixture',
        '-s', 'dev.swob.integration-fixture',
        '-w', keychainPath
      ], { encoding: 'utf-8' }).trim()
      expect(value).toBe('fixture-credential-value')
    } finally {
      try {
        execFileSync('/usr/bin/security', ['delete-keychain', keychainPath])
      } catch { /* disposable keychain may already be gone */ }
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
