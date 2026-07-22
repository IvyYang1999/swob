import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  SecurityCliProfileSecretStore,
  assertNoKeychainPasswordMismatch,
  type SpawnSecurity
} from './llm-secret-store'

const runIntegration = process.platform === 'darwin' && process.env.SWOB_RUN_KEYCHAIN_INTEGRATION === '1'

async function contractStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw new Error(`${label}: ${error instanceof Error ? error.message : 'unknown failure'}`)
  }
}

describe.skipIf(!runIntegration)('macOS Keychain production contract', () => {
  it('uses confirmed stdin for write/read/delete and rejects a one-line mismatch', async () => {
    const service = `dev.swob.keychain-contract.${process.pid}.${Date.now()}`
    const account = randomUUID()
    const mismatchAccount = randomUUID()
    const sampleValue = 'swob contract "$;[]{}|&" fixture-1234'
    const keychainEnv = { ...process.env, HOME: userInfo().homedir }
    const spawnSecurity: SpawnSecurity = (executable, args, options) => {
      const isolatedArgs = [...args]
      const serviceIndex = isolatedArgs.indexOf('-s')
      if (serviceIndex >= 0) isolatedArgs[serviceIndex + 1] = service
      return spawn(executable, isolatedArgs, { ...options, env: keychainEnv })
    }
    const store = new SecurityCliProfileSecretStore(spawnSecurity)

    try {
      await contractStep('write', () => store.set(account, sampleValue))
      expect(await contractStep('read', () => store.get(account))).toBe(sampleValue)
      await contractStep('delete', () => store.delete(account))
      expect(await contractStep('missing-read', () => store.get(account))).toBeNull()

      const mismatch = spawnSync('/usr/bin/security', [
        'add-generic-password', '-U',
        '-a', mismatchAccount,
        '-s', service,
        '-w'
      ], {
        input: `${sampleValue}\n`,
        encoding: 'utf8',
        env: keychainEnv,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      expect(mismatch.status).toBe(0)
      expect(() => assertNoKeychainPasswordMismatch(mismatch.stderr || '')).toThrow(/confirmation/)
    } finally {
      for (const candidate of [account, mismatchAccount]) {
        try {
          execFileSync('/usr/bin/security', [
            'delete-generic-password', '-a', candidate, '-s', service
          ], { env: keychainEnv, stdio: 'ignore' })
        } catch { /* a successful adapter delete or absent mismatch entry is expected */ }
      }
    }
  })
})
