import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SecurityCliProfileSecretStore, type SpawnSecurity } from './llm-secret-store'

function fakeSecurity(
  calls: Array<{ args: readonly string[]; input: string }>,
  exitCode = 0
): SpawnSecurity {
  return ((_executable, args) => {
    const child = new EventEmitter() as any
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    const call = { args, input: '' }
    calls.push(call)
    child.stdin.on('data', (chunk: Buffer) => { call.input += chunk.toString('utf8') })
    queueMicrotask(() => {
      if (args[0] === 'find-generic-password') child.stdout.write('fixture-value\n')
      child.stdout.end()
      child.emit('close', exitCode)
    })
    return child
  }) as SpawnSecurity
}

describe('Profile Keychain account isolation', () => {
  it('uses com.swob.llm-profile and the profile id as account for get/set/delete', async () => {
    const calls: Array<{ args: readonly string[]; input: string }> = []
    const store = new SecurityCliProfileSecretStore(fakeSecurity(calls))
    const profileId = '00000000-0000-4000-8000-000000000001'

    await expect(store.get(profileId)).resolves.toBe('fixture-value')
    await store.set(profileId, 'fixture-value')
    await store.delete(profileId)

    expect(calls.map((call) => call.args[0])).toEqual([
      'find-generic-password', 'add-generic-password', 'delete-generic-password'
    ])
    for (const call of calls) {
      expect(call.args).toContain('com.swob.llm-profile')
      expect(call.args).toContain(profileId)
    }
    expect(calls[1].input).toBe('fixture-value')
  })

  it('only treats Keychain item-not-found as empty and reports other failures', async () => {
    const calls: Array<{ args: readonly string[]; input: string }> = []
    const missingStore = new SecurityCliProfileSecretStore(fakeSecurity(calls, 44))
    const failingStore = new SecurityCliProfileSecretStore(fakeSecurity(calls, 1))
    const profileId = '00000000-0000-4000-8000-000000000001'

    await expect(missingStore.get(profileId)).resolves.toBeNull()
    await expect(failingStore.get(profileId))
      .rejects.toThrow('Keychain command failed')
  })
})
