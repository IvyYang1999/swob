import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  SecurityCliProfileSecretStore,
  SecurityCliSecretStore,
  type SpawnSecurity
} from './llm-secret-store'

function fakeProcess(
  onInput?: (value: string) => void,
  stderrText = ''
): ChildProcessWithoutNullStreams {
  const processLike = new EventEmitter() as ChildProcessWithoutNullStreams
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(processLike, { stdin, stdout, stderr })
  let input = ''
  stdin.on('data', (chunk) => { input += chunk.toString('utf-8') })
  stdin.on('finish', () => {
    onInput?.(input)
    stderr.end(stderrText)
    queueMicrotask(() => processLike.emit('close', 0))
  })
  return processLike
}

describe('SecurityCliSecretStore', () => {
  it.runIf(process.platform === 'darwin')('writes the value through stdin and never argv', async () => {
    let args: string[] = []
    let stdinValue = ''
    const spawnSecurity: SpawnSecurity = (_executable, receivedArgs) => {
      args = receivedArgs
      return fakeProcess((value) => { stdinValue = value })
    }
    const store = new SecurityCliSecretStore(spawnSecurity)

    await store.set('fixture-value')

    expect(args.at(-1)).toBe('-w')
    expect(args).not.toContain('fixture-value')
    expect(stdinValue).toBe('fixture-value\nfixture-value\n')
  })

  it.runIf(process.platform === 'darwin')('rejects a password mismatch even when security exits zero', async () => {
    const spawnSecurity: SpawnSecurity = () => fakeProcess(undefined, "passwords don't match")
    const store = new SecurityCliSecretStore(spawnSecurity)

    await expect(store.set('fixture-value')).rejects.toThrow(/confirmation/)
  })
})

describe('SecurityCliProfileSecretStore', () => {
  it.runIf(process.platform === 'darwin')('uses the same confirmed stdin protocol', async () => {
    let stdinValue = ''
    const spawnSecurity: SpawnSecurity = () => fakeProcess((value) => { stdinValue = value })
    const store = new SecurityCliProfileSecretStore(spawnSecurity)

    await store.set('00000000-0000-4000-8000-000000000001', 'profile-fixture')

    expect(stdinValue).toBe('profile-fixture\nprofile-fixture\n')
  })
})
